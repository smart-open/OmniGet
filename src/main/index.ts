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
import { Nm3u8Adapter } from './adapters/nm3u8'
import { getYtDlpSupervisor } from './orchestrator/ytdlp'
import { TaskManager } from './task/manager'
import { startSubscriptionTimer, stopSubscriptionTimer } from './subscribe'
import { getDb, closeDb } from './db'
import { registerIpcHandlers, setTaskManager, setMusicAdapter } from './ipc'
import { createLogger } from './logger'
import { adoptPortableUserData, runtimeBase } from './env'
import { startStatsScheduler, stopStatsScheduler } from './stats'
import { startScheduler, stopScheduler, invalidateSchedule } from './scheduler'
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

// ── 协议唤起入口（second-instance argv / macOS open-url 共用）──────────
// macOS 上协议 URL（含冷启动）经 open-url 事件投递，不走 second-instance argv；
// open-url 可能先于 app ready 触发——先入队，窗口就绪后在 bootstrap 内补派发
const pendingLaunchUrls: string[] = []

function handleLaunchUrl(url: string): void {
  if (!/^magnet:\?/i.test(url) && !/^https?:\/\//i.test(url)) return
  if (!app.isReady()) {
    pendingLaunchUrls.push(url)
    return
  }
  const win = getMainWindow()
  if (!win) {
    pendingLaunchUrls.push(url)
    return
  }
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
  if (sniff(url) && sharedDedupe.check(url)) {
    win.webContents.send('ui:action', { action: 'new-task', payload: url })
  }
}

// 特权 scheme 注册必须在 app ready 之前（omniget-preview: 试听流，F1）
registerPreviewScheme()

// ── 单实例锁（二次启动唤起已有实例）──────────────────────────────────
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  // ── 便携数据目录收拢（第九轮清账 D10）────────────────────────────────
  // Chromium 自身 profile（缓存/GPU cache/localStorage）一并重定向到应用数据
  // 目录——此前仅应用数据落 runtimeBase/data，Chromium 侧仍写系统 userData，
  // 便携承诺不完整。必须先于任何 getSettingParsed（DB 打开 → userDataDir）与
  // ready 调用；失败静默保留系统 userData 行为
  adoptPortableUserData()

  // ── GPU 硬件加速禁用开关（跨平台加固 P3）────────────────────────────
  // Linux（Wayland + NVIDIA）与部分老 GPU 上 Electron 硬件加速崩溃/白屏是常见报障源，
  // 提供 ui.disableGpu 设置项（设置 → 外观 → 兼容模式）+ OMNIGET_DISABLE_GPU=1 环境变量；
  // appendSwitch 必须先于 ready（模块加载同步执行，时序满足）。放在锁判定之后：
  // 竞争失败的实例不打开 DB/不做迁移写探测（此前置于锁前，输家实例会与主实例
  // 产生 DB 迁移/写库竞态）。设置读取失败（DB 未就绪等）保持默认开启 GPU。
  try {
    const disableGpu =
      process.env.OMNIGET_DISABLE_GPU === '1' ||
      getSettingParsed<boolean>('ui.disableGpu') === true
    if (disableGpu) {
      app.commandLine.appendSwitch('disable-gpu')
      log.info('GPU acceleration disabled (ui.disableGpu)')
    }
  } catch (err) {
    log.warn('ui.disableGpu 读取失败，保持默认硬件加速', { error: String(err) })
  }

  // GPU 进程崩溃兜底（跨平台加固 P3）：用户可见提示 + 给出兼容模式出口（一次性）。
  // 注册于模块加载期——ready 后 GPU 立即崩溃（白屏高发窗口）也可捕获
  let gpuCrashNotified = false
  app.on('child-process-gone', (_e, details) => {
    if (details.type !== 'GPU' || details.reason !== 'crashed' || gpuCrashNotified) return
    gpuCrashNotified = true
    log.error('GPU process crashed', details)
    void import('./ipc').then(({ broadcastNotices }) =>
      broadcastNotices([
        {
          level: 'warning',
          message:
            'GPU 进程异常退出，界面可能出现白屏/闪烁。可在 设置 → 外观 → 兼容模式 勾选「禁用 GPU 硬件加速」后重启应用'
        }
      ])
    )
  })

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

  // macOS：magnet: 协议唤起（second-instance argv 在 mac 上不携带协议 URL）
  app.on('open-url', (e, url) => {
    e.preventDefault()
    handleLaunchUrl(url)
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

/** 第十轮审查 P2：aria2 监督器引用（自动补齐完成后拉起用——bootstrap 内
 * 声明的 supervisor 对更早启动的异步补齐链不可见） */
const supervisorRef: { current: import('./orchestrator/aria2').Aria2Supervisor | null } = {
  current: null
}
const managerRef: { current: import('./task/manager').TaskManager | null } = { current: null }

let trackerRefreshTimer: ReturnType<typeof setInterval> | null = null

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
        // 第十轮审查 P2：aria2 补齐成功后自动拉起监督器——此前 supervisor.start()
        // 在补齐启动前已因 checkBinary 失败退场，重启链（exit/close 事件驱动）
        // 从此无触发点，核心下载引擎直到用户手动重启都不可用（任务永久卡排队）
        if (r.installed.includes('aria2c')) {
          void (async () => {
            for (let i = 0; i < 30 && !supervisorRef.current; i++) {
              await new Promise((res) => setTimeout(res, 500))
            }
            const sup = supervisorRef.current
            if (!sup) return
            try {
              await sup.start()
              log.info('aria2 supervisor started after engine auto-fetch')
            } catch (err) {
              log.warn('aria2 supervisor start after auto-fetch failed', { error: String(err) })
              managerRef.current?.broadcastHealth(false, 'aria2 引擎不可用')
            }
          })()
        }
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
  // ffprobe（可选工具，已在 TOFU 名单内但缺失不阻塞启动）：缺失仅 warning——
  // 完整性探测会静默降级（TOFU 闸门在各 spawn 点生效，首启此处只做在位提示）
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

  // macOS open-url 冷启动：URL 先于 ready 到达，窗口就绪后补派发
  for (const url of pendingLaunchUrls.splice(0)) handleLaunchUrl(url)

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
      // 审查修复（P1-2）：aria2 中途崩溃重启后旧 gid 全部失效，running/verifying
      // 任务每秒 tellStatus 报错被吞、永久卡死无出口——上线时先按 aria2 侧任务
      // 重置回 queued 再泵恢复（首启时无 running 行，幂等）
      void manager.recoverAria2Restart().then(() => manager.recoverEngineTasks())
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
  supervisorRef.current = supervisor
  managerRef.current = manager
  const ytdlpAdapter = new YtDlpAdapter()
  manager.setYtdlpEngine(ytdlpAdapter)
  // R7 续（backlog #17）：N_m3u8DL-RE 引擎（二进制缺失时任务回落 yt-dlp，注入无害）
  manager.setNm3u8Engine(new Nm3u8Adapter())

  setTaskManager(manager)
  // R7 续（backlog #18）：订阅追更定时器（10min tick，到期源串行检查）
  startSubscriptionTimer({
    createTask: (input) => manager.createTask(input),
    confirmSelection: (input) => manager.confirmSelection(input)
  })
  await manager.recoverOnStartup()
  manager.startPolling()

  // aria2 缺席（T0 阶段允许）时仅告警，不阻塞应用启动。
  // 第七轮审查 P2：aria2 起不来（二进制缺失/损坏）时恢复泵必须仍然恢复
  // ytdlp/nm3u8 的排队任务——它们不依赖 aria2，此前绑死 onOnline 会永久卡排队
  void supervisor.start().catch((err) => {
    log.error(`aria2 supervisor start failed: ${String(err)}`)
    manager.broadcastHealth(false, 'aria2 引擎不可用')
    void manager.recoverEngineTasks({ engines: ['ytdlp', 'nm3u8'] }).catch((e) =>
      log.warn('non-aria2 task recovery failed', e)
    )
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
  // R7 P0-4：每日定时刷新 tracker（原注释与实现不符——只有启动一次）+ 刷新后重注入。
  // 第十轮审查 P3：句柄模块级持有——退出清理段可停表（supervisor.shutdown 期间
  // 到期的定时器此前仍会跑，甚至 killAll 后重新拉起 yt-dlp）
  const TRACKER_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000
  trackerRefreshTimer = setInterval(() => {
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
  // 回归审查 P3：托盘批量操作补 catch——aria2 离线窗口点击「全部暂停/继续」
  // 此前会以 unhandledRejection 收场（「全部继续」恒可点后暴露面变大）
  setBulkControlHandlers(
    () => adapter.pauseAll().catch((err) => log.warn('tray pauseAll failed', err)),
    () => adapter.resumeAll().catch((err) => log.warn('tray resumeAll failed', err))
  )
  app
    .whenReady()
    .then(() => {
      const win = getMainWindow()
      if (win) {
        // 第七轮审查 P2：createTray 与关窗拦截解耦——Linux 无 AppIndicator 扩展
        // 的桌面环境 new Tray() 会 throw
        // 第十轮审查 P2：仅在托盘创建成功时拦截关窗——无托盘环境把关窗拦成
        // hide 会造出「无托盘无窗口无交互入口」的僵尸进程（注释此前声称
        // 「退化为直接关闭」但实现相反）；托盘缺失时关窗语义真正退化为直接关闭
        let trayOk = true
        try {
          createTray()
        } catch (err) {
          trayOk = false
          log.error('tray creation failed (关窗将直接退出，不最小化到托盘)', err)
        }
        if (trayOk) interceptCloseToTray(win)
        if (clipboardWatchEnabled()) startClipboardWatcher(() => {})
      }
    })
    .catch((err) => log.error('whenReady handler failed', err))

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
      // 第十轮审查 P3：补停三个周期任务——supervisor.shutdown() 最长约 12s，
      // 期间 10min 订阅 tick 到期会 createTask 落库甚至重新 spawn yt-dlp
      stopSubscriptionTimer()
      stopScheduler()
      if (trackerRefreshTimer) {
        clearInterval(trackerRefreshTimer)
        trackerRefreshTimer = null
      }
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

  // 第十轮审查 P2：渲染进程崩溃自动恢复——进程级 crash（OOM/native 崩溃）后
  // 主窗白屏死置，下载照常运行但用户没有任何 UI 可操作（RootBoundary 只兜
  // React 渲染期异常）。带次数上限的自动 reload + 通知告知
  let rendererReloads = 0
  win.webContents.on('render-process-gone', (_e, details) => {
    log.error(`renderer process gone: ${details.reason} (exitCode ${details.exitCode})`)
    if (rendererReloads >= 3 || details.reason === 'clean-exit') return
    rendererReloads++
    setTimeout(() => {
      if (win.isDestroyed()) return
      void win.webContents.reload()
      void import('./ipc')
        .then(({ broadcastNotices }) =>
          broadcastNotices([{ level: 'warning', message: '界面异常已自动恢复；如仍白屏请重启应用' }])
        )
        .catch(() => {})
    }, 1000)
  })

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
