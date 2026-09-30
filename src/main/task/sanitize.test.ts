import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeFilename, sanitizeRelativePath } from '@shared/sanitize'

test('Windows 非法字符替换（§4.5）', () => {
  assert.equal(sanitizeFilename('a<b>c:"d|e?*f'), 'a_b_c__d_e__f')
})

test('保留名处理：CON/NUL/COM1 前缀加下划线', () => {
  assert.equal(sanitizeFilename('CON'), '_CON')
  assert.equal(sanitizeFilename('nul.mp4'), '_nul.mp4')
  assert.equal(sanitizeFilename('COM1'), '_COM1')
})

test('末尾空格/点剔除', () => {
  assert.equal(sanitizeFilename('name... '), 'name')
})

test('控制字符剔除', () => {
  assert.equal(sanitizeFilename('a\x00b\x1fc'), 'abc')
})

test('超长截断（260 MAX_PATH 口径预留）', () => {
  const long = 'x'.repeat(300)
  assert.ok(sanitizeFilename(long).length <= 200)
})

test('相对路径分段清洗且保留结构', () => {
  assert.equal(sanitizeRelativePath('V/a<b>/c?d.mp4'), 'V/a_b_/c_d.mp4')
  // 目录穿越段被中和
  assert.equal(sanitizeRelativePath('../evil/x'), '_/evil/x')
})

test('空名兜底', () => {
  assert.equal(sanitizeFilename('...'), '_unnamed')
})
