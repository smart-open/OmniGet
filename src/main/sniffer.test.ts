import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DedupeWindow, sniff } from './sniffer'

test('五类输入各自路由正确（M1-8 验收）', () => {
  assert.equal(sniff('magnet:?xt=urn:btih:dc9e7581')?.type, 'magnet')
  assert.equal(sniff('D:\\downloads\\sample.torrent')?.type, 'bt')
  assert.equal(sniff('https://www.bilibili.com/video/BV1xx')?.type, 'video')
  assert.equal(sniff('https://example.com/file.zip')?.type, 'http')
  assert.equal(sniff('陈奕迅 孤勇者')?.type, 'music')
})

test('短视频分享短链 → video + noWatermark 默认 true（§4.3.1）', () => {
  const r = sniff('https://v.douyin.com/abcdEF/')
  assert.equal(r?.type, 'video')
  assert.equal(r?.platform, 'douyin')
  assert.equal(r?.noWatermark, true)
})

test('B 站普通链接不启用无水印', () => {
  const r = sniff('https://www.bilibili.com/video/BV1xx')
  assert.equal(r?.noWatermark, undefined)
})

test('HLS/DASH 清单链接 → video/hls（backlog #17：走 yt-dlp 而非 aria2）', () => {
  assert.equal(sniff('https://cdn.example.com/live/index.m3u8')?.type, 'video')
  assert.equal(sniff('https://cdn.example.com/live/index.m3u8')?.platform, 'hls')
  assert.equal(sniff('https://cdn.example.com/v/playlist.mpd?token=1')?.platform, 'hls')
  assert.equal(sniff('https://cdn.example.com/v/media.m3u?id=1')?.platform, 'hls')
  // 普通直链不受影响
  assert.equal(sniff('https://example.com/video.mp4')?.platform, 'http')
  // 域名含 .m3u8 但路径为普通页面的误报防御（仅按 pathname 判定）
  assert.equal(sniff('https://example.com/m3u8-player')?.platform, 'http')
})

test('30s 去重窗口：同 key 首次 true、窗口内 false、过期后 true', () => {
  const w = new DedupeWindow(50)
  assert.equal(w.check('magnet:dc9e'), true)
  assert.equal(w.check('magnet:dc9e'), false)
  await_delay(60)
  assert.equal(w.check('magnet:dc9e'), true)
})

function await_delay(ms: number): void {
  const start = Date.now()
  while (Date.now() - start < ms) {
    // busy wait（测试内同步延迟）
  }
}
