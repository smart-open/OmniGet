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

// 第七轮：ffprobe 入 TOFU——它会被主进程真实执行（完整性探测/轨道提取/region-concat
// 探流），此前游离在指纹闸门外，替换 aria2c/yt-dlp/ffmpeg 被拦而替换 ffprobe 可静默
// 执行任意代码（TOFU 围栏的定期执行洞）。deno 仍不入（主进程从不执行它，由 yt-dlp
// 自行调用，无强制点——在 engine-fetch 注释中显式备案为接受项）
export type SidecarBinary =
  | 'aria2c'
  | 'ytdlp'
  | 'ffmpeg'
  | 'nm3u8re'
  | 'ffprobe'

interface FingerprintStore {
  [binaryName: string]: string // sha256
}

function binaryName(name: SidecarBinary): string {
  // 惯例：二进制文件名连字符（yt-dlp.exe），TOFU 指纹键用枚举名（ytdlp）
  const file =
    name === 'ytdlp' ? 'yt-dlp' : name === 'nm3u8re' ? 'N_m3u8DL-RE' : name
  return process.platform === 'win32' ? `${file}.exe` : file
}

function existsSyncSafe(p: string): boolean {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { existsSync } = require('fs') as typeof import('fs')
  return existsSync(p)
}

function writableDir(dir: string): boolean {
  // 写入探测（仿 env.ts 口径）：Windows 上 access(W_OK) 基本只查只读属性不看 ACL，
  // Program Files 等全机安装目录会被误判可写，mkdir/rename 阶段才 EPERM
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { existsSync, writeFileSync, rmSync } = require('fs') as typeof import('fs')
    if (!existsSync(dir)) return false
    const probe = join(dir, '.omniget-write-probe')
    writeFileSync(probe, '')
    try {
      rmSync(probe, { force: true })
    } catch {
      // 残留探测文件无害，忽略
    }
    return true
  } catch {
    return false
  }
}

let cachedEnginesDirs: string[] | null = null

/**
 * 引擎目录候选链（查找顺序 = 优先级）：
 * 1. OMNIGET_ENGINES_DIR 显式注入（测试/高级用户，不缓存——单测多用例各自注入）
 * 2. dev：appRoot/resources/engines/<platform>-<arch>
 * 3. 打包态且打包目录可写（Windows per-user NSIS 安装到 %LOCALAPPDATA%）：resourcesPath/engines
 * 4. 打包态但打包目录只读（macOS /Applications、Linux AppImage squashfs、deb /opt）：
 *    <userData>/engines 优先（引擎按需补齐/yt-dlp 热更的唯一可写落点），bundled 目录次之
 *    （预装引擎只读执行兜底）
 */
export function enginesDirs(): string[] {
  if (process.env.OMNIGET_ENGINES_DIR) return [process.env.OMNIGET_ENGINES_DIR]
  if (cachedEnginesDirs) return cachedEnginesDirs
  const platform = `${process.platform}-${process.arch}`
  // 1) dev/test：appRoot 下的目录存在则优先（Electron-as-Node 也有 resourcesPath，需排除）
  const devDir = join(appRoot(), 'resources', 'engines', platform)
  if (existsSyncSafe(devDir)) return (cachedEnginesDirs = [devDir])
  // 2) 打包态：process.resourcesPath 由 electron-builder 注入
  const resourcesPath = (process as unknown as { resourcesPath?: string }).resourcesPath
  if (resourcesPath) {
    const bundled = join(resourcesPath, 'engines')
    if (writableDir(bundled)) return (cachedEnginesDirs = [bundled])
    return (cachedEnginesDirs = [join(userDataDir(), 'engines'), bundled])
  }
  return (cachedEnginesDirs = [devDir])
}

/** 引擎写入目标目录（候选链首选 = 保证可写）：引擎按需下载 / 热更器的 mkdir+rename 落点 */
export function enginesDir(): string {
  return enginesDirs()[0] ?? ''
}

function resolveEngineFile(file: string): string {
  // 多目录解析：userData（热更/按需安装的新版本）优先于只读 bundled 目录；
  // 全部缺失时回退首选目录——缺失报错路径口径与旧行为一致
  const dirs = enginesDirs()
  const first = dirs[0] ?? ''
  for (const dir of dirs) {
    const p = join(dir, file)
    if (existsSyncSafe(p)) return p
  }
  return join(first, file)
}

