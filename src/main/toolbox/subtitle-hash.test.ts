// backlog #30（2026-10-03）：OpenSubtitles 哈希 / zip 解包纯函数回归

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deflateRawSync } from 'zlib'
import { extractFirstFromZip, opensubtitlesFileHash, unwrapSubtitleBody } from './subtitle-fetch'

test('OpenSubtitles 哈希：全零小文件 = 文件大小（官方算法）', () => {
  const head = Buffer.alloc(65536)
  const tail = Buffer.alloc(65536)
  // 16 字节全零文件：size=16，sum=0 → 16
  assert.equal(opensubtitlesFileHash(16, head, tail), '0000000000000010')
})

test('OpenSubtitles 哈希：首/尾 8 字节 LE 求和（手工向量）', () => {
  const head = Buffer.alloc(65536)
  head.writeBigUInt64LE(1n, 0)
  const tail = Buffer.alloc(65536)
  tail.writeBigUInt64LE(2n, 65528)
  // size(100) + 1 + 2 = 103 = 0x67
  assert.equal(opensubtitlesFileHash(100, head, tail), '0000000000000067')
})

test('OpenSubtitles 哈希：64 位回绕不产生负数/越界', () => {
  const head = Buffer.alloc(8)
  head.writeBigUInt64LE((1n << 64n) - 1n, 0)
  const tail = Buffer.alloc(65536)
  // size(10) + (2^64-1) = 2^64 + 9 → 回绕取模 2^64 = 9
  assert.equal(opensubtitlesFileHash(10, head, tail), '0000000000000009')
})

/** 手工构造最小 zip（单条目 store 或 deflate）——extractFirstFromZip 的测试夹具 */
function buildZip(entries: Array<{ name: string; data: Buffer; deflate?: boolean }>): Buffer {
  const chunks: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8')
    const method = e.deflate ? 8 : 0
    const body = e.deflate ? deflateRawSync(e.data) : e.data
    const crc = 0 // extractFirstFromZip 不校验 CRC
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(e.data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    chunks.push(local, nameBuf, body)
    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE(method, 10)
    cd.writeUInt32LE(crc, 16)
    cd.writeUInt32LE(body.length, 20)
    cd.writeUInt32LE(e.data.length, 24)
    cd.writeUInt16LE(nameBuf.length, 28)
    cd.writeUInt32LE(offset, 42)
    central.push(cd, nameBuf)
    offset += 30 + nameBuf.length + body.length
  }
  const cdBuf = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cdBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...chunks, cdBuf, eocd])
}

test('extractFirstFromZip：store 条目原样提取', () => {
  const data = Buffer.from('1\n00:00:01,000 --> 00:00:02,000\n你好\n')
  const zip = buildZip([{ name: 'sub.srt', data }])
  assert.equal(extractFirstFromZip(zip)!.equals(data), true)
})

test('extractFirstFromZip：deflate 条目解压；优先字幕扩展名', () => {
  const srt = Buffer.from('1\n00:00:01,000 --> 00:00:02,000\n台词\n')
  const other = Buffer.from('junk-junk-junk')
  const zip = buildZip([
    { name: 'cover.jpg', data: other },
    { name: 'movie.zh.srt', data: srt, deflate: true }
  ])
  assert.equal(extractFirstFromZip(zip)!.equals(srt), true)
})

test('unwrapSubtitleBody：gzip / 裸 srt 透传', () => {
  const { gzipSync } = require('zlib') as typeof import('zlib')
  const srt = Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nhi\n')
  assert.equal(unwrapSubtitleBody(gzipSync(srt)).equals(srt), true)
  assert.equal(unwrapSubtitleBody(srt).equals(srt), true)
})
