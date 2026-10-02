// aria2c 监督器（M1-2，§2.2/§4.2）
// spawn（--enable-rpc --rpc-secret）+ WS JSON-RPC 客户端 + 心跳 + 指数退避重启
// （1s→30s，连续 5 次失败标记离线）。

import type { ChildProcess } from 'child_process'
import { randomBytes } from 'crypto'
import WebSocket from 'ws'
import { createLogger } from '../logger'
import { binaryPath, checkBinary, type SidecarBinary } from './binaries'
import { defaultGlobalOptions, toSpawnArgs } from '../aria2/options'
import { spawnTreeAware, terminateTree } from './proc'

const log = createLogger('aria2')

// ── JSON-RPC 客户端 ──────────────────────────────────────────────────

let rpcSeq = 0

export class Aria2RpcClient {
  private ws: WebSocket | null = null
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

  constructor(
    private readonly port: number,
    private readonly secret: string,
    /** B5：WS 意外断开（进程未死）时通知监督器走重启路径 */
    private readonly onClose?: () => void
  ) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      // P3 加固：废弃的旧 WS 仍挂着 onClose → scheduleRestart 回调，会引发多余重启——
      // 重建前先摘除全部监听并终止旧连接
      if (this.ws) {
        try {
          this.ws.removeAllListeners()
          this.ws.terminate()
        } catch {
          // ignore
        }
        this.ws = null
      }
      const ws = new WebSocket(`ws://127.0.0.1:${this.port}/jsonrpc`)
      this.ws = ws
      ws.on('open', () => resolve())
      ws.on('error', (err) => {
        this.rejectAll(err)
        reject(err)
      })
      ws.on('close', () => {
        this.rejectAll(new Error('aria2 RPC 连接已断开'))
        this.onClose?.()
      })
      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(String(data)) as {
            id?: number | string
            result?: unknown
            error?: { message: string }
            method?: string
            params?: unknown[]
          }
          if (msg.id !== undefined && !msg.method) {
            const entry = this.pending.get(Number(msg.id))
            if (entry) {
              this.pending.delete(Number(msg.id))
              if (msg.error) entry.reject(new Error(msg.error.message))
              else entry.resolve(msg.result)
            }
          }
          // 服务端通知（aria2.onDownloadStart 等）暂交由轮询统一处理
        } catch {
          // 非 JSON 帧忽略
        }
      })
    })
  }

  private rejectAll(err: Error): void {
    for (const [, p] of this.pending) p.reject(err)
    this.pending.clear()
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }

  call<T = unknown>(method: string, ...params: unknown[]): Promise<T> {
    if (!this.isOpen) return Promise.reject(new Error('aria2 未连接（引擎可能正在重启），请稍候重试'))
    const id = ++rpcSeq
    const payload = {
      jsonrpc: '2.0',
      id,
      method: method.startsWith('aria2.') ? method : `aria2.${method}`,
      params: [`token:${this.secret}`, ...params]
    }
    return new Promise<T>((resolve, reject) => {
      // P3 加固：超时 timer 在响应到达时清理（高频轮询下未清理的 timer 会持续堆积）
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`aria2 RPC 请求超时：${method}`))
        }
      }, 10_000)
      this.pending.set(id, {
        resolve: (v: unknown) => {
          clearTimeout(timer)
          resolve(v as T)
        },
        reject: (e: Error) => {
          clearTimeout(timer)
          reject(e)
        }
      })
      // P3 加固：isOpen 检查与 send 之间 WS 可能被 close() 置 null——send 失败按离线处理
      try {
        this.ws!.send(JSON.stringify(payload))
      } catch (err) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(
          new Error(
            `aria2 连接已断开（引擎可能正在重启），请稍候重试：${err instanceof Error ? err.message : String(err)}`
          )
        )
      }
    })
  }

  close(): void {
    this.ws?.close()
    this.ws = null
  }
}

// ── 监督器 ───────────────────────────────────────────────────────────

