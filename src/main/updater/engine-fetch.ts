// R6：引擎按需下载（首启免 262MB 全量捆绑）
// 分发约定（默认 GitHub Releases，可用设置 engines.mirror 指向自建镜像）：
//   <mirror>/<platform>-<arch>/manifest.json   → { files: { <二进制名>: sha256 } }
//   <mirror>/<platform>-<arch>/<二进制名>      → 引擎文件本体
// 流程：仅补缺失（已存在且指纹通过的引擎不覆盖）→ 流式下载 .part（边下边算 SHA256）
// → 与 manifest 比对（不符即丢弃，杜绝投毒）→ 原子改名安装 → TOFU 指纹登记。
import { createHash } from 'crypto'
import { createReadStream, createWriteStream } from 'fs'
import { chmod, mkdir, rename, rm, stat } from 'fs/promises'
import { dirname } from 'path'
import { lookup } from 'dns/promises'
import { pipeline } from 'stream/promises'
import { fetch as undiciFetch } from 'undici'
import type { SidecarBinary } from '../orchestrator/binaries'
import { binaryPath, checksumFile, enginesDir, recordFingerprint, toolPath } from '../orchestrator/binaries'
import { getSettingParsed, setSetting } from '../db'
import { createLogger } from '../logger'

const log = createLogger('engine-fetch')

export const DEFAULT_MIRROR = 'https://github.com/smart-open/OmniGet/releases/latest/download'

/**
 * C2 修复：镜像信任锚。
 * - 仅允许 https（防明文劫持替换二进制）
 * - 拒绝回环/私网/链路本地地址（防"设置镜像"成为内网探测通道）
 * - 主机须在已知分发域白名单内（可经 engines.mirrorHosts 扩展，扩展项同样过公网校验）
 * SHA256 只证明"与 manifest 一致"，manifest 与二进制必须来自可信主机才有信任锚。
 */
const TRUSTED_MIRROR_HOSTS = [
  'github.com',
  'objects.githubusercontent.com',
  'raw.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'cdn.jsdelivr.net',
  'fastly.jsdelivr.net',
  'gitee.com'
]

const ipLiteralPrivate =
  /^(127\.|10\.|192\.168\.|169\.254\.|0\.|::1$|f[cd][0-9a-f]{2}:)/i

