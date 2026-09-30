// uuid v7（时间有序，§4.1）：48bit ms 时间戳 + 随机位。

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
  const ts = Buffer.alloc(6)
  ts.writeUIntBE(now, 0, 6)

  const rand = randomBytes(8)
  // version 7
  rand[0] = 0x70 | (rand[0]! & 0x0f)
  // variant 10xx
  rand[2] = 0x80 | (rand[2]! & 0x3f)

  const hex = ts.toString('hex')
  const r = rand.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8)}-7${r.slice(0, 3)}-${r.slice(3, 7)}-${r.slice(7, 19)}`
}
