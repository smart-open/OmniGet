// 音乐引擎共享 HTTP 基建（对应 Python requests.Session + Retry + D4 TLS 策略）
// - 重试：total=2，backoff，仅 500/502/503/504（与 Python urllib3 Retry 口径一致）
// - D4 TLS：默认全量证书校验；仅第三方镜像域豁免（内容为公开音频流，无敏感数据）
// - 取消：所有请求携带 AbortSignal，取消即刻中断（优于 Python 版协作式取消）

// 统一使用 npm undici 的 fetch（与 Agent 同源，保证 dispatcher 兼容；
// Node 内置 fetch 的内置 undici 版本与 npm 包可能不一致，混用有运行时风险）
// ⚠️ undici 必须固定在 v6 线（^6.21）：v7+ 依赖 node:util markAsUncloneable（Node 22+），
// Electron 33 内置 Node 20.18 加载即崩（App threw an error during load）。
// 升级 undici 前必须先核对 Electron 内置 Node 版本（ELECTRON_RUN_AS_NODE=1 npx electron -p process.version）。
import { Agent, fetch as undiciFetch, type RequestInit as UndiciRequestInit } from 'undici'
import { createLogger } from '../logger'

const log = createLogger('music-http')

type FetchInit = UndiciRequestInit & { dispatcher?: Agent }

const RETRY_STATUS = new Set([500, 502, 503, 504])
const RETRY_TOTAL = 2
const RETRY_BACKOFF_MS = 1000

// D4：镜像域清单（原 engine.py VERIFY_DISABLED_HOSTS + 修正：镜像实际使用
// haitangw.net 域，原清单仅 haitangw.com 后缀匹配永不命中，属 Python 版笔误）
const VERIFY_DISABLED_HOSTS = [
  'music.126.net', // 网易云音频 CDN 镜像
  'cenguigui.cn',
  'rrvenn.cn',
  'toubiec.cn',
  'haitangw.com',
  'haitangw.net'
]

export function isMirrorHost(host: string): boolean {
  const h = host.toLowerCase()
  return VERIFY_DISABLED_HOSTS.some((d) => h === d || h.endsWith('.' + d))
}

/**
 * 试听/音频下载的目标域名白名单（SSRF 防线）：镜像 API 返回的直链
 * 必须落在已知音乐 CDN/镜像域内才允许主进程拉取并回流渲染层。
 */
const AUDIO_CDN_SUFFIXES = [
  '126.net', // 网易云 CDN（*.music.126.net 等）
  'qq.com', // QQ 音乐 CDN（isure.stream.qqmusic.qq.com 等）
  'kugou.com', // 酷狗
  'migu.cn', // 咪咕
  'douyin.com', // 汽水/抖音
  ...VERIFY_DISABLED_HOSTS // 镜像自身（部分镜像直接代理音频）
] as const

export function isTrustedAudioHost(host: string): boolean {
  const h = host.toLowerCase()
  return AUDIO_CDN_SUFFIXES.some((d) => h === d || h.endsWith('.' + d))
}

const insecureAgent = new Agent({ connect: { rejectUnauthorized: false } })

// ── Backlog：平台适配脚本 host 重写（scripts.ts 注入，http 层统一改写）────
// 平台 API 改版时由适配脚本把官方域指向镜像域，免发版自救。
// TLS 豁免随目标域自动生效：改写后 isMirrorHost 判断的是新域。
let scriptHostOverrides = new Map<string, string>()

export function setScriptHostOverrides(m: Map<string, string>): void {
  scriptHostOverrides = m
}

export function rewriteUrl(url: string): string {
  if (scriptHostOverrides.size === 0) return url
  try {
    const u = new URL(url)
    const target = scriptHostOverrides.get(u.hostname.toLowerCase())
    if (target) {
      // 目标形如 host 或 host:port：经 URL 解析拆分，避免 port 混入 hostname
      const parsed = new URL(`http://${target}`)
      u.hostname = parsed.hostname
      if (parsed.port) u.port = parsed.port
      return u.toString()
    }
  } catch {
    // 非法 URL/目标：原样返回，交由调用方报错
  }
  return url
}
// 试听流专用：连接 10s 超时、body 不限时（对应 Python socket 超时口径，长歌曲不被掐断）
const streamingAgent = new Agent({
  connect: { rejectUnauthorized: false },
  headersTimeout: 10_000,
  bodyTimeout: 0
})
const streamingSecureAgent = new Agent({ headersTimeout: 10_000, bodyTimeout: 0 })

