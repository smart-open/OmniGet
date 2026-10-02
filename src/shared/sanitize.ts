// 文件名清洗（§4.5 跨引擎统一，主进程实施点）
// 平台差异化（backlog #6）：Windows 按 NTFS/FAT 规则全量清洗（非法字符、
// 保留名、末尾空格/点）；POSIX（Linux/macOS）仅清洗真正非法的内容
//（控制字符与 `/`），保留名与末尾空格/点在 POSIX 上是合法文件名，不再改写。

const WINDOWS_ILLEGAL = /[<>:"|?*]/g
const CONTROL_CHARS = /[\x00-\x1f\x7f]/g
const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i
const MAX_FILENAME_LEN = 200 // 预留目录层级与扩展名余量（MAX_PATH 260 口径，§4.5）

/**
 * 清洗单段文件名（不含路径分隔符）。
 * Windows：非法字符替换为 `_`；POSIX：仅替换 `/`，其余合法字符原样保留。
 * `platform` 供测试注入；默认跟随当前运行平台。
 */
export function sanitizeFilename(
  name: string,
  platform: NodeJS.Platform = process.platform
): string {
  let out = name.replace(CONTROL_CHARS, '')
  if (platform === 'win32') {
    out = out
      .replace(WINDOWS_ILLEGAL, '_')
      .replace(/[\r\n\t]/g, ' ')
      .trim()
    // 保留名（CON/NUL/COM1…）
    if (RESERVED_NAMES.test(out)) {
      out = `_${out}`
    }
    // 末尾空格/点（Windows 文件系统限制）
    out = out.replace(/[. ]+$/g, '')
  } else {
    // POSIX：`/` 是路径分隔符必须中和；`\` 为合法字符保留；末尾空格/点同样是
    // 合法文件名，不做 trim/剔除（backlog #6 的核心诉求：按平台原生口径）
    out = out.replace(/\//g, '_').replace(/[\r\n\t]/g, ' ')
    if (out === '.' || out === '..') {
      out = '_'
    }
  }
  // 超长截断对全平台生效（跨平台同步/共享目录场景预留余量）
  if (out.length > MAX_FILENAME_LEN) {
    out = out.slice(0, MAX_FILENAME_LEN)
    if (platform === 'win32') out = out.replace(/[. ]+$/g, '')
  }
  return out || '_unnamed'
}

/**
 * 清洗相对路径（分段清洗，保留 `/` 分层；不改变路径结构）。
 * 分段同时接受 `\`（Windows 上游/BT 元数据边缘输入），防止整段逃过 `..` 穿越过滤。
 */
export function sanitizeRelativePath(path: string): string {
  return path
    .split(/[\\/]/)
    .map((seg) => (seg === '.' || seg === '..' ? '_' : sanitizeFilename(seg)))
    .join('/')
}
