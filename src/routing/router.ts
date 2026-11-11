/**
 * 本地优先路由器（方案 §4.1 请求路径 / §4.2 时限与执行次数）。
 *
 * - 所有常规任务先本地（GPU → 训练窗口外允许 CPU 回退）；
 * - 每逻辑请求：最多一次第三方生成、一次本地 schema 修复；技能步骤上限
 *   由配置固化（阶段 B 实现技能执行器）；
 * - POLICY_BLOCKED 硬阻断：不以第三方绕过；
 * - 全部失败/预算耗尽 → 已验证固定降级回复；
 * - 每次生成分配 generation_epoch，回执签发后迟到结果一律丢弃（不重复播出）。
 */
import { getFallbackReply } from '../adapters/fallback.ts'
import type { ModelAdapter } from '../adapters/model-adapter.ts'
import type { AnswerReceipt, LiveRequest, ReasonCode } from '../types.ts'
import { RequestBudget, budgetSpecFromConfig, GenerationRegistry } from './budget.ts'
import type { QualityGateResult } from './quality-gate.ts'
import {
  dominantFailure,
  mapModelError,
  type AttemptOutcome,
  type RouteContext,
  type RouterDeps,
} from './router-support.ts'

export type { UsageEntry, UsageRecorder, RouteContext, RouterDeps } from './router-support.ts'

export class RequestRouter {
  private readonly registry: GenerationRegistry
  private readonly deps: RouterDeps

  constructor(deps: RouterDeps) {
    this.deps = deps
    this.registry = deps.registry ?? new GenerationRegistry()
  }

  async route(request: LiveRequest, ctx: RouteContext): Promise<AnswerReceipt> {
    const t0 = this.now()
    const budget = new RequestBudget(budgetSpecFromConfig(this.deps.config), () => this.now()).start()

    // 0. 输入侧政策预检：硬阻断不进入任何模型（§4.1）
    const requestCheck = this.deps.qualityGate.checkRequestText(request.text)
    const blocked = requestCheck.failures.find((f) => f.code === 'POLICY_BLOCKED')
    if (blocked) {
      budget.dispose()
      return this.issueFallback(request, 'policy_blocked', 'POLICY_BLOCKED', t0)
    }

    const localAdapters: ModelAdapter[] = []
    if (this.deps.localGpu !== undefined) localAdapters.push(this.deps.localGpu)
    if (
      this.deps.config.models.local.cpuFallbackEnabled &&
      this.deps.localCpu !== undefined &&
      this.deps.localCpu !== this.deps.localGpu
    ) {
      localAdapters.push(this.deps.localCpu)
    }

    let lastReason: ReasonCode = 'LOCAL_UNAVAILABLE'

    // 1. 本地尝试（GPU → CPU），每个适配器至多一次生成 + 一次 schema 修复
    for (const adapter of localAdapters) {
      if (budget.remainingMs() <= 0) {
        // 总预算耗尽：不再发起任何生成，进入降级（不抛错，观众侧始终有回复）
        lastReason = 'LOCAL_TIMEOUT'
        break
      }
      const localRemaining = budget.localRemainingMs()
      if (localRemaining <= 0) {
        lastReason = 'LOCAL_TIMEOUT'
        continue
      }
      const outcome = await this.attemptAdapter(request, adapter, ctx, budget, t0)
      if (outcome.delivered && outcome.receipt) {
        budget.dispose()
        return outcome.receipt
      }
      if (outcome.reasonCode === 'POLICY_BLOCKED') {
        budget.dispose()
        return this.issueFallback(request, 'policy_blocked', 'POLICY_BLOCKED', t0)
      }
      if (outcome.reasonCode !== undefined) lastReason = outcome.reasonCode
      // 本地窗口已因超时耗尽：不再消耗 CPU 等其余本地尝试（共享预算不重置 §4.2）
      if (outcome.reasonCode === 'LOCAL_TIMEOUT') break
      if (budget.availableForGenerationMs() <= 0) break
    }

    // 2. 第三方一次：能力不足/质量门失败/本地不可用均允许升级；
    //    POLICY_BLOCKED 已在上面短路；预算不足或未配置不调用（§18 注）。
    if (this.deps.cloud !== undefined && this.deps.featureGates.cloudCallsEnabled) {
      if (budget.availableForGenerationMs() > 0) {
        const outcome = await this.attemptAdapter(request, this.deps.cloud, ctx, budget, t0)
        if (outcome.delivered && outcome.receipt) {
          budget.dispose()
          return outcome.receipt
        }
        if (outcome.reasonCode === 'POLICY_BLOCKED') {
          budget.dispose()
          return this.issueFallback(request, 'policy_blocked', 'POLICY_BLOCKED', t0)
        }
        if (outcome.reasonCode !== undefined) lastReason = outcome.reasonCode
      } else {
        lastReason = 'LOCAL_TIMEOUT'
      }
    }

    // 3. 固定降级回复（不再消耗任何模型预算）
    budget.dispose()
    const scenario = localAdapters.length === 0 && this.deps.cloud === undefined
      ? 'local_unavailable'
      : 'generation_failed'
    return this.issueFallback(request, scenario, lastReason, t0)
  }

