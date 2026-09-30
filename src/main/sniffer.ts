// 多源嗅探器（M1-8，§1.3/§7.5）
// magnet/.torrent/视频 URL/音乐名/HTTP 分型路由 + 30s 去重窗口
// （剪贴板·协议·拖拽三入口共用，同一链接只触发一次新建流程，§4.6）。

import type { TaskType } from '@shared/types'

export interface SniffResult {
  type: TaskType
  source: string
  /** 短视频平台（抖音/快手等）→ noWatermark 默认 true */
  noWatermark?: boolean
  platform?: string
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
    return { type: 'bt', source: raw.replace(/^file:\/\//, ''), platform: 'torrent' }
  }

  // 3. URL（视频平台 / HTTP 直链）
  if (/^https?:\/\//i.test(raw)) {
    try {
      const host = new URL(raw).hostname.toLowerCase()
      for (const { pattern, platform } of VIDEO_DOMAINS) {
        if (pattern.test(host)) {
          const shortlink = SHORTLINK_DOMAINS.test(host)
          return {
            type: 'video',
            source: raw,
            platform,
            noWatermark: shortlink ? true : undefined // 短视频分享链默认无水印（§4.3.1）
          }
        }
      }
      return { type: 'http', source: raw, platform: 'http' }
    } catch {
      return null
    }
  }

  // 4. 其余文本 → 音乐名（自然语言："陈奕迅的孤勇者" / "陈奕迅 孤勇者"）
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
