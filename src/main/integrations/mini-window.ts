// 迷你悬浮窗（backlog #8，设计文档 §7.7 迅雷对照）：置顶小窗显示聚合速度。
// 复用主窗口渲染层 bundle——?view=mini 时渲染 MiniWidget 分支（App.tsx 全套布局跳过）。
// 窗口特性：frameless / alwaysOnTop / skipTaskbar / 不可缩放；关闭即销毁，托盘菜单可随时重开。

import { BrowserWindow, nativeTheme, screen } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'
import { runtimeBase } from '../env'
import { getSettingParsed } from '../db'
import { createLogger } from '../logger'

const log = createLogger('integrations')

const MINI_WIDTH = 236
const MINI_HEIGHT = 58

/** 圆角外壳外的窗口底色随主题（审查修复：此前硬编码深色，浅色主题首帧闪白底突兀） */
function shellBackground(): string {
  const t = getSettingParsed<string>('ui.theme')
  const light =
    t === 'light' ? true : t === 'dark' ? false : !nativeTheme.shouldUseDarkColors
  return light ? '#F7F8F9' : '#0B0C0E'
}

let miniWin: BrowserWindow | null = null

/** 窗口身份标记：主进程各处原依赖 getAllWindows()[0]，多窗口后必须排除悬浮窗 */
export function isMiniWindow(win: BrowserWindow): boolean {
  return (win as unknown as { __omnigetMini?: boolean }).__omnigetMini === true
}

/** 主窗口（排除迷你悬浮窗；创建序不再可靠——主窗隐藏不销毁，悬浮窗可先销毁重建） */
export function getMainWindow(): BrowserWindow | null {
  return BrowserWindow.getAllWindows().find((w) => !isMiniWindow(w)) ?? null
}

export function miniWindowVisible(): boolean {
  return miniWin !== null && !miniWin.isDestroyed() && miniWin.isVisible()
}

/** 托盘菜单开关：无则创建，可见则隐藏，隐藏则唤回 */
export function toggleMiniWindow(): void {
  if (miniWin && !miniWin.isDestroyed()) {
    if (miniWin.isVisible()) {
      miniWin.hide()
      log.info('mini window hidden')
    } else {
      ensureOnScreen()
      miniWin.show()
      log.info('mini window shown')
    }
    return
  }
  createMiniWindow()
}

/** 审查修复：悬浮窗可能被拖出屏幕外/拖到已断开的显示器——唤回时拉回主工作区，
 * 否则托盘菜单「打开」后窗口不可见且无法找回（只能重启应用） */
function ensureOnScreen(): void {
  if (!miniWin || miniWin.isDestroyed()) return
  const wa = screen.getPrimaryDisplay().workArea
  const [x, y] = miniWin.getPosition()
  const [w, h] = miniWin.getSize()
  if (x === undefined || y === undefined || w === undefined || h === undefined) return
  if (x + w < wa.x || y + h < wa.y || x > wa.x + wa.width || y > wa.y + wa.height) {
    miniWin.setPosition(wa.x + wa.width - w - 16, wa.y + wa.height - h - 16)
  }
}

function miniIcon(): string | undefined {
  const p = existsSync(join(runtimeBase(), 'resources', 'icon.png'))
    ? join(runtimeBase(), 'resources', 'icon.png')
    : join(process.resourcesPath ?? runtimeBase(), 'icon.png')
  return existsSync(p) ? p : undefined
}

export function createMiniWindow(): void {
  if (miniWin && !miniWin.isDestroyed()) {
    miniWin.show()
    return
  }
  const wa = screen.getPrimaryDisplay().workArea
  miniWin = new BrowserWindow({
    width: MINI_WIDTH,
    height: MINI_HEIGHT,
    x: wa.x + wa.width - MINI_WIDTH - 16,
    y: wa.y + wa.height - MINI_HEIGHT - 16,
    show: false,
    frame: false,
    // 不透明窗口（透明窗 Windows 上白屏/透底，与主窗同口径）
    transparent: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    minimizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: true,
    backgroundColor: shellBackground(),
    icon: miniIcon(),
    webPreferences: {
      preload: join(__dirname, '../preload/bridge.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  })
  ;(miniWin as unknown as { __omnigetMini: boolean }).__omnigetMini = true
  // 'screen-saver' 级别：盖过多数置顶应用（迅雷悬浮窗口径）
  miniWin.setAlwaysOnTop(true, 'screen-saver')
  miniWin.once('ready-to-show', () => miniWin?.show())
  // 关闭 = 销毁（不进托盘拦截）；销毁后托盘菜单可随时重建
  miniWin.on('closed', () => {
    miniWin = null
  })
  if (process.env.ELECTRON_RENDERER_URL) {
    void miniWin.loadURL(`${process.env.ELECTRON_RENDERER_URL}/?view=mini`)
  } else {
    void miniWin.loadFile(join(__dirname, '../renderer/index.html'), {
      query: { view: 'mini' }
    })
  }
  log.info('mini window created')
}
