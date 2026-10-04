// 音乐引擎聚合层（engine.py 的等价 TS 移植，运行于 Electron 主进程内）
// - 聚合搜索：五平台候选 + 原唱校验 + 原版度打分（口径与脚本同源）
// - 下载：真取消（AbortSignal 贯穿所有网络请求），取消后清理产物
// - 试听：网易云镜像直链（经 omniget-preview:// 协议流式代理）

import { dirname, extname, join } from 'path'
import { rename, stat, unlink } from 'fs/promises'
import type { MusicSearchResult, ServiceEvent } from '@shared/types'
import { createLogger } from '../logger'
import { HostGate } from './gate'
import { isTrustedAudioHost } from './http'
import { DEFAULT_TEMPLATE, getNamingTemplate, renderNamingTemplate } from '../naming'
import {
  PlatformEngine,
  PLATFORM_LABELS,
  artistMatches,
  sanitizeName,
  scoreOriginality,
  tryAllPlatforms,
  type PlatformSong,
  type Quality
} from './platforms'

/** 自然语言解析（与脚本解析器同源口径）：'陈奕迅的孤勇者' / '陈奕迅,孤勇者' / '陈奕迅 - 孤勇者' */
export function parseQuery(q: string): { artist: string; song: string } {
  const query = q.trim()
  for (const sep of ['的', ' - ', '-', ',', '，', '、']) {
    if (query.includes(sep)) {
      const idx = query.indexOf(sep)
      const artist = query.slice(0, idx).trim()
      const song = query.slice(idx + sep.length).trim()
      if (artist && song) return { artist, song }
    }
  }
  const parts = query.split(/\s+/)
  if (parts.length === 2 && parts[0] && parts[1]) {
    return { artist: parts[0].trim(), song: parts[1].trim() }
  }
  return { artist: '', song: query }
}

export interface MusicJob {
  id: string
  status: 'running' | 'completed' | 'failed' | 'cancelling'
  controller: AbortController
  pipeline: string
  warnings: string[]
}

export interface MusicDownloadResult {
  success: boolean
  source: string
  message: string
  mp3Path: string
  lrcPath: string
  bytes?: number
}

const log = createLogger('music-engine')

export class MusicEngine {
  private gate = new HostGate(1000)
  private jobs = new Map<string, MusicJob>()

  getJob(id: string): MusicJob | undefined {
    return this.jobs.get(id)
  }

  private makeEngine(signal?: AbortSignal): PlatformEngine {
    return new PlatformEngine({
      gate: this.gate,
      signal,
      // 引擎内部日志统一走分级 logger（dev 同时镜像控制台），不再裸 console
      log: (msg) => log.info(msg)
    })
  }

  /** 聚合搜索（§4.4）：五平台候选 + 原唱命中优先 + 原版度降序；60s 总 deadline */
  async search(q: string, limit = 8): Promise<MusicSearchResult> {
    const { artist, song } = parseQuery(q)
    const keyword = `${artist} ${song}`.trim() || q
    const controller = new AbortController()
    const deadline = setTimeout(() => controller.abort(), 60_000)
    try {
      return await this.searchWith(q, keyword, artist, song, limit, controller.signal)
    } finally {
      clearTimeout(deadline)
    }
  }

  private async searchWith(
    originalQuery: string,
    keyword: string,
    artist: string,
    song: string,
    limit: number,
    signal: AbortSignal
  ): Promise<MusicSearchResult> {
    const engine = this.makeEngine(signal)
    const candidates: MusicSearchResult['candidates'] = []
    const degraded: string[] = []

    const plan: Array<['netease' | 'qq' | 'kugou' | 'migu' | 'soda', (kw: string, lim: number) => Promise<PlatformSong[]>]> = [
      ['netease', (kw, lim) => engine.searchNetease(kw, lim)],
      ['qq', (kw, lim) => engine.searchQq(kw, lim)],
      ['kugou', (kw, lim) => engine.searchKugou(kw, lim)],
      ['migu', (kw, lim) => engine.searchMigu(kw, lim)],
      ['soda', (kw, lim) => engine.searchSoda(kw, lim)]
    ]
    for (const [platform, fn] of plan) {
      let rows: PlatformSong[] = []
      try {
        rows = (await fn(keyword, limit)) ?? []
      } catch (err) {
        // 平台降级必须留痕（此前静默吞掉，无法排查"为什么搜不到"）
        log.warn(`搜索平台 ${platform} 降级`, { error: String(err) })
        rows = []
      }
      if (!rows.length) {
        degraded.push(platform)
        continue
      }
      for (const row of rows.slice(0, limit)) {
        const name = row.name ?? ''
        const rowArtist = row.artist ?? ''
        candidates.push({
          platform,
          platformLabel: PLATFORM_LABELS[platform] ?? platform,
          id: String(row.id ?? ''),
          name,
          artist: rowArtist,
          artistMatch: artist ? artistMatches(rowArtist, artist) : true,
          originality: scoreOriginality(name, song),
          durationMs: row.durationMs,
          album: row.album
        })
      }
    }
    candidates.sort(
      // 第六轮审查：升序比较把 artistMatch=false（0）排在 true（1）之前——原唱
      // 沉底且被 slice 截掉，与注释「原唱命中优先」相反；改降序
      (a, b) => Number(b.artistMatch) - Number(a.artistMatch) || b.originality - a.originality
    )
    return {
      query: originalQuery,
      parsed: { artist, song },
      candidates: candidates.slice(0, limit * 2),
      degraded
    }
  }

