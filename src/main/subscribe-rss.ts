// 三期（0.10.x，backlog #18 边界收敛）：RSS/Atom 订阅源解析 + 订阅条目过滤。
// 纯函数模块（可单测）：零依赖正则解析（播客/视频 RSS 形态收敛），
// 条目 URL 取值优先级 enclosure > media:content > yt:videoId > link。

export interface FeedEntry {
  url: string
  title: string
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function cdata(inner: string): string {
  return inner.replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '')
}

function tagText(block: string, tag: string): string | null {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i')
  const m = re.exec(block)
  return m ? decodeXmlEntities(cdata(m[1]!.trim())) : null
}

function attrOf(block: string, tag: string, attr: string): string | null {
  const re = new RegExp(`<${tag}[^>]*\\s${attr}="([^"]*)"`, 'i')
  const m = re.exec(block)
  return m ? decodeXmlEntities(m[1]!) : null
}

/** 解析 RSS 2.0 / Atom 订阅源文本（<item> / <entry> 两形态）。
 * 条目 URL 取值优先级：enclosure > yt:videoId(→ YouTube watch) > media:content > link。
 * （media:content 在部分源里是会过期的 CDN 直链——压过稳定 watch 链会制造
 * 永久失败条目并被去重档案封死，故 yt:videoId 优先于 media:content）
 * 非 http(s) 或空 URL 条目丢弃；上限 50 */
export function parseFeed(xml: string): FeedEntry[] {
  const out: FeedEntry[] = []
  const itemRe = /<(?:item|entry)[\s>][\s\S]*?<\/(?:item|entry)>/gi
  let m: RegExpExecArray | null
  while ((m = itemRe.exec(xml)) !== null && out.length < 50) {
    const block = m[0]
    const title = tagText(block, 'title') ?? ''
    const enclosure = attrOf(block, 'enclosure', 'url')
    const mediaUrl = attrOf(block, 'media:content', 'url')
    const ytVideoId = tagText(block, 'yt:videoId') ?? attrOf(block, 'yt:videoId', 'id')
    const linkTag = tagText(block, 'link')
    const link = linkTag ?? attrOf(block, 'link', 'href')
    const url =
      enclosure ??
      (ytVideoId ? `https://www.youtube.com/watch?v=${ytVideoId.trim()}` : null) ??
      mediaUrl ??
      link
    if (!url || !/^https?:\/\//i.test(url.trim())) continue
    out.push({ url: url.trim(), title: decodeXmlEntities(title).trim().slice(0, 200) })
  }
  return out
}

/** 拆分关键词过滤串：逗号/中文逗号/顿号/空白分隔，去空、限 20 个、单词 ≤60 字符 */
export function parseKeywords(raw: string | null | undefined): string[] {
  if (!raw) return []
  return raw
    .split(/[,，、\s]+/)
    .map((k) => k.trim().toLowerCase())
    .filter((k) => k.length > 0 && k.length <= 60)
    .slice(0, 20)
}

export interface FilterableEntry {
  url: string
  title: string
  /** 秒（yt-dlp flat 条目有；RSS 条目无 → null 视为通过） */
  durationSec?: number | null
}

export interface SubscriptionFilter {
  /** 最短时长秒（0 = 不过滤） */
  filterMinSec?: number
  filterKeywords?: string | null
}

/** 条目级过滤：时长下限（无时长信息视为通过）+ 关键词任一命中（无关键词视为通过） */
export function filterEntries<T extends FilterableEntry>(entries: T[], sub: SubscriptionFilter): T[] {
  const minSec = Math.max(0, Math.round(sub.filterMinSec ?? 0))
  const keywords = parseKeywords(sub.filterKeywords)
  return entries.filter((e) => {
    if (minSec > 0 && typeof e.durationSec === 'number' && Number.isFinite(e.durationSec)) {
      if (e.durationSec < minSec) return false
    }
    if (keywords.length > 0) {
      const title = e.title.toLowerCase()
      if (!keywords.some((k) => title.includes(k))) return false
    }
    return true
  })
}
