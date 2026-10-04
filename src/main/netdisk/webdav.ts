// backlog #26（2026-10-03）：WebDAV / OpenList 客户端（设置卡片 + 目录浏览 + 提交下载的数据面）。
// ⚠ 安全口径（与 backlog #11 sidecar 同一信任边界）：用户显式配置的自托管地址，
// 放行 http、不做内网校验（OpenList 常部署在本机/局域网）；凭据仅注入请求头，
// 响应摘要不回显；日志不落凭据。

import { getSettingParsed } from '../db'
import { getWebdavCredentials } from './credentials'

export interface NetdiskEntry {
  /** 展示名（displayname 优先，回退 href 末段） */
  name: string
  isDir: boolean
  size: number
  /** 相对端点根的服务器路径（如 /movies/foo.mp4），浏览导航与下载 URL 构造共用 */
  path: string
}

export interface NetdiskProbeResult {
  ok: boolean
  detail: string
}

/** 设置键 → 规范化端点（trim + 去尾斜杠 + http(s) 校验；空/非法返回 null） */
export function normalizeWebdavBase(raw: string | null | undefined): string | null {
  const v = typeof raw === 'string' ? raw.trim().replace(/\/+$/, '') : ''
  return /^https?:\/\//i.test(v) ? v : null
}

/** 读取设置中的端点（netdisk.endpoint；未配置返回 null = 功能禁用） */
export function getWebdavEndpoint(): string | null {
  return normalizeWebdavBase(getSettingParsed<string>('netdisk.endpoint'))
}

/** 端点 + 服务器路径 → 完整 URL（逐段百分号编码，防路径特殊字符破坏请求） */
export function webdavUrlFor(base: string, path: string): string {
  const clean = ('/' + path).replace(/\/+/g, '/')
  const encoded = clean
    .split('/')
    .map((seg) => (seg ? encodeURIComponent(seg) : ''))
    .join('/')
  return base.replace(/\/+$/, '') + encoded
}

/** Basic 认证头（无凭据/匿名返回 null） */
export function basicAuthHeader(): string | null {
  const creds = getWebdavCredentials()
  if (!creds || !creds.username) return null
  return `Basic ${Buffer.from(`${creds.username}:${creds.password}`).toString('base64')}`
}

// ── PROPFIND 解析（纯函数，单测覆盖）────────────────────────────────

interface RawEntry {
  name: string
  isDir: boolean
  size: number
  /** href 原文（未解码；listWebdav 负责归一化为相对 path） */
  href: string
}

function firstTag(body: string, tag: string): string | null {
  const m = new RegExp(`<(?:[\\w.-]+:)?${tag}(?:\\s[^>]*)?>([^<]*)<`, 'i').exec(body)
  return m?.[1] ?? null
}

/** XML 五个预定义实体 + 数字字符引用解码（displayname/href 常见 &amp; &apos; 等） */
function decodeXmlEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/** 解析 207 multistatus XML（命名空间前缀不定：d:/D:/裸标签均容忍） */
export function parsePropfind(xml: string): RawEntry[] {
  const out: RawEntry[] = []
  const blocks = xml.split(/<(?:[\w.-]+:)?response[\s>]/i).slice(1)
  for (const block of blocks) {
    const endIdx = block.search(/<\/(?:[\w.-]+:)?response\s*>/i)
    const body = endIdx >= 0 ? block.slice(0, endIdx) : block
    const rawHref = firstTag(body, 'href') ?? ''
    let href = decodeXmlEntities(rawHref.trim())
    try {
      href = decodeURIComponent(href)
    } catch {
      // 畸形编码：保留原文
    }
    const displayname = decodeXmlEntities((firstTag(body, 'displayname') ?? '').trim())
    const isDir = /<(?:[\w.-]+:)?collection\s*\/?>/i.test(body)
    const size = Number(firstTag(body, 'getcontentlength') ?? '0') || 0
    let name = displayname
    if (!name) {
      const seg = href.split('/').filter(Boolean).pop() ?? ''
      // href 可能是绝对 URL
      name = seg.split('?')[0] || '/'
    }
    if (!href) continue
    out.push({ name, isDir, size: isDir ? 0 : size, href })
  }
  return out
}

/** href（已解码）→ 相对端点根的服务器路径 */
export function hrefToPath(base: string, href: string): string {
  let pathname = href
  try {
    // 绝对 URL 取 pathname；相对路径原样
    if (/^https?:\/\//i.test(href)) pathname = new URL(href).pathname
  } catch {
    // 保持原样
  }
  const basePath = new URL(base).pathname.replace(/\/+$/, '').toLowerCase()
  let p = pathname.replace(/\/+$/, '')
  if (basePath && p.toLowerCase().startsWith(basePath)) p = p.slice(basePath.length) || '/'
  return p.startsWith('/') ? p : `/${p}`
}

// ── 目录列举 / 连接测试 ─────────────────────────────────────────────

/** 第六轮审查：按累计字节截断读取响应体（超限即拒绝），防内存 DoS */
async function readCappedText(res: Response, capBytes: number): Promise<string> {
  if (!res.body) return ''
  const decoder = new TextDecoder()
  let total = 0
  const parts: string[] = []
  for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength
    if (total > capBytes) {
      await res.body.cancel().catch(() => {})
      throw new Error(`响应体超过 ${Math.round(capBytes / 1024 / 1024)}MB 上限，疑似异常端点`)
    }
    parts.push(decoder.decode(chunk, { stream: true }))
  }
  parts.push(decoder.decode())
  return parts.join('')
}

