// nat-api 无官方类型定义（index.js + lib/，无 index.d.ts）——按 README 核实的手写声明
declare module 'nat-api' {
  interface NatMapOptions {
    publicPort: number
    privatePort?: number
    protocol?: 'TCP' | 'UDP'
    description?: string
    /** 映射存活秒数；autoUpdate=true 时库内部自动续期 */
    ttl?: number
  }
  interface NatClientOptions {
    ttl?: number
    autoUpdate?: boolean
    gateway?: string | null
    /** 启用 NAT-PMP（轻量协议，UPnP 不生效时兜底） */
    enablePMP?: boolean
    timeout?: number
  }
  class NatAPI {
    constructor(opts?: NatClientOptions)
    map(
      opts: NatMapOptions | number,
      privatePortOrCallback?: number | ((err: Error | null) => void),
      callback?: (err: Error | null) => void
    ): void
    unmap(
      opts: NatMapOptions | number,
      callback?: (err: Error | null) => void
    ): void
    externalIp(callback: (err: Error | null, ip?: string) => void): void
    destroy(): void
  }
  export = NatAPI
}
