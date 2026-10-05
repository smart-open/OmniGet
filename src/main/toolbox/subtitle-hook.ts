// 四期（0.11.x，roadmap「OpenSubtitles 字幕自动匹配升级为入库钩子」）：
// 视频任务完成登记后自动按文件哈希匹配字幕并落盘视频旁（fire-and-forget）。
// API Key 走 safeStorage 凭据通道（opensubtitles/credentials.ts，同 #26 口径）；
// 未配置 Key 直接跳过（功能门控在设置 video.subtitleHook）。

import { stat, open } from 'fs/promises'
import { fetchSubtitleForVideo, saveSubtitleBesideVideo } from './subtitle-fetch'
import { getOpensubtitlesKey } from '../opensubtitles/credentials'

/** 语言参数白名单（与工具箱 subtitle-fetch 同口径） */
export function normalizeSubtitleLanguages(raw: unknown): string {
  return /^[a-z]{2,3}(,[a-z]{2,3})*$/i.test(String(raw ?? '').trim())
    ? String(raw).trim().toLowerCase()
    : 'zh'
}

/**
 * 入库钩子主体：返回落盘字幕路径；无 Key 返回 null（静默跳过），
 * API 侧错误向上抛（调用方留痕，不阻断任务完成链）。
 */
export async function autoFetchSubtitle(videoPath: string, languages: string): Promise<string | null> {
  const apiKey = getOpensubtitlesKey()
  if (!apiKey) return null
  const size = (await stat(videoPath)).size
  // 首/尾各 64KB（官方哈希口径；小文件允许头尾重叠）
  const CHUNK = 65536
  const head = Buffer.alloc(CHUNK)
  const tail = Buffer.alloc(CHUNK)
  const fh = await open(videoPath, 'r')
  try {
    await fh.read(head, 0, CHUNK, 0)
    await fh.read(tail, 0, CHUNK, Math.max(0, size - CHUNK))
  } finally {
    await fh.close()
  }
  const sub = await fetchSubtitleForVideo(size, head, tail, apiKey, languages)
  return saveSubtitleBesideVideo(videoPath, sub.body, languages.split(',')[0] ?? 'zh', sub.fileName)
}
