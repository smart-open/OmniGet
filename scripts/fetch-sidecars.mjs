// sidecar 收集脚本（遗留问题清单 #1）：下载官方预编译 aria2c / yt-dlp / ffmpeg
// 到 resources/engines/<platform>-<arch>/，供本地打包或 CI 三平台 runner 调用。
//
// 用法：node scripts/fetch-sidecars.mjs [--force] [--target <platform-arch>]
//   --target：交叉收集（CI mac job 需为 x64 dmg 单独出包 darwin-x64 sidecar）
//   落盘文件名与运行时 binaryName() 口径一致：win32 → *.exe，其余平台裸名
//   （yt-dlp 一律落为 yt-dlp / yt-dlp.exe，发布资产名仅用于下载定位）
//   win:    yt-dlp.exe（yt-dlp 官方）+ aria2c（q3aql/aria2-static-build）+ ffmpeg（BtbN/FFmpeg-Builds）
//   linux:  同源静态构建
//   darwin-arm64: yt-dlp_macos + aria2（q3aql）+ ffmpeg（BtbN macos-arm64 构建）
//   darwin-x64:   ffmpeg/ffprobe 改用 ffbinaries——BtbN 不发布 macOS x64 构建，
//                 此前该平台 fetch 必失败（mac x64 dmg 出包链路走不通，P2 修复）
// 全部经官方/高星发布源；aria2/ffmpeg 的镜像源失效时会明确报错而非静默出空包。