function dispatcherFor(url: string): Agent | undefined {
  try {
    const host = new URL(url).hostname
    return isMirrorHost(host) ? insecureAgent : undefined
  } catch {
    return undefined
  }
}

function streamingDispatcherFor(url: string): Agent {
  try {
    return isMirrorHost(new URL(url).hostname) ? streamingAgent : streamingSecureAgent
  } catch {
    return streamingSecureAgent
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

export interface HttpOpts {
  signal?: AbortSignal
  timeoutMs?: number
  headers?: Record<string, string>
}

function mergeSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const t = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([signal, t]) : t
}

// ── 网络错误中文化（§4.1：用户可见文案必须中文 + 出口动作）────────────
// undici 的顶层错误是英文 'fetch failed'，真实原因在 cause 链的 errno 上，
// 逐层下钻归因后给出中文原因 + 检查建议。

/** 用户可取消（AbortController）与超时（AbortSignal.timeout）在 err.name 区分 */
function isAbortLike(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')
}

const ERRNO_REASONS: Record<string, string> = {
  ENOTFOUND: '域名解析失败（检查 DNS/网络）',
  EAI_AGAIN: '域名解析暂时失败（检查 DNS/网络）',
  ECONNREFUSED: '服务器拒绝连接（服务可能已下线）',
  ECONNRESET: '连接被重置',
  ECONNABORTED: '连接中断',
  ETIMEDOUT: '连接超时',
  UND_ERR_CONNECT_TIMEOUT: '连接超时',
  UND_ERR_HEADERS_TIMEOUT: '服务器响应超时',
  UND_ERR_BODY_TIMEOUT: '响应体传输超时',
  UND_ERR_SOCKET: '网络连接中断',
  EPIPE: '网络连接中断',
  ENETUNREACH: '网络不可达（检查网络/代理）',
  EHOSTUNREACH: '主机不可达（检查网络/代理）',
  CERT_HAS_EXPIRED: 'TLS 证书已过期',
  ERR_TLS_CERT_ALTNAME_INVALID: 'TLS 证书域名不匹配',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'TLS 自签名证书',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'TLS 证书无法验证',
  SELF_SIGNED_CERT_IN_CHAIN: 'TLS 证书链含自签名'
}

/** 把 fetch 相关错误归因为中文（带出口动作）；未识别错误原样返回 message */
export function humanizeNetworkError(err: unknown, url = ''): string {
  let host = ''
  if (url) {
    try {
      host = new URL(url).hostname
    } catch {
      host = ''
    }
  }
  const suffix = host ? `（${host}）` : ''
  if (isAbortLike(err)) return `请求超时或已取消${suffix}`
  // cause 链下钻（fetch failed → cause errno）
  let cur: unknown = err
  for (let depth = 0; depth < 6 && cur instanceof Error; depth++) {
    const code = (cur as NodeJS.ErrnoException).code ?? ''
    const reason = ERRNO_REASONS[code]
    if (reason) return `网络请求失败：${reason}${suffix}，请检查网络或代理后重试`
    cur = (cur as Error & { cause?: unknown }).cause
  }
  const msg = err instanceof Error ? err.message : String(err)
  if (msg) return `${msg}${suffix}，请检查网络后重试`
  return `网络请求失败${suffix}，请检查网络或代理后重试`
}

/** 失败统一记日志（含 URL 与原始错误），便于事后归因 */
function logHttpFailure(url: string, err: unknown): void {
  const code =
    err instanceof Error ? ((err as NodeJS.ErrnoException).code ?? err.name) : typeof err
  log.error(`HTTP 请求失败: ${url}`, { code, detail: String(err) })
}

/** 不可重试错误（4xx 等）：立即上抛，避免对第三方 API 做无效重试 */
class NonRetryableError extends Error {}

/** JSON 请求（带简单重试，等价 urllib3 Retry 口径：仅 5xx 与网络错误重试） */
export async function fetchJson<T = unknown>(
  url: string,
  init: FetchInit = {},
  opts: HttpOpts = {}
): Promise<T> {
  const { signal, timeoutMs = 15_000 } = opts
  url = rewriteUrl(url)
  let lastErr: unknown = new Error('unreachable')
  for (let attempt = 0; attempt <= RETRY_TOTAL; attempt++) {
    try {
      const merged = mergeSignal(signal, timeoutMs)
      // R5 修复：咪咕等接口返回未解压的压缩体（brotli）→ JSON.parse 得到二进制
      // 乱码（「锟斤拷…is not valid JSON」）。显式声明只收 gzip/deflate——undici
      // 对这两种编码确定会自动解压；调用方自带 Accept-Encoding 时不覆盖
      const reqHeaders = new Headers(init.headers)
      if (!reqHeaders.has('accept-encoding')) {
        reqHeaders.set('accept-encoding', 'gzip, deflate')
      }
      const res = await undiciFetch(url, {
        ...init,
        headers: reqHeaders,
        signal: merged,
        dispatcher: dispatcherFor(url)
      })
      // M5 修复：响应体大小上限——恶意/被投毒镜像可返回数百 MB JSON 撑爆主进程内存
      if (res.ok) return (await readBodyCapped(res, 8 * 1024 * 1024, url).then((s) => JSON.parse(s))) as T
      if (!RETRY_STATUS.has(res.status)) throw new NonRetryableError(`接口异常（HTTP ${res.status}）`)
      // 5xx：消费掉旧响应体再重试（防 undici socket 挂起）
      await res.body?.cancel().catch(() => {})
      if (attempt >= RETRY_TOTAL) throw new Error(`接口异常（HTTP ${res.status}）`)
      await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS * (attempt + 1)))
    } catch (err) {
      if (signal?.aborted || err instanceof NonRetryableError) throw err
      lastErr = err
      if (attempt < RETRY_TOTAL) {
        await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS * (attempt + 1)))
      }
    }
  }
  // 重试耗尽：归因中文化（用户可见）+ 记日志（排障）
  logHttpFailure(url, lastErr)
  throw new Error(humanizeNetworkError(lastErr, url))
}

