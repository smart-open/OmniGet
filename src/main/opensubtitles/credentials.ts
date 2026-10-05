// 四期（0.11.x，roadmap「OpenSubtitles 入库钩子」）：API Key 安全存储。
// 同 backlog #26 netdisk 口径：Electron safeStorage（Windows DPAPI / Keychain /
// libsecret）加密后落 settings 表；safeStorage 不可用降级明文并留痕。
// 经专用 IPC 写入；不进 settingsGet 回显（ipc.ts 读取黑名单）与写白名单。

import { getSettingParsed, setSetting } from '../db'
import { createLogger } from '../logger'

const log = createLogger('opensubtitles-credentials')

const KEY_ENC = 'opensubtitles.key.enc'
const KEY_PLAIN = 'opensubtitles.key'

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

export function saveOpensubtitlesKey(apiKey: string): void {
  const ss = safeStorage()
  if (ss) {
    setSetting(KEY_ENC, JSON.stringify(ss.encryptString(apiKey).toString('base64')))
    setSetting(KEY_PLAIN, 'null')
    return
  }
  log.warn('safeStorage 不可用，OpenSubtitles API Key 降级明文存储（仅本地 settings 表）')
  // 第九轮审查：明文回退同样 JSON 编码落库——纯数字/JSON 字面量 Key 在裸文本
  // 形态会被 getSettingParsed 解析成 number/null 而被判「未配置」（与 netdisk
  // 凭据通道口径对称）
  setSetting(KEY_PLAIN, JSON.stringify(apiKey))
  setSetting(KEY_ENC, 'null')
}

/** 第九轮审查：兼容双形态——新版 JSON 编码 + 旧版裸文本（历史明文 Key）；
 * 纯数字 Key 在裸文本形态解析为 number，按类型回收 */
function readPlainKey(): string | null {
  const v = getSettingParsed<unknown>(KEY_PLAIN)
  if (typeof v === 'string') return v || null
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return null
}

/** 读取 API Key；未配置/解密失败返回 null */
export function getOpensubtitlesKey(): string | null {
  const enc = getSettingParsed<string | null>(KEY_ENC)
  const ss = safeStorage()
  if (typeof enc === 'string' && enc && ss) {
    try {
      const key = ss.decryptString(Buffer.from(enc, 'base64'))
      return key || null
    } catch (err) {
      log.warn('OpenSubtitles API Key 解密失败（系统环境变化？），按未配置处理', { error: String(err) })
      return null
    }
  }
  return readPlainKey()
}

export function hasOpensubtitlesKey(): boolean {
  return getOpensubtitlesKey() !== null
}

/** 四期审查：存储形态回显——safeStorage 降级明文时 UI 不得谎称「加密存储」 */
export function keyStorageInfo(): { hasKey: boolean; encrypted: boolean } {
  const enc = getSettingParsed<string | null>(KEY_ENC)
  const ss = safeStorage()
  if (typeof enc === 'string' && enc && ss) {
    try {
      const key = ss.decryptString(Buffer.from(enc, 'base64'))
      if (key) return { hasKey: true, encrypted: true }
    } catch {
      // 解密失败按未配置处理（与 getOpensubtitlesKey 口径一致）
    }
  }
  return { hasKey: readPlainKey() !== null, encrypted: false }
}
