// 统一应用图标生成器（Electron 无窗运行）：
// 科技黑圆角矩形 + 电蓝「聚合下载」图形——三条来源支流汇入单一主箭头，落入托盘。
// 产物：build/icon.png(512, electron-builder 自动转 ico/icns) /
//       resources/icon.png(128, 托盘+extraResources) /
//       src/renderer/src/assets/logo.png(128, 界面左上角)
// 运行：npx electron scripts/gen-icon.cjs（完整 Electron 无窗运行，用后自退出）

const { app, nativeImage } = require('electron')
const fs = require('fs')
const path = require('path')

const S = 2048 // 画布（4x 超采样后平滑缩放）
const K = S / 512 // 512 设计空间 → 画布

/** 圆角矩形 SDF（负值在内部） */
function sdfRoundRect(px, py, cx, cy, hx, hy, r) {
  const qx = Math.abs(px - cx) - (hx - r)
  const qy = Math.abs(py - cy) - (hy - r)
  const ax = Math.max(qx, 0)
  const ay = Math.max(qy, 0)
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r
}

/** 盒子 SDF */
function sdfBox(px, py, cx, cy, hx, hy) {
  const dx = Math.abs(px - cx) - hx
  const dy = Math.abs(py - cy) - hy
  const ax = Math.max(dx, 0)
  const ay = Math.max(dy, 0)
  return Math.hypot(ax, ay) + Math.min(Math.max(dx, dy), 0)
}

/** 线段 SDF（胶囊）：点到线段距离 - 半宽 */
function sdfSegment(px, py, x1, y1, x2, y2, hw) {
  const vx = x2 - x1
  const vy = y2 - y1
  const wx = px - x1
  const wy = py - y1
  const t = Math.max(0, Math.min(1, (wx * vx + wy * vy) / (vx * vx + vy * vy || 1)))
  return Math.hypot(wx - vx * t, wy - vy * t) - hw
}

/** 箭头三角覆盖度：顶边 y0 → 底点 apexY，半宽从 hw0 线性展开到 hw1（逐行插值，1px 羽化） */
function triCoverage(dx, dy, cx, y0, apexY, hw0, hw1) {
  if (dy < y0 || dy > apexY) return 0
  const t = (dy - y0) / (apexY - y0)
  const hw = hw0 + (hw1 - hw0) * t
  return Math.max(0, Math.min(1, hw - Math.abs(dx - cx) + 0.5))
}

const cov = (d) => Math.max(0, Math.min(1, 0.5 - d))

function render() {
  const buf = Buffer.alloc(S * S * 4, 0)
  // 科技黑底：近黑垂直渐变（§7.2 禁纯黑 #000，用 #0B0C0E 系）
  const bgA = [0x21, 0x24, 0x2b] // RGB #21242B（顶部微亮蓝灰）
  const bgB = [0x0a, 0x0b, 0x0d] // RGB #0A0B0D（底部近黑）
  // 电蓝箭头渐变（§7.3 Electric Blue）
  const arA = [0x6a, 0xb0, 0xff] // RGB #6AB0FF（顶）
  const arB = [0x25, 0x63, 0xeb] // RGB #2563EB（底）
  const R = 512 * 0.23 * K // 圆角半径（≈23%）
  for (let y = 0; y < S; y++) {
    const gy = y / S
    const bgr = Math.round(bgA[0] + (bgB[0] - bgA[0]) * gy)
    const bgg = Math.round(bgA[1] + (bgB[1] - bgA[1]) * gy)
    const bgb = Math.round(bgA[2] + (bgB[2] - bgA[2]) * gy)
    for (let x = 0; x < S; x++) {
      // 圆角矩形遮罩（1px 羽化抗锯齿）
      const mask = cov(sdfRoundRect(x, y, S / 2, S / 2, S / 2, S / 2, R))
      if (mask <= 0) continue
      // 聚合下载图形（512 设计空间 × K）：
      // 三条来源支流（左/中/右）汇入单一主箭头 → 落入托盘底线
      const dx = x / K
      const dy = y / K
      // 支流：左上/右上斜线 + 中路竖线，汇聚于箭杆顶部（y≈208）
      const dLeft = sdfSegment(dx, dy, 148, 116, 240, 200, 17)
      const dRight = sdfSegment(dx, dy, 364, 116, 272, 200, 17)
      const dCenter = sdfBox(dx, dy, 256, 160, 15, 52) // y 108..212
      // 主箭杆 + 箭头 + 托盘底线
      const dShaft = sdfBox(dx, dy, 256, 258, 26, 58) // y 200..316
      const dBase = sdfBox(dx, dy, 256, 438, 116, 15)
      const aTri = triCoverage(dx, dy, 256, 306, 404, 30, 122)
      const aArrow = Math.max(
        cov(dLeft),
        cov(dRight),
        cov(dCenter),
        cov(dShaft),
        aTri,
        cov(dBase)
      )
      // 箭头颜色随垂直渐变（电蓝）
      const ar = Math.round(arA[0] + (arB[0] - arA[0]) * gy)
      const ag = Math.round(arA[1] + (arB[1] - arA[1]) * gy)
      const ab = Math.round(arA[2] + (arB[2] - arA[2]) * gy)
      // 混合：黑底 → 蓝箭头
      const r = Math.round(bgr + (ar - bgr) * aArrow)
      const g = Math.round(bgg + (ag - bgg) * aArrow)
      const b = Math.round(bgb + (ab - bgb) * aArrow)
      const i = (y * S + x) * 4
      buf[i] = b // BGRA
      buf[i + 1] = g
      buf[i + 2] = r
      buf[i + 3] = Math.round(mask * 255)
    }
  }
  return nativeImage.createFromBitmap(buf, { width: S, height: S })
}

app.whenReady().then(() => {
  const master = render()
  const out = (size, file) => {
    const img = size >= S ? master : master.resize({ width: size, height: size, quality: 'best' })
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, img.toPNG())
    console.log(`wrote ${file} (${size}x${size})`)
  }
  out(512, path.join(__dirname, '..', 'build', 'icon.png'))
  out(128, path.join(__dirname, '..', 'resources', 'icon.png'))
  out(128, path.join(__dirname, '..', 'src', 'renderer', 'src', 'assets', 'logo.png'))
  app.exit(0)
})
