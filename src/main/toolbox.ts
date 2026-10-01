// 本地工具箱（M4-13/14，§4.7）：零 AI / 零 GPU，纯 ffmpeg DSP
// type='tool' 任务走统一队列/状态机；独立信号量（默认 2 并发，不计入下载并发）
// 产物默认落 源目录/工具箱输出/<工具名>/

import { spawn, type ChildProcess } from 'child_process'
import { mkdir, stat } from 'fs/promises'
import { basename, join } from 'path'
import type { ToolCreateInput, ToolEvent } from '@shared/types'
import { createLogger } from './logger'
import { toolPath, ensureVerified } from './orchestrator/binaries'

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
    desc: '按起止时间无损剪切片段（关键帧对齐，秒级完成）；渲染层剪辑编辑器可逐区域批量提交',
    fields: [
      { key: 'from', label: '起始(秒)', type: 'text', default: '0' },
      { key: 'duration', label: '时长(秒)', type: 'text', default: '30' }
    ],
    build: (input, outDir, params) => {
      // 数值白名单：params 来自渲染层，`-` 开头值会被 ffmpeg 当作选项
      const from = Math.min(86400 * 7, Math.max(0, Number(params.from) || 0))
      const duration = Math.min(86400 * 7, Math.max(0.1, Number(params.duration) || 30))
      // 产物名带起始时间：多区域批量提交时互不覆盖
      const out = join(outDir, `${baseName(input)}_trim_${Math.round(from)}s.mp3`)
      return {
        args: ['-y', '-ss', String(from), '-t', String(duration), '-i', input, '-c', 'copy', out],
        output: out
      }
    }
  },
  {
    id: 'trim-video',
    label: '视频剪辑',
    category: 'video',
    desc: '按起止时间无损剪切视频片段（关键帧对齐，秒级完成），音轨直拷；渲染层剪辑编辑器可预览画面并拖选多个剪辑区域',
    fields: [
      { key: 'from', label: '起始(秒)', type: 'text', default: '0' },
      { key: 'duration', label: '时长(秒)', type: 'text', default: '30' }
    ],
    build: (input, outDir, params) => {
      const from = Math.min(86400 * 7, Math.max(0, Number(params.from) || 0))
      const duration = Math.min(86400 * 7, Math.max(0.1, Number(params.duration) || 30))
      const out = join(outDir, `${baseName(input)}_clip_${Math.round(from)}s.mp4`)
      return {
        args: ['-y', '-ss', String(from), '-t', String(duration), '-i', input, '-c', 'copy', out],
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
      const out = join(outDir, `${baseName(input)}_muted.mp4`)
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
      return {
        args: ['-y', '-i', input, '-vf', mode, '-c:v', 'libx264', '-crf', '23', '-c:a', 'copy', out],
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
      return {
        args: [
          '-y', '-i', input,
          '-vf', `scale=-2:${h}:flags=lanczos`,
          '-c:v', 'libx264', '-crf', '23', '-c:a', 'copy',
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
      const out = join(outDir, `${baseName(input)}_frame_${Math.round(from)}s.jpg`)
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
          '-b:a', '320k',
          out
        ],
        output: out
      }
    }
  },
  {
    id: 'audio-tempo',
    label: '音频变速（不变调）',
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
      return { args: ['-y', '-i', input, '-af', `atempo=${s}`, '-b:a', '320k', out], output: out }
    }
  },
  {
    id: 'image-convert',
    label: '图片转换',
    category: 'common',
    desc: 'PNG / JPG / WebP 互转（ffmpeg 原生编解码，秒级完成），封面/缩略图预处理',
    fields: [{ key: 'format', label: '目标格式', type: 'select', options: ['png', 'jpg', 'webp'], default: 'webp' }],
    build: (input, outDir, params) => {
      const fmt = String(params.format ?? 'webp')
      const out = join(outDir, `${baseName(input)}.${fmt}`)
      return { args: ['-y', '-i', input, '-frames:v', '1', out], output: out }
    }
  },
  {
    // Backlog：神经网络音轨分离 L2（可选增强组件，不随包分发）
    // 遵循 §4.7 "零内置模型"原则：Demucs 运行时与模型（+200MB）由用户自装；
    // 缺席时给出明确出口动作，不静默失败。
    id: 'stem-demucs',
    label: '音轨分离（神经网络）',
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
    // 半成品清理：ffmpeg 单文件产物；demucs 为目录产物 → recursive 兼容两者
    import('fs/promises').then(({ rm }) =>
      rm(entry.output, { recursive: true, force: true }).catch(() => {})
    )
    log.info(`tool task ${taskId} cancelled, partial output removed: ${entry.output}`)
    return true
  }

  async submit(input: ToolCreateInput, taskId = ''): Promise<string> {
    // Backlog：神经网络分离走独立执行器（demucs CLI，非 ffmpeg）
    if (input.tool === 'stem-demucs') return this.submitDemucs(input, taskId)
    const def = TOOL_DEFS.find((d) => d.id === input.tool)
    if (!def) throw new Error(`未知工具：${input.tool}`)
    const outDir = join(input.saveDir ?? '.', '工具箱输出', def.label)
    await mkdir(outDir, { recursive: true })
    const { args, output } = def.build(input.sourcePath, outDir, input.params)
    log.info(`tool ${input.tool} → ${output}`)

    // 信号量：≤2 并发（§4.7，不计入下载并发）；排队者额度由释放方同步移交
    if (this.active >= MAX_TOOL_CONCURRENT) {
      await new Promise<void>((r) => this.queue.push(r))
    } else {
      this.active++
    }
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
  private async submitDemucs(input: ToolCreateInput, taskId: string): Promise<string> {
    const outDir = join(input.saveDir ?? '.', '工具箱输出', '音轨分离')
    await mkdir(outDir, { recursive: true })
    const mode = String(input.params.mode ?? '两轨(人声/伴奏)')
    const model = mode.startsWith('六轨') ? 'htdemucs_6s' : 'htdemucs'
    const args = [
      '-n', model,
      ...(mode.startsWith('两轨') ? ['--two-stems=vocals'] : []),
      // 默认 wav 输出：--mp3 依赖 lameenc，缺失即整任务失败（鲁棒性优先）
      '--out', outDir,
      input.sourcePath
    ]
    const exe = String(input.params.demucsPath ?? '').trim() || 'demucs'

    // 排队者额度由释放方同步移交（同 submit）
    if (this.active >= MAX_TOOL_CONCURRENT) {
      await new Promise<void>((r) => this.queue.push(r))
    } else {
      this.active++
    }
    this.emit({ taskId, tool: input.tool, status: 'running', message: '正在检测 Demucs 运行时…' })
    try {
      const output = await this.runDemucs(exe, args, join(outDir, model, baseName(input.sourcePath)), taskId)
      this.emit({ taskId, tool: input.tool, status: 'completed', message: output })
      return output
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.emit({ taskId, tool: input.tool, status: 'failed', message })
      throw err
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

  private runDemucs(exe: string, args: string[], outPath: string, taskId: string): Promise<string> {
    return new Promise((resolve, reject) => {
      let proc: ChildProcess
      try {
        proc = spawn(exe, args, { windowsHide: true })
      } catch (err) {
        reject(this.demucsMissingHint(err))
        return
      }
      this.procs.set(taskId, { proc, output: outPath })
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
        this.procs.delete(taskId)
        reject(this.demucsMissingHint(err))
      })
      proc.on('exit', (code) => {
        this.procs.delete(taskId)
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
        '轻量分离可改用「人声/伴奏分离（轻量）」工具（中心声道消除，零模型即时完成）'
    )
  }

  private async runFfmpeg(args: string[], output: string, taskId: string): Promise<void> {
    await ensureVerified('ffmpeg') // TOFU 强制校验
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
