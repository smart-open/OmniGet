// 引擎适配器接口（§4.1）

import type { Task, TaskEvent } from '@shared/types'

export interface EngineHealthInfo {
  online: boolean
  detail?: string
}

export interface EngineAdapter {
  health(): Promise<EngineHealthInfo>
  /** 返回文件树/格式列表；磁力走 BEP-9；HTTP 走 HEAD 探测。
   * isAborted：解析轮询期间由调用方提供的中止探针（任务被删除/回收时提前退出，防 gid 泄漏） */
  parse(task: Task, isAborted?: () => boolean): Promise<ParseOutput>
  /** 启动任务；selection 提供恢复/re-add 时的勾选回放（相对路径或索引） */
  start(task: Task, selection?: { indexes?: number[]; paths?: string[] }): Promise<string>
  /** 暂停；aria2 实现返回 gid 终结语义（complete/error/removed = 未暂停但引擎侧已终结），
   *  其余引擎恒 'ok'（调用方据此走终态事件流而非误标 paused） */
  pause(task: Task): Promise<'ok' | 'complete' | 'error' | 'removed'>
  resume(task: Task): Promise<void>
  /** 仅移除引擎侧任务；文件删除由管理器按 task_files 精确执行 */
  remove(task: Task): Promise<void>
  /** 拉取当前活跃任务的进度快照（由管理器轮询并入事件流） */
  pollEvents(tasks: Task[]): Promise<TaskEvent[]>
}

export interface ParseOutput {
  files?: { path: string; size: number; selected?: boolean; downloaded?: number }[]
  formats?: import('@shared/types').VideoFormat[]
  infohash?: string
  magnet?: string
  name: string
  totalBytes: number
  /** M3-11：封面缩略图 / 时长（防下错预览） */
  coverUrl?: string
  duration?: number
  /** 合集/主页批量（M3-4/8）：确认后按 --playlist-items 回放勾选 */
  playlist?: boolean
  /** M3-2：ffmpeg 缺失 → 格式选择器降级为预合并格式并提示 */
  ffmpegMissing?: boolean
  /** 磁力任务在 parse 期间已 addUri 到 aria2（pause 态），确认勾选时直接 changeOption+unpause */
  pendingGid?: string
  /** R7 续（backlog #20）：HLS 直播流（media 清单无 #EXT-X-ENDLIST） */
  live?: boolean
  /** R7 P1 多源：HTTP 探测通过 content-length 校验的同文件镜像列表（start 时 addUri 多 URI 并行） */
  mirrors?: string[]
}
