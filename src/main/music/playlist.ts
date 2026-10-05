// 二期（0.9.x 歌单/专辑批量下载）：网易云歌单/专辑页 URL 解析与曲目列表抓取。
// 只消费官方公开 Web API（music.163.com/api/playlist/detail、/api/album/<id>），
// 不自研签名（合规红线）；批量入队复用单曲任务链（并发闸门 ≤4 由 manager 统一管）。

const NETEASE_HEADERS = {
  'User-Agent': 'Mozilla/5.0',
  Referer: 'https://music.163.com/',
  // undici fetch 对 brotli 解压不可靠（2026-10-01 实测教训）——显式收敛到 gzip/deflate
  'Accept-Encoding': 'gzip, deflate'
}

export interface PlaylistTrack {
  id: string
  name: string
  artist: string
  album: string
}

export interface MusicPlaylistInfo {
  kind: 'playlist' | 'album'
  id: string
  name: string
  tracks: PlaylistTrack[]
  /** 第十轮审查：歌单/专辑实际曲目总数——超过 tracks.length 说明发生截断，
   * 调用方（UI）必须显式提示，不得让用户误以为已拿到全部曲目 */
  total?: number
}

/** 单批入队上限（防巨型歌单一次塞爆任务队列；超过部分 UI 明示截断） */
export const PLAYLIST_MAX_TRACKS = 100

/**
 * 歌单/专辑 URL 分型（纯函数，单测覆盖）：
 * music.163.com/playlist?id=xxx / album?id=xxx（含 y.music.163.com、#/playlist、
 * m/playlist 等页面变体）→ { kind, id }；非歌单/专辑页返回 null。
 */
export function parseMusicPlaylistUrl(raw: string): { kind: 'playlist' | 'album'; id: string } | null {
  const url = raw.trim()
  if (!/^https?:\/\//i.test(url)) return null
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  const host = u.hostname.toLowerCase()
  if (!/(^|\.)music\.163\.com$/.test(host)) return null
  // new URL 已剥掉 `#/` 段前的路径参数：music.163.com/#/playlist?id=1 的 query
  // 挂在整体 URL 上（`#/playlist?id=1` 整段是 hash）——hash 内也解析一份
  const hashQuery = u.hash.includes('?') ? u.hash.slice(u.hash.indexOf('?') + 1) : ''
  const params = new URLSearchParams(hashQuery || u.search)
  const id = (params.get('id') ?? '').trim()
  if (!/^\d{1,20}$/.test(id)) return null
  const seg = `${u.pathname}${u.hash}`.toLowerCase()
  if (seg.includes('playlist')) return { kind: 'playlist', id }
  if (seg.includes('album')) return { kind: 'album', id }
  return null
}

function trackFrom(entry: Record<string, unknown>, fallbackAlbum = ''): PlaylistTrack | null {
  const id = entry.id
  if (id === undefined || id === null) return null
  const artists = ((entry.artists ?? entry.ar) as Array<{ name?: string }> | undefined) ?? []
  const albumObj = (entry.album ?? entry.al) as { name?: string } | undefined
  return {
    id: String(id),
    name: String(entry.name ?? ''),
    artist: artists.map((a) => a.name ?? '').join(', '),
    album: String(albumObj?.name ?? fallbackAlbum)
  }
}

/**
 * 抓取歌单/专辑曲目列表（官方公开 API；15s 超时，非 200/解析失败抛中文错误）。
 * 曲目数超上限时截断到 PLAYLIST_MAX_TRACKS（返回值不变长，截断由调用方明示）。
 */
export async function fetchMusicPlaylist(
  kind: 'playlist' | 'album',
  id: string
): Promise<MusicPlaylistInfo> {
  if (!/^\d{1,20}$/.test(id)) throw new Error('无效的歌单/专辑 ID')
  const url =
    kind === 'playlist'
      ? `https://music.163.com/api/playlist/detail?id=${id}`
      : `https://music.163.com/api/album/${id}`
  let res: Response
  try {
    res = await fetch(url, { headers: NETEASE_HEADERS, signal: AbortSignal.timeout(15_000) })
  } catch {
    throw new Error('网易云歌单接口不可达或超时，请检查网络后重试')
  }
  if (!res.ok) throw new Error(`网易云歌单接口失败（HTTP ${res.status}）`)
  // 第十轮审查（P3）：与 M5 口径对齐——响应体加 8MB 上限（此前裸 fetch + json()
  // 可被异常响应撑爆内存）
  const text = await res.text().then((t) => (t.length > 8 * 1024 * 1024 ? null : t))
  if (text === null) throw new Error('网易云歌单接口响应超过 8MB 上限（异常数据）')
  const body = ((): {
    result?: { name?: string; tracks?: Array<Record<string, unknown>>; trackCount?: number }
    album?: { name?: string; songs?: Array<Record<string, unknown>>; size?: number }
  } | null => {
    try {
      return JSON.parse(text)
    } catch {
      return null
    }
  })()
  if (!body) throw new Error('网易云歌单接口返回异常（非 JSON）')
  if (kind === 'playlist') {
    const all = (body.result?.tracks ?? [])
      .map((t) => trackFrom(t))
      .filter((t): t is PlaylistTrack => t !== null && !!t.name)
    const tracks = all.slice(0, PLAYLIST_MAX_TRACKS)
    if (!tracks.length) throw new Error('歌单为空或接口未返回曲目（歌单可能已被删除/设为隐私）')
    const total = Number(body.result?.trackCount) > 0 ? Number(body.result?.trackCount) : all.length
    return { kind, id, name: String(body.result?.name ?? `歌单 ${id}`), tracks, total }
  }
  const albumName = String(body.album?.name ?? `专辑 ${id}`)
  const all = (body.album?.songs ?? [])
    .map((t) => trackFrom(t, albumName))
    .filter((t): t is PlaylistTrack => t !== null && !!t.name)
  const tracks = all.slice(0, PLAYLIST_MAX_TRACKS)
  if (!tracks.length) throw new Error('专辑为空或接口未返回曲目')
  const total = Number(body.album?.size) > 0 ? Number(body.album?.size) : all.length
  return { kind, id, name: albumName, tracks, total }
}
