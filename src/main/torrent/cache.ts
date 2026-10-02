// 本地 .torrent 元数据缓存（R7 P0-3，docs/下载引擎优化方案 §三 P0-3）
// bt-save-metadata 产物收集进 userData/torrents/；同 infohash 的磁力任务
// 二次创建/启动时直接复用——元数据获取从「DHT 等待最长 90s」变为「本地秒出」。
// 命名口径：normalizeInfohash 后的 40 位 hex（查重键统一 hex 小写，与 DB 一致）。

import { copyFile, mkdir, readFile, rename } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { userDataDir } from '../env'
import { normalizeInfohash } from './parse'

function cacheDir(): string {
  return join(userDataDir(), 'torrents')
}

function cachePath(infohash: string): string {
  return join(cacheDir(), `${normalizeInfohash(infohash)}.torrent`)
}

/** 查询缓存：命中返回 .torrent 绝对路径，未命中/非法 infohash 返回 null */
export function findCachedTorrent(infohash: string | null | undefined): string | null {
  if (!infohash) return null
  const ih = normalizeInfohash(infohash)
  if (ih.length !== 40) return null
  const p = cachePath(ih)
  return existsSync(p) ? p : null
}

/** 读取缓存内容（base64，供 addTorrent 直接复用） */
export async function readCachedTorrent(infohash: string): Promise<string | null> {
  const p = findCachedTorrent(infohash)
  if (!p) return null
  try {
    return (await readFile(p)).toString('base64')
  } catch {
    return null
  }
}

/** 收集元数据产物进缓存：临时名 + rename 原子落位（copy 中途失败不留残缺目标） */
export async function cacheTorrentFile(srcPath: string, infohash: string): Promise<void> {
  const ih = normalizeInfohash(infohash)
  if (ih.length !== 40) return
  try {
    await mkdir(cacheDir(), { recursive: true })
    const target = cachePath(ih)
    if (existsSync(target)) return // 已有缓存（并发同磁力任务）：保留首个
    const staging = `${target}.${Date.now()}.tmp`
    await copyFile(srcPath, staging)
    await rename(staging, target)
  } catch (err) {
    // 缓存失败不阻断任务（只是下次要多等 DHT）
    const { createLogger } = await import('../logger')
    createLogger('torrent-cache').warn(`元数据缓存失败 ih=${ih}: ${String(err)}`)
  }
}
