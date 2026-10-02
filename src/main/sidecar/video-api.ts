// 短视频解析服务 sidecar 客户端（backlog #11，R7 续）。
// 用户自托管 Evil0ctal/Douyin_TikTok_Download_API v5 实例（Docker/本地进程均可），
// 在 yt-dlp 解析失败（快手/小红书无 extractor、抖音风控）时作为元数据兜底：
// 混合解析取直链 → 任务改道 aria2 http 直链管线（manager 编排）。

import { getSettingParsed } from '../db'
import { postForm } from '../music/http'
import { createLogger } from '../logger'
import { extractSidecarVideo, type SidecarVideo } from './video-extract'

export type { SidecarVideo } from './video-extract'

const log = createLogger('sidecar-video')

/** 设置键 → 规范化 base URL（trim + 去尾斜杠 + http(s) 校验；空/非法返回 null） */
export function normalizeSidecarBase(raw: string | null | undefined): string | null {
  const v = typeof raw === 'string' ? raw.trim().replace(/\/+$/, '') : ''
  return /^https?:\/\//i.test(v) ? v : null
}

/** 读取设置中的解析服务地址（sidecar.videoApiUrl；未配置返回 null = 兜底禁用） */
export function getVideoSidecarBase(): string | null {
  return normalizeSidecarBase(getSettingParsed<string>('sidecar.videoApiUrl'))
}

// ── 混合解析 ────────────────────────────────────────────────────────

interface HybridEnvelope {
  code?: number | string
  msg?: string
  message?: string
  data?: unknown
}

/**
 * 调自托管解析服务取直链。
 * 端点：POST {base}/api/hybrid/video_data（form: url=<分享/完整链接>），
 * 响应信封 { code, data, msg }；code 非 200 视为业务失败。
 */
export async function resolveViaSidecar(url: string): Promise<SidecarVideo> {
  const base = getVideoSidecarBase()
  if (!base) {
    throw new Error('未配置短视频解析服务（设置 → 下载 → 短视频解析服务）')
  }
  const endpoint = `${base}/api/hybrid/video_data`
  // 15s 单次超时 × fetchJson 3 次尝试 ≈ 最坏 47s：解析阶段阻塞任务创建，不可再宽
  const envelope = await postForm<HybridEnvelope>(endpoint, { url }, undefined, {
    timeoutMs: 15_000
  })
  const code = Number(envelope?.code)
  if (Number.isFinite(code) && code !== 200) {
    throw new Error(envelope?.msg || envelope?.message || `解析服务返回错误（code ${code}）`)
  }
  // 某些版本 data 直接内嵌在信封，无 data 字段时按信封本身解析（容忍实现漂移）
  const video = extractSidecarVideo(envelope?.data ?? envelope, url)
  if (!video) {
    throw new Error('解析服务未返回可下载的视频直链（图集/图文内容暂不支持）')
  }
  log.info(`sidecar resolve ok, url len=${video.url.length}, title=${video.title ?? ''}`)
  return video
}

// ── 连接测试 ────────────────────────────────────────────────────────

export interface SidecarProbeResult {
  ok: boolean
  detail: string
}

/** 设置页「测试连接」：对配置地址做可达性探测（不消耗解析请求） */
export async function probeVideoSidecar(raw: string): Promise<SidecarProbeResult> {
  const base = normalizeSidecarBase(raw)
  if (!base) return { ok: false, detail: '地址格式有误：需要 http:// 或 https:// 前缀' }
  try {
    const res = await fetch(base, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(8000)
    })
    if (!res.ok) {
      // 审查修复：非 ok 响应体同样释放（防 socket 悬挂）
      await res.body?.cancel().catch(() => {})
      return { ok: false, detail: `服务响应异常（HTTP ${res.status}）` }
    }
    // Evil0ctal 实例根路径返回 JSON 应用信息；识别到即明确提示，非 JSON（反代网页）不判失败
    let detail = `服务可达（HTTP ${res.status}）`
    try {
      const body = (await res.json()) as Record<string, unknown>
      if (body && typeof body === 'object' && ('code' in body || 'version' in body || 'routes' in body)) {
        detail = '服务可达（已识别解析服务实例）'
      }
    } catch {
      // 非 JSON 根路径：忽略
    }
    return { ok: true, detail }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    return { ok: false, detail: `无法连接：${reason}` }
  }
}
