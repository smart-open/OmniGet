// 统一错误码表（任务计划 T0-7）
// 失败文案必须带出口动作（§7.1 原则 / §4.8 任务诊断）。

export type ErrorKind = 'network' | 'disk' | 'engine' | 'parse' | 'risk' | 'internal'

export interface OmniGetError {
  code: string
  kind: ErrorKind
  /** 用户可读文案，必须含出口动作 */
  message: string
  /** 一键出口动作提示（M4-17 结构化归因的雏形） */
  exitHint?: string
  cause?: unknown
}

export const ERROR_CODES = {
  ENGINE_OFFLINE: {
    kind: 'engine',
    message: '下载引擎未就绪，正在尝试自动恢复；若持续失败请重启应用。',
    exitHint: '查看引擎状态'
  },
  ENGINE_BINARY_TAMPERED: {
    kind: 'engine',
    message: '引擎文件校验失败，已拒绝启动以保护系统安全。请重新安装 OmniGet。',
    exitHint: '重新安装'
  },
  ENGINE_FINGERPRINT_STORE_CORRUPT: {
    kind: 'engine',
    message: '引擎指纹库损坏，为防止被篡改的引擎被执行已拒绝启动。删除 fingerprints.json 后重启可重新登记。',
    exitHint: '查看帮助'
  },
  ENGINE_PORT_OCCUPIED: {
    kind: 'engine',
    message: '本地端口被占用，已自动改用备用端口；若任务异常请检查防火墙设置。',
    exitHint: '检查防火墙'
  },
  METADATA_TIMEOUT: {
    kind: 'network',
    message: '磁力元数据获取超时（90s）。可改用 .torrent 种子文件，或稍后重试。',
    exitHint: '改用 .torrent'
  },
  PLATFORM_DEGRADED: {
    kind: 'risk',
    message: '该音乐平台接口受限，已自动切换到备用平台；可粘贴歌曲 ID 精确下载。',
    exitHint: '用 ID 精确下载'
  },
  EXTRACTOR_STALE: {
    kind: 'engine',
    message: '该站点暂不支持或已失效（平台可能改版）。请先更新 yt-dlp 引擎后重试。',
    exitHint: '更新引擎'
  },
  DISK_FULL: {
    kind: 'disk',
    message: '磁盘空间不足。请清理空间或更换保存目录。',
    exitHint: '更换保存目录'
  },
  ILLEGAL_PATH: {
    kind: 'disk',
    message: '保存路径无效或超出系统路径长度限制，请更换保存目录。',
    exitHint: '更换保存目录'
  },
  PARSE_FAILED: {
    kind: 'parse',
    message: '链接无法解析。请检查链接是否完整，或该站点是否需要登录 cookie。',
    exitHint: '配置 cookie'
  },
  HTTP_TIMEOUT: {
    kind: 'network',
    message: '网络连接超时，已自动重试；若持续失败请检查网络后点击重试。',
    exitHint: '重试任务'
  },
  INTERNAL: {
    kind: 'internal',
    message: '发生内部错误，详情见日志；可尝试重启应用。',
    exitHint: '查看日志'
  }
} as const

export type ErrorCode = keyof typeof ERROR_CODES

export function makeError(
  code: ErrorCode,
  overrides?: Partial<OmniGetError>
): OmniGetError {
  const base = ERROR_CODES[code]
  return {
    code,
    kind: base.kind,
    message: base.message,
    exitHint: base.exitHint,
    ...overrides
  }
}
