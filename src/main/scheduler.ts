// 定时/分时段调度（M4-15，§4.8 借鉴 AB Download Manager）
// 速度计划表：时段 → 全局限速档，主进程每分钟驱动，切换即时经 aria2 changeGlobalOption 生效。
// 五期（0.12.x）合并编排升级：
// - 规则扩展「星期几」（days，缺省每天）与「停运窗口」（mode='pause'）——
//   停运窗口内不启动新排队任务 + 暂停运行中的下载引擎任务，窗口结束统一恢复；
// - 限速档与停运窗口共用一张规则表、同一个每分钟 tick（合并编排），
//   旧数据（无 days/mode 字段）按「每天 + 分时限速」兼容解析。

import { getSetting, setSetting } from './db'
import { createLogger } from './logger'

const log = createLogger('scheduler')

export interface ScheduleRule {
  from: string // '09:00'
  to: string // '18:00'
  /** 限速档：'0' 不限 / '2M' / '500K' 等 aria2 限速格式（mode='pause' 时忽略） */
  limit: string
  /** 五期：生效星期（0=周日…6=周六）；缺省/空 = 每天 */
  days?: number[]
  /** 五期：'limit' 分时限速（缺省，向后兼容）；'pause' 停运窗口 */
  mode?: 'limit' | 'pause'
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
      // 五期：mode 校验（缺省 'limit' 向后兼容）；pause 规则不消费限速档，归一 '0'
      const mode = x.mode === 'pause' ? 'pause' : 'limit'
      // 五期：days 校验——0..6 整数去重升序；非法/空 = 每天（缺省兼容旧数据）
      const days = Array.isArray(x.days)
        ? [...new Set(x.days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort(
            (a, b) => a - b
          )
        : []
      if (mode === 'limit' && !LIMIT_RE.test(limit)) continue
      out.push({
        from: x.from,
        to: x.to,
        limit: mode === 'pause' ? '0' : limit,
        ...(days.length > 0 ? { days } : {}),
        ...(mode === 'pause' ? { mode } : {})
      })
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

/** 五期：星期几匹配——days 缺省/空 = 每天。
 * 跨天时段（22:00–06:00）的凌晨段按「窗口开始日」判定星期：周五 22:00–06:00
 * 的周六凌晨仍属周五窗口（此前逐分钟按当天 getDay() 重判，跨零点即提前掐断窗口） */
function dayMatch(now: Date, rule: ScheduleRule): boolean {
  if (!rule.days || rule.days.length === 0) return true
  const [fh, fm] = rule.from.split(':').map(Number)
  const [th, tm] = rule.to.split(':').map(Number)
  const mins = now.getHours() * 60 + now.getMinutes()
  const from = (fh ?? 0) * 60 + (fm || 0)
  const to = (th ?? 0) * 60 + (tm || 0)
  const crossesMidnight = from !== to && from > to
  const refDay = crossesMidnight && mins < to ? (now.getDay() + 6) % 7 : now.getDay()
  return rule.days.includes(refDay)
}

function matches(now: Date, rule: ScheduleRule): boolean {
  return inRange(now, rule) && dayMatch(now, rule)
}

/** 当前应生效的限速档（仅 mode='limit' 规则参与）；无命中返回 null（保持当前值） */
export function currentLimit(now = new Date()): string | null {
  for (const rule of getScheduleRules()) {
    if ((rule.mode ?? 'limit') !== 'limit') continue
    if (matches(now, rule)) return rule.limit
  }
  return null
}

/** 五期：当前是否处于停运窗口（mode='pause' 规则任一命中） */
export function isPausedWindow(now = new Date()): boolean {
  return getScheduleRules().some((rule) => rule.mode === 'pause' && matches(now, rule))
}

let timer: NodeJS.Timeout | null = null
let applied: string | null = null
let appliedPause = false
let applyFn: ((limit: string) => Promise<void> | void) | null = null
let windowHooks: {
  onWindowStart: () => Promise<void> | void
  onWindowEnd: () => Promise<void> | void
} | null = null

/** 启动调度器：每分钟检查，值变化时经回调应用（限速 → aria2 changeGlobalOption；
 * 停运窗口 → hooks（任务管理器暂停/恢复 + 闸门守卫）） */
export function startScheduler(
  apply: (limit: string) => Promise<void> | void,
  hooks?: {
    onWindowStart: () => Promise<void> | void
    onWindowEnd: () => Promise<void> | void
  }
): void {
  stopScheduler()
  applyFn = apply
  windowHooks = hooks ?? null
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
      // 五期：停运窗口状态机（进入 → onWindowStart；退出 → onWindowEnd + 立即补泵）
      const paused = isPausedWindow()
      if (paused !== appliedPause) {
        appliedPause = paused
        log.info(`pause window ${paused ? 'entered' : 'exited'}`)
        void Promise.resolve(paused ? windowHooks?.onWindowStart() : windowHooks?.onWindowEnd())
          .catch((err) => log.warn('pause window hook failed', err))
      }
    } catch (err) {
      log.error('schedule tick failed', err)
    }
  }
  tick()
  timer = setInterval(tick, 60_000)
}

/** R4-P2：aria2 崩溃重启会经 spawnAndConnect 重放全局启动参数（含不限速默认值），
 * 覆盖已应用的分时限速档——标记失效并立即重放当前档位（否则静默失效到下个时段边界）。
 * 停运窗口不依赖 aria2（任务级 paused 持久于 DB），无需重放。 */
export function invalidateSchedule(): void {
  applied = null
  if (!applyFn) return
  const limit = currentLimit()
  if (limit !== null) {
    void Promise.resolve(applyFn(limit))
      .then(() => {
        applied = limit
      })
      .catch((err) => log.warn('schedule re-apply after restart failed', err))
  }
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer)
  timer = null
  applied = null
  appliedPause = false
  windowHooks = null
}
