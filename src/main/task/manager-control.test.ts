// 任务控制竞态回归（M1/A2 修复）：
// A1：用户暂停后，在途引擎调用的迟到报错不得把 paused 覆写成 failed；
// A2：无 engineGid 的 paused 任务 resume 必须退回 queued 重过启动闸门，
//     不得静默 no-op 写成 running（无 gid → 轮询跳过 → 永久卡死）。
// 经 Electron-as-Node 运行（better-sqlite3 ABI）。

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const tmp = mkdtempSync(join(tmpdir(), 'og-ctl-'))
process.env.OMNIGET_TEST_DATA_DIR = tmp

import { TaskManager } from './manager'
import type { Task } from '@shared/types'

const drain = (): Promise<void> => new Promise((r) => setTimeout(r, 50))

function makeTask(id: string, over: Partial<Task> = {}): Task {
  return {
    id,
    type: 'magnet',
    source: `magnet:?xt=urn:btih:${id}`,
    name: `task-${id}`,
    engine: 'aria2',
    status: 'parsing',
    saveDir: join(tmp, 'dl'),
    totalBytes: 0,
    downloadedBytes: 0,
    speedBps: 0,
    threads: 16,
    createdAt: Date.now(),
    ...over
  }
}

// —— aria2 打桩：记录调用，start 默认成功 ——
let resumeCalls = 0
let startCalls = 0
const baseAria2 = {
  isOnline: true,
  async start(): Promise<string> {
    startCalls++
    return 'gid-new'
  },
  async resume(): Promise<void> {
    resumeCalls++
  },
  async pause(): Promise<void> {},
  async remove(): Promise<void> {},
  async parse(): Promise<unknown> {
    throw new Error('not used')
  },
  async pollEvents(): Promise<unknown[]> {
    return []
  }
}

after(() => {
  const { closeDb } = require('../db') as typeof import('../db')
  closeDb()
  rmSync(tmp, { recursive: true, force: true })
})

test('A2：无 gid 的 paused 任务 resume → 退回 queued 重过启动闸门（修复前静默卡死）', async () => {
  const mgr = new TaskManager(baseAria2 as unknown as import('../adapters/aria2').Aria2Adapter)
  const { insertTask, getTask } = await import('./store')
  // 模拟「等槽期间被暂停」：queued 等待中未拿到引擎句柄（gid 为空）
  insertTask(makeTask('ctl-a2', { status: 'paused' }))

  await mgr.control({ taskId: 'ctl-a2', action: 'resume' })
  await drain()

  const t = getTask('ctl-a2')
  assert.equal(resumeCalls, 0, '无 gid 时不得调用 aria2.resume（修复前的静默 no-op 源头）')
  assert.equal(startCalls, 1, '应重新走 aria2.start 获取引擎句柄')
  assert.equal(t?.engineGid, 'gid-new', '重派后应登记新 gid')
  assert.notEqual(
    t?.status,
    'running',
    '不得在无 gid 时把状态写成 running（修复前的永久卡死态）'
  )
  assert.equal(t?.status, 'queued', '重派后保持 queued，等待引擎事件确认起跑')
})

test('A1：用户暂停后 start 迟到报错保持 paused（不得覆写成 failed）', async () => {
  const { insertTask, getTask, updateTaskFields } = await import('./store')
  const failAria2 = {
    ...baseAria2,
    // start 在途期间模拟用户并发暂停（DB 状态改为 paused），随后引擎调用报错
    async start(): Promise<string> {
      startCalls++
      updateTaskFields('ctl-a1', { status: 'paused' })
      throw new Error('boom: engine session lost')
    }
  }
  const mgr = new TaskManager(failAria2 as unknown as import('../adapters/aria2').Aria2Adapter)
  insertTask(makeTask('ctl-a1', { status: 'paused' }))

  // 经 A2 重派路径触发 gateStart(runWhenQueued(start))，start 在途报错
  await mgr.control({ taskId: 'ctl-a1', action: 'resume' })
  await drain()

  const t = getTask('ctl-a1')
  assert.equal(t?.status, 'paused', '迟到报错不得把用户暂停态覆写成 failed')
  assert.ok(t?.error?.includes('boom'), '错误信息应留痕（error 字段）供展示')
})
