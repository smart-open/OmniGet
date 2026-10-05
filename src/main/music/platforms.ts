// 五平台音乐搜索/下载引擎（batch_download_v4.py 的等价 TS 移植，§4.4）
// 平台回退链：网易云(稳健原唱校验) → QQ → 酷狗 → 咪咕 → 汽水
// 口径保持：音质映射、镜像顺序、大小校验阈值、原创度打分、歌词回退链逐项一致
// 所有网络操作接受 AbortSignal（取消语义优于 Python 版协作式取消）

import { join } from 'path'
import { randomUUID } from 'crypto'
import { mkdir, open, rename, stat, unlink, writeFile } from 'fs/promises'
import { getJson, postForm, postJson, getText, fetchToFile, downloadFile, hostOf, isTrustedAudioHost } from './http'
import { listTracks } from './library'
import { HostGate } from './gate'
import { mergeBilingualLrc, getLyricsMode } from './lyrics'
import { createLogger } from '../logger'

const log = createLogger('music.platforms')
import { sanitizeFilename } from '@shared/sanitize'

/**
 * H4 修复：第三方镜像 API 返回的直链必须落在可信音频域白名单内才允许主进程拉取。
 * 此前仅查 startsWith('http')——接口被投毒即可让主进程请求内网/云 metadata（SSRF）。
 * 下载链与试听链统一走同一白名单（原防线只覆盖试听）。
 */
function trustedAudioUrl(url: string): string | null {
  const u = (url ?? '').trim()
  if (!/^https?:\/\//i.test(u)) return null
  try {
    const host = new URL(u).hostname
    if (!isTrustedAudioHost(host)) return null
  } catch {
    return null
  }
  return u
}

export type Quality = 'standard' | 'high' | 'lossless'

// Quality mapping per platform（与 Python QUALITY_MAP 同源）
const QUALITY_MAP: Record<string, Record<Quality, string>> = {
  netease: { standard: 'standard', high: 'higher', lossless: 'lossless' },
  qq: { standard: '128', high: '320', lossless: 'm4a' },
  kugou: { standard: '3', high: '5', lossless: '6' },
  migu: { standard: 'PQ', high: 'HQ', lossless: 'SQ' },
  soda: { standard: 'standard', high: 'high', lossless: 'lossless' }
}

export const PLATFORMS = ['netease', 'qq', 'kugou', 'migu', 'soda'] as const
export type Platform = (typeof PLATFORMS)[number]

export const PLATFORM_LABELS: Record<string, string> = {
  netease: '网易云',
  qq: 'QQ 音乐',
  kugou: '酷狗',
  migu: '咪咕',
  soda: '汽水',
  cached: '缓存'
}

export interface PlatformSong {
  id: string
  name: string
  artist: string
  copyrightId?: string
  /** R6：时长毫秒（搜索列表展示；平台有值才带） */
  durationMs?: number
  /** R6：专辑名（搜索列表展示；平台有值才带） */
  album?: string
}

export interface PlatformResult {
  success: boolean
  source: string
  message: string
  mp3Path: string
  lrcPath: string
  /** 二期：专辑名（平台有值才带）——媒体服务器归档模板 {{album}} 数据源 */
  album?: string
  /** R4-P2：产物为既有文件（skip_existing 命中）——取消清理不得误删 */
  cached?: boolean
}

export interface EngineCallbacks {
  gate: HostGate
  signal?: AbortSignal
  onEvent?: (ev: { type: string; platform: string; message: string }) => void
  log?: (msg: string) => void
}

const UA = { 'User-Agent': 'Mozilla/5.0' }
const NETEASE_HEADERS = { 'User-Agent': 'Mozilla/5.0', Referer: 'https://music.163.com/' }
const EMPTY_LRC = '[00:00.000]暂无歌词\n'

// ── 工具（与 Python 静态方法同口径）────────────────────────────────

export function sanitizeName(name: string): string {
  // 复用统一清洗（保留名 CON/NUL、控制字符、尾点/空格、超长截断），额外处理路径分隔符
  return sanitizeFilename(name.replace(/[\\/]/g, '_'))
}

export function artistMatches(artistStr: string, singer: string): boolean {
  if (!artistStr || !singer) return false
  const a = String(artistStr).replace(/[\s\-–—&/、，,]/g, '').toLowerCase()
  const s = String(singer).replace(/[\s\-–—&/、，,]/g, '').toLowerCase()
  return s.length > 0 && (s.includes(a) || a.includes(s))
}

export function hasTimestamps(text: string | undefined): boolean {
  return (text?.match(/\[\d{1,2}:\d{2}/g) ?? []).length >= 3
}

export function scoreOriginality(name: string | undefined, songName: string): number {
  const n = (name ?? '').trim()
  const s = (songName ?? '').trim()
  const core = n.replace(/[（(【\[][^）)】\]]*[）)】\]]/g, '').replace(/\s+/g, '')
  let score = 0
  if (core === s || core.startsWith(s)) score += 100
  const penalty = [
    '原唱', '翻唱', 'Cover', 'cover', 'Live', 'live', 'DJ', 'dj', 'Remix', 'remix',
    '版', 'Demo', 'demo', '女生', '男生', '女声', '男声', '钢琴', '吉他', '伴奏',
    '致敬', '现场', '试听', '串烧', '慢摇', '电音', '烟嗓', '戏腔', '古风',
    '卡点', '深情', '正式', '完整', '纯音乐', 'Instrumental'
  ]
  for (const t of penalty) {
    if (n.includes(t)) score -= 30
  }
  return score
}

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
}

// 二期（0.9.x 无损档）：音频容器扩展名全集（skip_existing 多扩展名判定用）
const AUDIO_EXTS = ['.mp3', '.flac', '.m4a', '.ogg', '.wav', '.opus'] as const

/**
 * 音频文件头嗅探 → 真实容器扩展名（纯读前 12 字节，离线可靠）。
 * 此前产物统一硬编码 `.mp3`——镜像在无损档返回 flac/m4a 时扩展名与容器不符，
 * 部分播放器/媒体服务器（Navidrome 扫描）会拒收。
 */
