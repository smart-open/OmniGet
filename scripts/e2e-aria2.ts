// aria2 端到端集成验证（M1-3/M1-7，纯 Node，无需 electron）：
// 1. spawn sidecar aria2c + RPC 握手
// 2. HTTP 直链 HEAD 探测（parseHttp）
// 3. 多连接下载 → 中途 pause → resume → completed
// 4. 校验落盘文件体积与 HEAD content-length 一致

import { spawn } from 'child_process'
import { stat } from 'fs/promises'
import { join } from 'path'
import { Aria2Supervisor } from '../src/main/orchestrator/aria2'
import { Aria2Adapter } from '../src/main/adapters/aria2'
import type { Task } from '../src/shared/types'

const RPC_PORT = 16888
const URL =
  process.env.E2E_URL ?? 'https://registry.npmmirror.com/typescript/-/typescript-5.7.2.tgz'
const SAVE_DIR = join(process.cwd(), '.e2e-tmp')

// 自持实例：finally 按启动进程的 PID 树终止，不误杀机器上无关的 aria2c
let supervisor: Aria2Supervisor | null = null

async function main(): Promise<void> {
  console.log('[e2e] starting aria2c supervisor...')
  supervisor = new Aria2Supervisor(RPC_PORT)
  await supervisor.start()
  console.log('[e2e] aria2 online')

  const adapter = new Aria2Adapter(supervisor)
  const health = await adapter.health()
  assert(health.online, 'adapter health should be online')

  const task: Task = {
    id: 'e2e-http-1',
    type: 'http',
    source: URL,
    name: '',
    engine: 'aria2',
    status: 'parsing',
    saveDir: SAVE_DIR,
    totalBytes: 0,
    downloadedBytes: 0,
    speedBps: 0,
    threads: 16,
    createdAt: Date.now()
  }

  // ── HEAD 探测（M1-7）────────────────────────────────────────────
  const parsed = await adapter.parse(task)
  console.log(`[e2e] HEAD ok: name=${parsed.name} size=${parsed.totalBytes}`)
  assert(parsed.totalBytes > 0, 'content-length should be > 0')

  // ── start → 中途 pause → resume → completed（M1-3/§4.5 续传语义）─
  task.name = parsed.name
  task.status = 'queued'
  const gid = await adapter.start(task)
  console.log(`[e2e] started gid=${gid}`)
  task.engineGid = gid

  task.status = 'running'
  await sleep(1200)
  await adapter.pause(task)
  const paused = (await supervisor.getClient().call('tellStatus', gid)) as {
    status: string
  }
  assert(paused.status === 'paused', `expected paused, got ${paused.status}`)
  console.log('[e2e] paused mid-download ok')

  await sleep(500)
  await adapter.resume(task)
  console.log('[e2e] resumed')

  const deadline = Date.now() + 60_000
  let finalStatus = ''
  while (Date.now() < deadline) {
    const st = (await supervisor.getClient().call('tellStatus', gid)) as {
      status: string
      completedLength: string
      totalLength: string
      downloadSpeed: string
    }
    finalStatus = st.status
    if (st.status === 'complete' || st.status === 'error') break
    await sleep(500)
  }
  assert(finalStatus === 'complete', `expected complete, got ${finalStatus}`)
  console.log('[e2e] download completed')

  // ── 落盘校验：体积与 HEAD 一致（断网续传哈希不变的替代口径）──────
  const expected = Number(parsed.totalBytes)
  const actual = (await stat(join(SAVE_DIR, parsed.name))).size
  assert(
    actual === expected,
    `file size mismatch: ${actual} != ${expected}`
  )
  console.log(`[e2e] file size verified: ${actual} bytes`)

  await supervisor.shutdown()
  console.log('[e2e] ALL PASSED')
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`)
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

main()
  .catch((err) => {
    console.error('[e2e] FAILED:', err)
    process.exitCode = 1
  })
  .finally(() => {
    // 按本脚本启动实例的 PID 树终止（跨平台），不误杀机器上无关的 aria2c
    if (supervisor) void supervisor.shutdown()
  })
