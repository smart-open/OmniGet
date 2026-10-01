// 五平台音乐搜索/下载引擎（batch_download_v4.py 的等价 TS 移植，§4.4）
// 平台回退链：网易云(稳健原唱校验) → QQ → 酷狗 → 咪咕 → 汽水
// 口径保持：音质映射、镜像顺序、大小校验阈值、原创度打分、歌词回退链逐项一致
// 所有网络操作接受 AbortSignal（取消语义优于 Python 版协作式取消）

import { join } from 'path'
import { randomUUID } from 'crypto'
import { mkdir, rename, stat, unlink, writeFile } from 'fs/promises'
import { getJson, postForm, postJson, getText, fetchToFile, downloadFile, hostOf, isTrustedAudioHost } from './http'
import { HostGate } from './gate'
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
}

export interface PlatformResult {
  success: boolean
  source: string
  message: string
  mp3Path: string
  lrcPath: string
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
      return (data.result?.songs ?? []).map((s) => ({
        id: String(s.id),
        name: String(s.name ?? ''),
        artist: ((s.artists as Array<{ name?: string }> | undefined) ?? [])
          .map((a) => a.name ?? '')
          .join(', ')
      }))
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
          // rename 抛错会把已到手产物误判为下载失败——目标存在即视为成功并清理 part
          try {
            await rename(part, mp3Path)
          } catch (err) {
            const exists = await stat(mp3Path)
              .then(() => true)
              .catch(() => false)
            if (!exists) throw err
            await unlink(part).catch(() => {})
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
      const data = await postForm<{ lrc?: { lyric?: string } }>(
        url,
        { id: sid, lv: 1, kv: 1, tv: -1 },
        NETEASE_HEADERS,
        { signal: this.cb.signal, timeoutMs: 15_000 }
      )
      const lyric = data.lrc?.lyric ?? ''
      if (hasTimestamps(lyric)) {
        await writeLrc(lrcPath, lyric)
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
    const candidates = await this.searchNetease(`${singer} ${songName}`, 10)
    if (!candidates.length) return false
    const enriched = []
    for (const c of candidates.slice(0, 10)) {
      const d = await this.getNeteaseDetail(c.id)
      const artist = d.artist || c.artist
      enriched.push({ ...c, artist, match: artistMatches(artist, singer) })
    }
    const matched = enriched.filter((c) => c.match)
    if (!matched.length) {
      this.cb.log?.(`网易云搜索结果未匹配到原唱「${singer}」，可能为翻唱或搜索接口降级，跳过`)
      return false
    }
    matched.sort((a, b) => scoreOriginality(b.name, songName) - scoreOriginality(a.name, songName))
    const allIds = enriched.map((c) => c.id)
    for (const c of matched) {
      if (await this.downloadNeteaseAudio(c.id, mp3Path, quality)) {
        await this.neteaseLyricBest(c.id, allIds, lrcPath)
        this.cb.log?.(`网易云命中原唱: ${c.name} / ${c.artist}`)
        return true
      }
    }
    return false
  }

  /** F1：按网易云 ID 精确下载（搜索降级时的可靠通道） */
  async downloadNeteaseById(neteaseId: string, mp3Path: string, lrcPath: string, quality: Quality): Promise<boolean> {
    if (!(await this.downloadNeteaseAudio(neteaseId, mp3Path, quality))) return false
    await this.neteaseLyricBest(neteaseId, [neteaseId], lrcPath)
    return true
  }

  /** F1 试听直链（网易云镜像，engine.previewUrl 调用）。
   *  此前只试 haitangw 单镜像——该域不可达时试听必败；改为四镜像顺序回退。 */
  async previewNetease(sid: string, quality = 'standard'): Promise<string> {
    const fetchers: Array<[string, (id: string, lvl: string) => Promise<string>]> = [
      ['cenguigui', (id, lvl) => this.neteaseUrlCenguigui(id, lvl)],
      ['haitangw', (id, lvl) => this.neteaseUrlHaitangw(id, lvl)],
      ['rrvenn', (id, lvl) => this.neteaseUrlRrvenn(id, lvl)],
      ['toubiec', (id, lvl) => this.neteaseUrlToubiec(id, lvl)]
    ]
    for (const [name, fetcher] of fetchers) {
      try {
        const url = await fetcher(sid, quality)
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
        artist: ((s.singer as Array<{ name?: string }> | undefined) ?? []).map((a) => a.name ?? '').join(', ')
      }))
    } catch {
      return []
    }
  }

  async tryQq(songMid: string, mp3Path: string, lrcPath: string, quality: Quality): Promise<boolean> {
    const q = QUALITY_MAP.qq![quality]
    const h = { 'user-agent': 'Mozilla/5.0' }
    // vkeys
    try {
      const url = `https://api.vkeys.cn/music/tencent/song/link?mid=${songMid}&quality=${q}`
      await this.gate(url)
      const r = await getJson<{ data?: { url?: string } }>(url, h, { signal: this.cb.signal, timeoutMs: 10_000 })
      const url2 = r.data?.url ?? ''
      if (trustedAudioUrl(url2) && (await downloadFile(url2, mp3Path, { signal: this.cb.signal }))) {
        await this.saveQqLyric(songMid, lrcPath)
        return true
      }
    } catch (err) {
      if (!this.cb.signal?.aborted) this.cb.log?.(`QQ 音乐 vkeys 直链失败 mid=${songMid}：${err instanceof Error ? err.message : String(err)}`)
    }
    // 317ak
    try {
      for (const q2 of ['7', '9', '10', '8', '6', '5']) {
        const url = `https://api.317ak.com/api/yinyue/qqyinyue?ckey=Wk83NlFKQ0lINVBQSUNKT09YVUg=&i=${songMid}&br=${q2}&type=json&lrc=1`
        await this.gate(url)
        const data = await getJson<{ url?: string; lyric?: string }>(url, h, { signal: this.cb.signal, timeoutMs: 10_000 })
        const url2 = data.url ?? ''
        if (trustedAudioUrl(url2) && (await downloadFile(url2, mp3Path, { signal: this.cb.signal }))) {
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
        artist: String(s.SingerName ?? s.singername ?? '')
      }))
    } catch {
      return []
    }
  }

  async tryKugou(fileHash: string, mp3Path: string, lrcPath: string, quality: Quality): Promise<boolean> {
    void quality
    const h = { 'user-agent': 'Mozilla/5.0' }
    try {
      for (const q2 of ['6', '5', '4', '3', '2', '1']) {
        const url = `https://api.317ak.com/api/yinyue/kugou?ckey=UE9WTUhLSklYOEE3SUdIMkZNMVA=&i=${fileHash}&br=${q2}&type=json&lrc=1`
        await this.gate(url)
        const data = await getJson<{ url?: string; lyric?: string }>(url, h, { signal: this.cb.signal, timeoutMs: 10_000 })
        const url2 = data.url ?? ''
        if (trustedAudioUrl(url2) && (await downloadFile(url2, mp3Path, { signal: this.cb.signal }))) {
          await writeLrc(lrcPath, data.lyric || EMPTY_LRC)
          return true
        }
      }
    } catch (err) {
      if (!this.cb.signal?.aborted) this.cb.log?.(`酷狗 317ak 直链失败 hash=${fileHash}：${err instanceof Error ? err.message : String(err)}`)
    }
    try {
      for (const q2 of ['hires', 'lossless', 'exhigh']) {
        const url = `https://musicapi.haitangw.net/kgqq/kg.php?type=json&id=${fileHash}&level=${q2}`
        await this.gate(url)
        const r = await getJson<{ data?: { url?: string } }>(url, h, { signal: this.cb.signal, timeoutMs: 10_000 })
        const url2 = r.data?.url ?? ''
        if (trustedAudioUrl(url2) && (await downloadFile(url2, mp3Path, { signal: this.cb.signal }))) {
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
            artist: singers.filter((g) => typeof g === 'object').map((g) => g.name ?? '').join(', ')
          })
        }
      }
      return out
    } catch {
      return []
    }
  }

  async tryMigu(song: PlatformSong, mp3Path: string, lrcPath: string, quality: Quality): Promise<boolean> {
    const contentId = song.id
    const copyrightId = song.copyrightId ?? ''
    const q = QUALITY_MAP.migu![quality]
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
      let audio = data.data?.url ?? ''
      if (!audio) {
        audio = `https://app.pd.nf.migu.cn/MIGUM3.0/v1.0/content/sub/listenSong.do?channel=mx&copyrightId=${copyrightId}&contentId=${contentId}&toneFlag=${q}&resourceType=E&userId=15548614588710179085069&netType=00`
      }
      if (trustedAudioUrl(audio) && (await downloadFile(audio, mp3Path, { signal: this.cb.signal }))) {
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
    } catch (err) {
      if (!this.cb.signal?.aborted) this.cb.log?.(`咪咕直链失败 contentId=${contentId}：${err instanceof Error ? err.message : String(err)}`)
    }
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
              .join(', ')
          })
        }
      }
      return out
    } catch {
      return []
    }
  }

  async trySoda(song: PlatformSong, mp3Path: string, lrcPath: string): Promise<boolean> {
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
      if (trustedAudioUrl(url2) && (await downloadFile(url2, mp3Path, { signal: this.cb.signal }))) {
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
  const keyword = `${singer} ${songName}`
  await ensureDir(saveDir)
  const base = sanitizeName(`${singer} - ${songName}`)
  const mp3Path = join(saveDir, `${base}.mp3`)
  const lrcPath = join(saveDir, `${base}.lrc`)

  // skip_existing 语义（Python _already_downloaded 口径）：mp3>1KB 且 lrc 存在 → 跳过。
  // cached 标记：产物是既有文件而非本次落盘——取消清理时不得误删（可能属于并发同歌任务）
  if (await alreadyDownloaded(mp3Path, lrcPath)) {
    return { success: true, source: 'cached', message: '已存在，跳过', mp3Path, lrcPath, cached: true }
  }

  // R4-P3：每轮平台尝试前检查取消——取消后快速失败请求被平台 catch 吞成空结果，
  // 循环会白耗遍历并广播「尝试 QQ 音乐…」等误导性进度事件
  const aborted = (): boolean => signal?.aborted === true
  if (aborted()) return { success: false, source: '', message: '任务已取消', mp3Path: '', lrcPath: '' }

  // 1. 网易云（原唱校验）
  if (onEvent) onEvent({ type: 'progress', platform: 'netease', message: '尝试 网易云…' })
  if (await engine.tryNeteaseRobust(singer, songName, mp3Path, lrcPath, quality)) {
    onEvent?.({ type: 'platform-ok', platform: 'netease', message: '网易云 下载成功' })
    return { success: true, source: '网易云', message: `网易云: ${songName}`, mp3Path, lrcPath }
  }
  onEvent?.({ type: 'progress', platform: 'netease', message: '网易云 未命中' })

  // 2. QQ
  if (aborted()) return { success: false, source: '', message: '任务已取消', mp3Path: '', lrcPath: '' }
  if (onEvent) onEvent({ type: 'progress', platform: 'qq', message: '尝试 QQ 音乐…' })
  for (const song of await engine.searchQq(keyword)) {
    if (await engine.tryQq(song.id, mp3Path, lrcPath, quality)) {
      onEvent?.({ type: 'platform-ok', platform: 'qq', message: 'QQ 音乐 下载成功' })
      return { success: true, source: 'QQ 音乐', message: `QQ 音乐: ${song.name}`, mp3Path, lrcPath }
    }
  }
  onEvent?.({ type: 'progress', platform: 'qq', message: 'QQ 音乐 未命中' })

  // 3. 酷狗
  if (aborted()) return { success: false, source: '', message: '任务已取消', mp3Path: '', lrcPath: '' }
  if (onEvent) onEvent({ type: 'progress', platform: 'kugou', message: '尝试 酷狗…' })
  for (const song of await engine.searchKugou(keyword)) {
    if (await engine.tryKugou(song.id, mp3Path, lrcPath, quality)) {
      onEvent?.({ type: 'platform-ok', platform: 'kugou', message: '酷狗 下载成功' })
      return { success: true, source: '酷狗', message: `酷狗: ${song.name}`, mp3Path, lrcPath }
    }
  }
  onEvent?.({ type: 'progress', platform: 'kugou', message: '酷狗 未命中' })

  // 4. 咪咕
  if (aborted()) return { success: false, source: '', message: '任务已取消', mp3Path: '', lrcPath: '' }
  if (onEvent) onEvent({ type: 'progress', platform: 'migu', message: '尝试 咪咕…' })
  for (const song of await engine.searchMigu(keyword)) {
    if (await engine.tryMigu(song, mp3Path, lrcPath, quality)) {
      onEvent?.({ type: 'platform-ok', platform: 'migu', message: '咪咕 下载成功' })
      return { success: true, source: '咪咕', message: `咪咕: ${song.name}`, mp3Path, lrcPath }
    }
  }
  onEvent?.({ type: 'progress', platform: 'migu', message: '咪咕 未命中' })

  // 5. 汽水
  if (aborted()) return { success: false, source: '', message: '任务已取消', mp3Path: '', lrcPath: '' }
  if (onEvent) onEvent({ type: 'progress', platform: 'soda', message: '尝试 汽水…' })
  for (const song of await engine.searchSoda(keyword)) {
    if (await engine.trySoda(song, mp3Path, lrcPath)) {
      onEvent?.({ type: 'platform-ok', platform: 'soda', message: '汽水 下载成功' })
      return { success: true, source: '汽水', message: `汽水: ${song.name}`, mp3Path, lrcPath }
    }
  }
  onEvent?.({ type: 'progress', platform: 'soda', message: '汽水 未命中' })

  return { success: false, source: '', message: `所有平台均无法下载: ${keyword}`, mp3Path: '', lrcPath: '' }
}

/** 已下载判定（等价 _already_downloaded） */
export async function alreadyDownloaded(mp3Path: string, lrcPath: string): Promise<boolean> {
  try {
    const s = await stat(mp3Path)
    await stat(lrcPath)
    return s.size > 1024
  } catch {
    return false
  }
}
