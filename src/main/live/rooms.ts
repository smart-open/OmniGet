// 三期（0.10.x，backlog #25）：直播间页 URL 分型与取流辅助。
// 纯函数模块（可单测）：只做「直播间页 URL 识别 + 各平台取流所需请求头」，
// 不发请求、不碰引擎——解析链见 ./resolve.ts。

export interface LiveRoomInfo {
  /** 站点标识（bilibili/douyu/huya/douyin），健康归因与请求头选择用 */
  platform: string
  /** 房间号（URL 首段路径；b23.tv 短链等重定向形态不在此处理） */
  roomId: string
}

/** 直播间页 URL 规则表（按 host 判定；房间号 = 首段路径）。
 * 顺序敏感：live.douyin.com 必须先于 douyin 通用域在 sniffer 中被消费，
 * 此处只给出规则，判定顺序由 sniffer 保证（live 判定先于 VIDEO_DOMAINS） */
const LIVE_ROOM_RULES: { hostPattern: RegExp; platform: string }[] = [
  { hostPattern: /(^|\.)live\.bilibili\.com$/i, platform: 'bilibili' },
  { hostPattern: /(^|\.)douyu\.com$/i, platform: 'douyu' },
  { hostPattern: /(^|\.)huya\.com$/i, platform: 'huya' },
  { hostPattern: /(^|\.)live\.douyin\.com$/i, platform: 'douyin' }
]

/** 直播间页 URL 识别：非 http(s)、无房间号段、或宿主不匹配 → null。
 * 房间号段须为数字或合理字母段（防把平台首页当成直播间） */
export function detectLiveRoom(rawUrl: string): LiveRoomInfo | null {
  let u: URL
  try {
    u = new URL(rawUrl)
  } catch {
    return null
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  const host = u.hostname.toLowerCase()
  const rule = LIVE_ROOM_RULES.find((r) => r.hostPattern.test(host))
  if (!rule) return null
  const seg = u.pathname.split('/').filter(Boolean)[0] ?? ''
  // 房间号：数字（B站/斗鱼/虎牙/抖音均为主流）或 4-32 位字母数字段（个别自定义域名）
  if (!/^[0-9]{3,20}$/.test(seg) && !/^[a-zA-Z0-9_-]{4,32}$/.test(seg)) return null
  // 平台首页/功能页伪房间段（如 douyu.com/topic、douyu.com/live）排除——
  // 4-32 位字母段规则较宽，遗漏的功能页会被误判成房间号走解析失败路径
  if (/^(topic|index|home|about|help|search|directory|active|live|play|member|wap|app|download|news|rank|schedule)$/i.test(seg)) {
    return null
  }
  return { platform: rule.platform, roomId: seg }
}

/** 各直播间平台的取流请求头（N_m3u8DL-RE --header 注入）：
 * B站/抖音直播 CDN 校验 Referer/UA，缺头取流 403；虎牙/斗鱼对头不敏感但带上无害 */
export function streamHeadersFor(platform: string): Array<{ name: string; value: string }> {
  switch (platform) {
    case 'bilibili':
      return [
        { name: 'Referer', value: 'https://live.bilibili.com/' },
        { name: 'Origin', value: 'https://live.bilibili.com' }
      ]
    case 'douyin':
      return [{ name: 'Referer', value: 'https://live.douyin.com/' }]
    case 'douyu':
      return [{ name: 'Referer', value: 'https://www.douyu.com/' }]
    case 'huya':
      return [{ name: 'Referer', value: 'https://www.huya.com/' }]
    default:
      return []
  }
}

/** 平台公开 API 兜底（仅 B站，公开无签名接口——合规红线：不自研签名算法） */
export const BILI_ROOM_API = 'https://api.live.bilibili.com'
