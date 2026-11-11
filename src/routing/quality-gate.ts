/**
 * 规则式质量门（方案 §4.1：schema、证据、任务完成度、人设和重复检查）。
 *
 * 阶段 A 只实现确定性规则（不调用 LLM）；语义级评审在后续阶段的验证器中
 * 使用固定 judge 或受控第三方（§22.2）。
 */
import type { ReasonCode } from '../types.ts'

export interface QualityGateFailure {
  readonly code: ReasonCode
  readonly detail: string
}

export interface QualityGateResult {
  readonly pass: boolean
  readonly failures: readonly QualityGateFailure[]
}

export interface QualityCheckContext {
  /** 期望候选为该 JSON Schema 的输出（阶段 A 校验「能解析为 JSON 对象」） */
  readonly responseSchema?: object
  /** 近期已播出的回复（重复检测基线） */
  readonly recentReplies: readonly string[]
  /** 本回复必须引用的证据；缺失即证据不足 */
  readonly requiredEvidenceRefs?: readonly string[]
  readonly providedEvidenceRefs?: readonly string[]
}

/**
 * 人设硬边界（§23.2 输出检查的最小集）：命中即 POLICY_BLOCKED，
 * 不得由第三方绕过。完整平台规则包在阶段 F 接入。
 */
const PERSONA_BOUNDARY_PATTERNS: readonly RegExp[] = [
  /隐藏|关闭|移除.*(AI|人工智能).{0,6}(标识|标记)/,
  /(冒充|假装).{0,8}(真人|真人主播|人类)/,
  /(无视|绕过|忽略).{0,8}(规则|人设|限制|审核|平台)/,
  /(承诺|帮你|替你).{0,6}(退款|提现|转账|返现)/,
  /(身份证|银行卡|支付密码|验证码).{0,6}(告诉|发我|提供)/,
]

/** 三元组 Jaccard 相似度（中文口语重复检测的轻量实现）。 */
export function trigramSimilarity(a: string, b: string): number {
  if (a === b) return 1
  const grams = (s: string): Set<string> => {
    const set = new Set<string>()
    const norm = s.replace(/\s+/g, '')
    for (let i = 0; i + 3 <= norm.length; i++) set.add(norm.slice(i, i + 3))
    return set
  }
  const ga = grams(a)
  const gb = grams(b)
  if (ga.size === 0 || gb.size === 0) return 0
  let inter = 0
  for (const g of ga) if (gb.has(g)) inter++
  return inter / (ga.size + gb.size - inter)
}

export class QualityGate {
  private readonly opts: {
    repetitionSimilarityThreshold?: number
    personaBoundaryPatterns?: readonly RegExp[]
  }

  constructor(opts: { repetitionSimilarityThreshold?: number; personaBoundaryPatterns?: readonly RegExp[] } = {}) {
    this.opts = opts
  }

  check(candidateText: string, ctx: QualityCheckContext): QualityGateResult {
    const failures: QualityGateFailure[] = []
    const patterns = this.opts.personaBoundaryPatterns ?? PERSONA_BOUNDARY_PATTERNS

    // 1. 人设硬边界：命中即硬阻断（不被任何兜底绕过）
    for (const p of patterns) {
      if (p.test(candidateText)) {
        failures.push({ code: 'POLICY_BLOCKED', detail: `命中人设硬边界规则：${p.source}` })
        break
      }
    }

    // 2. 结构化输出：请求了 schema 时必须可解析为 JSON 对象
    if (ctx.responseSchema !== undefined) {
      try {
        const parsed: unknown = JSON.parse(candidateText)
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          failures.push({ code: 'SCHEMA_INVALID', detail: '结构化输出不是 JSON 对象' })
        }
      } catch {
        failures.push({ code: 'SCHEMA_INVALID', detail: '结构化输出无法解析为 JSON' })
      }
    }

    // 3. 重复检测：与近期已播出回复过度相似
    const threshold = this.opts.repetitionSimilarityThreshold ?? 0.8
    for (const recent of ctx.recentReplies) {
      const sim = trigramSimilarity(candidateText, recent)
      if (sim >= threshold) {
        failures.push({
          code: 'QUALITY_GATE_FAILED',
          detail: `与近期回复过度相似（similarity=${sim.toFixed(2)}）`,
        })
        break
      }
    }

    // 4. 证据检查：必需证据缺失
    if (ctx.requiredEvidenceRefs !== undefined && ctx.requiredEvidenceRefs.length > 0) {
      const provided = new Set(ctx.providedEvidenceRefs ?? [])
      const missing = ctx.requiredEvidenceRefs.filter((r) => !provided.has(r))
      if (missing.length > 0) {
        failures.push({ code: 'EVIDENCE_INSUFFICIENT', detail: `缺少证据引用：${missing.join(', ')}` })
      }
    }

    return { pass: failures.length === 0, failures }
  }

  /** 输入侧政策预检（请求文本进入模型前）。 */
  checkRequestText(text: string): QualityGateResult {
    const failures: QualityGateFailure[] = []
    for (const p of this.opts.personaBoundaryPatterns ?? PERSONA_BOUNDARY_PATTERNS) {
      if (p.test(text)) {
        failures.push({ code: 'POLICY_BLOCKED', detail: `请求命中硬边界规则：${p.source}` })
        break
      }
    }
    return { pass: failures.length === 0, failures }
  }
}
