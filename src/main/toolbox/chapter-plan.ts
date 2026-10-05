// 四期（0.11.x）：音频章节标记（有声书场景，工具箱 audio-chapters）。
// 用户时间轴文本 → FFMETADATA（[CHAPTER] 段）→ ffmpeg -map_metadata/-map_chapters
// 写入 mp3（ID3v2 CHAP）/ m4a·m4b（MP4 chapter track）。
// 纯函数（单测）：文本解析 + ffmetadata 构建 + 特殊字符转义。

export interface ChapterMark {
  startMs: number
  title: string
}

const MAX_CHAPTERS = 500

/**
 * 纯函数（单测覆盖）：解析时间轴文本，每行一个章节。
 * 支持行格式（# 开头为注释行，跳过）：
 *   00:01:23 第二章 出发      （时:分:秒 标题）
 *   01:23 - 章节名            （分:秒 [-] 标题）
 *   [00:05:00] 序章           （方括号时间戳）
 * 无标题行按「章节 N」命名；输出按时间排序并去除同起点重复。
 */
export function parseChapterText(text: string): ChapterMark[] {
  const out: ChapterMark[] = []
  const defaulted = new Set<ChapterMark>()
  const re = /^\[?(\d{1,4}):(\d{1,2})(?::(\d{1,2}))?\]?\s*(?:[-–—|:：]\s*)?(.*)$/
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim()
    if (!t || t.startsWith('#') || t.startsWith(';')) continue
    const m = re.exec(t)
    if (!m) continue
    const a = Number(m[1])
    const b = Number(m[2])
    const hasHour = m[3] !== undefined
    const c = hasHour ? Number(m[3]) : 0
    if (b >= 60 || c >= 60) continue // 分/秒越界视为非时间轴行，跳过
    const h = hasHour ? a : 0
    const min = hasHour ? b : a
    const sec = hasHour ? c : b
    const startMs = ((h * 60 + min) * 60 + sec) * 1000
    if (!Number.isFinite(startMs) || startMs < 0) continue
    const title = (m[4] ?? '').trim()
    const mark: ChapterMark = { startMs, title }
    if (!title) {
      defaulted.add(mark)
      mark.title = '章节' // 占位，最终按时间轴顺序重编号
    }
    out.push(mark)
    if (out.length >= MAX_CHAPTERS) break
  }
  out.sort((x, y) => x.startMs - y.startMs)
  const deduped = out.filter((c, i) => i === 0 || c.startMs !== out[i - 1]!.startMs)
  // 默认章节名按最终时间轴顺序编号（而非出现顺序）
  let n = 0
  for (const c of deduped) {
    if (defaulted.has(c)) c.title = `章节 ${++n}`
  }
  return deduped
}

/**
 * 纯函数（单测覆盖）：FFMETADATA 特殊字符转义（\\ ; # = 与换行前加反斜杠）。
 */
export function escapeFfmetadata(value: string): string {
  return value.replace(/([\\;#=])/g, '\\$1').replace(/\r?\n/g, '\\n')
}

/**
 * 纯函数（单测覆盖）：章节 → FFMETADATA 文本（;FFMETADATA1 头 + [CHAPTER] 段）。
 * 末章 END 取 totalMs（ffprobe 时长）；缺失回退 起点+1h（ffmpeg 封装侧按文件时长截断）。
 */
export function buildFfmetadata(chapters: ChapterMark[], totalMs: number | null): string {
  const lines: string[] = [';FFMETADATA1']
  for (let i = 0; i < chapters.length; i++) {
    const ch = chapters[i]!
    const nextStart = chapters[i + 1]?.startMs
    const endMs =
      nextStart !== undefined ? nextStart : (totalMs && totalMs > ch.startMs ? totalMs : ch.startMs + 3_600_000)
    lines.push('[CHAPTER]', 'TIMEBASE=1/1000', `START=${ch.startMs}`, `END=${Math.round(endMs)}`)
    lines.push(`title=${escapeFfmetadata(ch.title)}`)
  }
  return lines.join('\n') + '\n'
}
