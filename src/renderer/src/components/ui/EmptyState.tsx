// 构成式空态（§7.1 原则 4）：几何层叠插画（下载托盘隐喻）+ 一个动作按钮。
// 缓浮动效隔离在本叶子组件（§7.8 永续微动效之一）。

import { memo } from 'react'
import { Plus } from '@phosphor-icons/react'
import { Button } from './Button'

export const EmptyState = memo(function EmptyState({
  title,
  hint,
  actionLabel,
  onAction
}: {
  title: string
  hint: string
  actionLabel: string
  onAction: () => void
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-5">
      {/* 构成式插画：三层几何 + 降落箭头，全部 transform 动效 */}
      <div className="animate-[float_3.2s_ease-in-out_infinite]">
        <svg width="120" height="96" viewBox="0 0 120 96" fill="none" aria-hidden>
          {/* 背层 */}
          <rect x="22" y="8" width="76" height="52" rx="10" fill="var(--surface-2)" opacity="0.6" />
          {/* 中层：任务条 */}
          <rect x="14" y="20" width="76" height="52" rx="10" fill="var(--surface)" stroke="var(--border)" />
          <rect x="26" y="34" width="36" height="4" rx="2" fill="var(--text-3)" opacity="0.5" />
          <rect x="26" y="44" width="52" height="3" rx="1.5" fill="var(--accent)" opacity="0.85" />
          <rect x="26" y="44" width="30" height="3" rx="1.5" fill="var(--accent)" />
          <rect x="26" y="52" width="44" height="3" rx="1.5" fill="var(--text-3)" opacity="0.35" />
          {/* 前层：托盘 */}
          <path
            d="M40 66 L80 66 L96 82 Q98 84 94 84 L26 84 Q22 84 24 82 Z"
            fill="var(--surface-2)"
            stroke="var(--border)"
          />
          {/* 降落数据块 */}
          <rect x="56" y="12" width="8" height="14" rx="2" fill="var(--accent)" opacity="0.9" />
          <path d="M52 22 L60 30 L68 22" stroke="var(--accent)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" opacity="0.9" />
        </svg>
      </div>
      <div className="text-center">
        <p className="text-sm font-medium text-text-2">{title}</p>
        <p className="mt-1 text-xs text-text-3">{hint}</p>
      </div>
      {/* 主 CTA：强调色胶囊 + 图标 + 浮起阴影 */}
      <Button
        size="sm"
        variant="primary"
        onClick={onAction}
        icon={<Plus size={13} weight="bold" />}
        className="h-9 rounded-full px-5 shadow-[0_4px_16px_var(--accent-soft)]"
      >
        {actionLabel}
      </Button>
    </div>
  )
})
