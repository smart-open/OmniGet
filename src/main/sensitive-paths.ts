// 敏感路径黑名单共享模块（跨平台审查 P2/P3：save-dir / preview-protocol / ipc Cookie
// 三处手工维护已现漂移——Keychains 大小写失效、/private 旁路等，收敛为单一口径）。
//
// 口径约定（有意分层，不要强行合并）：
// - 写盘防线（save-dir）：SYSTEM + CREDENTIAL + PERSISTENCE（AppData/TEMP 属合法落盘位）
// - 媒体读取面（preview-protocol）：SYSTEM + CREDENTIAL + PERSISTENCE + roaming/TEMP 局部追加
// - Cookie 读取面（ipc ytdlp.cookieFile）：SYSTEM 局部子集 + CREDENTIAL + TEMP
//
// 全部条目按「小写 + 正斜杠」口径书写（normPath 归一后比对）。

import { realpathSync } from 'fs'
import { join } from 'path'

/**
 * 尽力 realpath（目录可能尚不存在）：对最深已存在的祖先段做符号链接展开，剩余段原样拼接。
 * macOS 上 /etc、/tmp、/var 均是 /private/* 的符号链接——不做归一，
 * 用户直接填 /private/etc 即可绕过黑名单。
 * UNC 路径跳过（真实解析会触发 SMB 出站认证）。
 */
export function realishPath(p: string): string {
  if (/^(\\\\|\/\/)/.test(p)) return p
  try {
    return realpathSync(p)
  } catch {
    // 目录不存在：逐级上溯找已存在祖先
  }
  const parts = p.split(/[\\/]+/).filter(Boolean)
  // 盘符段必须拼上分隔符再 join——path.win32.join('C:', 'Users') 产出 'C:Users'
  //（drive-relative，realpath 会按「该盘当前目录」解析，指向完全错误的位置）
  const drive = /^[a-zA-Z]:$/.test(parts[0] ?? '') ? parts[0] : null
  for (let i = parts.length - 1; i > 0; i--) {
    const head = drive ? join(`${drive}\\`, ...parts.slice(1, i)) : join('/', ...parts.slice(0, i))
    try {
      const real = realpathSync(head)
      const rest = parts.slice(i)
      return drive ? join(real, ...rest) : rest.length ? `${real}/${rest.join('/')}` : real
    } catch {
      // 继续上溯
    }
  }
  return p
}

/** 路径归一：反斜杠 → 正斜杠 + 小写（拦截比对用途，两侧一致故无漏判） */
export function normPath(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase()
}

/** 剥离盘符前缀（c:/windows → /windows）；兼容 'c:/x' 与 '/c:/x' 两种形态
 * （旧正则只匹配后者导致 C:\Windows 漏判，回归测试已锁定） */
export function stripDrive(norm: string): string {
  return norm.replace(/^\/?[a-z]:/, '')
}

/** 用户主目录（归一后）；取不到返回空串 */
export function homeDir(): string {
  return normPath(process.env.USERPROFILE ?? process.env.HOME ?? '').replace(/\/+$/, '')
}

/** 系统目录（任意盘符泛化后比对）。
 * 含 macOS 符号链接真实形态（/etc→/private/etc 等）与顶层系统目录——
 * 不做条目补齐时用户直接填 /private/etc 即可绕过 */
export const SYSTEM_DIRS: readonly string[] = [
  '/windows',
  '/program files',
  '/program files (x86)',
  '/programdata',
  '/usr', '/etc', '/bin', '/sbin', '/boot', '/proc', '/sys', '/dev',
  '/private/etc', '/private/tmp', '/private/var', '/private/usr',
  '/system', '/library'
]

/** 凭据/密钥目录（挂 home） */
export function credentialDirs(): string[] {
  const home = homeDir()
  return home
    ? [
        `${home}/.ssh`,
        `${home}/.gnupg`,
        `${home}/.aws`,
        `${home}/.kube`,
        `${home}/library/keychains`
      ]
    : []
}

/** 自启动/持久化目录（挂 home）——远程内容落到这些位置等于持久化代码执行 */
export function persistenceDirs(): string[] {
  const home = homeDir()
  return home
    ? [
        `${home}/appdata/roaming/microsoft/windows/start menu`,
        `${home}/appdata/roaming/microsoft/windows/start menu/programs/startup`,
        `${home}/appdata/local/microsoft/windows/start menu`,
        `${home}/.config/autostart`,
        `${home}/.config/systemd`,
        `${home}/.local/share/systemd`,
        `${home}/library/launchagents`,
        `${home}/library/launchdaemons`
      ]
    : []
}

/** norm 是否命中黑名单（含盘符泛化二次比对） */
export function hitsAny(norm: string, entries: readonly string[]): boolean {
  const test = (target: string) => (d: string): boolean => target === d || target.startsWith(`${d}/`)
  const stripped = stripDrive(norm)
  return entries.some(test(norm)) || (stripped !== norm && entries.some(test(stripped)))
}
