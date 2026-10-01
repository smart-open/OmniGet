// T5：种子创建（BT 分享/做种前置）：本地文件或目录 → .torrent
// bencode 编码（复用 parse 的 bencode 依赖，编解码同源保证 infohash 一致）
// + 逐片 SHA1（流式跨文件累积，大目录不占内存）。
import bencode from 'bencode'
import { createHash } from 'crypto'
import { createReadStream } from 'fs'
import { readFile, readdir, stat, writeFile } from 'fs/promises'
import { basename, join, relative } from 'path'
import { createLogger } from '../logger'

const log = createLogger('torrent-create')

export interface CreateTorrentOptions {
  /** tracker URL（可选；留空 = 纯 DHT 分发，可事后用工具补种） */
  announce?: string
  /** 分片大小（字节）；缺省按总大小自适应 */
  pieceLength?: number
  comment?: string
}

export interface CreateTorrentResult {
  outPath: string
  /** 40 位 hex 小写 */
  infohash: string
  totalBytes: number
  fileCount: number
}

interface SourceFile {
  /** 磁盘绝对路径 */
  abs: string
  /** 种子内相对路径段（多文件：[目录名, 子路径...]；单文件：[文件名]） */
  rel: string[]
  size: number
}

const MAX_PIECES = 20000 // 上限防护：防超大目录产生巨型 pieces 字段

function pickPieceLength(totalBytes: number): number {
  if (totalBytes < 64 * 1024 * 1024) return 256 * 1024
  if (totalBytes < 512 * 1024 * 1024) return 512 * 1024
  if (totalBytes < 2 * 1024 * 1024 * 1024) return 1024 * 1024
  return 4 * 1024 * 1024
}

async function walkDir(dir: string, base: string, out: SourceFile[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const abs = join(dir, e.name)
    if (e.isDirectory()) {
      await walkDir(abs, base, out)
    } else if (e.isFile()) {
      const st = await stat(abs)
      if (!st.isFile()) continue
      // P3 修复：零字节文件保留（length=0 条目）——此前静默丢弃会导致
      // 做种方与接收方目录不一致；分片生成器对 0 字节文件自然跳过
      out.push({ abs, rel: [basename(base), ...relative(base, abs).split(/[\\/]/)], size: st.size })
    }
  }
}

async function collectFiles(inputPath: string): Promise<{ files: SourceFile[]; totalBytes: number; name: string }> {
  const st = await stat(inputPath)
  const name = basename(inputPath)
  if (st.isFile()) {
    return { files: [{ abs: inputPath, rel: [name], size: st.size }], totalBytes: st.size, name }
  }
  if (!st.isDirectory()) throw new Error('仅支持文件或目录')
  const files: SourceFile[] = []
  await walkDir(inputPath, inputPath, files)
  if (files.length === 0) throw new Error('目录中没有可打包的文件')
  return { files, totalBytes: files.reduce((s, f) => s + f.size, 0), name }
}

/** 顺序跨文件产出 pieceLength 大小的分片（最后一片可能不足） */
async function* pieces(files: SourceFile[], pieceLength: number): AsyncGenerator<Buffer> {
  let buf = Buffer.alloc(0)
  for (const f of files) {
    const stream = createReadStream(f.abs, { highWaterMark: pieceLength })
    for await (const chunk of stream) {
      buf = Buffer.concat([buf, chunk as Buffer])
      while (buf.length >= pieceLength) {
        yield buf.subarray(0, pieceLength)
        buf = buf.subarray(pieceLength)
      }
    }
  }
  if (buf.length > 0) yield buf
}

export async function createTorrent(
  inputPath: string,
  outPath: string,
  options: CreateTorrentOptions = {}
): Promise<CreateTorrentResult> {
  const { files, totalBytes, name } = await collectFiles(inputPath)
  const pieceLength =
    options.pieceLength && options.pieceLength >= 16 * 1024
      ? options.pieceLength
      : pickPieceLength(totalBytes)
  const count = Math.ceil(totalBytes / pieceLength)
  if (count > MAX_PIECES) {
    throw new Error(
      `分片数 ${count} 超过上限 ${MAX_PIECES}：请调大分片大小后重试（当前自动 ${Math.round(pieceLength / 1024)}KB）`
    )
  }

  const hashes: Buffer[] = []
  for await (const piece of pieces(files, pieceLength)) {
    hashes.push(createHash('sha1').update(piece).digest())
  }
  log.info(
    `torrent created: ${files.length} files, ${totalBytes} bytes, ${hashes.length} pieces @ ${pieceLength}`
  )

  const multi = files.length > 1 || (files[0]?.rel.length ?? 1) > 1
  const info: Record<string, unknown> = {
    name,
    pieces: Buffer.concat(hashes),
    'piece length': pieceLength
  }
  if (multi) {
    info.files = files.map((f) => ({ length: f.size, path: f.rel.slice(1) }))
  } else {
    info.length = files[0]?.size ?? 0
  }

  const torrent: Record<string, unknown> = {
    info,
    announce: options.announce ?? '',
    'created by': 'OmniGet',
    'creation date': Math.floor(Date.now() / 1000)
  }
  if (options.comment) torrent.comment = options.comment

  // infohash 必须来自「写进文件的同一编码」：bencode 同源确定性编码（键排序），编解码一致
  const infohash = createHash('sha1').update(bencode.encode(info)).digest('hex')
  await writeFile(outPath, bencode.encode(torrent))
  return { outPath, infohash, totalBytes, fileCount: files.length }
}

/** T5：磁力生成（infohash → magnet:?xt=urn:btih:hex&dn=name&tr=...） */
export async function magnetFromTorrent(torrentPath: string): Promise<string> {
  const raw = await readFile(torrentPath)
  const data = bencode.decode(raw) as Record<string, unknown>
  const info = bencode.encode(data.info as Record<string, unknown>)
  const infohash = createHash('sha1').update(info).digest('hex')
  const dn = (() => {
    try {
      return (data.info as { name: Buffer }).name.toString('utf8')
    } catch {
      return ''
    }
  })()
  const announce = (() => {
    try {
      return (data.announce as Buffer).toString('utf8')
    } catch {
      return ''
    }
  })()
  // 注意：xt 的 urn:btih: 按规范不整体编码（URLSearchParams 会把 : 也编码）
  const params = [`xt=urn:btih:${infohash}`]
  if (dn) params.push(`dn=${encodeURIComponent(dn)}`)
  if (announce) params.push(`tr=${encodeURIComponent(announce)}`)
  return `magnet:?${params.join('&')}`
}