  private registerJob(jobId: string, pipeline = ''): MusicJob {
    const job: MusicJob = {
      id: jobId,
      status: 'running',
      controller: new AbortController(),
      pipeline,
      warnings: []
    }
    this.jobs.set(jobId, job)
    return job
  }

  /** 下载（artist+song），进度/完成经 onEvent 推送（ServiceEvent 形状与原服务端一致） */
  async download(
    jobId: string,
    input: { artist?: string; song?: string; q?: string; quality: string; saveDir: string },
    onEvent: (ev: ServiceEvent) => void
  ): Promise<MusicDownloadResult> {
    const job = this.registerJob(jobId)
    const emit = (kind: string, platform: string, message: string): void => {
      onEvent({
        type: kind === 'warning' ? 'music.warning' : 'music.progress',
        taskId: jobId,
        platform,
        platformLabel: PLATFORM_LABELS[platform] ?? platform,
        message
      })
    }
    try {
      let { artist, song } = input
      // 口径对齐 Python engine.download：artist/song 缺一即从拼接串或 q 解析
      //（覆盖 manager 传整行 song 的场景，如 '陈奕迅的孤勇者'）
      if (!artist || !song) {
        const source = input.q ?? `${artist ?? ''} ${song ?? ''}`.trim()
        if (source) {
          const parsed = parseQuery(source)
          artist = artist || parsed.artist
          song = song || parsed.song
        }
      }
      const quality: Quality = (['standard', 'high', 'lossless'] as const).includes(
        input.quality as Quality
      )
        ? (input.quality as Quality)
        : 'high'

      const result = await tryAllPlatforms(
        this.makeEngine(job.controller.signal),
        artist ?? '',
        song ?? '',
        input.saveDir,
        quality,
        (ev) => emit(ev.type, ev.platform, ev.message),
        job.controller.signal
      )
      if (this.isCancelled(job)) {
        // R4-P2：cached 命中的是既有文件（可能是并发同歌任务刚产出的）——
        // 取消清理只删本任务真实落盘的产物，否则会误删他人文件
        if (!result.cached) await this.cleanupArtifacts(result)
        return this.cancelledResult()
      }
      const out: MusicDownloadResult = {
        success: result.success,
        source: result.source,
        message: result.message,
        mp3Path: result.mp3Path,
        lrcPath: result.lrcPath
      }
      if (out.success && out.mp3Path) {
        // 第七轮审查 P2：cached 产物（既有文件，可能属于并发同歌任务/用户早前
        // 下载）不得改名——改名会让引用旧路径的记录/并发任务悬空
        if (!result.cached) {
          const renamed = await this.applyNaming(out.mp3Path, out.lrcPath ?? '', artist ?? '', song ?? '')
          out.mp3Path = renamed.mp3
          out.lrcPath = renamed.lrc
        }
        // M-5：rename 阶段不可中断——改名成功后再次复核取消状态，
        // 并用改名后的路径清理（否则清的是改名前路径，产物复活成孤儿）
        if (this.isCancelled(job)) {
          // 第七轮审查 P2：cached 命中在二次复核同样不得清理（补齐 R4-P2 漏网）
          if (!result.cached) {
            await this.cleanupArtifacts({ mp3Path: out.mp3Path, lrcPath: out.lrcPath })
          }
          return this.cancelledResult()
        }
        out.bytes = await stat(out.mp3Path).then((s) => s.size).catch(() => 0)
      }
      job.status = out.success ? 'completed' : 'failed'
      if (out.success) log.info(`音乐下载完成: ${out.message} → ${out.mp3Path}`)
      else log.error(`音乐下载失败: ${out.message}`)
      return out
    } catch (err) {
      if (job.controller.signal.aborted) return this.cancelledResult()
      const message = err instanceof Error ? err.message : String(err)
      log.error('音乐下载异常', { error: message })
      return {
        success: false,
        source: '',
        message,
        mp3Path: '',
        lrcPath: ''
      }
    } finally {
      this.jobs.delete(jobId)
    }
  }

