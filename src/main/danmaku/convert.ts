// 三期（0.10.x，backlog #23）：B站弹幕 xml → ASS 转换（BBDown / danmaku2ass 范式）。
// 纯函数模块（可单测）：parseDanmakuXml 解析 <d p="..."> 条目，xmlToAss 产出
// ASS 字幕（滚动 R2L 用 \move 逐条轨迹，底部/顶部定轨；简单车道分配防重叠）。
// 供两个入口复用：工具箱「弹幕转换」工具 + B站视频任务完成后的可选压制（ytdlp 适配器）。

export interface DanmakuComment {
  /** 出现时间（秒） */
  time: number
  /** 1=滚动 4=底部 5=顶部（B站 mode）；7 特殊弹幕不支持 → 转底部 */
  mode: number
  /** 0=普通 1=小 2=大 */
  size: number
  /** RGB 十进制（B站 p 字段第 4 位，默认白） */
  color: number
  text: string
}

export interface AssOptions {
  /** 画布宽（弹幕坐标系，默认 1920） */
  width?: number
  height?: number
  /** 基准字号（playRes 下，默认 38） */
  fontSize?: number
  /** 不透明度 1–100（默认 100） */
  opacity?: number
  /** 滚动弹幕全程秒数（默认 12） */
  scrollSeconds?: number
  /** 底部/顶部驻留秒数（默认 5） */
  fixSeconds?: number
  /** 字体（默认 Microsoft YaHei，缺失时系统回退） */
  fontFamily?: string
}

function decodeEntities(s: string): string {
  // 第十轮审查 P3：非法码点（>0x10FFFF）String.fromCodePoint 抛 RangeError
  // 会令整次压制失败——单条降级为原样保留
  const safeCodePoint = (n: number): string => {
    try {
      return String.fromCodePoint(n)
    } catch {
      return ''
    }
  }
  return s
    .replace(/&#(\d+);/g, (_, n) => safeCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => safeCodePoint(parseInt(n, 16)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/** 解析B站弹幕 XML（api.bilibili.com/x/v1/dm/listsoa 或本地存档）；无 <d> 条目 → 空数组 */
export function parseDanmakuXml(xml: string): DanmakuComment[] {
  const out: DanmakuComment[] = []
  const re = /<d\s+p="([^"]*)"[^>]*>([\s\S]*?)<\/d>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) {
    const p = m[1]!.split(',')
    if (p.length < 5) continue
    const time = Number(p[0])
    const mode = Number(p[1])
    const size = Number(p[2])
    const color = Number(p[3])
    const text = decodeEntities(m[2]!).trim()
    if (!Number.isFinite(time) || time < 0 || !text) continue
    out.push({
      time,
      mode: Number.isFinite(mode) ? mode : 1,
      size: Number.isFinite(size) ? size : 0,
      color: Number.isFinite(color) && color > 0 ? color : 0xffffff,
      text
    })
  }
  return out.sort((a, b) => a.time - b.time)
}

/** RGB 十进制 → ASS 颜色 &H00BBGGRR& */
export function rgbToAss(rgb: number, alphaHex: string): string {
  const r = (rgb >> 16) & 0xff
  const g = (rgb >> 8) & 0xff
  const b = rgb & 0xff
  return `&H${alphaHex}${b.toString(16).padStart(2, '0')}${g
    .toString(16)
    .padStart(2, '0')}${r.toString(16).padStart(2, '0')}`
}

function assTime(sec: number): string {
  const s = Math.max(0, sec)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = Math.floor(s % 60)
  const cs = Math.round((s - Math.floor(s)) * 100)
  return `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${String(Math.min(99, cs)).padStart(2, '0')}`
}

function escapeAssText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/\{/g, '（')
    .replace(/\}/g, '）')
    .replace(/\r?\n/g, '\\N')
}

/** 简易车道分配输入 */
interface Slot {
  /** 车道空出的最早时间（秒） */
  freeAt: number
}

function pickScrollLane(lanes: Slot[], t: number, textWidth: number, W: number, scrollSec: number): number {
  for (let i = 0; i < lanes.length; i++) {
    if (t >= lanes[i]!.freeAt) {
      // 精确式：新弹幕右缘不再撞前一条尾部 = 前一条尾部清出重叠区所需时间
      // = textWidth / ((W + textWidth) / scrollSec)
      lanes[i]!.freeAt = t + (textWidth / (W + textWidth)) * scrollSec
      return i
    }
  }
  // 全占：取最早空出的车道（弹幕密度极端时降级重叠而非丢弃）
  let best = 0
  for (let i = 1; i < lanes.length; i++) if (lanes[i]!.freeAt < lanes[best]!.freeAt) best = i
  lanes[best]!.freeAt = t + (textWidth / (W + textWidth)) * scrollSec
  return best
}

