// 订阅追更（backlog #18，Tube Archivist/Pinchflat/spotDL sync 范式收敛）
// 频道/UP主/歌单 URL → yt-dlp --flat-playlist 抓条目 → 与去重档案差集 →
// 自动入队（createTask + confirmSelection 直通，复用全部管线）。
// 调度：全局 10min tick，到期（lastCheckedAt + intervalMin）逐个串行检查，
// 单次单源最多入队 20 条（防大频道首次订阅刷屏）。
// 三期（0.10.x，backlog #18 边界收敛）：RSS 源；每源保存目录/参数预设/命名模板；
// 条目级过滤（最短时长/标题关键词）——过滤与 RSS 解析纯函数在 ./subscribe-rss。

import { getDb, getSettingParsed } from './db'
import { broadcastNotices } from './ipc'
import { createLogger } from './logger'
import { addArchiveKey, archiveKey, isArchiveFused, isArchived } from './task/archive'
import { getYtDlpSupervisor } from './orchestrator/ytdlp'
import { validateSaveDir } from './save-dir'
import type {
  ConfirmSelectionInput,
  Subscription,
  SubscriptionAddInput,
  SubscriptionUpdateInput
} from '@shared/types'
import { uuidv7 } from './task/id'
import { filterEntries, parseFeed } from './subscribe-rss'

const log = createLogger('subscribe')

const MAX_ENTRIES_PER_CHECK = 20
const TICK_MS = 10 * 60 * 1000

interface FlatEntry {
  url?: string
  title?: string
  duration?: number | null
  _type?: string
}

