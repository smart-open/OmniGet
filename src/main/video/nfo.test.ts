// 第十轮审查（0.11.2）：NFO 构建回归——XML 声明合法性此前无测试覆盖，
// P1（声明行缺 `>` 导致产物全部非法 XML）由本文件锁定
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildMovieNfo, escapeXml } from './nfo'

test('NFO 声明行以 ?> 终止（P1 回归锁：缺 > 时 Jellyfin/Emby 解析必失败）', () => {
  const xml = buildMovieNfo({ title: '测试视频', platform: 'bilibili', durationSec: 123.4 })
  const first = xml.split('\n')[0] ?? ''
  assert.ok(first.startsWith('<?xml '), '应为 XML 声明')
  assert.ok(first.endsWith('?>'), `声明行必须以 ?> 终止，实际：${first}`)
  assert.ok(xml.includes('<movie>'), '根元素存在')
})

test('NFO：duration 输出 fileinfo；无 duration 不输出', () => {
  const withDur = buildMovieNfo({ title: 'a', durationSec: 61 })
  assert.ok(withDur.includes('<duration>61</duration>'))
  const noDur = buildMovieNfo({ title: 'a' })
  assert.ok(!noDur.includes('<fileinfo>'))
})

test('NFO：标题特殊字符转义', () => {
  const xml = buildMovieNfo({ title: 'a<b>&"\'c' })
  assert.ok(xml.includes('<title>a&lt;b&gt;&amp;&quot;&apos;c</title>'))
  assert.equal(escapeXml('<&>'), '&lt;&amp;&gt;')
})

test('NFO：date 提供时按该日期生成 year/premiered（第十轮：归档日期取下载时刻）', () => {
  const xml = buildMovieNfo({ title: 'a', date: new Date('2026-03-05T00:00:00Z').getTime() })
  assert.ok(xml.includes('<premiered>2026-03-05</premiered>'))
})
