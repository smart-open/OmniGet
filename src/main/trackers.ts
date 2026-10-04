// Tracker 管理器（M4-16，§4.2/§4.8 借鉴 Motrix）
// 多订阅源合并（ngosang best/all + XIU2 best/all）+ 手动增删 + last-ok 展示；
// 数据复用 trackers 表；每日刷新，部分源失败降级用成功源。

import { getDb } from './db'
import { createLogger } from './logger'
import type { TrackerEntry } from '@shared/types'

const log = createLogger('trackers')

/** 订阅源清单：多源合并提高 peer 发现能力（加速 BT/磁力下载） */
const SUBSCRIPTIONS: Array<{ url: string; source: string }> = [
  // GitHub Raw 原源
  {
    url: 'https://raw.githubusercontent.com/XIU2/TrackersListCollection/master/best.txt',
    source: 'xiu2'
  },
  {
    url: 'https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_best.txt',
    source: 'ngosang'
  },
  {
    url: 'https://raw.githubusercontent.com/XIU2/TrackersListCollection/master/all.txt',
    source: 'xiu2'
  },
  {
    url: 'https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_all.txt',
    source: 'ngosang'
  },
  // jsDelivr CDN 镜像：raw.githubusercontent.com 不可达时的兜底（同一份数据，DB 按主键去重）
  {
    url: 'https://fastly.jsdelivr.net/gh/XIU2/TrackersListCollection@master/best.txt',
    source: 'xiu2'
  },
  {
    url: 'https://fastly.jsdelivr.net/gh/ngosang/trackerslist@master/trackers_best.txt',
    source: 'ngosang'
  },
  {
    url: 'https://fastly.jsdelivr.net/gh/XIU2/TrackersListCollection@master/all.txt',
    source: 'xiu2'
  },
  {
    url: 'https://fastly.jsdelivr.net/gh/ngosang/trackerslist@master/trackers_all.txt',
    source: 'ngosang'
  }
]

/** 单源上限（all 全量列表很大，防膨胀） */
const PER_SOURCE_CAP = 120

export function listTrackers(): TrackerEntry[] {
  return getDb()
    .prepare('SELECT url, last_ok_at, source FROM trackers ORDER BY source, url')
    .all() as unknown as TrackerEntry[]
}

export function addTracker(url: string): void {
  const trimmed = url.trim()
  // 校验：仅允许 tracker 协议，禁止逗号/空白（bt-tracker 为 CSV 注入 aria2 全局选项）
  if (
    !/^(https?|udp|wss?):\/\/[^\s,]+$/i.test(trimmed) ||
    trimmed.length > 500
  ) {
    throw new Error('无效的 tracker 地址：需以 http(s):// udp:// ws(s):// 开头，且不含空格或逗号')
  }
  getDb()
    .prepare(
      'INSERT INTO trackers (url, last_ok_at, source) VALUES (?, NULL, ?) ON CONFLICT(url) DO NOTHING'
    )
    .run(trimmed, 'manual')
}

export function removeTracker(url: string): void {
  getDb().prepare('DELETE FROM trackers WHERE url = ?').run(url)
}

async function fetchSource(url: string): Promise<string[]> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'OmniGet' },
    signal: AbortSignal.timeout(20_000)
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return (await res.text())
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && /^[a-z]+:\/\//i.test(l))
    // P3 加固：与 addTracker 同口径——禁止逗号/空白条目（bt-tracker 为 CSV，
    // 订阅源被投毒插入伪条目会原样进入 aria2 全局选项）
    .filter((l) => !/[\s,]/.test(l) && l.length <= 500)
}

/** 订阅源刷新：多源合并去重；单个源失败不影响其余（全部失败才抛出走缓存降级） */
export async function refreshTrackers(): Promise<number> {
  const results = await Promise.allSettled(
    SUBSCRIPTIONS.map(async (s) => ({ source: s.source, urls: await fetchSource(s.url) }))
  )
  const ok = results.filter((r) => r.status === 'fulfilled').map((r) => r.value)
  if (ok.length === 0) {
    throw new Error('全部 tracker 订阅源拉取失败')
  }
  const failed = results.length - ok.length
  const upsert = getDb().prepare(
    'INSERT INTO trackers (url, last_ok_at, source) VALUES (?, NULL, ?) ON CONFLICT(url) DO NOTHING'
  )
  let total = 0
  const tx = getDb().transaction((items: Array<{ source: string; urls: string[] }>) => {
    for (const { source, urls } of items) {
      for (const u of urls.slice(0, PER_SOURCE_CAP)) {
        // 第六轮审查：4/8 订阅源是同数据的 CDN 镜像——ON CONFLICT DO NOTHING 前
        // total++ 使统计值约为实际入库数的 2 倍；按真实写入行数计数
        const info = upsert.run(u, source)
        total += Number(info.changes)
      }
    }
  })
  tx(ok)
  log.info(
    `trackers refreshed: ${total} urls from ${ok.length}/${SUBSCRIPTIONS.length} sources` +
      (failed > 0 ? ` (${failed} source(s) failed)` : '')
  )
  return total
}

/** 汇总注入 aria2 bt-tracker（全局选项）。兜底再过滤一次 CSV 注入向量 */
export function joinedTrackers(): string {
  return listTrackers()
    .map((t) => t.url)
    .filter((u) => !/[\s,]/.test(u))
    .join(',')
}
