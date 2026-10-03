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
  // 跨平台审查修复：isAbsolute 语义随平台变化（'D:\x' 在 POSIX 是相对路径），
  // 断言按平台分流，保证 ubuntu CI / mac 本地测试均可通过
  if (process.platform === 'win32') {
    assert.equal(validateSaveDir('D:\\downloads'), null)
    assert.equal(validateSaveDir('C:\\Users\\me\\Downloads'), null)
  } else {
    assert.equal(validateSaveDir('/home/me/downloads'), null)
    assert.equal(validateSaveDir('/opt/mydata/downloads'), null)
  }
})

test('跨平台审查 P1：macOS /private 符号链接真实形态与顶层系统目录拒绝', () => {
  assert.ok(validateSaveDir('/private/etc'))
  assert.ok(validateSaveDir('/private/tmp/evil'))
  assert.ok(validateSaveDir('/private/var/root'))
  assert.ok(validateSaveDir('/library/fonts'))
})

test('回归审查 #2：盘符相对路径 bug——不存在的新目录不得被误判（win）', () => {
  // realish 曾用 join('C:', ...) 产出 drive-relative 路径（'C:Users'），
  // realpath 按「该盘当前目录」解析 → cwd 在 C:\Windows 时合法目录被误判为系统目录
  if (process.platform === 'win32') {
    assert.equal(validateSaveDir('C:\\Users\\nobody\\downloads-new-dir'), null)
  }
})

test('回归审查 #13：盘符根 / 文件系统根拒绝（整盘落盘无意义且放行子路径绕过）', () => {
  assert.ok(validateSaveDir('C:\\'))
  assert.ok(validateSaveDir('D:\\'))
  assert.ok(validateSaveDir('/'))
})

test('回归审查 #5：正斜杠 UNC 形态拒绝', () => {
  assert.ok(validateSaveDir('//server/share'))
})
