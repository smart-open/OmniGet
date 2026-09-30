// 系统集成包（M1-12，§4.6）：托盘、系统通知、剪贴板监听、magnet: 协议注册、开机自启。
// 托盘：程序化绘制的模板图标（自动适配深浅色任务栏）、左键切换主窗、右键丰富菜单
//（速度表头 / 显示主窗 / 新建任务 / 全部暂停·继续 / 剪贴板监听 / 开机自启 / 退出）。

import {
  app,
  Menu,
  Tray,
  nativeImage,
  nativeTheme,
  BrowserWindow,
  clipboard,
  Notification
} from 'electron'
import { sniff, DedupeWindow } from '../sniffer'
import { createLogger } from '../logger'
import { getSetting, setSetting } from '../db'
import type { TaskEvent } from '@shared/types'

const log = createLogger('integrations')

let tray: Tray | null = null
let clipboardTimer: NodeJS.Timeout | null = null
const dedupe = new DedupeWindow(30_000)
let speedProvider: () => { down: number; up: number; running: number; queued: number } = () => ({
  down: 0,
  up: 0,
  running: 0,
  queued: 0
})
let pauseAllHandler: () => Promise<void> | void = () => {}
let resumeAllHandler: () => Promise<void> | void = () => {}

/** 主进程 → 渲染层 UI 动作（新建任务预填） */
export function sendUiAction(win: BrowserWindow, action: 'new-task', payload?: unknown): void {
  win.webContents.send('ui:action', { action, payload })
}

export function setSpeedProvider(
  p: () => { down: number; up: number; running: number; queued: number }
): void {
  speedProvider = p
}

/** M1-12 托盘全局暂停/继续（manager 注入 aria2 forcePauseAll/unpauseAll） */
export function setBulkControlHandlers(
  pauseAll: () => Promise<void> | void,
  resumeAll: () => Promise<void> | void
): void {
  pauseAllHandler = pauseAll
  resumeAllHandler = resumeAll
}

// ── 托盘图标：程序化绘制「聚合下载」单色字形（透明底，随系统深浅色换色）──
// Windows 不反色模板图 → 监听 nativeTheme 重绘：深色任务栏用白色字形，浅色用近黑。

function segCoverage(
  dx: number,
  dy: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  hw: number
): number {
  const vx = x2 - x1
  const vy = y2 - y1
  const wx = dx - x1
  const wy = dy - y1
  const t = Math.max(0, Math.min(1, (wx * vx + wy * vy) / (vx * vx + vy * vy || 1)))
  return Math.max(0, Math.min(1, hw - Math.hypot(wx - vx * t, wy - vy * t) + 0.5))
}

function boxCoverage(dx: number, dy: number, cx: number, cy: number, hx: number, hy: number): number {
  return Math.max(0, Math.min(1, Math.min(hx - Math.abs(dx - cx), hy - Math.abs(dy - cy)) + 0.5))
}

function triCoverage(dx: number, dy: number, cx: number, y0: number, apexY: number, hw0: number, hw1: number): number {
  if (dy < y0 || dy > apexY) return 0
  const t = (dy - y0) / (apexY - y0)
  const hw = hw0 + (hw1 - hw0) * t
  return Math.max(0, Math.min(1, hw - Math.abs(dx - cx) + 0.5))
}

