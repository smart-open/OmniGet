// sidecar 二进制接入与 SHA256 启动校验（T0-6，§8/§9）
// 信任模型：TOFU —— 首次运行记录指纹到 userData/fingerprints.json，
// 后续启动逐次比对；指纹不符 → 报警并拒绝启动引擎。

import { createHash } from 'crypto'
import { createReadStream } from 'fs'
import { access, constants, mkdir, readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { makeError } from '@shared/errors'
import { createLogger } from '../logger'
import { appRoot, userDataDir } from '../env'

const log = createLogger('binaries')

export type SidecarBinary = 'aria2c' | 'ytdlp' | 'ffmpeg'

interface FingerprintStore {
  [binaryName: string]: string // sha256
}

function binaryName(name: SidecarBinary): string {
  // 惯例：二进制文件名连字符（yt-dlp.exe），TOFU 指纹键用枚举名（ytdlp）
  const file = name === 'ytdlp' ? 'yt-dlp' : name
  return process.platform === 'win32' ? `${file}.exe` : file
}

export function enginesDir(): string {
  // dev: resources/engines/<platform>；prod: extraResources 解包后的 engines/
  const platform = `${process.platform}-${process.arch}`
  if (process.env.OMNIGET_ENGINES_DIR) return process.env.OMNIGET_ENGINES_DIR
  // 1) dev/test：appRoot 下的目录存在则优先（Electron-as-Node 也有 resourcesPath，需排除）
  const devDir = join(appRoot(), 'resources', 'engines', platform)
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { existsSync } = require('fs') as typeof import('fs')
    if (existsSync(devDir)) return devDir
  } catch {
    // ignore
  }
  // 2) 打包态：process.resourcesPath 由 electron-builder 注入
  const resourcesPath = (process as unknown as { resourcesPath?: string }).resourcesPath
  if (resourcesPath) return join(resourcesPath, 'engines')
  return devDir
}

export function binaryPath(name: SidecarBinary): string {
  return join(enginesDir(), binaryName(name))
}

/** 引擎目录内工具二进制的跨平台路径（ffmpeg/ffprobe 等，复用 binaryName 平台逻辑，防止手写漂移） */
export function toolPath(name: string): string {
  return join(enginesDir(), process.platform === 'win32' ? `${name}.exe` : name)
}

function fingerprintsFile(): string {
  return join(userDataDir(), 'fingerprints.json')
}

async function sha256(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(file)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

async function loadFingerprints(): Promise<FingerprintStore> {
  try {
    return JSON.parse(await readFile(fingerprintsFile(), 'utf8')) as FingerprintStore
  } catch (err) {
    // ⚠ 区分「首启无指纹库」（正常 TOFU 登记）与「指纹库损坏/不可读」——
    // 后者若当空库处理等于静默重置信任基线，篡改的二进制会被放行
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      log.info('fingerprints.json 不存在（首次运行，TOFU 将登记初始指纹）')
    } else {
      log.error('TOFU 指纹库读取失败——按空库处理会重置信任基线，请检查文件权限/完整性', {
        error: String(err)
      })
    }
    return {}
  }
}

export interface BinaryCheckResult {
  ok: boolean
  path: string
  sha256?: string
  error?: string
}

/**
 * 校验单个二进制：存在 → 可执行 → TOFU 指纹比对。
 * M3-9 的热更器复用 recordFingerprint 完成新指纹登记。
 */
export async function checkBinary(name: SidecarBinary): Promise<BinaryCheckResult> {
  const path = binaryPath(name)
  try {
    await access(path, constants.X_OK)
  } catch {
    // 引擎二进制尚未放入（T0 阶段允许缺席，仅告警；M1 起改为硬失败）
    log.warn(`binary missing: ${name} at ${path}`)
    return { ok: false, path, error: 'missing' }
  }

  const digest = await sha256(path)
  const store = await loadFingerprints()
  const known = store[name]
  if (known === undefined) {
    // TOFU：首次运行，记录指纹
    store[name] = digest
    await mkdir(userDataDir(), { recursive: true })
    await writeFile(fingerprintsFile(), JSON.stringify(store, null, 2), 'utf8')
    log.info(`TOFU fingerprint recorded for ${name}`, { sha256: digest })
    return { ok: true, path, sha256: digest }
  }
  if (known !== digest) {
    // 篡改：报警拒绝（验收口径）
    log.error(`binary fingerprint mismatch: ${name}`, { expected: known, actual: digest })
    throw makeError('ENGINE_BINARY_TAMPERED', {
      message: `引擎 ${name} 文件校验失败，已拒绝启动以保护系统安全。请重新安装 OmniGet。`
    })
  }
  return { ok: true, path, sha256: digest }
}

export async function recordFingerprint(name: SidecarBinary, digest: string): Promise<void> {
  const store = await loadFingerprints()
  store[name] = digest
  await writeFile(fingerprintsFile(), JSON.stringify(store, null, 2), 'utf8')
  verifiedCache.delete(name) // 热更换了新指纹，进程内缓存失效
}

// 进程内已校验缓存（mtime+size+内容短指纹命中即视为已过 TOFU，避免每次 spawn 全量重哈希）。
// P2 加固：原 (mtime,size) 判据可被「改完二进制再把 mtime/size 改回去」伪造绕过——
// 追加首尾 64KB 的快速内容指纹（全量 SHA256 仍由 checkBinary 负责）。
const verifiedCache = new Map<SidecarBinary, { m: number; size: number; fp: string }>()

async function quickFingerprint(path: string, size: number): Promise<string> {
  const { open } = await import('fs/promises')
  const { createHash } = await import('crypto')
  const WINDOW = 64 * 1024
  const handle = await open(path, 'r')
  try {
    const head = Buffer.alloc(Math.min(WINDOW, size))
    await handle.read(head, 0, head.length, 0)
    const hash = createHash('sha256').update(head)
    if (size > WINDOW) {
      const tail = Buffer.alloc(WINDOW)
      await handle.read(tail, 0, WINDOW, Math.max(0, size - WINDOW))
      hash.update(tail)
    }
    hash.update(String(size))
    return hash.digest('hex')
  } finally {
    await handle.close()
  }
}

/**
 * 强制 TOFU 校验（spawn 前必调）：缺失或指纹不符均抛错。
 * 此前只有 aria2 真正执行了"指纹不符拒绝启动"，yt-dlp/ffmpeg 缺此闸门。
 */
export async function ensureVerified(name: SidecarBinary): Promise<void> {
  const path = binaryPath(name)
  const { stat } = await import('fs/promises')
  const st = await stat(path).catch(() => null)
  if (!st) {
    throw makeError('ENGINE_BINARY_TAMPERED', {
      message: `引擎 ${binaryName(name)} 缺失（${path}）。请在设置中更新或重新安装引擎。`
    })
  }
  const fp = await quickFingerprint(path, st.size).catch(() => 'unavailable')
  const cached = verifiedCache.get(name)
  if (cached && cached.m === st.mtimeMs && cached.size === st.size && cached.fp === fp) return
  await checkBinary(name) // 指纹不符时内部抛 ENGINE_BINARY_TAMPERED
  verifiedCache.set(name, { m: st.mtimeMs, size: st.size, fp })
}

/** M3-9：热更器复用的单文件 SHA256 */
export function checksumFile(file: string): Promise<string> {
  return sha256(file)
}
