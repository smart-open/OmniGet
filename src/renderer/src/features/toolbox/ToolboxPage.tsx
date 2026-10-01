// 工具箱（M4-13/14，§4.7）：左右分栏布局（左工具导航 / 右大操作区）
// 剪辑类工具接入多区域剪辑编辑器（波形拖选区域，逐区域/合并提交）
// 反馈统一走 toast/toastError（§UX 规则：写操作必须可见反馈）
import { useEffect, useRef, useState } from 'react'
import {
  ArrowClockwise,
  ArrowCounterClockwise,
  ArrowsIn,
  ArrowsLeftRight,
  Camera,
  Eye,
  Fingerprint,
  FolderOpen,
  FilmStrip,
  FrameCorners,
  Gauge,
  Gif,
  Image as ImageIcon,
  Magnet,
  Microphone,
  Rows,
  SpeakerHigh,
  SpeakerSlash,
  SplitHorizontal,
  Subtitles,
  TagSimple,
  TextAa,
  Timer,
  UploadSimple,
  WaveSine,
  Waveform,
  X,
  type Icon
} from '@phosphor-icons/react'
import { PREVIEW_SCHEME, type ToolDefInfo, type ToolEvent } from '@shared/types'
import { Button } from '../../components/ui'
import { toast, toastError } from '../../lib/feedback'
import { ClipEditor, type ClipRegion } from './ClipEditor'

interface RunningJob {
  taskId: string
  tool: string
  status: ToolEvent['status']
  message?: string
  seconds?: number
}

const CATEGORIES = [
  { key: 'common', title: '通用' },
  { key: 'audio', title: '音频处理' },
  { key: 'video', title: '视频处理' }
] as const

/** 剪辑类工具：from/duration 由剪辑编辑器提供，隐藏手填字段 */
const CLIP_TOOLS = new Set(['trim', 'trim-video'])

// ── 产物预览（完成后可直接查看结果） ─────────────────────────────────
type PreviewKind = 'image' | 'video' | 'audio' | 'text'

const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.gif']
const VIDEO_EXTS = ['.mp4', '.webm', '.mov', '.m4v']
const AUDIO_EXTS = ['.mp3', '.m4a', '.aac', '.flac', '.wav', '.opus', '.ogg']
const TEXT_EXTS = ['.txt', '.srt', '.ass', '.vtt', '.sha256', '.sha1', '.md5']

function previewKindOf(path: string | null | undefined): PreviewKind | null {
  const dot = path ? path.lastIndexOf('.') : -1
  const ext = dot >= 0 && path ? path.slice(dot).toLowerCase() : ''
  if (IMAGE_EXTS.includes(ext)) return 'image'
  if (VIDEO_EXTS.includes(ext)) return 'video'
  if (AUDIO_EXTS.includes(ext)) return 'audio'
  if (TEXT_EXTS.includes(ext)) return 'text'
  return null
}

function previewUrlOf(path: string): string {
  return `${PREVIEW_SCHEME}://local/${encodeURIComponent(path)}`
}

/** 产物预览弹层（图片/视频/音频经 omniget-preview://local 流式加载，文本读前 64KB） */
function ToolPreviewModal({
  path,
  kind,
  onClose
}: {
  path: string
  kind: PreviewKind
  onClose: () => void
}): React.ReactElement {
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState('')
  const url = previewUrlOf(path)
  const name = path.split(/[\\/]/).pop() ?? path

  useEffect(() => {
    if (kind !== 'text') return
    let alive = true
    fetch(url)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`读取失败（${r.status}）`))))
      .then((t) => {
        if (alive) setText(t.slice(0, 64 * 1024))
      })
      .catch((err) => {
        if (alive) setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      alive = false
    }
  }, [kind, url])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const mediaError = (): void => setError('该格式无法在应用内预览，请用「打开目录」查看')

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6"
      onClick={onClose}
    >
      <div
        className="flex max-h-full w-full max-w-2xl flex-col overflow-hidden rounded-panel border border-border bg-surface shadow-pop"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <span className="num min-w-0 flex-1 truncate text-xs font-medium" title={path}>
            {name}
          </span>
          <button
            onClick={onClose}
            className="rounded-ctl p-1 text-text-3 transition-colors hover:bg-surface-2 hover:text-text-1"
            title="关闭"
          >
            <X size={14} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {error && <p className="text-xs text-danger">预览失败：{error}</p>}
          {!error && kind === 'image' && (
            <img
              src={url}
              alt={name}
              onError={mediaError}
              className="mx-auto max-h-[60vh] rounded-ctl"
            />
          )}
          {!error && kind === 'video' && (
            <video
              src={url}
              controls
              autoPlay
              onError={mediaError}
              className="mx-auto max-h-[60vh] w-full rounded-ctl"
            />
          )}
          {!error && kind === 'audio' && (
            <audio
              src={url}
              controls
              autoPlay
              onError={mediaError}
              className="w-full"
            />
          )}
          {!error && kind === 'text' && (
            text === null ? (
              <p className="text-xs text-text-3">读取中…</p>
            ) : (
              <pre className="num whitespace-pre-wrap break-all text-[11px] leading-relaxed text-text-2">
                {text}
              </pre>
            )
          )}
        </div>
      </div>
    </div>
  )
}

