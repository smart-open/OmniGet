// 文件分类（按扩展名）：视频 / 音乐 / 图片 / 文档 / 其他
// 供 Inspector 文件清单与新建任务文件树做分类筛选与快捷选择。

export type FileCategory = 'video' | 'music' | 'image' | 'doc' | 'other'

export const FILE_CATEGORIES: Array<{ id: FileCategory | 'all'; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'video', label: '视频' },
  { id: 'music', label: '音乐' },
  { id: 'image', label: '图片' },
  { id: 'doc', label: '文档' },
  { id: 'other', label: '其他' }
]

const EXT_MAP: Record<string, FileCategory> = {}
const register = (cat: FileCategory, exts: string[]): void => {
  for (const e of exts) EXT_MAP[e] = cat
}
register('video', ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v', 'ts', 'mpg', 'mpeg', 'rmvb', 'rm', '3gp', 'vob'])
register('music', ['mp3', 'flac', 'wav', 'aac', 'm4a', 'opus', 'ogg', 'wma', 'ape', 'aiff', 'alac'])
register('image', ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'heic', 'heif', 'tiff', 'ico'])
register('doc', ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md', 'epub', 'mobi', 'nfo', 'srt', 'ass', 'ssa', 'vtt', 'csv', 'log'])

/** 按文件名（含扩展名）分类 */
export function fileCategory(name: string): FileCategory {
  const dot = name.lastIndexOf('.')
  if (dot < 0) return 'other'
  const ext = name.slice(dot + 1).toLowerCase()
  return EXT_MAP[ext] ?? 'other'
}
