// 二期（0.9.x 双语歌词）：LRC 双轨合并（backlog 二期「歌词增强：双语/翻译歌词落盘」）
// 网易云 lyric API 的 tlyric（翻译轨）与原文按时间戳逐行合并——译文行不带时间戳
// 紧贴原文行下（主流播放器/媒体服务器的双语 LRC 通用形态）。

import { getSettingParsed } from '../db'

export type LyricsMode = 'original' | 'bilingual'

/** 歌词落盘模式（设置键 music.lyrics；默认 original 保持既有行为） */
export function getLyricsMode(): LyricsMode {
  const v = getSettingParsed<string>('music.lyrics')
  return v === 'bilingual' ? 'bilingual' : 'original'
}

interface LrcLine {
  /** 归一化时间戳（厘秒）；无时间戳的行（元数据/空行）为 null */
  t: number | null
  text: string
  raw: string
}

/** 时间戳标签：[mm:ss.xx] / [mm:ss.xxx]，单行可携带多个标签 */
const STAMP_RE = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g

function parseLrc(text: string): LrcLine[] {
  const out: LrcLine[] = []
  for (const raw of text.split(/\r?\n/)) {
    STAMP_RE.lastIndex = 0
    let first: number | null = null
    let m: RegExpExecArray | null
    while ((m = STAMP_RE.exec(raw)) !== null) {
      const min = Number(m[1])
      const sec = Number(m[2])
      const fracRaw = m[3] ?? ''
      // 精度归一：2 位=厘秒，3 位=毫秒取整到厘秒
      const frac = fracRaw ? Number(fracRaw.padEnd(2, '0').slice(0, 2)) : 0
      const t = min * 6000 + sec * 100 + frac
      if (first === null) first = t
    }
    const textPart = raw.replace(STAMP_RE, '').trim()
    out.push({ t: first, text: textPart, raw })
  }
  return out
}

/**
 * 原文 + 翻译 → 双语 LRC：逐时间戳把译文行（无时间戳）插到原文行下。
 * 无翻译的时间戳行原样保留；元数据行（[ti:]/[ar:] 等无时间戳）原样保留。
 * 纯函数（单测覆盖）。
 */
export function mergeBilingualLrc(orig: string, trans: string): string {
  const src = parseLrc(orig)
  const map = new Map<number, string>()
  for (const line of parseLrc(trans)) {
    if (line.t === null || !line.text) continue
    if (!map.has(line.t)) map.set(line.t, line.text)
  }
  const out: string[] = []
  for (const line of src) {
    out.push(line.raw)
    if (line.t !== null) {
      const tr = map.get(line.t)
      if (tr) out.push(tr)
    }
  }
  return out.join('\n') + '\n'
}
