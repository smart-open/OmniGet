// 保存目录安全校验（H9/H1：主进程写盘的最后防线，IPC settingsSet 与任务创建共用）
// 威胁模型：渲染层被攻破 / bridge token 泄漏 → 提交任意 saveDir 让主进程向
// 系统敏感目录落盘（下载产物=攻击者控制的文件内容）。写盘口径比读取侧
// （taskParseFile/preview 黑名单）略宽：AppData/TEMP 属合法落盘位置，但
// 自启动目录、系统目录、凭据目录必须拦截。

import { isAbsolute } from 'path'

/** 校验失败返回错误文案；通过返回 null */
export function validateSaveDir(dir: string): string | null {
  const d = (dir ?? '').trim()
  if (!d) return '保存目录为空'
  if (!isAbsolute(d)) return '保存目录必须是绝对路径'
  // P3 修复：拒绝 UNC 路径——下载落盘到网络共享会触发 SMB 出站认证（凭据面），
  // 与读取侧 taskParseFile 的 UNC 拒绝对称
  if (/^\\\\/.test(d)) return '不允许 UNC 网络路径作为保存目录'
  if (d.includes('\0')) return '保存目录包含非法字符'
  const norm = d.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const profile = (process.env.USERPROFILE ?? process.env.HOME ?? '').replace(/\\/g, '/').toLowerCase()
  const sensitive = [
    // 系统目录（盘符泛化在下方二次剥离比对）
    '/windows',
    '/program files',
    '/program files (x86)',
    '/programdata',
    '/usr', '/etc', '/bin', '/sbin', '/boot', '/proc', '/sys', '/dev',
    // 凭据/密钥目录
    profile ? `${profile}/.ssh` : '',
    profile ? `${profile}/.gnupg` : '',
    profile ? `${profile}/.aws` : '',
    profile ? `${profile}/.kube` : '',
    profile ? `${profile}/library/keychains` : '',
    // H1 修复：自启动/计划任务目录——远程内容落到这些位置等于持久化代码执行
    profile ? `${profile}/appdata/roaming/microsoft/windows/start menu` : '',
    profile ? `${profile}/appdata/roaming/microsoft/windows/start menu/programs/startup` : '',
    profile ? `${profile}/appdata/local/microsoft/windows/start menu` : '',
    profile ? `${profile}/.config/autostart` : '',
    profile ? `${profile}/.config/systemd` : '',
    profile ? `${profile}/.local/share/systemd` : '',
    profile ? `${profile}/library/launchagents` : '',
    profile ? `${profile}/library/launchdaemons` : ''
  ].filter(Boolean)
  const hit =
    sensitive.some((s) => norm === s || norm.startsWith(`${s}/`)) ||
    (strippedOfDrive(norm) !== norm && sensitive.some((s) => strippedOfDrive(norm) === s || strippedOfDrive(norm).startsWith(`${s}/`)))
  if (hit) return '不允许将下载目录设为系统、自启动或敏感目录'
  return null
}

/** 剥离盘符前缀（c:/windows → /windows），用于任意盘符的系统目录比对 */
function strippedOfDrive(norm: string): string {
  // 兼容 'c:/x'（norm 产出形态）与 '/c:/x' 两种形态——旧正则只匹配后者，
  // 导致 C:\Windows 等路径漏判（回归测试已锁定）
  return norm.replace(/^\/?[a-z]:/, '')
}
