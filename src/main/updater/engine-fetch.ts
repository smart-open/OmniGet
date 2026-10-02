// R6：引擎按需下载（首启免 262MB 全量捆绑）
// 分发约定（默认 GitHub Releases，可用设置 engines.mirror 指向自建镜像）：
//   <mirror>/<platform>-<arch>/manifest.json   → { files: { <二进制名>: sha256 } }
//   <mirror>/<platform>-<arch>/<二进制名>      → 引擎文件本体
// 流程：仅补缺失（已存在且指纹通过的引擎不覆盖）→ 流式下载 .part（边下边算 SHA256）
// → 与 manifest 比对（不符即丢弃，杜绝投毒）→ 原子改名安装 → TOFU 指纹登记。
import { createHash } from 'crypto'
import { createWriteStream } from 'fs'
import { chmod, mkdir, rename, rm, stat } from 'fs/promises'
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
 * 同目录放置即被识别（jsruntime.ts 另做 PATH 注入双保险）；kind=tool 不入 TOFU */
const ENGINE_FILES: Array<{ name: string; kind: 'sidecar' | 'tool'; sidecar?: SidecarBinary }> = [
  { name: 'aria2c', kind: 'sidecar', sidecar: 'aria2c' },
  { name: 'ffmpeg', kind: 'sidecar', sidecar: 'ffmpeg' },
  { name: 'ffprobe', kind: 'tool' },
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

function manifestUrl(): string {
  return `${mirrorBase()}/${dirKey()}/manifest.json`
}

async function fetchManifest(): Promise<Record<string, string>> {
  const res = await undiciFetch(manifestUrl(), { signal: AbortSignal.timeout(15_000) })
  if (!res.ok) throw new Error(`manifest 获取失败（HTTP ${res.status}）`)
  const raw = (await res.json()) as { files?: Record<string, string> }
  if (!raw?.files || typeof raw.files !== 'object') throw new Error('manifest 格式不合法')
  return raw.files
}

async function downloadAndVerify(url: string, sha256: string, dest: string, onProgress?: (received: number, total: number) => void): Promise<void> {
  const part = `${dest}.part`
  await rm(part, { force: true })
  const res = await undiciFetch(url, { signal: AbortSignal.timeout(600_000) })
  if (!res.ok || !res.body) throw new Error(`下载失败（HTTP ${res.status}）`)
  const body = res.body
  const total = Number(res.headers.get('content-length') ?? 0)
  const hash = createHash('sha256')
  const ws = createWriteStream(part)
  let received = 0
  try {
    await pipeline(
      (async function* () {
        for await (const chunk of body) {
          const buf = chunk as Buffer
          hash.update(buf)
          received += buf.length
          onProgress?.(received, total)
          yield buf
        }
      })(),
      ws
    )
  } catch (err) {
    // R4-P3：网络异常/超时等失败路径必须清理 .part（此前仅 SHA 不符分支清理，
    // 引擎目录会累积残缺的 *.part）
    await rm(part, { force: true }).catch(() => {})
    throw err
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
  // C2 修复：分发源必须可信（https + 白名单域 + 公网地址），否则拒绝安装
  try {
    await assertTrustedMirror(mirrorBase())
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
  try {
    manifest = await fetchManifest()
  } catch (err) {
    const error = `${err instanceof Error ? err.message : String(err)}（分发源：${manifestUrl()}）`
    for (const e of wanted) result.failed.push({ name: e.name, error })
    log.warn(`engine manifest unavailable: ${error}`)
    return result
  }

  for (const e of wanted) {
    const file = fileOf(e.name)
    const sha = manifest[file]
    if (!sha || !/^[0-9a-f]{64}$/i.test(sha)) {
      result.failed.push({ name: e.name, error: '分发源清单中缺少该引擎的 SHA256（不可信来源，拒绝安装）' })
      continue
    }
    try {
      await downloadAndVerify(
        `${mirrorBase()}/${dirKey()}/${encodeURIComponent(file)}`,
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
