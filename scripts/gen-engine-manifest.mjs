// 一期 0.8.0（backlog §一 #3）：发布侧引擎资产生成。
// 扫描 resources/engines/<platform>-<arch>/ 下与 engine-fetch.ts ENGINE_FILES
// 同口径的引擎文件，产出：
//   release/engine-dist/<platform>-<arch>/manifest.json   → { files: { <文件名>: sha256 } }
//   release/engine-dist/<platform>-<arch>/<文件名>        → 引擎文件本体
// CI release job 将其扁平化为 <platform>-<arch>-<文件名> 上传 GitHub Release
// （Release 资产是平铺命名空间；engine-fetch 目录式 404 时回退扁平口径）。
//
// 用法：node scripts/gen-engine-manifest.mjs [--engines <dir>] [--out <dir>]

import { mkdir, copyFile, writeFile, readdir } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const argOf = (flag, fallback) => {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : fallback
}
const ENGINES = argOf('--engines', join(ROOT, 'resources', 'engines'))
const OUT = argOf('--out', join(ROOT, 'release', 'engine-dist'))

// 与 src/main/updater/engine-fetch.ts ENGINE_FILES 同口径（缺 deno/N_m3u8DL-RE
// 时跳过该条目——软失败收集项，应用侧按需补齐时给出明确报错而非静默缺失）
const NAMES = ['aria2c', 'ffmpeg', 'ffprobe', 'yt-dlp', 'deno', 'N_m3u8DL-RE']
const fileOf = (name, plat) => (plat === 'win32' ? `${name}.exe` : name)

if (!existsSync(ENGINES)) {
  console.error(`[engine-dist] 引擎目录不存在：${ENGINES}`)
  process.exit(1)
}

const entries = (await readdir(ENGINES, { withFileTypes: true })).filter((e) => e.isDirectory())
if (entries.length === 0) {
  console.error(`[engine-dist] 引擎目录下无平台子目录：${ENGINES}`)
  process.exit(1)
}

let generated = 0
for (const ent of entries) {
  const key = ent.name // 形如 win32-x64 / darwin-arm64（与运行时 dirKey 同口径）
  const plat = key.split('-')[0]
  const srcDir = join(ENGINES, key)
  const outDir = join(OUT, key)
  const files = {}
  for (const name of NAMES) {
    const f = fileOf(name, plat)
    const p = join(srcDir, f)
    if (!existsSync(p)) continue
    const sha = createHash('sha256').update(readFileSync(p)).digest('hex')
    files[f] = sha
    await mkdir(outDir, { recursive: true })
    await copyFile(p, join(outDir, f))
  }
  if (Object.keys(files).length === 0) {
    console.warn(`[engine-dist] ${key}: 无已知引擎文件，跳过`)
    continue
  }
  await writeFile(join(outDir, 'manifest.json'), `${JSON.stringify({ files }, null, 2)}\n`)
  generated++
  console.log(`[engine-dist] ${key}: ${Object.keys(files).length} 项（${Object.keys(files).join(', ')}）`)
}

if (generated === 0) {
  console.error('[engine-dist] 未生成任何平台清单')
  process.exit(1)
}
console.log(`[engine-dist] 完成：${generated} 个平台 → ${OUT}`)
