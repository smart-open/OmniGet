// 参数作用域封装（M1-4，§4.2 边界表逐项）
// 全局选项：启动参数或 aria2.changeGlobalOption（首任务前生效）
// 每任务选项：aria2.changeOption(gid, …)（任务进行中可热更）

import { join } from 'path'
import { userDataDir } from '../env'

export type Aria2GlobalOptions = {
  'listen-port'?: string
  'enable-dht'?: string
  'enable-dht6'?: string
  'bt-enable-lpd'?: string
  'max-concurrent-downloads'?: string
  'file-allocation'?: string
  'max-overall-download-limit'?: string
  'bt-tracker'?: string
  'bt-max-peers'?: string
  'bt-request-peer-speed-limit'?: string
  'bt-tracker-connect-timeout'?: string
  'bt-tracker-timeout'?: string
  'min-split-size'?: string
  'dht-file-path'?: string
  'dht-file-path6'?: string
  'rpc-listen-port'?: string // 仅启动参数
}

export type Aria2TaskOptions = {
  'select-file'?: string
  dir?: string
  'seed-ratio'?: string
  'max-connection-per-server'?: string
  'check-integrity'?: string
  'max-download-limit'?: string
  split?: string
  continue?: string
  'bt-save-metadata'?: string
  pause?: string
}

/** 全局选项默认值（继承 torrent_dl.py 推荐值，§附录 A；含下载加速调优） */
export function defaultGlobalOptions(): Aria2GlobalOptions {
  return {
    'listen-port': '6881',
    'enable-dht': 'true',
    'enable-dht6': 'true',
    'bt-enable-lpd': 'true',
    'max-concurrent-downloads': '8',
    'file-allocation': 'none',
    'max-overall-download-limit': '0',
    'bt-max-peers': '200',
    // 加速：整体速度低于 10M 时 aria2 主动提高 peer 连接换手积极性
    'bt-request-peer-speed-limit': '10M',
    'bt-tracker-connect-timeout': '10',
    'bt-tracker-timeout': '15',
    // HTTP 加速：分片下限降到 1M（默认 20M 会让大文件分片太少、并行不足）
    'min-split-size': '1M',
    // DHT 路由表持久化：冷启动直接复用上次节点，无需重新引导发现
    'dht-file-path': join(userDataDir(), 'dht.dat'),
    'dht-file-path6': join(userDataDir(), 'dht6.dat')
  }
}

/** 生成 aria2c 启动参数（全局选项仅能经启动参数注入的部分） */
export function toSpawnArgs(globalOpts: Aria2GlobalOptions, rpcSecret: string, rpcPort: number): string[] {
  return [
    '--enable-rpc',
    `--rpc-secret=${rpcSecret}`,
    `--rpc-listen-port=${String(rpcPort)}`,
    '--rpc-listen-all=false',
    '--continue=true',
    '--check-integrity=false',
    '--auto-file-renaming=false',
    '--allow-overwrite=true',
    '--summary-interval=0',
    ...Object.entries(globalOpts)
      .filter(([k, v]) => v !== undefined && k !== 'rpc-listen-port')
      .map(([k, v]) => `--${k}=${v}`)
  ]
}

/**
 * 每任务选项构建（§4.2 边界表）。
 * - BT/磁力：select-file/seed-ratio/dir 为热更项
 * - HTTP：split 与 max-connection-per-server 同值（脚本约定）
 */
export function buildTaskOptions(input: {
  type: 'bt' | 'magnet' | 'http'
  threads: number
  saveDir: string
  selectedFileIndexes?: number[]
  seedRatio?: number
  checkIntegrity?: boolean
}): Aria2TaskOptions {
  const opts: Aria2TaskOptions = {
    dir: input.saveDir,
    // aria2 硬限制 1–16（超限直接拒绝任务）；split 上限另行 64
    'max-connection-per-server': String(Math.min(16, Math.max(1, input.threads))),
    'check-integrity': input.checkIntegrity ? 'true' : 'false'
  }
  if (input.type === 'http') {
    opts.split = String(Math.min(64, Math.max(1, input.threads)))
    opts.continue = 'true'
  } else {
    opts['seed-ratio'] = String(input.seedRatio ?? 0)
    if (input.selectedFileIndexes?.length) {
      opts['select-file'] = input.selectedFileIndexes.join(',')
    }
  }
  return opts
}
