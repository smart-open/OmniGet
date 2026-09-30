// 新建任务对话框（M1-9，§7.5 线框 + §7.8 动效规范）
// spring(100/20) 缩放入场、玻璃面板 radius-dialog；逻辑与 M1-a 保持一致。

import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  DownloadSimple,
  FilePlus,
  FloppyDisk,
  FolderOpen,
  LinkSimple,
  MagnifyingGlass,
  Warning,
  X
} from '@phosphor-icons/react'
import type { ParseOutputPayload, TaskFile, TaskType } from '@shared/types'
import { matchSelectSyntax } from '@shared/select-syntax'
import { FILE_CATEGORIES, fileCategory } from '@shared/file-category'
import { useTasks } from '../../stores/tasks'
import {
  buildTree,
  collectSelected,
  formatBytes,
  nodeState,
  setSubtree,
  type CheckState,
  type TreeNode
} from './fileTree'
import { Button, Input } from '../../components/ui'

interface Props {
  open: boolean
  initialSource?: string
  onClose: () => void
}

type Phase = 'input' | 'parsing' | 'awaiting'

export function NewTaskDialog({ open, initialSource, onClose }: Props) {
  const [source, setSource] = useState('')
  const [phase, setPhase] = useState<Phase>('input')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [taskId, setTaskId] = useState('')
  const [parsed, setParsed] = useState<ParseOutputPayload | null>(null)
  const [files, setFiles] = useState<TaskFile[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState('')
  const [threads, setThreads] = useState(16)
  const [saveDir, setSaveDir] = useState('')
  const [seedAndStop, setSeedAndStop] = useState(true)
  const [dragOver, setDragOver] = useState(false)
  const [sniffType, setSniffType] = useState<TaskType | null>(null)
  /** M3-3：视频格式选择状态 */
  const [formatId, setFormatId] = useState<string | null>(null)
  const [resFilter, setResFilter] = useState('all')
  const [audioOnly, setAudioOnly] = useState(false)
  const [embedSubs, setEmbedSubs] = useState(false)
  const [embedThumbnail, setEmbedThumbnail] = useState(false)
  const [delogo, setDelogo] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      setPhase('input')
      setError('')
      setParsed(null)
      setFiles([])
      setSelected(new Set())
      setQuery('')
      setSource(initialSource ?? '')
      setDragOver(false)
      setSniffType(null)
      setFormatId(null)
      setResFilter('all')
      setAudioOnly(false)
      setEmbedSubs(false)
      setEmbedThumbnail(false)
      setDelogo(false)
      if (!saveDir) {
        void window.omniget.defaultSaveDir().then(setSaveDir)
      }
      setTimeout(() => inputRef.current?.focus(), 60)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialSource])

  // 分类筛选（视频/音乐/图片/文档/其他）：过滤后重建文件树，全选/反选只作用于过滤集
  const [cat, setCat] = useState<'all' | 'video' | 'music' | 'image' | 'doc' | 'other'>('all')
  const filteredFiles = useMemo(
    () => (cat === 'all' ? files : files.filter((f) => fileCategory(f.path) === cat)),
    [files, cat]
  )
  const tree = useMemo(
    () => (filteredFiles.length ? buildTree(filteredFiles) : null),
    [filteredFiles]
  )

  // 搜索框语法命中集实时高亮并映射 select-file（§4.2）
  const match = useMemo(() => {
    if (!query.trim() || files.length === 0) return null
    return matchSelectSyntax(query, files.map((f) => f.path))
  }, [query, files])

  const selectedPaths = tree ? collectSelected(tree, selected) : []
  const selectedBytes = useMemo(() => {
    const byPath = new Map(files.map((f) => [f.path, f.size]))
    return selectedPaths.reduce((s, p) => s + (byPath.get(p) ?? 0), 0)
  }, [selectedPaths, files])

  function applyResult(res: Awaited<ReturnType<typeof window.omniget.createTask>>): void {
    if (res.kind === 'failed') {
      setError(res.error)
      setPhase('input')
      return
    }
    setTaskId(res.taskId)
    setParsed(res.parsed)
    setSniffType(res.sniff.type)
    const list = (res.parsed.files ?? []) as TaskFile[]
    setFiles(list)
    setSelected(new Set(list.map((f) => f.path)))
    setPhase('awaiting')
  }

  async function submitSource(): Promise<void> {
    if (!source.trim()) return
    setPhase('parsing')
    setError('')
    try {
      applyResult(
        await window.omniget.createTask({
          source: source.trim(),
          threads,
          saveDir,
          seedRatio: seedAndStop ? 0 : undefined
        })
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setPhase('input')
    }
  }

  /** F1：选择/拖入 .torrent → 取绝对路径直接解析（webUtils 桥） */
  function handleTorrentFiles(fileList: FileList | null): void {
    const file = fileList?.[0]
    if (!file) return
    const path = window.omniget.filePath(file)
    setSource(path)
    void submitSourceWithPath(path)
  }

  async function submitSourceWithPath(path: string): Promise<void> {
    setPhase('parsing')
    setError('')
    try {
      applyResult(
        await window.omniget.createTask({
          source: path,
          threads,
          saveDir,
          seedRatio: seedAndStop ? 0 : undefined
        })
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setPhase('input')
    }
  }

  async function confirm(): Promise<void> {
    setSubmitting(true)
    try {
      await window.omniget.confirmSelection({
        taskId,
        selectedPaths: selectedPaths.length === files.length ? undefined : selectedPaths,
        threads,
        video: sniffType === 'video' || sniffType === null
          ? {
              formatId: formatId ?? undefined,
              audioOnly,
              audioFormat: 'mp3',
              embedSubs,
              embedThumbnail,
              delogo: delogo && (sniffType === 'video' ? false : true)
            }
          : undefined
      })
      await useTasks.getState().load('all')
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          onClick={onClose}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.16 }}
        >
          <motion.div
            className="flex max-h-[82dvh] w-[640px] flex-col overflow-hidden rounded-dialog border border-border bg-surface shadow-[var(--shadow-float)]"
            onClick={(e) => e.stopPropagation()}
            onDragOver={(e) => {
              e.preventDefault()
              setDragOver(true)
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault()
              setDragOver(false)
              if (phase === 'input') handleTorrentFiles(e.dataTransfer.files)
            }}
            initial={{ scale: 0.96, opacity: 0, y: 8 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.97, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 100, damping: 20 }} // §7.8
          >
            {/* 标题行 */}
            <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
              <h2 className="text-sm font-medium">新建任务</h2>
              <button
                className="press flex h-6 w-6 items-center justify-center rounded text-text-3 transition-colors hover:bg-surface-2 hover:text-text-1"
                onClick={onClose}
              >
                <X size={14} />
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
              {/* F1：拖拽 .torrent 反馈 */}
              {dragOver && phase === 'input' && (
                <div className="mb-3 rounded-panel border border-dashed border-accent bg-accent-soft py-5 text-center text-xs text-accent">
                  松开以解析 .torrent 文件
                </div>
              )}

              {/* ── 输入区 ──────────────────────────────────────────── */}
              <div className="flex gap-2">
                <Input
                  ref={inputRef}
                  value={source}
                  onChange={(e) => setSource(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && phase === 'input' && void submitSource()}
                  placeholder="粘贴磁力 / 视频链接 / 音乐名，或选择种子文件"
                  disabled={phase !== 'input'}
                  lead={<LinkSimple size={14} />}
                  className="flex-1"
                />
                {phase === 'input' && (
                  <>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept=".torrent"
                      className="hidden"
                      onChange={(e) => handleTorrentFiles(e.target.files)}
                    />
                    <Button
                      variant="outline"
                      icon={<FilePlus size={14} />}
                      onClick={() => fileInputRef.current?.click()}
                    >
                      种子
                    </Button>
                    <Button icon={<MagnifyingGlass size={14} />} onClick={() => void submitSource()}>
                      解析
                    </Button>
                  </>
                )}
              </div>
              {error && (
                <p className="mt-2 text-xs leading-relaxed text-danger">{error}</p>
              )}

              {/* ── 解析中：磁力雷达（§7.8 之二）────────────────────── */}
              {phase === 'parsing' && (
                <div className="flex flex-col items-center gap-4 py-12">
                  <div className="relative h-12 w-12">
                    <div className="radar-ring absolute inset-0 rounded-full border border-accent/40 border-t-accent" />
                    <div className="absolute inset-2 rounded-full border border-border" />
                    <div className="absolute inset-0 flex items-center justify-center">
                      <span className="h-1.5 w-1.5 rounded-full bg-accent" />
                    </div>
                  </div>
                  <p className="text-xs text-text-3">正在从网络获取文件清单…（最长 90s）</p>
                </div>
              )}

              {/* ── awaiting：文件树 ───────────────────────────────── */}
              {phase === 'awaiting' && tree && (
                <motion.div
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.2 }}
                >
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-xs text-text-2">
                      解析结果
                      <span className="num ml-2 text-text-3">
                        {filteredFiles.length === files.length
                          ? `${files.length} 个文件`
                          : `${filteredFiles.length}/${files.length} 个文件`}{' '}
                        · {formatBytes(parsed?.totalBytes ?? 0)}
                      </span>
                    </span>
                    <div className="flex gap-3 text-[11px]">
                      <button
                        className="text-text-3 transition-colors hover:text-accent"
                        onClick={() =>
                          setSelected((prev) => {
                            const next = new Set(prev)
                            filteredFiles.forEach((f) => next.add(f.path))
                            return next
                          })
                        }
                      >
                        全选
                      </button>
                      <button
                        className="text-text-3 transition-colors hover:text-accent"
                        onClick={() => {
                          const next = new Set<string>()
                          filteredFiles.forEach((f) => {
                            if (!selected.has(f.path)) next.add(f.path)
                          })
                          setSelected(next)
                        }}
                      >
                        反选
                      </button>
                    </div>
                  </div>

                  {/* 分类 chips：视频/音乐/图片/文档/其他（含计数），过滤文件树 */}
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

                  <div className="relative">
                    <MagnifyingGlass
                      size={13}
                      className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-3"
                    />
                    <input
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="搜索文件名或索引区间（如 1,3,5-10 或 mp4）"
                      className="mb-2 h-8 w-full rounded-ctl border border-border bg-surface-2 pl-8 pr-3 text-xs outline-none placeholder:text-text-3 focus:border-accent"
                    />
                  </div>

                  <div className="max-h-56 overflow-y-auto rounded-panel border border-border">
                    <TreeNodeView
                      node={tree}
                      depth={0}
                      selected={selected}
                      match={match?.indexes ?? null}
                      onToggle={(node, checked) => {
                        const next = new Set(selected)
                        setSubtree(node, checked, next)
                        setSelected(next)
                      }}
                    />
                  </div>

                  <p className="num mt-2 text-[11px] text-text-2">
                    已选 {selectedPaths.length}/{files.length} 个 ·{' '}
                    <span className="text-text-1">{formatBytes(selectedBytes)}</span>
                    {selectedBytes < (parsed?.totalBytes ?? 0) && (
                      <span className="text-text-3">
                        {' '}
                        / {formatBytes(parsed?.totalBytes ?? 0)}（排除{' '}
                        {formatBytes((parsed?.totalBytes ?? 0) - selectedBytes)}）
                      </span>
                    )}
                  </p>
                </motion.div>
              )}

              {/* awaiting：单文件卡片（HTTP） */}
              {/* ── awaiting：视频分支（M3-3/5/10/11）────────────────── */}
              {phase === 'awaiting' && !tree && parsed?.formats && (
                <motion.div
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.2 }}
                  className="mt-4"
                >
                  {/* 预览卡片（§4.3.2 防下错）：封面 + 标题 + 时长 */}
                  <div className="flex gap-3 rounded-panel border border-border p-3">
                    {parsed.coverUrl && (
                      <img
                        src={parsed.coverUrl}
                        alt=""
                        className="h-16 w-28 shrink-0 rounded object-cover"
                      />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm">{parsed.name}</p>
                      <p className="num mt-0.5 text-[11px] text-text-3">
                        {parsed.duration
                          ? `${Math.floor(parsed.duration / 60)}:${String(parsed.duration % 60).padStart(2, '0')}`
                          : ''}{' '}
                        {parsed.totalBytes > 0 && formatBytes(parsed.totalBytes)}
                      </p>
                    </div>
                  </div>

                  {parsed.ffmpegMissing && (
                    <p className="mt-2 flex items-center gap-1.5 text-[11px] text-warning">
                      <Warning size={12} /> ffmpeg 缺失：仅显示预合并格式（画质可能受限）
                    </p>
                  )}

                  {/* 分辨率快筛（§4.3.2 多维筛选） */}
                  <div className="mt-3 flex items-center gap-1.5">
                    {['all', '2160', '1440', '1080', '720', '480'].map((r) => (
                      <button
                        key={r}
                        onClick={() => setResFilter(r)}
                        className={`press rounded-full border px-2.5 py-0.5 text-[10px] transition-colors ${
                          resFilter === r
                            ? 'border-accent bg-accent-soft text-accent'
                            : 'border-border text-text-3 hover:text-text-1'
                        }`}
                      >
                        {r === 'all' ? '全部' : `${r}p+`}
                      </button>
                    ))}
                    <label className="ml-auto flex cursor-pointer items-center gap-1.5 text-[11px] text-text-2">
                      <input
                        type="checkbox"
                        checked={audioOnly}
                        onChange={(e) => setAudioOnly(e.target.checked)}
                      />
                      仅提取音频 (MP3)
                    </label>
                  </div>

                  {/* 格式列表（radio 单选；默认 bv*+ba/b） */}
                  {!audioOnly && (
                    <div className="mt-2 max-h-52 overflow-y-auto rounded-panel border border-border">
                      {/* 默认档 */}
                      <FormatRow
                        id="default"
                        label="最佳画质（bv*+ba/b）"
                        detail="自动选择最佳视频+音频"
                        selected={formatId === null}
                        onSelect={() => setFormatId(null)}
                      />
                      {(parsed.formats ?? [])
                        .filter((f) => {
                          if (resFilter === 'all') return true
                          const h = parseInt(f.resolution) || 0
                          return h >= Number(resFilter)
                        })
                        .map((f) => (
                          <FormatRow
                            key={f.formatId}
                            id={f.formatId}
                            label={`${f.resolution} ${f.ext}${f.fps ? ` ${f.fps}fps` : ''}${
                              f.noWatermark === false ? ' · 水印' : ''
                            }`}
                            detail={[
                              f.vcodec && f.vcodec !== 'none' ? f.vcodec.split('.')[0] : null,
                              f.tbr ? `${Math.round(f.tbr)}k` : null,
                              f.filesize ? formatBytes(f.filesize) : null
                            ]
                              .filter(Boolean)
                              .join(' · ')}
                            selected={formatId === f.formatId}
                            onSelect={() => setFormatId(f.formatId)}
                          />
                        ))}
                    </div>
                  )}

                  {/* M3-5：字幕/封面嵌入 */}
                  <div className="mt-2 flex gap-4">
                    <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-text-2">
                      <input
                        type="checkbox"
                        checked={embedSubs}
                        onChange={(e) => setEmbedSubs(e.target.checked)}
                      />
                      内嵌字幕（zh/en）
                    </label>
                    <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-text-2">
                      <input
                        type="checkbox"
                        checked={embedThumbnail}
                        onChange={(e) => setEmbedThumbnail(e.target.checked)}
                      />
                      内嵌封面
                    </label>
                    {/* M3-7：短视频 L3 显式选择 */}
                    {sniffType &&
                      ['douyin', 'kuaishou', 'xiaohongshu', 'xigua', 'weibo'].includes(
                        sniffType
                      ) && (
                        <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-text-2">
                          <input
                            type="checkbox"
                            checked={delogo}
                            onChange={(e) => setDelogo(e.target.checked)}
                          />
                          遮挡水印（后处理，产出副本）
                        </label>
                      )}
                  </div>
                </motion.div>
              )}

              {phase === 'awaiting' && !tree && parsed && !parsed.formats && (
                <div className="mt-4 rounded-panel border border-border px-4 py-3">
                  <p className="text-sm">{parsed.name || '单文件'}</p>
                  <p className="num mt-0.5 text-xs text-text-3">{formatBytes(parsed.totalBytes)}</p>
                </div>
              )}

              {/* ── 参数区 ─────────────────────────────────────────── */}
              {phase !== 'parsing' && (
                <div className="mt-5 space-y-4 border-t border-border pt-4">
                  {/* 多线程滑杆（§7.5：1–64 档；BT 显示 peers 上限语义） */}
                  <div>
                    <div className="mb-1.5 flex items-center justify-between text-xs">
                      <span className="text-text-2">多线程</span>
                      <span className="num text-text-2">
                        {threads}{' '}
                        {sniffType === 'bt' || sniffType === 'magnet' ? 'peers 上限' : '连接'}
                        {threads >= 8 && threads <= 32 && (
                          <span className="ml-1 text-text-3">推荐 8–32</span>
                        )}
                      </span>
                    </div>
                    <input
                      type="range"
                      min={1}
                      max={64}
                      value={threads}
                      onChange={(e) => setThreads(Number(e.target.value))}
                      style={{ '--fill': `${((threads - 1) / 63) * 100}%` } as React.CSSProperties}
                      className="w-full"
                    />
                  </div>

                  {/* 保存目录 */}
                  <div className="flex items-center gap-2">
                    <span className="flex w-14 shrink-0 items-center gap-1 text-xs text-text-2">
                      <FloppyDisk size={13} />
                      保存到
                    </span>
                    <input
                      value={saveDir}
                      onChange={(e) => setSaveDir(e.target.value)}
                      className="num h-8 min-w-0 flex-1 rounded-ctl border border-border bg-surface-2 px-3 text-xs outline-none focus:border-accent"
                    />
                    <button
                      onClick={() =>
                        void window.omniget.pickFolder().then((dir) => {
                          if (dir) setSaveDir(dir)
                        })
                      }
                      aria-label="浏览文件夹"
                      title="浏览文件夹"
                      className="press inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-ctl border border-border text-text-2 transition-colors hover:border-text-3 hover:text-text-1"
                    >
                      <FolderOpen size={14} />
                    </button>
                  </div>

                  {/* F3：下完即停（BT/磁力任务） */}
                  {(sniffType === 'bt' || sniffType === 'magnet' || sniffType === null) && (
                    <label className="flex w-fit cursor-pointer items-center gap-2 text-xs text-text-2">
                      <input
                        type="checkbox"
                        checked={seedAndStop}
                        onChange={(e) => setSeedAndStop(e.target.checked)}
                      />
                      下完即停（做种比例 0）
                    </label>
                  )}
                </div>
              )}
            </div>

            {/* ── 底部动作 ──────────────────────────────────────────── */}
            <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3.5">
              <Button variant="ghost" onClick={onClose}>
                取消
              </Button>
              {phase === 'awaiting' && (
                <Button
                  onClick={() => void confirm()}
                  disabled={submitting}
                  icon={<DownloadSimple size={14} weight="bold" />}
                >
                  {submitting
                    ? '提交中…'
                    : selectedPaths.length > 0
                      ? `立即下载 (${selectedPaths.length})`
                      : '立即下载'}
                </Button>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

// ── 树节点视图（三态复选框 + 语法命中高亮）──────────────────────────

function TreeNodeView(props: {
  node: TreeNode
  depth: number
  selected: Set<string>
  match: Set<number> | null
  onToggle: (node: TreeNode, checked: boolean) => void
}) {
  const { node, depth, selected, match, onToggle } = props
  const state: CheckState = nodeState(node, selected)
  const hit = node.isLeaf && match?.has(node.index ?? -1)

  return (
    <div>
      <div
        className={`row-line flex items-center gap-2 py-1.5 pr-3 text-xs transition-colors ${
          hit ? 'bg-accent-soft' : 'hover:bg-surface-2'
        }`}
        style={{ paddingLeft: 12 + depth * 16 }}
      >
        <TriStateBox state={state} onChange={(c) => onToggle(node, c)} />
        <span className={`min-w-0 flex-1 truncate ${hit ? 'text-accent' : ''}`}>{node.name}</span>
        {node.isLeaf && match && (
          <span className="num text-[9px] text-text-3">#{node.index}</span>
        )}
        <span className="num shrink-0 text-text-3">{formatBytes(node.size)}</span>
      </div>
      {node.children.map((c) => (
        <TreeNodeView
          key={c.path}
          node={c}
          depth={depth + 1}
          selected={selected}
          match={match}
          onToggle={onToggle}
        />
      ))}
    </div>
  )
}

/** M3-3 格式行（radio 单选） */
function FormatRow({
  id,
  label,
  detail,
  selected,
  onSelect
}: {
  id: string
  label: string
  detail: string
  selected: boolean
  onSelect: () => void
}) {
  return (
    <button
      onClick={onSelect}
      className={`row-line flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors ${
        selected ? 'bg-accent-soft' : 'hover:bg-surface-2'
      }`}
    >
      <span
        className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border transition-colors ${
          selected ? 'border-accent' : 'border-border'
        }`}
      >
        {selected && <span className="h-1.5 w-1.5 rounded-full bg-accent" />}
      </span>
      <span className={`min-w-0 flex-1 truncate ${selected ? 'text-accent' : ''}`}>{label}</span>
      <span className="num shrink-0 text-[10px] text-text-3">{detail}</span>
      <span className="num hidden shrink-0 text-[9px] text-text-3 group-hover:inline">{id}</span>
    </button>
  )
}

function TriStateBox({
  state,
  onChange
}: {
  state: CheckState
  onChange: (checked: boolean) => void
}) {
  return (
    <button
      onClick={() => onChange(state !== 'checked')}
      className={`press flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[9px] leading-none transition-colors ${
        state === 'unchecked'
          ? 'border-border text-transparent hover:border-accent'
          : 'border-accent bg-accent text-white'
      }`}
      aria-checked={state === 'checked'}
      role="checkbox"
    >
      {state === 'indeterminate' ? '−' : '✓'}
    </button>
  )
}
