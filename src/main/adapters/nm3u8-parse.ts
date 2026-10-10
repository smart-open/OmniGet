// HLS/DASH 清单解析纯函数（backlog #17 第二阶段）。
// 独立无依赖模块：单测可直接覆盖，不触发引擎/进程依赖。

export interface HlsVariant {
  /** 变体清单 URI（相对或绝对；start 阶段经 url=<regex> 选择器锁定） */
  uri: string
  /** RESOLUTION，形如 1920x1080 */
  resolution?: string
  /** BANDWIDTH（bps） */
  bandwidth?: number
  name?: string
}

export interface HlsManifestInfo {
  kind: 'master' | 'media' | 'mpd' | 'unknown'
  variants: HlsVariant[]
  /** media 清单 #EXTINF 时长合计（秒，取整） */
  durationSec?: number
  /** master 清单 #EXT-X-MEDIA TYPE=SUBTITLES 字幕轨（backlog #17 增强：-ss 轨道选择） */
  subtitles: HlsSubtitleTrack[]
}

export interface HlsSubtitleTrack {
  /** GROUP-ID（变体清单 SUBTITLES="..." 属性值；RE -ss id=<regex> 选择键） */
  groupId: string
  /** #EXT-X-MEDIA NAME 属性 */
  name?: string
  /** LANGUAGE 属性（ISO 639 码） */
  language?: string
}

/** 引号感知的 HLS attribute-list 切分（CODECS="avc1,mp4a" 内含逗号） */
export function splitHlsAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {}
  const parts: string[] = []
  let cur = ''
  let inQuote = false
  for (const ch of s) {
    if (ch === '"') inQuote = !inQuote
    if (ch === ',' && !inQuote) {
      parts.push(cur)
      cur = ''
    } else {
      cur += ch
    }
  }
  if (cur.trim()) parts.push(cur)
  for (const p of parts) {
    const eq = p.indexOf('=')
    if (eq <= 0) continue
    out[p.slice(0, eq).trim().toUpperCase()] = p
      .slice(eq + 1)
      .trim()
      .replace(/^"|"$/g, '')
  }
  return out
}

export function parseHlsManifest(text: string): HlsManifestInfo {
  const trimmed = text.trim()
  // DASH MPD（XML）：不做深度解析——RE 自动选最佳轨
  if (/^\s*<\?xml[\s\S]*?<MPD/i.test(trimmed) || /^\s*<MPD/i.test(trimmed)) {
    return { kind: 'mpd', variants: [], subtitles: [] }
  }
  const lines = trimmed.split(/\r?\n/)
  const variants: HlsVariant[] = []
  const subtitles: HlsSubtitleTrack[] = []
  let durationSec = 0
  let pending: Record<string, string> | null = null
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      pending = splitHlsAttrs(line.slice('#EXT-X-STREAM-INF:'.length))
      continue
    }
    if (line.startsWith('#EXTINF:')) {
      const d = parseFloat(line.slice('#EXTINF:'.length))
      if (Number.isFinite(d)) durationSec += d
      continue
    }
    if (line.startsWith('#EXT-X-MEDIA:')) {
      const attrs = splitHlsAttrs(line.slice('#EXT-X-MEDIA:'.length))
      // 只收 SUBTITLES 轨（AUDIO 轨由 RE --auto-select/-sa for=best 自动取最佳，无选择 UI）
      if (attrs['TYPE'] === 'SUBTITLES') {
        subtitles.push({
          groupId: attrs['GROUP-ID'] ?? '',
          name: attrs['NAME'] || undefined,
          language: attrs['LANGUAGE'] || undefined
        })
      }
      // 注意：不清 pending——实际清单常见 MEDIA 行插在 STREAM-INF 与其 URI 行之间，
      // 此处重置会误丢变体（对齐 #EXTINF 同样的「不干扰 pending」口径）
      continue
    }
    if (line.startsWith('#')) {
      pending = null
      continue
    }
    // 非注释行 = URI（master 变体或 media 分片；分片行因无 pending 被忽略）
    if (pending) {
      variants.push({
        uri: line,
        resolution: pending.RESOLUTION,
        bandwidth: pending.BANDWIDTH ? Number(pending.BANDWIDTH) : undefined,
        name: pending.NAME
      })
      pending = null
    }
  }
  if (variants.length > 0)
    return { kind: 'master', variants, subtitles, durationSec: durationSec || undefined }
  if (durationSec > 0) return { kind: 'media', variants: [], subtitles, durationSec: Math.round(durationSec) }
  return { kind: 'unknown', variants: [], subtitles }
}

/** 变体 URI → N_m3u8DL-RE url= 选择器的正则转义（分片 URL 为绝对地址，子串可命中） */
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
