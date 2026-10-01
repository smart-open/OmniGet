// 多区域剪辑编辑器 v2：波形可视化（WebAudio 解码）+ 全拖拽时间轴
// - 拖选波形创建剪辑区域；拖区域边缘微调；点播放头/波形拖动跳播
// - 视频模式上方保留画面预览，音画同步（同一 media 元素驱动）
// - 区域列表逐条试听/删除；输出方式：多段任务 / 合并单文件（region-concat）
import { useCallback, useEffect, useRef, useState } from 'react'
import { Pause, Play, Scissors, X } from '@phosphor-icons/react'
import { PREVIEW_SCHEME } from '@shared/types'
import { Button } from '../../components/ui'

export interface ClipRegion {
  start: number
  end: number
}

const MIN_REGION_SEC = 0.5
const EDGE_PX = 7 // 区域边缘手柄命中半径（px）
const PEAKS_N = 1200

function fmt(t: number): string {
  if (!Number.isFinite(t) || t < 0) return '0:00.0'
  const m = Math.floor(t / 60)
  const s = t - m * 60
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(1)}`
}

function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || fallback
}

type DragKind = 'seek' | 'create' | 'resize-s' | 'resize-e'

interface DragState {
  kind: DragKind
  idx?: number
  anchor: number
  orig?: ClipRegion
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
  /** merged=true：多区域合并为单一输出（单命令 filter_complex）；false：逐区域建任务 */
  onSubmit: (regions: ClipRegion[], merged: boolean) => void
}) {
  const mediaRef = useRef<HTMLVideoElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const peaksRef = useRef<Float32Array | null>(null)
  const dragRef = useRef<DragState | null>(null)

  const [duration, setDuration] = useState(0)
  const [cur, setCur] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [regions, setRegions] = useState<ClipRegion[]>([])
  const [activeIdx, setActiveIdx] = useState<number | null>(null)
  const [draft, setDraft] = useState<ClipRegion | null>(null)
  const [mediaErr, setMediaErr] = useState('')
  const [waveErr, setWaveErr] = useState(false)
  const [hasWave, setHasWave] = useState(false)
  const [volume, setVolume] = useState(1)
  // T6：输出方式（多段任务 / 合并单文件）
  const [outMode, setOutMode] = useState<'split' | 'merged'>('split')

  const previewUrl = source ? `${PREVIEW_SCHEME}://local/${encodeURIComponent(source)}` : ''

  // ── 波形解码（fetch 经特权协议 + decodeAudioData；失败降级为纯时间轴）──
  useEffect(() => {
    let cancelled = false
    peaksRef.current = null
    setHasWave(false)
    setWaveErr(false)
    if (!previewUrl) return
    void (async () => {
      try {
        const res = await fetch(previewUrl)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const buf = await res.arrayBuffer()
        const Ctx: typeof AudioContext =
          window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
        const ctx = new Ctx()
        try {
          const audio = await ctx.decodeAudioData(buf)
          const ch = audio.getChannelData(0)
          const peaks = new Float32Array(PEAKS_N)
          const step = Math.max(1, Math.floor(ch.length / PEAKS_N))
          for (let i = 0; i < PEAKS_N; i++) {
            let max = 0
            const s = i * step
            const e = Math.min(ch.length, s + step)
            for (let j = s; j < e; j += 8) {
              const v = Math.abs(ch[j] ?? 0)
              if (v > max) max = v
            }
            peaks[i] = max
          }
          if (cancelled) return
          peaksRef.current = peaks
          setHasWave(true)
          const dur = audio.duration
          // 流式容器（部分 webm/mkv）duration 为 Infinity，必须拦下，否则 draw() 刻度循环死循环
          setDuration((d) => d || (Number.isFinite(dur) ? dur : 0))
        } finally {
          // decode 失败也要释放（浏览器对 AudioContext 实例数有上限）
          void ctx.close()
        }
      } catch {
        if (!cancelled) setWaveErr(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [previewUrl])

  // ── 画布绘制 ─────────────────────────────────────────────────────
  const draw = useCallback(() => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap || !Number.isFinite(duration) || duration <= 0) return
    const dpr = window.devicePixelRatio || 1
    const w = wrap.clientWidth
    const h = wrap.clientHeight
    if (w === 0) return
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.scale(dpr, dpr)

    const accent = cssVar('--accent', '#e0a030')
    const played = cssVar('--text-1', '#ddd')
    const rest = cssVar('--text-3', '#666')
    const xOf = (t: number): number => (t / duration) * w

    ctx.clearRect(0, 0, w, h)

    // 波形（无峰值数据时画中线上下浅带）
    const peaks = peaksRef.current
    const mid = h / 2
    for (let x = 0; x < w; x++) {
      const t = (x / w) * duration
      let amp: number
      if (peaks) {
        amp = peaks[Math.min(PEAKS_N - 1, Math.floor((x / w) * PEAKS_N))] ?? 0
      } else {
        amp = 0.035
      }
      const barH = Math.max(1, amp * (h - 8))
      ctx.fillStyle = t <= cur ? accent : rest
      ctx.globalAlpha = peaks ? 1 : 0.6
      ctx.fillRect(x, mid - barH / 2, 1, barH)
      if (!peaks) {
        ctx.globalAlpha = 0.25
        ctx.fillStyle = played
        ctx.fillRect(x, mid - barH / 2, 1, 1)
        ctx.fillRect(x, mid + barH / 2 - 1, 1, 1)
      }
    }
    ctx.globalAlpha = 1

    // 时间刻度
    const niceSteps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600]
    const stepSec = niceSteps.find((s) => duration / s <= 10) ?? 900
    ctx.fillStyle = rest
    ctx.font = '10px ui-monospace, monospace'
    ctx.textBaseline = 'top'
    for (let t = 0; t <= duration; t += stepSec) {
      const x = xOf(t)
      ctx.globalAlpha = 0.5
      ctx.fillRect(x, h - 5, 1, 5)
      ctx.globalAlpha = 1
      if (x < w - 26) ctx.fillText(fmt(t), x + 3, h - 14)
    }

    // 区域叠加层（含拖选草稿）
    const paintRegion = (r: ClipRegion, active: boolean, isDraft: boolean): void => {
      const x0 = xOf(r.start)
      const x1 = xOf(r.end)
      ctx.fillStyle = isDraft ? cssVar('--warning', '#e0b040') : accent
      ctx.globalAlpha = active ? 0.28 : 0.16
      ctx.fillRect(x0, 0, Math.max(2, x1 - x0), h)
      ctx.globalAlpha = 1
      ctx.fillRect(x0, 0, 2, h)
      ctx.fillRect(x1 - 2, 0, 2, h)
      // 边缘手柄
      ctx.fillStyle = isDraft ? cssVar('--warning', '#e0b040') : accent
      ctx.fillRect(x0 - 1, mid - 9, 4, 18)
      ctx.fillRect(x1 - 3, mid - 9, 4, 18)
    }
    regions.forEach((r, i) => paintRegion(r, activeIdx === i, false))
    if (draft) paintRegion(draft, true, true)

    // 播放头
    ctx.fillStyle = played
    ctx.fillRect(xOf(cur) - 0.5, 0, 1.5, h)
    ctx.beginPath()
    ctx.moveTo(xOf(cur) - 4, 0)
    ctx.lineTo(xOf(cur) + 4, 0)
    ctx.lineTo(xOf(cur), 6)
    ctx.closePath()
    ctx.fill()
  }, [duration, cur, regions, draft, activeIdx])

  useEffect(() => {
    draw()
  }, [draw])

  // ResizeObserver 常驻（经 ref 读取最新 draw）——原实现依赖 [draw]，cur 每 250ms
  // 变化一次会导致 observer 每帧 disconnect/observe，纯浪费
  const drawRef = useRef(draw)
  useEffect(() => {
    drawRef.current = draw
  }, [draw])
  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return
    const ro = new ResizeObserver(() => drawRef.current())
    ro.observe(wrap)
    return () => ro.disconnect()
  }, [])

  // ── 播放控制 ─────────────────────────────────────────────────────
  function togglePlay(): void {
    const m = mediaRef.current
    if (!m) return
    if (m.paused) void m.play().catch(() => setMediaErr('播放失败：媒体可能已不可用'))
    else m.pause()
  }

  function seek(t: number): void {
    const m = mediaRef.current
    if (!m || !Number.isFinite(duration)) return
    m.currentTime = Math.min(Math.max(0, t), duration)
    setCur(m.currentTime)
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
    void m.play().catch(() => setMediaErr('播放失败：媒体可能已不可用'))
  }

  useEffect(() => {
    const m = mediaRef.current
    if (m) m.volume = volume
  }, [volume])

  // ── 拖拽交互（pointer events，setPointerCapture 保证拖出画布仍连续）──
  function xToTime(clientX: number): number {
    const wrap = wrapRef.current
    if (!wrap || duration <= 0) return 0
    const rect = wrap.getBoundingClientRect()
    return Math.min(duration, Math.max(0, ((clientX - rect.left) / rect.width) * duration))
  }

  function hitTest(t: number, clientX: number): DragState {
    const wrap = wrapRef.current
    if (wrap) {
      const rect = wrap.getBoundingClientRect()
      const x = clientX - rect.left
      for (let i = 0; i < regions.length; i++) {
        const r = regions[i]
        if (!r) continue
        if (Math.abs(x - (r.start / duration) * rect.width) <= EDGE_PX) {
          return { kind: 'resize-s', idx: i, anchor: t, orig: r }
        }
        if (Math.abs(x - (r.end / duration) * rect.width) <= EDGE_PX) {
          return { kind: 'resize-e', idx: i, anchor: t, orig: r }
        }
      }
    }
    return { kind: 'create', anchor: t }
  }

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>): void {
    if (duration <= 0) return
    const t = xToTime(e.clientX)
    const st = hitTest(t, e.clientX)
    dragRef.current = st
    e.currentTarget.setPointerCapture(e.pointerId)
    if (st.kind === 'create') seek(t) // 点按即跳播；拖动则形成选区
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>): void {
    const st = dragRef.current
    if (!st || duration <= 0) return
    const t = xToTime(e.clientX)
    if (st.kind === 'create') {
      setDraft({ start: Math.min(st.anchor, t), end: Math.max(st.anchor, t) })
    } else if (st.kind === 'resize-s' && st.idx !== undefined) {
      const r = regions[st.idx]
      if (r) {
        setRegions((prev) =>
          prev.map((x, i) => (i === st.idx ? { ...x, start: Math.min(t, x.end - MIN_REGION_SEC) } : x))
        )
      }
    } else if (st.kind === 'resize-e' && st.idx !== undefined) {
      const r = regions[st.idx]
      if (r) {
        setRegions((prev) =>
          prev.map((x, i) => (i === st.idx ? { ...x, end: Math.max(t, x.start + MIN_REGION_SEC) } : x))
        )
      }
    }
  }

  function onPointerUp(e: React.PointerEvent<HTMLDivElement>): void {
    const st = dragRef.current
    dragRef.current = null
    if (!st || duration <= 0) return
    if (st.kind === 'create') {
      const t = xToTime(e.clientX)
      const r = draft ?? { start: Math.min(st.anchor, t), end: Math.max(st.anchor, t) }
      setDraft(null)
      if (r.end - r.start >= MIN_REGION_SEC) {
        setRegions((prev) => [...prev, r].sort((a, b) => a.start - b.start))
        setMediaErr('')
      }
      seek(t)
    } else if (st.kind === 'resize-s' || st.kind === 'resize-e') {
      setActiveIdx(null)
    }
  }

  function removeRegion(idx: number): void {
    setRegions((prev) => prev.filter((_, i) => i !== idx))
    if (activeIdx === idx) setActiveIdx(null)
  }

  return (
    <div className="rounded-panel border border-border bg-surface-2/40 p-3">
      {/* 视频画面预览（音频模式不显示） */}
      {kind === 'video' && (
        <video
          ref={mediaRef}
          src={previewUrl}
          onTimeUpdate={onTimeUpdate}
          onLoadedMetadata={(e) => {
  // Infinity（流式容器）与 NaN 一律归 0，防止 draw() 死循环
  const d = e.currentTarget.duration
  setDuration(Number.isFinite(d) ? d : 0)
}}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onError={() =>
            setMediaErr('媒体加载失败：文件可能已被移动、删除，或格式不受支持')
          }
          className="mb-3 max-h-64 w-full rounded-ctl bg-black"
        />
      )}
      {kind === 'audio' && (
        <audio
          ref={mediaRef as unknown as React.Ref<HTMLAudioElement>}
          src={previewUrl}
          onTimeUpdate={onTimeUpdate}
          onLoadedMetadata={(e) => {
  // Infinity（流式容器）与 NaN 一律归 0，防止 draw() 死循环
  const d = e.currentTarget.duration
  setDuration(Number.isFinite(d) ? d : 0)
}}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onError={() =>
            setMediaErr('媒体加载失败：文件可能已被移动、删除，或格式不受支持')
          }
          className="hidden"
        />
      )}

      {/* 波形 / 时间轴（拖选创建区域 · 拖边缘微调 · 拖播放头跳播） */}
      <div
        ref={wrapRef}
        className="relative h-24 w-full cursor-crosshair touch-none select-none overflow-hidden rounded-ctl bg-black/60"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
        {duration <= 0 && !mediaErr && (
          <div className="absolute inset-0 flex items-center justify-center text-xs text-text-3">
            正在解析媒体…
          </div>
        )}
      </div>
      {mediaErr && <p className="mt-2 text-[11px] text-danger">{mediaErr}</p>}
      {duration > 0 && !hasWave && !waveErr && (
        <p className="mt-1 text-[10px] text-text-3">波形解析中，可先直接拖选时间轴…</p>
      )}
      {waveErr && (
        <p className="mt-1 text-[10px] text-text-3">
          波形解析失败（格式受限），已降级为时间轴模式，拖选功能不受影响
        </p>
      )}

      {/* 播放控制条 */}
      <div className="mt-2 flex items-center gap-3">
        <Button
          size="sm"
          variant="outline"
          onClick={togglePlay}
          className="w-16"
          title="播放 / 暂停（空格）"
        >
          {playing ? <Pause size={13} weight="fill" /> : <Play size={13} weight="fill" />}
          {playing ? '暂停' : '播放'}
        </Button>
        <span className="num text-xs text-text-2">
          {fmt(cur)} <span className="text-text-3">/ {fmt(duration)}</span>
        </span>
        <label className="ml-auto flex items-center gap-1.5 text-[10px] text-text-3">
          音量
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={volume}
            onChange={(e) => setVolume(Number(e.target.value))}
            className="w-24 accent-[var(--accent)]"
          />
        </label>
      </div>

      {/* 区域列表 */}
      {regions.length > 0 && (
        <div className="mt-2 space-y-1">
          {regions.map((r, i) => (
            <div
              key={i}
              className={`flex items-center gap-2 rounded-ctl px-2.5 py-1.5 text-xs ${
                activeIdx === i ? 'bg-accent-soft' : 'bg-surface'
              }`}
            >
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
        </div>
      )}

      {/* 输出方式 + 提交 */}
      {regions.length > 0 && (
        <>
          <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px] text-text-2">
            <span className="text-text-3">输出方式</span>
            <label className="flex cursor-pointer items-center gap-1.5">
              <input
                type="radio"
                checked={outMode === 'split'}
                onChange={() => setOutMode('split')}
              />
              多段输出（每区域一个任务）
            </label>
            <label className="flex cursor-pointer items-center gap-1.5">
              <input
                type="radio"
                checked={outMode === 'merged'}
                onChange={() => setOutMode('merged')}
              />
              合并为单个文件（无缝拼接）
            </label>
          </div>
          <Button
            size="sm"
            className="mt-1 w-full"
            disabled={busy}
            onClick={() => onSubmit(regions, outMode === 'merged')}
            icon={<Scissors size={13} />}
          >
            {busy
              ? '提交中…'
              : outMode === 'merged'
                ? `合并 ${regions.length} 个区域为单个文件`
                : `提交 ${regions.length} 个剪辑区域`}
          </Button>
        </>
      )}
      {regions.length === 0 && (
        <p className="mt-2 text-center text-[11px] text-text-3">
          在上方波形 / 时间轴上<b className="text-text-2">拖选</b>即可创建剪辑区域，拖动区域边缘可微调
        </p>
      )}
    </div>
  )
}
