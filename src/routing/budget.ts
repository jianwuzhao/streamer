/**
 * 请求预算与播出去重键（方案 §4.2）。
 *
 * - 初始本地候选预算 5s、总实时决策预算 12s、约 1.5s 预留检查及播出提交；
 * - 检索、CPU 尝试、本地修复、技能执行及第三方请求共享预算，
 *   不同阶段不能各自重新获得完整超时；
 * - request_id + generation_epoch 防止迟到本地结果和云端结果重复播出。
 */
import type { DafeiyuConfigType } from '../config.ts'

export class BudgetExpiredError extends Error {
  constructor() {
    super('请求总预算已耗尽')
    this.name = 'BudgetExpiredError'
  }
}
export interface BudgetSpec {
  readonly totalDeadlineMs: number
  readonly localAttemptMs: number
  readonly outputReserveMs: number
}

export function budgetSpecFromConfig(cfg: DafeiyuConfigType): BudgetSpec {
  return {
    totalDeadlineMs: cfg.models.totalDeadlineMs,
    localAttemptMs: cfg.models.localAttemptMs,
    outputReserveMs: cfg.models.outputReserveMs,
  }
}

/** 单次逻辑请求的共享预算（可注入毫秒时钟便于测试）。 */
export class RequestBudget {
  private readonly t0: number
  private readonly spec: BudgetSpec
  private readonly now: () => number
  private readonly controller = new AbortController()
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(spec: BudgetSpec, now: () => number = () => Date.now()) {
    this.spec = spec
    this.now = now
    this.t0 = now()
  }

  /** 启动真实总超时计时器（unref，不阻止进程退出）。 */
  start(): this {
    const remaining = this.spec.totalDeadlineMs - (this.now() - this.t0)
    if (remaining > 0) {
      this.timer = setTimeout(() => this.controller.abort(new BudgetExpiredError()), remaining)
      this.timer.unref?.()
    } else {
      this.controller.abort(new BudgetExpiredError())
    }
    return this
  }

  get signal(): AbortSignal {
    return this.controller.signal
  }

  elapsedMs(): number {
    return this.now() - this.t0
  }

  /** 距总截止的剩余毫秒（可为负）。 */
  remainingMs(): number {
    return this.spec.totalDeadlineMs - this.elapsedMs()
  }

  /** 扣除播出预留后可用于生成的毫秒。 */
  availableForGenerationMs(): number {
    return this.remainingMs() - this.spec.outputReserveMs
  }

  /** 本地尝试阶段的剩余毫秒（不超过本地预算，也不超过总预算）。 */
  localRemainingMs(): number {
    const byLocal = this.spec.localAttemptMs - this.elapsedMs()
    return Math.min(byLocal, this.availableForGenerationMs())
  }

  throwIfExpired(): void {
    if (this.remainingMs() <= 0) throw new BudgetExpiredError()
  }

  abort(): void {
    this.controller.abort(new BudgetExpiredError())
  }

  dispose(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
  }
}

// ---------------------------------------------------------------------------
// 播出去重：request_id + generation_epoch（§4.2）
// ---------------------------------------------------------------------------

interface RequestGenerationState {
  /** 已签发回执（已选定播出结果）的最新 epoch；0 = 尚未签发 */
  issuedEpoch: number
  /** 已分配的最大 epoch */
  latestEpoch: number
}

/**
 * 每逻辑请求的代际登记：每次生成尝试分配递增 epoch；
 * 只有「未被更迟尝试超越、且尚未为更早尝试签发回执」的结果允许播出。
 * 迟到的本地/云端结果因 epoch 落后被丢弃。
 */
export class GenerationRegistry {
  private readonly requests = new Map<string, RequestGenerationState>()

  /** 为一次新的生成尝试分配 epoch。 */
  nextEpoch(requestId: string): number {
    const state = this.requests.get(requestId) ?? { issuedEpoch: 0, latestEpoch: 0 }
    state.latestEpoch += 1
    this.requests.set(requestId, state)
    return state.latestEpoch
  }

  /**
   * 该 epoch 的结果是否允许签发为播出结果：
   * - 必须是当前最新分配的 epoch（有更新尝试在途/已完成则本结果作废）；
   * - 该请求尚未为任何 epoch 签发回执（一回复只播一次）。
   */
  shouldDeliver(requestId: string, epoch: number): boolean {
    const state = this.requests.get(requestId)
    if (!state) return false
    return state.issuedEpoch === 0 && epoch === state.latestEpoch
  }

  /** 签发回执：锁定该请求，后续任何 epoch 的结果都不再播出。 */
  markIssued(requestId: string, epoch: number): void {
    const state = this.requests.get(requestId)
    if (state && state.issuedEpoch === 0) state.issuedEpoch = epoch
  }

  /** 会话结束清理。 */
  cleanup(requestId: string): void {
    this.requests.delete(requestId)
  }
}

export function makePlaybackKey(requestId: string, epoch: number): string {
  return `${requestId}#${epoch}`
}
