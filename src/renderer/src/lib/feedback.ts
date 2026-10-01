// 全局反馈基础设施：渲染层 toast + 二次确认对话框（confirmAction）。
// toast 与主进程 broadcastNotices 的 onNotices 通道合流（App.tsx 桥接），统一渲染。
import { create } from 'zustand'

export type NoticeLevel = 'success' | 'warning' | 'info'

export interface ToastItem {
  /** P3 修复：UUID 前缀字符串——原 Date.now()+Math.random() 同毫秒极小概率碰撞 */
  id: string
  level: NoticeLevel
  message: string
}

interface ToastState {
  toasts: ToastItem[]
  push: (message: string, level?: NoticeLevel) => void
  dismiss: (id: string) => void
}

export const useToasts = create<ToastState>((set, get) => ({
  toasts: [],
  push: (message, level = 'info') => {
    // P3 修复：Date.now()+Math.random() 同毫秒极小概率碰撞，改用 UUID 前缀
    const id = crypto.randomUUID()
    set((s) => ({ toasts: [...s.toasts.slice(-4), { id, level, message }] }))
    setTimeout(() => get().dismiss(id), 3500)
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
}))

/** 任意位置调用：toast('已保存', 'success') */
export const toast = (message: string, level: NoticeLevel = 'info'): void => {
  useToasts.getState().push(message, level)
}

/** 写操作失败的统一反馈：toast('保存失败：具体原因', 'warning') */
export const toastError = (action: string, err: unknown): void => {
  const detail = err instanceof Error ? err.message : String(err)
  toast(`${action}失败：${detail}`, 'warning')
}

// ── 二次确认 ─────────────────────────────────────────────────────────

export interface ConfirmOptions {
  title: string
  message: string
  /** 确认按钮文案，默认「确认」；危险操作建议「彻底删除」等具体动词 */
  confirmLabel?: string
  /** 危险操作：确认按钮与标题用 danger 色 */
  danger?: boolean
}

interface PendingConfirm extends ConfirmOptions {
  resolve: (v: boolean) => void
}

interface ConfirmState {
  pending: PendingConfirm | null
  /** 排队中的后续确认（防并发 open 相互覆盖丢失 resolver） */
  queue: Array<PendingConfirm>
  open: (o: ConfirmOptions, resolve: (v: boolean) => void) => void
  answer: (v: boolean) => void
}

export const useConfirm = create<ConfirmState>((set, get) => ({
  pending: null,
  queue: [],
  open: (o, resolve) => {
    const p = { ...o, resolve }
    if (get().pending) set((s) => ({ queue: [...s.queue, p] }))
    else set({ pending: p })
  },
  answer: (v) => {
    const { pending, queue } = get()
    pending?.resolve(v)
    set({ pending: queue[0] ?? null, queue: queue.slice(1) })
  }
}))

/** 是否有确认对话框待处理（模态期间应屏蔽全局快捷键等后台交互） */
export function isConfirmActive(): boolean {
  return useConfirm.getState().pending !== null
}

/** 删除等高危操作的二次确认：await confirmAction({ title, message, danger: true }) */
export function confirmAction(o: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    useConfirm.getState().open(o, resolve)
  })
}