export async function detectAudioExt(filePath: string): Promise<string | null> {
  try {
    const fh = await open(filePath, 'r')
    try {
      const buf = Buffer.alloc(12)
      const { bytesRead } = await fh.read(buf, 0, 12, 0)
      if (bytesRead < 4) return null
      const magic = (from: number, len: number): string => buf.subarray(from, from + len).toString('latin1')
      if (magic(0, 4) === 'fLaC') return '.flac'
      if (magic(4, 4) === 'ftyp') return '.m4a'
      if (magic(0, 4) === 'OggS') return '.ogg'
      if (magic(0, 4) === 'RIFF') return '.wav'
      if (magic(0, 3) === 'ID3') return '.mp3'
      // 裸 MPEG 帧头：0xFFEx 同步字
      if (buf[0] === 0xff && (buf[1]! & 0xe0) === 0xe0) return '.mp3'
      return null
    } finally {
      await fh.close()
    }
  } catch {
    return null
  }
}

/**
 * 下载产物扩展名对齐：文件头与后缀不符时改名到真实容器扩展名（lrc 主名不变）。
 * 失败（目标已存在/占用）原样返回 .mp3 路径，不影响成功语义。
 */
export async function alignAudioExt(audioPath: string): Promise<string> {
  const m = /\.\w+$/.exec(audioPath)
  const ext = m?.[0]?.toLowerCase() ?? ''
  if (!AUDIO_EXTS.includes(ext as (typeof AUDIO_EXTS)[number])) return audioPath
  const real = await detectAudioExt(audioPath)
  if (!real || real === ext) return audioPath
  const base = audioPath.slice(0, audioPath.length - ext.length)
  const target = base + real
  if (target === audioPath) return audioPath
  try {
    await rename(audioPath, target)
    log.info(`音频扩展名对齐: ${audioPath} → ${target}（文件头嗅探）`)
    return target
  } catch {
    return audioPath
  }
}

async function writeLrc(lrcPath: string, content: string): Promise<void> {
  try {
    await writeFile(lrcPath, content || EMPTY_LRC, 'utf8')
  } catch (err) {
    // M-2：歌词写盘失败（磁盘满/权限）不得让已成功下载的音频整体失败成孤儿——
    // mp3 是主产物，歌词为附属；失败留痕后按「无歌词」继续
    log.warn(`歌词写入失败（忽略，不影响音频产物）: ${lrcPath}`, err)
  }
}

// ── 五平台引擎（每次下载任务实例化一个，携带信号量与回调）──────────

export class PlatformEngine {
  constructor(private readonly cb: EngineCallbacks) {}

  /** 第七轮审查 P2：产物归属标记——「目标已存在即视为成功」的兜底路径落到的
   * mp3 可能是并发同歌任务刚产出的文件（本任务未写入任何字节）。tryAllPlatforms
   * 据此把结果标为 cached，取消清理时不得误删他人产物 */
  lastProductForeign = false

  /** 二期：本次下载命中的平台专辑名（{{album}} 归档模板数据源） */
  lastAlbum = ''

  private async gate(url: string): Promise<void> {
    const h = hostOf(url)
    if (h) await this.cb.gate.wait(h, this.cb.signal) // M-5：限速等待可被取消
  }

  // ========== 网易云（稳健：原唱校验 + 完整音频 + 时间轴歌词）==========

  async searchNetease(keyword: string, limit = 10): Promise<PlatformSong[]> {
    try {
      const url = 'https://music.163.com/api/cloudsearch/pc'
      await this.gate(url)
      const data = await postForm<{ result?: { songs?: Array<Record<string, unknown>> } }>(
        url,
        { s: keyword, type: 1, limit, offset: 0 },
        NETEASE_HEADERS,
        { signal: this.cb.signal, timeoutMs: 10_000 }
      )
      return (data.result?.songs ?? []).map((s) => {
        // R6 修复：cloudsearch/pc 新版响应歌手字段为 `ar`（旧 `artists` 已不下发，
        // 实测 2026-10-02）——原映射恒得空 artist，列表无歌手且下载侧原唱校验
        // 只能靠 song/detail 逐条补；两字段都读保持向后兼容
        const artists =
          (s.ar as Array<{ name?: string }> | undefined) ??
          (s.artists as Array<{ name?: string }> | undefined) ??
          []
        return {
          id: String(s.id),
          name: String(s.name ?? ''),
          artist: artists.map((a) => a.name ?? '').join(', '),
          // dt=时长毫秒；al.name=专辑（新版响应字段名）
          durationMs: typeof s.dt === 'number' ? s.dt : undefined,
          album: String((s.al as { name?: string } | undefined)?.name ?? '') || undefined
        }
      })
    } catch {
      return []
    }
  }

  async getNeteaseDetail(songId: string): Promise<{ name?: string; artist?: string; album?: string }> {
    try {
      const url = 'https://music.163.com/api/song/detail'
      await this.gate(url)
      const data = await postForm<{ songs?: Array<Record<string, unknown>> }>(
        url,
        { id: songId, ids: `[${songId}]` },
        NETEASE_HEADERS,
        { signal: this.cb.signal, timeoutMs: 15_000 }
      )
      const s = data.songs?.[0]
      if (!s) return {}
      return {
        name: String(s.name ?? ''),
        artist: ((s.artists as Array<{ name?: string }> | undefined) ?? [])
          .map((a) => a.name ?? '')
          .join(', '),
        album: String((s.album as { name?: string } | undefined)?.name ?? '')
      }
    } catch {
      return {}
    }
  }

  // ---- 镜像音频直链 fetcher（顺序与 Python 一致，toubiec 截断片段风险放最后）----

  private async neteaseUrlCenguigui(sid: string, level: string): Promise<string> {
    const url = `https://api-v2.cenguigui.cn/api/netease/music_v1.php?id=${sid}&type=json&level=${level}`
    await this.gate(url)
    const d = await getJson<{ data?: { url?: string } }>(url, { 'user-agent': 'Mozilla/5.0' }, {
      signal: this.cb.signal
    })
    return d.data?.url ?? ''
  }

  private async neteaseUrlHaitangw(sid: string, level: string): Promise<string> {
    const url = `https://musicapi.haitangw.net/music/wy.php?id=${sid}&level=${level}&type=json`
    await this.gate(url)
    const d = await getJson<{ data?: { url?: string } }>(url, { 'user-agent': 'Mozilla/5.0' }, {
      signal: this.cb.signal
    })
    return d.data?.url ?? ''
  }