export async function getJson<T = unknown>(
  url: string,
  headers?: Record<string, string>,
  opts: HttpOpts = {}
): Promise<T> {
  return fetchJson<T>(url, { method: 'GET', headers }, opts)
}

export async function postJson<T = unknown>(
  url: string,
  body: unknown,
  headers?: Record<string, string>,
  opts: HttpOpts = {}
): Promise<T> {
  return fetchJson<T>(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body)
    },
    opts
  )
}

export async function postForm<T = unknown>(
  url: string,
  data: Record<string, string | number>,
  headers?: Record<string, string>,
  opts: HttpOpts = {}
): Promise<T> {
  const body = new URLSearchParams(
    Object.entries(data).map(([k, v]) => [k, String(v)] as [string, string])
  ).toString()
  return fetchJson<T>(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
      body
    },
    opts
  )
}

/** GET 文本（歌词等） */
export async function getText(url: string, headers?: Record<string, string>, opts: HttpOpts = {}): Promise<string> {
  url = rewriteUrl(url)
  let res: Awaited<ReturnType<typeof undiciFetch>>
  try {
    res = await undiciFetch(url, {
      method: 'GET',
      headers,
      signal: mergeSignal(opts.signal, opts.timeoutMs ?? 15_000),
      dispatcher: dispatcherFor(url)
    })
  } catch (err) {
    logHttpFailure(url, err)
    throw new Error(humanizeNetworkError(err, url))
  }
  if (!res.ok) throw new Error(`接口异常（HTTP ${res.status}）`)
  // M5：歌词等文本同样限 2MB
  return readBodyCapped(res, 2 * 1024 * 1024, url)
}

/** M5：按累计字节截断读取响应体（超限即拒绝），防内存 DoS */
async function readBodyCapped(
  res: Awaited<ReturnType<typeof undiciFetch>>,
  capBytes: number,
  url: string
): Promise<string> {
  const decoder = new TextDecoder()
  let total = 0
  const parts: string[] = []
  for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength
    if (total > capBytes) {
      await res.body?.cancel().catch(() => {})
      throw new Error(`响应体超过 ${Math.round(capBytes / 1024 / 1024)}MB 上限，疑似异常数据（${hostOf(url)}）`)
    }
    parts.push(decoder.decode(chunk, { stream: true }))
  }
  parts.push(decoder.decode())
  return parts.join('')
}

/**
 * 流式下载到文件（等价 _fetch_url_to_file）：返回实际字节数，失败返回 0。
 * 增量写盘（无损文件可达数十 MB，不进内存）；最小字节数由调用方判定。
 */
