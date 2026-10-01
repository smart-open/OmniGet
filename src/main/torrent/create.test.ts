// T5 种子创建测试：创建 → 解析回环（infohash / 文件清单 / 磁力一致性）
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTorrent, magnetFromTorrent } from './create'
import { parseTorrentFile } from './parse'

test('单文件种子：创建 → 解析回环一致', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omniget-t5-'))
  const src = join(dir, 'hello.mp4')
  await writeFile(src, Buffer.alloc(700 * 1024, 7)) // 700KB → 自动 256KB 分片 = 3 片

  const r = await createTorrent(src, join(dir, 'hello.mp4.torrent'), {
    announce: 'udp://tracker.example.com:1337'
  })
  assert.equal(r.fileCount, 1)
  assert.equal(r.totalBytes, 700 * 1024)
  assert.match(r.infohash, /^[0-9a-f]{40}$/)

  const parsed = parseTorrentFile(r.outPath)
  assert.equal(parsed.infohash, r.infohash)
  assert.equal(parsed.name, 'hello.mp4')
  assert.equal(parsed.files.length, 1)
  assert.equal(parsed.files[0]?.size, 700 * 1024)

  // 磁力提取：infohash + dn + tr 一致
  const magnet = await magnetFromTorrent(r.outPath)
  assert.ok(magnet.startsWith(`magnet:?xt=urn:btih:${r.infohash}`))
  assert.ok(magnet.includes('tr=udp%3A%2F%2Ftracker.example.com%3A1337'))
})

test('目录种子：多文件 info 与解析回环一致', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omniget-t5-'))
  const root = join(dir, '合集')
  await mkdir(join(root, 'sub'), { recursive: true })
  await writeFile(join(root, 'a.txt'), 'AAA')
  await writeFile(join(root, 'sub', 'b.txt'), 'BBBB')

  const r = await createTorrent(root, join(dir, '合集.torrent'))
  assert.equal(r.fileCount, 2)
  assert.equal(r.totalBytes, 7)

  const parsed = parseTorrentFile(r.outPath)
  assert.equal(parsed.infohash, r.infohash)
  assert.equal(parsed.name, '合集')
  assert.deepEqual(
    parsed.files.map((f) => f.path).sort(),
    ['a.txt', 'sub/b.txt']
  )
  assert.equal(parsed.files.reduce((s, f) => s + f.size, 0), 7)
})

test('.torrent 文件可被 bencode 解析（announce 落盘）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omniget-t5-'))
  const src = join(dir, 'x.txt')
  await writeFile(src, 'X')
  const r = await createTorrent(src, join(dir, 'x.torrent'), { announce: 'http://t/announce' })
  const raw = await readFile(r.outPath)
  assert.ok(raw.includes(Buffer.from('http://t/announce')))
})
