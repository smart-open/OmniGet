// CDP：打开侧栏主题弹层 + 截图
const WebSocket = require('ws')
const http = require('http')
const fs = require('fs')

const out = process.argv[2] ?? 'shot-theme-menu.png'

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
  const page = targets.find((t) => t.type === 'page')
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
  // 主题按钮：aside 底部组里第三个（统计/快捷键/主题/设置）——按图标按钮顺序取，含 aria-label 的才是图标按钮
  const click = `(function(){
    const aside = document.querySelector('aside')
    const btns = [...aside.querySelectorAll('button')]
    const themeBtn = btns.find((b) => b.getAttribute('aria-label') === '主题' || /随系统|石墨灰|曜石黑|暗夜紫|青墨绿|琥珀橙|科技蓝/.test(b.textContent))
    if (!themeBtn) return 'BTN_NOT_FOUND: ' + btns.map(b => b.textContent.trim()).join(',')
    themeBtn.click()
    return 'CLICKED'
  })()`
  const r = await send('Runtime.evaluate', { expression: click })
  console.log('click:', r.result?.value)
  await new Promise((res) => setTimeout(res, 500))
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'))
  console.log('SAVED', out)
  ws.close()
  process.exit(0)
}

main().catch((e) => {
  console.error('ERR', e.message)
  process.exit(1)
})