  private async neteaseUrlRrvenn(sid: string, level: string): Promise<string> {
    const url = 'https://music.rrvenn.cn/Song_V1'
    await this.gate(url)
    const d = await postJson<{ data?: { url?: string } }>(
      url,
      { url: String(sid), level, type: 'json' },
      { 'User-Agent': 'Mozilla/5.0', Referer: 'https://music.rrvenn.cn/' },
      { signal: this.cb.signal }
    )
    return d.data?.url ?? ''
  }

  private async neteaseUrlToubiec(sid: string, level: string): Promise<string> {
    const url = 'https://nextmusic.toubiec.cn/api/getSongUrl'
    await this.gate(url)
    const d = await postJson<{ data?: { url?: string } }>(
      url,
      { id: String(sid), level, timestamp: Date.now() },
      { Origin: 'https://wyapi.toubiec.cn', Referer: 'https://wyapi.toubiec.cn/', 'User-Agent': 'Mozilla/5.0' },
      { signal: this.cb.signal }
    )
    return d.data?.url ?? ''
  }

  /** 完整音频优先：.part 临时文件达标才原子改名（min_mb 口径 1.5MB） */
  private async downloadNeteaseAudio(sid: string, mp3Path: string, quality: Quality, minMb = 1.5): Promise<boolean> {
    const levels: Record<Quality, string[]> = {
      high: ['exhigh', 'higher', 'standard'],
      standard: ['standard', 'higher'],
      lossless: ['lossless', 'exhigh']
    }
    const fetchers = [
      (id: string, lvl: string) => this.neteaseUrlCenguigui(id, lvl),
      (id: string, lvl: string) => this.neteaseUrlHaitangw(id, lvl),
      (id: string, lvl: string) => this.neteaseUrlRrvenn(id, lvl),
      (id: string, lvl: string) => this.neteaseUrlToubiec(id, lvl)
    ]
    // M2 修复：part 名掺入本次下载的随机后缀——同名歌曲并发任务此前共用同一
    // .part.mp3 交错写入产生损坏文件；rename 目标同名时也会互相覆盖
    const part = mp3Path.replace(/\.mp3$/i, `.${randomUUID().slice(0, 8)}.part.mp3`)
    const fetcherNames = ['cenguigui', 'haitangw', 'rrvenn', 'toubiec']
    let lastErr: unknown = null
    for (const [fi, fetcher] of fetchers.entries()) {
      for (const lvl of levels[quality]) {
        let url = ''
        try {
          url = await fetcher(sid, lvl)
        } catch (err) {
          // ⚠ 单个镜像不可达只跳过该镜像，绝不能中断整个镜像链
          //（此前无 try/catch：第一个镜像 fetch failed → 整个下载直接失败）
          if (this.cb.signal?.aborted) throw err
          lastErr = err
          this.cb.log?.(`镜像 ${fetcherNames[fi] ?? fi} 取直链失败（level=${lvl}）：${err instanceof Error ? err.message : String(err)}`)
          continue
        }
        if (!trustedAudioUrl(url)) continue
        const size = await fetchToFile(url, part, { signal: this.cb.signal, minBytes: 1024 })
        if (size >= minMb * 1024 * 1024) {
          // P2 修复：目标已存在（Windows EEXIST/EPERM，如上次任务只留下 mp3）时
          // rename 抛错会把已到手产物误判为下载失败——目标存在即视为成功并清理 part。
          // 第七轮审查：此路径本任务未落盘任何字节（文件可能属于并发同歌任务）——
          // 置 lastProductForeign，engine 取消清理与改名均按 cached 语义跳过
          try {
            await rename(part, mp3Path)
            this.lastProductForeign = false
          } catch (err) {
            const exists = await stat(mp3Path)
              .then(() => true)
              .catch(() => false)
            if (!exists) throw err
            await unlink(part).catch(() => {})
            this.lastProductForeign = true
          }
          return true
        }
        if (size > 0) await unlink(part).catch(() => {})
      }
    }
    // 全部镜像失败：日志留痕（归因链已由 http 层记录），便于事后排查
    if (lastErr) this.cb.log?.(`网易云全部镜像取直链失败 sid=${sid}`)
    return false
  }

  private async fetchNeteaseLyric(sid: string, lrcPath: string): Promise<boolean> {
    try {
      const url = 'https://music.163.com/api/song/lyric'
      await this.gate(url)
      // 二期（0.9.x 双语歌词）：tv=1 取翻译轨（tlyric），原文轨仍走 lrc
      const data = await postForm<{ lrc?: { lyric?: string }; tlyric?: { lyric?: string } }>(
        url,
        { id: sid, lv: 1, kv: 1, tv: 1 },
        NETEASE_HEADERS,
        { signal: this.cb.signal, timeoutMs: 15_000 }
      )
      const lyric = data.lrc?.lyric ?? ''
      if (hasTimestamps(lyric)) {
        const trans = data.tlyric?.lyric ?? ''
        if (getLyricsMode() === 'bilingual' && hasTimestamps(trans)) {
          await writeLrc(lrcPath, mergeBilingualLrc(lyric, trans))
        } else {
          await writeLrc(lrcPath, lyric)
        }
        return true
      }
    } catch (err) {
      // 歌词失败降级占位，但写盘类失败（磁盘满/权限）需留痕
      if (!this.cb.signal?.aborted) this.cb.log?.(`网易云官方歌词接口失败 sid=${sid}：${err instanceof Error ? err.message : String(err)}`)
    }
    return false
  }

  private async fetchNeteaseLyricInline(sid: string, lrcPath: string): Promise<boolean> {
    const inline = [
      `https://api-v2.cenguigui.cn/api/netease/music_v1.php?id=${sid}&type=json&level=exhigh`,
      `https://musicapi.haitangw.net/music/wy.php?id=${sid}&level=exhigh&type=json`
    ]
    for (const url of inline) {
      try {
        await this.gate(url)
        const d = await getJson<{ data?: { lyric?: string } }>(url, { 'user-agent': 'Mozilla/5.0' }, {
          signal: this.cb.signal
        })
        const lyric = d.data?.lyric ?? ''
        if (hasTimestamps(lyric)) {
          await writeLrc(lrcPath, lyric)
          return true
        }
      } catch {
        continue
      }
    }
    return false
  }

