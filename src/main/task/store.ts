// 任务持久化（M1-1/M1-11）：tasks / task_files 表读写。

import type { Task, TaskStatus, TaskType, TaskFile } from '@shared/types'
import { getDb } from '../db'

interface TaskRow {
  id: string
  type: string
  params: string | null
  engine: string
  source: string
  name: string | null
  status: string
  save_dir: string
  total_bytes: number
  downloaded: number
  threads: number
  seed_ratio: number
  infohash: string | null
  format_id: string | null
  no_watermark: number | null
  wm_level: string | null
  quality: string | null
  engine_gid: string | null
  error: string | null
  created_at: number
  completed_at: number | null
  deleted_at: number | null
}

function rowToTask(r: TaskRow): Task {
  return {
    id: r.id,
    type: r.type as TaskType,
    source: r.source,
    name: r.name ?? '',
    engine: r.engine as Task['engine'],
    status: r.status as TaskStatus,
    saveDir: r.save_dir,
    totalBytes: r.total_bytes,
    downloadedBytes: r.downloaded,
    speedBps: 0,
    threads: r.threads,
    noWatermark: r.no_watermark === null ? undefined : r.no_watermark === 1,
    seedRatio: r.seed_ratio ?? 0,
    // engine_gid：WS 事件按 gid 匹配任务（缺失会导致音乐事件永不命中）
    engineGid: r.engine_gid ?? undefined,
    quality: (r.quality as Task['quality']) ?? undefined,
    params: r.params ?? undefined,
    createdAt: r.created_at,
    error: r.error ?? undefined
  }
}

const INSERT = `
  INSERT INTO tasks (id, type, params, engine, source, name, status, save_dir,
    total_bytes, downloaded, threads, seed_ratio, infohash, format_id,
    no_watermark, wm_level, quality, engine_gid, error, created_at, completed_at, deleted_at)
  VALUES (@id, @type, @params, @engine, @source, @name, @status, @saveDir,
    @totalBytes, @downloaded, @threads, @seedRatio, @infohash, @formatId,
    @noWatermark, @wmLevel, @quality, @engineGid, @error, @createdAt, @completedAt, @deletedAt)
`

export function insertTask(task: Task & { seedRatio?: number; infohash?: string; formatId?: string; wmLevel?: string; quality?: string; engineGid?: string }): void {
  getDb()
    .prepare(INSERT)
    .run({
      params: task.params ?? null,
      seedRatio: task.seedRatio ?? 0,
      infohash: null,
      formatId: null,
      noWatermark: task.noWatermark === undefined ? null : task.noWatermark ? 1 : 0,
      wmLevel: null,
      quality: task.quality ?? null,
      engineGid: null,
      error: task.error ?? null,
      createdAt: task.createdAt,
      completedAt: null,
      deletedAt: null,
      totalBytes: task.totalBytes,
      downloaded: task.downloadedBytes,
      name: task.name,
      saveDir: task.saveDir,
      threads: task.threads,
      status: task.status,
      engine: task.engine,
      source: task.source,
      type: task.type,
      id: task.id
    })
}

