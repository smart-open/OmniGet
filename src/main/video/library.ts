// 三期（0.10.x）：视频媒体库（Pinchflat 范式半步——封面墙 + 元数据浏览，不做全家桶）。
// 登记：manager 在视频任务完成落 task_files 后对视频产物登记一行（同路径覆盖）；
// 封面：优先复用既有图（--write-thumbnail 场景），否则 ffmpeg 抽帧存 userData/covers/
//（渲染层经 omniget-preview://local 流出——userData 路径在预览协议白名单内）。

import { randomUUID } from 'crypto'
import { mkdirSync } from 'fs'
import { stat } from 'fs/promises'
import { join } from 'path'
import { getDb } from '../db'
import { userDataDir } from '../env'
import { createLogger } from '../logger'
import { ensureVerified, toolPath } from '../orchestrator/binaries'
import { getYtDlpSupervisor } from '../orchestrator/ytdlp'

const log = createLogger('video-library')

export interface VideoRow {
  id: string
  task_id: string | null
  path: string
  title: string
  platform: string | null
  size: number
  duration_sec: number | null
  cover_path: string | null
  created_at: number
}

export interface VideoRegistration {
  taskId?: string
  path: string
  title: string
  platform?: string
  size?: number
  durationSec?: number | null
  coverPath?: string | null
}

/** 完成即登记：同路径已存在则复用行（保留 id 与既有封面），否则新插入 */
export function registerVideo(input: VideoRegistration): string {
  const db = getDb()
  const existing = db.prepare('SELECT id FROM videos WHERE path = ?').get(input.path) as
    | { id: string }
    | undefined
  if (existing) {
    db.prepare(
      'UPDATE videos SET task_id = ?, title = ?, platform = ?, size = ? WHERE id = ?'
    ).run(input.taskId ?? null, input.title, input.platform ?? null, input.size ?? 0, existing.id)
    return existing.id
  }
  const id = randomUUID()
  db.prepare(
    `INSERT INTO videos (id, task_id, path, title, platform, size, duration_sec, cover_path, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.taskId ?? null,
    input.path,
    input.title,
    input.platform ?? null,
    input.size ?? 0,
    input.durationSec ?? null,
    input.coverPath ?? null,
    Date.now()
  )
  return id
}

export function listVideos(): VideoRow[] {
  return getDb()
    .prepare('SELECT * FROM videos ORDER BY created_at DESC')
    .all() as unknown as VideoRow[]
}

export function removeVideo(id: string): boolean {
  const db = getDb()
  const row = db.prepare('SELECT cover_path FROM videos WHERE id = ?').get(id) as
    | { cover_path: string | null }
    | undefined
  if (!row) return false
  db.prepare('DELETE FROM videos WHERE id = ?').run(id)
  // 审查加固：封面是库的内部产物（非用户文件）——随条目一并清理，防 covers 目录只增不减
  if (row.cover_path) {
    void import('fs/promises').then(({ unlink }) => unlink(row.cover_path!).catch(() => {}))
  }
  return true
}

/** 四期（0.11.x）：任务「彻底删除（含文件）」时随产物注销库行并清理封面文件。
 * 「删除·保留文件」不调用（库行保留，条目标注文件缺失）。 */
export function removeVideosByTask(taskId: string): void {
  const db = getDb()
  const rows = db
    .prepare('SELECT cover_path FROM videos WHERE task_id = ?')
    .all(taskId) as unknown as Array<{ cover_path: string | null }>
  if (rows.length === 0) return
  db.prepare('DELETE FROM videos WHERE task_id = ?').run(taskId)
  for (const r of rows) {
    if (r.cover_path) {
      void import('fs/promises').then(({ unlink }) => unlink(r.cover_path!).catch(() => {}))
    }
  }
}

function coversDir(): string {
  const dir = join(userDataDir(), 'covers')
  mkdirSync(dir, { recursive: true })
  return dir
}

/** ffprobe 时长（秒；探测失败 null——封面位次回退固定 3s） */
export async function probeDurationSec(path: string): Promise<number | null> {
  try {
    await ensureVerified('ffprobe')
    const out = await getYtDlpSupervisor()
      .runAux(
        toolPath('ffprobe'),
        ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', path],
        30_000
      )
      .then((r) => (r.code === 0 ? r.stdout : ''))
      .catch(() => '')
    const sec = Number(
      (JSON.parse(out || '{}') as { format?: { duration?: string } }).format?.duration ?? NaN
    )
    return Number.isFinite(sec) && sec > 0 ? sec : null
  } catch {
    return null
  }
}

/** 封面抽取：videoPath 抽 1 帧 → covers/<id>.jpg；成功回写 videos.cover_path。
 * 失败静默留痕（封面缺失 → 前端占位图，不阻断登记） */
export async function generateCover(videoId: string, videoPath: string): Promise<void> {
  const out = join(coversDir(), `${videoId}.jpg`)
  try {
    const existing = await stat(out).then((s) => s.isFile()).catch(() => false)
    if (existing) {
      setCover(videoId, out)
      return
    }
    const dur = await probeDurationSec(videoPath)
    // 第十轮审查 P2：duration_sec 回填——此前该列永不写入（死列），封面墙时长
    // 角标恒「—」且 NFO <fileinfo><duration> 永不输出
    if (dur) {
      getDb().prepare('UPDATE videos SET duration_sec = ? WHERE id = ?').run(dur, videoId)
    }
    // 取 10% 处（长视频片头多为黑场/片头字幕）；探不到时长用 3s
    const pos = dur ? Math.min(dur * 0.1, 120) : 3
    await ensureVerified('ffmpeg')
    // runAux 为一次性执行（登记进程表 + 超时兜底），复用 ytdlp supervisor 通道
    const r = await getYtDlpSupervisor().runAux(
      toolPath('ffmpeg'),
      ['-y', '-ss', pos.toFixed(2), '-i', videoPath, '-frames:v', '1', '-vf', 'scale=640:-2', '-q:v', '4', out],
      60_000
    )
    if (r.code !== 0) throw new Error(`ffmpeg exit ${r.code}`)
    const size = await stat(out).then((s) => s.size).catch(() => 0)
    if (size < 1024) throw new Error('封面抽帧产物为空')
    setCover(videoId, out)
    log.info(`video cover generated: ${out}`)
  } catch (err) {
    log.warn(`video cover generation failed for ${videoId}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

function setCover(videoId: string, coverPath: string): void {
  getDb().prepare('UPDATE videos SET cover_path = ? WHERE id = ?').run(coverPath, videoId)
}
