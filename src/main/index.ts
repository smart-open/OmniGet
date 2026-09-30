// 主进程入口（T0-1）：单实例锁、窗口、生命周期编排。

import { app, BrowserWindow, Menu, shell } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { allocatePorts } from './orchestrator/ports'
import { checkBinary } from './orchestrator/binaries'
import { Aria2Supervisor } from './orchestrator/aria2'
import { Aria2Adapter } from './adapters/aria2'
import { LocalMusicAdapter } from './music/adapter'
import { registerPreviewHandler, registerPreviewScheme } from './music/preview-protocol'
import { YtDlpAdapter } from './adapters/ytdlp'
import { getYtDlpSupervisor } from './orchestrator/ytdlp'
import { TaskManager } from './task/manager'
import { getDb, closeDb } from './db'
import { registerIpcHandlers, setTaskManager, setMusicAdapter } from './ipc'
import { createLogger } from './logger'
import { runtimeBase } from './env'
import { startStatsScheduler, stopStatsScheduler } from './stats'
import { startScheduler } from './scheduler'
import { toolbox } from './toolbox'
import { broadcastToolEvents } from './ipc'
import { refreshTrackers, joinedTrackers } from './trackers'
import { startAppUpdater } from './app-updater'
import {
  clipboardWatchEnabled,
  createTray,
  interceptCloseToTray,
  markQuitting,
  registerProtocol,
  setBulkControlHandlers,
  setSpeedProvider,
  startClipboardWatcher
} from './integrations/tray'
import { sniff } from './sniffer'

const log = createLogger('main')

// 特权 scheme 注册必须在 app ready 之前（omniget-preview: 试听流，F1）
registerPreviewScheme()

// ── 单实例锁（二次启动唤起已有实例）──────────────────────────────────
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', (_e, argv) => {
    // magnet: 协议唤起：从 argv 提取链接并转发到窗口（§4.6，30s 去重在嗅探侧）
    const source = argv.find((a) => /^magnet:\?/i.test(a) || /^https?:\/\//i.test(a))
    const win = BrowserWindow.getAllWindows()[0]
    if (win) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
      if (source && sniff(source)) {
        win.webContents.send('ui:action', { action: 'new-task', payload: source })
      }
    }
  })

  void bootstrap()
}

