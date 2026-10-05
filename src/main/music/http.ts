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
import { randomUUID } from 'crypto'
import { createLogger } from '../logger'

const log = createLogger('music-http')

type FetchInit = UndiciRequestInit & { dispatcher?: Agent }

const RETRY_STATUS = new Set([500, 502, 503, 504])
const RETRY_TOTAL = 2
const RETRY_BACKOFF_MS = 1000

// D4：镜像域清单（原 engine.py VERIFY_DISABLED_HOSTS + 修正：镜像实际使用
// haitangw.net 域，原清单仅 haitangw.com 后缀匹配永不命中，属 Python 版笔误）
const VERIFY_DISABLED_HOSTS = [
  // 第六轮审查：移除 music.126.net——网易官方音频 CDN（引擎从不主动访问该域取
  // 直链，四镜像 API 均不在清单内），对其关闭证书校验等于接受官方域 MITM，
  // 疑似从 Python 版照搬的过度豁免
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

// ── SSRF：手动重定向逐跳内网校验（第十轮审查：openStream 口径抽取共享）────
// undici 默认 follow（最多 20 跳）——被投毒镜像返回 302 跳内网（127.0.0.1/
// 169.254.169.254 等）会被自动跟随并把响应体回显/落盘，击穿 net-guard。
// 统一改手动循环：入口 + 每个跳转目标都过 isInternalUrl，协议白名单，上限 3 跳；
// dispatcher 按当前跳 URL 重算（跨域重定向不沿用初始 dispatcher 的 TLS 策略）。
// 内网拦截/协议违规按不可重试处理（重试只会原样复现）
async function fetchWithGuardedRedirects(
  url: string,
  init: {
    method?: string
    body?: UndiciRequestInit['body']
    headers: Headers
    signal?: AbortSignal
    dispatcherFor: (u: string) => Agent | undefined
  }
): Promise<Awaited<ReturnType<typeof undiciFetch>>> {
  const { isInternalUrl } = await import('../net-guard')
  let current = url
  if (await isInternalUrl(current)) {
    throw new NonRetryableError('请求地址为内网地址，已拦截')
  }
  for (let hop = 0; ; hop++) {
    const res = await undiciFetch(current, {
      method: init.method ?? 'GET',
      body: init.body,
      headers: init.headers,
      redirect: 'manual',
      signal: init.signal,
      dispatcher: init.dispatcherFor(current)
    })
    const location = res.headers.get('location')
    if (res.status >= 300 && res.status < 400 && location) {
      await res.body?.cancel().catch(() => {})
      if (hop >= 3) throw new NonRetryableError('重定向次数超限')
      let next: URL
      try {
        next = new URL(location, current)
      } catch {
        throw new NonRetryableError(`重定向地址无效：${location}`)
      }
      if (next.protocol !== 'https:' && next.protocol !== 'http:') {
        throw new NonRetryableError(`重定向协议不允许：${next.protocol}`)
      }
      if (await isInternalUrl(next.toString())) {
        throw new NonRetryableError('重定向目标为内网地址，已拦截')
      }
      current = next.toString()
      continue
    }
    return res
  }
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
      const res = await fetchWithGuardedRedirects(url, {
        method: init.method,
        body: init.body,
        headers: reqHeaders,
        signal: merged,
        dispatcherFor
      })
      // M5 修复：响应体大小上限——恶意/被投毒镜像可返回数百 MB JSON 撑爆主进程内存
      if (res.ok) {
        // 第六轮审查：200 但正文非 JSON（HTML 错误页/截断体）或超限属协议层错误，
        // 重试 3 次只会浪费额度——按不可重试处理（超时仍属网络层，保留重试）
        const text = await readBodyCapped(res, 8 * 1024 * 1024, url)
        try {
          return JSON.parse(text) as T
        } catch {
          throw new NonRetryableError('接口返回的不是有效 JSON（可能为错误页或被劫持）')
        }
      }
      if (!RETRY_STATUS.has(res.status)) {
        // 审查修复：4xx 路径同样消费响应体（防 undici socket 挂起，与 5xx 路径对称）
        await res.body?.cancel().catch(() => {})
        throw new NonRetryableError(`接口异常（HTTP ${res.status}）`)
      }
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
  // 第六轮审查：R5 的 Accept-Encoding 修复只落在 fetchJson/fetchToFile/openStream，
  // getText 漏网——咪咕歌词/汽水分享页返回 brotli 时 undici 不解压，正文变
  // 二进制（歌词降占位、_ROUTER_DATA 解析静默失败），与 R5 同型补齐
  const reqHeaders = new Headers(headers)
  if (!reqHeaders.has('accept-encoding')) {
    reqHeaders.set('accept-encoding', 'gzip, deflate')
  }
  let res: Awaited<ReturnType<typeof undiciFetch>>
  try {
    res = await fetchWithGuardedRedirects(url, {
      method: 'GET',
      headers: reqHeaders,
      signal: mergeSignal(opts.signal, opts.timeoutMs ?? 15_000),
      dispatcherFor
    })
  } catch (err) {
    logHttpFailure(url, err)
    throw new Error(humanizeNetworkError(err, url))
  }
  if (!res.ok) {
    // 审查修复：非 ok 同样释放响应体（防 socket 挂起）
    await res.body?.cancel().catch(() => {})
    throw new Error(`接口异常（HTTP ${res.status}）`)
  }
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
      // 第七轮审查 P3：超限属协议层错误必须不可重试——此前抛普通 Error 会
      // 被重试链再拉满 2 次全量响应体（~24MB + 退避）才失败
      throw new NonRetryableError(
        `响应体超过 ${Math.round(capBytes / 1024 / 1024)}MB 上限，疑似异常数据（${hostOf(url)}）`
      )
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
  opts: HttpOpts & { minBytes?: number; maxBytes?: number; onForeign?: () => void } = {}
): Promise<number> {
  const { signal, minBytes = 1024, maxBytes = 512 * 1024 * 1024 } = opts
  url = rewriteUrl(url)
  const { mkdir, rename, unlink, stat } = await import('fs/promises')
  const { dirname } = await import('path')
  // 第十轮审查 P2：目标已存在（≥minBytes）→ 不再拉流直接按成功返回。
  // 背景：QQ/酷狗/咪咕/汽水链 downloadFile 落到固定 mp3Path——音频已存在但
  // 歌词缺失（skip_existing 要求二者同时在）时，rename 撞已存在目标在 Windows
  // 必 EPERM → 返回 0 → 六个 br 全试一遍（每次完整下载后丢弃）→ 五平台全空，
  // 用户看到「所有平台均无法下载」。命中时 onForeign 通知调用方标记
  // lastProductForeign（产物非本任务落盘，取消清理/改名按 cached 语义跳过）
  if (minBytes > 0) {
    const existing = await stat(dest).catch(() => null)
    if (existing && existing.size >= minBytes) {
      opts.onForeign?.()
      return existing.size
    }
  }
  // 第九轮审查：part 名掺随机后缀——QQ/酷狗/咪咕/汽水链路此前共用固定
  // `${dest}.part`，同名歌曲并发任务（skip_existing 仅 tryAllPlatforms 开头
  // 判定一次）交错写入产生损坏产物。M2 修复只落在网易云链路，此处下沉到
  // fetchToFile 全链路生效
  const tmp = `${dest}.${randomUUID().slice(0, 8)}.part`
  // R5 修复同源：文件链路同样固定 Accept-Encoding——咪咕等 CDN 返回 brotli 时
  // undici 不会解压，写盘的是压缩字节流 = 播放不了的「假成功」音频
  const reqHeaders = new Headers(opts.headers ?? { 'User-Agent': 'Mozilla/5.0' })
  if (!reqHeaders.has('accept-encoding')) {
    reqHeaders.set('accept-encoding', 'gzip, deflate')
  }
  try {
    // 流式下载：headers 10s / body 不限时（大文件慢镜像不被总超时掐断）；
    // 对 5xx 做与 Python Retry(total=2) 一致的重试。
    // 第十轮审查：接入手动重定向逐跳内网校验（与 fetchJson/getText 同口径）
    let res = await fetchWithGuardedRedirects(url, {
      method: 'GET',
      headers: reqHeaders,
      signal,
      dispatcherFor: streamingDispatcherFor
    })
    for (let attempt = 0; RETRY_STATUS.has(res.status) && attempt < RETRY_TOTAL; attempt++) {
      await res.body?.cancel().catch(() => {}) // 消费旧响应体，防 socket 挂起
      await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS * (attempt + 1)))
      res = await fetchWithGuardedRedirects(url, {
        method: 'GET',
        headers: reqHeaders,
        signal,
        dispatcherFor: streamingDispatcherFor
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
      // 第七轮修复（流停滞检测）：body 不限时的副作用是黑洞镜像 TCP 可达但
      // 停止发数据时任务无限挂起——45s 无字节进度判定断流（走 reject → catch
      // 清理 part → 平台回退链继续下一个镜像/平台）
      const IDLE_MS = 45_000
      let lastData = Date.now()
      let stallTimer: ReturnType<typeof setInterval> | null = null
      let settled = false
      const finish = (fn: () => void): void => {
        if (settled) return
        settled = true
        if (stallTimer) clearInterval(stallTimer)
        fn()
      }
      stallTimer = setInterval(() => {
        if (Date.now() - lastData > IDLE_MS) {
          cleanup()
          finish(() =>
            reject(new Error(`下载停滞（45s 无进度，镜像可能已断流）：${hostOf(url)}`))
          )
        }
      }, 5_000)
      stallTimer.unref?.()
      nodeStream.on('data', (chunk: Buffer) => {
        lastData = Date.now()
        total += chunk.length
        // 审查修复：总字节上限——被投毒/异常镜像可无限流灌满磁盘（JSON 链路有
        // 8MB cap，文件链路此前刻意遗漏）；超限走 reject → catch 统一清理 part
        if (total > maxBytes) {
          cleanup()
          finish(() =>
            reject(new Error(`下载超过 ${Math.round(maxBytes / 1024 / 1024)}MB 上限，疑似异常数据（${hostOf(url)}）`))
          )
          return
        }
        if (!ws.write(chunk)) nodeStream.pause()
      })
      // drain 是可写流事件：写缓冲排空后恢复读取（挂在 nodeStream 上会永久挂起）
      ws.on('drain', () => nodeStream.resume())
      ws.on('error', (e) => {
        cleanup()
        finish(() => reject(e))
      })
      nodeStream.on('error', (e) => {
        cleanup()
        finish(() => reject(e))
      })
      nodeStream.on('end', () => {
        // 回归审查 P3：end 即停表——ws.end 回调（大缓冲慢盘 flush）可能超过 45s，
        // 停表延迟会把已完整传输的下载误判为停滞（语义安全但整段重下）
        if (stallTimer) {
          clearInterval(stallTimer)
          stallTimer = null
        }
        ws.end(() => finish(resolve))
      })
    })
    if (total < minBytes) {
      await unlink(tmp).catch(() => {})
      return 0
    }
    await rename(tmp, dest).catch(async (renameErr) => {
      // 第十轮审查 P2：与网易云链 exists 兜底同口径——rename 撞已存在目标
      // （并发同歌任务刚落盘）按 foreign 成功返回，清理 part
      const existing = await stat(dest).then(() => true).catch(() => false)
      if (existing) {
        opts.onForeign?.()
        return stat(dest).then((s) => s.size)
      }
      throw renameErr
    })
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
  // R5 修复同源：试听流固定 gzip/deflate（brotli 流不解压 = 坏音频流）
  const headers = new Headers({ 'User-Agent': 'Mozilla/5.0', ...extraHeaders })
  if (!headers.has('accept-encoding')) {
    headers.set('accept-encoding', 'gzip, deflate')
  }
  let res: Awaited<ReturnType<typeof undiciFetch>>
  try {
    // 第九轮审查（SSRF）：undici 默认 follow 重定向——公网 302 跳内网（127.0.0.1/
    // 169.254.169.254 等）会被自动跟随并把响应体原样回显，击穿 net-guard 防线。
    // 改手动重定向逐跳校验（保留镜像 CDN 302 直链的合法场景，上限 3 跳）
    const { isInternalUrl } = await import('../net-guard')
    let current = url
    for (let hop = 0; ; hop++) {
      res = await undiciFetch(current, {
        method: 'GET',
        headers,
        redirect: 'manual',
        dispatcher: streamingDispatcherFor(current)
      })
      const location = res.headers.get('location')
      if (res.status >= 300 && res.status < 400 && location) {
        await res.body?.cancel().catch(() => {})
        if (hop >= 3) throw new Error('重定向次数超限')
        let next: URL
        try {
          next = new URL(location, current)
        } catch {
          throw new Error(`重定向地址无效：${location}`)
        }
        if (next.protocol !== 'https:' && next.protocol !== 'http:') {
          throw new Error(`重定向协议不允许：${next.protocol}`)
        }
        if (await isInternalUrl(next.toString())) {
          throw new Error('重定向目标为内网地址，已拦截')
        }
        current = next.toString()
        continue
      }
      break
    }
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
  opts: HttpOpts & { onForeign?: () => void } = {}
): Promise<boolean> {
  const n = await fetchToFile(url, dest, { ...opts, minBytes: 1024 })
  return n >= 1024
}
