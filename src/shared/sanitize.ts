// 文件名清洗（§4.5 跨引擎统一，主进程实施点）
// Windows 非法字符替换、控制字符剔除、保留名处理、末尾空格/点剔除、超长截断。

const WINDOWS_ILLEGAL = /[<>:"|?*]/g
const CONTROL_CHARS = /[\x00-\x1f\x7f]/g
const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i
const MAX_FILENAME_LEN = 200 // 预留目录层级与扩展名余量（MAX_PATH 260 口径，§4.5）

/**
 * 清洗单段文件名（不含路径分隔符）。非法字符替换为 `_`。
 */
export function sanitizeFilename(name: string): string {
  let out = name
    .replace(CONTROL_CHARS, '')
    .replace(WINDOWS_ILLEGAL, '_')
    .replace(/[\r\n\t]/g, ' ')
    .trim()
  // 保留名（CON/NUL/COM1…）
  if (RESERVED_NAMES.test(out)) {
    out = `_${out}`
  }
  // 末尾空格/点（Windows 文件系统限制）
  out = out.replace(/[. ]+$/g, '')
  if (out.length > MAX_FILENAME_LEN) {
    out = out.slice(0, MAX_FILENAME_LEN)
    out = out.replace(/[. ]+$/g, '')
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
