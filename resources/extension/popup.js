const els = Object.fromEntries(
  ['port', 'token', 'intercept', 'save', 'ping', 'status'].map((id) => [id, document.getElementById(id)])
)

chrome.storage.local.get(['port', 'token', 'intercept']).then((c) => {
  els.port.value = c.port ?? 16820
  els.token.value = c.token ?? ''
  els.intercept.checked = !!c.intercept
})

els.save.addEventListener('click', () => {
  chrome.storage.local.set({
    port: Number(els.port.value) || 16820,
    token: els.token.value.trim(),
    intercept: els.intercept.checked
  })
  els.status.textContent = '已保存'
  els.status.className = 'ok'
})

els.ping.addEventListener('click', async () => {
  chrome.storage.local.set({
    port: Number(els.port.value) || 16820,
    token: els.token.value.trim(),
    intercept: els.intercept.checked
  })
  els.status.textContent = '连接中…'
  els.status.className = ''
  chrome.runtime.sendMessage({ type: 'ping' }, (r) => {
    if (r?.ok) {
      els.status.textContent = `已连接 OmniGet v${r.version}`
      els.status.className = 'ok'
    } else {
      els.status.textContent = '连接失败：请确认 OmniGet 已启动、端口/令牌正确'
      els.status.className = 'bad'
    }
  })
})
