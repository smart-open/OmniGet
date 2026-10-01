// yt-dlp 适配器（M3-1 ~ M3-11，§4.3）
// parse：-J 解析（单视频 formats / flat-playlist 条目树）
// start：spawn 下载（进度模板逐行解析）；短视频 L1/L2（wm_level 回填）；L3 delogo 后处理
// pause：SIGTERM 保留 .part；resume：同参数重 spawn（§4.1 语义）
// M3-2：ffmpeg 缺失时降级预合并格式（--ffmpeg-location 仅在存在时注入）

import type { Task, TaskEvent, VideoFormat } from '@shared/types'
import { join } from 'path'
import { sanitizeFilename } from '@shared/sanitize'
import { getSettingParsed } from '../db'
import { createLogger } from '../logger'
import { getYtDlpSupervisor } from '../orchestrator/ytdlp'
import { ensureVerified } from '../orchestrator/binaries'
import type { EngineHealthInfo, ParseOutput } from './types'

const log = createLogger('ytdlp-adapter')

export interface VideoSelection {
  formatId?: string
  embedSubs?: boolean
  embedThumbnail?: boolean
  audioOnly?: boolean
  audioFormat?: 'mp3' | 'm4a' | 'opus'
  delogo?: boolean
}

interface RawFormat {
  format_id?: string
  url?: string
  ext?: string
  height?: number
  width?: number
  fps?: number
  vcodec?: string
  acodec?: string
  tbr?: number
  filesize?: number
  filesize_approx?: number
  format_note?: string
  protocol?: string
}

interface YtDlpJson {
  _type?: string
  id?: string
  title?: string
  thumbnail?: string
  thumbnails?: { url?: string }[]
  duration?: number
  uploader?: string
  ext?: string
  formats?: RawFormat[]
  entries?: YtDlpJson[]
}

export class YtDlpAdapter {
  private supervisor = getYtDlpSupervisor()
  private sink: ((e: TaskEvent) => void) | null = null
  private ffmpegOk: boolean | null = null
  /** 确认勾选时的视频参数（transient；恢复后走默认值） */
  private videoOpts = new Map<string, VideoSelection>()
  private userPaused = new Set<string>()
  private running = new Set<string>()
  /** 短视频任务（L1/L2 判定用） */
  private shortVideo = new Set<string>()
  /** taskId → 启动参数（resume 重 spawn 凭据） */
  private argsByTask = new Map<
    string,
    { args: string[]; shortVideo: boolean; attempt: number }
  >()

  setSink(cb: (e: TaskEvent) => void): void {
    this.sink = cb
  }

  private emit(e: TaskEvent): void {
    this.sink?.(e)
  }

  async health(): Promise<EngineHealthInfo> {
    const v = await this.supervisor.version()
    return v ? { online: true, detail: v } : { online: false, detail: 'yt-dlp 不可用' }
  }

  // ── parse（M3-3/M3-4/M3-11）────────────────────────────────────────

  async parse(task: Task): Promise<ParseOutput> {
    if (this.ffmpegOk === null) this.ffmpegOk = await this.supervisor.ffmpegAvailable()
    const { stripFileProtocol } = await import('../sniffer')
    const url = stripFileProtocol(task.source)
    const out = await this.supervisor.execJson(['-J', '--no-playlist', url])
    const json = JSON.parse(out) as YtDlpJson

    // 合集/主页（M3-4/M3-8）：flat-playlist 条目 → 文件树
    if (json._type === 'playlist' && Array.isArray(json.entries)) {
      const files = json.entries.map((e, i) => ({
        path: sanitize(`${e.title || e.id || `entry-${i}`}.${e.ext || 'mp4'}`),
        size: 0, // flat 模式不取单集体积（避免 N 次请求）
        selected: true,
        downloaded: 0
      }))
      return {
        name: sanitize(json.title || '合集'),
        files,
        totalBytes: 0,
        playlist: true,
        coverUrl: json.thumbnails?.[0]?.url ?? undefined,
        ffmpegMissing: !this.ffmpegOk
      }
    }

    // 单视频：formats → VideoFormat 列表（M3-3）
    const formats = this.mapFormats(json.formats ?? [], !this.ffmpegOk)
    return {
      name: sanitize(json.title || json.id || 'video'),
      formats,
      totalBytes: pickSize(formats[0]),
      coverUrl: json.thumbnail,
      duration: json.duration,
      ffmpegMissing: !this.ffmpegOk
    }
  }

