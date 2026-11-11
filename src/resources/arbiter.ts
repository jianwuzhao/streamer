/**
 * 资源仲裁器（方案 §3.2）。
 *
 * 优先级：播出及安全操作 > 实时本地回答 > 反馈纠错与复盘 > 获准的后台任务。
 * 训练准入：free_vram ≥ measured_training_peak + reserve，同时资源未知
 * （探测不可用）时 fail-safe 不准入并记录原因；本组件不做任何进程终止。
 */
import type { ResourceProbe, ResourceSample } from './probe.ts'

export const TASK_PRIORITY = [
  'broadcast_safety',
  'realtime_local_answer',
  'feedback_review',
  'approved_background',
] as const

export type TaskClass = (typeof TASK_PRIORITY)[number]

export function taskRank(cls: TaskClass): number {
  const idx = TASK_PRIORITY.indexOf(cls)
  return idx >= 0 ? idx : TASK_PRIORITY.length
}

export interface TrainingAdmissionInput {
  /** 实测训练峰值显存（MB），由目标机小批次测试校准 */
  readonly measuredTrainingPeakMb: number
  /** 安全余量（MB），按游戏/画面/语音实测峰值调整 */
  readonly reserveMb: number
}

export type TrainingAdmission =
  | { readonly admit: true; readonly freeVramMb: number; readonly requiredMb: number }
  | {
      readonly admit: false
      readonly reason: 'probe_unavailable' | 'insufficient_vram'
      readonly detail: string
      readonly freeVramMb?: number
      readonly requiredMb?: number
    }

export class ResourceArbiter {
  private readonly samples: ResourceSample[] = []
  private readonly probe: ResourceProbe
  private readonly opts: { intervalMs?: number; keepSamples?: number }
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(probe: ResourceProbe, opts: { intervalMs?: number; keepSamples?: number } = {}) {
    this.probe = probe
    this.opts = opts
  }

  /** 启动周期采样（unref，不阻止进程退出）。 */
  start(): this {
    const intervalMs = this.opts.intervalMs ?? 1_000
    const tick = (): void => {
      void this.sampleOnce()
    }
    this.timer = setInterval(tick, intervalMs)
    this.timer.unref?.()
    void this.sampleOnce()
    return this
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
  }

  /** 手动采样一次（测试与按需检查共用）。 */
  async sampleOnce(): Promise<ResourceSample | null> {
    try {
      const s = await this.probe.sample()
      if (s !== null) {
        this.samples.push(s)
        const keep = this.opts.keepSamples ?? 60
        while (this.samples.length > keep) this.samples.shift()
      }
      return s
    } catch {
      return null
    }
  }

  latest(): ResourceSample | null {
    return this.samples[this.samples.length - 1] ?? null
  }

  /**
   * 训练窗口准入（§3.2）：显存未知或不足一律延后并给出原因。
   * 显存之外（CPU 回答延迟、RAM、云端预算）的完整准入在阶段 D 训练调度中补充。
   */
  evaluateTrainingAdmission(input: TrainingAdmissionInput): TrainingAdmission {
    const requiredMb = input.measuredTrainingPeakMb + input.reserveMb
    const latest = this.latest()
    if (latest === null || latest.freeVramMb === undefined) {
      return {
        admit: false,
        reason: 'probe_unavailable',
        detail: '资源探测不可用（开发机或探测失败），训练窗口 fail-safe 延后',
        requiredMb,
      }
    }
    const freeVramMb = latest.freeVramMb
    if (freeVramMb < requiredMb) {
      return {
        admit: false,
        reason: 'insufficient_vram',
        detail: `空闲显存 ${freeVramMb}MB < 需求 ${requiredMb}MB（峰值 ${input.measuredTrainingPeakMb}MB + 余量 ${input.reserveMb}MB）`,
        freeVramMb,
        requiredMb,
      }
    }
    return { admit: true, freeVramMb, requiredMb }
  }
}
