// Backlog：平台适配健康注册表（提取器健康度/失效平台公示）
// 数据来源：任务失败归因（M4-17 diagnose）+ 音乐平台降级/成功事件。
// 内存态（重启清零即可接受：健康度是"当前可用性"信号，非审计数据）。

import type { PlatformHealthEntry } from '@shared/types'

export interface HealthError {
  at: number
  kind: string
  message: string
}

interface Entry {
  id: string
  label: string
  engine: string
  status: 'ok' | 'degraded' | 'down' | 'unknown'
  lastOkAt?: number
  lastFailAt?: number
  failCount: number
  recentErrors: HealthError[]
  hint?: string
}

const entries = new Map<string, Entry>()
const MAX_RECENT_ERRORS = 5
const FAIL_WINDOW_MS = 24 * 60 * 60 * 1000

const LABELS: Record<string, string> = {
  aria2: 'aria2（BT/磁力/HTTP）',
  ytdlp: 'yt-dlp（视频提取）',
  music: '音乐引擎',
  netease: '网易云',
  qq: 'QQ 音乐',
  kugou: '酷狗',
  migu: '咪咕',
  soda: '汽水',
  // R7 P1：短视频平台（yt-dlp 提取，按任务平台归因）
  douyin: '抖音',
  kuaishou: '快手',
  xiaohongshu: '小红书',
  weibo: '微博',
  xigua: '西瓜视频'
}

function entry(id: string, engine: string): Entry {
  let e = entries.get(id)
  if (!e) {
    e = {
      id,
      label: LABELS[id] ?? id,
      engine,
      status: 'unknown',
      failCount: 0,
      recentErrors: []
    }
    entries.set(id, e)
  }
  // R7 续审查修复：引擎归属跟随最近一次成功/失败来源（sidecar 兜底命中后，
  // 平台行的引擎列从 yt-dlp 翻为 sidecar，用户可确认兜底通道生效）
  if (e.engine !== engine) e.engine = engine
  return e
}

function now(): number {
  return Date.now()
}

function rollingFailCount(e: Entry): number {
  if (!e.lastFailAt || now() - e.lastFailAt > FAIL_WINDOW_MS) return 0
  return e.failCount
}

function recomputeStatus(e: Entry): void {
  if (e.status === 'degraded') {
    // 降级是显式标记，只有成功后自动恢复为 ok
    if (e.lastOkAt && e.lastFailAt && e.lastOkAt >= e.lastFailAt) e.status = 'ok'
    return
  }
  if (e.lastOkAt && (!e.lastFailAt || e.lastOkAt >= e.lastFailAt)) e.status = 'ok'
  else if (e.lastFailAt && rollingFailCount(e) > 0) e.status = 'down'
  else e.status = 'unknown'
}

/** 平台/提取器一次成功交互（搜索命中、进度推进、任务完成） */
export function recordPlatformOk(id: string, engine = 'music'): void {
  const e = entry(id, engine)
  e.lastOkAt = now()
  e.failCount = 0
  recomputeStatus(e)
}

/** 一次失败（errorText 建议先经 diagnose 归因） */
export function recordPlatformFailure(
  id: string,
  kind: string,
  message: string,
  engine = 'music',
  hint?: string
): void {
  const e = entry(id, engine)
  const prev = e.lastFailAt
  e.lastFailAt = now()
  e.failCount = prev && now() - prev <= FAIL_WINDOW_MS ? e.failCount + 1 : 1
  e.recentErrors = [{ at: now(), kind, message: message.slice(0, 200) }, ...e.recentErrors].slice(
    0,
    MAX_RECENT_ERRORS
  )
  if (hint) e.hint = hint
  recomputeStatus(e)
}

/** 显式降级标记（音乐平台回退链命中、镜像切替等） */
export function recordPlatformDegraded(
  id: string,
  message: string,
  engine = 'music',
  hint?: string
): void {
  const e = entry(id, engine)
  e.status = 'degraded'
  e.lastFailAt = now()
  e.failCount += 1
  e.recentErrors = [{ at: now(), kind: 'degraded', message: message.slice(0, 200) }, ...e.recentErrors].slice(
    0,
    MAX_RECENT_ERRORS
  )
  if (hint) e.hint = hint
}

/** R7 P1：预置平台条目（unknown 态出现在面板，用户可见覆盖面；有事件后自动翻转） */
export function seedPlatforms(ids: string[], engine: string): void {
  for (const id of ids) entry(id, engine)
}

/** 面板快照（含引擎级 + 音乐平台级；未出现过的平台不列出） */
export function platformHealthSnapshot(): PlatformHealthEntry[] {
  return [...entries.values()]
    .map((e) => ({
      id: e.id,
      label: e.label,
      engine: e.engine,
      status: e.status,
      lastOkAt: e.lastOkAt,
      lastFailAt: e.lastFailAt,
      failCount: rollingFailCount(e),
      recentErrors: [...e.recentErrors],
      hint: e.hint
    }))
    .sort((a, b) => (a.engine === b.engine ? a.id.localeCompare(b.id) : a.engine.localeCompare(b.engine)))
}
