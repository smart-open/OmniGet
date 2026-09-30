// F1 试听流协议（omniget-preview://）：主进程流式代理网易云镜像音频，
// 替代原 omni-service 16801 端口代理；<audio> 直接播放，无端口/token 开销。

import { protocol } from 'electron'
import { createLogger } from '../logger'
import { getMusicEngine } from './engine'
import { openStream } from './http'

const log = createLogger('music-preview')

export const PREVIEW_SCHEME = 'omniget-preview'

/** app.ready 前调用：注册特权 scheme（媒体流 + fetch 支持） */
export function registerPreviewScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: PREVIEW_SCHEME,
      privileges: { stream: true, supportFetchAPI: true, bypassCSP: false }
    }
  ])
}

/** app.ready 后调用：挂载协议处理器 */
export function registerPreviewHandler(): void {
  protocol.handle(PREVIEW_SCHEME, async (request) => {
    try {
      const url = new URL(request.url)
      if (url.host !== 'music') return new Response('not found', { status: 404 })
      const platform = url.searchParams.get('platform') ?? 'netease'
      const sid = url.searchParams.get('id') ?? ''
      const quality = url.searchParams.get('quality') ?? 'standard'
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
