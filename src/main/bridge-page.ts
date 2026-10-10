// Web 面板页面渲染（自 bridge.ts 抽出，零 electron 依赖——可离线单测）
// 四期遗留「移动端提交」：面板页移动优先重写（Gopeed 范式）——
// - 表格改卡片列表（窄屏不再横向溢出，触控目标 ≥36px）
// - viewport-fit=cover + theme-color + 16px 输入字号（防 iOS 聚焦缩放）
// - 剪贴板粘贴按钮（isSecureContext 特性检测：LAN 明文 HTTP 下自动隐藏，降级手输）
// - 分页「加载更多」（/api/tasks offset/limit 既有能力，移动端长列表友好）
// - 页面不可见时暂停轮询（手机省电省流）
// 安全口径不变：token 页面 bootstrap 后立即剥离、删除仍 confirm、操作反馈走 #msg

/** 面板单页 HTML（服务端注入端口；脚本内禁用模板插值防注入面） */
export function renderPage(port: number): string {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="theme-color" content="#0B0C0E"><title>OmniGet 远程</title>
<style>
:root{color-scheme:dark}
*{-webkit-tap-highlight-color:transparent}
body{font-family:system-ui,sans-serif;background:#0B0C0E;color:#E7E9EC;margin:0;padding:16px 16px calc(16px + env(safe-area-inset-bottom));max-width:760px;box-sizing:content-box;margin-inline:auto}
h1{font-size:15px;margin:0 0 14px}
h1 .muted{font-size:12px}
input,button{font:inherit}
.row{display:flex;gap:8px;margin-bottom:10px}
input[type=text],input[type=search]{flex:1;min-width:0;background:#15171A;border:1px solid #2A2D33;border-radius:10px;color:inherit;padding:10px 12px;font-size:16px}
button{background:#3B6EFF;color:#fff;border:0;border-radius:10px;padding:10px 18px;font-size:14px;cursor:pointer;min-height:40px}
button.mini{background:#1E2126;color:#E7E9EC;padding:8px 14px;font-size:12px;border-radius:8px;min-height:36px}
button.mini.danger{color:#E5615C}
#summary{display:flex;gap:14px;font-size:12px;margin-bottom:12px;flex-wrap:wrap}
#summary b{color:#3B6EFF}
.muted{color:#8B9096}
.card{background:#121417;border:1px solid #1E2126;border-radius:12px;padding:10px 12px;margin-bottom:8px}
.card .top{display:flex;justify-content:space-between;align-items:baseline;gap:10px}
.card .name{font-size:13px;word-break:break-all;min-width:0}
.card .st{font-size:11px;flex-shrink:0}
.st-running{color:#3B6EFF}.st-completed{color:#4CAF7D}.st-failed{color:#E5615C}.st-paused{color:#E8B34B}
.bar{height:5px;background:#1E2126;border-radius:3px;overflow:hidden;margin:7px 0 5px}
.bar>div{height:100%;background:#3B6EFF}
.card .meta{display:flex;justify-content:space-between;gap:10px;font-size:11px;color:#8B9096}
.acts{display:flex;gap:6px;margin-top:8px;flex-wrap:wrap}
.grp{display:inline-block;font-size:10px;color:#8B9096;border:1px solid #2A2D33;border-radius:4px;padding:0 5px;margin-left:6px}
#more{width:100%;margin:4px 0 8px}
@media (min-width:640px){body{padding-top:24px}h1{font-size:16px}}
</style></head><body>
<h1>OmniGet 远程任务面板 <span class="muted">:${port}</span></h1>
<form class="row" id="f">
  <input type="text" id="url" placeholder="粘贴磁力 / 视频链接 / 音乐名 / 直链，提交到桌面端下载" />
  <button type="button" id="paste" class="mini" hidden>粘贴</button>
  <button type="submit">下载</button>
</form>
<div class="row"><input type="search" id="q" placeholder="按名称/链接过滤任务…" /></div>
<div id="summary" class="muted"></div>
<div id="msg" class="muted" style="font-size:12px;margin-bottom:12px"></div>
<div id="rows"></div>
<button id="more" class="mini" hidden>加载更多</button>
<script>
const token = new URLSearchParams(location.search).get('token')
// M-3：立即剥离 URL 中的 token（replaceState 替换当前历史条目，token 不进历史/后续 Referer）
try { history.replaceState(null, '', location.pathname) } catch {}
const H = { 'x-omniget-token': token, 'content-type': 'application/json' }
const PAGE = 50
// 审查修复（0.13.1）：服务端 /api/tasks limit 硬顶 500（Math.min(500, …)）。此前
// 「加载更多」无封顶——offset 超过 500 后，5s 轮询重取窗口（服务端钳到 500 条）整页
// 替换渲染，DOM 缩水到 500 条但 offset 状态不变 → 计数虚报 + 再点「加载更多」
// 产生 501..offset 区间空洞。分页总量同步封顶到 500，超出提示用过滤缩小范围
const MAX_TASKS = 500
let offset = 0
let total = 0
let qTimer = null
function $(id) { return document.getElementById(id) }
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
function setMsg(t) { $('msg').textContent = t }
function btn(a, label, danger, id) {
  return '<button class="mini' + (danger ? ' danger' : '') + '" data-a="' + a + '" data-id="' + esc(id) + '">' + label + '</button>'
}
function taskCard(t) {
  const p = t.progress || 0
  const canPause = t.status === 'running' || t.status === 'queued'
  const canResume = t.status === 'paused'
  const canRetry = t.status === 'failed'
  const canRemove = t.status !== 'removed'
  let acts = ''
  if (canPause) acts += btn('pause', '暂停', false, t.id)
  if (canResume) acts += btn('resume', '继续', false, t.id)
  if (canRetry) acts += btn('retry', '重试', false, t.id)
  if (canRemove) acts += btn('remove', '移除', true, t.id)
  return '<div class="card">'
    + '<div class="top"><span class="name">' + esc(t.name) + (t.queueGroup ? '<span class="grp">' + esc(t.queueGroup) + '</span>' : '') + '</span>'
    + '<span class="st st-' + esc(t.status) + '">' + esc(t.status) + '</span></div>'
    + '<div class="bar"><div style="width:' + p + '%"></div></div>'
    + '<div class="meta"><span>' + p + '%' + (t.totalBytes > 0 ? ' · ' + esc(fmtSize(t.totalBytes)) : '') + '</span>'
    + '<span>' + esc(fmtBps(t.speedBps)) + '</span></div>'
    + (acts ? '<div class="acts">' + acts + '</div>' : '')
    + '</div>'
}
function renderRows(tasks, append) {
  const html = tasks.map(taskCard).join('')
  if (append) $('rows').insertAdjacentHTML('beforeend', html)
  else $('rows').innerHTML = html
}
function updateMore() {
  const b = $('more')
  const capped = offset >= MAX_TASKS
  b.hidden = offset >= total || capped
  b.textContent = capped
    ? '已加载 ' + MAX_TASKS + ' / ' + total + '（达上限，请用上方过滤缩小范围）'
    : '加载更多（已载 ' + offset + ' / ' + total + '）'
}
function fetchTasks(off, limit) {
  const qs = new URLSearchParams({ q: $('q').value.trim(), limit: String(limit), offset: String(off) })
  return fetch('/api/tasks?' + qs.toString(), { headers: H }).then((r) => r.json())
}
// 全量刷新当前已载窗口（从 0 重取 offset+PAGE 条替换渲染；offset 仅由「加载更多」推进）
async function poll() {
  if (document.visibilityState === 'hidden') return
  try {
    const [d, sr] = await Promise.all([
      fetchTasks(0, Math.min(Math.max(offset, PAGE), MAX_TASKS)),
      fetch('/api/stats', { headers: H })
    ])
    const st = await sr.json()
    total = d.total || 0
    $('summary').innerHTML = st.ok
      ? '<span>↓ <b>' + (esc(fmtBps(st.downBps)) || '0') + '</b></span>'
        + '<span>运行 ' + esc(st.running) + '</span><span>排队 ' + esc(st.queued) + '</span>'
        + '<span>完成 ' + esc(st.counts.completed) + '</span><span>失败 ' + esc(st.counts.failed) + '</span>'
      : ''
    renderRows(d.tasks || [], false)
    updateMore()
  } catch (e) { setMsg('无法连接桌面端') }
}
async function more() {
  if (offset >= MAX_TASKS) return
  try {
    const d = await fetchTasks(offset, PAGE)
    const rows = d.tasks || []
    offset = Math.min(MAX_TASKS, offset + rows.length)
    total = d.total || total
    renderRows(rows, true)
    updateMore()
  } catch (e) { setMsg('无法连接桌面端') }
}
async function act(id, action, needConfirm) {
  if (needConfirm && !confirm('确认移除该任务？（文件保留，可进回收站找回）')) return
  try {
    const r = await fetch('/api/task/' + encodeURIComponent(id) + '/' + action, { method: 'POST', headers: H })
    const d = await r.json()
    setMsg(d.ok ? '操作成功' : '失败：' + (d.error || ''))
  } catch (e) { setMsg('无法连接桌面端') }
  poll()
}
$('more').addEventListener('click', more)
document.body.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-a]')
  if (b) act(b.dataset.id, b.dataset.a, b.dataset.a === 'remove')
})
$('f').addEventListener('submit', async (e) => {
  e.preventDefault()
  const url = $('url').value.trim()
  if (!url) return
  try {
    const r = await fetch('/api/download', { method: 'POST', headers: H, body: JSON.stringify({ url }) })
    const d = await r.json()
    setMsg(d.ok ? '已提交到下载队列' : '失败：' + (d.error || ''))
    if (d.ok) { $('url').value = ''; offset = 0; poll() }
  } catch (e) { setMsg('无法连接桌面端') }
})
$('q').addEventListener('input', () => {
  clearTimeout(qTimer); qTimer = setTimeout(() => { offset = 0; poll() }, 350)
})
// 剪贴板粘贴按钮：仅安全上下文（localhost / HTTPS）可见；LAN 明文 HTTP 下浏览器会拒绝 readText，隐藏降级为长按手输
if (window.isSecureContext && navigator.clipboard && navigator.clipboard.readText) {
  const pb = $('paste')
  pb.hidden = false
  pb.addEventListener('click', async () => {
    try {
      const t = await navigator.clipboard.readText()
      if (t && t.trim()) { $('url').value = t.trim(); $('url').focus() }
      else setMsg('剪贴板为空')
    } catch (e) { setMsg('读取剪贴板失败（浏览器未授权）') }
  })
}
// 手机切后台时暂停轮询（省电省流），回前台立即补一次
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') poll() })
poll()
setInterval(poll, 5000)
</script></body></html>`
}
