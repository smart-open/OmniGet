// 工具箱（M4-13/14，§4.7）：八件套 + 参数表单 + 独立信号量（2 并发）
import { useEffect, useRef, useState } from 'react'
import { Gear } from '@phosphor-icons/react'
import type { ToolDefInfo, ToolEvent } from '@shared/types'
import { Button } from '../../components/ui'

interface RunningJob {
  tool: string
  status: ToolEvent['status']
  message?: string
  seconds?: number
}

export function ToolboxPage() {
  const [defs, setDefs] = useState<ToolDefInfo[]>([])
  const [openTool, setOpenTool] = useState<string | null>(null)
  const [params, setParams] = useState<Record<string, Record<string, string>>>({})
  const [sourcePath, setSourcePath] = useState('')
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
      if (e.status === 'progress') {
        setJobs((prev) =>
          prev.map((j, i) => (i === prev.length - 1 ? { ...j, seconds: e.seconds } : j))
        )
        return
      }
      setJobs((prev) => [...prev.slice(-5), { tool: e.tool, status: e.status, message: e.message, seconds: e.seconds }])
      if (e.status === 'completed') setNotice(`处理完成：${e.message ?? ''}`)
      if (e.status === 'failed') setNotice(`处理失败：${e.message ?? ''}`)
    })
    return off
  }, [])

  function pickFile(toolId: string): void {
    setOpenTool(toolId)
    if (fileRef.current) {
      fileRef.current.accept = toolId === 'subtitle-convert' ? '.srt,.ass,.vtt' : 'audio/*,video/*'
      fileRef.current.click()
    }
  }

  function onFileChosen(e: React.ChangeEvent<HTMLInputElement>): void {
    const file = e.target.files?.[0]
    if (file && openTool) {
      setSourcePath(window.omniget.filePath(file))
    }
  }

  async function run(toolId: string): Promise<void> {
    if (!sourcePath) {
      setNotice('请先选择源文件')
      return
    }
    const def = defs.find((d) => d.id === toolId)
    const filled: Record<string, string> = {}
    for (const f of def?.fields ?? []) {
      filled[f.key] = params[toolId]?.[f.key] ?? f.default ?? ''
    }
    try {
      await window.omniget.toolCreate({
        tool: toolId,
        sourcePath,
        params: filled,
        saveDir: await window.omniget.defaultSaveDir().catch(() => undefined)
      })
      setNotice('已提交（独立 2 并发队列，任务列表可见）')
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <main className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[860px] px-6 py-6">
        <h2 className="mb-1 text-sm font-semibold">工具箱</h2>
        <p className="mb-4 text-[11px] text-text-3">
          纯本地 ffmpeg 处理，零 AI / 零 GPU；独立 2 并发队列，任务进度可在任务列表观察
        </p>

        {notice && (
          <div className="mb-4 rounded-ctl border border-border bg-surface-2 px-3 py-2 text-xs text-text-2">
            {notice}
          </div>
        )}

        {/* defs 加载失败（三态：错误） */}
        {defsError && (
          <div className="mb-4 rounded-panel border border-danger/30 bg-danger/8 px-3 py-2 text-xs text-danger">
            工具清单加载失败：{defsError}（重启应用或检查 ffmpeg sidecar 后重试）
          </div>
        )}

        {/* 三态：空态 */}
        {!defsError && defs.length === 0 && (
          <div className="rounded-panel border border-border px-4 py-8 text-center text-xs text-text-3">
            工具清单为空
          </div>
        )}

        {/* 分类分组：通用 → 音频 → 视频（每组标题 + 工具卡网格，每行 4 个） */}
        {(
          [
            { key: 'common', title: '通用' },
            { key: 'audio', title: '音频处理' },
            { key: 'video', title: '视频处理' }
          ] as const
        ).map((cat) => {
          const items = defs.filter((d) => (d.category ?? 'common') === cat.key)
          if (items.length === 0) return null
          return (
            <section key={cat.key} className="mb-6">
              <h3 className="mb-2 flex items-center gap-2 text-xs font-medium text-text-2">
                <span className="inline-block h-3 w-[3px] rounded-full bg-accent" />
                {cat.title}
                <span className="num text-[10px] text-text-3">{items.length}</span>
              </h3>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                {items.map((d) => (
                  <div
                    key={d.id}
                    className="flex flex-col rounded-panel border border-border bg-surface p-4 transition-colors hover:border-text-3"
                  >
                    <p className="text-[13px] font-medium">{d.label}</p>
                    {d.desc && (
                      <p className="mt-1 flex-1 text-[11px] leading-relaxed text-text-3">{d.desc}</p>
                    )}
                    <div className="mt-3 flex items-center gap-2 border-t border-border pt-3">
                      <Button
                        size="xs"
                        variant="primary"
                        className="!h-7 rounded-full !px-3"
                        icon={<Gear size={12} />}
                        onClick={() => pickFile(d.id)}
                      >
                        处理
                      </Button>
                      {openTool === d.id && (
                        <span className="num truncate text-[10px] text-text-3">
                          {sourcePath ? sourcePath.split(/[\\/]/).pop() : '未选择文件'}
                        </span>
                      )}
                    </div>
                    {/* 参数表单（展开） */}
                    {openTool === d.id && (
                      <div className="mt-3 space-y-1.5 border-t border-border pt-3">
                        {d.fields.map((f) => (
                          <div key={f.key} className="flex items-center gap-1.5">
                            <span className="w-14 shrink-0 text-[10px] text-text-3">{f.label}</span>
                            {f.type === 'select' ? (
                              <select
                                value={params[d.id]?.[f.key] ?? f.default ?? ''}
                                onChange={(e) =>
                                  setParams((p) => ({
                                    ...p,
                                    [d.id]: { ...p[d.id], [f.key]: e.target.value }
                                  }))
                                }
                                className="h-6 flex-1 rounded border border-border bg-surface-2 px-1 text-[10px] outline-none"
                              >
                                {f.options?.map((o) => (
                                  <option key={o} value={o}>
                                    {o}
                                  </option>
                                ))}
                              </select>
                            ) : (
                              <input
                                value={params[d.id]?.[f.key] ?? f.default ?? ''}
                                onChange={(e) =>
                                  setParams((p) => ({
                                    ...p,
                                    [d.id]: { ...p[d.id], [f.key]: e.target.value }
                                  }))
                                }
                                className="num h-6 flex-1 rounded border border-border bg-surface-2 px-1 text-[10px] outline-none focus:border-accent"
                              />
                            )}
                          </div>
                        ))}
                        <p className="num truncate text-[10px] text-text-3">
                          {sourcePath ? `源：${sourcePath}` : '未选择文件'}
                        </p>
                        <Button size="xs" onClick={() => void run(d.id)}>
                          提交处理
                        </Button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )
        })}

        {/* 最近任务动态 */}
        {jobs.length > 0 && (
          <div className="mt-5">
            <h3 className="mb-2 text-xs text-text-2">处理动态</h3>
            {jobs.map((j, i) => (
              <div key={i} className="row-line flex items-center gap-2 px-1 py-1.5 text-[11px]">
                <span
                  className={`h-1.5 w-1.5 rounded-full ${
                    j.status === 'completed'
                      ? 'bg-success'
                      : j.status === 'failed'
                        ? 'bg-danger'
                        : 'bg-accent'
                  }`}
                />
                <span className="flex-1 text-text-2">{j.tool}</span>
                <span className="num text-text-3">
                  {j.seconds !== undefined ? `${Math.floor(j.seconds)}s` : (j.message ?? j.status)}
                </span>
              </div>
            ))}
          </div>
        )}

        <input ref={fileRef} type="file" className="hidden" onChange={onFileChosen} />
      </div>
    </main>
  )
}
