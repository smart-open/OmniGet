// 端口分配器（T0-8，§11 风险 #3）
// aria2 RPC 起始 16800，omni-service 起始 16801；被占用则顺延（上限 16810），
// 结果经环境变量下发给子进程。

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

export async function allocatePorts(): Promise<{
  aria2RpcPort: number
  servicePort: number
}> {
  const used = new Set<number>()

  async function pick(start: number): Promise<number> {
    for (let p = start; p <= MAX_PORT; p++) {
      if (used.has(p)) continue
      if (await probe(p)) {
        used.add(p)
        return p
      }
    }
    throw new Error(`端口分配失败：范围 [${start}, ${MAX_PORT}] 内无可用端口`)
  }

  const aria2RpcPort = await pick(16800)
  const servicePort = await pick(16801)
  return { aria2RpcPort, servicePort }
}
