// 音乐工作台（M2-7/M2-8，§7.6）
// 搜索（自然语言同源解析）→ 候选行（平台徽标/原唱风险/原版度）→ 音质单选 → 下载。
// 降级黄条（§4.4：降级必须告警）+ 批量导入（多行文本）。

import { useEffect, useRef, useState } from 'react'
import {
  ArrowDown,
  CheckCircle,
  DownloadSimple,
  ListChecks,
  MagnifyingGlass,
  PlayCircle,
  PauseCircle,
  Warning
} from '@phosphor-icons/react'
import type { MusicCandidate, MusicSearchResult } from '@shared/types'
import { Button, Input } from '../../components/ui'
import { toast, toastError } from '../../lib/feedback'

const QUALITY_LABELS: Record<string, string> = {
  standard: '标准 128k',
  high: '高品 320k',
  lossless: '无损 FLAC'
}

export function MusicWorkbench({ onOpenTasks }: { onOpenTasks: () => void }) {
  const [q, setQ] = useState('')
  const [searching, setSearching] = useState(false)
  const [result, setResult] = useState<MusicSearchResult | null>(null)
  const [searchError, setSearchError] = useState('')
  const [quality, setQuality] = useState<'standard' | 'high' | 'lossless'>('high')
  const [posting, setPosting] = useState<Set<string>>(new Set())
  const [batchOpen, setBatchOpen] = useState(false)
  const [batchText, setBatchText] = useState('')
  const [batchInfo, setBatchInfo] = useState('')
  const [batchBusy, setBatchBusy] = useState(false)
  const [idBusy, setIdBusy] = useState(false)
  /** F1：试听状态（单实例 Audio）与 ID 精确下载入口 */
  const [playingId, setPlayingId] = useState<string | null>(null)
  const [idOpen, setIdOpen] = useState(false)
  const [idValue, setIdValue] = useState('')
  const [idArtist, setIdArtist] = useState('')
  const [idSong, setIdSong] = useState('')
  const audioRef = useRef<HTMLAudioElement | null>(null)
  /** P2 修复：试听竞态守卫——await 期间再点别处时，过期回调用序号自弃 */
  const previewSeq = useRef(0)

  // P2 修复：离开音乐页时停止试听（此前 Audio 随页面卸载继续播放且无法控制）
  useEffect(() => {
    return () => {
      previewSeq.current++
      audioRef.current?.pause()
      audioRef.current = null
    }
  }, [])

  async function doSearch(): Promise<void> {
    if (!q.trim()) return
    setSearching(true)
    setSearchError('')
    try {
      setResult(await window.omniget.musicSearch({ q: q.trim() }))
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : String(err))
      setResult(null)
    } finally {
      setSearching(false)
    }
  }

  async function download(c: MusicCandidate): Promise<void> {
    const key = `${c.platform}:${c.id}`
    setPosting((prev) => new Set(prev).add(key))
    try {
      const artist = result?.parsed.artist || c.artist.split(',')[0]
      await window.omniget.musicDownload({
        artist,
        song: c.name,
        quality,
        saveDir: await window.omniget.defaultSaveDir().catch(() => undefined)
      })
      // P1 修复：成功提示必须在 await 成功之后——此前在 try/catch 之后无条件执行，
      // 失败时同时出现黄条 + 绿色"已加入队列"假成功
      toast(`「${c.name}」已加入下载队列`, 'success')
    } catch (err) {
      toastError('加入下载队列', err)
    } finally {
      setPosting((prev) => {
        const next = new Set(prev)
        next.delete(key)
        return next
      })
    }
  }

  /** F1 试听：经主进程 omniget-preview:// 协议代理的预览流（符合 CSP media-src） */
  async function togglePreview(c: MusicCandidate): Promise<void> {
    const key = `${c.platform}:${c.id}`
    if (playingId === key) {
      audioRef.current?.pause()
      setPlayingId(null)
      return
    }
    const seq = ++previewSeq.current
    audioRef.current?.pause()
    setPlayingId(null)
    const url = await window.omniget.musicPreview(c.platform, c.id).catch(() => '')
    if (seq !== previewSeq.current) return // P2 修复：等待期间用户已点开其他候选
    if (!url) {
      toast('该平台暂不支持试听', 'warning')
      return
    }
    const audio = new Audio(url)
    audioRef.current = audio
    audio.onended = () => setPlayingId(null)
    audio.onerror = () => {
      setPlayingId(null)
      toast('试听加载失败（镜像可能已失效）', 'warning')
    }
    void audio.play()
    setPlayingId(key)
  }

  /** F1：用 ID 精确下载（§4.4 兜底通道） */
  async function downloadById(): Promise<void> {
    const id = idValue.trim()
    if (!id || idBusy) return
    setIdBusy(true)
    try {
      await window.omniget.musicDownload({
        neteaseId: id,
        artist: idArtist.trim() || undefined,
        song: idSong.trim() || undefined,
        quality,
        saveDir: await window.omniget.defaultSaveDir().catch(() => undefined)
      })
      setIdValue('')
      toast('歌曲已加入下载队列', 'success')
    } catch (err) {
      toastError('ID 精确下载', err)
    } finally {
      setIdBusy(false)
    }
  }

  /** M2-8 批量导入：多行文本逐行入队（服务端同源解析） */
  async function batchImport(): Promise<void> {
    if (batchBusy) return // P2 修复：无防重入，连点会重复入队
    const lines = batchText
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
    if (lines.length === 0) return
    setBatchBusy(true)
    setBatchInfo(`入队中 0/${lines.length}`)
    let done = 0
    let failed = 0
    for (const line of lines) {
      try {
        await window.omniget.musicDownload({
          q: line,
          quality,
          saveDir: await window.omniget.defaultSaveDir().catch(() => undefined)
        })
      } catch {
        failed++ // 单行失败不阻断批量
      }
      done++
      setBatchInfo(`入队中 ${done}/${lines.length}`)
    }
    setBatchBusy(false)
    if (failed > 0) {
      toast(`批量入队：成功 ${done - failed} 个，失败 ${failed} 个（无法解析或平台不支持）`, 'warning')
    }
    setBatchInfo(
      failed > 0
        ? `已入队 ${done - failed}/${done} 个任务，${failed} 个失败`
        : `已入队 ${done} 个任务，可在任务列表观察进度`
    )
    setTimeout(() => setBatchInfo(''), 4000)
  }

  const degradedSearch = result?.degraded.length ?? 0

  return (
    <main className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[860px] px-6 py-6">
        {/* ── 搜索区 ──────────────────────────────────────────────── */}
        <div className="mb-1 flex gap-2">
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !searching && void doSearch()}
            placeholder='搜索：陈奕迅的孤勇者 / "陈奕迅,孤勇者"'
            lead={<MagnifyingGlass size={14} />}
            className="flex-1"
          />
          <Button onClick={() => void doSearch()} disabled={searching}>
            {searching ? '搜索中…' : '搜索'}
          </Button>
          <Button
            variant="outline"
            icon={<ListChecks size={14} />}
            onClick={() => setBatchOpen((v) => !v)}
            title="批量导入"
          >
            批量
          </Button>
        </div>
        <p className="mt-1.5 text-[11px] text-text-3">
          支持自然语言："陈奕迅的孤勇者" / "陈奕迅,孤勇者"；五平台回退链，降级时黄色告警
        </p>

        {/* ── 降级黄条（§4.4）─────────────────────────────────────── */}
        {degradedSearch > 0 && (
          <div className="mt-3 flex items-start gap-2 rounded-ctl border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
            <Warning size={14} className="mt-px shrink-0" />
            <span>
              搜索接口降级中（{result?.degraded.map(labelOf).join('、')}）→ 建议用歌曲 ID
              精确下载，或稍后重试
            </span>
          </div>
        )}
        {searchError && <p className="mt-3 text-xs text-danger">{searchError}</p>}

        {/* ── 批量导入（M2-8）────────────────────────────────────── */}
        {batchOpen && (
          <div className="mt-4 rounded-panel border border-border p-4">
            <p className="mb-2 text-xs text-text-2">
              每行一首（沿用脚本解析格式：`歌手 歌名` / `歌手的歌名`），批量入队后进度在任务列表观察
            </p>
            <textarea
              value={batchText}
              onChange={(e) => setBatchText(e.target.value)}
              rows={5}
              placeholder={'陈奕迅 孤勇者\n周杰伦 晴天\n孙燕姿的遇见'}
              className="w-full rounded-ctl border border-border bg-surface-2 px-3 py-2 text-xs outline-none placeholder:text-text-3 focus:border-accent"
            />
            <div className="mt-2 flex items-center justify-between">
              <span className="num text-[11px] text-text-3">{batchInfo}</span>
              <Button
                size="sm"
                icon={<DownloadSimple size={13} />}
                disabled={batchBusy || !batchText.trim()}
                onClick={() => void batchImport()}
              >
                {batchBusy ? '入队中…' : '批量入队'}
              </Button>
            </div>
          </div>
        )}

        {/* ── 音质单选 + ID 精确下载入口（§7.6）───────────────────── */}
        <div className="mt-4 border-b border-border pb-3">
          <div className="flex items-center gap-4">
            <span className="text-xs text-text-2">音质</span>
            {(Object.keys(QUALITY_LABELS) as Array<'standard' | 'high' | 'lossless'>).map((k) => (
              <label key={k} className="flex cursor-pointer items-center gap-1.5 text-xs">
                <input
                  type="radio"
                  name="quality"
                  checked={quality === k}
                  onChange={() => setQuality(k)}
                />
                <span className={quality === k ? 'text-text-1' : 'text-text-3'}>
                  {QUALITY_LABELS[k]}
                </span>
              </label>
            ))}
            <button
              className="press ml-auto text-[11px] text-text-3 transition-colors hover:text-text-1"
              onClick={() => setIdOpen((v) => !v)}
            >
              用 ID 精确下载
            </button>
          </div>
          {idOpen && (
            <div className="mt-2 flex items-center gap-2">
              <input
                value={idValue}
                onChange={(e) => setIdValue(e.target.value)}
                placeholder="网易云歌曲 ID（降级兜底通道）"
                className="num h-7 w-44 rounded-ctl border border-border bg-surface-2 px-2 text-xs outline-none focus:border-accent"
              />
              <input
                value={idArtist}
                onChange={(e) => setIdArtist(e.target.value)}
                placeholder="歌手（可选）"
                className="h-7 w-28 rounded-ctl border border-border bg-surface-2 px-2 text-xs outline-none focus:border-accent"
              />
              <input
                value={idSong}
                onChange={(e) => setIdSong(e.target.value)}
                placeholder="歌名（可选）"
                className="h-7 w-32 rounded-ctl border border-border bg-surface-2 px-2 text-xs outline-none focus:border-accent"
              />
              <Button
                size="xs"
                onClick={() => void downloadById()}
                disabled={!idValue.trim() || idBusy}
              >
                {idBusy ? '入队中…' : '入队'}
              </Button>
            </div>
          )}
        </div>

        {/* ── 候选行（§7.6）──────────────────────────────────────── */}
        {searching && (
          <div className="space-y-2 py-6">
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="skeleton-line h-10 rounded-ctl" />
            ))}
          </div>
        )}

        {!searching && result && result.candidates.length === 0 && (
          <p className="py-10 text-center text-sm text-text-3">未搜索到候选，请更换关键词</p>
        )}

        {!searching &&
          result?.candidates.map((c, i) => {
            const key = `${c.platform}:${c.id}`
            const risk = !c.artistMatch || c.originality < 80
            return (
              <div
                key={key}
                className="row-line group flex items-center gap-3 px-1 py-2.5"
                style={{ animationDelay: `${Math.min(i, 10) * 40}ms` }}
              >
                {/* 原唱校验状态 */}
                {c.artistMatch ? (
                  <CheckCircle size={15} weight="fill" className="shrink-0 text-success" />
                ) : (
                  <Warning size={15} weight="fill" className="shrink-0 text-warning" />
                )}

                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm">{c.name}</span>
                    {risk && (
                      <span className="shrink-0 rounded border border-warning/50 px-1 py-px text-[9px] text-warning">
                        翻唱风险
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 text-[11px] text-text-3">
                    <span className="rounded border border-border px-1 py-px uppercase">
                      {c.platformLabel}
                    </span>
                    <span className="truncate">{c.artist}</span>
                    {c.originality < 100 && (
                      <span className="num">原版度 {c.originality}</span>
                    )}
                  </div>
                </div>

                <div className="flex shrink-0 items-center gap-1">
                  {/* F1 试听（仅网易云候选） */}
                  {c.platform === 'netease' && (
                    <button
                      title={playingId === key ? '停止试听' : '试听'}
                      className={`press flex h-6 w-6 items-center justify-center rounded transition-colors ${
                        playingId === key
                          ? 'text-accent'
                          : 'text-text-3 hover:bg-surface-2 hover:text-text-1'
                      }`}
                      onClick={() => togglePreview(c)}
                    >
                      {playingId === key ? (
                        <PauseCircle size={15} weight="fill" />
                      ) : (
                        <PlayCircle size={15} />
                      )}
                    </button>
                  )}
                  <Button
                    size="sm"
                    variant={c.artistMatch ? 'primary' : 'outline'}
                    icon={<DownloadSimple size={13} />}
                    disabled={posting.has(key)}
                    onClick={() => void download(c)}
                  >
                    {posting.has(key) ? '入队中' : '下载'}
                  </Button>
                </div>
              </div>
            )
          })}

        {/* 已入队提示 */}
        {(result?.candidates.length ?? 0) > 0 && (
          <div className="mt-4 flex items-center gap-2 text-xs text-text-3">
            <ArrowDown size={12} />
            已入队任务在任务列表中查看
            <button className="text-accent hover:underline" onClick={onOpenTasks}>
              前往列表
            </button>
          </div>
        )}
      </div>
    </main>
  )
}

function labelOf(platform: string): string {
  const map: Record<string, string> = {
    netease: '网易云',
    qq: 'QQ 音乐',
    kugou: '酷狗',
    migu: '咪咕',
    soda: '汽水'
  }
  return map[platform] ?? platform
}
