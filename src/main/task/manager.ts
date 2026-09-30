// 任务管理器（M1-1/M1-11，§4.5）：编排、状态机驱动、持久化恢复、事件广播。

import { app } from 'electron'
import type {
  Task,
  TaskEvent,
  TaskStatus,
  ServiceEvent,
  UiNotice,
  EngineHealth,
  ConfirmSelectionInput
} from '@shared/types'
import type { CreateTaskResult } from '@shared/types'
import { makeError } from '@shared/errors'
import { broadcastEngineHealth, broadcastTasks, broadcastNotices } from '../ipc'
import { createLogger } from '../logger'
import { normalizeInfohash } from '../torrent/parse'
import { sniff } from '../sniffer'
import type { Aria2Adapter } from '../adapters/aria2'
import type { MusicAdapter } from '../adapters/music'
import type { YtDlpAdapter } from '../adapters/ytdlp'
import type { ParseOutput } from '../adapters/types'
import { notifyTaskEvent } from '../integrations/tray'
import { toolbox } from '../toolbox'
import { samplePeakSpeed, recordCompletion } from '../stats'
import { assertTransition, IllegalTransitionError } from './state-machine'
import { uuidv7 } from './id'
import { TaskEventMerger } from './events'
import {
  findTaskByInfohash,
  getTask,
  getTaskFiles,
  insertTask,
  listTasks,
  purgeTask,
  restoreTask,
  saveTaskFiles,
  setTaskFileSelection,
  softDeleteTask,
  updateTaskFields
} from './store'

const log = createLogger('task-manager')

interface TaskExt extends Task {
  infohash?: string
  /** 磁力 parse 期间持有的暂停态 aria2 gid */
  pendingGid?: string
}

export type { CreateTaskResult } from '@shared/types'

const MAX_MUSIC_CONCURRENT = 4 // §4.5 音乐并发上限

export class TaskManager {
  private aria2: Aria2Adapter
  private music: MusicAdapter | null = null
  private ytdlp: YtDlpAdapter | null = null
  private merger: TaskEventMerger
  private pollTimer: NodeJS.Timeout | null = null
  private currentEvents = new Map<string, TaskEvent>()
  /** M2-6 信号量：进行中的音乐下载数 */
  private activeMusic = 0
  /** 正在 POST 中的音乐任务（防 pump 重入） */
  private musicPosting = new Set<string>()

  constructor(aria2Adapter: Aria2Adapter) {
    this.aria2 = aria2Adapter
    this.merger = new TaskEventMerger(250, (events) => this.applyEngineEvents(events))
  }

  /** M2-6：注入音乐引擎（omni-service 上线后） */
  setMusicEngine(adapter: MusicAdapter): void {
    this.music = adapter
  }

  /** M3：注入 yt-dlp 引擎；事件经 sink 汇入 250ms 合并流 */
  setYtdlpEngine(adapter: YtDlpAdapter): void {
    this.ytdlp = adapter
    adapter.setSink((e) => this.merger.push(e))
  }

  /**
   * omni-service 上线回调（B1）：
   * 清理 queued 音乐任务的失效 gid（旧 service 任务已随崩溃消失）→ 重泵信号量
   */
  onMusicEngineOnline(): void {
    this.broadcastHealthMusic(true)
    for (const t of listTasks({ status: ['queued'] })) {
      if (t.engine === 'music' && t.engineGid) {
        updateTaskFields(t.id, { engineGid: null })
      }
    }
    this.pumpMusic()
  }

  /** B1：下线时重置信号量（在途 POST 的 done 永远不会来），queued 任务等上线重泵 */
  onMusicEngineOffline(detail?: string): void {
    this.activeMusic = 0
    this.broadcastHealthMusic(false, detail)
  }

  // ── 生命周期 ────────────────────────────────────────────────────────

  startPolling(): void {
    if (this.pollTimer) return
    this.pollTimer = setInterval(() => {
      void this.pollOnce()
    }, 1000)
  }

  stopPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pollTimer = null
    this.merger.dispose()
  }

  private async pollOnce(): Promise<void> {
    try {
      const active = listTasks({ status: ['queued', 'running', 'paused', 'verifying'] })
      const events = await this.aria2.pollEvents(active)
      for (const e of events) this.merger.push(e)
      // M4-4 峰值速度采样
      const total = events.reduce((s, e) => s + (e.speedBps ?? 0), 0)
      if (total > 0) samplePeakSpeed(total)
    } catch (err) {
      log.debug('poll failed', err)
    }
  }

  /** 引擎事件 → 状态机转移 + 广播（§6.1 event:tasks 4Hz） */
  private applyEngineEvents(events: TaskEvent[]): void {
    const out: TaskEvent[] = []
    for (const e of events) {
      const task = getTask(e.taskId) as TaskExt | null
      if (!task) continue
      if (e.status && e.status !== task.status) {
        try {
          this.transition(task, e.status)
        } catch (err) {
          if (err instanceof IllegalTransitionError) {
            log.debug(`skip illegal engine transition ${err.from} -> ${err.to} for ${task.id}`)
            continue
          }
          throw err
        }
      }
      updateTaskFields(e.taskId, {
        downloaded: e.downloadedBytes,
        totalBytes: e.totalBytes,
        // M3-6：wm_level 回填（direct|fallback|post）
        ...(e.wmLevel ? { wmLevel: e.wmLevel } : {})
      })
      this.currentEvents.set(e.taskId, e)
      notifyTaskEvent(e, task.name)
      out.push({ ...e, status: e.status ?? task.status })
    }
    if (out.length) broadcastTasks(out)
  }

  // ── 新建任务（§7.5 流程状态机）─────────────────────────────────────

  async createTask(input: {
    source: string
    threads: number
    saveDir: string
    noWatermark?: boolean
    seedRatio?: number
  }): Promise<CreateTaskResult> {
    const s = sniff(input.source)
    if (!s) return { kind: 'failed', error: makeError('PARSE_FAILED').message }

    // 入参校验（防止空目录/越界线程落库后在引擎侧报晦涩错误）
    const saveDir = input.saveDir?.trim() ?? ''
    if (!saveDir) {
      return { kind: 'failed', error: '请先设置保存目录（设置 → 下载，或对话框内选择）' }
    }
    const threads = Math.round(Math.min(64, Math.max(1, input.threads || 8)))

    // 磁力查重：infohash 已存在 → 秒开文件树（§4.2 Step4）；回收站任务已被排除（B7）
    if (s.type === 'magnet') {
      const ih = /xt=urn:btih:([a-zA-Z0-9]+)/.exec(s.source)?.[1]
      if (ih) {
        const existing = findTaskByInfohash(ih)
        if (existing) {
          const files = getTaskFiles(existing.id)
          if (files.length > 0) {
            log.info(`infohash ${ih} dedup: reuse file tree of ${existing.id}`)
            const parsed: ParseOutput = {
              name: existing.name,
              files,
              totalBytes: existing.totalBytes,
              infohash: normalizeInfohash(ih)
            }
            return { kind: 'awaiting', taskId: existing.id, parsed, sniff: s }
          }
        }
      }
    }

    const task: TaskExt = {
      id: uuidv7(),
      type: s.type,
      source: s.source,
      name: '',
      engine:
        s.type === 'music'
          ? 'music'
          : s.type === 'video'
            ? 'ytdlp'
            : s.type === 'tool'
              ? 'tool'
              : 'aria2',
      status: 'parsing',
      saveDir,
      totalBytes: 0,
      downloadedBytes: 0,
      speedBps: 0,
      threads,
      noWatermark: s.noWatermark ?? input.noWatermark,
      seedRatio: input.seedRatio,
      createdAt: Date.now()
    }
    insertTask(task)
    this.pushEvent({ taskId: task.id, status: 'parsing' })

    try {
      // M3：按引擎分派解析（video → yt-dlp；其余 → aria2）
      const parsed =
        task.engine === 'ytdlp'
          ? await this.ytdlp!.parse(task)
          : await this.aria2.parse(task)
      // M3-6：短视频任务标记（L1/L2/L3 判定）
      if (task.engine === 'ytdlp' && s.platform && ['douyin', 'kuaishou', 'xiaohongshu', 'xigua', 'weibo'].includes(s.platform)) {
        this.ytdlp?.markShortVideo(task.id)
      }
      task.name = parsed.name
      task.infohash = parsed.infohash
      task.pendingGid = parsed.pendingGid
      updateTaskFields(task.id, {
        name: parsed.name,
        infohash: parsed.infohash ?? null,
        totalBytes: parsed.totalBytes,
        engineGid: parsed.pendingGid ?? null
      })
      if (parsed.files?.length) {
        saveTaskFiles(
          task.id,
          parsed.files.map((f) => ({
            path: f.path,
            size: f.size,
            selected: f.selected ?? true,
            downloaded: f.downloaded ?? 0
          }))
        )
      }
      // M3-4：合集标记持久化（重启恢复后 --playlist-items 回放需要）
      if (parsed.playlist) {
        updateTaskFields(task.id, { params: JSON.stringify({ playlist: true }) })
      }

      // awaiting 可跳过：HTTP 单文件 parsing → queued（§4.1 注记）
      const skipAwaiting = s.type === 'http'
      this.transition(task, skipAwaiting ? 'queued' : 'awaiting')
      if (skipAwaiting) {
        const gid = await this.aria2.start({ ...task, status: 'queued' })
        updateTaskFields(task.id, { engineGid: gid })
      }
      return { kind: 'awaiting', taskId: task.id, parsed, sniff: s }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // B9：状态转移失败不得吞掉原始错误
      try {
        this.transition(task, 'failed')
      } catch (txErr) {
        log.warn(`transition to failed failed for ${task.id}`, txErr)
      }
      updateTaskFields(task.id, { error: message })
      this.pushEvent({ taskId: task.id, status: 'failed', error: message })
      return { kind: 'failed', error: message }
    }
  }

  /**
   * 确认勾选（§6.1 task:confirmSelection）。
   * - awaiting：常规流程（磁力 pause 态 changeOption+unpause / .torrent addTorrent）
   * - completed（B10，§4.5 增量补下）：同 infohash re-add + 新 select-file，
   *   aria2 对已存在文件秒校验跳过；状态经 re-add 语义回到 queued（§4.5 明确定义，绕过守卫）
   */
  async confirmSelection(input: {
    taskId: string
    selectedPaths?: string[]
    formatId?: string
    threads: number
    video?: ConfirmSelectionInput['video']
  }): Promise<void> {
    const task = getTask(input.taskId) as TaskExt | null
    if (!task) throw new Error('任务不存在或已删除')

    if (input.selectedPaths) {
      setTaskFileSelection(task.id, input.selectedPaths)
    }
    const selection = { paths: input.selectedPaths ?? [] }

    if (task.status === 'completed' && task.engine === 'aria2') {
      // 增量补下：re-add + 新 select-file（§4.5）
      log.info(`re-add completed task ${task.id} for incremental download`)
      const gid = await this.aria2.start(task, selection)
      updateTaskFields(task.id, {
        status: 'queued',
        engineGid: gid,
        threads: input.threads,
        error: null,
        completedAt: null
      })
      this.pushEvent({ taskId: task.id, status: 'queued' })
      return
    }

    if (task.status !== 'awaiting') {
      throw new IllegalTransitionError(task.status, 'queued')
    }

    this.transition(task, 'queued')
    try {
      if (task.engine === 'ytdlp') {
        // M3：格式选择 → spawn 下载（合集按 --playlist-items 回放）
        if (input.video) this.ytdlp?.setVideoOptions(task.id, input.video)
        const gid = await this.ytdlp!.start(
          task,
          this.isPlaylistTask(task) ? this.selectionFor(task) : undefined
        )
        updateTaskFields(task.id, { engineGid: gid, threads: input.threads })
      } else if (task.pendingGid) {
        // 磁力暂停态：changeOption(select-file/dir/seed-ratio) + unpause（§4.2 Step3）
        await this.aria2.confirmSelection(
          task.pendingGid,
          input.selectedPaths ?? [],
          input.threads,
          task.saveDir,
          task.seedRatio ?? 0
        )
        updateTaskFields(task.id, { engineGid: task.pendingGid, threads: input.threads })
        await this.aria2.resume({ ...task, engineGid: task.pendingGid })
      } else {
        // .torrent：addTorrent 注入 select-file（按 task_files 顺序映射索引）+ dir
        const gid = await this.aria2.start(task, this.selectionFor(task))
        updateTaskFields(task.id, { engineGid: gid, threads: input.threads })
      }
      this.pushEvent({ taskId: task.id, status: 'queued' })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      try {
        this.transition(task, 'failed')
      } catch (txErr) {
        log.warn(`transition to failed failed for ${task.id}`, txErr)
      }
      updateTaskFields(task.id, { error: message })
      this.pushEvent({ taskId: task.id, status: 'failed', error: message })
      throw err
    }
  }

  // ── 控制（§6.1 task:control）───────────────────────────────────────

  async control(input: {
    taskId: string
    action: 'pause' | 'resume' | 'remove' | 'top'
    withFiles?: boolean
  }): Promise<void> {
    const task = getTask(input.taskId) as TaskExt | null
    if (!task) return
    switch (input.action) {
      case 'pause':
        if (task.status === 'running' || task.status === 'queued') {
          // M3-1：yt-dlp pause = SIGTERM（.part 保留）；aria2 = RPC pause
          if (task.engine === 'ytdlp') this.ytdlp?.pause(task)
          else
            await this.aria2.pause(task).catch(() => {
              // 极端竞态：forcePause 仍被拒（如刚重启 aria2 会话丢失）→ 不转状态，抛友好提示
              throw new Error('任务正忙，无法立即暂停，请稍候重试')
            })
          this.transition(task, 'paused')
          this.pushEvent({ taskId: task.id, status: 'paused' })
        }
        break
      case 'resume':
        // B8：先调引擎成功再转移状态，失败时保持 paused
        if (task.status === 'paused') {
          if (task.engine === 'ytdlp') {
            // resume：同参数重 spawn（恢复凭据是任务参数本身，§4.1）
            if (!this.ytdlp?.resume(task)) throw new Error('无法恢复：任务参数已丢失，请重试')
          } else {
            await this.aria2.resume(task)
          }
          this.transition(task, 'running')
          this.pushEvent({ taskId: task.id, status: 'running' })
        }
        break
      case 'remove': {
        // 按引擎分派移除：aria2 走 RPC；ytdlp 杀进程；
        // music 无取消端点（仅解除 gid 关联，服务侧任务自然结束）；
        // tool 杀 ffmpeg 进程（取消后任务记录按 withFiles 语义处理）
        if (task.engine === 'ytdlp') {
          this.ytdlp?.remove(task)
        } else if (task.engine === 'music') {
          // 服务端协作式取消（标记 cancelling，引擎完成后服务端删产物）
          if (task.engineGid) void this.music?.cancel(task.engineGid)
          updateTaskFields(task.id, { engineGid: null })
        } else if (task.engine === 'tool') {
          toolbox.cancel(task.id)
        } else {
          await this.aria2.remove(task)
        }
        if (input.withFiles) {
          // B6：只删除任务文件（task_files 记录的相对路径），禁止整目录 rm
          await this.deleteTaskFiles(task)
          purgeTask(task.id)
        } else {
          softDeleteTask(task.id) // 回收站：默认保留文件（§4.5）
        }
        break
      }
      case 'top':
        // 置顶：M1 先记录，排序在 UI 层（§4.5 手动置顶 > 新建）
        break
    }
  }

  /** B6：按 task_files 精确删除任务文件；目录内无其他文件时顺带清理空目录 */
  private async deleteTaskFiles(task: Task): Promise<void> {
    const { rm, stat, readdir } = await import('fs/promises')
    const { join, dirname } = await import('path')
    const files = getTaskFiles(task.id)
    const saveDir = task.saveDir.replace(/\\/g, '/').replace(/\/+$/, '')
    const dirs = new Set<string>()
    // 大小写口径跟文件系统走：win32/macOS 不敏感，Linux 敏感（防止 /data/Foo 被误判为 saveDir 内）
    const caseFold = (p: string): string => (process.platform === 'linux' ? p : p.toLowerCase())
    for (const f of files) {
      const abs = join(task.saveDir, f.path)
      // 防御：确保解析出的绝对路径确实位于 saveDir 之内
      if (!caseFold(abs.replace(/\\/g, '/')).startsWith(caseFold(saveDir) + '/')) {
        log.warn(`skip file outside saveDir: ${abs}`)
        continue
      }
      dirs.add(dirname(abs.replace(/\\/g, '/')))
      await rm(abs, { force: true }).catch(() => {})
    }
    // 自底向上清理空目录（限 saveDir 内）
    const sorted = [...dirs].sort((a, b) => b.length - a.length)
    for (const d of sorted) {
      const norm = d.replace(/\\/g, '/')
      if (!caseFold(norm).startsWith(caseFold(saveDir) + '/')) continue
      try {
        const entries = await readdir(norm)
        if (entries.length === 0) await rm(norm, { recursive: true })
        void stat
      } catch {
        // 目录不存在或非空，忽略
      }
    }
  }

  async restoreFromTrash(taskId: string): Promise<void> {
    restoreTask(taskId)
    const task = getTask(taskId)
    if (!task) return
    // 移入回收站时引擎侧任务已被移除：恢复后运行类状态归位 queued 并立即 re-add，
    // 避免「恢复后永远 running 但引擎里没有任务」的幽灵态
    if (['running', 'queued', 'paused', 'verifying'].includes(task.status)) {
      updateTaskFields(taskId, { status: 'queued', engineGid: null })
      this.pushEvent({ taskId, status: 'queued' })
      if (task.engine === 'aria2' || task.engine === 'ytdlp') {
        void this.recoverEngineTasks()
      } else if (task.engine === 'music') {
        this.pumpMusic()
      }
    }
  }

  // ── 持久化恢复（M1-11，§4.5）──────────────────────────────────────

  /**
   * 重启恢复：
   * - parsing → failed（B3：解析中断不可静默直下，文案给出口动作让用户重试）
   * - queued/running/paused/verifying → queued（引擎上线后 re-add 续传，B2 已带勾选回放）
   * - awaiting：凭已存 task_files 恢复勾选面板
   */
  async recoverOnStartup(): Promise<void> {
    const rows = listTasks({
      status: ['parsing', 'awaiting', 'queued', 'running', 'paused', 'verifying']
    })
    for (const t of rows) {
      try {
        if (t.status === 'parsing') {
          updateTaskFields(t.id, {
            status: 'failed',
            error: makeError('INTERNAL', {
              message: '解析被应用重启中断。请点击重试重新解析。'
            }).message
          })
        } else if (['queued', 'running', 'paused', 'verifying'].includes(t.status)) {
          updateTaskFields(t.id, { status: 'queued', engineGid: null })
        }
      } catch (err) {
        log.warn(`recover task ${t.id} failed`, err)
      }
    }
    log.info(`recovered ${rows.length} active tasks from db`)
  }

  /**
   * 引擎上线后 re-add 队列任务（§4.5：BT 凭 infohash/torrent re-add）。
   * B2：磁力任务走 BEP-9 + 勾选回放（带 pause），绝不裸 addUri。
   */
  async recoverEngineTasks(): Promise<void> {
    const queued = listTasks({ status: ['queued'] })
    for (const t of queued) {
      try {
        if (t.engine === 'aria2') {
          const gid = await this.aria2.start(t, this.selectionFor(t))
          updateTaskFields(t.id, { engineGid: gid })
        } else if (t.engine === 'ytdlp' && this.ytdlp) {
          // M3-1：resume = 同参数重 spawn（合集带 --playlist-items 回放）
          const gid = await this.ytdlp.start(
            t,
            this.isPlaylistTask(t) ? this.selectionFor(t) : undefined
          )
          updateTaskFields(t.id, { engineGid: gid })
        } else {
          continue
        }
        this.transition(t, 'running')
        this.pushEvent({ taskId: t.id, status: 'running' })
        log.info(`re-added task ${t.id}`)
      } catch (err) {
        log.warn(`re-add task ${t.id} failed`, err)
      }
    }
  }

  /** F5：单任务失败重试（failed → queued → re-add），不影响其他任务 */
  async retryTask(taskId: string): Promise<void> {
    const task = getTask(taskId) as TaskExt | null
    if (!task || task.status !== 'failed') return
    this.transition(task, 'queued')
    if (task.engine !== 'aria2' && task.engine !== 'ytdlp') {
      this.pushEvent({ taskId, status: 'queued' })
      // 音乐/工具失败重试：立即重泵对应队列（否则任务卡 queued 直到引擎重启）
      if (task.engine === 'music') this.pumpMusic()
      return
    }
    try {
      let gid: string
      if (task.engine === 'ytdlp') {
        gid = await this.ytdlp!.start(
          task,
          this.isPlaylistTask(task) ? this.selectionFor(task) : undefined
        )
      } else {
        gid = await this.aria2.start(task, this.selectionFor(task))
      }
      updateTaskFields(taskId, { engineGid: gid, error: null })
      this.transition(task, 'running')
      this.pushEvent({ taskId, status: 'running' })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      try {
        this.transition(task, 'failed')
      } catch {
        // 已是 failed
      }
      updateTaskFields(taskId, { error: message })
      this.pushEvent({ taskId, status: 'failed', error: message })
    }
  }

  /** M3-4：合集任务判定（params JSON 持久化，重启恢复可用） */
  private isPlaylistTask(task: Task): boolean {
    if (!task.params) return false
    try {
      return (JSON.parse(task.params) as { playlist?: boolean }).playlist === true
    } catch {
      return false
    }
  }

  /** 从 task_files 构造勾选回放（路径 + 索引双通道，适配器按任务类型取用） */
  private selectionFor(task: Task): { indexes?: number[]; paths?: string[] } {
    const files = getTaskFiles(task.id)
    if (files.length === 0) return {}
    const indexes: number[] = []
    const paths: string[] = []
    files.forEach((f, i) => {
      if (f.selected) {
        indexes.push(i + 1) // task_files 保存顺序 = 解析顺序 = aria2 index
        paths.push(f.path)
      }
    })
    return { indexes, paths }
  }

  // ── 工具箱任务（M4-13，§4.7：统一队列/状态机，独立信号量在 toolbox 内）──

  async createToolTask(input: {
    tool: string
    sourcePath: string
    params: Record<string, unknown>
    saveDir?: string
  }): Promise<{ taskId: string }> {
    const task: TaskExt = {
      id: uuidv7(),
      type: 'tool',
      source: input.sourcePath,
      name: `工具箱：${input.tool}`,
      engine: 'tool',
      status: 'queued',
      saveDir: input.saveDir ?? '',
      totalBytes: 0,
      downloadedBytes: 0,
      speedBps: 0,
      threads: 0,
      createdAt: Date.now()
    }
    insertTask(task)
    this.pushEvent({ taskId: task.id, status: 'queued' })

    // M4-12/M4-13：工具任务 running 中断标记 failed（ffmpeg 中间产物不续传，§4.5）
    void (async () => {
      try {
        this.transition(task, 'running')
        this.pushEvent({ taskId: task.id, status: 'running' })
        const output = await toolbox.submit(
          {
            tool: input.tool,
          sourcePath: input.sourcePath,
          params: input.params,
          saveDir: input.saveDir || input.sourcePath
        },
          task.id
        )
        this.transition(task, 'completed')
        updateTaskFields(task.id, { name: `工具箱：${input.tool} → ${output}`, error: null })
        this.pushEvent({ taskId: task.id, status: 'completed' })
        log.info(`tool task ${task.id} completed → ${output}`)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        try {
          this.transition(task, 'failed')
        } catch {
          // 已失败
        }
        updateTaskFields(task.id, { error: message })
        this.pushEvent({ taskId: task.id, status: 'failed', error: message })
      }
    })()
    return { taskId: task.id }
  }

  // ── 内部 ───────────────────────────────────────────────────────────

  private transition(task: TaskExt, to: TaskStatus): void {
    assertTransition(task.status, to)
    const patch: Parameters<typeof updateTaskFields>[1] = { status: to }
    if (to === 'completed') {
      patch.completedAt = Date.now()
      // M4-4：完成量/体积当日增量
      recordCompletion(Date.now(), task.totalBytes)
    }
    updateTaskFields(task.id, patch)
    task.status = to
  }

  private pushEvent(e: TaskEvent): void {
    this.currentEvents.set(e.taskId, e)
    broadcastTasks([e])
  }

  /** 托盘聚合速度（§4.6）：基于最近一次引擎事件快照 */
  getAggregateSpeeds(): { down: number; up: number; running: number; queued: number } {
    let down = 0
    let running = 0
    let queued = 0
    for (const t of listTasks({ status: ['running', 'queued'] })) {
      if (t.status === 'running') {
        running++
        down += this.currentEvents.get(t.id)?.speedBps ?? 0
      } else {
        queued++
      }
    }
    return { down, up: 0, running, queued }
  }

  /** 加速：把最新 tracker 列表即时注入运行中/排队的 aria2 任务（per-download changeOption） */
  async injectTrackersToRunning(trackerCsv: string): Promise<number> {
    if (!trackerCsv) return 0
    let n = 0
    for (const t of listTasks({ status: ['running', 'queued'] })) {
      if (t.engine !== 'aria2' || !t.engineGid) continue
      try {
        await this.aria2.changeOption(t.engineGid, { 'bt-tracker': trackerCsv })
        n++
      } catch (err) {
        log.debug(`tracker inject skip ${t.id}`, err)
      }
    }
    if (n > 0) log.info(`trackers injected into ${n} active task(s)`)
    return n
  }

  /** 引擎健康广播（§6.1 event:engines）：合并维护各引擎最近状态 */
  private healths: EngineHealth[] = [
    { name: 'aria2', online: false },
    { name: 'ytdlp', online: false, detail: 'M3 接入' },
    { name: 'music', online: false, detail: 'omni-service 未启动' }
  ]

  broadcastHealth(online: boolean, detail?: string): void {
    this.healths = this.healths.map((h) =>
      h.name === 'aria2' ? { ...h, online, detail } : h
    )
    broadcastEngineHealth(this.healths)
  }

  private broadcastHealthMusic(online: boolean, detail?: string): void {
    this.healths = this.healths.map((h) =>
      h.name === 'music' ? { ...h, online, detail } : h
    )
    broadcastEngineHealth(this.healths)
  }

  // ── 音乐任务（M2-6/M2-7，§4.4）────────────────────────────────────

  /** 音乐工作台搜索：代理 omni-service（不创建任务） */
  async musicSearch(q: string) {
    if (!this.music || !this.music.isOnline) {
      throw new Error('音乐服务未就绪，请稍后重试或重启应用。')
    }
    return this.music.search({ q })
  }

  /**
   * 创建音乐下载任务（§4.5：音乐单曲无需 awaiting，parsing→queued 直进）。
   * 支持三种输入：q（自然语言整行）/ artist+song / neteaseId（F1 精确下载兜底）。
   * 信号量调度：≤4 并发，超额任务保持 queued 等待槽位。
   */
  async createMusicTask(input: {
    q?: string
    artist?: string
    song?: string
    neteaseId?: string
    quality: 'standard' | 'high' | 'lossless'
    saveDir?: string
  }): Promise<{ taskId: string }> {
    if (!this.music || !this.music.isOnline) {
      throw new Error('音乐服务未就绪，请稍后重试或重启应用。')
    }
    let artist = (input.artist ?? '').trim()
    let song = (input.song ?? '').trim()
    if (!artist && !song && input.q) {
      // 服务端同源解析；本地仅生成展示名
      song = input.q
    }
    const display = input.neteaseId
      ? `${artist || '歌曲'} - ${song || `ID ${input.neteaseId}`}（ID 精确下载）`
      : artist
        ? `${artist} - ${song}`
        : song
    // B3：缺省落系统下载目录（app.getPath('downloads')）
    const saveDir =
      input.saveDir?.trim() || app.getPath('downloads')
    const task: TaskExt = {
      id: uuidv7(),
      type: 'music',
      source: input.neteaseId ? `id:${input.neteaseId}` : display,
      name: display,
      engine: 'music',
      status: 'queued',
      saveDir,
      totalBytes: 0,
      downloadedBytes: 0,
      speedBps: 0,
      threads: 0,
      quality: input.quality,
      createdAt: Date.now()
    }
    insertTask(task)
    this.pushEvent({ taskId: task.id, status: 'queued' })
    this.pumpMusic()
    return { taskId: task.id }
  }

  /** M2-6 信号量泵：队列 FIFO 出队 → 占位 → POST omni-service */
  private pumpMusic(): void {
    if (!this.music || !this.music.isOnline) return
    while (this.activeMusic < MAX_MUSIC_CONCURRENT) {
      const queued = listTasks({ status: ['queued'] }).filter(
        (t) => t.engine === 'music' && !t.engineGid && !this.musicPosting.has(t.id)
      )
      const next = queued[queued.length - 1] // createdAt DESC → 取尾部最早（FIFO）
      if (!next) return
      this.musicPosting.add(next.id)
      this.activeMusic++ // 同步占位，防 while 重入超发
      void this.postMusicDownload(next).finally(() => this.musicPosting.delete(next.id))
    }
  }

  private async postMusicDownload(task: TaskExt): Promise<void> {
    if (!this.music) return
    try {
      let req: Parameters<MusicAdapter['download']>[0]
      if (task.source.startsWith('id:')) {
        // F1：ID 精确下载（§4.4 兜底通道）
        req = {
          neteaseId: task.source.slice(3),
          artist: task.name.includes(' - ') ? task.name.split(' - ')[0] : undefined,
          song: task.name.includes(' - ') ? task.name.split(' - ').slice(1).join(' - ') : undefined,
          quality: task.quality ?? 'high',
          saveDir: task.saveDir
        }
      } else {
        const dash = task.source.indexOf(' - ')
        req = {
          artist: dash > 0 ? task.source.slice(0, dash) : undefined,
          song: dash > 0 ? task.source.slice(dash + 3) : task.source,
          quality: task.quality ?? 'high',
          saveDir: task.saveDir
        }
      }
      const serviceTaskId = await this.music.download(req)
      updateTaskFields(task.id, { engineGid: serviceTaskId })
    } catch (err) {
      // POST 失败：释放占位并标记失败
      this.activeMusic = Math.max(0, this.activeMusic - 1)
      const message = err instanceof Error ? err.message : String(err)
      try {
        this.transition(task, 'failed')
      } catch {
        // 已失败
      }
      updateTaskFields(task.id, { error: message })
      this.pushEvent({ taskId: task.id, status: 'failed', error: message })
      this.pumpMusic()
    }
  }

  /** omni-service WS 事件 → 任务流（§6.3 music.progress/done/warning） */
  applyMusicEvent(ev: ServiceEvent): void {
    if (ev.type === 'music.warning') {
      const notice: UiNotice = {
        level: 'warning',
        message: ev.message ?? '音乐平台降级',
        taskId: ev.taskId
      }
      broadcastNotices([notice])
      return
    }

    // engineGid = omni-service 任务 id
    const all = listTasks({ status: ['queued', 'running'] })
    const task = all.find((t) => t.engine === 'music' && t.engineGid === ev.taskId) as
      | TaskExt
      | undefined
    if (!task) return

    if (ev.type === 'music.progress') {
      if (task.status === 'queued') {
        this.transition(task, 'running')
      }
      this.pushEvent({
        taskId: task.id,
        status: 'running',
        speedBps: 0,
        // F2：阶段文案随事件透传（渲染层展示替代字节进度）
        message: ev.message ?? ev.platformLabel,
        error: undefined
      })
      return
    }

    // music.done（cancelled：服务端协作式取消完成，产物已删，任务多半已随删除消失）
    if ((ev as { cancelled?: boolean }).cancelled) {
      try {
        this.transition(task, 'failed')
      } catch {
        // 已失败
      }
      updateTaskFields(task.id, { error: '任务已取消' })
      this.pushEvent({ taskId: task.id, status: 'failed', error: '任务已取消' })
    } else if (ev.success) {
      if (task.status === 'queued') this.transition(task, 'running')
      this.transition(task, 'completed')
      const bytes = ev.bytes ?? 0
      // F3：用真实文件名回填展示名
      let name = task.name
      if (ev.mp3Path) {
        const base = ev.mp3Path.replace(/\\/g, '/').split('/').pop() ?? ''
        name = base.replace(/\.(mp3|flac|m4a)$/i, '')
      }
      updateTaskFields(task.id, {
        downloaded: bytes,
        totalBytes: bytes,
        error: null,
        name
      })
      this.pushEvent({
        taskId: task.id,
        status: 'completed',
        downloadedBytes: bytes,
        totalBytes: bytes
      })
    } else {
      // §4.4：平台降级类失败不自动重试，文案给出口动作
      const message =
        ev.message ||
        makeError('PLATFORM_DEGRADED', {
          message: '五平台均未命中。建议更换关键词，或用歌曲 ID 精确下载。'
        }).message
      try {
        this.transition(task, 'failed')
      } catch {
        // 已失败
      }
      updateTaskFields(task.id, { error: message })
      this.pushEvent({ taskId: task.id, status: 'failed', error: message })
    }
    // 释放信号量槽位
    this.activeMusic = Math.max(0, this.activeMusic - 1)
    this.pumpMusic()
  }
}
