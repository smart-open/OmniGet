// 骨架屏：与最终布局同形（§7.1 原则 4），shimmer 隔离在本叶子组件（§7.8 性能红线）。

export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`skeleton-line rounded-ctl ${className}`} />
}

/** 与任务行同构的三段骨架 */
export function TaskRowSkeleton({ index = 0 }: { index?: number }) {
  return (
    <div
      className="row-line px-4 py-2.5"
      style={{ opacity: 1 - index * 0.12 }}
    >
      <div className="flex items-center gap-2">
        <Skeleton className="h-3.5 w-3.5 rounded-full" />
        <Skeleton className="h-3.5 w-2/5" />
        <div className="flex-1" />
        <Skeleton className="h-3 w-24" />
      </div>
      <div className="mt-2 flex items-center gap-2">
        <Skeleton className="h-2.5 w-36" />
      </div>
      <Skeleton className="meter mt-2 !rounded-full" />
    </div>
  )
}
