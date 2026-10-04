// store 层回归（DB 迁移重放 / 软删 / 查重过滤）：经 env 降级在纯 Node 下运行。

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const tmp = mkdtempSync(join(tmpdir(), 'og-store-'))
process.env.OMNIGET_TEST_DATA_DIR = tmp

before(() => {
  // env.userDataDir 支持 OMNIGET_TEST_DATA_DIR 覆盖（见 env.ts）
})

import { getDb, closeDb } from '../db'
import {
  insertTask,
  getTask,
  listTasks,
  softDeleteTask,
  restoreTask,
  purgeTask,
  findTaskByInfohash,
  saveTaskFiles,
  getTaskFiles,
  setTaskFileSelection,
  updateTaskFields
} from './store'
import type { Task } from '@shared/types'

function makeTask(id: string, over: Partial<Task> = {}): Task {
  return {
    id,
    type: 'magnet',
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

test('迁移可重放：user_version=3 且全表就绪', () => {
  const db = getDb()
  const v = db.pragma('user_version', { simple: true }) as number
  assert.equal(v, 3)
  const tables = (
    db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
  ).map((r) => r.name)
  for (const t of ['tasks', 'task_files', 'settings', 'trackers', 'daily_stats', 'subscriptions', 'music_tracks']) {
    assert.ok(tables.includes(t), `missing table ${t}`)
  }
})

test('task CRUD + seedRatio 落库', () => {
  insertTask(makeTask('a1', { seedRatio: 1.5 }))
  const t = getTask('a1')
  assert.ok(t)
  assert.equal(t?.seedRatio, 1.5)
  updateTaskFields('a1', { name: 'renamed', status: 'completed', completedAt: 123 })
  const t2 = getTask('a1')
  assert.equal(t2?.name, 'renamed')
  assert.equal(t2?.status, 'completed')
})

test('软删除/恢复/彻底删除（§4.5 回收站）', () => {
  insertTask(makeTask('a2'))
  softDeleteTask('a2')
  // 默认列表不含回收站任务；getTask 按 id 取（回收站行仍可直接操作）
  assert.ok(getTask('a2'))
  assert.ok(!listTasks({}).some((t) => t.id === 'a2'))
  assert.equal(listTasks({ onlyDeleted: true }).length, 1)
  restoreTask('a2')
  assert.ok(listTasks({}).some((t) => t.id === 'a2'))
  purgeTask('a2')
  assert.equal(getTask('a2'), null)
})

test('B7：infohash 查重排除回收站任务', () => {
  insertTask(makeTask('a3'))
  updateTaskFields('a3', { infohash: 'dc9e7581aabbccddeeff00112233445566778899' })
  softDeleteTask('a3')
  assert.equal(
    findTaskByInfohash('dc9e7581aabbccddeeff00112233445566778899'),
    null,
    '回收站任务不应命中查重'
  )
  restoreTask('a3')
  assert.ok(findTaskByInfohash('DC9E7581AABBCCDDEEFF00112233445566778899'))
})

test('task_files：保存/勾选回放/顺序保持（§5 相对路径口径）', () => {
  insertTask(makeTask('a4'))
  saveTaskFiles('a4', [
    { path: 'V/1.mp4', size: 100, selected: true, downloaded: 0 },
    { path: 'V/2.mp4', size: 200, selected: true, downloaded: 0 },
    { path: 'P/1.jpg', size: 10, selected: true, downloaded: 0 }
  ])
  setTaskFileSelection('a4', ['V/1.mp4', 'P/1.jpg'])
  const files = getTaskFiles('a4')
  assert.equal(files.length, 3)
  assert.equal(files[0]?.selected, true)
  assert.equal(files[1]?.selected, false)
  assert.equal(files[2]?.selected, true)
  // 顺序 = 保存顺序（re-add 时 index = 顺序 + 1 的依据）
  assert.deepEqual(files.map((f) => f.path), ['V/1.mp4', 'V/2.mp4', 'P/1.jpg'])
})