async function bootstrap(): Promise<void> {
  // 去掉原生菜单栏（应用内导航 + 自绘标题栏承担全部入口）
  Menu.setApplicationMenu(null)

  app.whenReady().then(createWindow)

  // §2.2 应用启动：恢复 DB → 端口分配 → 二进制校验 → 恢复任务 → 引擎 → IPC
  await app.whenReady()
  getDb()

  const ports = await allocatePorts()
  log.info('ports allocated', ports)
  for (const name of ['aria2c', 'ytdlp', 'ffmpeg'] as const) {
    try {
      await checkBinary(name)
    } catch (err) {
      log.error(`binary check failed: ${name}`, err)
    }
  }

  registerIpcHandlers()
  registerProtocol() // magnet: 协议（M1-12）
  registerPreviewHandler() // omniget-preview: 试听流协议（F1，主进程内引擎）

  // M1 编排：任务恢复 → aria2 监督器 → 适配器 → 管理器
  const supervisor = new Aria2Supervisor(ports.aria2RpcPort, undefined, {
    onOnline: (port) => {
      log.info(`aria2 online at ${port}`)
      void manager.recoverEngineTasks()
      manager.broadcastHealth(true)
      // M4-16：aria2 就绪后注入 Tracker（启动期的竞态在此兜底重试）；
      // 加速：同时对运行中/排队任务逐个 changeOption 注入
      const trackerCsv = joinedTrackers()
      void supervisor
        .getClient()
        .call('changeGlobalOption', { 'bt-tracker': trackerCsv })
        .then(() => manager.injectTrackersToRunning(trackerCsv))
        .catch(() => {})
    },
    onOffline: () => {
      manager.broadcastHealth(false, 'aria2 连续重启失败')
    }
  })
  const adapter = new Aria2Adapter(supervisor)
  const manager = new TaskManager(adapter)
  const ytdlpAdapter = new YtDlpAdapter()
  manager.setYtdlpEngine(ytdlpAdapter)

  setTaskManager(manager)
  await manager.recoverOnStartup()
  manager.startPolling()

  // aria2 缺席（T0 阶段允许）时仅告警，不阻塞应用启动
  void supervisor.start().catch((err) => {
    log.error(`aria2 supervisor start failed: ${String(err)}`)
    manager.broadcastHealth(false, 'aria2 引擎不可用')
  })

  // M3：yt-dlp 健康探测（--version）
  void getYtDlpSupervisor()
    .version()
    .then((v) => {
      if (v) log.info(`yt-dlp ${v} available`)
      else log.warn('yt-dlp binary unavailable')
    })

  // ── M4 ─────────────────────────────────────────────────────────────
  startStatsScheduler()
  startAppUpdater()
  toolbox.onEvent((e) => broadcastToolEvents(e))
  // M4-15：调度器应用限速（aria2 changeGlobalOption）
  startScheduler((limit) => supervisor.getClient().call('changeGlobalOption', { 'max-overall-download-limit': limit }))
  // M4-16：Tracker 刷新（注入统一在 aria2 onOnline 后兜底执行，避免启动竞态告警）
  void refreshTrackers().catch((err) => log.warn('tracker refresh failed (使用缓存)', err))

  // ── M2：音乐线（主进程内嵌引擎，无需 sidecar）────────────────────
  const musicAdapter = new LocalMusicAdapter()
  manager.setMusicEngine(musicAdapter)
  setMusicAdapter(musicAdapter)
  musicAdapter.onEvent((ev) => manager.applyMusicEvent(ev))
  log.info('music engine online (in-process)')

  // M1-12 系统集成：托盘 / 关窗最小化 / 剪贴板监听（按设置启停）
  setSpeedProvider(() => manager.getAggregateSpeeds())
  setBulkControlHandlers(
    () => adapter.pauseAll(),
    () => adapter.resumeAll()
  )
  app.whenReady().then(() => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) {
      createTray()
      interceptCloseToTray(win)
      if (clipboardWatchEnabled()) startClipboardWatcher(() => {})
    }
  })

  app.on('window-all-closed', () => {
    // 关窗已最小化到托盘（interceptCloseToTray），此处仅托盘退出时触发
  })

  app.on('before-quit', () => {
    markQuitting()
    void supervisor.shutdown()
    manager.stopPolling()
    stopStatsScheduler()
    getYtDlpSupervisor().killAll()
    closeDb()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    show: false,
    // 不透明无边框窗口（透明窗在 Windows 上会白屏/透底；Win11 DWM 自动圆角）
    transparent: false,
    frame: false,
    backgroundColor: '#0B0C0E',
    hasShadow: true,
    // 任务栏/Alt-Tab 图标：dev 用 resources/icon.png；Windows 打包态由 exe 内嵌图标接管，
    // macOS 由 bundle icns 接管；Linux 打包态从 electron-builder extraResources 取 icon.png
    icon: existsSync(join(runtimeBase(), 'resources', 'icon.png'))
      ? join(runtimeBase(), 'resources', 'icon.png')
      : join(process.resourcesPath ?? runtimeBase(), 'icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/bridge.js'),
      contextIsolation: true, // §9
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  })

  win.once('ready-to-show', () => win.show())

  // 自绘窗口控件：最小化 / 最大化切换 / 关闭（关闭走托盘拦截 → 隐藏）
  win.on('maximize', () => win.webContents.send('win:state', true))
  win.on('unmaximize', () => win.webContents.send('win:state', false))

  // 外链一律走系统浏览器（§9）
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}
