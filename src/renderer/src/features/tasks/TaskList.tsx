// 任务列表（M1-10，§7.4/§7.8）
// 虚拟滚动（10k+ 行）、行 hover 浮出图标操作、3px 进度条 scaleX 动效（禁 width 动画）。
// 首载 stagger 仅前 10 行（§7.8）；空态/骨架/错误三态齐备（§7.1 原则 4）。

import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  PushPin,
  ArrowsClockwise,
  CheckCircle,
  FolderOpen,
  Pause,
  Play,
  FileX,
  Trash,
  X
} from '@phosphor-icons/react'
import { useTasks } from '../../stores/tasks'
import { formatBytes, formatEta } from '../new-task/fileTree'
import { Button, EmptyState, TaskRowSkeleton } from '../../components/ui'
import { confirmAction, toast, toastError } from '../../lib/feedback'
import type { Task } from '@shared/types'

/** UX 硬性标准：写操作失败必须给用户可见反馈——所有行内/批量操作统一经此包装 */
async function guarded(action: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
  } catch (err) {
    toastError(action, err)
  }
}

const FILTERS: Record<string, (t: Task) => boolean> = {
  all: () => true,
  downloading: (t) =>
    ['queued', 'running', 'paused', 'parsing', 'awaiting', 'verifying'].includes(t.status),
  completed: (t) => ['completed', 'seeding'].includes(t.status),
  bt: (t) => t.type === 'bt' || t.type === 'magnet',
  video: (t) => t.type === 'video',
  music: (t) => t.type === 'music',
  toolbox: (t) => t.type === 'tool',
  // M4-3：回收站（ipc task:list filter='trash' 返回已删除任务）
  trash: () => true
}

const FILTER_TITLES: Record<string, string> = {
  all: '全部任务',
  downloading: '正在下载',
  completed: '已完成',
  bt: '种子与磁力',
  video: '视频',
  music: '音乐',
  toolbox: '工具箱',
  trash: '回收站'
}

const EMPTY_COPY: Record<string, { title: string; hint: string }> = {
  all: { title: '还没有任务', hint: '从剪贴板粘贴链接，或拖入 .torrent 开始' },
  downloading: { title: '当前没有进行中的任务', hint: '新建任务后将在这里排队与下载' },
  completed: { title: '还没有完成的任务', hint: '完成的任务会折叠收敛到这里' }
}

