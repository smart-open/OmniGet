// dev 启动包装（R5）：Windows 中文终端默认 GBK 代码页（936），主进程/日志的
// UTF-8 中文输出会显示成乱码（「璇锋眰澶辫触」）。chcp 修改的是所附着的
// 控制台设备代码页（整会话共享），对本终端及后续子进程均生效。
// 非 Windows 或 chcp 失败时静默跳过，直接透传 electron-vite dev。

const { spawnSync } = require('child_process')

if (process.platform === 'win32') {
  try {
    spawnSync('chcp', ['65001'], { stdio: 'ignore', shell: true })
  } catch {
    // ignore
  }
}

const result = spawnSync('npx', ['electron-vite', 'dev'], {
  stdio: 'inherit',
  shell: process.platform === 'win32'
})
process.exit(result.status ?? 1)
