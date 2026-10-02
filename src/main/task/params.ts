// 任务 params JSON 读取辅助（R7 P1）：镜像列表 / 单任务限速
// 独立模块：adapter 与 manager 双方共用，且不把 db 依赖带进 adapter（纯函数）。

import type { Task } from '@shared/types'

function parseParams(task: Task): Record<string, unknown> {
  return parseParamsJson(task.params)
}

/** 解析任务 params JSON（manager 等无 Task 上下文的调用方共用；非法 JSON 返回空对象） */
export function parseParamsJson(params: string | null | undefined): Record<string, unknown> {
  try {
    return JSON.parse(params ?? '{}') as Record<string, unknown>
  } catch {
    return {}
  }
}

/** 同文件镜像 URL 列表（缺省仅 source 本身） */
export function readTaskUrls(task: Task): string[] {
  const urls = [task.source]
  const p = parseParams(task)
  if (Array.isArray(p.urls)) {
    for (const u of p.urls) {
      if (typeof u === 'string' && /^https?:\/\//i.test(u) && !urls.includes(u)) urls.push(u)
    }
  }
  return urls
}

/** 单任务限速（aria2 格式 2M/500K/字节；非法值忽略返回 null） */
export function readTaskSpeedLimit(task: Task): string | null {
  const p = parseParams(task)
  if (typeof p.speedLimit === 'string' && /^\d+(\.\d+)?[KM]?$/i.test(p.speedLimit.trim())) {
    return p.speedLimit.trim()
  }
  return null
}

/** 视频任务平台标识（markShortVideo 回写，分站 cookie/健康归因用） */
export function readTaskPlatform(task: Task): string | null {
  const p = parseParams(task)
  return typeof p.platform === 'string' && p.platform ? p.platform : null
}

/** R7 续（backlog #11）：sidecar 兜底任务的原分享页 URL（aria2 UA/referer 伪装用） */
export function readTaskOriginUrl(task: Task): string | null {
  const p = parseParams(task)
  const u = typeof p.originUrl === 'string' ? p.originUrl.trim() : ''
  return /^https?:\/\//i.test(u) ? u : null
}

/** R7 续（backlog #11）：sidecar 兜底产物名（解析服务标题清洗后）。
 * parseHttp 命名与 aria2 start 的 out 选项共用——两处口径必须一致，
 * 否则 task_files 记录与磁盘实际文件名脱钩（回收站含文件删除会漏删） */
export function readTaskOutName(task: Task): string | null {
  const p = parseParams(task)
  const n = typeof p.outName === 'string' ? p.outName.trim() : ''
  if (!n) return null
  // out 只允许单段文件名：防路径穿越/子目录注入
  return n.replace(/[\\/]+/g, '_')
}
