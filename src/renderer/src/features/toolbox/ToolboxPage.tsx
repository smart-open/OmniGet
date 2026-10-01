// 工具箱（M4-13/14，§4.7）：左右分栏布局（左工具导航 / 右大操作区，修文本溢出）
// 音频裁剪/视频剪辑接入多区域剪辑编辑器（试听 + A/B 标记，逐区域批量提交）
import { useEffect, useRef, useState } from 'react'
import { Gear } from '@phosphor-icons/react'
import type { ToolDefInfo, ToolEvent } from '@shared/types'
import { Button } from '../../components/ui'
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

export function ToolboxPage() {
  const [defs, setDefs] = useState<ToolDefInfo[]>([])
  const [activeTool, setActiveTool] = useState<string | null>(null)
  const [params, setParams] = useState<Record<string, Record<string, string>>>({})
  const [sourcePath, setSourcePath] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const [jobs, setJobs] = useState<RunningJob[]>([])
  const [notice, setNotice] = useState('')
  const [defsError, setDefsError] = useState('')

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
      if (e.status === 'completed') setNotice(`处理完成：${e.message ?? ''}`)
      if (e.status === 'failed') setNotice(`处理失败：${e.message ?? ''}`)
    })
    return off
  }, [])

  const def = defs.find((d) => d.id === activeTool) ?? null
  const isClip = activeTool != null && CLIP_TOOLS.has(activeTool)

  function pickFile(toolId: string): void {
    setActiveTool(toolId)
    if (fileRef.current) {
      fileRef.current.accept =
        toolId === 'subtitle-convert'
          ? '.srt,.ass,.vtt'
          : toolId === 'trim-video' || toolId === 'video-frame'
            ? 'video/*'
            : toolId === 'image-convert'
              ? 'image/*'
              : 'audio/*,video/*'
      fileRef.current.click()
    }
  }

  function onFileChosen(e: React.ChangeEvent<HTMLInputElement>): void {
    const file = e.target.files?.[0]
    if (file && activeTool) {
      setSourcePath(window.omniget.filePath(file))
      setNotice('')
    }
    e.target.value = '' // 允许重复选择同一文件
  }

  async function submitOne(toolId: string, extra?: Record<string, string>): Promise<void> {
    const d = defs.find((x) => x.id === toolId)
    const filled: Record<string, string> = {}
    for (const f of d?.fields ?? []) {
      filled[f.key] = extra?.[f.key] ?? params[toolId]?.[f.key] ?? f.default ?? ''
    }
    await window.omniget.toolCreate({
      tool: toolId,
      sourcePath,
      params: filled,
      saveDir: await window.omniget.defaultSaveDir().catch(() => undefined)
    })
  }

  async function run(toolId: string): Promise<void> {
    if (!sourcePath) {
      setNotice('请先选择源文件')
      return
    }
    setSubmitting(true)
    try {
      await submitOne(toolId)
      setNotice('已提交（独立 2 并发队列，任务列表可见）')
    } catch (err) {
      setNotice(`提交失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setSubmitting(false)
    }
  }

  async function runClipRegions(toolId: string, regions: ClipRegion[]): Promise<void> {
    if (!sourcePath) {
      setNotice('请先选择源文件')
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
      setNotice(
        errors.length > 0
          ? `已提交 ${ok}/${regions.length} 个剪辑任务；失败：${errors.join('；')}`
          : `已提交 ${ok} 个剪辑区域任务（独立 2 并发队列，任务列表可见）`
      )
    } finally {
      setSubmitting(false)
    }
  }

  function fmtRange(r: ClipRegion): string {
    return `${r.start.toFixed(1)}s-${r.end.toFixed(1)}s`
  }

  const visibleFields = def?.fields.filter((f) => !(isClip && (f.key === 'from' || f.key === 'duration'))) ?? []

  return (
    <div className="flex h-full overflow-hidden">
      {/* ── 左列：工具导航（紧凑行，替代原 2×4 小卡片网格）────────── */}
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
                    <Gear size={13} weight={isActive ? 'fill' : 'regular'} className="shrink-0" />
                    <span className="min-w-0 flex-1 truncate text-xs font-medium">{d.label}</span>
                    {CLIP_TOOLS.has(d.id) && (
                      <span className="shrink-0 rounded border border-accent/40 px-1 py-px text-[8px] text-accent">
                        可试听
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          )
        })}
      </aside>

      {/* ── 右列：大操作区（全宽表单 + 剪辑编辑器）─────────────────── */}
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
                音频裁剪 / 视频剪辑支持试听并拖选多个剪辑区域
              </p>
            </div>
          )}

          {def && (
            <>
              <h2 className="text-sm font-semibold">{def.label}</h2>
              {/* 全宽描述：break-words 防溢出（原小卡片内 truncate 导致说明读不全） */}
              <p className="mb-4 mt-1 break-words text-[11px] leading-relaxed text-text-3">
                {def.desc}
              </p>

              {notice && (
                <div className="mb-4 break-words rounded-ctl border border-border bg-surface-2 px-3 py-2 text-xs text-text-2">
                  {notice}
                </div>
              )}

              {/* 源文件 */}
              <div className="rounded-panel border border-border bg-surface p-4">
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    icon={<Gear size={13} />}
                    onClick={() => pickFile(def.id)}
                  >
                    {sourcePath ? '更换文件' : '选择源文件'}
                  </Button>
                  <span
                    className="num min-w-0 flex-1 truncate text-xs text-text-2"
                    title={sourcePath}
                  >
                    {sourcePath ? sourcePath.split(/[\\/]/).pop() : '未选择文件'}
                  </span>
                </div>

                {/* 剪辑编辑器（音频裁剪 / 视频剪辑） */}
                {isClip && sourcePath && (
                  <div className="mt-3">
                    <ClipEditor
                      key={`${def.id}:${sourcePath}`}
                      source={sourcePath}
                      kind={def.id === 'trim-video' ? 'video' : 'audio'}
                      busy={submitting}
                      onSubmit={(regions) => void runClipRegions(def.id, regions)}
                    />
                  </div>
                )}
                {isClip && !sourcePath && (
                  <p className="mt-3 rounded-ctl bg-surface-2 px-3 py-2 text-[11px] text-text-3">
                    选择文件后可试听，并在时间轴上标记任意多个剪辑区域（逐区域提交，互不覆盖）
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
                  <div className="mt-4 flex items-center gap-3 border-t border-border pt-3">
                    <Button size="sm" disabled={submitting} onClick={() => void run(def.id)}>
                      {submitting ? '提交中…' : '提交处理'}
                    </Button>
                    <span
                      className="num min-w-0 flex-1 truncate text-[10px] text-text-3"
                      title={sourcePath}
                    >
                      {sourcePath || '未选择文件'}
                    </span>
                  </div>
                )}
              </div>

              {/* 处理动态 */}
              {jobs.length > 0 && (
                <div className="mt-4">
                  <h3 className="mb-2 text-xs text-text-2">处理动态</h3>
                  <div className="rounded-panel border border-border px-3 py-1">
                    {jobs.map((j) => (
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
                                : 'bg-accent'
                          }`}
                        />
                        <span className="min-w-0 flex-1 truncate text-text-2">
                          {defs.find((d) => d.id === j.tool)?.label ?? j.tool}
                        </span>
                        <span className="num shrink-0 text-text-3" title={j.message}>
                          {j.seconds !== undefined
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

          <input ref={fileRef} type="file" className="hidden" onChange={onFileChosen} />
        </div>
      </main>
    </div>
  )
}
