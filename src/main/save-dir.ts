// 保存目录安全校验（H9/H1：主进程写盘的最后防线，IPC settingsSet 与任务创建共用）
// 威胁模型：渲染层被攻破 / bridge token 泄漏 → 提交任意 saveDir 让主进程向
// 系统敏感目录落盘（下载产物=攻击者控制的文件内容）。写盘口径比读取侧
// （taskParseFile/preview 黑名单）略宽：AppData/TEMP 属合法落盘位置，但
// 自启动目录、系统目录、凭据目录必须拦截。
// 黑名单/归一统一来自 ../sensitive-paths（跨平台审查：多处手工维护已现漂移）。

import { isAbsolute } from 'path'
import { SYSTEM_DIRS, credentialDirs, hitsAny, persistenceDirs, realishPath } from './sensitive-paths'

/** 校验失败返回错误文案；通过返回 null */
export function validateSaveDir(dir: string): string | null {
  const d = (dir ?? '').trim()
  if (!d) return '保存目录为空'
  if (!isAbsolute(d)) return '保存目录必须是绝对路径'
  // P3 修复：拒绝 UNC 路径——下载落盘到网络共享会触发 SMB 出站认证（凭据面），
  // 与读取侧 taskParseFile 的 UNC 拒绝对称（回审查修复：`//server/share`
  // 正斜杠形态在 win32 isAbsolute 为真且黑名单无可中条目，一并拦截）
  if (/^(\\\\|\/\/)/.test(d)) return '不允许 UNC 网络路径作为保存目录'
  if (d.includes('\0')) return '保存目录包含非法字符'
  const norm = realishPath(d).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  // 盘符根 / 文件系统根：整盘落盘无意义且等于放行任意子路径绕过逐段判定
  if (/^[a-z]:$/.test(norm) || norm === '') return '不允许将盘符根目录设为保存目录'
  const sensitive = [...SYSTEM_DIRS, ...credentialDirs(), ...persistenceDirs()]
  if (hitsAny(norm, sensitive)) return '不允许将下载目录设为系统、自启动或敏感目录'
  return null
}