export function binaryPath(name: SidecarBinary): string {
  return resolveEngineFile(binaryName(name))
}

/** 轻量在位检查（不走 TOFU/执行位校验）：引擎路由决策用（backlog #17） */
export function isBinaryPresent(name: SidecarBinary): boolean {
  return existsSyncSafe(binaryPath(name))
}

/** 引擎目录内工具二进制的跨平台路径（ffmpeg/ffprobe 等，复用 binaryName 平台逻辑，防止手写漂移） */
export function toolPath(name: string): string {
  return resolveEngineFile(process.platform === 'win32' ? `${name}.exe` : name)
}

/** 热更器写入目标：必须落在首选可写目录——resolved 路径可能位于只读打包目录，
 * 对其 unlink/rename 会 EROFS/EACCES（跨平台审查 P0-2） */
export function writableBinaryPath(name: SidecarBinary): string {
  return join(enginesDir(), binaryName(name))
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
    // 后者若当空库处理等于静默重置信任基线，篡改的二进制会被放行。
    // H7 修复：损坏/不可读时 fail-closed——拒绝启动所有 sidecar 引擎，
    // 由用户显式删除指纹库文件后重新登记（UI 告警文案给出恢复路径）
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      log.info('fingerprints.json 不存在（首次运行，TOFU 将登记初始指纹）')
      return {}
    }
    log.error('TOFU 指纹库损坏/不可读——fail-closed 拒绝启动引擎（删除该文件可重置 TOFU 基线）', {
      error: String(err)
    })
    throw makeError('ENGINE_FINGERPRINT_STORE_CORRUPT', {
      message:
        '引擎指纹库损坏，为防止被篡改的引擎被执行已拒绝启动。如确认本机安全，可删除 userData 下的 fingerprints.json 后重启应用重新登记。'
    })
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
    // TOFU：首次运行，记录指纹（走 H2 互斥：并发登记不互相覆写丢条目）
    await recordFingerprint(name, digest)
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

// H2 修复：指纹文件读-改-写互斥（promise 链串行化）——启动期引擎自动补齐、
// aria2/ytdlp 的 checkBinary 与两条热更链并发登记时，整体覆写会丢掉对方刚写入
// 的条目 → 下次启动走 TOFU 首次登记分支，当前二进制被静默重新登记放行
let fingerprintChain: Promise<void> = Promise.resolve()

function enqueueFingerprintWrite(fn: () => Promise<void>): Promise<void> {
  const next = fingerprintChain.then(fn, fn)
  // 链尾吞错：单次写失败不阻断后续登记（调用方各自处理自身异常）
  fingerprintChain = next.catch(() => {})
  return next
}

async function writeFingerprintEntry(name: SidecarBinary, digest: string): Promise<void> {
  // 临界区内重读（而非沿用调用方快照）+ 按 key 合并，最大化保留并发写入方
  const store = await loadFingerprints()
  store[name] = digest
  await mkdir(userDataDir(), { recursive: true })
  await writeFile(fingerprintsFile(), JSON.stringify(store, null, 2), 'utf8')
  verifiedCache.delete(name) // 热更换了新指纹，进程内缓存失效
}

export function recordFingerprint(name: SidecarBinary, digest: string): Promise<void> {
  return enqueueFingerprintWrite(() => writeFingerprintEntry(name, digest))
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
  // 第九轮审查：快速指纹失败（文件被占用/IO 异常，Windows 杀软扫描期常见）时
  // 不得命中缓存——「本次与上次都读不到内容」不等于「内容未变」，恰好这类异常
  // 窗口也是替换二进制的窗口，必须走 checkBinary 全量 SHA256
  const cached = verifiedCache.get(name)
  if (fp !== 'unavailable' && cached && cached.m === st.mtimeMs && cached.size === st.size && cached.fp === fp) return
  await checkBinary(name) // 指纹不符时内部抛 ENGINE_BINARY_TAMPERED
  if (fp !== 'unavailable') verifiedCache.set(name, { m: st.mtimeMs, size: st.size, fp })
}

/** M3-9：热更器复用的单文件 SHA256 */
export function checksumFile(file: string): Promise<string> {
  return sha256(file)
}
