// IPC handler 注册表（T0-3 + M1 接入真实编排，§6.1 白名单）

import { app, ipcMain, BrowserWindow, shell } from 'electron'
import {
  IPC_CHANNELS,
  type ControlTaskInput,
  type CreateTaskInput,
  type ConfirmSelectionInput,
  type MusicDownloadInput,
  type MusicSearchInput,
  type ToolCreateInput
} from '@shared/types'
import { getDb, getSetting, setSetting } from './db'
import { createLogger } from './logger'
import type { TaskManager } from './task/manager'
import type { MusicAdapter } from './adapters/music'
import { parseTorrentFile } from './torrent/parse'

const log = createLogger('ipc')

let taskManager: TaskManager | null = null
let musicAdapter: MusicAdapter | null = null

export function setTaskManager(m: TaskManager): void {
  taskManager = m
}

export function setMusicAdapter(a: MusicAdapter): void {
  musicAdapter = a
}

/** 主进程 → 渲染层事件广播（Electron-as-Node 单测下无窗口，安全跳过） */
function windows(): Electron.BrowserWindow[] {
  try {
    return BrowserWindow?.getAllWindows?.() ?? []
  } catch {
    return []
  }
}

export function broadcastTasks(payload: unknown): void {
  for (const win of windows()) win.webContents.send(IPC_CHANNELS.eventTasks, payload)
}

export function broadcastEngineHealth(payload: unknown): void {
  for (const win of windows()) win.webContents.send(IPC_CHANNELS.eventEngines, payload)
}

/** M2-4 降级黄条等通知广播（§4.4：降级必须告警，不静默） */
export function broadcastNotices(payload: unknown): void {
  for (const win of windows()) win.webContents.send(IPC_CHANNELS.eventNotices, payload)
}

/** M4-13 工具箱事件广播 */
export function broadcastToolEvents(payload: unknown): void {
  for (const win of windows()) win.webContents.send('event:tools', payload)
}

