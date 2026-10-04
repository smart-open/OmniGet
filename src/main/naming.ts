// 智能命名模板（M4-11，§4.3.2）：{{title}} {{uploader}} {{date}} {{index:N}}
// 三类引擎统一接入（yt-dlp -o 模板 / 音乐完成重命名 / aria2 目录口径）。

import { getSettingParsed } from './db'
import { sanitizeFilename } from '@shared/sanitize'

export const DEFAULT_TEMPLATE = '{{title}}'

export function getNamingTemplate(): string {
  const v = getSettingParsed<string>('naming.template')
  return typeof v === 'string' ? v : DEFAULT_TEMPLATE
}

/**
 * 二期（0.9.x）：音乐命名模板独立键。music.template 非空时优先于全局
 * naming.template——媒体服务器归档（Navidrome/Jellyfin 的 artist/album 目录约定）
 * 需要 `/` 目录分隔，而视频侧 toYtDlpOutputTemplate 会把 `/` 中和为 `_`，
 * 共用同一键会互相污染，故拆分。
 */
export function getMusicNamingTemplate(): string {
  const v = getSettingParsed<string>('music.template')
  if (typeof v === 'string' && v.trim()) return v
  return getNamingTemplate()
}

export interface NamingVars {
  title?: string
  uploader?: string
  /** 音乐任务：歌手（与 uploader 语义并存，模板按场景使用） */
  artist?: string
  /** 二期：专辑名（音乐任务；MusicBrainz/平台元数据有值才带） */
  album?: string
  /** 1-based 序号（合集/批量场景） */
  index?: number
}

/** 渲染模板：{{date}} = 当日；{{index:3}} = 序号补零；未知占位符原样保留 */
export function renderNamingTemplate(template: string, vars: NamingVars): string {
  const date = new Date().toISOString().slice(0, 10)
  return template.replace(/\{\{\s*(\w+)(?::(\d+))?\s*\}\}/g, (_m, key: string, pad?: string) => {
    switch (key) {
      case 'title':
        return vars.title ?? 'untitled'
      case 'uploader':
        return vars.uploader ?? 'unknown'
      case 'artist':
        return vars.artist ?? vars.uploader ?? 'unknown'
      case 'album':
        return vars.album ?? 'Unknown Album'
      case 'date':
        return date
      case 'index':
        return String(vars.index ?? 1).padStart(Number(pad) || 1, '0')
      default:
        return _m
    }
  })
}

/**
 * 二期（0.9.x 媒体服务器归档）：把渲染后的模板拆成安全相对路径段。
 * 支持 `/`（与 `\`）目录分隔（Navidrome `{{artist}}/{{album}}/{{title}}` 约定）；
 * 逐段 sanitizeName 中和非法字符，`..`/空段/绝对路径前缀全部收口：
 * 返回的段拼接后保证落在目标目录内（调用方直接 join）。
 */
export function renderNamingSegments(template: string, vars: NamingVars): string[] {
  const rendered = renderNamingTemplate(template, vars).replace(/\.{2,}/g, '.')
  const raw = rendered
    .split(/[\\/]+/)
    .map((seg) => seg.trim())
    .filter(Boolean)
    .map((seg) => sanitizeFilename(seg.replace(/[\\/]/g, '_')))
    .filter((seg) => seg && seg !== '.' && seg !== '..')
  return raw.length > 0 ? raw.slice(0, 8) : ['untitled']
}

/** yt-dlp 输出模板转换：变量映射为 yt-dlp 字段（date 落为字面当日） */
export function toYtDlpOutputTemplate(template: string): string {
  const mapped = template.replace(/\{\{\s*title\s*\}\}/g, '%(title)s').replace(
    /\{\{\s*uploader\s*\}\}/g,
    '%(uploader)s'
  )
  let rendered = renderNamingTemplate(mapped, {})
  // 防穿越：模板存于 settings，`..` 可把 yt-dlp -o 输出逃出 saveDir
  rendered = rendered.replace(/\.{2,}/g, '.').replace(/^[\\/]+/, '').replace(/[\\/]+$/, '')
  // L2 加固：中和模板中段的路由分隔符——`..` 折叠挡不住 `a/b/c` 式目录膨胀
  //（不能穿越但可在 saveDir 下制造任意深度子目录）；`\` 同理
  rendered = rendered.replace(/[\\/]/g, '_')
  return `${rendered || DEFAULT_TEMPLATE}.%(ext)s`
}
