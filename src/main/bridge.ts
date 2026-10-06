// R1+R5：本地桥接服务（127.0.0.1 + token 鉴权）
// - 浏览器扩展（resources/extension/）：拦截/右键下载 → POST /api/download
// - Web UI：http://127.0.0.1:<port>/?token=<token> 任务面板 + 链接推送
// 安全边界：默认仅绑定回环地址；全部 /api 需 token（首启随机生成入库）；
// 源 URL 经统一嗅探器/createTask 白名单路由，不直接下载任意内容。
// 五期（0.12.x）远程强化：
// - 局域网远程访问（bridge.lan，opt-in 默认关）：绑定 0.0.0.0，token 鉴权全端点
//   保持强制；Host 校验在 LAN 模式放行（局域网设备以 IP:port 访问，token 兜底）
// - 任务管理端点：/api/tasks 支持过滤/分页/搜索、/api/stats 聚合速度、
//   POST /api/task/:id/:action（pause|resume|remove|retry）远程任务管理

import http from 'http'
import { randomUUID, timingSafeEqual } from 'crypto'
import { createServer } from 'net'
import { networkInterfaces } from 'os'
import { app } from 'electron'
import type { TaskManager } from './task/manager'
import type { TaskStatus } from '@shared/types'
import { getSettingParsed, setSetting } from './db'
import { listTasks, taskCounts, getTask } from './task/store'
import { createLogger } from './logger'

const log = createLogger('bridge')

let server: http.Server | null = null
let currentManager: TaskManager | null = null
let info = { port: 0, token: '', running: false, lan: false }

/** 探测从 start 起第一个可用回环端口 */
async function probePort(start: number): Promise<number> {
  for (let p = start; p < start + 20; p++) {
    const ok = await new Promise<boolean>((resolve) => {
      const s = createServer()
      s.once('error', () => resolve(false))
      s.once('listening', () => s.close(() => resolve(true)))
      s.listen(p, '127.0.0.1')
    })
    if (ok) return p
  }
  return start
}

/** 本机局域网 IPv4 地址（面板地址提示用；无则空数组） */
function lanAddresses(): string[] {
  const out: string[] = []
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address)
    }
  }
  return out
}

function json(res: http.ServerResponse, code: number, req?: http.IncomingMessage, body?: unknown): void {
  const headers: Record<string, string | number> = {
    'Content-Type': 'application/json; charset=utf-8',
    // M-3 收紧：不再通配 *。仅对浏览器扩展来源回显 Origin（扩展 fetch 需要 CORS 应答），
    // 其余来源不携带 ACAO——任意网页即使拿到 token 也无法跨域读取响应
    ...(req?.headers.origin?.startsWith('chrome-extension://')
      ? { 'Access-Control-Allow-Origin': req.headers.origin }
      : {}),
    'Access-Control-Allow-Headers': 'content-type, x-omniget-token',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  }
  res.writeHead(code, headers)
  res.end(JSON.stringify(body ?? null))
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = ''
    let settled = false
    const done = (v: string): void => {
      if (!settled) {
        settled = true
        resolve(v)
      }
    }
    const handler = (c: Buffer): void => {
      data += String(c)
      if (data.length > 1_000_000) {
        // P3 修复：超限后先摘除监听并 resolve，再销毁 socket——原实现 destroy 后
        // end/error 不保证触发，Promise 可能永不 settle（handler 挂起 + socket 泄漏）
        req.removeListener('data', handler)
        done(data)
        req.destroy()
      }
    }
    req.on('data', handler)
    req.on('end', () => done(data))
    req.on('error', () => done(''))
  })
}

/** 常量时间字符串比较，防时序侧信道枚举 token */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ab.length !== bb.length) {
    // 长度不等也要跑一次比较，抹平时长差异
    timingSafeEqual(ab, ab)
    return false
  }
  return timingSafeEqual(ab, bb)
}

function authed(req: http.IncomingMessage, token: string, lan: boolean): boolean {
  const header = req.headers['x-omniget-token']
  // Host 校验：防 DNS rebinding（回环绑定 + token 仍兜底）。
  // L1 修复：IPv6 字面量形如 [::1]:16820——按括号截取，此前 split(':')[0] 切出 '['
  // 导致 [::1] 分支永远匹配不上且合法请求被误杀
  // 五期：LAN 模式跳过 Host 白名单——局域网设备以 IP:port 访问，
  // token 全端点强制兜底（rebinding 攻击者拿不到 token）
  if (!lan) {
    const rawHost = String(req.headers.host ?? '')
    const host = rawHost.startsWith('[')
      ? (/\[[^\]]*\]/.exec(rawHost)?.[0] ?? rawHost)
      : rawHost.split(':')[0]
    if (host && host !== '127.0.0.1' && host !== 'localhost' && host !== '[::1]') return false
  }
  // M-3：/api 仅收 header token——query token 会进浏览器历史/Referer
  return typeof header === 'string' && safeEqual(header, token)
}