export function updateTaskFields(
  id: string,
  fields: Partial<{
    name: string
    status: TaskStatus
    totalBytes: number
    downloaded: number
    threads: number
    params: string | null
    engineGid: string | null
    infohash: string | null
    formatId: string | null
    wmLevel: string | null
    quality: string | null
    error: string | null
    completedAt: number | null
  }>
): void {
  const sets: string[] = []
  const args: Record<string, unknown> = { id }
  const map: Record<string, string> = {
    name: 'name',
    status: 'status',
    totalBytes: 'total_bytes',
    downloaded: 'downloaded',
    threads: 'threads',
    params: 'params',
    engineGid: 'engine_gid',
    infohash: 'infohash',
    formatId: 'format_id',
    wmLevel: 'wm_level',
    quality: 'quality',
    error: 'error',
    completedAt: 'completed_at'
  }
  for (const [k, col] of Object.entries(map)) {
    if (k in fields) {
      sets.push(`${col} = @${k}`)
      args[k] = fields[k as keyof typeof fields] ?? null
    }
  }
  if (sets.length === 0) return
  getDb()
    .prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = @id`)
    .run(args)
}

export function getTask(id: string): Task | null {
  const row = getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(id) as
    | TaskRow
    | undefined
  return row ? rowToTask(row) : null
}

export function listTasks(filter: {
  status?: TaskStatus[]
  type?: TaskType[]
  includeDeleted?: boolean
}): Task[] {
  const conds: string[] = []
  const args: Record<string, unknown> = {}
  if (!filter.includeDeleted) {
    conds.push('deleted_at IS NULL')
  } else {
    conds.push('deleted_at IS NOT NULL')
  }
  if (filter.status?.length) {
    conds.push(`status IN (${filter.status.map((_, i) => `@st${i}`).join(',')})`)
    filter.status.forEach((s, i) => (args[`st${i}`] = s))
  }
  if (filter.type?.length) {
    conds.push(`type IN (${filter.type.map((_, i) => `@ty${i}`).join(',')})`)
    filter.type.forEach((t, i) => (args[`ty${i}`] = t))
  }
  const rows = getDb()
    .prepare(
      `SELECT * FROM tasks WHERE ${conds.join(' AND ')} ORDER BY created_at DESC`
    )
    .all(args) as TaskRow[]
  return rows.map(rowToTask)
}

/** 侧栏角标计数（单条 SQL 全表口径，跨视图一致；10k 行内亚毫秒） */
export function taskCounts(): { running: number; queued: number; completed: number; trashed: number } {
  const row = getDb()
    .prepare(
      `SELECT
        COALESCE(SUM(CASE WHEN deleted_at IS NULL AND status = 'running' THEN 1 ELSE 0 END), 0) AS running,
        COALESCE(SUM(CASE WHEN deleted_at IS NULL AND status = 'queued' THEN 1 ELSE 0 END), 0) AS queued,
        COALESCE(SUM(CASE WHEN deleted_at IS NULL AND status = 'completed' THEN 1 ELSE 0 END), 0) AS completed,
        COALESCE(SUM(CASE WHEN deleted_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS trashed
      FROM tasks`
    )
    .get() as { running: number; queued: number; completed: number; trashed: number }
  return row
}

// B7：排除回收站任务（deleted_at 非 NULL 不可作为查重/补选目标）
export function findTaskByInfohash(infohash: string): Task | null {
  const row = getDb()
    .prepare(
      'SELECT * FROM tasks WHERE infohash = ? COLLATE NOCASE AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1'
    )
    .get(infohash) as TaskRow | undefined
  return row ? rowToTask(row) : null
}

/** 回收站：软删除；withFiles=true 仅为语义标记（文件删除由调用方执行） */
export function softDeleteTask(id: string): void {
  getDb().prepare('UPDATE tasks SET deleted_at = ? WHERE id = ?').run(Date.now(), id)
}

export function restoreTask(id: string): void {
  getDb().prepare('UPDATE tasks SET deleted_at = NULL WHERE id = ?').run(id)
}

/** 是否在回收站（彻底删除类操作的防线：非回收站任务禁止 purge） */
export function isTrashed(id: string): boolean {
  const row = getDb().prepare('SELECT deleted_at FROM tasks WHERE id = ?').get(id) as
    | { deleted_at: number | null }
    | undefined
  return row?.deleted_at != null
}

export function purgeTask(id: string): void {
  getDb().prepare('DELETE FROM tasks WHERE id = ?').run(id)
}

// ── task_files ───────────────────────────────────────────────────────

export function saveTaskFiles(taskId: string, files: TaskFile[]): void {
  const tx = getDb().transaction((items: TaskFile[]) => {
    getDb().prepare('DELETE FROM task_files WHERE task_id = ?').run(taskId)
    const ins = getDb().prepare(
      'INSERT INTO task_files (task_id, path, size, selected, downloaded) VALUES (?, ?, ?, ?, 0)'
    )
    for (const f of items) {
      ins.run(taskId, f.path, f.size, f.selected ? 1 : 0)
    }
  })
  tx(files)
}

export function setTaskFileSelection(taskId: string, selectedPaths: string[]): void {
  getDb().prepare('UPDATE task_files SET selected = 0 WHERE task_id = ?').run(taskId)
  const upd = getDb().prepare(
    'UPDATE task_files SET selected = 1 WHERE task_id = ? AND path = ?'
  )
  const tx = getDb().transaction((paths: string[]) => {
    for (const p of paths) upd.run(taskId, p)
  })
  tx(selectedPaths)
}

export function getTaskFiles(taskId: string): TaskFile[] {
  const rows = getDb()
    .prepare(
      'SELECT path, size, selected, downloaded FROM task_files WHERE task_id = ? ORDER BY id'
    )
    .all(taskId) as { path: string; size: number; selected: number; downloaded: number }[]
  // SQLite INTEGER → boolean 归一
  return rows.map((r) => ({
    path: r.path,
    size: r.size,
    selected: r.selected === 1,
    downloaded: r.downloaded ?? 0
  }))
}
