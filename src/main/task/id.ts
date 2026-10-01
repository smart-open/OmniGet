// uuid v7（时间有序，§4.1）：48bit ms 时间戳 + 随机位。
// L8 修复：随机段扩到 10 字节（80bit），此前 8 字节被格式串截成 9 字符尾段，
// 产物不是合法 UUID——任何按 UUID 校验的下游（导入/同步）都会拒绝。

import { randomBytes } from 'crypto'

let lastMs = 0
let seq = 0

export function uuidv7(): string {
  const now = Date.now()
  if (now === lastMs) {
    seq = (seq + 1) & 0xfff
  } else {
    lastMs = now
    seq = randomBytes(2).readUInt16BE(0) & 0xfff
  }
  const buf = Buffer.alloc(16)
  // 48bit unix ms（bytes 0-5）。L2 修复：seq 12 位完整嵌入 rand_a（bytes 6-7 低 12 位）
  // ——此前 rand[0] 低 4 位仍随机、rand[1] 完全随机，同毫秒内排序承诺落空
  buf.writeUIntBE(now, 0, 6)
  const rand = randomBytes(10)
  rand[0] = (0x70 | (((seq >> 8) & 0x0f) as number)) as number // byte6：version 7 + rand_a 高 4 位 = seq 高 4 位
  rand[1] = seq & 0xff // byte7：rand_a 低 8 位 = seq 低 8 位
  rand[2] = 0x80 | (rand[2]! & 0x3f) // byte8：variant 10xx
  rand.copy(buf, 6)

  const h = buf.toString('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}
