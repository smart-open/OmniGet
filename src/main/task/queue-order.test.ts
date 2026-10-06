import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { interleaveByGroup, type QueueEntry } from './queue-order'

function entry(id: string, group?: string): QueueEntry & { id: string } {
  return { id, group, run: () => {} }
}

describe('interleaveByGroup（五期：启动队列分组轮转）', () => {
  it('空队列为空序', () => {
    assert.deepEqual(interleaveByGroup([]), [])
  })

  it('同组保持 FIFO', () => {
    const out = interleaveByGroup([entry('a1', '订阅A'), entry('a2', '订阅A'), entry('a3', '订阅A')])
    assert.deepEqual(out.map((e) => e.id), ['a1', 'a2', 'a3'])
  })

  it('跨组交替：单订阅批量不饿死手动任务', () => {
    const out = interleaveByGroup([
      entry('s1', '订阅A'),
      entry('s2', '订阅A'),
      entry('s3', '订阅A'),
      entry('m1'),
      entry('m2')
    ])
    assert.deepEqual(out.map((e) => e.id), ['s1', 'm1', 's2', 'm2', 's3'])
  })

  it('无标签任务合并为同一匿名组', () => {
    const out = interleaveByGroup([entry('m1'), entry('s1', '订阅A'), entry('m2')])
    assert.deepEqual(out.map((e) => e.id), ['m1', 's1', 'm2'])
  })

  it('多组均匀轮转且各组保序', () => {
    const out = interleaveByGroup([
      entry('a1', 'A'),
      entry('b1', 'B'),
      entry('a2', 'A'),
      entry('c1', 'C'),
      entry('b2', 'B')
    ])
    // 轮转序：第 1 轮 A/B/C 各出一个（a1,b1,c1），第 2 轮剩 A/B（a2,b2）
    assert.deepEqual(out.map((e) => e.id), ['a1', 'b1', 'c1', 'a2', 'b2'])
    assert.deepEqual(out.slice(0, 3).map((e) => e.group), ['A', 'B', 'C'])
  })
})
