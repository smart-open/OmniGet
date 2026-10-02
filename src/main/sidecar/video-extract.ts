// 短视频解析服务 sidecar —— 响应提取纯函数（backlog #11，R7 续）。
// 独立于 db/http 依赖：单测可直接导入，不触发 better-sqlite3 ABI 加载。
//
// 口径：Evil0ctal/Douyin_TikTok_Download_API v5 自托管实例的
// POST /api/hybrid/video_data 混合解析端点——对 douyin/tiktok/kuaishou/
// xiaohongshu 等平台返回统一的类抖音结构（data.video.play_addr.url_list 等）。
// 不同版本/平台存在字段漂移，故按「优先级路径 → 启发式兜底」两级提取。
//
// ⚠ 合规边界（backlog #11 明示）：不自研 a_bogus/X-Bogus 等签名——算法高频
// 变更且头部开源项目已因合规停止维护；本模块只消费自托管服务的公开 HTTP API。

export interface SidecarVideo {
  /** 可下载直链（CDN 签名 URL，有时效） */
  url: string
  /** 作品标题（产物命名用） */
  title?: string
  /** 封面图 URL（预留，暂不落库） */
  coverUrl?: string
}

/** sidecar 混合解析覆盖的平台（manager 兜底闸门用；yt-dlp 缺快手/小红书 extractor） */
export const SIDECAR_PLATFORMS = ['douyin', 'kuaishou', 'xiaohongshu', 'xigua', 'weibo', 'tiktok']

/** 平台标识 → 中文标签（通知/健康文案用） */
export function platformLabel(platform: string): string {
  const map: Record<string, string> = {
    douyin: '抖音',
    kuaishou: '快手',
    xiaohongshu: '小红书',
    weibo: '微博',
    xigua: '西瓜视频',
    tiktok: 'TikTok'
  }
  return map[platform] ?? platform
}

// ── 直链提取 ────────────────────────────────────────────────────────

interface UrlHit {
  path: string
  url: string
}

/** 排除：封面/头像/分享页/话题文本等非媒体 URL */
const EXCLUDE_PATH =
  /cover|thumb|icon|image|pic|avatar|logo|share|tag|text|desc|title|web_url|canonical/i

/** 优先级规则：rank 越小越优先（play_addr 为无水印主流直链；快手原始结构 mainMvUrls） */
const RANK_RULES: Array<[RegExp, number]> = [
  [/play_addr\.url_list/, 0],
  [/download_addr\.url_list/, 1],
  [/mainMvUrls/, 1],
  [/master_url/, 2],
  [/backup_url/i, 3],
  [/play_url|playApi|video_url|video_resource/i, 4]
]

const MAX_DEPTH = 14
const MAX_HITS = 200

function walkUrls(node: unknown, path: string, hits: UrlHit[], origin: string, depth: number): void {
  if (depth > MAX_DEPTH || hits.length >= MAX_HITS) return
  if (typeof node === 'string') {
    if (/^https?:\/\//i.test(node) && node !== origin && !EXCLUDE_PATH.test(path)) {
      hits.push({ path, url: node })
    }
    return
  }
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      walkUrls(node[i], `${path}[${i}]`, hits, origin, depth + 1)
    }
    return
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      walkUrls(v, path ? `${path}.${k}` : k, hits, origin, depth + 1)
    }
  }
}

function rankOf(path: string): number {
  for (const [re, rank] of RANK_RULES) {
    if (re.test(path)) return rank
  }
  // 启发式：路径含视频/流媒体语义的作次级兜底；无任何媒体语义的（普通 url 字段）
  // rank 6 —— pickVideoUrl 对 rank 6 直接判负（图集/分享页等误报防线）
  return /video|media|stream|manifest|representation/i.test(path) ? 5 : 6
}

/** 从混合解析响应里挑出最佳视频直链；挑不到返回 null（图集/纯图文场景） */
export function pickVideoUrl(payload: unknown, originUrl: string): string | null {
  const hits: UrlHit[] = []
  walkUrls(payload, '', hits, originUrl, 0)
  if (hits.length === 0) return null
  hits.sort((a, b) => {
    const ra = rankOf(a.path)
    const rb = rankOf(b.path)
    if (ra !== rb) return ra - rb
    // 同级优先 .mp4 直链；再按 URL 长度（CDN 直链通常带完整签名参数）
    const ma = /\.mp4/i.test(a.url) ? 0 : 1
    const mb = /\.mp4/i.test(b.url) ? 0 : 1
    if (ma !== mb) return ma - mb
    return b.url.length - a.url.length
  })
  const best = hits[0]
  if (!best || rankOf(best.path) >= 6) return null
  return best.url
}

function firstUrlUnder(payload: unknown, re: RegExp): string | undefined {
  const hits: UrlHit[] = []
  walkUrls(payload, '', hits, '', 0)
  return hits.find((h) => re.test(h.path))?.url
}

/** 结构化提取（title/cover/url）；无直链返回 null */
export function extractSidecarVideo(payload: unknown, originUrl: string): SidecarVideo | null {
  const url = pickVideoUrl(payload, originUrl)
  if (!url) return null
  const obj = (payload ?? {}) as Record<string, unknown>
  const video = (obj.video ?? {}) as Record<string, unknown>
  const title =
    typeof obj.desc === 'string' && obj.desc.trim()
      ? obj.desc
      : typeof obj.title === 'string' && obj.title.trim()
        ? obj.title
        : undefined
  return {
    url,
    title: title?.trim().slice(0, 200),
    coverUrl: firstUrlUnder(video, /cover/i)
  }
}
