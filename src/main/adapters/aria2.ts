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
import { buildTaskOptions } from '../aria2/options'
import { createLogger } from '../logger'
import { diagnose } from '../diagnosis'
import { recordPlatformFailure } from '../health'
import type { EngineAdapter, EngineHealthInfo, ParseOutput } from './types'
import type { Aria2Supervisor } from '../orchestrator/aria2'

const log = createLogger('aria2-adapter')

const METADATA_TIMEOUT_MS = 90_000 // 磁力元数据超时（§11 风险 #5）
const HTTP_PROBE_TIMEOUT_MS = 10_000

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
}

export class Aria2Adapter implements EngineAdapter {
  constructor(private readonly supervisor: Aria2Supervisor) {}

  private rpc() {
    return this.supervisor.getClient()
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

  async parse(task: Task): Promise<ParseOutput> {
    if (task.type === 'magnet') return this.parseMagnet(task)
    if (task.type === 'bt') return this.parseTorrent(task)
    if (task.type === 'http') return this.parseHttp(task)
    throw new Error(`aria2 适配器不支持的任务类型：${task.type}`)
  }

  /** 磁力 BEP-9 四步（§4.2）：addUri(pause:true, bt-save-metadata) → 等 metadata → getFiles */
  private async parseMagnet(task: Task): Promise<ParseOutput> {
    const infohash = extractInfohash(task.source)

    // D2：元数据落盘到临时目录（不污染用户保存目录）
    const metaDir = join(tmpdir(), 'omniget-metadata', task.id)
    const gid = (await this.rpc().call('addUri', [task.source], {
      dir: metaDir,
      'bt-save-metadata': 'true',
      pause: 'true' // 必须 pause:true：否则元数据到达后立刻全量下载（§4.2）
    })) as string

    // 等 metadata：轮询 tellStatus 直到 status=complete
    const deadline = Date.now() + METADATA_TIMEOUT_MS
    while (Date.now() < deadline) {
      const st = (await this.rpc().call('tellStatus', gid)) as Aria2Status
      // B1：元数据下载阶段 files 只有 <name>.torrent 本体，过滤之（BEP-9 勾选面板只呈现真实内容文件）
      const files = this.statusToFiles(st).filter((f) => !f.path.endsWith('.torrent'))
      if (st.status === 'complete' && files.length > 0) {
        const name = st.bittorrent?.info?.name ?? files[0]?.path.split('/')[0] ?? task.source
        const ih = normalizeInfohash(st.infoHash ?? infohash ?? '')
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
        throw makeError('METADATA_TIMEOUT', { cause: st.errorMessage })
      }
      await sleep(1000)
    }
    // 超时：移除暂停态任务
    await this.rpc().call('remove', gid).catch(() => {})
    throw makeError('METADATA_TIMEOUT')
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

  /** HTTP 直链 HEAD 探测（M1-7）：大小/文件名嗅探；带超时防挂起 */
  private async parseHttp(task: Task): Promise<ParseOutput> {
    const res = await fetch(task.source, {
      method: 'HEAD',
      redirect: 'follow',
      signal: AbortSignal.timeout(HTTP_PROBE_TIMEOUT_MS)
    })
    if (!res.ok) {
      throw makeError('HTTP_TIMEOUT', {
        message: `直链探测失败（HTTP ${res.status}）。请检查链接是否有效后重试。`
      })
    }
    const len = Number(res.headers.get('content-length') ?? 0)
    const cd = res.headers.get('content-disposition') ?? ''
    const m = /filename\*?=(?:UTF-8'')?"?([^";]+)/i.exec(cd)
    const urlName = decodeURIComponent(
      new URL(res.url || task.source).pathname.split('/').pop() ?? ''
    )
    const name = sanitizeFilename(m?.[1] || urlName || 'download')
    return {
      name,
      totalBytes: len,
      files: [{ path: name, size: len }]
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
      seedRatio: task.seedRatio ?? 0
    })