/**
 * PROPFIND Depth:1 列目录。返回按目录优先 + 名称排序的条目（不含自身）。
 * 401/404/非 207 均抛带出口动作的中文错误。
 */
export async function listWebdav(path: string): Promise<NetdiskEntry[]> {
  const base = getWebdavEndpoint()
  if (!base) throw new Error('未配置网盘/WebDAV 地址（设置 → 下载 → 网盘聚合）')
  const clean = ('/' + (path ?? '/')).replace(/\/+/g, '/')
  // 审查修复（安全发现 3）：拒绝路径穿越/非法字符——被攻破的渲染层不得借
  // netdisk:list 以主进程为代理探测端点根之外的任意服务器路径
  if (/(^|\/)\.\.?(\/|$)/.test(clean) || clean.includes('\0') || clean.includes('\\')) {
    throw new Error('目录路径不合法')
  }
  const url = webdavUrlFor(base, clean)
  const headers: Record<string, string> = { Depth: '1' }
  const auth = basicAuthHeader()
  if (auth) headers.Authorization = auth
  let res: Response
  try {
    res = await fetch(url, { method: 'PROPFIND', headers, signal: AbortSignal.timeout(12_000) })
  } catch {
    throw new Error('无法连接网盘/WebDAV 服务：网络不可达或超时')
  }
  if (res.status === 401) {
    // 第六轮审查：401/404 提前 throw 不消费响应体 → socket 滞留（反复输错密码
    // 持续累积），与非 207 分支的 body.cancel 口径对齐
    await res.body?.cancel().catch(() => {})
    throw new Error('认证失败（401）：请检查设置中的用户名/密码')
  }
  if (res.status === 404) {
    await res.body?.cancel().catch(() => {})
    throw new Error(`目录不存在（404）：${clean}`)
  }
  if (res.status !== 207) {
    await res.body?.cancel().catch(() => {})
    throw new Error(
      `目录读取失败（HTTP ${res.status}）：请确认地址为 WebDAV 端点（OpenList 示例 http://host:5240/dav）`
    )
  }
  // 第六轮审查：207 正文无上限——异常/被投毒端点可回超大 XML 撑内存（与音乐域
  // 8MB JSON 上限同口径，PROPFIND 目录页远小于此）
  const xml = await readCappedText(res, 8 * 1024 * 1024)
  const selfPath = clean.replace(/\/+$/, '') || '/'
  const entries: NetdiskEntry[] = []
  for (const raw of parsePropfind(xml)) {
    const p = hrefToPath(base, raw.href).replace(/\/+$/, '') || '/'
    if (p === selfPath) continue // Depth:1 回显自身，过滤
    entries.push({ name: raw.name, isDir: raw.isDir, size: raw.isDir ? 0 : raw.size, path: p })
  }
  entries.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1))
  return entries
}

/** 设置页「测试连接」：PROPFIND Depth:0 探测端点（区分可达/认证失败） */
export async function probeWebdav(): Promise<NetdiskProbeResult> {
  const base = getWebdavEndpoint()
  if (!base) return { ok: false, detail: '地址格式有误：需要 http:// 或 https:// 前缀' }
  const headers: Record<string, string> = { Depth: '0' }
  const auth = basicAuthHeader()
  if (auth) headers.Authorization = auth
  let res: Response
  try {
    res = await fetch(base, { method: 'PROPFIND', headers, signal: AbortSignal.timeout(8000) })
  } catch (err) {
    return { ok: false, detail: `无法连接：${err instanceof Error ? err.message : String(err)}` }
  }
  await res.body?.cancel().catch(() => {})
  if (res.status === 207) return { ok: true, detail: '连接成功（WebDAV 端点可达）' }
  if (res.status === 401) {
    return auth
      ? { ok: false, detail: '地址可达，但认证失败（401）：请检查用户名/密码' }
      : { ok: false, detail: '地址可达，但需要认证（401）：请填写用户名/密码并保存' }
  }
  if (res.status === 404) {
    return { ok: false, detail: '地址可达，但路径不存在（404）：请核对 WebDAV 路径（OpenList 常为 /dav）' }
  }
  return { ok: false, detail: `服务响应异常（HTTP ${res.status}）：请确认该地址提供 WebDAV 出口` }
}
