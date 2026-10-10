// HLS 清单解析单测（backlog #17 第二阶段）

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { escapeRegex, parseHlsManifest, splitHlsAttrs } from './nm3u8-parse'

const MASTER = [
  '#EXTM3U',
  '#EXT-X-STREAM-INF:BANDWIDTH=1280000,RESOLUTION=640x360,CODECS="avc1.64001f,mp4a.40.2"',
  'video-360p/playlist.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=4128000,RESOLUTION=1920x1080,NAME="1080p"',
  'video-1080p/playlist.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=2560000,RESOLUTION=1280x720',
  'video-720p/playlist.m3u8'
].join('\n')

test('master 清单：变体数/分辨率/码率解析，CODECS 引号内逗号不切断', () => {
  const info = parseHlsManifest(MASTER)
  assert.equal(info.kind, 'master')
  assert.equal(info.variants.length, 3)
  assert.equal(info.variants[0]?.resolution, '640x360')
  assert.equal(info.variants[0]?.bandwidth, 1280000)
  assert.equal(info.variants[1]?.name, '1080p')
  assert.equal(info.variants[1]?.uri, 'video-1080p/playlist.m3u8')
})

test('media 清单：kind=media，EXTINF 时长合计', () => {
  const media = [
    '#EXTM3U',
    '#EXT-X-TARGETDURATION:10',
    '#EXTINF:9.5,',
    'seg-1.ts',
    '#EXTINF:10.5,',
    'seg-2.ts',
    '#EXT-X-ENDLIST'
  ].join('\n')
  const info = parseHlsManifest(media)
  assert.equal(info.kind, 'media')
  assert.equal(info.variants.length, 0)
  assert.equal(info.durationSec, 20)
})

test('直播流（media 无 ENDLIST）→ kind=media（上层判 live）', () => {
  const live = [
    '#EXTM3U',
    '#EXT-X-TARGETDURATION:6',
    '#EXTINF:6.0,',
    'live-1.ts',
    '#EXTINF:6.0,',
    'live-2.ts'
  ].join('\n')
  const info = parseHlsManifest(live)
  assert.equal(info.kind, 'media')
  // 直播判定：media + 无 #EXT-X-ENDLIST（nm3u8 适配器口径）
  assert.ok(!/#EXT-X-ENDLIST/i.test(live))
})

test('MPD（DASH）识别为 mpd，不做深度解析', () => {
  const info = parseHlsManifest('<?xml version="1.0"?><MPD xmlns="urn:mpeg:dash"><Period/></MPD>')
  assert.equal(info.kind, 'mpd')
  assert.equal(info.variants.length, 0)
})

test('空/垃圾文本 → unknown', () => {
  assert.equal(parseHlsManifest('').kind, 'unknown')
  assert.equal(parseHlsManifest('hello world').kind, 'unknown')
})

test('splitHlsAttrs：引号感知 + 键大写归一', () => {
  const attrs = splitHlsAttrs('BANDWIDTH=1000,CODECS="a,b,c",NAME="720p 高清"')
  assert.equal(attrs.BANDWIDTH, '1000')
  assert.equal(attrs.CODECS, 'a,b,c')
  assert.equal(attrs.NAME, '720p 高清')
})

test('escapeRegex：变体 URI 中的正则元字符被转义（url= 选择器安全）', () => {
  assert.equal(escapeRegex('v/1080p.m3u8?a=1&b=2'), 'v/1080p\\.m3u8\\?a=1&b=2')
})

// ── backlog #17 增强（2026-10-09）：SUBTITLES 字幕轨解析 ─────────────────

test('master 清单：SUBTITLES 字幕轨解析（GROUP-ID/NAME/LANGUAGE），AUDIO 轨不误收', () => {
  const master = [
    '#EXTM3U',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="en",DEFAULT=YES',
    '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs-en",NAME="English",LANGUAGE="en",DEFAULT=YES,URI="subs/en/playlist.m3u8"',
    '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs-zh",NAME="简体中文",LANGUAGE="zh-Hans"',
    '#EXT-X-STREAM-INF:BANDWIDTH=4128000,RESOLUTION=1920x1080,SUBTITLES="subs-en"',
    'video-1080p/playlist.m3u8'
  ].join('\n')
  const info = parseHlsManifest(master)
  assert.equal(info.kind, 'master')
  assert.equal(info.variants.length, 1) // MEDIA 行不得误产变体
  assert.equal(info.subtitles.length, 2)
  assert.equal(info.subtitles[0]?.groupId, 'subs-en')
  assert.equal(info.subtitles[0]?.name, 'English')
  assert.equal(info.subtitles[0]?.language, 'en')
  assert.equal(info.subtitles[1]?.groupId, 'subs-zh')
  assert.equal(info.subtitles[1]?.language, 'zh-Hans')
})

test('MEDIA 行插在 STREAM-INF 与 URI 行之间：不清 pending，变体不丢', () => {
  const master = [
    '#EXTM3U',
    '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="简体中文"',
    '#EXT-X-STREAM-INF:BANDWIDTH=1280000,RESOLUTION=640x360',
    '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="简体中文"',
    'video-360p/playlist.m3u8'
  ].join('\n')
  const info = parseHlsManifest(master)
  assert.equal(info.kind, 'master')
  assert.equal(info.variants.length, 1)
  assert.equal(info.variants[0]?.uri, 'video-360p/playlist.m3u8')
  assert.equal(info.subtitles.length, 2)
})

test('media/unknown 清单：subtitles 恒为数组（空），无 SUBTITLES 行不报错', () => {
  const media = parseHlsManifest(
    ['#EXTM3U', '#EXTINF:9.5,', 'seg-1.ts', '#EXT-X-ENDLIST'].join('\n')
  )
  assert.deepEqual(media.subtitles, [])
  assert.deepEqual(parseHlsManifest('hello world').subtitles, [])
})
