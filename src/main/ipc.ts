// IPC handler 注册表（T0-3 + M1 接入真实编排，§6.1 白名单）

import { app, ipcMain, BrowserWindow, nativeTheme, shell } from 'electron'
import { stat, writeFile, readFile } from 'fs/promises'
import { isAbsolute, basename } from 'path'
import {
  IPC_CHANNELS,
  type AppUpdateCheck,
  type BtExternalResult,
  type ControlTaskInput,
  type CreateTaskInput,
  type ConfirmSelectionInput,
  type MusicDownloadInput,
  type MusicSearchInput,
  type NetdiskDownloadInput,
  type NetdiskEntry,
  type SubscriptionAddInput,
  type SubscriptionUpdateInput,
  type ToolCreateInput
} from '@shared/types'
import { getDb, getSetting, getSettingParsed, setSetting } from './db'
import { validateSaveDir } from './save-dir'
import { SYSTEM_DIRS, credentialDirs, hitsAny, normPath, realishPath } from './sensitive-paths'
import { createLogger } from './logger'
import type { TaskManager } from './task/manager'
import type { MusicAdapter } from './music/adapter'
import {
  addSubscription,
  checkSubscriptionNow,
  listSubscriptions,
  removeSubscription,
  updateSubscription,
  type SubscriptionHost
} from './subscribe'

const log = createLogger('ipc')

let taskManager: TaskManager | null = null
let musicAdapter: MusicAdapter | null = null

// 第六轮审查：发布仓库 slug 改为构建期常量——原实现运行时 require('../../package.json')
// 违反 AGENT.md「主进程禁用运行时相对 require」约定（Rollup 不重写，打包态依赖
// 产物层级侥幸成立，层级变化即静默失效返回 null 且无报错痕迹）。仓库 slug 属
// 静态发布配置，硬编码与 package.json repository 字段保持一致，改仓库时同步改此常量
const RELEASE_REPO_SLUG = 'smart-open/OmniGet'

/** 发布仓库 slug（owner/name） */
function resolveRepoSlug(): string | null {
  return RELEASE_REPO_SLUG
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
  for (const win of windows()) {
    if (win.isDestroyed()) continue // quit 竞态：迭代中窗口可能已销毁
    win.webContents.send(IPC_CHANNELS.eventTasks, payload)
  }
}

export function broadcastEngineHealth(payload: unknown): void {
  for (const win of windows()) {
    if (win.isDestroyed()) continue
    win.webContents.send(IPC_CHANNELS.eventEngines, payload)
  }
}

/** M2-4 降级黄条等通知广播（§4.4：降级必须告警，不静默） */
export function broadcastNotices(payload: unknown): void {
  for (const win of windows()) {
    if (win.isDestroyed()) continue
    win.webContents.send(IPC_CHANNELS.eventNotices, payload)
  }
}

