// backlog #26（2026-10-03）：网盘/WebDAV 凭据安全存储。
// Electron safeStorage（Windows DPAPI / macOS Keychain / libsecret）加密后落 settings 表；
// safeStorage 不可用（无头/测试环境）降级明文并留痕日志。凭据仅注入请求头：
// 不入日志、不经 settingsGet 回显（ipc.ts 读取黑名单 + 不进写白名单）。

import { getSettingParsed, setSetting } from '../db'
import { createLogger } from '../logger'

const log = createLogger('netdisk-credentials')

export interface WebdavCredentials {
  username: string
  password: string
}

const KEY_ENC = 'netdisk.auth.enc'
const KEY_PLAIN = 'netdisk.auth'

interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(plain: string): Buffer
  decryptString(encrypted: Buffer): string
}

function safeStorage(): SafeStorageLike | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { safeStorage: ss } = require('electron') as { safeStorage?: SafeStorageLike }
    if (ss && typeof ss.isEncryptionAvailable === 'function' && ss.isEncryptionAvailable()) {
      return ss
    }
    return null
  } catch {
    return null
  }
}

function normalizeCreds(obj: Partial<WebdavCredentials>): WebdavCredentials | null {
  if (typeof obj.username === 'string' && obj.username) {
    return { username: obj.username, password: typeof obj.password === 'string' ? obj.password : '' }
  }
  return null
}

export function saveWebdavCredentials(username: string, password: string): void {
  const payload = JSON.stringify({ username, password } satisfies WebdavCredentials)
  const ss = safeStorage()
  if (ss) {
    setSetting(KEY_ENC, JSON.stringify(ss.encryptString(payload).toString('base64')))
    // 顺带清掉历史明文（写 null 即等效清除）
    setSetting(KEY_PLAIN, 'null')
    return
  }
  log.warn('safeStorage 不可用，WebDAV 凭据降级明文存储（仅本地 settings 表）')
  // 第十轮审查 P1：getSettingParsed 读取时会 JSON.parse 一层——此处必须把
  // payload 字符串再编码一层，否则读回的是对象而 read() 只认 string，
  // 凭据写入即丢失（保存后永远 401）
  setSetting(KEY_PLAIN, JSON.stringify(payload))
  setSetting(KEY_ENC, 'null')
}

/** 读取凭据；未配置/解密失败返回 null（调用方按匿名访问处理或明确报错） */
export function getWebdavCredentials(): WebdavCredentials | null {
  const read = (raw: unknown): WebdavCredentials | null => {
    // 第十轮审查：兼容对象形态（修复前明文降级分支单层编码写入的存量行）
    if (raw !== null && typeof raw === 'object') {
      return normalizeCreds(raw as Partial<WebdavCredentials>)
    }
    if (typeof raw !== 'string') return null
    try {
      const obj = JSON.parse(raw) as Partial<WebdavCredentials>
      return normalizeCreds(obj)
    } catch {
      // 结构损坏按未配置处理
    }
    return null
  }
  const enc = getSettingParsed<string | null>(KEY_ENC)
  const ss = safeStorage()
  if (typeof enc === 'string' && enc && ss) {
    try {
      return read(ss.decryptString(Buffer.from(enc, 'base64')))
    } catch (err) {
      log.warn('WebDAV 凭据解密失败（系统环境变化？），按未配置处理', { error: String(err) })
      return null
    }
  }
  if (typeof enc === 'string' && enc && !ss) {
    // 第六轮审查：密文存在但 safeStorage 不可用（如 keytar/系统密钥环不可用）时
    // 静默落空——用户只会看到「需要认证」，无从得知凭据已不可解密
    log.warn('WebDAV 凭据为密文但 safeStorage 不可用，按未配置处理')
  }
  return read(getSettingParsed<unknown>(KEY_PLAIN))
}

export function hasWebdavCredentials(): boolean {
  return getWebdavCredentials() !== null
}
