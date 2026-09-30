// yt-dlp 热更器（M3-9，§8/§11 风险 #1）
// GitHub Releases 拉取最新 yt-dlp.exe + SHA2-256SUMS 校验 → TOFU 指纹登记 → 原子替换
// 失败回滚：替换前备份旧文件，校验失败自动还原。

import { app } from 'electron'
import { createWriteStream } from 'fs'
import { checksumFile, recordFingerprint, binaryPath, enginesDir } from '../orchestrator/binaries'
import { rename, unlink, copyFile, mkdir, chmod } from 'fs/promises'
import { createHash } from 'crypto'
import { createLogger } from '../logger'

const log = createLogger('ytdlp-updater')

const API_LATEST = 'https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest'
const SUMS_ASSET = 'SHA2-256SUMS'

/** 按平台/架构选择官方 release 资产（此前硬编码 yt-dlp.exe 会在 mac/linux 上用 Windows PE 覆盖引擎） */
function platformAsset(): string {
  if (process.platform === 'win32') return 'yt-dlp.exe'
  if (process.platform === 'darwin') return 'yt-dlp_macos' // 官方 macOS 通用二进制（x64/arm64 经 Rosetta 兼容）
  if (process.arch === 'arm64') return 'yt-dlp_linux_arm64'
  if (process.arch === 'arm') return 'yt-dlp_linux_armv7l'
  if (process.arch === 'ia32') return 'yt-dlp_linux32'
  return 'yt-dlp_linux'
}

export interface UpdateResult {
  ok: boolean
  version?: string
  error?: string
}

async function downloadTo(url: string, dest: string): Promise<void> {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok || !res.body) throw new Error(`下载失败（HTTP ${res.status}），请稍后重试更新`)
  const fs = await import('fs')
  // 引擎目录可能尚未创建（首次热更/全新安装），否则 createWriteStream 异步 open 失败会被吞掉
  await mkdir(enginesDir(), { recursive: true })
  const tmp = `${dest}.tmp`
  const reader = res.body.getReader()
  const file = createWriteStream(tmp)
  await new Promise<void>((resolve, reject) => {
    // 立即挂监听：open/写入错误（如目录缺失、磁盘满）必须中断流程，不能静默
    file.on('error', reject)
    void (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          if (!file.write(Buffer.from(value))) {
            await new Promise<void>((r) => file.once('drain', r))
          }
        }
        file.end()
        resolve()
      } catch (err) {
        file.destroy(err as Error)
        reject(err)
      }
    })()
  })
  await new Promise<void>((resolve, reject) => {
    file.close(() => resolve())
    file.on('error', reject)
  })
  void fs
  await rename(tmp, dest)
}

export async function updateYtDlp(): Promise<UpdateResult> {
  const target = binaryPath('ytdlp')
  const backup = `${target}.bak`
  try {
    // 1. 查询最新版本资产
    const res = await fetch(API_LATEST, {
      headers: { 'User-Agent': 'OmniGet-Updater' },
      signal: AbortSignal.timeout(20_000)
    })
    if (!res.ok) throw new Error(`发布查询失败（HTTP ${res.status}），请稍后重试更新`)
    const release = (await res.json()) as {
      tag_name: string
      assets: { name: string; browser_download_url: string }[]
    }
    const assetName = platformAsset()
    const exe = release.assets.find((a) => a.name === assetName)
    const sums = release.assets.find((a) => a.name === SUMS_ASSET)
    if (!exe || !sums) throw new Error('最新发布中缺少 yt-dlp 资产，请稍后重试')

    // 2. 下载新二进制与校验和
    const tmpExe = `${target}.new`
    const tmpSums = `${target}.sums`
    await downloadTo(exe.browser_download_url, tmpExe)
    await downloadTo(sums.browser_download_url, tmpSums)

    // 3. SHA256 校验（官方 SUMS 清单，TOFU 供应链口径 §9）
    const sumsBody = await import('fs/promises').then((m) => m.readFile(tmpSums, 'utf8'))
    const expected = new RegExp(`^([a-f0-9]{64})\\s+\\*?${assetName}$`, 'mi').exec(sumsBody)?.[1]
    if (!expected) throw new Error('校验清单中缺少对应条目')
    const actual = await import('fs/promises').then((m) =>
      m.readFile(tmpExe).then((buf) => createHash('sha256').update(buf).digest('hex'))
    )
    if (actual !== expected.toLowerCase()) {
      throw new Error('SHA256 校验不一致——下载已损坏，请重试更新')
    }
    await unlink(tmpSums).catch(() => {})

    // 4. 原子替换（备份旧文件以便回滚）；Unix 需补回可执行位
    await copyFile(target, backup).catch(() => {})
    await unlink(target).catch(() => {})
    await rename(tmpExe, target)
    if (process.platform !== 'win32') await chmod(target, 0o755).catch(() => {})

    // 5. TOFU 指纹登记（后续启动逐次比对）
    const digest = await checksumFile(target)
    await recordFingerprint('ytdlp', digest)
    log.info(`yt-dlp updated to ${release.tag_name}`)
    return { ok: true, version: release.tag_name }
  } catch (err) {
    // 回滚：还原备份
    await copyFile(backup, target).catch(() => {})
    const message = err instanceof Error ? err.message : String(err)
    log.error('yt-dlp update failed', message)
    return { ok: false, error: message }
  } finally {
    // 清理备份（成功/失败后都由指纹机制保障，保留会造成混乱）
    await unlink(`${target}.bak`).catch(() => {})
    void app
  }
}
