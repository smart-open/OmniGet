// UPnP / NAT-PMP 端口映射（R7 P0-1，docs/下载引擎优化方案 §三 P0-1）
// BT 速度第一影响因素 = 可连接性：NAT 后端口未映射时 peer 无法主动连入，
// peer 数与下载速度数量级下降（qBittorrent/Transmission 优化共识）。
// 映射目标：aria2 listen-port（TCP，BT 数据）+ dht-listen-port（UDP，DHT/UDP tracker）。
// 失败静默降级（路由器不支持 UPnP/NAT-PMP 属常态），仅日志留痕；
// 设置项 bt.upnp（默认开）可整体关闭。

import type NatAPI from 'nat-api'
import { createLogger } from '../logger'

const log = createLogger('nat')

let client: NatAPI | null = null
let mapped = false
let lastError: string | null = null

/** 供设置页展示最近一次映射结果（unknown=未尝试，true=成功，false=失败） */
export function natMappingStatus(): { attempted: boolean; ok: boolean; error: string | null } {
  return { attempted: client !== null, ok: mapped, error: lastError }
}

function mapOne(
  c: NatAPI,
  port: number,
  protocol: 'TCP' | 'UDP',
  description: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    c.map({ publicPort: port, privatePort: port, protocol, ttl: 7200, description }, (err) => {
      if (err) reject(err)
      else resolve()
    })
  })
}

/** aria2 online 后调用：映射 BT 端口池首个端口（路由器 ext:port → 本机 port）。
 * nat-api autoUpdate 默认开启（TTL 到期前自动续期），无需自建定时器。
 * 幂等：aria2 崩溃重启会重复触发 onOnline——已映射时直接跳过。 */
export async function setupNatMapping(): Promise<void> {
  if (client) return
  const { getSettingParsed } = await import('../db')
  if (getSettingParsed<boolean>('bt.upnp') === false) {
    log.info('nat mapping disabled by setting bt.upnp=false')
    return
  }
  // 动态 require：nat-api 无 ESM 入口；失败（缺依赖/平台异常）静默降级
  let NatAPICtor: typeof NatAPI
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    NatAPICtor = require('nat-api') as typeof NatAPI
  } catch (err) {
    log.warn('nat-api 加载失败（跳过端口映射）', { error: String(err) })
    return
  }
  const { btPrimaryPorts } = await import('../aria2/options')
  const { tcp, udp } = btPrimaryPorts()
  try {
    client = new NatAPICtor({ ttl: 7200, autoUpdate: true, enablePMP: true, timeout: 5000 })
    // TCP 与 UDP 各一条映射；PMP 协议 TCP 不支持时回调错误——逐条容错。
    // 审查修复：mapped 按实际成功数置位（原实现即使全部失败也置 true，状态误报）
    let okCount = 0
    const errors: string[] = []
    await mapOne(client, tcp, 'TCP', 'OmniGet BT')
      .then(() => {
        okCount++
      })
      .catch((e: Error) => {
        errors.push(`TCP ${tcp}: ${e.message}`)
        log.warn(`TCP ${tcp} 映射失败: ${e.message}`)
      })
    await mapOne(client, udp, 'UDP', 'OmniGet DHT')
      .then(() => {
        okCount++
      })
      .catch((e: Error) => {
        errors.push(`UDP ${udp}: ${e.message}`)
        log.warn(`UDP ${udp} 映射失败: ${e.message}`)
      })
    mapped = okCount > 0
    lastError = mapped ? (errors.length ? errors.join('; ') : null) : errors.join('; ') || '全部映射失败'
    if (mapped) {
      log.info(`NAT 映射完成（${okCount}/2）: TCP ${tcp} + UDP ${udp}（UPnP/NAT-PMP）`)
    } else {
      log.warn(`NAT 端口映射失败（路由器可能不支持 UPnP/NAT-PMP）: ${lastError}`)
    }
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err)
    mapped = false
    log.warn(`NAT 端口映射失败（路由器可能不支持 UPnP/NAT-PMP）: ${lastError}`)
  }
}

/** 应用退出时撤销映射（fire-and-forget：未及撤销的映射由 TTL 自行过期） */
export function clearNatMapping(): void {
  const c = client
  client = null
  mapped = false
  if (!c) return
  try {
    c.destroy()
    log.info('NAT 映射已撤销')
  } catch {
    // ignore
  }
}
