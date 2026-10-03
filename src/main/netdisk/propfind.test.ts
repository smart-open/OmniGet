// backlog #26（2026-10-03）：PROPFIND 解析 / URL 构造纯函数回归

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hrefToPath, normalizeWebdavBase, parsePropfind, webdavUrlFor } from './webdav'

const SAMPLE_DAV = `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>/dav/</D:href>
    <D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop></D:propstat>
  </D:response>
  <D:response>
    <D:href>/dav/movies/</D:href>
    <D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype><D:displayname>movies</D:displayname></D:prop></D:propstat>
  </D:response>
  <D:response>
    <D:href>/dav/movies/%E5%AD%A4%E5%8B%87%E8%80%85.mp4</D:href>
    <D:propstat><D:prop><D:resourcetype/><D:getcontentlength>1048576</D:getcontentlength></D:prop></D:propstat>
  </D:response>
</D:multistatus>`

test('parsePropfind：命名空间前缀/自闭合 collection/百分比编码 href', () => {
  const entries = parsePropfind(SAMPLE_DAV)
  assert.equal(entries.length, 3)
  assert.equal(entries[0]!.isDir, true)
  assert.equal(entries[1]!.name, 'movies')
  assert.equal(entries[2]!.isDir, false)
  assert.equal(entries[2]!.size, 1048576)
  // displayname 缺失回退 href 末段（已解码）
  assert.equal(entries[2]!.name, '孤勇者.mp4')
})

test('parsePropfind：XML 实体解码（displayname/href 含 & 等）', () => {
  const xml = `<multistatus><response><href>/dav/A&amp;B%20x.mp4</href><propstat><prop><resourcetype/><displayname>A&amp;B &apos;x&apos;</displayname></prop></propstat></response></multistatus>`
  const entries = parsePropfind(xml)
  assert.equal(entries[0]!.name, `A&B 'x'`)
  assert.equal(entries[0]!.href, '/dav/A&B x.mp4')
})

test('parsePropfind：无前缀裸标签（OpenList/部分服务器）', () => {
  const xml = `<multistatus><response><href>/dav/a.mkv</href><propstat><prop><resourcetype/><getcontentlength>10</getcontentlength></prop></propstat></response></multistatus>`
  const entries = parsePropfind(xml)
  assert.equal(entries.length, 1)
  assert.equal(entries[0]!.name, 'a.mkv')
  assert.equal(entries[0]!.size, 10)
})

test('hrefToPath：剥离端点基路径（大小写不敏感）', () => {
  assert.equal(hrefToPath('http://h:5240/dav', '/dav/movies/x.mp4'), '/movies/x.mp4')
  assert.equal(hrefToPath('http://h:5240/DAV', '/dav/x'), '/x')
  // 绝对 URL href
  assert.equal(hrefToPath('http://h:5240/dav', 'http://h:5240/dav/y/z.mkv'), '/y/z.mkv')
  // 根目录
  assert.equal(hrefToPath('http://h:5240/dav', '/dav/'), '/')
})

test('webdavUrlFor：逐段编码 + 去尾斜杠', () => {
  assert.equal(webdavUrlFor('http://h:5240/dav/', '/movies/名.mp4'), 'http://h:5240/dav/movies/%E5%90%8D.mp4')
  assert.equal(webdavUrlFor('http://h:5240/dav', '/'), 'http://h:5240/dav/')
})

test('normalizeWebdavBase：http 放行、非法拒绝、去尾斜杠', () => {
  assert.equal(normalizeWebdavBase(' http://127.0.0.1:5240/dav/ '), 'http://127.0.0.1:5240/dav')
  assert.equal(normalizeWebdavBase('https://pan.example.com/dav'), 'https://pan.example.com/dav')
  assert.equal(normalizeWebdavBase('ftp://x'), null)
  assert.equal(normalizeWebdavBase(''), null)
  assert.equal(normalizeWebdavBase(null), null)
})
