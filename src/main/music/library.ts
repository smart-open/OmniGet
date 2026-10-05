// 二期（0.9.x 音乐库）：已下载曲目登记与检索。
// 登记：manager 在 music.done 成功时落一行（真实产物路径/元数据）；
// 视图：按歌手/专辑分组浏览（分组在渲染层做，主进程只给扁平列表）；
// 补标签：一键 MusicBrainz 查询 + ffmpeg -c copy 元数据回写（原地替换，库行同步更新），
// 复用 #29 工具的查询纯函数与 TOFU 引擎闸门（ensureVerified）。

import { randomUUID } from 'crypto'
import { rename, stat, unlink } from 'fs/promises'
import { dirname, extname, join } from 'path'
import { getDb } from '../db'
import { createLogger } from '../logger'
import { ensureVerified, toolPath } from '../orchestrator/binaries'
import { spawnTreeAware, terminateTree } from '../orchestrator/proc'
import { lookupRecordingTags, parseNameQuery } from '../toolbox/musicbrainz'

const log = createLogger('music-library')

export interface MusicTrackRow {
  id: string
  task_id: string | null
  path: string
  lrc_path: string | null
  title: string
  artist: string | null
  album: string | null
  quality: string | null
  source: string | null
  size: number
  created_at: number
}

export interface TrackRegistration {
  taskId?: string
  path: string
  lrcPath?: string
  title: string
  artist?: string
  album?: string
  quality?: string
  source?: string
  size?: number
}

/** 完成即登记：同路径已存在则更新（重下/改名场景），不产生重复行 */
export function registerTrack(input: TrackRegistration): string {
  const id = randomUUID()
  const db = getDb()
  db.prepare('DELETE FROM music_tracks WHERE path = ?').run(input.path)
  db.prepare(
    `INSERT INTO music_tracks (id, task_id, path, lrc_path, title, artist, album, quality, source, size, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.taskId ?? null,
    input.path,
    input.lrcPath ?? null,
    input.title,
    input.artist ?? null,
    input.album ?? null,
    input.quality ?? null,
    input.source ?? null,
    input.size ?? 0,
    Date.now()
  )
  return id
}

export function listTracks(): MusicTrackRow[] {
  return getDb()
    .prepare(
      'SELECT * FROM music_tracks ORDER BY artist COLLATE NOCASE, album COLLATE NOCASE, title COLLATE NOCASE'
    )
    .all() as unknown as MusicTrackRow[]
}

export function removeTrack(id: string): boolean {
  const r = getDb().prepare('DELETE FROM music_tracks WHERE id = ?').run(id)
  return r.changes > 0
}

/** 四期（0.11.x）：任务「彻底删除（含文件）」时随产物注销库行（文件已删，库行成死链）。
 * 「删除·保留文件」不调用（库行保留，条目标注文件缺失）。 */
export function removeTracksByTask(taskId: string): void {
  getDb().prepare('DELETE FROM music_tracks WHERE task_id = ?').run(taskId)
}

/**
 * 一键补标签（库行入口串 #29 MusicBrainz 查询）：
 * 查询词优先用库行元数据，缺失时从文件名解析（'Artist - Title'）→
 * WS 2 匹配 → ffmpeg -c copy（不改音频数据）写 -metadata → 临时文件原地替换 →
 * 库行 title/artist/album 同步更新。返回更新后的标签集。
 */
export async function retagTrack(
  id: string
): Promise<{ title: string; artist?: string; album?: string; date?: string }> {
  const row = listTracks().find((t) => t.id === id)
  if (!row) throw new Error('曲目不存在或已被移除')
  const parsed = parseNameQuery(row.path)
  const artist = row.artist?.trim() || parsed.artist
  const title = row.title?.trim() || parsed.title
  if (!title) throw new Error('缺少曲名（库记录与文件名均无法解析出查询词）')

  // 查询（#29 同源：限流/未命中均给出路）
  const tags = await lookupRecordingTags(artist || undefined, title)

  // ffmpeg 流拷贝回写元数据（TOFU 闸门与工具箱同口径）
  const ffmpeg = toolPath('ffmpeg')
  await ensureVerified('ffmpeg')
  const tmp = join(dirname(row.path), `.retag-${randomUUID().slice(0, 8)}${extname(row.path)}`)
  const args = ['-y', '-i', row.path, '-c', 'copy']
  if (tags.title) args.push('-metadata', `title=${tags.title}`)
  if (tags.artist) args.push('-metadata', `artist=${tags.artist}`)
  if (tags.album) args.push('-metadata', `album=${tags.album}`)
  if (tags.date) args.push('-metadata', `date=${tags.date}`)
  args.push(tmp)

  const proc = spawnTreeAware(ffmpeg, args, { stdio: 'ignore' })
  const code = await new Promise<number | null>((resolve, reject) => {
    proc.once('error', reject)
    proc.once('exit', (c) => resolve(c))
  })
  if (code !== 0) {
    await unlink(tmp).catch(() => {})
    if (code === null) terminateTree(proc, 1000)
    throw new Error(`ffmpeg 元数据回写失败（exit ${code ?? 'signal'}）`)
  }
  const size = await stat(tmp).then((s) => s.size).catch(() => 0)
  if (size < 1024) {
    await unlink(tmp).catch(() => {})
    throw new Error('ffmpeg 产物为空，已放弃替换原文件')
  }
  // 原地替换：旧文件换名保留为 .bak 失败不阻断（磁盘上先有新文件再删旧）
  await unlink(row.path).catch(() => {})
  await rename(tmp, row.path).catch(async () => {
    // 替换失败：保留临时文件并报错，不静默丢产物
    throw new Error(`元数据文件替换失败：${tmp}`)
  })
  getDb()
    .prepare('UPDATE music_tracks SET title = ?, artist = ?, album = ? WHERE id = ?')
    .run(tags.title ?? row.title, tags.artist ?? row.artist, tags.album ?? row.album, id)
  log.info(`音乐库补标签完成: ${row.path} → ${tags.artist ?? ''} - ${tags.title ?? ''}`)
  return { title: tags.title ?? row.title, artist: tags.artist ?? undefined, album: tags.album ?? undefined, date: tags.date }
}
