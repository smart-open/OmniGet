// 二期（0.9.x 双语歌词）：LRC 双轨合并回归
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const tmp = mkdtempSync(join(tmpdir(), 'og-lrc-'))
process.env.OMNIGET_TEST_DATA_DIR = tmp

import { mergeBilingualLrc, getLyricsMode } from './lyrics'

after(() => {
  const { closeDb } = require('../db') as typeof import('../db')
  closeDb()
  rmSync(tmp, { recursive: true, force: true })
})

test('逐时间戳合并：译文行紧贴原文行下', () => {
  const orig = '[00:01.50]Hello\n[00:04.00]World\n'
  const trans = '[00:01.50]你好\n[00:04.00]世界\n'
  const merged = mergeBilingualLrc(orig, trans)
  const lines = merged.split('\n').filter(Boolean)
  assert.deepEqual(lines, ['[00:01.50]Hello', '你好', '[00:04.00]World', '世界'])
})

test('无翻译的时间戳行原样保留；元数据行不动', () => {
  const orig = '[ti:Test]\n[00:01.00]Only\n[00:02.00]NoTrans\n'
  const trans = '[00:01.00]只有\n'
  const merged = mergeBilingualLrc(orig, trans)
  const lines = merged.split('\n').filter(Boolean)
  assert.deepEqual(lines, ['[ti:Test]', '[00:01.00]Only', '只有', '[00:02.00]NoTrans'])
})

test('时间戳精度归一：厘秒与毫秒同键匹配', () => {
  const orig = '[00:01.20]A\n'
  const trans = '[00:01.200]甲\n'
  const merged = mergeBilingualLrc(orig, trans)
  assert.ok(merged.includes('甲'), `毫秒时间戳应命中：${merged}`)
})

test('空译文/无时间戳译文被忽略，原文完整保留', () => {
  const orig = '[00:01.00]A\n[00:02.00]B\n'
  const trans = '纯文本翻译行\n[00:01.00]\n'
  const merged = mergeBilingualLrc(orig, trans)
  assert.equal(merged.split('\n').filter(Boolean).length, 2)
  assert.ok(!merged.includes('纯文本翻译行'))
})

test('歌词模式默认 original（设置未写入时）', () => {
  assert.equal(getLyricsMode(), 'original')
})
