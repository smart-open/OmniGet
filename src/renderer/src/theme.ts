// 主题管理：多主题 + 跟随系统（persist: settings ui.theme）
// data-theme 取值与 tokens.css 的 :root[data-theme=...] 一一对应。

export type ThemeId = 'system' | 'light' | 'dark' | 'violet' | 'green' | 'amber' | 'blue'

export interface ThemeMeta {
  id: ThemeId
  label: string
  /** 选择器里的色板预览（bg/accent） */
  bg: string
  accent: string
  /** 预览圆点边框是否需要浅色（深底时） */
  dark: boolean
}

export const THEMES: ThemeMeta[] = [
  // bg = 色板圆块底色（实色完整圆）；accent = 圆块描边环，双信息一眼辨主题。
  // 随系统用左右对分（黑/白）表达「跟随系统深浅」。
  { id: 'system', label: '随系统', bg: 'linear-gradient(90deg,#0b0c0e 50%,#f7f8f9 50%)', accent: '#5aa0ff', dark: true },
  { id: 'light', label: '石墨灰', bg: '#f7f8f9', accent: '#2563eb', dark: false },
  { id: 'dark', label: '曜石黑', bg: '#0b0c0e', accent: '#5aa0ff', dark: true },
  { id: 'violet', label: '暗夜紫', bg: '#0f0c1a', accent: '#a78bfa', dark: true },
  { id: 'green', label: '青墨绿', bg: '#0a100d', accent: '#34d399', dark: true },
  { id: 'amber', label: '琥珀橙', bg: '#141008', accent: '#fbbf24', dark: true },
  { id: 'blue', label: '科技蓝', bg: '#0a0f1c', accent: '#3b82f6', dark: true }
]

/** system → 跟随 prefers-color-scheme 解析成具体主题 */
export function resolveTheme(id: ThemeId): Exclude<ThemeId, 'system'> {
  if (id !== 'system') return id
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

/** 应用主题到 documentElement；返回实际生效的具体主题 */
export function applyTheme(id: ThemeId): Exclude<ThemeId, 'system'> {
  const effective = resolveTheme(id)
  document.documentElement.dataset.theme = effective
  return effective
}

/** 读取持久化主题（兼容历史值：oled→dark，非法值→system） */
export function parseStoredTheme(v: unknown): ThemeId {
  if (typeof v === 'string' && THEMES.some((t) => t.id === v)) return v as ThemeId
  if (v === 'oled') return 'dark'
  return 'system'
}

/** 跟随系统变化监听（仅 system 主题需要响应）；返回取消函数 */
export function watchSystemTheme(id: ThemeId, onChange: (effective: Exclude<ThemeId, 'system'>) => void): () => void {
  if (id !== 'system') return () => {}
  const mq = window.matchMedia('(prefers-color-scheme: dark)')
  const fn = (): void => onChange(applyTheme('system'))
  mq.addEventListener('change', fn)
  return () => mq.removeEventListener('change', fn)
}