  /** M3-3：formats → 选择器列表（合并展示视频轨；ffmpeg 缺失时仅保留渐进式预合并格式） */
  private mapFormats(raw: RawFormat[], premergedOnly: boolean): VideoFormat[] {
    const list: VideoFormat[] = []
    for (const f of raw) {
      const hasVideo = f.vcodec && f.vcodec !== 'none'
      const hasAudio = f.acodec && f.acodec !== 'none'
      if (premergedOnly && !(hasVideo && hasAudio)) continue
      if (!hasVideo && !hasAudio) continue
      list.push({
        formatId: f.format_id ?? '',
        resolution: f.height ? `${f.width ?? '?'}x${f.height}` : 'audio',
        ext: f.ext ?? '',
        fps: f.fps,
        vcodec: f.vcodec,
        acodec: f.acodec,
        tbr: f.tbr,
        filesize: f.filesize ?? f.filesize_approx,
        // L1 无水印启发：format 元数据带 wm/watermark 标记的排后（§4.3.1）
        noWatermark: !/wm|watermark/i.test(`${f.format_id ?? ''} ${f.format_note ?? ''}`)
      })
    }
    // 按高度降序，音频排最后
    list.sort((a, b) => {
      const ha = parseInt(a.resolution) || 0
      const hb = parseInt(b.resolution) || 0
      return hb - ha
    })
    return list.slice(0, 40)
  }

  // ── start / control（M3-1/M3-5/M3-6/M3-10）────────────────────────

  async start(task: Task, selection?: { indexes?: number[]; paths?: string[] }): Promise<string> {
    // TOFU 强制校验（此前仅 aria2 有闸门，yt-dlp 被篡改仍可运行）
    await ensureVerified('ytdlp')
    if (this.ffmpegOk === null) this.ffmpegOk = await this.supervisor.ffmpegAvailable()
    const opts = this.videoOpts.get(task.id) ?? {}
    const isPlaylist = (selection?.indexes?.length ?? 0) > 1
    const isShort = this.shortVideo.has(task.id)
    // P1 加固：settings 落库为 JSON 串，读取必须反序列化（带引号会让 --cookies 静默失效）
    const rawCookie = getSettingParsed<string | null>('ytdlp.cookieFile')
    const cookieFile = typeof rawCookie === 'string' && rawCookie.trim() ? rawCookie : null

    const args: string[] = [task.source]
    // M3-3：格式选择（默认 bv*+ba/b）；仅音频（M3-10）
    if (opts.audioOnly) {
      args.push('-x', '--audio-format', opts.audioFormat ?? 'mp3')
      if (this.ffmpegOk) args.push('--embed-thumbnail')
    } else {
      args.push('-f', opts.formatId ?? 'bv*+ba/b')
      // M3-5：字幕/封面嵌入（ffmpeg 依赖）
      if (opts.embedSubs && this.ffmpegOk) args.push('--embed-subs', '--sub-langs', 'zh.*,en')
      if (opts.embedThumbnail && this.ffmpegOk) args.push('--embed-thumbnail')
    }
    args.push('--newline', '--no-mtime')
    args.push(
      '--progress-template',
      'download:@P|%(progress.downloaded_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s'
    )
    args.push('--concurrent-fragments', String(Math.min(64, Math.max(1, task.threads || 16))))
    if (this.ffmpegOk) {
      const { enginesDir } = await import('../orchestrator/binaries')
      args.push('--ffmpeg-location', enginesDir())
    }
    if (cookieFile) args.push('--cookies', cookieFile)
    if (isPlaylist) {
      // M3-4/8：N–M 集选择 + 上传者分目录 + 元数据 JSON/封面落盘
      args.push('--playlist-items', dedupeRanges(selection?.indexes ?? []))
      args.push('-o', join(task.saveDir, '%(uploader)s/%(title)s.%(ext)s'))
      args.push('--write-info-json', '--write-thumbnail')
    } else {
      // M4-11：全局命名模板（{{title}}/{{uploader}}/{{date}}/{{index:N}}）
      const { toYtDlpOutputTemplate, getNamingTemplate } = await import('../naming')
      args.push('-o', join(task.saveDir, toYtDlpOutputTemplate(getNamingTemplate())))
    }

    this.running.add(task.id)
    this.emit({ taskId: task.id, status: 'running', message: '开始下载' })
    this.argsByTask.set(task.id, { args, shortVideo: isShort, attempt: 1 })
    this.run(task, args, { shortVideo: isShort, video: opts, attempt: 1 })
    return task.id // engineGid = taskId（yt-dlp 无服务端 gid）
  }

  private run(
    task: Task,
    args: string[],
    ctx: { shortVideo: boolean; video: VideoSelection; attempt: number }
  ): void {
    this.supervisor.spawnTask(task.id, args, {
      isUserPaused: () => this.userPaused.has(task.id),
      onLine: (line) => this.parseProgress(task, line),
      onExit: (cls) => {
        void this.onExit(task, args, ctx, cls)
      }
    })
  }

