// 运行环境路径（便携模式）：
// - 数据/配置/历史 → <运行目录>/data（任务库 omniget.db、日志、TOFU 指纹、DHT 缓存）
// - 首次从旧位置（%APPDATA%/OmniGet）一次性迁移历史数据
// - 运行目录不可写（如装进 Program Files）时回退系统 userData，日志告警
// - 纯 Node（单测/集成脚本）降级临时目录；OMNIGET_TEST_DATA_DIR 可注入隔离

import { existsSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'

type ElectronApp = {
  getPath?: (name: string) => string
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
      const legacy = app.getPath('userData')
      // 与新目录相同则视为无旧数据
      return legacy
    }
  } catch {
    // ignore
  }
  return null
}

/** 一次性迁移：旧 omniget.db / dht.dat → data/（目标缺失才拷贝）。
 * fingerprints.json 不迁移：TOFU 信任锚定安装身份，旧目录指纹对新 sidecar 无意义 */
function migrateFromLegacy(legacy: string, target: string): void {
  const items = ['omniget.db', 'dht.dat', 'dht6.dat']
  for (const name of items) {
    const from = join(legacy, name)
    const to = join(target, name)
    if (existsSync(from) && !existsSync(to)) {
      try {
        copyFileSync(from, to)
      } catch (err) {
        // 迁移失败不阻塞启动（新库从零开始），但必须留痕——用户视角是历史数据"消失"
        // eslint-disable-next-line no-console
        console.error(`[env] 旧数据迁移失败: ${from} → ${to}`, err)
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
    mkdirSync(target, { recursive: true })
    // 写入探测（目录存在但 ACL 只读时 mkdir 不报错）
    const probe = join(target, '.write-probe')
    writeFileSync(probe, '')
    rmSync(probe, { force: true })
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
      mkdirSync(fallback, { recursive: true })
    } catch {
      // ignore
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
