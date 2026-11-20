/**
 * 路由器支撑类型与纯函数（自 router.ts 拆出，保持单文件 ≤400 行）。
 */
import { CloudDisabledError } from '../adapters/cloud.ts'
import type { GenerateMessage } from '../adapters/model-adapter.ts'
import type { ModelAdapter } from '../adapters/model-adapter.ts'
import type { DafeiyuConfigType, FeatureGates } from '../config.ts'
import type { HostInteraction } from '../live/interaction-replies.ts'
import type { ProfileOption } from '../settings/catalogs.ts'
import type { AnswerReceipt, AnswerRoute, ReasonCode } from '../types.ts'
import type { GenerationRegistry } from './budget.ts'
import type { QualityGate, QualityGateResult } from './quality-gate.ts'

export interface UsageEntry {
  readonly requestId: string
  readonly epoch: number
  readonly route: AnswerRoute
  readonly reasonCode?: ReasonCode
  readonly model?: string
  readonly latencyMs: number
  readonly tokensIn?: number
  readonly tokensOut?: number
  readonly tokensTotal?: number
  readonly costCny?: number
}

export interface UsageRecorder {
  /** 返回 usage_id；记录失败返回 null（不阻塞回答链路，但必须可见于日志）。 */
  record(entry: UsageEntry): number | null
}

export interface RouterDeps {
  readonly config: DafeiyuConfigType
  readonly featureGates: FeatureGates
  readonly qualityGate: QualityGate
  readonly usage: UsageRecorder
  readonly localGpu?: ModelAdapter
  readonly localCpu?: ModelAdapter | undefined
  readonly cloud?: ModelAdapter
  readonly registry?: GenerationRegistry
  readonly now?: () => number
  readonly getHostProfile?: () => ProfileOption
  readonly localAvailable?: (adapter: ModelAdapter) => boolean
  readonly localOutcome?: (adapter: ModelAdapter, ok: boolean) => void
}

export interface RouteContext {
  readonly signal?: AbortSignal
  readonly startedAt?: number
  readonly onDraft?: (text: string) => void
  readonly hostProfile?: ProfileOption
  readonly hostConversation?: {
    readonly mode: 'preview' | 'live'
    readonly history: readonly GenerateMessage[]
    readonly cloudHistory: readonly GenerateMessage[]
    readonly memory: readonly string[]
    readonly program?: readonly string[]
    readonly cloudText?: string
    readonly address?: string
    readonly interaction?: HostInteraction
  }
  readonly localOnly?: boolean
  readonly allowCloud?: () => boolean
  readonly preferCloud?: boolean
  readonly preset?: { readonly text: string; readonly kind: NonNullable<AnswerReceipt['replyKind']> }
  readonly previewCharacter?: string
  readonly previewDescription?: string
  /** 近期已播出回复（重复检测） */
  readonly recentReplies: readonly string[]
  /** 请求结构化输出时提供 */
  readonly responseSchema?: object
  readonly requiredEvidenceRefs?: readonly string[]
  readonly providedEvidenceRefs?: readonly string[]
}

export interface AttemptOutcome {
  readonly delivered: boolean
  readonly receipt?: AnswerReceipt
  /** 触发升级/降级的主导原因码 */
  readonly reasonCode?: ReasonCode
}

/** 模型调用错误 → 路由原因码（云端禁用按预算/配置细分）。 */
export function mapModelError(err: unknown): { code: ReasonCode; message: string } {
  if (err instanceof CloudDisabledError) {
    const exhausted = err.reasons.includes('budget_exhausted')
    return {
      code: exhausted ? 'LOCAL_RESOURCE_UNAVAILABLE' : 'LOCAL_UNAVAILABLE',
      message: err.message,
    }
  }
  const anyErr = err as { reasonCode?: ReasonCode; message?: string }
  if (anyErr && typeof anyErr.reasonCode === 'string') {
    return { code: anyErr.reasonCode, message: anyErr.message ?? String(err) }
  }
  return { code: 'LOCAL_UNAVAILABLE', message: String(err) }
}

const FAILURE_PRIORITY: readonly ReasonCode[] = [
  'POLICY_BLOCKED',
  'SCHEMA_INVALID',
  'EVIDENCE_INSUFFICIENT',
  'QUALITY_GATE_FAILED',
]

/** 质量门多失败并存时取主导原因码（政策阻断最高）。 */
export function dominantFailure(gate: QualityGateResult): ReasonCode {
  for (const code of FAILURE_PRIORITY) {
    if (gate.failures.some((f) => f.code === code)) return code
  }
  return 'QUALITY_GATE_FAILED'
}