  // -------------------------------------------------------------------------

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  /** 单适配器一次生成（+schema 失败时一次修复）。 */
  private async attemptAdapter(
    request: LiveRequest,
    adapter: ModelAdapter,
    ctx: RouteContext,
    budget: RequestBudget,
    t0: number,
  ): Promise<AttemptOutcome> {
    const epoch = this.registry.nextEpoch(request.requestId)
    const attemptStart = this.now()
    const timeoutMs = Math.max(1, budget.availableForGenerationMs())

    let result
    try {
      result = await adapter.generate(
        {
          messages: this.buildMessages(request),
          maxOutputTokens: this.deps.config.models.local.maxOutputTokens,
          ...(ctx.responseSchema !== undefined ? { responseSchema: ctx.responseSchema } : {}),
        },
        { signal: budget.signal, timeoutMs },
      )
    } catch (err) {
      const { code } = mapModelError(err)
      this.recordUsage(request, epoch, adapter.route, attemptStart, code, adapter.model)
      return { delivered: false, reasonCode: code }
    }

    const gate = this.gateResult(result.text, ctx)
    if (!gate.pass && gate.failures.some((f) => f.code === 'SCHEMA_INVALID')) {
      // 总预算内最多修复一次（§4.1 SCHEMA_INVALID 行）
      if (budget.availableForGenerationMs() > 0) {
        const repair = await this.repairOnce(request, adapter, result.text, ctx, budget)
        if (repair !== undefined) {
          const repairGate = this.gateResult(repair.result.text, ctx)
          if (repairGate.pass) {
            return this.deliver(request, adapter, repair.result, repair.epoch, attemptStart, t0, budget)
          }
          return this.finishFailedGate(request, adapter, repair.epoch, attemptStart, repairGate)
        }
      }
    }

    if (gate.pass) {
      return this.deliver(request, adapter, result, epoch, attemptStart, t0, budget)
    }
    return this.finishFailedGate(request, adapter, epoch, attemptStart, gate)
  }

  /** 质量门失败收尾：记录原因码并返回未交付。 */
  private finishFailedGate(
    request: LiveRequest,
    adapter: ModelAdapter,
    epoch: number,
    attemptStart: number,
    gate: QualityGateResult,
  ): AttemptOutcome {
    const code = dominantFailure(gate)
    this.recordUsage(request, epoch, adapter.route, attemptStart, code, adapter.model)
    return { delivered: false, reasonCode: code }
  }

  private async repairOnce(
    request: LiveRequest,
    adapter: ModelAdapter,
    badOutput: string,
    ctx: RouteContext,
    budget: RequestBudget,
  ): Promise<{ epoch: number; result: Awaited<ReturnType<ModelAdapter['generate']>> } | undefined> {
    const epoch = this.registry.nextEpoch(request.requestId)
    try {
      const result = await adapter.generate(
        {
          messages: [
            ...this.buildMessages(request),
            { role: 'assistant', text: badOutput },
            {
              role: 'user',
              text: ctx.responseSchema !== undefined
                ? `上一个输出不符合要求的 JSON 结构（schema=${JSON.stringify(ctx.responseSchema)}）。请只输出符合该结构的 JSON，不要包含其他文字。`
                : '上一个输出格式不正确，请重新严格按要求输出。',
            },
          ],
          maxOutputTokens: this.deps.config.models.local.maxOutputTokens,
          ...(ctx.responseSchema !== undefined ? { responseSchema: ctx.responseSchema } : {}),
        },
        { signal: budget.signal, timeoutMs: Math.max(1, budget.availableForGenerationMs()) },
      )
      return { epoch, result }
    } catch {
      return undefined
    }
  }

