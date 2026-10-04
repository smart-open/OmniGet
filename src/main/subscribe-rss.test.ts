import { test } from 'node:test'
import assert from 'node:assert/strict'
import { filterEntries, parseFeed, parseKeywords } from './subscribe-rss'

const RSS = `<?xml version="1.0"?>
<rss version="2.0"><channel>
<item>
  <title>第一集：启程</title>
  <enclosure url="https://cdn.example.com/ep1.mp4" type="video/mp4" length="1048576"/>
</item>
<item>
  <title>第二集</title>
  <link>https://example.com/ep2</link>
</item>
<item>
  <title><![CDATA[第三集 & 中文]]></title>
  <link>https://example.com/ep3</link>
</item>
<item><title>无链接条目</title><description>空</description></item>
</channel></rss>`

const ATOM = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:yt="http://www.youtube.com/xml/schemas/2015">
<entry>
  <yt:videoId>dQw4w9WgXcQ</yt:videoId>
  <title>YouTube 条目</title>
  <link rel="alternate" href="https://www.youtube.com/watch?v=should-not-win"/>
</entry>
</feed>`

test('三期（backlog #18）：RSS 解析（enclosure 优先 / 实体解码）', () => {
  const items = parseFeed(RSS)
  // 无链接条目被丢弃
  assert.equal(items.length, 3)
  assert.equal(items[0]!.url, 'https://cdn.example.com/ep1.mp4')
  assert.equal(items[0]!.title, '第一集：启程')
  assert.equal(items[1]!.url, 'https://example.com/ep2')
  assert.equal(items[2]!.title, '第三集 & 中文')
})

test('三期：Atom 解析（yt:videoId → YouTube watch URL）', () => {
  const items = parseFeed(ATOM)
  assert.equal(items.length, 1)
  assert.equal(items[0]!.url, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ')
})

test('三期：关键词解析（多分隔符 / 去空 / 上限）', () => {
  assert.deepEqual(parseKeywords('动画, 科幻、纪录片'), ['动画', '科幻', '纪录片'])
  assert.deepEqual(parseKeywords('  '), [])
  assert.deepEqual(parseKeywords(null), [])
})

test('三期：条目过滤（时长下限 + 关键词任一命中）', () => {
  const entries = [
    { url: 'a', title: '长视频', durationSec: 3600 },
    { url: 'b', title: '短片', durationSec: 60 },
    { url: 'c', title: '无时长信息（RSS）', durationSec: null },
    { url: 'd', title: '动画正片 01', durationSec: 1400 }
  ]
  // 时长下限：≥300 保留（无时长信息视为通过）
  assert.deepEqual(
    filterEntries(entries, { filterMinSec: 300 }).map((e) => e.url),
    ['a', 'c', 'd']
  )
  // 关键词：任一命中
  assert.deepEqual(
    filterEntries(entries, { filterKeywords: '动画, 电影' }).map((e) => e.url),
    ['d']
  )
  // 组合：时长 AND 关键词
  assert.deepEqual(
    filterEntries(entries, { filterMinSec: 300, filterKeywords: '动画' }).map((e) => e.url),
    ['d']
  )
  // 无过滤条件全保留
  assert.equal(filterEntries(entries, {}).length, 4)
})
