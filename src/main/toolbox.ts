// 本地工具箱（M4-13/14，§4.7）：零 AI / 零 GPU，纯 ffmpeg DSP
// type='tool' 任务走统一队列/状态机；独立信号量（默认 2 并发，不计入下载并发）
// 产物默认落 源目录/工具箱输出/<工具名>/

import { execFileSync, type ChildProcess } from 'child_process'
import { mkdir, rm, stat, writeFile } from 'fs/promises'
import { basename, extname, join } from 'path'
import type { ToolCreateInput, ToolEvent } from '@shared/types'
import { createLogger } from './logger'
import { getSettingParsed, setSetting } from './db'
import { toolPath, ensureVerified } from './orchestrator/binaries'
import { spawnTreeAware, terminateTree } from './orchestrator/proc'
import { probeStreams } from './toolbox/ffprobe'
import { planTrackExtraction } from './toolbox/track-plan'
import { lookupRecordingTags, parseNameQuery } from './toolbox/musicbrainz'

const log = createLogger('toolbox')

/** 第六轮审查：ffmpeg/demucs 兜底超时（长任务合法耗时可达数小时，取宽限值） */
const TOOL_TIMEOUT_MS = 6 * 60 * 60 * 1000

const MAX_TOOL_CONCURRENT = 2

export interface ToolDef {
  id: string
  label: string
  /** 分类（渲染层分组展示）：audio 音频 / video 视频 / common 通用 */
  category: 'audio' | 'video' | 'common'
  /** 工具说明（渲染层卡片展示） */
  desc: string
  /** 参数表单描述（渲染层据此渲染） */
  fields: Array<{ key: string; label: string; type: 'text' | 'number' | 'select'; options?: string[]; default?: string }>
  /** T4：多文件输入（渲染层允许多选；文件顺序 = 处理顺序） */
  multi?: boolean
  /** T4：附加文件选择器（如字幕文件），路径经 params[key] 传入 build */
  extraFile?: { key: string; label: string; accept: string }
  /** T5：执行运行时（默认 ffmpeg CLI；node = 纯 JS compute） */
  runtime?: 'ffmpeg' | 'node'
  /** true：不出现在渲染层工具导航（由其他工具内部调用的辅助项） */
  hidden?: boolean
  /** runtime=node：JS 执行体，返回产物路径 */
  compute?: (inputPath: string, outDir: string, params: Record<string, unknown>) => Promise<string>
  /** backlog #28/#29：允许 async build（轨道提取需 ffprobe 探流、MusicBrainz 需联网匹配后再组参） */
  build: (
    inputPath: string,
    outDir: string,
    params: Record<string, unknown>
  ) =>
    | {
        args: string[]
        output: string
        /** P2 修复：多产物工具（voice-sep 的伴奏+人声两轨）——取消时须逐个清理半成品 */
        extraOutputs?: string[]
        /** 执行前写入的辅助文件（如 concat 清单） */
        prewrite?: { path: string; content: string }
      }
    | Promise<{
        args: string[]
        output: string
        extraOutputs?: string[]
        prewrite?: { path: string; content: string }
      }>
}

function baseName(input: string): string {
  return basename(input).replace(/\.\w+$/, '')
}

/** 第七轮：在 PATH 上解析可执行文件完整路径（win 用 where / POSIX 用 which）。
 * 找不到或执行失败返回 null——调用方保持原样回退 */
function resolveOnPath(name: string): string | null {
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which'
    const out = execFileSync(cmd, [name], {
      encoding: 'utf8',
      timeout: 5_000,
      windowsHide: true
    })
    const lines = out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
    // 回归审查（疑似）：Windows 下 where 首个命中可能是 Microsoft Store 执行别名
    // stub（0 字节 reparse，pip 实际装的 Python Scripts 排在后面）——优先取非 stub 命中
    const pick = lines.find((l) => !/WindowsApps/i.test(l)) ?? lines[0]
    return pick || null
  } catch {
    return null
  }
}

/** 常见文件系统错误中文化（§4.1：用户可见文案必须中文 + 出口动作） */
function fsErrToChinese(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return '文件或目录不存在（源文件可能已被移动/删除）'
    if (code === 'EACCES' || code === 'EPERM') return '没有读写权限（尝试更换输出目录，或检查文件是否被占用）'
    if (code === 'ENOSPC') return '磁盘空间不足'
    if (code === 'EMFILE' || code === 'ENFILE') return '打开的文件过多，请稍后重试'
    if (code === 'EBUSY') return '文件被其他程序占用'
  }
  return err instanceof Error ? err.message : String(err)
}

/** T4：多文件输入解析（params.__files 来自渲染层多选，JSON 串或数组；回退单输入） */
function parseFilesParam(input: string, params: Record<string, unknown>): string[] {
  const raw = params.__files
  let list: unknown = raw
  if (typeof raw === 'string') {
    try {
      list = JSON.parse(raw)
    } catch {
      list = raw
    }
  }
  if (Array.isArray(list)) {
    const files = list.map(String).filter((f) => f.trim())
    if (files.length > 0) return files
  }
  return [input]
}

/** T6：剪辑区域解析（渲染层 JSON；排序 + 去过短段 + 上限 50） */
function parseRegions(params: Record<string, unknown>): Array<{ start: number; end: number }> {
  try {
    const raw = JSON.parse(String(params.regions ?? '[]')) as Array<{ start: number; end: number }>
    return (Array.isArray(raw) ? raw : [])
      .map((r) => ({ start: Math.max(0, Number(r?.start) || 0), end: Number(r?.end) || 0 }))
      .filter((r) => r.end - r.start >= 0.5)
      .sort((a, b) => a.start - b.start)
      .slice(0, 50)
  } catch {
    return []
  }
}

