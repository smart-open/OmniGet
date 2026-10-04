// 二期（0.9.x 歌单/专辑批量）：URL 分型回归
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const tmp = mkdtempSync(join(tmpdir(), 'og-pl-'))
process.env.OMNIGET_TEST_DATA_DIR = tmp

import { parseMusicPlaylistUrl, PLAYLIST_MAX_TRACKS } from './playlist'

after(() => {
  const { closeDb } = require('../db') as typeof import('../db')
  closeDb()
  rmSync(tmp, { recursive: true, force: true })
})

test('歌单 URL：标准形态与 y/#/m 变体', () => {
  assert.deepEqual(parseMusicPlaylistUrl('https://music.163.com/playlist?id=123456'), { kind: 'playlist', id: '123456' })
  assert.deepEqual(parseMusicPlaylistUrl('https://y.music.163.com/m/playlist?id=999'), { kind: 'playlist', id: '999' })
  assert.deepEqual(parseMusicPlaylistUrl('https://music.163.com/#/playlist?id=42'), { kind: 'playlist', id: '42' })
  assert.deepEqual(
    parseMusicPlaylistUrl('https://music.163.com/playlist?id=42&userid=1'),
    { kind: 'playlist', id: '42' }
  )
})

test('专辑 URL：query 形态与路径形态', () => {
  assert.deepEqual(parseMusicPlaylistUrl('https://music.163.com/album?id=888'), { kind: 'album', id: '888' })
  assert.deepEqual(parseMusicPlaylistUrl('https://music.163.com/#/album?id=888'), { kind: 'album', id: '888' })
})

test('非歌单/专辑输入返回 null', () => {
  assert.equal(parseMusicPlaylistUrl('https://music.163.com/song?id=1'), null)
  assert.equal(parseMusicPlaylistUrl('https://example.com/playlist?id=1'), null)
  assert.equal(parseMusicPlaylistUrl('不是链接'), null)
  assert.equal(parseMusicPlaylistUrl('https://music.163.com/playlist'), null) // 无 id
  assert.equal(parseMusicPlaylistUrl(''), null)
})

test('批量上限常量', () => {
  assert.equal(PLAYLIST_MAX_TRACKS, 100)
})