/** 渲染层 download.videoPresets 的结构（subscribeAdd/Update 校验 presetId 用） */
interface StoredVideoPreset {
  id: number
  name: string
  opts: {
    formatId?: string | null
    audioOnly?: boolean
    embedSubs?: boolean
    embedThumbnail?: boolean
    delogo?: boolean
    template?: string
  }
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
  source_kind: string
  save_dir: string | null
  preset_id: number | null
  template: string | null
  filter_min_sec: number
  filter_keywords: string | null
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
    createdAt: r.created_at,
    sourceKind: r.source_kind === 'rss' ? 'rss' : 'ytdlp',
    saveDir: r.save_dir,
    presetId: r.preset_id,
    template: r.template,
    filterMinSec: r.filter_min_sec,
    filterKeywords: r.filter_keywords
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

/** 三期：每源可写字段归一校验（add/update 共用） */
function normalizeExtra(input: SubscriptionAddInput): {
  sourceKind: 'ytdlp' | 'rss'
  saveDir: string | null
  presetId: number | null
  template: string | null
  filterMinSec: number
  filterKeywords: string | null
} {
  const sourceKind = input.sourceKind === 'rss' ? 'rss' : 'ytdlp'
  let saveDir: string | null = null
  if (typeof input.saveDir === 'string' && input.saveDir.trim()) {
    const dir = input.saveDir.trim()
    // 与任务创建同口径校验（含自启动目录拦截）——脏目录在检查期才报错会静默失败
    const err = validateSaveDir(dir)
    if (err) throw new Error(err)
    saveDir = dir
  }
  let presetId: number | null = null
  if (input.presetId != null) {
    const id = Number(input.presetId)
    const presets = getSettingParsed<StoredVideoPreset[]>('download.videoPresets') ?? []
    if (!Number.isFinite(id) || !presets.some((p) => p.id === id)) {
      throw new Error('参数预设不存在（可能已被删除），请重新选择')
    }
    presetId = Math.round(id)
  }
  const template = typeof input.template === 'string' && input.template.trim() ? input.template.trim().slice(0, 200) : null
  const filterMinSec = Math.max(0, Math.min(24 * 3600, Math.round(Number(input.filterMinSec) || 0)))
  const filterKeywords =
    typeof input.filterKeywords === 'string' && input.filterKeywords.trim()
      ? input.filterKeywords.trim().slice(0, 500)
      : null
  return { sourceKind, saveDir, presetId, template, filterMinSec, filterKeywords }
}

export function addSubscription(input: SubscriptionAddInput): Subscription {
  const name = String(input.name ?? '')
    .trim()
    .slice(0, 100)
  const url = String(input.url ?? '').trim()
  if (!name) throw new Error('订阅名称不能为空')
  if (!/^https?:\/\//i.test(url)) throw new Error('订阅地址必须以 http:// 或 https:// 开头')
  // 审查修复：同一 URL 可重复添加——列表出现重复订阅、检查与通知翻倍。
  // 第六轮审查：精确字符串比对可被 ?si= 等追踪参数绕过——比对前做 archiveKey
  // 同源归一化（youtu.be 展开/追踪参数/尾斜杠/协议归一）
  const norm = archiveKey(url)
  const all = listSubscriptions()
  const dup = all.find((s) => archiveKey(s.url) === norm)
  if (dup) throw new Error(`该地址已订阅为「${dup.name}」`)
  // 第七轮审查 P3：数量上限（对齐 scheduler 64 条口径）——tick 串行 flat-parse
  // 全部到期源，无上限可被塞爆后占满 yt-dlp supervisor，饿死正常任务解析
  if (all.length >= 64) throw new Error('订阅数量已达上限（64），请先清理不再需要的订阅')
  const extra = normalizeExtra(input)
  const sub: Subscription = {
    id: uuidv7(),
    name,
    url,
    intervalMin: validInterval(input.intervalMin),
    addedTotal: 0,
    lastCheckedAt: null,
    lastError: null,
    createdAt: Date.now(),
    ...extra
  }
  getDb()
    .prepare(
      `INSERT INTO subscriptions (id, name, url, interval_min, added_total, last_checked_at, last_error, created_at,
        source_kind, save_dir, preset_id, template, filter_min_sec, filter_keywords)
       VALUES (@id, @name, @url, @intervalMin, @addedTotal, @lastCheckedAt, @lastError, @createdAt,
        @sourceKind, @saveDir, @presetId, @template, @filterMinSec, @filterKeywords)`
    )
    .run({ ...sub, lastCheckedAt: null, lastError: null })
  log.info(`subscription added: ${name} (${extra.sourceKind})`)
  return sub
}

/** 三期（backlog #18）：编辑订阅源（全字段覆盖；URL 归一查重排除自身） */
export function updateSubscription(input: SubscriptionUpdateInput): Subscription {
  const sub = listSubscriptions().find((s) => s.id === String(input.id ?? ''))
  if (!sub) throw new Error('订阅不存在或已被删除')
  const name = String(input.name ?? '')
    .trim()
    .slice(0, 100)
  const url = String(input.url ?? '').trim()
  if (!name) throw new Error('订阅名称不能为空')
  if (!/^https?:\/\//i.test(url)) throw new Error('订阅地址必须以 http:// 或 https:// 开头')
  const norm = archiveKey(url)
  const dup = listSubscriptions().find((s) => s.id !== sub.id && archiveKey(s.url) === norm)
  if (dup) throw new Error(`该地址已订阅为「${dup.name}」`)
  const extra = normalizeExtra(input)
  getDb()
    .prepare(
      `UPDATE subscriptions SET name = ?, url = ?, interval_min = ?, source_kind = ?, save_dir = ?,
        preset_id = ?, template = ?, filter_min_sec = ?, filter_keywords = ? WHERE id = ?`
    )
    .run(
      name,
      url,
      validInterval(input.intervalMin),
      extra.sourceKind,
      extra.saveDir,
      extra.presetId,
      extra.template,
      extra.filterMinSec,
      extra.filterKeywords,
      sub.id
    )
  log.info(`subscription updated: ${name} (${extra.sourceKind})`)
  return listSubscriptions().find((s) => s.id === sub.id)!
}

export function removeSubscription(id: string): void {
  getDb().prepare('DELETE FROM subscriptions WHERE id = ?').run(id)
}

/** 订阅宿主：manager 的最小依赖面（防循环依赖） */
export interface SubscriptionHost {
  createTask: (input: { source: string; threads: number; saveDir: string }) => Promise<unknown>
  confirmSelection: (input: {
    taskId: string
    threads: number
    /** 三期：订阅源指定的视频参数（预设映射；缺省默认参数） */
    video?: ConfirmSelectionInput['video']
  }) => Promise<void>
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

/** 三期：RSS/Atom 源抓条目（零依赖正则解析，parseFeed 见 subscribe-rss） */
async function rssParseEntries(url: string): Promise<FlatEntry[]> {
  const { getText } = await import('./music/http')
  const xml = await getText(url, undefined, { timeoutMs: 30_000 })
  return parseFeed(xml).map((e) => ({ url: e.url, title: e.title, duration: null }))
}

/** 三期：订阅源参数 → 视频任务确认参数（预设映射；仅模板时也构造以带上模板） */
function presetToVideo(sub: Subscription): ConfirmSelectionInput['video'] | undefined {
  if (sub.presetId == null && !(sub.template ?? '').trim()) return undefined
  const presets = getSettingParsed<StoredVideoPreset[]>('download.videoPresets') ?? []
  const o = sub.presetId != null ? presets.find((p) => p.id === sub.presetId)?.opts : undefined
  return {
    formatId: o?.formatId ?? undefined,
    audioOnly: o?.audioOnly === true,
    audioFormat: 'mp3',
    embedSubs: o?.embedSubs === true,
    embedThumbnail: o?.embedThumbnail === true,
    delogo: o?.delogo === true,
    template: (sub.template ?? '').trim() || o?.template || undefined
  }
}

/** 单次检查：抓条目（ytdlp/RSS 双路）→ 条目过滤 → 档案差集 → 自动入队；返回新增条数 */
export async function checkSubscription(
  sub: Subscription,
  host: SubscriptionHost
): Promise<number> {
  const raw = sub.sourceKind === 'rss' ? await rssParseEntries(sub.url) : await flatParseEntries(sub.url)
  // 三期：条目级过滤（最短时长/关键词；时长下限对无时长信息的 RSS 条目视为通过）
  const entries = filterEntries(
    raw.map((e) => ({ url: e.url as string, title: e.title ?? '', durationSec: e.duration ?? null })),
    sub
  )
  // 三期：每源保存目录优先，留空回落全局
  const saveDir = (sub.saveDir ?? '').trim() || getSettingParsed<string>('download.saveDir')?.trim() || ''
  // 三期：每源参数预设/命名模板 → 确认参数
  const video = presetToVideo(sub)
  let added = 0
  let firstError: string | null = null
  let attempted = 0
  for (const entry of entries) {
    if (added >= MAX_ENTRIES_PER_CHECK) break
    const url = entry.url
    // 第六轮审查：连续失败熔断——永久失败条目（下架/地区受限）此前每周期
    // 重建→失败→回滚无限循环，达阈值后跳过直至某次成功清零
    if (isArchived(url) || isArchiveFused(url)) continue
    attempted++
    try {
      const res = (await host.createTask({ source: url, threads: 16, saveDir })) as {
        kind?: string
        taskId?: string
        error?: string
      }
      if (res.kind === 'failed') throw new Error(res.error ?? '任务创建失败')
      // 入队即登记档案（而非等确认/完成）——确认失败（任务被用户删除等）时
      // 下个周期不再重复建 awaiting 任务；后续失败由 manager 侧回滚+熔断兜底
      addArchiveKey(url)
      if (res.kind === 'awaiting' && res.taskId) {
        // 视频任务直通确认（复用 awaiting→queued 管线；三期带源参数）
        await host.confirmSelection({ taskId: res.taskId, threads: 16, video })
      }
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
  // 审查修复：并发防护——定时 tick 与手动「立即检查」重叠时，双方都在对方
  // addArchiveKey 之前通过 isArchived，同一 URL 会建两个任务
  if (inflightChecks.has(id)) return { added: 0 }
  inflightChecks.add(id)
  try {
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
  } finally {
    inflightChecks.delete(id)
  }
}

export async function checkSubscriptionNow(
  id: string,
  host: SubscriptionHost
): Promise<{ added: number }> {
  return checkById(id, host)
}

// ── 定时调度 ────────────────────────────────────────────────────────

let timer: NodeJS.Timeout | null = null
/** 审查修复：并发防护——在途检查的订阅 id 集合 + tick 重入标志 */
const inflightChecks = new Set<string>()
let tickRunning = false

async function runDueChecks(host: SubscriptionHost): Promise<void> {
  // 审查修复：单源 flat-parse 最长 120s × N 源串行，检查期间完全可能超过 10min tick
  // ——tick 重叠会重复入队；上一次未跑完则本轮整体跳过
  if (tickRunning) return
  tickRunning = true
  try {
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
  } finally {
    tickRunning = false
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
