// OmniGet 浏览器扩展 background（MV3 service worker）
// - 右键菜单「用 OmniGet 下载链接」
// - 可选：自动拦截浏览器下载并转发到 OmniGet（popup 开关）
// - 桥接端点：http://127.0.0.1:<port>，token 见 OmniGet 设置 → 远程/扩展

const DEFAULTS = { port: 16820, token: '', intercept: false }

async function cfg() {
  const stored = await chrome.storage.local.get(['port', 'token', 'intercept'])
  return { ...DEFAULTS, ...stored }
}

async function api(path, body) {
  const c = await cfg()
  const res = await fetch(`http://127.0.0.1:${c.port}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', 'x-omniget-token': c.token },
    body: body ? JSON.stringify(body) : undefined
  })
  return res.json()
}

function flashBadge(text, color) {
  chrome.action.setBadgeText({ text })
  chrome.action.setBadgeBackgroundColor({ color })
  setTimeout(() => chrome.action.setBadgeText({ text: '' }), 1500)
}

async function sendToOmniGet(url) {
  const c = await cfg()
  if (!c.token) {
    flashBadge('!', '#E5615C')
    return
  }
  try {
    const r = await api('/api/download', { url })
    flashBadge(r.ok ? '✓' : '!', r.ok ? '#4CAF7D' : '#E5615C')
  } catch {
    flashBadge('!', '#E5615C')
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'omniget-link',
    title: '用 OmniGet 下载此链接',
    contexts: ['link']
  })
  chrome.contextMenus.create({
    id: 'omniget-page',
    title: '用 OmniGet 下载此页面媒体（视频/音频直链）',
    contexts: ['video', 'audio']
  })
})

chrome.contextMenus.onClicked.addListener((info) => {
  const url = info.menuItemId === 'omniget-link' ? info.linkUrl : info.srcUrl
  if (url) void sendToOmniGet(url)
})

// 可选自动拦截：浏览器新建下载 → 取消并转发到 OmniGet
chrome.downloads.onCreated.addListener((item) => {
  void (async () => {
    const c = await cfg()
    if (!c.intercept || !c.token) return
    if (!/^https?:/i.test(item.url || '')) return // 跳过内部/扩展页下载
    try {
      await chrome.downloads.cancel(item.id)
    } catch {
      // 下载可能已完成，无法取消：仍然提交一份链接（OmniGet 侧有查重/秒校验）
    }
    await sendToOmniGet(item.url)
  })()
})

// popup 消息通道：测试连接
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'ping') {
    api('/api/ping')
      .then((d) => sendResponse({ ok: !!d.ok, version: d.version }))
      .catch(() => sendResponse({ ok: false }))
    return true // 异步 sendResponse
  }
  return false
})
