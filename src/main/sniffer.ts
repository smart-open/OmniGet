// 多源嗅探器（M1-8，§1.3/§7.5）
// magnet/.torrent/视频 URL/音乐名/HTTP 分型路由 + 30s 去重窗口
// （剪贴板·协议·拖拽三入口共用，同一链接只触发一次新建流程，§4.6）。

import { fileURLToPath } from 'url'
import type { TaskType } from '@shared/types'

export interface SniffResult {
  type: TaskType
  source: string
  /** 短视频平台（抖音/快手等）→ noWatermark 默认 true */
  noWatermark?: boolean
  platform?: string
}

/** file:// → 本地路径（跨平台：Windows 盘符、%20 转义、file://localhost 形态）；非 file: 输入原样返回 */
export function stripFileProtocol(raw: string): string {
  if (!/^file:\/\//i.test(raw)) return raw
  try {
    return fileURLToPath(raw)
  } catch {
    return decodeURIComponent(raw.replace(/^file:\/\/(localhost)?/i, ''))
  }
}

const VIDEO_DOMAINS: { pattern: RegExp; platform: string }[] = [
  { pattern: /(^|\.)youtube\.com$|(^|\.)youtu\.be$/, platform: 'youtube' },
  { pattern: /(^|\.)bilibili\.com$|(^|\.)b23\.tv$/, platform: 'bilibili' },
  { pattern: /(^|\.)douyin\.com$|(^|\.)iesdouyin\.com$|(^|\.)v\.douyin\.com$/, platform: 'douyin' },
  { pattern: /(^|\.)kuaishou\.com$|(^|\.)v\.kuaishou\.com$/, platform: 'kuaishou' },
  { pattern: /(^|\.)xiaohongshu\.com$|(^|\.)xhslink\.com$/, platform: 'xiaohongshu' },
  { pattern: /(^|\.)weibo\.com$|(^|\.)weibo\.cn$/, platform: 'weibo' },
  { pattern: /(^|\.)ixigua\.com$/, platform: 'xigua' }
]

const SHORTLINK_DOMAINS = /v\.douyin\.com|v\.kuaishou\.com|xhslink\.com|b23\.tv/

export function sniff(input: string): SniffResult | null {
  const raw = input.trim()
  if (!raw) return null

  // 1. 磁力
  if (/^magnet:\?/i.test(raw)) {
    return { type: 'magnet', source: raw, platform: 'magnet' }
  }

  // 2. .torrent 文件路径（拖拽/文件选择器）
  if (/\.torrent$/i.test(raw) && !/^https?:/i.test(raw)) {
    return { type: 'bt', source: stripFileProtocol(raw), platform: 'torrent' }
  }

  // 3. URL（视频平台 / HTTP 直链）
  if (/^https?:\/\//i.test(raw)) {
    try {
      const u = new URL(raw)
      // R4-P3：source 用规范化后的 URL——聊天/网页复制的链接常带中文标点/引号/
      // markdown 尾缀（`https://v.douyin.com/xxx。`），new URL 能解析成功但
      // 尾巴会随 source 进引擎导致 404
      const clean = u.toString()
      const host = u.hostname.toLowerCase()
      for (const { pattern, platform } of VIDEO_DOMAINS) {
        if (pattern.test(host)) {
          const shortlink = SHORTLINK_DOMAINS.test(host)
          return {
            type: 'video',
            source: clean,
            platform,
            noWatermark: shortlink ? true : undefined // 短视频分享链默认无水印（§4.3.1）
          }
        }
      }
      // R7 续（backlog #17 第一阶段）：HLS/DASH 清单分型 → video 任务走 yt-dlp
      //（generic extractor 原生支持 m3u8/MPD 分段流与 AES-128；aria2 只会下到
      // 清单文件本身）。此前此类链接落 http 类型必然产出损坏的 .m3u8 文件
      if (/\.(m3u8|m3u|mpd)([?#]|$)/i.test(u.pathname)) {
        return { type: 'video', source: clean, platform: 'hls' }
      }
      return { type: 'http', source: clean, platform: 'http' }
    } catch {
      return null
    }
  }

  // 4. 其余文本 → 音乐名（自然语言："陈奕迅的孤勇者" / "陈奕迅 孤勇者"）
  // R4-P3：形如本地绝对路径的输入不当作音乐名（防未来新入口把
  // `D:\movies\xxx.mp4` 当歌名搜索）——当前两个调用方各有过滤，此处兜底收口
  if (/^(?:[a-zA-Z]:[\\/]|\/)/.test(raw) && !/\.torrent$/i.test(raw)) {
    return null
  }
  return { type: 'music', source: raw, platform: 'music' }
}

// ── 30s 去重窗口 ─────────────────────────────────────────────────────

export class DedupeWindow {
  private seen = new Map<string, number>()
  constructor(private readonly windowMs = 30_000) {}

  /** 返回 false 表示窗口内重复，应跳过弹窗 */
  check(key: string): boolean {
    const now = Date.now()
    // 清理过期
    for (const [k, t] of this.seen) {
      if (now - t > this.windowMs) this.seen.delete(k)
    }
    const prev = this.seen.get(key)
    if (prev !== undefined) return false
    this.seen.set(key, now)
    return true
  }
}

/** R4-P3：三入口共用实例——剪贴板与 magnet 协议此前各自 new，同一磁力 30s 内
 * 先经剪贴板、再经协议唤起会各弹一次（模块注释声称"三入口共用"但实现未兑现） */
export const launchDedupe = new DedupeWindow(30_000)
