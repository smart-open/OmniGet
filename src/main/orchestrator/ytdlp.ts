// yt-dlp 监督器（M3-1，§4.1 语义注记 / §6.2）
// 一次性 CLI：spawn → 逐行 stdout 解析 → 退出码 0/1/2 分类
// pause = SIGTERM（保留 .part 分片缓存）；resume = 同参数重新 spawn 续传
// 同时承担健康探测（--version）与热更后的二进制重载（M3-9）

import { type ChildProcess } from 'child_process'
import { createLogger } from '../logger'
import { binaryPath, checkBinary, ensureVerified } from './binaries'
import { spawnTreeAware, terminateTree } from './proc'

const log = createLogger('ytdlp')

export interface YtDlpRunHandle {
  taskId: string
  kill(signal?: NodeJS.Signals): void
}

export interface YtDlpRunOptions {
  onLine?: (line: string) => void
  /** 退出码分类：0 成功 / 1 运行错误（网络、格式等）/ 2 用法错误 */
  onExit?: (classification: 'ok' | 'error' | 'usage', code: number | null) => void
  /** 用户主动暂停标记：exit 时区分 paused 与 failed */
  isUserPaused?: () => boolean
}

export class YtDlpSupervisor {
  private procs = new Map<string, ChildProcess>()
  /** stderr 尾部（失败归因用） */
  private errTails = new Map<string, string>()

  /** M3-2/M3-9：健康探测（--version）；二进制缺失/损坏返回 null */
  async version(): Promise<string | null> {
    try {
      const check = await checkBinary('ytdlp')
      if (!check.ok) return null
      const out = await this.exec(['--version'], 10_000)
      return out.trim() || null
    } catch {
      return null
    }
  }

  /** ffmpeg 存在性探测（M3-2）：缺失时格式选择器降级预合并格式 */
  async ffmpegAvailable(): Promise<boolean> {
    try {
      const check = await checkBinary('ffmpeg')
      return check.ok
    } catch {
      return false
    }
  }

  /** -J JSON 解析（parse 用）。P2 加固：解析路径此前完全绕过 TOFU 闸门——被篡改的
   * 二进制可以先在解析阶段执行；spawn 前强制指纹校验 */
  async execJson(args: string[], timeoutMs = 60_000): Promise<string> {
    await ensureVerified('ytdlp')
    return this.exec(args, timeoutMs)
  }

  private exec(args: string[], timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawnTreeAware(this.bin(), args)
      let out = ''
      // L-6：stdout 无上限累积会让超大合集 -J JSON（数十 MB）全量驻留内存
      const MAX_OUT = 64 * 1024 * 1024
      const timer = setTimeout(() => {
        // H3 修复：解析/探测路径同样用树终止——单进程 SIGKILL 不级联 ffmpeg 等子进程
        terminateTree(proc, 2000)
        reject(new Error('yt-dlp 执行超时'))
      }, timeoutMs)
      proc.stdout?.on('data', (d: Buffer) => {
        out += String(d)
        if (out.length > MAX_OUT) {
          clearTimeout(timer)
          terminateTree(proc, 2000)
          reject(new Error('yt-dlp 输出超出 64MB 上限（合集过大或站点异常），请减少单次条目数'))
        }
      })
      // H3 修复：stderr 必须持续消费（spawn 默认 stdio 下 stderr 为 pipe），
      // 部分站点 stderr 输出量大，64KB 管道写满会阻塞子进程直到被超时误杀
      let errTail = ''
      proc.stderr?.on('data', (d: Buffer) => {
        errTail = (errTail + String(d)).slice(-1500)
      })
      proc.on('exit', () => {
        clearTimeout(timer)
        resolve(out)
      })
      proc.on('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
    })
  }

  private bin(): string {
    return binaryPath('ytdlp')
  }

  /** 启动一个下载任务（长驻进程，逐行回调） */
  spawnTask(taskId: string, args: string[], opts: YtDlpRunOptions): YtDlpRunHandle {
    const proc = spawnTreeAware(this.bin(), args)
    this.procs.set(taskId, proc)
    log.info(`spawn ${taskId}: yt-dlp ${args.join(' ').slice(0, 120)}…`)

    let buffer = ''
    proc.stdout?.on('data', (d: Buffer) => {
      buffer += String(d)
      let idx: number
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim()
        buffer = buffer.slice(idx + 1)
        if (line) opts.onLine?.(line)
      }
    })
    proc.stderr?.on('data', (d: Buffer) => {
      const line = String(d).trim()
      if (line) {
        log.debug(`[yt-dlp] ${line}`)
        this.errTails.set(taskId, ((this.errTails.get(taskId) ?? '') + '\n' + line).slice(-1500))
      }
    })

    proc.on('exit', (code) => {
      this.procs.delete(taskId)
      if (opts.isUserPaused?.()) {
        opts.onExit?.('ok', code) // pause 语义：SIGTERM 保留 .part，非失败
        return
      }
      if (code === 0) opts.onExit?.('ok', 0)
      else if (code === 2) opts.onExit?.('usage', 2)
      else opts.onExit?.('error', code)
    })
    proc.on('error', (err) => {
      this.procs.delete(taskId)
      log.error(`spawn error: ${String(err)}`)
      opts.onExit?.('error', null)
    })

    return {
      taskId,
      kill: () => {
        // L2 修复：与 pause/killAll 口径一致，走树终止防 ffmpeg 孤儿
        if (proc.exitCode === null) terminateTree(proc, 8000)
      }
    }
  }

  /** pause：优雅退出（.part 保留，§4.1）；进程树终止防 ffmpeg 孤儿（Windows 上 SIGTERM 本就是硬杀） */
  pause(taskId: string): boolean {
    const proc = this.procs.get(taskId)
    if (!proc || proc.exitCode !== null) return false
    terminateTree(proc, 8000)
    return true
  }

  getStderrTail(taskId: string): string {
    return this.errTails.get(taskId) ?? ''
  }

  /** 任务终态/删除时清理（防 errTails 只增不减） */
  dropTask(taskId: string): void {
    this.errTails.delete(taskId)
  }

  /** 强杀（应用退出，§2.2）：进程树整体终止 */
  killAll(): void {
    for (const [, proc] of this.procs) {
      if (proc.exitCode === null) terminateTree(proc, 10_000)
    }
  }
}

/** 单例（yt-dlp 为按需 CLI，无驻留引擎进程，监督器仅管理进程表与健康） */
let instance: YtDlpSupervisor | null = null

export function getYtDlpSupervisor(): YtDlpSupervisor {
  if (!instance) instance = new YtDlpSupervisor()
  return instance
}
