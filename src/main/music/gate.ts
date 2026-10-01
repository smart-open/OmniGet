// M2-5 端口：同 host 请求串行化 + 最小间隔（防平台风控，§4.5）
// Python 版用 threading.Lock 实现，此处为 Promise 链式队列（单线程事件循环天然串行）

/** AbortSignal 等待期间的取消异常（与 fetch 行为一致，上层按取消处理） */
function abortError(): Error {
  const e = new Error(' Aborted')
  e.name = 'AbortError'
  return e
}

export class HostGate {
  private readonly minIntervalMs: number
  private readonly last = new Map<string, number>()
  private readonly chains = new Map<string, Promise<void>>()

  constructor(minIntervalMs = 1000) {
    this.minIntervalMs = minIntervalMs
  }

  /** 等待该 host 的轮次：同 host 串行，跨 host 并行。
   * signal：限速等待可被取消（M-5 盲点修复——取消不必白等最多 1s） */
  wait(host: string, signal?: AbortSignal): Promise<void> {
    const prev = this.chains.get(host) ?? Promise.resolve()
    const next = prev.then(async () => {
      const now = Date.now()
      const last = this.last.get(host) ?? 0
      const delta = now - last
      if (signal?.aborted) throw abortError()
      if (delta < this.minIntervalMs) {
        await new Promise<void>((resolve, reject) => {
          let t: NodeJS.Timeout | undefined
          const onAbort = (): void => done(true)
          const done = (aborted = false): void => {
            if (t) clearTimeout(t)
            signal?.removeEventListener('abort', onAbort)
            if (aborted) reject(abortError())
            else resolve()
          }
          t = setTimeout(() => done(), this.minIntervalMs - delta)
          signal?.addEventListener('abort', onAbort, { once: true })
        })
      }
      this.last.set(host, Date.now())
    })
    // 链上容错：前一个等待失败（含取消）不阻塞后续
    this.chains.set(
      host,
      next.catch(() => {})
    )
    return next
  }
}
