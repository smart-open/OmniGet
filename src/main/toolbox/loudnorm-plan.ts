// 四期（0.11.x）：EBU R128 两遍响度归一（工具箱 loudnorm 升级）。
// 两遍法 = 第一遍完整解码测量（print_format=json）→ 第二遍 linear=true 应用测量值，
// 避免 loudnorm 默认动态模式对流内响度变化做二次动态压缩（有声书/音乐母带场景失真）。
// 纯函数（单测）：测量结果解析 + 第二遍滤镜参数构建；执行封装 measureLoudnorm。

import { ensureVerified, toolPath } from '../orchestrator/binaries'
import { spawnTreeAware, terminateTree } from '../orchestrator/proc'

export interface LoudnormMeasure {
  input_i: number
  input_tp: number
  input_lra: number
  input_thresh: number
  /** 目标档位下的偏移（ffmpeg 一并下发，linear 模式建议回传） */
  target_offset: number
}

/** 目标响度档（与旧版单遍口径一致：Spotify/YouTube 生态主流 -14 LUFS） */
export const LOUDNORM_TARGET = { I: -14, TP: -1.5, LRA: 11 } as const

/**
 * 纯函数（单测覆盖）：从 ffmpeg 第一遍 stderr 解析测量 JSON。
 * 取最后一个含 input_i 的 JSON 块（stderr 可能混入横幅/进度杂项）；
 * -inf/-NaN 等非有限值视为无效（极短/静音输入），返回 null 由调用方回退单遍。
 */
export function parseLoudnormMeasure(stderr: string): LoudnormMeasure | null {
  const matches = [...stderr.matchAll(/\{[^{}]*"input_i"[^{}]*\}/g)]
  const last = matches[matches.length - 1]
  if (!last) return null
  try {
    const obj = JSON.parse(last[0]) as Record<string, unknown>
    const input_i = Number(obj.input_i)
    const input_tp = Number(obj.input_tp)
    const input_lra = Number(obj.input_lra)
    const input_thresh = Number(obj.input_thresh)
    const target_offset = Number(obj.target_offset ?? 0)
    if (![input_i, input_tp, input_thresh, target_offset].every(Number.isFinite)) return null
    // LRA 允许 0（单稳态信号）；非有限才拒绝
    if (!Number.isFinite(input_lra)) return null
    return { input_i, input_tp, input_lra, input_thresh, target_offset }
  } catch {
    return null
  }
}

/** 数值钳制到合理量级（防解析异常值原样注入滤镜参数） */
function clampMeasure(v: number, min: number, max: number): string {
  return Math.min(max, Math.max(min, v)).toFixed(2)
}

/** 纯函数（单测覆盖）：由测量值构建第二遍 loudnorm 滤镜参数（linear 模式） */
export function buildLoudnormFilter(m: LoudnormMeasure): string {
  return [
    `loudnorm=I=${LOUDNORM_TARGET.I}`,
    `TP=${LOUDNORM_TARGET.TP}`,
    `LRA=${LOUDNORM_TARGET.LRA}`,
    `measured_I=${clampMeasure(m.input_i, -70, 0)}`,
    `measured_TP=${clampMeasure(m.input_tp, -9, 25)}`,
    `measured_LRA=${clampMeasure(m.input_lra, 0, 90)}`,
    `measured_thresh=${clampMeasure(m.input_thresh, -70, 0)}`,
    `offset=${clampMeasure(m.target_offset, -35, 35)}`,
    'linear=true'
  ].join(':')
}

const MEASURE_TIMEOUT_MS = 15 * 60 * 1000

/**
 * 第一遍测量：完整解码跑 loudnorm print_format=json，返回测量值。
 * 任何失败（ffmpeg 缺席/超时/解析失败）返回 null——调用方回退单遍动态模式，
 * 不判任务失败（测量只是增益质量的优化路径）。
 */
export async function measureLoudnorm(inputPath: string): Promise<LoudnormMeasure | null> {
  try {
    await ensureVerified('ffmpeg')
  } catch {
    return null
  }
  return new Promise((resolve) => {
    const args = [
      '-hide_banner',
      '-nostats',
      '-i',
      inputPath,
      '-vn', // 审查修复：视频源测量只解码音轨（响度与视频流无关，白耗时）
      '-af',
      `loudnorm=I=${LOUDNORM_TARGET.I}:TP=${LOUDNORM_TARGET.TP}:LRA=${LOUDNORM_TARGET.LRA}:print_format=json`,
      '-f',
      'null',
      '-'
    ]
    let proc: ReturnType<typeof spawnTreeAware>
    try {
      proc = spawnTreeAware(toolPath('ffmpeg'), args)
    } catch {
      resolve(null)
      return
    }
    let stderr = ''
    proc.stderr?.on('data', (d: Buffer) => {
      stderr = (stderr + String(d)).slice(-8000)
    })
    const timer = setTimeout(() => {
      terminateTree(proc, 1000)
      resolve(null)
    }, MEASURE_TIMEOUT_MS)
    proc.on('error', () => {
      clearTimeout(timer)
      resolve(null)
    })
    proc.on('exit', (code) => {
      clearTimeout(timer)
      resolve(code === 0 ? parseLoudnormMeasure(stderr) : null)
    })
  })
}