  /** 歌词回退链：主 ID 官方 → 候选 ID 官方 → 内联镜像 → 占位（与 Python 口径一致） */
  private async neteaseLyricBest(primaryId: string, allIds: string[], lrcPath: string): Promise<void> {
    for (const sid of [primaryId, ...allIds.filter((i) => i !== primaryId)]) {
      if (this.cb.signal?.aborted) return // M-5：abort 后不再逐个候选快速失败
      if (await this.fetchNeteaseLyric(sid, lrcPath)) return
    }
    for (const sid of allIds) {
      if (this.cb.signal?.aborted) return
      if (await this.fetchNeteaseLyricInline(sid, lrcPath)) return
    }
    if (this.cb.signal?.aborted) return
    await writeLrc(lrcPath, EMPTY_LRC)
  }

  async tryNeteaseRobust(singer: string, songName: string, mp3Path: string, lrcPath: string, quality: Quality): Promise<boolean> {
    this.lastProductForeign = false // 每次尝试前重置归属标记
    this.lastAlbum = ''
    const candidates = await this.searchNetease(`${singer} ${songName}`.trim(), 10)
    if (!candidates.length) return false
    const enriched = []
    for (const c of candidates.slice(0, 10)) {
      const d = await this.getNeteaseDetail(c.id)
      const artist = d.artist || c.artist
      enriched.push({ ...c, artist, match: artistMatches(artist, singer) })
    }
    // R6 修复：用户只输歌名不输歌手（singer 为空）时，artistMatches 恒 false →
    // 网易云永远跳过 → 全平台失败（实测日志「所有平台均无法下载:  童年」）。
    // 空歌手按「原版度」择优，与搜索列表排序口径一致；仍要求经 detail 补齐歌手
    const matched = singer ? enriched.filter((c) => c.match) : enriched
    if (!matched.length) {
      this.cb.log?.(`网易云搜索结果未匹配到原唱「${singer}」，可能为翻唱或搜索接口降级，跳过`)
      return false
    }
    matched.sort((a, b) => scoreOriginality(b.name, songName) - scoreOriginality(a.name, songName))
    // 空歌手无原唱锚点，候选全部尝试代价过高（每候选 4 镜像×3 音质）——只取最像原版的前 5
    const attempts = singer ? matched : matched.slice(0, 5)
    const allIds = enriched.map((c) => c.id)
    for (const c of attempts) {
      if (await this.downloadNeteaseAudio(c.id, mp3Path, quality)) {
        await this.neteaseLyricBest(c.id, allIds, lrcPath)
        this.lastAlbum = c.album ?? ''
        this.cb.log?.(`网易云命中: ${c.name} / ${c.artist}`)
        return true
      }
    }
    return false
  }

  /** F1：按网易云 ID 精确下载（搜索降级时的可靠通道）。专辑名由调用方
   *  （engine.downloadById 的 detail）回填 engine.lastAlbum */
  async downloadNeteaseById(neteaseId: string, mp3Path: string, lrcPath: string, quality: Quality): Promise<boolean> {
    this.lastAlbum = ''
    if (!(await this.downloadNeteaseAudio(neteaseId, mp3Path, quality))) return false
    await this.neteaseLyricBest(neteaseId, [neteaseId], lrcPath)
    return true
  }

  /** F1 试听直链（网易云镜像，engine.previewUrl 调用）。
   *  此前只试 haitangw 单镜像——该域不可达时试听必败；改为四镜像顺序回退。
   *  审查修复：quality 白名单透传的是应用层口径（standard/high/lossless），而镜像
   *  level 需网易云有效值（standard/higher/exhigh/lossless）——'high' 直接透传会让
   *  四镜像全部失败，这里按 QUALITY_MAP 同口径映射 */
  async previewNetease(sid: string, quality = 'standard'): Promise<string> {
    const q: Quality = (['standard', 'high', 'lossless'] as const).includes(quality as Quality)
      ? (quality as Quality)
      : 'standard'
    const level = QUALITY_MAP.netease?.[q] ?? 'standard'
    const fetchers: Array<[string, (id: string, lvl: string) => Promise<string>]> = [
      ['cenguigui', (id, lvl) => this.neteaseUrlCenguigui(id, lvl)],
      ['haitangw', (id, lvl) => this.neteaseUrlHaitangw(id, lvl)],
      ['rrvenn', (id, lvl) => this.neteaseUrlRrvenn(id, lvl)],
      ['toubiec', (id, lvl) => this.neteaseUrlToubiec(id, lvl)]
    ]
    for (const [name, fetcher] of fetchers) {
      try {
        const url = await fetcher(sid, level)
        // H4：试听直链同样过白名单（engine.previewNetease 有二次校验，此处提前拦截）
        if (url && trustedAudioUrl(url)) return url
      } catch (err) {
        this.cb.log?.(`试听镜像 ${name} 失败：${err instanceof Error ? err.message : String(err)}`)
      }
    }
    return ''
  }

  // ========== QQ 音乐 ==========

  async searchQq(keyword: string, limit = 5): Promise<PlatformSong[]> {
    try {
      const data = JSON.stringify({
        req: {
          method: 'DoSearchForQQMusicDesktop',
          module: 'music.search.SearchCgiService',
          param: {
            remoteplace: 'txt.yqq.center',
            searchid: '',
            search_type: 0,
            query: keyword,
            page_num: 1,
            num_per_page: limit
          }
        }
      })
      const url =
        'https://u.y.qq.com/cgi-bin/musicu.fcg?' +
        new URLSearchParams({
          format: 'json',
          inCharset: 'utf-8',
          outCharset: 'utf-8',
          notice: '0',
          platform: 'yqq.json',
          needNewCode: '0',
          data
        }).toString()
      await this.gate(url)
      const r = await getJson<Record<string, unknown>>(url, { 'User-Agent': 'Mozilla/5.0', Referer: 'https://y.qq.com/' }, {
        signal: this.cb.signal,
        timeoutMs: 10_000
      })
      const list =
        ((r.req as { data?: { body?: { song?: { list?: Array<Record<string, unknown>> } } } })?.data?.body?.song?.list) ?? []
      return list.map((s) => ({
        id: String(s.mid ?? ''),
        name: String(s.title ?? ''),
        artist: ((s.singer as Array<{ name?: string }> | undefined) ?? []).map((a) => a.name ?? '').join(', '),
        // R6：搜索列表展示字段（interval=秒，album.name=专辑）
        durationMs: Number(s.interval) > 0 ? Number(s.interval) * 1000 : undefined,
        album: String((s.album as { name?: string } | undefined)?.name ?? '') || undefined
      }))
    } catch {
      return []
    }
  }

