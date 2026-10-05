// aria2 适配器（M1-3/M1-5/M1-7，§4.2）
// parse：磁力 BEP-9（addUri pause:true → metadata → getFiles，元数据落临时目录）；HTTP HEAD 探测
// start：addUri/addTorrent 注入 select-file + dir；磁力 re-add 走 BEP-9 后回放勾选（§4.5）
// 事件流：轮询 tellStatus → TaskEvent（由管理器按 250ms 窗口合并）
// 路径口径：task_files 存相对路径（§5）；aria2 绝对路径经 dir 前缀裁剪归一。

import type { Task, TaskEvent, TaskFile } from '@shared/types'
import { makeError } from '@shared/errors'
import { sanitizeFilename, sanitizeRelativePath } from '@shared/sanitize'
import { readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { generateMagnet, normalizeInfohash, parseTorrentFile } from '../torrent/parse'
import { cacheTorrentFile, findCachedTorrent, readCachedTorrent } from '../torrent/cache'
import { parseParamsJson, readTaskOriginUrl, readTaskOutName, readTaskSpeedLimit, readTaskUrls } from '../task/params'
import { buildTaskOptions } from '../aria2/options'
import { createLogger } from '../logger'
import { diagnose } from '../diagnosis'
import { recordPlatformFailure } from '../health'
import type { EngineAdapter, EngineHealthInfo, ParseOutput } from './types'
import type { Aria2Supervisor } from '../orchestrator/aria2'

const log = createLogger('aria2-adapter')

const METADATA_TIMEOUT_MS = 90_000 // 磁力元数据超时（§11 风险 #5）
const HTTP_PROBE_TIMEOUT_MS = 10_000

/** R7 续审查加固：短视频直链（douyin/kuaishou CDN）常校验 UA/referer——
 * sidecar 兜底任务的探测与下载统一用浏览器 UA + 原分享页 referer */
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

/** 探测响应 → 预期完整体积：GET Range 兜底（206）经 content-range 取总长，
 * 其余回落 content-length（与镜像 content-length 一致性校验同一口径） */
function probeTotalLen(res: Response): number {
  const cr = res.headers.get('content-range') // 形如 bytes 0-0/12345
  if (cr) {
    const m = /\/(\d+)\s*$/.exec(cr)
    if (m) return Number(m[1])
  }
  return Number(res.headers.get('content-length') ?? 0)
}

/** P3 修复：磁力元数据临时目录统一清理（%TEMP%/omniget-metadata/<taskId> 此前从不删除） */
function cleanupMetadataDir(metaDir: string): void {
  void import('fs/promises').then(({ rm }) =>
    rm(metaDir, { recursive: true, force: true }).catch(() => {})
  )
}

/** 第六轮审查：放弃确认的磁力任务（parse 成功后用户关闭对话框永不确认）的
 * 元数据目录无人回收，累积至进程退出——启动时清扫 mtime 超 24h 的陈旧目录
 *（活跃 awaiting 任务目录是新写的，不会被误删） */
export function cleanupStaleMetadataDirs(): void {
  void (async () => {
    const { readdir, rm, stat } = await import('fs/promises')
    const root = join(tmpdir(), 'omniget-metadata')
    const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
    const stale = Date.now() - 24 * 60 * 60 * 1000
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const dir = join(root, e.name)
      const m = await stat(dir)
        .then((s) => s.mtimeMs)
        .catch(() => 0)
      if (m > 0 && m < stale) {
        await rm(dir, { recursive: true, force: true }).catch(() => {})
      }
    }
  })()
}

interface Aria2Status {
  gid: string
  status: string
  dir?: string
  totalLength: string
  completedLength: string
  downloadSpeed: string
  connections?: string
  numSeeders?: string
  infoHash?: string
  errorMessage?: string
  files?: { index: string; path: string; length: string; selected: string }[]
  bittorrent?: { info?: { name?: string } }
}

/** start/恢复时随任务注入的勾选集（相对路径或 1-based 索引，二选一或同时） */
export interface SelectionHint {
  indexes?: number[]
  paths?: string[]
  /** P1 加固：增量补下（re-add 凭已存在文件秒校验）显式放行覆盖；新任务默认拒绝 */
  allowOverwrite?: boolean
}

export class Aria2Adapter implements EngineAdapter {
  constructor(private readonly supervisor: Aria2Supervisor) {}

  private rpc() {
    return this.supervisor.getClient()
  }

