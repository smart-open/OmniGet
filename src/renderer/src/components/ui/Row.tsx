import type { HTMLAttributes } from 'react'

// 行容器：divide-y 线性分区，禁卡片盒子（§7.1 原则 1）
export function Row({ className = '', ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={`row-line px-4 py-3 transition-colors hover:bg-surface-2 group ${className}`}
      {...props}
    />
  )
}
