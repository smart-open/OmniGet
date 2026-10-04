import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectLiveRoom, streamHeadersFor } from './rooms'

test('三期（backlog #25）：四平台直播间 URL 识别', () => {
  const cases: Array<[string, string, string]> = [
    ['https://live.bilibili.com/21452505', 'bilibili', '21452505'],
    ['https://www.douyu.com/999911', 'douyu', '999911'],
    ['https://www.huya.com/660132', 'huya', '660132'],
    ['https://live.douyin.com/745961234', 'douyin', '745961234'],
    // 自定义直播间字母段（虎牙部分主播）
    ['https://www.huya.com/dongdongxiang', 'huya', 'dongdongxiang']
  ]
  for (const [url, platform, roomId] of cases) {
    const r = detectLiveRoom(url)
    assert.ok(r, `应识别：${url}`)
    assert.equal(r.platform, platform)
    assert.equal(r.roomId, roomId)
  }
})

test('三期：非直播间 URL / 伪房间段排除', () => {
  // 首页无房间段
  assert.equal(detectLiveRoom('https://live.bilibili.com/'), null)
  // 功能页伪房间段
  assert.equal(detectLiveRoom('https://www.douyu.com/topic/riyao'), null)
  assert.equal(detectLiveRoom('https://www.douyu.com/directory/myFollow'), null)
  // 非 http(s)
  assert.equal(detectLiveRoom('magnet:?xt=urn:btih:abc'), null)
  assert.equal(detectLiveRoom('D:\\live\\room'), null)
  // 解析失败的输入
  assert.equal(detectLiveRoom(''), null)
  // 普通视频页（非直播 host）
  assert.equal(detectLiveRoom('https://www.bilibili.com/video/BV1xx'), null)
})

test('三期：取流请求头按平台注入（B站/抖音校验 Referer）', () => {
  assert.ok(streamHeadersFor('bilibili').some((h) => h.name === 'Referer' && h.value.includes('live.bilibili.com')))
  assert.ok(streamHeadersFor('douyin').some((h) => h.name === 'Referer'))
  assert.deepEqual(streamHeadersFor('unknown'), [])
})
