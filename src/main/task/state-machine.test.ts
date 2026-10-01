import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assertTransition, canTransition, IllegalTransitionError } from './state-machine'

test('合法转移：parsing → awaiting → queued → running → verifying → completed', () => {
  assertTransition('parsing', 'awaiting')
  assertTransition('awaiting', 'queued')
  assertTransition('queued', 'running')
  assertTransition('running', 'verifying')
  assertTransition('verifying', 'completed')
})

test('awaiting 可跳过：parsing → queued（HTTP/音乐单曲，§4.1 注记）', () => {
  assertTransition('parsing', 'queued')
})

test('seeding 仅从 running/verifying 语义进入且回 completed', () => {
  assertTransition('seeding', 'completed')
})

test('seeding 可落 failed（M-4：做种中出错不得卡死在非终态）', () => {
  assertTransition('seeding', 'failed')
})

test('paused 双向：running → paused → running，paused → queued', () => {
  assertTransition('running', 'paused')
  assertTransition('paused', 'running')
  assertTransition('paused', 'queued')
})

test('failed 重试：failed → queued', () => {
  assertTransition('failed', 'queued')
})

test('非法转移被拒', () => {
  const illegal: [Parameters<typeof canTransition>[0], Parameters<typeof canTransition>[1]][] = [
    ['completed', 'running'],
    ['completed', 'queued'],
    ['parsing', 'completed'],
    ['awaiting', 'running'],
    ['verifying', 'running'],
    ['seeding', 'running'],
    ['failed', 'completed']
  ]
  for (const [from, to] of illegal) {
    assert.throws(() => assertTransition(from, to), IllegalTransitionError)
    assert.equal(canTransition(from, to), false)
  }
})
