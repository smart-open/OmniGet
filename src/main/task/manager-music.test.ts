// 音乐信号量并发行为回归（M2-6，§4.5：≤4 并发，done 释放槽位再泵）
// 经 Electron-as-Node 运行（better-sqlite3 ABI）。

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const tmp = mkdtempSync(join(tmpdir(), 'og-music-'))
process.env.OMNIGET_TEST_DATA_DIR = tmp

before(() => {})

import { TaskManager } from './manager'

// —— MusicAdapter 打桩：记录并发峰值，手动放行 ——
let inflight = 0
let maxInflight = 0
const resolvers: Array<() => void> = []
const posted: string[] = []

const fakeAdapter = {
  isOnline: true,
  async download(req: { song?: string; q?: string; neteaseId?: string }): Promise<string> {
    inflight++
    maxInflight = Math.max(maxInflight, inflight)
    // 序号必须在调用时同步捕获（await 后 posted.length 会变）
    const seq = posted.push(req.neteaseId ?? req.song ?? req.q ?? '?')
    await new Promise<void>((r) => resolvers.push(r))
    inflight--
    return 'svc-' + seq
  },
  async search(): Promise<unknown> {
    return { candidates: [], degraded: [] }
  },
  async getTask(): Promise<null> {
    return null
  }
} as unknown as import('../adapters/music').MusicAdapter

after(() => {
  const { closeDb } = require('../db') as typeof import('../db')
  closeDb()
  rmSync(tmp, { recursive: true, force: true })
})

test('信号量：6 个任务最多 4 并发，done 释放后补位', async () => {
  const aria2Stub = {} as import('../adapters/aria2').Aria2Adapter
  const mgr = new TaskManager(aria2Stub)
  mgr.setMusicEngine(fakeAdapter)
  mgr.onMusicEngineOnline()

  const ids: string[] = []
  for (let i = 0; i < 6; i++) {
    const r = await mgr.createMusicTask({
      song: `song-${i}`,
      quality: 'high',
      saveDir: join(tmp, `d${i}`)
    })
    ids.push(r.taskId)
  }

  // 泵为异步 void：等待微任务排空
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(maxInflight, 4, `并发峰值应为 4，实际 ${maxInflight}`)
  assert.equal(posted.length, 4, '应只有 4 个 POST 发出')

  // 放行前 4 个 → 触发 done 事件 → 槽位释放 → 剩余 2 个补位
  for (const resolve of resolvers.splice(0)) resolve()
  await new Promise((r) => setTimeout(r, 50))
  // done 事件按 service taskId 查任务：engineGid = svc-N
  for (let i = 1; i <= 4; i++) {
    mgr.applyMusicEvent({
      type: 'music.done',
      taskId: `svc-${i}`,
      success: true,
      bytes: 100,
      mp3Path: join(tmp, `d${i - 1}`, `song-${i - 1}.mp3`)
    })
  }
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(posted.length, 6, '剩余 2 个任务应补位发出')

  // 完成后全部为 completed
  const { listTasks } = await import('./store')
  const done = listTasks({ status: ['completed'] }).filter((t) => t.engine === 'music')
  assert.equal(done.length, 4)
  const stillQueued = listTasks({ status: ['queued'] }).filter((t) => t.engine === 'music')
  assert.equal(stillQueued.length, 2)

  // B1：服务下线清信号量，上线清 gid 重泵
  mgr.onMusicEngineOffline()
  mgr.onMusicEngineOnline()
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(maxInflight, 4, '重泵后并发仍受 4 限制')
})
