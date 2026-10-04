// 二期（0.9.x 无损档）：音频文件头嗅探与扩展名对齐回归
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'fs'
import { mkdtemp, writeFile as wf, stat } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

const tmp = mkdtempSync(join(tmpdir(), 'og-audio-'))
process.env.OMNIGET_TEST_DATA_DIR = join(tmp, 'data')

import { detectAudioExt, alignAudioExt } from './platforms'

after(() => {
  const { closeDb } = require('../db') as typeof import('../db')
  closeDb()
  rmSync(tmp, { recursive: true, force: true })
})

test('detectAudioExt：flac / m4a / mp3 裸帧 / ID3 / 未知', async () => {
  const dir = await mkdtemp(join(tmp, 'probe-'))
  const p = async (name: string, buf: Buffer): Promise<string> => {
    const path = join(dir, name)
    await wf(path, buf)
    return path
  }
  assert.equal(await detectAudioExt(await p('a.flac', Buffer.from('fLaC' + 'x'.repeat(20), 'latin1'))), '.flac')
  // m4a：偏移 4 的 ftyp 盒
  const m4a = Buffer.alloc(16)
  m4a.write('----ftyp', 0, 'latin1')
  assert.equal(await detectAudioExt(await p('b.m4a', m4a)), '.m4a')
  // ID3 头 mp3
  assert.equal(await detectAudioExt(await p('c.mp3', Buffer.from('ID3\x03\x00\x00' + '\0'.repeat(10), 'latin1'))), '.mp3')
  // 裸 MPEG 同步帧
  assert.equal(await detectAudioExt(await p('d.mp3', Buffer.from([0xff, 0xfb, 0x90, 0x00]))), '.mp3')
  // 未知魔数
  assert.equal(await detectAudioExt(await p('e.bin', Buffer.from('NOTAUDIO1234', 'latin1'))), null)
  // 文件不存在
  assert.equal(await detectAudioExt(join(dir, 'missing.mp3')), null)
})

test('alignAudioExt：fLaC 内容的 .mp3 改名 .flac；一致时不动', async () => {
  const dir = await mkdtemp(join(tmp, 'align-'))
  // ① 镜像返回 flac 但按 .mp3 命名 → 改名 .flac
  const wrong = join(dir, 'Artist - Song.mp3')
  await wf(wrong, Buffer.from('fLaC' + 'x'.repeat(20), 'latin1'))
  await wf(join(dir, 'Artist - Song.lrc'), '[00:01.00]x\n')
  const fixed = await alignAudioExt(wrong)
  assert.equal(fixed, join(dir, 'Artist - Song.flac'))
  await stat(fixed) // 音频已改名
  await stat(join(dir, 'Artist - Song.lrc')) // lrc 主名不变
  // ② 真 mp3 内容保持 .mp3
  const ok = join(dir, 'Real.mp3')
  await wf(ok, Buffer.from([0xff, 0xfb, 0x90, 0x00, ...Array(16).fill(0)]))
  assert.equal(await alignAudioExt(ok), ok)
})
