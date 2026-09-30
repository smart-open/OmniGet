// 本地工具箱（M4-13/14，§4.7）：零 AI / 零 GPU，纯 ffmpeg DSP
// type='tool' 任务走统一队列/状态机；独立信号量（默认 2 并发，不计入下载并发）
// 产物默认落 源目录/工具箱输出/<工具名>/

import { spawn, type ChildProcess } from 'child_process'
import { mkdir, stat } from 'fs/promises'
import { basename, join } from 'path'
import type { ToolCreateInput, ToolEvent } from '@shared/types'
import { createLogger } from './logger'
import { toolPath } from './orchestrator/binaries'

const log = createLogger('toolbox')

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
  build: (inputPath: string, outDir: string, params: Record<string, unknown>) => { args: string[]; output: string }
}

function baseName(input: string): string {
  return basename(input).replace(/\.\w+$/, '')
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
      const fmt = String(params.format ?? 'mp3')
      const audio = ['mp3', 'aac', 'm4a', 'opus', 'flac', 'wav'].includes(fmt)
      const out = join(outDir, `${baseName(input)}_converted.${fmt}`)
      return {
        args: [
          '-y', '-i', input,
          ...(audio ? ['-vn', '-b:a', String(params.bitrate ?? '320k')] : ['-c:v', 'libx264', '-crf', '23']),
          out
        ],
        output: out
      }
    }
  },
  {
    id: 'trim',
    label: '音频裁剪',
    category: 'audio',
    desc: '按起止时间无损剪切片段（关键帧对齐，秒级完成）',
    fields: [
      { key: 'from', label: '起始(秒)', type: 'text', default: '0' },
      { key: 'duration', label: '时长(秒)', type: 'text', default: '30' }
    ],
    build: (input, outDir, params) => {
      const out = join(outDir, `${baseName(input)}_trim.mp3`)
      return {
        args: ['-y', '-ss', String(params.from ?? '0'), '-t', String(params.duration ?? '30'), '-i', input, '-c', 'copy', out],
        output: out
      }
    }
  },
  {
    id: 'loudnorm',
    label: '响度标准化',
    category: 'audio',
    desc: 'EBU R128 响度归一到 -14 LUFS + 峰值限制（母带轻量替代）',
    fields: [],
    build: (input, outDir) => {
      const out = join(outDir, `${baseName(input)}_loudnorm.mp3`)
      return {
        args: ['-y', '-i', input, '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11', '-b:a', '320k', out],
        output: out
      }
    }
  },
  {
    id: 'metadata',
    label: '元数据编辑',
    category: 'audio',
    desc: '写入/修改 ID3 标签（标题/艺术家/专辑），与音乐模块 LRC 联动',
    fields: [
      { key: 'title', label: '标题', type: 'text' },
      { key: 'artist', label: '艺术家', type: 'text' },
      { key: 'album', label: '专辑', type: 'text' }
    ],
    build: (input, outDir, params) => {
      const out = join(outDir, `${baseName(input)}_tagged.mp3`)
      const meta: string[] = []
      if (params.title) meta.push('-metadata', `title=${String(params.title)}`)
      if (params.artist) meta.push('-metadata', `artist=${String(params.artist)}`)
      if (params.album) meta.push('-metadata', `album=${String(params.album)}`)
      return { args: ['-y', '-i', input, ...meta, '-c', 'copy', out], output: out }
    }
  },
  {
    // M4-14 L1：中心声道消除（立体声有效；UI 标注"轻量模式"）
    id: 'voice-sep',
    label: '人声/伴奏分离（轻量）',
    category: 'audio',
    desc: '中心声道消除法，产出人声/伴奏两轨。仅立体声有效，单声道无效果；实时率约 20 倍，零模型零 GPU',
    fields: [],
    build: (input, outDir) => {
      const inst = join(outDir, `${baseName(input)}_伴奏.mp3`)
      const vocal = join(outDir, `${baseName(input)}_人声.mp3`)
      return {
        args: [
          '-y', '-i', input,
          '-af', 'pan=stereo|c0=c0-c1|c1=c1-c0', '-b:a', '320k', inst,
          '-af', 'pan=stereo|c0=0.5*c0+0.5*c1|c1=0.5*c1+0.5*c0', '-b:a', '320k', vocal
        ],
        output: inst
      }
    }
  },
  {
    id: 'compress',
    label: '视频压缩',
    category: 'video',
    desc: 'H.264 CRF 三档预设（高画质/均衡/高压缩），音轨直拷不重编码',
    fields: [{ key: 'preset', label: '档位', type: 'select', options: ['high', 'balanced', 'small'], default: 'balanced' }],
    build: (input, outDir, params) => {
      const crf = { high: '18', balanced: '23', small: '30' }[String(params.preset ?? 'balanced')] ?? '23'
      const out = join(outDir, `${baseName(input)}_compressed.mp4`)
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
    desc: '视频片段转 GIF/WebP，调色板优化防色带，帧率与宽度可选',
    fields: [
      { key: 'from', label: '起始(秒)', type: 'text', default: '0' },
      { key: 'duration', label: '时长(秒)', type: 'text', default: '5' },
      { key: 'width', label: '宽度', type: 'text', default: '480' }
    ],
    build: (input, outDir, params) => {
      const out = join(outDir, `${baseName(input)}.gif`)
      return {
        args: [
          '-y', '-ss', String(params.from ?? '0'), '-t', String(params.duration ?? '5'), '-i', input,
          '-vf', `fps=12,scale=${String(params.width ?? '480')}:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse`,
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
      const fmt = String(params.format ?? 'srt')
      const out = join(outDir, `${baseName(input)}.${fmt}`)
      return { args: ['-y', '-i', input, out], output: out }
    }
  }
]

export class ToolboxRunner {
  private active = 0
  private queue: Array<() => void> = []
  private listeners = new Set<(e: ToolEvent) => void>()
  /** 运行中的 ffmpeg 进程（按任务 id 索引，支持取消） */
  private procs = new Map<string, { proc: ChildProcess; output: string }>()

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
    if (!entry) return false
    this.procs.delete(taskId)
    entry.proc.kill()
    // 半成品清理：ffmpeg 直接写 output（无 .part），取消后产物不完整，删除
    import('fs/promises').then(({ rm }) => rm(entry.output, { force: true }).catch(() => {}))
    log.info(`tool task ${taskId} cancelled, partial output removed: ${entry.output}`)
    return true
  }

  async submit(input: ToolCreateInput, taskId = ''): Promise<string> {
    const def = TOOL_DEFS.find((d) => d.id === input.tool)
    if (!def) throw new Error(`未知工具：${input.tool}`)
    const outDir = join(input.saveDir ?? '.', '工具箱输出', def.label)
    await mkdir(outDir, { recursive: true })
    const { args, output } = def.build(input.sourcePath, outDir, input.params)
    log.info(`tool ${input.tool} → ${output}`)

    // 信号量：≤2 并发（§4.7，不计入下载并发）
    if (this.active >= MAX_TOOL_CONCURRENT) {
      await new Promise<void>((r) => this.queue.push(r))
    }
    this.active++
    this.emit({ taskId, tool: input.tool, status: 'running', message: '处理中' })
    try {
      await this.runFfmpeg(args, output, taskId)
      const size = await stat(output).then((s) => s.size).catch(() => 0)
      this.emit({ taskId, tool: input.tool, status: 'completed', message: output, bytes: size })
      return output
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.emit({ taskId, tool: input.tool, status: 'failed', message })
      throw err
    } finally {
      this.active--
      this.procs.delete(taskId)
      this.queue.shift()?.()
    }
  }

  private runFfmpeg(args: string[], output: string, taskId: string): Promise<void> {
    const ffmpeg = toolPath('ffmpeg')
    return new Promise((resolve, reject) => {
      const proc = spawn(ffmpeg, args, { windowsHide: true })
      this.procs.set(taskId, { proc, output })
      proc.stderr?.on('data', (d: Buffer) => {
        const m = /time=(\d+):(\d+):(\d+\.\d+)/.exec(String(d))
        if (m) {
          const seconds = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
          this.emit({ taskId, tool: '', status: 'progress', seconds })
        }
      })
      proc.on('exit', (code) => {
        this.procs.delete(taskId)
        stat(output)
          .then(() => (code === 0 ? resolve() : reject(new Error(`ffmpeg 退出码 ${code}`))))
          .catch(() => reject(new Error(`ffmpeg 退出码 ${code}，产物未生成`)))
      })
      proc.on('error', (err) => {
        this.procs.delete(taskId)
        reject(err)
      })
    })
  }
}

export const toolbox = new ToolboxRunner()