  async tryQq(songMid: string, mp3Path: string, lrcPath: string, quality: Quality): Promise<boolean> {
    this.lastProductForeign = false // 第十轮审查：与 tryNeteaseRobust 同口径重置归属标记
    const q = QUALITY_MAP.qq![quality]
    const h = { 'user-agent': 'Mozilla/5.0' }
    // vkeys
    try {
      const url = `https://api.vkeys.cn/music/tencent/song/link?mid=${songMid}&quality=${q}`
      await this.gate(url)
      const r = await getJson<{ data?: { url?: string } }>(url, h, { signal: this.cb.signal, timeoutMs: 10_000 })
      const url2 = r.data?.url ?? ''
      if (trustedAudioUrl(url2) && (await downloadFile(url2, mp3Path, { signal: this.cb.signal, onForeign: () => { this.lastProductForeign = true } }))) {
        await this.saveQqLyric(songMid, lrcPath)
        return true
      }
    } catch (err) {
      if (!this.cb.signal?.aborted) this.cb.log?.(`QQ 音乐 vkeys 直链失败 mid=${songMid}：${err instanceof Error ? err.message : String(err)}`)
    }
    // 317ak
    try {
      // 第十轮审查：QQ 317ak 链此前无视所选音质恒从高到低全试（标准档也先拉
      // 无损再丢弃）——与酷狗链 quality 接线口径对齐。br 越大音质越高（同 317ak
      // 酷狗链惯例）；链路自带逐档回退，选低档优先命中低 br
      const brChain =
        quality === 'lossless'
          ? ['10', '9', '8', '7', '6', '5']
          : quality === 'high'
            ? ['7', '6', '5']
            : ['5', '6', '7']
      for (const q2 of brChain) {
        const url = `https://api.317ak.com/api/yinyue/qqyinyue?ckey=Wk83NlFKQ0lINVBQSUNKT09YVUg=&i=${songMid}&br=${q2}&type=json&lrc=1`
        await this.gate(url)
        const data = await getJson<{ url?: string; lyric?: string }>(url, h, { signal: this.cb.signal, timeoutMs: 10_000 })
        const url2 = data.url ?? ''
        if (trustedAudioUrl(url2) && (await downloadFile(url2, mp3Path, { signal: this.cb.signal, onForeign: () => { this.lastProductForeign = true } }))) {
          await writeLrc(lrcPath, data.lyric || EMPTY_LRC)
          return true
        }
      }
    } catch (err) {
      if (!this.cb.signal?.aborted) this.cb.log?.(`QQ 音乐 317ak 直链失败 mid=${songMid}：${err instanceof Error ? err.message : String(err)}`)
    }
    return false
  }

  private async saveQqLyric(songMid: string, lrcPath: string): Promise<void> {
    let lyric = ''
    try {
      const url = `https://api.vkeys.cn/v2/music/tencent/lyric?mid=${songMid}`
      await this.gate(url)
      const r = await getJson<{ data?: { lrc?: string } }>(url, { 'user-agent': 'Mozilla/5.0' }, {
        signal: this.cb.signal,
        timeoutMs: 10_000
      })
      lyric = r.data?.lrc ?? ''
    } catch {
      // ignore
    }
    await writeLrc(lrcPath, lyric || EMPTY_LRC)
  }

  // ========== 酷狗 ==========

  async searchKugou(keyword: string, limit = 5): Promise<PlatformSong[]> {
    try {
      const url =
        'https://songsearch.kugou.com/song_search_v2?' +
        new URLSearchParams({
          keyword,
          page: '1',
          pagesize: String(limit),
          platform: 'WebFilter',
          format: 'json'
        }).toString()
      await this.gate(url)
      const r = await getJson<{ data?: { lists?: Array<Record<string, unknown>> } }>(url, UA, {
        signal: this.cb.signal,
        timeoutMs: 10_000
      })
      return (r.data?.lists ?? []).map((s) => ({
        id: String(s.FileHash ?? s.hash ?? ''),
        name: String(s.SongName ?? s.songname ?? ''),
        artist: String(s.SingerName ?? s.singername ?? ''),
        // R6：搜索列表展示字段（Duration=秒，AlbumName=专辑）
        durationMs: Number(s.Duration) > 0 ? Number(s.Duration) * 1000 : undefined,
        album: String(s.AlbumName ?? '') || undefined
      }))
    } catch {
      return []
    }
  }

  async tryKugou(fileHash: string, mp3Path: string, lrcPath: string, quality: Quality): Promise<boolean> {
    this.lastProductForeign = false // 第十轮审查：重置归属标记
    // 二期（0.9.x 无损档）：quality 接线（此前 void quality 忽略音质，恒从 br=6 起试）。
    // 317ak br 值越大音质越高（1-6）；haitangw level：hires > lossless > exhigh > standard
    const h = { 'user-agent': 'Mozilla/5.0' }
    const brChain = quality === 'lossless' ? ['6', '5', '4', '3', '2', '1'] : quality === 'high' ? ['5', '4', '3', '2', '1'] : ['3', '2', '1']
    try {
      for (const q2 of brChain) {
        const url = `https://api.317ak.com/api/yinyue/kugou?ckey=UE9WTUhLSklYOEE3SUdIMkZNMVA=&i=${fileHash}&br=${q2}&type=json&lrc=1`
        await this.gate(url)
        const data = await getJson<{ url?: string; lyric?: string }>(url, h, { signal: this.cb.signal, timeoutMs: 10_000 })
        const url2 = data.url ?? ''
        if (trustedAudioUrl(url2) && (await downloadFile(url2, mp3Path, { signal: this.cb.signal, onForeign: () => { this.lastProductForeign = true } }))) {
          await writeLrc(lrcPath, data.lyric || EMPTY_LRC)
          return true
        }
      }
    } catch (err) {
      if (!this.cb.signal?.aborted) this.cb.log?.(`酷狗 317ak 直链失败 hash=${fileHash}：${err instanceof Error ? err.message : String(err)}`)
    }
    try {
      const levelChain = quality === 'lossless' ? ['hires', 'lossless'] : quality === 'high' ? ['exhigh'] : ['standard', 'exhigh']
      for (const q2 of levelChain) {
        const url = `https://musicapi.haitangw.net/kgqq/kg.php?type=json&id=${fileHash}&level=${q2}`
        await this.gate(url)
        const r = await getJson<{ data?: { url?: string } }>(url, h, { signal: this.cb.signal, timeoutMs: 10_000 })
        const url2 = r.data?.url ?? ''
        if (trustedAudioUrl(url2) && (await downloadFile(url2, mp3Path, { signal: this.cb.signal, onForeign: () => { this.lastProductForeign = true } }))) {
          await writeLrc(lrcPath, EMPTY_LRC)
          return true
        }
      }
    } catch (err) {
      if (!this.cb.signal?.aborted) this.cb.log?.(`酷狗 haitangw 直链失败 hash=${fileHash}：${err instanceof Error ? err.message : String(err)}`)
    }
    return false
  }