/** 工具图标映射（导航与操作区标题复用） */
const TOOL_ICONS: Record<string, Icon> = {
  convert: ArrowsLeftRight,
  trim: Waveform,
  'trim-video': FilmStrip,
  loudnorm: SpeakerHigh,
  metadata: TagSimple,
  'voice-sep': SplitHorizontal,
  compress: ArrowsIn,
  gif: Gif,
  'subtitle-convert': Subtitles,
  'video-reverse': ArrowCounterClockwise,
  'video-mute': SpeakerSlash,
  'video-speed': Gauge,
  'video-rotate': ArrowClockwise,
  'video-scale': FrameCorners,
  'video-frame': Camera,
  'audio-fade': WaveSine,
  'audio-tempo': Timer,
  'image-convert': ImageIcon,
  concat: Rows,
  'subtitles-burn': TextAa,
  'region-concat': Rows,
  'torrent-create': Magnet,
  'torrent-magnet': Magnet,
  checksum: Fingerprint,
  'stem-demucs': Microphone
}

/** 按工具推导源文件 accept（无对应类型则不限制） */
function acceptFor(toolId: string, d?: ToolDefInfo): string {
  if (toolId === 'subtitle-convert') return '.srt,.ass,.vtt'
  if (toolId === 'trim-video' || toolId === 'video-frame' || toolId === 'gif') return 'video/*'
  if (toolId === 'image-convert') return 'image/*'
  if (toolId === 'torrent-create' || toolId === 'checksum') return '*/*'
  if (toolId === 'torrent-magnet') return '.torrent'
  return d?.multi ? 'video/*,audio/*' : 'audio/*,video/*'
}

