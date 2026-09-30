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
