// 主进程入口（T0-1）：单实例锁、窗口、生命周期编排。

import { app, BrowserWindow, dialog, Menu, shell } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { allocatePorts } from './orchestrator/ports'
import { checkBinary } from './orchestrator/binaries'
import { Aria2Supervisor } from './orchestrator/aria2'
import { Aria2Adapter } from './adapters/aria2'
import { LocalMusicAdapter } from './music/adapter'
import { registerPreviewHandler, registerPreviewScheme } from './music/preview-protocol'
import { getMusicEngine } from './music/engine'
import { YtDlpAdapter } from './adapters/ytdlp'
import { getYtDlpSupervisor } from './orchestrator/ytdlp'
import { TaskManager } from './task/manager'
import { getDb, closeDb } from './db'
import { registerIpcHandlers, setTaskManager, setMusicAdapter } from './ipc'
import { createLogger } from './logger'
import { runtimeBase } from './env'
import { startStatsScheduler, stopStatsScheduler } from './stats'
import { startScheduler, invalidateSchedule } from './scheduler'
import { startBridge, stopBridge } from './bridge'
import { toolbox } from './toolbox'
import { broadcastToolEvents } from './ipc'
import { refreshTrackers, joinedTrackers } from './trackers'
import { seedPlatforms } from './health'
import { defaultGlobalOptions } from './aria2/options'
import { getSettingParsed } from './db'
import { setupNatMapping, clearNatMapping } from './net/nat'
import { startAppUpdater, stopAppUpdaterTimer } from './app-updater'
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
import { getMainWindow } from './integrations/mini-window'
import { sniff, launchDedupe as sharedDedupe } from './sniffer'

const log = createLogger('main')

// 特权 scheme 注册必须在 app ready 之前（omniget-preview: 试听流，F1）
registerPreviewScheme()

// ── 单实例锁（二次启动唤起已有实例）──────────────────────────────────
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  const launchDedupe = sharedDedupe // R4-P3：三入口共用去重窗口
  app.on('second-instance', (_e, argv) => {
    // magnet: 协议唤起：从 argv 提取链接并转发到窗口（§4.6；30s 去重防止重复唤起开重复任务）
    const source = argv.find((a) => /^magnet:\?/i.test(a) || /^https?:\/\//i.test(a))
    // R4 续（backlog #8）：多窗口后须排除迷你悬浮窗
    const win = getMainWindow()
    if (win) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
      if (source && sniff(source) && launchDedupe.check(source)) {
        win.webContents.send('ui:action', { action: 'new-task', payload: source })
      }
    }
  })

  // P1 加固：bootstrap 内任一环节（DB 打开/迁移、端口分配等）抛错都不允许变成
  // unhandledRejection 静默无窗退出——给出可见错误后退出
  bootstrap().catch((err) => {
    log.error('bootstrap failed:', err)
    try {
      dialog.showErrorBox(
        'OmniGet 启动失败',
        `${err instanceof Error ? err.message : String(err)}\n\n请检查数据目录是否可写，或重新安装应用。`
      )
    } catch {
      // ready 之前 showErrorBox 不可用的极端场景：忽略，走 app.quit
    }
    app.quit()
  })
}

