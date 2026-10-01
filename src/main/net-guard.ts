// 内网/回环地址防护（M3：嗅探与直链探测的 SSRF 防线）
// 下载器特性允许用户提交任意 URL，但主进程"代发请求 + 回显响应头"的路径
// （嗅探、HEAD 探测、引擎镜像分发）不得成为内网探测通道。

import { lookup } from 'dns/promises'

/** 域名解析复核结果缓存（进程生命周期内同域只查一次，避免高频探测放大 DNS 查询） */
const resolveCache = new Map<string, boolean>()

function isPrivateIPv4Bytes(a: number, b: number): boolean {
  if (a === 10 || a === 127 || a === 0) return true
  if (a === 192 && b === 168) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
  return false
}

export function isPrivateIPv4(host: string): boolean {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host)
  if (!m) return false
  return isPrivateIPv4Bytes(Number(m[1]), Number(m[2]))
}

function isPrivateIpLiteral(host: string): boolean {
  if (isPrivateIPv4(host)) return true
  if (host === '::' || host === '::1') return true // 未指定地址 / 回环
  if (!host.includes(':')) return false
  // P1 修复：完整 IPv6 解析——WHATWG URL 会把 [64:ff9b::10.0.0.1] 规范化为
  // [64:ff9b::a00:1]（内嵌 IPv4 变十六进制形态），点分正则覆盖不全。
  // 解析成 8 个 16 位组后统一判定 mapped/NAT64/ULA/link-local
  const groups = parseIPv6(host)
  if (!groups) return false
  if (groups.every((g) => g === 0)) return true // 全零（:: 展开后）
  const first = groups[0] ?? 0
  if (first >= 0xfc00 && first <= 0xfdff) return true // ULA fc00::/7
  if (first >= 0xfe80 && first <= 0xfebf) return true // link-local fe80::/10
  // IPv4-mapped ::ffff:0:0/96 或 NAT64 64:ff9b::/96：解包内嵌 IPv4 按 IPv4 判定
  const isMapped = groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff
  const isNat64 = groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((g) => g === 0)
  if (isMapped || isNat64) {
    const hi = groups[6] ?? 0
    const lo = groups[7] ?? 0
    return isPrivateIPv4Bytes(hi >>> 8, hi & 0xff) || isPrivateIPv4Bytes(lo >>> 8, lo & 0xff)
  }
  return false
}

/** 解析 IPv6 为 8 个 16 位组（含 :: 压缩与尾部内嵌 IPv4），非法返回 null */
function parseIPv6(host: string): number[] | null {
  let rest = host
  let tail: number[] = []
  const v4m = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(host)
  if (v4m?.[2]) {
    const parts = v4m[2].split('.').map(Number)
    if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return null
    tail = [((parts[0] ?? 0) << 8) | (parts[1] ?? 0), ((parts[2] ?? 0) << 8) | (parts[3] ?? 0)]
    rest = v4m[1] ?? ''
  }
  const halves = rest.split('::')
  if (halves.length > 2) return null
  const parseGroups = (side: string): number[] | null => {
    if (side === '') return []
    const groups = side.split(':').map((g) => parseInt(g, 16))
    if (groups.some((g) => Number.isNaN(g))) return null
    return groups
  }
  const head = parseGroups(halves[0] ?? '')
  const back = parseGroups(halves[1] ?? '')
  if (!head || !back) return null
  if (halves.length === 2) {
    const fill = 8 - tail.length - head.length - back.length
    if (fill < 1) return null
    return [...head, ...Array.from({ length: fill }, () => 0), ...back, ...tail]
  }
  if (head.length + tail.length !== 8) return null
  return [...head, ...tail]
}

/**
 * 校验 URL 是否可安全由主进程代发探测请求。
 * 拒绝：非 http(s)、回环/私网/链路本地/保留地址字面量、localhost 及内网伪 TLD、
 * 以及 DNS 解析结果全部为内网地址的域名（防域名 → 内网的 rebinding 式绕过）。
 */
export async function isInternalUrl(rawUrl: string): Promise<boolean> {
  let u: URL
  try {
    u = new URL(rawUrl)
  } catch {
    return true
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return true
  const host = u.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '') // FQDN 尾点归一（localhost. 不依赖 lookup 兜底）
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return true
  }
  if (isPrivateIpLiteral(host)) return true
  // IP 字面量之外做 DNS 解析复核（结果缓存，进程生命周期内同域只查一次）
  const cached = resolveCache.get(host)
  if (cached !== undefined) return cached
  try {
    const addrs = await lookup(host, { all: true })
    // H1 修复：混合记录（公网+内网并存）必须判内网——真实请求可能命中任意一条
    // A 记录（此前 every 判定被单条公网记录击穿，fail-open）
    const result =
      addrs.length === 0 ||
      addrs.some((a) =>
        a.family === 4 ? isPrivateIPv4(a.address) : isPrivateIpLiteral(a.address)
      )
    // L-7 对齐 engine-fetch 口径：只缓存「确认内网」的判定（内网域恒定）——
    // 公网判定不落缓存，域名后续被 rebinding 到内网时下一轮探测仍会复核
    if (result) resolveCache.set(host, result)
    return result
  } catch {
    return true // 解析失败按内网处理（fail-closed）
  }
}
