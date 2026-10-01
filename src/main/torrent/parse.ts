// .torrent 本地解析流水线（M1-6，§4.2 五步）
// bencode → infohash(SHA1) → 文件树 → 磁力生成；base32→hex 归一化 + 脏字段容错。

import bencode from 'bencode'
import { createHash } from 'crypto'
import { readFileSync } from 'fs'
import type { TaskFile } from '@shared/types'
import { sanitizeFilename, sanitizeRelativePath } from '@shared/sanitize'

interface BDict { [key: string]: BencodeValue }
type BencodeValue = number | Buffer | BencodeValue[] | BDict

function decodeStr(buf: Buffer): string {
  // P3 修复：Buffer.toString('utf8') 永不抛错（非法序列替换为 U+FFFD），
  // 此前 try/catch 是死代码，注释声称的"脏字段容错"从未生效——
  // 现在主路径即做 FFFD 替换清理
  return buf.toString('utf8').replace(/\uFFFD/g, '')
}

export interface TorrentInfo {
  infohash: string // 40 位 hex 小写
  name: string
  files: TaskFile[]
  trackers: string[]
  magnet: string
}

/** 磁力 32 位 base32 infohash → 40 位 hex 归一化（查重键统一存 hex 小写） */
export function normalizeInfohash(raw: string): string {
  const s = raw.trim().toLowerCase()
  if (s.length === 40 && /^[0-9a-f]+$/.test(s)) return s
  if (s.length === 32) {
    // RFC4648 base32（磁力 urn:btih 默认字母表）
    const alpha = 'abcdefghijklmnopqrstuvwxyz234567'
    // R4-P3：32 位 btih 混入非法字符（0/1/8/9，短链生成器常见错误）时原样返回
    // 会造成同一资源 base32/hex 双查重键 → 重复任务；显式判非法并留痕
    let bits = 0
    let value = 0
    const out: number[] = []
    for (const ch of s) {
      const idx = alpha.indexOf(ch)
      if (idx === -1) {
        // 非法 base32：交回上层按非法磁力拒绝（不再静默原样返回）
        throw new Error(`磁力 infohash 含非法 base32 字符「${ch}」，请检查链接是否完整`)
      }
      value = (value << 5) | idx
      bits += 5
      if (bits >= 8) {
        out.push((value >>> (bits - 8)) & 0xff)
        bits -= 8
      }
    }
    return Buffer.from(out).toString('hex')
  }
  return s
}

function buildFileList(info: BDict): TaskFile[] {
  const files = info['files']
  if (Array.isArray(files)) {
    const list: TaskFile[] = []
    for (const f of files) {
      if (typeof f !== 'object' || f === null) continue
      const fd = f as BDict
      const pathParts = Array.isArray(fd['path'])
        ? (fd['path'] as Buffer[]).map((p) => sanitizeFilename(decodeStr(p as Buffer)))
        : []
      const length = typeof fd['length'] === 'number' ? fd['length'] : 0
      // P3 加固：与 aria2 轮询路径同口径——本地解析的路径也过清洗（恶意种子可携带
      // `..`/Windows 非法字符，删除与比对逻辑依赖相对路径口径一致）
      list.push({
        path: sanitizeRelativePath(pathParts.join('/')),
        size: length,
        selected: true,
        downloaded: 0
      })
    }
    return list
  }
  const name = sanitizeFilename(decodeStr(info['name'] as Buffer))
  const length = typeof info['length'] === 'number' ? info['length'] : 0
  return [{ path: name, size: length, selected: true, downloaded: 0 }]
}

function collectTrackers(data: BDict): string[] {
  const out: string[] = []
  const announceList = data['announce-list']
  if (Array.isArray(announceList)) {
    for (const tier of announceList) {
      if (Array.isArray(tier)) {
        for (const t of tier) out.push(decodeStr(t as Buffer))
      }
    }
  }
  if (out.length === 0 && typeof data['announce'] !== 'undefined') {
    out.push(decodeStr(data['announce'] as Buffer))
  }
  return [...new Set(out.filter(Boolean))]
}

export function generateMagnet(infohash: string, name: string, trackers: string[]): string {
  // magnet URI 约定：xt/dn/tr 分段以 & 连接，':' 等保留原样，仅对组件做必要转义
  const parts: string[] = [`xt=urn:btih:${infohash}`]
  if (name) parts.push(`dn=${encodeURIComponent(name)}`)
  // 磁力中最多携带 8 个 tracker（脚本约定）
  for (const tr of trackers.slice(0, 8)) {
    parts.push(`tr=${encodeURIComponent(tr)}`)
  }
  return `magnet:?${parts.join('&')}`
}

export function parseTorrent(data: Buffer): TorrentInfo {
  const decoded = bencode.decode(data) as BDict
  const info = decoded['info']
  if (typeof info !== 'object' || info === null) {
    throw new Error('种子文件无效：缺少 info 字典（文件可能已损坏）')
  }
  // Step1: info 重新 bencode 后计算 SHA1 得 infohash
  const infohash = createHash('sha1').update(bencode.encode(info)).digest('hex')

  const name =
    typeof (info as BDict)['name'] !== 'undefined'
      ? decodeStr((info as BDict)['name'] as Buffer)
      : ''

  // Step2: 文件树（多文件 files[] / 单文件 name+length）
  const files = buildFileList(info as BDict)

  // Step3: tracker 展开 + 磁力生成
  const trackers = collectTrackers(decoded)
  const magnet = generateMagnet(infohash, name, trackers)

  return { infohash, name, files, trackers, magnet }
}

export function parseTorrentFile(filePath: string): TorrentInfo {
  return parseTorrent(readFileSync(filePath))
}
