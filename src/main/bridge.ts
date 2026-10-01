// R1+R5：本地桥接服务（127.0.0.1 + token 鉴权）
// - 浏览器扩展（resources/extension/）：拦截/右键下载 → POST /api/download
// - Web UI：http://127.0.0.1:<port>/?token=<token> 任务面板 + 链接推送
// 安全边界：仅绑定回环地址；全部 /api 需 token（首启随机生成入库）；
// 源 URL 经统一嗅探器/createTask 白名单路由，不直接下载任意内容。

import http from 'http'
import { randomUUID } from 'crypto'
import { createServer } from 'net'
import { app } from 'electron'
import type { TaskManager } from './task/manager'
import { getSettingParsed, setSetting } from './db'
import { listTasks, taskCounts } from './task/store'
import { createLogger } from './logger'

const log = createLogger('bridge')

let server: http.Server | null = null
let info = { port: 0, token: '', running: false }

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

function json(res: http.ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'content-type, x-omniget-token',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  })
  res.end(JSON.stringify(body))
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
    req.on('data', (c: Buffer) => {
      data += String(c)
      if (data.length > 1_000_000) {
        // P3 修复：超限后先摘除监听并 resolve，再销毁 socket——原实现 destroy 后
        // end/error 不保证触发，Promise 可能永不 settle（handler 挂起 + socket 泄漏）
        req.removeListener('data', handler)
        done(data)
        req.destroy()
      }
    })
    const handler = (c: Buffer): void => {
      data += String(c)
      if (data.length > 1_000_000) {
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

function authed(req: http.IncomingMessage, url: URL, token: string): boolean {
  const header = req.headers['x-omniget-token']
  const query = url.searchParams.get('token')
  return (typeof header === 'string' && header === token) || query === token
}

function taskRow(t: {
  id: string
  name: string
  status: string
  type: string
  downloadedBytes: number
  totalBytes: number
  error?: string | null
}): Record<string, unknown> {
  return {
    id: t.id,
    name: t.name || '(解析中)',
    status: t.status,
    type: t.type,
    progress:
      t.totalBytes > 0 ? Math.min(100, Math.round((t.downloadedBytes / t.totalBytes) * 100)) : 0,
    error: t.error ?? undefined
  }
}

async function handle(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  manager: TaskManager,
  token: string,
  port: number
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'content-type, x-omniget-token',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
    })
    res.end()
    return
  }

  // Web UI 页面（token 经 query 校验后注入页面）
  if (req.method === 'GET' && url.pathname === '/') {
    if (url.searchParams.get('token') !== token) {
      res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('需要访问令牌：在 OmniGet 设置 → 远程/扩展 中查看 token，访问 /?token=<token>')
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(renderPage(port))
    return
  }

  if (!authed(req, url, token)) {
    json(res, 401, { ok: false, error: 'token 不匹配' })
    return
  }

  try {
    if (req.method === 'GET' && url.pathname === '/api/ping') {
      json(res, 200, { ok: true, app: 'OmniGet', version: app.getVersion() })
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/tasks') {
      const counts = await taskCounts()
      const tasks = listTasks({})
        .slice(0, 50)
        .map(taskRow)
      json(res, 200, { ok: true, counts, tasks })
      return
    }
    if (req.method === 'POST' && url.pathname === '/api/download') {
      const body = JSON.parse((await readBody(req)) || '{}') as { url?: string }
      const source = String(body.url ?? '').trim()
      if (!source) {
        json(res, 400, { ok: false, error: '缺少 url' })
        return
      }
      const saveDir =
        getSettingParsed<string>('download.saveDir') || app.getPath('downloads')
      const result = await manager.createTask({ source, threads: 16, saveDir })
      if (result.kind === 'failed') {
        json(res, 422, { ok: false, error: result.error })
        return
      }
      // 扩展/远程提交默认全选直接入队（awaiting 类自动确认；http 已在 createTask 直启）
      if (result.kind === 'awaiting' && result.sniff.type !== 'http') {
        await manager.confirmSelection({ taskId: result.taskId, threads: 16 })
      }
      json(res, 200, { ok: true, taskId: result.kind === 'awaiting' ? result.taskId : result.taskId })
      return
    }
    json(res, 404, { ok: false, error: 'not found' })
  } catch (err) {
    json(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
  }
}

function renderPage(port: number): string {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>OmniGet 远程</title>
<style>
:root{color-scheme:dark}
body{font-family:system-ui,sans-serif;background:#0B0C0E;color:#E7E9EC;margin:0;padding:24px;max-width:760px;margin-inline:auto}
h1{font-size:16px;margin:0 0 16px}
input,button{font:inherit}
.row{display:flex;gap:8px;margin-bottom:16px}
input[type=text]{flex:1;background:#15171A;border:1px solid #2A2D33;border-radius:8px;color:inherit;padding:8px 12px;font-size:13px}
button{background:#3B6EFF;color:#fff;border:0;border-radius:8px;padding:8px 16px;font-size:13px;cursor:pointer}
table{width:100%;border-collapse:collapse;font-size:12px}
td,th{text-align:left;padding:6px 8px;border-bottom:1px solid #1E2126}
.st-Running,.st-running{color:#3B6EFF}.st-completed,.st-Completed{color:#4CAF7D}.st-failed,.st-Failed{color:#E5615C}
.muted{color:#8B9096}
</style></head><body>
<h1>OmniGet 远程任务面板 <span class="muted" style="font-size:12px">127.0.0.1:${port}</span></h1>
<form class="row" id="f">
  <input type="text" id="url" placeholder="粘贴磁力 / 视频链接 / 音乐名 / 直链，提交到桌面端下载" />
  <button type="submit">下载</button>
</form>
<div id="msg" class="muted" style="font-size:12px;margin-bottom:12px"></div>
<table><thead><tr><th style="width:34%">任务</th><th>状态</th><th>进度</th><th class="muted">类型</th></tr></thead>
<tbody id="rows"></tbody></table>
<script>
const token = new URLSearchParams(location.search).get('token')
const H = { 'x-omniget-token': token, 'content-type': 'application/json' }
async function refresh() {
  try {
    const r = await fetch('/api/tasks?token=' + encodeURIComponent(token), { headers: H })
    const d = await r.json()
    document.getElementById('rows').innerHTML = (d.tasks || []).map(t =>
      '<tr><td>' + (t.name || '').replace(/</g, '&lt;') + '</td>' +
      '<td class="st-' + t.status + '">' + t.status + '</td>' +
      '<td class="num">' + t.progress + '%</td><td class="muted">' + t.type + '</td></tr>'
    ).join('')
  } catch (e) { document.getElementById('msg').textContent = '无法连接桌面端' }
}
document.getElementById('f').addEventListener('submit', async (e) => {
  e.preventDefault()
  const url = document.getElementById('url').value.trim()
  if (!url) return
  try {
    const r = await fetch('/api/download?token=' + encodeURIComponent(token), { method: 'POST', headers: H, body: JSON.stringify({ url }) })
    const d = await r.json()
    document.getElementById('msg').textContent = d.ok ? '已提交到下载队列' : ('失败：' + (d.error || ''))
    if (d.ok) { document.getElementById('url').value = ''; refresh() }
  } catch (e) { document.getElementById('msg').textContent = '无法连接桌面端' }
})
refresh()
setInterval(refresh, 5000)
</script></body></html>`
}

/** 应用启动时调用（manager 就绪后）；重复调用安全 */
export function startBridge(manager: TaskManager): void {
  if (server) return
  let token = getSettingParsed<string>('bridge.token')
  if (typeof token !== 'string' || !/^[a-f0-9]{32}$/.test(token)) {
    token = randomUUID().replace(/-/g, '')
    setSetting('bridge.token', JSON.stringify(token))
  }
  void (async () => {
    const port = await probePort(16820)
    server = http.createServer((req, res) => {
      void handle(req, res, manager, token, port).catch((err) => {
        log.warn('bridge request failed', err)
        try {
          json(res, 500, { ok: false, error: 'internal error' })
        } catch {
          // 已响应
        }
      })
    })
    server.on('error', (err) => log.warn('bridge server error', err))
    server.listen(port, '127.0.0.1', () => {
      info = { port, token, running: true }
      log.info(`bridge listening at http://127.0.0.1:${port} (token auth, loopback only)`)
    })
  })()
}

export function getBridgeInfo(): { port: number; token: string; running: boolean } {
  return { ...info }
}
