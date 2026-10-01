// 250ms 事件合并器（§6.1 性能约定）：
// 同一任务在窗口内的多次进度更新合并为一条，整窗口批量推送渲染层。

import type { TaskEvent } from '@shared/types'
import { createLogger } from '../logger'

const log = createLogger('events')

export class TaskEventMerger {
  private buffer = new Map<string, TaskEvent>()
  private timer: NodeJS.Timeout | null = null

  constructor(
    private readonly windowMs = 250,
    private readonly flush: (events: TaskEvent[]) => void
  ) {}

  push(event: TaskEvent): void {
    const prev = this.buffer.get(event.taskId)
    this.buffer.set(event.taskId, { ...prev, ...event })
    if (!this.timer) {
      this.timer = setTimeout(() => this.drain(), this.windowMs)
    }
  }

  private drain(): void {
    this.timer = null
    if (this.buffer.size === 0) return
    const events = [...this.buffer.values()]
    this.buffer.clear()
    try {
      this.flush(events)
    } catch (err) {
      // 定时器回调内上抛 = uncaughtException 崩主进程：记录并放弃本窗口事件
      log.error('event flush failed', err)
    }
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer)
    this.drain()
  }
}
