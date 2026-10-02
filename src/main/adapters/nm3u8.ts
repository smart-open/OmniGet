// N_m3u8DL-RE 适配器（backlog #17 第二阶段，§4.3 同型 yt-dlp 适配器）
// parse：主进程拉取清单文本 → master 变体列表（对话框格式选择）/媒体单轨
// start：spawn N_m3u8DL-RE（-M format=mp4 混流；ffmpeg 经 PATH 注入自动发现）
// 进度：非 TTY 模式逐行输出分片进度 `N/M xx%`；exit 0 = 完成
// pause：SIGTERM（临时分片保留，RE 重跑自动跳过已下分片）；resume：同参数重 spawn
//
// 选项均经 v0.6.0-beta 真机 --help 核实（2026-06-29 构建），实测真实 m3u8 E2E 通过。

import type { Task, TaskEvent, VideoFormat } from '@shared/types'
import { stat } from 'fs/promises'
import { join } from 'path'
import { sanitizeFilename } from '@shared/sanitize'
import { createLogger } from '../logger'
import { binaryPath, ensureVerified } from '../orchestrator/binaries'
import { getYtDlpSupervisor } from '../orchestrator/ytdlp'
import { escapeRegex, parseHlsManifest } from './nm3u8-parse'
import type { ParseOutput } from './types'

const log = createLogger('nm3u8-adapter')

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

const MAX_MANIFEST_BYTES = 8 * 1024 * 1024