export interface Aria2SupervisorEvents {
  onOnline: (port: number) => void
  onOffline: () => void
}

export class Aria2Supervisor {
  private proc: ChildProcess | null = null
  private client: Aria2RpcClient | null = null
  private secret = randomBytes(32).toString('hex')
  private backoffMs = 1000
  private consecutiveFailures = 0
  private stopped = false
  private heartbeat: NodeJS.Timeout | null = null
  private restarting = false

  readonly rpcPort: number
  readonly binaryName: SidecarBinary = 'aria2c'

  constructor(
    rpcPort: number,
    private readonly globalOptions = defaultGlobalOptions(),
    private readonly events: Aria2SupervisorEvents = { onOnline: () => {}, onOffline: () => {} }
  ) {
    this.rpcPort = rpcPort
  }

  get isOnline(): boolean {
    return this.client?.isOpen ?? false
  }

  /** 需要时返回已连接客户端（供适配器调用 RPC） */
  getClient(): Aria2RpcClient {
    if (!this.client) throw new Error('aria2 引擎尚未启动')
    return this.client
  }

  async start(): Promise<void> {
    this.stopped = false
    const check = await checkBinary('aria2c')
    if (!check.ok) {
      throw new Error(`aria2c 不可用（${check.path}）：${check.error}`)
    }
    await this.spawnAndConnect()
  }

  private async spawnAndConnect(): Promise<void> {
    // P3 加固：secret 写配置文件注入（--conf-path，不出现在命令行；aria2 启动后即读走）。
    // R5 修复：此前用的 --rpc-secret-file 是不存在的选项 → aria2c exit 28 无限重启，
    // BT/HTTP 引擎全挂。conf 文件只含 rpc-secret 一行
    const { writeFile, unlink } = await import('fs/promises')
    const { join } = await import('path')
    const { userDataDir } = await import('../env')
    const secretFile = join(userDataDir(), 'aria2-rpc-secret.conf')
    // M1 加固：secret 文件仅属主可读写（Linux/macOS 同机低权用户不可读），用后即删
    await writeFile(secretFile, `rpc-secret=${this.secret}\n`, { encoding: 'utf8', mode: 0o600 })
    const args = toSpawnArgs(this.globalOptions, secretFile, this.rpcPort)
    const proc = spawnTreeAware(binaryPath('aria2c'), args, {
      stdio: ['ignore', 'ignore', 'pipe']
    })
    this.proc = proc
    proc.stderr?.on('data', (d: Buffer) => log.debug(`[aria2c] ${String(d).trim()}`))
    proc.on('exit', (code) => {
      // H1 修复：exit 回调必须校验进程身份——旧进程的 exit 事件（Windows taskkill
      // 有延迟）可能在重启流程 spawn 出新进程后才迟到，若无身份校验会误关新 client、
      // 误停心跳并再次触发 scheduleRestart（terminateTree 指向健康新进程）→ 重启风暴
      if (this.proc !== proc) return
      log.warn(`aria2c exited (code=${code})`)
      this.proc = null
      if (this.client === client) {
        this.client?.close()
        this.client = null
        this.stopHeartbeat()
      }
      if (!this.stopped) void this.scheduleRestart()
    })

    const client = new Aria2RpcClient(this.rpcPort, this.secret, () => {
      // B5：进程存活但 WS 断开 → 触发重启路径（scheduleRestart 内部有幂等防护）
      if (!this.stopped && this.proc === proc) {
        log.warn('aria2 rpc websocket closed unexpectedly')
        void this.scheduleRestart()
      }
    })
    this.client = client
    try {
      await this.waitForRpc()
    } finally {
      // M1：RPC 就绪后 secret 已被 aria2 读取，删除落盘残留（失败不阻断）
      void unlink(secretFile).catch(() => {})
    }
    await client.call('changeGlobalOption', {
      ...this.globalOptions,
      'rpc-listen-port': undefined
    })
    this.backoffMs = 1000
    this.consecutiveFailures = 0
    this.startHeartbeat()
    log.info(`aria2 online at rpc port ${this.rpcPort}`)
    this.events.onOnline(this.rpcPort)
  }

