// yt-dlp 外部 JS 运行时探测与注入（backlog #16，竞品二轮发现①）
// 依据 yt-dlp 官方 EJS 约定（wiki/EJS + issue #15012）：自 2025-11 起，下载
// YouTube 等依赖 nsig 挑战的站点需要外部 JS 运行时（Deno/Node + yt-dlp-ejs）。
// 运行时查找面：PATH，或 yt-dlp 同目录。
//
// OmniGet 策略：
// 1. enginesDir 优先（deno 经引擎按需下载机制放入，与 yt-dlp 同目录）
// 2. 系统 PATH 兜底（用户可能已装 node/deno）
// 3. spawn 时把 enginesDir 前置进子进程 PATH——同目录 + PATH 双查找面兜底
//
// 仅影响 YouTube 等站点；国内站点提取不受影响（缺失时健康页明示）。

import { existsSync } from 'fs'
import { delimiter, join } from 'path'
import { enginesDirs } from './binaries'

export interface JsRuntime {
  name: 'deno' | 'node'
  path: string
  /** engines = 随引擎按需下载（与 yt-dlp 同目录）；path = 系统 PATH 既有安装 */
  source: 'engines' | 'path'
}

const EXE = (n: string): string => (process.platform === 'win32' ? `${n}.exe` : n)

/** 短 TTL 缓存：existsSync 扫描虽轻，但 spawn 期逐次全量扫描无谓 */
let cache: { at: number; value: JsRuntime | null } | null = null
const CACHE_TTL = 30_000

export function findJsRuntime(): JsRuntime | null {
  if (cache && Date.now() - cache.at < CACHE_TTL) return cache.value
  const value = detect()
  cache = { at: Date.now(), value }
  return value
}

function detect(): JsRuntime | null {
  // 跨平台审查 P0-2：mac/Linux 打包态引擎目录可能两级（userData 可写 + 只读 bundle），逐级扫描
  for (const dir of enginesDirs()) {
    for (const name of ['deno', 'node'] as const) {
      const p = join(dir, EXE(name))
      if (existsSync(p)) return { name, path: p, source: 'engines' }
    }
  }
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  for (const name of ['deno', 'node'] as const) {
    for (const d of dirs) {
      const p = join(d, EXE(name))
      if (existsSync(p)) return { name, path: p, source: 'path' }
    }
  }
  return null
}

/** yt-dlp 子进程环境：引擎目录候选链前置进 PATH（同目录约定 + PATH 双查找面） */
export function childEnvWithEngines(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${enginesDirs().join(delimiter)}${delimiter}${process.env.PATH ?? ''}`
  }
}

/** 人类可读状态（健康页 detail / 日志） */
export function jsRuntimeLabel(): string {
  const rt = findJsRuntime()
  return rt ? `${rt.name}（${rt.source === 'engines' ? '引擎目录' : '系统 PATH'}）` : '缺失'
}