function isPrivateIPv4(host: string): boolean {
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

/** DNS 解析结果全部必须是公网地址（防域名解析到内网的 rebinding 式绕过） */
const resolvedHostCache = new Map<string, boolean>()
async function isPublicHost(host: string): Promise<boolean> {
  if (isPrivateIPv4(host)) return false
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return false
  if (ipLiteralPrivate.test(host)) return false
  const cached = resolvedHostCache.get(host)
  if (cached !== undefined) return cached
  try {
    const addrs = await lookup(host, { all: true })
    const ok =
      addrs.length > 0 &&
      addrs.every(
        (a) =>
          (a.family === 4 && !isPrivateIPv4(a.address)) ||
          (a.family === 6 && !/^(::1|f[cd]|fe80)/i.test(a.address))
      )
    // M2 修复：只缓存"确认公网"的结果——首启离线/DNS 抖动期的不可信判定不得
    // 钉死整个进程生命周期（此前 false 永久缓存，github.com 会被误拒到重启为止）
    if (ok) resolvedHostCache.set(host, true)
    return ok
  } catch {
    return false // 解析失败按不可信处理（fail-closed），但不落缓存
  }
}

async function assertTrustedMirror(mirror: string): Promise<void> {
  let u: URL
  try {
    u = new URL(mirror)
  } catch {
    throw new Error('镜像地址格式不合法')
  }
  if (u.protocol !== 'https:') throw new Error('镜像必须使用 https')
  const custom = getSettingParsed<string[]>('engines.mirrorHosts') ?? []
  const allowlist = [...TRUSTED_MIRROR_HOSTS, ...custom.filter((h) => typeof h === 'string')]
  const host = u.hostname.toLowerCase()
  if (!allowlist.includes(host)) {
    throw new Error(
      `镜像主机不在可信分发域列表（${host}）。如需自建镜像，请在设置中将其域名加入 engines.mirrorHosts`
    )
  }
  if (!(await isPublicHost(host))) {
    throw new Error(`镜像主机不可指向内网/回环地址（${host}）`)
  }
}

/** 可信镜像基址（不可信时回退官方源并告警） */
function mirrorBase(): string {
  const v = getSettingParsed<string>('engines.mirror')
  if (typeof v === 'string' && /^https:\/\//i.test(v.trim())) {
    return v.trim().replace(/\/+$/, '')
  }
  if (typeof v === 'string' && v.trim()) {
    log.warn(`engines.mirror 非 https，已忽略并回退官方源：${v.trim()}`)
  }
  return DEFAULT_MIRROR
}

/** 参与按需下载的引擎（ffprobe 为可选工具，同样支持补齐）。
 * deno（backlog #16）：yt-dlp 外部 JS 运行时（YouTube EJS 要求），与 yt-dlp
 * 同目录放置即被识别（jsruntime.ts 另做 PATH 注入双保险）。
 * ⚠ TOFU 覆盖面备案（第七轮审查）：ffprobe 会由主进程执行 → 入 TOFU 闸门
 * （sidecar: 'ffprobe'）；deno 主进程从不执行（由 yt-dlp 自行调用，无强制点）
 * → 维持不入 TOFU，为显式接受项 */
const ENGINE_FILES: Array<{ name: string; kind: 'sidecar' | 'tool'; sidecar?: SidecarBinary }> = [
  { name: 'aria2c', kind: 'sidecar', sidecar: 'aria2c' },
  { name: 'ffmpeg', kind: 'sidecar', sidecar: 'ffmpeg' },
  { name: 'ffprobe', kind: 'tool', sidecar: 'ffprobe' },
  { name: 'yt-dlp', kind: 'sidecar', sidecar: 'ytdlp' },
  { name: 'deno', kind: 'tool' },
  // backlog #17：HLS/DASH 引擎（发布侧直接放置解包后的单文件，免 zip 解压支持）
  { name: 'N_m3u8DL-RE', kind: 'sidecar', sidecar: 'nm3u8re' }
]

const fileOf = (name: string): string =>
  process.platform === 'win32' ? `${name}.exe` : name

function dirKey(): string {
  return `${process.platform}-${process.arch}`
}

function pathOf(name: string): string {
  return ENGINE_FILES.find((e) => e.name === name)?.kind === 'tool' ? toolPath(name) : binaryPath(name as SidecarBinary)
}

export interface EngineStatusEntry {
  name: string
  file: string
  installed: boolean
  size?: number
}

export async function engineStatus(): Promise<EngineStatusEntry[]> {
  const out: EngineStatusEntry[] = []
  for (const e of ENGINE_FILES) {
    const p = pathOf(e.name)
    const st = await stat(p).catch(() => null)
    out.push({ name: e.name, file: fileOf(e.name), installed: !!st, size: st?.size })
  }
  return out
}

export interface FetchResult {
  installed: string[]
  skipped: string[]
  failed: Array<{ name: string; error: string }>
}

function manifestUrl(base: string): string {
  return `${base}/${dirKey()}/manifest.json`
}

/** 一期 0.8.0（backlog §一 #3）：资产定位双口径。
 * 自建镜像/raw 分支用目录式（<platform>-<arch>/manifest.json）；GitHub Releases
 * 的资产是平铺命名空间（不支持子目录），发布工作流按
 * <platform>-<arch>-<文件名> 上传——目录式 404 时回退扁平口径。 */
type MirrorLayout = 'dir' | 'flat'

function fileUrl(base: string, layout: MirrorLayout, file: string): string {
  return layout === 'dir'
    ? `${base}/${dirKey()}/${encodeURIComponent(file)}`
    : `${base}/${dirKey()}-${encodeURIComponent(file)}`
}

async function fetchManifest(base: string): Promise<{ files: Record<string, string>; layout: MirrorLayout }> {
  let lastStatus = 0
  for (const layout of ['dir', 'flat'] as const) {
    const url = layout === 'dir' ? manifestUrl(base) : `${base}/${dirKey()}-manifest.json`
    const res = await undiciFetch(url, { signal: AbortSignal.timeout(15_000) })
    if (res.status === 404) {
      // 目录式 404 = 分发源可能只提供扁平资产，继续试下一口径
      lastStatus = 404
      continue
    }
    if (!res.ok) throw new Error(`manifest 获取失败（HTTP ${res.status}）`)
    const raw = (await res.json()) as { files?: Record<string, string> }
    if (!raw?.files || typeof raw.files !== 'object') throw new Error('manifest 格式不合法')
    return { files: raw.files, layout }
  }
  // 404 = 分发源尚无当前平台目录（发布资产未就绪，backlog #3）——给出可自解释
  // 的文案，避免每次启动的"补齐失败"通知让用户误判为故障
  throw new Error(`manifest 获取失败（HTTP ${lastStatus}）（分发源暂未提供该平台的引擎清单，等待发布资产）`)
}

/** 第七轮：空闲超时——60s 无任何字节进度才中断（硬 10min 总超时对弱网大引擎
 * ~100-200MB 必超时且每次从 0 重来；配合下方 Range 断点续传后弱网也能装完） */
const FETCH_IDLE_TIMEOUT_MS = 60_000

async function downloadAndVerify(url: string, sha256: string, dest: string, onProgress?: (received: number, total: number) => void): Promise<void> {
  const part = `${dest}.part`
  // 第七轮审查 P1：引擎目录可能尚未创建（全新安装/按需目录回退到 userData/engines）——
  // createWriteStream 的异步 open ENOENT 会被 pipeline 吞成下载失败且每次启动重复
  // 失败。与 updater/ytdlp.ts 同口径：落盘前先建目录
  await mkdir(dirname(part), { recursive: true })

  // 第七轮：断点续传——已存在的 .part 发起 Range 续传（失败路径不再删 .part，
  // 残缺部分最终由 SHA256 比对兜底丢弃）；服务器不支持 Range（200）则从头重下
  const partStat = await stat(part).catch(() => null)
  let offset = partStat?.size ?? 0
  if (offset > 0) log.info(`resuming download from ${offset} bytes: ${dest}`)

  const controller = new AbortController()
  let idleTimer: NodeJS.Timeout | null = null
  const armIdle = (): void => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      controller.abort(new Error(`下载停滞（${FETCH_IDLE_TIMEOUT_MS / 1000}s 无进度）`))
    }, FETCH_IDLE_TIMEOUT_MS)
    idleTimer.unref?.()
  }
  try {
    armIdle()
    let res = await undiciFetch(url, {
      headers: offset > 0 ? { range: `bytes=${offset}-` } : undefined,
      signal: controller.signal
    })
    if (res.ok && offset > 0 && res.status !== 206) {
      // 服务器不支持 Range：忽略 .part 从头重下
      offset = 0
    }
    if (res.status === 206 && offset > 0) {
      // 回归审查 P3：206 必须校验 Content-Range 起始偏移——镜像/代理返回错位
      // 206（如从 0 开始）时新旧数据拼接错乱（最终有 SHA256 兜底，但弱网下会
      // 「看似在续传、实则反复整包校验失败从零重来」），错位按不支持 Range 处理
      const cr = /^bytes\s+(\d+)-/i.exec(res.headers.get('content-range') ?? '')
      if (!cr || cr[1] !== String(offset)) {
        log.warn(
          `content-range mismatch (expect offset ${offset}, got "${res.headers.get('content-range') ?? ''}")，回退整包重下`
        )
        offset = 0
      }
    }
    if (res.status === 416 && offset > 0) {
      // .part 已达/超过远端体积（上次写到尾部中断）：丢弃重下
      await rm(part, { force: true }).catch(() => {})
      offset = 0
      res = await undiciFetch(url, { signal: controller.signal })
    }
    if (!res.ok || !res.body) throw new Error(`下载失败（HTTP ${res.status}）`)
    const body = res.body
    const total = offset + Number(res.headers.get('content-length') ?? 0)
    const hash = createHash('sha256')
    if (offset > 0) {
      // 续传：先对既有部分求哈希（新数据续接后才可能通过整包 SHA256 比对）
      const existing = createReadStream(part)
      for await (const chunk of existing) hash.update(chunk as Buffer)
    }
    const ws = createWriteStream(part, { flags: offset > 0 ? 'a' : 'w' })
    let received = offset
    try {
      await pipeline(
        (async function* () {
          for await (const chunk of body) {
            armIdle()
            const buf = chunk as Buffer
            hash.update(buf)
            received += buf.length
            onProgress?.(received, total)
            yield buf
          }
        })(),
        ws
      )
    } finally {
      // 失败路径保留 .part 供下次续传（残缺内容由最终 SHA256 比对兜底丢弃）
      if (idleTimer) clearTimeout(idleTimer)
    }
    const digest = hash.digest('hex')
    if (digest !== sha256.toLowerCase()) {
      await rm(part, { force: true })
      throw new Error(`SHA256 校验不符（期望 ${sha256.slice(0, 12)}…，实际 ${digest.slice(0, 12)}…），已丢弃`)
    }
    await mkdir(enginesDir(), { recursive: true })
    await rename(part, dest)
    // H2 修复：Unix 侧按需安装的引擎必须有执行位（createWriteStream 默认 0644，
    // 否则 checkBinary 的 access(X_OK) 永远失败，首启补齐后引擎必挂）
    if (process.platform !== 'win32') {
      await chmod(dest, 0o755).catch((err: unknown) =>
        log.warn(`chmod +x failed for ${dest}`, err)
      )
    }
  } finally {
    if (idleTimer) clearTimeout(idleTimer)
  }
}

