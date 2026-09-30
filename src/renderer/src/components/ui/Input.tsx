import { forwardRef, type InputHTMLAttributes, type ReactNode } from 'react'

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** 前置图标槽 */
  lead?: ReactNode
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className = '', lead, ...props },
  ref
) {
  if (lead) {
    return (
      <div
        className={`flex h-9 items-center gap-2 rounded-ctl border border-border bg-surface px-3 transition-colors focus-within:border-accent ${className}`}
      >
        <span className="shrink-0 text-text-3">{lead}</span>
        <input
          ref={ref}
          className="min-w-0 flex-1 bg-transparent text-sm text-text-1 outline-none placeholder:text-text-3"
          {...props}
        />
      </div>
    )
  }
  return (
    <input
      ref={ref}
      className={`h-9 w-full rounded-ctl border border-border bg-surface px-3 text-sm text-text-1 placeholder:text-text-3 outline-none transition-colors focus:border-accent ${className}`}
      {...props}
    />
  )
})
