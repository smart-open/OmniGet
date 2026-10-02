// 订阅追更（backlog #18，Tube Archivist/Pinchflat/spotDL sync 范式收敛）
// 频道/UP主/歌单 URL → yt-dlp --flat-playlist 抓条目 → 与去重档案差集 →
// 自动入队（createTask + confirmSelection 直通，复用全部管线）。
// 调度：全局 10min tick，到期（lastCheckedAt + intervalMin）逐个串行检查，
// 单次单源最多入队 20 条（防大频道首次订阅刷屏）。

import { getDb, getSettingParsed } from './db'
import { broadcastNotices } from './ipc'
import { createLogger } from './logger'
import { addArchiveKey, isArchived } from './task/archive'
import { getYtDlpSupervisor } from './orchestrator/ytdlp'
import type { Subscription, SubscriptionAddInput } from '@shared/types'
import { uuidv7 } from './task/id'

const log = createLogger('subscribe')

const MAX_ENTRIES_PER_CHECK = 20
const TICK_MS = 10 * 60 * 1000

interface FlatEntry {
  url?: string
  title?: string
  _type?: string
}

interface Row {
  id: string
  name: string
  url: string
  interval_min: number
  added_total: number
  last_checked_at: number | null
  last_error: string | null
  created_at: number
}

function rowToSub(r: Row): Subscription {
  return {
    id: r.id,
    name: r.name,
    url: r.url,
    intervalMin: r.interval_min,
    addedTotal: r.added_total,
    lastCheckedAt: r.last_checked_at,
    lastError: r.last_error,
    createdAt: r.created_at
  }
}

export function listSubscriptions(): Subscription[] {
  const rows = getDb()
    .prepare('SELECT * FROM subscriptions ORDER BY created_at ASC')
    .all() as Row[]
  return rows.map(rowToSub)
}

function validInterval(v: unknown): number {
  const n = Math.floor(Number(v))
  // 下限 30min：过密订阅只会招致平台风控
  return [60, 180, 360, 720, 1440].includes(n) ? n : n >= 30 && n <= 1440 ? n : 60
}

export function addSubscription(input: SubscriptionAddInput): Subscription {
  const name = String(input.name ?? '')
    .trim()
    .slice(0, 100)
  const url = String(input.url ?? '').trim()
  if (!name) throw new Error('订阅名称不能为空')
  if (!/^https?:\/\//i.test(url)) throw new Error('订阅地址必须以 http:// 或 https:// 开头')
  const sub: Subscription = {
    id: uuidv7(),
    name,
    url,
    intervalMin: validInterval(input.intervalMin),
    addedTotal: 0,
    lastCheckedAt: null,
    lastError: null,
    createdAt: Date.now()
  }
  getDb()
    .prepare(
      `INSERT INTO subscriptions (id, name, url, interval_min, added_total, last_checked_at, last_error, created_at)
       VALUES (@id, @name, @url, @intervalMin, @addedTotal, @lastCheckedAt, @lastError, @createdAt)`
    )
    .run({ ...sub, lastCheckedAt: null, lastError: null })
  log.info(`subscription added: ${name}`)
  return sub
}

export function removeSubscription(id: string): void {
  getDb().prepare('DELETE FROM subscriptions WHERE id = ?').run(id)
}

/** 订阅宿主：manager 的最小依赖面（防循环依赖） */
export interface SubscriptionHost {
  createTask: (input: { source: string; threads: number; saveDir: string }) => Promise<unknown>
  confirmSelection: (input: { taskId: string; threads: number }) => Promise<void>
}

async function flatParseEntries(url: string): Promise<FlatEntry[]> {
  const out = await getYtDlpSupervisor().execJson(
    ['-J', '--flat-playlist', '--no-warnings', url],
    120_000
  )
  const json = JSON.parse(out) as { entries?: FlatEntry[] }
  return (json.entries ?? []).filter(
    (e) => typeof e.url === 'string' && /^https?:\/\//i.test(e.url ?? '') && e._type !== 'playlist'
  )
}

/** 单次检查：抓条目 → 档案差集 → 自动入队；返回新增条数 */
export async function checkSubscription(
  sub: Subscription,
  host: SubscriptionHost
): Promise<number> {
  const entries = await flatParseEntries(sub.url)
  const saveDir = getSettingParsed<string>('download.saveDir')?.trim() || ''
  let added = 0
  let firstError: string | null = null
  let attempted = 0
  for (const entry of entries) {
    if (added >= MAX_ENTRIES_PER_CHECK) break
    const url = entry.url as string
    if (isArchived(url)) continue
    attempted++
    try {
      const res = (await host.createTask({ source: url, threads: 16, saveDir })) as {
        kind?: string
        taskId?: string
        error?: string
      }
      if (res.kind === 'failed') throw new Error(res.error ?? '任务创建失败')
      if (res.kind === 'awaiting' && res.taskId) {
        // 视频任务默认参数直通确认（复用 awaiting→queued 管线）
        await host.confirmSelection({ taskId: res.taskId, threads: 16 })
      }
      // 入队即登记档案（而非等完成）——防止下次检查在任务完成前重复入队
      addArchiveKey(url)
      added++
    } catch (err) {
      // 单条目失败不阻断其余条目
      const msg = err instanceof Error ? err.message : String(err)
      log.warn(`订阅条目入队失败（${sub.name}）: ${msg}`)
      firstError = firstError ?? msg
    }
  }
  // 审查修复：全军覆没（如保存目录未配置）不能伪装成「暂无新内容」——
  // 上抛首个错误由 checkById 落 lastError 公示
  if (added === 0 && attempted > 0 && firstError) throw new Error(firstError)
  return added
}

async function checkById(id: string, host: SubscriptionHost): Promise<{ added: number }> {
  const sub = listSubscriptions().find((s) => s.id === id)
  if (!sub) throw new Error('订阅不存在或已删除')
  let added = 0
  let error: string | null = null
  try {
    added = await checkSubscription(sub, host)
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
  }
  getDb()
    .prepare(
      'UPDATE subscriptions SET last_checked_at = ?, last_error = ?, added_total = added_total + ? WHERE id = ?'
    )
    .run(Date.now(), error, added, id)
  if (added > 0) {
    broadcastNotices([
      { level: 'info', message: `订阅「${sub.name}」新增 ${added} 个内容，已自动入队` }
    ])
  }
  return { added }
}

export async function checkSubscriptionNow(
  id: string,
  host: SubscriptionHost
): Promise<{ added: number }> {
  return checkById(id, host)
}

// ── 定时调度 ────────────────────────────────────────────────────────

let timer: NodeJS.Timeout | null = null

async function runDueChecks(host: SubscriptionHost): Promise<void> {
  const now = Date.now()
  for (const sub of listSubscriptions()) {
    if (sub.lastCheckedAt !== null && now - sub.lastCheckedAt < sub.intervalMin * 60_000) {
      continue
    }
    try {
      const r = await checkById(sub.id, host)
      log.info(`subscription checked: ${sub.name}, +${r.added}`)
    } catch (err) {
      log.warn(`subscription check failed: ${sub.name}`, err)
    }
  }
}

export function startSubscriptionTimer(host: SubscriptionHost): void {
  if (timer) return
  timer = setInterval(() => {
    void runDueChecks(host)
  }, TICK_MS)
  log.info('subscription timer started')
}

export function stopSubscriptionTimer(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}