export interface FetchOptions {
  onProgress?: (name: string, received: number, total: number) => void
  /** 仅补这些引擎（缺省 = 全部缺失项） */
  names?: string[]
}

/** 补齐缺失引擎；全部就绪/无分发源时快速返回。安装成功即登记 TOFU 指纹。 */
export async function fetchMissingEngines(opts: FetchOptions = {}): Promise<FetchResult> {
  // H5 修复 + R4-P1 修正：串行链必须回写链尾——此前从未赋回 fetchChain，
  // 并发调用实际并行执行（同一 .part 互相踩踏），与 ytdlp 热更器同型空操作
  const p = fetchChain.then(() => runFetchMissingEngines(opts))
  fetchChain = p.then(
    () => undefined,
    () => undefined
  )
  return p
}

let fetchChain: Promise<unknown> = Promise.resolve()

async function runFetchMissingEngines(opts: FetchOptions): Promise<FetchResult> {
  const result: FetchResult = { installed: [], skipped: [], failed: [] }
  // C2 修复：分发源必须可信（https + 白名单域 + 公网地址），否则拒绝安装。
  // 审查修复（TOCTOU，10-03）：基址只读一次并全程使用快照——此前 assertTrustedMirror
  // 校验的是当时的 mirrorBase()，而 fetchManifest/下载 URL 各自重读 settings；
  // 被攻破的渲染层可在校验通过后的 IO 窗口内改写 engines.mirror，让 manifest 与
  // 二进制都来自未校验源（SHA256 自签 → TOFU 基线被污染 → 供应链防线整体绕过）
  const base = mirrorBase()
  try {
    await assertTrustedMirror(base)
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    log.warn(`engine mirror untrusted: ${error}`)
    for (const e of opts.names ?? []) result.failed.push({ name: e, error })
    if (!opts.names?.length) {
      const status = await engineStatus()
      for (const e of status.filter((x) => !x.installed)) result.failed.push({ name: e.name, error })
    }
    return result
  }
  const status = await engineStatus()
  const wanted = status.filter((e) => !e.installed && (!opts.names || opts.names.includes(e.name)))
  if (wanted.length === 0) return result

  let manifest: Record<string, string>
  let layout: MirrorLayout = 'dir'
  try {
    const m = await fetchManifest(base)
    manifest = m.files
    layout = m.layout
  } catch (err) {
    const error = `${err instanceof Error ? err.message : String(err)}（分发源：${manifestUrl(base)}）`
    for (const e of wanted) result.failed.push({ name: e.name, error })
    log.warn(`engine manifest unavailable: ${error}`)
    return result
  }
  if (layout === 'flat') log.info(`engine mirror uses flat asset naming (${dirKey()}-<file>)`)

  for (const e of wanted) {
    const file = fileOf(e.name)
    const sha = manifest[file]
    if (!sha || !/^[0-9a-f]{64}$/i.test(sha)) {
      result.failed.push({ name: e.name, error: '分发源清单中缺少该引擎的 SHA256（不可信来源，拒绝安装）' })
      continue
    }
    try {
      await downloadAndVerify(
        fileUrl(base, layout, file),
        sha,
        pathOf(e.name),
        (received, total) => opts.onProgress?.(e.name, received, total)
      )
      // TOFU 指纹登记（仅 sidecar 受 TOFU 闸门管理；ffprobe 为可选工具）
      const digest = await checksumFile(pathOf(e.name))
      const sidecar = ENGINE_FILES.find((x) => x.name === e.name)?.sidecar
      if (sidecar) await recordFingerprint(sidecar, digest)
      result.installed.push(e.name)
      log.info(`engine installed: ${e.name} (${file})`)
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      result.failed.push({ name: e.name, error })
      log.warn(`engine fetch failed: ${e.name}`, err)
    }
  }
  return result
}

/** 首启自动补齐开关（download.autoFetchEngines，默认开） */
export function autoFetchEnabled(): boolean {
  return getSettingParsed<boolean>('engines.autoFetch') !== false
}

export function setAutoFetch(enabled: boolean): void {
  setSetting('engines.autoFetch', JSON.stringify(enabled))
}

export function setMirror(url: string): void {
  setSetting('engines.mirror', JSON.stringify(url.trim()))
}

export function getMirror(): string {
  return mirrorBase()
}
