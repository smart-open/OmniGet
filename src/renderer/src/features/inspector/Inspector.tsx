// M4-2 任务详情 Inspector 抽屉（§7.8）：layoutId 共享元素过渡（行标题 → 抽屉头）、
// spring 入场、内容 stagger；实时进度来自任务事件流，文件清单来自 task:detail。
// 动效红线：只动 transform/opacity。

import { AnimatePresence, motion } from 'framer-motion'
import {
  ArrowClockwise,
  ArrowSquareOut,
  Copy,
  FileText,
  Pause,
  Play,
  Trash,
  X
} from '@phosphor-icons/react'
import type { Task, TaskFile } from '@shared/types'
import { useEffect, useState } from 'react'
import { FILE_CATEGORIES, fileCategory } from '@shared/file-category'
import { confirmAction, toast } from '../../lib/feedback'
import { formatBytes } from '../new-task/fileTree'

const spring = { type: 'spring' as const, stiffness: 300, damping: 32 }

const STATUS_LABEL: Record<string, string> = {
  queued: '排队中',
  parsing: '解析中',
  awaiting: '待确认',
  running: '下载中',
  paused: '已暂停',
  verifying: '校验中',
  completed: '已完成',
  failed: '失败'
}

export function Inspector({
  task,
  onClose,
  onChanged
}: {
  task: Task | null
  onClose: () => void
  onChanged: () => void
}) {
  const [files, setFiles] = useState<TaskFile[]>([])
  const [copied, setCopied] = useState(false)
  const [cat, setCat] = useState<'all' | 'video' | 'music' | 'image' | 'doc' | 'other'>('all')

  // 打开时拉文件清单
  useEffect(() => {
    if (!task) {
      setFiles([])
      return
    }
    window.omniget
      .getTaskDetail(task.id)
      .then((d) => setFiles(d?.files ?? []))
      .catch(() => setFiles([])) // 请求失败不产生 unhandledrejection，文件清单留空
  }, [task?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!task) return null

  const pct =
    task.totalBytes > 0 ? Math.min(100, (task.downloadedBytes / task.totalBytes) * 100) : 0
  const running = task.status === 'running'
  const failed = task.status === 'failed'
  const trashed = false // 列表过滤已保证 trash 视图不进 Inspector（select 仅在非回收站行触发）

  const control = async (action: 'pause' | 'resume' | 'remove'): Promise<void> => {
    if (action === 'remove') {
      const ok = await confirmAction({
        title: '移入回收站',
        message: `「${task.name || task.source}」将被移入回收站，可在回收站中恢复。`,
        confirmLabel: '移入回收站'
      })
      if (!ok) return
    }
    await window.omniget.controlTask({ taskId: task.id, action })
    onChanged()
    if (action === 'pause') toast('任务已暂停', 'success')
    else if (action === 'resume') toast('任务已继续下载', 'success')
    else toast('任务已移入回收站', 'success')
  }

  const retry = (): void => {
    void window.omniget
      .retryTask(task.id)
      .then(() => {
        toast('任务已重新排队', 'success')
        onChanged()
      })
  }

  const copySource = (): void => {
    void navigator.clipboard?.writeText(task.source).catch(() => {})
    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
  }

  return (
    <AnimatePresence>
      <motion.aside
        key="inspector"
        initial={{ x: 40, opacity: 0 }}
        animate={{ x: 0, opacity: 1 }}
        exit={{ x: 40, opacity: 0 }}
        transition={spring}
        className="flex h-full w-[340px] shrink-0 flex-col border-l border-border bg-surface"
      >
        {/* 头部：layoutId 共享元素（行标题 → 抽屉标题） */}
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-4">
          <motion.span layoutId={`task-title-${task.id}`} className="flex-1 truncate text-sm font-medium">
            {task.name}
          </motion.span>
          <button
            onClick={onClose}
            className="press flex h-7 w-7 items-center justify-center rounded-ctl text-text-2 hover:bg-surface-2 hover:text-text-1"
            aria-label="关闭详情"
          >
            <X size={14} weight="bold" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {/* 状态 + 进度（stagger 入场） */}
          <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 }}>
            <div className="mb-2 flex items-center gap-2 text-xs">
              <span
                className={`inline-block h-1.5 w-1.5 rounded-full ${
                  task.status === 'completed'
                    ? 'bg-success'
                    : task.status === 'failed'
                      ? 'bg-danger'
                      : running
                        ? 'bg-accent'
                        : 'bg-text-3'
                }`}
              />
              <span className="text-text-2">{STATUS_LABEL[task.status] ?? task.status}</span>
              <span className="num ml-auto text-text-3">{pct.toFixed(1)}%</span>
            </div>
            <div className="meter">
              <div
                className="will-transform h-full rounded-full bg-accent"
                style={{ width: `${pct}%`, opacity: running ? 1 : 0.55 }}
              />
            </div>
            <div className="num mt-2 flex justify-between text-[11px] text-text-3">
              <span>
                {formatBytes(task.downloadedBytes)} / {formatBytes(task.totalBytes)}
              </span>
              {running && <span className="text-accent">{formatBytes(task.speedBps)}/s</span>}
            </div>
          </motion.div>

          {/* 失败归因 + 出口动作（§4.1：失败文案必须带出口动作） */}
          {failed && task.error && (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.08 }}
              className="mt-4 rounded-panel border border-danger/30 bg-danger/8 p-3"
            >
              <p className="text-[11px] leading-relaxed text-danger">{task.error}</p>
              <button
                onClick={retry}
                className="press mt-2 inline-flex items-center gap-1.5 rounded-ctl border border-border px-2.5 py-1 text-[11px] text-text-2 hover:text-text-1"
              >
                <ArrowClockwise size={12} /> 重试任务
              </button>
            </motion.div>
          )}

          {/* 元信息 */}
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
            className="mt-4 space-y-2 border-t border-border pt-4 text-[11px]"
          >
            <div className="flex items-start gap-2">
              <span className="w-14 shrink-0 text-text-3">来源</span>
              <span className="num min-w-0 flex-1 break-all text-text-2">{task.source}</span>
              <button
                onClick={copySource}
                className="press shrink-0 text-text-3 hover:text-text-1"
                aria-label="复制来源"
              >
                <Copy size={12} />
              </button>
              {copied && <span className="shrink-0 text-accent">已复制</span>}
            </div>
            <div className="flex items-center gap-2">
              <span className="w-14 shrink-0 text-text-3">引擎</span>
              <span className="num text-text-2">{task.engine}</span>
              <span className="text-text-3">·</span>
              <span className="text-text-2">{task.type.toUpperCase()}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-14 shrink-0 text-text-3">保存到</span>
              <span className="num min-w-0 flex-1 truncate text-text-2" title={task.saveDir}>
                {task.saveDir}
              </span>
              <button
                onClick={() => void window.omniget.openFolder(task.id)}
                className="press shrink-0 text-text-3 hover:text-text-1"
                aria-label="打开目录"
              >
                <ArrowSquareOut size={12} />
              </button>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-14 shrink-0 text-text-3">创建于</span>
              <span className="num text-text-2">
                {new Date(task.createdAt).toLocaleString('zh-CN', { hour12: false })}
              </span>
            </div>
          </motion.div>

          {/* 文件清单（BT/磁力多文件；其余单文件）：分类筛选 chips + 列表 */}
          {files.length > 0 && (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.12 }}
              className="mt-4 border-t border-border pt-4"
            >
              <p className="mb-2 text-[11px] text-text-3">
                文件（{files.filter((f) => f.selected).length}/{files.length}）
              </p>
              {/* 分类 chips：全部/视频/音乐/图片/文档/其他（含计数） */}
              <div className="mb-2 flex flex-wrap gap-1">
                {FILE_CATEGORIES.map((c) => {
                  const count =
                    c.id === 'all'
                      ? files.length
                      : files.filter((f) => fileCategory(f.path) === c.id).length
                  if (c.id !== 'all' && count === 0) return null
                  const activeCat = cat === c.id
                  return (
                    <button
                      key={c.id}
                      onClick={() => setCat(c.id)}
                      className={`num press rounded-ctl border px-2 py-0.5 text-[10px] transition-colors ${
                        activeCat
                          ? 'border-accent bg-accent-soft text-accent'
                          : 'border-border text-text-3 hover:border-text-3 hover:text-text-2'
                      }`}
                    >
                      {c.label} {count}
                    </button>
                  )
                })}
              </div>
              <div className="max-h-56 space-y-px overflow-y-auto">
                {files
                  .filter((f) => cat === 'all' || fileCategory(f.path) === cat)
                  .map((f) => (
                    <div key={f.path} className="row-line flex items-center gap-2 py-1.5 text-[11px]">
                      <FileText size={12} className="shrink-0 text-text-3" />
                      <span className="min-w-0 flex-1 truncate text-text-2">{f.path}</span>
                      {!f.selected && <span className="shrink-0 text-text-3">未选</span>}
                      <span className="num shrink-0 text-text-3">{formatBytes(f.size)}</span>
                    </div>
                  ))}
              </div>
            </motion.div>
          )}
        </div>

        {/* 底部操作条（图标+名称） */}
        <div className="flex shrink-0 items-center gap-2 border-t border-border p-3">
          {(task.status === 'running' || task.status === 'queued') && (
            <button
              onClick={() => void control('pause')}
              className="press inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-ctl border border-border text-xs text-text-2 hover:text-text-1"
            >
              <Pause size={13} weight="fill" /> 暂停
            </button>
          )}
          {task.status === 'paused' && (
            <button
              onClick={() => void control('resume')}
              className="press inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-ctl bg-accent text-xs text-white hover:bg-accent-press"
            >
              <Play size={13} weight="fill" /> 继续
            </button>
          )}
          {failed && (
            <button
              onClick={retry}
              className="press inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-ctl bg-accent text-xs text-white hover:bg-accent-press"
            >
              <ArrowClockwise size={13} /> 重试
            </button>
          )}
          {!trashed && task.status !== 'completed' && task.status !== 'failed' && (
            <span className="flex-1" />
          )}
          <button
            onClick={() => void control('remove').then(onClose)}
            className="press inline-flex h-8 items-center gap-1.5 rounded-ctl border border-border px-3 text-xs text-text-2 hover:border-danger/40 hover:text-danger"
            aria-label="移入回收站"
          >
            <Trash size={13} /> 回收站
          </button>
        </div>
      </motion.aside>
    </AnimatePresence>
  )
}
