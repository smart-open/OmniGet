import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TaskEventMerger } from './events'

test('250ms 窗口合并：同任务进度只保留最后一条（§6.1）', async () => {
  const flushed: unknown[] = []
  const merger = new TaskEventMerger(50, (events) => flushed.push(events))

  merger.push({ taskId: 'a', downloadedBytes: 100, speedBps: 10 })
  merger.push({ taskId: 'a', downloadedBytes: 200, speedBps: 20 })
  merger.push({ taskId: 'b', downloadedBytes: 1 })
  merger.push({ taskId: 'a', downloadedBytes: 300, speedBps: 30 })

  await new Promise((r) => setTimeout(r, 80))
  assert.equal(flushed.length, 1)
  const batch = flushed[0] as { taskId: string; downloadedBytes: number }[]
  assert.equal(batch.length, 2)
  const a = batch.find((e) => e.taskId === 'a')
  assert.equal(a?.downloadedBytes, 300)
  merger.dispose()
})

test('drop：丢弃窗口内未 flush 的合并事件（暂停/恢复回放竞态防护）', async () => {
  const flushed: unknown[] = []
  const merger = new TaskEventMerger(50, (events) => flushed.push(events))

  merger.push({ taskId: 'a', status: 'running' })
  merger.push({ taskId: 'b', status: 'running' })
  merger.drop('a') // 用户刚暂停：窗口内的陈旧 running 事件必须作废

  await new Promise((r) => setTimeout(r, 80))
  assert.equal(flushed.length, 1)
  const batch = flushed[0] as { taskId: string }[]
  assert.deepEqual(
    batch.map((e) => e.taskId),
    ['b'],
    '被 drop 的任务不得回放，其他任务事件不受影响'
  )
  merger.dispose()
})

test('drop 不存在的 taskId：静默无副作用', async () => {
  const flushed: unknown[] = []
  const merger = new TaskEventMerger(50, (events) => flushed.push(events))
  merger.push({ taskId: 'x', downloadedBytes: 1 })
  merger.drop('不存在')
  await new Promise((r) => setTimeout(r, 80))
  assert.equal(flushed.length, 1, 'drop 未知 id 不应影响其他窗口事件')
  merger.dispose()
})
