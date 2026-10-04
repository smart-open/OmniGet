// 三期（0.10.x，backlog #25）：直播间页 URL → 流清单解析。
// 主路：yt-dlp -J 解析直播间页（B站/斗鱼/虎牙/抖音 extractor 自带直播支持，
// 零新依赖）；兜底：B站公开 API（room_playing，无签名）拼 HLS 清单直链。
// 产出 manifestUrl 喂 N_m3u8DL-RE（manager 侧改写 task.source 后走既有 nm3u8 管线）。

import type { Task } from '@shared/types'
import type { ParseOutput } from '../adapters/types'
import { createLogger } from '../logger'
import { getYtDlpSupervisor } from '../orchestrator/ytdlp'
import { detectLiveRoom, BILI_ROOM_API, streamHeadersFor } from './rooms'

const log = createLogger('live-resolve')

interface LiveFormat {
  url?: string
  height?: number
  tbr?: number
  protocol?: string
  ext?: string
  format_id?: string
}

interface LiveJson {
  title?: string
  thumbnail?: string
  is_live?: boolean
  formats?: LiveFormat[]
}

/** 从 yt-dlp formats 里挑最佳 HLS 清单直链（直播房间 formats 多为 m3u8_native）。
 * N_m3u8DL-RE 只吃 HLS/DASH 类清单——FLV/fMP4 直链一律不用 */
export function pickManifestUrl(formats: LiveFormat[]): string | null {
  const hls = formats.filter(
    (f) =>
      typeof f.url === 'string' &&
      (/\.m3u8([?#]|$)/i.test(f.url) || f.protocol === 'm3u8_native' || f.protocol === 'm3u8')
  )
  if (hls.length === 0) return null
  hls.sort((a, b) => (b.height ?? 0) - (a.height ?? 0) || (b.tbr ?? 0) - (a.tbr ?? 0))
  return hls[0]!.url ?? null
}

/** 主路：yt-dlp -J 解析直播间页。未开播（is_live=false 且无 formats）/ 无 HLS 清单 → 抛可读错误 */
async function resolveViaYtDlp(url: string): Promise<{ name: string; coverUrl?: string; manifestUrl: string }> {
  const out = await getYtDlpSupervisor().execJson(['-J', '--no-playlist', url], 60_000)
  const json = JSON.parse(out) as LiveJson
  const manifestUrl = pickManifestUrl(json.formats ?? [])
  if (!manifestUrl) {
    throw new Error(
      json.is_live === false
        ? '该直播间当前未开播，无法录制。开播后再试。'
        : '未从直播间解析出可用的 HLS 流（可能未开播或平台不支持）。可稍后重试。'
    )
  }
  return {
    name: json.title || 'live',
    coverUrl: json.thumbnail,
    manifestUrl
  }
}

/** 兜底：B站公开 API 拼 HLS 清单（yt-dlp 解析失败且平台为 bilibili 时启用）。
 * room_playing 返回 playurl_info.stream[].format[].protocol[].codec[].base_url/host */
async function resolveViaBiliApi(roomId: string): Promise<{ name: string; coverUrl?: string; manifestUrl: string }> {
  const { getJson } = await import('../music/http')
  const json = await getJson<{
    code?: number
    data?: {
      title?: string
      room_id?: number
      live_status?: number
      keyframe?: string
      playurl_info?: {
        playurl?: {
          stream?: Array<{
            format?: Array<{
              protocol?: Array<{
                protocol_name?: string
                codec?: Array<{ base_url?: string; host?: string; extra?: string }>
              }>
            }>
          }>
        }
      }
    }
  }>(`${BILI_ROOM_API}/room/v1/Room/room_playing?id=${encodeURIComponent(roomId)}`)
  if (json.code !== 0 || !json.data) throw new Error('B站直播间信息获取失败（接口异常或房间号无效）')
  if (json.data.live_status !== 1) throw new Error('该直播间当前未开播，无法录制。开播后再试。')
  let manifestUrl: string | null = null
  for (const stream of json.data.playurl_info?.playurl?.stream ?? []) {
    for (const format of stream.format ?? []) {
      for (const proto of format.protocol ?? []) {
        for (const codec of proto.codec ?? []) {
          if (codec.base_url?.includes('.m3u8') && codec.host) {
            // 审查加固：host 可能自带协议、base_url 可能缺前导斜杠——拼前归一
            const hostPart = /^https?:\/\//i.test(codec.host)
              ? codec.host.replace(/\/+$/, '')
              : `https://${codec.host.replace(/^\/+/, '').replace(/\/+$/, '')}`
            const pathPart = codec.base_url.startsWith('/') ? codec.base_url : `/${codec.base_url}`
            manifestUrl = `${hostPart}${pathPart}${codec.extra ?? ''}`
            break
          }
        }
        if (manifestUrl) break
      }
      if (manifestUrl) break
    }
    if (manifestUrl) break
  }
  if (!manifestUrl) throw new Error('未从B站直播间解析出可用的 HLS 流（可能未开播）。可稍后重试。')
  return { name: json.data.title || `bilibili-live-${roomId}`, coverUrl: json.data.keyframe, manifestUrl }
}

/** 直播间任务解析入口（manager 专用：engine=nm3u8 且 sniff.liveRoom）。
 * 平台请求头写入 params.liveHeaders（nm3u8 适配器 start 时注入 --header） */
export async function resolveLiveRoom(task: Task): Promise<ParseOutput> {
  const info = detectLiveRoom(task.source)
  if (!info) throw new Error('直播间地址无效（无法识别房间号）')
  let resolved: { name: string; coverUrl?: string; manifestUrl: string }
  try {
    resolved = await resolveViaYtDlp(task.source)
  } catch (err) {
    // 兜底仅 B站（公开无签名 API）；其余平台不造签名算法（合规红线）
    if (info.platform === 'bilibili') {
      log.warn(`yt-dlp 直播解析失败，回落B站公开 API: ${err instanceof Error ? err.message : String(err)}`)
      resolved = await resolveViaBiliApi(info.roomId)
    } else {
      throw err
    }
  }
  log.info(`live room resolved: ${info.platform}/${info.roomId} → ${resolved.manifestUrl.slice(0, 80)}…`)
  return {
    name: resolved.name,
    coverUrl: resolved.coverUrl,
    formats: [], // 直播不提供清晰度选择（RE --auto-select 自动最佳轨道）
    totalBytes: 0,
    live: true,
    manifestUrl: resolved.manifestUrl
  }
}

/** nm3u8 适配器注入用：按任务来源平台返回 --header 参数对 */
export function liveHeaderArgs(paramsJson: string | null | undefined): string[] {
  let roomUrl = ''
  try {
    roomUrl = String((JSON.parse(paramsJson ?? '{}') as { roomUrl?: string }).roomUrl ?? '')
  } catch {
    return []
  }
  const info = detectLiveRoom(roomUrl)
  if (!info) return []
  return streamHeadersFor(info.platform).flatMap((h) => ['--header', `${h.name}: ${h.value}`])
}
