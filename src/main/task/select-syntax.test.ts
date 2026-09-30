import { test } from 'node:test'
import assert from 'node:assert/strict'
import { matchSelectSyntax } from '@shared/select-syntax'

const paths = [
  'V/VID_001.mp4',
  'V/VID_002.mp4',
  'P/001.jpg',
  'P/002.jpg',
  'promo.txt'
]

test('索引区间：1,3,5-10（越界裁剪）', () => {
  const r = matchSelectSyntax('1,3,5-10', paths)
  assert.deepEqual([...r.indexes].sort(), [1, 3, 5])
  assert.equal(r.indexOnly, true)
})

test('关键词：VID,mp4 命中并集', () => {
  const r = matchSelectSyntax('VID,mp4', paths)
  assert.deepEqual([...r.indexes].sort(), [1, 2])
  assert.equal(r.indexOnly, false)
})

test('混用取并集（§4.2）：1, 3-4, jpg', () => {
  const r = matchSelectSyntax('1, 3-4, jpg', paths)
  assert.deepEqual([...r.indexes].sort(), [1, 3, 4])
})

test('空输入返回空集', () => {
  const r = matchSelectSyntax('  ', paths)
  assert.equal(r.indexes.size, 0)
})