export function TaskList({
  active,
  onNewTask,
  query = ''
}: {
  active: string
  onNewTask: () => void
  query?: string
}) {
  const tasks = useTasks((s) => s.tasks)
  const loading = useTasks((s) => s.loading)
  const loadedFilter = useTasks((s) => s.loadedFilter)
  const load = useTasks((s) => s.load)
  const selectedTaskId = useTasks((s) => s.selectedTaskId)
  const select = useTasks((s) => s.select)
  const pinned = useTasks((s) => s.pinned)
  const parentRef = useRef<HTMLDivElement>(null)
  const isTrash = active === 'trash'

  // ⚠ 数据源守卫：tasks map 是「最后一次 load」的内容。若在回收站视图里被其他
  // 组件 load('all') 覆盖（FILTERS.trash 不过滤），会把全部任务当回收站显示——
  // 一键清空将误删正在下载的任务。此处强制校验并自动重载正确的过滤器。
  const trashDataReady = !isTrash || loadedFilter === 'trash'
  useEffect(() => {
    if (isTrash && loadedFilter !== 'trash') void load('trash')
  }, [isTrash, loadedFilter, load])

  // 回收站批量操作：多选集合 + 批量恢复/彻底删除/一键清空
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!isTrash) setChecked(new Set())
  }, [isTrash])
  const toggleChecked = (id: string): void => {
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  /** 批量执行器：P1 修复——任一 IPC 失败不得让 busy 永久卡死或静默无反馈 */
  const runBatch = async (
    ids: string[],
    op: (id: string) => Promise<void>,
    action: string
  ): Promise<number> => {
    let okCount = 0
    let lastErr: unknown = null
    for (const id of ids) {
      try {
        await op(id)
        okCount++
      } catch (err) {
        lastErr = err
      }
    }
    try {
      await useTasks.getState().load('trash')
    } catch {
      // 重载失败不掩盖批量结果
    }
    setBusy(false)
    if (okCount < ids.length && lastErr) {
      toastError(action, lastErr)
    }
    if (okCount > 0) {
      toast(
        ids.length === okCount
          ? `已处理 ${okCount} 个任务`
          : `${okCount}/${ids.length} 个任务处理成功`,
        okCount === ids.length ? 'success' : 'warning'
      )
    }
    return okCount
  }
  const batchRestore = async (): Promise<void> => {
    if (!trashDataReady || checked.size === 0 || busy) return
    setBusy(true)
    const ids = [...checked]
    await runBatch(ids, (id) => window.omniget.restoreTask(id), '恢复任务')
    setChecked(new Set())
  }
  const batchPurge = async (): Promise<void> => {
    if (!trashDataReady || checked.size === 0 || busy) return
    const ok = await confirmAction({
      title: `彻底删除 ${checked.size} 个任务`,
      message: '将永久删除这些任务及其已下载的全部文件，此操作不可恢复。请确认已不再需要它们。',
      confirmLabel: '彻底删除',
      danger: true
    })
    if (!ok) return
    setBusy(true)
    const ids = [...checked]
    await runBatch(ids, (id) => window.omniget.purgeTask(id), '彻底删除')
    setChecked(new Set())
  }
  const emptyTrash = async (): Promise<void> => {
    // 双保险：数据源必须是回收站（trash 过滤）才允许清空
    if (!trashDataReady || list.length === 0 || busy) return
    const ok = await confirmAction({
      title: '清空回收站',
      message: `将永久删除回收站内全部 ${list.length} 个任务及其已下载文件，此操作不可恢复。`,
      confirmLabel: '全部删除',
      danger: true
    })
    if (!ok) return
    setBusy(true)
    await runBatch(list.map((t) => t.id), (id) => window.omniget.purgeTask(id), '清空回收站')
    setChecked(new Set())
  }

  const list = useMemo(() => {
    const pred = FILTERS[active] ?? FILTERS['all']!
    const q = query.trim().toLowerCase()
    const filtered = [...tasks.values()].filter(
      (t) =>
        pred(t) &&
        (q === '' ||
          t.name.toLowerCase().includes(q) ||
          t.source.toLowerCase().includes(q))
    )
    // 置顶优先（保持 pinned 数组内的先后），其余按原顺序
    const pinSet = new Set(pinned)
    return [...filtered].sort((a, b) => {
      const pa = pinSet.has(a.id) ? 0 : 1
      const pb = pinSet.has(b.id) ? 0 : 1
      return pa - pb
    })
  }, [tasks, active, query, pinned])

  // P3 修复：单行操作后 checked 集合残留已删 id → 计数虚高、全选框错乱
  const checkedKey = list.map((t) => t.id).join('|')
  useEffect(() => {
    const alive = new Set(checkedKey.split('|').filter(Boolean))
    setChecked((prev) => {
      const stale = [...prev].filter((id) => !alive.has(id))
      if (stale.length === 0) return prev
      const next = new Set(prev)
      for (const id of stale) next.delete(id)
      return next
    })
  }, [checkedKey])

  const virtualizer = useVirtualizer({
    count: list.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 76,
    overscan: 12
  })

  // ── 骨架屏（与行同形，§7.1 原则 4）─────────────────────────────────
  if (loading || !trashDataReady) {
    return (
      <main ref={parentRef} className="h-full overflow-y-auto">
        {Array.from({ length: 7 }, (_, i) => (
          <TaskRowSkeleton key={i} index={i} />
        ))}
      </main>
    )
  }

  // ── 空态（构成式插画 + 一个动作按钮）───────────────────────────────
  if (list.length === 0) {
    // 搜索无匹配（库里有任务但被查询过滤掉）
    if (tasks.size > 0 && query.trim() !== '') {
      return (
        <main className="h-full overflow-y-auto">
          <div className="flex h-full flex-col items-center justify-center gap-3">
            <p className="text-sm text-text-2">没有匹配「{query.trim()}」的任务</p>
            <p className="text-xs text-text-3">试试其他关键词，或清除搜索条件</p>
          </div>
        </main>
      )
    }
    const copy = EMPTY_COPY[active] ?? {
      title: `「${FILTER_TITLES[active] ?? active}」暂无内容`,
      hint: '该分组下的任务会显示在这里'
    }
    return (
      <main className="h-full overflow-y-auto">
        <EmptyState
          title={copy.title}
          hint={copy.hint}
          actionLabel="新建下载任务"
          onAction={onNewTask}
        />
      </main>
    )
  }

  const title = FILTER_TITLES[active] ?? active

  return (
    <main ref={parentRef} className="h-full overflow-y-auto">
      {/* 分组头（§7.4）：标题 + 计数；回收站视图带批量操作条 */}
      <div className="sticky top-0 z-10 flex items-center justify-between gap-3 bg-[color:var(--bg)]/80 px-4 pb-2 pt-3 backdrop-blur-sm">
        <h2 className="text-xs font-medium text-text-2">
          {title}
          <span className="num ml-2 text-text-3">{list.length}</span>
        </h2>
        {isTrash && (
          <div className="flex items-center gap-1.5">
            <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-text-3">
              <input
                type="checkbox"
                checked={list.length > 0 && checked.size === list.length}
                onChange={(e) =>
                  setChecked(e.target.checked ? new Set(list.map((t) => t.id)) : new Set())
                }
              />
              全选
            </label>
            <Button
              size="xs"
              variant="outline"
              disabled={checked.size === 0 || busy}
              icon={<ArrowsClockwise size={12} />}
              onClick={() => void batchRestore()}
            >
              恢复 ({checked.size})
            </Button>
            <Button
              size="xs"
              variant="outline"
              disabled={checked.size === 0 || busy}
              icon={<Trash size={12} />}
              onClick={() => void batchPurge()}
              className="hover:border-danger/40 hover:text-danger"
            >
              彻底删除 ({checked.size})
            </Button>
            <Button
              size="xs"
              variant="ghost"
              disabled={list.length === 0 || busy}
              onClick={() => void emptyTrash()}
              className="!text-text-3 hover:!text-danger"
            >
              一键清空
            </Button>
          </div>
        )}
      </div>

      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map((vi) => {
          const task = list[vi.index]
          if (!task) return null
          return (
            <div
              key={task.id}
              style={
                {
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  height: vi.size,
                  transform: `translateY(${vi.start}px)`
                } as React.CSSProperties
              }
            >
              {/* stagger 只动内层：外层 transform 是虚拟滚动定位，动画 transform 会覆盖它导致所有行叠顶 */}
              <div className={vi.index < 10 ? 'stagger-in' : undefined} style={{ '--i': vi.index } as React.CSSProperties}>
                <TaskRow
                  task={task}
                  isTrash={isTrash}
                  selected={selectedTaskId === task.id}
                  pinned={pinned.includes(task.id)}
                  checked={checked.has(task.id)}
                  onCheck={() => toggleChecked(task.id)}
                  onSelect={() => select(task.id)}
                />
              </div>
            </div>
          )
        })}
      </div>
    </main>
  )
}

