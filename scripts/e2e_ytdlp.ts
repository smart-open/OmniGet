// yt-dlp 端到端（M3-1/2/3）：版本探测 → -J 解析 formats → 最低画质下载 → 校验落盘
// 运行方式同 npm test（Electron-as-Node，better-sqlite3 ABI 匹配）
import { mkdtempSync, statSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const tmp = mkdtempSync(join(tmpdir(), 'og-ytdlp-'))
process.env.OMNIGET_TEST_DATA_DIR = tmp

const URL = process.env.E2E_URL ?? 'https://www.bilibili.com/video/BV1GJ411x7h7/'

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`)
}

async function main(): Promise<void> {
  const { getYtDlpSupervisor } = await import('../src/main/orchestrator/ytdlp')
  const { YtDlpAdapter } = await import('../src/main/adapters/ytdlp')

  const sup = getYtDlpSupervisor()
  const version = await sup.version()
  console.log('[e2e] yt-dlp version:', version)
  assert(Boolean(version), 'version probe failed')
  console.log('[e2e] ffmpeg available:', await sup.ffmpegAvailable())

  const adapter = new YtDlpAdapter()
  const health = await adapter.health()
  assert(health.online, 'adapter health online')
  console.log('[e2e] health ok:', health.detail)

  const task = {
    id: 'e2e-ytdlp-1',
    type: 'video',
    source: URL,
    name: '',
    engine: 'ytdlp',
    status: 'parsing',
    saveDir: tmp,
    totalBytes: 0,
    downloadedBytes: 0,
    speedBps: 0,
    threads: 4,
    createdAt: Date.now()
  } as import('../src/shared/types').Task

  // ── parse：-J formats（M3-3/M3-11）──────────────────────────────
  const parsed = await adapter.parse(task)
  console.log(
    `[e2e] parse ok: name=${parsed.name} formats=${parsed.formats?.length} duration=${parsed.duration} cover=${Boolean(parsed.coverUrl)}`
  )
  assert((parsed.formats?.length ?? 0) > 0, 'formats should not be empty')

  // ── start：最低视频+音频组合（速度优先）─────────────────────────
  adapter.setVideoOptions(task.id, { formatId: 'worstvideo+worstaudio/worst' })
  adapter.setSink((e) => {
    if (e.status === 'running' && e.downloadedBytes) {
      process.stdout.write(`\r[e2e] progress: ${e.downloadedBytes} bytes`)
    } else if (e.error) {
      console.log(`\n[e2e] event: ${e.status} ${e.error ?? ''}`)
    } else if (e.status === 'completed') {
      console.log('\n[e2e] event: completed')
    }
  })
  task.status = 'queued'
  const gid = await adapter.start(task)
  console.log('[e2e] started gid=', gid)

  // 轮询等待 completed（adapter 事件经 sink 同步；此处简单等待文件出现）
  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    if (!adapter.isRunning(task.id)) break
    await new Promise((r) => setTimeout(r, 1000))
  }
  assert(!adapter.isRunning(task.id), 'task still running after 180s')

  const files = rmNoop()
  const video = files.find((f) => /\.(mp4|mkv|webm)$/i.test(f))
  assert(Boolean(video), 'video file not found')
  const size = statSync(join(tmp, video!)).size
  assert(size > 100_000, `video too small: ${size}`)
  console.log(`[e2e] video file: ${video} (${size} bytes)`)
  console.log('[e2e] ALL PASSED')
}

function rmNoop(): string[] {
  const out: string[] = []
  for (const f of require('fs').readdirSync(tmp)) out.push(f)
  return out
}

main()
  .catch((err) => {
    console.error('[e2e] FAILED:', err.message ?? err)
    process.exitCode = 1
  })
  .finally(() => {
    const { closeDb } = require('../src/main/db')
    closeDb()
    rmSync(tmp, { recursive: true, force: true })
  })