  // ========== 咪咕 ==========

  async searchMigu(keyword: string, limit = 5): Promise<PlatformSong[]> {
    try {
      const url =
        'https://c.musicapp.migu.cn/v1.0/content/search_all.do?' +
        new URLSearchParams({
          text: keyword,
          pageNo: '1',
          pageSize: String(limit),
          isCopyright: '1',
          sort: '1',
          searchSwitch: JSON.stringify({ song: 1, album: 0, singer: 0, tagSong: 1, mvSong: 0, bestShow: 1 })
        }).toString()
      await this.gate(url)
      const r = await getJson<{ songResultData?: { result?: Array<Record<string, unknown>> } }>(url, UA, {
        signal: this.cb.signal,
        timeoutMs: 10_000
      })
      const out: PlatformSong[] = []
      for (const s of r.songResultData?.result ?? []) {
        const cid = s.contentId
        const copyid = s.copyrightId
        if (cid && copyid) {
          const singers = ((s.singers ?? s.singerList) as Array<{ name?: string }> | undefined) ?? []
          out.push({
            id: String(cid),
            copyrightId: String(copyid),
            name: String(s.name ?? s.songName ?? ''),
            artist: singers.filter((g) => typeof g === 'object').map((g) => g.name ?? '').join(', '),
            // 第十轮审查 P3：补专辑名映射——此前 tryMigu 的 lastAlbum 恒空，
            // {{album}} 归档模板对咪咕恒 Unknown Album（死代码）
            album: String((s.album as { name?: string } | undefined)?.name ?? s.albumName ?? '') || undefined
          })
        }
      }
      return out
    } catch {
      return []
    }
  }

  async tryMigu(song: PlatformSong, mp3Path: string, lrcPath: string, quality: Quality): Promise<boolean> {
    this.lastProductForeign = false // 第十轮审查：重置归属标记
    this.lastAlbum = song.album ?? ''
    const contentId = song.id
    const copyrightId = song.copyrightId ?? ''
    const q = QUALITY_MAP.migu![quality]
    // R6 修复：listen-url 接口现返回非 JSON 二进制体（服务端异常，实测 2026-10-02，
    // JSON.parse 必炸）——原实现里 getJson 抛错直达 catch，listenSong.do 兜底直链
    // 永远走不到。改为接口失败/空 url 都落到兜底直链（实测返回 4MB audio/mpeg 可用）
    let audio = ''
    try {
      const url =
        'https://c.musicapp.migu.cn/strategy/listen-url/h5/v2.4?' +
        new URLSearchParams({
          contentId,
          copyrightId,
          resourceType: 'E',
          netType: '01',
          toneFlag: q,
          scene: '',
          lowerQualityContentId: contentId
        }).toString()
      await this.gate(url)
      const data = await getJson<{ data?: { url?: string } }>(
        url,
        { 'Content-Type': 'application/json;charset=UTF-8', birth: 'h5page', signature: '1' },
        { signal: this.cb.signal, timeoutMs: 10_000 }
      )
      audio = data.data?.url ?? ''
    } catch (err) {
      if (this.cb.signal?.aborted) return false
      this.cb.log?.(`咪咕 listen-url 接口失败（改走兜底直链）contentId=${contentId}：${err instanceof Error ? err.message : String(err)}`)
    }
    if (!audio) {
      audio = `https://app.pd.nf.migu.cn/MIGUM3.0/v1.0/content/sub/listenSong.do?channel=mx&copyrightId=${copyrightId}&contentId=${contentId}&toneFlag=${q}&resourceType=E&userId=15548614588710179085069&netType=00`
    }
    if (
      trustedAudioUrl(audio) &&
      (await downloadFile(audio, mp3Path, {
        signal: this.cb.signal,
        onForeign: () => {
          this.lastProductForeign = true
        },
        headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://m.music.migu.cn/v3' }
      }))
    ) {
      let lyric = ''
      try {
        const url2 = `https://app.c.nf.migu.cn/MIGUM3.0/strategy/pc/listen/v1.0?scene=&netType=01&resourceType=2&copyrightId=${copyrightId}&contentId=${contentId}&toneFlag=PQ`
        await this.gate(url2)
        const r2 = await getJson<{ data?: { lrcUrl?: string } }>(url2, undefined, { signal: this.cb.signal, timeoutMs: 10_000 })
        if (r2.data?.lrcUrl) {
          lyric = await getText(r2.data.lrcUrl, UA, { signal: this.cb.signal, timeoutMs: 10_000 })
        }
      } catch {
        // 歌词接口失败不影响音频（下方落占位歌词）
        lyric = ''
      }
      await writeLrc(lrcPath, lyric || EMPTY_LRC)
      return true
    }
    if (!this.cb.signal?.aborted) this.cb.log?.(`咪咕直链失败 contentId=${contentId}（listen-url 与 listenSong.do 兜底均不可用）`)
    return false
  }

  // ========== 汽水 ==========

