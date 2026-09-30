// 快捷键帮助浮层（M4-5，§7.9）
import { AnimatePresence, motion } from 'framer-motion'
import { X } from '@phosphor-icons/react'

const SHORTCUTS: Array<[string, string]> = [
  ['Ctrl + N', '新建任务'],
  ['Ctrl + F', '搜索任务'],
  ['Ctrl + /', '快捷键帮助'],
  ['Ctrl + 1..6', '切换左侧分组'],
  ['Space', '暂停 / 继续选中任务'],
  ['Delete', '移入回收站'],
  ['Enter', '对话框内确认解析']
]

export function HelpOverlay({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          onClick={onClose}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
        >
          <motion.div
            className="w-[380px] rounded-dialog border border-border bg-surface p-5 shadow-[var(--shadow-float)]"
            onClick={(e) => e.stopPropagation()}
            initial={{ scale: 0.96 }}
            animate={{ scale: 1 }}
            exit={{ scale: 0.97 }}
            transition={{ type: 'spring', stiffness: 100, damping: 20 }}
          >
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-medium">键盘快捷键</h2>
              <button
                className="press text-text-3 hover:text-text-1"
                onClick={onClose}
              >
                <X size={14} />
              </button>
            </div>
            <div className="space-y-1.5">
              {SHORTCUTS.map(([keys, desc]) => (
                <div key={keys} className="flex items-center justify-between">
                  <span className="text-xs text-text-2">{desc}</span>
                  <span className="kbd">{keys}</span>
                </div>
              ))}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