// ── 任务行（§7.4：首行状态+名称+体积 / 次行上下文 / 三行细进度条）──────
// memo：任何事件批次都会换 tasks Map，未 memo 时所有可见行全量重渲染（10k 下主要 jank 源）

const TaskRow = memo(function TaskRow({
  task,
  isTrash,
  selected,
  pinned,
  checked,
  onCheck,
  onSelect
}: {
  task: Task
  isTrash: boolean
  selected: boolean
  pinned: boolean
  checked: boolean
  onCheck: () => void
  onSelect: () => void
}) {
  const togglePin = useTasks((s) => s.togglePin)
  const pct =
    task.totalBytes > 0 ? Math.min(100, (task.downloadedBytes / task.totalBytes) * 100) : 0
  const eta =
    task.speedBps > 0 && task.totalBytes > task.downloadedBytes
      ? formatEta((task.totalBytes - task.downloadedBytes) / task.speedBps)
      : null
  // F2：音乐任务无字节进度 → 展示引擎阶段文案
  const stage = useTasks((s) => s.stageById[task.id])

  const barColor =
    task.status === 'failed'
      ? 'bg-danger'
      : task.status === 'paused'
        ? 'bg-text-3'
        : task.status === 'completed'
          ? 'bg-success'
          : 'bg-accent'

  async function restore(): Promise<void> {
    await window.omniget.restoreTask(task.id)
    // P3 修复：回收站行内操作重载 'all' 会触发数据源守卫再重载 'trash' → 双载+骨架闪烁
    await useTasks.getState().load(isTrash ? 'trash' : 'all')
    toast(`已恢复「${task.name || task.source}」`, 'success')
  }

  async function purge(): Promise<void> {
    const ok = await confirmAction({
      title: '彻底删除任务',
      message: `「${task.name || task.source}」及其已下载文件将被永久删除，此操作不可恢复。`,
      confirmLabel: '彻底删除',
      danger: true
    })
    if (!ok) return
    await window.omniget.purgeTask(task.id)
    await useTasks.getState().load(isTrash ? 'trash' : 'all')
    toast('任务及其文件已彻底删除', 'success')
  }

  async function purgeRecord(): Promise<void> {
    const ok = await confirmAction({
      title: '删除任务记录',
      message: `将删除「${task.name || task.source}」的任务记录（保留已下载文件），此操作不可恢复。`,
      confirmLabel: '删除记录',
      danger: true
    })
    if (!ok) return
    await window.omniget.purgeTaskRecord(task.id)
    await useTasks.getState().load(isTrash ? 'trash' : 'all')
    toast('任务记录已删除（文件保留）', 'success')
  }

  async function moveToTrash(): Promise<void> {
    const ok = await confirmAction({
      title: '移入回收站',
      message: `「${task.name || task.source}」将被移入回收站，可在回收站中恢复。`,
      confirmLabel: '移入回收站'
    })
    if (!ok) return
    await window.omniget.controlTask({ taskId: task.id, action: 'remove', withFiles: false })
    await useTasks.getState().load('all')
    toast('任务已移入回收站', 'success')
  }

  async function control(action: 'pause' | 'resume' | 'remove' | 'top'): Promise<void> {
    await window.omniget.controlTask({ taskId: task.id, action, withFiles: false })
    await useTasks.getState().load(isTrash ? 'trash' : 'all')
    if (action === 'pause') toast('任务已暂停', 'success')
    else if (action === 'resume') toast('任务已继续下载', 'success')
  }

  const canPause = task.status === 'running' || task.status === 'queued'
  const canResume = task.status === 'paused'

  return (
    <div
      className={`row-line group cursor-pointer px-4 py-2.5 transition-colors hover:bg-surface-2 ${
        selected ? 'bg-accent-soft' : ''
      }`}
      // P2 修复：回收站行禁止选中打开 Inspector——对已删任务显示暂停/移入回收站
      // 等操作会调 engine control 打出无意义错误
      onClick={isTrash ? undefined : onSelect}
    >
      {/* 首行 */}
      <div className="flex items-center gap-2.5">
        {isTrash && (
          <input
            type="checkbox"
            checked={checked}
            onChange={onCheck}
            onClick={(e) => e.stopPropagation()}
            className="shrink-0"
          />
        )}
        <StatusIcon status={task.status} />
        {pinned && <PushPin size={11} weight="fill" className="shrink-0 text-accent" />}
        <motion.span
          layoutId={`task-title-${task.id}`}
          transition={{ type: 'spring', stiffness: 300, damping: 32 }}
          className={`min-w-0 flex-1 truncate text-sm ${
            task.status === 'completed' ? 'text-text-2' : 'text-text-1'
          }`}
        >
          {task.name || task.source}
        </motion.span>
        {task.error && (
          <span className="min-w-0 max-w-48 shrink truncate text-[11px] text-danger">
            {task.error}
          </span>
        )}
        <span className="num shrink-0 text-xs text-text-2">
          {formatBytes(task.downloadedBytes)}
          {task.totalBytes > 0 && (
            <span className="text-text-3"> / {formatBytes(task.totalBytes)}</span>
          )}
        </span>
      </div>

      {/* 次行：引擎上下文 + hover 浮出操作（§7.4） */}
      <div className="mt-1 flex items-center gap-1.5 text-[11px] text-text-3">
        <EngineBadge type={task.type} />
        <span className="text-border">·</span>
        {task.engine === 'music' && task.status === 'running' && stage ? (
          <span className="truncate text-text-2">{stage}</span>
        ) : (
          <>
            <span className="num">{task.threads} 连接</span>
            {task.speedBps > 0 && (
              <>
                <span className="text-border">·</span>
                <span className="num text-text-2">{formatBytes(task.speedBps)}/s</span>
              </>
            )}
            {eta && (
              <>
                <span className="text-border">·</span>
                <span className="num">剩余 {eta}</span>
              </>
            )}
          </>
        )}

        {/* hover 浮出操作：回收站四动作（恢复/彻底删除含文件/删除仅记录/打开目录） */}
        <span className="ml-auto flex items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100">
          {isTrash ? (
            <>
              <RowAction label="恢复" onClick={() => void guarded('恢复任务', restore)}>
                <ArrowsClockwise size={13} />
              </RowAction>
              <RowAction label="彻底删除（含文件）" danger onClick={() => void guarded('彻底删除', purge)}>
                <Trash size={13} />
              </RowAction>
              <RowAction label="删除（保留文件）" onClick={() => void guarded('删除记录', purgeRecord)}>
                <FileX size={13} />
              </RowAction>
              <RowAction label="打开目录" onClick={() => void window.omniget.openFolder(task.id)}>
                <FolderOpen size={13} />
              </RowAction>
            </>
          ) : (
            <>
              {canPause && (
                <RowAction label="暂停" onClick={() => void guarded('暂停任务', () => control('pause'))}>
                  <Pause size={13} />
                </RowAction>
              )}
              {canResume && (
                <RowAction label="继续" onClick={() => void guarded('继续任务', () => control('resume'))}>
                  <Play size={13} weight="fill" />
                </RowAction>
              )}
              {['queued', 'running', 'paused', 'completed', 'failed'].includes(task.status) && (
                <RowAction
                  label={pinned ? '取消置顶' : '置顶'}
                  onClick={() => togglePin(task.id)}
                  active={pinned}
                >
                  <PushPin size={13} weight={pinned ? 'fill' : 'regular'} />
                </RowAction>
              )}
              <RowAction label="打开目录" onClick={() => void window.omniget.openFolder(task.id)}>
                <FolderOpen size={13} />
              </RowAction>
              <RowAction label="移入回收站" danger onClick={() => void guarded('移入回收站', moveToTrash)}>
                <Trash size={13} />
              </RowAction>
            </>
          )}
        </span>
      </div>

      {/* 三行：3px 细进度条（scaleX，禁 width 动画 §7.8） */}
      <div className="meter mt-1.5">
        <div
          className={`h-full w-full origin-left will-transform ${barColor}`}
          style={{ transform: `scaleX(${pct / 100})` }}
        />
      </div>
    </div>
  )
})

