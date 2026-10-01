// 任务诊断结构化（M4-17，§4.5/§4.8）：失败归因五类 + 一键出口动作
// DNS / TLS / HTTP状态码 / 平台风控 / 磁盘 —— 从引擎 stderr/错误消息模式匹配。

export type FailureKind = 'dns' | 'tls' | 'http' | 'risk' | 'disk' | 'unknown'

export interface Diagnosis {
  kind: FailureKind
  /** 用户可读归因 */
  message: string
  /** 一键出口动作（§4.5） */
  exitAction: 'retry' | 'update-engine' | 'id-download' | 'change-dir' | 'check-network'
}

const PATTERNS: Array<{
  kind: FailureKind
  re: RegExp
  message: string
  exitAction: Diagnosis['exitAction']
}> = [
  {
    kind: 'dns',
    re: /getaddrinfo|name or service not known|no address|EAI_AGAIN/i,
    message: '域名解析失败（DNS）。请检查网络连接或代理设置。',
    exitAction: 'check-network'
  },
  {
    kind: 'tls',
    // M12 修复：锚定 TLS 语义关键词（原先裸 SSL/certificate/TLS 会命中含这些词的
    // 文件名/路径，如 "openssl.conf"，造成误归因）
    re: /\b(SSL|TLS)[\s:,-]|\bhandshake\b|\bcertificate verify failed\b|\bCERTIFICATE_ERROR\b|\bsslverif/i,
    message: 'TLS/证书握手失败（站点证书异常或被拦截）。可尝试更新引擎或检查系统时间。',
    exitAction: 'update-engine'
  },
  {
    kind: 'risk',
    // M12 修复：429/403 仅匹配 "HTTP xxx" 归因语境，不再命中任意含 403 的文本。
    // M1 修复：必须排在 http 模式之前——yt-dlp 的 "HTTP Error 429: Too Many Requests"
    // 会被 http 的 /HTTP Error (\d{3})/ 先短路，risk 模式的 429/403 分支沦为死代码
    re: /HTTP (Error )?4(29|03)|sign in to confirm|频率|风控|verify you.re a human|not a bot|Too Many Requests|Forbidden \(?403/i,
    message: '触发平台风控（频率/登录验证）。建议降低并发或配置 cookie 后重试。',
    exitAction: 'retry'
  },
  {
    kind: 'http',
    re: /HTTP Error (\d{3})|Requested format is not available/i,
    message: 'HTTP 请求失败或格式不可用。可尝试更新引擎（站点可能已改版）。',
    exitAction: 'update-engine'
  },
  {
    kind: 'disk',
    re: /No space left|disk full|EPERM|EACCES|Permission denied/i,
    message: '磁盘写入失败（空间不足或权限）。请更换保存目录。',
    exitAction: 'change-dir'
  }
]

export function diagnose(errorText: string): Diagnosis {
  for (const p of PATTERNS) {
    if (p.re.test(errorText)) {
      return { kind: p.kind, message: p.message, exitAction: p.exitAction }
    }
  }
  return {
    kind: 'unknown',
    message: '下载失败，原因未归类。可重试或更新引擎。',
    exitAction: 'retry'
  }
}