function pickFixLane(lanes: Slot[], t: number, fixSec: number): number {
  for (let i = 0; i < lanes.length; i++) {
    if (t >= lanes[i]!.freeAt) {
      lanes[i]!.freeAt = t + fixSec
      return i
    }
  }
  let best = 0
  for (let i = 1; i < lanes.length; i++) if (lanes[i]!.freeAt < lanes[best]!.freeAt) best = i
  lanes[best]!.freeAt = t + fixSec
  return best
}

const SIZE_FACTOR: Record<number, number> = { 0: 1, 1: 0.7, 2: 1.4 }

/** 弹幕 → ASS 字幕全文。条目上限 3000（防超长直播录播炸渲染器） */
export function xmlToAss(xml: string, opts: AssOptions = {}): string {
  const W = Math.max(320, Math.round(opts.width ?? 1920))
  const H = Math.max(180, Math.round(opts.height ?? Math.round(W * 9 / 16)))
  const fs = Math.max(12, Math.round(opts.fontSize ?? 38))
  const opacity = Math.min(100, Math.max(1, Math.round(opts.opacity ?? 100)))
  const scrollSec = Math.min(60, Math.max(4, opts.scrollSeconds ?? 12))
  const fixSec = Math.min(30, Math.max(2, opts.fixSeconds ?? 5))
  const font = (opts.fontFamily ?? 'Microsoft YaHei').replace(/[\\{}]/g, '')
  const alphaHex = Math.round(((100 - opacity) * 255) / 100)
    .toString(16)
    .padStart(2, '0')

  const comments = parseDanmakuXml(xml).slice(0, 3000)
  const textWidth = (c: DanmakuComment): number => c.text.length * fs * (SIZE_FACTOR[c.size] ?? 1)

  const scrollLanes: Slot[] = Array.from({ length: Math.max(1, Math.floor(H / fs / 1.4)) }, () => ({ freeAt: 0 }))
  const fixLanes: Slot[] = Array.from({ length: Math.max(1, Math.floor(H / fs / 1.4)) }, () => ({ freeAt: 0 }))

  const events: string[] = []
  for (const c of comments) {
    const isFix = c.mode === 4 || c.mode === 5 || c.mode === 7
    const isTop = c.mode === 5
    if (isFix) {
      const lane = pickFixLane(fixLanes, c.time, fixSec)
      const y = isTop ? (lane + 1) * fs : H - lane * fs - fs
      events.push(
        `Dialogue: 1,${assTime(c.time)},${assTime(c.time + fixSec)},Fix,,0,0,0,,{\\pos(${Math.round(W / 2)},${Math.round(y)})}${escapeAssText(c.text)}`
      )
    } else {
      // 1/2/3/6 均按滚动处理（6 逆向弹幕占比极低，统一 R2L 保证可读性）
      const tw = Math.max(fs, textWidth(c))
      const lane = pickScrollLane(scrollLanes, c.time, tw, W, scrollSec)
      const y = (lane + 1) * fs
      events.push(
        `Dialogue: 0,${assTime(c.time)},${assTime(c.time + scrollSec)},R2L,,0,0,0,,{\\move(${Math.round(W + tw / 2)},${Math.round(y)},${Math.round(-tw / 2)},${Math.round(y)})}${escapeAssText(c.text)}`
      )
    }
  }

  return [
    '[Script Info]',
    '; OmniGet danmaku export (backlog #23)',
    `Title: danmaku`,
    'ScriptType: v4.00+',
    `PlayResX: ${W}`,
    `PlayResY: ${H}`,
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    'YCbCr Matrix: TV.601',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: R2L,${font},${fs},${rgbToAss(0xffffff, alphaHex)},&H00FFFFFF,&H00000000,&H96000000,0,0,0,0,100,100,0,0,1,2,0,7,0,0,0,1`,
    `Style: Fix,${font},${fs},${rgbToAss(0xffffff, alphaHex)},&H00FFFFFF,&H00000000,&H96000000,0,0,0,0,100,100,0,0,1,2,0,2,0,0,0,1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...events,
    ''
  ].join('\n')
}
