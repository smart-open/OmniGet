// R6：引擎按需下载（首启免 262MB 全量捆绑）
// 分发约定（默认 GitHub Releases，可用设置 engines.mirror 指向自建镜像）：
//   <mirror>/<platform>-<arch>/manifest.json   → { files: { <二进制名>: sha256 } }
//   <mirror>/<platform>-<arch>/<二进制名>      → 引擎文件本体
// 流程：仅补缺失（已存在且指纹通过的引擎不覆盖）→ 流式下载 .part（边下边算 SHA256）
// → 与 manifest 比对（不符即丢弃，杜绝投毒）→ 原子改名安装 → TOFU 指纹登记。
import { createHash } from 'crypto'
import { createWriteStream } from 'fs'
import { mkdir, rename, rm, stat } from 'fs/promises'
import { pipeline } from 'stream/promises'
import { fetch as undiciFetch } from 'undici'
import type { SidecarBinary } from '../orchestrator/binaries'
import { binaryPath, checksumFile, enginesDir, recordFingerprint, toolPath } from '../orchestrator/binaries'
import { getSettingParsed, setSetting } from '../db'
import { createLogger } from '../logger'

const log = createLogger('engine-fetch')

export const DEFAULT_MIRROR = 'https://github.com/smart-open/OmniGet/releases/latest/download'

/** 参与按需下载的引擎（ffprobe 为可选工具，同样支持补齐） */
const ENGINE_FILES: Array<{ name: string; kind: 'sidecar' | 'tool'; sidecar?: SidecarBinary }> = [
  { name: 'aria2c', kind: 'sidecar', sidecar: 'aria2c' },
  { name: 'ffmpeg', kind: 'sidecar', sidecar: 'ffmpeg' },
  { name: 'ffprobe', kind: 'tool' },
  { name: 'yt-dlp', kind: 'sidecar', sidecar: 'ytdlp' }
]

const fileOf = (name: string): string =>
  process.platform === 'win32' ? `${name}.exe` : name

function mirrorBase(): string {
  const v = getSettingParsed<string>('engines.mirror')
  return typeof v === 'string' && /^https?:\/\//i.test(v.trim()) ? v.trim().replace(/\/+$/, '') : DEFAULT_MIRROR
}

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
  const digest = hash.digest('hex')
  if (digest !== sha256.toLowerCase()) {
    await rm(part, { force: true })
    throw new Error(`SHA256 校验不符（期望 ${sha256.slice(0, 12)}…，实际 ${digest.slice(0, 12)}…），已丢弃`)
  }
  await mkdir(enginesDir(), { recursive: true })
  await rename(part, dest)
}

export interface FetchOptions {
  onProgress?: (name: string, received: number, total: number) => void
  /** 仅补这些引擎（缺省 = 全部缺失项） */
  names?: string[]
}

/** 补齐缺失引擎；全部就绪/无分发源时快速返回。安装成功即登记 TOFU 指纹。 */
export async function fetchMissingEngines(opts: FetchOptions = {}): Promise<FetchResult> {
  const result: FetchResult = { installed: [], skipped: [], failed: [] }
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
