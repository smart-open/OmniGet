import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'

type Variant = 'primary' | 'ghost' | 'outline' | 'danger'
type Size = 'xs' | 'sm' | 'md'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
  icon?: ReactNode
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', icon, className = '', children, ...props },
  ref
) {
  const base =
    'press inline-flex items-center justify-center gap-1.5 rounded-ctl font-medium transition-colors duration-150 disabled:opacity-40 disabled:pointer-events-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40'
  const sizes: Record<Size, string> = {
    xs: 'h-6 px-2 text-[11px]',
    sm: 'h-7 px-2.5 text-xs',
    md: 'h-9 px-4 text-sm'
  }
  const variants: Record<Variant, string> = {
    primary: 'bg-accent text-white hover:bg-accent-press',
    ghost: 'text-text-2 hover:text-text-1 hover:bg-surface-2',
    outline: 'border border-border text-text-2 hover:text-text-1 hover:border-text-3',
    danger: 'text-danger hover:bg-danger/10'
  }
  return (
    <button
      ref={ref}
      className={`${base} ${sizes[size]} ${variants[variant]} ${className}`}
      {...props}
    >
      {icon}
      {children}
    </button>
  )
})
