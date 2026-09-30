// AI 图标后处理（Electron 无窗运行）：
// 从 1024 生成图中心裁出圆角瓦片 → 外围透明化（SDF 羽化）→ 缩放输出三份产物。
// 运行：npx electron scripts/process-ai-icon.cjs <输入png>

const { app, nativeImage } = require('electron')
const fs = require('fs')
const path = require('path')

const input = process.argv[2] ?? path.join(__dirname, '..', 'out', 'icon-raw.png')

function sdfRoundRect(px, py, cx, cy, hx, hy, r) {
  const qx = Math.abs(px - cx) - (hx - r)
  const qy = Math.abs(py - cy) - (hy - r)
  const ax = Math.max(qx, 0)
  const ay = Math.max(qy, 0)
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r
}
const cov = (d) => Math.max(0, Math.min(1, 0.5 - d))

app.whenReady().then(() => {
  const src = nativeImage.createFromPath(input)
  const { width: W, height: H } = src.getSize()
  const raw = src.toBitmap() // BGRA
  // 瓦片边距：生成图外围有灰底，裁掉 15%
  const m = Math.round(Math.min(W, H) * 0.15)
  const T = Math.min(W, H) - m * 2
  const R = T * 0.23 // 圆角半径 ≈23%
  const out = Buffer.alloc(T * T * 4, 0)
  for (let y = 0; y < T; y++) {
    for (let x = 0; x < T; x++) {
      const sx = m + x
      const sy = m + y
      const si = (sy * W + sx) * 4
      const mask = cov(sdfRoundRect(x, y, T / 2, T / 2, T / 2, T / 2, R))
      const di = (y * T + x) * 4
      out[di] = raw[si] // B
      out[di + 1] = raw[si + 1] // G
      out[di + 2] = raw[si + 2] // R
      out[di + 3] = Math.round(mask * 255) // A
    }
  }
  const tile = nativeImage.createFromBitmap(out, { width: T, height: T })
  const save = (size, file) => {
    const img = size >= T ? tile : tile.resize({ width: size, height: size, quality: 'best' })
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, img.toPNG())
    console.log(`wrote ${file} (${size}x${size})`)
  }
  const root = path.join(__dirname, '..')
  save(512, path.join(root, 'build', 'icon.png'))
  save(128, path.join(root, 'resources', 'icon.png'))
  save(128, path.join(root, 'src', 'renderer', 'src', 'assets', 'logo.png'))
  app.exit(0)
})
