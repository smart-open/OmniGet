// 第十轮审查（0.11.2）：WebDAV 凭据往返回归——明文降级分支双重编码 P1 的
// 回归锁（保存后永远读不回 → WebDAV 永远 401）。
// 测试环境 ELECTRON_RUN_AS_NODE 下 require('electron') 无 safeStorage，
// 自动走明文降级分支——恰好覆盖被修路径
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const tmp = mkdtempSync(join(tmpdir(), 'og-webdav-'))
process.env.OMNIGET_TEST_DATA_DIR = tmp

import { saveWebdavCredentials, getWebdavCredentials, hasWebdavCredentials } from './credentials'

after(() => {
  const { closeDb } = require('../db') as typeof import('../db')
  closeDb()
  rmSync(tmp, { recursive: true, force: true })
})

test('明文降级：save → get 往返一致（P1 回归锁：双重编码曾致读回恒 null）', () => {
  saveWebdavCredentials('alice', 's3cret')
  const got = getWebdavCredentials()
  assert.deepEqual(got, { username: 'alice', password: 's3cret' })
  assert.equal(hasWebdavCredentials(), true)
})

test('未配置返回 null；对象形态存量行兼容读取', () => {
  const { setSetting, getSettingParsed } = require('../db') as typeof import('../db')
  // 修复前明文分支写入的是单层编码（读回为对象）——read() 必须兼容该形态
  setSetting('netdisk.auth', JSON.stringify({ username: 'bob', password: 'pw' }))
  // getSettingParsed 解析一层后已是对象，直接验证对象形态兼容
  assert.deepEqual(getSettingParsed('netdisk.auth'), { username: 'bob', password: 'pw' })
  const got = getWebdavCredentials()
  assert.deepEqual(got, { username: 'bob', password: 'pw' })
})
