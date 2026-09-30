// 音乐信号量并发行为回归（M2-6，§4.5：≤4 并发，done 释放槽位再泵）
// 经 Electron-as-Node 运行（better-sqlite3 ABI）。

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const tmp = mkdtempSync(join(tmpdir(), 'og-music-'))
process.env.OMNIGET_TEST_DATA_DIR = tmp

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
  async cancel(): Promise<boolean> {
    return true
  },
  async search(): Promise<unknown> {
    return { candidates: [], degraded: [] }
  },
  async getTask(): Promise<null> {
    return null
  }
} as unknown as import('../music/adapter').MusicAdapter

const drain = (): Promise<void> => new Promise((r) => setTimeout(r, 50))

after(() => {
  const { closeDb } = require('../db') as typeof import('../db')
  closeDb()
  rmSync(tmp, { recursive: true, force: true })
})

let mgr: TaskManager

test('信号量：6 个任务最多 4 并发，done 释放后补位', async () => {
  const aria2Stub = {} as import('../adapters/aria2').Aria2Adapter
  mgr = new TaskManager(aria2Stub)
  mgr.setMusicEngine(fakeAdapter)

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
  await drain()
  assert.equal(maxInflight, 4, `并发峰值应为 4，实际 ${maxInflight}`)
  assert.equal(posted.length, 4, '应只有 4 个 POST 发出')

  // 放行前 4 个 → 触发 done 事件 → 槽位释放 → 剩余 2 个补位
  for (const resolve of resolvers.splice(0)) resolve()
  await drain()
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
  await drain()
  assert.equal(posted.length, 6, '剩余 2 个任务应补位发出')

  // 完成后全部为 completed
  const { listTasks } = await import('./store')
  const done = listTasks({ status: ['completed'] }).filter((t) => t.engine === 'music')
  assert.equal(done.length, 4)
  const stillQueued = listTasks({ status: ['queued'] }).filter((t) => t.engine === 'music')
  assert.equal(stillQueued.length, 2)

  // 清场：放行并终结后 2 个在途任务（svc-5/svc-6），不留悬挂状态给后续用例
  for (const resolve of resolvers.splice(0)) resolve()
  await drain()
  for (let i = 5; i <= 6; i++) {
    mgr.applyMusicEvent({
      type: 'music.done',
      taskId: `svc-${i}`,
      success: true,
      bytes: 100,
      mp3Path: join(tmp, `song-${i - 1}.mp3`)
    })
  }
  await drain()
  assert.equal(
    listTasks({ status: ['queued'] }).filter((t) => t.engine === 'music').length,
    0,
    '测试收尾后不应有 queued 音乐任务'
  )
})

test('quality 落库回读（P2-4 回归：插入/查询/updateTaskFields 三处断链）', async () => {
  const r = await mgr.createMusicTask({
    song: 'q-song',
    quality: 'lossless',
    saveDir: join(tmp, 'dq')
  })
  const { getTask, updateTaskFields } = await import('./store')
  const task = getTask(r.taskId)
  assert.equal(task?.quality, 'lossless', 'createMusicTask 的 quality 必须落库')
  updateTaskFields(r.taskId, { quality: 'standard' })
  assert.equal(getTask(r.taskId)?.quality, 'standard', 'updateTaskFields 必须支持 quality')
})

test('启动恢复：resumeMusicQueue 泵遗留 queued 任务（P1 启动泵缺口回归）', async () => {
  const { insertTask, getTask } = await import('./store')
  const id = 'recover-music-1'
  insertTask({
    id,
    type: 'music',
    source: 'recover artist - recover song',
    name: 'recover artist - recover song',
    engine: 'music',
    status: 'queued', // 模拟重启后 recoverOnStartup 归位（engineGid 为空）
    saveDir: join(tmp, 'dr'),
    totalBytes: 0,
    downloadedBytes: 0,
    speedBps: 0,
    threads: 0,
    quality: 'high',
    createdAt: Date.now()
  })
  mgr.resumeMusicQueue()
  await drain()
  // posted 记录的是 postMusicDownload 解析后的 song 字段（source 含 ' - ' 时拆分）
  assert.ok(posted.includes('recover song'), '遗留 queued 任务应被立即泵出')
  // 放行 download → postMusicDownload 登记 engineGid
  for (const resolve of resolvers.splice(0)) resolve()
  await drain()
  assert.ok(getTask(id)?.engineGid?.startsWith('svc-'), '泵出后应登记 engineGid')
  // 收尾：终结全部在途（含前序用例遗留），保证下个用例从干净槽位开始
  const { listTasks: lt, updateTaskFields: uf } = await import('./store')
  for (const t of lt({ status: ['queued', 'running'] }).filter((t) => t.engine === 'music')) {
    if (t.engineGid) {
      mgr.applyMusicEvent({ type: 'music.done', taskId: t.engineGid, success: true, bytes: 1, mp3Path: 'x.mp3' })
    }
    uf(t.id, { engineGid: null })
  }
  await drain()
})

test('取消/删除运行中任务不泄漏槽位（P1 槽位泄漏回归）', async () => {
  const { getTask, listTasks, updateTaskFields } = await import('./store')

  // 占满 4 个槽位
  const ids: string[] = []
  for (let i = 0; i < 4; i++) {
    const r = await mgr.createMusicTask({
      song: `leak-${i}`,
      quality: 'high',
      saveDir: join(tmp, `dl${i}`)
    })
    ids.push(r.taskId)
  }
  await drain()
  // 放行 download → engineGid 登记（postMusicDownload 在 download resolve 后写库）
  for (const resolve of resolvers.splice(0)) resolve()
  await drain()
  const firstId = ids[0] ?? ''
  const gid0 = getTask(firstId)?.engineGid ?? ''
  assert.ok(gid0, '第一个任务应已泵出并登记 gid')

  // 删除运行中任务（remove 清 gid + 软删，引擎随后回发 done(cancelled)）
  await mgr.control({ taskId: firstId, action: 'remove' })
  mgr.applyMusicEvent({ type: 'music.done', taskId: gid0, cancelled: true, success: false })

  // 修复前：槽位未释放，第 5 个任务永远 queued；修复后：立即泵出并获得 gid
  const r5 = await mgr.createMusicTask({ song: 'leak-post', quality: 'high', saveDir: join(tmp, 'dlpost') })
  await drain()
  assert.ok(
    posted.includes('leak-post'),
    'done(cancelled) 后应释放槽位并泵出新任务'
  )
  for (const resolve of resolvers.splice(0)) resolve()
  await drain()
  assert.ok(getTask(r5.taskId)?.engineGid, '新任务应获得 engineGid（槽位未泄漏）')

  // 收尾：终结全部在途，避免污染后续
  for (const t of listTasks({ status: ['queued', 'running'] }).filter((t) => t.engine === 'music')) {
    updateTaskFields(t.id, { engineGid: null })
  }
  for (const resolve of resolvers.splice(0)) resolve()
  await drain()
})
