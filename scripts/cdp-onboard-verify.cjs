// CDP：向导原子验证（重置→重载→步进→断言→截图）
const WebSocket = require('ws')
const http = require('http')
const fs = require('fs')

const out = process.argv[2] ?? 'shot-onboard-final.png'

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
  const evalJs = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true })
    return r.result?.value
  }
  await new Promise((r) => ws.on('open', r))

  await evalJs(`window.omniget.settingsSet('onboarded', false).then(()=>'ok')`)
  await new Promise((r) => setTimeout(r, 900))
  await send('Page.reload', {})
  await new Promise((r) => setTimeout(r, 3200))

  const step0 = await evalJs(
    `({wizard: document.body.textContent.includes('下载目录'), next: [...document.querySelectorAll('button')].some(b=>b.textContent.includes('下一步'))})`
  )
  console.log('step0:', JSON.stringify(step0))

  await evalJs(
    `[...document.querySelectorAll('button')].find(b=>b.textContent.includes('下一步'))?.click()`
  )
  await new Promise((r) => setTimeout(r, 600))

  const step1 = await evalJs(
    `({
      title: document.body.textContent.includes('选择外观'),
      themes: ['随系统','石墨灰','曜石黑','暗夜紫','青墨绿','琥珀橙','科技蓝'].filter(t=>document.body.textContent.includes(t)),
      swatches: document.querySelectorAll('span.rounded-full.border-2').length
    })`
  )
  console.log('step1:', JSON.stringify(step1))

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
