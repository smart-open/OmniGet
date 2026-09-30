// 跨平台进程树终止（§2.2 优雅退出口径的三平台对齐）
// 问题背景：
// - Windows 上 Node 的 kill('SIGTERM'/'SIGKILL') 一律映射为 TerminateProcess（立即硬杀，
//   两级"优雅→强杀"设计退化为同一次硬杀，且不级联 ffmpeg 等孙进程 → 孤儿进程占句柄）
// - Unix 上 SIGTERM 优雅、SIGKILL 强杀语义正常，但子进程同样不级联
// 统一口径：
// - win32：taskkill /T /F（一棵树整体终止）；taskkill 不可用时退回 proc.kill()
// - 其他：SIGTERM → graceMs 后仍未退出则 SIGKILL

import { spawn, type ChildProcess } from 'child_process'

/** 优雅→强杀两级终止进程树；幂等，exit 后调用为空操作 */
export function terminateTree(proc: ChildProcess, graceMs = 8000): void {
  if (proc.exitCode !== null || proc.signalCode !== null) return
  if (process.platform === 'win32') {
    if (!proc.pid) return
    const tk = spawn(
      'taskkill',
      ['/pid', String(proc.pid), '/T', '/F'],
      { windowsHide: true, stdio: 'ignore' }
    )
    tk.on('error', () => {
      // taskkill 不可用（极少数精简系统）→ 退化为直接终止
      try {
        proc.kill()
      } catch {
        // ignore
      }
    })
    return
  }
  try {
    proc.kill('SIGTERM')
  } catch {
    return
  }
  if (graceMs > 0) {
    setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null) {
        try {
          proc.kill('SIGKILL')
        } catch {
          // ignore
        }
      }
    }, graceMs).unref?.()
  }
}
