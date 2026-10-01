// CDP：重置向导标记 → 重载 → 步进 → 截图（诊断首启向导）
// 用法：node scripts/cdp-onboard.cjs <下一步次数，默认1> <输出png>
const WebSocket = require('ws')
const http = require('http')
const fs = require('fs')

const steps = Number(process.argv[2] ?? 1)
const out = process.argv[3] ?? 'shot-onboard.png'

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
  // 1) 重置向导标记（写库留足时间）
  // P2 修复：必须传布尔 false——字符串 'false' 会被双重序列化成真值（AGENT.md 记载的坑），
  // 此前本脚本的重置静默不生效、向导弹不出来
  await send('Runtime.evaluate', {
    expression: "window.omniget.settingsSet('onboarded', false)"
  })
  await new Promise((r) => setTimeout(r, 1000))
  // 2) 重载（App 挂载时读到 false → 弹向导）
  await send('Page.reload', {})
  await new Promise((r) => setTimeout(r, 3000))
  // 3) 步进
  for (let k = 0; k < steps; k++) {
    await send('Runtime.evaluate', {
      expression: `(function(){
        const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('下一步'))
        if (!btn) return 'NO_NEXT'
        btn.click()
        return 'OK'
      })()`
    })
    await new Promise((r) => setTimeout(r, 450))
  }
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
