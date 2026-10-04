// 渲染层 store 单测（第七轮补齐「渲染层测试为零」缺口的最小闭环）：
// 覆盖 tasks store 的事件合流 / 删除事件 / 未知任务防抖重载与记忆 / 置顶乐观回滚。
// window.omniget 桥以内存 mock 顶替（store 只在调用期触桥，import 期无副作用）。
// 注：tsx 在 CJS 输出下不支持顶层 await——用例内动态 import（模块缓存复用）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Task, TaskEvent } from '@shared/types'
import type { useTasks as UseTasks } from './tasks'

const listTasksCalls: string[] = []
const settingsSetCalls: Array<{ key: string; value: unknown }> = []
let settingsSetShouldFail = false
;(globalThis as unknown as { window: unknown }).window = {
  omniget: {
    listTasks: async (filter: string) => {
      listTasksCalls.push(filter)
      if (filter === 'slow') {
        // 乱序防护用例：由用例自行 resolve
        return await new Promise<Task[]>((resolve) => {
          ;(globalThis as unknown as { __resolveSlow: (v: Task[]) => void }).__resolveSlow = resolve
        })
      }
      return [seedTask({ id: 'fast', name: 'fast.zip' })]
    },
    settingsGet: async () => null,
    settingsSet: async (key: string, value: unknown) => {
      settingsSetCalls.push({ key, value })
      if (settingsSetShouldFail) throw new Error('write failed')
      return undefined
    },
    taskCounts: async () => ({ running: 0, queued: 0, completed: 0, failed: 0, trashed: 0 })
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function seedTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1',
    type: 'http',
    source: 'https://example.com/file.zip',
    name: 'file.zip',
    engine: 'aria2',
    status: 'downloading',
    saveDir: '/tmp',
    totalBytes: 1000,
    downloadedBytes: 100,
    speedBps: 0,
    threads: 8,
    ...overrides
  } as Task
}

// 模块级 store 引用（首次 loadStore 后可用）
let store: typeof UseTasks | null = null
const loadStore = async (): Promise<typeof UseTasks> => {
  const mod = await import('./tasks')
  store = mod.useTasks
  return store
}

function useTasks(): typeof UseTasks {
  if (!store) throw new Error('store 尚未加载（用例须先 await loadStore()）')
  return store
}

function reset(): void {
  useTasks().setState({
    tasks: new Map(),
    engines: [],
    globalSpeedBps: 0,
    speedHistory: [],
    stageById: {},
    selectedTaskId: null,
    pinned: [],
    counts: { running: 0, queued: 0, completed: 0, failed: 0, trashed: 0 },
    loadError: null,
    loadedFilter: 'all',
    loading: false
  })
}

test('applyEvents：进度/状态合流到已知任务，非 failed 状态清除旧错误', async () => {
  await loadStore()
  reset()
  const t = seedTask({ error: '上次失败' })
  useTasks().setState({ tasks: new Map([[t.id, t]]) })
  useTasks().getState().applyEvents([
    { taskId: 't1', status: 'running', downloadedBytes: 500, speedBps: 2048 } as TaskEvent
  ])
  const cur = useTasks().getState().tasks.get('t1')
  assert.equal(cur?.status, 'running')
  assert.equal(cur?.downloadedBytes, 500)
  assert.equal(cur?.speedBps, 2048)
  assert.equal(cur?.error, undefined, '重试/恢复成功后旧错误必须清除')
})

test('applyEvents：failed 事件保留错误文案，removed 事件删除条目', async () => {
  await loadStore()
  reset()
  const t = seedTask()
  useTasks().setState({ tasks: new Map([[t.id, t]]) })
  useTasks().getState().applyEvents([
    { taskId: 't1', status: 'failed', error: '磁盘已满' } as TaskEvent
  ])
  assert.equal(useTasks().getState().tasks.get('t1')?.error, '磁盘已满')
  useTasks().getState().applyEvents([{ taskId: 't1', removed: true } as TaskEvent])
  assert.equal(useTasks().getState().tasks.has('t1'), false, 'removed 后本地列表必须移除条目')
})

test('未知任务：400ms 防抖重载当前视图，同任务记忆后不重复重载', async () => {
  await loadStore()
  reset()
  await useTasks().getState().load('completed')
  const before = listTasksCalls.length
  useTasks().getState().applyEvents([
    { taskId: 'ghost', status: 'running' } as TaskEvent
  ])
  await sleep(500)
  assert.ok(listTasksCalls.length > before, '未知任务必须触发一次防抖重载')
  const afterFirst = listTasksCalls.length
  // 同一 taskId 再次出现：unknownReloadSeen 记忆（loadedFilter+taskId）→ 不再重载
  useTasks().getState().applyEvents([
    { taskId: 'ghost', status: 'running', downloadedBytes: 1 } as TaskEvent
  ])
  await sleep(500)
  assert.equal(listTasksCalls.length, afterFirst, '已记忆的未知任务不得无限重载')
})

test('未知任务：换视图 load 成功后清空记忆，重新放行一次重载', async () => {
  await loadStore()
  reset()
  await useTasks().getState().load('completed')
  useTasks().getState().applyEvents([{ taskId: 'ghost2', status: 'running' } as TaskEvent])
  await sleep(500)
  const afterFirst = listTasksCalls.length
  await useTasks().getState().load('all') // 换视图 → unknownReloadSeen 清空
  useTasks().getState().applyEvents([{ taskId: 'ghost2', status: 'running' } as TaskEvent])
  await sleep(500)
  assert.ok(listTasksCalls.length > afterFirst, '换视图后同一未知任务应重新触发一次重载')
})

test('togglePin：乐观置顶成功持久化；失败按操作方向回滚', async () => {
  await loadStore()
  reset()
  settingsSetShouldFail = false
  useTasks().setState({ pinned: [] })
  useTasks().getState().togglePin('a')
  assert.deepEqual(useTasks().getState().pinned, ['a'])
  await sleep(20)
  assert.equal(settingsSetCalls.at(-1)?.key, 'ui.pinnedTasks')

  settingsSetShouldFail = true
  useTasks().getState().togglePin('b')
  assert.deepEqual(useTasks().getState().pinned, ['b', 'a'], '乐观更新先行')
  await sleep(20)
  assert.deepEqual(useTasks().getState().pinned, ['a'], '失败后按本次方向回滚（移除 b）')
  settingsSetShouldFail = false
})

test('load：乱序防护——过期响应不覆盖新状态', async () => {
  await loadStore()
  reset()
  const slowPromise = useTasks().getState().load('slow')
  await useTasks().getState().load('all')
  assert.equal(useTasks().getState().loadedFilter, 'all')
  assert.equal(useTasks().getState().tasks.has('fast'), true)
  const g = globalThis as unknown as { __resolveSlow?: (v: Task[]) => void }
  g.__resolveSlow?.([])
  await slowPromise
  assert.equal(
    useTasks().getState().loadedFilter,
    'all',
    '过期 load 响应不得覆盖最新过滤器'
  )
})
