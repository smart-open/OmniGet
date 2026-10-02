// 任务管理器（M1-1/M1-11，§4.5）：编排、状态机驱动、持久化恢复、事件广播。

import { app } from 'electron'
import { basename, dirname, isAbsolute, join } from 'path'
import { validateSaveDir } from '../save-dir'
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
import { sniff } from '../sniffer'
import { expandInputSource, extractHttpUrls, isVideoHostUrl } from '../shortlink'
import { parseParamsJson, readTaskSpeedLimit } from '../task/params'
import type { Aria2Adapter } from '../adapters/aria2'
import type { MusicAdapter } from '../music/adapter'
import type { YtDlpAdapter } from '../adapters/ytdlp'
import type { ParseOutput } from '../adapters/types'
import { notifyTaskEvent } from '../integrations/tray'
import { toolbox } from '../toolbox'
import { samplePeakSpeed, recordCompletion, reverseCompletion } from '../stats'
import { recordPlatformOk, recordPlatformDegraded, recordPlatformFailure } from '../health'
import { getSettingParsed } from '../db'
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
      }
      // P1 加固：yt-dlp 单视频完成时产物落 task_files（此前 video/music 无 task_files，
      // 回收站「删除（含文件）」对这两类任务一个文件都不删）
      if (e.status === 'completed' && task.engine === 'ytdlp') {
        this.persistYtdlpProduct(task, e)
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

  /** yt-dlp 单视频产物落 task_files（合集任务解析期已有文件树，跳过） */
  private persistYtdlpProduct(task: TaskExt, e: TaskEvent): void {
    if (getTaskFiles(task.id).length > 0) return
    void (async () => {
      const { readdir, stat } = await import('fs/promises')
      const { join, relative, isAbsolute } = await import('path')
      // R4-P2：优先用适配器精确追踪的产物（M9 --print after_move:filepath，含
      // info-json/封面/字幕等附属文件）——此前按「目录内最新视频」猜测，多任务
      // 共用保存目录并发完成时会错拿他任务产物，回收站「含文件删除」误删
      const tracked = (this.ytdlp?.getOutputFiles(task.id) ?? []).filter((p) => isAbsolute(p))
      const products: { path: string; size: number }[] = []
      for (const abs of tracked) {
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
      (t) => t.engine === 'aria2' || t.engine === 'ytdlp'
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
  private runWhenQueued(taskId: string, job: (t: TaskExt) => Promise<void>): () => void {
    return () => {
      void (async () => {
        if (this.launching.has(taskId)) return
        this.launching.add(taskId)
        try {
          const cur = getTask(taskId) as TaskExt | null
          if (!cur || cur.status !== 'queued') return
          await job(cur)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          // P3 加固：await 期间状态可能已被轮询改写（如用户刚暂停）——重读复核再转移
          const fresh = getTask(taskId) as TaskExt | null
          if (!fresh) return
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
          updateTaskFields(taskId, { error: message })
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
        s.type === 'video'
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
      const parsed =
        task.engine === 'ytdlp'
          ? await this.ytdlp!.parse(task)
          : await this.aria2.parse(task, isAborted)
      // A3：解析返回后复核——已删除的任务不得复活写库/转移状态
      if (isTrashed(task.id)) {
        if (parsed.pendingGid) {
          await this.aria2
            .remove({ ...task, engineGid: parsed.pendingGid })
            .catch(() => {})
        }
        return { kind: 'failed', error: '任务已删除' }
      }
      // M3-6：短视频任务标记（L1/L2/L3 判定）；R7 P1：回传平台（分站 cookie/健康归因）
      if (task.engine === 'ytdlp' && s.platform && ['douyin', 'kuaishou', 'xiaohongshu', 'xigua', 'weibo'].includes(s.platform)) {
        this.ytdlp?.markShortVideo(task.id, s.platform)
      }
      task.name = parsed.name
      task.infohash = parsed.infohash
      task.pendingGid = parsed.pendingGid
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
          })
        )
      }
      return { kind: 'awaiting', taskId: task.id, parsed, sniff: s }
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
      // L-3：撤销原完成记账，保持增量 daily_stats 与全量重算口径一致
      const prevCompletedAt = getTaskCompletedAt(task.id)
      if (prevCompletedAt) {
        reverseCompletion(prevCompletedAt, task.totalBytes ?? 0)
      }
      updateTaskFields(task.id, {
        status: 'queued',
        threads: input.threads,
        error: null,
        completedAt: null
      })
      this.pushEvent({ taskId: task.id, status: 'queued' })
      this.gateStart(
        this.runWhenQueued(task.id, async (cur) => {
          // 增量补下：显式放行覆盖（凭已存在文件做秒校验跳过，§4.5）
          const gid = await this.aria2.start(cur, {
            ...this.selectionFor(cur),
            allowOverwrite: true
          })
          updateTaskFields(cur.id, { engineGid: gid })
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

  /** awaiting→queued 后的引擎启动（磁力 changeOption+unpause / .torrent addTorrent / ytdlp spawn） */
  private async startConfirmed(
    task: TaskExt,
    input: { selectedPaths?: string[]; threads: number; video?: ConfirmSelectionInput['video'] }
  ): Promise<void> {
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
      // R7 P1：单任务限速（params.speedLimit；changeOption 合并语义不清除）
      const speedLimit = readTaskSpeedLimit(task)
      if (speedLimit) {
        await this.aria2.changeOption(task.pendingGid, { 'max-download-limit': speedLimit })
      }
      updateTaskFields(task.id, { engineGid: task.pendingGid, threads: input.threads })
      await this.aria2.resume({ ...task, engineGid: task.pendingGid })
    } else {
      // .torrent：addTorrent 注入 select-file（按 task_files 顺序映射索引）+ dir
      const gid = await this.aria2.start(task, this.selectionFor(task))
      updateTaskFields(task.id, { engineGid: gid, threads: input.threads })
    }
    this.pushEvent({ taskId: task.id, status: 'queued' })
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
            this.ytdlp?.pause(task)
          } else if (task.engine === 'music') {
            // 音乐：真取消（AbortSignal 即刻中断，引擎产物已清理），槽位由后续 done(cancelled) 事件释放
            if (task.engineGid) void this.music?.cancel(task.engineGid)
            updateTaskFields(task.id, { engineGid: null })
          } else if (task.engine === 'tool') {
            // R4-P2：tool（ffmpeg）无暂停语义——此前误走 aria2 分支静默 no-op 后
            // 仍转移 paused（UI 显示已暂停、进程实际继续跑）。显式拒绝并给出路
            throw new Error('工具任务不支持暂停。如需中断请移除任务（可保留文件），稍后重新提交。')
          } else {
            await this.aria2.pause(task).catch(() => {
              // 极端竞态：forcePause 仍被拒（如刚重启 aria2 会话丢失）→ 不转状态，抛友好提示
              throw new Error('任务正忙，无法立即暂停，请稍候重试')
            })
          }
          // P2 加固：await 期间轮询事件可能已把任务转移到 completed/failed——
          // 用旧快照 transition 会把 DB 状态回写覆盖，必须重读复核
          const fresh = getTask(input.taskId) as TaskExt | null
          if (!fresh || (fresh.status !== 'running' && fresh.status !== 'queued')) return
          this.transition(fresh, 'paused')
          this.merger.drop(fresh.id) // 丢弃窗口内陈旧 running 事件，防止暂停被回放回退
          this.pushEvent({ taskId: fresh.id, status: 'paused' })
          // R2：暂停释放并发槽
          this.pumpStarts()
        }
        break
      case 'resume':
        // B8：先调引擎成功再转移状态，失败时保持 paused
        if (task.status === 'paused') {
          if (task.engine === 'ytdlp') {
            // resume：同参数重 spawn（恢复凭据是任务参数本身，§4.1）
            if (!this.ytdlp?.resume(task)) throw new Error('无法恢复：任务参数已丢失，请重试')
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
                  const gid = await this.aria2.start(cur)
                  updateTaskFields(cur.id, { engineGid: gid })
                })
              )
              break
            }
            await this.aria2.resume(task)
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
          await this.deleteTaskFiles(task, files)
        } else {
          softDeleteTask(task.id) // 回收站：默认保留文件（§4.5）
        }
        // P3 修复：删除运行中任务时速度快照表此前只增不减（removed→failed 事件
        // 被 isTrashed 守卫拦截，currentEvents.delete 永不执行）
        this.currentEvents.delete(task.id)
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
    if (['running', 'queued', 'paused', 'verifying', 'seeding'].includes(task.status)) {
      // R4-P2：seeding 纳入归位（与 recoverOnStartup 口径一致）——移入回收站时
      // 引擎 gid 已销毁，漏掉会让任务永久显示「做种中」且无重试入口
      updateTaskFields(taskId, { status: 'queued', engineGid: null })
      this.pushEvent({ taskId, status: 'queued' })
      if (task.engine === 'aria2' || task.engine === 'ytdlp') {
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

  // ── 持久化恢复（M1-11，§4.5）──────────────────────────────────────

  /**
   * 重启恢复：
   * - parsing → failed（B3：解析中断不可静默直下，文案给出口动作让用户重试）
   * - queued/running/paused/verifying → queued（引擎上线后 re-add 续传，B2 已带勾选回放）
   * - awaiting：凭已存 task_files 恢复勾选面板
   */
  async recoverOnStartup(): Promise<void> {
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
  async recoverEngineTasks(): Promise<void> {
    const queued = listTasks({ status: ['queued'] })
    for (const t of queued) {
      // R2：过并发闸门（超出上限的排队任务停在 queued，槽位释放后由 pumpStarts 派发）
      this.gateStart(
        this.runWhenQueued(t.id, async (cur) => {
          let gid: string
          if (cur.engine === 'aria2') {
            gid = await this.aria2.start(cur, this.selectionFor(cur))
          } else if (cur.engine === 'ytdlp' && this.ytdlp) {
            // M3-1：resume = 同参数重 spawn（合集带 --playlist-items 回放）
            gid = await this.ytdlp.start(
              cur,
              this.isPlaylistTask(cur) ? this.selectionFor(cur) : undefined
            )
          } else {
            return
          }
          updateTaskFields(cur.id, { engineGid: gid })
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
    if (!task || task.status !== 'failed') return
    this.transition(task, 'queued')
    if (task.engine !== 'aria2' && task.engine !== 'ytdlp') {
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
          gid = await this.ytdlp!.start(
            cur,
            this.isPlaylistTask(cur) ? this.selectionFor(cur) : undefined
          )
        } else {
          gid = await this.aria2.start(cur, this.selectionFor(cur))
        }
        updateTaskFields(cur.id, { engineGid: gid, error: null })
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
      const output = await toolbox.submit(
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
      // M3 修复：产物落 task_files——否则「彻底删除（含文件）」对工具任务只删记录，
      // 工具箱输出目录下的产物永久残留
      saveTaskFiles(task.id, [
        { path: basename(output), size, selected: true, downloaded: size }
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

  private pushEvent(e: TaskEvent): void {
    // P2 加固：终态事件不进入速度快照表——music/tool 直推路径此前只增不减，
    // 长驻会话 Map 无界增长（违背本表"防无界增长"的设计初衷）
    if (e.status !== 'completed' && e.status !== 'failed') {
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
      ? `${artist || '歌曲'} - ${song || `ID ${input.neteaseId}`}（ID 精确下载）`
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
        name = basename(ev.mp3Path).replace(/\.(mp3|flac|m4a)$/i, '')
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
