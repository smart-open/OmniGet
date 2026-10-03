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

import { mkdir, chmod, rename, unlink } from 'node:fs/promises'
import { existsSync, readdirSync } from 'node:fs'
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
  const r = spawnSync('curl', ['-sSL', '-H', 'Accept: application/vnd.github+json', `${GH}/repos/${repo}/releases/latest`], {
    encoding: 'utf8',
    timeout: 60_000
  })
  if (r.status !== 0) throw new Error(`GitHub API unreachable: ${repo}`)
  return JSON.parse(r.stdout)
}

/** 下载到文件（跟随重定向）；shell 路由到 curl 保证 CI/本地一致 */
function download(url, dest) {
  const r = spawnSync('curl', ['-sSL', '--fail', '--retry', '3', '-o', dest, url], { timeout: 600_000 })
  if (r.status !== 0) throw new Error(`download failed: ${url}`)
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
  const r = spawnSync('tar', ['-xzf', tgz, '-C', toDir], { timeout: 300_000 })
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
  await rename(src, dest)
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
          ? 'yt-dlp_linux_arm64'
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
  if (!(await need(exe))) return
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
