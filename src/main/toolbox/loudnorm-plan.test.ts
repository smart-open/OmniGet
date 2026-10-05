// 四期（0.11.x）：EBU R128 两遍响度归一纯函数回归（测量解析 + 第二遍滤镜构建）

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildLoudnormFilter, parseLoudnormMeasure } from './loudnorm-plan'

const SAMPLE_JSON = `{
  "input_i" : "-17.24",
  "input_tp" : "-0.44",
  "input_lra" : "6.20",
  "input_thresh" : "-27.74",
  "output_i" : "-14.10",
  "output_tp" : "-1.50",
  "output_lra" : "5.20",
  "output_thresh" : "-24.60",
  "normalization_type" : "dynamic",
  "target_offset" : "0.34"
}`

test('loudnorm 测量解析：标准 JSON 块（stderr 杂项混合）', () => {
  const stderr = `[parsed_0 @ xxx] \n[Parsed_loudnorm_0 @ 0x0]\n${SAMPLE_JSON}\nsize=N/A time=...`
  const m = parseLoudnormMeasure(stderr)
  assert.ok(m)
  assert.equal(m.input_i, -17.24)
  assert.equal(m.input_tp, -0.44)
  assert.equal(m.input_lra, 6.2)
  assert.equal(m.input_thresh, -27.74)
  assert.equal(m.target_offset, 0.34)
})

test('loudnorm 测量解析：取最后一个 JSON 块（多次出现以末次为准）', () => {
  const m = parseLoudnormMeasure(`${SAMPLE_JSON}${SAMPLE_JSON}`)
  assert.ok(m)
  assert.equal(m.input_i, -17.24)
})

test('loudnorm 测量解析：无测量块 / -inf 值返回 null（回退单遍）', () => {
  assert.equal(parseLoudnormMeasure('no json here'), null)
  assert.equal(parseLoudnormMeasure(''), null)
  const infinite = SAMPLE_JSON.replace('"input_i" : "-17.24"', '"input_i" : "-inf"')
  assert.equal(parseLoudnormMeasure(infinite), null)
})

test('loudnorm 第二遍滤镜：linear 模式 + 测量值钳制', () => {
  const f = buildLoudnormFilter({
    input_i: -17.24,
    input_tp: -0.44,
    input_lra: 6.2,
    input_thresh: -27.74,
    target_offset: 0.34
  })
  assert.ok(f.includes('loudnorm=I=-14:TP=-1.5:LRA=11'))
  assert.ok(f.includes('measured_I=-17.24'))
  assert.ok(f.includes('measured_TP=-0.44'))
  assert.ok(f.includes('measured_LRA=6.20'))
  assert.ok(f.includes('measured_thresh=-27.74'))
  assert.ok(f.includes('offset=0.34'))
  assert.ok(f.includes('linear=true'))
  // 异常值钳制：超界数值不得原样注入（防解析异常破坏滤镜参数）
  const clamped = buildLoudnormFilter({
    input_i: 999,
    input_tp: -999,
    input_lra: 0,
    input_thresh: -999,
    target_offset: 999
  })
  assert.ok(clamped.includes('measured_I=0.00'))
  assert.ok(clamped.includes('measured_TP=-9.00'))
  assert.ok(clamped.includes('measured_thresh=-70.00'))
  assert.ok(clamped.includes('offset=35.00'))
})
