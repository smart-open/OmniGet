// 短链/分享文案展开的纯函数分支单测（R7 P1；302 网络路径依赖外网，不在单测覆盖）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractFirstUrl, extractHttpUrls, expandInputSource } from './shortlink'

test('extractFirstUrl：分享文案中提取 URL 并剥离中文标点尾缀', () => {
  assert.equal(
    extractFirstUrl('2.84 nqe:/ 复制打开抖音 https://v.douyin.com/iRNBho6u/ 看视频'),
    'https://v.douyin.com/iRNBho6u/'
  )
  assert.equal(extractFirstUrl('没有链接的文本'), null)
})

test('extractHttpUrls：多镜像提取 + 去重', () => {
  const urls = extractHttpUrls('https://a.com/f.zip\nhttps://b.com/f.zip https://a.com/f.zip。')
  assert.deepEqual(urls, ['https://a.com/f.zip', 'https://b.com/f.zip'])
  assert.deepEqual(extractHttpUrls('普通文本'), [])
})

test('expandInputSource：纯文本歌名原样返回（不误伤音乐查询）', async () => {
  const r = await expandInputSource('陈奕迅的孤勇者')
  assert.equal(r.source, '陈奕迅的孤勇者')
  assert.equal(r.wasShortLink, false)
  assert.equal(r.rewritten, false)
})

test('expandInputSource：分享文案中的非视频域 URL 不接管', async () => {
  const r = await expandInputSource('看看这个 https://github.com/aria2/aria2 好用')
  assert.equal(r.source, '看看这个 https://github.com/aria2/aria2 好用')
  assert.equal(r.wasShortLink, false)
})

test('expandInputSource：裸 URL 非短链域原样透传', async () => {
  const r = await expandInputSource('https://www.bilibili.com/video/BV1xx411c7mD')
  assert.equal(r.source, 'https://www.bilibili.com/video/BV1xx411c7mD')
  assert.equal(r.wasShortLink, false)
})
