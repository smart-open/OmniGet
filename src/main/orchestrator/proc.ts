// 跨平台进程树终止（§2.2 优雅退出口径的三平台对齐）
// 问题背景：
// - Windows 上 Node 的 kill('SIGTERM'/'SIGKILL') 一律映射为 TerminateProcess（立即硬杀，
//   两级"优雅→强杀"设计退化为同一次硬杀，且不级联 ffmpeg 等孙进程 → 孤儿进程占句柄）
// - Unix 上 SIGTERM 优雅、SIGKILL 强杀语义正常，但子进程同样不级联
// 统一口径：
// - win32：taskkill /T /F（一棵树整体终止）；taskkill 不可用时退回 proc.kill()
// - 其他：优先向进程组发信号（需 spawn 时 detached: true，见 spawnTreeAware）→
//   退化为仅直接子进程 SIGTERM → graceMs 后仍未退出则（组）SIGKILL

import { spawn, type ChildProcess, type SpawnOptions } from 'child_process'

/** 跨平台 spawn：Unix 侧 detached 使子进程成为进程组组长，terminateTree 才能级联孙进程 */
export function spawnTreeAware(command: string, args: string[], options: SpawnOptions = {}): ChildProcess {
  const opts: SpawnOptions = { ...options }
  if (process.platform !== 'win32') {
    opts.detached = true
  } else {
    opts.windowsHide = options.windowsHide ?? true
  }
  return spawn(command, args, opts)
}

function killGroup(pid: number, signal: NodeJS.Signals): boolean {
  try {
    // detached 子进程的 pgid === pid，负号即整组信号（覆盖 ffmpeg 等孙进程）
    process.kill(-pid, signal)
    return true
  } catch {
    return false
  }
}

/** 优雅→强杀两级终止进程树；幂等，exit 后调用为空操作 */
export function terminateTree(proc: ChildProcess, graceMs = 8000): void {
  if (proc.exitCode !== null || proc.signalCode !== null) return
  if (!proc.pid) return
  if (process.platform === 'win32') {
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
  // M5 修复：进程组信号级联孙进程；组信号失败（如子进程非 detached 启动）退化为仅直接子进程
  const groupKilled = killGroup(proc.pid, 'SIGTERM')
  if (!groupKilled) {
    try {
      proc.kill('SIGTERM')
    } catch {
      return
    }
  }
  if (graceMs > 0) {
    setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null) {
        try {
          if (!killGroup(proc.pid!, 'SIGKILL')) proc.kill('SIGKILL')
        } catch {
          // ignore
        }
      }
    }, graceMs).unref?.()
  }
}