  /** R7 P0-3：磁力任务的 bt-tracker = 订阅源 ∪ 磁力自带 tr=（每任务选项，
   * 不写则继承全局订阅源；写则须显式并集防覆盖） */
  private magnetTrackerMerge(source: string): Record<string, string> {
    const extras = extractMagnetTrackers(source)
    if (extras.length === 0) return {}
    try {
      // 惰性 import：trackers 依赖 db，避免适配器在非主进程上下文被连坐初始化
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { joinedTrackers } = require('../trackers') as typeof import('../trackers')
      const globalCsv = joinedTrackers()
      const seen = new Set(globalCsv.split(',').filter(Boolean))
      const fresh = extras.filter((t) => !seen.has(t))
      if (fresh.length === 0) return {}
      // 审查修复：按条截断（此前 slice 会从中间截断最后一个 URL 产生畸形 tracker）
      const parts: string[] = []
      let total = 0
      for (const t of [...globalCsv.split(',').filter(Boolean), ...fresh]) {
        const add = t.length + (parts.length ? 1 : 0)
        if (total + add > 8000) break
        parts.push(t)
        total += add
      }
      return { 'bt-tracker': parts.join(',') }
    } catch {
      // 订阅源不可用时仅用磁力自带 tr
      return { 'bt-tracker': extras.join(',') }
    }
  }

  /** getGlobalStat 缓存（pollEvents 每 1s 顺带刷新；托盘/状态栏上传速度数据源） */
  private lastGlobalStat = { down: 0, up: 0 }

  globalStat(): { down: number; up: number } {
    return this.lastGlobalStat
  }

  async health(): Promise<EngineHealthInfo> {
    if (!this.supervisor.isOnline) return { online: false, detail: 'aria2 offline' }
    try {
      await this.rpc().call('getVersion')
      return { online: true }
    } catch (err) {
      return { online: false, detail: String(err) }
    }
  }

  // ── parse ──────────────────────────────────────────────────────────

  async parse(task: Task, isAborted?: () => boolean): Promise<ParseOutput> {
    if (task.type === 'magnet') return this.parseMagnet(task, isAborted)
    if (task.type === 'bt') return this.parseTorrent(task)
    if (task.type === 'http') return this.parseHttp(task)
    throw new Error(`aria2 适配器不支持的任务类型：${task.type}`)
  }

  /** 磁力 BEP-9 四步（§4.2）：addUri(pause:true, bt-save-metadata) → 等 metadata → getFiles。
   * R7 P0-3：本地 .torrent 缓存命中时零引擎依赖秒出文件树（跳过 DHT 等待） */
  private async parseMagnet(task: Task, isAborted?: () => boolean): Promise<ParseOutput> {
    const infohash = extractInfohash(task.source)

    // R7：本地元数据缓存快路径——同 infohash 曾解析过（.torrent 已收集）直接本地解析
    const cached = findCachedTorrent(infohash)
    if (cached) {
      try {
        const info = parseTorrentFile(cached)
        if (info.files.length > 0) {
          log.info(`磁力元数据缓存命中 ih=${info.infohash}（${info.files.length} 文件）`)
          return {
            name: info.name,
            files: info.files,
            totalBytes: info.files.reduce((s, f) => s + f.size, 0),
            infohash: info.infohash,
            magnet: info.magnet
          }
        }
      } catch (err) {
        log.warn(`缓存的 .torrent 解析失败，回退 BEP-9: ${String(err)}`)
      }
    }

    // D2：元数据落盘到临时目录（不污染用户保存目录）
    const metaDir = join(tmpdir(), 'omniget-metadata', task.id)
    const gid = (await this.rpc().call('addUri', [task.source], {
      dir: metaDir,
      'bt-save-metadata': 'true',
      pause: 'true', // 必须 pause:true：否则元数据到达后立刻全量下载（§4.2）
      ...this.magnetTrackerMerge(task.source)
    })) as string

    // 等 metadata：轮询 tellStatus 直到 status=complete
    // P2 修复：轮询体内 tellStatus RPC 异常（aria2 重启/超时）此前直接上抛，
    // pause 态 gid 与 metaDir 均泄漏——统一收口到 finally
    let succeeded = false
    try {
      const deadline = Date.now() + METADATA_TIMEOUT_MS
      while (Date.now() < deadline) {
        // A3：任务在解析期间被删除/回收 → 立即移除暂停态 gid 并退出，
        // 防 90s 窗口内 aria2 侧任务泄漏（此时 DB 的 engineGid 尚未落库，remove 路径够不到它）
        if (isAborted?.()) {
          throw new Error('任务已删除')
        }
        const st = (await this.rpc().call('tellStatus', gid)) as Aria2Status
        // B1：元数据下载阶段 files 只有 <name>.torrent 本体，过滤之（BEP-9 勾选面板只呈现真实内容文件）
        const files = this.statusToFiles(st).filter((f) => !f.path.endsWith('.torrent'))
        if (st.status === 'complete' && files.length > 0) {
          const name = st.bittorrent?.info?.name ?? files[0]?.path.split('/')[0] ?? task.source
          const ih = normalizeInfohash(st.infoHash ?? infohash ?? '')
          succeeded = true
          // R7 P0-3：元数据产物收集进本地缓存（同 infohash 二次任务秒出文件树）
          if (ih) {
            const { readdir } = await import('fs/promises')
            const saved = await readdir(metaDir).catch(() => [] as string[])
            const torrentFile = saved.find((f) => f.toLowerCase().endsWith('.torrent'))
            if (torrentFile) void cacheTorrentFile(join(metaDir, torrentFile), ih)
          }
          return {
            name,
            files,
            totalBytes: files.reduce((s, f) => s + f.size, 0),
            infohash: ih || undefined,
            magnet: ih ? generateMagnet(ih, name, []) : undefined,
            pendingGid: gid // 保留暂停态 gid，确认勾选时 changeOption+unpause
          }
        }
        if (st.status === 'error' || st.status === 'removed') {
          // P3 修复：error/removed ≠ 超时——此前一律抛 METADATA_TIMEOUT，
          // "链接无效/无种"也被文案包装成"超时（90s）"，出口动作误导
          throw makeError('METADATA_TIMEOUT', {
            message: `磁力元数据获取失败${st.errorMessage ? `（${st.errorMessage}）` : ''}。请确认链接有效或有可用节点，或改用 .torrent 文件创建任务`
          })
        }
        await sleep(1000)
      }
      // 超时（R7：带出口动作——冷门种建议改用 .torrent 文件）
      throw makeError('METADATA_TIMEOUT', {
        message:
          '磁力元数据获取超时（90s）：种子冷门或 DHT 连通性差。建议改用 .torrent 文件创建任务，或稍后重试'
      })
    } finally {
      if (!succeeded) {
        await this.rpc().call('remove', gid).catch(() => {})
        cleanupMetadataDir(metaDir)
      }
    }
  }

