// backlog #29（2026-10-03）：MusicBrainz 公开 API 补标签（工具箱过渡路线，不引入 beets）
// WS 2 免费开放（需显式 User-Agent；限速 1 req/s——单文件单请求不触及）

export interface MusicTags {
  title?: string
  artist?: string
  album?: string
  date?: string
}

interface MbRecording {
  score?: number
  title?: string
  'artist-credit'?: Array<{ name?: string; joinphrase?: string }>
  releases?: Array<{ title?: string; date?: string }>
  'first-release-date'?: string
}

/** 文件名 → 查询词：'Artist - Title' 双段解析；单段仅作曲名 */
export function parseNameQuery(rawName: string): { artist?: string; title: string } {
  const name = rawName.replace(/\.(\w{2,5})$/, '').replace(/[_]+/g, ' ').trim()
  const dash = name.indexOf(' - ')
  if (dash > 0) {
    const artist = name.slice(0, dash).trim()
    const title = name.slice(dash + 3).trim()
    if (artist && title) return { artist, title }
  }
  return { title: name }
}

/** MusicBrainz recording 响应 → 标签集（纯函数，单测覆盖） */
export function tagsFromRecording(rec: MbRecording): MusicTags {
  return {
    title: rec.title || undefined,
    artist: rec['artist-credit']?.[0]?.name || undefined,
    album: rec.releases?.[0]?.title || undefined,
    date: rec['first-release-date'] || rec.releases?.[0]?.date || undefined
  }
}

/**
 * 查询 MusicBrainz 并取最佳匹配（score 最高的首条）。
 * 未命中 / 网络失败抛出带出口动作的中文错误。
 */
export async function lookupRecordingTags(
  artist: string | undefined,
  title: string
): Promise<MusicTags> {
  const query = artist
    ? `artist:"${artist}" AND recording:"${title}"`
    : `recording:"${title}"`
  const url = `https://musicbrainz.org/ws/2/recording?query=${encodeURIComponent(query)}&fmt=json&limit=5`
  let res: Response
  try {
    res = await fetch(url, {
      headers: {
        Accept: 'application/json',
        // MusicBrainz 强制要求 UA（缺失 403）
        'User-Agent': 'OmniGet/0.1.0 (https://github.com/OmniGet/OmniGet)'
      },
      signal: AbortSignal.timeout(10_000)
    })
  } catch {
    throw new Error('MusicBrainz 查询失败：网络不可达或超时，请检查网络后重试')
  }
  if (res.status === 503) {
    throw new Error('MusicBrainz 限流（HTTP 503），请稍等几秒后重试')
  }
  if (!res.ok) {
    throw new Error(`MusicBrainz 查询失败（HTTP ${res.status}）`)
  }
  const body = (await res.json()) as { recordings?: MbRecording[] }
  const best = (body.recordings ?? []).find((r) => typeof r?.title === 'string')
  if (!best) {
    throw new Error(
      `MusicBrainz 未找到匹配录音：「${artist ? `${artist} - ` : ''}${title}」。可手动填写歌手/曲名后重试`
    )
  }
  return tagsFromRecording(best)
}
