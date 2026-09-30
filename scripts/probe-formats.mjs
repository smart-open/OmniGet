#!/usr/bin/env node
// B 站 formats 原始结构探针（原 probe_formats.py 的跨平台 Node 版）
// 用法: node scripts/probe-formats.mjs [url]
// yt-dlp 路径解析口径与 src/main/orchestrator/binaries.ts 一致：
//   OMNIGET_ENGINES_DIR > resources/engines/<platform>-<arch>

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const platform = `${process.platform}-${process.arch}`
const bin = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'

const candidates = [
  process.env.OMNIGET_ENGINES_DIR,
  join(process.cwd(), 'resources', 'engines', platform)
].filter((p) => p && existsSync(p))

const ytdlp = candidates.length ? join(candidates[0], bin) : bin

const url = process.argv[2] ?? 'https://www.bilibili.com/video/BV1GJ411x7h7/'
const out = spawnSync(ytdlp, ['-J', '--no-playlist', url], {
  encoding: 'utf8',
  timeout: 90_000,
  maxBuffer: 256 * 1024 * 1024
})

if (out.error) {
  console.error('spawn failed:', out.error.message)
  process.exit(1)
}
if (out.status !== 0) {
  console.error('stderr:', (out.stderr ?? '').slice(0, 500))
  process.exit(1)
}

const d = JSON.parse(out.stdout)
const fs = d.formats ?? []
console.log('count:', fs.length)
for (const f of fs.slice(0, 14)) {
  console.log(
    f.format_id, '|', f.ext, '|', f.vcodec, '|', f.acodec, '|', f.protocol, '|', f.height
  )
}