  /** .torrent：本地解析零引擎依赖（§4.2） */
  private async parseTorrent(task: Task): Promise<ParseOutput> {
    const { stripFileProtocol } = await import('../sniffer')
    const torrentPath = stripFileProtocol(task.source)
    const info = parseTorrentFile(torrentPath)
    return {
      name: info.name,
      files: info.files,
      totalBytes: info.files.reduce((s, f) => s + f.size, 0),
      infohash: info.infohash,
      magnet: info.magnet
    }
  }

  /** R7 续审查加固：单 URL 探测（HEAD 优先；调用方在 HEAD 被拒时以 GET Range 重试）。
   * 第十轮审查 P3：改手动重定向逐跳内网校验——redirect:'follow' 时中间跳若是内网
   * （公网 302 → 内网 → 302 回公网），请求会真实打到内网（盲探测），仅复核最终
   * URL 拦不住（对齐 music/http.ts openStream / nm3u8 fetchManifestText 口径） */
  private async probeHttpUrl(
    url: string,
    method: 'HEAD' | 'GET',
    headers?: Record<string, string>
  ): Promise<Response> {
    const { isInternalUrl } = await import('../net-guard')
    if (await isInternalUrl(url)) {
      throw new Error('该链接指向内网/回环地址，已拦截')
    }
    let current = url
    for (let hop = 0; ; hop++) {
      const res = await fetch(current, {
        method,
        redirect: 'manual',
        headers,
        signal: AbortSignal.timeout(HTTP_PROBE_TIMEOUT_MS)
      })
      const location = res.headers.get('location')
      if (res.status >= 300 && res.status < 400 && location) {
        await res.body?.cancel().catch(() => {})
        if (hop >= 3) throw new Error('重定向次数超限')
        const next = new URL(location, current)
        if (next.protocol !== 'https:' && next.protocol !== 'http:') {
          throw new Error(`重定向协议不允许：${next.protocol}`)
        }
        if (await isInternalUrl(next.toString())) {
          throw new Error('该链接重定向至内网/回环地址，已中止探测。')
        }
        current = next.toString()
        continue
      }
      return res
    }
  }

