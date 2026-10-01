// 任务状态机（M1-1，§4.1）
// 全部状态 + 转移守卫；非法转移直接抛错。
// 注记：awaiting 为可跳过状态（HTTP/音乐单曲 parsing 直达 queued）；
//       verifying → completed 默认路径；seeding 仅 seed-ratio>0 进入。

import type { TaskStatus } from '@shared/types'

const TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  parsing: ['awaiting', 'queued', 'failed'],
  awaiting: ['queued', 'failed'], // 取消 awaiting 任务 = failed（附取消文案）
  queued: ['running', 'paused', 'failed'],
  // M-4 修复：seeding 成为可达状态——BT 下载完成但仍在做种（aria2 status=active 且
  // completedLength >= totalLength）时进入 seeding，做种结束（ratio 达标）才 completed
  running: ['paused', 'verifying', 'seeding', 'completed', 'failed'],
  paused: ['queued', 'running', 'failed'],
  verifying: ['completed', 'failed'],
  seeding: ['completed', 'failed'],
  completed: [],
  failed: ['queued'] // 手动/自动重试
}

export class IllegalTransitionError extends Error {
  constructor(
    public from: TaskStatus,
    public to: TaskStatus
  ) {
    super(`非法状态转移：${from} -> ${to}`)
    this.name = 'IllegalTransitionError'
  }
}

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TRANSITIONS[from].includes(to)
}

/** 转移守卫：非法转移抛 IllegalTransitionError */
export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransition(from, to)) {
    throw new IllegalTransitionError(from, to)
  }
}
