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
