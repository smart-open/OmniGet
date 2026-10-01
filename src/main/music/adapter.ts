// 本地音乐适配器（阶段1）：主进程内引擎直跑，替代 omni-service REST 代理。
// 事件契约保持 ServiceEvent 形状 → manager.applyMusicEvent 零改动；
// engineGid = 本地任务 id（取消/恢复语义一致）。

import { randomUUID } from 'crypto'
import type { MusicSearchInput, MusicSearchResult, ServiceEvent } from '@shared/types'
import { getMusicEngine } from './engine'
import { createLogger } from '../logger'

const log = createLogger('music-adapter')

export interface MusicDownloadRequest {
  artist?: string
  song?: string
  q?: string
  neteaseId?: string
  quality: string
  saveDir: string
}

export interface MusicAdapter {
  readonly isOnline: boolean
  search(input: MusicSearchInput): Promise<MusicSearchResult>
  download(req: MusicDownloadRequest): Promise<string>
  cancel(taskId: string): Promise<boolean>
  getTask(taskId: string): Promise<Record<string, unknown> | null>
  previewUrl(platform: string, sid: string): string
  onEvent(cb: (ev: ServiceEvent) => void): void
}

export class LocalMusicAdapter implements MusicAdapter {
  // 单例引擎：与预览协议共享 host 限速门与任务注册表
  private readonly engine = getMusicEngine()
  private listeners = new Set<(ev: ServiceEvent) => void>()

  readonly isOnline = true

  onEvent(cb: (ev: ServiceEvent) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private emit(ev: ServiceEvent): void {
    for (const cb of this.listeners) {
      try {
        cb(ev)
      } catch {
        // 单个监听方异常不阻断其他
      }
    }
  }

  async search(input: MusicSearchInput): Promise<MusicSearchResult> {
    return this.engine.search(input.q)
  }

  /** 启动异步下载任务：立即返回 jobId（存 engineGid），进度/完成经 onEvent 推送 */
  async download(req: MusicDownloadRequest): Promise<string> {
    const jobId = randomUUID().replace(/-/g, '')
    const byId = Boolean(req.neteaseId)
    // P3 修复：runJob 虽有内层兜底，但任何遗漏（emit 之外的字段访问抛错）
    // 都会成为 unhandledRejection——补 .catch 留痕成本极低
    void this.runJob(jobId, req, byId).catch((err) => {
      log.error(`music job ${jobId} crashed: ${err instanceof Error ? err.message : String(err)}`)
    })
    return jobId
  }

  private async runJob(jobId: string, req: MusicDownloadRequest, byId: boolean): Promise<void> {
    const result = byId
      ? await this.engine.downloadById(
          jobId,
          req as { neteaseId: string } & MusicDownloadRequest,
          (ev) => this.emit(ev)
        )
      : await this.engine.download(jobId, req, (ev) => this.emit(ev))
    this.emit({
      type: 'music.done',
      taskId: jobId,
      success: result.success,
      cancelled: result.message === '任务已取消',
      source: result.source,
      message: result.message,
      mp3Path: result.mp3Path,
      lrcPath: result.lrcPath,
      bytes: result.bytes ?? 0
    })
  }

  async cancel(taskId: string): Promise<boolean> {
    return this.engine.cancel(taskId)
  }

  async getTask(taskId: string): Promise<Record<string, unknown> | null> {
    const job = this.engine.getJob(taskId)
    return job ? { ...job, controller: undefined } : null
  }

  /** F1 试听：omniget-preview:// 协议 URL（主进程流式代理镜像音频，CSP 白名单内） */
  previewUrl(platform: string, sid: string): string {
    return `omniget-preview://music?platform=${encodeURIComponent(platform)}&id=${encodeURIComponent(
      sid
    )}&quality=standard`
  }
}
