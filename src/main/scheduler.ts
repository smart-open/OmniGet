// 定时/分时段调度（M4-15，§4.8 借鉴 AB Download Manager）
// 速度计划表：时段 → 全局限速档，主进程每分钟驱动，切换即时经 aria2 changeGlobalOption 生效。

import { getSetting, setSetting } from './db'
import { createLogger } from './logger'

const log = createLogger('scheduler')

export interface ScheduleRule {
  from: string // '09:00'
  to: string // '18:00'
  /** 限速档：'0' 不限 / '2M' / '500K' 等 aria2 限速格式 */
  limit: string
}

export function getScheduleRules(): ScheduleRule[] {
  try {
    return JSON.parse(getSetting('schedule.rules') ?? '[]') as ScheduleRule[]
  } catch {
    return []
  }
}

export function setScheduleRules(rules: ScheduleRule[]): void {
  setSetting('schedule.rules', JSON.stringify(rules))
}

function inRange(now: Date, rule: ScheduleRule): boolean {
  const [fh, fm] = rule.from.split(':').map(Number)
  const [th, tm] = rule.to.split(':').map(Number)
  const mins = now.getHours() * 60 + now.getMinutes()
  const from = (fh ?? 0) * 60 + (fm || 0)
  const to = (th ?? 0) * 60 + (tm || 0)
  // 支持跨天边界（22:00-06:00）
  return from <= to ? mins >= from && mins < to : mins >= from || mins < to
}

/** 当前应生效的限速档；无命中返回 null（保持当前值） */
export function currentLimit(now = new Date()): string | null {
  for (const rule of getScheduleRules()) {
    if (inRange(now, rule)) return rule.limit
  }
  return null
}

let timer: NodeJS.Timeout | null = null
let applied: string | null = null

/** 启动调度器：每分钟检查，值变化时经回调应用（aria2 changeGlobalOption） */
export function startScheduler(apply: (limit: string) => Promise<void> | void): void {
  stopScheduler()
  const tick = (): void => {
    const limit = currentLimit()
    if (limit !== null && limit !== applied) {
      applied = limit
      log.info(`schedule applied: ${limit}`)
      void apply(limit)
    } else if (limit === null && applied !== null) {
      // 计划表整体清空/时段结束：恢复不限速
      applied = '0'
      void apply('0')
    }
  }
  tick()
  timer = setInterval(tick, 60_000)
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer)
  timer = null
  applied = null
}
