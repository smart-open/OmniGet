// 参数作用域封装（M1-4，§4.2 边界表逐项）
// 全局选项：启动参数或 aria2.changeGlobalOption（首任务前生效）
// 每任务选项：aria2.changeOption(gid, …)（任务进行中可热更）

import { join } from 'path'
import { userDataDir } from '../env'

export type Aria2GlobalOptions = {
  'listen-port'?: string
  'dht-listen-port'?: string
  'peer-id-prefix'?: string
  'peer-agent'?: string
  'enable-dht'?: string
  'enable-dht6'?: string
  'bt-enable-lpd'?: string
  'max-concurrent-downloads'?: string
  'file-allocation'?: string
  'max-overall-download-limit'?: string
  'max-overall-upload-limit'?: string
  'bt-tracker'?: string
  'bt-max-peers'?: string
  'bt-request-peer-speed-limit'?: string
  'bt-tracker-connect-timeout'?: string
  'bt-tracker-timeout'?: string
  'min-split-size'?: string
  'dht-file-path'?: string
  'dht-file-path6'?: string
  'dht-entry-point'?: string
  'dht-entry-point6'?: string
  // R7 优化（官方 1.37 手册逐项核实存在）
  'bt-force-encryption'?: string // arc4 加密握手，绕运营商 BT QoS
  'bt-stop-timeout'?: string // 连续 0 速自动停止，防死种占并发槽
  'bt-detach-seed-only'?: string // 并发计数排除纯做种
  'bt-load-saved-metadata'?: string // 磁力先读本机已存 .torrent，命中秒出元数据
  'uri-selector'?: string // 多源镜像测速选择
  'optimize-concurrent-downloads'?: string // 按带宽自动扩并发
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
  /** R7 续（backlog #11）：sidecar 兜底任务按解析服务标题落盘（http addUri） */
  out?: string
  /** R7 续审查加固：sidecar 兜底直链常校验 UA/referer（与探测同源伪装） */
  'user-agent'?: string
  referer?: string
  'bt-save-metadata'?: string
  pause?: string
  // P1 加固：allow-overwrite 从全局启动参数收窄为每任务——仅增量补下（re-add 凭
  // 已存在文件做秒校验）显式开启；新任务默认拒绝覆盖已存在的同名文件
  'allow-overwrite'?: string
}

/** 全局选项默认值（继承 torrent_dl.py 推荐值，§附录 A；含下载加速调优）。
 * R7 优化：端口范围/DHT UDP 端口/加密/僵尸任务清理/多源调度——全部经官方
 * 1.37 手册核实存在（dht-bootstrap-node/peer-id 不存在，勿引入）。
 * btForceEncryption：设置项 bt.forceEncryption（默认开），由调用方读取后传入 */
