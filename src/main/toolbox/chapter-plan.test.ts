// 四期（0.11.x）：音频章节标记纯函数回归（时间轴文本解析 + FFMETADATA 构建）

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildFfmetadata, escapeFfmetadata, parseChapterText } from './chapter-plan'

test('章节解析：时:分:秒 / 分:秒 / 方括号 / 分隔符变体', () => {
  const text = [
    '# 注释行跳过',
    '00:01:23 第二章 出发',
    '00:00:00 序章',
    '05:30 - 只有分秒',
    '[00:05:00] 方括号时间戳',
    '2:03:45|竖线分隔'
  ].join('\n')
  const ch = parseChapterText(text)
  assert.deepEqual(
    ch.map((c) => [c.startMs, c.title]),
    [
      [0, '序章'],
      [83_000, '第二章 出发'],
      [300_000, '方括号时间戳'],
      [330_000, '只有分秒'],
      [2 * 3600_000 + 3 * 60_000 + 45_000, '竖线分隔']
    ]
  )
})

test('章节解析：1:23 = 1分23秒 = 83 秒（无小时段两段式）', () => {
  const ch = parseChapterText('01:23 - 只有分秒')
  assert.equal(ch.length, 1)
  assert.equal(ch[0]!.startMs, 83_000)
  assert.equal(ch[0]!.title, '只有分秒')
})

test('章节解析：无标题行默认命名 + 排序去同起点 + 分秒越界跳过', () => {
  const text = ['00:02:00 第二', '00:01:00', '00:01:00 重复起点', '75:90 非法', '不是时间轴'].join('\n')
  const ch = parseChapterText(text)
  assert.deepEqual(
    ch.map((c) => [c.startMs, c.title]),
    [
      [60_000, '章节 1'],
      [120_000, '第二']
    ]
  )
})

test('章节解析：上限 500 条', () => {
  const lines = Array.from({ length: 600 }, (_, i) => `${String(Math.floor(i / 3600)).padStart(2, '0')}:${String(Math.floor((i % 3600) / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')} 章${i}`)
  assert.equal(parseChapterText(lines.join('\n')).length, 500)
})

test('FFMETADATA 转义：\\ ; # = 与换行', () => {
  assert.equal(escapeFfmetadata('a\\b;c#d=e\nf'), 'a\\\\b\\;c\\#d\\=e\\nf')
})

test('FFMETADATA 构建：TIMEBASE/START/END 链 + 末章 END 取 totalMs + 标题转义', () => {
  const md = buildFfmetadata(
    [
      { startMs: 0, title: '序;章' },
      { startMs: 60_000, title: '第二' }
    ],
    180_000
  )
  assert.ok(md.startsWith(';FFMETADATA1\n'))
  assert.ok(md.includes('[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=60000\ntitle=序\\;章'))
  assert.ok(md.includes('[CHAPTER]\nTIMEBASE=1/1000\nSTART=60000\nEND=180000\ntitle=第二'))
})

test('FFMETADATA 构建：无总时长时末章 END = 起点 + 1h', () => {
  const md = buildFfmetadata([{ startMs: 30_000, title: '章' }], null)
  assert.ok(md.includes('START=30000'), md)
  assert.ok(md.includes('END=3630000'), md)
})
