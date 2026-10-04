// backlog #28（2026-10-03）：轨道提取参数规划（纯函数，单测覆盖）
// 输入 ffprobe 流清单 + 用户选择，输出完整 ffmpeg 参数（-map 与输出文件交错）。
// 音轨：流拷贝进 Matroska（.mka 可装任意音频编码，零重编码）
// 字幕轨：统一转 SRT（mov_text/ass 均可转；图形字幕 PGS/DVB/VOBSUB 无法转文本，跳过）

import { join } from 'path'
import type { StreamInfo } from './ffprobe'

/** 可转文本的字幕编码（其余视为图形字幕） */
export const TEXT_SUB_CODECS = new Set([
  'subrip',
  'srt',
  'ass',
  'ssa',
  'mov_text',
  'webvtt',
  'text',
  'dvb_teletext',
  'libaribb24'
])

export interface TrackPlan {
  /** 完整 ffmpeg 参数（输出路径已按 -map → out 交错排列） */
  args: string[]
  /** 第一个产物（output），其余进 extraOutputs */
  outputs: string[]
  /** 全部模式跳过的图形字幕条数 */
  skippedBitmap: number
}

/**
 * 规划轨道提取命令。
 * @param kind 'audio' | 'subtitle'
 * @param mode 'all' 全部轨道 | 'index' 仅指定序号（0-based，按该类型顺序）
 */
export function planTrackExtraction(
  streams: StreamInfo[],
  kind: 'audio' | 'subtitle',
  mode: 'all' | 'index',
  index: number,
  inputPath: string,
  outDir: string,
  baseName: string
): TrackPlan {
  const selected = streams.filter((s) => s.codec_type === kind)
  const label = kind === 'audio' ? '音轨' : '字幕轨'
  if (mode === 'index') {
    if (index < 0 || index >= selected.length) {
      throw new Error(
        selected.length === 0
          ? `该文件没有可提取的${label}`
          : `序号超出范围：该文件共 ${selected.length} 条${label}（序号 0-${selected.length - 1}）`
      )
    }
    const target = selected[index]!
    if (kind === 'subtitle' && !TEXT_SUB_CODECS.has(target.codec_name)) {
      throw new Error(
        `第 ${index} 条字幕轨为图形字幕（${target.codec_name}），无法导出为文本字幕。文本字幕（srt/ass/mov_text 等）方可提取`
      )
    }
    const ext = kind === 'audio' ? 'mka' : 'srt'
    const out = join(outDir, `${baseName}.track${index}.${ext}`)
    return {
      args: [
        '-y',
        '-i',
        inputPath,
        '-map',
        kind === 'audio' ? `0:a:${index}` : `0:s:${index}`,
        ...(kind === 'audio' ? ['-c:a', 'copy'] : ['-c:s', 'srt']),
        out
      ],
      outputs: [out],
      skippedBitmap: 0
    }
  }
  // 全部轨道
  if (kind === 'audio') {
    if (selected.length === 0) throw new Error('该文件没有可提取的音轨')
    const outputs = selected.map((_s, i) => join(outDir, `${baseName}.audio${i}.mka`))
    const args: string[] = ['-y', '-i', inputPath]
    for (let i = 0; i < selected.length; i++) {
      // ffmpeg 多输出：输出选项只作用于其后最近的输出文件——-c:a copy 必须放进每个
      // -map/输出对之间（第六轮审查：置于首输出之前只对第 1 条音轨生效，其余按容器
      // 默认编码器静默重编码或直接报 Automatic encoder selection failed）
      args.push('-map', `0:a:${i}`, '-c:a', 'copy', outputs[i]!)
    }
    return { args, outputs, skippedBitmap: 0 }
  }
  const textTracks = selected.filter((s) => TEXT_SUB_CODECS.has(s.codec_name))
  const skippedBitmap = selected.length - textTracks.length
  if (textTracks.length === 0) {
    throw new Error(
      selected.length === 0
        ? '该文件没有可提取的字幕轨'
        : '全部字幕轨均为图形字幕（PGS/DVB/VOBSUB），无法导出为文本字幕'
    )
  }
  // 统一转 SRT（单命令多输出共用 -c:s srt；ass 样式特效会丢失）。
  // 第六轮审查：同上——-c:s srt 同样按输出对交错排列（.srt 恰好被猜出编码器，
  // 属侥幸无害，仍统一口径）
  const outputs = textTracks.map((_s, i) => join(outDir, `${baseName}.sub${i}.srt`))
  const args: string[] = ['-y', '-i', inputPath]
  for (let i = 0; i < textTracks.length; i++) {
    // 0:s:N 按文件内字幕轨序号精确锁定（selected = 文件内全部字幕轨的顺序切片，
    // 含被跳过的图形轨时序号不发生错位）
    const ordinal = selected.indexOf(textTracks[i]!)
    args.push('-map', `0:s:${ordinal}`, '-c:s', 'srt', outputs[i]!)
  }
  return { args, outputs, skippedBitmap }
}