export function defaultGlobalOptions(bt?: { btForceEncryption?: boolean }): Aria2GlobalOptions {
  return {
    // R7：端口范围（原单端口 6881）——入站可用端口池更大，配合 UPnP 映射提升可连接性
    'listen-port': '6881-6891',
    // R7：DHT/UDP tracker 监听端口（默认即 6881-6999，显式声明与 TCP 范围对齐）
    'dht-listen-port': '6881-6891',
    'enable-dht': 'true',
    'enable-dht6': 'true',
    'bt-enable-lpd': 'true',
    'max-concurrent-downloads': '8',
    'file-allocation': 'none',
    'max-overall-download-limit': '0',
    // 加速：BT 上传限速 1M——seed-ratio=0 无限做种 + 上传不限速会打满上行，
    // TCP ACK 挤占导致下载掉速（家用非对称带宽最常见瓶颈）
    'max-overall-upload-limit': '1M',
    'bt-max-peers': '200',
    // 加速：整体速度低于 10M 时 aria2 主动提高 peer 连接换手积极性
    'bt-request-peer-speed-limit': '10M',
    'bt-tracker-connect-timeout': '10',
    'bt-tracker-timeout': '15',
    // HTTP 加速：分片下限降到 1M（默认 20M 会让大文件分片太少、并行不足）
    'min-split-size': '1M',
    // DHT 路由表持久化：冷启动直接复用上次节点，无需重新引导发现
    'dht-file-path': join(userDataDir(), 'dht.dat'),
    'dht-file-path6': join(userDataDir(), 'dht6.dat'),
    // 加速：DHT 入口节点引导——dht.dat 缺失/失效时立即入网，避免数分钟空转找 peer
    'dht-entry-point': 'router.bittorrent.com:6881',
    'dht-entry-point6': 'dht.transmissionbt.com:6881',
    // R7：BT 消息 arc4 加密握手——绕运营商 BT QoS 限速/干扰（个别客户端拒绝加密
    // 连接会损失少量 peer，做成设置项可关闭）
    'bt-force-encryption': bt?.btForceEncryption === false ? 'false' : 'true',
    // R7：连续 30 分钟 0 速自动停止 BT 任务——死种不再永久占并发槽
    'bt-stop-timeout': '1800',
    // R7：maxConcurrentDownloads 闸门计数排除纯做种任务（seeding 不算下载）
    'bt-detach-seed-only': 'true',
    // R7：磁力任务优先读本机已存 .torrent（userData/torrents/ 同目录时秒出元数据）
    'bt-load-saved-metadata': 'true',
    // R7 多源：adaptive=首连接选最优镜像，其余并发测试未试镜像（P2SP-lite 调度）
    'uri-selector': 'adaptive',
    // R7 多源：按带宽自动扩并发（N = 5 + 25·log₁₀(带宽 Mbps)）
    'optimize-concurrent-downloads': 'true',
    // R7 P2：peer 指纹伪装为 qBittorrent 4.6.5——部分客户端/站点对 aria2 的
    // peer-id 降权/拒连，社区通行做法（本机出站指纹，无安全影响）
    'peer-id-prefix': '-qB4650-',
    'peer-agent': 'qBittorrent 4.6.5'
  }
}

/** R7：BT 监听端口池首个端口（UPnP 映射目标；路由器只转发该端口到本机，端口池内其余端口供出站使用） */
export function btPrimaryPorts(): { tcp: number; udp: number } {
  const opts = defaultGlobalOptions()
  const first = (v: string | undefined): number => Number(v?.split(/[,-]/)[0] ?? 6881) || 6881
  return { tcp: first(opts['listen-port']), udp: first(opts['dht-listen-port']) }
}

/** 生成 aria2c 启动参数（全局选项仅能经启动参数注入的部分）。
 * P3 加固：RPC secret 经文件注入（--rpc-secret-file）——原 --rpc-secret 会出现在
 * 进程命令行，本机其他进程经 wmic/任务管理器可直接读取 */
export function toSpawnArgs(globalOpts: Aria2GlobalOptions, rpcSecretConf: string, rpcPort: number): string[] {
  return [
    '--enable-rpc',
    // R5 修复：aria2c 没有 --rpc-secret-file 选项（原 third-round 改造臆造，
    // 实测 aria2c 直接 exit 28）——改用 --conf-path 携带只含 rpc-secret 的
    // 配置文件，同样保持 secret 不出现在命令行
    `--conf-path=${rpcSecretConf}`,
    `--rpc-listen-port=${String(rpcPort)}`,
    '--rpc-listen-all=false',
    '--continue=true',
    '--check-integrity=false',
    '--auto-file-renaming=false',
    // P1 加固：默认拒绝覆盖（此前 true 会静默覆盖用户同名文件且不产生副本；
    // 增量补下任务经每任务选项显式放行）
    '--allow-overwrite=false',
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
  allowOverwrite?: boolean
}): Aria2TaskOptions {
  const opts: Aria2TaskOptions = {
    dir: input.saveDir,
    // aria2 硬限制 1–16（超限直接拒绝任务）；split 上限另行 64
    'max-connection-per-server': String(Math.min(16, Math.max(1, input.threads))),
    'check-integrity': input.checkIntegrity ? 'true' : 'false'
  }
  if (input.allowOverwrite) {
    opts['allow-overwrite'] = 'true'
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
