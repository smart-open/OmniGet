// 本地 .torrent 元数据缓存单测（R7 P0-3）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { cacheTorrentFile, findCachedTorrent, readCachedTorrent } from './cache'

process.env.OMNIGET_TEST_DATA_DIR = mkdtempSync(join(tmpdir(), 'omniget-cache-test-'))

const IH = 'dc9e7581a1b2c3d4e5f60718293a4b5c6d7e8f90' // 40 位 hex

test('缓存写入 → 命中 → base64 读出 roundtrip', async () => {
  const src = join(process.env.OMNIGET_TEST_DATA_DIR!, 'src.torrent')
  writeFileSync(src, 'd4:infod4:name4:teste')

  assert.equal(findCachedTorrent(IH), null) // 写入前未命中
  await cacheTorrentFile(src, IH)

  const hit = findCachedTorrent(IH)
  assert.ok(hit, '写入后应命中')
  assert.ok(hit.endsWith(`${IH}.torrent`))
  assert.equal(await readCachedTorrent(IH), Buffer.from('d4:infod4:name4:teste').toString('base64'))
})

test('非法 infohash 不缓存不命中', async () => {
  assert.equal(findCachedTorrent('not-a-hash'), null)
  await cacheTorrentFile('/tmp/x.torrent', 'zzz')
  assert.equal(findCachedTorrent('zzz'), null)
})

test('重复缓存幂等（保留首个，不覆盖）', async () => {
  const src = join(process.env.OMNIGET_TEST_DATA_DIR!, 'other.torrent')
  writeFileSync(src, 'different-content')
  const before = await readCachedTorrent(IH)
  await cacheTorrentFile(src, IH)
  assert.equal(await readCachedTorrent(IH), before, '二次缓存不得覆盖首个')
})
