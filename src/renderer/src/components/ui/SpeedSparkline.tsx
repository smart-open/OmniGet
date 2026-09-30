// 顶栏迷你速度曲线（§7.8 永续微动效之三）：自绘 SVG，数据驱动滚动，无 CSS 循环。
// memo 化叶子组件，速度历史由 store 维护。

import { memo } from 'react'

export const SpeedSparkline = memo(function SpeedSparkline({
  history,
  width = 88,
  height = 24
}: {
  history: number[]
  width?: number
  height?: number
}) {
  const n = 32
  const data = history.slice(-n)
  const pad = data.length < n ? Array(n - data.length).fill(0) : []
  const series = [...pad, ...data]
  const max = Math.max(...series, 1024) // 下限 1KB/s，避免空态时曲线坍缩成直线
  const step = width / (n - 1)

  const points = series.map((v, i) => {
    const x = i * step
    const y = height - 2 - (v / max) * (height - 5)
    return `${x.toFixed(1)},${y.toFixed(1)}`
  })
  const line = points.join(' ')
  const area = `0,${height} ${line} ${width},${height}`

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="overflow-visible"
      aria-hidden
    >
      <polygon points={area} fill="var(--accent-soft)" />
      <polyline
        points={line}
        fill="none"
        stroke="var(--accent)"
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  )
})
