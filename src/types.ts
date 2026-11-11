/**
 * 核心领域契约（方案 §2.4 / §4.1 / §17 / §22.2 的项目内部接口）。
 *
 * 注意：这些是 dsh-dafeiyu-evolve 的内部契约，不是 DSH 原生 API；
 * 与宿主/外部插件（dsh-rsi、neural-cloud、continual-harness、live-studio）
 * 的绑定由后续阶段的适配器实现。
 */

// ---------------------------------------------------------------------------
// 路由原因码（方案 §4.1）
// ---------------------------------------------------------------------------

export const REASON_CODES = [
  'LOCAL_UNAVAILABLE',
  'LOCAL_RESOURCE_UNAVAILABLE',
  'LOCAL_TIMEOUT',
  'UNSUPPORTED_CAPABILITY',
  'SCHEMA_INVALID',
  'EVIDENCE_INSUFFICIENT',
  'QUALITY_GATE_FAILED',
  'NEEDS_CLARIFICATION',
  'POLICY_BLOCKED',
] as const

export type ReasonCode = (typeof REASON_CODES)[number]

// ---------------------------------------------------------------------------
// 感知事件（方案 §2.4 LiveEnvelope）
// ---------------------------------------------------------------------------

export type Provenance = 'platform_verified' | 'operator' | 'bridge' | 'unverified'

export interface LiveEnvelope {
  readonly schemaVersion: number
  readonly eventId: string
  readonly source: string
  readonly sourceEventId: string
  readonly roomId: string
  readonly sessionId: string
  readonly viewerKey?: string | undefined
  readonly occurredAt: string
  readonly receivedAt: string
  readonly type: string
  readonly correlationId?: string | undefined
  readonly causalEventIds: readonly string[]
  readonly provenance: Provenance
  readonly purposeTags: readonly string[]
  readonly payloadRef: string
  /** 回放模式：只读环境，禁止推流、播音、游戏操作和再次答谢（§2.4） */
  readonly replay?: boolean | undefined
}

/** 事件投递回执 */
export interface DurableReceipt {
  readonly eventId: string
  readonly duplicate: boolean
  /** 迟到但落在有界窗口外：只记录，不更新投影、不触发动作 */
  readonly late: boolean
  /** 是否真正进入了处理链路（非重复、非窗外迟到） */
  readonly processed: boolean
}

// ---------------------------------------------------------------------------
// 黑板快照（方案 §2.4 BlackboardSnapshot）
// ---------------------------------------------------------------------------

export interface BlackboardSnapshot {
  readonly revision: number
  readonly sessionId: string
  readonly topic: string
  readonly gameStateRef?: string | undefined
  readonly pendingTasks: readonly string[]
  readonly recentEventIds: readonly string[]
  readonly activeReleaseId: string
  readonly policyVersion: string
  readonly expiresAt: string
}

// ---------------------------------------------------------------------------
// 政策授权（方案 §11.1 PolicyDecision）
// ---------------------------------------------------------------------------

export type PolicyAction =
  | 'memory_write'
  | 'profile_update'
  | 'train'
  | 'publish'
  | 'consolidate'

export type PolicyActor = 'policy_service' | 'operator'

export interface PolicyDecision {
  readonly id: string
  readonly actor: PolicyActor
  readonly action: PolicyAction
  readonly payloadHash: string
  readonly policyVersion: string
  readonly epoch: number
  readonly expiresAt: string
  readonly result: 'allow' | 'deny' | 'review'
}

// ---------------------------------------------------------------------------
// 直播请求与回答回执（方案 §17 LearningRuntime 的 answer 通道）
// ---------------------------------------------------------------------------

export interface LiveRequest {
  readonly requestId: string
  readonly sessionId: string
  readonly roomId: string
  readonly viewerKey?: string
  readonly text: string
  readonly type: 'danmaku' | 'gift_comment' | 'operator' | 'system'
  readonly purposeTags: readonly string[]
  readonly occurredAt: string
}

