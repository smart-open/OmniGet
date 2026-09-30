// M2-5 端口：同 host 请求串行化 + 最小间隔（防平台风控，§4.5）
// Python 版用 threading.Lock 实现，此处为 Promise 链式队列（单线程事件循环天然串行）

export class HostGate {
  private readonly minIntervalMs: number
  private readonly last = new Map<string, number>()
  private readonly chains = new Map<string, Promise<void>>()

  constructor(minIntervalMs = 1000) {
    this.minIntervalMs = minIntervalMs
  }

  /** 等待该 host 的轮次：同 host 串行，跨 host 并行 */
  wait(host: string): Promise<void> {
    const prev = this.chains.get(host) ?? Promise.resolve()
    const next = prev.then(async () => {
      const now = Date.now()
      const last = this.last.get(host) ?? 0
      const delta = now - last
      if (delta < this.minIntervalMs) {
        await new Promise((r) => setTimeout(r, this.minIntervalMs - delta))
      }
      this.last.set(host, Date.now())
    })
    // 链上容错：前一个等待失败不阻塞后续
    this.chains.set(
      host,
      next.catch(() => {})
    )
    return next
  }
}
