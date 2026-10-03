// backlog #30（2026-10-03）：OpenSubtitles API 字幕匹配（工具箱过渡路线，不引入 Bazarr）
// 用户自备免费 API Key（api.opensubtitles.com 注册）；文件哈希精确匹配 → 下载 → 落盘到视频旁

import { inflateRawSync, gunzipSync } from 'zlib'

// ── OpenSubtitles 文件哈希（官方算法：size + 首/尾 64KB 逐 8 字节 LE 求和）──

/** 纯函数（单测覆盖）：输入文件大小与首/尾各 64KB 数据 → 16 位十六进制哈希 */
export function opensubtitlesFileHash(fileSize: number, head: Buffer, tail: Buffer): string {
  let hash = BigInt(fileSize)
  for (const buf of [head, tail]) {
    for (let off = 0; off + 8 <= buf.length; off += 8) {
      hash += buf.readBigUInt64LE(off)
    }
  }
  // 64 位无符号回绕（sum 溢出时按官方口径取模 2^64）
  if (hash < 0n) hash += 1n << 64n
  hash &= (1n << 64n) - 1n
  return hash.toString(16).padStart(16, '0')
}

// ── 最小 ZIP 读取（OpenSubtitles 下载产物常为 zip/gzip 包裹的 .srt）────────

/** 纯函数（单测覆盖）：从 zip 缓冲提取第一个条目（store/deflate）；失败返回 null */
export function extractFirstFromZip(buf: Buffer): Buffer | null {
  // EOCD（0x06054b50）从尾部向前找（注释区最长 65535）
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) return null
  const count = buf.readUInt16LE(eocd + 10)
  const cdOffset = buf.readUInt32LE(eocd + 16)
  let ptr = cdOffset
  for (let n = 0; n < count; n++) {
    if (ptr + 46 > buf.length || buf.readUInt32LE(ptr) !== 0x02014b50) return null
    const method = buf.readUInt16LE(ptr + 10)
    const compSize = buf.readUInt32LE(ptr + 20)
    const nameLen = buf.readUInt16LE(ptr + 28)
    const extraLen = buf.readUInt16LE(ptr + 30)
    const commentLen = buf.readUInt16LE(ptr + 32)
    const localOff = buf.readUInt32LE(ptr + 42)
    const name = buf.slice(ptr + 46, ptr + 46 + nameLen).toString('utf8')
    if (/\.(srt|vtt|ass|ssa)$/i.test(name)) {
      // 定位 local file header（0x04034b50），跳过其文件名/extra 字段取数据区
      if (localOff + 30 > buf.length || buf.readUInt32LE(localOff) !== 0x04034b50) return null
      const lNameLen = buf.readUInt16LE(localOff + 26)
      const lExtraLen = buf.readUInt16LE(localOff + 28)
      const dataStart = localOff + 30 + lNameLen + lExtraLen
      const data = buf.slice(dataStart, dataStart + compSize)
      try {
        return method === 0 ? Buffer.from(data) : inflateRawSync(data)
      } catch {
        return null
      }
    }
    ptr += 46 + nameLen + extraLen + commentLen
  }
  return null
}

/** 解包下载响应体：zip → 首个字幕条目；gzip → 解压；其余按原文（已是 srt） */
export function unwrapSubtitleBody(buf: Buffer): Buffer {
  if (buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b) {
    const inner = extractFirstFromZip(buf)
    if (!inner) throw new Error('字幕压缩包解析失败（zip 结构异常）')
    return inner
  }
  if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    return gunzipSync(buf)
  }
  return buf
}

// ── API 流程 ─────────────────────────────────────────────────────────

const API_BASE = 'https://api.opensubtitles.com/api/v1'

function apiHeaders(apiKey: string): Record<string, string> {
  return {
    'Api-Key': apiKey,
    Accept: 'application/json',
    'User-Agent': 'OmniGet v0.1.0'
  }
}

/** 完整流程：哈希匹配 → 下载 → 解包。返回字幕字节与推荐文件名 */
export async function fetchSubtitleForVideo(
  fileSize: number,
  head: Buffer,
  tail: Buffer,
  apiKey: string,
  languages: string
): Promise<{ body: Buffer; fileName: string; release?: string }> {
  const hash = opensubtitlesFileHash(fileSize, head, tail)
  const searchUrl = `${API_BASE}/subtitles?hash=${hash}&languages=${encodeURIComponent(languages)}`
  let searchRes: Response
  try {
    searchRes = await fetch(searchUrl, { headers: apiHeaders(apiKey), signal: AbortSignal.timeout(15_000) })
  } catch {
    throw new Error('OpenSubtitles 查询失败：网络不可达或超时')
  }
  if (searchRes.status === 401) throw new Error('API Key 无效（HTTP 401）：请到 api.opensubtitles.com 检查')
  if (searchRes.status === 406) throw new Error('配额已用尽（HTTP 406）：免费账号每日下载/查询次数有限，明日再试')
  if (!searchRes.ok) throw new Error(`OpenSubtitles 查询失败（HTTP ${searchRes.status}）`)
  const found = (await searchRes.json()) as {
    data?: Array<{ attributes?: { files?: Array<{ file_id?: number }>; release?: string } }>
  }
  const entry = (found.data ?? []).find((d) => typeof d?.attributes?.files?.[0]?.file_id === 'number')
  const fileId = entry?.attributes?.files?.[0]?.file_id
  if (!fileId) {
    throw new Error(`未找到与该视频哈希匹配的${languages}字幕（哈希匹配 = 内容级精确对应）`)
  }
  const dlRes = await fetch(`${API_BASE}/download`, {
    method: 'POST',
    headers: { ...apiHeaders(apiKey), 'Content-Type': 'application/json' },
    body: JSON.stringify({ file_id: fileId }),
    signal: AbortSignal.timeout(15_000)
  })
  if (dlRes.status === 406) throw new Error('每日下载配额已用尽（HTTP 406），明日再试')
  if (!dlRes.ok) throw new Error(`字幕下载授权失败（HTTP ${dlRes.status}）`)
  const dl = (await dlRes.json()) as { link?: string; file_name?: string }
  if (!dl.link) throw new Error('OpenSubtitles 未返回下载链接')
  const subRes = await fetch(dl.link, { signal: AbortSignal.timeout(30_000) })
  if (!subRes.ok) throw new Error(`字幕文件下载失败（HTTP ${subRes.status}）`)
  const body = Buffer.from(await subRes.arrayBuffer())
  return { body: unwrapSubtitleBody(body), fileName: dl.file_name || 'subtitle.srt', release: entry?.attributes?.release }
}
