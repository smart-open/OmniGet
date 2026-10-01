// stats 层回归（L-3）：reverseCompletion 增量回撤 + 与 recomputeDailyStats 全量口径一致。
// 经 env 降级在纯 Node 下运行（OMNIGET_TEST_DATA_DIR 隔离 DB）。

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const tmp = mkdtempSync(join(tmpdir(), 'og-stats-'))
process.env.OMNIGET_TEST_DATA_DIR = tmp

import { closeDb } from './db'
import {
  recordCompletion,
  reverseCompletion,
  recomputeDailyStats,
  samplePeakSpeed,
  getDailyStats
} from './stats'
import { insertTask, updateTaskFields } from './task/store'
import type { Task } from '@shared/types'

function makeTask(id: string, over: Partial<Task> = {}): Task {
  return {
    id,
    type: 'bt',
    source: `magnet:?xt=urn:btih:${id}`,
    name: `task-${id}`,
    engine: 'aria2',
    status: 'parsing',
    saveDir: '/tmp/dl',
    totalBytes: 0,
    downloadedBytes: 0,
    speedBps: 0,
    threads: 16,
    createdAt: Date.now(),
    ...over
  }
}

after(() => {
  closeDb()
  rmSync(tmp, { recursive: true, force: true })
})

test('record/reverse 对账：回撤计数与体积，且不得为负（floor 0）', () => {
  const at = new Date(2026, 9, 1, 12, 0, 0).getTime()
  const day = new Date(at).toLocaleDateString('sv-SE')
  recordCompletion(at, 1000)
  recordCompletion(at, 500)
  reverseCompletion(at, 1000)
  let row = getDailyStats().find((r) => r.day === day)
  assert.equal(row?.completed_count, 1)
  assert.equal(row?.completed_bytes, 500)
  // 多撤不得产生负数
  reverseCompletion(at, 99_999)
  row = getDailyStats().find((r) => r.day === day)
  assert.equal(row?.completed_count, 0)
  assert.equal(row?.completed_bytes, 0)
})

test('增量回撤与全量重算口径一致（L-3 主诉：completed 重入队后跨天漂移）', () => {
  const at = new Date(2026, 9, 1, 18, 0, 0).getTime()
  const day = new Date(at).toLocaleDateString('sv-SE')
  const id = 'stats-reverse-1'
  insertTask(makeTask(id, { totalBytes: 2048 }))
  updateTaskFields(id, { status: 'completed', completedAt: at })
  recordCompletion(at, 2048)

  // 全量重算：1 条完成
  recomputeDailyStats()
  assert.equal(getDailyStats().find((r) => r.day === day)?.completed_count, 1)

  // 模拟 re-add：先撤销记账、再退回 queued（与 manager.confirmSelection 同序）
  reverseCompletion(at, 2048)
  updateTaskFields(id, { status: 'queued' })

  // 增量口径归零，全量重算亦归零（重算只落有完成记录的日，无记录 = 行缺失）→ 无漂移
  assert.equal(getDailyStats().find((r) => r.day === day)?.completed_count, 0)
  recomputeDailyStats()
  assert.equal(getDailyStats().find((r) => r.day === day)?.completed_count ?? 0, 0)
})

test('全量重算保留历史峰值（H5：每日 peak 不得被重算归零）', () => {
  samplePeakSpeed(123_456)
  const day = new Date().toLocaleDateString('sv-SE')
  recomputeDailyStats()
  assert.equal(getDailyStats().find((r) => r.day === day)?.peak_speed_bps, 123_456)
})
