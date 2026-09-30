// IPC handler 注册表（T0-3 + M1 接入真实编排，§6.1 白名单）

import { app, ipcMain, BrowserWindow, shell } from 'electron'
import {
  IPC_CHANNELS,
  type AppUpdateCheck,
  type BtExternalResult,
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
import type { MusicAdapter } from './music/adapter'
import { parseTorrentFile } from './torrent/parse'

const log = createLogger('ipc')

let taskManager: TaskManager | null = null
let musicAdapter: MusicAdapter | null = null

/** 发布仓库 slug（owner/name）：package.json repository 字段解析；未配置返回 null */
function resolveRepoSlug(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pkg = require('../../package.json') as {
      repository?: { url?: string } | string
    }
    const url = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url
    const m = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(\.git)?$/i.exec(url ?? '')
    return m ? `${m[1]}/${m[2]}` : null
  } catch {
    return null
  }
}

/** 语义化版本比较（x.y.z 逐段数值）：>0 表示 a 更新 */
function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => parseInt(x, 10) || 0)
  const pb = b.split(/[.-]/).map((x) => parseInt(x, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

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
    // 本地 .torrent 解析：零引擎依赖即时出文件树（§4.2）。
    // 收口：仅允许 .torrent 扩展 + 拒绝系统目录（防渲染层被攻破后的任意文件探测）
    const p = String(path ?? '').trim()
    if (!/\.torrent$/i.test(p)) throw new Error('仅支持解析 .torrent 文件')
    const sysDirs = [process.env.SystemRoot ?? 'C:\\Windows', process.env.WINDIR ?? 'C:\\Windows']
      .concat(['C:\\Windows', '/usr', '/etc', '/bin', '/sbin', '/boot'])
      .filter(Boolean)
      .map((d) => d.toLowerCase())
    const norm = p.replace(/\\/g, '/').toLowerCase()
    if (sysDirs.some((d) => norm.startsWith(d.replace(/\\/g, '/').toLowerCase() + '/'))) {
      throw new Error('不允许解析系统目录中的文件')
    }
    const info = parseTorrentFile(p)
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

  ipcMain.handle(IPC_CHANNELS.taskCounts, async () => {
    const { taskCounts } = await import('./task/store')
    return taskCounts()
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

  // music（M2：内嵌音乐引擎）
  ipcMain.handle(IPC_CHANNELS.musicSearch, async (_e, input: MusicSearchInput) => {
    if (!taskManager) throw new Error('任务系统尚未就绪，请稍候')
    return taskManager.musicSearch(input.q)
  })
  ipcMain.handle(IPC_CHANNELS.musicDownload, async (_e, input: MusicDownloadInput) => {
    if (!taskManager) throw new Error('任务系统尚未就绪，请稍候')
    return taskManager.createMusicTask(input)
  })

  // engine（M3-9：yt-dlp 热更器）
  ipcMain.handle(IPC_CHANNELS.engineUpdate, async (_e, engine: 'ytdlp') => {
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

  // F1 试听：返回预览流 URL（主进程经 omniget-preview:// 协议代理镜像音频）
  ipcMain.handle(IPC_CHANNELS.musicPreview, (_e, platform: string, id: string) => {
    return musicAdapter ? musicAdapter.previewUrl(platform, id) : ''
  })

  // BT 端口自检（#5）：探测 aria2 listen-port 本地 TCP 监听；外网可达性由用户防火墙决定
  ipcMain.handle(IPC_CHANNELS.diagBtPort, async () => {
    const { defaultGlobalOptions } = await import('./aria2/options')
    const port = Number(defaultGlobalOptions()['listen-port'] ?? '6881')
    const listening = await new Promise<boolean>((resolve) => {
      const { createConnection } = require('net') as typeof import('net')
      const sock = createConnection({ host: '127.0.0.1', port, timeout: 2000 })
      sock.once('connect', () => {
        sock.destroy()
        resolve(true)
      })
      const fail = (): void => {
        sock.destroy()
        resolve(false)
      }
      sock.once('timeout', fail)
      sock.once('error', fail)
    })
    return { listening, port }
  })

  // BT 外网可达性探测（#5 增强，opt-in）：经 check-host.net 免费节点对本机公网 IP:6881
  // 发起多节点 TCP 探测——只能验证「外部能否主动连入」，是 BT 连通性的黄金判据。
  ipcMain.handle(IPC_CHANNELS.diagBtExternal, async (): Promise<BtExternalResult> => {
    const fail = (error: string): BtExternalResult => ({ reachable: null, ok: 0, total: 0, error })
    try {
      const { fetch: f } = await import('undici')
      const jsonHeaders = { Accept: 'application/json' } as Record<string, string>

      // 1. 本机公网 IP：多源兜底（部分网络环境会阻断单一服务，实测 ipify 国内常被重置）
      let ip: string | undefined
      for (const src of [
        { url: 'https://api.ipify.org?format=json', parse: 'json' as const },
        { url: 'https://api64.ipify.org?format=json', parse: 'json' as const },
        { url: 'https://ifconfig.me/ip', parse: 'text' as const }
      ]) {
        try {
          const r = await f(src.url, { signal: AbortSignal.timeout(5000) })
          if (!r.ok) continue
          const v =
            src.parse === 'json'
              ? ((await r.json()) as { ip?: string }).ip
              : (await r.text()).trim()
          if (v && /^[\d.:a-fA-F]+$/.test(v)) {
            ip = v
            break
          }
        } catch {
          continue
        }
      }
      if (!ip) return fail('获取公网 IP 失败：探测相关服务在当前网络不可达')

      // 2. 发起多节点 TCP 探测
      const { defaultGlobalOptions } = await import('./aria2/options')
      const port = Number(defaultGlobalOptions()['listen-port'] ?? '6881')
      let startRes
      try {
        startRes = await f(
          `https://check-host.net/check-tcp?host=${encodeURIComponent(`${ip}:${port}`)}&max_nodes=3`,
          { headers: jsonHeaders, signal: AbortSignal.timeout(10_000) }
        )
      } catch {
        return fail(
          '探测服务（check-host.net）在当前网络不可达——功能可用性依赖该服务，可稍后重试'
        )
      }
      if (!startRes.ok) return fail('探测服务不可达（check-host.net）')
      const { request_id: requestId } = (await startRes.json()) as { request_id?: string }
      if (!requestId) return fail('探测任务创建失败')

      // 3. 轮询结果（节点通常 3~8s 返回，最多 15s）
      let ok = 0
      let done = 0
      let total = 0
      for (let i = 0; i < 8; i++) {
        await new Promise((r) => setTimeout(r, 2000))
        const res = await f(`https://check-host.net/check-result/${requestId}`, {
          headers: jsonHeaders,
          signal: AbortSignal.timeout(8000)
        })
        if (!res.ok) continue
        const nodes = (await res.json()) as Record<string, [unknown] | null>
        total = Object.keys(nodes).length
        done = 0
        ok = 0
        for (const v of Object.values(nodes)) {
          if (v === null) continue // 该节点尚未返回
          done++
          const first = (v as Array<Record<string, unknown>>)[0]
          // 成功节点：{ time: number }；失败：{ error: ... } 或 timeout
          if (first && typeof first.time === 'number') ok++
        }
        if (done >= total && total > 0) break
      }
      if (total === 0) return fail('探测节点无响应，请稍后重试')
      return { reachable: ok > 0, ok, total, ip }
    } catch (err) {
      log.warn('bt external probe failed:', String(err))
      return fail('探测失败：网络不可达或服务超时')
    }
  })

  // 应用更新检查（#4 Linux 手动通道 / 通用版本比对）：GitHub latest release
  ipcMain.handle(IPC_CHANNELS.appCheckUpdate, async (): Promise<AppUpdateCheck> => {
    const current = app.getVersion()
    try {
      const repo = resolveRepoSlug()
      if (!repo) {
        return { hasUpdate: false, current, error: '未配置发布仓库（package.json repository 字段）' }
      }
      const { fetch: f } = await import('undici')
      const res = await f(`https://api.github.com/repos/${repo}/releases/latest`, {
        headers: { Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(10_000)
      })
      if (res.status === 404) return { hasUpdate: false, current, error: '发布仓库尚无正式 release' }
      if (!res.ok) return { hasUpdate: false, current, error: `GitHub API HTTP ${res.status}` }
      const rel = (await res.json()) as { tag_name?: string; html_url?: string }
      const latest = rel.tag_name?.replace(/^v/i, '')
      if (!latest) return { hasUpdate: false, current, error: 'release 元数据异常' }
      return {
        hasUpdate: compareVersions(latest, current) > 0,
        current,
        latest,
        releaseUrl: rel.html_url ?? `https://github.com/${repo}/releases/latest`
      }
    } catch (err) {
      log.warn('app update check failed:', String(err))
      return { hasUpdate: false, current, error: '检查失败：网络不可达或 GitHub API 限流' }
    }
  })

  // 打开 Releases 下载页（Linux 手动更新出口；仅允许 https 的 GitHub 发布地址）
  ipcMain.handle(IPC_CHANNELS.appOpenReleases, async (): Promise<void> => {
    const repo = resolveRepoSlug()
    const url = repo
      ? `https://github.com/${repo}/releases/latest`
      : 'https://github.com/'
    if (/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/releases/.test(url)) {
      await shell.openExternal(url)
    }
  })

  // DB 健康自检（T0-4 验收辅助）
  ipcMain.handle('db:ping', () => {
    const row = getDb().pragma('user_version', { simple: true }) as number
    return { userVersion: row }
  })

  log.info('ipc handlers registered')
}
