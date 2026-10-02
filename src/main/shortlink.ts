// 短视频短链/分享文案展开（R7 P1，docs/下载引擎优化方案 §三 P1 短视频-1）
// 端口：抖音 v.douyin.com / 快手 v.kuaishou.com / 小红书 xhslink.com / B 站 b23.tv
// 语义：分享文案（"7.20 xyz:/ https://v.douyin.com/xxx/ 打开抖音"）→ 提取 URL →
//       短链 302 还原为完整链接再分流（Evil0ctal/Douyin_TikTok_Download_API 口径）。
// 边界：仅对已知视频/短链域名改写，纯文本歌名（音乐查询）不受影响。

export const SHORTLINK_HOSTS = /^(v\.douyin\.com|v\.kuaishou\.com|xhslink\.com|b23\.tv)$/i

const VIDEO_HOST_PATTERN =
  /(^|\.)(youtube\.com|youtu\.be|bilibili\.com|b23\.tv|douyin\.com|iesdouyin\.com|kuaishou\.com|xiaohongshu\.com|xhslink\.com|weibo\.com|weibo\.cn|ixigua\.com)$/i

/** 从任意文本提取首个 http(s) URL（容忍中文标点/markdown 尾缀） */
export function extractFirstUrl(text: string): string | null {
  const m = /https?:\/\/[^\s"'<>，。；；、）】》！？,;!?]+/i.exec(text)
  if (!m) return null
  // 剥离常见尾缀污染（右括号/引号成对出现的场景不做——简单剥离集合即可）
  return m[0].replace(/[)）\]】>》.,;；]+$/, '')
}

/** 提取全部去重 http(s) URL（R7 P1 多源：多镜像粘贴合并为单任务） */
export function extractHttpUrls(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s"'<>，。；；、）】》！？,;!?]+/gi) ?? []
  const out: string[] = []
  for (const raw of matches) {
    const u = raw.replace(/[)）\]】>》.,;；]+$/, '')
    if (!out.includes(u)) out.push(u)
  }
  return out
}

/** 供调用方判定 URL 是否落在视频/短链域（多链接粘贴分流用） */
export function isVideoHostUrl(url: string): boolean {
  try {
    return VIDEO_HOST_PATTERN.test(new URL(url).hostname)
  } catch {
    return false
  }
}

function isShortLink(url: string): boolean {
  try {
    return SHORTLINK_HOSTS.test(new URL(url).hostname)
  } catch {
    return false
  }
}

export interface ExpandResult {
  source: string
  /** 输入是短视频分享短链（展开后 noWatermark 默认 true，§4.3.1） */
  wasShortLink: boolean
  /** 发生了改写（短链展开 / 分享文案提取） */
  rewritten: boolean
}

/**
 * 输入源规范化（createTask 前调用）：
 * 1. 输入含 URL 且本身不是裸 URL（分享文案）→ 提取 URL（仅当 URL 是已知视频/短链域，防误伤普通文本）
 * 2. URL 是已知短链域 → 302 跟随一次还原完整链接
 * 其余输入原样返回（网络异常也原样返回，由后续流程按原输入处理）。
 */
export async function expandInputSource(raw: string): Promise<ExpandResult> {
  const input = raw.trim()
  if (!input) return { source: raw, wasShortLink: false, rewritten: false }

  let candidate: string | null = null
  let fromText = false
  if (/^https?:\/\//i.test(input)) {
    candidate = input.split(/\s+/)[0] ?? input // 裸 URL 后跟文案时取首段
  } else {
    const extracted = extractFirstUrl(input)
    if (extracted) {
      try {
        // 仅当目标是已知视频/短链域才接管，否则维持原输入（音乐名等）
        if (VIDEO_HOST_PATTERN.test(new URL(extracted).hostname)) {
          candidate = extracted
          fromText = true
        }
      } catch {
        // 非法 URL：维持原输入
      }
    }
  }
  if (!candidate) return { source: raw, wasShortLink: false, rewritten: false }

  const wasShortLink = isShortLink(candidate)
  if (!wasShortLink) {
    return { source: fromText ? candidate : raw, wasShortLink: false, rewritten: fromText }
  }

  // 短链 302 还原（redirect: manual 只跟一跳；短链服务均为单跳 30x）
  try {
    const res = await fetch(candidate, {
      method: 'GET', // 部分短链对 HEAD 返回 405，用 GET（body 立即取消）
      redirect: 'manual',
      signal: AbortSignal.timeout(8000)
    })
    void res.body?.cancel().catch(() => {})
    const location = res.headers.get('location')
    if (location && [301, 302, 303, 307, 308].includes(res.status)) {
      const expanded = new URL(location, candidate).toString()
      return { source: expanded, wasShortLink: true, rewritten: true }
    }
    // 无跳转（已失效/风控）：交回原短链，由引擎侧报错并给出口动作
    return { source: candidate, wasShortLink: true, rewritten: fromText }
  } catch {
    // 网络异常：交回原短链（ytdlp 侧有完整的失败归因）
    return { source: candidate, wasShortLink: true, rewritten: fromText }
  }
}