/** 拉取清单文本（带 UA、15s 超时、8MB 上限——防异常端点撑爆内存） */
async function fetchManifestText(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { 'user-agent': BROWSER_UA, accept: '*/*' },
    redirect: 'follow',
    signal: AbortSignal.timeout(15_000)
  })
  if (!res.ok) throw new Error(`清单获取失败（HTTP ${res.status}）`)
  const reader = res.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_MANIFEST_BYTES) {
      await reader.cancel().catch(() => {})
      throw new Error('清单文件超出 8MB 上限')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function nameFromUrl(url: string): string {
  try {
    const seg = new URL(url).pathname.split('/').pop() ?? ''
    const base = decodeURIComponent(seg).replace(/\.(m3u8|m3u|mpd)$/i, '')
    return base || 'stream'
  } catch {
    return 'stream'
  }
}

/** 审查修复：master 直播清单漏判——ENDLIST 只出现在媒体清单，master 文本永远没有。
 * 补探测首个变体（按最高清排序前的原始顺序取第一条）的媒体清单是否含 ENDLIST；
 * 探测失败按非直播回落（宁可不显示录制选项，也不给 VOD 误标直播） */
async function probeMasterLive(masterUrl: string, info: ReturnType<typeof parseHlsManifest>): Promise<boolean> {
  const first = info.variants[0]
  if (!first) return false
  try {
    const abs = new URL(first.uri, masterUrl).toString()
    const text = await fetchManifestText(abs)
    return !/#EXT-X-ENDLIST/i.test(text)
  } catch {
    return false
  }
}

export interface Nm3u8Selection {
  /** master 变体 URI（parse 返回的 formatId；空 = 自动最佳轨道） */
  formatId?: string
  /** R7 续（backlog #20）：直播录制时长（分钟；仅 live 流生效） */
  liveRecordMinutes?: number
}

export class Nm3u8Adapter {
  private supervisor = getYtDlpSupervisor()
  private sink: ((e: TaskEvent) => void) | null = null
  /** 确认勾选时的选择（transient；恢复后走自动最佳） */
  private videoOpts = new Map<string, Nm3u8Selection>()
  private userPaused = new Set<string>()
  /** taskId → 预期产物绝对路径（RE 混流产物 = save-dir/<save-name>.mp4） */
  private outputFiles = new Map<string, string[]>()
  private argsByTask = new Map<string, { args: string[] }>()
  /** stdout 尾部（RE 日志走 stdout，失败归因用；stderr 之外的自留口径） */
  private lineTails = new Map<string, string>()

  setSink(cb: (e: TaskEvent) => void): void {
    this.sink = cb
  }

  private emit(e: TaskEvent): void {
    this.sink?.(e)
  }

  async health(): Promise<{ online: boolean; detail?: string }> {
    try {
      await ensureVerified('nm3u8re')
      const r = await this.supervisor.runAux(binaryPath('nm3u8re'), ['--version'], 10_000)
      const v = r.stdout.trim().split('\n')[0]?.trim()
      return v ? { online: true, detail: v } : { online: false, detail: 'N_m3u8DL-RE 不可用' }
    } catch {
      return { online: false, detail: 'N_m3u8DL-RE 不可用' }
    }
  }

  // ── parse ──────────────────────────────────────────────────────────

  async parse(task: Task): Promise<ParseOutput> {
    const text = await fetchManifestText(task.source)
    const info = parseHlsManifest(text)
    const formats: VideoFormat[] = []
    if (info.kind === 'master' && info.variants.length > 0) {
      for (const v of info.variants) {
        formats.push({
          formatId: v.uri,
          resolution: v.resolution ?? 'auto',
          ext: 'ts',
          tbr: v.bandwidth ? Math.round(v.bandwidth / 1000) : undefined,
          noWatermark: true
        })
      }
      formats.sort((a, b) => (parseInt(b.resolution) || 0) - (parseInt(a.resolution) || 0))
    } else {
      // media/MPD/unknown：单条目，RE 自动选最佳轨道
      formats.push({ formatId: '', resolution: 'auto', ext: 'ts', noWatermark: true })
    }
    log.info(`manifest parsed: kind=${info.kind}, variants=${info.variants.length}`)
    // R7 续（backlog #20）：media 清单且无 #EXT-X-ENDLIST = 直播流；
    // master 清单经变体探测补判（probeMasterLive，失败按非直播回落）
    const live =
      info.kind === 'media'
        ? !/#EXT-X-ENDLIST/i.test(text)
        : info.kind === 'master'
          ? await probeMasterLive(task.source, info)
          : false
    return {
      name: sanitizeFilename(nameFromUrl(task.source)),
      formats: formats.slice(0, 40),
      totalBytes: 0,
      duration: info.durationSec,
      live
    }
  }

  // ── start ──────────────────────────────────────────────────────────

  async start(task: Task): Promise<string> {
    await ensureVerified('nm3u8re')
    const opts = this.videoOpts.get(task.id) ?? {}
    const args = this.buildArgs(task, opts)
    this.emit({ taskId: task.id, status: 'running', message: '开始下载' })
    this.argsByTask.set(task.id, { args })
    const saveName = sanitizeFilename(task.name || 'stream')
    this.outputFiles.set(task.id, [join(task.saveDir, `${saveName}.mp4`)])
    this.supervisor.spawnProcess(binaryPath('nm3u8re'), task.id, args, {
      isUserPaused: () => this.userPaused.has(task.id),
      onLine: (line) => this.ingestLine(task, line),
      onExit: (cls) => {
        this.onExit(task, cls).catch((err) => log.error(`onExit 后处理失败 ${task.id}`, err))
      }
    })
    return task.id // engineGid = taskId（CLI 无服务端 gid）
  }

  /** v0.6.0-beta 实测选项；分片选择用 url=<变体URI正则> 精确锁定 + 音频取最佳 */
  private buildArgs(task: Task, opts: Nm3u8Selection): string[] {
    const args = [
      task.source,
      '--save-dir',
      task.saveDir,
      '--save-name',
      sanitizeFilename(task.name || 'stream'),
      '--thread-count',
      String(Math.min(64, Math.max(1, task.threads || 16))),
      '-M',
      'format=mp4',
      '--no-ansi-color',
      '--ui-language',
      'zh-CN',
      '--disable-update-check'
    ]
    if (opts.formatId) {
      args.push('-sv', `url=${escapeRegex(opts.formatId)}:for=best`, '-sa', 'for=best')
    } else {
      args.push('--auto-select')
    }
    // R7 续（backlog #20）：直播录制（选项经 v0.6.0-beta --help 核实）
    if (opts.liveRecordMinutes && opts.liveRecordMinutes > 0) {
      const m = Math.min(24 * 60, Math.floor(opts.liveRecordMinutes))
      args.push(
        '--live-real-time-merge',
        '--live-record-limit',
        `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00`
      )
      log.info(`live record limit: ${m} min`)
    }
    return args
  }

  private ingestLine(task: Task, line: string): void {
    const tail = ((this.lineTails.get(task.id) ?? '') + '\n' + line).slice(-1500)
    this.lineTails.set(task.id, tail)
    // 非 TTY 进度帧：`Vid ━━━ 12/15 80.0% ...`（实测格式）
    const m = /(\d+)\/(\d+)\s+([\d.]+)\s*%/.exec(line)
    if (m) {
      const pct = Math.min(100, Math.round(Number(m[3])))
      this.emit({
        taskId: task.id,
        status: 'running',
        message: `下载中 ${pct}%（${m[1]}/${m[2]} 分片）`
      })
    }
  }

  private async onExit(task: Task, cls: 'ok' | 'error' | 'usage'): Promise<void> {
    if (this.userPaused.has(task.id)) {
      this.userPaused.delete(task.id)
      this.emit({ taskId: task.id, status: 'paused', message: '已暂停（临时分片已保留）' })
      return
    }
    if (cls === 'ok') {
      // 混流产物（<save-name>.mp4）实际大小回填——任务列表进度与完成记账用
      let size = 0
      for (const p of this.outputFiles.get(task.id) ?? []) {
        size = Math.max(size, await stat(p).then((s) => s.size).catch(() => 0))
      }
      this.emit({ taskId: task.id, status: 'completed', downloadedBytes: size, totalBytes: size })
      const { recordPlatformOk } = await import('../health')
      recordPlatformOk('hls', 'nm3u8')
      this.cleanupTaskState(task.id)
      return
    }
    const tail = (this.lineTails.get(task.id) ?? '').trim()
    const last = tail.split('\n').filter(Boolean).pop() ?? ''
    const msg = `HLS 下载失败：${last || '进程异常退出'}`
    this.emit({ taskId: task.id, status: 'failed', error: msg })
    const { recordPlatformFailure } = await import('../health')
    recordPlatformFailure('hls', 'http', msg, 'nm3u8')
    this.cleanupTaskState(task.id)
  }

  // ── control ────────────────────────────────────────────────────────

  pause(task: Task): boolean {
    this.userPaused.add(task.id)
    const ok = this.supervisor.pause(task.id)
    if (!ok) this.userPaused.delete(task.id)
    if (ok) this.warnLiveInterrupted(task.id)
    return ok
  }

  /** resume：同参数重 spawn（RE 凭 tmp 目录跳过已下分片续传） */
  resume(task: Task): boolean {
    const entry = this.argsByTask.get(task.id)
    if (!entry) return false
    this.emit({ taskId: task.id, status: 'running', message: '继续下载' })
    this.supervisor.spawnProcess(binaryPath('nm3u8re'), task.id, entry.args, {
      isUserPaused: () => this.userPaused.has(task.id),
      onLine: (line) => this.ingestLine(task, line),
      onExit: (cls) => {
        this.onExit(task, cls).catch((err) => log.error(`onExit 后处理失败 ${task.id}`, err))
      }
    })
    return true
  }

  remove(task: Task): void {
    // 先标记 userPaused——exit 走 paused 分支，不对已删除任务 emit failed
    this.userPaused.add(task.id)
    const paused = this.supervisor.pause(task.id)
    if (!paused) this.userPaused.delete(task.id)
    this.warnLiveInterrupted(task.id)
    this.cleanupTaskState(task.id, true)
  }

  /** 审查修复：Windows 上进程终止实际是 taskkill /F（orchestrator/proc.ts——
   * SIGTERM 映射 TerminateProcess），--live-real-time-merge 的 mp4 moov 不落盘 =
   * 手动中断的直播录制大概率无法播放，且直播流无「续传补 finalize」可能。
   * 引擎侧无法优雅终止（Node 在 Windows 无 SIGINT 投递），降级为明确告知用户 */
  private warnLiveInterrupted(taskId: string): void {
    if ((this.videoOpts.get(taskId)?.liveRecordMinutes ?? 0) <= 0) return
    void import('../ipc').then(({ broadcastNotices }) =>
      broadcastNotices([
        {
          level: 'warning',
          message:
            '直播录制已中断：混流文件可能未完成封装（无法播放）。建议等待设定的录制时长自然结束，或中断后重新录制。'
        }
      ])
    )
  }

  /** R4-P2 同型：精确产物路径（manager 落 task_files 用） */
  getOutputFiles(taskId: string): string[] {
    return this.outputFiles.get(taskId) ?? []
  }

  setVideoOptions(taskId: string, sel: Nm3u8Selection): void {
    this.videoOpts.set(taskId, sel)
  }

  /** 审查修复：回收站恢复前清除 remove() 遗留的 userPaused 标记——恢复后 RE 正常
   * 跑完若命中该标记会被误判为「已暂停」，完成记账/产物落库全部跳过 */
  clearPauseMark(taskId: string): void {
    this.userPaused.delete(taskId)
  }

  private cleanupTaskState(taskId: string, keepPauseMark = false): void {
    this.argsByTask.delete(taskId)
    this.videoOpts.delete(taskId)
    this.lineTails.delete(taskId)
    this.outputFiles.delete(taskId)
    if (!keepPauseMark) this.userPaused.delete(taskId)
    this.supervisor.dropTask(taskId)
  }
}