  private parseProgress(task: Task, line: string): void {
    if (!line.startsWith('@P|')) return
    const [, downloaded, total, speed] = line.split('|')
    this.emit({
      taskId: task.id,
      status: 'running',
      downloadedBytes: Number(downloaded) || 0,
      totalBytes: Number(total) || 0,
      speedBps: Number(speed) || 0
    })
  }

  /** 退出分类处理：ok → completed（+L3）；短视频 error → L2 重试；其余 → failed */
  private async onExit(
    task: Task,
    args: string[],
    ctx: { shortVideo: boolean; video: VideoSelection; attempt: number },
    cls: 'ok' | 'error' | 'usage'
  ): Promise<void> {
    this.running.delete(task.id)

    if (this.userPaused.has(task.id)) {
      this.userPaused.delete(task.id)
      this.emit({ taskId: task.id, status: 'paused', message: '已暂停（.part 已保留）' })
      return
    }

    if (cls === 'ok') {
      // M4-12：完成文件完整性探测（ffprobe 读元数据，失败返回提示文案）
      const integrityMsg = await this.verifyIntegrity(task)
      // M3-6：wm_level 回填
      let wmLevel = ctx.video.delogo ? 'post' : ctx.shortVideo ? 'direct' : null
      let message = integrityMsg
      // M3-7 L3：delogo 后处理（产出 _nowm 副本，保留原件）。
      // P3 修复：此前 integrity/delogo/主完成各 emit 一次 completed → 系统通知刷 2~3 条；合并为一条
      if (ctx.shortVideo && ctx.video.delogo && this.ffmpegOk) {
        try {
          await this.delogoLatest(task)
          wmLevel = 'post'
          message = message ?? 'delogo 完成'
        } catch (err) {
          log.warn('delogo failed', err)
          message = message ?? 'delogo 失败，保留原片'
        }
      }
      this.emit({
        taskId: task.id,
        status: 'completed',
        wmLevel: wmLevel ?? undefined,
        message
      })
      this.cleanupTaskState(task.id)
      return
    }

    // M3-6 L2：短视频下载失败 → 移动端 UA 候补重试一次
    if (ctx.shortVideo && ctx.attempt === 1 && cls === 'error') {
      log.info(`L2 fallback retry for ${task.id}`)
      this.emit({
        taskId: task.id,
        status: 'running',
        wmLevel: 'fallback',
        message: 'L1 未命中，尝试移动端候补通道…'
      })
      const retryArgs = [
        ...args,
        '--extractor-args',
        'douyin:api=mobile',
        '--user-agent',
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15'
      ]
      this.run(task, retryArgs, { ...ctx, attempt: 2 })
      return
    }

    const tail = this.supervisor.getStderrTail(task.id).trim()
    const lastLine = tail.split('\n').pop() ?? ''
    // M4-17：结构化归因（五类 + 出口动作）
    const { diagnose } = await import('../diagnosis')
    const diagnosis = diagnose(`${tail} ${lastLine}`)
    const msg =
      cls === 'usage'
        ? 'yt-dlp 参数错误（引擎版本不兼容？）。请尝试更新引擎。'
        : `${diagnosis.message}${lastLine ? `（${lastLine}）` : ''}`
    this.emit({ taskId: task.id, status: 'failed', error: msg })
    // Backlog：平台健康面板——视频提取失败写入健康注册表（cls=usage 属参数问题不计平台故障）
    if (cls !== 'usage') {
      const { recordPlatformFailure } = await import('../health')
      recordPlatformFailure(
        'ytdlp',
        diagnosis.kind,
        msg,
        'yt-dlp',
        diagnosis.exitAction === 'update-engine' ? '尝试更新引擎（设置 → 更新）' : undefined
      )
    }
    this.cleanupTaskState(task.id)
  }

  /** 终态（completed/failed）清理：防长期运行 Map 只增不减（paused 保留参数供 resume） */
  private cleanupTaskState(taskId: string): void {
    this.argsByTask.delete(taskId)
    this.videoOpts.delete(taskId)
    this.shortVideo.delete(taskId)
    this.userPaused.delete(taskId)
    this.running.delete(taskId) // P3：remove 路径进程可能已死、onExit 不会再触发，防 Set 残留
    this.supervisor.dropTask(taskId)
  }

