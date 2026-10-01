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
    return sanitizeRules(JSON.parse(getSetting('schedule.rules') ?? '[]'))
  } catch {
    return []
  }
}

/** 入库前结构校验：IPC 参数来自渲染层，脏数据会让 tick 解析 NaN/TypeError 崩调度器 */
function sanitizeRules(rules: unknown): ScheduleRule[] {
  if (!Array.isArray(rules)) return []
  // L9 修复：时段须为合法 24h 时间（原 ^\d{1,2}:\d{1,2}$ 放行 99:99 → 永不命中的死规则）
  const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/
  // 限速档格式收紧：数字/'K'/'M' 单位（aria2 overall-speed-limit 格式）
  const LIMIT_RE = /^\d{1,7}[KM]?$/i
  const out: ScheduleRule[] = []
  for (const r of rules.slice(0, 64)) {
    const x = r as Partial<ScheduleRule> | null
    if (
      x &&
      typeof x.from === 'string' &&
      typeof x.to === 'string' &&
      typeof x.limit === 'string' &&
      TIME_RE.test(x.from) &&
      TIME_RE.test(x.to)
    ) {
      // M3 修复：''/'unlimited' 会被 aria2 RPC 拒绝 → 归一化为 aria2 的不限速值 '0'
      const raw = x.limit.trim()
      const limit = /^unlimited$/i.test(raw) || raw === '' ? '0' : raw.slice(0, 16)
      if (!LIMIT_RE.test(limit)) continue
      out.push({ from: x.from, to: x.to, limit })
    }
  }
  return out
}

export function setScheduleRules(rules: ScheduleRule[]): void {
  setSetting('schedule.rules', JSON.stringify(sanitizeRules(rules)))
}

function inRange(now: Date, rule: ScheduleRule): boolean {
  const [fh, fm] = rule.from.split(':').map(Number)
  const [th, tm] = rule.to.split(':').map(Number)
  const mins = now.getHours() * 60 + now.getMinutes()
  const from = (fh ?? 0) * 60 + (fm || 0)
  const to = (th ?? 0) * 60 + (tm || 0)
  // from === to 视为全天生效（原实现落入空区间永不命中）
  if (from === to) return true
  // 支持跨天边界（22:00-06:00）
  return from < to ? mins >= from && mins < to : mins >= from || mins < to
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
    // 定时器回调内上抛 = uncaughtException 崩主进程：任何异常都不允许逃出 tick
    try {
      const limit = currentLimit()
      if (limit !== null && limit !== applied) {
        // M3 修复：applied 必须在 apply 成功后落位——先前实现先赋值再 apply，
        // aria2 拒绝该档位时本会话内不再重试，限速静默失效
        log.info(`schedule applying: ${limit}`)
        void Promise.resolve(apply(limit))
          .then(() => {
            applied = limit
          })
          .catch((err) => log.warn('schedule apply failed', err))
      } else if (limit === null && applied !== null) {
        // 计划表整体清空/时段结束：恢复不限速
        void Promise.resolve(apply('0'))
          .then(() => {
            applied = '0'
          })
          .catch((err) => log.warn('schedule apply failed', err))
      }
    } catch (err) {
      log.error('schedule tick failed', err)
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
