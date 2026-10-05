// 四期（0.11.x）：Jellyfin/Emby 友好的 NFO 与海报落盘（roadmap 四期「NFO/媒体库
// 元数据导出」——二期音乐归档口径的视频侧补全）。
// 生成 `<视频名>.nfo`（movie 语义）+ `<视频名>-poster.jpg`（复用库封面抽帧产物），
// 与视频同目录——配合设置 → 下载「按类型自动归档」的目录结构可被 Jellyfin 直接扫描。
// 纯函数（单测）：XML 构建 + 转义；落盘封装 exportNfoForVideo / maybeExportNfo。

import { copyFile, writeFile, stat } from 'fs/promises'
import { extname } from 'path'
import { getSettingParsed } from '../db'
import { createLogger } from '../logger'

const log = createLogger('video-nfo')

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

export interface NfoInput {
  title: string
  platform?: string | null
  durationSec?: number | null
  date?: number
}

/** 纯函数（单测覆盖）：库行 → Jellyfin/Emby movie NFO（Kodi 通用方言子集） */
export function buildMovieNfo(input: NfoInput): string {
  const date = new Date(input.date ?? Date.now())
  const lines: string[] = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>', '<movie>']
  const push = (tag: string, value: string): void => {
    lines.push(`  <${tag}>${escapeXml(value)}</${tag}>`)
  }
  push('title', input.title)
  if (input.platform) push('studio', input.platform)
  push('outline', `OmniGet 下载${input.platform ? `（来源：${input.platform}）` : ''}`)
  // 归档日期（Jellyfin 按年归组/展示）
  push('year', String(date.getFullYear()))
  push('premiered', date.toISOString().slice(0, 10))
  if (Number.isFinite(input.durationSec) && (input.durationSec ?? 0) > 0) {
    lines.push('  <fileinfo>')
    lines.push('    <streamdetails>')
    lines.push(`      <duration>${Math.round(input.durationSec!)}</duration>`)
    lines.push('    </streamdetails>')
    lines.push('  </fileinfo>')
  }
  lines.push('</movie>', '')
  return lines.join('\n')
}

export interface NfoExportResult {
  nfoPath: string
  posterPath: string | null
}

async function exportNfo(
  video: { path: string; title: string; platform: string | null; size: number; duration_sec: number | null; cover_path: string | null },
  broadcast: boolean,
  overwrite: boolean
): Promise<NfoExportResult> {
  const base = video.path.slice(0, video.path.length - extname(video.path).length) || video.path
  const nfoPath = `${base}.nfo`
  // 第九轮审查（C8）：自动入库钩子不得覆盖同目录已有的 .nfo/-poster.jpg——
  // Jellyfin/tinyMediaManager 等工具或用户手写的元数据信息量更高（plot/rating），
  // 被低信息量的 OmniGet 版本静默覆盖不可接受；手动导出保留覆盖语义（用户显式意图）
  if (!overwrite && (await stat(nfoPath).then(() => true).catch(() => false))) {
    log.info(`nfo auto-export skipped (existing): ${nfoPath}`)
    return { nfoPath, posterPath: null }
  }
  await writeFile(nfoPath, buildMovieNfo({
    title: video.title,
    platform: video.platform,
    durationSec: video.duration_sec,
    // 第十轮审查：归档日期用库行登记时间（下载完成时刻），此前恒取导出时刻
    date: (video as { created_at?: number }).created_at
  }), 'utf8')
  // 海报：复用库封面抽帧产物（cover 存在才拷贝）；命名 <视频名>-poster.jpg（Jellyfin/Emby 均识别）
  let posterPath: string | null = null
  if (video.cover_path) {
    posterPath = `${base}-poster.jpg`
    if (!overwrite && (await stat(posterPath).then(() => true).catch(() => false))) {
      log.info(`nfo poster auto-export skipped (existing): ${posterPath}`)
      posterPath = null
    } else {
      // 第十轮审查：封面文件可能已被清理（任务删除/库行注销）——拷贝失败降级
      // 为「仅 NFO」，不吞掉已写成功的 NFO
      posterPath = await copyFile(video.cover_path, posterPath)
        .then(() => posterPath)
        .catch(() => null)
    }
  }
  if (broadcast) {
    // 动态引入（同 manager 口径）：ipc 模块拉起 electron 主模块，测试环境只测纯函数
    const { broadcastNotices } = await import('../ipc')
    broadcastNotices([
      { level: 'info', message: `NFO/海报已导出到视频同目录：${nfoPath.split(/[\\/]/).pop() ?? nfoPath}` }
    ])
  }
  log.info(`nfo exported: ${nfoPath}${posterPath ? ` (+poster)` : ''}`)
  return { nfoPath, posterPath }
}

/** 手动导出（视频库行操作）：条目不存在/路径无效时抛错给 toast */
export async function exportNfoForVideo(videoId: string): Promise<NfoExportResult> {
  const { getDb } = await import('../db')
  const video = getDb().prepare('SELECT * FROM videos WHERE id = ?').get(videoId) as
    | { path: string; title: string; platform: string | null; size: number; duration_sec: number | null; cover_path: string | null }
    | undefined
  if (!video) throw new Error('条目不存在或已被移除')
  return exportNfo(video, true, true)
}

/** 自动入库钩子：设置 video.nfoExport 开启时随封面就绪落 NFO；失败仅留痕不阻断 */
export async function maybeExportNfo(videoId: string): Promise<void> {
  if (getSettingParsed<boolean>('video.nfoExport') !== true) return
  try {
    const { getDb } = await import('../db')
    const video = getDb().prepare('SELECT * FROM videos WHERE id = ?').get(videoId) as
      | { path: string; title: string; platform: string | null; size: number; duration_sec: number | null; cover_path: string | null }
      | undefined
    if (!video) return
    await exportNfo(video, false, false)
  } catch (err) {
    log.warn(`nfo auto-export failed for ${videoId}: ${err instanceof Error ? err.message : String(err)}`)
  }
}
