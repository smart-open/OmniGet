// 系统集成包（M1-12，§4.6）：托盘、系统通知、剪贴板监听、magnet: 协议注册、开机自启。
// 托盘：品牌 icon.png（自带底色适配深浅色任务栏）、左键切换主窗、右键丰富菜单
//（速度表头 / 显示主窗 / 新建任务 / 全部暂停·继续 / 剪贴板监听 / 开机自启 / 退出）。

import { app, Menu, Tray, nativeImage, BrowserWindow, clipboard, Notification } from 'electron'
import { join } from 'path'
import { sniff, DedupeWindow } from '../sniffer'
import { createLogger } from '../logger'
import { runtimeBase } from '../env'
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

// ── 托盘图标：品牌 icon.png（深色圆角底 + 蓝色聚合下载箭头）──────────
// 自带底色，深浅色任务栏均可辨识，无需模板图/主题重绘。

function buildTrayIcon(): Electron.NativeImage {
  const candidates = [
    join(runtimeBase(), 'resources', 'icon.png'), // dev 与 Windows 打包态
    join(process.resourcesPath ?? runtimeBase(), 'icon.png') // electron-builder extraResources
  ]
  for (const p of candidates) {
    const img = nativeImage.createFromPath(p)
    if (!img.isEmpty()) {
      const icon = img.resize({ width: 16, height: 16, quality: 'best' })
      const big = img.resize({ width: 32, height: 32, quality: 'best' })
      icon.addRepresentation({ scaleFactor: 2, width: 32, height: 32, buffer: big.toPNG() })
      return icon
    }
  }
  log.warn('tray icon: resources/icon.png not found, using empty image')
  return nativeImage.createEmpty()
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
      // Linux：Electron 经 XDG autostart（~/.config/autostart/*.desktop）实现，主流桌面环境可用，放开供用户自选
      visible: true,
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

  if (process.platform === 'darwin') {
    // macOS 惯例：单击弹菜单（左/右键同口径），无"左键切窗口"约定
    tray.on('click', () => tray?.popUpContextMenu(buildTrayMenu()))
    tray.on('right-click', () => tray?.popUpContextMenu(buildTrayMenu()))
  } else {
    // 左键：切换主窗显隐（Windows/Linux 行为）
    tray.on('click', () => toggleMainWindow())
    // 右键：弹出菜单（每次现场构建，速度/勾选态始终最新）
    tray.on('right-click', () => tray?.popUpContextMenu(buildTrayMenu()))
  }

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