export function registerIpcHandlers(): void {
  // 自绘窗口控件（frameless 圆角窗口）
  ipcMain.on('win:minimize', (e) => BrowserWindow.fromWebContents(e.sender)?.minimize())
  ipcMain.on('win:maximize', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  ipcMain.on('win:close', (e) => BrowserWindow.fromWebContents(e.sender)?.close())

  // task
  ipcMain.handle(IPC_CHANNELS.taskCreate, async (_e, input: CreateTaskInput) => {
    if (!taskManager) throw new Error('任务系统尚未就绪，请稍候')
    return taskManager.createTask(input)
  })

  ipcMain.handle(IPC_CHANNELS.taskParseFile, async (_e, path: string) => {
    // 本地 .torrent 解析：零引擎依赖即时出文件树（§4.2）
    const info = parseTorrentFile(path)
    return {
      kind: 'torrent',
      name: info.name,
      totalBytes: info.files.reduce((s, f) => s + f.size, 0),
      files: info.files,
      infohash: info.infohash,
      magnet: info.magnet
    }
  })

  ipcMain.handle(IPC_CHANNELS.taskConfirmSelection, async (_e, input: ConfirmSelectionInput) => {
    if (!taskManager) throw new Error('任务系统尚未就绪，请稍候')
    await taskManager.confirmSelection(input)
  })

  ipcMain.handle(IPC_CHANNELS.taskControl, async (_e, input: ControlTaskInput) => {
    try {
      if (!taskManager) throw new Error('任务系统尚未就绪，请稍候')
      await taskManager.control(input)
    } catch (err) {
      // 操作失败必须给用户可见反馈（不允许静默无响应）
      broadcastNotices([
        { level: 'warning', message: err instanceof Error ? err.message : String(err) }
      ])
    }
  })

  ipcMain.handle(IPC_CHANNELS.taskRetry, async (_e, taskId: string) => {
    // F5：单任务失败重试（failed → queued → re-add），不影响其他任务
    try {
      if (!taskManager) throw new Error('任务系统尚未就绪，请稍候')
      await taskManager.retryTask(taskId)
    } catch (err) {
      broadcastNotices([
        { level: 'warning', message: err instanceof Error ? err.message : String(err) }
      ])
    }
  })

  ipcMain.handle(IPC_CHANNELS.taskOpenFolder, async (_e, taskId: string) => {
    const { getTask } = await import('./task/store')
    const task = getTask(taskId)
    if (task) void shell.openPath(task.saveDir)
  })

  ipcMain.handle(IPC_CHANNELS.taskList, async (_e, filter: string) => {
    const { listTasks } = await import('./task/store')
    // filter: 'all' | 'downloading' | 'completed' | 'trash' | 类型分组
    switch (filter) {
      case 'downloading':
        return listTasks({ status: ['queued', 'running', 'paused', 'verifying', 'parsing'] })
      case 'completed':
        return listTasks({ status: ['completed', 'seeding'] })
      case 'trash':
        return listTasks({ includeDeleted: true })
      default:
        return listTasks({})
    }
  })

  // music（M2：代理 omni-service）
  ipcMain.handle(IPC_CHANNELS.musicSearch, async (_e, input: MusicSearchInput) => {
    if (!taskManager) throw new Error('任务系统尚未就绪，请稍候')
    return taskManager.musicSearch(input.q)
  })
  ipcMain.handle(IPC_CHANNELS.musicDownload, async (_e, input: MusicDownloadInput) => {
    if (!taskManager) throw new Error('任务系统尚未就绪，请稍候')
    return taskManager.createMusicTask(input)
  })

  // engine（M3-9：yt-dlp 热更器）
  ipcMain.handle(IPC_CHANNELS.engineUpdate, async (_e, engine: 'ytdlp' | 'service') => {
    if (engine !== 'ytdlp') throw new Error('仅支持 yt-dlp 引擎更新')
    const { updateYtDlp } = await import('./updater/ytdlp')
    return updateYtDlp()
  })

  // tool（M4-13：工具箱真实接入）
  ipcMain.handle(IPC_CHANNELS.toolCreate, async (_e, input: ToolCreateInput) => {
    if (!taskManager) throw new Error('任务系统尚未就绪，请稍候')
    return taskManager.createToolTask(input)
  })
  ipcMain.handle('tool:defs', () => {
    return import('./toolbox').then((m) =>
      m.TOOL_DEFS.map((d) => ({
        id: d.id,
        label: d.label,
        category: d.category,
        desc: d.desc,
        fields: d.fields
      }))
    )
  })

  // ── M4-3 回收站（失败统一广播通知，渲染层不静默）────────────────────
  ipcMain.handle('task:restore', async (_e, taskId: string) => {
    try {
      if (!taskManager) throw new Error('任务系统尚未就绪，请稍候')
      await taskManager.restoreFromTrash(taskId)
    } catch (err) {
      broadcastNotices([
        { level: 'warning', message: err instanceof Error ? err.message : String(err) }
      ])
    }
  })
  ipcMain.handle('task:purge', async (_e, taskId: string) => {
    try {
      if (!taskManager) throw new Error('任务系统尚未就绪，请稍候')
      // 防线：仅回收站内任务可彻底清除（防止误删运行中任务）
      const { isTrashed } = await import('./task/store')
      if (!isTrashed(taskId)) throw new Error('任务不在回收站，无法彻底删除')
      // 彻底清除 = 删除任务文件（精确删除）+ 移除记录
      await taskManager.control({ taskId, action: 'remove', withFiles: true })
    } catch (err) {
      broadcastNotices([
        { level: 'warning', message: err instanceof Error ? err.message : String(err) }
      ])
    }
  })
  ipcMain.handle('task:purgeRecord', async (_e, taskId: string) => {
    try {
      // 仅删除任务记录（保留已下载文件）——回收站「删除」动作
      const { purgeTask, isTrashed } = await import('./task/store')
      if (!isTrashed(taskId)) throw new Error('任务不在回收站，无法删除')
      purgeTask(taskId)
    } catch (err) {
      broadcastNotices([
        { level: 'warning', message: err instanceof Error ? err.message : String(err) }
      ])
    }
  })

  // M4-2 Inspector：任务详情 + 文件清单
  ipcMain.handle('task:detail', async (_e, taskId: string) => {
    const { getTask, getTaskFiles } = await import('./task/store')
    const task = getTask(taskId)
    if (!task) return null
    return { task, files: getTaskFiles(taskId) }
  })

  // ── M4-4 统计 ────────────────────────────────────────────────────────
  ipcMain.handle('stats:get', async () => {
    const { getDailyStats } = await import('./stats')
    // snake_case 行 → 前端驼峰 DailyStat（原先未映射导致页面 NaN/空）
    return getDailyStats(30).map((r) => ({
      day: r.day,
      completedCount: r.completed_count ?? 0,
      completedBytes: r.completed_bytes ?? 0,
      peakSpeedBps: r.peak_speed_bps ?? 0
    }))
  })

  // ── M4-15 调度 ───────────────────────────────────────────────────────
  ipcMain.handle('schedule:get', async () => {
    const { getScheduleRules } = await import('./scheduler')
    return getScheduleRules()
  })
  ipcMain.handle('schedule:set', async (_e, rules: unknown) => {
    const { setScheduleRules } = await import('./scheduler')
    setScheduleRules(rules as never)
  })

  // ── M4-16 Tracker 管理器 ────────────────────────────────────────────
  ipcMain.handle('trackers:list', async () => {
    const { listTrackers } = await import('./trackers')
    return listTrackers()
  })
  ipcMain.handle('trackers:add', async (_e, url: string) => {
    const { addTracker } = await import('./trackers')
    addTracker(url)
  })
  ipcMain.handle('trackers:remove', async (_e, url: string) => {
    const { removeTracker } = await import('./trackers')
    removeTracker(url)
  })
  ipcMain.handle('trackers:refresh', async () => {
    const { refreshTrackers } = await import('./trackers')
    return refreshTrackers()
  })

  // ── M4-7 应用自检更新 ────────────────────────────────────────────────
  ipcMain.handle('app:update', async () => {
    const { updateYtDlp } = await import('./updater/ytdlp')
    return updateYtDlp()
  })

  // settings
  ipcMain.handle(IPC_CHANNELS.settingsGet, (_e, key: string) => {
    const raw = getSetting(key)
    try {
      return raw === null ? null : (JSON.parse(raw) as unknown)
    } catch {
      return raw
    }
  })
  ipcMain.handle(IPC_CHANNELS.settingsSet, (_e, key: string, value: unknown) => {
    setSetting(key, JSON.stringify(value ?? null))
  })

  // 窗口底色随主题同步（圆角外壳外的一圈底色）
  ipcMain.on('ui:theme', (_e, theme: string) => {
    const light = theme === 'light'
    for (const win of BrowserWindow.getAllWindows()) {
      try {
        win.setBackgroundColor(light ? '#F7F8F9' : '#0B0C0E')
      } catch {
        // 忽略
      }
    }
  })

  // 应用环境：默认保存目录 = 用户配置（download.saveDir）→ 系统 Downloads
  ipcMain.handle('app:defaultSaveDir', () => {
    const configured = getSetting('download.saveDir')
    if (configured && configured.trim()) return configured
    return app.getPath('downloads')
  })

  // 系统文件夹选择对话框（取消返回 null）
  ipcMain.handle('app:pickFolder', async () => {
    const { dialog } = await import('electron')
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory']
    })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })

  // F1 试听：同步返回预览流 URL（服务端代理镜像音频，经 16801 符合 CSP）
  ipcMain.on('music:preview', (e, platform: string, id: string) => {
    e.returnValue = musicAdapter ? musicAdapter.previewUrl(platform, id) : ''
  })

  // DB 健康自检（T0-4 验收辅助）
  ipcMain.handle('db:ping', () => {
    const row = getDb().pragma('user_version', { simple: true }) as number
    return { userVersion: row }
  })

  log.info('ipc handlers registered')
}