  private waitForRpc(): Promise<void> {
    // RPC 服务就绪可能有亚秒级延迟，重试连接
    return new Promise((resolve, reject) => {
      let attempts = 0
      const tryConnect = (): void => {
        attempts++
        this.client!
          .connect()
          .then(resolve)
          .catch((err: Error) => {
            if (this.proc === null || this.proc.exitCode !== null) {
              reject(err)
              return
            }
            if (attempts >= 30) {
              reject(new Error('aria2 RPC 连续 30 次尝试仍不可达'))
              return
            }
            setTimeout(tryConnect, 300)
          })
      }
      tryConnect()
    })
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.heartbeat = setInterval(() => {
      if (!this.client?.isOpen) return
      this.client.call('getVersion').catch(() => {
        // 心跳失败不主动处理：exit 事件会触发退避重启
      })
    }, 10_000)
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null
  }

  /** 指数退避重启：1s→2s→4s→…上限 30s；连续 5 次失败标记离线 */
  private async scheduleRestart(): Promise<void> {
    // H1 修复：restarting 标志贯穿整个重启周期（含退避等待与重试），而非只在
    // spawnAndConnect 内短暂为真——否则 WS 断开与进程退出双重触发可穿透幂等防护，
    // 并发双 spawn 抢占同一 rpc 端口
    if (this.restarting || this.stopped) return
    this.restarting = true
    try {
      for (;;) {
        if (this.stopped) return
        this.consecutiveFailures++
        // P3 修复：只在首次跨过阈值时广播（状态沿触发）——此前每轮退避
        // 都重复 onOffline → broadcastHealth 反复刷新
        if (this.consecutiveFailures === 5) {
          log.error('aria2 offline: 5 consecutive failures')
          this.events.onOffline()
          // 保持退避继续尝试恢复（UI 红点已亮）
        } else if (this.consecutiveFailures > 5) {
          log.error(`aria2 offline: ${this.consecutiveFailures} consecutive failures`)
        }
        // 先终止残留进程（B5：WS 断开但进程存活时，必须释放端口再重生）
        if (this.proc && this.proc.exitCode === null) {
          terminateTree(this.proc, 3000)
          this.proc = null
        }
        const delay = this.backoffMs
        this.backoffMs = Math.min(this.backoffMs * 2, 30_000)
        log.info(`restarting aria2c in ${delay}ms (failure #${this.consecutiveFailures})`)
        await new Promise((r) => setTimeout(r, delay))
        if (this.stopped) return
        try {
          await this.spawnAndConnect()
          return
        } catch (err) {
          // spawn/connect 失败：继续退避循环（此前 finally 提前清标志 + 递归触发
          // 时 restarting 仍为 true 会被幂等守卫吞掉，重启实际丢失）
          log.error('aria2 restart failed', err)
        }
      }
    } finally {
      this.restarting = false
    }
  }

  /** 应用退出：shutdown 优雅关闭。
   * P2 修复：RPC 优雅关闭限时 2s——WS 已断时 call 会挂到 10s 超时，
   * before-quit 等不及即退出 → taskkill 兜底永不执行 → aria2c 孤儿进程占端口/继续上传。 */
  async shutdown(): Promise<void> {
    this.stopped = true
    this.stopHeartbeat()
    await Promise.race([
      this.client?.call('shutdown').catch(() => {}) ?? Promise.resolve(),
      new Promise((r) => setTimeout(r, 2000))
    ])
    this.client?.close()
    if (this.proc && this.proc.exitCode === null) {
      // 10s 超时强杀（§2.2）；Windows 上由 taskkill /T 保证进程树整体退出
      terminateTree(this.proc, 10_000)
    }
  }
}
