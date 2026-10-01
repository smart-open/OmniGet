// F1 试听流协议（omniget-preview://）：主进程流式代理网易云镜像音频，
// 替代原 omni-service 16801 端口代理；<audio> 直接播放，无端口/token 开销。
// 工具箱剪辑编辑器（本地媒体）复用同一协议：omniget-preview://local/<URL 编码的绝对路径>，
// 支持 Range 请求（视频/音频可拖动试听）。

import { protocol } from 'electron'
import { createReadStream } from 'fs'
import { stat } from 'fs/promises'
import { extname, isAbsolute } from 'path'
import { Readable } from 'stream'
import { createLogger } from '../logger'
import { getMusicEngine } from './engine'
import { openStream } from './http'

const log = createLogger('music-preview')

export const PREVIEW_SCHEME = 'omniget-preview'

/** 本地媒体扩展名白名单：防止该协议被当作任意本地文件读取通道 */
const LOCAL_MEDIA_TYPES: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.wav': 'audio/wav',
  '.opus': 'audio/opus',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.mov': 'video/quicktime',
  '.ts': 'video/mp2t',
  // 工具箱产物预览：图片 + 纯文本（校验和 / 磁力 txt / 字幕）
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.txt': 'text/plain; charset=utf-8',
  '.srt': 'text/plain; charset=utf-8',
  '.ass': 'text/plain; charset=utf-8',
  '.vtt': 'text/plain; charset=utf-8',
  '.sha256': 'text/plain; charset=utf-8',
  '.sha1': 'text/plain; charset=utf-8',
  '.md5': 'text/plain; charset=utf-8'
}

/** app.ready 前调用：注册特权 scheme（媒体流 + fetch 支持） */
export function registerPreviewScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: PREVIEW_SCHEME,
      privileges: { stream: true, supportFetchAPI: true, bypassCSP: false }
    }
  ])
}

/** 本地媒体流（Range 支持：<video>/<audio> 拖动进度必需）。
 * P3 加固：扩展名白名单之外再挡系统/敏感目录——防被攻破的渲染层把该协议当
 * 全盘媒体文件枚举读取通道（媒体类用户文件不在此列，正常剪辑试听不受影响） */
function isSensitivePath(p: string): boolean {
  const norm = p.replace(/\\/g, '/').toLowerCase()
  const profile = (process.env.USERPROFILE ?? process.env.HOME ?? '').replace(/\\/g, '/')
  const blocked = [
    'c:/windows',
    'c:/program files',
    'c:/program files (x86)',
    '/usr', '/etc', '/bin', '/sbin', '/boot', '/proc', '/sys', '/dev',
    profile ? `${profile}/.ssh` : '',
    profile ? `${profile}/.gnupg` : '',
    profile ? `${profile}/AppData/Roaming` : '',
    profile ? `${profile}/Library/Keychains` : ''
  ].filter(Boolean)
  return blocked.some((d) => norm === d || norm.startsWith(`${d}/`))
}

async function serveLocalMedia(path: string, request: Request): Promise<Response> {
  try {
    if (!isAbsolute(path)) return new Response('bad request', { status: 400 })
    const type = LOCAL_MEDIA_TYPES[extname(path).toLowerCase()]
    if (!type) return new Response('unsupported media type', { status: 415 })
    if (isSensitivePath(path)) return new Response('forbidden', { status: 403 })
    const info = await stat(path)
    if (!info.isFile()) return new Response('not found', { status: 404 })
    const size = info.size

    const rangeHeader = request.headers.get('range')
    const rangeMatch = rangeHeader ? /bytes=(\d*)-(\d*)/.exec(rangeHeader) : null
    if (rangeMatch) {
      let start = rangeMatch[1] ? parseInt(rangeMatch[1], 10) : 0
      let end = rangeMatch[2] ? Math.min(parseInt(rangeMatch[2], 10), size - 1) : size - 1
      if (!Number.isFinite(start) || start < 0 || start > end || start >= size) {
        return new Response(null, {
          status: 416,
          headers: { 'Content-Range': `bytes */${size}` }
        })
      }
      end = Math.min(end, size - 1)
      const stream = createReadStream(path, { start, end })
      return new Response(Readable.toWeb(stream) as ReadableStream, {
        status: 206,
        headers: {
          'Content-Type': type,
          'Content-Length': String(end - start + 1),
          'Content-Range': `bytes ${start}-${end}/${size}`,
          'Accept-Ranges': 'bytes'
        }
      })
    }

    const stream = createReadStream(path)
    return new Response(Readable.toWeb(stream) as ReadableStream, {
      status: 200,
      headers: {
        'Content-Type': type,
        'Content-Length': String(size),
        'Accept-Ranges': 'bytes'
      }
    })
  } catch {
    // 文件被移动/删除：404 即可（渲染层 onerror 兜底提示）
    return new Response('not found', { status: 404 })
  }
}

/** app.ready 后调用：挂载协议处理器 */
export function registerPreviewHandler(): void {
  protocol.handle(PREVIEW_SCHEME, async (request) => {
    try {
      const url = new URL(request.url)
      // 本地媒体分支（工具箱剪辑试听）
      if (url.host === 'local') {
        const p = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
        return serveLocalMedia(p, request)
      }
      if (url.host !== 'music') return new Response('not found', { status: 404 })
      const platform = url.searchParams.get('platform') ?? 'netease'
      const sid = url.searchParams.get('id') ?? ''
      const quality = url.searchParams.get('quality') ?? 'standard'
      // 纵深防御：入口即校验（engine.previewUrl 内部还有同口径校验）
      if (platform !== 'netease' || !/^\d{1,20}$/.test(sid)) {
        return new Response('bad request', { status: 400 })
      }
      const mirror = await getMusicEngine().previewUrl(platform, sid, quality)
      if (!mirror) return new Response('preview unavailable', { status: 404 })
      const upstream = await openStream(mirror)
      if (!upstream.ok || !upstream.body) {
        return new Response('upstream error', { status: 502 })
      }
      const headers = new Headers({ 'Content-Type': upstream.contentType })
      if (upstream.contentLength) headers.set('Content-Length', upstream.contentLength)
      // undici body (web ReadableStream) → 全局 Response（protocol.handle 要求全局类系）
      return new Response(upstream.body as ReadableStream, { status: 200, headers })
    } catch (err) {
      // 镜像不稳时静默断流（客户端 onerror 兜底）
      log.warn(`preview stream failed: ${String(err)}`)
      return new Response('stream error', { status: 502 })
    }
  })
}
