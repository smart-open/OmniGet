declare module 'bencode' {
  // bencode 的实际类型面较宽（字符串自动编码为 Buffer），采用宽松声明
  export function decode(data: Buffer): Record<string, any> | any[] | number | Buffer
  export function encode(value: unknown): Buffer
}
