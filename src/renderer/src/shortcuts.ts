// 快捷键（§7.9 可自定义版）：默认表 + 用户覆盖（settings ui.keymap）+ 录制归一化。
// key 格式：小写组合，如 'ctrl+n' / 'ctrl+/' / 'space' / 'delete' / 'ctrl+1'。

export type ShortcutAction =
  | 'new-task'
  | 'search'
  | 'help'
  | 'group1'
  | 'group2'
  | 'group3'
  | 'group4'
  | 'group5'
  | 'group6'
  | 'pause-toggle'
  | 'trash'

export const DEFAULT_KEYS: Record<ShortcutAction, string> = {
  'new-task': 'ctrl+n',
  search: 'ctrl+f',
  help: 'ctrl+/',
  group1: 'ctrl+1',
  group2: 'ctrl+2',
  group3: 'ctrl+3',
  group4: 'ctrl+4',
  group5: 'ctrl+5',
  group6: 'ctrl+6',
  'pause-toggle': 'space',
  trash: 'delete'
}

export const SHORTCUT_LABELS: Record<ShortcutAction, string> = {
  'new-task': '新建任务',
  search: '搜索任务',
  help: '快捷键帮助',
  // 审查修复：与 App.tsx NAV_GROUPS 扁平顺序对齐（R6 插入「处理失败」视图后
  // 文案错位一格，音乐分组从此无快捷键可达）
  group1: '切换到 全部',
  group2: '切换到 处理中',
  group3: '切换到 处理失败',
  group4: '切换到 处理完成',
  group5: '切换到 种子磁力',
  group6: '切换到 视频',
  'pause-toggle': '暂停 / 继续选中',
  trash: '移入回收站（选中）'
}

/** 用户覆盖表（仅存与默认不同的项） */
export type Keymap = Partial<Record<ShortcutAction, string>>

export function parseKeymap(v: unknown): Keymap {
  if (!v || typeof v !== 'object') return {}
  const out: Keymap = {}
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === 'string' && val) out[k as ShortcutAction] = val
  }
  return out
}

/** 生效键位 = 默认 + 覆盖 */
export function effectiveKeys(overrides: Keymap): Record<ShortcutAction, string> {
  return { ...DEFAULT_KEYS, ...overrides }
}

/** 键盘事件 → 归一化 key（用于匹配与录制） */
export function eventToKey(e: KeyboardEvent): string | null {
  const k = e.key
  if (k === 'Control' || k === 'Shift' || k === 'Alt' || k === 'Meta') return null
  let main: string
  if (k === ' ') main = 'space'
  else if (k === 'Delete') main = 'delete'
  else if (k === 'Escape') main = 'esc'
  else if (k === '/') main = '/'
  else main = k.toLowerCase()
  const parts: string[] = []
  if (e.ctrlKey) parts.push('ctrl')
  if (e.altKey) parts.push('alt')
  if (e.shiftKey && main !== 'space') parts.push('shift')
  if (e.metaKey) parts.push('meta')
  parts.push(main)
  return parts.join('+')
}

/** 展示格式：ctrl+n → Ctrl N */
export function formatKey(key: string): string {
  return key
    .split('+')
    .map((p) => (p === 'ctrl' ? 'Ctrl' : p === 'space' ? 'Space' : p.charAt(0).toUpperCase() + p.slice(1)))
    .join(' + ')
    .replace('Ctrl + /', 'Ctrl + /')
}
