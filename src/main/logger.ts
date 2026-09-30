// 主进程分级日志（T0-7）
// 输出到 userData/logs/main-YYYY-MM-DD.log，同时镜像到控制台（dev）。

import { appendFile, mkdir } from 'fs/promises'
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

class Logger {
  private scope: string
  private minLevel: number
  private static logDir: string | null = null

  constructor(scope = 'app') {
    this.scope = scope
    this.minLevel = process.env.NODE_ENV === 'development' ? LEVELS.debug : LEVELS.info
  }

  static init(): void {
    Logger.logDir = resolveLogDir()
  }


  private async write(level: Level, msg: string, data?: unknown): Promise<void> {
    if (LEVELS[level] < this.minLevel) return
    const record: LogRecord = {
      t: new Date().toISOString(),
      level,
      scope: this.scope,
      msg,
      data
    }
    const line = JSON.stringify(record)
    if (process.env.NODE_ENV === 'development') {
      // eslint-disable-next-line no-console
      console[level === 'debug' ? 'log' : level](
        `[${level}] [${this.scope}] ${msg}`,
        data ?? ''
      )
    }
    try {
      if (Logger.logDir) {
        await mkdir(Logger.logDir, { recursive: true })
        const file = join(
          Logger.logDir,
          `main-${new Date().toISOString().slice(0, 10)}.log`
        )
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
  return new Logger(scope)
}
