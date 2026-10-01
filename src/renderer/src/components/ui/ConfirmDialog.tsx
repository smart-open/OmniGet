// 全局二次确认对话框（挂载一次于 App；经 confirmAction() 以 Promise 形式调用）
import { AnimatePresence, motion } from 'framer-motion'
import { Warning } from '@phosphor-icons/react'
import { useEffect } from 'react'
import { useConfirm } from '../../lib/feedback'
import { Button } from './Button'

export function ConfirmDialog() {
  const pending = useConfirm((s) => s.pending)
  const answer = useConfirm((s) => s.answer)
  const open = pending !== null

  // Esc = 取消；Enter = 确认（danger 级除外：删除类操作不得被 Enter 直通，必须显式点击）
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      // 输入控件内的 Enter/Escape 不当作对话框按键（防正在输入时误确认）
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if (e.key === 'Escape') answer(false)
      else if (e.key === 'Enter' && !pending?.danger) answer(true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, answer, pending])

  return (
    <AnimatePresence>
      {pending && (
        <motion.div
          key="confirm-mask"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60"
          onClick={() => answer(false)}
        >
          <motion.div
            initial={{ scale: 0.95, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.95, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 300, damping: 28 }}
            className="w-[380px] rounded-dialog border border-border bg-surface p-5 shadow-[var(--shadow-float)]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-2 flex items-center gap-2">
              {pending.danger && <Warning size={16} weight="fill" className="shrink-0 text-danger" />}
              <h3 className={`text-sm font-medium ${pending.danger ? 'text-danger' : 'text-text-1'}`}>
                {pending.title}
              </h3>
            </div>
            <p className="text-xs leading-relaxed text-text-2">{pending.message}</p>
            <div className="mt-5 flex justify-end gap-2">
              <Button size="sm" variant="outline" onClick={() => answer(false)}>
                取消
              </Button>
              <Button
                size="sm"
                variant={pending.danger ? 'primary' : 'primary'}
                className={pending.danger ? '!bg-danger hover:!bg-danger/85' : undefined}
                onClick={() => answer(true)}
              >
                {pending.confirmLabel ?? '确认'}
              </Button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
