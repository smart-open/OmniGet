// 250ms 事件合并器（§6.1 性能约定）：
// 同一任务在窗口内的多次进度更新合并为一条，整窗口批量推送渲染层。

import type { TaskEvent } from '@shared/types'

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
    this.flush(events)
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer)
    this.drain()
  }
}
