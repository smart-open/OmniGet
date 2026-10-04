// better-sqlite3 封装 + 迁移框架（T0-4，§5 全表 DDL 一次建齐）
// 迁移可重放：以 user_version 记录版本，按序执行未应用的迁移，全程事务。

import Database from 'better-sqlite3'
import { mkdirSync } from 'fs'
import { join } from 'path'
import { createLogger } from '../logger'
import { userDataDir } from '../env'

const log = createLogger('db')

type Migration = { version: number; name: string; up: (db: Database.Database) => void }

// ── §5 数据模型 ──────────────────────────────────────────────────────
const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial-schema',
    up: (db) => {
      db.exec(`
        CREATE TABLE tasks (
          id            TEXT PRIMARY KEY,
          type          TEXT NOT NULL,
          params        TEXT,
          engine        TEXT NOT NULL,
          source        TEXT NOT NULL,
          name          TEXT,
          status        TEXT NOT NULL DEFAULT 'parsing',
          save_dir      TEXT NOT NULL,
          total_bytes   INTEGER DEFAULT 0,
          downloaded    INTEGER DEFAULT 0,
          threads       INTEGER DEFAULT 16,
          seed_ratio    REAL DEFAULT 0,
          infohash      TEXT,
          format_id     TEXT,
          no_watermark  INTEGER,
          wm_level      TEXT,
          quality       TEXT,
          engine_gid    TEXT,
          error         TEXT,
          created_at    INTEGER NOT NULL,
          completed_at  INTEGER,
          deleted_at    INTEGER
        );
        CREATE INDEX idx_tasks_status ON tasks(status, created_at DESC);
        CREATE INDEX idx_tasks_infohash ON tasks(infohash) WHERE infohash IS NOT NULL;

        CREATE TABLE task_files (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          path       TEXT NOT NULL,
          size       INTEGER NOT NULL,
          selected   INTEGER NOT NULL DEFAULT 1,
          downloaded INTEGER DEFAULT 0,
          UNIQUE(task_id, path)
        );

        CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

        CREATE TABLE trackers (url TEXT PRIMARY KEY, last_ok_at INTEGER, source TEXT);

        CREATE TABLE daily_stats (
          day             TEXT PRIMARY KEY,
          completed_count INTEGER DEFAULT 0,
          completed_bytes INTEGER DEFAULT 0,
          peak_speed_bps  INTEGER DEFAULT 0
        );
      `)
    }
  },
  {
    version: 2,
    name: 'subscriptions',
    up: (db) => {
      // R7 续（backlog #18）：订阅追更源
      db.exec(`
        CREATE TABLE subscriptions (
          id              TEXT PRIMARY KEY,
          name            TEXT NOT NULL,
          url             TEXT NOT NULL,
          interval_min    INTEGER NOT NULL DEFAULT 60,
          added_total     INTEGER NOT NULL DEFAULT 0,
          last_checked_at INTEGER,
          last_error      TEXT,
          created_at      INTEGER NOT NULL
        );
        CREATE INDEX idx_subscriptions_due ON subscriptions(last_checked_at);
      `)
    }
  }
]

let instance: Database.Database | null = null

export function getDb(): Database.Database {
  if (instance) return instance
  const dir = userDataDir()
  mkdirSync(dir, { recursive: true })
  instance = new Database(join(dir, 'omniget.db'))
  instance.pragma('journal_mode = WAL')
  instance.pragma('foreign_keys = ON')
  migrate(instance)
  return instance
}

export function migrate(db: Database.Database): void {
  const current = db.pragma('user_version', { simple: true }) as number
  // 第七轮审查 P3：降级场景（高版本应用建库后回退旧版）留痕——旧代码跑新 schema
  // 的运行期报错此前无任何版本线索
  const latest = MIGRATIONS.length > 0 ? MIGRATIONS[MIGRATIONS.length - 1]!.version : 0
  if (current > latest) {
    log.warn(`db schema user_version=${current} 高于应用支持的 ${latest}（应用降级运行，兼容性不保证）`)
  }
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue
    log.info(`applying migration ${m.version}: ${m.name}`)
    const tx = db.transaction(() => {
      m.up(db)
      db.pragma(`user_version = ${m.version}`)
    })
    tx()
  }
}

export function closeDb(): void {
  instance?.close()
  instance = null
}

// ── 常用封装 ─────────────────────────────────────────────────────────

export function getSetting(key: string): string | null {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  return row?.value ?? null
}

/**
 * 主进程侧读取设置：settingsSet 以 JSON.stringify 落库（渲染层 settingsGet 已做
 * 反序列化），主进程内部读取必须走本函数，否则读到带引号的 JSON 串污染路径/参数。
 * 反序列化失败回退原文（兼容历史裸文本值）。
 */
export function getSettingParsed<T = unknown>(key: string): T | null {
  const raw = getSetting(key)
  if (raw === null) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return raw as unknown as T
  }
}

export function setSetting(key: string, value: string): void {
  getDb()
    .prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    )
    .run(key, value)
}
