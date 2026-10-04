// F1 试听流协议（omniget-preview://）：主进程流式代理网易云镜像音频，
// 替代原 omni-service 16801 端口代理；<audio> 直接播放，无端口/token 开销。
// 工具箱剪辑编辑器（本地媒体）复用同一协议：omniget-preview://local/<URL 编码的绝对路径>，
// 支持 Range 请求（视频/音频可拖动试听）。

import { app, protocol } from 'electron'
import { createReadStream } from 'fs'
import { realpath, stat } from 'fs/promises'
import { extname, isAbsolute } from 'path'
import { Readable } from 'stream'
import { createLogger } from '../logger'
import { getSettingParsed } from '../db'
import { SYSTEM_DIRS, credentialDirs, hitsAny, homeDir, persistenceDirs } from '../sensitive-paths'
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
 * 全盘媒体文件枚举读取通道（媒体类用户文件不在此列，正常剪辑试听不受影响）
 * M8 修复：盘符泛化（不再硬编码 c:）、拒绝 UNC/网络路径、userData 白名单豁免
 * （此前 AppData/Roaming 整目录被禁导致应用自身产物反而无法预览） */
function isSensitivePath(p: string): boolean {
  // 黑名单统一来自 ../sensitive-paths（跨平台审查：条目小写 + /private 归一 + 自启动目录）
  const norm = p.replace(/\\/g, '/').toLowerCase()
  // UNC / 网络路径（\\server\share）一律拒绝
  if (/^\/\//.test(norm)) return true
  if (hitsAny(norm, [...SYSTEM_DIRS, ...credentialDirs(), ...persistenceDirs()])) return true
  // 豁免：应用自身数据目录下的媒体产物（工具箱输出等）——须位于敏感目录检查之后
  try {
    const userData = app.getPath('userData').replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '')
    if (norm === userData || norm.startsWith(`${userData}/`)) return false
  } catch {
    // app 未就绪（单测环境）——按原口径继续
  }
  // AppData/Roaming 与 AppData/Local/Temp 仍禁（userData 豁免优先）
  const home = homeDir()
  const roamBlock = home ? [`${home}/appdata/roaming`, `${home}/appdata/local/temp`] : []
  return hitsAny(norm, roamBlock)
}

/** M4：纯文本产物允许的目录白名单（userData / 系统下载 / 用户配置下载目录） */
function isAppArtifactPath(p: string): boolean {
  const norm = p.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '')
  const candidates = new Set<string>()
  try {
    candidates.add(app.getPath('userData').replace(/\\/g, '/').toLowerCase().replace(/\/+$/, ''))
    candidates.add(app.getPath('downloads').replace(/\\/g, '/').toLowerCase().replace(/\/+$/, ''))
  } catch {
    // app 未就绪（单测）：userData 缺失则只认下载目录口径
  }
  try {
    const saveDir = getSettingParsed<string>('download.saveDir')
    if (typeof saveDir === 'string' && saveDir.trim()) {
      candidates.add(saveDir.trim().replace(/\\/g, '/').toLowerCase().replace(/\/+$/, ''))
    }
  } catch {
    // db 未就绪：忽略
  }
  return [...candidates].some((root) => norm === root || norm.startsWith(`${root}/`))
}

