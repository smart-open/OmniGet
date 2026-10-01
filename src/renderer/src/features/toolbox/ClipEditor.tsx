// 多区域剪辑编辑器：本地媒体试听（omniget-preview://local，Range 拖动）
// + 时间轴可视化 + A/B 标记出多个剪辑区域，提交时逐区域建任务（独立 2 并发队列）。
import { useRef, useState } from 'react'
import { Pause, Play, Plus, X } from '@phosphor-icons/react'
import { PREVIEW_SCHEME } from '@shared/types'
import { Button } from '../../components/ui'

export interface ClipRegion {
  start: number
  end: number
}

const MIN_REGION_SEC = 0.5

function fmt(t: number): string {
  if (!Number.isFinite(t) || t < 0) return '0:00.0'
  const m = Math.floor(t / 60)
  const s = t - m * 60
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(1)}`
}

export function ClipEditor({
  source,
  kind,
  busy,
  onSubmit
}: {
  source: string
  kind: 'audio' | 'video'
  busy?: boolean
  onSubmit: (regions: ClipRegion[]) => void
}) {
  const mediaRef = useRef<HTMLVideoElement | null>(null)
  const [duration, setDuration] = useState(0)
  const [cur, setCur] = useState(0)
  const [markerA, setMarkerA] = useState<number | null>(null)
  const [regions, setRegions] = useState<ClipRegion[]>([])
  const [activeIdx, setActiveIdx] = useState<number | null>(null)
  const [mediaErr, setMediaErr] = useState('')
  const [hint, setHint] = useState('')

  const previewUrl = source ? `${PREVIEW_SCHEME}://local/${encodeURIComponent(source)}` : ''

  function seek(t: number): void {
    const m = mediaRef.current
    if (!m || !Number.isFinite(duration)) return
    m.currentTime = Math.min(Math.max(0, t), duration)
  }

  function onTimeUpdate(): void {
    const m = mediaRef.current
    if (!m) return
    setCur(m.currentTime)
    // 区域试听：播放到区域终点自动暂停
    if (activeIdx !== null) {
      const r = regions[activeIdx]
      if (r && m.currentTime >= r.end - 0.05) {
        m.pause()
        setActiveIdx(null)
      }
    }
  }

  function playRegion(idx: number): void {
    const m = mediaRef.current
    const r = regions[idx]
    if (!m || !r) return
    m.currentTime = r.start
    setActiveIdx(idx)
    void m.play().catch(() => setHint('播放失败：媒体可能已不可用'))
  }

  function addRegion(): void {
    const start = markerA ?? 0
    const end = cur
    if (end - start < MIN_REGION_SEC) {
      setHint(`区间过短（至少 ${MIN_REGION_SEC}s）：先「设为起点」，播放到终点再「添加区域」`)
      return
    }
    setRegions((prev) =>
      [...prev, { start, end }].sort((a, b) => a.start - b.start)
    )
    setMarkerA(null)
    setHint('')
  }

  function removeRegion(idx: number): void {
    setRegions((prev) => prev.filter((_, i) => i !== idx))
    if (activeIdx === idx) setActiveIdx(null)
  }

  function seekFromTrack(e: React.MouseEvent<HTMLDivElement>): void {
    if (duration <= 0) return
    const rect = e.currentTarget.getBoundingClientRect()
    seek(((e.clientX - rect.left) / rect.width) * duration)
  }

  return (
    <div className="rounded-panel border border-border bg-surface-2/40 p-3">
      {/* 预览播放器（video 元素播纯音频同样可用；native controls 负责播放/暂停/音量） */}
      {kind === 'video' ? (
        <video
          ref={mediaRef}
          src={previewUrl}
          controls
          onTimeUpdate={onTimeUpdate}
          onLoadedMetadata={(e) => setDuration(e.currentTarget.duration || 0)}
          onError={() => setMediaErr('媒体加载失败：文件可能已被移动、删除，或格式不受支持')}
          className="max-h-64 w-full rounded-ctl bg-black"
        />
      ) : (
        <div className="rounded-ctl bg-black/80 px-3 py-2">
          <audio
            ref={mediaRef as unknown as React.Ref<HTMLAudioElement>}
            src={previewUrl}
            controls
            onTimeUpdate={onTimeUpdate}
            onLoadedMetadata={(e) => setDuration(e.currentTarget.duration || 0)}
            onError={() => setMediaErr('媒体加载失败：文件可能已被移动、删除，或格式不受支持')}
            className="w-full"
          />
        </div>
      )}

      {mediaErr && <p className="mt-2 text-[11px] text-danger">{mediaErr}</p>}

      {/* 时间轴可视化：区域色块 + 起点标记，点击跳转 */}
      <div
        className="relative mt-3 h-4 cursor-pointer rounded-full bg-surface-2"
        onClick={seekFromTrack}
        title="点击时间轴跳转播放位置"
      >
        {duration > 0 &&
          regions.map((r, i) => (
            <div
              key={i}
              className={`absolute inset-y-0 rounded-full border border-accent/60 ${
                activeIdx === i ? 'bg-accent/50' : 'bg-accent/25'
              }`}
              style={{ left: `${(r.start / duration) * 100}%`, width: `${((r.end - r.start) / duration) * 100}%` }}
            />
          ))}
        {markerA !== null && duration > 0 && (
          <div
            className="absolute inset-y-0 w-0.5 bg-warning"
            style={{ left: `${(markerA / duration) * 100}%` }}
            title={`起点 ${fmt(markerA)}`}
          />
        )}
        {duration > 0 && (
          <div
            className="pointer-events-none absolute inset-y-0 w-px bg-text-1"
            style={{ left: `${(cur / duration) * 100}%` }}
          />
        )}
      </div>

      {/* A/B 标记 + 区域列表 */}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button
          size="xs"
          variant="outline"
          onClick={() => setMarkerA(cur)}
          title="把当前播放位置记为区域起点"
        >
          设为起点{markerA !== null ? `（${fmt(markerA)}）` : ''}
        </Button>
        <Button
          size="xs"
          variant={markerA !== null ? 'primary' : 'outline'}
          icon={<Plus size={12} weight="bold" />}
          onClick={addRegion}
          title="当前播放位置作为区域终点，与起点组成一个剪辑区域"
        >
          添加区域（终点 {fmt(cur)}）
        </Button>
        <span className="num text-[10px] text-text-3">
          总时长 {fmt(duration)} · 已标记 {regions.length} 个区域
        </span>
      </div>
      {hint && <p className="mt-1 text-[11px] text-text-3">{hint}</p>}

      {regions.length > 0 && (
        <div className="mt-2 space-y-1">
          {regions.map((r, i) => (
            <div key={i} className="flex items-center gap-2 rounded-ctl bg-surface px-2.5 py-1.5 text-xs">
              <span className="num shrink-0 text-text-3">#{i + 1}</span>
              <span className="num min-w-0 flex-1 truncate text-text-2">
                {fmt(r.start)} → {fmt(r.end)}
                <span className="ml-2 text-text-3">（{(r.end - r.start).toFixed(1)}s）</span>
              </span>
              {activeIdx === i ? (
                <button
                  className="press shrink-0 text-accent hover:text-accent-press"
                  title="停止"
                  onClick={() => {
                    mediaRef.current?.pause()
                    setActiveIdx(null)
                  }}
                >
                  <Pause size={13} weight="fill" />
                </button>
              ) : (
                <button
                  className="press shrink-0 text-text-3 hover:text-text-1"
                  title="试听该区域"
                  onClick={() => playRegion(i)}
                >
                  <Play size={13} weight="fill" />
                </button>
              )}
              <button
                className="press shrink-0 text-text-3 hover:text-danger"
                title="删除该区域"
                onClick={() => removeRegion(i)}
              >
                <X size={13} weight="bold" />
              </button>
            </div>
          ))}
          <Button
            size="sm"
            className="w-full"
            disabled={busy}
            onClick={() => onSubmit(regions)}
            icon={<Plus size={13} weight="bold" />}
          >
            {busy ? '提交中…' : `提交 ${regions.length} 个剪辑区域`}
          </Button>
        </div>
      )}
    </div>
  )
}
