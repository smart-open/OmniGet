// backlog #28（2026-10-03）：轨道提取规划纯函数回归

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planTrackExtraction } from './track-plan'
import type { StreamInfo } from './ffprobe'

const streams: StreamInfo[] = [
  { index: 0, codec_type: 'video', codec_name: 'h264' },
  { index: 1, codec_type: 'audio', codec_name: 'aac' },
  { index: 2, codec_type: 'audio', codec_name: 'flac' },
  { index: 3, codec_type: 'subtitle', codec_name: 'subrip' },
  { index: 4, codec_type: 'subtitle', codec_name: 'hdmv_pgs_subtitle' },
  { index: 5, codec_type: 'subtitle', codec_name: 'mov_text' }
]

test('音轨全部提取：mka 多输出 + -map/-c:a/输出交错', () => {
  const plan = planTrackExtraction(streams, 'audio', 'all', 0, 'in.mkv', '/out', 'base')
  assert.equal(plan.outputs.length, 2)
  assert.ok(plan.outputs[0]!.endsWith('base.audio0.mka'))
  // 第六轮审查：输出选项只作用于其后最近的输出文件——每个 -map 后必须紧跟
  // -c:a copy 与其输出文件（置于首输出之前只对第 1 条音轨生效）
  const mapIdxs = plan.args.reduce<number[]>(
    (acc, a, i) => (a === '-map' ? [...acc, i] : acc),
    []
  )
  assert.equal(mapIdxs.length, 2)
  for (let i = 0; i < mapIdxs.length; i++) {
    const at = mapIdxs[i]!
    const seg = plan.args.slice(at, at + 4)
    assert.equal(seg[1], `0:a:${i}`)
    assert.deepEqual(seg.slice(2), ['-c:a', 'copy'])
    assert.equal(plan.args[at + 4], plan.outputs[i])
  }
})

test('音轨指定序号：单输出流拷贝', () => {
  const plan = planTrackExtraction(streams, 'audio', 'index', 1, 'in.mkv', '/out', 'base')
  assert.equal(plan.outputs.length, 1)
  assert.ok(plan.outputs[0]!.endsWith('base.track1.mka'))
  assert.ok(plan.args.includes('0:a:1'))
})

test('序号越界：报错并给出条数范围', () => {
  assert.throws(() => planTrackExtraction(streams, 'audio', 'index', 5, 'in.mkv', '/out', 'b'), /序号 0-1/)
})

test('字幕全部提取：跳过图形轨，0:s 序号按文件内字幕轨序号锁定', () => {
  const plan = planTrackExtraction(streams, 'subtitle', 'all', 0, 'in.mkv', '/out', 'base')
  // subrip(0) + mov_text(2) 可转；pgs(1) 跳过
  assert.equal(plan.outputs.length, 2)
  assert.equal(plan.skippedBitmap, 1)
  const srtIdx = plan.args.indexOf('0:s:0')
  const movIdx = plan.args.indexOf('0:s:2')
  assert.ok(srtIdx >= 0 && movIdx >= 0, '应包含 0:s:0 与 0:s:2（pgs 序号 1 不出现）')
  assert.ok(!plan.args.includes('0:s:1'))
  assert.ok(plan.outputs.every((o) => o.endsWith('.srt')))
})

test('全图形字幕：明确报错不静默', () => {
  const pgsOnly: StreamInfo[] = [
    { index: 0, codec_type: 'video', codec_name: 'h264' },
    { index: 1, codec_type: 'subtitle', codec_name: 'hdmv_pgs_subtitle' }
  ]
  assert.throws(() => planTrackExtraction(pgsOnly, 'subtitle', 'all', 0, 'in.mkv', '/out', 'b'), /图形字幕/)
})

test('无音轨/无字幕轨：明确报错', () => {
  assert.throws(() => planTrackExtraction([], 'audio', 'all', 0, 'in.mkv', '/out', 'b'), /没有可提取的音轨/)
  assert.throws(() => planTrackExtraction([], 'subtitle', 'index', 0, 'in.mkv', '/out', 'b'), /没有可提取的字幕轨/)
})