  private deliver(
    request: LiveRequest,
    adapter: ModelAdapter,
    result: { text: string; tokensIn?: number; tokensOut?: number },
    epoch: number,
    attemptStart: number,
    t0: number,
    budget: RequestBudget,
  ): AttemptOutcome {
    if (budget.remainingMs() <= 0) {
      // 完整候选超出共享时限：丢弃迟到输出（§4.1 LOCAL_TIMEOUT 行）
      this.recordUsage(request, epoch, adapter.route, attemptStart, 'LOCAL_TIMEOUT', adapter.model)
      return { delivered: false, reasonCode: 'LOCAL_TIMEOUT' }
    }
    if (!this.registry.shouldDeliver(request.requestId, epoch)) {
      // 已有更新尝试或回执已签发：本结果迟到，丢弃（§4.2）
      this.recordUsage(request, epoch, adapter.route, attemptStart, 'LOCAL_TIMEOUT', adapter.model)
      return { delivered: false, reasonCode: 'LOCAL_TIMEOUT' }
    }
    this.registry.markIssued(request.requestId, epoch)
    const usageId = this.deps.usage.record({
      requestId: request.requestId,
      epoch,
      route: adapter.route,
      model: adapter.model,
      latencyMs: this.now() - attemptStart,
      ...(result.tokensIn !== undefined ? { tokensIn: result.tokensIn } : {}),
      ...(result.tokensOut !== undefined ? { tokensOut: result.tokensOut } : {}),
    })
    return {
      delivered: true,
      receipt: {
        requestId: request.requestId,
        playbackKey: `${request.requestId}#${epoch}`,
        text: result.text,
        route: adapter.route,
        usageId,
        latencyMs: this.now() - t0,
      },
    }
  }

  /** 签发固定降级回执（占用并锁定 epoch，防止迟到模型结果再播出）。 */
  private issueFallback(
    request: LiveRequest,
    scenario: 'policy_blocked' | 'generation_failed' | 'local_unavailable',
    reasonCode: ReasonCode,
    t0: number,
  ): AnswerReceipt {
    const epoch = this.registry.nextEpoch(request.requestId)
    this.registry.markIssued(request.requestId, epoch)
    const usageId = this.deps.usage.record({
      requestId: request.requestId,
      epoch,
      route: 'fallback',
      reasonCode,
      latencyMs: this.now() - t0,
    })
    return {
      requestId: request.requestId,
      playbackKey: `${request.requestId}#${epoch}`,
      text: getFallbackReply(scenario),
      route: 'fallback',
      reasonCode,
      usageId,
      latencyMs: this.now() - t0,
    }
  }

  private buildMessages(request: LiveRequest) {
    return [
      {
        role: 'system' as const,
        text: `你是直播角色「${this.deps.config.scope.characterId}」，用简短、口语化的中文回复弹幕，单条回复不超过两句话。`,
      },
      { role: 'user' as const, text: request.text },
    ]
  }

  private gateResult(text: string, ctx: RouteContext): QualityGateResult {
    return this.deps.qualityGate.check(text, {
      recentReplies: ctx.recentReplies,
      ...(ctx.responseSchema !== undefined ? { responseSchema: ctx.responseSchema } : {}),
      ...(ctx.requiredEvidenceRefs !== undefined
        ? { requiredEvidenceRefs: ctx.requiredEvidenceRefs }
        : {}),
      ...(ctx.providedEvidenceRefs !== undefined
        ? { providedEvidenceRefs: ctx.providedEvidenceRefs }
        : {}),
    })
  }

  private recordUsage(
    request: LiveRequest,
    epoch: number,
    route: 'local_gpu' | 'local_cpu' | 'cloud',
    attemptStart: number,
    reasonCode: ReasonCode | undefined,
    model: string,
  ): void {
    this.deps.usage.record({
      requestId: request.requestId,
      epoch,
      route,
      ...(reasonCode !== undefined ? { reasonCode } : {}),
      model,
      latencyMs: this.now() - attemptStart,
    })
  }
}