export function ToolboxPage() {
  const [defs, setDefs] = useState<ToolDefInfo[]>([])
  const [activeTool, setActiveTool] = useState<string | null>(null)
  const [params, setParams] = useState<Record<string, Record<string, string>>>({})
  const [sourcePath, setSourcePath] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  // T4：多文件输入（拼接）与附加文件（字幕）选择
  const [picking, setPicking] = useState<'source' | 'extra'>('source')
  const [extraFiles, setExtraFiles] = useState<string[]>([])
  const extraRef = useRef<HTMLInputElement>(null)
  const [jobs, setJobs] = useState<RunningJob[]>([])
  const [defsError, setDefsError] = useState('')
  const [preview, setPreview] = useState<{ path: string; kind: PreviewKind } | null>(null)

  useEffect(() => {
    window.omniget
      .getToolDefs()
      .then(setDefs)
      .catch((err) => setDefsError(err instanceof Error ? err.message : String(err)))
    const off = window.omniget.onToolEvents((e: ToolEvent) => {
      // 以 taskId 归位：多区域剪辑并发提交时进度不再错挂到最近一条
      setJobs((prev) => {
        const idx = prev.findIndex((j) => j.taskId === e.taskId)
        if (idx >= 0) {
          const next = [...prev]
          const cur = next[idx]
          if (cur) {
            next[idx] = { ...cur, status: e.status, message: e.message, seconds: e.seconds }
          }
          return next
        }
        return [
          ...prev.slice(-9),
          {
            taskId: e.taskId ?? '',
            tool: e.tool ?? '',
            status: e.status,
            message: e.message,
            seconds: e.seconds
          }
        ]
      })
      if (e.status === 'completed') toast('处理完成', 'success')
      if (e.status === 'failed') toast(`处理失败：${e.message ?? ''}`, 'warning')
    })
    return off
  }, [])

  const def = defs.find((d) => d.id === activeTool) ?? null
  const isClip = activeTool != null && CLIP_TOOLS.has(activeTool)
  const ToolIcon = def ? TOOL_ICONS[def.id] : undefined
  // 处理动态按工具隔离：只显示当前工具的任务（剪辑页同时显示其隐藏工具 region-concat 的合并任务）
  const toolJobs = jobs.filter(
    (j) => j.tool === activeTool || (isClip && j.tool === 'region-concat')
  )

  function pickFile(toolId: string): void {
    const d = defs.find((x) => x.id === toolId)
    setActiveTool(toolId)
    setPicking('source')
    if (fileRef.current) {
      fileRef.current.multiple = !!d?.multi
      fileRef.current.accept = acceptFor(toolId, d)
      fileRef.current.click()
    }
  }

  function pickExtra(toolId: string): void {
    const d = defs.find((x) => x.id === toolId)
    if (!d?.extraFile) return
    setActiveTool(toolId)
    setPicking('extra')
    if (extraRef.current) {
      extraRef.current.accept = d.extraFile.accept
      extraRef.current.click()
    }
  }

  /** 选择/拖入源文件统一入口（File[] → 路径） */
  function handleSourceFiles(files: File[]): void {
    if (files.length === 0 || !activeTool) return
    const main = files[0]
    if (!main) return
    setSourcePath(window.omniget.filePath(main))
    setExtraFiles(files.map((f) => window.omniget.filePath(f)))
  }

  function onFileChosen(e: React.ChangeEvent<HTMLInputElement>): void {
    const files = Array.from(e.target.files ?? [])
    e.target.value = '' // 允许重复选择同一文件
    if (picking === 'extra') {
      const def2 = defs.find((x) => x.id === activeTool)
      const first = files[0]
      if (def2?.extraFile && first) {
        const path = window.omniget.filePath(first)
        setParams((p) => ({
          ...p,
          [def2.id]: { ...p[def2.id], [def2.extraFile!.key]: path }
        }))
      }
      return
    }
    handleSourceFiles(files)
  }

  function onDrop(e: React.DragEvent<HTMLDivElement>): void {
    e.preventDefault()
    setDragOver(false)
    if (!def) return
    handleSourceFiles(Array.from(e.dataTransfer.files))
  }

  async function submitOne(toolId: string, extra?: Record<string, string>): Promise<void> {
    const d = defs.find((x) => x.id === toolId)
    const filled: Record<string, string> = {}
    for (const f of d?.fields ?? []) {
      filled[f.key] = extra?.[f.key] ?? params[toolId]?.[f.key] ?? f.default ?? ''
    }
    // T4：多文件输入（顺序 = 拼接顺序）与附加文件路径透传
    if (d?.multi) filled.__files = JSON.stringify(extraFiles.length > 0 ? extraFiles : [sourcePath])
    if (d?.extraFile) filled[d.extraFile.key] = params[toolId]?.[d.extraFile.key] ?? ''
    await window.omniget.toolCreate({
      tool: toolId,
      sourcePath,
      params: filled,
      saveDir: await window.omniget.defaultSaveDir().catch(() => undefined)
    })
  }

  async function run(toolId: string): Promise<void> {
    if (!sourcePath) {
      toast('请先选择源文件', 'warning')
      return
    }
    const d = defs.find((x) => x.id === toolId)
    if (d?.extraFile && !params[toolId]?.[d.extraFile.key]) {
      toast(`请先选择${d.extraFile.label}`, 'warning')
      return
    }
    setSubmitting(true)
    try {
      await submitOne(toolId)
      toast('已提交处理（任务列表可见进度）', 'success')
    } catch (err) {
      toastError('提交', err)
    } finally {
      setSubmitting(false)
    }
  }

  async function runClipRegions(toolId: string, regions: ClipRegion[]): Promise<void> {
    if (!sourcePath) {
      toast('请先选择源文件', 'warning')
      return
    }
    setSubmitting(true)
    let ok = 0
    const errors: string[] = []
    try {
      for (const r of regions) {
        try {
          await submitOne(toolId, {
            from: r.start.toFixed(2),
            duration: (r.end - r.start).toFixed(2)
          })
          ok++
        } catch (err) {
          errors.push(`#${fmtRange(r)}：${err instanceof Error ? err.message : String(err)}`)
        }
      }
      if (errors.length > 0) {
        toast(`已提交 ${ok}/${regions.length} 个剪辑任务；失败：${errors.join('；')}`, 'warning')
      } else {
        toast(`已提交 ${ok} 个剪辑区域任务`, 'success')
      }
    } finally {
      setSubmitting(false)
    }
  }

  function fmtRange(r: ClipRegion): string {
    return `${r.start.toFixed(1)}s-${r.end.toFixed(1)}s`
  }

  /** T6：多区域合并为单一输出（region-concat 单命令 filter_complex） */
  async function runMergedClip(kind: 'audio' | 'video', regions: ClipRegion[]): Promise<void> {
    if (!sourcePath) {
      toast('请先选择源文件', 'warning')
      return
    }
    setSubmitting(true)
    try {
      await window.omniget.toolCreate({
        tool: 'region-concat',
        sourcePath,
        params: { regions: JSON.stringify(regions), media: kind },
        saveDir: await window.omniget.defaultSaveDir().catch(() => undefined)
      })
      toast(`已提交合并任务（${regions.length} 段无缝拼接）`, 'success')
    } catch (err) {
      toastError('提交合并', err)
    } finally {
      setSubmitting(false)
    }
  }

  const visibleFields =
    def?.fields.filter((f) => !(isClip && (f.key === 'from' || f.key === 'duration'))) ?? []

  return (
    <div className="flex h-full overflow-hidden">
      {/* ── 左列：工具导航 ──────────────────────────────────────────── */}
      <aside className="w-56 shrink-0 overflow-y-auto border-r border-border bg-surface px-2 py-3">
        <h2 className="px-2 pb-2 text-sm font-semibold">工具箱</h2>
        {defsError && (
          <p className="px-2 text-[11px] leading-relaxed text-danger">
            工具清单加载失败：{defsError}
          </p>
        )}
        {!defsError && defs.length === 0 && (
          <p className="px-2 py-4 text-[11px] text-text-3">工具清单为空</p>
        )}
        {CATEGORIES.map((cat) => {
          const items = defs.filter((d) => (d.category ?? 'common') === cat.key)
          if (items.length === 0) return null
          return (
            <div key={cat.key} className="mb-3">
              <p className="mb-1 flex items-center gap-1.5 px-2 text-[10px] uppercase tracking-[0.14em] text-text-3">
                <span className="inline-block h-2 w-[3px] rounded-full bg-accent" />
                {cat.title}
              </p>
              {items.map((d) => {
                const isActive = activeTool === d.id
                const Icon = TOOL_ICONS[d.id]
                return (
                  <button
                    key={d.id}
                    onClick={() => setActiveTool(d.id)}
                    title={d.desc}
                    className={`mb-0.5 flex w-full items-center gap-2 rounded-ctl px-2.5 py-2 text-left transition-colors ${
                      isActive
                        ? 'bg-accent-soft text-accent'
                        : 'text-text-2 hover:bg-surface-2 hover:text-text-1'
                    }`}
                  >
                    {Icon ? (
                      <Icon size={14} weight={isActive ? 'fill' : 'regular'} className="shrink-0" />
                    ) : null}
                    <span className="min-w-0 flex-1 truncate text-xs font-medium">{d.label}</span>
                  </button>
                )
              })}
            </div>
          )
        })}
      </aside>

      {/* ── 右列：大操作区 ──────────────────────────────────────────── */}
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-6 py-5">
          {!defsError && defs.length === 0 && (
            <div className="rounded-panel border border-border px-4 py-8 text-center text-xs text-text-3">
              工具清单为空
            </div>
          )}

          {!def && defs.length > 0 && !defsError && (
            <div className="rounded-panel border border-border px-4 py-10 text-center">
              <p className="text-sm text-text-2">从左侧选择一个工具开始</p>
              <p className="mt-1 text-[11px] text-text-3">
                音频裁剪 / 视频剪辑支持波形拖选多个剪辑区域并合并输出
              </p>
            </div>
          )}

          {def && (
            <>
              <div className="flex items-center gap-2">
                {ToolIcon && <ToolIcon size={16} weight="fill" className="text-accent" />}
                <h2 className="text-sm font-semibold">{def.label}</h2>
              </div>
              <p className="mb-4 mt-1 break-words text-[11px] leading-relaxed text-text-3">
                {def.desc}
              </p>

              {/* 源文件：大上传面板（点击 / 拖放） */}
              <div
                onClick={() => pickFile(def.id)}
                onDragOver={(e) => {
                  e.preventDefault()
                  setDragOver(true)
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={onDrop}
                className={`cursor-pointer rounded-panel border border-dashed px-4 py-6 text-center transition-colors ${
                  dragOver
                    ? 'border-accent bg-accent-soft'
                    : sourcePath
                      ? 'border-border bg-surface'
                      : 'border-border bg-surface-2/40 hover:border-text-3'
                }`}
                title="点击选择文件，或直接拖入"
              >
                <input ref={fileRef} type="file" className="hidden" onChange={onFileChosen} />
                <input
                  ref={extraRef}
                  type="file"
                  className="hidden"
                  onChange={onFileChosen}
                />
                <UploadSimple
                  size={22}
                  className="mx-auto mb-1 text-text-3"
                  weight={sourcePath ? 'fill' : 'regular'}
                />
                {sourcePath ? (
                  <>
                    <p className="num truncate px-6 text-xs font-medium text-text-1" title={sourcePath}>
                      {def.multi
                        ? `${Math.max(1, extraFiles.length)} 个文件（按选择顺序处理）：${sourcePath.split(/[\\/]/).pop()}${extraFiles.length > 1 ? ' 等' : ''}`
                        : sourcePath.split(/[\\/]/).pop()}
                    </p>
                    <p className="mt-0.5 text-[10px] text-text-3">点击更换 · 支持拖放替换</p>
                  </>
                ) : (
                  <>
                    <p className="text-xs font-medium text-text-2">
                      {def.multi ? '选择源文件（可多选，按顺序处理）' : '选择源文件'}
                    </p>
                    <p className="mt-0.5 text-[10px] text-text-3">点击选择，或把文件拖到这里</p>
                  </>
                )}
              </div>

              {/* T4：附加文件（字幕等） */}
              {def.extraFile && (
                <div className="mt-2 flex items-center gap-2">
                  <Button size="sm" variant="outline" onClick={() => pickExtra(def.id)}>
                    选择{def.extraFile.label}
                  </Button>
                  <span
                    className="num min-w-0 flex-1 truncate text-xs text-text-2"
                    title={params[def.id]?.[def.extraFile.key]}
                  >
                    {params[def.id]?.[def.extraFile.key]
                      ? String(params[def.id]?.[def.extraFile.key] ?? '')
                          .split(/[\\/]/)
                          .pop()
                      : `未选择${def.extraFile.label}`}
                  </span>
                </div>
              )}

              {/* 剪辑编辑器（音频裁剪 / 视频剪辑） */}
              {isClip && sourcePath && (
                <div className="mt-3">
                  <ClipEditor
                    key={`${def.id}:${sourcePath}`}
                    source={sourcePath}
                    kind={def.id === 'trim-video' ? 'video' : 'audio'}
                    busy={submitting}
                    onSubmit={(regions, merged) =>
                      void (merged
                        ? runMergedClip(def.id === 'trim-video' ? 'video' : 'audio', regions)
                        : runClipRegions(def.id, regions))
                    }
                  />
                </div>
              )}
              {isClip && !sourcePath && (
                <p className="mt-3 rounded-ctl bg-surface-2 px-3 py-2 text-[11px] text-text-3">
                  选择文件后可播放预览，在波形 / 时间轴上拖选任意多个剪辑区域（支持多段后合并输出）
                </p>
              )}

              {/* 常规参数（剪辑工具的 from/duration 由编辑器提供） */}
              {visibleFields.length > 0 && (
                <div className="mt-3 space-y-2.5 border-t border-border pt-3">
                  {visibleFields.map((f) => (
                    <div key={f.key}>
                      <label className="mb-1 block text-[11px] text-text-2">{f.label}</label>
                      {f.type === 'select' ? (
                        <select
                          value={params[def.id]?.[f.key] ?? f.default ?? ''}
                          onChange={(e) =>
                            setParams((p) => ({
                              ...p,
                              [def.id]: { ...p[def.id], [f.key]: e.target.value }
                            }))
                          }
                          className="h-8 w-full rounded-ctl border border-border bg-surface-2 px-2 text-xs outline-none focus:border-accent"
                        >
                          {f.options?.map((o) => (
                            <option key={o} value={o}>
                              {o}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <input
                          value={params[def.id]?.[f.key] ?? f.default ?? ''}
                          onChange={(e) =>
                            setParams((p) => ({
                              ...p,
                              [def.id]: { ...p[def.id], [f.key]: e.target.value }
                            }))
                          }
                          className="num h-8 w-full rounded-ctl border border-border bg-surface-2 px-2 text-xs outline-none focus:border-accent"
                        />
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* 非剪辑类工具的提交按钮 */}
              {!isClip && (
                <div className="mt-4 flex items-center gap-3">
                  <Button size="md" disabled={submitting || !sourcePath} onClick={() => void run(def.id)}>
                    {submitting ? '提交中…' : '开始处理'}
                  </Button>
                  <span
                    className="num min-w-0 flex-1 truncate text-[10px] text-text-3"
                    title={sourcePath}
                  >
                    {sourcePath || '未选择文件'}
                  </span>
                </div>
              )}

              {/* 处理动态（按工具隔离显示：只显示当前工具的任务；后台进度持续记录，切回仍可见） */}
              {toolJobs.length > 0 && (
                <div className="mt-5">
                  <div className="mb-2 flex items-center gap-2">
                    <h3 className="text-xs text-text-2">处理动态</h3>
                    <span className="num text-[10px] text-text-3">{toolJobs.length}</span>
                    <button
                      onClick={() =>
                        setJobs((prev) => prev.filter((j) => j.tool !== activeTool))
                      }
                      className="ml-auto rounded-ctl px-1.5 py-0.5 text-[10px] text-text-3 transition-colors hover:bg-surface-2 hover:text-text-1"
                      title="清空当前工具的处理记录"
                    >
                      清空记录
                    </button>
                  </div>
                  <div className="rounded-panel border border-border px-3 py-1">
                    {toolJobs.map((j) => (
                      <div
                        key={j.taskId}
                        className="row-line flex items-center gap-2 py-1.5 text-[11px]"
                      >
                        <span
                          className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                            j.status === 'completed'
                              ? 'bg-success'
                              : j.status === 'failed'
                                ? 'bg-danger'
                                : 'bg-accent animate-pulse'
                          }`}
                        />
                        <span className="min-w-0 flex-1 truncate text-text-2">
                          {defs.find((d) => d.id === j.tool)?.label ?? j.tool}
                        </span>
                        {/* 完成后：预览产物 + 打开结果所在目录 */}
                        {j.status === 'completed' && j.message && (
                          <span className="flex shrink-0 items-center gap-0.5">
                            {previewKindOf(j.message) && (
                              <button
                                onClick={() =>
                                  setPreview({ path: j.message!, kind: previewKindOf(j.message)! })
                                }
                                className="rounded-ctl p-1 text-text-3 transition-colors hover:bg-surface-2 hover:text-accent"
                                title="预览产物"
                              >
                                <Eye size={13} />
                              </button>
                            )}
                            <button
                              onClick={() => {
                                const out = j.message ?? ''
                                // 防御：preload 未含新桥（主进程/preload 未重启）时给明确提示，不静默
                                if (typeof window.omniget.revealToolOutput !== 'function') {
                                  toast('打开目录功能需重启应用后生效', 'warning')
                                  return
                                }
                                void window.omniget
                                  .revealToolOutput(out)
                                  .catch((err) => toastError('打开目录', err))
                              }}
                              className="rounded-ctl p-1 text-text-3 transition-colors hover:bg-surface-2 hover:text-text-1"
                              title="打开结果所在目录"
                            >
                              <FolderOpen size={13} />
                            </button>
                          </span>
                        )}
                        <span className="num shrink-0 text-text-3" title={j.message}>
                          {j.status === 'completed'
                            ? '完成'
                            : j.seconds !== undefined
                              ? `${Math.floor(j.seconds)}s`
                              : (j.message ?? j.status)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </main>

      {/* 产物预览弹层 */}
      {preview && (
        <ToolPreviewModal
          path={preview.path}
          kind={preview.kind}
          onClose={() => setPreview(null)}
        />
      )}
    </div>
  )
}