async function bootstrap(): Promise<void> {
  // 去掉原生菜单栏（应用内导航 + 自绘标题栏承担全部入口）
  Menu.setApplicationMenu(null)

  // §2.2 应用启动：恢复 DB → 端口分配 → 二进制校验 → 恢复任务 → 引擎 → IPC → 窗口
  // ⚠️ 窗口必须在 registerIpcHandlers() 之后创建：提前创建会让渲染层在 handler
  // 注册完成前发起 invoke（task:list/settings:get...），刷一屏 "No handler registered"
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
  // R6：引擎按需下载——缺失且开启自动补齐时后台拉取（不阻塞启动，成败经通知栏反馈）
  void import('./updater/engine-fetch')
    .then(async (m) => {
      if (!m.autoFetchEnabled()) return
      const st = await m.engineStatus()
      const missing = st.filter((e) => !e.installed).map((e) => e.name)
      if (missing.length === 0) return
      log.info(`auto-fetching missing engines: ${missing.join(', ')}`)
      const r = await m.fetchMissingEngines({ names: missing })
      const { broadcastNotices } = await import('./ipc')
      if (r.installed.length > 0) {
        broadcastNotices([
          { level: 'info', message: `已自动安装引擎：${r.installed.join('、')}，如未生效请重启应用` }
        ])
      }
      if (r.failed.length > 0) {
        broadcastNotices([
          {
            level: 'warning',
            message: `引擎自动补齐失败：${r.failed
              .map((f) => `${f.name}（${f.error}）`)
              .join('；')}。可在设置 → 更新 中重试`
          }
        ])
      }
    })
    .catch((err) => log.warn('引擎自动补齐链路异常', { error: String(err) }))
  // ffprobe（可选工具，非 SidecarBinary）：缺失仅 warning——完整性探测会静默降级
  try {
    const { toolPath } = await import('./orchestrator/binaries')
    const { access, constants } = await import('fs/promises')
    await access(toolPath('ffprobe'), constants.X_OK)
  } catch {
    log.warn('ffprobe missing: 完整性探测（M4-12）将不可用，请将 ffprobe 放入引擎目录')
  }

  registerIpcHandlers()
  registerProtocol() // magnet: 协议（M1-12）
  registerPreviewHandler() // omniget-preview: 试听流协议（F1，主进程内引擎）
  createWindow() // IPC/协议全部就绪后再创建窗口（渲染层 invoke 不再撞上未注册通道）

  // L5 修复：旧数据迁移失败必须让用户可见（此前只有 console 留痕，用户视角是历史数据消失）
  const { legacyMigrationErrors } = await import('./env')
  if (legacyMigrationErrors.length > 0) {
    // 延迟到渲染层订阅建立后广播（窗口刚创建，渲染层尚未挂载监听）
    setTimeout(() => {
      void import('./ipc').then(({ broadcastNotices }) =>
        broadcastNotices([
          {
            level: 'warning',
            message: `历史数据迁移失败：${legacyMigrationErrors.join('；')}。旧记录可能无法保留，详见日志`
          }
        ])
      )
    }, 5000)
  }

  // M1 编排：任务恢复 → aria2 监督器 → 适配器 → 管理器
  // R7 P0-5：BT 加密读取设置项（bt.forceEncryption 默认开，绕运营商 QoS）
  const supervisor = new Aria2Supervisor(
    ports.aria2RpcPort,
    defaultGlobalOptions({
      btForceEncryption: getSettingParsed<boolean>('bt.forceEncryption') !== false
    }),
    {
    onOnline: (port) => {
      log.info(`aria2 online at ${port}`)
      void manager.recoverEngineTasks()
      manager.broadcastHealth(true)
      // R4-P2：重启路径 changeGlobalOption 会重置全局限速——重放当前时段档位
      invalidateSchedule()
      // M4-16：aria2 就绪后注入 Tracker（启动期的竞态在此兜底重试）；
      // 加速：同时对运行中/排队任务逐个 changeOption 注入
      const trackerCsv = joinedTrackers()
      void supervisor
        .getClient()
        .call('changeGlobalOption', { 'bt-tracker': trackerCsv })
        .then(() => manager.injectTrackersToRunning(trackerCsv))
        .catch((err) => log.warn('启动期 Tracker 注入失败', { error: String(err) }))
      // R7 P0-1：UPnP/NAT-PMP 端口映射（幂等：已映射则跳过；失败静默降级）
      void setupNatMapping()
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
  // R7 P0-4：每日定时刷新 tracker（原注释与实现不符——只有启动一次）+ 刷新后重注入
  const TRACKER_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000
  setInterval(() => {
    void refreshTrackers()
      .then(() => {
        if (supervisor.isOnline) {
          return supervisor
            .getClient()
            .call('changeGlobalOption', { 'bt-tracker': joinedTrackers() })
        }
      })
      .catch((err) => log.warn('每日 tracker 刷新失败（沿用缓存）', err))
  }, TRACKER_REFRESH_INTERVAL_MS)

  // ── M2：音乐线（主进程内嵌引擎，无需 sidecar）────────────────────
  const musicAdapter = new LocalMusicAdapter()
  manager.setMusicEngine(musicAdapter)
  setMusicAdapter(musicAdapter)
  musicAdapter.onEvent((ev) => manager.applyMusicEvent(ev))
  // B1：恢复上次重启前遗留的 queued 音乐任务（recoverOnStartup 在此之前不泵音乐）
  manager.resumeMusicQueue()
  log.info('music engine online (in-process)')
  // R7 P1：健康面板预置短视频平台行（unknown 态，有任务后按平台归因翻转）。
  // 审查修复：health.ts 已在静态依赖链上，动态 import 是多余的一次调度开销
  seedPlatforms(['douyin', 'kuaishou', 'xiaohongshu', 'weibo', 'xigua'], 'yt-dlp')

  // R1+R5：本地桥接（浏览器扩展 + Web UI 远程面板，回环 + token 鉴权）
  startBridge(manager)

  // M1-12 系统集成：托盘 / 关窗最小化 / 剪贴板监听（按设置启停）
  setSpeedProvider(() => manager.getAggregateSpeeds())
  setBulkControlHandlers(
    () => adapter.pauseAll(),
    () => adapter.resumeAll()
  )
  app.whenReady().then(() => {
    const win = getMainWindow()
    if (win) {
      createTray()
      interceptCloseToTray(win)
      if (clipboardWatchEnabled()) startClipboardWatcher(() => {})
    }
  })

  app.on('window-all-closed', () => {
    // 关窗已最小化到托盘（interceptCloseToTray），此处仅托盘退出时触发
  })

  // P2 修复：before-quit 必须等待 supervisor.shutdown() 完成——原 void 直调时
  // Electron 可能在 taskkill 兜底执行前就退出，aria2c 孤儿进程占端口/继续上传。
  // preventDefault + 显式 app.exit(0) 保证清理链跑完再退。
  let quitCleanupStarted = false
  app.on('before-quit', (e) => {
    // L5 修复：标志在异步清理完成后才落位——二次触发 quit（before-quit 再入）
    // 期间若已置 done 会跳过 preventDefault，supervisor.shutdown() 未完成即退出
    if (quitCleanupStarted) {
      e.preventDefault() // 清理链在跑：拦住，由 app.exit(0) 收尾
      return
    }
    quitCleanupStarted = true
    e.preventDefault()
    markQuitting()
    // P2 修复：同步清理段包 try/catch——任一抛错会让本函数中断，
    // 而 quitCleanupStarted 已置位，后续 before-quit 恒走 preventDefault，
    // supervisor.shutdown().finally(app.exit) 链不会启动 → 应用永久无法退出
    try {
      manager.stopPolling()
      stopStatsScheduler()
      getYtDlpSupervisor().killAll()
      // 音乐任务 abort 全部网络请求，避免遗留 .part 文件
      getMusicEngine().shutdown()
      stopAppUpdaterTimer()
      stopBridge()
      // R7 P0-1：撤销 NAT 端口映射（fire-and-forget；未及撤销由 TTL 过期兜底）
      clearNatMapping()
    } catch (err) {
      log.error('before-quit 同步清理失败（继续退出）', { error: String(err) })
    }
    void supervisor
      .shutdown()
      .catch(() => {})
      .finally(() => {
        try {
          closeDb()
        } catch {
          // ignore
        }
        app.exit(0)
      })
  })

  app.on('activate', () => {
    // 仅迷你悬浮窗存活时也要重建主窗
    if (!getMainWindow()) createWindow()
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

  // 外链一律走系统浏览器（§9）；仅放行 web/mailto 协议（file:// 等本地协议不外抛）
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?|mailto):/i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  // M-2：拦截窗口内导航——渲染层被注入后不得把主窗口导航到任意外部页面
  //（webSecurity 仍开启，但 preload 白名单 API 会暴露给新页面的上下文）
  win.webContents.on('will-navigate', (e, url) => {
    if (url === win.webContents.getURL()) return
    e.preventDefault()
    if (/^https?:/i.test(url)) void shell.openExternal(url)
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}
