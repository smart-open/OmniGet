// 五期（0.12.x）：启动队列分组轮转（roadmap 五期「按订阅源队列分组」）。
// 纯函数独立成文件：manager 的 startQueue 派发顺序可单测，不依赖 DB/引擎。

/** 启动队列条目：run 为带状态自检的启动闭包；group 为队列分组标签
 * （订阅创建的任务 = 订阅源名，手动任务无标签） */
export interface QueueEntry {
  run: () => void
  group?: string
}

/**
 * 分组轮转派发序：同组保持 FIFO（订阅批量条目按抓取顺序下载），
 * 跨组交替（round-robin）——单个订阅源的批量积压不再饿死手动任务。
 * 无标签的手动任务视为同一个匿名组，参与同一轮转。
 */
export function interleaveByGroup<T extends QueueEntry>(entries: T[]): T[] {
  const buckets = new Map<string, T[]>()
  const order: string[] = []
  for (const e of entries) {
    const g = e.group ?? ''
    if (!buckets.has(g)) {
      buckets.set(g, [])
      order.push(g)
    }
    buckets.get(g)!.push(e)
  }
  const out: T[] = []
  let remaining = entries.length
  while (remaining > 0) {
    let advanced = false
    for (const g of order) {
      const b = buckets.get(g)!
      if (b.length > 0) {
        out.push(b.shift()!)
        remaining--
        advanced = true
      }
    }
    // 防御：remaining 计数与桶内容不一致时终止（理论不可达）
    if (!advanced) break
  }
  return out
}
