// 三期（0.10.x）：视频媒体库 MVP——已下载视频封面墙 + 元数据浏览。
// 数据源 = videos 表（视频任务完成即登记）；检索、本地预览（omniget-preview://local
// 流式 + Range）、定位文件、移除条目（不删文件）。
// 反馈硬性标准：移除经 confirmAction 二次确认；写操作失败 toastError。

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ArrowsClockwise,
  FileText,
  FolderOpen,
  MagnifyingGlass,
  MonitorPlay,
  Play,
  Trash,
  Warning,
  X
} from '@phosphor-icons/react'
import type { VideoLibraryItem } from '@shared/types'
import { Button, Input } from '../../components/ui'
import { toast, toastError, confirmAction } from '../../lib/feedback'

/** 本地媒体流协议（与音乐库/工具箱产物预览同源） */
function localMediaUrl(path: string): string {
  return `omniget-preview://local/${encodeURIComponent(path)}`
}

/** Chromium <video> 可直接播放的容器（mkv/ts/flv 不在内——只给定位不给预览） */
const PLAYABLE = /\.(mp4|webm|mov)$/i

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

function formatDuration(sec: number | null): string {
  if (sec == null || !Number.isFinite(sec) || sec <= 0) return '—'
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.floor(sec % 60)
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`
}

export function VideoLibrary() {
  const [items, setItems] = useState<VideoLibraryItem[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [preview, setPreview] = useState<VideoLibraryItem | null>(null)

  const load = useCallback(async (): Promise<void> => {
    try {
      setItems(await window.omniget.videoLibrary())
    } catch (err) {
      toastError('视频库加载失败', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
    // 视频任务完成自动刷新（用户停在库页无需手动刷新）
    const off = window.omniget.onTaskEvents((events) => {
      if (events.some((e) => e.status === 'completed')) void load()
    })
    return () => {
      off()
      setPreview(null)
    }
  }, [load])

  // 预览弹层 Esc 关闭
  useEffect(() => {
    if (!preview) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setPreview(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [preview])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return items
    return items.filter(
      (v) => v.title.toLowerCase().includes(q) || (v.platform ?? '').toLowerCase().includes(q)
    )
  }, [items, query])

  async function reveal(v: VideoLibraryItem): Promise<void> {
    await window.omniget.revealToolOutput(v.path)
  }

  /** 四期（0.11.x）：NFO/海报手动导出（写操作 → toast 反馈） */
  const [exportingNfo, setExportingNfo] = useState<string | null>(null)
  async function exportNfo(v: VideoLibraryItem): Promise<void> {
    setExportingNfo(v.id)
    try {
      const r = await window.omniget.videoExportNfo(v.id)
      toast(`NFO${r.posterPath ? '/海报' : ''}已导出到视频同目录`, 'success')
    } catch (err) {
      toastError('导出 NFO 失败', err)
    } finally {
      setExportingNfo(null)
    }
  }

  async function remove(v: VideoLibraryItem): Promise<void> {
    const ok = await confirmAction({
      title: '移除库条目',
      message: `从视频库移除「${v.title}」？（不删除磁盘文件）`,
      confirmLabel: '移除',
      danger: true
    })
    if (!ok) return
    try {
      await window.omniget.videoLibraryRemove(v.id)
      toast('已从视频库移除', 'success')
      if (preview?.id === v.id) setPreview(null)
      await load()
    } catch (err) {
      toastError('移除失败', err)
    }
  }

  const total = items.length

  return (
    <main className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[1100px] px-6 py-6">
        {/* ── 顶部：统计 + 检索 + 刷新 ─────────────────────────────── */}
        <div className="mb-4 flex items-center gap-3">
          <div className="flex items-center gap-2 text-sm text-text-1">
            <MonitorPlay size={16} className="text-accent" />
            视频库
            <span className="num text-xs text-text-3">{total} 个</span>
          </div>
          <div className="ml-auto flex w-[300px] items-center gap-2">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="检索标题 / 平台"
              lead={<MagnifyingGlass size={14} />}
              className="flex-1"
            />
            <Button variant="outline" icon={<ArrowsClockwise size={14} />} onClick={() => void load()} title="刷新">
              刷新
            </Button>
          </div>
        </div>

        {loading && (
          <div className="grid grid-cols-2 gap-4 py-6 sm:grid-cols-3 lg:grid-cols-4">
            {Array.from({ length: 8 }, (_, i) => (
              <div key={i} className="skeleton-line aspect-video rounded-ctl" />
            ))}
          </div>
        )}

        {!loading && total === 0 && (
          <div className="rounded-panel border border-border px-6 py-14 text-center text-sm text-text-3">
            视频库还是空的——下载完成的视频会自动登记到这里
            <br />
            <span className="text-xs">封面墙浏览已下载视频；配合设置 → 模板的命名模板归档效果最佳</span>
          </div>
        )}

        {!loading && total > 0 && filtered.length === 0 && (
          <p className="py-10 text-center text-sm text-text-3">没有匹配「{query}」的条目</p>
        )}

        {/* ── 封面墙 ─────────────────────────────────────────────────── */}
        {!loading && filtered.length > 0 && (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {filtered.map((v) => (
              <div
                key={v.id}
                className="group overflow-hidden rounded-ctl border border-border bg-surface transition-colors hover:border-accent/40"
              >
                {/* 封面：16:9；占位图标在下、封面图绝对定位叠上（加载失败隐藏 img
                    露出占位）——占位放 img 之后会永远叠在封面上 */}
                <div className="relative aspect-video bg-surface-2">
                  <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                    <MonitorPlay size={30} className="text-text-3 opacity-40" />
                  </div>
                  {v.coverPath ? (
                    <img
                      src={localMediaUrl(v.coverPath)}
                      alt={v.title}
                      loading="lazy"
                      className="absolute inset-0 h-full w-full object-cover"
                      onError={(e) => {
                        ;(e.currentTarget as HTMLImageElement).style.display = 'none'
                      }}
                    />
                  ) : null}
                  {/* 悬浮预览按钮（仅 Chromium 可播放容器；文件缺失禁用） */}
                  {PLAYABLE.test(v.path) && v.exists && (
                    <button
                      title="预览播放"
                      onClick={() => setPreview(v)}
                      className="press absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 transition-opacity group-hover:opacity-100"
                    >
                      <span className="flex h-10 w-10 items-center justify-center rounded-full bg-accent text-white">
                        <Play size={16} weight="fill" />
                      </span>
                    </button>
                  )}
                  <span className="num absolute bottom-1.5 right-1.5 rounded bg-black/60 px-1.5 py-0.5 text-[10px] leading-none text-white">
                    {formatDuration(v.durationSec)}
                  </span>
                </div>
                <div className="px-2.5 py-2">
                  <div className="truncate text-xs text-text-1" title={v.title}>
                    {v.title}
                  </div>
                  <div className="mt-1 flex items-center gap-2 text-[10px] text-text-3">
                    <span className="uppercase">{v.platform ?? 'video'}</span>
                    <span className="num">{formatSize(v.size)}</span>
                    {!v.exists && (
                      <span className="flex items-center gap-0.5 text-danger" title="文件已被移动或删除">
                        <Warning size={11} /> 缺失
                      </span>
                    )}
                    <span className="ml-auto flex items-center gap-1">
                      {/* 四期：NFO/海报导出（Jellyfin/Emby 归档口径） */}
                      <button
                        title="导出 NFO/海报（Jellyfin/Emby）"
                        disabled={exportingNfo === v.id}
                        className="press flex h-5 w-5 items-center justify-center rounded text-text-3 transition-colors hover:bg-surface-2 hover:text-text-1 disabled:opacity-50"
                        onClick={() => void exportNfo(v)}
                      >
                        <FileText size={12} />
                      </button>
                      <button
                        title="打开所在目录"
                        className="press flex h-5 w-5 items-center justify-center rounded text-text-3 transition-colors hover:bg-surface-2 hover:text-text-1"
                        onClick={() => void reveal(v)}
                      >
                        <FolderOpen size={12} />
                      </button>
                      <button
                        title="从视频库移除（不删文件）"
                        className="press flex h-5 w-5 items-center justify-center rounded text-text-3 transition-colors hover:bg-surface-2 hover:text-danger"
                        onClick={() => void remove(v)}
                      >
                        <Trash size={12} />
                      </button>
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── 预览弹层（本地流式播放，Esc/遮罩关闭）────────────────────── */}
      {preview && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-8"
          onClick={() => setPreview(null)}
        >
          <div
            className="w-full max-w-3xl overflow-hidden rounded-panel border border-border bg-surface shadow-[var(--shadow-pop)]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-2.5">
              <span className="truncate text-xs text-text-1">{preview.title}</span>
              <button
                className="press text-text-3 hover:text-text-1"
                onClick={() => setPreview(null)}
                aria-label="关闭预览"
              >
                <X size={14} />
              </button>
            </div>
            <video
              src={localMediaUrl(preview.path)}
              controls
              autoPlay
              className="max-h-[70vh] w-full bg-black"
              onError={() => toast('本地播放失败（文件可能已被移动或删除）', 'warning')}
            />
          </div>
        </div>
      )}
    </main>
  )
}
