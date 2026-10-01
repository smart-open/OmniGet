// save-dir 校验回归（H9/H1）：写盘最后防线（纯函数，离线可测）
import test from 'node:test'
import assert from 'node:assert/strict'
import { validateSaveDir } from './save-dir'

test('空目录/相对路径/空字节拒绝', () => {
  assert.ok(validateSaveDir(''))
  assert.ok(validateSaveDir('relative/path'))
  assert.ok(validateSaveDir('D:\\bad\\dir\0'))
})

test('系统目录拒绝（含盘符泛化）', () => {
  assert.ok(validateSaveDir('/windows/temp'))
  assert.ok(validateSaveDir('C:\\Windows\\Temp'))
  assert.ok(validateSaveDir('D:\\Program Files\\x'))
})

test('凭据/自启动目录拒绝', () => {
  const profile = process.env.USERPROFILE ?? process.env.HOME ?? ''
  if (profile) {
    assert.ok(validateSaveDir(`${profile}\\.ssh`))
    assert.ok(validateSaveDir(`${profile}\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu`))
  }
})

test('P3 回归：UNC 路径拒绝（SMB 出站认证风险）', () => {
  assert.ok(validateSaveDir('\\\\server\\share'))
})

test('合法用户目录通过', () => {
  assert.equal(validateSaveDir('D:\\downloads'), null)
  assert.equal(validateSaveDir('C:\\Users\\me\\Downloads'), null)
})