/** M4-13 工具箱事件广播 */
export function broadcastToolEvents(payload: unknown): void {
  for (const win of windows()) {
    if (win.isDestroyed()) continue
    win.webContents.send('event:tools', payload)
  }
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

  ipcMain.handle(IPC_CHANNELS.taskConfirmSelection, async (_e, input: ConfirmSelectionInput) => {
    if (!taskManager) throw new Error('任务系统尚未就绪，请稍候')
    await taskManager.confirmSelection(input)
  })

  ipcMain.handle(IPC_CHANNELS.taskControl, async (_e, input: ControlTaskInput) => {
    try {
      if (!taskManager) throw new Error('任务系统尚未就绪，请稍候')
      await taskManager.control(input)
    } catch (err) {
      // 失败必须让 invoke reject：渲染层各调用点已有 catch/toastError（假成功比无反馈更糟）
      throw err instanceof Error ? err : new Error(String(err))
    }
  })

  ipcMain.handle(IPC_CHANNELS.taskRetry, async (_e, taskId: string) => {
    // F5：单任务失败重试（failed → queued → re-add），不影响其他任务
    try {
      if (!taskManager) throw new Error('任务系统尚未就绪，请稍候')
      await taskManager.retryTask(taskId)
    } catch (err) {
      throw err instanceof Error ? err : new Error(String(err))
    }
  })

  ipcMain.handle(IPC_CHANNELS.taskOpenFolder, async (_e, taskId: string) => {
    const { getTask } = await import('./task/store')
    const task = getTask(taskId)
    if (!task) return
    try {
      // openPath 失败返回错误字符串（成功返回空串）：目录不存在等必须给用户可见反馈
      const error = await shell.openPath(task.saveDir)
      if (error) {
        broadcastNotices([{ level: 'warning', message: `打开目录失败：${error}` }])
      }
    } catch (err) {
      // 兜底：openPath 自身异常也不产生 unhandled rejection（渲染层多为 void 调用）
      broadcastNotices([
        {
          level: 'warning',
          message: `打开目录失败：${err instanceof Error ? err.message : String(err)}`
        }
      ])
    }
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
      // R6：「下载失败」侧栏视图（失败任务列表 + 角标）
      case 'failed':
        return listTasks({ status: ['failed'] })
      case 'trash':
        return listTasks({ onlyDeleted: true })
      default:
        return listTasks({})
    }
  })

  // music（M2：内嵌音乐引擎）
  ipcMain.handle(IPC_CHANNELS.musicSearch, async (_e, input: MusicSearchInput) => {
    if (!taskManager) throw new Error('任务系统尚未就绪，请稍候')
    // R4-P2：IPC 是运行时边界——入参零校验时 null 会裸抛英文 TypeError 到渲染层
    const q = typeof input?.q === 'string' ? input.q.trim() : ''
    if (!q) throw new Error('请输入歌曲名或「歌手 - 歌名」后再搜索')
    if (q.length > 200) throw new Error('搜索词过长（上限 200 字符），请缩短后重试')
    return taskManager.musicSearch(q)
  })
  ipcMain.handle(IPC_CHANNELS.musicDownload, async (_e, input: MusicDownloadInput) => {
    if (!taskManager) throw new Error('任务系统尚未就绪，请稍候')
    return taskManager.createMusicTask(input)
  })

  // 二期（0.9.x 歌单/专辑批量）：URL 解析（网易云公开 API，合规红线：不自研签名）
  ipcMain.handle(IPC_CHANNELS.musicPlaylist, async (_e, url: string) => {
    const u = typeof url === 'string' ? url.trim() : ''
    if (!u) throw new Error('请粘贴网易云歌单/专辑页链接')
    if (u.length > 500) throw new Error('链接过长，请粘贴完整的歌单/专辑页 URL')
    const { fetchMusicPlaylist, parseMusicPlaylistUrl } = await import('./music/playlist')
    const parsed = parseMusicPlaylistUrl(u)
    if (!parsed) throw new Error('暂仅支持网易云歌单/专辑页链接（music.163.com/playlist 或 /album）')
    return fetchMusicPlaylist(parsed.kind, parsed.id)
  })
  // 二期（0.9.x 音乐库）：已完成曲目登记视图
  ipcMain.handle(IPC_CHANNELS.musicLibrary, async () => {
    const { listTracks } = await import('./music/library')
    // 审查修复：exists 改异步 stat——existsSync 逐行同步跑在主线程，断连网络盘
    // 单次可达数秒（整应用冻结，含托盘/悬浮窗）
    return Promise.all(
      listTracks().map(async (r) => ({
        id: r.id,
        taskId: r.task_id,
        path: r.path,
        lrcPath: r.lrc_path,
        title: r.title,
        artist: r.artist,
        album: r.album,
        quality: r.quality,
        source: r.source,
        size: r.size,
        exists: await stat(r.path).then((s) => s.isFile()).catch(() => false),
        createdAt: r.created_at
      }))
    )
  })
  ipcMain.handle(IPC_CHANNELS.musicLibraryRemove, async (_e, trackId: string) => {
    const { removeTrack } = await import('./music/library')
    const id = typeof trackId === 'string' ? trackId.trim() : ''
    if (!id) throw new Error('缺少曲目 ID')
    const removed = removeTrack(id)
    if (!removed) throw new Error('曲目不存在或已被移除')
  })
  ipcMain.handle(IPC_CHANNELS.musicLibraryRetag, async (_e, trackId: string) => {
    const { retagTrack } = await import('./music/library')
    const id = typeof trackId === 'string' ? trackId.trim() : ''
    if (!id) throw new Error('缺少曲目 ID')
    return retagTrack(id)
  })

  // 三期（0.10.x）：视频媒体库（视频任务完成即登记，封面墙浏览）
  ipcMain.handle(IPC_CHANNELS.videoLibrary, async () => {
    const { listVideos } = await import('./video/library')
    // exists 异步 stat（同 musicLibrary 审查口径）
    return Promise.all(
      listVideos().map(async (r) => ({
        id: r.id,
        taskId: r.task_id,
        path: r.path,
        title: r.title,
        platform: r.platform,
        size: r.size,
        durationSec: r.duration_sec,
        coverPath: r.cover_path,
        exists: await stat(r.path).then((s) => s.isFile()).catch(() => false),
        createdAt: r.created_at
      }))
    )
  })
  ipcMain.handle(IPC_CHANNELS.videoLibraryRemove, async (_e, videoId: string) => {
    const { removeVideo } = await import('./video/library')
    const id = typeof videoId === 'string' ? videoId.trim() : ''
    if (!id) throw new Error('缺少条目 ID')
    const removed = removeVideo(id)
    if (!removed) throw new Error('条目不存在或已被移除')
  })
  // 四期（0.11.x）：NFO/海报手动导出（视频库行操作，Jellyfin/Emby 归档口径）
  ipcMain.handle(IPC_CHANNELS.videoExportNfo, async (_e, videoId: string) => {
    const { exportNfoForVideo } = await import('./video/nfo')
    const id = typeof videoId === 'string' ? videoId.trim() : ''
    if (!id) throw new Error('缺少条目 ID')
    return exportNfoForVideo(id)
  })
  // 四期（0.11.x）：OpenSubtitles API Key（safeStorage 凭据通道，同 #26 口径——
  // 专用 IPC 写入；读取黑名单不回显，写白名单不含）
  ipcMain.handle(IPC_CHANNELS.opensubtitlesSaveKey, async (_e, apiKey: string) => {
    const key = typeof apiKey === 'string' ? apiKey.trim() : ''
    if (!key) throw new Error('API Key 不能为空')
    if (key.length > 128) throw new Error('API Key 过长（上限 128 字符）')
    const { saveOpensubtitlesKey } = await import('./opensubtitles/credentials')
    saveOpensubtitlesKey(key)
  })
  ipcMain.handle(IPC_CHANNELS.opensubtitlesStatus, async () => {
    const { keyStorageInfo } = await import('./opensubtitles/credentials')
    return keyStorageInfo()
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
  // 工具产物定位：在系统文件管理器中高亮产物文件（「打开结果所在目录」）
  ipcMain.handle(IPC_CHANNELS.toolReveal, async (_e, output: string) => {
    const p = typeof output === 'string' ? output.trim() : ''
    if (!p || !isAbsolute(p)) {
      broadcastNotices([{ level: 'warning', message: '打开目录失败：产物路径无效' }])
      return
    }
    // 第九轮审查（与 preview:// 同口径双闸）：①入口拒绝字面 `..`/`.` 段；
    // ②realpath 失败直接拒绝——此前「保持原路径继续」会把含 `..` 的原始串
    // 参与前缀比对（TOCTOU：竞态窗口内目标出现即定位任意位置），且目标不存在
    // 时 showItemInFolder 本就无意义
    if (p.split(/[\\/]+/).includes('..') || p.split(/[\\/]+/).includes('.')) {
      broadcastNotices([{ level: 'warning', message: '打开目录失败：产物路径无效' }])
      return
    }
    // L-5 加固：仅允许高亮任务保存目录内的产物——被攻破的渲染层不得借
    // showItemInFolder 定位任意系统文件（隐藏/系统位置）。大小写口径随文件系统
    // P2 修复：先 realpath 规范化再比对——否则 `D:\任务\..\..\机密\x.txt`
    // 仍以任务目录前缀开头，可绕过包含判定（与 taskParseFile 同口径）
    const { listTasks } = await import('./task/store')
    const { realpath } = await import('fs/promises')
    const norm = (x: string): string => x.replace(/\\/g, '/').replace(/\/+$/, '')
    const fold = (x: string): string => (process.platform === 'linux' ? norm(x) : norm(x).toLowerCase())
    let real: string
    try {
      real = await realpath(p)
    } catch {
      broadcastNotices([{ level: 'warning', message: '打开目录失败：产物不存在或已被移动' }])
      return
    }
    const target = fold(real)
    const inside = listTasks({}).some((t) => {
      if (!t.saveDir) return false
      const base = fold(t.saveDir)
      return target === base || target.startsWith(base + '/')
    })
    if (!inside) {
      broadcastNotices([{ level: 'warning', message: '打开目录失败：路径不在任务产物目录内' }])
      return
    }
    try {
      const info = await stat(p)
      if (!info.isFile()) throw new Error('产物不存在或已被移动')
      shell.showItemInFolder(p)
    } catch (err) {
      broadcastNotices([
        {
          level: 'warning',
          message: `打开目录失败：${err instanceof Error ? err.message : String(err)}`
        }
      ])
    }
  })
  ipcMain.handle('tool:defs', () => {
    return import('./toolbox').then((m) =>
      m.TOOL_DEFS.filter((d) => !d.hidden).map((d) => ({
        id: d.id,
        label: d.label,
        category: d.category,
        desc: d.desc,
        fields: d.fields,
        multi: d.multi,
        extraFile: d.extraFile
      }))
    )
  })
  // 回归审查：demucs TOFU 指纹重置的用户可执行出口——指纹键不进渲染层写白名单
  // （防被攻破的渲染层轮换二进制），合法升级经此专用通道显式重置（UI 侧有二次确认）
  ipcMain.handle(IPC_CHANNELS.toolDemucsReset, () => {
    getDb().prepare('DELETE FROM settings WHERE key = ?').run('toolbox.demucs.fingerprint')
  })

  // ── Backlog：平台适配健康面板 ────────────────────────────────────────
  ipcMain.handle(IPC_CHANNELS.healthGet, async () => {
    const { platformHealthSnapshot } = await import('./health')
    return platformHealthSnapshot()
  })

  // ── R7 续（backlog #11）：短视频解析服务连接测试 ─────────────────────
  ipcMain.handle(IPC_CHANNELS.sidecarProbe, async (_e, baseUrl: string) => {
    const { probeVideoSidecar } = await import('./sidecar/video-api')
    return probeVideoSidecar(String(baseUrl ?? ''))
  })

  // ── R7 续（backlog #18）：订阅追更 ──────────────────────────────────
  const subHost = (): SubscriptionHost => ({
    createTask: (input) => {
      if (!taskManager) throw new Error('任务系统尚未就绪，请稍候')
      return taskManager.createTask(input)
    },
    confirmSelection: (input) => {
      if (!taskManager) throw new Error('任务系统尚未就绪，请稍候')
      return taskManager.confirmSelection(input)
    }
  })
  ipcMain.handle(IPC_CHANNELS.subscribeList, () => listSubscriptions())
  ipcMain.handle(IPC_CHANNELS.subscribeAdd, (_e, input: SubscriptionAddInput) =>
    addSubscription(input)
  )
  ipcMain.handle(IPC_CHANNELS.subscribeUpdate, (_e, input: SubscriptionUpdateInput) =>
    updateSubscription(input)
  )
  ipcMain.handle(IPC_CHANNELS.subscribeRemove, (_e, id: string) => removeSubscription(String(id)))
  ipcMain.handle(IPC_CHANNELS.subscribeCheckNow, (_e, id: string) =>
    checkSubscriptionNow(String(id), subHost())
  )

  // ── backlog #26（2026-10-03）：网盘聚合（OpenList / WebDAV）──────────
  ipcMain.handle(IPC_CHANNELS.netdiskProbe, async () => {
    const { probeWebdav } = await import('./netdisk/webdav')
    return probeWebdav()
  })
  ipcMain.handle(IPC_CHANNELS.netdiskSaveCreds, async (_e, input: { username?: string; password?: string }) => {
    const username = typeof input?.username === 'string' ? input.username.trim() : ''
    const password = typeof input?.password === 'string' ? input.password : ''
    if (!username) throw new Error('用户名不能为空')
    // 长度上限：防渲染层异常输入把巨型串写进凭据存储（Basic 编码前合理量级）
    if (username.length > 128) throw new Error('用户名过长（上限 128 字符）')
    if (password.length > 512) throw new Error('密码过长（上限 512 字符）')
    const { saveWebdavCredentials } = await import('./netdisk/credentials')
    saveWebdavCredentials(username, password)
    // 保存后立即探测：失败时用户当场看到凭据问题（假成功比无反馈更糟）
    const { probeWebdav } = await import('./netdisk/webdav')
    return probeWebdav()
  })
  ipcMain.handle(IPC_CHANNELS.netdiskList, async (_e, path: string) => {
    const { listWebdav } = await import('./netdisk/webdav')
    return listWebdav(typeof path === 'string' ? path : '/')
  })
  ipcMain.handle(IPC_CHANNELS.netdiskDownload, async (_e, input: NetdiskDownloadInput) => {
    if (!taskManager) throw new Error('任务系统尚未就绪，请稍候')
    const { getWebdavEndpoint, webdavUrlFor } = await import('./netdisk/webdav')
    const base = getWebdavEndpoint()
    if (!base) throw new Error('未配置网盘/WebDAV 地址（设置 → 下载 → 网盘聚合）')
    // 第九轮审查：路径黑名单与 listWebdav 口径对齐（含 `.`/`..` 段、\0、反斜杠）——
    // 同一信任面不得两套宽窄不一的过滤
    const entries = (Array.isArray(input?.entries) ? input.entries : []).filter(
      (e): e is NetdiskEntry =>
        !!e &&
        !e.isDir &&
        typeof e.path === 'string' &&
        e.path.startsWith('/') &&
        !/(^|\/)\.\.?(\/|$)/.test(e.path) &&
        !e.path.includes('\0') &&
        !e.path.includes('\\')
    )
    if (entries.length === 0) throw new Error('请先勾选要下载的文件')
    if (entries.length > 50) throw new Error('单次最多提交 50 个文件，请分批下载')
    const saveDir = String(input?.saveDir ?? '').trim()
    if (!saveDir) throw new Error('请先设置保存目录')
    // 审查修复：目录合法性在循环前统一预校验——此前逐任务校验，第 N 个失败会
    // 留下「已创建 N-1 个任务但整体报错」的半批次且无任何提示
    {
      const { validateSaveDir } = await import('./save-dir')
      const dirErr = validateSaveDir(saveDir)
      if (dirErr) throw new Error(dirErr)
    }
    let created = 0
    const failed: Array<{ name: string; error: string }> = []
    // 审查修复（P2-1）：逐个创建 + 部分成功语义——此前单个失败整批 reject，
    // 已创建的任务无任何提示，用户按报错重试会产生整批重复任务
    for (const e of entries) {
      try {
        await taskManager.createNetdiskTask({
          url: webdavUrlFor(base, e.path),
          name: e.name,
          size: Number(e.size) || 0,
          saveDir,
          threads: Number(input?.threads) || 8
        })
        created++
      } catch (err) {
        failed.push({ name: e.name, error: err instanceof Error ? err.message : String(err) })
      }
    }
    log.info(`netdisk batch download: created=${created} failed=${failed.length}`)
    return { created, failed }
  })

  // ── R1+R5：本地桥接信息（端口/token，设置页展示）─────────────────────
  ipcMain.handle(IPC_CHANNELS.bridgeInfo, async () => {
    const { getBridgeInfo } = await import('./bridge')
    return getBridgeInfo()
  })

  // ── R6：引擎按需下载（状态查询 + 手动补齐）───────────────────────────
  ipcMain.handle(IPC_CHANNELS.enginesStatus, async () => {
    const m = await import('./updater/engine-fetch')
    return m.engineStatus()
  })
  ipcMain.handle(IPC_CHANNELS.enginesFetch, async () => {
    const m = await import('./updater/engine-fetch')
    return m.fetchMissingEngines()
  })

  // ── Backlog：平台适配脚本注册表（内置自维护 + userData 热更）─────────
  ipcMain.handle(IPC_CHANNELS.scriptsList, async () => {
    const { listAdapterScripts } = await import('./adapters/scripts')
    return listAdapterScripts()
  })
  ipcMain.handle(IPC_CHANNELS.scriptsReload, async () => {
    const { reloadAdapterScripts } = await import('./adapters/scripts')
    return reloadAdapterScripts()
  })
  ipcMain.handle(IPC_CHANNELS.scriptsToggle, async (_e, id: string, enabled: boolean) => {
    // 第七轮审查 P3：强制布尔——字符串 "false" 落库后 raw.enabled !== false 判真，
    // 用户显式禁用的脚本会静默保持启用
    if (typeof enabled !== 'boolean') throw new Error('参数 enabled 必须为布尔值')
    const { setAdapterScriptEnabled } = await import('./adapters/scripts')
    setAdapterScriptEnabled(id, enabled)
  })

  // ── M4-3 回收站（失败统一广播通知，渲染层不静默）────────────────────
  ipcMain.handle('task:restore', async (_e, taskId: string) => {
    try {
      if (!taskManager) throw new Error('任务系统尚未就绪，请稍候')
      await taskManager.restoreFromTrash(taskId)
    } catch (err) {
      throw err instanceof Error ? err : new Error(String(err))
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
      throw err instanceof Error ? err : new Error(String(err))
    }
  })
  ipcMain.handle('task:purgeRecord', async (_e, taskId: string) => {
    try {
      // 仅删除任务记录（保留已下载文件）——回收站「删除」动作
      const { purgeTask, isTrashed } = await import('./task/store')
      if (!isTrashed(taskId)) throw new Error('任务不在回收站，无法删除')
      purgeTask(taskId)
    } catch (err) {
      throw err instanceof Error ? err : new Error(String(err))
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
  // R4 清理：'app:update' 孤儿通道已删除——渲染层唯一更新入口是
  // appCheckUpdate（bridge.checkAppUpdate）；定时器走 app-updater 的
  // checkForUpdatesAndNotify（checkForAppUpdateNow 死代码已随第六轮审查删除）

  // settings
  // 读取黑名单：与写白名单对称——渲染层被攻破时不得借 settingsGet 拖走敏感值
  //（bridge.token 可驱动全部 Web API；凭据类路径由各自专用 IPC 按需返回）
  const RENDERER_READ_BLOCKED_SETTINGS = new Set<string>(
    // backlog #26：WebDAV 凭据密文/明文兜底键均不回显渲染层（凭据仅注入请求头）
    // 四期（0.11.x）：OpenSubtitles API Key 走 safeStorage 凭据通道，同口径不回显
    [
      'bridge.token',
      'netdisk.auth.enc',
      'netdisk.auth',
      'opensubtitles.key.enc',
      'opensubtitles.key'
    ]
  )
  // 第九轮清账（D8）：黑名单升为「精确键 + 命名模式」双层——凭据键历史上已两次
  // 事后补漏（netdisk/opensubtitles 均为泄露后加黑名单）；模式层让未来新增的
  // 凭据类键（*.token/secret/password/auth/credential 段、*.key(.enc)）默认拒绝，
  // 不再依赖人工记忆同步。已核对渲染层现有读取键无一命中模式（无误伤）
  const RENDERER_READ_BLOCKED_PATTERNS: RegExp[] = [
    /(^|\.)(token|secret|password|passwd|credential|auth)(\.|$)/i,
    /(^|\.)key(\.enc)?$/i
  ]
  const isBlockedSettingKey = (k: string): boolean =>
    RENDERER_READ_BLOCKED_SETTINGS.has(k) || RENDERER_READ_BLOCKED_PATTERNS.some((re) => re.test(k))
  ipcMain.handle(IPC_CHANNELS.settingsGet, (_e, key: string) => {
    const k = String(key ?? '')
    if (isBlockedSettingKey(k)) {
      throw new Error(`设置项 ${k} 由系统管理，不可读取`)
    }
    const raw = getSetting(key)
    try {
      return raw === null ? null : (JSON.parse(raw) as unknown)
    } catch {
      // L3 修复：解析失败回退返回原始串会让调用方拿到两种形态——统一返回 null
      //（渲染层各调用点已按 null 兜底处理默认值）
      return null
    }
  })
  // P2 加固：设置键白名单——渲染层被攻破时不得借此改写主进程仲裁的敏感配置
  //（bridge.token/schedule.rules 主进程独占；engines.mirror 只允许 https 分发源，
  //  否则可指向攻击者服务器构成引擎供应链投毒通道）
  const RENDERER_WRITABLE_SETTINGS = new Set<string>([
    'ui.theme',
    'ui.locale',
    'ui.keymap',
    'ui.pinnedTasks',
    'ui.clipboardWatch',
    // 跨平台加固：GPU 兼容模式开关（ready 前主进程读取追加 disable-gpu，重启生效）
    'ui.disableGpu',
    'onboarded',
    'download.saveDir',
    'download.maxConcurrent',
    'download.autoArchive',
    'download.videoPresets',
    'naming.template',
    // 二期音乐双键（用户反馈：music.template 保存报「不存在或由系统管理」——
    // 键随 0.9.0 引入但漏出白名单；music.lyrics 同型，工作台歌词模式此前静默失败）
    'music.template',
    'music.lyrics',
    'engines.mirror',
    // engines.mirrorHosts 主进程独占（渲染层无 UI，仅配置文件/主进程可写）——
    // 信任锚不得与被保护对象同置于渲染层可写面，否则 SHA256 校验失去独立锚点
    'engines.autoFetch',
    'ytdlp.cookieFile',
    // R7 续（backlog #19/#22）：下载行为开关
    'download.dedupe',
    'download.ytdlpAria2c',
    // 审查修复：BT 网络开关此前漏配白名单——设置页「保存」100% 被
    // 「不可修改」拒绝，BT 加速功能永久无法启用（两键均为主进程消费的布尔开关）
    'bt.upnp',
    'bt.forceEncryption',
    // R7 续（backlog #11）：自托管短视频解析服务地址（http 允许——常部署在局域网/本机）
    'sidecar.videoApiUrl',
    // backlog #26（2026-10-03）：网盘/WebDAV 端点（http 允许——OpenList 常部署在局域网/本机；
    // 凭据走专用 IPC，不在此白名单）
    'netdisk.endpoint',
    // 四期（0.11.x）：内容库入库钩子开关与语言偏好（OpenSubtitles API Key 走专用 IPC）
    'video.subtitleHook',
    'video.subtitleLanguages',
    'video.nfoExport'
  ])
  ipcMain.handle(IPC_CHANNELS.settingsSet, (_e, key: string, value: unknown) => {
    const k = String(key ?? '')
    if (!RENDERER_WRITABLE_SETTINGS.has(k)) {
      throw new Error(`设置项 ${k} 不存在或由系统管理，不可修改`)
    }
    if (k === 'engines.mirror') {
      const v = typeof value === 'string' ? value.trim() : ''
      if (v && !/^https:\/\//i.test(v)) {
        throw new Error('引擎分发源必须是 https:// 地址')
      }
    }
    if (k === 'sidecar.videoApiUrl') {
      // R7 续（backlog #11）：仅接受 http(s) 地址；http 放行——自托管解析服务
      // 常部署在本机/局域网（http://127.0.0.1:8000）
      const v = typeof value === 'string' ? value.trim() : ''
      if (v && !/^https?:\/\//i.test(v)) {
        throw new Error('解析服务地址必须以 http:// 或 https:// 开头')
      }
    }
    if (k === 'netdisk.endpoint') {
      // backlog #26：同 sidecar 信任边界——http 放行（OpenList/WebDAV 常在局域网/本机）
      const v = typeof value === 'string' ? value.trim() : ''
      if (v && !/^https?:\/\//i.test(v)) {
        throw new Error('网盘/WebDAV 地址必须以 http:// 或 https:// 开头')
      }
    }
    if (k === 'download.saveDir' && typeof value === 'string' && value.trim()) {
      // H1 修复：saveDir 与任务创建共用同一防线——此前零校验，被攻破的渲染层
      //（或 bridge token 持有者）可把落盘目录指到自启动目录实现持久化代码执行
      const err = validateSaveDir(value)
      if (err) throw new Error(err)
    }
    if (k === 'ytdlp.cookieFile') {
      // R4-P2：路径校验（与 save-dir/taskParseFile 威胁模型对齐）——UNC 会触发
      // SMB 出站认证（NTLM 凭据外泄面）；敏感目录中的文件不得被 yt-dlp 读取
      const v = typeof value === 'string' ? value.trim() : ''
      if (v) {
        if (!isAbsolute(v)) throw new Error('Cookie 文件必须是本机绝对路径，请通过「浏览」重新选择')
        if (/^\/\//.test(v.replace(/\\/g, '/'))) {
          throw new Error('不支持网络路径中的 Cookie 文件（存在凭据外泄风险）')
        }
        // 黑名单统一来自 ../sensitive-paths（跨平台审查收敛口径）；TEMP 为 Cookie 读取面局部追加。
        // 与 save-dir/preview 同口径做符号链接归一——macOS /tmp、/var 是 /private/* 的符号链接，
        // 字面比对可被绕过
        const norm = realishPath(v).replace(/\\/g, '/').toLowerCase()
        const blockedDirs = [
          ...SYSTEM_DIRS,
          ...credentialDirs(),
          process.env.SystemRoot ? normPath(process.env.SystemRoot) : '',
          process.env.TEMP ? normPath(process.env.TEMP) : ''
        ].filter(Boolean)
        if (hitsAny(norm, blockedDirs)) {
          throw new Error('不允许使用系统或敏感目录中的文件作为 Cookie 文件')
        }
      }
    }
    // 第六轮审查：白名单键此前无值大小上限——ui.pinnedTasks 等可被塞入任意大小
    // 字符串直落 SQLite（膨胀 DB / 拖慢每次设置读取）。256KB 足以覆盖键位映射/
    // 置顶列表等全部合法值（预设导入另有 1MB 通道）
    const encoded = JSON.stringify(value ?? null)
    if (encoded.length > 256 * 1024) {
      throw new Error('设置值过大（超过 256KB 上限）')
    }
    setSetting(k, encoded)
    // 审查修复：主题跨窗口热同步真正闭环——syncTheme 无渲染层调用方，ui:theme
    // 永不触发；设置页改主题走 settingsSet('ui.theme')，在此处广播到所有窗口
    //（含迷你悬浮窗）并同步窗口底色（frameless 圆角外壳外的一圈）
    if (k === 'ui.theme' && typeof value === 'string') {
      const light =
        value === 'light' ? true : value === 'dark' ? false : !nativeTheme.shouldUseDarkColors
      for (const win of BrowserWindow.getAllWindows()) {
        if (win.isDestroyed()) continue
        win.webContents.send('app:theme-changed', value)
        try {
          win.setBackgroundColor(light ? '#F7F8F9' : '#0B0C0E')
        } catch {
          // 窗口销毁竞态：忽略
        }
      }
    }
  })

  // 窗口底色随主题同步（圆角外壳外的一圈底色）
  ipcMain.on('ui:theme', (e, theme: string) => {
    const light = theme === 'light'
    for (const win of BrowserWindow.getAllWindows()) {
      try {
        win.setBackgroundColor(light ? '#F7F8F9' : '#0B0C0E')
      } catch {
        // 忽略
      }
    }
    // 审查修复：主题变更热同步到其他窗口——`app:theme-changed` 是窗口内 DOM 事件，
    // 迷你悬浮窗（独立 webContents）原收不到，改主题后悬浮窗要重开才换肤
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.webContents === e.sender || win.isDestroyed()) continue
      win.webContents.send('app:theme-changed', theme)
    }
  })

  // 应用环境：默认保存目录 = 用户配置（download.saveDir）→ 系统 Downloads
  ipcMain.handle('app:version', () => app.getVersion())
  ipcMain.handle('app:defaultSaveDir', () => {
    // P1 加固：设置值为 JSON 串，必须反序列化（否则路径带引号落盘损坏）
    const configured = getSettingParsed<string>('download.saveDir')
    if (typeof configured === 'string' && configured.trim()) return configured
    return app.getPath('downloads')
  })

  // 系统文件夹选择对话框（取消返回 null）。
  // 第七轮审查 P3：挂 parent（对齐 app:exportFile）——主窗隐藏到托盘时无属主
  // 对话框可能落到其他窗口后面，用户感知为「点了没反应」
  ipcMain.handle('app:pickFolder', async (e) => {
    const { dialog } = await import('electron')
    const parent = BrowserWindow.fromWebContents(e.sender)
    const result = await (parent
      ? dialog.showOpenDialog(parent, { properties: ['openDirectory', 'createDirectory'] })
      : dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] }))
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })

  // R4 续（backlog #4）：预设导出/导入——对话框 + 读写盘收口在主进程（渲染层无 Node 能力，§9）
  ipcMain.handle('app:exportFile', async (e, defaultName: string, content: string) => {
    const { dialog } = await import('electron')
    const safeName = String(defaultName ?? 'export.json').replace(/[<>:"|?*\r\n\t\\/]/g, '_')
    // 审查修复：挂 parent——主窗隐藏到托盘时无属主对话框可能落到其他窗口后面
    const parent = BrowserWindow.fromWebContents(e.sender)
    const result = await (parent
      ? dialog.showSaveDialog(parent, {
          defaultPath: safeName,
          filters: [{ name: 'JSON', extensions: ['json'] }]
        })
      : dialog.showSaveDialog({
          defaultPath: safeName,
          filters: [{ name: 'JSON', extensions: ['json'] }]
        }))
    if (result.canceled || !result.filePath) return null
    // 1MB 上限：预设文件是纯文本 JSON，超限即异常输入，拒绝落盘
    const body = String(content ?? '')
    if (body.length > 1024 * 1024) throw new Error('导出内容超过 1MB 上限')
    await writeFile(result.filePath, body, 'utf-8')
    log.info(`export file → ${result.filePath}`)
    return result.filePath
  })

  ipcMain.handle('app:importFile', async (e, ext = 'json') => {
    const { dialog } = await import('electron')
    const ex = String(ext ?? 'json').replace(/[^a-z0-9]/gi, '') || 'json'
    const parent = BrowserWindow.fromWebContents(e.sender)
    const result = await (parent
      ? dialog.showOpenDialog(parent, {
          properties: ['openFile'],
          filters: [{ name: ex.toUpperCase(), extensions: [ex] }]
        })
      : dialog.showOpenDialog({
          properties: ['openFile'],
          filters: [{ name: ex.toUpperCase(), extensions: [ex] }]
        }))
    if (result.canceled || result.filePaths.length === 0) return null
    const filePath = result.filePaths[0]
    if (!filePath) return null
    const stat1 = await stat(filePath)
    if (stat1.size > 1024 * 1024) throw new Error('文件超过 1MB 上限')
    const content = await readFile(filePath, 'utf-8')
    return { name: basename(filePath), content }
  })

  // F1 试听：返回预览流 URL（主进程经 omniget-preview:// 协议代理镜像音频）
  ipcMain.handle(IPC_CHANNELS.musicPreview, (_e, platform: string, id: string) => {
    return musicAdapter ? musicAdapter.previewUrl(platform, id) : ''
  })

  // BT 端口自检（#5）：探测 aria2 listen-port 本地 TCP 监听；外网可达性由用户防火墙决定。
  // 审查修复：listen-port 现为区间（'6881-6891'），Number() 直接解析得 NaN——改用 btPrimaryPorts
  ipcMain.handle(IPC_CHANNELS.diagBtPort, async () => {
    const { btPrimaryPorts } = await import('./aria2/options')
    const port = btPrimaryPorts().tcp
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
    // 审查修复：natMappingStatus 原为无调用方的死代码——接入自检结果供设置页展示
    const { natMappingStatus } = await import('./net/nat')
    return { listening, port, nat: natMappingStatus() }
  })

  // BT 外网可达性探测（#5 增强，opt-in）：经 check-host.net 免费节点对本机公网 IP:6881
  // 发起多节点 TCP 探测——只能验证「外部能否主动连入」，是 BT 连通性的黄金判据。
  let lastBtExternalAt = 0
  let btExternalInFlight = false
  ipcMain.handle(IPC_CHANNELS.diagBtExternal, async (): Promise<BtExternalResult> => {
    const fail = (error: string): BtExternalResult => ({ reachable: null, ok: 0, total: 0, error })
    // 第七轮审查 P3：节流 + 单飞——该通道会把本机公网 IP 外送第三方（ipify/
    // check-host）并对本机端口发起外部探测，被攻破渲染层反复触发等于持续泄露
    const now = Date.now()
    if (now - lastBtExternalAt < 30_000 || btExternalInFlight) {
      throw new Error('BT 连通性检测刚执行过，请 30 秒后再试')
    }
    lastBtExternalAt = now
    btExternalInFlight = true
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

      // 2. 发起多节点 TCP 探测（listen-port 为区间——经 btPrimaryPorts 取首端口）
      const { btPrimaryPorts } = await import('./aria2/options')
      const port = btPrimaryPorts().tcp
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
    } finally {
      btExternalInFlight = false
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

  // R4 清理：'db:ping'（T0-4 验收辅助）无渲染层调用方已删除——收敛 IPC 面

  // Backlog：适配脚本热更监听（加载内置清单 + userData 目录 watch）
  import('./adapters/scripts')
    .then((m) => m.startAdapterScriptWatcher())
    .catch((err) => log.warn('适配脚本热更模块加载失败', { error: String(err) }))

  log.info('ipc handlers registered')
}