export async function fetchToFile(
  url: string,
  dest: string,
  opts: HttpOpts & { minBytes?: number } = {}
): Promise<number> {
  const { signal, minBytes = 1024 } = opts
  url = rewriteUrl(url)
  const { mkdir, rename, unlink } = await import('fs/promises')
  const { dirname } = await import('path')
  const tmp = `${dest}.part`
  try {
    // 流式下载：headers 10s / body 不限时（大文件慢镜像不被总超时掐断）；
    // 对 5xx 做与 Python Retry(total=2) 一致的重试
    let res = await undiciFetch(url, {
      method: 'GET',
      headers: opts.headers ?? { 'User-Agent': 'Mozilla/5.0' },
      signal,
      dispatcher: streamingDispatcherFor(url)
    })
    for (let attempt = 0; RETRY_STATUS.has(res.status) && attempt < RETRY_TOTAL; attempt++) {
      await res.body?.cancel().catch(() => {}) // 消费旧响应体，防 socket 挂起
      await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS * (attempt + 1)))
      res = await undiciFetch(url, {
        method: 'GET',
        headers: opts.headers ?? { 'User-Agent': 'Mozilla/5.0' },
        signal,
        dispatcher: streamingDispatcherFor(url)
      })
    }
    if (!res.ok || !res.body) {
      // R4-P3：4xx/重试耗尽仍 5xx 静默返回 0 会让「这个平台为什么下不了」无法排查
      logHttpFailure(url, new Error(`HTTP ${res.status}`))
      return 0
    }
    await mkdir(dirname(dest), { recursive: true })
    let total = 0
    const { createWriteStream } = await import('fs')
    const { Readable } = await import('stream')
    const ws = createWriteStream(tmp)
    const nodeStream = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0])
    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        // M4 修复：任一侧失败必须销毁上游响应体与文件流，防 socket/句柄滞留
        nodeStream.destroy()
        res.body?.cancel().catch(() => {})
        ws.destroy()
      }
      nodeStream.on('data', (chunk: Buffer) => {
        total += chunk.length
        if (!ws.write(chunk)) nodeStream.pause()
      })
      // drain 是可写流事件：写缓冲排空后恢复读取（挂在 nodeStream 上会永久挂起）
      ws.on('drain', () => nodeStream.resume())
      ws.on('error', (e) => {
        cleanup()
        reject(e)
      })
      nodeStream.on('error', (e) => {
        cleanup()
        reject(e)
      })
      nodeStream.on('end', () => ws.end(() => resolve()))
    })
    if (total < minBytes) {
      await unlink(tmp).catch(() => {})
      return 0
    }
    await rename(tmp, dest)
    return total
  } catch (err) {
    await unlink(tmp).catch(() => {})
    if (signal?.aborted) throw err
    // 静默容错语义保持（返回 0 由调用方降级），但必须记日志供排障
    logHttpFailure(url, err)
    return 0
  }
}

/** 打开响应流（试听代理用）：连接超时 10s、body 不限时；由 protocol 层转发 body。
 *  R6：extraHeaders 支持转发 Range——<audio> 拖动进度需要上游 206 分段响应 */
export async function openStream(
  url: string,
  extraHeaders?: Record<string, string>
): Promise<{
  status: number
  ok: boolean
  contentType: string
  contentLength: string | null
  contentRange: string | null
  acceptRanges: boolean
  body: unknown
}> {
  url = rewriteUrl(url)
  let res: Awaited<ReturnType<typeof undiciFetch>>
  try {
    res = await undiciFetch(url, {
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0', ...extraHeaders },
      dispatcher: streamingDispatcherFor(url)
    })
  } catch (err) {
    logHttpFailure(url, err)
    throw new Error(humanizeNetworkError(err, url))
  }
  return {
    status: res.status,
    ok: res.ok,
    contentType: res.headers.get('content-type') ?? 'audio/mpeg',
    contentLength: res.headers.get('content-length'),
    contentRange: res.headers.get('content-range'),
    acceptRanges: res.headers.get('accept-ranges') === 'bytes',
    body: res.body
  }
}

/** 整体下载（等价 _download_file）：<1KB 视为失败不落盘。
 *  注：流式下载不设总超时（大文件慢镜像不被掐断），连接超时由 streamingAgent 承担 */
export async function downloadFile(
  url: string,
  dest: string,
  opts: HttpOpts = {}
): Promise<boolean> {
  const n = await fetchToFile(url, dest, { ...opts, minBytes: 1024 })
  return n >= 1024
}
