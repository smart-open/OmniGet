import { test } from 'node:test'
import assert from 'node:assert/strict'
import bencode from 'bencode'
import { createHash } from 'crypto'
import { generateMagnet, normalizeInfohash, parseTorrent } from './parse'

function makeSingleFileTorrent(): Buffer {
  return bencode.encode({
    announce: 'udp://tracker.example.com:6969/announce',
    info: {
      name: 'sample.mkv',
      length: 123456789,
      'piece length': 262144,
      pieces: Buffer.alloc(20)
    }
  })
}

function makeMultiFileTorrent(): Buffer {
  return bencode.encode({
    'announce-list': [
      ['udp://a.example.com:6969', 'https://b.example.com/announce'],
      ['udp://c.example.com:6969']
    ],
    info: {
      name: 'Pack',
      'piece length': 262144,
      pieces: Buffer.alloc(20),
      files: [
        { path: [Buffer.from('V'), Buffer.from('VID_001.mp4')], length: 541_000_000 },
        { path: [Buffer.from('P'), Buffer.from('001.jpg')], length: 1_800_000 }
      ]
    }
  })
}

test('单文件种子：infohash 与官方算法一致（SHA1 of bencoded info）', () => {
  const raw = makeSingleFileTorrent()
  const expected = createHash('sha1')
    .update(bencode.encode((bencode.decode(raw) as Record<string, any>).info))
    .digest('hex')
  const info = parseTorrent(raw)
  assert.equal(info.infohash, expected)
  assert.equal(info.name, 'sample.mkv')
  assert.deepEqual(info.files, [
    { path: 'sample.mkv', size: 123456789, selected: true, downloaded: 0 }
  ])
})

test('多文件种子：path 逐级拼接 + announce-list 逐 tier 展开', () => {
  const info = parseTorrent(makeMultiFileTorrent())
  assert.equal(info.name, 'Pack')
  assert.equal(info.files.length, 2)
  assert.equal(info.files[0]?.path, 'V/VID_001.mp4')
  assert.equal(info.files[0]?.size, 541_000_000)
  assert.equal(info.trackers.length, 3)
})

test('磁力生成：xt/dn/tr 齐全且最多 8 个 tracker', () => {
  const magnet = generateMagnet('dc9e7581aabbccddeeff00112233445566778899', 'Pack', [
    'udp://t1',
    'udp://t2',
    'udp://t3',
    'udp://t4',
    'udp://t5',
    'udp://t6',
    'udp://t7',
    'udp://t8',
    'udp://t9',
    'udp://t10'
  ])
  assert.ok(magnet.startsWith('magnet:?xt=urn:btih:dc9e7581aabbccddeeff00112233445566778899'))
  assert.ok(magnet.includes('dn=Pack'))
  assert.equal(magnet.match(/tr=/g)?.length, 8)
})

test('base32 → hex 归一化：32 位磁力查重命中 40 位 hex', () => {
  const hex = 'dc9e7581aabbccddeeff00112233445566778899'
  const b32 = b32encode(Buffer.from(hex, 'hex'))
  assert.equal(b32.length, 32)
  assert.equal(normalizeInfohash(b32), hex)
  // 40 位 hex 直接透传
  assert.equal(normalizeInfohash(hex.toUpperCase()), hex)
})

/** RFC4648 base32（无填充小写） */
function b32encode(buf: Buffer): string {
  const alpha = 'abcdefghijklmnopqrstuvwxyz234567'
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of buf) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += alpha[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += alpha[(value << (5 - bits)) & 31]
  return out
}

test('脏字段容错：非法 path 缓冲不中断解析', () => {
  const raw = bencode.encode({
    announce: 'udp://x',
    info: {
      name: Buffer.from([0xff, 0xfe, 0x61, 0x62]), // 非法 UTF-8 前缀
      length: 1,
      'piece length': 16384,
      pieces: Buffer.alloc(20)
    }
  })
  const info = parseTorrent(raw)
  assert.ok(info.name.includes('ab'))
})