/** 「聚合下载」字形：三支流汇入主箭头 → 托盘底线。512 设计空间渲染后平滑缩放。 */
function drawGlyphImage(r: number, g: number, b: number): Electron.NativeImage {
  const S = 512
  const buf = Buffer.alloc(S * S * 4, 0)
  const K = S / 16 // 16 网格设计空间
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = x / K
      const dy = y / K
      const a = Math.max(
        segCoverage(dx, dy, 2.6, 2.4, 7.1, 7.4, 0.85), // 左支流
        segCoverage(dx, dy, 13.4, 2.4, 8.9, 7.4, 0.85), // 右支流
        boxCoverage(dx, dy, 8, 4.4, 1.0, 3.1), // 中路竖杆（y1.3..7.5）
        boxCoverage(dx, dy, 8, 8.3, 1.0, 0.9), // 主箭杆（y7.4..9.2）
        triCoverage(dx, dy, 8, 9.2, 12.4, 1.6, 4.9), // 箭头
        boxCoverage(dx, dy, 8, 14.2, 4.6, 0.9) // 托盘底线
      )
      if (a <= 0) continue
      const i = (y * S + x) * 4
      buf[i] = b
      buf[i + 1] = g
      buf[i + 2] = r
      buf[i + 3] = Math.round(a * 255)
    }
  }
  return nativeImage.createFromBitmap(buf, { width: S, height: S })
}

function themedTrayIcon(): Electron.NativeImage {
  // 系统深色任务栏（深色模式）→ 白色字形；浅色 → 近黑（§7.2 禁纯黑）
  const dark = nativeTheme.shouldUseDarkColors
  const [r, g, b] = dark ? [255, 255, 255] : [23, 24, 26]
  const glyph = drawGlyphImage(r, g, b)
  const icon = glyph.resize({ width: 16, height: 16, quality: 'best' })
  const big = glyph.resize({ width: 32, height: 32, quality: 'best' })
  icon.addRepresentation({ scaleFactor: 2, width: 32, height: 32, buffer: big.toBitmap() })
  return icon
}

function buildTrayIcon(): Electron.NativeImage {
  return themedTrayIcon()
}

// ── 主窗口切换（左键单击）────────────────────────────────────────────

export function toggleMainWindow(): void {
  const win = BrowserWindow.getAllWindows()[0]
  if (!win) return
  if (win.isVisible() && !win.isMinimized()) {
    win.hide()
  } else {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }
}

// ── 托盘（§4.6）──────────────────────────────────────────────────────

function fmtSpeed(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB/s`
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB/s`
  return `${Math.max(0, Math.round(n / 1024))} KB/s`
}

function buildTrayMenu(): Electron.Menu {
  const s = speedProvider()
  const clipboardWatch = getSetting('ui.clipboardWatch') !== 'false'
  const loginItem = app.getLoginItemSettings?.().openAtLogin ?? false

  return Menu.buildFromTemplate([
    {
      label: `↓ ${fmtSpeed(s.down)}   ↑ ${fmtSpeed(s.up)}`,
      enabled: false
    },
    {
      label: `运行 ${s.running} · 排队 ${s.queued}`,
      enabled: false
    },
    { type: 'separator' },
    {
      label: '显示主界面',
      click: () => {
        const win = BrowserWindow.getAllWindows()[0]
        if (win) {
          if (win.isMinimized()) win.restore()
          win.show()
          win.focus()
        }
      }
    },
    {
      label: '新建任务…',
      click: () => {
        const win = BrowserWindow.getAllWindows()[0]
        if (win) {
          if (win.isMinimized()) win.restore()
          win.show()
          win.focus()
          sendUiAction(win, 'new-task')
        }
      }
    },
    { type: 'separator' },
    {
      label: '全部暂停',
      enabled: s.running > 0,
      click: () => void pauseAllHandler()
    },
    {
      label: '全部继续',
      enabled: s.queued > 0,
      click: () => void resumeAllHandler()
    },
    { type: 'separator' },
    {
      label: '剪贴板监听',
      type: 'checkbox',
      checked: clipboardWatch,
      click: (item) => {
        setSetting('ui.clipboardWatch', item.checked ? 'true' : 'false')
        if (item.checked) startClipboardWatcher(() => {})
        else stopClipboardWatcher()
        log.info(`clipboard watch ${item.checked ? 'enabled' : 'disabled'} (tray)`)
      }
    },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: loginItem,
      visible: process.platform !== 'linux',
      click: (item) => setLoginItemSettings(item.checked)
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        // B4：必须走 app.quit() 触发 before-quit（supervisor.shutdown 依赖它）；
        // app.exit() 会跳过生命周期事件导致 aria2c 孤儿进程
        app.quit()
      }
    }
  ])
}

