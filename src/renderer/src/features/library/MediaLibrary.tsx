// 四期（0.11.x，roadmap「统一媒体库」）：音乐库 + 视频库汇合为统一内容视图。
// 顶部分段切换（带计数与汇总体积）+ 任务完成/删除事件自动刷新；
// 子视图沿用既有组件——音乐=歌手/专辑分组列表，视频=封面墙。

import { useCallback, useEffect, useState } from 'react'
import { Books, MonitorPlay, MusicNote } from '@phosphor-icons/react'
import { MusicLibrary } from './MusicLibrary'
import { VideoLibrary } from './VideoLibrary'

function formatTotalSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024 * 1024) return `${(bytes / 1024 ** 4).toFixed(2)} TB`
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 ** 2).toFixed(0)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

type LibraryTab = 'music' | 'video'

export function MediaLibrary() {
  const [tab, setTab] = useState<LibraryTab>('music')
  const [summary, setSummary] = useState<{ tracks: number; videos: number; bytes: number } | null>(
    null
  )

  const load = useCallback(async (): Promise<void> => {
    try {
      const [tracks, videos] = await Promise.all([
        window.omniget.musicLibrary(),
        window.omniget.videoLibrary()
      ])
      setSummary({
        tracks: tracks.length,
        videos: videos.length,
        bytes:
          tracks.reduce((a, t) => a + t.size, 0) + videos.reduce((a, v) => a + v.size, 0)
      })
    } catch {
      // 汇总条失败不打扰（两个子视图有各自的错误提示路径）
    }
  }, [])

  useEffect(() => {
    void load()
    const off = window.omniget.onTaskEvents((events) => {
      if (events.some((e) => e.status === 'completed' || e.removed)) void load()
    })
    return off
  }, [load])

  return (
    // 审查修复：flex 列布局——子视图（MusicLibrary/VideoLibrary）根节点自带
    // `h-full overflow-y-auto`，若父容器直接纵向堆叠会形成嵌套滚动容器 +
    // 父级重复滚动条；min-h-0 flex-1 给子视图明确的弹性高度，滚动只发生在子视图
    <main className="flex h-full flex-col overflow-hidden">
      <div className="mx-auto w-full max-w-[1100px] shrink-0 px-6 pb-2 pt-6">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2 text-sm font-medium text-text-1">
            <Books size={17} className="text-accent" />
            内容库
          </div>
          <div className="flex items-center gap-1 rounded-ctl border border-border p-0.5">
            {(
              [
                { id: 'music', label: '音乐', icon: MusicNote, count: summary?.tracks },
                { id: 'video', label: '视频', icon: MonitorPlay, count: summary?.videos }
              ] as const
            ).map((s) => (
              <button
                key={s.id}
                onClick={() => setTab(s.id)}
                className={`press flex items-center gap-1.5 rounded-[7px] px-3 py-1 text-xs transition-colors ${
                  tab === s.id
                    ? 'bg-accent text-white'
                    : 'text-text-2 hover:bg-surface-2 hover:text-text-1'
                }`}
              >
                <s.icon size={13} />
                {s.label}
                <span className="num text-[10px] opacity-80">{s.count ?? '—'}</span>
              </button>
            ))}
          </div>
          {summary && (
            <span className="num ml-auto text-[11px] text-text-3">
              共 {formatTotalSize(summary.bytes)}
            </span>
          )}
        </div>
      </div>

      {/* ── 子视图：音乐（歌手/专辑分组）/ 视频（封面墙）──────────── */}
      <div className="min-h-0 flex-1 overflow-hidden">
        {tab === 'music' ? <MusicLibrary /> : <VideoLibrary />}
      </div>
    </main>
  )
}