function taskRow(t: {
  id: string
  name: string
  status: string
  type: string
  downloadedBytes: number
  totalBytes: number
  speedBps: number
  queueGroup?: string
  error?: string | null
}): Record<string, unknown> {
  return {
    id: t.id,
    name: t.name || '(解析中)',
    status: t.status,
    type: t.type,
    progress:
      t.totalBytes > 0 ? Math.min(100, Math.round((t.downloadedBytes / t.totalBytes) * 100)) : 0,
    downloadedBytes: t.downloadedBytes,
    totalBytes: t.totalBytes,
    speedBps: t.speedBps,
    queueGroup: t.queueGroup ?? undefined,
    error: t.error ?? undefined
  }
}

async function handle(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  manager: TaskManager,
  token: string,
  port: number,
  lan: boolean
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      // 与 json() 同口径：仅扩展来源回显 Origin
      ...(req.headers.origin?.startsWith('chrome-extension://')
        ? { 'Access-Control-Allow-Origin': req.headers.origin }
        : {}),
      'Access-Control-Allow-Headers': 'content-type, x-omniget-token',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
    })
    res.end()
    return
  }

  // Web UI 页面（token 经 query 校验后注入页面；页面脚本随即剥离 URL 中的 token）
  if (req.method === 'GET' && url.pathname === '/') {
    if (safeEqual(url.searchParams.get('token') ?? '', token) === false) {
      res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('需要访问令牌：在 OmniGet 设置 → 远程/扩展 中查看 token，访问 /?token=<token>')
      return
    }
    // 第七轮审查 P3：补 CSP 纵深——页面内容含渲染层/任务名等攻击者可控文本
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy':
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      'Referrer-Policy': 'no-referrer'
    })
    res.end(renderPage(port))
    return
  }

  // M-3：/api 只收 header token（扩展本就走 header；query token 会进浏览器历史/
  // Referer，仅保留页面入口这一处 bootstrap 用途）
  if (!authed(req, token, lan)) {
    json(res, 401, req, { ok: false, error: 'token 不匹配' })
    return
  }

  try {
    if (req.method === 'GET' && url.pathname === '/api/ping') {
      json(res, 200, req, { ok: true, app: 'OmniGet', version: app.getVersion() })
      return
    }
    // 五期：任务管理列表——状态过滤/关键词搜索/分页（默认前 100 条）
    if (req.method === 'GET' && url.pathname === '/api/tasks') {
      const counts = await taskCounts()
      // 状态过滤下推 SQL（合法值白名单外直接忽略，防注入面收敛在 store 层参数化）
      const VALID_STATUS = new Set([
        'parsing', 'awaiting', 'queued', 'running', 'paused', 'verifying', 'seeding', 'completed', 'failed'
      ])
      const status = (url.searchParams.get('status') ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => VALID_STATUS.has(s))
      const q = (url.searchParams.get('q') ?? '').trim().toLowerCase()
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 100))
      const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0)
      let tasks = listTasks(status.length > 0 ? { status: status as TaskStatus[] } : {})
      if (q) tasks = tasks.filter((t) => (t.name ?? '').toLowerCase().includes(q) || t.source.toLowerCase().includes(q))
      const total = tasks.length
      const rows = tasks.slice(offset, offset + limit).map(taskRow)
      json(res, 200, req, { ok: true, counts, total, tasks: rows })
      return
    }
    // 五期：聚合状态（托盘同口径快照）——面板头部速度/计数展示
    if (req.method === 'GET' && url.pathname === '/api/stats') {
      const speeds = manager.getAggregateSpeeds()
      const counts = await taskCounts()
      json(res, 200, req, {
        ok: true,
        downBps: speeds.down,
        upBps: speeds.up,
        running: speeds.running,
        queued: speeds.queued,
        counts
      })
      return
    }
    if (req.method === 'POST' && url.pathname === '/api/download') {
      const body = JSON.parse((await readBody(req)) || '{}') as { url?: string }
      const source = String(body.url ?? '').trim()
      if (!source) {
        json(res, 400, req, { ok: false, error: '缺少 url' })
        return
      }
      const saveDir =
        getSettingParsed<string>('download.saveDir') || app.getPath('downloads')
      const result = await manager.createTask({ source, threads: 16, saveDir })
      if (result.kind === 'failed') {
        json(res, 422, req, { ok: false, error: result.error })
        return
      }
      // 扩展/远程提交默认全选直接入队（awaiting 类自动确认；http 已在 createTask 直启）
      if (result.kind === 'awaiting' && result.sniff.type !== 'http') {
        await manager.confirmSelection({ taskId: result.taskId, threads: 16 })
      }
      json(res, 200, req, { ok: true, taskId: result.taskId })
      return
    }
    // 五期：远程任务管理——POST /api/task/:id/:action
    const m = /^\/api\/task\/([A-Za-z0-9-]+)\/(pause|resume|remove|retry)$/.exec(url.pathname)
    if (req.method === 'POST' && m) {
      // noUncheckedIndexedAccess：捕获组已由正则保证非空
      const taskId = m[1]!
      const action = m[2]!
      const task = getTask(taskId)
      if (!task) {
        json(res, 404, req, { ok: false, error: '任务不存在' })
        return
      }
      try {
        if (action === 'retry') await manager.retryTask(taskId)
        else await manager.control({ taskId, action: action as 'pause' | 'resume' | 'remove' })
      } catch (err) {
        json(res, 409, req, {
          ok: false,
          error: err instanceof Error ? err.message : String(err)
        })
        return
      }
      json(res, 200, req, { ok: true })
      return
    }
    json(res, 404, req, { ok: false, error: 'not found' })
  } catch (err) {
    json(res, 500, req, { ok: false, error: err instanceof Error ? err.message : String(err) })
  }
}

