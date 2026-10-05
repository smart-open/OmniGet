// 三期（0.10.x，backlog #23）：B站视频任务弹幕压制后处理。
// 链路：URL 提取 bvid/aid → 公开 API 取 cid → 公开 API 拉弹幕 XML → xmlToAss →
// ffmpeg subtitles 滤镜压制（视频重编码 veryfast，音频流拷贝）。任一步失败不判
// 任务失败——压制是可选增强，返回说明文案由调用方并入完成消息。

import { unlink, writeFile } from 'fs/promises'
import { randomUUID } from 'crypto'
import { basename, dirname, extname, join } from 'path'
import { createLogger } from '../logger'
import { ensureVerified, toolPath } from '../orchestrator/binaries'
import { spawnTreeAware, terminateTree } from '../orchestrator/proc'
import { getJson, getText } from '../music/http'
import { xmlToAss } from './convert'

const log = createLogger('danmaku-burn')

/** 从 B站视频 URL 提取 bvid / aid（video/BVxxxx | video/av123 | b23.tv 已在短链层展开） */
export function extractBiliVideoId(url: string): { bvid?: string; aid?: string } | null {
  const m = /\/video\/(BV[0-9A-Za-z]+)/i.exec(url)
  if (m) return { bvid: m[1] }
  const a = /\/video\/av(\d+)/i.exec(url)
  if (a) return { aid: a[1] }
  const b = /[?&](?:bvid|bv)=((?:bv|BV)?[0-9A-Za-z]+)/i.exec(url)
  if (b) return { bvid: /^bv/i.test(b[1]!) ? b[1] : `BV${b[1]!.replace(/^bv/i, '')}` }
  return null
}

interface BiliViewData {
  code?: number
  data?: { cid?: number; title?: string; pages?: Array<{ cid?: number }> }
}

/** 取视频 cid（公开接口 view?bvid= / ?aid=，无签名） */
async function fetchCid(id: { bvid?: string; aid?: string }): Promise<number> {
  const q = id.bvid ? `bvid=${encodeURIComponent(id.bvid)}` : `aid=${id.aid}`
  const json = await getJson<BiliViewData>(`https://api.bilibili.com/x/web-interface/view?${q}`)
  if (json.code !== 0 || !json.data) throw new Error('B站视频信息获取失败（接口异常或视频不存在）')
  const cid = json.data.cid ?? json.data.pages?.[0]?.cid
  if (!cid) throw new Error('未获取到视频 cid（多P视频暂不支持弹幕压制）')
  return cid
}

/** ffmpeg subtitles 滤镜路径转义（Windows 盘符冒号/反斜杠/单引号） */
export function escapeFilterPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'")
}

export interface BurnResult {
  /** 产物路径（<原名>_弹幕.<ext>，保留原片） */
  output: string
  /** 弹幕条数（说明文案用） */
  comments: number
}

/**
 * 对单个视频文件执行弹幕压制。失败抛错（调用方降级为完成消息附注，不判任务失败）。
 */
export async function burnDanmaku(
  sourceUrl: string,
  videoPath: string,
  opts: { width?: number; opacity?: number } = {}
): Promise<BurnResult> {
  const id = extractBiliVideoId(sourceUrl)
  if (!id) throw new Error('非B站视频链接，无法获取弹幕')
  // 审查加固：多P任务（?p=N>1）cid 取的是 P1——错页弹幕烧录比不烧更糟
  const page = /[?&]p=(\d+)/.exec(sourceUrl)
  if (page && Number(page[1]) > 1) throw new Error('多P视频暂不支持弹幕压制（仅支持 P1）')
  const cid = await fetchCid(id)
  // 弹幕 XML（公开接口 listsoa；空/无 <d> 视为无弹幕）
  const xml = await getText(`https://api.bilibili.com/x/v1/dm/listsoa?oid=${cid}`, {
    referer: 'https://www.bilibili.com/',
    'user-agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
  })
  const { parseDanmakuXml } = await import('./convert')
  const comments = parseDanmakuXml(xml)
  if (comments.length === 0) throw new Error('该视频暂无弹幕')

  const ext = extname(videoPath) || '.mp4'
  const out = join(dirname(videoPath), `${basename(videoPath).replace(/\.\w+$/, '')}_弹幕${ext}`)
  const assPath = join(dirname(videoPath), `.danmaku-${randomUUID().slice(0, 8)}.ass`)
  await writeFile(
    assPath,
    xmlToAss(xml, { width: opts.width ?? 1920, opacity: opts.opacity ?? 100 }),
    'utf8'
  )
  try {
    await ensureVerified('ffmpeg')
    const filter = `ass='${escapeFilterPath(assPath)}'`
    const proc = spawnTreeAware(
      toolPath('ffmpeg'),
      ['-y', '-i', videoPath, '-vf', filter, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-c:a', 'copy', out],
      { stdio: 'ignore' }
    )
    // 第九轮审查：压制兜底超时（与 runDemucs/retag 同口径，6 小时宽限——压制
    // 时长与源视频成正比）——坏输入/网络盘卡死此前会永久挂住任务完成链
    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        terminateTree(proc, 1000)
        resolve(-1)
      }, 6 * 60 * 60 * 1000)
      timer.unref?.()
      proc.once('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
      proc.once('exit', (c) => {
        clearTimeout(timer)
        resolve(c)
      })
    })
    if (code !== 0) {
      await unlink(out).catch(() => {})
      if (code === null) terminateTree(proc, 1000)
      throw new Error(
        code === -1
          ? 'ffmpeg 弹幕压制超时（6 小时），任务已终止'
          : `ffmpeg 弹幕压制失败（exit ${code ?? 'signal'}）`
      )
    }
  } finally {
    await unlink(assPath).catch(() => {})
  }
  log.info(`danmaku burned: ${out} (${comments.length} comments)`)
  return { output: out, comments: comments.length }
}