export type AnswerRoute = 'local_gpu' | 'local_cpu' | 'cloud' | 'fallback'

export interface AnswerReceipt {
  readonly requestId: string
  /** request_id + generation_epoch：防止迟到本地/云端结果重复播出（§4.2） */
  readonly playbackKey: string
  readonly text: string
  readonly route: AnswerRoute
  readonly reasonCode?: ReasonCode
  readonly usageId: number | null
  readonly latencyMs: number
}

// ---------------------------------------------------------------------------
// 验证器契约（方案 §22.2）
// ---------------------------------------------------------------------------

export interface VerificationRequest {
  readonly candidateHash: string
  readonly kind: 'memory' | 'skill' | 'model' | 'consolidation' | 'speech'
  readonly scope: string
  readonly baselineReleaseId: string
  readonly policyVersion: string
  readonly evidenceRefs: readonly string[]
  readonly budgetRef: string
}

export interface VerificationCheck {
  readonly id: string
  readonly verdict: 'pass' | 'fail' | 'inconclusive'
  readonly evidenceRef: string
}

export interface VerificationReport {
  readonly reportId: string
  readonly candidateHash: string
  readonly baselineReleaseId: string
  readonly verdict: 'pass' | 'fail' | 'inconclusive'
  readonly checks: readonly VerificationCheck[]
  readonly metrics: Readonly<Record<string, number>>
  readonly expiresAt: string
}

// ---------------------------------------------------------------------------
// 学习运行时（方案 §17 LearningRuntime）
// ---------------------------------------------------------------------------

/** 阶段 A 未实现的接口统一抛出此错误：显式声明能力边界，不做静默空实现。 */
export class NotImplementedError extends Error {
  public readonly method: string
  public readonly plannedPhase: string
  constructor(method: string, plannedPhase: string) {
    super(`LearningRuntime.${method} 计划在阶段 ${plannedPhase} 实现，当前阶段 A 不可调用`)
    this.name = 'NotImplementedError'
    this.method = method
    this.plannedPhase = plannedPhase
  }
}

export interface ScopedQuery {
  readonly text: string
  readonly sessionId: string
  readonly characterId: string
  readonly namespaces?: readonly string[]
  /** 观众作用域：非空时才可能召回该观众私有内容（§8.1 ACL） */
  readonly viewerKey?: string | undefined
}

export interface ContextBundle {
  readonly memories: readonly { readonly ref: string; readonly text: string }[]
  readonly skills: readonly { readonly ref: string; readonly text: string }[]
  readonly injectedTokens: number
}

export interface LearningRuntime {
  ingest(event: LiveEnvelope): Promise<DurableReceipt>
  answer(request: LiveRequest): Promise<AnswerReceipt>
  /** 阶段 B */
  updateProfile(eventId: string): Promise<{ revision: number }>
  /** 阶段 B */
  proposeCognition(input: {
    claim: string
    namespace: string
    scene: string
    subject?: string
    layer?: 'L2' | 'L4'
    evidenceRefs: readonly string[]
  }): Promise<{ ref: string; status: string; challenged: readonly string[] }>
  /** 阶段 C */
  retrieve(query: ScopedQuery): Promise<ContextBundle>
  /** 阶段 D */
  trainSlice(run: { runId: string; decision: PolicyDecision }): Promise<{ checkpointRef: string }>
  /** 阶段 E */
  evaluateRelease(candidate: { releaseId: string; candidateHash: string }): Promise<VerificationReport>
  /** 阶段 E：授权校验 → 自动检查 → 灰度 → 激活（无逐次人工点击） */
  publish(grant: PolicyDecision): Promise<{ releaseId: string }>
  /** 阶段 E：grant.payloadHash 须为 `memory:<sourceMemoryId>` */
  consolidate(grant: PolicyDecision, sourceMemoryId: string): Promise<{ stableRevision: number }>
  /** 阶段 E */
  rollback(releaseId: string): Promise<{ restoredReleaseId: string }>
}
