// omni-service 监督器（M2-1/M2-6，§2.2/§6.2）
// dev: spawn `python service/main.py`；prod: sidecar omni-service(.exe)
// 端口/token 经环境变量注入（§9：token 不出现在进程参数）
// /health 心跳 10s；连续 3 次失败 → 退避重启（1s→30s，连续 5 次 → offline）

import { spawn, type ChildProcess } from 'child_process'
import { randomBytes } from 'crypto'
import WebSocket from 'ws'
import { createLogger } from '../logger'
import { appRoot } from '../env'

const log = createLogger('omni-service')

export interface ServiceSupervisorOptions {
  port: number
  onOnline: (port: number, token: string) => void
  onOffline: (detail?: string) => void
  /** WS 消息（music.progress/done/warning） */
  onEvent: (event: unknown) => void
}

export class ServiceSupervisor {
  private proc: ChildProcess | null = null
  private ws: WebSocket | null = null
  private wsPing: NodeJS.Timeout | null = null
  private _token = randomBytes(24).toString('hex')
  private backoffMs = 1000
  private healthFails = 0
  private consecutiveFailures = 0
  private stopped = false
  private restarting = false
  private healthTimer: NodeJS.Timeout | null = null

  constructor(private readonly opts: ServiceSupervisorOptions) {}

  get port(): number {
    return this.opts.port
  }

  get token(): string {
    return this._token
  }

  get isOnline(): boolean {
    return this.healthFails === 0 && this.proc !== null && this.proc.exitCode === null
  }

  async start(): Promise<void> {
    this.stopped = false
    await this.spawn()
    this.startHealthPoll()
  }

  private async spawn(): Promise<void> {
    this.restarting = true
    try {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        OMNI_SERVICE_PORT: String(this.opts.port),
        OMNI_SERVICE_TOKEN: this._token,
        OMNI_SERVICE_HOST: '127.0.0.1',
        PYTHONUNBUFFERED: '1',
        PYTHONIOENCODING: 'utf-8' // GBK 控制台防护（引擎日志含 Unicode 符号）
      }

      if (process.env.NODE_ENV === 'development' || !app.isPackagedEnv()) {
        // dev：系统 Python 直跑源码
        this.proc = spawn('python', ['service/main.py'], {
          cwd: appRoot(),
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true
        })
      } else {
        // prod：PyInstaller sidecar
        const { binaryPath, checkBinary } = await import('./binaries')
        const check = await checkBinary('omni-service')
        if (!check.ok) throw new Error(`omni-service 可执行文件不可用：${check.error}`)
        this.proc = spawn(binaryPath('omni-service'), [], {
          env,
          stdio: ['ignore', 'ignore', 'pipe'],
          windowsHide: true
        })
      }

      this.proc.stderr?.on('data', (d: Buffer) => log.debug(`[service] ${String(d).trim()}`))
      this.proc.on('exit', (code) => {
        log.warn(`omni-service exited (code=${code})`)
        this.closeWs()
        if (!this.stopped) void this.scheduleRestart()
      })

      // 等首个 health OK（最多 30s：PyInstaller 解压较慢）
      await this.waitHealthy(30_000)
      this.backoffMs = 1000
      this.consecutiveFailures = 0
      this.healthFails = 0
      log.info(`omni-service online at port ${this.opts.port}`)
      this.opts.onOnline(this.opts.port, this.token)
    } finally {
      this.restarting = false
    }
  }

  private async waitHealthy(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (this.proc === null || this.proc.exitCode !== null) {
        throw new Error('omni-service 启动期间异常退出，请查看日志')
      }
      if (await this.probeHealth()) return
      await new Promise((r) => setTimeout(r, 500))
    }
    throw new Error('omni-service 健康检查超时')
  }

  private async probeHealth(): Promise<boolean> {
    try {
      const res = await fetch(`http://127.0.0.1:${this.opts.port}/health`, {
        signal: AbortSignal.timeout(3000)
      })
      return res.ok
    } catch {
      return false
    }
  }

  private startHealthPoll(): void {
    this.stopHealthPoll()
    this.healthTimer = setInterval(() => {
      void (async () => {
        const ok = await this.probeHealth()
        if (ok) {
          this.healthFails = 0
          return
        }
        this.healthFails++
        if (this.healthFails >= 3 && !this.restarting && !this.stopped) {
          log.warn('omni-service health check failed 3x, restarting')
          void this.scheduleRestart()
        }
      })()
    }, 10_000)
  }

  private stopHealthPoll(): void {
    if (this.healthTimer) clearInterval(this.healthTimer)
    this.healthTimer = null
  }

  private async scheduleRestart(): Promise<void> {
    if (this.restarting || this.stopped) return
    this.restarting = true
    try {
      this.consecutiveFailures++
      if (this.consecutiveFailures >= 5) {
        log.error('omni-service offline: 5 consecutive failures')
        this.opts.onOffline('omni-service 连续重启失败')
      }
      if (this.proc && this.proc.exitCode === null) {
        this.proc.kill('SIGTERM')
        this.proc = null
      }
      const delay = this.backoffMs
      this.backoffMs = Math.min(this.backoffMs * 2, 30_000)
      await new Promise((r) => setTimeout(r, delay))
      if (this.stopped) return
      await this.spawn()
    } catch (err) {
      log.error('omni-service restart failed', err)
      this.restarting = false
      if (!this.stopped) void this.scheduleRestart()
      return
    }
  }

  // ── WS 事件流（§6.3）：由适配器在 onOnline 后调用 connectWs ─────────

  connectWs(): void {
    this.closeWs()
    const ws = new WebSocket(`ws://127.0.0.1:${this.opts.port}/ws/events`)
    this.ws = ws
    ws.on('open', () => {
      log.info('ws events connected')
      // D5：首帧鉴权（token 不进 URL）
      ws.send(this._token)
      this.wsPing = setInterval(() => {
        try {
          ws.send('ping')
        } catch {
          // 连接已断，close 事件接管
        }
      }, 30_000)
    })
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(String(data))
        if (msg && typeof msg === 'object' && 'type' in msg) {
          this.opts.onEvent(msg)
        }
      } catch {
        // 非 JSON 帧（pong）忽略
      }
    })
    ws.on('error', () => {
      // close 事件接管重连
    })
    ws.on('close', () => {
      this.closeWs()
      if (!this.stopped) {
        setTimeout(() => {
          if (!this.stopped && this.proc && this.proc.exitCode === null) this.connectWs()
        }, 3000)
      }
    })
  }

  private closeWs(): void {
    if (this.wsPing) clearInterval(this.wsPing)
    this.wsPing = null
    try {
      this.ws?.close()
    } catch {
      // 已断
    }
    this.ws = null
  }

  async shutdown(): Promise<void> {
    this.stopped = true
    this.stopHealthPoll()
    this.closeWs()
    if (this.proc && this.proc.exitCode === null) {
      this.proc.kill('SIGTERM')
      setTimeout(() => {
        if (this.proc && this.proc.exitCode === null) this.proc.kill('SIGKILL')
      }, 10_000)
    }
  }
}

// 打包态探测辅助（避免顶层 import electron，保持纯 Node 可测）
const app = {
  isPackagedEnv(): boolean {
    return Boolean((process as unknown as { resourcesPath?: string }).resourcesPath)
  }
}
