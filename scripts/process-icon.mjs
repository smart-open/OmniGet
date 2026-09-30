#!/usr/bin/env node
// OmniGet 图标处理工具（原 make_transparent_icon.py + process_icon_v2.py 的 Node 版，sharp 实现）
//
// 用法:
//   node scripts/process-icon.mjs [--src <png>] [--mode v2|legacy] [--src-bg legacy源]
//
// 模式:
//   v2     —— 纯黑底反解（alpha = max(RGB)，fg = pixel/alpha）+ 字形包围盒裁切 + 88% 饱满填充
//   legacy —— 深色砖底图（外圈估计背景色）反解 + 低 alpha 裁剪(CUT=0.18)
//
// 输出: build/icon.png(512) / resources/icon.png(256) / src/renderer/src/assets/logo.png(256)

import sharp from 'sharp'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const getArg = (name, def) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : def
}

const mode = getArg('--mode', 'v2')
const src = resolve(getArg('--src', join(ROOT, 'out', 'icon_v2_raw.png')))
const CUT = 0.18

if (!existsSync(src)) {
  console.error(`source not found: ${src}`)
  process.exit(1)
}

// ── 解码为 RGBA 像素 ────────────────────────────────────────────────
const { data, info } = await sharp(src).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
const W = info.width
const H = info.height
const px = data // RGBA

// ── alpha/前景反解 ──────────────────────────────────────────────────
let bg = [0, 0, 0]
if (mode === 'legacy') {
  // 背景色估计：外圈 8px 环的逐通道中位数
  const ring = []
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (y < 8 || y >= H - 8 || x < 8 || x >= W - 8) {
        const i = (y * W + x) * 4
        ring.push([px[i], px[i + 1], px[i + 2]])
      }
    }
  }
  bg = [0, 1, 2].map((c) => {
    const col = ring.map((r) => r[c]).sort((a, b) => a - b)
    return col[col.length >> 1]
  })
}
console.log('mode =', mode, 'bg =', bg)

const denom = bg.map((b) => 255 - b)
const alpha = new Float64Array(W * H)
const fg = Buffer.alloc(W * H * 3)

for (let p = 0, i = 0; p < W * H; p++, i += 4) {
  const r = px[i]
  const g = px[i + 1]
  const b = px[i + 2]
  let a
  if (mode === 'legacy') {
    const dr = (r - bg[0]) / denom[0]
    const dg = (g - bg[1]) / denom[1]
    const db = (b - bg[2]) / denom[2]
    a = Math.min(1, Math.max(0, Math.max(dr, dg, db)))
    // 反解前景（alpha 0 处置 bg）
    const safe = Math.max(a, 1e-6)
    fg[i] = Math.min(255, Math.max(0, bg[0] + (r - bg[0]) / safe))
    fg[i + 1] = Math.min(255, Math.max(0, bg[1] + (g - bg[1]) / safe))
    fg[i + 2] = Math.min(255, Math.max(0, bg[2] + (b - bg[2]) / safe))
  } else {
    // 纯黑底：alpha = max(RGB)/255，fg = pixel/alpha
    a = Math.max(r, g, b) / 255
    const safe = Math.max(a, 1e-6)
    fg[i] = Math.min(255, r / safe)
    fg[i + 1] = Math.min(255, g / safe)
    fg[i + 2] = Math.min(255, b / safe)
  }
  alpha[p] = a
}

// legacy：低 alpha 裁剪残影 + 重映射
if (mode === 'legacy') {
  for (let p = 0; p < W * H; p++) {
    const a = alpha[p]
    if (a < CUT) alpha[p] = 0
    else alpha[p] = (a - CUT) / (1 - CUT)
  }
} else {
  // v2：极低 alpha 噪声置零
  for (let p = 0; p < W * H; p++) {
    if (alpha[p] < 0.03) alpha[p] = 0
  }
}

// ── 合成 RGBA ───────────────────────────────────────────────────────
const outRgba = Buffer.alloc(W * H * 4)
for (let p = 0, i = 0, o = 0; p < W * H; p++, i += 4, o += 4) {
  outRgba[o] = fg[i]
  outRgba[o + 1] = fg[i + 1]
  outRgba[o + 2] = fg[i + 2]
  outRgba[o + 3] = Math.round(alpha[p] * 255)
}
let img = sharp(outRgba, { raw: { width: W, height: H, channels: 4 } })

// v2：裁字形包围盒 → 居中 88% 画布
if (mode === 'v2') {
  let minX = W, minY = H, maxX = 0, maxY = 0
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (alpha[y * W + x] > 0.03) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  const gw = maxX - minX + 1
  const gh = maxY - minY + 1
  const canvas = Math.ceil(Math.max(gw, gh) / 0.88)
  const padX = Math.floor((canvas - gw) / 2)
  const padY = Math.floor((canvas - gh) / 2)
  const glyphBuf = Buffer.alloc(gw * gh * 4)
  for (let y = 0; y < gh; y++) {
    const srcRow = ((minY + y) * W + minX) * 4
    outRgba.copy(glyphBuf, y * gw * 4, srcRow, srcRow + gw * 4)
  }
  img = sharp(glyphBuf, { raw: { width: gw, height: gh, channels: 4 } })
    .extend({
      top: padY,
      bottom: canvas - gh - padY,
      left: padX,
      right: canvas - gw - padX,
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    })
}

// ── 输出 ───────────────────────────────────────────────────────────
const targets = [
  [join(ROOT, 'build', 'icon.png'), 512],
  [join(ROOT, 'resources', 'icon.png'), 256],
  [join(ROOT, 'src', 'renderer', 'src', 'assets', 'logo.png'), 256]
]
for (const [file, size] of targets) {
  mkdirSync(dirname(file), { recursive: true })
  await img.clone().resize(size, size, { kernel: 'lanczos3' }).png().toFile(file)
  console.log('written:', file)
}
console.log('done')
