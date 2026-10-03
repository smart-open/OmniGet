// yt-dlp 热更器（M3-9，§8/§11 风险 #1）
// GitHub Releases 拉取最新 yt-dlp.exe + SHA2-256SUMS 校验 → TOFU 指纹登记 → 原子替换
// 失败回滚：替换前备份旧文件，校验失败自动还原。

import { createWriteStream, existsSync } from 'fs'
import { checksumFile, recordFingerprint, writableBinaryPath, enginesDir } from '../orchestrator/binaries'
import { rename, unlink, copyFile, mkdir, chmod } from 'fs/promises'
import { createHash } from 'crypto'
import { getSettingParsed, setSetting } from '../db'
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
  // P2 加固：网络停滞时永久挂起会让"更新中"卡死——下载整体限时（引擎包 ~15MB 量级，5min 足够慢速网络）
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(300_000) })
  if (!res.ok || !res.body) throw new Error(`下载失败（HTTP ${res.status}），请稍后重试更新`)
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
  await rename(tmp, dest)
}

export async function updateYtDlp(): Promise<UpdateResult> {
  // H5 修复 + R4-P1 修正：串行链必须回写链尾——此前 `chain.then(run)` 的结果
  // 从未赋回 chain，并发调用 await 的都是同一个已 resolve 的初始 promise，
  // 实际并行执行（互踩 unlink/rename/指纹登记）。r4 审查证实为空操作。
  const p = ytdlpUpdateChain.then(() => runUpdateYtDlp())
  ytdlpUpdateChain = p.then(
    () => undefined,
    () => undefined
  )
  return p
}

let ytdlpUpdateChain: Promise<unknown> = Promise.resolve()

async function runUpdateYtDlp(): Promise<UpdateResult> {
  // 跨平台审查 P0-2：写入目标必须是首选可写目录——mac/Linux 打包态 binaryPath 解析
  // 到只读 bundle 内的旧版本时，对其 unlink/rename 会 EROFS/EACCES，热更永远失败
  const target = writableBinaryPath('ytdlp')
  const backup = `${target}.bak`
  const tmpExe = `${target}.new`
  const tmpSums = `${target}.sums`
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

    // R4-P3：同版本跳过——此前同一版本也全量替换（无谓流量 + 替换风险）。
    // 回归审查 #6：tag 相同但写入目标二进制缺失时不得跳过（userData/engines 被清理
    // 而 bundled 是旧版 → 会误报「已是最新」但实际运行旧二进制；换架构安装同理）
    const appliedTag = getSettingParsed<string>('engines.ytdlpTag')
    if (appliedTag && appliedTag === release.tag_name && existsSync(target)) {
      log.info(`yt-dlp already at ${release.tag_name}, skip`)
      return { ok: true, version: release.tag_name }
    }
    if (appliedTag === release.tag_name && !existsSync(target)) {
      log.warn(`yt-dlp tag ${release.tag_name} 已登记但二进制缺失，重新下载补齐`)
    }

    // 2. 下载新二进制与校验和
    await downloadTo(exe.browser_download_url, tmpExe)
    await downloadTo(sums.browser_download_url, tmpSums)

    // 3. SHA256 校验（官方 SUMS 清单，TOFU 供应链口径 §9）
    const sumsBody = await import('fs/promises').then((m) => m.readFile(tmpSums, 'utf8'))
    // assetName 含 '.'（yt-dlp.exe），需转义防正则误匹配
    const expected = new RegExp(`^([a-f0-9]{64})\\s+\\*?${assetName.replace(/\./g, '\\.')}$`, 'mi').exec(sumsBody)?.[1]
    if (!expected) throw new Error('校验清单中缺少对应条目')
    const actual = await import('fs/promises').then((m) =>
      m.readFile(tmpExe).then((buf) => createHash('sha256').update(buf).digest('hex'))
    )
    if (actual !== expected.toLowerCase()) {
      throw new Error('SHA256 校验不一致——下载已损坏，请重试更新')
    }
    await unlink(tmpSums).catch(() => {})

    // 4. 原子替换（备份旧文件以便回滚）；Unix 需补回可执行位
    await copyFile(target, backup).catch((err) =>
      log.warn('备份旧 yt-dlp 失败——本次更新将无法回滚', { error: String(err) })
    )
    await unlink(target).catch(() => {})
    await rename(tmpExe, target)
    if (process.platform !== 'win32') await chmod(target, 0o755).catch(() => {})

    // 5. TOFU 指纹登记（后续启动逐次比对）
    const digest = await checksumFile(target)
    await recordFingerprint('ytdlp', digest)
    await setSetting('engines.ytdlpTag', JSON.stringify(release.tag_name))
    log.info(`yt-dlp updated to ${release.tag_name}`)
    return { ok: true, version: release.tag_name }
  } catch (err) {
    // R4-P3：失败路径清理临时文件（.new/.sums 残留此前无人清）
    const { rm } = await import('fs/promises')
    await rm(tmpExe, { force: true }).catch(() => {})
    await rm(tmpSums, { force: true }).catch(() => {})
    // 回滚：还原备份（回滚本身失败必须留痕——target 可能处于缺失/损坏状态）
    const rollbackOk = await copyFile(backup, target)
      .then(() => true)
      .catch((rollbackErr) => {
        log.error('yt-dlp 更新回滚失败，当前二进制可能损坏，建议重新更新或重装', {
          error: String(rollbackErr)
        })
        return false
      })
    if (!rollbackOk) {
      // R4-P3：target 缺失/损坏时排队自愈——走按需补齐通道重装（SHA256+TOFU 全程校验）
      void import('./engine-fetch')
        .then((m) => m.fetchMissingEngines({ names: ['yt-dlp'] }))
        .catch(() => {})
    }
    const message = err instanceof Error ? err.message : String(err)
    log.error('yt-dlp update failed', message)
    return { ok: false, error: message }
  } finally {
    // 清理备份（成功/失败后都由指纹机制保障，保留会造成混乱）
    await unlink(`${target}.bak`).catch(() => {})
  }
}
