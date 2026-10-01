// 内网/回环地址防护（M3：嗅探与直链探测的 SSRF 防线）
// 下载器特性允许用户提交任意 URL，但主进程"代发请求 + 回显响应头"的路径
// （嗅探、HEAD 探测、引擎镜像分发）不得成为内网探测通道。

import { lookup } from 'dns/promises'

/** 域名解析复核结果缓存（进程生命周期内同域只查一次，避免高频探测放大 DNS 查询） */
const resolveCache = new Map<string, boolean>()

export function isPrivateIPv4(host: string): boolean {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host)
  if (!m) return false
  const [a, b] = [Number(m[1]), Number(m[2])]
  if (a === 10 || a === 127 || a === 0) return true
  if (a === 192 && b === 168) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
  return false
}

function isPrivateIpLiteral(host: string): boolean {
  if (isPrivateIPv4(host)) return true
  if (host === '::1') return true
  if (/^f[cd][0-9a-f]{2}:/i.test(host)) return true // IPv6 ULA (fc00::/7)
  if (/^fe80/i.test(host)) return true // IPv6 link-local
  return false
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
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '')
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
