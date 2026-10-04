import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseDanmakuXml, rgbToAss, xmlToAss } from './convert'

const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<i>
<d p="1.5,1,25,16777215,0,0,0,0">普通滚动弹幕</d>
<d p="2.0,4,25,16711680,0,0,0,0">底部弹幕</d>
<d p="3.2,5,25,255,0,0,0,0">顶部弹幕</d>
<d p="4.0,1,25,0,0,0,0,0">&lt;测试&gt;&amp;转义</d>
<d p="bad,1,25,0,0,0,0,0">坏时间戳</d>
<d p="5.0,1,25,0,0,0,0,0"></d>
</i>`

test('三期（backlog #23）：弹幕 XML 解析', () => {
  const list = parseDanmakuXml(SAMPLE)
  // 坏时间戳/空文本被过滤，剩 4 条
  assert.equal(list.length, 4)
  assert.equal(list[0]!.time, 1.5)
  assert.equal(list[0]!.mode, 1)
  assert.equal(list[0]!.color, 0xffffff)
  // 底部弹幕（mode 4）红色
  assert.equal(list[1]!.mode, 4)
  assert.equal(list[1]!.color, 0xff0000)
  // 实体解码
  assert.equal(list[3]!.text, '<测试>&转义')
  // 按 time 升序
  assert.ok(list.every((c, i) => i === 0 || c.time >= list[i - 1]!.time))
})

test('三期：RGB → ASS 颜色（&H00BBGGRR）', () => {
  // 0xff0000（红）→ BB=00 GG=00 RR=ff
  assert.equal(rgbToAss(0xff0000, '00'), '&H000000ff')
  // 0xffffff → 全 f
  assert.equal(rgbToAss(0xffffff, '00'), '&H00ffffff')
})

test('三期：xmlToAss 产出 ASS 结构（样式/轨迹/定轨）', () => {
  const ass = xmlToAss(SAMPLE, { width: 1920, height: 1080, fontSize: 38, opacity: 80 })
  // Script Info / Styles / Events 段齐备
  assert.match(ass, /PlayResX: 1920/)
  assert.match(ass, /PlayResY: 1080/)
  assert.match(ass, /Style: R2L,/)
  assert.match(ass, /Style: Fix,/)
  // 滚动弹幕用 \move（右→左；起点 x = 画布宽 + 半文本宽，可能 > 1999）
  assert.match(ass, /\\move\(\d{3,5},/)
  // 底部弹幕用 \pos（下半区）
  assert.match(ass, /\\pos\(960,\d+\)/)
  // 顶部弹幕 y 在上半区（< 1080/2）
  const topLine = ass.split('\n').find((l) => l.includes('顶部弹幕'))
  assert.ok(topLine)
  const y = Number(/\\pos\(960,(\d+)\)/.exec(topLine)![1])
  assert.ok(y < 540, `顶部弹幕应在画布上半区，实际 y=${y}`)
  // 不透明度 80 → alpha ≈ 51（0x33）
  assert.match(ass, /&H33ffffff/i)
  // 实体解码后的文本原样落事件行（ASS 特殊字符是 {}，已替换为全角括号）
  assert.ok(ass.includes('<测试>&转义'))
})

test('三期：空 XML / 上限裁剪', () => {
  // 空 XML：结构头仍在，无事件行
  const empty = xmlToAss('')
  assert.match(empty, /PlayResX: 1920/)
  assert.equal(empty.split('\n').filter((l) => l.startsWith('Dialogue:')).length, 0)
  const many = Array.from({ length: 3500 }, (_, i) => `<d p="${i},1,25,0,0,0,0,0">弹幕${i}</d>`).join('')
  const ass = xmlToAss(`<i>${many}</i>`)
  const dialogueCount = ass.split('\n').filter((l) => l.startsWith('Dialogue:')).length
  assert.equal(dialogueCount, 3000)
})