  async searchSoda(keyword: string, limit = 5): Promise<PlatformSong[]> {
    try {
      void limit
      const params = new URLSearchParams({
        aid: '386088',
        app_name: 'luna_pc',
        region: 'cn',
        geo_region: 'cn',
        os_region: 'cn',
        device_id: '3753066532709850',
        iid: '3753066532713946',
        version_name: '3.5.1',
        version_code: '30050100',
        channel: 'official',
        build_mode: 'master',
        device_platform: 'windows',
        device_type: 'Windows',
        os_version: 'Windows 10 Education',
        fp: '3753066532709850',
        q: keyword,
        cursor: '0',
        search_id: randomUUID(),
        search_method: 'input',
        search_scene: ''
      })
      const url = `https://api.qishui.com/luna/pc/search/track?${params.toString()}`
      await this.gate(url)
      const r = await getJson<{ data?: { list?: Array<Record<string, unknown>> } }>(
        url,
        { 'User-Agent': 'LunaPC/3.5.1(408871041)' },
        { signal: this.cb.signal, timeoutMs: 10_000 }
      )
      const out: PlatformSong[] = []
      for (const item of r.data?.list ?? []) {
        const track = (item.entity as { track?: Record<string, unknown> } | undefined)?.track
        const tid = track?.id
        if (tid) {
          out.push({
            id: String(tid),
            name: String(track.name ?? ''),
            artist: ((track.artists as Array<{ name?: string }> | undefined) ?? [])
              .map((a) => a.name ?? '')
              .join(', '),
            // 第十轮审查 P3：补专辑名映射（同 tryMigu 口径）
            album: String((track.album as { name?: string } | undefined)?.name ?? '') || undefined
          })
        }
      }
      return out
    } catch {
      return []
    }
  }

  async trySoda(song: PlatformSong, mp3Path: string, lrcPath: string): Promise<boolean> {
    this.lastProductForeign = false // 第十轮审查：重置归属标记
    this.lastAlbum = song.album ?? ''
    const songId = song.id
    try {
      // 2026-09-30 实测：https 证书有效（Python 原版 http 为历史遗留），切换防中间人篡改
      const url = 'https://qiuyu520.fun/qishuiParse/api/track/v2'
      await this.gate(url)
      const data = await postJson<{ data?: { url?: string; lyric?: string } }>(
        url,
        { track_id: songId },
        {
          Accept: 'application/json, text/plain, */*',
          'User-Agent': 'Mozilla/5.0',
          Referer: 'https://qiuyu520.fun/qishui/',
          Origin: 'https://qiuyu520.fun'
        },
        { signal: this.cb.signal, timeoutMs: 10_000 }
      )
      const url2 = data.data?.url ?? ''
      if (trustedAudioUrl(url2) && (await downloadFile(url2, mp3Path, { signal: this.cb.signal, onForeign: () => { this.lastProductForeign = true } }))) {
        await writeLrc(lrcPath, data.data?.lyric || EMPTY_LRC)
        return true
      }
    } catch (err) {
      if (!this.cb.signal?.aborted) this.cb.log?.(`汽水 qiuyu520 直链失败 track=${songId}：${err instanceof Error ? err.message : String(err)}`)
    }
    // Fallback: official share page
    try {
      const url = `https://music.douyin.com/qishui/share/track?track_id=${songId}`
      await this.gate(url)
      const html = await getText(url, {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X)',
        Accept: 'text/html,application/xhtml+xml'
      }, { signal: this.cb.signal, timeoutMs: 10_000 })
      const m = /_ROUTER_DATA\s*=\s*({.*?});/s.exec(html)
      if (m) {
        const meta = JSON.parse(m[1] ?? '{}') as unknown
        let audioUrl = ''
        for (const v of deepSearch(meta, 'audioWithLyricsOption')) {
          if (typeof v === 'object' && v !== null && 'url' in v && (v as { url?: unknown }).url) {
            audioUrl = String((v as { url: unknown }).url)
            break
          }
        }
        audioUrl = audioUrl.replace(/\\u002F/g, '/')
        if (trustedAudioUrl(audioUrl) && (await downloadFile(audioUrl, mp3Path, { signal: this.cb.signal }))) {
          await writeLrc(lrcPath, EMPTY_LRC)
          return true
        }
      }
    } catch (err) {
      if (!this.cb.signal?.aborted) this.cb.log?.(`汽水分享页直链失败 track=${songId}：${err instanceof Error ? err.message : String(err)}`)
    }
    return false
  }
}

/** 深度搜索（等价 Python _deep_search 生成器） */
export function* deepSearch(d: unknown, key: string): Generator<unknown> {
  if (Array.isArray(d)) {
    for (const item of d) yield* deepSearch(item, key)
  } else if (typeof d === 'object' && d !== null) {
    const obj = d as Record<string, unknown>
    if (key in obj) yield obj[key]
    for (const v of Object.values(obj)) yield* deepSearch(v, key)
  }
}

