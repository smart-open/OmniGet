// yt-dlp 外部 JS 运行时探测与注入（backlog #16，竞品二轮发现①）
// 依据 yt-dlp 官方 EJS 约定（wiki/EJS + issue #15012）：自 2025-11 起，下载
// YouTube 等依赖 nsig 挑战的站点需要外部 JS 运行时（Deno/Node + yt-dlp-ejs）。
// 运行时查找面：PATH，或 yt-dlp 同目录。
//
// OmniGet 策略：
// 1. enginesDir 优先（deno 经引擎按需下载机制放入，与 yt-dlp 同目录）
// 2. 系统 PATH 兜底（用户可能已装 node/deno）
// 3. Electron 复用兜底（一期 0.8.0，零包体调查结论落地）：ELECTRON_RUN_AS_NODE=1
//    下 Electron 主二进制即 Node.js 运行时（官方文档 Process: Run as Node.js）——
//    把自身可执行文件以 node 名注册进引擎目录（硬链接零拷贝），spawn yt-dlp 时
//    注入该环境变量，yt-dlp 调起的 node 即为 Node 运行时，EJS 可用且不增一分包体
//    /下载量。子进程链（yt-dlp → node）均非 Electron 进程，该变量无副作用
// 4. spawn 时把 enginesDir 前置进子进程 PATH——同目录 + PATH 双查找面兜底
//
// 仅影响 YouTube 等站点；国内站点提取不受影响（缺失时健康页明示）。
// ⚠ TOFU 覆盖面备案：shim 由自身二进制派生（与 deno 同理主进程从不执行、无强制
// 点），不入 TOFU——显式接受项，口径与 engine-fetch deno 条目一致。

import { existsSync, linkSync, symlinkSync, rmSync, statSync } from 'fs'
import { spawnSync } from 'child_process'
import { basename, delimiter, join } from 'path'
import { enginesDir, enginesDirs } from './binaries'

export interface JsRuntime {
  name: 'deno' | 'node'
  path: string
  /** engines = 随引擎按需下载（与 yt-dlp 同目录）；path = 系统 PATH 既有安装；
   * shim = Electron 复用（ELECTRON_RUN_AS_NODE，零包体兜底） */
  source: 'engines' | 'path' | 'shim'
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
  return synthesizeNodeShim()
}

/** 三级兜底：把自身可执行文件以 node 名注册进引擎目录（打包态 only，dev 机器
 * 一般已有 node/deno 且不污染仓库目录）。
 * 落盘只做零拷贝两种：硬链接（Windows 同卷；NSIS 默认 per-user 安装覆盖主流场景）
 * → 符号链接（POSIX，指向路径天然跟随应用更新）。审查修复（P2）：不做复制兜底
 * ——跨卷复制 ~200MB 发生在同步探测路径（所有 yt-dlp spawn 经 findJsRuntime），
 * 会阻塞主进程数秒以上；跨卷 Windows 便携版降级「缺失」口径，走 deno 按需下载
 * 主路径（deno 在引擎清单内，本 shim 仅分发源缺失时的兜底）。 */
function synthesizeNodeShim(): JsRuntime | null {
  const packaged = (process as unknown as { resourcesPath?: string }).resourcesPath
  if (!packaged) return null
  const dir = enginesDir()
  const exe = process.execPath
  if (!dir || !exe) return null
  // 防呆：自身已是 node/deno 形态（Electron-as-Node 场景）时无需注册
  if (/^(node|deno)(\.exe)?$/i.test(basename(exe))) return null
  const target = join(dir, EXE('node'))
  try {
    // 版本对齐：既有 shim 与当前主程序体积不符（应用已更新）时重建
    const same = existsSync(target) && statSync(target).size === statSync(exe).size
    if (!same) {
      rmSync(target, { force: true })
      try {
        linkSync(exe, target)
      } catch {
        symlinkSync(exe, target)
      }
    }
  } catch {
    return null // 文件系统不配合（只读卷等）→ 维持「缺失」口径，健康页明示
  }
  if (!existsSync(target)) return null
  // 实测验证：`node --version` 须返回正常 Node 版本号——ELECTRON_RUN_AS_NODE 对
  // shim 自身同样生效（防壳形态异常静默传导给 yt-dlp，失败即清理回退「缺失」）
  const v = spawnSync(target, ['--version'], {
    encoding: 'utf8',
    timeout: 10_000,
    windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  })
  if (v.status !== 0 || !/^v\d+\./.test((v.stdout ?? '').trim())) {
    rmSync(target, { force: true })
    return null
  }
  return { name: 'node', path: target, source: 'shim' }
}

/** yt-dlp 子进程环境：引擎目录候选链前置进 PATH（同目录约定 + PATH 双查找面）。
 * 审查修复（P1）：凡解析自引擎目录的 node 一律注入 ELECTRON_RUN_AS_NODE=1——
 * 应用更新后 tier-1 会命中「指向旧 exe 的陈旧硬链接 shim」（体积对齐重建在
 * tier-3，永远走不到），若此时不注入，旧 Electron 二进制会被当成 GUI 拉起；
 * 该变量为 Electron 专属，用户自放的真 node.exe 对其零感知，无副作用 */
export function childEnvWithEngines(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${enginesDirs().join(delimiter)}${delimiter}${process.env.PATH ?? ''}`
  }
  const rt = findJsRuntime()
  if (rt?.name === 'node' && rt.source !== 'path') env.ELECTRON_RUN_AS_NODE = '1'
  return env
}

/** 人类可读状态（健康页 detail / 日志） */
export function jsRuntimeLabel(): string {
  const rt = findJsRuntime()
  if (!rt) return '缺失'
  const src = rt.source === 'engines' ? '引擎目录' : rt.source === 'path' ? '系统 PATH' : 'Electron 复用（零包体）'
  return `${rt.name}（${src}）`
}
