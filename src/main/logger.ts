// 主进程分级日志（T0-7）
// 输出到 userData/logs/main-YYYY-MM-DD.log，同时镜像到控制台（dev）。

import { appendFile, mkdir, stat, rename } from 'fs/promises'
import { join } from 'path'
import { userDataDir } from './env'

// 纯 Node 环境（单测/集成脚本）下 electron 不可用，env 模块降级到系统临时目录
function resolveLogDir(): string {
  return join(userDataDir(), 'logs')
}

type Level = 'debug' | 'info' | 'warn' | 'error'

interface LogRecord {
  t: string
  level: Level
  scope: string
  msg: string
  data?: unknown
}

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 }

// 第十一轮审查 P3：常见敏感键脱敏（write 层统一兜底，不再依赖调用点自觉——
// 未来任何调用点误传 header/credential 对象时静默落盘明文是唯一防线缺口）
const SENSITIVE_KEY_RE =
  /("?(?:token|secret|password|passwd|authorization|auth|cookie|api[-_]?key|credential)"?\s*:\s*)"(?:[^"\\]|\\.)*"/gi

function redact(data: unknown): unknown {
  if (typeof data === 'string') return data
  if (data === null || typeof data !== 'object') return data
  try {
    const redacted = JSON.stringify(data).replace(SENSITIVE_KEY_RE, '$1"[REDACTED]"')
    return JSON.parse(redacted)
  } catch {
    // 循环引用等序列化失败：降级为字符串表示
    return String(data)
  }
}

// 第十一轮审查 P3：单文件体积上限——错误风暴（如 aria2 离线时每秒 tellStatus
// 报错）此前单日文件可无限膨胀，14 天 prune 兜不住单日。超限轮转为 .1（保留
// 最近一份溢出段），新记录继续写当日主文件
const MAX_LOG_FILE_BYTES = 32 * 1024 * 1024

class Logger {
  private scope: string
  private minLevel: number
  private static logDir: string | null = null
  private static prunedDay: string | null = null

  constructor(scope = 'app') {
    this.scope = scope
    this.minLevel = process.env.NODE_ENV === 'development' ? LEVELS.debug : LEVELS.info
  }

  static init(): void {
    if (Logger.logDir === resolveLogDir()) return // 幂等：不再重复重置全局字段
    Logger.logDir = resolveLogDir()
  }

  /** L6 修复：日志轮转——按天分文件但从不清理会让 logs/ 无限膨胀，保留最近 14 天。
   * 第十一轮审查 P3：托盘常驻数月不重启则「每进程只跑一次」失效——改为每本地
   * 日首次写入时重跑（prunedDay 记上次执行日）。 */
  static pruneOldLogs(): void {
    const day = new Date().toLocaleDateString('sv-SE')
    if (Logger.prunedDay === day || !Logger.logDir) return
    Logger.prunedDay = day
    void (async () => {
      const { readdir, rm } = await import('fs/promises')
      const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000
      const entries = await readdir(Logger.logDir!).catch(() => [] as string[])
      for (const f of entries) {
        const m = /^main-(\d{4}-\d{2}-\d{2})\.log(\.\d+)?$/.exec(f)
        if (!m) continue
        if (new Date(`${m[1]}T00:00:00Z`).getTime() < cutoff) {
          await rm(join(Logger.logDir!, f), { force: true }).catch(() => {})
        }
      }
    })().catch(() => {})
  }

  private async write(level: Level, msg: string, data?: unknown): Promise<void> {
    if (LEVELS[level] < this.minLevel) return
    const record: LogRecord = {
      t: new Date().toISOString(),
      level,
      scope: this.scope,
      msg,
      data: data === undefined ? undefined : redact(data)
    }
    const line = JSON.stringify(record)
    if (process.env.NODE_ENV === 'development') {
      // eslint-disable-next-line no-console
      console[level === 'debug' ? 'log' : level](
        `[${level}] [${this.scope}] ${msg}`,
        record.data ?? ''
      )
    }
    try {
      if (Logger.logDir) {
        await mkdir(Logger.logDir, { recursive: true })
        // 第十一轮审查 P3：文件名改本地日期（此前 UTC——UTC+8 用户本地凌晨
        // 0-8 点的日志落进「昨天」的文件，排障对时易错位）
        const file = join(Logger.logDir, `main-${new Date().toLocaleDateString('sv-SE')}.log`)
        const st = await stat(file).catch(() => null)
        if (st && st.size > MAX_LOG_FILE_BYTES) {
          await rename(file, `${file}.1`).catch(() => {})
        }
        await appendFile(file, line + '\n', 'utf8')
      }
    } catch {
      // 日志失败不影响业务
    }
  }

  debug(msg: string, data?: unknown): void {
    void this.write('debug', msg, data)
  }
  info(msg: string, data?: unknown): void {
    void this.write('info', msg, data)
  }
  warn(msg: string, data?: unknown): void {
    void this.write('warn', msg, data)
  }
  error(msg: string, data?: unknown): void {
    void this.write('error', msg, data)
  }
}

export function createLogger(scope: string): Logger {
  Logger.init()
  Logger.pruneOldLogs()
  return new Logger(scope)
}
