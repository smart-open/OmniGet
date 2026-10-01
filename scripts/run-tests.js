// 测试运行器：经 ELECTRON_RUN_AS_NODE 用 Electron 内置 Node 跑 node:test。
// 原因：better-sqlite3 装的是 Electron ABI 预编译（本机无 MSVC），纯 Node ABI 不匹配。
// 注：Electron 33 内置 Node 20 的 --test 不展开 glob，这里自行递归收集 *.test.ts。
const { spawn } = require('child_process')
const { readdirSync } = require('fs')
const path = require('path')

const electronBinary = require('electron') // 纯 Node 下返回二进制路径字符串
if (typeof electronBinary !== 'string') {
  console.error('run-tests.js 必须在普通 Node 下执行')
  process.exit(1)
}

const root = path.join(__dirname, '..')

function collectTestFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...collectTestFiles(full))
    else if (entry.isFile() && entry.name.endsWith('.test.ts')) out.push(full)
  }
  return out
}

const testFiles = collectTestFiles(path.join(root, 'src', 'main'))
if (testFiles.length === 0) {
  console.error('未找到测试文件')
  process.exit(1)
}

const args = [
  path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
  '--tsconfig', 'tsconfig.node.json',
  '--test',
  ...testFiles
]

const child = spawn(electronBinary, args, {
  stdio: 'inherit',
  cwd: root,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
})
// P3 修复：Electron 二进制缺失/损坏时 spawn 会发 'error' 事件——
// 无监听会以 uncaught exception 崩溃而非打印指引
child.on('error', (err) => {
  console.error('无法启动测试进程（Electron 二进制缺失或损坏？）：', err.message)
  console.error('修复方法见 AGENT.md §6（Electron 二进制手动放置步骤）')
  process.exit(1)
})
child.on('exit', (code) => process.exit(code ?? 1))