  /** M3-7 L3：对保存目录最新视频文件做 delogo（右上角 15%×8%），产出 _nowm 副本 */
  private async delogoLatest(task: Task): Promise<void> {
    const { readdir } = await import('fs/promises')
    const { spawn } = await import('child_process')
    const { toolPath } = await import('../orchestrator/binaries')

    const entries = await readdir(task.saveDir)
    const video = await newestVideo(
      entries.filter((f) => /\.(mp4|mkv|webm|mov)$/i.test(f) && !f.includes('_nowm')),
      task.saveDir
    )
    if (!video) return
    const out = video.replace(/(\.\w+)$/, '_nowm$1')
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(
        toolPath('ffmpeg'),
        [
          '-y',
          '-i',
          video,
          '-vf',
          'delogo=x=iw*0.85:y=ih*0.02:w=iw*0.15:h=ih*0.08',
          '-c:a',
          'copy',
          out
        ],
        { windowsHide: true }
      )
      proc.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`))))
      proc.on('error', reject)
    })
  }

  /** M4-12：ffprobe 完整性探测（可探测项失败 → 返回标黄提示文案，不判失败） */
  private async verifyIntegrity(task: Task): Promise<string | undefined> {
    try {
      const { readdir } = await import('fs/promises')
      const { spawn } = await import('child_process')
      const { toolPath } = await import('../orchestrator/binaries')
      const entries = await readdir(task.saveDir)
      const video = await newestVideo(
        entries.filter((f) => /\.(mp4|mkv|webm|mov)$/i.test(f)),
        task.saveDir
      )
      if (!video) return
      const probe = toolPath('ffprobe')
      const out = await new Promise<string>((resolve) => {
        const proc = spawn(probe, [
          '-v', 'error', '-show_entries', 'format=duration', '-of', 'json', video
        ], { windowsHide: true })
        let stdout = ''
        proc.stdout?.on('data', (d: Buffer) => (stdout += String(d)))
        proc.on('exit', (code) => resolve(code === 0 ? stdout : ''))
        proc.on('error', () => resolve(''))
      })
      const duration = Number((JSON.parse(out || '{}') as { format?: { duration?: string } }).format?.duration ?? 0)
      if (duration <= 0) {
        return '完整性探测未通过：文件可能损坏，点击重试可重新下载。'
      }
    } catch {
      // 探测失败不影响完成语义（可选项）
    }
    return undefined
  }

  // ── control（§4.1 语义）────────────────────────────────────────────

  pause(task: Task): boolean {
    if (!this.running.has(task.id)) return false
    this.userPaused.add(task.id)
    return this.supervisor.pause(task.id)
  }

  /** resume：同参数重 spawn（恢复凭据是任务参数本身，§4.1） */
  resume(task: Task): boolean {
    const entry = this.argsByTask.get(task.id)
    if (!entry) return false
    this.run(task, entry.args, {
      shortVideo: entry.shortVideo,
      video: this.videoOpts.get(task.id) ?? {},
      attempt: 1
    })
    return true
  }

  remove(task: Task): void {
    this.userPaused.delete(task.id)
    this.supervisor.pause(task.id)
    this.cleanupTaskState(task.id)
  }

  isRunning(taskId: string): boolean {
    return this.running.has(taskId)
  }

  /** confirm 时登记视频参数 */
  setVideoOptions(taskId: string, video: VideoSelection): void {
    this.videoOpts.set(taskId, video)
  }

  markShortVideo(taskId: string): void {
    this.shortVideo.add(taskId)
  }
}

function pickSize(f?: VideoFormat): number {
  return f?.filesize ?? 0
}

/** 目录内最新的视频文件（按 mtime，字典序在时间戳命名之外不可靠） */
async function newestVideo(names: string[], saveDir: string): Promise<string | null> {
  const { stat } = await import('fs/promises')
  const { join } = await import('path')
  let best: { path: string; m: number } | null = null
  for (const f of names) {
    const p = join(saveDir, f)
    const m = await stat(p).then((s) => s.mtimeMs).catch(() => 0)
    if (!best || m > best.m) best = { path: p, m }
  }
  return best?.path ?? null
}

function sanitize(name: string): string {
  // 统一清洗（保留名/控制字符/尾点空格/超长），额外处理路径分隔符与 `/`
  return sanitizeFilename(name.replace(/[\\/]/g, '_')) || 'untitled'
}

/** 索引数组 → yt-dlp --playlist-items 语法（1,3,5-10，§4.2） */
function dedupeRanges(indexes: number[]): string {
  const sorted = [...new Set(indexes)].sort((a, b) => a - b)
  const parts: string[] = []
  let start = sorted[0]!
  let prev = sorted[0]!
  for (let i = 1; i <= sorted.length; i++) {
    const cur = sorted[i] ?? Number.NaN
    if (cur !== prev + 1) {
      parts.push(start === prev ? `${start}` : `${start}-${prev}`)
      start = cur
    }
    prev = cur
  }
  return parts.join(',')
}