async function serveLocalMedia(rawPath: string, request: Request): Promise<Response> {
  try {
    if (!isAbsolute(rawPath)) return new Response('bad request', { status: 400 })
    // R4-P1 加固：先 realpath 规范化再过黑/白名单——WHATWG URL 对非特殊 scheme
    // 不做路径点归一化，`omniget-preview://local/c:/windows/../..` 会以字面串
    // 绕过前缀比对后由 fs 层解析 `..` 逃逸（与 taskParseFile/toolReveal 同口径）。
    // 显式含 `..`/`.` 段直接拒绝；软链/junction 由 realpath 消除。
    if (/(^|[\\/])\.\.?(?:[\\/]|$)/.test(rawPath)) {
      return new Response('forbidden', { status: 403 })
    }
    let path: string
    try {
      path = await realpath(rawPath)
    } catch {
      return new Response('not found', { status: 404 })
    }
    const type = LOCAL_MEDIA_TYPES[extname(path).toLowerCase()]
    if (!type) return new Response('unsupported media type', { status: 415 })
    if (isSensitivePath(path)) return new Response('forbidden', { status: 403 })
    // M4 加固：纯文本扩展（.txt/.srt/.md5 等）收窄到应用产物目录——媒体文件
    // 全盘可读尚属试听语义所需，但文本可外泄任意笔记/凭据文件，仅允许
    // userData / 系统下载目录 / 用户配置的下载目录三处
    if (type.startsWith('text/') && !isAppArtifactPath(path)) {
      return new Response('forbidden', { status: 403 })
    }
    const info = await stat(path)
    if (!info.isFile()) return new Response('not found', { status: 404 })
    const size = info.size

    const rangeHeader = request.headers.get('range')
    const rangeMatch = rangeHeader ? /bytes=(\d*)-(\d*)/.exec(rangeHeader) : null
    if (rangeMatch) {
      // L5 修复：suffix range（bytes=-N）语义为"文件末尾 N 字节"，此前被解析成 0..N
      let start: number
      let end: number
      if (!rangeMatch[1] && rangeMatch[2]) {
        const suffix = parseInt(rangeMatch[2], 10)
        start = Number.isFinite(suffix) ? Math.max(0, size - suffix) : 0
        end = size - 1
      } else {
        start = rangeMatch[1] ? parseInt(rangeMatch[1], 10) : 0
        end = rangeMatch[2] ? Math.min(parseInt(rangeMatch[2], 10), size - 1) : size - 1
      }
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
      // 远程封面代理（omniget-preview://remote?src=<https 图片直链>）：
      // 封面经主进程转发，渲染层不再直连第三方域暴露 IP（与试听链口径一致）
      if (url.host === 'remote') {
        const src = url.searchParams.get('src') ?? ''
        if (!/^https:\/\//i.test(src)) return new Response('bad request', { status: 400 })
        const { isInternalUrl } = await import('../net-guard')
        if (await isInternalUrl(src)) return new Response('forbidden', { status: 403 })
        const upstream = await openStream(src).catch(() => null)
        if (!upstream?.ok || !upstream.body) {
          // 审查修复：上游非 ok 时已打开的响应流必须释放（防 socket 悬挂累积）
          await (upstream?.body as { cancel?: () => Promise<void> } | undefined)
            ?.cancel?.()
            .catch(() => {})
          return new Response('upstream error', { status: 502 })
        }
        const type = /^image\//i.test(upstream.contentType)
          ? upstream.contentType
          : 'image/jpeg'
        // 第六轮审查：远程封面无大小上限——被投毒封面源可无限流灌内存/磁盘缓存
        //（音乐分支语义为音频流不设限，图片分支封顶 20MB：封面图远小于此）
        const IMAGE_CAP_BYTES = 20 * 1024 * 1024
        const capped = new TransformStream<Uint8Array, Uint8Array>()
        void (async () => {
          const reader = (upstream.body as ReadableStream<Uint8Array>).getReader()
          const writer = capped.writable.getWriter()
          let sent = 0
          try {
            for (;;) {
              const { done, value } = await reader.read()
              if (done) break
              sent += value.byteLength
              if (sent > IMAGE_CAP_BYTES) {
                await reader.cancel().catch(() => {})
                await writer.abort(new Error('image too large')).catch(() => {})
                return
              }
              await writer.write(value)
            }
            await writer.close()
          } catch {
            // 回归审查：渲染层取消加载（img 移除/导航）时 write 拒绝进入此分支——
            // 只 abort writer 不 cancel reader 会让 undici 上游连接滞留累积
            await reader.cancel().catch(() => {})
            await writer.abort().catch(() => {})
          }
        })()
        return new Response(capped.readable, {
          status: 200,
          headers: { 'Content-Type': type, 'Cache-Control': 'max-age=3600' }
        })
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
      // R6：透传 Range——渲染层 <audio> 拖动进度条时 Chromium 会发分段请求，
      // 不透传则只能顺序播放无法 seek
      const rangeHeader = request.headers.get('range')
      const upstream = await openStream(mirror, rangeHeader ? { Range: rangeHeader } : undefined)
      if (!upstream.ok || !upstream.body) {
        // 审查修复：同上，释放非 ok 上游流
        await (upstream.body as { cancel?: () => Promise<void> } | undefined)
          ?.cancel?.()
          .catch(() => {})
        return new Response('upstream error', { status: 502 })
      }
      const headers = new Headers({ 'Content-Type': upstream.contentType })
      if (upstream.contentLength) headers.set('Content-Length', upstream.contentLength)
      if (upstream.contentRange) headers.set('Content-Range', upstream.contentRange)
      if (upstream.acceptRanges) headers.set('Accept-Ranges', 'bytes')
      // undici body (web ReadableStream) → 全局 Response（protocol.handle 要求全局类系）
      return new Response(upstream.body as ReadableStream, { status: upstream.status, headers })
    } catch (err) {
      // 镜像不稳时静默断流（客户端 onerror 兜底）
      log.warn(`preview stream failed: ${String(err)}`)
      return new Response('stream error', { status: 502 })
    }
  })
}
