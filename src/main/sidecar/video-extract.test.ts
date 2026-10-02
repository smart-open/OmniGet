// sidecar 响应提取单测（backlog #11）：统一结构 / 字段漂移 / 图集误报防线

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractSidecarVideo, pickVideoUrl, platformLabel } from './video-extract'

const ORIGIN = 'https://v.kuaishou.com/abc'

// ── 类抖音统一结构（douyin/tiktok 混合解析主口径）────────────────────

const douyinData = {
  desc: '测试视频 #日常',
  author: { nickname: '张三' },
  video: {
    cover: { url_list: ['https://p3-sign.douyinpic.com/cover.jpeg?x=1'] },
    play_addr: {
      uri: 'v0d00fg10000',
      url_list: [
        'https://www.douyin.com/aweme/v1/play/?video_id=v0d00fg10000&ratio=1080p&line=0',
        'https://v26-web.douyinvod.com/o8AbC/video/tos/cn/tos-cn-ve-15/xxx/?a=6383&is_play_url=1&mime_type=video_mp4'
      ]
    },
    download_addr: {
      url_list: ['https://aweme.snssdk.com/aweme/v1/play/?video_id=v0d00fg10000&ratio=540p']
    }
  }
}

test('抖音统一结构：优先 play_addr，排除封面与原始链接，标题取 desc', () => {
  const v = extractSidecarVideo(douyinData, ORIGIN)
  assert.ok(v)
  assert.equal(v.url, douyinData.video.play_addr.url_list[1]) // 同级取更长（带完整参数）的 CDN 直链
  assert.equal(v.title, '测试视频 #日常')
})

test('play_addr 优先级高于 download_addr', () => {
  const url = pickVideoUrl(douyinData, ORIGIN)
  assert.ok(url)
  assert.match(url, /play\?video_id=v0d00fg10000&ratio=1080p|douyinvod/)
})

// ── 字段漂移兜底（快手 mainMvUrls / 小红书 master_url）──────────────

test('快手原始结构：mainMvUrls 命中', () => {
  const data = {
    photo: {
      caption: '快手作品',
      mainMvUrls: [{ url_list: ['https://download.kwaicdn.com/video/abc.mp4'] }],
      coverUrls: [{ url: 'https://photo.kwaicdn.com/cover.jpg' }]
    }
  }
  const v = extractSidecarVideo(data, ORIGIN)
  assert.ok(v)
  assert.equal(v.url, 'https://download.kwaicdn.com/video/abc.mp4')
})

test('小红书结构：master_url 优先于 backup_url', () => {
  const data = {
    video: {
      media: {
        stream: {
          h264: [
            {
              master_url: 'https://sns-video.xhscdn.com/master.mp4',
              backup_url: 'https://sns-video.xhscdn.com/backup.mp4'
            }
          ]
        }
      }
    }
  }
  const v = extractSidecarVideo(data, ORIGIN)
  assert.ok(v)
  assert.equal(v.url, 'https://sns-video.xhscdn.com/master.mp4')
})

// ── 误报防线 ────────────────────────────────────────────────────────

test('图集/纯图文（仅图片 URL）返回 null，不把图片当视频', () => {
  const data = {
    desc: '图文笔记',
    images: [{ url_list: ['https://sns-img.xhscdn.com/a.jpg'] }],
    note_card: { image_list: [{ url: 'https://sns-img.xhscdn.com/b.jpg' }] }
  }
  assert.equal(extractSidecarVideo(data, ORIGIN), null)
})

test('仅分享页/普通 url 字段不误判为视频直链', () => {
  const data = { share_url: 'https://v.kuaishou.com/abc', url: 'https://www.kuaishou.com/p/1' }
  assert.equal(extractSidecarVideo(data, ORIGIN), null)
})

test('原始输入链接本身被排除', () => {
  const data = { video: { play_addr: { url_list: [ORIGIN] } } }
  assert.equal(extractSidecarVideo(data, ORIGIN), null)
})

test('无 payload 返回 null（防御空响应）', () => {
  assert.equal(extractSidecarVideo(null, ORIGIN), null)
  assert.equal(extractSidecarVideo({}, ORIGIN), null)
})

test('platformLabel 映射与未知平台回退', () => {
  assert.equal(platformLabel('kuaishou'), '快手')
  assert.equal(platformLabel('xiaohongshu'), '小红书')
  assert.equal(platformLabel('unknown'), 'unknown')
})
