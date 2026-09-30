import type { ButtonHTMLAttributes, ReactNode } from 'react'

/** 悬停提示（纯 CSS，跟随按钮上方居中） */
export function Tooltip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="group/tip relative inline-flex">
      {children}
      <span
        role="tooltip"
        className="pointer-events-none absolute -top-1 left-1/2 z-50 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-md border border-border bg-[var(--tooltip-bg)] px-2 py-1 text-[11px] leading-none text-text-1 opacity-0 shadow-lg transition-opacity duration-150 group-hover/tip:opacity-100"
      >
        {label}
      </span>
    </span>
  )
}

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** hover 提示文案（必填：图标按钮必须带名称） */
  tip: string
  children: ReactNode
}

/** 图标按钮（§7.2：只展示图标，hover 出名称） */
export function IconButton({ tip, children, className = '', ...props }: IconButtonProps) {
  return (
    <Tooltip label={tip}>
      <button
        type="button"
        aria-label={tip}
        className={`press inline-flex h-8 w-8 items-center justify-center rounded-ctl text-text-2 transition-colors hover:bg-surface-2 hover:text-text-1 disabled:pointer-events-none disabled:opacity-40 ${className}`}
        {...props}
      >
        {children}
      </button>
    </Tooltip>
  )
}