function renderPage(port: number): string {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width, initial-scale=1"><title>OmniGet 远程</title>
<style>
:root{color-scheme:dark}
body{font-family:system-ui,sans-serif;background:#0B0C0E;color:#E7E9EC;margin:0;padding:24px;max-width:760px;margin-inline:auto}
h1{font-size:16px;margin:0 0 16px}
input,button{font:inherit}
.row{display:flex;gap:8px;margin-bottom:12px}
input[type=text]{flex:1;background:#15171A;border:1px solid #2A2D33;border-radius:8px;color:inherit;padding:8px 12px;font-size:13px}
button{background:#3B6EFF;color:#fff;border:0;border-radius:8px;padding:8px 16px;font-size:13px;cursor:pointer}
button.mini{background:#1E2126;color:#E7E9EC;padding:3px 10px;font-size:11px;border-radius:6px}
button.mini.danger{color:#E5615C}
#summary{display:flex;gap:14px;font-size:12px;margin-bottom:14px;flex-wrap:wrap}
#summary b{color:#3B6EFF}
table{width:100%;border-collapse:collapse;font-size:12px}
td,th{text-align:left;padding:6px 8px;border-bottom:1px solid #1E2126;vertical-align:middle}
.st-Running,.st-running{color:#3B6EFF}.st-completed,.st-Completed{color:#4CAF7D}.st-failed,.st-Failed{color:#E5615C}.st-paused{color:#E8B34B}
.bar{height:5px;background:#1E2126;border-radius:3px;overflow:hidden;min-width:90px}
.bar>div{height:100%;background:#3B6EFF}
.muted{color:#8B9096}
.grp{display:inline-block;font-size:10px;color:#8B9096;border:1px solid #2A2D33;border-radius:4px;padding:0 5px;margin-left:6px}
@media (max-width:600px){.hide-sm{display:none}}
</style></head><body>
<h1>OmniGet 远程任务面板 <span class="muted" style="font-size:12px">:${port}</span></h1>
<form class="row" id="f">
  <input type="text" id="url" placeholder="粘贴磁力 / 视频链接 / 音乐名 / 直链，提交到桌面端下载" />
  <button type="submit">下载</button>
</form>
<div class="row"><input type="text" id="q" placeholder="按名称/链接过滤任务…" /></div>
<div id="summary" class="muted"></div>
<div id="msg" class="muted" style="font-size:12px;margin-bottom:12px"></div>
<table><thead><tr><th style="width:38%">任务</th><th>状态</th><th class="hide-sm">进度</th><th>操作</th></tr></thead>
<tbody id="rows"></tbody></table>
<script>
const token = new URLSearchParams(location.search).get('token')
// M-3：立即剥离 URL 中的 token（replaceState 替换当前历史条目，token 不进历史/后续 Referer）
try { history.replaceState(null, '', location.pathname) } catch {}
const H = { 'x-omniget-token': token, 'content-type': 'application/json' }
let qTimer = null
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]))
}
function fmtBps(v) {
  if (!v || v <= 0) return ''
  const u = ['B/s','KB/s','MB/s','GB/s']; let i = 0; let n = v
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++ }
  return n.toFixed(n >= 100 || i === 0 ? 0 : 1) + ' ' + u[i]
}
function fmtSize(v) {
  if (!v || v <= 0) return ''
  const u = ['B','KB','MB','GB']; let i = 0; let n = v
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++ }
  return n.toFixed(n >= 100 || i === 0 ? 0 : 1) + ' ' + u[i]
}
async function act(id, action, needConfirm) {
  if (needConfirm && !confirm('确认移除该任务？（文件保留，可进回收站找回）')) return
  try {
    const r = await fetch('/api/task/' + encodeURIComponent(id) + '/' + action, { method: 'POST', headers: H })
    const d = await r.json()
    document.getElementById('msg').textContent = d.ok ? '操作成功' : ('失败：' + (d.error || ''))
  } catch (e) { document.getElementById('msg').textContent = '无法连接桌面端' }
  refresh()
}
async function refresh() {
  try {
    const qs = new URLSearchParams({ q: document.getElementById('q').value.trim() })
    const [r, s] = await Promise.all([
      fetch('/api/tasks?' + qs, { headers: H }),
      fetch('/api/stats', { headers: H })
    ])
    const d = await r.json()
    const st = await s.json()
    document.getElementById('summary').innerHTML = st.ok
      ? '<span>↓ <b>' + (esc(fmtBps(st.downBps)) || '0') + '</b></span>'
        + '<span>运行 ' + esc(st.running) + '</span><span>排队 ' + esc(st.queued) + '</span>'
        + '<span>完成 ' + esc(st.counts.completed) + '</span><span>失败 ' + esc(st.counts.failed) + '</span>'
      : ''
    document.getElementById('rows').innerHTML = (d.tasks || []).map(t => {
      const p = t.progress || 0
      const canPause = t.status === 'running' || t.status === 'queued'
      const canResume = t.status === 'paused'
      const canRetry = t.status === 'failed'
      const canRemove = t.status !== 'removed'
      return '<tr><td>' + esc(t.name) + (t.queueGroup ? '<span class="grp">' + esc(t.queueGroup) + '</span>' : '')
        + (t.speedBps > 0 ? '<div class="muted" style="font-size:10px">' + esc(fmtBps(t.speedBps)) + '</div>' : '')
        + '</td>'
        + '<td class="st-' + esc(t.status) + '">' + esc(t.status) + '</td>'
        + '<td class="hide-sm"><div class="bar"><div style="width:' + p + '%"></div></div>'
        + '<div class="muted" style="font-size:10px;margin-top:2px">' + p + '%' + (t.totalBytes > 0 ? ' · ' + esc(fmtSize(t.totalBytes)) : '') + '</div></td>'
        + '<td>'
        + (canPause ? '<button class="mini" data-a="pause" data-id="' + esc(t.id) + '">暂停</button> ' : '')
        + (canResume ? '<button class="mini" data-a="resume" data-id="' + esc(t.id) + '">继续</button> ' : '')
        + (canRetry ? '<button class="mini" data-a="retry" data-id="' + esc(t.id) + '">重试</button> ' : '')
        + (canRemove ? '<button class="mini danger" data-a="remove" data-id="' + esc(t.id) + '">移除</button>' : '')
        + '</td></tr>'
    }).join('')
  } catch (e) { document.getElementById('msg').textContent = '无法连接桌面端' }
}
document.body.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-a]')
  if (b) act(b.dataset.id, b.dataset.a, b.dataset.a === 'remove')
})
document.getElementById('f').addEventListener('submit', async (e) => {
  e.preventDefault()
  const url = document.getElementById('url').value.trim()
  if (!url) return
  try {
    const r = await fetch('/api/download', { method: 'POST', headers: H, body: JSON.stringify({ url }) })
    const d = await r.json()
    document.getElementById('msg').textContent = d.ok ? '已提交到下载队列' : ('失败：' + (d.error || ''))
    if (d.ok) { document.getElementById('url').value = ''; refresh() }
  } catch (e) { document.getElementById('msg').textContent = '无法连接桌面端' }
})
document.getElementById('q').addEventListener('input', () => {
  clearTimeout(qTimer); qTimer = setTimeout(refresh, 350)
})
refresh()
setInterval(refresh, 5000)
</script></body></html>`
}

function readLanSetting(): boolean {
  return getSettingParsed<boolean>('bridge.lan') === true
}

function ensureToken(): string {
  let token = getSettingParsed<string>('bridge.token')
  if (typeof token !== 'string' || !/^[a-f0-9]{32}$/.test(token)) {
    token = randomUUID().replace(/-/g, '')
    setSetting('bridge.token', JSON.stringify(token))
  }
  return token
}

let listening = false

/** 监听（Promise 化：成功 resolve，绑定失败 reject——调用方决定是否公示）。
 * listening 之后的 'error' 只记日志（如运行期端口被系统回收）。 */
async function listen(manager: TaskManager, token: string): Promise<void> {
  const lan = readLanSetting()
  const port = await probePort(16820)
  await new Promise<void>((resolve, reject) => {
    const s = http.createServer((req, res) => {
      void handle(req, res, manager, token, port, lan).catch((err) => {
        log.warn('bridge request failed', err)
        try {
          json(res, 500, req, { ok: false, error: 'internal error' })
        } catch {
          // 已响应
        }
      })
    })
    s.on('error', (err) => {
      if (listening) log.warn('bridge server error', err)
      else reject(err)
    })
    s.listen(port, lan ? '0.0.0.0' : '127.0.0.1', () => {
      server = s
      listening = true
      info = { port, token, running: true, lan }
      log.info(
        `bridge listening at http://${lan ? '0.0.0.0' : '127.0.0.1'}:${port} (token auth, ${lan ? 'LAN' : 'loopback only'})`
      )
      resolve()
    })
  })
}