/** 五平台回退链（顺序与 Python _try_all_platforms 一致） */
export async function tryAllPlatforms(
  engine: PlatformEngine,
  singer: string,
  songName: string,
  saveDir: string,
  quality: Quality,
  onEvent?: EngineCallbacks['onEvent'],
  signal?: AbortSignal
): Promise<PlatformResult> {
  const keyword = `${singer} ${songName}`.trim()
  await ensureDir(saveDir)
  // R6：空歌手（用户只输歌名）时文件名不再以 "- " 开头
  const base = sanitizeName(singer ? `${singer} - ${songName}` : songName)
  const mp3Path = join(saveDir, `${base}.mp3`)
  const lrcPath = join(saveDir, `${base}.lrc`)

  // skip_existing 语义（Python _already_downloaded 口径）：mp3>1KB 且 lrc 存在 → 跳过。
  // cached 标记：产物是既有文件而非本次落盘——取消清理时不得误删（可能属于并发同歌任务）
  if (await alreadyDownloaded(mp3Path, lrcPath)) {
    return { success: true, source: 'cached', message: '已存在，跳过', mp3Path, lrcPath, cached: true }
  }
  // 第十轮审查 P2：music.template 自定义命名后 skip_existing 永不命中——首次
  // 下载的产物已被 applyNaming 改名/迁目录，原生命名路径必不存在，重复入队会
  // 全量重下并堆积「(2)」副本。补音乐库兜底：title/artist 命中且文件在盘 →
  // 按 cached 返回（engine 取消清理与改名自动跳过）
  const libHit = listTracks().find(
    (t) =>
      t.title === songName &&
      (!singer || (t.artist ?? '').includes(singer)) &&
      stat(t.path).then(() => true).catch(() => false)
  )
  if (libHit) {
    log.info(`skip_existing (library): ${libHit.path}`)
    return {
      success: true,
      source: 'cached',
      message: '已存在（音乐库命中），跳过',
      mp3Path: libHit.path,
      lrcPath: libHit.lrc_path ?? '',
      cached: true
    }
  }

  // R4-P3：每轮平台尝试前检查取消——取消后快速失败请求被平台 catch 吞成空结果，
  // 循环会白耗遍历并广播「尝试 QQ 音乐…」等误导性进度事件
  const aborted = (): boolean => signal?.aborted === true
  if (aborted()) return { success: false, source: '', message: '任务已取消', mp3Path: '', lrcPath: '' }

  // 二期（无损档）：成功后按文件头对齐产物扩展名（.mp3 → .flac/.m4a/…），
  // 并把真实路径/专辑名带进结果
  const finish = async (source: string, message: string): Promise<PlatformResult> => ({
    success: true,
    source,
    message,
    mp3Path: await alignAudioExt(mp3Path),
    lrcPath,
    album: engine.lastAlbum || undefined
  })

  // 1. 网易云（原唱校验）
  if (onEvent) onEvent({ type: 'progress', platform: 'netease', message: '尝试 网易云…' })
  if (await engine.tryNeteaseRobust(singer, songName, mp3Path, lrcPath, quality)) {
    onEvent?.({ type: 'platform-ok', platform: 'netease', message: '网易云 下载成功' })
    // 第七轮审查 P2：exists 兜底命中的产物非本任务落盘（lastProductForeign）——
    // 按 cached 语义返回，engine 取消清理/改名跳过，防误删并发同歌任务的产物
    const r = await finish('网易云', `网易云: ${songName}`)
    if (engine.lastProductForeign) return { ...r, cached: true }
    return r
  }
  onEvent?.({ type: 'progress', platform: 'netease', message: '网易云 未命中' })

  // 2. QQ
  if (aborted()) return { success: false, source: '', message: '任务已取消', mp3Path: '', lrcPath: '' }
  if (onEvent) onEvent({ type: 'progress', platform: 'qq', message: '尝试 QQ 音乐…' })
  for (const song of await engine.searchQq(keyword)) {
    engine.lastAlbum = song.album ?? ''
    if (await engine.tryQq(song.id, mp3Path, lrcPath, quality)) {
      onEvent?.({ type: 'platform-ok', platform: 'qq', message: 'QQ 音乐 下载成功' })
      // 第十轮审查：exists 兜底命中的产物按 cached 返回（对齐网易云分支口径）
      const r = await finish('QQ 音乐', `QQ 音乐: ${song.name}`)
      if (engine.lastProductForeign) return { ...r, cached: true }
      return r
    }
  }
  onEvent?.({ type: 'progress', platform: 'qq', message: 'QQ 音乐 未命中' })

  // 3. 酷狗
  if (aborted()) return { success: false, source: '', message: '任务已取消', mp3Path: '', lrcPath: '' }
  if (onEvent) onEvent({ type: 'progress', platform: 'kugou', message: '尝试 酷狗…' })
  for (const song of await engine.searchKugou(keyword)) {
    engine.lastAlbum = song.album ?? ''
    if (await engine.tryKugou(song.id, mp3Path, lrcPath, quality)) {
      onEvent?.({ type: 'platform-ok', platform: 'kugou', message: '酷狗 下载成功' })
      const r = await finish('酷狗', `酷狗: ${song.name}`)
      if (engine.lastProductForeign) return { ...r, cached: true }
      return r
    }
  }
  onEvent?.({ type: 'progress', platform: 'kugou', message: '酷狗 未命中' })

  // 4. 咪咕
  if (aborted()) return { success: false, source: '', message: '任务已取消', mp3Path: '', lrcPath: '' }
  if (onEvent) onEvent({ type: 'progress', platform: 'migu', message: '尝试 咪咕…' })
  for (const song of await engine.searchMigu(keyword)) {
    if (await engine.tryMigu(song, mp3Path, lrcPath, quality)) {
      onEvent?.({ type: 'platform-ok', platform: 'migu', message: '咪咕 下载成功' })
      const r = await finish('咪咕', `咪咕: ${song.name}`)
      if (engine.lastProductForeign) return { ...r, cached: true }
      return r
    }
  }
  onEvent?.({ type: 'progress', platform: 'migu', message: '咪咕 未命中' })

  // 5. 汽水
  if (aborted()) return { success: false, source: '', message: '任务已取消', mp3Path: '', lrcPath: '' }
  if (onEvent) onEvent({ type: 'progress', platform: 'soda', message: '尝试 汽水…' })
  for (const song of await engine.searchSoda(keyword)) {
    if (await engine.trySoda(song, mp3Path, lrcPath)) {
      onEvent?.({ type: 'platform-ok', platform: 'soda', message: '汽水 下载成功' })
      const r = await finish('汽水', `汽水: ${song.name}`)
      if (engine.lastProductForeign) return { ...r, cached: true }
      return r
    }
  }
  onEvent?.({ type: 'progress', platform: 'soda', message: '汽水 未命中' })

  return { success: false, source: '', message: `所有平台均无法下载: ${keyword}`, mp3Path: '', lrcPath: '' }
}

/**
 * 已下载判定（等价 _already_downloaded）：音频 >1KB 且 lrc 存在 → 跳过。
 * 二期（无损档）：产物扩展名按文件头对齐后可能是 .flac/.m4a——对主名扫全部音频
 * 扩展名，防止无损产物被重复下载覆盖。
 */
export async function alreadyDownloaded(mp3Path: string, lrcPath: string): Promise<boolean> {
  const m = /\.\w+$/.exec(mp3Path)
  const base = m ? mp3Path.slice(0, mp3Path.length - m[0].length) : mp3Path
  for (const ext of AUDIO_EXTS) {
    try {
      const s = await stat(base + ext)
      await stat(lrcPath)
      if (s.size > 1024) return true
    } catch {
      // 该扩展名不存在 → 试下一个
    }
  }
  return false
}
