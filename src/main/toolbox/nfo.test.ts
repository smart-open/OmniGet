// 四期（0.11.x）：NFO 构建（Jellyfin/Emby movie 方言）纯函数回归

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildMovieNfo, escapeXml } from '../video/nfo'

test('XML 转义：& < > " \'', () => {
  assert.equal(escapeXml(`a&<>"'b`), 'a&amp;&lt;&gt;&quot;&apos;b')
})

test('NFO：标题/来源/年份/时长齐全', () => {
  const xml = buildMovieNfo({
    title: '我的视频 <2026>',
    platform: 'bilibili',
    durationSec: 123.4,
    date: new Date('2026-10-04T00:00:00Z').getTime()
  })
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8" standalone="yes"?'))
  assert.ok(xml.includes('<title>我的视频 &lt;2026&gt;</title>'))
  assert.ok(xml.includes('<studio>bilibili</studio>'))
  assert.ok(xml.includes('<year>2026</year>'))
  assert.ok(xml.includes('<premiered>2026-10-04</premiered>'))
  assert.ok(xml.includes('<duration>123</duration>'))
  assert.ok(xml.trimEnd().endsWith('</movie>'))
})

test('NFO：缺省来源与时长时省略对应字段', () => {
  const xml = buildMovieNfo({ title: 'x' })
  assert.ok(!xml.includes('<studio>'))
  assert.ok(!xml.includes('<fileinfo>'))
})
