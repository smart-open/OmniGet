// Backlog：平台适配脚本注册表（内置自维护 + userData 热更目录）
// 定位：M4-16 已做 Tracker 接口化与热更通道；本模块把同样的"改版自救"能力
// 扩展到平台适配层——脚本 = JSON 清单（版本 + host 重写表），平台 API 改版时
// 改 JSON 即可重定向到镜像域，免发版。
// 合规边界（同 lx-music DMCA 教训）：只做声明式 host 重写，不开放任意代码执行；
// 目录内非 JSON 文件一律忽略。

import { watch, existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { userDataDir } from '../env'
import { setScriptHostOverrides } from '../music/http'
import { createLogger } from '../logger'
import type { AdapterScriptInfo } from '@shared/types'

const log = createLogger('scripts')

interface ScriptManifest {
  id: string
  platform: string
  version: string
  enabled: boolean
  notes?: string
  /** host 重写表：官方域 → 镜像域（http 层统一改写，TLS 豁免随镜像域自动生效） */
  hostOverrides?: Record<string, string>
}

const BUILTINS: ScriptManifest[] = [
  {
    id: 'netease-official',
    platform: 'netease',
    version: '1.0.0',
    enabled: true,
    notes: '网易云官方 API（music.163.com）。官方接口失效时，将 hostOverrides 改为 {"music.163.com": "<镜像域>"} 并把 version +0.0.1 即可生效，无需更新应用。',
    hostOverrides: {}
  },
  {
    id: 'qq-official',
    platform: 'qq',
    version: '1.0.0',
    enabled: true,
    notes: 'QQ 音乐官方接口（u.y.qq.com）。',
    hostOverrides: {}
  },
  {
    id: 'kugou-official',
    platform: 'kugou',
    version: '1.0.0',
    enabled: true,
    notes: '酷狗移动端接口（songsearch.kugou.com / wwwapi.kugou.com）。',
    hostOverrides: {}
  },
  {
    id: 'migu-official',
    platform: 'migu',
    version: '1.0.0',
    enabled: true,
    notes: '咪咕音乐接口（m.music.migu.cn）。',
    hostOverrides: {}
  },
  {
    id: 'soda-official',
    platform: 'soda',
    version: '1.0.0',
    enabled: true,
    notes: '汽水音乐（luna.bytedance.com 系）。风控最强，失效时优先走回退链其他平台。',
    hostOverrides: {}
  }
]

export function adapterScriptsDir(): string {
  return join(userDataDir(), 'adapter-scripts')
}

let loaded: ScriptManifest[] = []
let watcher: ReturnType<typeof watch> | null = null
let reloadTimer: NodeJS.Timeout | null = null

function builtinFor(id: string): ScriptManifest | undefined {
  return BUILTINS.find((b) => b.id === id)
}

/** 脚本 id 白名单：防路径遍历（id 直接拼文件名，绝不允许分隔符/越级） */
const SCRIPT_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/

/** host 重写值合法性：必须是合法 hostname（可带端口），拒绝 URL/协议/空白注入 */
function validHostTarget(value: string): boolean {
  if (!/^[a-zA-Z0-9.-]+(:\d{1,5})?$/.test(value)) return false
  try {
    const u = new URL(`http://${value}`)
    return u.hostname.length > 0
  } catch {
    return false
  }
}

/** 全量加载：内置清单落盘（缺才写）→ userData 覆盖/新增 → 重建 host 重写表。
 *  任何 I/O 异常都不得上抛（watch 回调/定时器里调用，抛出即主进程崩溃） */
function loadAll(): void {
  try {
    const dir = adapterScriptsDir()
    mkdirSync(dir, { recursive: true })
    for (const b of BUILTINS) {
      const file = join(dir, `${b.id}.json`)
      if (!existsSync(file)) {
        writeFileSync(file, JSON.stringify(b, null, 2), 'utf8')
      }
    }
    const scripts: ScriptManifest[] = []
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue
      try {
        const raw = JSON.parse(readFileSync(join(dir, name), 'utf8')) as Partial<ScriptManifest>
        if (
          !raw ||
          typeof raw.id !== 'string' ||
          !SCRIPT_ID_RE.test(raw.id) ||
          typeof raw.platform !== 'string'
        ) {
          log.warn(`忽略非法脚本清单：${name}`)
          continue
        }
        const b = builtinFor(raw.id)
        scripts.push({
          id: raw.id,
          platform: raw.platform,
          version: String(raw.version ?? '0.0.0'),
          enabled: raw.enabled !== false,
          notes: raw.notes ?? b?.notes,
          hostOverrides:
            raw.hostOverrides && typeof raw.hostOverrides === 'object' ? raw.hostOverrides : {}
        })
      } catch (err) {
        log.warn(`脚本清单解析失败：${name}`, err)
      }
    }
    loaded = scripts

    // 重建 host 重写表 → 注入 http 层（仅 enabled 脚本；键值双重校验）
    const overrides = new Map<string, string>()
    for (const s of loaded) {
      if (!s.enabled) continue
      for (const [from, to] of Object.entries(s.hostOverrides ?? {})) {
        if (typeof to !== 'string') continue
        const target = to.trim()
        const source = from.toLowerCase().trim()
        if (target && validHostTarget(target) && source) {
          overrides.set(source, target)
        } else {
          log.warn(`忽略非法 host 重写（${s.id}）：${source} → ${target}`)
        }
      }
    }
    setScriptHostOverrides(overrides)
    // GBK 控制台会乱码（chcp 936）：主进程日志统一 ASCII
    log.info(`adapter scripts loaded: ${loaded.length}, host rewrites: ${overrides.size}`)
  } catch (err) {
    // 目录不可用（权限/磁盘）：保留上次成功加载结果，host 重写表清空（保守回退）
    log.error('适配脚本目录加载失败，沿用上次结果', err)
    setScriptHostOverrides(new Map())
  }
}

