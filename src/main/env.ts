// 运行环境路径（便携模式）：
// - 数据/配置/历史 → <运行目录>/data（任务库 omniget.db、日志、TOFU 指纹、DHT 缓存）
// - 首次从旧位置（%APPDATA%/OmniGet）一次性迁移历史数据
// - 运行目录不可写（如装进 Program Files）时回退系统 userData，日志告警
// - 纯 Node（单测/集成脚本）降级临时目录；OMNIGET_TEST_DATA_DIR 可注入隔离

import { existsSync, mkdirSync, copyFileSync, renameSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'

type ElectronApp = {
  getPath?: (name: string) => string
  setPath?: (name: string, path: string) => void
  getAppPath?: () => string
  isPackaged?: boolean
}

function electronApp(): ElectronApp | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require('electron') as { app?: ElectronApp }
    if (app && typeof app.getPath === 'function') return app
  } catch {
    // electron 不可用（纯 Node 测试环境）
  }
  return null
}

let cachedDataDir: string | null = null

/** 系统默认 userData 快照（adoptPortableUserData 重定向前捕获——迁移来源判定依据） */
let originalUserData: string | null = null

/**
 * 第九轮清账（D10）：把 Chromium 自身 profile（缓存/GPU cache/localStorage）也
 * 收拢进应用数据目录——此前仅应用数据落 runtimeBase/data，Chromium 侧仍写系统
 * %APPDATA%/OmniGet，「便携」承诺不完整（换机丢 Chromium 侧状态），且
 * legacyDataDir 恰好返回同一目录、迁移语义与 Chromium 活动目录纠缠。
 * 必须在单实例锁判定后、ready 前调用（Electron 要求 userData 重定位于 ready 前）；
 * 测试环境（OMNIGET_TEST_DATA_DIR）不重定向。
 */
export function adoptPortableUserData(): void {
  const app = electronApp()
  if (!app || process.env.OMNIGET_TEST_DATA_DIR) return
  try {
    if (!originalUserData && app.getPath) originalUserData = app.getPath('userData')
    // userDataDir() 会完成目录创建/写探测/旧数据迁移；不可写时其内部已回退
    // 系统 userData——此时 target === originalUserData，跳过重定向（自洽）
    const target = userDataDir()
    if (originalUserData !== target && typeof app.setPath === 'function') {
      app.setPath('userData', target)
    }
  } catch {
    // 早期阶段 logger 未必就绪且不宜阻塞启动——重定向失败保留系统 userData 行为
  }
}

/** 运行基目录：Windows 打包态 = exe 所在目录（便携口径）；dev = 项目根；纯 Node = cwd */
export function runtimeBase(): string {
  const app = electronApp()
  if (app) {
    if (app.isPackaged) {
      // 仅 Windows 便携口径数据随 exe 目录；macOS（.app bundle 内不可靠/破坏签名）与
      // Linux（AppImage 为 squashfs 只读挂载）必须走系统 userData
      if (process.platform === 'win32') return dirname(process.execPath)
      try {
        if (app.getPath) return app.getPath('userData')
      } catch {
        // ignore，落到下方 cwd
      }
      return dirname(process.execPath)
    }
    if (app.getAppPath) return app.getAppPath()
  }
  return process.cwd()
}

/** 旧版系统数据目录（迁移来源）：%APPDATA%/OmniGet */
function legacyDataDir(): string | null {
  const app = electronApp()
  try {
    if (app?.getPath) {
      // 第九轮清账（D10）：userData 可能已被 adoptPortableUserData 重定向到应用
      // 数据目录——迁移来源必须用重定向前捕获的原始路径，否则迁移逻辑失明
      const legacy = originalUserData ?? app.getPath('userData')
      // 与新目录相同则视为无旧数据
      return legacy
    }
  } catch {
    // ignore
  }
  return null
}

/** 迁移失败记录（L5：bootstrap 后广播到 UI，不再只有 console 留痕） */
export const legacyMigrationErrors: string[] = []

/** 一次性迁移：旧 omniget.db / dht.dat → data/（目标缺失才拷贝）。
 * fingerprints.json 不迁移：TOFU 信任锚定安装身份，旧目录指纹对新 sidecar 无意义
 * R4-P2：拷贝改为「临时名 + rename 原子落位」——copyFileSync 中途失败（磁盘满/
 * 杀软锁定）会留残缺目标文件，下次启动 existsSync(to) 为真即永久跳过迁移，
 * 用户数据"消失"且不再告警 */