/** 生命周期操作串行化：startBridge/restartBridge/stopBridge 全部入队，
 * 消除「listen 在途（probePort await 期间 server 尚未赋值）时二次触发
 * stopBridge no-op → 双 server、引用覆盖泄漏」的竞态（审查 P1-2） */
let opChain: Promise<void> = Promise.resolve()

function enqueue(op: () => Promise<void>): Promise<void> {
  const p = opChain.then(op)
  opChain = p.catch(() => {})
  return p
}

/** 关闭当前 server 并等待端口释放（重启路径用——close 回调不等待会导致
 * probePort 静默顺延 16821+，固定端口的扩展/Web 面板 URL 失效，审查 P3-9） */
function closeServerAsync(): Promise<void> {
  const s = server
  server = null
  listening = false
  info = { port: 0, token: '', running: false, lan: false }
  if (!s) return Promise.resolve()
  return new Promise((resolve) => {
    try {
      // close 回调不触发的兜底（活动连接挂住时 500ms 后放行，进程退出由 quit 路径强收）
      const timer = setTimeout(resolve, 500)
      s.close(() => {
        clearTimeout(timer)
        resolve()
      })
    } catch {
      resolve()
    }
  })
}

/** 应用启动时调用（manager 就绪后）；重复调用安全（串行队列幂等） */
export function startBridge(manager: TaskManager): void {
  currentManager = manager
  const token = ensureToken()
  void enqueue(async () => {
    if (server || listening) return
    await listen(manager, token)
  }).catch((err) => log.error('bridge failed to start', err))
}

/** 五期：LAN 开关切换后重启桥接服务（token 不变；端口经 close 等待尽量保持 16820）。
 * 绑定失败 reject 上抛——IPC 层回滚设置并让渲染层 toast 真实失败（不再假报成功） */
export async function restartBridge(): Promise<void> {
  const manager = currentManager
  if (!manager) throw new Error('桥接服务尚未初始化')
  const token = ensureToken()
  await enqueue(async () => {
    await closeServerAsync()
    if (stopRequested) return
    await listen(manager, token)
  })
}

export function getBridgeInfo(): {
  port: number
  token: string
  running: boolean
  lan: boolean
  lanAddresses: string[]
} {
  return { ...info, lanAddresses: lanAddresses() }
}

let stopRequested = false

/** P3 修复：退出时显式关闭 HTTP server（此前依赖 app.exit 强杀，与生命周期口径不一致） */
export function stopBridge(): void {
  stopRequested = true
  void enqueue(async () => {
    await closeServerAsync()
  })
}
