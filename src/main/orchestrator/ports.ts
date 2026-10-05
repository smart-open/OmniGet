// 端口分配器（T0-8，§11 风险 #3）
// aria2 RPC 起始 16800；被占用则顺延（上限 16810）。
// （音乐服务已内嵌主进程，不再需要独立端口）

import { createServer } from 'net'

const MAX_PORT = 16810

function probe(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer()
    srv.once('error', () => resolve(false))
    srv.once('listening', () => {
      srv.close(() => resolve(true))
    })
    srv.listen(port, '127.0.0.1')
  })
}

export async function allocatePorts(): Promise<{ aria2RpcPort: number }> {
  for (let p = 16800; p <= MAX_PORT; p++) {
    if (await probe(p)) return { aria2RpcPort: p }
  }
  throw new Error(`端口分配失败：范围 [16800, ${MAX_PORT}] 内无可用端口`)
}

/** 第九轮审查：aria2 崩溃重启前重探端口——优先原端口，被占则向上顺延（不回卷，
 * 避免与其它实例互抢）。全部占满时原样返回（由 spawn 侧按原口径失败退避） */
export async function reallocateRpcPort(preferred: number): Promise<number> {
  if (await probe(preferred)) return preferred
  for (let p = preferred + 1; p <= MAX_PORT; p++) {
    if (await probe(p)) return p
  }
  return preferred
}
