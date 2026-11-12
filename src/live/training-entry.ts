/**
 * 一键训练入口（方案 §24.3）。
 *
 * 检查合格样本 → 等待资源 → 训练中 → 验证中 → 小范围采用 → 已发布
 * 或：样本不足 / 验证未通过 / 已取消。
 * 按钮不直接替换当前服务权重（champion 不动由 TrainingScheduler 保证）；
 * 暂停学习停止新的学习写入/训练/发布/固化/个性化。
 */
import type { TrainingScheduler } from '../training/scheduler.ts'

export type TrainingEntryStatus =
  | 'checking_samples'
  | 'waiting_resource'
  | 'training'
  | 'verifying'
  | 'canary'
  | 'published'
  | 'insufficient_samples'
  | 'verification_failed'
  | 'cancelled'
  | 'learning_paused'

export interface TrainingEntryResult {
  readonly status: TrainingEntryStatus
  readonly detail: string
  readonly steps?: number
  readonly checkpointId?: string
}

export class TrainingEntry {
  private paused = false
  private inFlight: Promise<TrainingEntryResult> | null = null
  private last: TrainingEntryResult | null = null
  private readonly scheduler: TrainingScheduler

  constructor(scheduler: TrainingScheduler) {
    this.scheduler = scheduler
  }

  /** 最近一次训练结果（面板进度展示；进程内态，历史窗口见 training_runs 表）。 */
  get lastResult(): TrainingEntryResult | null {
    return this.last
  }

  /** 暂停学习（≠紧急停止播出）：停新学习写入/训练/发布。 */
  pauseLearning(): void {
    this.paused = true
  }

  resumeLearning(): void {
    this.paused = false
  }

  get learningPaused(): boolean {
    return this.paused
  }

  /** 训练一次（幂等：进行中复用同一任务）。 */
  trainOnce(opts: { mode?: 'dry_run' | 'qlora' } = {}): Promise<TrainingEntryResult> {
    if (this.paused) {
      const pausedResult: TrainingEntryResult = { status: 'learning_paused', detail: '学习已暂停：恢复学习后再训练' }
      this.last = pausedResult
      return Promise.resolve(pausedResult)
    }
    if (this.inFlight !== null) return this.inFlight
    this.inFlight = this.run(opts)
      .then((result) => {
        this.last = result
        return result
      })
      .finally(() => {
        this.inFlight = null
      })
    return this.inFlight
  }

  private async run(opts: { mode?: 'dry_run' | 'qlora' }): Promise<TrainingEntryResult> {
    const verdict = this.scheduler.evaluateOpportunity()
    if (!verdict.admit) {
      if (verdict.reason === 'insufficient_samples') {
        return { status: 'insufficient_samples', detail: verdict.detail }
      }
      if (verdict.reason === 'insufficient_vram' || verdict.reason === 'training_disabled') {
        return { status: 'waiting_resource', detail: verdict.detail }
      }
      return { status: 'verification_failed', detail: verdict.detail }
    }
    const executed = await this.scheduler.executeWindow(opts)
    if (executed.receipt === null || executed.receipt.state !== 'completed') {
      return {
        status: 'waiting_resource',
        detail: executed.receipt?.error ?? executed.verdict.admit ? '训练窗口未完成' : JSON.stringify(executed.verdict),
      }
    }
    // 训练完成 ≠ 发布：验证（阶段 E 七道门）未通过时继续使用稳定版本（§24.3）
    return {
      status: 'verifying', // 候选进入验证队列；发布由 ReleaseController 按报告决定
      detail: `完成 ${executed.receipt.steps} 步；候选待七道门验证后灰度`,
      steps: executed.receipt.steps,
      ...(executed.checkpointId !== null && executed.checkpointId !== undefined ? { checkpointId: executed.checkpointId } : {}),
    }
  }
}
