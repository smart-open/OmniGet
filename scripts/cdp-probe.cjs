// CDP 主题诊断：连接 dev 渲染进程，检查各 data-theme 的 CSS 规则与变量解析
const WebSocket = require('ws')
const http = require('http')

function getTargets() {
  return new Promise((resolve, reject) => {
    http
      .get('http://127.0.0.1:9222/json/list', (res) => {
        let d = ''
        res.on('data', (c) => (d += c))
        res.on('end', () => resolve(JSON.parse(d)))
      })
      .on('error', reject)
  })
}

async function main() {
  const targets = await getTargets()
  const page = targets.find((t) => t.type === 'page' && /localhost|127\.0\.0\.1/.test(t.url))
  if (!page) {
    console.log('NO_PAGE', targets.map((t) => `${t.type}:${t.url}`).join(' | '))
    return
  }
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  let id = 0
  const pending = new Map()
  const send = (method, params) =>
    new Promise((res) => {
      const mid = ++id
      pending.set(mid, res)
      ws.send(JSON.stringify({ id: mid, method, params }))
    })
  ws.on('message', (raw) => {
    const m = JSON.parse(raw)
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m.result)
      pending.delete(m.id)
    }
  })
  await new Promise((r) => ws.on('open', r))

  const expr = `(async () => {
    const out = { theme: document.documentElement.dataset.theme }
    // 收集所有样式表中含 data-theme 的规则数
    const rules = {}
    for (const sheet of document.styleSheets) {
      let list
      try { list = sheet.cssRules } catch { continue }
      const walk = (rs) => {
        for (const r of rs) {
          if (r.cssRules) walk(r.cssRules)
          const m = r.selectorText && r.selectorText.match(/data-theme=['"]?([a-z]+)/)
          if (m) rules[m[1]] = (rules[m[1]] || 0) + 1
        }
      }
      walk(list)
    }
    out.rules = rules
    // 逐主题试算变量
    out.vars = {}
    for (const t of ['dark', 'oled', 'violet', 'green', 'amber', 'blue', 'light']) {
      document.documentElement.dataset.theme = t
      const cs = getComputedStyle(document.documentElement)
      out.vars[t] = {
        bg: cs.getPropertyValue('--bg').trim(),
        text1: cs.getPropertyValue('--text-1').trim(),
        bodyColor: getComputedStyle(document.body).color
      }
    }
    document.documentElement.dataset.theme = out.theme
    return JSON.stringify(out)
  })()`
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true })
  console.log(r.result?.value ?? JSON.stringify(r))
  ws.close()
  process.exit(0)
}

main().catch((e) => {
  console.error('ERR', e.message)
  process.exit(1)
})