  /** HTTP 直链 HEAD 探测（M1-7）：大小/文件名嗅探；带超时防挂起。
   * R7 P1 多源：task.params.urls 携带多个同文件镜像时逐个探测，
   * 仅保留与主 URL content-length 完全一致的镜像（防错拼不同文件） */
  private async parseHttp(task: Task): Promise<ParseOutput> {
    // M3 修复：拒绝内网/回环目标——主进程代发探测并回显响应头不得成为内网探测通道
    const { isInternalUrl } = await import('../net-guard')
    const candidateUrls = readTaskUrls(task)
    // R7 续审查加固：sidecar 兜底任务的直链常校验 UA/referer——探测与下载同源伪装
    const originUrl = readTaskOriginUrl(task)
    const probeHeaders: Record<string, string> | undefined = originUrl
      ? { 'user-agent': BROWSER_UA, referer: originUrl }
      : undefined
    // R7 续修复（backlog #11）：sidecar 任务预检宽容放行——直链由解析服务刚签发，
    // 预检失败多为环境差异（TLS 指纹/网络路径），不判死任务，错误交给下载段暴露
    //（重试前 manager 会自动重问解析服务刷新时效直链）
    const lenient = !!originUrl
    const probed: { url: string; len: number; res: Response }[] = []
    let primary: { url: string; len: number; res: Response } | null = null
    for (const url of candidateUrls) {
      if (await isInternalUrl(url)) {
        if (url === task.source) {
          throw makeError('PARSE_FAILED', {
            message: '该链接指向内网/回环地址，不允许探测与下载。'
          })
        }
        log.warn(`多源镜像指向内网，已剔除: ${url}`)
        continue
      }
      try {
        // R7 续审查加固：HEAD 被拒（部分 CDN/网关仅允许 GET，403/405 等）时以
        // GET Range: bytes=0-0 兜底探测（206 经 content-range 取总长），两法皆败才判失败
        let res = await this.probeHttpUrl(url, 'HEAD', probeHeaders).catch(() => null)
        if (!res || !res.ok) {
          const viaGet = await this.probeHttpUrl(url, 'GET', probeHeaders)
            .then((r) => (r.ok ? r : null))
            .catch(() => null)
          if (viaGet) {
            await res?.body?.cancel().catch(() => {}) // 消费被拒响应体，防 socket 挂起
            res = viaGet
          }
        }
        if (!res || !res.ok) {
          const status = res?.status ?? 0
          await res?.body?.cancel().catch(() => {})
          if (url === task.source) {
            if (lenient) {
              log.warn(
                `sidecar 直链预检失败（HTTP ${status || '网络异常'}），跳过预检直接下载: ${url}`
              )
              break
            }
            const timedOut = status === 0 || [408, 425].includes(status) || status >= 500
            throw makeError(timedOut ? 'HTTP_TIMEOUT' : 'PARSE_FAILED', {
              message:
                status === 429
                  ? '直链探测失败（HTTP 429）：请求过于频繁被服务端限流，请稍后重试。'
                  : status === 0
                    ? '直链探测失败：网络不可达或超时，请检查链接后重试。'
                    : `直链探测失败（HTTP ${status}）。请检查链接是否有效后重试。`
            })
          }
          log.warn(`多源镜像探测失败（HTTP ${status}），已剔除: ${url}`)
          continue
        }
        // 重定向后的最终地址同样不得落在内网（防公网 302 跳内网）
        if (res.url && res.url !== url && (await isInternalUrl(res.url))) {
          await res.body?.cancel().catch(() => {})
          if (url === task.source) {
            throw makeError('PARSE_FAILED', {
              message: '该链接重定向至内网/回环地址，已中止探测。'
            })
          }
          log.warn(`多源镜像重定向至内网，已剔除: ${url}`)
          continue
        }
        const len = probeTotalLen(res)
        await res.body?.cancel().catch(() => {}) // GET 兜底的 206 体必须消费，防 socket 挂起
        const entry = { url, len, res }
        if (!primary) primary = entry
        else if (len === primary.len) probed.push(entry)
        // 第十轮审查 P3：primary 无 content-length（len=0）时等长(0)镜像不再被
        // 误剔除——否则多源并下载对该站点整体失效
        else {
          log.warn(`多源镜像大小不一致（${len} ≠ ${primary.len}），已剔除: ${url}`)
        }
      } catch (err) {
        if (url === task.source) throw err
        log.warn(`多源镜像探测异常，已剔除: ${url} (${String(err)})`)
      }
    }
    if (!primary) {
      if (lenient) {
        const outName = readTaskOutName(task)
        const name = outName || 'video.mp4'
        log.warn(`sidecar 直链预检未通过，跳过预检直接尝试下载: ${task.source}`)
        return {
          name,
          totalBytes: 0,
          files: [{ path: name, size: 0 }],
          mirrors: [task.source]
        }
      }
      throw makeError('PARSE_FAILED', {
        message: '全部镜像探测失败，请检查链接是否有效后重试。'
      })
    }
    const res = primary.res
    // R7 多源：探测通过的镜像写回 params.urls（start 时 addUri 多 URI 并行）
    const mirrors = [primary.url, ...probed.map((p) => p.url)]
    if (mirrors.length > 1) {
      log.info(`多源下载：${mirrors.length} 个镜像通过 content-length 校验`)
    }
    const len = probeTotalLen(res)
    const cd = res.headers.get('content-disposition') ?? ''
    const m = /filename\*?=(?:UTF-8'')?"?([^";]+)/i.exec(cd)
    // P3 修复：畸形百分号编码（如 /b%c/x.mp4）会抛 URIError 裸异常，回退原始路径
    const rawName = new URL(res.url || task.source).pathname.split('/').pop() ?? ''
    const urlName = (() => {
      try {
        return decodeURIComponent(rawName)
      } catch {
        return rawName
      }
    })()
    const name = sanitizeFilename(m?.[1] || urlName || 'download')
    // R7 续（backlog #11）：sidecar 兜底任务携带解析服务标题产物名——CDN 直链
    // 路径无文件名（哈希段），默认命名不可读；与 aria2 start 的 out 选项同源
    const finalName = readTaskOutName(task) || name
    return {
      name: finalName,
      totalBytes: len,
      files: [{ path: finalName, size: len }],
      // 审查修复：恒返回（至少含主 URL）——manager 据此回写 params.urls，
      // 保证未通过校验的原始镜像不会残留在 params 里被 start() 直接使用
      mirrors
    }
  }

  /**
   * aria2 绝对路径 → 相对路径（§5：task_files.path 用 / 分层相对路径）。
   * 基准 = st.dir（aria2 任务下载目录）。
   */
  private statusToFiles(st: Aria2Status): TaskFile[] {
    const dir = (st.dir ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
    return (st.files ?? []).map((f) => {
      const norm = f.path.replace(/\\/g, '/')
      const rel =
        dir && norm.toLowerCase().startsWith(dir.toLowerCase() + '/')
          ? norm.slice(dir.length + 1)
          : norm
      return {
        path: sanitizeRelativePath(rel),
        size: Number(f.length),
        selected: f.selected === 'true',
        downloaded: 0
      }
    })
  }

  // ── start / control ────────────────────────────────────────────────

  /**
   * 启动任务。
   * - bt：addTorrent 注入 select-file（来自 selection.indexes，即 task_files 顺序）
   * - magnet：BEP-9 二次获取元数据（pause 态）→ 按路径回放 select-file → unpause（§4.5 re-add）
   * - http：addUri
   */
  async start(task: Task, selection?: SelectionHint): Promise<string> {
    const opts = buildTaskOptions({
      type: task.type === 'bt' || task.type === 'magnet' ? 'bt' : 'http',
      threads: task.threads,
      saveDir: task.saveDir,
      seedRatio: task.seedRatio ?? 0,
      allowOverwrite: selection?.allowOverwrite === true
    })
    // R7 P1：单任务限速（params.speedLimit；changeOption 合并语义下无需在每个
    // 后续 changeOption 重复携带，unpause/勾选回放不会清除）
    const speedLimit = readTaskSpeedLimit(task)
    if (speedLimit) opts['max-download-limit'] = speedLimit

    try {
      if (task.type === 'bt') {
        const { stripFileProtocol } = await import('../sniffer')
        const base64 = readFileSync(stripFileProtocol(task.source)).toString('base64')
        if (selection?.indexes?.length) {
          opts['select-file'] = selection.indexes.join(',')
        }
        return (await this.rpc().call('addTorrent', base64, [], opts)) as string
      }

      if (task.type === 'magnet') {
        // R7 P0-3：本地元数据缓存命中 → 直接 addTorrent（跳过二次 BEP-9 元数据等待）
        const ih = extractInfohash(task.source)
        const cachedBase64 = ih ? await readCachedTorrent(ih) : null
        if (cachedBase64) {
          log.info(`磁力启动走本地元数据缓存 ih=${ih ?? ''}`)
          const gid = (await this.rpc().call('addTorrent', cachedBase64, [], {
            ...opts,
            pause: 'true'
          })) as string
          let ok = false
          try {
            if (selection?.paths?.length) {
              await this.applySelectionByPath(gid, selection.paths, task.threads, task.saveDir, task.seedRatio ?? 0)
            }
            await this.rpc().call('unpause', gid)
            ok = true
            return gid
          } finally {
            if (!ok) await this.rpc().call('remove', gid).catch(() => {})
          }
        }

        const gid = (await this.rpc().call('addUri', [task.source], {
          dir: task.saveDir,
          'bt-save-metadata': 'true',
          pause: 'true',
          ...this.magnetTrackerMerge(task.source)
        })) as string
        // P2 修复：waitMagnetMetadata 的 RPC 异常此前直接上抛，pause 态 gid 泄漏
        // （此时 engineGid 尚未落库，管理器 remove 路径够不到它）——finally 统一移除
        let ok = false
        try {
          const ready = await this.waitMagnetMetadata(gid)
          if (!ready) {
            throw makeError('METADATA_TIMEOUT')
          }
          // 审查修复：start 路径拿到的元数据同样收集进本地缓存——此前仅 parse 收集，
          // 重试/恢复等直接 start 的路径缓存覆盖面打折
          const readyIh = normalizeInfohash(ready.infoHash ?? '')
          if (readyIh) await this.collectMetadataToCache(task.saveDir, readyIh)
          if (selection?.paths?.length) {
            await this.applySelectionByPath(gid, selection.paths, task.threads, task.saveDir, task.seedRatio ?? 0)
          }
          await this.rpc().call('unpause', gid)
          ok = true
          return gid
        } finally {
          if (!ok) await this.rpc().call('remove', gid).catch(() => {})
        }
      }

      // R7 P1 多源：task.params.urls 携带同文件镜像列表 → addUri 多 URI 并行分段
      const urls = readTaskUrls(task)
      // R7 续（backlog #11）：sidecar 兜底任务按解析服务标题落盘（直链无文件名）
      const outName = readTaskOutName(task)
      if (outName) opts.out = outName
      // R7 续审查加固：sidecar 兜底直链常校验 UA/referer（与 parseHttp 探测同源）
      const originUrl = readTaskOriginUrl(task)
      if (originUrl) {
        opts['user-agent'] = BROWSER_UA
        opts.referer = originUrl
      }
      // backlog #26（2026-10-03）：网盘/WebDAV 任务（params.netdisk）注入 Basic 认证头。
      // 凭据从安全存储读取（不入任务库/日志/params）；重启恢复与重试都会重走本路径，
      // 凭据更新后新启动的任务自动使用新值
      if (parseParamsJson(task.params).netdisk === true) {
        const { basicAuthHeader } = await import('../netdisk/webdav')
        const auth = basicAuthHeader()
        if (auth) opts.header = `Authorization: ${auth}`
      }
      return (await this.rpc().call('addUri', urls, opts)) as string
    } catch (err) {
      // P1 加固：allow-overwrite 默认关闭后，同名文件直接报 aria2 原生英文错误——
      // 归一为带出口动作的中文提示
      const raw = err instanceof Error ? err.message : String(err)
      if (/File already exists/i.test(raw)) {
        throw new Error(
          '保存目录已存在同名文件，为防覆盖已停止下载。请更换保存目录，或先删除旧任务/旧文件后重试'
        )
      }
      throw err
    }
  }

  /** 等待磁力元数据：成功返回终结态 status（含 infoHash），失败/超时返回 null */
  private async waitMagnetMetadata(gid: string): Promise<Aria2Status | null> {
    const deadline = Date.now() + METADATA_TIMEOUT_MS
    while (Date.now() < deadline) {
      const st = (await this.rpc().call('tellStatus', gid)) as Aria2Status
      if (st.status === 'complete') return st
      if (st.status === 'error' || st.status === 'removed') return null
      await sleep(1000)
    }
    return null
  }

  /** 审查修复（P2-6）：从 saveDir 中按 infohash 精确匹配收集 bt-save-metadata 产物
   * 进本地缓存。saveDir 可能有用户自己的 .torrent，逐个解析比对 infohash 防误收 */
  private async collectMetadataToCache(saveDir: string, infohash: string): Promise<void> {
    try {
      const { readdir } = await import('fs/promises')
      const names = (await readdir(saveDir)).filter((f) => f.toLowerCase().endsWith('.torrent'))
      for (const n of names) {
        try {
          const info = parseTorrentFile(join(saveDir, n))
          if (normalizeInfohash(info.infohash) === infohash) {
            void cacheTorrentFile(join(saveDir, n), infohash)
            return
          }
        } catch {
          // 非法 .torrent：跳过
        }
      }
    } catch (err) {
      log.debug(`元数据收集失败（不阻断任务）: ${String(err)}`)
    }
  }

  /** 按相对路径回放 select-file（tellStatus 绝对路径裁掉 dir 后比对） */
  private async applySelectionByPath(
    gid: string,
    relativePaths: string[],
    threads: number,
    saveDir: string,
    seedRatio: number
  ): Promise<void> {
    const st = (await this.rpc().call('tellStatus', gid)) as Aria2Status
    const dir = (st.dir ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
    const indexByRel = new Map<string, string>()
    for (const f of st.files ?? []) {
      const norm = f.path.replace(/\\/g, '/')
      const rel =
        dir && norm.toLowerCase().startsWith(dir.toLowerCase() + '/')
          ? norm.slice(dir.length + 1)
          : norm
      indexByRel.set(rel.toLowerCase(), f.index)
    }
    const indexes = relativePaths
      .map((p) => indexByRel.get(p.replace(/\\/g, '/').toLowerCase()))
      .filter((v): v is string => v !== undefined)
      .map(Number)
    // #17 加固（与 confirmSelection 同防线）：勾选与元数据 0 命中时不带 select-file
    // 的 unpause 会静默全量下载——明确失败并给出口动作（磁力缓存路径复用此方法）
    // 第十轮审查 P2：部分命中同族漏网——1≤命中<勾选数时按命中子集静默下载，
    // 用户其余文件无任何提示即丢失。同样明确失败（对齐 0 命中文案口径）
    if (relativePaths.length > 0 && indexes.length < relativePaths.length) {
      throw new Error(
        indexes.length === 0
          ? `勾选的 ${relativePaths.length} 个文件与种子元数据 0 命中（文件清单可能已变化）。` +
              '请删除该任务后重新解析，在文件树中重新勾选'
          : `勾选的 ${relativePaths.length} 个文件仅 ${indexes.length} 个与种子元数据匹配（文件清单可能已变化）。` +
              '为避免静默丢文件已中止，请删除该任务后重新解析并重新勾选'
      )
    }
    await this.rpc().call('changeOption', gid, {
      ...buildTaskOptions({ type: 'bt', threads, saveDir, seedRatio, selectedFileIndexes: indexes })
    })
  }

  /** 运行中任务热更选项（加速：tracker 注入等，§4.2 每任务作用域） */
  async changeOption(gid: string, opts: Record<string, string>): Promise<void> {
    await this.rpc().call('changeOption', gid, opts)
  }

  /** 返回值（审查修复：gid 终结语义修正）：
   *  - 'ok'：引擎侧已置为暂停
   *  - 'complete'/'error'：gid 实际已终结——调用方必须按终态处理而非误标 paused
   *  - 'removed'：gid 已被移除（并发删除窗口），由调用方自行复核 */
  async pause(task: Task): Promise<'ok' | 'complete' | 'error' | 'removed'> {
    if (!task.engineGid) return 'ok'
    try {
      await this.rpc().call('pause', task.engineGid)
      return 'ok'
    } catch {
      // aria2 在文件预分配、BT 初始化等关键段会拒绝暂停（GID#xxx cannot be paused now）
      // → 降级 forcePause（跳过 Tracker 注销等耗时动作，立即置为暂停态）
      try {
        await this.rpc().call('forcePause', task.engineGid)
        return 'ok'
      } catch (err2) {
        const st = (await this.rpc()
          .call('tellStatus', task.engineGid)
          .catch(() => null)) as Aria2Status | null
        if (st && ['complete', 'error', 'removed'].includes(st.status)) {
          log.warn(`pause skipped, gid already ${st.status}: ${task.engineGid}`)
          return st.status as 'complete' | 'error' | 'removed'
        }
        throw err2
      }
    }
  }

  async resume(task: Task): Promise<void> {
    if (!task.engineGid) return
    await this.rpc().call('unpause', task.engineGid)
  }

  /** 仅移除引擎侧任务；文件删除由管理器按 task_files 精确执行（B6：禁止整目录 rm）。
   * M6 修复：顺带清理 .aria2 控制文件——remove 后 gid 已销毁，控制文件永久残留，
   * 配合 --continue=true 下次同名任务可能复用脏状态 */
  async remove(task: Task): Promise<void> {
    if (task.engineGid) {
      // 第六轮审查：rpc() 在引擎离线时同步 throw（orchestrator.getClient 客户端为
      // null），原 .catch 只包住 call() —— 删除/清空回收站在 aria2 启动失败窗口
      // 整体失败。引擎离线时本地清理照常进行，RPC 失败一并吞掉（引擎重启后
      // recoverAria2Restart/recoverEngineTasks 会重置这些任务）
      try {
        await this.rpc().call('remove', task.engineGid)
      } catch {
        // 已完成任务的 gid 已销毁 / 引擎离线，忽略
      }
    }
    const { getTaskFiles } = await import('../task/store')
    const { rm } = await import('fs/promises')
    for (const f of getTaskFiles(task.id)) {
      await rm(join(task.saveDir, `${f.path}.aria2`), { force: true }).catch(() => {})
    }
  }

  /** 确认勾选（磁力暂停态）：changeOption(select-file) + 改 dir + seed-ratio（§4.2 Step3） */
  async confirmSelection(
    gid: string,
    selectedPaths: string[],
    threads: number,
    saveDir: string,
    seedRatio: number
  ): Promise<void> {
    const st = (await this.rpc().call('tellStatus', gid)) as Aria2Status
    const dir = (st.dir ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
    const indexByRel = new Map<string, string>()
    for (const f of st.files ?? []) {
      const norm = f.path.replace(/\\/g, '/')
      const rel =
        dir && norm.toLowerCase().startsWith(dir.toLowerCase() + '/')
          ? norm.slice(dir.length + 1)
          : norm
      indexByRel.set(rel.toLowerCase(), f.index)
    }
    const indexes = selectedPaths
      .map((p) => indexByRel.get(p.replace(/\\/g, '/').toLowerCase()))
      .filter((v): v is string => v !== undefined)
      .map(Number)
    // #17 加固：用户勾选与引擎元数据 0 命中（镜像改名/大小写口径漂移）时，
    // 不带 select-file 的 unpause 会静默全量下载——明确失败并给出口动作
    // 第十轮审查 P2：部分命中同族漏网同修（对齐 applySelectionByPath 口径）
    if (selectedPaths.length > 0 && indexes.length < selectedPaths.length) {
      throw new Error(
        indexes.length === 0
          ? `勾选的 ${selectedPaths.length} 个文件与种子元数据 0 命中（文件清单可能已变化）。` +
              '请删除该任务后重新解析，在文件树中重新勾选'
          : `勾选的 ${selectedPaths.length} 个文件仅 ${indexes.length} 个与种子元数据匹配（文件清单可能已变化）。` +
              '为避免静默丢文件已中止，请删除该任务后重新解析并重新勾选'
      )
    }
    await this.rpc().call('changeOption', gid, {
      ...buildTaskOptions({ type: 'bt', threads, saveDir, seedRatio, selectedFileIndexes: indexes })
    })
    // R4-P3：确认后元数据临时目录不再被引用（dir 已改为任务保存目录）——
    // 此前仅解析失败路径清理，成功解析的磁力每次都在 %TEMP% 残留一个 .torrent。
    // st.dir 即 parse 阶段的 omniget-metadata/<taskId>/ 目录
    if (dir && dir.toLowerCase().includes('omniget-metadata')) cleanupMetadataDir(dir)
  }

  /** 托盘「全部暂停」（§4.6） */
  async pauseAll(): Promise<void> {
    await this.rpc().call('forcePauseAll')
  }

  /** 托盘「全部继续」（§4.6） */
  async resumeAll(): Promise<void> {
    await this.rpc().call('unpauseAll')
  }

  // ── 事件流 ─────────────────────────────────────────────────────────

  async pollEvents(tasks: Task[]): Promise<TaskEvent[]> {
    if (!this.supervisor.isOnline) return []
    // 顺带刷新全局速度缓存（含上传；失败静默，保留上次值）
    void this.rpc()
      .call('getGlobalStat')
      .then((s) => {
        const g = s as { downloadSpeed?: string; uploadSpeed?: string }
        this.lastGlobalStat = {
          down: Number(g.downloadSpeed) || 0,
          up: Number(g.uploadSpeed) || 0
        }
      })
      .catch(() => {})
    const events: TaskEvent[] = []
    // L-7：并行轮询——逐任务串行 await 在任务多或 aria2 卡顿时一轮超过 1s，
    // 会拉长事件窗口（放大合并器回放竞态）
    await Promise.all(
      tasks.map(async (task) => {
        if (task.engine !== 'aria2' || !task.engineGid) return
        // M-4：seeding 任务继续轮询，做种结束（aria2 报 complete）才落 completed
        if (!['queued', 'running', 'paused', 'verifying', 'seeding'].includes(task.status)) return
        try {
          const st = (await this.rpc().call('tellStatus', task.engineGid)) as Aria2Status
          // M-4：下载完成但仍在上传（做种）→ seeding（此前一直显示「下载中」，完成时间
          // 口径偏移到做种结束）。BT 以外任务 totalLength 恒等于 completedLength，不受影响
          const seeding =
            st.status === 'active' &&
            Number(st.totalLength) > 0 &&
            Number(st.completedLength) >= Number(st.totalLength)
          const statusMap: Record<string, TaskEvent['status']> = {
            active: seeding ? 'seeding' : 'running',
            waiting: 'queued',
            paused: 'paused',
            complete: 'completed',
            error: 'failed',
            removed: 'failed'
          }
          const mapped = statusMap[st.status]
          // M4-17：aria2 错误结构化归因（五类 + 出口动作）
          // P3 加固：pollEvents 每秒逐任务调用，归因/健康模块必须静态导入（动态 import 每秒 N 次 Promise 调度开销）
          const d = diagnose(st.errorMessage ?? '')
          // Backlog：平台健康面板——aria2 错误写入健康注册表
          if (st.status === 'error') {
            recordPlatformFailure('aria2', d.kind, st.errorMessage ?? d.message, 'aria2')
          }
          events.push({
            taskId: task.id,
            status: mapped,
            downloadedBytes: Number(st.completedLength),
            totalBytes: Number(st.totalLength),
            speedBps: Number(st.downloadSpeed),
            error:
              st.status === 'error'
                ? (st.errorMessage ? `${d.message}（${st.errorMessage}）` : d.message)
                : undefined
          })
        } catch (err) {
          log.debug(`poll status failed for gid ${task.engineGid}`, err)
        }
      })
    )
    return events
  }
}

function extractInfohash(source: string): string | null {
  const m = /xt=urn:btih:([a-zA-Z0-9]+)/.exec(source)
  return m?.[1] ? normalizeInfohash(m[1]) : null
}

/** R7 P0-3：磁力自带 tr= 参数与订阅源并集（bt-tracker 为 CSV，逐条注入防覆盖全局） */
function extractMagnetTrackers(source: string): string[] {
  try {
    return [...new URL(source).searchParams.getAll('tr')]
      .map((t) => t.trim())
      .filter((t) => /^[a-z]+:\/\//i.test(t) && !/[\s,]/.test(t) && t.length <= 500)
  } catch {
    return []
  }
}

/** R7 P1 多源：读任务镜像 URL 列表（params.urls JSON；缺省仅 source 本身）——见 task/params.ts */

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
