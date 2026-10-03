// backlog #29（2026-10-03）：MusicBrainz 文件名解析 / 标签映射纯函数回归

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseNameQuery, tagsFromRecording } from './musicbrainz'

test('parseNameQuery：「歌手 - 曲名」双段解析', () => {
  assert.deepEqual(parseNameQuery('陈奕迅 - 孤勇者.mp3'), { artist: '陈奕迅', title: '孤勇者' })
  // 下划线中和为空格（利于 MusicBrainz 全文匹配），无双段分隔符时整体作曲名
  assert.deepEqual(parseNameQuery('Artist_Title.flac'), { title: 'Artist Title' })
})

test('parseNameQuery：单段仅曲名', () => {
  assert.deepEqual(parseNameQuery('孤勇者.mp3'), { title: '孤勇者' })
  // 只有分隔符无曲名段 → 回退整名
  const r = parseNameQuery(' - .mp3')
  assert.equal(r.artist, undefined)
})

test('tagsFromRecording：artist-credit / release / 日期映射', () => {
  const tags = tagsFromRecording({
    title: '孤勇者',
    'artist-credit': [{ name: '陈奕迅' }],
    releases: [{ title: '孤勇者 Single', date: '2021-11-08' }],
    'first-release-date': '2021-11-08'
  })
  assert.equal(tags.title, '孤勇者')
  assert.equal(tags.artist, '陈奕迅')
  assert.equal(tags.album, '孤勇者 Single')
  assert.equal(tags.date, '2021-11-08')
})

test('tagsFromRecording：缺字段容忍（返回 undefined 而非崩溃）', () => {
  const tags = tagsFromRecording({ title: 'x' })
  assert.equal(tags.title, 'x')
  assert.equal(tags.artist, undefined)
  assert.equal(tags.album, undefined)
})