  private isCancelled(job: MusicJob): boolean {
    return job.controller.signal.aborted || job.status === 'cancelling'
  }

  private cancelledResult(): MusicDownloadResult {
    return { success: false, source: '', message: '任务已取消', mp3Path: '', lrcPath: '' }
  }

  private async cleanupArtifacts(result: { mp3Path?: string; lrcPath?: string }): Promise<void> {
    for (const p of [result.mp3Path, result.lrcPath]) {
      if (p) await unlink(p).catch(() => {})
    }
  }

  /** M4-11：音乐完成重命名（naming.template 非默认时生效；{{title}}=歌名 {{artist}}=歌手）。
   *  返回最终 mp3 路径；lrc 同步改名；目标冲突时追加序号防覆盖。 */
  private async applyNaming(
    mp3Path: string,
    lrcPath: string,
    artist: string,
    song: string
  ): Promise<{ mp3: string; lrc: string }> {
    const tpl = getNamingTemplate().trim()
    if (!tpl || tpl === DEFAULT_TEMPLATE || !mp3Path) return { mp3: mp3Path, lrc: lrcPath }
    const base =
      sanitizeName(renderNamingTemplate(tpl, { title: song, artist }).replace(/\.{2,}/g, '.')) ||
      sanitizeName(song)
    const dir = dirname(mp3Path)
    const ext = extname(mp3Path)
    const preferred = join(dir, base + ext)
    if (preferred === mp3Path) return { mp3: mp3Path, lrc: lrcPath }
    let final = preferred
    for (let n = 2; n < 50; n++) {
      const exists = await stat(final).then(() => true).catch(() => false)
      if (!exists) break
      final = join(dir, `${base} (${n})${ext}`)
    }
    // P3 加固：序号探测耗尽时 final 可能仍指向已存在文件——直接 rename 会覆盖用户同名文件
    const targetExists = await stat(final).then(() => true).catch(() => false)
    if (targetExists) return { mp3: mp3Path, lrc: lrcPath } // 放弃重命名，保留引擎原生命名
    const renamed = await rename(mp3Path, final)
      .then(() => true)
      .catch(() => false)
    if (!renamed) return { mp3: mp3Path, lrc: lrcPath } // 重命名失败不视为下载失败
    const lrcFinal = final.replace(/\.\w+$/, '.lrc')
    if (lrcPath) await rename(lrcPath, lrcFinal).catch(() => {})
    return { mp3: final, lrc: lrcFinal }
  }

