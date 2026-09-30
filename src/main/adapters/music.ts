// 音乐适配器（M2-6，§4.4）：主进程 ↔ omni-service REST 代理；
// WS 事件由 ServiceSupervisor 接收后经 onEvent 回调进入任务流（manager.applyMusicEvent）。

import type { MusicSearchInput, MusicSearchResult, ServiceEvent } from '@shared/types'
import type { ServiceSupervisor } from '../orchestrator/service'

export interface MusicDownloadRequest {
  artist?: string
  song?: string
  q?: string
  /** F1：ID 精确下载（§4.4 兜底通道），走 /api/music/download-by-id */
  neteaseId?: string
  quality: string
  saveDir: string
}

export class MusicAdapter {
  constructor(private readonly supervisor: ServiceSupervisor) {}

  get isOnline(): boolean {
    return this.supervisor.isOnline
  }

  private base(): string {
    return `http://127.0.0.1:${this.supervisor.port}`
  }

  private headers(): Record<string, string> {
    return { 'Content-Type': 'application/json', 'X-Omni-Token': this.supervisor.token }
  }

  async health(): Promise<boolean> {
    try {
      const res = await fetch(`${this.base()}/health`, { signal: AbortSignal.timeout(3000) })
      return res.ok
    } catch {
      return false
    }
  }

  /** §4.4 GET /api/music/search（自然语言解析在服务端，与脚本解析器同源） */
  async search(input: MusicSearchInput): Promise<MusicSearchResult> {
    const res = await fetch(
      `${this.base()}/api/music/search?q=${encodeURIComponent(input.q)}`,
      { headers: this.headers(), signal: AbortSignal.timeout(30_000) }
    )
    if (!res.ok) throw new Error(`音乐搜索失败（HTTP ${res.status}），请稍后重试`)
    return (await res.json()) as MusicSearchResult
  }

  /** POST /api/music/download（或 download-by-id）→ 202 {taskId}（omni-service 任务 id，存 engineGid） */
  async download(req: MusicDownloadRequest): Promise<string> {
    const byId = Boolean(req.neteaseId)
    const res = await fetch(
      `${this.base()}/api/music/download${byId ? '-by-id' : ''}`,
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(req),
        signal: AbortSignal.timeout(15_000)
      }
    )
    if (!res.ok) throw new Error(`音乐下载提交失败（HTTP ${res.status}），请稍后重试`)
    const data = (await res.json()) as { taskId: string }
    return data.taskId
  }

  /** F1 试听：返回经服务代理的预览流 URL（<audio> 可直接播放，走 16801 符合 CSP） */
  previewUrl(platform: string, sid: string): string {
    return `${this.base()}/api/music/preview?platform=${encodeURIComponent(
      platform
    )}&id=${encodeURIComponent(sid)}&token=${this.supervisor.token}`
  }

  /** GET /api/music/task/{id}（恢复时查询服务端任务状态） */
  async getTask(serviceTaskId: string): Promise<Record<string, unknown> | null> {
    try {
      const res = await fetch(
        `${this.base()}/api/music/task/${serviceTaskId}`,
        { headers: this.headers(), signal: AbortSignal.timeout(5000) }
      )
      if (!res.ok) return null
      return (await res.json()) as Record<string, unknown>
    } catch {
      return null
    }
  }

  /** 协作式取消：标记 cancelling，引擎线程完成后由服务端删除产物 */
  async cancel(serviceTaskId: string): Promise<boolean> {
    try {
      const res = await fetch(
        `${this.base()}/api/music/task/${serviceTaskId}/cancel`,
        { method: 'POST', headers: this.headers(), signal: AbortSignal.timeout(5000) }
      )
      if (!res.ok) return false
      const data = (await res.json()) as { ok?: boolean }
      return data.ok === true
    } catch {
      return false
    }
  }
}

export function isServiceEvent(msg: unknown): msg is ServiceEvent {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    'type' in msg &&
    typeof (msg as ServiceEvent).type === 'string' &&
    (msg as ServiceEvent).type.startsWith('music.')
  )
}
