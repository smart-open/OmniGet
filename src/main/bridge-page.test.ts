// Web 面板页面回归（四期遗留「移动端提交」批次）：页面为字符串模板，离线可测。
// 锁定移动优先改造的关键面：视口/主题色 meta、卡片布局（取代桌面表格）、
// 分页加载、剪贴板粘贴降级、token 剥离、删除确认与操作反馈（UX 硬性标准）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { renderPage } from './bridge-page'

const html = renderPage(16820)

test('移动端视口与主题色 meta（viewport-fit + theme-color）', () => {
  assert.ok(html.includes('name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"'))
  assert.ok(html.includes('name="theme-color" content="#0B0C0E"'))
})

test('卡片布局取代桌面表格（窄屏不横向溢出）', () => {
  assert.ok(!/<table/i.test(html))
  assert.ok(html.includes("'<div class=\"card\">'"))
})

test('分页加载（offset/limit 下推既有端点能力）', () => {
  assert.ok(html.includes('加载更多'))
  assert.ok(html.includes("offset: String(off)"))
  assert.ok(html.includes("limit: String(limit)"))
})

test('分页封顶 500（审查修复：offset 超服务端 limit 硬顶后窗口错位/区间空洞）', () => {
  // 服务端 /api/tasks limit = Math.min(500, …)；分页总量必须同步封顶
  assert.ok(html.includes('MAX_TASKS = 500'))
  // poll 重取窗口同步钳顶（此前 Math.max(offset, PAGE) 可超 500 被服务端截断）
  assert.ok(html.includes('Math.min(Math.max(offset, PAGE), MAX_TASKS)'))
  // more() 到顶短路 + offset 推进钳顶（防 DOM 缩水与计数虚报）
  assert.ok(html.includes('if (offset >= MAX_TASKS) return'))
  assert.ok(html.includes('offset = Math.min(MAX_TASKS, offset + rows.length)'))
  // 到顶提示缩小过滤范围（不静默隐藏）
  assert.ok(html.includes('达上限，请用上方过滤缩小范围'))
})

test('剪贴板粘贴按钮带安全上下文降级（LAN 明文 HTTP 下隐藏）', () => {
  assert.ok(html.includes('window.isSecureContext && navigator.clipboard && navigator.clipboard.readText'))
  assert.ok(html.includes("pb.hidden = false"))
})

test('页面不可见时暂停轮询（手机省电省流）', () => {
  assert.ok(html.includes("document.visibilityState === 'hidden'"))
  assert.ok(html.includes("document.addEventListener('visibilitychange'"))
})

test('安全口径不变：token 剥离 / 删除 confirm / 操作反馈 #msg', () => {
  assert.ok(html.includes('history.replaceState(null, \'\', location.pathname)'))
  assert.ok(html.includes("confirm('确认移除该任务？（文件保留，可进回收站找回）')"))
  assert.ok(html.includes("$('msg').textContent"))
})

test('端点与端口注入不变', () => {
  assert.ok(html.includes('/api/download'))
  assert.ok(html.includes('/api/tasks'))
  assert.ok(html.includes('/api/stats'))
  assert.ok(html.includes('/api/task/'))
  assert.ok(html.includes(':16820'))
})

test('客户端脚本无模板插值残留（${ 不出现在脚本区，防注入面）', () => {
  const scriptStart = html.indexOf('<script>')
  assert.ok(scriptStart > 0)
  assert.ok(!html.slice(scriptStart).includes('${'))
})