  /** F1：按网易云 ID 精确下载（搜索降级时的可靠通道） */
  async downloadById(
    jobId: string,
    input: { neteaseId: string; artist?: string; song?: string; quality: string; saveDir: string },
    onEvent: (ev: ServiceEvent) => void
  ): Promise<MusicDownloadResult> {
    const job = this.registerJob(jobId, 'netease')
    const emit = (kind: string, platform: string, message: string): void => {
      onEvent({
        type: kind === 'warning' ? 'music.warning' : 'music.progress',
        taskId: jobId,
        platform,
        platformLabel: PLATFORM_LABELS[platform] ?? platform,
        message
      })
    }
    try {
      const quality: Quality = (['standard', 'high', 'lossless'] as const).includes(
        input.quality as Quality
      )
        ? (input.quality as Quality)
        : 'high'
      // 防注入：ID 直接内插镜像 API URL，必须纯数字
      const nid = input.neteaseId.trim()
      if (!/^\d{1,20}$/.test(nid)) {
        return {
          success: false,
          source: '',
          message: `无效的歌曲 ID: ${input.neteaseId.slice(0, 40)}`,
          mp3Path: '',
          lrcPath: ''
        }
      }
      const engine = this.makeEngine(job.controller.signal)
      const detail = await engine.getNeteaseDetail(nid)
      const artist = (input.artist || detail.artist || '未知歌手').trim()
      const song = (input.song || detail.name || nid).trim()
      const filename = sanitizeName(`${artist} - ${song}`)
      const mp3Path = join(input.saveDir, `${filename}.mp3`)
      const lrcPath = join(input.saveDir, `${filename}.lrc`)
      emit('progress', 'netease', '尝试 网易云（按 ID 精确下载）…')
      const ok = await engine.downloadNeteaseById(nid, mp3Path, lrcPath, quality)
      // 回归审查 P2：exists 兜底命中的产物非本任务落盘（lastProductForeign，可能
      // 属于并发同歌任务/用户既有下载）——取消清理不得误删 mp3（lrc 为本任务写入可删）
      const foreign = engine.lastProductForeign
      if (this.isCancelled(job) || !ok) {
        if (this.isCancelled(job)) {
          if (!foreign) await unlink(mp3Path).catch(() => {})
          await unlink(lrcPath).catch(() => {})
          return this.cancelledResult()
        }
        return {
          success: false,
          source: '',
          message: `按ID下载音频失败: ${input.neteaseId}`,
          mp3Path: '',
          lrcPath: ''
        }
      }
      log.info(`音乐按 ID 下载完成: 网易云:${nid} → ${mp3Path}`)
      // foreign/cached 既有产物不改名（与 download 路径的 cached 口径一致——
      // 改名会让引用旧路径的记录/并发任务悬空）
      const final = foreign
        ? { mp3: mp3Path, lrc: lrcPath }
        : await this.applyNaming(mp3Path, lrcPath, artist, song)
      // R4-P3：与 download 的 M-5 口径对齐——rename 后再次复核取消，
      // 否则取消落在改名期间会留下孤儿产物（completed 态必须在复核后落位，
      // 否则 rename 期间 cancel() 会被拒、复核永假）
      if (this.isCancelled(job)) {
        if (!foreign) await this.cleanupArtifacts({ mp3Path: final.mp3, lrcPath: final.lrc })
        return this.cancelledResult()
      }
      job.status = 'completed'
      const finalBase = final.mp3.replace(/\\/g, '/').split('/').pop() ?? filename
      return {
        success: true,
        source: '网易云(按ID)',
        message: `网易云: ${finalBase.replace(/\.\w+$/, '')}`,
        mp3Path: final.mp3,
        lrcPath: final.lrc,
        bytes: await stat(final.mp3).then((s) => s.size).catch(() => 0)
      }
    } catch (err) {
      if (job.controller.signal.aborted) return this.cancelledResult()
      const message = err instanceof Error ? err.message : String(err)
      log.error('音乐按 ID 下载异常', { error: message })
      return {
        success: false,
        source: '',
        message,
        mp3Path: '',
        lrcPath: ''
      }
    } finally {
      this.jobs.delete(jobId)
    }
  }

  /** 真取消：AbortSignal 即刻中断网络请求；false = 任务已终结 */
  cancel(jobId: string): boolean {
    const job = this.jobs.get(jobId)
    if (!job) return false
    if (job.status === 'completed' || job.status === 'failed') return false
    job.status = 'cancelling'
    job.controller.abort()
    return true
  }

  /** 应用退出：abort 全部在途下载（不留 .part 残留；事件监听器随进程销毁） */
  shutdown(): void {
    for (const job of this.jobs.values()) {
      if (job.status === 'running') job.controller.abort()
    }
  }

  /** F1 试听：网易云镜像直链（protocol 层流式代理给 <audio>）。
   *  安全：sid 必须纯数字、quality 白名单、返回 URL 必须落在可信音频域内。 */
  async previewUrl(platform: string, sid: string, quality = 'standard'): Promise<string | null> {
    if (platform !== 'netease' || !/^\d{1,20}$/.test(sid)) return null
    if (!(['standard', 'high', 'lossless'] as const).includes(quality as Quality)) return null
    // 第七轮审查 P3：试听链路补总 deadline（与 search 60s 同口径）——四镜像 ×
    // 每镜像 3 次重试在最坏黑洞网络下可达数分钟，渲染层 IPC 无超时兜底
    const controller = new AbortController()
    const deadline = setTimeout(() => controller.abort(), 45_000)
    let url: string
    try {
      const engine = this.makeEngine(controller.signal)
      url = await engine.previewNetease(sid, quality)
    } catch (err) {
      // 回归审查 P3：deadline/引擎异常留痕——否则渲染层只见 404，无法归因
      //「是超时还是镜像全空返回」
      log.warn(`preview url failed (sid=${sid}): ${err instanceof Error ? err.message : String(err)}`)
      return null
    } finally {
      clearTimeout(deadline)
    }
    if (!url || !url.startsWith('http')) return null
    try {
      if (!isTrustedAudioHost(new URL(url).hostname)) return null
    } catch {
      return null
    }
    return url
  }
}

let instance: MusicEngine | null = null

/** 单例（预览协议与适配器共享 host 门控与任务注册表） */
export function getMusicEngine(): MusicEngine {
  if (!instance) instance = new MusicEngine()
  return instance
}
