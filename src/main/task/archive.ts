// 已下载去重档案（backlog #22，spotDL sync / Pinchflat 范式）
// 两个文件，格式不同、职责不同：
// - download.archive（自有）：一行一个 `sha1:<hex>`（任务 source 归一化哈希）——
//   新建任务去重、订阅差集计算的判定底座
// - ytdlp.archive（yt-dlp 原生格式 `<extractor> <id>`）：经 --download-archive 传给
//   yt-dlp——合集内条目级去重 + extractor ID 记录；与自有文件分离避免格式互污

import { createHash } from 'crypto'
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { userDataDir } from '../env'
import { createLogger } from '../logger'

const log = createLogger('archive')

function archivePath(): string {
  return join(userDataDir(), 'download.archive')
}

export function ytdlpArchiveFile(): string {
  return join(userDataDir(), 'ytdlp.archive')
}

/** source URL → 档案键（归一化：trim + URL 规范化；sha1 防超长 URL/隐私明文落盘） */
export function archiveKey(source: string): string {
  return `sha1:${createHash('sha1').update(normalizeSourceUrl(source)).digest('hex')}`
}

/** 审查修复：URL 归一化——同一视频换链接形态（youtu.be、tracking 参数、尾斜杠、
 * http/https、fragment）此前全部判为不同键，去重对最常见场景失效 */
function normalizeSourceUrl(source: string): string {
  const raw = source.trim()
  try {
    const u = new URL(raw)
    u.protocol = 'https:'
    u.hash = ''
    // 常见追踪/分享参数（不存在时 delete 为 no-op）
    for (const p of [
      't',
      'si',
      'feature',
      'spm',
      'share_source',
      'share_medium',
      'share_token',
      'utm_source',
      'utm_medium',
      'utm_campaign'
    ]) {
      u.searchParams.delete(p)
    }
    // youtu.be 短链 → 标准 watch 链接
    if (u.hostname === 'youtu.be' && u.pathname.length > 1) {
      return `https://www.youtube.com/watch?v=${u.pathname.slice(1)}${
        u.search ? u.search : ''
      }`
    }
    let out = u.toString()
    if (out.endsWith('/')) out = out.slice(0, -1)
    return out
  } catch {
    return raw
  }
}

/** mtime 缓存：创建期逐任务读文件，mtime 未变直接命中 */
let cache: { m: number; keys: Set<string> } | null = null

function loadKeys(): Set<string> {
  const p = archivePath()
  if (!existsSync(p)) return new Set()
  const m = statSync(p).mtimeMs
  if (cache && cache.m === m) return cache.keys
  try {
    const keys = new Set(
      readFileSync(p, 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
    )
    cache = { m, keys }
    return keys
  } catch (err) {
    log.warn('download.archive 读取失败（按未收录处理）', err)
    return new Set()
  }
}

export function isArchived(source: string): boolean {
  return loadKeys().has(archiveKey(source))
}

/** 追加档案键（Set 语义：已存在不重复写） */
export function addArchiveKey(source: string): void {
  const key = archiveKey(source)
  if (loadKeys().has(key)) return
  try {
    appendFileSync(archivePath(), `${key}\n`, 'utf8')
    cache = null // 失效缓存（mtime 粒度不足以感知同秒两次追加）
  } catch (err) {
    log.warn('download.archive 追加失败', err)
  }
}

/** 审查修复：回滚档案键（订阅侧「入队即登记」后任务失败时调用，防失败条目被永久拉黑） */
export function removeArchiveKey(source: string): void {
  const key = archiveKey(source)
  const keys = loadKeys()
  if (!keys.has(key)) return
  try {
    const rest = [...keys].filter((k) => k !== key)
    writeFileSync(archivePath(), rest.length > 0 ? `${rest.join('\n')}\n` : '', 'utf8')
    cache = null
  } catch (err) {
    log.warn('download.archive 回滚失败', err)
  }
}
