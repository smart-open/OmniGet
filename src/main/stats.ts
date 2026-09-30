// 统计聚合（M4-4，§5 daily_stats）
// 应用启动与每日 0 点增量重算：按 completed_at 归日聚合完成量/体积；峰值速度滑动采样回填。

import { getDb } from './db'
import { createLogger } from './logger'

const log = createLogger('stats')

let timer: NodeJS.Timeout | null = null

/** 全量重算（启动/跨天）：统计页只读本表，不扫全量任务（§5 口径） */
export function recomputeDailyStats(): void {
  const db = getDb()
  db.exec(`
    DELETE FROM daily_stats;
    INSERT INTO daily_stats (day, completed_count, completed_bytes)
    SELECT date(completed_at / 1000, 'unixepoch', 'localtime') AS day,
           COUNT(*)                         AS completed_count,
           COALESCE(SUM(total_bytes), 0)    AS completed_bytes
    FROM tasks
    WHERE status = 'completed' AND completed_at IS NOT NULL
    GROUP BY day;
  `)
  log.info('daily_stats recomputed')
}

/** 单日增量（任务完成时调用） */
export function recordCompletion(completedAt: number, totalBytes: number): void {
  const day = new Date(completedAt).toLocaleDateString('sv-SE') // YYYY-MM-DD 本地时区
  getDb()
    .prepare(
      `INSERT INTO daily_stats (day, completed_count, completed_bytes) VALUES (?, 1, ?)
       ON CONFLICT(day) DO UPDATE SET
         completed_count = completed_count + 1,
         completed_bytes = completed_bytes + excluded.completed_bytes`
    )
    .run(day, totalBytes)
}

/** M4-4 峰值速度：轮询采样回填当日 */
export function samplePeakSpeed(speedBps: number): void {
  if (speedBps <= 0) return
  const day = new Date().toLocaleDateString('sv-SE')
  getDb()
    .prepare(
      `INSERT INTO daily_stats (day, peak_speed_bps) VALUES (?, ?)
       ON CONFLICT(day) DO UPDATE SET peak_speed_bps = MAX(peak_speed_bps, excluded.peak_speed_bps)`
    )
    .run(day, speedBps)
}

/** 启动重算 + 每日 0 点重算定时器 */
export function startStatsScheduler(): void {
  recomputeDailyStats()
  const tick = (): void => {
    timer = setTimeout(() => {
      recomputeDailyStats()
      tick()
    }, msUntilMidnight())
  }
  tick()
}

export function stopStatsScheduler(): void {
  if (timer) clearTimeout(timer)
  timer = null
}

function msUntilMidnight(): number {
  const now = new Date()
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 5)
  return next.getTime() - now.getTime()
}

export interface DailyStatRow {
  day: string
  completed_count: number
  completed_bytes: number
  peak_speed_bps: number
}

export function getDailyStats(days = 30): DailyStatRow[] {
  return getDb()
    .prepare(
      'SELECT day, completed_count, completed_bytes, peak_speed_bps FROM daily_stats ORDER BY day DESC LIMIT ?'
    )
    .all(days) as unknown as DailyStatRow[]
}