export const TOOL_DEFS: ToolDef[] = [
  {
    id: 'convert',
    label: '格式转换',
    category: 'common',
    desc: '音频/视频互转（mp3/m4a/opus/flac/wav/mp4），可选码率',
    fields: [
      { key: 'format', label: '目标格式', type: 'select', options: ['mp3', 'm4a', 'opus', 'flac', 'wav', 'mp4'], default: 'mp3' },
      { key: 'bitrate', label: '码率', type: 'select', options: ['128k', '192k', '320k'], default: '320k' }
    ],
    build: (input, outDir, params) => {
      // 第六轮审查：format 必须白名单——subtitle-convert/image-convert 同型已修，
      // 唯此处漏网：任意字符串原样拼进输出文件名可注入 ../ 路径穿越（P2）
      const fmt = ['mp3', 'm4a', 'opus', 'flac', 'wav', 'mp4'].includes(String(params.format))
        ? String(params.format)
        : 'mp3'
      const audio = ['mp3', 'aac', 'm4a', 'opus', 'flac', 'wav'].includes(fmt)
      // 数值白名单：bitrate 只允许预置档位（防选项注入）；flac/wav 无损不吃码率参数
      const bitrate = ['128k', '192k', '320k'].includes(String(params.bitrate))
        ? String(params.bitrate)
        : '320k'
      const out = join(outDir, `${baseName(input)}_converted.${fmt}`)
      return {
        args: [
          '-y', '-i', input,
          ...(audio
            ? ['-vn', ...(['flac', 'wav'].includes(fmt) ? [] : ['-b:a', bitrate])]
            : ['-c:v', 'libx264', '-crf', '23']),
          out
        ],
        output: out
      }
    }
  },
  {
    // 四期（0.11.x，roadmap「音频处理族」）：批量转码队列——多文件单任务一次提交，
    // 复用 T4 multi 通道（渲染层零增量），失败/取消逐产物清理（extraOutputs 口径）
    id: 'batch-convert',
    label: '批量转码',
    category: 'common',
    multi: true,
    desc: '多个音频/视频文件一次转码（mp3/m4a/opus/flac/wav/mp4），可选码率；每个文件独立产物落「工具箱输出」目录',
    fields: [
      { key: 'format', label: '目标格式', type: 'select', options: ['mp3', 'm4a', 'opus', 'flac', 'wav', 'mp4'], default: 'mp3' },
      { key: 'bitrate', label: '码率', type: 'select', options: ['128k', '192k', '320k'], default: '320k' }
    ],
    build: (input, outDir, params) => {
      // 白名单同单文件 convert（format 防路径穿越 / bitrate 防选项注入）
      const fmt = ['mp3', 'm4a', 'opus', 'flac', 'wav', 'mp4'].includes(String(params.format))
        ? String(params.format)
        : 'mp3'
      const audio = ['mp3', 'aac', 'm4a', 'opus', 'flac', 'wav'].includes(fmt)
      const bitrate = ['128k', '192k', '320k'].includes(String(params.bitrate))
        ? String(params.bitrate)
        : '320k'
      const files = parseFilesParam(input, params)
      // 产物名去重：不同目录同名文件（a/01.mp3 与 b/01.mp3）不得互相覆盖
      const used = new Set<string>()
      const outputs = files.map((f) => {
        const stem = baseName(f)
        let name = `${stem}_converted.${fmt}`
        for (let i = 2; used.has(name.toLowerCase()); i++) {
          name = `${stem}_converted_${i}.${fmt}`
        }
        used.add(name.toLowerCase())
        return join(outDir, name)
      })
      return {
        args: [
          '-y',
          ...files.flatMap((f) => ['-i', f]),
          // ⚠ ffmpeg 两条语义（审查修复）：①选项只作用于紧随的下一个输出——
          // 公共参数必须逐输出重复（voice-sep 同款先例），否则第 2+ 个产物拿默认参数；
          // ②默认流选择是「跨全部输入挑最优」而非「第 i 输入 → 第 i 输出」——
          // 不显式 -map 时所有产物都会取 0 号输入的流
          ...files.flatMap((_f, i) => [
            ...(audio
              ? ['-vn', ...(['flac', 'wav'].includes(fmt) ? [] : ['-b:a', bitrate])]
              : ['-c:v', 'libx264', '-crf', '23', '-b:a', bitrate]),
            ...(audio ? ['-map', `${i}:a?`] : ['-map', `${i}:v:0`, '-map', `${i}:a:0?`]),
            outputs[i]!
          ])
        ],
        output: outputs[0]!,
        extraOutputs: outputs.slice(1)
      }
    }
  },
  {
    id: 'trim',
    label: '音频裁剪',
    category: 'audio',
    desc: '按起止时间无损剪切片段（关键帧对齐，秒级完成）；剪辑编辑器支持波形拖选多区域批量提交',
    fields: [
      { key: 'from', label: '起始(秒)', type: 'text', default: '0' },
      { key: 'duration', label: '时长(秒)', type: 'text', default: '30' }
    ],
    build: (input, outDir, params) => {
      // 数值白名单：params 来自渲染层，`-` 开头值会被 ffmpeg 当作选项
      const from = Math.min(86400 * 7, Math.max(0, Number(params.from) || 0))
      const duration = Math.min(86400 * 7, Math.max(0.1, Number(params.duration) || 30))
      // 容器兼容：流拷贝要求输出容器支持源编码。mp3 源 → mp3；
      // m4a/aac → m4a；其余音频保持原扩展名；视频输入取音轨 → m4a
      const ext = extname(input).toLowerCase()
      const outExt =
        ext === '.mp3'
          ? '.mp3'
          : ext === '.aac' || ext === '.m4a'
            ? '.m4a'
            : ['.flac', '.wav', '.ogg', '.opus'].includes(ext)
              ? ext
              : '.m4a'
      // 产物名带起始时间（0.01s 精度）：多区域批量提交时互不覆盖（0.1s 粒度仍可碰撞）
      const out = join(outDir, `${baseName(input)}_trim_${from.toFixed(2)}s${outExt}`)
      return {
        args: ['-y', '-ss', String(from), '-t', String(duration), '-i', input, '-vn', '-c', 'copy', out],
        output: out
      }
    }
  },
  {
    id: 'trim-video',
    label: '视频剪辑',
    category: 'video',
    desc: '按起止时间无损剪切视频片段（关键帧对齐，秒级完成），音轨直拷；剪辑编辑器可预览画面并在时间轴拖选多个剪辑区域（支持多段合并输出）',
    fields: [
      { key: 'from', label: '起始(秒)', type: 'text', default: '0' },
      { key: 'duration', label: '时长(秒)', type: 'text', default: '30' }
    ],
    build: (input, outDir, params) => {
      const from = Math.min(86400 * 7, Math.max(0, Number(params.from) || 0))
      const duration = Math.min(86400 * 7, Math.max(0.1, Number(params.duration) || 30))
      // 容器兼容：mp4 系输入直拷 mp4；webm/mkv 等编码 mp4 容器装不下 → matroska
      const ext = extname(input).toLowerCase()
      const outExt = ['.mp4', '.m4v', '.mov'].includes(ext) ? '.mp4' : '.mkv'
      const out = join(outDir, `${baseName(input)}_clip_${from.toFixed(2)}s${outExt}`)
      return {
        args: ['-y', '-ss', String(from), '-t', String(duration), '-i', input, '-c', 'copy', out],
        output: out
      }
    }
  },
  {
    // 四期（0.11.x）：单遍 → 两遍 EBU R128（先测量后应用，linear=true 不做二次动态压缩）
    id: 'loudnorm',
    label: '响度标准化',
    category: 'audio',
    desc: 'EBU R128 响度归一到 -14 LUFS（两遍法：先完整解码测量，再 linear 模式应用，无二次动态压缩失真）。测量失败自动回退单遍动态模式',
    fields: [],
    // async build（backlog #28 范式）：第一遍测量耗时与音频时长成正比（宽限 15 分钟）
    build: async (input, outDir) => {
      const out = join(outDir, `${baseName(input)}_loudnorm.mp3`)
      const { measureLoudnorm, buildLoudnormFilter, LOUDNORM_TARGET } = await import(
        './toolbox/loudnorm-plan'
      )
      const measured = await measureLoudnorm(input)
      // -vn：渲染层 accept 含 video/*，视频源输入时 ffmpeg 默认流选择会把视频流
      // 塞进 mp3 容器 → Automatic encoder selection failed 必失败（对齐 trim 口径）
      const filter = measured
        ? buildLoudnormFilter(measured)
        : `loudnorm=I=${LOUDNORM_TARGET.I}:TP=${LOUDNORM_TARGET.TP}:LRA=${LOUDNORM_TARGET.LRA}`
      if (measured) {
        log.info(`loudnorm two-pass measured I=${measured.input_i.toFixed(2)} LUFS`)
      }
      return {
        args: ['-y', '-i', input, '-af', filter, '-vn', '-b:a', '320k', out],
        output: out
      }
    }
  },
  {
    id: 'metadata',
    label: '元数据编辑',
    category: 'audio',
    desc: '写入/修改 ID3 标签（标题/艺术家/专辑），与音乐模块 LRC 联动。输出容器跟随源文件',
    fields: [
      { key: 'title', label: '标题', type: 'text' },
      { key: 'artist', label: '艺术家', type: 'text' },
      { key: 'album', label: '专辑', type: 'text' }
    ],
    build: (input, outDir, params) => {
      // 容器兼容：此前固定 .mp3 + 流拷贝，m4a/aac/flac/wav 源会因容器不支持而失败；
      // 改为跟随源扩展名（未知类型回退 mp3 并重编码保证可用）
      const ext = extname(input).toLowerCase()
      const known = ['.mp3', '.m4a', '.aac', '.flac', '.wav', '.ogg', '.opus', '.mp4', '.mkv', '.mov', '.m4v']
      const outExt = known.includes(ext) ? ext : '.mp3'
      const out = join(outDir, `${baseName(input)}_tagged${outExt}`)
      const meta: string[] = []
      if (params.title) meta.push('-metadata', `title=${String(params.title)}`)
      if (params.artist) meta.push('-metadata', `artist=${String(params.artist)}`)
      if (params.album) meta.push('-metadata', `album=${String(params.album)}`)
      if (outExt === '.mp3' && ext !== '.mp3') {
        return { args: ['-y', '-i', input, ...meta, '-b:a', '320k', out], output: out }
      }
      return { args: ['-y', '-i', input, ...meta, '-c', 'copy', out], output: out }
    }
  },
  {
    // 四期（0.11.x，roadmap「音频处理族」）：有声书章节标记——时间轴文本 →
    // FFMETADATA → mp3（ID3v2 CHAP）/ m4a·m4b（MP4 chapter track），流拷贝秒级
    id: 'audio-chapters',
    label: '音频章节标记',
    category: 'audio',
    desc: '为有声书/长音频写入章节标记（mp3/m4a/m4b 容器）。选择时间轴文本（每行「时:分:秒 标题」，如 00:01:23 序章）；其余容器请先用格式转换转 mp3/m4a',
    extraFile: { key: 'chapters', label: '章节时间轴文本', accept: '.txt' },
    fields: [],
    // async build（backlog #28 范式）：末章 END 需 ffprobe 真实时长
    build: async (input, outDir, params) => {
      const ext = extname(input).toLowerCase()
      if (!['.mp3', '.m4a', '.m4b'].includes(ext)) {
        throw new Error('章节标记需 mp3/m4a/m4b 容器（ID3v2/MP4 章节才可写）：请先用「格式转换」转出后再标记')
      }
      const { readFile } = await import('fs/promises')
      const { parseChapterText, buildFfmetadata } = await import('./toolbox/chapter-plan')
      const text = await readFile(String(params.chapters ?? ''), 'utf8').catch(() => {
        throw new Error('无法读取章节文本文件（可能已被移动或删除）')
      })
      const chapters = parseChapterText(text)
      if (chapters.length === 0) {
        throw new Error('章节文本未解析到任何章节：每行需为「时:分:秒 标题」（如 00:01:23 序章），# 开头为注释')
      }
      // 末章 END：ffprobe 时长；探测失败回退起点+1h（封装侧按文件时长截断）
      const { probeDurationSec } = await import('./toolbox/ffprobe')
      const durMs = (await probeDurationSec(input).catch(() => null)) ?? null
      const metaPath = join(outDir, `${baseName(input)}_chapters.ffmeta.txt`)
      const out = join(outDir, `${baseName(input)}_章节${ext}`)
      return {
        args: [
          '-y', '-i', input, '-i', metaPath,
          // 审查修复：元数据保留原音频（-map_metadata 1 会用无标签的 ffmetadata
          // 覆盖 title/artist 等）；章节独立经 -map_chapters 从 ffmetadata 导入
          '-map_metadata', '0', '-map_chapters', '1',
          '-c', 'copy',
          out
        ],
        output: out,
        prewrite: { path: metaPath, content: buildFfmetadata(chapters, durMs ? Math.round(durMs * 1000) : null) }
      }
    }
  },
  {
    // M4-14 L1：中心声道消除（立体声有效；UI 标注"轻量模式"）
    id: 'voice-sep',
    label: '人声/伴奏分离',
    category: 'audio',
    desc: '中心声道消除法，产出人声/伴奏两轨。仅立体声有效，单声道无效果；实时率约 20 倍，零模型零 GPU',
    fields: [],
    build: (input, outDir) => {
      const inst = join(outDir, `${baseName(input)}_伴奏.mp3`)
      const vocal = join(outDir, `${baseName(input)}_人声.mp3`)
      return {
        args: [
          '-y', '-i', input,
          // -vn：视频源输入时防止频流被默认选择进 mp3 输出（两个输出各自需要）
          '-af', 'pan=stereo|c0=c0-c1|c1=c1-c0', '-vn', '-b:a', '320k', inst,
          '-af', 'pan=stereo|c0=0.5*c0+0.5*c1|c1=0.5*c1+0.5*c0', '-vn', '-b:a', '320k', vocal
        ],
        output: inst,
        extraOutputs: [vocal]
      }
    }
  },
  {
    id: 'compress',
    label: '视频压缩',
    category: 'video',
    desc: 'H.264 CRF 三档预设（高画质/均衡/高压缩），音轨直拷不重编码；输出容器跟随源文件',
    fields: [{ key: 'preset', label: '档位', type: 'select', options: ['high', 'balanced', 'small'], default: 'balanced' }],
    build: (input, outDir, params) => {
      const crf = { high: '18', balanced: '23', small: '30' }[String(params.preset ?? 'balanced')] ?? '23'
      // 第七轮审查 P2：容器兼容——mp4 系源直拷 mp4；webm/mkv（vorbis/opus）源
      // 音轨直拷装不进 mp4（Could not find tag for codec），跟随 matroska 容器
      const ext = extname(input).toLowerCase()
      const outExt = ['.mp4', '.m4v', '.mov'].includes(ext) ? '.mp4' : '.mkv'
      const out = join(outDir, `${baseName(input)}_compressed${outExt}`)
      return {
        args: ['-y', '-i', input, '-c:v', 'libx264', '-crf', crf, '-preset', 'medium', '-c:a', 'copy', out],
        output: out
      }
    }
  },
  {
    id: 'gif',
    label: 'GIF 截取',
    category: 'video',
    desc: '视频片段转 GIF，调色板优化防色带，帧率与宽度可选',
    fields: [
      { key: 'from', label: '起始(秒)', type: 'text', default: '0' },
      { key: 'duration', label: '时长(秒)', type: 'text', default: '5' },
      { key: 'width', label: '宽度', type: 'text', default: '480' }
    ],
    build: (input, outDir, params) => {
      // 数值白名单：from/duration/width 全部钳制，防注入 ffmpeg 选项 / 滤镜链
      const from = Math.min(86400 * 7, Math.max(0, Number(params.from) || 0))
      const duration = Math.min(600, Math.max(0.5, Number(params.duration) || 5))
      const width = Math.min(1920, Math.max(64, Math.round(Number(params.width) || 480)))
      const out = join(outDir, `${baseName(input)}.gif`)
      return {
        args: [
          '-y', '-ss', String(from), '-t', String(duration), '-i', input,
          '-vf', `fps=12,scale=${width}:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse`,
          out
        ],
        output: out
      }
    }
  },
  {
    id: 'subtitle-convert',
    label: '字幕转换',
    category: 'common',
    desc: 'srt / ass / vtt 互转（ffmpeg 原生转码，秒级完成）',
    fields: [{ key: 'format', label: '目标格式', type: 'select', options: ['srt', 'ass', 'vtt'], default: 'srt' }],
    build: (input, outDir, params) => {
      // R4-P2：format 白名单（与 convert 同口径）——原样拼接可注入 `../` 路径穿越
      const fmt = ['srt', 'ass', 'vtt'].includes(String(params.format)) ? String(params.format) : 'srt'
      const out = join(outDir, `${baseName(input)}.${fmt}`)
      return { args: ['-y', '-i', input, out], output: out }
    }
  },
  {
    // 竞品对齐（File Centipede 工具箱思路）：视频后处理轻工具族
    id: 'video-reverse',
    label: '视频倒放',
    category: 'video',
    desc: '视频画面倒放（可选保留/移除音轨同步倒放）。需逐帧解码重编码，长视频耗时与内存开销大，建议短视频片段使用',
    fields: [
      {
        key: 'audio',
        label: '音轨处理',
        type: 'select',
        options: ['保留（同步倒放）', '移除音轨'],
        default: '保留（同步倒放）'
      }
    ],
    build: (input, outDir, params) => {
      const keepAudio = String(params.audio ?? '保留（同步倒放）') !== '移除音轨'
      const out = join(outDir, `${baseName(input)}_reversed.mp4`)
      return {
        args: [
          '-y', '-i', input,
          '-vf', 'reverse',
          ...(keepAudio ? ['-af', 'areverse'] : ['-an']),
          '-c:v', 'libx264', '-crf', '23', '-preset', 'medium',
          out
        ],
        output: out
      }
    }
  },
  {
    id: 'video-mute',
    label: '移除音轨',
    category: 'video',
    desc: '去掉视频中的音频流（画面无损直拷，秒级完成），输出无声视频',
    fields: [],
    build: (input, outDir) => {
      // 容器兼容：直拷要求容器支持源编码（webm/mkv 源装不进 mp4 → matroska）
      const ext = extname(input).toLowerCase()
      const outExt = ['.mp4', '.m4v', '.mov'].includes(ext) ? '.mp4' : '.mkv'
      const out = join(outDir, `${baseName(input)}_muted${outExt}`)
      return { args: ['-y', '-i', input, '-an', '-c:v', 'copy', out], output: out }
    }
  },
  {
    id: 'video-speed',
    label: '视频变速',
    category: 'video',
    desc: '画面与音轨同步变速（不变调），重编码输出',
    fields: [
      {
        key: 'speed',
        label: '速度倍率',
        type: 'select',
        options: ['0.5', '0.75', '1.25', '1.5', '2.0'],
        default: '1.5'
      }
    ],
    build: (input, outDir, params) => {
      const s = ['0.5', '0.75', '1.25', '1.5', '2.0'].includes(String(params.speed))
        ? String(params.speed)
        : '1.5'
      const out = join(outDir, `${baseName(input)}_x${s}.mp4`)
      return {
        args: [
          '-y', '-i', input,
          '-vf', `setpts=PTS/${s}`,
          '-af', `atempo=${s}`,
          '-c:v', 'libx264', '-crf', '23', '-c:a', 'aac',
          out
        ],
        output: out
      }
    }
  },
  {
    id: 'video-rotate',
    label: '旋转/镜像',
    category: 'video',
    desc: '旋转或翻转视频画面（重编码输出），修正手机竖拍/倒置素材',
    fields: [
      {
        key: 'mode',
        label: '变换',
        type: 'select',
        options: ['90° 顺时针', '90° 逆时针', '180°', '水平镜像', '垂直镜像'],
        default: '90° 顺时针'
      }
    ],
    build: (input, outDir, params) => {
      const vf: Record<string, string> = {
        '90° 顺时针': 'transpose=1',
        '90° 逆时针': 'transpose=2',
        '180°': 'transpose=1,transpose=1',
        水平镜像: 'hflip',
        垂直镜像: 'vflip'
      }
      const mode = vf[String(params.mode ?? '90° 顺时针')] ?? 'transpose=1'
      const suffix: Record<string, string> = {
        '90° 顺时针': 'rot90',
        '90° 逆时针': 'rot270',
        '180°': 'rot180',
        水平镜像: 'hflip',
        垂直镜像: 'vflip'
      }
      const out = join(outDir, `${baseName(input)}_${suffix[String(params.mode ?? '')] ?? 'rot'}.mp4`)
      // 容器兼容：非 mp4 系源（webm/mkv 的 vorbis/opus）直拷进 mp4 容器会失败 → 转 AAC
      const mp4ish = ['.mp4', '.m4v', '.mov'].includes(extname(input).toLowerCase())
      return {
        args: [
          '-y', '-i', input, '-vf', mode,
          '-c:v', 'libx264', '-crf', '23', '-c:a', mp4ish ? 'copy' : 'aac',
          out
        ],
        output: out
      }
    }
  },
  {
    id: 'video-scale',
    label: '分辨率缩放',
    category: 'video',
    desc: '等比缩放到目标高度（lanczos 高质量缩放，宽度自动偶数对齐），压缩/适配设备屏幕',
    fields: [
      {
        key: 'height',
        label: '目标分辨率',
        type: 'select',
        options: ['1080p', '720p', '480p', '360p'],
        default: '720p'
      }
    ],
    build: (input, outDir, params) => {
      const h = { '1080p': 1080, '720p': 720, '480p': 480, '360p': 360 }[String(params.height ?? '720p')] ?? 720
      const out = join(outDir, `${baseName(input)}_${h}p.mp4`)
      // 容器兼容：非 mp4 系源（webm/mkv 的 vorbis/opus）直拷进 mp4 容器会失败 → 转 AAC
      const mp4ish = ['.mp4', '.m4v', '.mov'].includes(extname(input).toLowerCase())
      return {
        args: [
          '-y', '-i', input,
          '-vf', `scale=-2:${h}:flags=lanczos`,
          '-c:v', 'libx264', '-crf', '23', '-c:a', mp4ish ? 'copy' : 'aac',
          out
        ],
        output: out
      }
    }
  },
  {
    id: 'video-frame',
    label: '封面截图',
    category: 'video',
    desc: '从指定时间点提取一帧保存为 JPG（可作封面/缩略图），秒级完成',
    fields: [{ key: 'from', label: '时间点(秒)', type: 'text', default: '0' }],
    build: (input, outDir, params) => {
      const from = Math.min(86400 * 7, Math.max(0, Number(params.from) || 0))
      const out = join(outDir, `${baseName(input)}_frame_${from.toFixed(1)}s.jpg`)
      return {
        args: ['-y', '-ss', String(from), '-i', input, '-frames:v', '1', '-q:v', '2', out],
        output: out
      }
    }
  },
  {
    id: 'audio-fade',
    label: '淡入淡出',
    category: 'audio',
    desc: '音频首尾淡入淡出（areverse 技巧实现尾部淡出，无需知道总时长），适合铃声/串场素材',
    fields: [
      { key: 'fadeIn', label: '淡入(秒)', type: 'text', default: '2' },
      { key: 'fadeOut', label: '淡出(秒)', type: 'text', default: '2' }
    ],
    build: (input, outDir, params) => {
      const fi = Math.min(30, Math.max(0.1, Number(params.fadeIn) || 2))
      const fo = Math.min(30, Math.max(0.1, Number(params.fadeOut) || 2))
      const out = join(outDir, `${baseName(input)}_fade.mp3`)
      return {
        args: [
          '-y', '-i', input,
          '-af', `afade=t=in:st=0:d=${fi},areverse,afade=t=in:st=0:d=${fo},areverse`,
          '-vn', // 视频源输入时防止频流被默认选择进 mp3 输出
          '-b:a', '320k',
          out
        ],
        output: out
      }
    }
  },
  {
    id: 'audio-tempo',
    label: '音频变速',
    category: 'audio',
    desc: '调整播放速度而保持音高（atempo），适合倍速听课/慢速跟练',
    fields: [
      {
        key: 'tempo',
        label: '速度倍率',
        type: 'select',
        options: ['0.5', '0.75', '1.25', '1.5', '2.0'],
        default: '1.25'
      }
    ],
    build: (input, outDir, params) => {
      const s = ['0.5', '0.75', '1.25', '1.5', '2.0'].includes(String(params.tempo))
        ? String(params.tempo)
        : '1.25'
      const out = join(outDir, `${baseName(input)}_x${s}.mp3`)
      return { args: ['-y', '-i', input, '-af', `atempo=${s}`, '-vn', '-b:a', '320k', out], output: out }
    }
  },
  {
    id: 'image-convert',
    label: '图片转换',
    category: 'common',
    desc: 'PNG / JPG / WebP 互转（ffmpeg 原生编解码，秒级完成），封面/缩略图预处理',
    fields: [{ key: 'format', label: '目标格式', type: 'select', options: ['png', 'jpg', 'webp'], default: 'webp' }],
    build: (input, outDir, params) => {
      // R4-P2：format 白名单（与 convert 同口径）——原样拼接可注入 `../` 路径穿越
      const fmt = ['png', 'jpg', 'webp'].includes(String(params.format)) ? String(params.format) : 'webp'
      const out = join(outDir, `${baseName(input)}.${fmt}`)
      return { args: ['-y', '-i', input, '-frames:v', '1', out], output: out }
    }
  },
  {
    // T4：多文件无损拼接（concat demuxer，流拷贝）
    id: 'concat',
    label: '视频/音频拼接',
    category: 'video',
    desc: '把多个媒体文件按选择顺序无损拼接（concat demuxer，流拷贝，秒级）。要求各段编码参数一致；多选文件时顺序即拼接顺序',
    multi: true,
    fields: [],
    build: (input, outDir, params) => {
      const files = parseFilesParam(input, params)
      // L-2 加固：换行可注入任意 concat 清单指令行（file/duration/流选项）——fail-closed 拒绝
      if (files.some((f) => /[\r\n]/.test(f))) {
        throw new Error('文件路径包含换行符，无法生成拼接清单（请重命名文件后重试）')
      }
      const listPath = join(outDir, `${baseName(input)}_concat.txt`)
      // concat 清单格式：file '<路径>'；单引号转义 ' → '\''
      const content = files
        .map((f) => `file '${f.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`)
        .join('\n')
      // 输出容器跟随第一段：音频扩展名用原容器，否则 mp4
      const ext = extname(files[0] ?? input).toLowerCase()
      const audioOut = ['.mp3', '.m4a', '.aac', '.flac', '.wav', '.ogg', '.opus'].includes(ext)
      const out = join(outDir, `${baseName(input)}_concat${audioOut ? ext : '.mp4'}`)
      return {
        args: ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', out],
        output: out,
        prewrite: { path: listPath, content }
      }
    }
  },
  {
    // T4：字幕烧录（第二输入 = 字幕文件）
    id: 'subtitles-burn',
    label: '字幕烧录',
    category: 'video',
    desc: '把 srt/ass/vtt 字幕硬压进画面（重编码输出）。需在参数中选择字幕文件；Windows 含特殊字符路径建议先移至纯英文路径',
    extraFile: { key: 'subtitle', label: '字幕文件', accept: '.srt,.ass,.vtt' },
    fields: [],
    build: (input, outDir, params) => {
      const sub = String(params.subtitle ?? '')
      // ffmpeg 滤镜文件名转义：\ → /、: ' , ; [ ] → \x（L-3：未转义 , ; [ ] 可在 -vf
      // 中注入额外滤镜节点/链分隔符，破坏滤镜语义）
      const esc = sub
        .replace(/\\/g, '/')
        .replace(/:/g, '\\:')
        .replace(/'/g, "\\'")
        .replace(/[,;[\]]/g, (ch) => `\\${ch}`)
      const filter = sub.toLowerCase().endsWith('.ass') ? `ass=${esc}` : `subtitles=${esc}`
      const out = join(outDir, `${baseName(input)}_subbed.mp4`)
      // 容器兼容：非 mp4 系源（webm/mkv 的 vorbis/opus）直拷进 mp4 容器会失败 → 转 AAC
      const mp4ish = ['.mp4', '.m4v', '.mov'].includes(extname(input).toLowerCase())
      return {
        args: [
          '-y', '-i', input, '-vf', filter,
          '-c:v', 'libx264', '-crf', '23', '-c:a', mp4ish ? 'copy' : 'aac',
          out
        ],
        output: out
      }
    }
  },
  {
    // T6：多区域剪辑合并（filter_complex 单命令完成 trim+concat）
    // hidden：不出现在工具导航，由剪辑编辑器「合并为单个文件」自动提交
    id: 'region-concat',
    label: '多区域合并',
    category: 'video',
    desc: '按剪辑编辑器标记的多个区域一次裁剪并无缝合并为单一输出（单命令 filter_complex；视频重编码 H.264，音频转 AAC）',
    hidden: true,
    fields: [],
    build: async (input, outDir, params) => {
      const regions = parseRegions(params)
      if (regions.length === 0) {
        throw new Error('缺少有效剪辑区域（每段至少 0.5 秒，最多 50 段）')
      }
      const media = String(params.media ?? 'video') === 'audio' ? 'audio' : 'video'
      if (media === 'audio') {
        const chains = regions
          .map((r, i) => `[0:a]atrim=start=${r.start}:end=${r.end},asetpts=PTS-STARTPTS[a${i}]`)
          .join(';')
        const fc = `${chains};${regions.map((_, i) => `[a${i}]`).join('')}concat=n=${regions.length}:v=0:a=1[aout]`
        const out = join(outDir, `${baseName(input)}_clip_merged.mp3`)
        return {
          args: ['-y', '-i', input, '-filter_complex', fc, '-map', '[aout]', '-b:a', '320k', out],
          output: out
        }
      }
      const vchains = regions
        .map((r, i) => `[0:v]trim=start=${r.start}:end=${r.end},setpts=PTS-STARTPTS[v${i}]`)
        .join(';')
      // 第七轮审查 P2：无音轨视频（video-mute 工具的存在证明这是常见输入）——
      // 硬引用 [0:a] 会让 filtergraph 报 "matches no streams" 整单失败。
      // ffprobe 探流降级为纯视频 concat（探测失败按有音轨处理，保持旧行为）
      let hasAudio = true
      try {
        hasAudio = (await probeStreams(input)).some((s) => s.codec_type === 'audio')
      } catch (err) {
        log.warn(
          `region-concat probeStreams failed (assume audio present): ${err instanceof Error ? err.message : String(err)}`
        )
      }
      if (!hasAudio) {
        const fc = `${vchains};${regions
          .map((_, i) => `[v${i}]`)
          .join('')}concat=n=${regions.length}:v=1:a=0[vout]`
        const out = join(outDir, `${baseName(input)}_clip_merged.mp4`)
        return {
          args: ['-y', '-i', input, '-filter_complex', fc, '-map', '[vout]', '-c:v', 'libx264', '-crf', '23', out],
          output: out
        }
      }
      const achains = regions
        .map((r, i) => `[0:a]atrim=start=${r.start}:end=${r.end},asetpts=PTS-STARTPTS[a${i}]`)
        .join(';')
      const sel = regions.map((_, i) => `[v${i}][a${i}]`).join('')
      const fc = `${vchains};${achains};${sel}concat=n=${regions.length}:v=1:a=1[vout][aout]`
      const out = join(outDir, `${baseName(input)}_clip_merged.mp4`)
      return {
        args: [
          '-y', '-i', input, '-filter_complex', fc,
          '-map', '[vout]', '-map', '[aout]',
          '-c:v', 'libx264', '-crf', '23', '-c:a', 'aac',
          out
        ],
        output: out
      }
    }
  },
  {
    // T5：种子创建（node 运行时；输入可为单文件或整个目录）
    id: 'torrent-create',
    label: '种子创建',
    category: 'common',
    desc: '把本地文件或整个文件夹制作为 .torrent（逐片 SHA1，输出 infohash/磁力信息）。Tracker 可留空（纯 DHT 分发）；目录模式递归打包全部文件',
    fields: [{ key: 'announce', label: 'Tracker URL（可选）', type: 'text', default: '' }],
    runtime: 'node',
    build: () => ({ args: [], output: '' }),
    compute: async (inputPath, outDir, params) => {
      const { createTorrent } = await import('./torrent/create')
      const r = await createTorrent(
        inputPath,
        join(outDir, `${basename(inputPath)}.torrent`),
        { announce: String(params.announce ?? '').trim() || undefined }
      )
      log.info(`torrent ${r.outPath} infohash=${r.infohash} files=${r.fileCount}`)
      return r.outPath
    }
  },
  {
    // T5：从已有 .torrent 提取磁力链接（infohash + 名称 + tracker）
    id: 'torrent-magnet',
    label: '种子转磁力',
    category: 'common',
    desc: '从 .torrent 提取磁力链接（infohash + 名称 + Tracker）并输出为 txt，秒级完成',
    fields: [],
    runtime: 'node',
    build: () => ({ args: [], output: '' }),
    compute: async (inputPath, outDir) => {
      const { magnetFromTorrent } = await import('./torrent/create')
      if (!/\.torrent$/i.test(inputPath)) throw new Error('输入必须是 .torrent 文件')
      const magnet = await magnetFromTorrent(inputPath)
      const out = join(outDir, `${baseName(inputPath)}_magnet.txt`)
      await writeFile(out, magnet + '\n', 'utf8')
      return out
    }
  },
  {
    // T5：校验和计算（node 运行时，流式 hash 不占内存）
    id: 'checksum',
    label: '校验和计算',
    category: 'common',
    desc: '计算文件 SHA256 / SHA1 / MD5 校验和并输出校验文件（内容格式与 sha256sum 一致，可直接用于 -c 校验）',
    fields: [
      { key: 'algorithm', label: '算法', type: 'select', options: ['sha256', 'sha1', 'md5'], default: 'sha256' }
    ],
    runtime: 'node',
    build: () => ({ args: [], output: '' }),
    compute: async (inputPath, outDir, params) => {
      const { createHash } = await import('crypto')
      const { createReadStream } = await import('fs')
      const { pipeline } = await import('stream/promises')
      const { writeFile } = await import('fs/promises')
      const algo = ['sha256', 'sha1', 'md5'].includes(String(params.algorithm))
        ? String(params.algorithm)
        : 'sha256'
      const hash = createHash(algo)
      await pipeline(createReadStream(inputPath), hash) // 流式：大文件不进内存
      const digest = hash.digest('hex')
      const out = join(outDir, `${baseName(inputPath)}.${algo}`)
      await writeFile(out, `${digest}  ${basename(inputPath)}\n`, 'utf8')
      return out
    }
  },
  {
    // backlog #28（2026-10-03）：轨道提取（MKVToolNix 范式，ffmpeg -map 流拷贝零新依赖）
    id: 'track-extract',
    label: '轨道提取',
    category: 'video',
    desc: '把视频内的音轨/字幕轨导出为独立文件（流拷贝零重编码，秒级）。音轨 → mka（任意编码可装）；字幕轨 → srt（ass 特效样式会丢失；PGS/DVB 图形字幕不支持）',
    fields: [
      { key: 'kind', label: '轨道类型', type: 'select', options: ['音轨', '字幕轨'], default: '音轨' },
      { key: 'scope', label: '提取范围', type: 'select', options: ['全部轨道', '指定序号'], default: '全部轨道' },
      { key: 'index', label: '轨道序号（0 起，仅「指定序号」时生效）', type: 'text', default: '0' }
    ],
    // async build：先 ffprobe 探流（序号越界/图形字幕在参数期即报错，不浪费一次执行额度）
    build: async (input, outDir, params) => {
      const kind = String(params.kind ?? '音轨') === '字幕轨' ? 'subtitle' : 'audio'
      const mode = String(params.scope ?? '全部轨道') === '指定序号' ? 'index' : 'all'
      const index = Math.max(0, Math.min(31, Math.round(Number(params.index) || 0)))
      const streams = await probeStreams(input)
      const plan = planTrackExtraction(streams, kind, mode, index, input, outDir, baseName(input))
      if (plan.skippedBitmap > 0) {
        log.info(`track-extract: skipped ${plan.skippedBitmap} bitmap subtitle track(s)`)
      }
      return {
        args: plan.args,
        output: plan.outputs[0]!,
        extraOutputs: plan.outputs.slice(1)
      }
    }
  },
  {
    // backlog #28（2026-10-03）：外挂字幕封装（MKVToolNix 范式，流拷贝秒级）
    id: 'subtitle-mux',
    label: '外挂字幕封装',
    category: 'video',
    desc: '视频 + srt/ass 字幕封装为 mkv/mp4 软字幕（流拷贝，秒级，不重编码）。mp4 容器字幕自动转 mov_text；mkv 原样直拷',
    extraFile: { key: 'subtitle', label: '字幕文件', accept: '.srt,.ass,.ssa,.vtt' },
    fields: [
      { key: 'container', label: '封装容器', type: 'select', options: ['mkv', 'mp4'], default: 'mkv' },
      { key: 'lang', label: '字幕语言代码（可选，如 chi / eng）', type: 'text', default: '' }
    ],
    build: (input, outDir, params) => {
      const container = String(params.container) === 'mp4' ? 'mp4' : 'mkv'
      // 语言代码白名单：ISO 639 两/三字母（白名单外静默忽略，防选项注入）
      const lang = /^[a-z]{2,3}$/i.test(String(params.lang ?? '').trim())
        ? String(params.lang).trim().toLowerCase()
        : null
      const out = join(outDir, `${baseName(input)}_muxed.${container}`)
      return {
        args: [
          '-y', '-i', input, '-i', String(params.subtitle ?? ''),
          '-map', '0', '-map', '1',
          '-c', 'copy',
          ...(container === 'mp4' ? ['-c:s', 'mov_text'] : []),
          ...(lang ? ['-metadata:s:s:0', `language=${lang}`] : []),
          out
        ],
        output: out
      }
    }
  },
  {
    // backlog #29（2026-10-03）：MusicBrainz 标签补全（工具箱过渡路线，不引入 beets/Python）
    id: 'musicbrainz-tag',
    label: '标签补全',
    category: 'audio',
    desc: '按「歌手 - 曲名」（可从文件名自动解析）查询 MusicBrainz 公开 API，把标题/歌手/专辑/日期写入音频标签（流拷贝，不改音频数据）。需联网；未命中时给出重试建议',
    fields: [
      { key: 'artist', label: '歌手（留空自动从文件名解析）', type: 'text', default: '' },
      { key: 'title', label: '曲名（留空自动从文件名解析）', type: 'text', default: '' }
    ],
    // async build：先联网匹配再组参（产物名锚定输入文件名——第七轮审查 P3：
    // 网络数据做产物名会让两个不同源文件命中同一录音时静默互相覆盖）
    build: async (input, outDir, params) => {
      const parsed = parseNameQuery(baseName(input))
      const artist = String(params.artist ?? '').trim() || parsed.artist
      const title = String(params.title ?? '').trim() || parsed.title
      if (!title) throw new Error('无法确定曲名：请在参数中填写曲名（文件名不含有效曲名）')
      const tags = await lookupRecordingTags(artist, title)
      const ext = extname(input).toLowerCase()
      const known = ['.mp3', '.m4a', '.aac', '.flac', '.wav', '.ogg', '.opus']
      if (!known.includes(ext)) {
        throw new Error('仅支持音频文件（mp3/m4a/aac/flac/wav/ogg/opus）')
      }
      const out = join(outDir, `${baseName(input)}_tagged${ext}`)
      const meta: string[] = []
      if (tags.title) meta.push('-metadata', `title=${tags.title}`)
      if (tags.artist) meta.push('-metadata', `artist=${tags.artist}`)
      if (tags.album) meta.push('-metadata', `album=${tags.album}`)
      if (tags.date) meta.push('-metadata', `date=${tags.date}`)
      return { args: ['-y', '-i', input, ...meta, '-c', 'copy', out], output: out }
    }
  },
  {
    // backlog #30（2026-10-03）：OpenSubtitles 字幕匹配（工具箱过渡路线，不引入 Bazarr）
    id: 'subtitle-fetch',
    label: '字幕匹配',
    category: 'common',
    desc: '按文件哈希在 OpenSubtitles 内容级精确匹配字幕，保存到视频同目录（zip/gzip 自动解包）。需自备免费 API Key（api.opensubtitles.com 注册）；免费账号每日查询/下载配额有限',
    fields: [
      { key: 'apiKey', label: 'API Key（注册后获取）', type: 'text', default: '' },
      { key: 'languages', label: '字幕语言（逗号分隔，如 zh,en）', type: 'text', default: 'zh' }
    ],
    runtime: 'node',
    build: () => ({ args: [], output: '' }),
    compute: async (inputPath, _outDir, params) => {
      // 四期（0.11.x）：参数留空回退 safeStorage 凭据通道（设置页保存，同 #26 口径）
      let apiKey = String(params.apiKey ?? '').trim()
      if (!apiKey) {
        const creds = await import('./opensubtitles/credentials')
        apiKey = creds.getOpensubtitlesKey() ?? ''
      }
      if (!apiKey) {
        throw new Error('未配置 OpenSubtitles API Key：请在 设置 → 下载 →「OpenSubtitles 字幕匹配」保存（api.opensubtitles.com 免费注册），或在本参数中填写')
      }
      const languages = /^[a-z]{2,3}(,[a-z]{2,3})*$/i.test(String(params.languages ?? '').trim())
        ? String(params.languages).trim().toLowerCase()
        : 'zh'
      const { stat, open } = await import('fs/promises')
      const { fetchSubtitleForVideo, saveSubtitleBesideVideo } = await import('./toolbox/subtitle-fetch')
      const size = (await stat(inputPath)).size
      // 首/尾各 64KB（官方哈希口径；小文件允许头尾重叠）
      const CHUNK = 65536
      const head = Buffer.alloc(CHUNK)
      const tail = Buffer.alloc(CHUNK)
      const fh = await open(inputPath, 'r')
      try {
        await fh.read(head, 0, CHUNK, 0)
        await fh.read(tail, 0, CHUNK, Math.max(0, size - CHUNK))
      } finally {
        await fh.close()
      }
      const sub = await fetchSubtitleForVideo(size, head, tail, apiKey, languages)
      // 落盘到视频同目录（播放器可自动加载）；重名不覆盖，追加序号
      const out = await saveSubtitleBesideVideo(inputPath, sub.body, languages.split(',')[0] ?? 'zh')
      log.info(`subtitle-fetch: saved ${out} (release=${sub.release ?? 'unknown'})`)
      return out
    }
  },
  {
    // Backlog：神经网络音轨分离 L2（可选增强组件，不随包分发）
    // 遵循 §4.7 "零内置模型"原则：Demucs 运行时与模型（+200MB）由用户自装；
    // 缺席时给出明确出口动作，不静默失败。
    id: 'stem-demucs',
    label: 'AI 音轨分离',
    category: 'audio',
    desc: 'Demucs 分离：两轨（人声/伴奏）或四/六轨全分离。属可选增强组件——需自行安装 Python 并 `pip install demucs`（模型约 +200MB），CPU 处理 4 分钟歌曲约需数分钟；未安装时会给出安装指引',
    fields: [
      {
        key: 'mode',
        label: '分离档位',
        type: 'select',
        options: ['两轨(人声/伴奏)', '四轨(人声/伴奏/鼓/贝斯)', '六轨(+钢琴/吉他)'],
        default: '两轨(人声/伴奏)'
      },
      { key: 'demucsPath', label: 'demucs 可执行文件路径（留空 = 从 PATH 查找）', type: 'text' }
    ],
    // 不走 ffmpeg：由 ToolboxRunner.submit 分支到 runDemucs
    build: () => ({ args: [], output: '' })
  },
  {
    // 三期（0.10.x，backlog #23）：B站弹幕 xml → ASS（BBDown 范式）
    id: 'danmaku-convert',
    label: '弹幕转换',
    category: 'video',
    desc: 'B站弹幕 XML 转 ASS 字幕（滚动/底部/顶部车道分配，可作压制输入）',
    runtime: 'node',
    fields: [
      { key: 'width', label: '画布宽度', type: 'number', default: '1920' },
      { key: 'fontSize', label: '基准字号', type: 'number', default: '38' },
      { key: 'opacity', label: '不透明度(1-100)', type: 'number', default: '100' }
    ],
    compute: async (inputPath, outDir, params) => {
      const { readFile, writeFile } = await import('fs/promises')
      const { xmlToAss } = await import('./danmaku/convert')
      const clampInt = (v: unknown, min: number, max: number, dflt: number): number => {
        const n = Math.round(Number(v))
        return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt
      }
      const xml = await readFile(inputPath, 'utf8')
      // 审查加固：错误输入此前会静默产出仅含头的空 ASS 并报成功——必须显式报错
      const { parseDanmakuXml } = await import('./danmaku/convert')
      if (parseDanmakuXml(xml).length === 0) {
        throw new Error('未解析到任何弹幕（请确认输入是B站弹幕 XML 文件）')
      }
      const ass = xmlToAss(xml, {
        width: clampInt(params.width, 320, 7680, 1920),
        fontSize: clampInt(params.fontSize, 12, 200, 38),
        opacity: clampInt(params.opacity, 1, 100, 100)
      })
      const out = join(outDir, `${baseName(inputPath)}.ass`)
      await writeFile(out, ass, 'utf8')
      return out
    },
    build: () => ({ args: [], output: '' }) // runtime=node 不走 ffmpeg（compute 兜底声明）
  }
]

export class ToolboxRunner {
  private active = 0
  private queue: Array<() => void> = []
  private listeners = new Set<(e: ToolEvent) => void>()
  /** 运行中的 ffmpeg 进程（按任务 id 索引，支持取消） */
  private procs = new Map<
    string,
    { proc: ChildProcess; output: string; tool: string; extraOutputs: string[] }
  >()
  /** node 运行时任务（纯 JS compute 无法强杀，登记取消标记 + 产物路径） */
  private nodeTasks = new Map<string, { output: string; cancelled: boolean; tool: string }>()
  /** L3 修复：取消标记——terminateTree（组信号/taskkill）不置 proc.killed，
   * exit 判定取消改用本集合（跨平台口径一致） */
  private cancelled = new Set<string>()
  /** P1 修复：排队中（等待信号量）的任务登记——此前 cancel 对排队任务恒 false，
   * 删除任务后 ffmpeg/node 照常执行，软删任务还会被"复活"为 completed */
  private queuedTasks = new Map<string, { tool: string; cancelled: boolean }>()
  /** 四期审查：构建期（async build，如两遍响度测量的完整解码/ffprobe 时长探测，
   * 可达数分钟）任务登记——此窗口内任务不在 procs/queuedTasks，cancel 恒 false
   * 且无法中断测量，任务记录已删但 ffmpeg 照跑 */
  private building = new Set<string>()

  onEvent(cb: (e: ToolEvent) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private emit(e: ToolEvent): void {
    for (const cb of this.listeners) cb(e)
  }

  /** 取消运行中的工具任务：杀 ffmpeg 进程并删除半成品产物 */
  cancel(taskId: string): boolean {
    const entry = this.procs.get(taskId)
    if (entry) {
      // R4-P3：不立即删 procs 表项——取消完成窗口内的二次 cancel 此前恒 false
      //（UI 误报「取消失败」）；表项由 submit finally / 进程 exit 清理
      // L3 修复：先落取消标记（terminateTree 不置 proc.killed，Unix 上组信号
      // SIGTERM 终止后 exit 判定取消必须靠本标记，而非「ffmpeg 退出码 null」误导）
      this.cancelled.add(taskId)
      // M7 修复：树终止 + 等 exit 后再删半成品——Windows 上 ffmpeg 尚持句柄时
      // 立即 rm 会 EBUSY 被静默吞掉，产物残留
      terminateTree(entry.proc, 3000)
      const exited = new Promise<void>((resolve) => {
        if (entry.proc.exitCode !== null || entry.proc.signalCode !== null) resolve()
        else entry.proc.once('exit', () => resolve())
      })
      void exited.then(() =>
        // 半成品清理：ffmpeg 单/多产物（voice-sep 为伴奏+人声两轨）；demucs 为目录产物 → recursive 兼容
        import('fs/promises').then(({ rm }) =>
          Promise.all(
            [entry.output, ...entry.extraOutputs].map((p) =>
              rm(p, { recursive: true, force: true }).catch(() => {})
            )
          )
        )
      )
      log.info(`tool task ${taskId} cancelled, partial output removed: ${entry.output}`)
      return true
    }
    // P2 修复：node 运行时任务（torrent-create/checksum/torrent-magnet）此前不在
    // 进程表 → cancel 恒 false，大目录任务无法取消。登记后标记取消 + 清产物
    const node = this.nodeTasks.get(taskId)
    if (node) {
      node.cancelled = true
      // ⚠ 只删真实产物（node.output 为空 = compute 未完成，产物未知）。
      // 严禁 rm 整个 outDir——那会连带删除该工具的历史产物
      if (node.output) {
        import('fs/promises').then(({ rm }) =>
          rm(node.output, { recursive: true, force: true }).catch(() => {})
        )
      }
      this.emit({ taskId, tool: node.tool, status: 'failed', message: '任务已取消' })
      log.info(`tool(node) task ${taskId} cancelled`)
      return true
    }
    // P1 修复：排队中的任务——标记取消，起跑复核（acquireSlot）会放弃执行
    const queued = this.queuedTasks.get(taskId)
    if (queued) {
      queued.cancelled = true
      log.info(`tool task ${taskId} cancelled while queued`)
      return true
    }
    // 四期审查：构建期任务——标记取消，submit 在 build 返回后复核放弃（spawn 前）
    if (taskId && this.building.has(taskId)) {
      this.cancelled.add(taskId)
      log.info(`tool task ${taskId} cancelled while building`)
      return true
    }
    return false
  }

  /**
   * P1 修复：信号量获取 + 排队取消复核。
   * 排队期间任务可被 cancel() 标记；拿到额度后复核，已取消则移交额度并返回 false，
   * 调用方必须直接放弃执行（不得触碰 this.active）。
   */
  private async acquireSlot(taskId: string, tool: string): Promise<boolean> {
    const entry = { tool, cancelled: false }
    if (taskId) this.queuedTasks.set(taskId, entry)
    try {
      if (this.active >= MAX_TOOL_CONCURRENT) {
        await new Promise<void>((r) => this.queue.push(r))
      } else {
        this.active++
      }
    } finally {
      if (taskId) this.queuedTasks.delete(taskId)
    }
    if (entry.cancelled) {
      // 排队期间被取消：移交额度给下一个排队者
      this.active--
      const next = this.queue.shift()
      if (next) {
        this.active++
        next()
      }
      this.emit({ taskId, tool, status: 'failed', message: '任务已取消' })
      return false
    }
    return true
  }

  async submit(
    input: ToolCreateInput,
    taskId = ''
  ): Promise<{ output: string; extraOutputs: string[] }> {
    // Backlog：神经网络分离走独立执行器（demucs CLI，非 ffmpeg）
    if (input.tool === 'stem-demucs') return this.submitDemucs(input, taskId)
    const def = TOOL_DEFS.find((d) => d.id === input.tool)
    if (!def) throw new Error(`未知工具：${input.tool}`)
    // T4：附加文件必选校验（如字幕烧录的字幕文件）
    if (def.extraFile && !String(input.params[def.extraFile.key] ?? '').trim()) {
      throw new Error(`请选择${def.extraFile.label}`)
    }
    const outDir = join(input.saveDir ?? '.', '工具箱输出', def.label)
    try {
      await mkdir(outDir, { recursive: true })
    } catch (err) {
      const message = `无法创建输出目录：${fsErrToChinese(err)}`
      this.emit({ taskId, tool: input.tool, status: 'failed', message })
      log.error(`tool ${input.tool} mkdir failed: ${outDir}`, { error: String(err) })
      throw new Error(message)
    }
    // T5：node 运行时工具（纯 JS，不经 ffmpeg CLI）
    if (def.runtime === 'node' && def.compute) {
      if (!(await this.acquireSlot(taskId, input.tool))) throw new Error('任务已取消')
      this.emit({ taskId, tool: input.tool, status: 'running', message: '处理中' })
      // 登记 node 任务（支持取消）；output 置空——取消时只删真实产物，
      // 严禁 rm 整个 outDir（会连带删除历史产物）
      const nodeEntry = { output: '', cancelled: false, tool: input.tool }
      if (taskId) this.nodeTasks.set(taskId, nodeEntry)
      try {
        const output = await def.compute(input.sourcePath, outDir, input.params)
        if (nodeEntry.cancelled) {
          // 取消发生在 compute 进行中：删掉刚产出的产物再报「已取消」
          await rm(output, { force: true }).catch(() => {})
          throw new Error('任务已取消')
        }
        nodeEntry.output = output
        const size = await stat(output).then((s) => s.size).catch(() => 0)
        this.emit({ taskId, tool: input.tool, status: 'completed', message: output, bytes: size })
        return { output, extraOutputs: [] }
      } catch (err) {
        if (!nodeEntry.cancelled) {
          const message = fsErrToChinese(err)
          this.emit({ taskId, tool: input.tool, status: 'failed', message })
          log.error(`tool(node) ${input.tool} failed`, { error: String(err) })
          throw new Error(message)
        }
        throw err
      } finally {
        this.nodeTasks.delete(taskId)
        // 额度同步移交被唤醒者（同 ffmpeg 路径：先减后移，防插队突破并发上限）
        this.active--
        const next = this.queue.shift()
        if (next) {
          this.active++
          next()
        }
      }
    }
    // 信号量：≤2 并发（§4.7，不计入下载并发）；排队者额度由释放方同步移交。
    // 四期审查修复：acquireSlot 前移到 build 之前——async build（两遍响度测量的
    // 完整解码，可达数分钟）此前不受 MAX_TOOL_CONCURRENT 约束，N 个 loudnorm
    // 任务 = N 路并发 ffmpeg 全量解码
    if (!(await this.acquireSlot(taskId, input.tool))) throw new Error('任务已取消')
    let prewrite: { path: string; content: string } | undefined
    try {
      // 参数构建失败（如多区域剪辑无有效区域）也必须广播 failed 事件，不静默
      let built: Awaited<ReturnType<ToolDef['build']>>
      if (taskId) this.building.add(taskId)
      try {
        built = await def.build(input.sourcePath, outDir, input.params)
      } finally {
        if (taskId) this.building.delete(taskId)
      }
      // 四期审查：构建期被取消（如两遍响度测量进行中删除任务）——spawn 前复核放弃，
      // 不再为已删任务白跑数分钟转码（测量进程本身有 15min 兜底超时，自然终止）
      if (taskId && this.cancelled.delete(taskId)) throw new Error('任务已取消')
      const { args, output, extraOutputs } = built
      prewrite = built.prewrite
      log.info(`tool ${input.tool} → ${output}`)
      // R4-P3：prewrite 在 acquireSlot 之后写——排队中被取消的任务不再留下
      // 无人清理的 concat 清单；审查修复：写盘入 try——磁盘满/EACCES 此前会
      // 直接逃逸跳过 finally → 并发信号量泄漏，两次即令工具队列永久卡死
      if (prewrite) {
        await writeFile(prewrite.path, prewrite.content, 'utf8')
      }
      // 第六轮审查：emit running 与 procs.set 的实际顺序相反（spawn 在 runFfmpeg
      // 内部才发生）——窗口内 cancel 恒 false 但进程照跑。改为 spawn 登记后回调 emit
      await this.runFfmpeg(args, output, taskId, input.tool, extraOutputs ?? [], () =>
        this.emit({ taskId, tool: input.tool, status: 'running', message: '处理中' })
      )
      const size = await stat(output).then((s) => s.size).catch(() => 0)
      this.emit({ taskId, tool: input.tool, status: 'completed', message: output, bytes: size })
      log.info(`tool ${input.tool} completed: ${output} (${size} bytes)`)
      // 四期审查：全产物返回——多产物工具（批量转码/voice-sep）的第 2..N 产物
      // 也须落 task_files，否则「彻底删除（含文件）」漏删
      return { output, extraOutputs: extraOutputs ?? [] }
    } catch (err) {
      this.cancelled.delete(taskId) // 取消标记随终态清理（防集合残留污染 exit 判定）
      const message = err instanceof Error ? err.message : String(err)
      this.emit({ taskId, tool: input.tool, status: 'failed', message })
      log.error(`tool ${input.tool} failed: ${message}`)
      throw new Error(message)
    } finally {
      // R4-P3：临时清单文件（concat 的 *_concat.txt）任务终态后清理，不留产物目录
      if (prewrite) {
        await rm(prewrite.path, { force: true }).catch(() => {})
      }
      // P2 加固：额度同步移交被唤醒者（新 submit 在间隙内插队会突破并发上限）
      this.active--
      this.procs.delete(taskId)
      const next = this.queue.shift()
      if (next) {
        this.active++
        next()
      }
    }
  }

  /** Backlog：Demucs 神经网络音轨分离（可选增强组件执行器） */
  private async submitDemucs(
    input: ToolCreateInput,
    taskId: string
  ): Promise<{ output: string; extraOutputs: string[] }> {
    const outDir = join(input.saveDir ?? '.', '工具箱输出', '音轨分离')
    try {
      await mkdir(outDir, { recursive: true })
    } catch (err) {
      const message = `无法创建输出目录：${fsErrToChinese(err)}`
      this.emit({ taskId, tool: input.tool, status: 'failed', message })
      log.error(`stem-demucs mkdir failed: ${outDir}`, { error: String(err) })
      throw new Error(message)
    }
    const mode = String(input.params.mode ?? '两轨(人声/伴奏)')
    const model = mode.startsWith('六轨') ? 'htdemucs_6s' : 'htdemucs'
    const args = [
      '-n', model,
      ...(mode.startsWith('两轨') ? ['--two-stems=vocals'] : []),
      // 默认 wav 输出：--mp3 依赖 lameenc，缺失即整任务失败（鲁棒性优先）
      '--out', outDir,
      input.sourcePath
    ]
    // 安全校验：demucsPath 来自渲染层，basename 必须为 demucs（防渲染层借道执行任意二进制）
    const exeRaw = String(input.params.demucsPath ?? '').trim()
    // 第七轮：TOFU 指纹闸门收敛为单一路径——用户填路径与 PATH 解析（where/which
    // 还原完整路径）走同一闸门，消除「填路径=受管、走 PATH=免检」的双标信任口径
    const verifyDemucsFingerprint = async (exePath: string): Promise<void> => {
      // 第六轮审查（P1）：basename 校验可被「改名 demucs.exe 的任意二进制」绕过，
      // 是全 IPC 面唯一无信任锚的 spawn 入口。补 TOFU 指纹：首次使用登记 SHA256，
      // 此后不一致即拒绝（合法升级需删除设置键 toolbox.demucs.fingerprint 重置）。
      // 指纹键不进渲染层写白名单，渲染层无法篡改
      const { createHash } = await import('crypto')
      const { readFile } = await import('fs/promises')
      let fingerprint: string
      try {
        fingerprint = createHash('sha256').update(await readFile(exePath)).digest('hex')
      } catch (err) {
        const message = `无法读取 demucs 可执行文件：${fsErrToChinese(err)}`
        this.emit({ taskId, tool: input.tool, status: 'failed', message })
        throw new Error(message)
      }
      const stored = getSettingParsed<string>('toolbox.demucs.fingerprint')
      if (stored && stored !== fingerprint) {
        const message =
          'demucs 可执行文件与首次使用时登记的指纹不一致，已拦截执行。如确认是合法升级（非替换的恶意二进制），请在工具箱的「人声/伴奏分离」工具页点击「重置二进制信任」后重试'
        this.emit({ taskId, tool: input.tool, status: 'failed', message })
        throw new Error(message)
      }
      if (!stored) setSetting('toolbox.demucs.fingerprint', JSON.stringify(fingerprint))
    }
    let exe = 'demucs'
    if (exeRaw) {
      if (!/^demucs(\.exe)?$/i.test(basename(exeRaw))) {
        const message = 'demucs 可执行文件路径无效：文件名必须为 demucs 或 demucs.exe'
        this.emit({ taskId, tool: input.tool, status: 'failed', message })
        throw new Error(message)
      }
      await verifyDemucsFingerprint(exeRaw)
      exe = exeRaw
    } else {
      // 留空走 PATH：解析出完整路径纳入同一 TOFU 闸门（解析失败保持原样，由
      // runDemucs 的 spawn ENOENT 给出友好报错）
      const resolved = resolveOnPath('demucs')
      if (resolved) {
        await verifyDemucsFingerprint(resolved)
        exe = resolved
      }
    }

    // 排队者额度由释放方同步移交（同 submit）
    if (!(await this.acquireSlot(taskId, input.tool))) throw new Error('任务已取消')
    try {
      const output = await this.runDemucs(
        exe,
        args,
        join(outDir, model, baseName(input.sourcePath)),
        taskId,
        () => this.emit({ taskId, tool: input.tool, status: 'running', message: '正在检测 Demucs 运行时…' })
      )
      this.emit({ taskId, tool: input.tool, status: 'completed', message: output })
      log.info(`stem-demucs completed: ${output}`)
      return { output, extraOutputs: [] }
    } catch (err) {
      const message = fsErrToChinese(err)
      this.emit({ taskId, tool: input.tool, status: 'failed', message })
      log.error(`stem-demucs failed: ${message}`)
      throw new Error(message)
    } finally {
      // P2 加固：同 submit——额度同步移交被唤醒者
      this.active--
      this.procs.delete(taskId)
      const next = this.queue.shift()
      if (next) {
        this.active++
        next()
      }
    }
  }

  private runDemucs(
    exe: string,
    args: string[],
    outPath: string,
    taskId: string,
    onSpawn?: () => void
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      let proc: ChildProcess
      try {
        proc = spawnTreeAware(exe, args)
      } catch (err) {
        reject(this.demucsMissingHint(err))
        return
      }
      this.procs.set(taskId, { proc, output: outPath, tool: 'stem-demucs', extraOutputs: [] })
      onSpawn?.()
      // 第六轮审查：与 runFfmpeg 同口径加兜底超时（demucs CPU 推理可合法耗时数小时，
      // 取宽限值）——离线网络盘/僵尸进程此前会无限占住并发槽
      const timer = setTimeout(() => {
        this.cancelled.add(taskId)
        terminateTree(proc, 3000)
        reject(new Error('Demucs 执行超时（6 小时），任务已终止'))
      }, TOOL_TIMEOUT_MS)
      const clearTimer = (): void => clearTimeout(timer)
      let stderrTail = ''
      proc.stderr?.on('data', (d: Buffer) => {
        stderrTail = (stderrTail + String(d)).slice(-2000)
        // demucs 进度条形如 `  45%|████▌  | 12/27 [00:31<00:38]`
        const m = /(\d{1,3})%\|/.exec(String(d))
        if (m) {
          this.emit({ taskId, tool: 'stem-demucs', status: 'progress', message: `神经网络分离 ${m[1]}%` })
        }
      })
      proc.on('error', (err) => {
        clearTimer()
        this.procs.delete(taskId)
        reject(this.demucsMissingHint(err))
      })
      proc.on('exit', (code) => {
        clearTimer()
        this.procs.delete(taskId)
        // L3：取消用 cancelled 集合判定（与 ffmpeg 路径口径一致）
        if (this.cancelled.delete(taskId)) {
          reject(new Error('任务已取消'))
          return
        }
        if (code === 0) {
          resolve(outPath)
        } else {
          reject(
            new Error(
              `demucs 退出码 ${code}。${stderrTail.trim().split('\n').pop() ?? ''}（提示：确认已 pip install demucs；CPU 分离较慢属正常）`
            )
          )
        }
      })
    })
  }

  /** 缺席时的明确出口动作（不静默失败，§4.1） */
  private demucsMissingHint(err: unknown): Error {
    void err
    return new Error(
      '未检测到 Demucs 运行时。音轨分离 L2 属可选增强组件（模型 +200MB，遵循"零内置模型"原则未随包分发）：' +
        '请安装 Python 并执行 `pip install demucs`，或将 demucs 可执行文件完整路径填入参数后重试；' +
        '轻量分离可改用「人声/伴奏分离」工具（中心声道消除，零模型即时完成）'
    )
  }

  private async runFfmpeg(
    args: string[],
    output: string,
    taskId: string,
    tool: string,
    extraOutputs: string[] = [],
    onSpawn?: () => void
  ): Promise<void> {
    await ensureVerified('ffmpeg') // TOFU 强制校验
    const ffmpeg = toolPath('ffmpeg')
    return new Promise((resolve, reject) => {
      const proc = spawnTreeAware(ffmpeg, args)
      // 第六轮审查：spawn 登记进程表后再回调 emit running——原注释声称的顺序与
      // 实际相反，窗口内 cancel 返回 false 但进程照跑
      this.procs.set(taskId, { proc, output, tool, extraOutputs })
      onSpawn?.()
      // 第六轮审查：兜底超时（ffprobe 30s 口径不适用于正式转码；长视频转码可合法
      // 耗时数小时，取宽限值）——离线网络盘/坏扇区此前会无限占住并发槽
      const timer = setTimeout(() => {
        this.cancelled.add(taskId)
        terminateTree(proc, 3000)
        reject(new Error('工具执行超时（6 小时），任务已终止。文件可能位于离线网络盘或已损坏'))
      }, TOOL_TIMEOUT_MS)
      const clearTimer = (): void => clearTimeout(timer)
      let stderrTail = ''
      proc.stderr?.on('data', (d: Buffer) => {
        const text = String(d)
        stderrTail = (stderrTail + text).slice(-2000)
        const m = /time=(\d+):(\d+):(\d+\.\d+)/.exec(text)
        if (m) {
          const seconds = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
          this.emit({ taskId, tool, status: 'progress', seconds })
        }
      })
      proc.on('exit', (code) => {
        clearTimer()
        this.procs.delete(taskId)
        // 取消（L3：跨平台用 cancelled 集合判定，不依赖 proc.killed）：不报「退出码」误导用户
        if (this.cancelled.delete(taskId) || proc.killed) {
          reject(new Error('任务已取消'))
          return
        }
        // 原生 stderr 尾行一并带出（容器不支持等诊断上下文）
        const tail = stderrTail.trim().split('\n').pop() ?? ''
        const hint = tail && !tail.includes('time=') ? `：${tail.slice(-200)}` : ''
        stat(output)
          .then(() => (code === 0 ? resolve() : reject(new Error(`ffmpeg 退出码 ${code}${hint}`))))
          .catch(() => reject(new Error(`ffmpeg 退出码 ${code}，产物未生成${hint}`)))
      })
      proc.on('error', (err) => {
        clearTimer()
        this.procs.delete(taskId)
        reject(err)
      })
    })
  }
}

export const toolbox = new ToolboxRunner()