import { mkdir, chmod, copyFile, rename, unlink } from 'node:fs/promises'
import { existsSync, readdirSync, readFileSync, unlinkSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'

const FORCE = process.argv.includes('--force')
// --target <platform-arch>：交叉收集（覆盖 host 平台判断；平台串按首段拆分，如 darwin-x64）
const TARGET_ARG = (() => {
  const i = process.argv.indexOf('--target')
  const v = i >= 0 ? process.argv[i + 1] : null
  return v && /^[a-z0-9]+-[a-z0-9_]+$/.test(v) ? v : null
})()
const plat = TARGET_ARG ? TARGET_ARG.split('-')[0] : process.platform
const arch = TARGET_ARG ? TARGET_ARG.split('-').slice(1).join('-') : process.arch
const ROOT = join(import.meta.dirname, '..')
const platform = TARGET_ARG ?? `${process.platform}-${process.arch}`
// OUT 口径：env 单独使用 = 精确目录（运行时注入语义不变）；--target 与 env 同时给定时
// 追加平台子目录——否则交叉收集产物会静默落错目录，need() 还会因已有产物跳过下载，
// 留下「架构错但门禁绿灯」的脚部枪
const OUT =
  process.env.OMNIGET_ENGINES_DIR
    ? TARGET_ARG
      ? join(process.env.OMNIGET_ENGINES_DIR, platform)
      : process.env.OMNIGET_ENGINES_DIR
    : join(ROOT, 'resources', 'engines', platform)

const GH = 'https://api.github.com'

function ghLatest(repo) {
  // 第六轮审查：加 --fail——403 限流时 curl 此前退出码为 0，JSON.parse 解析错误体
  // 成功、rel.assets undefined → 报「缺少资产」而非「API 限流」，排障误导
  const r = spawnSync('curl', ['-sSL', '--fail', '-H', 'Accept: application/vnd.github+json', `${GH}/repos/${repo}/releases/latest`], {
    encoding: 'utf8',
    timeout: 60_000
  })
  if (r.status !== 0) throw new Error(`GitHub API unreachable or rate-limited: ${repo}`)
  return JSON.parse(r.stdout)
}

/** 下载到文件（跟随重定向）；shell 路由到 curl 保证 CI/本地一致 */
function download(url, dest) {
  const r = spawnSync('curl', ['-sSL', '--fail', '--retry', '3', '-o', dest, url], { timeout: 600_000 })
  if (r.status !== 0) throw new Error(`download failed: ${url}`)
}

/** 下载侧 SHA256 预校验（第七轮）：官方发布源提供校验和资产（如 yt-dlp 的
 * SHA2-256SUMS）时强制比对，不符即失败拒绝安装——堵「发布源资产被投毒/下载
 * 中途损坏直接进包」的缺口（此前下载侧零校验，仅运行时 TOFU 兜底） */
function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function verifyChecksum(file, sumsUrl, entryName) {
  const tmp = join(tmpdir(), `omniget-sums-${Date.now()}`)
  try {
    download(sumsUrl, tmp)
    const text = readFileSync(tmp, 'utf8')
    const line = text
      .split(/\r?\n/)
      .find((l) => l.trimEnd().endsWith(entryName))
    if (!line) throw new Error(`校验和清单中无 ${entryName} 条目`)
    const expected = line.trim().split(/\s+/)[0]?.toLowerCase()
    const actual = sha256File(file)
    if (!expected || expected !== actual) {
      throw new Error(
        `SHA256 预校验不符：${entryName}（期望 ${expected ?? '无'}，实际 ${actual}）——拒绝安装`
      )
    }
    console.log('  ✓ SHA256 预校验通过')
  } finally {
    // 回归审查 P3：清理失败不得掩盖真实根因（download 失败时文件不存在 →
    // unlinkSync ENOENT 会替换掉「download failed: url」原始错误）
    try {
      unlinkSync(tmp)
    } catch {
      // 残留临时文件无害
    }
  }
}

function unzip(zip, toDir) {
  // P3 修复：Windows 10+ 自带 bsdtar（可解 zip），避免 PowerShell Expand-Archive
  // 单引号插值在路径含引号字符时炸掉的问题；类 Unix 用 unzip -o
  if (plat === 'win32') {
    const r = spawnSync('tar', ['-xf', zip, '-C', toDir], { timeout: 300_000 })
    if (r.status !== 0) throw new Error(`unzip failed: ${zip}`)
  } else {
    const r = spawnSync('unzip', ['-o', zip, '-d', toDir], { timeout: 300_000 })
    if (r.status !== 0) throw new Error(`unzip failed: ${zip}`)
  }
}

function untar(tgz, toDir) {
  // 第六轮审查（P1）：原硬编码 -xzf（gzip 滤镜）——aria2 的 darwin/linux 资产是
  // .tar.bz2，GNU tar 必报 not in gzip format（Linux CI 出包链路断）；macOS bsdtar
  // 读取时自动探测压缩格式故侥幸存活。改无压缩标志 -xf（GNU tar/bsdtar 均按
  // 魔数自动探测，与下方 ffmpeg .tar.xz 的 -xf 口径一致）
  const r = spawnSync('tar', ['-xf', tgz, '-C', toDir], { timeout: 300_000 })
  if (r.status !== 0) throw new Error(`untar failed: ${tgz}`)
}

function findFile(dir, re) {
  const stack = [dir]
  while (stack.length) {
    const d = stack.pop()
    for (const e of existsSync(d) ? readdirSync(d, { withFileTypes: true }) : []) {
      const p = join(d, e.name)
      if (e.isDirectory()) stack.push(p)
      else if (re.test(e.name)) return p
    }
  }
  return null
}

async function place(src, name) {
  const dest = join(OUT, name)
  try {
    await rename(src, dest)
  } catch (err) {
    // 第六轮审查（P1）：tmpdir()（通常 C:）与仓库（如 D:）跨文件系统时 rename 抛
    // EXDEV——本机直接跑脚本三项全挂（CI 同盘不暴露）。跨卷回退 copy+unlink
    if (err && typeof err === 'object' && 'code' in err && err.code === 'EXDEV') {
      await copyFile(src, dest)
      await unlink(src).catch(() => {})
    } else {
      throw err
    }
  }
  if (plat !== 'win32') await chmod(dest, 0o755).catch(() => {})
  console.log(`  ✓ ${name}`)
}

async function need(name) {
  if (!FORCE && existsSync(join(OUT, name))) {
    console.log(`  · ${name} 已存在，跳过（--force 覆盖）`)
    return false
  }
  return true
}

async function fetchYtDlp() {
  // 发布资产名（下载定位）与落盘名（运行时 binaryName 口径）分离——
  // 此前按资产名落盘（yt-dlp_macos/yt-dlp_linux），运行时按 yt-dlp 查找必然缺失（跨平台审查 P0-1）
  const assetName =
    plat === 'win32'
      ? 'yt-dlp.exe'
      : plat === 'darwin'
        ? 'yt-dlp_macos'
        : arch === 'arm64'
          ? 'yt-dlp_linux_aarch64'
          : arch === 'arm'
            ? 'yt-dlp_linux_armv7l'
            : arch === 'ia32'
              ? 'yt-dlp_linux32'
              : 'yt-dlp_linux'
  const exe = plat === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'
  if (!(await need(exe))) return
  const rel = ghLatest('yt-dlp/yt-dlp')
  const asset = rel.assets?.find((a) => a.name === assetName)
  if (!asset) throw new Error(`yt-dlp release ${rel.tag_name} 缺少资产 ${assetName}`)
  console.log(`yt-dlp ${rel.tag_name} …`)
  const tmp = join(tmpdir(), assetName)
  await unlink(tmp).catch(() => {})
  download(asset.browser_download_url, tmp)
  // 第七轮：下载侧 SHA256 预校验（yt-dlp 官方随 release 提供 SHA2-256SUMS）
  const sums = rel.assets?.find((a) => a.name === 'SHA2-256SUMS')
  if (sums) verifyChecksum(tmp, sums.browser_download_url, assetName)
  else console.log('  ! 该 release 未提供校验和资产，跳过预校验')
  await place(tmp, exe)
}

async function fetchAria2() {
  const bin = plat === 'win32' ? 'aria2c.exe' : 'aria2c'
  if (!(await need(bin))) return
  console.log('aria2 (q3aql/aria2-static-build) …')
  const rel = ghLatest('q3aql/aria2-static-build')
  const pat =
    plat === 'win32'
      ? /win.*64bit.*\.zip$/i
      : plat === 'darwin'
        ? /macos-darwin.*\.tar\.bz2$/i
        : arch === 'arm64'
          ? /linux-glibc.*arm64.*\.tar\.bz2$/i
          : /linux-glibc.*x86_64.*\.tar\.bz2$/i
  const asset = rel.assets?.find((a) => pat.test(a.name))
  if (!asset) throw new Error(`aria2-static-build ${rel.tag_name} 无匹配平台资产`)
  const tmp = join(tmpdir(), asset.name)
  await unlink(tmp).catch(() => {})
  download(asset.browser_download_url, tmp)
  const ex = join(tmpdir(), `aria2-x-${Date.now()}`)
  await mkdir(ex, { recursive: true })
  if (asset.name.endsWith('.zip')) unzip(tmp, ex)
  else untar(tmp, ex)
  const found = findFile(ex, plat === 'win32' ? /^aria2c\.exe$/i : /^aria2c$/)
  if (!found) throw new Error('解包后未找到 aria2c')
  await place(found, bin)
}

/** P2 修复：darwin-x64 的 ffmpeg/ffprobe 来源——BtbN 无 macOS x64 资产，
 * 改用 ffbinaries（macos-64 zip 内含可执行单文件，API 稳定、HTTPS 直链） */
async function fetchFfmpegDarwinX64() {
  const metaRes = spawnSync('curl', ['-sSL', 'https://ffbinaries.com/api/v1/version/latest'], {
    encoding: 'utf8',
    timeout: 60_000
  })
  if (metaRes.status !== 0) throw new Error('ffbinaries API unreachable: https://ffbinaries.com')
  const meta = JSON.parse(metaRes.stdout)
  for (const tool of ['ffmpeg', 'ffprobe']) {
    if (!(await need(tool))) continue
    const url = meta?.bin?.['macos-64']?.[tool]
    if (!url) throw new Error(`ffbinaries ${meta.version ?? 'latest'} 缺少 macos-64 ${tool} 资产`)
    console.log(`${tool} (ffbinaries ${meta.version}) …`)
    const tmp = join(tmpdir(), `ffb-${tool}.zip`)
    await unlink(tmp).catch(() => {})
    download(url, tmp)
    const ex = join(tmpdir(), `ffb-x-${tool}-${Date.now()}`)
    await mkdir(ex, { recursive: true })
    unzip(tmp, ex)
    const found = findFile(ex, new RegExp(`^${tool}$`, 'i'))
    if (!found) throw new Error(`解包后未找到 ${tool}`)
    await place(found, tool)
  }
}

async function fetchFfmpeg() {
  const exe = plat === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
  if (plat === 'darwin' && arch === 'x64') return fetchFfmpegDarwinX64()
  // 第七轮审查 P3：逐工具判断缺失——此前 ffmpeg 在位即 early-return，
  // ffprobe 缺失（手动清理/上次中断）时永远补不上，只能 --force 重下 ffmpeg
  const needFfmpeg = await need(exe)
  const needFfprobe = await need(plat === 'win32' ? 'ffprobe.exe' : 'ffprobe')
  if (!needFfmpeg && !needFfprobe) return
  console.log('ffmpeg (BtbN/FFmpeg-Builds) …')
  const rel = ghLatest('BtbN/FFmpeg-Builds/releases/latest')
  const suffix =
    plat === 'win32'
      ? /win64-gpl-shared.*\.zip$/i
      : plat === 'darwin'
        ? /macos-arm64-gpl-shared.*\.zip$/i
        : /linux64-gpl-shared.*\.tar\.xz$/i
  const asset = rel.assets?.find((a) => suffix.test(a.name))
  if (!asset) throw new Error('FFmpeg-Builds 无匹配平台资产')
  const tmp = join(tmpdir(), asset.name)
  await unlink(tmp).catch(() => {})
  download(asset.browser_download_url, tmp)
  const ex = join(tmpdir(), `ff-x-${Date.now()}`)
  await mkdir(ex, { recursive: true })
  if (asset.name.endsWith('.zip')) unzip(tmp, ex)
  else {
    const r = spawnSync('tar', ['-xf', tmp, '-C', ex], { timeout: 600_000 })
    if (r.status !== 0) throw new Error('untar ffmpeg failed')
  }
  for (const tool of ['ffmpeg', 'ffprobe']) {
    const pat = plat === 'win32' ? new RegExp(`^${tool}\\.exe$`, 'i') : new RegExp(`^${tool}$`)
    const found = findFile(ex, pat)
    if (!found) throw new Error(`解包后未找到 ${tool}`)
    await place(found, plat === 'win32' ? `${tool}.exe` : tool)
  }
}

await mkdir(OUT, { recursive: true })
console.log(`[sidecars] 目标目录：${OUT}`)
let failed = 0
for (const job of [fetchYtDlp, fetchAria2, fetchFfmpeg]) {
  try {
    await job()
  } catch (err) {
    failed++
    console.error(`  ✗ ${job.name}: ${err.message}`)
  }
}
if (failed > 0) {
  console.error(`[sidecars] ${failed} 项失败——请重试或手动放置到引擎目录`)
  process.exitCode = 1
} else {
  console.log('[sidecars] 全部就位')
}
