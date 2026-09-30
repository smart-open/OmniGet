// 智能命名模板（M4-11，§4.3.2）：{{title}} {{uploader}} {{date}} {{index:N}}
// 三类引擎统一接入（yt-dlp -o 模板 / 音乐完成重命名 / aria2 目录口径）。

import { getSetting } from './db'

export const DEFAULT_TEMPLATE = '{{title}}'

export function getNamingTemplate(): string {
  return getSetting('naming.template') ?? DEFAULT_TEMPLATE
}

export interface NamingVars {
  title?: string
  uploader?: string
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
      case 'date':
        return date
      case 'index':
        return String(vars.index ?? 1).padStart(Number(pad) || 1, '0')
      default:
        return _m
    }
  })
}

/** yt-dlp 输出模板转换：变量映射为 yt-dlp 字段（date 落为字面当日） */
export function toYtDlpOutputTemplate(template: string): string {
  const mapped = template.replace(/\{\{\s*title\s*\}\}/g, '%(title)s').replace(
    /\{\{\s*uploader\s*\}\}/g,
    '%(uploader)s'
  )
  const rendered = renderNamingTemplate(mapped, {})
  return `${rendered.replace(/[\\/]+$/, '')}.%(ext)s`
}
