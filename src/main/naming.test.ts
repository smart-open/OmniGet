// 智能命名模板回归：yt-dlp -o 输出模板防穿越（遗留 #35）与占位符渲染
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  renderNamingTemplate,
  renderNamingSegments,
  toYtDlpOutputTemplate,
  DEFAULT_TEMPLATE
} from './naming'

test('占位符渲染：title/uploader/artist 回退链', () => {
  assert.equal(renderNamingTemplate('{{title}}', { title: 'T' }), 'T')
  assert.equal(renderNamingTemplate('{{title}}', {}), 'untitled')
  assert.equal(renderNamingTemplate('{{artist}}', { uploader: 'U' }), 'U')
  assert.equal(renderNamingTemplate('{{artist}}', { artist: 'A', uploader: 'U' }), 'A')
})

test('index 补零与未知占位符原样保留', () => {
  assert.equal(renderNamingTemplate('{{index:3}}', { index: 7 }), '007')
  assert.equal(renderNamingTemplate('{{index}}', {}), '1')
  assert.equal(renderNamingTemplate('{{nope}}', {}), '{{nope}}')
})

test('P3 回归：yt-dlp 模板防穿越——.. 折叠 + 首尾分隔符剥离 + 中段分隔符中和', () => {
  const t = toYtDlpOutputTemplate('../../{{title}}')
  assert.ok(!t.includes('..'), `模板不得包含 ..：${t}`)
  assert.ok(!/^[\\/]/.test(t), `模板不得以路径分隔符开头：${t}`)

  const t2 = toYtDlpOutputTemplate('a/b/{{title}}')
  const stem = t2.split('.%(ext)s')[0] ?? ''
  assert.ok(!/[\\/]/.test(stem.replace(/%\(title\)s/g, '')), `中段分隔符须被中和：${t2}`)
})

test('yt-dlp 变量映射与 ext 后缀', () => {
  assert.equal(toYtDlpOutputTemplate('{{title}}'), '%(title)s.%(ext)s')
  assert.ok(toYtDlpOutputTemplate('{{title}}/{{uploader}}').endsWith('.%(ext)s'))
  assert.ok(toYtDlpOutputTemplate('{{uploader}}').includes('%(uploader)s'))
})

test('空模板回退默认', () => {
  assert.ok(toYtDlpOutputTemplate('').endsWith('.%(ext)s'))
  assert.equal(DEFAULT_TEMPLATE, '{{title}}')
})

// ── 二期（0.9.x）：album 变量 + 目录段渲染（媒体服务器归档） ──────────

test('album 变量：缺省回退 Unknown Album', () => {
  assert.equal(renderNamingTemplate('{{album}}/{{title}}', { title: 'T', album: 'AL' }), 'AL/T')
  assert.equal(renderNamingTemplate('{{album}}', {}), 'Unknown Album')
})

test('renderNamingSegments：目录结构拆分与逐段清洗', () => {
  assert.deepEqual(renderNamingSegments('{{artist}}/{{album}}/{{title}}', { artist: 'A', album: 'B', title: 'T' }), ['A', 'B', 'T'])
  assert.deepEqual(renderNamingSegments('/{{artist}}//{{title}}/', { artist: 'A', title: 'T' }), ['A', 'T'])
  assert.deepEqual(renderNamingSegments('{{artist}}\\{{title}}', { artist: 'A', title: 'T' }), ['A', 'T'])
})

test('renderNamingSegments：防穿越与非法段收口', () => {
  const segs = renderNamingSegments('{{title}}/../evil', { title: 'T' })
  assert.ok(!segs.includes('..'), `不得包含 .. 段：${JSON.stringify(segs)}`)
  // 全段非法（'..'）时收口为单段且无穿越
  const only = renderNamingSegments('..', {})
  assert.equal(only.length, 1)
  assert.ok(!only[0]!.includes('..'))
  assert.ok(!renderNamingSegments('../../{{title}}', { title: 'T' }).includes('..'))
})
