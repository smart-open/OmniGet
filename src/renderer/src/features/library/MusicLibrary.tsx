// 二期（0.9.x 音乐库）：按歌手/专辑分组浏览已下载曲目。
// 数据源 = music_tracks 表（music.done 完成即登记）；支持检索、本地试听
// （omniget-preview://local 流式）、MusicBrainz 一键补标签、定位文件、移除条目。
// 反馈硬性标准：所有写操作（补标签/移除）均有 toast + 二次确认。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  MagnifyingGlass,
  MusicNote,
  Play,
  Pause,
  ArrowsClockwise,
  FolderOpen,
  Trash,
  Warning
} from '@phosphor-icons/react'
import type { MusicLibraryTrack } from '@shared/types'
import { Button, Input } from '../../components/ui'
import { toast, toastError, confirmAction } from '../../lib/feedback'

/** 本地媒体流协议（与工具箱产物预览同源） */
function localMediaUrl(path: string): string {
  return `omniget-preview://local/${encodeURIComponent(path)}`
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

interface AlbumGroup {
  artist: string
  album: string
  tracks: MusicLibraryTrack[]
}

export function MusicLibrary() {
  const [tracks, setTracks] = useState<MusicLibraryTrack[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [playingId, setPlayingId] = useState<string | null>(null)
  const [retagging, setRetagging] = useState<string | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  const load = useCallback(async (): Promise<void> => {
    try {
      const rows = await window.omniget.musicLibrary()
      setTracks(rows)
    } catch (err) {
      toastError('音乐库加载失败', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
    // 流畅性：音乐下载完成自动刷新（用户停在库页无需手动刷新）
    const off = window.omniget.onTaskEvents((events) => {
      if (events.some((e) => e.status === 'completed')) void load()
    })
    return () => {
      off()
      audioRef.current?.pause()
      audioRef.current = null
    }
  }, [load])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return tracks
    return tracks.filter(
      (t) =>
        t.title.toLowerCase().includes(q) ||
        (t.artist ?? '').toLowerCase().includes(q) ||
        (t.album ?? '').toLowerCase().includes(q)
    )
  }, [tracks, query])

  /** 分组：歌手 → 专辑（缺失归「未知歌手 / Unknown Album」） */
  const groups = useMemo<AlbumGroup[]>(() => {
    const map = new Map<string, AlbumGroup>()
    for (const t of filtered) {
      const artist = t.artist?.trim() || '未知歌手'
      const album = t.album?.trim() || 'Unknown Album'
      const key = `${artist}\n${album}`
      const g = map.get(key)
      if (g) g.tracks.push(t)
      else map.set(key, { artist, album, tracks: [t] })
    }
    return [...map.values()]
  }, [filtered])

  function togglePlay(t: MusicLibraryTrack): void {
    if (playingId === t.id) {
      audioRef.current?.pause()
      setPlayingId(null)
      return
    }
    audioRef.current?.pause()
    const audio = new Audio(localMediaUrl(t.path))
    audioRef.current = audio
    audio.onended = () => setPlayingId(null)
    audio.onerror = () => {
      setPlayingId(null)
      toast('本地播放失败（文件可能已被移动或删除）', 'warning')
    }
    audio.play().catch(() => {
      setPlayingId(null)
      toast('本地播放失败', 'warning')
    })
    setPlayingId(t.id)
  }

  async function reveal(t: MusicLibraryTrack): Promise<void> {
    await window.omniget.revealToolOutput(t.path)
  }

  async function retag(t: MusicLibraryTrack): Promise<void> {
    const ok = await confirmAction({
      title: 'MusicBrainz 补标签',
      message: `将查询 MusicBrainz 并用匹配结果回写「${t.title}」的标签（流拷贝，不改音频数据，原文件被替换）。继续？`,
      confirmLabel: '补标签',
      danger: false
    })
    if (!ok) return
    setRetagging(t.id)
    try {
      const tags = await window.omniget.musicLibraryRetag(t.id)
      toast(`补标签完成：${tags.artist ?? ''} - ${tags.title}`, 'success')
      await load()
    } catch (err) {
      toastError('补标签失败', err)
    } finally {
      setRetagging(null)
    }
  }

  async function removeTrack(t: MusicLibraryTrack): Promise<void> {
    const ok = await confirmAction({
      title: '移除库条目',
      message: `从音乐库移除「${t.title}」？（不删除磁盘文件）`,
      confirmLabel: '移除',
      danger: true
    })
    if (!ok) return
    try {
      await window.omniget.musicLibraryRemove(t.id)
      toast('已从音乐库移除', 'success')
      if (playingId === t.id) {
        audioRef.current?.pause()
        setPlayingId(null)
      }
      await load()
    } catch (err) {
      toastError('移除失败', err)
    }
  }

  const total = tracks.length

  return (
    <main className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[900px] px-6 py-6">
        {/* ── 顶部：统计 + 检索 + 刷新 ─────────────────────────────── */}
        <div className="mb-4 flex items-center gap-3">
          <div className="flex items-center gap-2 text-sm text-text-1">
            <MusicNote size={16} className="text-accent" />
            音乐库
            <span className="num text-xs text-text-3">{total} 首</span>
          </div>
          <div className="ml-auto flex w-[300px] items-center gap-2">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="检索歌手 / 专辑 / 曲名"
              lead={<MagnifyingGlass size={14} />}
              className="flex-1"
            />
            <Button variant="outline" icon={<ArrowsClockwise size={14} />} onClick={() => void load()} title="刷新">
              刷新
            </Button>
          </div>
        </div>

        {loading && (
          <div className="space-y-2 py-6">
            {Array.from({ length: 5 }, (_, i) => (
              <div key={i} className="skeleton-line h-10 rounded-ctl" />
            ))}
          </div>
        )}

        {!loading && total === 0 && (
          <div className="rounded-panel border border-border px-6 py-14 text-center text-sm text-text-3">
            音乐库还是空的——下载完成的音乐会自动登记到这里
            <br />
            <span className="text-xs">
              按歌手/专辑分组浏览；配合设置 → 模板的归档命名（artist/album 目录）效果最佳
            </span>
          </div>
        )}

        {!loading && total > 0 && filtered.length === 0 && (
          <p className="py-10 text-center text-sm text-text-3">没有匹配「{query}」的曲目</p>
        )}

        {/* ── 分组列表：歌手 → 专辑 ─────────────────────────────────── */}
        {!loading &&
          groups.map((g) => (
            <div key={`${g.artist}/${g.album}`} className="mb-5">
              <div className="mb-1.5 flex items-baseline gap-2 border-b border-border pb-1.5">
                <span className="text-sm text-text-1">{g.artist}</span>
                <span className="text-xs text-text-3">《{g.album}》</span>
                <span className="num text-[11px] text-text-3">{g.tracks.length} 首</span>
              </div>
              {g.tracks.map((t) => {
                const playing = playingId === t.id
                return (
                  <div
                    key={t.id}
                    className="row-line group flex items-center gap-3 px-1 py-2"
                  >
                    <button
                      title={playing ? '暂停' : '播放'}
                      className={`press flex h-7 w-7 shrink-0 items-center justify-center rounded-full transition-colors ${
                        playing ? 'bg-accent text-white' : 'bg-surface-2 text-text-3 hover:text-text-1'
                      }`}
                      onClick={() => togglePlay(t)}
                    >
                      {playing ? <Pause size={13} weight="fill" /> : <Play size={13} weight="fill" />}
                    </button>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm text-text-1">{t.title}</div>
                      <div className="mt-0.5 flex items-center gap-2 text-[11px] text-text-3">
                        <span className="uppercase">{t.quality ?? '—'}</span>
                        <span className="num">{formatSize(t.size)}</span>
                        {(t.lrcPath ?? '') === '' && (
                          <span className="flex items-center gap-0.5 text-warning">
                            <Warning size={11} /> 无歌词
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <button
                        title="MusicBrainz 补标签"
                        disabled={retagging === t.id}
                        className="press flex h-6 w-6 items-center justify-center rounded text-text-3 transition-colors hover:bg-surface-2 hover:text-text-1 disabled:opacity-50"
                        onClick={() => void retag(t)}
                      >
                        <ArrowsClockwise size={13} className={retagging === t.id ? 'animate-spin' : ''} />
                      </button>
                      <button
                        title="打开所在目录"
                        className="press flex h-6 w-6 items-center justify-center rounded text-text-3 transition-colors hover:bg-surface-2 hover:text-text-1"
                        onClick={() => void reveal(t)}
                      >
                        <FolderOpen size={13} />
                      </button>
                      <button
                        title="从音乐库移除（不删文件）"
                        className="press flex h-6 w-6 items-center justify-center rounded text-text-3 transition-colors hover:bg-surface-2 hover:text-danger"
                        onClick={() => void removeTrack(t)}
                      >
                        <Trash size={13} />
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          ))}
      </div>
    </main>
  )
}