function migrateFromLegacy(legacy: string, target: string): void {
  // 第九轮审查：-wal 一并迁移——better-sqlite3 WAL 模式下未 checkpoint 的事务
  // 只在 -wal 里，只拷主库会丢最近写入；且旧目录残留 -wal 会让下次启动的
  // 「目标缺失才拷」重试拿到陈旧主库（不可自愈）。-shm 可由 SQLite 重建不拷
  const items = ['omniget.db', 'omniget.db-wal', 'dht.dat', 'dht6.dat']
  for (const name of items) {
    const from = join(legacy, name)
    const to = join(target, name)
    if (existsSync(from) && !existsSync(to)) {
      const staging = `${to}.migrating`
      try {
        copyFileSync(from, staging)
        renameSync(staging, to)
      } catch (err) {
        // 迁移失败不阻塞启动（新库从零开始），但必须留痕——用户视角是历史数据"消失"。
        // 清理残缺暂存文件，下次启动可重试迁移（目标未落位，下次仍会重拷）
        try {
          if (existsSync(staging)) rmSync(staging, { force: true })
        } catch {
          // ignore
        }
        // eslint-disable-next-line no-console
        console.error(`[env] 旧数据迁移失败: ${from} → ${to}`, err)
        legacyMigrationErrors.push(`${name}（${err instanceof Error ? err.message : String(err)}）`)
      }
    }
  }
}

/**
 * 数据目录（配置 + 历史数据统一根）：<运行目录>/data。
 * 不可写时回退系统 userData（保证应用可用），并保留迁移语义。
 */
export function userDataDir(): string {
  // 测试隔离：env 变量最高优先级且不缓存（node:test 单进程跑多文件，各文件注入各自临时目录）
  const envDir = process.env.OMNIGET_TEST_DATA_DIR
  if (envDir) return envDir
  if (cachedDataDir) return cachedDataDir

  const target = join(runtimeBase(), 'data')
  try {
    // 0o700：数据目录含 db/bridge token/指纹库等敏感资产——POSIX 下不共享可读
    //（Windows ACL 由系统默认，mode 参数无副作用）。已存在目录不受影响
    mkdirSync(target, { recursive: true, mode: 0o700 })
    // 写入探测（目录存在但 ACL 只读时 mkdir 不报错）
    const probe = join(target, '.write-probe')
    writeFileSync(probe, '')
    try {
      rmSync(probe, { force: true })
    } catch {
      // 残留探测文件无害，忽略
    }
    cachedDataDir = target
  } catch {
    const app = electronApp()
    let fallback = join(tmpdir(), 'omniget-data')
    try {
      if (app?.getPath) fallback = app.getPath('userData')
    } catch {
      // ignore
    }
    try {
      // 0o700：兜底目录（含 db/bridge token）不应共享可读——仅 userData 不可用
      // 时才会落到 tmpdir
      mkdirSync(fallback, { recursive: true, mode: 0o700 })
    } catch (err) {
      // R4-P3：主目录与回退目录均不可写的根因必须留痕（后续 getDb/logger 全线
      // 失败只会给出表层错误）
      legacyMigrationErrors.push(
        `数据目录不可写（${target}），回退目录创建也失败（${err instanceof Error ? err.message : String(err)}）`
      )
    }
    cachedDataDir = fallback
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { createLogger } = require('./logger') as { createLogger: (s: string) => { warn: (m: string) => void } }
      createLogger('env').warn(`data dir not writable (${target}), fallback: ${fallback}`)
    } catch {
      // ignore
    }
  }

  // 首次迁移旧数据（仅当回退目标不是旧目录本身）
  const legacy = legacyDataDir()
  if (legacy && legacy !== cachedDataDir && existsSync(join(legacy, 'omniget.db'))) {
    migrateFromLegacy(legacy, cachedDataDir)
  }
  return cachedDataDir
}

export function appRoot(): string {
  const app = electronApp()
  if (app?.getAppPath) return app.getAppPath()
  return process.cwd()
}