export function createTray(): Tray {
  tray = new Tray(buildTrayIcon())
  tray.setToolTip('OmniGet')
  // 系统深浅色切换 → 重绘托盘字形（Windows 不自动反色）
  nativeTheme.on('updated', () => {
    tray?.setImage(themedTrayIcon())
  })

  // 左键：切换主窗显隐（Windows 行为；macOS 用 right-click 打开菜单）
  tray.on('click', () => toggleMainWindow())
  // 右键：弹出菜单（每次现场构建，速度/勾选态始终最新）
  tray.on('right-click', () => {
    tray?.popUpContextMenu(buildTrayMenu())
  })

  // tooltip 每 2s 刷新聚合速度
  const rebuild = (): void => {
    const s = speedProvider()
    tray?.setToolTip(
      `OmniGet\n↓ ${fmtSpeed(s.down)}  ↑ ${fmtSpeed(s.up)}\n运行 ${s.running} · 排队 ${s.queued}`
    )
  }
  rebuild()
  setInterval(rebuild, 2000)
  log.info('tray created (interactive icon + rich menu)')
  return tray
}

/** 关闭主窗默认最小化到托盘（§4.6）；before-quit 期间放行 */
export function interceptCloseToTray(win: BrowserWindow): void {
  win.on('close', (e) => {
    if (!(app as unknown as { isQuitting?: boolean }).isQuitting) {
      e.preventDefault()
      win.hide()
    }
  })
}

export function markQuitting(): void {
  ;(app as unknown as { isQuitting?: boolean }).isQuitting = true
}

// ── 剪贴板监听（§4.6：与协议唤起/拖拽共用 30s 去重窗口）──────────────

export function clipboardWatchEnabled(): boolean {
  return getSetting('ui.clipboardWatch') !== 'false' // 默认开（向导口径一致）
}

export function startClipboardWatcher(onSource: (source: string) => void): void {
  if (clipboardTimer) return
  let last = ''
  clipboardTimer = setInterval(() => {
    const text = clipboard.readText()?.trim()
    if (!text || text === last) return
    last = text
    const s = sniff(text)
    if (!s || s.type === 'music') return // 仅磁力/种子路径/URL 触发提示
    if (!dedupe.check(text.slice(0, 120))) return
    log.info(`clipboard detected ${s.type} link`)
    const win = BrowserWindow.getAllWindows()[0]
    if (win) {
      if (win.isMinimized()) win.restore()
      win.show()
      sendUiAction(win, 'new-task', s.source)
    }
    void onSource
  }, 1500)
}

export function stopClipboardWatcher(): void {
  if (clipboardTimer) {
    clearInterval(clipboardTimer)
    clipboardTimer = null
  }
}

// ── 系统通知（§4.6：任务完成/失败）──────────────────────────────────

export function notifyTaskEvent(e: TaskEvent, taskName: string): void {
  if (e.status !== 'completed' && e.status !== 'failed') return
  if (!Notification.isSupported()) return
  new Notification({
    title: e.status === 'completed' ? '下载完成' : '下载失败',
    body: taskName || '任务',
    silent: e.status === 'completed'
  }).show()
}

// ── magnet: 协议注册 + 开机自启（§4.6，默认关）──────────────────────

export function registerProtocol(): void {
  if (app.isPackaged) {
    if (!app.isDefaultProtocolClient('magnet')) {
      app.setAsDefaultProtocolClient('magnet')
    }
  } else {
    // dev：仅注册入口，不写注册表（避免污染开发机）
    log.info('dev mode: skip magnet protocol registration')
  }
}

export function setLoginItemSettings(enabled: boolean): void {
  app.setLoginItemSettings({ openAtLogin: enabled })
}
