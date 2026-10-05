// 任务管理器（M1-1/M1-11，§4.5）：编排、状态机驱动、持久化恢复、事件广播。

import { app } from 'electron'
import { basename, dirname, isAbsolute, join } from 'path'
import { validateSaveDir } from '../save-dir'
import { credentialDirs, hitsAny, normPath, realishPath, SYSTEM_DIRS } from '../sensitive-paths'
import type {
  Task,
  TaskEvent,
  TaskFile,
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
import { sniff, type SniffResult } from '../sniffer'
import { expandInputSource, extractHttpUrls, isVideoHostUrl } from '../shortlink'
import { parseParamsJson, readTaskOriginUrl, readTaskPlatform, readTaskSpeedLimit } from '../task/params'
import type { Aria2Adapter } from '../adapters/aria2'
import { cleanupStaleMetadataDirs } from '../adapters/aria2'
import type { MusicAdapter } from '../music/adapter'
import { registerTrack } from '../music/library'
import type { YtDlpAdapter } from '../adapters/ytdlp'
import { Nm3u8Adapter } from '../adapters/nm3u8'
import { isBinaryPresent } from '../orchestrator/binaries'
import type { ParseOutput } from '../adapters/types'
import { notifyTaskEvent } from '../integrations/tray'
import { toolbox } from '../toolbox'
import { samplePeakSpeed, recordCompletion, reverseCompletion } from '../stats'
import { recordPlatformOk, recordPlatformDegraded, recordPlatformFailure } from '../health'
import { getSettingParsed } from '../db'
import { addArchiveKey, isArchived, noteArchiveFailure, noteArchiveSuccess, removeArchiveKey } from './archive'
import { sanitizeFilename } from '@shared/sanitize'
import {
  getVideoSidecarBase,
  resolveViaSidecar,
  type SidecarVideo
} from '../sidecar/video-api'
import { platformLabel, SIDECAR_PLATFORMS } from '../sidecar/video-extract'
import { assertTransition, IllegalTransitionError } from './state-machine'
import { uuidv7 } from './id'
import { TaskEventMerger } from './events'
import {
  findTaskByInfohash,
  getTask,
  getTaskCompletedAt,
  getTaskFiles,
  insertTask,
  isTrashed,
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
  private nm3u8: Nm3u8Adapter | null = null
  private merger: TaskEventMerger
  private pollTimer: NodeJS.Timeout | null = null
  private currentEvents = new Map<string, TaskEvent>()
  /** R2：并发上限闸门的待启动队列（FIFO 闭包，run 内部自检任务状态） */
  private startQueue: Array<() => void> = []
  /** P2 加固：正在启动（引擎调用在途）的任务——DB 状态仍为 queued，但槽位已被真实占用 */
  private launching = new Set<string>()
  /** M2-6 信号量：进行中的音乐下载数 */
  private activeMusic = 0
  /** 正在 POST 中的音乐任务（防 pump 重入） */
  private musicPosting = new Set<string>()

  constructor(aria2Adapter: Aria2Adapter) {
    this.aria2 = aria2Adapter
    this.merger = new TaskEventMerger(250, (events) => this.applyEngineEvents(events))
  }

  /** M2-6：注入音乐引擎（主进程内嵌，启动即就绪） */
  setMusicEngine(adapter: MusicAdapter): void {
    this.music = adapter
  }

  /** M3：注入 yt-dlp 引擎；事件经 sink 汇入 250ms 合并流 */
  setYtdlpEngine(adapter: YtDlpAdapter): void {
    this.ytdlp = adapter
    adapter.setSink((e) => this.merger.push(e))
  }

  /** R7 续（backlog #17）：注入 N_m3u8DL-RE 引擎（HLS/DASH；二进制在位时启用） */
  setNm3u8Engine(adapter: Nm3u8Adapter): void {
    this.nm3u8 = adapter
    adapter.setSink((e) => this.merger.push(e))
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
      const active = listTasks({ status: ['queued', 'running', 'paused', 'verifying', 'seeding'] })
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
      // P2 加固：回收站/已删除任务的事件不得复活广播（remove 后轮询仍会回一帧 removed→failed）
      if (!task || isTrashed(task.id)) continue
      // 第六轮审查：轮询名单含 paused（托盘 forcePauseAll 直调 RPC 不经 manager，
      // 依赖轮询回写 DB）——代价是每个暂停任务 4Hz 的无效落库+广播。暂停任务无
      // 字节进度，同状态 paused 帧整体去重（running→paused 的首帧不受影响）
      if (e.status === 'paused' && task.status === 'paused') continue
      let justCompleted = false
      if (e.status && e.status !== task.status) {
        try {
          this.transition(task, e.status)
          justCompleted = e.status === 'completed'
        } catch (err) {
          if (err instanceof IllegalTransitionError) {
            log.debug(`skip illegal engine transition ${err.from} -> ${err.to} for ${task.id}`)
            // P3 加固：状态转移非法只跳过转移，本窗口的字节进度照常落库
          } else {
            throw err
          }
        }
      }
      updateTaskFields(e.taskId, {
        downloaded: e.downloadedBytes,
        totalBytes: e.totalBytes,
        // M3-6：wm_level 回填（direct|fallback|post）
        ...(e.wmLevel ? { wmLevel: e.wmLevel } : {})
      })
      if (justCompleted) {
        // H5：此刻 totalBytes 已是引擎最终值，记账才准确
        this.recordCompletionBytes(e.totalBytes ?? task.totalBytes ?? 0)
        // R7 续（backlog #22）：完成即登记去重档案（单视频；合集/订阅源 URL 不入档案，
        // 条目级由 yt-dlp --download-archive 负责）
        // 审查修复：sidecar 改道任务的 task.source 已被换成时效直链——必须登记
        // 原分享链接（params.originUrl），否则同链接重复下载
        if (task.type === 'video' && !this.isPlaylistTask(task)) {
          // 审查修复：sidecar 改道任务的 task.source 已换成时效直链——登记原分享
          // 链接（params.originUrl），否则与创建期预检键不一致、去重失效
          addArchiveKey(readTaskOriginUrl(task) ?? task.source)
          noteArchiveSuccess(readTaskOriginUrl(task) ?? task.source)
        } else if (task.type === 'http') {
          const origin = readTaskOriginUrl(task)
          if (origin) addArchiveKey(origin)
        }
      }
      if (e.status === 'failed' && task.type === 'video' && !this.isPlaylistTask(task)) {
        // 审查修复：订阅侧「入队即登记档案」，下载失败必须回滚——否则失败条目被
        // 永久拉黑（订阅追更从此跳过该视频，唯一解法是手删 download.archive）。
        // 第六轮审查：回滚+下轮重建的循环对永久失败条目（下架/地区受限）是无限
        // churn——连续失败计数熔断，防 failed 行刷屏与通知打扰
        const origin = readTaskOriginUrl(task) ?? task.source
        removeArchiveKey(origin)
        removeArchiveKey(task.source)
        noteArchiveFailure(origin)
      }
      // 审查修复（P2-3 配套）：失败/暂停外的终态路径无人调用 persistCliProduct，
      // 适配器 outputFiles 登记需在此兜底注销（防 Map 无界增长；暂停保留供 resume）
      if (e.status === 'failed') this.dropEngineOutputs(task.id)
      // P1 加固：yt-dlp 单视频完成时产物落 task_files（此前 video/music 无 task_files，
      // 回收站「删除（含文件）」对这两类任务一个文件都不删）
      // R7 续（backlog #17）：nm3u8（N_m3u8DL-RE）同型复用产物落库
      if (e.status === 'completed' && (task.engine === 'ytdlp' || task.engine === 'nm3u8')) {
        this.persistCliProduct(task, e)
      }
      this.currentEvents.set(e.taskId, e)
      // P2 加固：终态事件后聚合速度表不再需要该条目，删除防 Map 无界增长
      if (e.status === 'completed' || e.status === 'failed') {
        this.currentEvents.delete(e.taskId)
      }
      notifyTaskEvent(e, task.name)
      out.push({ ...e, status: e.status ?? task.status })
    }
    if (out.length) broadcastTasks(out)
    // R2：槽位释放（completed/failed/paused）后派发排队任务
    if (this.startQueue.length > 0) this.pumpStarts()
  }

  /** yt-dlp/nm3u8 单视频产物落 task_files（合集任务解析期已有文件树，跳过） */
  private persistCliProduct(task: TaskExt, e: TaskEvent): void {
    if (getTaskFiles(task.id).length > 0) {
      this.dropEngineOutputs(task.id)
      return
    }
    // 审查修复（P2-3）：适配器在 onExit 内 emit completed 后「同步」清理
    // outputFiles，而本方法在 250ms 合并窗口 flush 后才执行——届时 getOutputFiles
    // 恒为空，M9 精确产物追踪沦为死代码、回落「目录内最新视频」猜测（多任务并发
    // 完成时错拿他任务产物 → 含文件删除误删）。改为：此处在调用线程同步捕获，
    // 随即从适配器注销（防 Map 无界增长），异步持久化使用捕获值
    const tracked = (
      task.engine === 'nm3u8'
        ? this.nm3u8?.getOutputFiles(task.id)
        : this.ytdlp?.getOutputFiles(task.id)
    ) ?? []
    this.dropEngineOutputs(task.id)
    void (async () => {
      const { readdir, stat } = await import('fs/promises')
      const { join, relative, isAbsolute } = await import('path')
      const absTracked = tracked.filter((p) => isAbsolute(p))
      const products: { path: string; size: number }[] = []
      for (const abs of absTracked) {
        const rel = relative(task.saveDir, abs).replace(/\\/g, '/')
        if (!rel || rel.startsWith('../') || rel === '..') continue // 越界防御
        const sz = await stat(abs).then((s) => s.size).catch(() => 0)
        products.push({ path: rel, size: sz })
      }
      if (products.length === 0) {
        // 兜底：适配器无追踪记录（如恢复重跑后的旧会话）→ 目录扫描最新视频
        const entries = await readdir(task.saveDir).catch(() => [] as string[])
        const videos = entries.filter((f) => /\.(mp4|mkv|webm|mov|flv|ts)$/i.test(f) && !f.endsWith('.part'))
        let best: { path: string; m: number } | null = null
        for (const f of videos) {
          const m = await stat(join(task.saveDir, f)).then((s) => s.mtimeMs).catch(() => 0)
          if (!best || m > best.m) best = { path: f, m }
        }
        if (best) {
          const fallbackSize = e.totalBytes ?? task.totalBytes ?? 0
          products.push({ path: best.path, size: fallbackSize })
        }
      }
      if (products.length === 0) return
      const size = e.totalBytes ?? task.totalBytes ?? 0
      saveTaskFiles(
        task.id,
        products.map((p) => ({ path: p.path, size: p.size || size, selected: true, downloaded: p.size || size }))
      )
      // 三期（0.10.x）：视频媒体库登记（视频产物完成即入库；合集任务文件树在
      // parse 期已有，不进此路径——MVP 只覆盖单视频/直播录制产物）
      const { registerVideo, generateCover } = await import('../video/library')
      for (const p of products) {
        if (!/\.(mp4|mkv|webm|mov|flv|ts)$/i.test(p.path)) continue
        const absPath = join(task.saveDir, p.path)
        const fileSize = p.size || (await stat(absPath).then((s) => s.size).catch(() => 0))
        if (fileSize < 1024) continue // 防半成品/损坏文件入库
        const videoId = registerVideo({
          taskId: task.id,
          path: absPath,
          title: task.name || p.path,
          platform: readTaskPlatform(task) ?? undefined,
          size: fileSize
        })
        // 封面抽取 fire-and-forget（失败留痕不阻断；同路径重复完成由库内覆盖去重）
        // 四期（0.11.x）入库钩子（fire-and-forget，失败留痕不阻断完成链）：
        // ① OpenSubtitles 字幕自动匹配（设置 video.subtitleHook，Key 走 safeStorage 凭据通道）
        // ② NFO/海报 sidecar（设置 video.nfoExport，Jellyfin/Emby 归档口径）
        // 审查修复：钩子链 await generateCover——NFO 海报复用封面产物，并发跑
        // 首次完成时 cover_path 尚未落库，poster.jpg 几乎必然跳过
        void (async () => {
          await generateCover(videoId, absPath)
          // 任务在钩子窗口内被删除（含文件）→ 不再写孤儿字幕/海报
          if (isTrashed(task.id)) return
          if (getSettingParsed<boolean>('video.subtitleHook') === true) {
            // 审查修复：字幕步骤独立容错——「未匹配到字幕」是最常见的正常结果
            // （fetchSubtitleForVideo 主动抛错），此前会连带跳过 NFO 导出
            try {
              const { autoFetchSubtitle, normalizeSubtitleLanguages } = await import(
                '../toolbox/subtitle-hook'
              )
              const langs = normalizeSubtitleLanguages(
                getSettingParsed<string>('video.subtitleLanguages') ?? 'zh'
              )
              const saved = await autoFetchSubtitle(absPath, langs)
              if (saved) {
                broadcastNotices([
                  {
                    level: 'info',
                    message: `已自动匹配字幕：${saved.split(/[\\/]/).pop() ?? saved}`,
                    taskId: task.id
                  }
                ])
              }
            } catch (err) {
              log.warn(
                `subtitle hook failed for ${task.id}: ${err instanceof Error ? err.message : String(err)}`
              )
            }
          }
          const { maybeExportNfo } = await import('../video/nfo')
          await maybeExportNfo(videoId)
        })().catch((err) => {
          log.warn(`post-video library hooks failed for ${task.id}: ${err instanceof Error ? err.message : String(err)}`)
        })
      }
    })().catch((err) => {
      // 修复：saveTaskFiles 同步异常（如退出阶段 DB 已关闭）不得逃逸为 unhandledRejection
      log.warn(`persistYtdlpProduct failed for ${task.id}`, err)
    })
  }

  // ── R2：全局并发上限（download.maxConcurrent，0=不限）───────────────

  private maxConcurrent(): number {
    const v = getSettingParsed<number>('download.maxConcurrent')
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0
  }

  /** 占用全局并发槽的引擎（music/tool 有各自独立信号量，不计入）。
   * P2 加固：启动在途（launching）的任务 DB 状态仍是 queued，但槽位已被真实占用，
   * 必须计入，否则轮询窗口内 pumpStarts 会突破 maxConcurrent。 */
  private runningDownloads(): number {
    const dbRunning = listTasks({ status: ['running', 'verifying'] }).filter(
      (t) => t.engine === 'aria2' || t.engine === 'ytdlp' || t.engine === 'nm3u8'
    ).length
    return dbRunning + this.launching.size
  }

  /** 闸门：有空位（或不限）立即执行；否则入 FIFO 队列，槽位释放后由 pumpStarts 派发 */
  private gateStart(run: () => void): void {
    const max = this.maxConcurrent()
    if (max <= 0 || this.runningDownloads() + this.startQueue.length < max) {
      run()
      return
    }
    this.startQueue.push(run)
  }

  /** 槽位释放后派发排队任务；run 自检任务状态（已删除/取消则放弃） */
  private pumpStarts(): void {
    if (this.startQueue.length === 0) return
    const max = this.maxConcurrent()
    if (max <= 0) {
      const q = this.startQueue
      this.startQueue = []
      for (const run of q) run()
      return
    }
    let running = this.runningDownloads()
    while (this.startQueue.length > 0 && running < max) {
      const run = this.startQueue.shift()!
      running++ // 本批预占，防同批超发；任务被删/失败由后续 pump 修正
      run()
    }
  }

  /** 排队启动包装：执行时重读任务并校验仍为 queued（过期/删除即放弃）。
   * P2 加固：launching 集合防同一任务并发 re-add 两次（磁力 waitMagnetMetadata
   * 最长 90s 期间 DB 一直是 queued，第二个入队的同任务 job 会穿透状态检查）。 */
  private runWhenQueued(taskId: string, job: (t: TaskExt) => Promise<string | void>): () => void {
    return () => {
      void (async () => {
        if (this.launching.has(taskId)) return
        this.launching.add(taskId)
        try {
          // P1 修复（全功能审查 10-03）：成功路径此前不校验回收站——排队任务在
          // startQueue 滞留期间被删除（softDeleteTask 只写 deleted_at，status 仍是
          // queued）时，槽位释放后闭包照常执行，回收站任务被复活下载（幽灵任务）
          const cur = getTask(taskId) as TaskExt | null
          if (!cur || cur.status !== 'queued' || isTrashed(taskId)) return
          const gid = await job(cur)
          // P2 修复：启动在途窗口（磁力 metadata 最长 90s）内的并发操作收口——
          // 仅对 aria2 引擎生效（ytdlp/nm3u8 暂停走各自的 supervisor.pause 按
          // taskId 查找，不依赖 gid）
          if (typeof gid === 'string' && gid && cur.engine === 'aria2') {
            const fresh = getTask(taskId) as TaskExt | null
            if (!fresh || isTrashed(taskId)) {
              // 在途删除：适配器已 addUri/addTorrent，移除孤儿 gid（否则无人
              // 轮询、不可暂停不可删，直到应用退出）
              await this.aria2.remove({ ...cur, engineGid: gid }).catch(() => {})
              return
            }
            if (fresh.status === 'paused') {
              // 在途暂停：对新 gid 补一发 pause——否则适配器 start 内部的
              // unpause 让引擎继续下载，paused 又被轮询 active→running
              // 合法转移静默撤销。
              // 第六轮审查：补偿必须检查 gid 终结语义——complete/error 走终态
              // 事件流（补齐记账），removed 说明引擎条目已销毁，paused+死 gid
              // 无 resume 出口，按 failed 给出口
              const outcome = await this.aria2
                .pause({ ...fresh, engineGid: gid })
                .catch(() => null)
              if (outcome === 'complete' || outcome === 'error') {
                // 回归审查：complete 在 paused 态是空操作——paused→completed 非法
                // 转移被 applyEngineEvents 静默跳过（记账/档案/产物全丢，任务卡
                // paused 无出口）。先合法归位 running（paused→running 合法），再投
                // completed 事件（running→completed 合法，记账闭环）
                if (outcome === 'complete') {
                  try {
                    this.transition(fresh, 'running')
                  } catch {
                    return // 窗口内已被轮询推到终态，无需补发
                  }
                }
                this.merger.push(
                  outcome === 'complete'
                    ? { taskId: fresh.id, status: 'completed' }
                    : { taskId: fresh.id, status: 'failed', error: '引擎侧任务已失败（aria2 终止）。请点击重试。' }
                )
              } else if (outcome === 'removed') {
                this.merger.push({
                  taskId: fresh.id,
                  status: 'failed',
                  error: '引擎侧任务已被移除。请点击重试。'
                })
              }
              return
            }
          } else if (cur.engine === 'ytdlp' || cur.engine === 'nm3u8') {
            // 第七轮审查 P2：ytdlp/nm3u8 启动在途窗口收口（与 aria2 对称）——
            // start 内 ensureVerified/ffmpegAvailable 可达秒级，期间用户的暂停/
            // 删除只写了 DB 状态；spawn 完成后 paused 会被 running 合法转移静默
            // 撤销、已删任务会幽灵下载到完成。job 返回（spawn 已发生、running
            // 事件仍在 250ms 合并窗内，DB 状态尚未被转移）时按 fresh 状态补杀进程
            const fresh = getTask(taskId) as TaskExt | null
            if (!fresh || isTrashed(taskId) || fresh.status === 'paused') {
              const adapter = cur.engine === 'ytdlp' ? this.ytdlp : this.nm3u8
              adapter?.pause(fresh ?? cur)
              if (fresh && fresh.status === 'paused') {
                this.merger.drop(fresh.id) // 丢弃窗口内陈旧 running 事件，防止暂停被回放撤销
                this.pushEvent({ taskId: fresh.id, status: 'paused' })
              }
            }
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          // P3 加固：await 期间状态可能已被轮询改写（如用户刚暂停）——重读复核再转移
          const fresh = getTask(taskId) as TaskExt | null
          if (!fresh || isTrashed(fresh.id)) return
          // M1 修复：用户刚暂停（queued→paused 合法）后，在途引擎调用的迟到报错
          // 不得把 paused 覆写成 failed——保持暂停态，仅记录错误供展示
          if (fresh.status === 'paused') {
            updateTaskFields(taskId, { error: message })
            log.warn(`start failed after user pause, keep paused: ${taskId}`, message)
            return
          }
          try {
            this.transition(fresh, 'failed')
          } catch {
            // 已是 failed
          }
          // 第六轮审查：启动失败后旧 gid 无轮询无清理（磁力确认失败时指向 parse
          // 期 paused gid）——随失败一并清空，重试走全新句柄
          updateTaskFields(taskId, { error: message, engineGid: null })
          this.pushEvent({ taskId, status: 'failed', error: message })
        } finally {
          this.launching.delete(taskId)
          // R4-P2：失败释放并发槽后必须泵队列——pushEvent 是直推、不触发 pumpStarts，
          // maxConcurrent 场景下首个任务启动失败会让排队任务永久卡 queued
          this.pumpStarts()
        }
      })()
    }
  }

  // ── 新建任务（§7.5 流程状态机）─────────────────────────────────────

  /** H9 修复：渲染层传入的 saveDir 必须校验——实现收敛到 save-dir 模块
   *（IPC settingsSet('download.saveDir') 与任务创建共用同一防线，含自启动目录拦截） */
  private validateSaveDir(dir: string): string | null {
    return validateSaveDir(dir)
  }

  async createTask(input: {
    source: string
    threads: number
    saveDir: string
    noWatermark?: boolean
    seedRatio?: number
    /** R7 P1：单任务限速（aria2 格式） */
    speedLimit?: string
  }): Promise<CreateTaskResult> {
    // P3 修复：文本含 ≥2 个 URL 且任一是视频域 → 多为不同视频（非同文件镜像），
    // 此前短链展开只取第一个、其余静默丢弃——显式报错引导分次/批量创建；
    // 纯 HTTP 直链多 URL 不受影响，仍走下方镜像合并分支（P2SP-lite）
    const pastedUrls = extractHttpUrls(input.source)
    if (pastedUrls.length > 1 && pastedUrls.some((u) => isVideoHostUrl(u))) {
      return {
        kind: 'failed',
        error:
          '检测到多个视频链接（非同文件镜像）。请逐个创建任务，或在创建对话框中每行一个链接批量创建'
      }
    }
    // R7 P1：短视频短链/分享文案展开——"7.20 xyz:/ https://v.douyin.com/xxx/ 抖音"
    // → 提取 URL → 302 还原完整链接；纯文本歌名不受影响（仅接管已知视频/短链域）
    const exp = await expandInputSource(input.source)

    // R7 P1 多源：≥2 个 http URL（非磁力输入）→ 同文件镜像合并为一个任务（P2SP-lite），
    // 镜像一致性由 parseHttp 的 content-length 校验兜底
    let s = sniff(exp.source)
    let multiSource: string[] | null = null
    if (!s) {
      const urls = extractHttpUrls(input.source)
      const first = urls[0]
      if (urls.length > 1 && first) {
        multiSource = urls
        s = { type: 'http', source: first, platform: 'http' }
      }
    }
    if (!s) return { kind: 'failed', error: makeError('PARSE_FAILED').message }
    // 分享短链默认无水印（§4.3.1）：短链已展开为完整链接，按展开标记回填
    if (exp.wasShortLink && s.type === 'video') s.noWatermark = true

    // 音乐查询（纯文本歌名）无解析/勾选阶段：直接走音乐工作台通道创建并入队，
    // 避免 engine=music 落入 aria2.parse 报"不支持的任务类型"
    if (s.type === 'music') {
      const { taskId } = await this.createMusicTask({
        q: input.source,
        quality: 'high',
        saveDir: input.saveDir
      })
      return { kind: 'started', taskId }
    }

    // R7 续（backlog #22）：已下载去重预检——在任务落库前拒绝（重复粘贴不产生垃圾
    // failed 行）。合集/订阅源 URL 不入档案，条目级由 yt-dlp --download-archive 负责；
    // 设置 download.dedupe 可关。短链展开后的 s.source 为判定对象
    if (
      s.type === 'video' &&
      !s.liveRoom && // 三期（#25）：直播录制可重复——同一直播间多次录制是常态，不走去重
      getSettingParsed<boolean>('download.dedupe') !== false &&
      isArchived(s.source)
    ) {
      return {
        kind: 'failed',
        error: '该内容已下载过（已下载去重）。如需重新下载，请在设置 → 队列与归档 中关闭去重。'
      }
    }

    // 审查修复：在途去重——同一视频链接进行中（解析/待确认/排队/运行）时拒绝重复创建。
    // 此前无互斥：对话框、Web 面板、订阅多入口可对同一 URL 双开 yt-dlp 并发写同名产物
    //（NewTaskDialog 的 submitting 只防单对话框双击）
    if (s.type === 'video') {
      const dupSource = s.source
      const dup = listTasks({ status: ['parsing', 'awaiting', 'queued', 'running'] }).find(
        (t) => t.type === 'video' && (t.source === dupSource || readTaskOriginUrl(t) === dupSource)
      )
      if (dup) {
        return { kind: 'failed', error: '相同链接的任务正在进行中，请勿重复创建' }
      }
    }

    // 入参校验（防止空目录/越界线程落库后在引擎侧报晦涩错误）
    let saveDir = input.saveDir?.trim() ?? ''
    if (!saveDir) {
      return { kind: 'failed', error: '请先设置保存目录（设置 → 下载，或对话框内选择）' }
    }
    const dirErr = this.validateSaveDir(saveDir)
    if (dirErr) return { kind: 'failed', error: dirErr }
    // R7：按类型自动归档（opt-in，设置 download.autoArchive）——创建时路由到分类子目录
    if (getSettingParsed<boolean>('download.autoArchive') === true) {
      const mediaExt = /\.(mp4|mkv|webm|avi|mov|flv|ts|mp3|flac|m4a|wav|ogg|opus|aac)(\?|#|$)/i
      if (s.type === 'video') saveDir = join(saveDir, '视频')
      else if (s.type === 'http' && /\.(mp3|flac|m4a|wav|ogg|opus|aac)(\?|#|$)/i.test(input.source))
        saveDir = join(saveDir, '音乐')
      else if (s.type === 'http' && mediaExt.test(input.source)) saveDir = join(saveDir, '视频')
    }
    const threads = Math.round(Math.min(64, Math.max(1, input.threads || 8)))

    // 磁力查重：infohash 已存在 → 秒开文件树（§4.2 Step4）；回收站任务已被排除（B7）
    if (s.type === 'magnet') {
      let ih = /xt=urn:btih:([a-zA-Z0-9]+)/.exec(s.source)?.[1]
      if (ih) {
        // 第七轮审查 P2：base32 形态的 infohash（野外最常见）必须先归一化为 hex
        // 再查重——库中 infohash 恒为 40 位 hex（parse 后写入），base32 原文比对
        // 永远 miss，同一磁力每次都重走 90s BEP-9 解析
        try {
          ih = normalizeInfohash(ih)
        } catch {
          ih = undefined
        }
      }
      if (ih) {
        const existing = findTaskByInfohash(ih)
        if (existing) {
          // 回归审查（疑似-1）：命中排队/下载/暂停中的同种任务时，复用文件树会让
          // 确认面板对非 awaiting/completed 任务抛 IllegalTransitionError——显式
          // 给出可读出口（避免重复下载是查重的初衷，不能因此创建重复任务）
          if (!['awaiting', 'completed', 'failed'].includes(existing.status)) {
            return {
              kind: 'failed',
              error: `该磁力/种子已有任务在进行中（${existing.name}，当前状态：${existing.status}）。请在任务列表中操作原任务，或等其结束后再试`
            }
          }
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
        s.type === 'video'
          ? // R7 续（backlog #17）：HLS/DASH 清单链接且 N_m3u8DL-RE 在位 → 专用引擎；
            // 否则回落 yt-dlp（generic extractor 原生支持 HLS，第一阶段口径）
            // 三期（backlog #25）：直播间页 URL 同走 RE（RE 缺席回落 yt-dlp 原生录制）
            (s.platform === 'hls' || s.liveRoom) && isBinaryPresent('nm3u8re')
            ? 'nm3u8'
            : 'ytdlp'
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
      // R7 P1：镜像列表 + 单任务限速 + 视频平台标识入 params（parse 阶段校验后回写）
      params: JSON.stringify({
        ...(multiSource ? { urls: multiSource } : {}),
        ...(input.speedLimit?.trim() ? { speedLimit: input.speedLimit.trim() } : {}),
        ...(s.type === 'video' && s.platform ? { platform: s.platform } : {})
      }),
      createdAt: Date.now()
    }
    insertTask(task)
    this.pushEvent({ taskId: task.id, status: 'parsing' })

    try {
      // M3：按引擎分派解析（video → yt-dlp；其余 → aria2）。
      // A3：传入中止探针——磁力 metadata 轮询最长 90s，期间任务可能被删除
      const isAborted = (): boolean => isTrashed(task.id)
      let parsed: ParseOutput
      try {
        parsed =
          task.engine === 'ytdlp'
            ? await this.ytdlp!.parse(task)
            : task.engine === 'nm3u8'
              ? // 三期（backlog #25）：直播间任务解析走 live/resolve（yt-dlp -J/B站公开
                // API 取流清单）——nm3u8.parse 只会拉 task.source（此刻还是直播间页 URL）
                s.liveRoom
                ? await import('../live/resolve').then((m) => m.resolveLiveRoom(task))
                : await this.nm3u8!.parse(task)
              : await this.aria2.parse(task, isAborted)
      } catch (parseErr) {
        // R7 续（backlog #11）：yt-dlp 解析失败（快手/小红书无 extractor、抖音风控等）
        // → 自托管解析服务兜底；命中后任务改道 http 直链管线（aria2 直启）
        const fallback = await this.trySidecarFallback(task, s, isAborted)
        if (!fallback) throw parseErr
        parsed = fallback
        // 对话框与 skipAwaiting 按 http 直链口径（无格式选择、创建即入队）
        s = { type: 'http', source: task.source, platform: 'http' }
      }
      // A3：解析返回后复核——已删除的任务不得复活写库/转移状态
      if (isTrashed(task.id)) {
        if (parsed.pendingGid) {
          await this.aria2
            .remove({ ...task, engineGid: parsed.pendingGid })
            .catch(() => {})
        }
        return { kind: 'failed', error: '任务已删除' }
      }
      // R7 续（backlog #22）：已下载去重——单视频命中档案即拒绝（合集/订阅源 URL 不入
      // 档案，条目级由 yt-dlp --download-archive 负责；设置 download.dedupe 可关）
      // 审查修复：预检已上移至任务落库前（避免重复粘贴产生垃圾 failed 行）
      // M3-6：短视频任务标记（L1/L2/L3 判定）；R7 P1：回传平台（分站 cookie/健康归因）
      if (task.engine === 'ytdlp' && s.platform && ['douyin', 'kuaishou', 'xiaohongshu', 'xigua', 'weibo'].includes(s.platform)) {
        this.ytdlp?.markShortVideo(task.id, s.platform)
      }
      task.name = parsed.name
      task.infohash = parsed.infohash
      task.pendingGid = parsed.pendingGid
      // 三期（backlog #25）：直播间任务改喂流清单——task.source 改写为清单直链
      //（RE 直接消费），原直播间页 URL 存 params.roomUrl（平台请求头注入依据）。
      // 清单有时效（分钟~小时级）：重启恢复的直播任务凭过期清单失败属预期，
      // 重新粘贴直播间地址即可（不回滚——录制窗口本就稍纵即逝）
      if (parsed.manifestUrl && task.engine === 'nm3u8') {
        const prev = parseParamsJson(task.params)
        task.params = JSON.stringify({ ...prev, roomUrl: task.source })
        task.source = parsed.manifestUrl
      }
      // R7 P1 多源 + 审查修复：parse 校验通过的镜像回写 params（剔除探测失败/
      // 大小不一致/内网项）。必须整体重写且保留旧字段（speedLimit 等）——原实现
      // ① 覆盖丢 speedLimit；② 仅 >1 镜像通过才回写，未校验的原始镜像（含内网
      // 地址）残留 params.urls，start() 会绕过 net-guard 直接使用。
      // parseHttp 现恒返回 mirrors（至少含探测通过的主 URL），此处取 ?? 兜底防脏数据
      if (task.type === 'http') {
        const prev = parseParamsJson(task.params)
        const urls = parsed.mirrors?.length ? parsed.mirrors : [task.source]
        task.params = JSON.stringify({ ...prev, urls })
      }
      updateTaskFields(task.id, {
        name: parsed.name,
        infohash: parsed.infohash ?? null,
        totalBytes: parsed.totalBytes,
        engineGid: parsed.pendingGid ?? null,
        ...(task.params ? { params: task.params } : {})
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
      // M3-4：合集标记持久化（重启恢复后 --playlist-items 回放需要）。
      // 审查修复：合并写入而非整体覆盖——params 现承载 speedLimit/platform/urls，
      // 覆盖会让视频合集任务丢失平台标识（分站 cookie/健康归因失效）
      if (parsed.playlist) {
        const prev = parseParamsJson(task.params)
        updateTaskFields(task.id, { params: JSON.stringify({ ...prev, playlist: true }) })
      }

      // awaiting 可跳过：HTTP 单文件 parsing → queued（§4.1 注记）
      const skipAwaiting = s.type === 'http'
      this.transition(task, skipAwaiting ? 'queued' : 'awaiting')
      if (skipAwaiting) {
        // R2：过并发闸门（排队时任务保持 queued，槽位释放后由 pumpStarts 启动）
        this.gateStart(
          this.runWhenQueued(task.id, async (cur) => {
            const gid = await this.aria2.start(cur)
            updateTaskFields(cur.id, { engineGid: gid })
            return gid
          })
        )
      }
      // R7 续：http 直链任务已在本函数内直启（skipAwaiting），返回 started 让对话框
      // 直接关框——此前单路径仍返回 awaiting，用户点确认会撞上 confirmSelection 的
      // awaiting 状态守卫抛 IllegalTransitionError（批量路径早已跳过，单路径漏改）
      return skipAwaiting
        ? { kind: 'started', taskId: task.id }
        : { kind: 'awaiting', taskId: task.id, parsed, sniff: s }
    } catch (err) {
      // A3：解析期间任务被删除（含中止探针抛出）→ 不转移状态、不标失败
      if (isTrashed(task.id)) return { kind: 'failed', error: '任务已删除' }
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
   * R7 续修复（backlog #11）：sidecar 兜底任务的时效直链——启动/重试前重问解析服务
   * 刷新（签名 URL 过期是下载失败的主因）。仅对 params.originUrl 存在的任务生效
   * （即 sidecar 改道任务）；刷新失败不阻断启动——旧直链可能仍有效。
   */
  private async refreshSidecarLink(task: TaskExt): Promise<TaskExt> {
    const originUrl = readTaskOriginUrl(task)
    if (!originUrl || !getVideoSidecarBase()) return task
    try {
      const video = await resolveViaSidecar(originUrl)
      const prev = parseParamsJson(task.params)
      const params = JSON.stringify({ ...prev, urls: [video.url] })
      task.source = video.url
      task.params = params
      updateTaskFields(task.id, { source: video.url, params })
      log.info(`sidecar 直链已刷新 ${task.id}`)
    } catch (err) {
      log.warn(`sidecar 直链刷新失败（沿用旧直链重试）${task.id}`, err)
    }
    return task
  }

  /**
   * R7 续（backlog #11）：yt-dlp 解析失败 → 自托管短视频解析服务兜底。
   * 未配置服务 / 平台不在覆盖面 / 兜底解析失败 → 返回 null 走原失败路径；
   * 命中 → 任务改道 http 直链管线：type/engine 持久化改写，source 换直链，
   * params.outName 携带标题产物名（parseHttp 命名与 aria2 out 共用）。
   * 直链有效性仍由 aria2.parseHttp 的 HEAD 探测 + 内网校验把关。
   */
  private async trySidecarFallback(
    task: TaskExt,
    s: SniffResult,
    isAborted: () => boolean
  ): Promise<ParseOutput | null> {
    if (task.engine !== 'ytdlp' || s.type !== 'video' || !s.platform) return null
    if (!SIDECAR_PLATFORMS.includes(s.platform)) return null
    if (!getVideoSidecarBase()) return null
    const platform = s.platform
    log.info(`yt-dlp 解析失败，尝试解析服务兜底（${platform}）: ${task.id}`)
    let video: SidecarVideo
    try {
      video = await resolveViaSidecar(task.source)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.warn(`解析服务兜底失败 ${task.id}: ${message}`)
      recordPlatformFailure(
        platform,
        'risk',
        `解析服务兜底失败：${message}`,
        'sidecar',
        '检查设置 → 短视频解析服务'
      )
      return null
    }
    // 解析在途期间任务可能被删除
    if (isAborted()) return null
    // 原分享页 URL（aria2 探测/下载的 UA/referer 伪装用）；产物扩展名取直链路径，缺省 mp4
    // （审查修复：解析服务标题无扩展名，out 直接用会落盘无后缀文件）
    const originUrl = task.source
    const pathExt = (() => {
      try {
        return (/\.(\w{2,5})$/.exec(new URL(video.url).pathname)?.[1] ?? 'mp4').toLowerCase()
      } catch {
        return 'mp4'
      }
    })()
    const outName = video.title ? `${sanitizeFilename(video.title)}.${pathExt}` : ''
    const prev = parseParamsJson(task.params)
    task.type = 'http'
    task.engine = 'aria2'
    task.source = video.url
    task.params = JSON.stringify({
      ...prev,
      urls: [video.url],
      originUrl,
      ...(outName ? { outName } : {})
    })
    updateTaskFields(task.id, {
      type: 'http',
      engine: 'aria2',
      source: video.url,
      params: task.params
    })
    // 健康面板：解析服务命中即记平台 ok（下载段由 aria2 层负责）
    recordPlatformOk(platform, 'sidecar')
    broadcastNotices([
      {
        level: 'info',
        message: `yt-dlp 未能解析该链接，已通过自托管解析服务获取直链（${platformLabel(platform)}）`,
        taskId: task.id
      }
    ])
    return await this.aria2.parse(task, isAborted)
  }

  /**
   * backlog #26（2026-10-03）：网盘/WebDAV（OpenList）任务创建。
   * 与常规 http 任务的区别：URL 来自用户显式配置的自托管端点（信任边界同 backlog #11，
   * 不做内网校验/无 HEAD 探测——PROPFIND 已在浏览阶段核验可达与认证），凭据由 aria2
   * 适配器在 start 时从安全存储读取注入；创建即过并发闸门直启（无 awaiting/勾选阶段）。
   */
  async createNetdiskTask(input: {
    url: string
    name: string
    size: number
    saveDir: string
    threads: number
  }): Promise<{ taskId: string }> {
    const url = typeof input.url === 'string' && /^https?:\/\//i.test(input.url.trim()) ? input.url.trim() : ''
    if (!url) throw new Error('下载地址无效（必须为 http/https）')
    const name = sanitizeFilename(String(input.name ?? '').replace(/[\\/]+/g, '_')) || 'file'
    const saveDir = String(input.saveDir ?? '').trim()
    if (!saveDir) throw new Error('请先设置保存目录')
    const dirErr = this.validateSaveDir(saveDir)
    if (dirErr) throw new Error(dirErr)
    const threads = Math.round(Math.min(64, Math.max(1, input.threads || 8)))
    // 审查修复：在途查重——同一网盘文件重复提交时，第二个任务会因 aria2
    // allow-overwrite=false 以 "File already exists" 失败，徒增垃圾 failed 行
    // （与视频任务创建期在途去重同口径）
    const dup = listTasks({ status: ['parsing', 'awaiting', 'queued', 'running'] }).find(
      (t) => t.engine === 'aria2' && t.source === url
    )
    if (dup) {
      throw new Error(`「${dup.name}」已在下载队列中，请勿重复提交`)
    }
    const task: TaskExt = {
      id: uuidv7(),
      type: 'http',
      source: url,
      name,
      engine: 'aria2',
      status: 'queued',
      saveDir,
      totalBytes: Math.max(0, Number(input.size) || 0),
      downloadedBytes: 0,
      speedBps: 0,
      threads,
      // netdisk 标记：aria2.start 据此注入 Basic 认证头（凭据不落任务库）
      params: JSON.stringify({ urls: [url], outName: name, netdisk: true }),
      createdAt: Date.now()
    }
    insertTask(task)
    // 审查修复：跳过 parse 阶段导致 task_files 为空——回收站「删除（含文件）」
    // 对网盘任务一个文件都不删（B6 承诺落空），Inspector 文件列表也为空。
    // 此处按 outName 预登记（size 取 PROPFIND 值，完成后由轮询回填 downloaded）
    saveTaskFiles(task.id, [
      { path: name, size: task.totalBytes, selected: true, downloaded: 0 }
    ])
    this.pushEvent({ taskId: task.id, status: 'queued' })
    this.gateStart(
      this.runWhenQueued(task.id, async (cur) => {
        const gid = await this.aria2.start(cur)
        updateTaskFields(cur.id, { engineGid: gid })
        return gid
      })
    )
    log.info(`netdisk task created: ${name} (${(task.totalBytes / 1024 / 1024).toFixed(1)} MB)`)
    return { taskId: task.id }
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
    // 审查修复（P2）：回收站任务的 status 仍是 awaiting/completed——无此防线时
    // confirmSelection 会复活回收站任务下载（completed 路径还会清 completedAt、
    // 扰动统计回撤记账），与 retryTask 的口径对齐
    if (isTrashed(task.id)) throw new Error('任务已在回收站中，无法开始下载')
    // P3 修复：threads 钳制到 1–64（与 createTask 同口径）——渲染层可传任意整数
    // 入库并透传给 aria2 split
    const threads = Math.min(64, Math.max(1, Math.floor(Number(input.threads) || 16)))
    input = { ...input, threads }

    // P2 加固：全不选的提交此前会走"未传 select-file"分支 → aria2 静默全量下载。
    // 主进程兜底拦截（渲染层按钮已禁用，此处防其他调用方）
    if (input.selectedPaths && input.selectedPaths.length === 0) {
      throw new Error('请至少勾选一个文件再开始下载')
    }
    if (input.selectedPaths) {
      setTaskFileSelection(task.id, input.selectedPaths)
    }

    if (task.status === 'completed' && task.engine === 'aria2') {
      // 增量补下：re-add + 新 select-file（§4.5）；过 R2 并发闸门。
      // P1 修复：selection 必须经 selectionFor() 取（indexes+paths 双通道）——
      // 此前只传 paths，.torrent 任务的 select-file 永不注入 → aria2 全量重下。
      log.info(`re-add completed task ${task.id} for incremental download`)
      // L-3：撤销原完成记账，保持增量 daily_stats 与全量重算口径一致。
      // 审查修复：回撤延后到 re-add 真正启动成功——若在启动前回撤而启动失败
      // （同名冲突/aria2 拒绝），任务落 failed 后统计被永久吞掉（单向漂移）
      // 第七轮修复（双重记账）：completedAt 此前在此清空——若任务在排队窗口被删除、
      // 之后从回收站恢复再完成，旧完成记录未回撤而新完成照常入账 → daily_stats 双计。
      // 改为保留旧 completedAt 作为「待回撤」锚点：重新起跑成功后由
      // consumePendingCompletion 回撤；排队/重启/失败窗口期间记录保持不变
      updateTaskFields(task.id, {
        status: 'queued',
        threads: input.threads,
        error: null,
        // 回归审查 P3：清旧 gid——旧 gid 指向已完成/做种中的引擎条目，排队窗口
        // 内轮询对它做无谓 tellStatus（对齐 retryTask 口径）
        engineGid: null
      })
      this.pushEvent({ taskId: task.id, status: 'queued' })
      this.gateStart(
        this.runWhenQueued(task.id, async (cur) => {
          // 增量补下：显式放行覆盖（凭已存在文件做秒校验跳过，§4.5）
          const gid = await this.aria2.start(cur, {
            ...this.selectionFor(cur),
            allowOverwrite: true
          })
          // 回归审查 P2：回撤收敛到 consumePendingCompletion——此前内联版
          // reverse 抛错仍清锚点（统计双计且锚点丢失不可重试），两处语义不一致
          this.consumePendingCompletion(cur.id, task.totalBytes ?? 0)
          updateTaskFields(cur.id, { engineGid: gid })
          return gid
        })
      )
      return
    }

    if (task.status !== 'awaiting') {
      throw new IllegalTransitionError(task.status, 'queued')
    }

    this.transition(task, 'queued')
    // R2：过并发闸门（排队时任务停在 queued；启动逻辑抽取到 startConfirmed，
    // 槽位释放后由 pumpStarts 派发执行）
    this.gateStart(this.runWhenQueued(task.id, (cur) => this.startConfirmed(cur, input)))
  }

  /** awaiting→queued 后的引擎启动（磁力 changeOption+unpause / .torrent addTorrent / ytdlp spawn）。
   * 返回 aria2 引擎的 gid 供 runWhenQueued 做在途删除/暂停收口（ytdlp/nm3u8 无需） */
  private async startConfirmed(
    task: TaskExt,
    input: { selectedPaths?: string[]; threads: number; video?: ConfirmSelectionInput['video'] }
  ): Promise<string | void> {
    let gid: string | undefined
    if (task.engine === 'ytdlp') {
      // M3：格式选择 → spawn 下载（合集按 --playlist-items 回放）
      if (input.video) {
        this.ytdlp?.setVideoOptions(task.id, input.video)
        // 第六轮审查：videoOpts 仅适配器内存态，failed 终态 cleanupTaskState 清空
        // 后会话内 retry 丢失用户全部选择（音频提取/字幕嵌入/命名模板/delogo）——
        // 随 params 持久化，retryTask 从中恢复
        const prev = parseParamsJson(task.params)
        updateTaskFields(task.id, { params: JSON.stringify({ ...prev, videoOptions: input.video }) })
      }
      gid = await this.ytdlp!.start(
        task,
        this.isPlaylistTask(task) ? this.selectionFor(task) : undefined
      )
      updateTaskFields(task.id, { engineGid: gid, threads: input.threads })
    } else if (task.engine === 'nm3u8') {
      // R7 续（backlog #17）：HLS 任务 → N_m3u8DL-RE spawn（formatId = 变体 URI）。
      // 审查修复：必须整对象透传 input.video——此前白名单只取 formatId，
      // liveRecordMinutes 被丢弃，用户设置的直播录制时长永不生效（RE 无限录制）
      // 回归审查（videoOpts 覆盖面补全）：与 ytdlp 同型——随 params 持久化，
      // 重试/重启恢复可回放（含 liveRecordMinutes）
      if (input.video) {
        this.nm3u8?.setVideoOptions(task.id, input.video)
        const prev = parseParamsJson(task.params)
        updateTaskFields(task.id, { params: JSON.stringify({ ...prev, videoOptions: input.video }) })
      }
      gid = await this.nm3u8!.start(task)
      updateTaskFields(task.id, { engineGid: gid, threads: input.threads })
    } else if (task.engineGid) {
      // 磁力暂停态：changeOption(select-file/dir/seed-ratio) + unpause（§4.2 Step3）
      // P1 修复（第六轮审查）：原判断 task.pendingGid 是死分支——pendingGid 只存在
      // 于创建期内存对象，runWhenQueued 经 getTask 重读时 rowToTask 不映射该字段，
      // 恒 undefined → 磁力确认永远走 else 重加（重新 BEP-9 取元数据最长 90s、
      // 状态闪烁、旧 paused gid 与 metaDir 泄漏、.torrent 产物写进保存目录）。
      // 磁力 parse 期已把 pendingGid 落库为 engine_gid（createTask:586），此处改用
      // engineGid；.torrent 任务本地解析无 gid，仍走下方 addTorrent 分支
      // 回归审查：快速通道对「引擎侧 gid 已销毁」的场景必失败——跨重启（aria2 会话
      // 无持久化）与 awaiting 任务删除→恢复（control remove 已销毁引擎条目）。
      // 此前改用 engineGid 后这两类场景由「慢但可用」变「确认必失败」，故失败时
      // 回落 re-add（addUri 磁力，BEP-9/元数据缓存），恢复可用性
      try {
        const pendingGid = task.engineGid
        await this.aria2.confirmSelection(
          pendingGid,
          input.selectedPaths ?? [],
          input.threads,
          task.saveDir,
          task.seedRatio ?? 0
        )
        // R7 P1：单任务限速（params.speedLimit；changeOption 合并语义不清除）
        const speedLimit = readTaskSpeedLimit(task)
        if (speedLimit) {
          await this.aria2.changeOption(pendingGid, { 'max-download-limit': speedLimit })
        }
        updateTaskFields(task.id, { engineGid: pendingGid, threads: input.threads })
        await this.aria2.resume({ ...task, engineGid: pendingGid })
        gid = pendingGid
      } catch (err) {
        if (err instanceof IllegalTransitionError) throw err
        log.warn(`磁力快速通道失败，回落 re-add：${task.id}`, err instanceof Error ? err.message : String(err))
        gid = await this.aria2.start(task, this.selectionFor(task))
        updateTaskFields(task.id, { engineGid: gid, threads: input.threads })
      }
    } else {
      // .torrent：addTorrent 注入 select-file（按 task_files 顺序映射索引）+ dir
      gid = await this.aria2.start(task, this.selectionFor(task))
      updateTaskFields(task.id, { engineGid: gid, threads: input.threads })
    }
    this.pushEvent({ taskId: task.id, status: 'queued' })
    return gid
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
          if (task.engine === 'ytdlp') {
            // M3-1：yt-dlp pause = SIGTERM（.part 保留）
            // 第六轮审查：running 但 pause 返回 false = 启动在途窗口（spawn 未
            // 登记进程表）——照常转 paused 会被随后的 running 合法转移静默撤销；
            // queued 时 false 属正常（尚未起跑，直接落到下方通用收尾转 paused）
            if (task.status === 'running' && !this.ytdlp?.pause(task)) {
              throw new Error('任务正忙，无法立即暂停，请稍候重试')
            }
          } else if (task.engine === 'nm3u8') {
            // R7 续（backlog #17）：N_m3u8DL-RE pause = SIGTERM（tmp 分片保留）
            if (task.status === 'running' && !this.nm3u8?.pause(task)) {
              throw new Error('任务正忙，无法立即暂停，请稍候重试')
            }
          } else if (task.engine === 'music') {
            // 音乐：真取消（AbortSignal 即刻中断，引擎产物已清理），槽位由后续 done(cancelled) 事件释放
            if (task.engineGid) void this.music?.cancel(task.engineGid)
            updateTaskFields(task.id, { engineGid: null })
          } else if (task.engine === 'tool') {
            // R4-P2：tool（ffmpeg）无暂停语义——此前误走 aria2 分支静默 no-op 后
            // 仍转移 paused（UI 显示已暂停、进程实际继续跑）。显式拒绝并给出路
            throw new Error('工具任务不支持暂停。如需中断请移除任务（可保留文件），稍后重新提交。')
          } else {
            const outcome = await this.aria2.pause(task).catch(() => null)
            if (outcome === null) {
              // 极端竞态：forcePause 仍被拒（如刚重启 aria2 会话丢失）→ 不转状态，抛友好提示
              throw new Error('任务正忙，无法立即暂停，请稍候重试')
            }
            if (outcome === 'complete' || outcome === 'error' || outcome === 'removed') {
              // 审查修复：gid 终结语义修正——complete ≠ paused。此前会把刚下载完的
              // 任务标成「已暂停」。改走引擎事件流转移终态（补齐完成记账/去重登记/
              // 产物落库；直接 transition 会绕过 applyEngineEvents 的全部收尾）。
              // 第六轮审查：'removed' 同样不得落通用收尾——引擎条目已销毁的任务被
              // 标 paused 后 resume 永远失败（unpause 报 gid 不存在）且无 queued 出口
              const fresh = getTask(input.taskId) as TaskExt | null
              if (fresh && (fresh.status === 'running' || fresh.status === 'queued')) {
                // 回归审查：queued→completed 非法转移会被静默跳过（同上）——先归位
                // running 再投 completed 事件，记账/产物落库才真正闭环
                if (outcome === 'complete' && fresh.status !== 'running') {
                  try {
                    this.transition(fresh, 'running')
                  } catch {
                    return // 窗口内已被轮询推到终态
                  }
                }
                this.merger.push(
                  outcome === 'complete'
                    ? { taskId: fresh.id, status: 'completed' }
                    : {
                        taskId: fresh.id,
                        status: 'failed',
                        error:
                          outcome === 'removed'
                            ? '引擎侧任务已被移除。请点击重试。'
                            : '引擎侧任务已失败（aria2 终止）。请点击重试。'
                      }
                )
              }
              return
            }
          }
          // P2 加固：await 期间轮询事件可能已把任务转移到 completed/failed——
          // 用旧快照 transition 会把 DB 状态回写覆盖，必须重读复核。
          // 审查修复（P3）：并发删除窗口（outcome='removed' 落到通用收尾）内
          // 不得给回收站行写 paused / 广播幽灵 paused 事件
          const fresh = getTask(input.taskId) as TaskExt | null
          if (!fresh || isTrashed(fresh.id) || (fresh.status !== 'running' && fresh.status !== 'queued')) return
          this.transition(fresh, 'paused')
          this.merger.drop(fresh.id) // 丢弃窗口内陈旧 running 事件，防止暂停被回放回退
          this.pushEvent({ taskId: fresh.id, status: 'paused' })
          // R2：暂停释放并发槽
          this.pumpStarts()
        } else if (task.status === 'verifying' || task.status === 'seeding') {
          // 第七轮审查 P3：verifying/seeding 点暂停此前静默无响应（连报错都没有）——
          // 显式拒绝并给出路，与 tool 分支同口径
          throw new Error(
            task.status === 'verifying'
              ? '任务正在做完整性校验，暂不能暂停，请稍候重试'
              : '任务正在做种。如需停止，可在设置中调整做种比例，或直接移除任务。'
          )
        }
        break
      case 'resume':
        // B8：先调引擎成功再转移状态，失败时保持 paused
        if (task.status === 'paused') {
          if (task.engine === 'ytdlp') {
            // resume：同参数重 spawn（恢复凭据是任务参数本身，§4.1）
            if (!this.ytdlp?.resume(task)) throw new Error('无法恢复：任务参数已丢失，请重试')
          } else if (task.engine === 'nm3u8') {
            // R7 续（backlog #17）：RE 同参数重 spawn（凭 tmp 分片续传）
            if (!this.nm3u8?.resume(task)) throw new Error('无法恢复：任务参数已丢失，请重试')
          } else if (task.engine === 'music') {
            // 音乐：暂停时引擎任务已终止，恢复 = 取消可能残留的旧引擎任务后重新入队
            if (task.engineGid) void this.music?.cancel(task.engineGid)
            updateTaskFields(task.id, { status: 'queued', engineGid: null })
            this.pushEvent({ taskId: task.id, status: 'queued' })
            this.pumpMusic()
            break
          } else if (task.engine === 'tool') {
            // R4-P2：tool 无续跑语义（§4.5，ffmpeg 中间产物不续传）——
            // 退回 queued 重走工具执行体（toolbox.submit 从头跑），而非误提交 aria2
            updateTaskFields(task.id, { status: 'queued' })
            this.pushEvent({ taskId: task.id, status: 'queued' })
            const curTool = getTask(task.id) as TaskExt | null
            if (curTool) void this.runToolTask(curTool)
            break
          } else {
            if (!task.engineGid) {
              // 等槽期间被暂停的任务尚未拿到引擎句柄（gid 为空），aria2.resume 会静默
              // no-op 而状态被写成 running → 无 gid、轮询跳过、queued 泵放弃 = 永久卡死。
              // 正确语义：退回 queued 并重新过启动闸门（旧 job 可能已被泵丢弃，必须重派）。
              updateTaskFields(task.id, { status: 'queued' })
              this.pushEvent({ taskId: task.id, status: 'queued' })
              this.gateStart(
                this.runWhenQueued(task.id, async (cur) => {
                  // 第七轮审查 P1：此分支必须带 selectionFor——部分勾选的 BT/磁力
                  // 任务在排队窗口被暂停再恢复时，裸 start 会丢 select-file，
                  // aria2 全量下载用户明确取消勾选的文件（对齐 recoverEngineTasks/
                  // retryTask 口径）
                  // 回归审查 P2：增量补下任务（completedAt 锚点在）二次起跑必须
                  // 放行覆盖——saveDir 里有原完成文件，裸 start 必撞 File already
                  // exists（对齐 confirmSelection 增量入口的 allowOverwrite: true）
                  const pendingIncremental = getTaskCompletedAt(cur.id) != null
                  const gid = await this.aria2.start(cur, {
                    ...this.selectionFor(cur),
                    ...(pendingIncremental ? { allowOverwrite: true } : {})
                  })
                  // 第七轮修复（双重记账）：排队暂停恢复路径同样回撤未消化的旧记账
                  this.consumePendingCompletion(cur.id, cur.totalBytes ?? 0)
                  updateTaskFields(cur.id, { engineGid: gid })
                  return gid
                })
              )
              break
            }
            // 第七轮审查 P3：unpause 失败此前上抛 aria2 原始英文错误（如 gid 已
            // 终结的 "cannot be unpaused now"）——归一为中文 + 出口动作
            await this.aria2.resume(task).catch(() => {
              throw new Error('引擎侧无法恢复该任务（引擎条目可能已失效）。请移除任务后重新提交。')
            })
          }
          // P2 加固：同 pause——跨 await 后复核状态，防旧快照覆盖终态
          const fresh = getTask(input.taskId) as TaskExt | null
          if (!fresh || fresh.status !== 'paused') return
          this.transition(fresh, 'running')
          this.merger.drop(fresh.id) // 对称防护：丢弃窗口内陈旧 paused 事件
          this.pushEvent({ taskId: fresh.id, status: 'running' })
        }
        break
      case 'remove': {
        // 按引擎分派移除：aria2 走 RPC；ytdlp 杀进程；
        // music 无取消端点（仅解除 gid 关联，服务侧任务自然结束）；
        // tool 杀 ffmpeg 进程（取消后任务记录按 withFiles 语义处理）
        if (task.engine === 'ytdlp') {
          this.ytdlp?.remove(task)
        } else if (task.engine === 'nm3u8') {
          this.nm3u8?.remove(task)
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
          // M2 修复：先 purge 记录后删文件——中途崩溃最多残留孤儿文件（无害可再清），
          // 而非「记录在但文件已删」的矛盾状态
          const files = getTaskFiles(task.id)
          purgeTask(task.id)
          // 四期（0.11.x）：统一内容库与回收站口径打通——文件已删时库行随之注销，
          // 不留死链；「删除·保留文件」（purgeRecord）不在此路径，库行保留
          void (async () => {
            const { removeTracksByTask } = await import('../music/library')
            const { removeVideosByTask } = await import('../video/library')
            removeTracksByTask(task.id)
            removeVideosByTask(task.id)
          })().catch((err) =>
            log.warn(`purge library rows failed for ${task.id}`, { error: String(err) })
          )
          await this.deleteTaskFiles(task, files)
        } else {
          softDeleteTask(task.id) // 回收站：默认保留文件（§4.5）
        }
        // 产物登记随任务删除一并注销（remove 不产生 failed 事件，无人兜底清理）
        this.dropEngineOutputs(task.id)
        // P3 修复：删除运行中任务时速度快照表此前只增不减（removed→failed 事件
        // 被 isTrashed 守卫拦截，currentEvents.delete 永不执行）
        this.currentEvents.delete(task.id)
        // 审查修复：广播删除事件——否则悬浮窗等只靠事件流刷新的视图计数虚高
        //（主窗口靠调用点显式 load 自愈，MiniWidget 没有这条自愈路径）
        this.pushEvent({ taskId: task.id, removed: true })
        // R2：移除释放并发槽
        this.pumpStarts()
        break
      }
      case 'top':
        // 置顶：M1 先记录，排序在 UI 层（§4.5 手动置顶 > 新建）
        break
    }
  }

  /** B6：按 task_files 精确删除任务文件；目录内无其他文件时顺带清理空目录。
   * files 可由调用方预捕获（M2：purge 记录后 task_files 已清空，需传入快照） */
  private async deleteTaskFiles(task: Task, fileList?: TaskFile[]): Promise<void> {
    const { rm, readdir } = await import('fs/promises')
    const { join, dirname } = await import('path')
    const files = fileList ?? getTaskFiles(task.id)
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
      // 终态删除用户文件：失败必须留痕（记录已删但文件残留会让用户困惑）
      await rm(abs, { force: true }).catch((err) =>
        log.warn(`删除任务文件失败（残留磁盘）: ${abs}`, { error: String(err) })
      )
    }
    // 自底向上清理空目录（限 saveDir 内）
    const sorted = [...dirs].sort((a, b) => b.length - a.length)
    for (const d of sorted) {
      const norm = d.replace(/\\/g, '/')
      if (!caseFold(norm).startsWith(caseFold(saveDir) + '/')) continue
      try {
        const entries = await readdir(norm)
        if (entries.length === 0) await rm(norm, { recursive: true })
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
    if (task.status === 'parsing') {
      // 第六轮审查：解析中删除→恢复的僵尸——createTask 的 isAborted 探针命中后
      // 直接 return（不做状态转移），归位名单此前不含 parsing → 恢复后永久
      // 「解析中」，不可暂停/重试/再入队。归位 failed 与 recoverOnStartup 同口径，
      // 给 retryTask 出口
      updateTaskFields(taskId, { status: 'failed', error: '解析已中断（任务曾删除）。请点击重试' })
      this.pushEvent({ taskId, status: 'failed', error: '解析已中断（任务曾删除）。请点击重试' })
      return
    }
    if (['running', 'queued', 'paused', 'verifying', 'seeding'].includes(task.status)) {
      // R4-P2：seeding 纳入归位（与 recoverOnStartup 口径一致）——移入回收站时
      // 引擎 gid 已销毁，漏掉会让任务永久显示「做种中」且无重试入口
      updateTaskFields(taskId, { status: 'queued', engineGid: null })
      // 审查修复：nm3u8.remove() 遗留的 userPaused 标记在此处（dropTask 使 exit
      // 回调不再触发）永远无人清除——恢复后 RE 正常跑完会被误判为「已暂停」，
      // 完成记账/产物落库全部跳过，任务永久卡在暂停态
      if (task.engine === 'nm3u8') this.nm3u8?.clearPauseMark(taskId)
      this.pushEvent({ taskId, status: 'queued' })
      if (task.engine === 'aria2' || task.engine === 'ytdlp' || task.engine === 'nm3u8') {
        void this.recoverEngineTasks()
      } else if (task.engine === 'music') {
        this.pumpMusic()
      } else if (task.engine === 'tool') {
        // P2 修复：tool 引擎此前无恢复泵——恢复后永远停在"排队中"。
        // runToolTask 起跑复核要求 status==='queued'，上一步已归位
        void this.runToolTask(task)
      }
    }
  }

  /** 适配器产物登记注销（persistCliProduct 捕获后 / failed 终态兜底） */
  private dropEngineOutputs(taskId: string): void {
    this.ytdlp?.dropOutputFiles(taskId)
    this.nm3u8?.dropOutputFiles(taskId)
  }

  /**
   * 审查修复（P1-2）：aria2 子进程中途崩溃重启后，新会话 gid 全部失效——
   * running/verifying 任务每秒 tellStatus 报错被吞，永远收不到事件（无法暂停、
   * 无法重试，无任何出口）。与 recoverOnStartup 同语义：按 aria2 侧任务重置回
   * queued，由 recoverEngineTasks re-add 续传（BT 凭 infohash、http 凭 URL）。
   */
  async recoverAria2Restart(): Promise<void> {
    const rows = listTasks({ status: ['running', 'paused', 'verifying', 'seeding'] }).filter(
      (t) => t.engine === 'aria2'
    )
    for (const t of rows) {
      updateTaskFields(t.id, { status: 'queued', engineGid: null })
      this.pushEvent({ taskId: t.id, status: 'queued' })
    }
    if (rows.length > 0) {
      log.warn(`aria2 中途重启：${rows.length} 个任务已重置回排队待续传`)
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
    // 第六轮审查：清扫放弃确认的磁力任务残留的 %TEMP%/omniget-metadata 陈旧目录
    cleanupStaleMetadataDirs()
    // M-4：seeding 纳入恢复——重启后置回 queued 由引擎 re-add（BT 秒校验后继续做种），
    // 否则 seeding 任务重启后无人轮询，永久停在「做种中」
    const rows = listTasks({
      status: ['parsing', 'awaiting', 'queued', 'running', 'paused', 'verifying', 'seeding']
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
        } else if (t.engine === 'tool' && ['queued', 'running'].includes(t.status)) {
          // 审查修复：tool 引擎不在 recoverEngineTasks 泵名单（仅 aria2/ytdlp/nm3u8），
          // 归位 queued 后无人派发 = 永久卡死且无暂停/重试出口；按 failed 落定给重试入口
          //（与 tool 的「running 中断不续传」语义一致）
          updateTaskFields(t.id, {
            status: 'failed',
            error: '工具任务被应用重启中断。请点击重试重新执行。'
          })
        } else if (['queued', 'running', 'paused', 'verifying', 'seeding'].includes(t.status)) {
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
  async recoverEngineTasks(opts?: { engines?: string[] }): Promise<void> {
    const queued = listTasks({ status: ['queued'] })
    // 第七轮审查 P2：支持按引擎过滤——aria2 起不来时也要恢复 ytdlp/nm3u8 的
    // 排队任务（它们不依赖 aria2；此前恢复泵绑死 aria2 onOnline，aria2 二进制
    // 缺失/损坏时这些任务永久卡「排队中」，queued 又无 retry 入口，用户无出口）
    const targets = opts?.engines ? queued.filter((t) => opts.engines!.includes(t.engine)) : queued
    for (const t of targets) {
      // R2：过并发闸门（超出上限的排队任务停在 queued，槽位释放后由 pumpStarts 派发）
      this.gateStart(
        this.runWhenQueued(t.id, async (cur) => {
          let gid: string
          if (cur.engine === 'aria2') {
            // R7 续修复（backlog #11）：sidecar 兜底任务恢复前刷新时效直链
            const withFreshLink = await this.refreshSidecarLink(cur)
            // 回归审查 P2：增量补下任务重启恢复同理——锚点在即放行覆盖
            const pendingIncremental = getTaskCompletedAt(cur.id) != null
            gid = await this.aria2.start(withFreshLink, {
              ...this.selectionFor(cur),
              ...(pendingIncremental ? { allowOverwrite: true } : {})
            })
            // 第七轮修复（双重记账）：重启前遗留的「增量补下 queued 任务」（带旧
            // completedAt 锚点）经恢复泵起跑成功后回撤旧记账
            this.consumePendingCompletion(cur.id, cur.totalBytes ?? 0)
          } else if (cur.engine === 'ytdlp' && this.ytdlp) {
            // M3-1：resume = 同参数重 spawn（合集带 --playlist-items 回放）
            // 回归审查（videoOpts 覆盖面补全）：重启后适配器内存为空，从 params 回放
            const p = parseParamsJson(cur.params)
            if (p.videoOptions && typeof p.videoOptions === 'object') {
              this.ytdlp.setVideoOptions(cur.id, p.videoOptions as Parameters<
                NonNullable<YtDlpAdapter['setVideoOptions']>
              >[1])
            }
            gid = await this.ytdlp.start(
              cur,
              this.isPlaylistTask(cur) ? this.selectionFor(cur) : undefined
            )
          } else if (cur.engine === 'nm3u8' && this.nm3u8) {
            // R7 续（backlog #17）：RE 重 spawn（凭 tmp 分片续传）
            // 回归审查（videoOpts 覆盖面补全）：同上——从 params 回放格式选择/直播时长
            const p = parseParamsJson(cur.params)
            if (p.videoOptions && typeof p.videoOptions === 'object') {
              this.nm3u8.setVideoOptions(cur.id, p.videoOptions as Parameters<
                NonNullable<Nm3u8Adapter['setVideoOptions']>
              >[1])
            }
            gid = await this.nm3u8.start(cur)
          } else {
            return
          }
          updateTaskFields(cur.id, { engineGid: gid })
          if (cur.engine === 'aria2') return gid
          // P3 加固：await 后重读复核，防旧快照覆盖轮询已写入的状态
          const fresh = getTask(cur.id) as TaskExt | null
          if (fresh && fresh.status === 'queued') {
            this.transition(fresh, 'running')
            this.pushEvent({ taskId: cur.id, status: 'running' })
          }
          log.info(`re-added task ${cur.id}`)
        })
      )
    }
  }

  /** F5：单任务失败重试（failed → queued → re-add），不影响其他任务 */
  async retryTask(taskId: string): Promise<void> {
    const task = getTask(taskId) as TaskExt | null
    if (!task || task.status !== 'failed' || isTrashed(taskId)) return
    this.transition(task, 'queued')
    // 审查修复：失败任务的旧 engineGid 仍指向已终结的引擎条目——重试置回 queued 后
    // 1s 内的轮询会拿旧 gid 回一帧 failed 把任务打回 failed（并发槽满时 pumpStarts
    // 直接放弃 = 重试毫无效果且无反馈）。重试必须换新句柄并丢弃旧事件流
    updateTaskFields(taskId, { engineGid: null })
    this.merger.drop(taskId)
    if (task.engine !== 'aria2' && task.engine !== 'ytdlp' && task.engine !== 'nm3u8') {
      this.pushEvent({ taskId, status: 'queued' })
      // 音乐/工具失败重试：立即重泵对应队列（否则任务卡 queued 直到引擎重启）
      if (task.engine === 'music') {
        // R4-P1：失败任务的 engineGid 残留会被 pumpMusic 的 !engineGid 过滤
        // 挡住 → 重试后永久卡 queued，必须先清 gid 再泵
        updateTaskFields(taskId, { engineGid: null })
        this.pumpMusic()
      }
      // H6 修复：tool 引擎此前无任何重新提交路径，failed→queued 后永久卡死
      if (task.engine === 'tool') void this.runToolTask(task)
      return
    }
    // R2：过并发闸门（排队时任务停在 queued，槽位释放后自动启动）
    this.gateStart(
      this.runWhenQueued(taskId, async (cur) => {
        let gid: string
        if (cur.engine === 'ytdlp') {
          // 第六轮审查：failed 终态已清适配器内存 videoOpts——从 params 恢复
          // 用户确认时的选择，否则重试按默认格式重下
          const p = parseParamsJson(cur.params)
          if (p.videoOptions && typeof p.videoOptions === 'object') {
            this.ytdlp?.setVideoOptions(cur.id, p.videoOptions as Parameters<
              NonNullable<YtDlpAdapter['setVideoOptions']>
            >[1])
          }
          gid = await this.ytdlp!.start(
            cur,
            this.isPlaylistTask(cur) ? this.selectionFor(cur) : undefined
          )
        } else if (cur.engine === 'nm3u8' && this.nm3u8) {
          // R7 续（backlog #17）：RE 重 spawn
          // 回归审查（videoOpts 覆盖面补全）：从 params 回放（含 liveRecordMinutes）
          const p = parseParamsJson(cur.params)
          if (p.videoOptions && typeof p.videoOptions === 'object') {
            this.nm3u8?.setVideoOptions(cur.id, p.videoOptions as Parameters<
              NonNullable<Nm3u8Adapter['setVideoOptions']>
            >[1])
          }
          gid = await this.nm3u8.start(cur)
        } else {
          // R7 续修复（backlog #11）：sidecar 兜底任务重试前刷新时效直链
          const fresh = await this.refreshSidecarLink(cur)
          // 回归审查 P2：增量补下任务失败重试同理——锚点在即放行覆盖
          const pendingIncremental = getTaskCompletedAt(cur.id) != null
          gid = await this.aria2.start(fresh, {
            ...this.selectionFor(cur),
            ...(pendingIncremental ? { allowOverwrite: true } : {})
          })
          // 第七轮修复（双重记账）：失败任务若带未回撤的旧 completedAt（增量补下
          // 启动失败落入 failed），重试起跑成功后回撤
          this.consumePendingCompletion(cur.id, cur.totalBytes ?? 0)
        }
        updateTaskFields(cur.id, { engineGid: gid, error: null })
        if (cur.engine === 'aria2') return gid
        // P3 加固：await 后重读复核，防旧快照覆盖轮询已写入的状态
        const fresh = getTask(taskId) as TaskExt | null
        if (fresh && fresh.status === 'queued') {
          this.transition(fresh, 'running')
          this.pushEvent({ taskId: cur.id, status: 'running' })
        }
      })
    )
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
    // P2 修复：tool 任务此前是唯一未接入 saveDir 校验的 IPC 入口（H1/H9 口径统一），
    // sourcePath 同样要求绝对路径并拒绝 UNC（与读取侧 taskParseFile 对称）
    const sp = String(input.sourcePath ?? '').trim()
    if (!sp) throw new Error('请先选择源文件')
    if (sp.includes('\0')) throw new Error('源文件路径包含非法字符')
    if (!isAbsolute(sp)) throw new Error('源文件路径必须是绝对路径')
    if (/^\\\\/.test(sp)) throw new Error('不支持 UNC 网络路径作为源文件')
    // 第六轮审查：读取侧此前只挡 UNC——与 taskParseFile/preview 口径对齐，套用
    // 系统/凭据目录黑名单（防被攻破的渲染层借 checksum 等工具哈希凭据文件）。
    // userData 豁免在先：工具箱产物（存 userData）可作为下一轮工具的输入
    {
      const norm = realishPath(sp).replace(/\\/g, '/').toLowerCase()
      let userDataExempt = ''
      try {
        userDataExempt = app
          .getPath('userData')
          .replace(/\\/g, '/')
          .toLowerCase()
          .replace(/\/+$/, '')
      } catch {
        // app 未就绪（单测环境）
      }
      const home = normPath(app.getPath('home'))
      const blockedDirs = [
        ...SYSTEM_DIRS,
        ...credentialDirs(),
        ...(home ? [`${home}/appdata/roaming`, `${home}/appdata/local/temp`] : []),
        process.env.TEMP ? normPath(process.env.TEMP) : ''
      ]
        .filter(Boolean)
        .filter((d) => !(userDataExempt && (d === userDataExempt || d.startsWith(`${userDataExempt}/`))))
      const inUserData = userDataExempt !== '' && (norm === userDataExempt || norm.startsWith(`${userDataExempt}/`))
      if (!inUserData && hitsAny(norm, blockedDirs)) {
        throw new Error('不允许使用系统或敏感目录中的文件作为工具输入')
      }
    }
    const effectiveSaveDir = input.saveDir || dirname(sp)
    const saveErr = validateSaveDir(effectiveSaveDir)
    if (saveErr) throw new Error(saveErr)
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
      // H6 修复：持久化工具输入——否则重试时 tool/params 丢失，failed 永远无法重新提交
      params: JSON.stringify({ ...input, saveDir: input.saveDir ?? '' }),
      createdAt: Date.now()
    }
    insertTask(task)
    this.pushEvent({ taskId: task.id, status: 'queued' })
    void this.runToolTask(task)
    return { taskId: task.id }
  }

  /** 工具任务执行体（创建与重试共用）。调用时任务应为 queued 状态 */
  private async runToolTask(task: TaskExt): Promise<void> {
    // M4-12/M4-13：工具任务 running 中断标记 failed（ffmpeg 中间产物不续传，§4.5）
    try {
      // 起跑复核：任务在队列等待期间被删除/回收则放弃，防止状态位复活
      const cur = getTask(task.id) as TaskExt | null
      if (!cur || cur.status !== 'queued' || isTrashed(task.id)) return
      let input: { tool: string; sourcePath: string; params: Record<string, unknown>; saveDir?: string }
      try {
        input = JSON.parse(task.params ?? '') as typeof input
      } catch {
        throw new Error('工具任务参数缺失，无法重试（请重新创建任务）')
      }
      this.transition(task, 'running')
      this.pushEvent({ taskId: task.id, status: 'running' })
      const { output, extraOutputs } = await toolbox.submit(
        {
          tool: input.tool,
          sourcePath: input.sourcePath,
          params: input.params,
          // 缺省回退：源文件所在目录（而非文件本身——那会让 mkdir 失败）
          saveDir: input.saveDir || dirname(input.sourcePath)
        },
        task.id
      )
      // P1 修复：终态转移前复核——ffmpeg 产物写盘期间任务被删除（含文件）时，
      // 不得把回收站任务"复活"为 completed 或向已 purge 的任务写 task_files（FK 异常）
      const freshDone = getTask(task.id) as TaskExt | null
      if (!freshDone || isTrashed(task.id)) return
      this.transition(freshDone, 'completed')
      // saveDir 归位产物所在目录：任务列表「打开目录」直达工具产物（此前指向源文件/下载目录）
      updateTaskFields(task.id, {
        name: `工具箱：${input.tool} → ${output}`,
        saveDir: dirname(output),
        error: null
      })
      // H5：以产物实际大小记账
      const { stat } = await import('fs/promises')
      const size = await stat(output).then((s) => s.size).catch(() => 0)
      // 审查修复（P3）：total_bytes 恒 0 → recomputeDailyStats 跨天后工具产物
      // 字节数归零（统计口径漂移）；与 completion 增量同源回写
      updateTaskFields(task.id, { totalBytes: size })
      // M3 修复：产物落 task_files——否则「彻底删除（含文件）」对工具任务只删记录，
      // 工具箱输出目录下的产物永久残留。四期审查：多产物工具（批量转码/voice-sep）
      // 的第 2..N 产物同样登记，B6 承诺才完整
      const extraRows = await Promise.all(
        extraOutputs.map(async (p) => {
          const sz = await stat(p).then((s) => s.size).catch(() => 0)
          return { path: basename(p), size: sz, selected: true, downloaded: sz }
        })
      )
      saveTaskFiles(task.id, [
        { path: basename(output), size, selected: true, downloaded: size },
        ...extraRows
      ])
      this.recordCompletionBytes(size)
      this.pushEvent({ taskId: task.id, status: 'completed' })
      log.info(`tool task ${task.id} completed → ${output}`)
    } catch (err) {
      // M3 修复：任务已被 purge/移入回收站（toolbox.cancel 异步生效后本 catch 迟到）
      // 不得复活记录或把回收站任务广播成 failed
      const fresh = getTask(task.id) as TaskExt | null
      if (!fresh || isTrashed(task.id)) return
      const message = err instanceof Error ? err.message : String(err)
      try {
        this.transition(fresh, 'failed')
      } catch {
        // 已失败
      }
      updateTaskFields(task.id, { error: message })
      this.pushEvent({ taskId: task.id, status: 'failed', error: message })
    }
  }

  // ── 内部 ───────────────────────────────────────────────────────────

  private transition(task: TaskExt, to: TaskStatus): void {
    assertTransition(task.status, to)
    const patch: Parameters<typeof updateTaskFields>[1] = { status: to }
    if (to === 'completed') {
      patch.completedAt = Date.now()
    }
    updateTaskFields(task.id, patch)
    task.status = to
  }

  /** M4-4：完成量/体积当日增量。H5 修复：必须在真实字节数回写 DB 之后再记账，
   * （transition 时刻 totalBytes 往往还是旧值——音乐首发即完成时记 0，完成体积少记） */
  private recordCompletionBytes(bytes: number): void {
    recordCompletion(Date.now(), Math.max(0, bytes ?? 0))
  }

  /** 第七轮修复（双重记账）：增量补下 re-add 保留旧 completedAt 作「待回撤」锚点
   * （排队/删除恢复/重启/失败重试窗口期间旧记录不丢）。任务经任何路径真正重新
   * 起跑成功后调用本方法回撤旧记账并清锚点——此后完成照常入账，杜绝双计 */
  private consumePendingCompletion(taskId: string, taskBytes: number): void {
    const prev = getTaskCompletedAt(taskId)
    if (prev == null) return
    try {
      reverseCompletion(prev, Math.max(0, taskBytes ?? 0))
    } catch (err) {
      // 回撤是纯记账——SQL 异常不得影响在跑任务，只留日志（锚点保留，下次再试）
      log.warn(`consumePendingCompletion reverse failed for ${taskId}`, err)
      return
    }
    updateTaskFields(taskId, { completedAt: null })
  }

  private pushEvent(e: TaskEvent): void {
    // P2 加固：终态事件不进入速度快照表——music/tool 直推路径此前只增不减，
    // 长驻会话 Map 无界增长（违背本表"防无界增长"的设计初衷）
    if (e.status !== 'completed' && e.status !== 'failed' && !e.removed) {
      this.currentEvents.set(e.taskId, e)
    }
    broadcastTasks([e])
  }

  /** 托盘聚合速度（§4.6）：基于最近一次引擎事件快照 + aria2 全局上传速度 */
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
    // P3 修复：上传速度此前硬编码 0——读 aria2 getGlobalStat 缓存值
    const g = this.aria2.globalStat()
    return { down, up: g.up, running, queued }
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
    { name: 'nm3u8', online: false, detail: 'N_m3u8DL-RE（HLS/DASH，按需 CLI）' },
    { name: 'music', online: true, detail: '内嵌引擎' }
  ]

  broadcastHealth(online: boolean, detail?: string): void {
    this.healths = this.healths.map((h) =>
      h.name === 'aria2' ? { ...h, online, detail } : h
    )
    broadcastEngineHealth(this.healths)
  }

  // ── 音乐任务（M2-6/M2-7，§4.4）────────────────────────────────────

  /** 音乐工作台搜索：内嵌引擎直跑（不创建任务） */
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
      ? `${artist && song ? `${artist} - ${song}` : artist || song || `ID ${input.neteaseId}`}（ID 精确下载）`
      : artist
        ? `${artist} - ${song}`
        : song
    // B3：缺省落系统下载目录（app.getPath('downloads')）
    const saveDir =
      input.saveDir?.trim() || app.getPath('downloads')
    {
      // H9：音乐任务同样校验（此前直用渲染层传入的任意目录）
      const dirErr = this.validateSaveDir(saveDir)
      if (dirErr) throw new Error(dirErr)
    }
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
      // 审查修复：真实 artist/song 持久化进 params——此前引擎侧从展示名反解析，
      // 「（ID 精确下载）」后缀与占位词会污染产物文件名与库记录，且
      // engine.getNeteaseDetail 的补全永远不生效
      params: JSON.stringify({
        musicArtist: artist || undefined,
        musicSong: song || undefined,
        neteaseId: input.neteaseId
      }),
      createdAt: Date.now()
    }
    insertTask(task)
    this.pushEvent({ taskId: task.id, status: 'queued' })
    this.pumpMusic()
    return { taskId: task.id }
  }

  /**
   * B1：音乐引擎就绪后恢复队列（原 sidecar onMusicEngineOnline 语义）。
   * 启动时 recoverOnStartup 只置回 queued，若无人泵则任务永久卡死；此方法在
   * setMusicEngine 之后调用，清理残留 gid 并立即泵队列。
   */
  resumeMusicQueue(): void {
    if (!this.music || !this.music.isOnline) return
    for (const t of listTasks({ status: ['queued'] })) {
      if (t.engine === 'music' && t.engineGid) updateTaskFields(t.id, { engineGid: null })
    }
    this.pumpMusic()
  }

  /** M2-6 信号量泵：队列 FIFO 出队 → 占位 → 提交内嵌引擎 */
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
        // F1：ID 精确下载（§4.4 兜底通道）。
        // 审查修复：artist/song 改从 params 读真实值（缺省时 engine.getNeteaseDetail
        // 补全）——此前从展示名反解析，「（ID 精确下载）」后缀/占位词污染产物名
        const p = parseParamsJson(task.params)
        req = {
          neteaseId: task.source.slice(3),
          artist: typeof p.musicArtist === 'string' && p.musicArtist ? p.musicArtist : undefined,
          song: typeof p.musicSong === 'string' && p.musicSong ? p.musicSong : undefined,
          quality: task.quality ?? 'high',
          saveDir: task.saveDir
        }
      } else {
        const p = parseParamsJson(task.params)
        const dash = task.source.indexOf(' - ')
        req = {
          artist:
            typeof p.musicArtist === 'string' && p.musicArtist
              ? p.musicArtist
              : dash > 0
                ? task.source.slice(0, dash)
                : undefined,
          song:
            typeof p.musicSong === 'string' && p.musicSong
              ? p.musicSong
              : dash > 0
                ? task.source.slice(dash + 3)
                : task.source,
          quality: task.quality ?? 'high',
          saveDir: task.saveDir
        }
      }
      const serviceTaskId = await this.music.download(req)
      updateTaskFields(task.id, { engineGid: serviceTaskId })
      // P2 加固：POST 在途期间用户可能已暂停/删除任务（此前 pause 只对已有 gid
      // 调 cancel，此窗口内取消失效 → 引擎照常下载落盘"已取消"的完整音频）。
      // 返回后补偿检查：任务已离开排队/运行态则立即取消引擎侧任务。
      const fresh = getTask(task.id) as TaskExt | null
      if (!fresh || (fresh.status !== 'queued' && fresh.status !== 'running')) {
        void this.music.cancel(serviceTaskId).catch(() => {})
      }
    } catch (err) {
      // POST 失败：释放占位并标记失败
      this.activeMusic = Math.max(0, this.activeMusic - 1)
      const message = err instanceof Error ? err.message : String(err)
      // R4-P3：fresh 重读 + 回收站复核（POST 在途可达数十秒，期间用户可能已删除
      // 任务）——用过期快照转移会把回收站里的行写回 failed 并广播矛盾事件
      const fresh = getTask(task.id) as TaskExt | null
      if (!fresh || isTrashed(task.id)) return
      try {
        this.transition(fresh, 'failed')
      } catch {
        // 已失败
      }
      updateTaskFields(task.id, { error: message })
      this.pushEvent({ taskId: task.id, status: 'failed', error: message })
      // 失败必须留痕（引擎层已有日志，此处任务级归档一条）
      log.error(`音乐任务失败 ${task.id}: ${message}`)
      this.pumpMusic()
    }
  }

  /** 音乐引擎事件 → 任务流（§6.3 music.progress/done/warning） */
  applyMusicEvent(ev: ServiceEvent): void {
    // Backlog：平台健康面板——降级/成功事件喂给健康注册表
    if (ev.type === 'music.warning') {
      if (ev.platform) recordPlatformDegraded(ev.platform, ev.message ?? '平台降级')
      const notice: UiNotice = {
        level: 'warning',
        message: ev.message ?? '音乐平台降级',
        taskId: ev.taskId
      }
      broadcastNotices([notice])
      return
    }

    if (ev.type === 'music.progress') {
      // engineGid = 音乐引擎任务 id
      const all = listTasks({ status: ['queued', 'running'] })
      const task = all.find((t) => t.engine === 'music' && t.engineGid === ev.taskId) as
        | TaskExt
        | undefined
      if (!task) return
      if (ev.platform) recordPlatformOk(ev.platform) // 平台有响应推进 → 健康
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

    // music.done：每个 done 都对应一个经 pumpMusic 占槽的引擎任务。
    // 任务可能已被删除/暂停（gid 已清），此时查找会落空——但槽位必须照常释放，
    // 否则每取消/删除一个运行中任务就永久泄漏 1 个并发位（上限 4，泄漏满后音乐队列全卡死）。
    this.activeMusic = Math.max(0, this.activeMusic - 1)
    // Backlog：平台健康——done 事件按成败回写（取消不计失败）
    if (ev.platform && !(ev as { cancelled?: boolean }).cancelled) {
      if (ev.success === false) {
        recordPlatformFailure(ev.platform, 'risk', ev.message ?? '平台返回失败')
      } else {
        recordPlatformOk(ev.platform)
      }
    }

    const all = listTasks({ status: ['queued', 'running'] })
    const task = all.find((t) => t.engine === 'music' && t.engineGid === ev.taskId) as
      | TaskExt
      | undefined
    if (!task) {
      this.pumpMusic()
      return
    }

    // cancelled：取消完成（引擎产物已清理；任务多已随删除/暂停流转，此处兜底标记）
    if ((ev as { cancelled?: boolean }).cancelled) {
      try {
        this.transition(task, 'failed')
      } catch {
        // 已失败
      }
      // R4-P1：失败/取消均清 gid——残留 gid 会让后续重试被 pumpMusic 的
      // !engineGid 过滤挡住，任务永久卡 queued
      updateTaskFields(task.id, { error: '任务已取消', engineGid: null })
      this.pushEvent({ taskId: task.id, status: 'failed', error: '任务已取消' })
    } else if (ev.success) {
      if (task.status === 'queued') this.transition(task, 'running')
      this.transition(task, 'completed')
      const bytes = ev.bytes ?? 0
      // F3：用真实文件名回填展示名
      let name = task.name
      if (ev.mp3Path) {
        // 二期无损档：对齐后扩展名可能是 ogg/wav/opus——通用剥后缀（原正则仅 mp3/flac/m4a 会漏）
        name = basename(ev.mp3Path).replace(/\.\w+$/, '')
      }
      updateTaskFields(task.id, {
        downloaded: bytes,
        totalBytes: bytes,
        error: null,
        name
      })
      // H5：真实字节数已回写后再记账
      this.recordCompletionBytes(bytes)
      // P1 加固：音乐产物落 task_files（此前 music 任务无 task_files，
      // 回收站「删除（含文件）」承诺落空，mp3/lrc 残留磁盘）
      const productFiles: TaskFile[] = []
      if (ev.mp3Path) {
        productFiles.push({ path: basename(ev.mp3Path), size: bytes, selected: true, downloaded: bytes })
      }
      if (ev.lrcPath) {
        productFiles.push({ path: basename(ev.lrcPath), size: 0, selected: true, downloaded: 0 })
      }
      if (productFiles.length > 0) saveTaskFiles(task.id, productFiles)
      // 二期（0.9.x 音乐库）：完成即登记曲目（音乐库视图数据源）。
      // title 用真实产物名回填后的 name；artist 从 params 取持久化真值
      if (ev.mp3Path) {
        // 库登记失败不得吞掉 completed 事件（pushEvent 在其后）——SQLite 故障时降级跳过
        try {
          const p = parseParamsJson(task.params)
          registerTrack({
            taskId: task.id,
            path: ev.mp3Path,
            lrcPath: ev.lrcPath || undefined,
            title: name,
            artist: typeof p.musicArtist === 'string' && p.musicArtist ? p.musicArtist : undefined,
            album: ev.album || undefined,
            quality: task.quality ?? undefined,
            source: ev.source || undefined,
            size: bytes
          })
        } catch (err) {
          log.warn('音乐库登记失败（不影响任务完成）', { error: err instanceof Error ? err.message : String(err) })
        }
      }
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
      // R4-P1：失败清 gid（同取消路径——残留会让重试永不入泵）
      updateTaskFields(task.id, { error: message, engineGid: null })
      this.pushEvent({ taskId: task.id, status: 'failed', error: message })
    }
    this.pumpMusic()
  }
}