    if (task.type === 'bt') {
      const { stripFileProtocol } = await import('../sniffer')
      const base64 = readFileSync(stripFileProtocol(task.source)).toString('base64')
      if (selection?.indexes?.length) {
        opts['select-file'] = selection.indexes.join(',')
      }
      return (await this.rpc().call('addTorrent', base64, [], opts)) as string
    }

    if (task.type === 'magnet') {
      const gid = (await this.rpc().call('addUri', [task.source], {
        dir: task.saveDir,
        'bt-save-metadata': 'true',
        pause: 'true'
      })) as string
      const ready = await this.waitMagnetMetadata(gid)
      if (!ready) {
        await this.rpc().call('remove', gid).catch(() => {})
        throw makeError('METADATA_TIMEOUT')
      }
      if (selection?.paths?.length) {
        await this.applySelectionByPath(gid, selection.paths, task.threads, task.saveDir, task.seedRatio ?? 0)
      }
      await this.rpc().call('unpause', gid)
      return gid
    }

    return (await this.rpc().call('addUri', [task.source], opts)) as string
  }

  private async waitMagnetMetadata(gid: string): Promise<boolean> {
    const deadline = Date.now() + METADATA_TIMEOUT_MS
    while (Date.now() < deadline) {
      const st = (await this.rpc().call('tellStatus', gid)) as Aria2Status
      if (st.status === 'complete') return true
      if (st.status === 'error' || st.status === 'removed') return false
      await sleep(1000)
    }
    return false
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
    await this.rpc().call('changeOption', gid, {
      ...buildTaskOptions({ type: 'bt', threads, saveDir, seedRatio, selectedFileIndexes: indexes })
    })
  }

  /** 运行中任务热更选项（加速：tracker 注入等，§4.2 每任务作用域） */
  async changeOption(gid: string, opts: Record<string, string>): Promise<void> {
    await this.rpc().call('changeOption', gid, opts)
  }

  async pause(task: Task): Promise<void> {
    if (!task.engineGid) return
    try {
      await this.rpc().call('pause', task.engineGid)
    } catch {
      // aria2 在文件预分配、BT 初始化等关键段会拒绝暂停（GID#xxx cannot be paused now）
      // → 降级 forcePause（跳过 Tracker 注销等耗时动作，立即置为暂停态）
      try {
        await this.rpc().call('forcePause', task.engineGid)
      } catch (err2) {
        // gid 已终结（complete/error/removed）→ 视为已暂停，真实状态由轮询对齐
        const st = (await this.rpc()
          .call('tellStatus', task.engineGid)
          .catch(() => null)) as Aria2Status | null
        if (st && ['complete', 'error', 'removed'].includes(st.status)) {
          log.warn(`pause skipped, gid already ${st.status}: ${task.engineGid}`)
          return
        }
        throw err2
      }
    }
  }

  async resume(task: Task): Promise<void> {
    if (!task.engineGid) return
    await this.rpc().call('unpause', task.engineGid)
  }

  /** 仅移除引擎侧任务；文件删除由管理器按 task_files 精确执行（B6：禁止整目录 rm） */
  async remove(task: Task): Promise<void> {
    if (!task.engineGid) return
    await this.rpc().call('remove', task.engineGid).catch(() => {
      // 已完成任务的 gid 已销毁，忽略
    })
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
    await this.rpc().call('changeOption', gid, {
      ...buildTaskOptions({ type: 'bt', threads, saveDir, seedRatio, selectedFileIndexes: indexes })
    })
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
    const events: TaskEvent[] = []
    for (const task of tasks) {
      if (task.engine !== 'aria2' || !task.engineGid) continue
      if (!['queued', 'running', 'paused', 'verifying'].includes(task.status)) continue
      try {
        const st = (await this.rpc().call('tellStatus', task.engineGid)) as Aria2Status
        const statusMap: Record<string, TaskEvent['status']> = {
          active: 'running',
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
    }
    return events
  }
}

function extractInfohash(source: string): string | null {
  const m = /xt=urn:btih:([a-zA-Z0-9]+)/.exec(source)
  return m?.[1] ? normalizeInfohash(m[1]) : null
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
