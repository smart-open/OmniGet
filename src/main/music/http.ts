// 音乐引擎共享 HTTP 基建（对应 Python requests.Session + Retry + D4 TLS 策略）
// - 重试：total=2，backoff，仅 500/502/503/504（与 Python urllib3 Retry 口径一致）
// - D4 TLS：默认全量证书校验；仅第三方镜像域豁免（内容为公开音频流，无敏感数据）
// - 取消：所有请求携带 AbortSignal，取消即刻中断（优于 Python 版协作式取消）

// 统一使用 npm undici 的 fetch（与 Agent 同源，保证 dispatcher 兼容；
// Node 内置 fetch 的内置 undici 版本与 npm 包可能不一致，混用有运行时风险）
import { Agent, fetch as undiciFetch, type RequestInit as UndiciRequestInit } from 'undici'

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

/** 不可重试错误（4xx 等）：立即上抛，避免对第三方 API 做无效重试 */
class NonRetryableError extends Error {}

/** JSON 请求（带简单重试，等价 urllib3 Retry 口径：仅 5xx 与网络错误重试） */
export async function fetchJson<T = unknown>(
  url: string,
  init: FetchInit = {},
  opts: HttpOpts = {}
): Promise<T> {
  const { signal, timeoutMs = 15_000 } = opts
  let lastErr: unknown = new Error('unreachable')
  for (let attempt = 0; attempt <= RETRY_TOTAL; attempt++) {
    try {
      const merged = mergeSignal(signal, timeoutMs)
      const res = await undiciFetch(url, {
        ...init,
        signal: merged,
        dispatcher: dispatcherFor(url)
      })
      if (res.ok) return (await res.json()) as T
      if (!RETRY_STATUS.has(res.status)) throw new NonRetryableError(`HTTP ${res.status}`)
      // 5xx：消费掉旧响应体再重试（防 undici socket 挂起）
      await res.body?.cancel().catch(() => {})
      if (attempt >= RETRY_TOTAL) throw new Error(`HTTP ${res.status}`)
      await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS * (attempt + 1)))
    } catch (err) {
      if (signal?.aborted || err instanceof NonRetryableError) throw err
      lastErr = err
      if (attempt < RETRY_TOTAL) {
        await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS * (attempt + 1)))
      }
    }
  }
  throw lastErr
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
  const res = await undiciFetch(url, {
    method: 'GET',
    headers,
    signal: mergeSignal(opts.signal, opts.timeoutMs ?? 15_000),
    dispatcher: dispatcherFor(url)
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.text()
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
    if (!res.ok || !res.body) return 0
    await mkdir(dirname(dest), { recursive: true })
    let total = 0
    const { createWriteStream } = await import('fs')
    const { Readable } = await import('stream')
    const ws = createWriteStream(tmp)
    const nodeStream = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0])
    await new Promise<void>((resolve, reject) => {
      nodeStream.on('data', (chunk: Buffer) => {
        total += chunk.length
        if (!ws.write(chunk)) nodeStream.pause()
      })
      // drain 是可写流事件：写缓冲排空后恢复读取（挂在 nodeStream 上会永久挂起）
      ws.on('drain', () => nodeStream.resume())
      ws.on('error', reject)
      nodeStream.on('error', reject)
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
    return 0
  }
}

/** 打开响应流（试听代理用）：连接超时 10s、body 不限时；由 protocol 层转发 body */
export async function openStream(
  url: string
): Promise<{ status: number; ok: boolean; contentType: string; contentLength: string | null; body: unknown }> {
  const res = await undiciFetch(url, {
    method: 'GET',
    headers: { 'User-Agent': 'Mozilla/5.0' },
    dispatcher: streamingDispatcherFor(url)
  })
  return {
    status: res.status,
    ok: res.ok,
    contentType: res.headers.get('content-type') ?? 'audio/mpeg',
    contentLength: res.headers.get('content-length'),
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
