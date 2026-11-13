/**
 * 资源探测（方案 §3.2：每秒采集显存、RAM、GPU 利用率与进程存活状态）。
 *
 * 开发机（无 NVIDIA GPU）返回 null → 资源未知时训练准入 fail-safe 为「不准入」。
 * 不提供任何「杀进程释放显存」的能力（§3.2：不得通过杀死直播进程释放资源）。
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { freemem, totalmem } from 'node:os'

const execFileAsync = promisify(execFile)

export interface ResourceSample {
  readonly timestampMs: number
  readonly totalVramMb?: number
  readonly usedVramMb?: number
  readonly freeVramMb?: number
  readonly gpuUtilPct?: number
  readonly usedRamMb?: number
}

export interface ResourceProbe {
  readonly id: string
  sample(): Promise<ResourceSample | null>
}

/** 目标机（RTX 4060 Ti / NVIDIA 驱动）：nvidia-smi 查询。 */
export class NvidiaSmiProbe implements ResourceProbe {
  readonly id = 'nvidia-smi'

  async sample(): Promise<ResourceSample | null> {
    try {
      const { stdout } = await execFileAsync('nvidia-smi', [
        '--query-gpu=memory.total,memory.used,memory.free,utilization.gpu',
        '--format=csv,noheader,nounits',
      ])
      const line = stdout.trim().split('\n')[0]
      if (line === undefined) return null
      const parts = line.split(',').map((s) => Number.parseFloat(s.trim()))
      const [totalVramMb, usedVramMb, freeVramMb, gpuUtilPct] = parts
      if (
        totalVramMb === undefined ||
        usedVramMb === undefined ||
        freeVramMb === undefined ||
        gpuUtilPct === undefined ||
        parts.some((n) => Number.isNaN(n))
      ) {
        return null
      }
      const usedRamMb = Math.round((totalmem() - freemem()) / 1024 / 1024)
      return { timestampMs: Date.now(), totalVramMb, usedVramMb, freeVramMb, gpuUtilPct, usedRamMb }
    } catch {
      return null
    }
  }
}

/** 开发机/探测不可用：显存未知（RAM 仍可观测）。 */
export class UnknownGpuProbe implements ResourceProbe {
  readonly id = 'unknown'

  async sample(): Promise<ResourceSample | null> {
    return {
      timestampMs: Date.now(),
      usedRamMb: Math.round((totalmem() - freemem()) / 1024 / 1024),
    }
  }
}