/** 渲染层读取口径 */
export function listAdapterScripts(): AdapterScriptInfo[] {
  return loaded.map((s) => ({
    id: s.id,
    platform: s.platform,
    version: s.version,
    enabled: s.enabled,
    source: builtinFor(s.id) ? 'builtin' : 'user',
    notes: s.notes,
    hostOverrides: { ...(s.hostOverrides ?? {}) }
  }))
}

export function reloadAdapterScripts(): AdapterScriptInfo[] {
  loadAll()
  return listAdapterScripts()
}

export function setAdapterScriptEnabled(id: string, enabled: boolean): void {
  // 防路径遍历：id 会拼进文件路径
  if (!SCRIPT_ID_RE.test(id)) throw new Error(`非法脚本 id：${id}`)
  const dir = adapterScriptsDir()
  const file = join(dir, `${id}.json`)
  if (!existsSync(file)) throw new Error(`脚本清单不存在：${id}`)
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<ScriptManifest>
  raw.enabled = enabled
  writeFileSync(file, JSON.stringify(raw, null, 2), 'utf8')
  loadAll()
}

/** 应用启动时调用：加载一次 + 监听目录热更（防抖 500ms） */
export function startAdapterScriptWatcher(): void {
  loadAll()
  if (watcher) return
  try {
    const w = watch(adapterScriptsDir(), { persistent: false }, () => {
      if (reloadTimer) clearTimeout(reloadTimer)
      reloadTimer = setTimeout(() => loadAll(), 500)
    })
    // 目录被删/权限变化时 watch 会异步发 error：无监听会变 uncaughtException 崩主进程
    w.on('error', (err) => {
      log.warn('适配脚本目录监听异常，热更降级为手动重载', err)
      watcher = null
    })
    watcher = w
  } catch (err) {
    log.warn('适配脚本目录监听失败（热更降级为手动重载）', err)
  }
}
