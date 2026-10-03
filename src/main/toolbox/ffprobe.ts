// backlog #28（2026-10-03）：ffprobe 流探测（轨道提取工具需要先知道有哪些音轨/字幕轨）

import { toolPath } from '../orchestrator/binaries'
import { spawnTreeAware } from '../orchestrator/proc'

export interface StreamInfo {
  index: number
  /** audio / subtitle / video */
  codec_type: string
  codec_name: string
}

interface FfprobeJson {
  streams?: Array<{ index?: number; codec_type?: string; codec_name?: string }>
}

/** 探测媒体文件流清单（ffprobe JSON）。失败抛出带出口动作的中文错误 */
export function probeStreams(inputPath: string): Promise<StreamInfo[]> {
  return new Promise((resolve, reject) => {
    const args = ['-v', 'error', '-show_streams', '-of', 'json', inputPath]
    const proc = spawnTreeAware(toolPath('ffprobe'), args)
    let stdout = ''
    let stderrTail = ''
    proc.stdout?.on('data', (d: Buffer) => {
      stdout += String(d)
    })
    proc.stderr?.on('data', (d: Buffer) => {
      stderrTail = (stderrTail + String(d)).slice(-500)
    })
    proc.on('error', (err) => reject(err))
    proc.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`ffprobe 退出码 ${code}${stderrTail ? `：${stderrTail.trim()}` : ''}`))
        return
      }
      try {
        const json = JSON.parse(stdout || '{}') as FfprobeJson
        const streams = (json.streams ?? [])
          .map((s, i) => ({
            index: Number(s.index ?? i),
            codec_type: String(s.codec_type ?? ''),
            codec_name: String(s.codec_name ?? '')
          }))
          .filter((s) => s.codec_type === 'audio' || s.codec_type === 'subtitle')
        resolve(streams)
      } catch (err) {
        reject(new Error(`ffprobe 输出解析失败：${err instanceof Error ? err.message : String(err)}`))
      }
    })
  })
}