function RowAction({
  label,
  danger,
  active,
  onClick,
  children
}: {
  label: string
  danger?: boolean
  active?: boolean
  onClick: (e: React.MouseEvent) => void
  children: React.ReactNode
}) {
  return (
    <button
      title={label}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation() // 不触发行选中
        onClick(e)
      }}
      className={`press inline-flex h-6 items-center gap-1 rounded-ctl px-1.5 text-[11px] transition-colors ${
        active
          ? 'bg-accent-soft text-accent'
          : danger
            ? 'text-text-3 hover:bg-danger/10 hover:text-danger'
            : 'text-text-3 hover:bg-surface hover:text-text-1'
      }`}
    >
      {children}
      <span>{label}</span>
    </button>
  )
}

function EngineBadge({ type }: { type: Task['type'] }) {
  const map: Record<string, string> = {
    bt: 'BT',
    magnet: '磁力',
    http: 'HTTP',
    video: '视频',
    music: '音乐',
    tool: '工具'
  }
  return (
    <span className="rounded border border-border px-1 py-px text-[9px] uppercase tracking-wide text-text-3">
      {map[type] ?? type}
    </span>
  )
}

function StatusIcon({ status }: { status: Task['status'] }) {
  const cls = 'shrink-0'
  switch (status) {
    case 'running':
      return <Play size={13} weight="fill" className={`${cls} text-accent`} />
    case 'paused':
      return <Pause size={13} weight="fill" className={`${cls} text-text-3`} />
    case 'failed':
      return <X size={13} weight="bold" className={`${cls} text-danger`} />
    case 'completed':
      return <CheckCircle size={13} weight="fill" className={`${cls} text-success`} />
    case 'seeding':
      return <ArrowsClockwise size={13} className={`${cls} text-success`} />
    default:
      return <span className={`${cls} inline-block h-1.5 w-1.5 rounded-full bg-text-3`} />
  }
}
