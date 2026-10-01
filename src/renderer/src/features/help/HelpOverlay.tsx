// 快捷键帮助浮层（M4-5，§7.9）。
// P3 修复：键位此前硬编码默认值——用户自定义后帮助面板与实际不符；
// 现读取 effectiveKeys（默认表 + 用户覆盖），打开时刷新。
import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { X } from '@phosphor-icons/react'
import { effectiveKeys, formatKey, parseKeymap, type ShortcutAction } from '../../shortcuts'

const ACTIONS: Array<{ action: ShortcutAction; desc: string; fallback: string }> = [
  { action: 'new-task', desc: '新建任务', fallback: 'Ctrl+N' },
  { action: 'search', desc: '搜索任务', fallback: 'Ctrl+F' },
  { action: 'help', desc: '快捷键帮助', fallback: 'Ctrl+/' },
  { action: 'group1', desc: '分组 1 · 全部', fallback: 'Ctrl+1' },
  { action: 'group2', desc: '分组 2 · 下载中', fallback: 'Ctrl+2' },
  { action: 'group3', desc: '分组 3 · 已完成', fallback: 'Ctrl+3' },
  { action: 'pause-toggle', desc: '暂停 / 继续选中任务', fallback: 'Space' },
  { action: 'trash', desc: '移入回收站', fallback: 'Delete' }
]

export function HelpOverlay({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [rows, setRows] = useState<Array<{ keys: string; desc: string }>>([])

  useEffect(() => {
    if (!open) return
    void window.omniget
      .settingsGet('ui.keymap')
      .then((v) => {
        const keys = effectiveKeys(parseKeymap(v))
        setRows(
          ACTIONS.map(({ action, desc, fallback }) => ({
            keys: formatKey(keys[action]) || fallback,
            desc
          }))
        )
      })
      .catch(() => setRows(ACTIONS.map(({ desc, fallback }) => ({ keys: fallback, desc }))))
  }, [open])

  // P3 修复：Esc 关闭帮助面板（App 在面板打开期间屏蔽全局按键，需面板自行处理）
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

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
              {rows.map(({ keys, desc }) => (
                <div key={desc} className="flex items-center justify-between">
                  <span className="text-xs text-text-2">{desc}</span>
                  <span className="kbd">{keys}</span>
                </div>
              ))}
              <div className="flex items-center justify-between">
                <span className="text-xs text-text-2">对话框内确认解析</span>
                <span className="kbd">Enter</span>
              </div>
            </div>
            <p className="mt-3 text-[10px] text-text-3">
              键位可在 设置 → 快捷键 中自定义；「Ctrl + 4..6」切换其余分组
            </p>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
