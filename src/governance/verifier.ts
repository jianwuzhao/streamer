/**
 * 统一验证器（方案 §12.2 发布门 / §22.2 契约）。
 *
 * - 只接受可校验的结构化结果（metrics/checks），不用自由文本「评估通过」；
 * - 七道门：完整性、政策回归、任务质量（95% CI 下界 ≥ −2pp）、工具执行、
 *   人设与重复、资源、数据与证据；
 * - 指标缺失 ⇒ inconclusive（禁止当作通过）；任何 fail ⇒ fail；
 * - 报告绑定候选哈希与基线，内容变化需重验；带过期时间。
 */
import { createHash, randomUUID } from 'node:crypto'
import { get, nowIso, run, type DB } from '../storage/db.ts'
import type { VerificationCheck, VerificationReport } from '../types.ts'

export interface ReleaseManifest {
  readonly releaseName: string
  readonly persona: { readonly policyVersion: string; readonly personaHash: string }
  readonly model?: { readonly baseProfile: string; readonly adapterCheckpoint?: string }
  readonly memories: readonly { readonly id: string; readonly revision: number }[]
  readonly skills: readonly { readonly skillId: string; readonly version: string }[]
  readonly retrieval: { readonly indexGeneration: number; readonly embeddingModelRevision: string }
  readonly routing: { readonly policy: string }
  readonly metrics: {
    readonly taskQualityDeltaCiLow?: number
    readonly personaRegressionFailures?: number
    readonly toolTestsPassed?: number
    readonly toolTestsTotal?: number
    readonly oomObserved?: boolean
  }
  readonly observation?: { readonly sessions: number; readonly samples: number }
}

/** 规范哈希：剔除 releaseName 后的稳定 JSON 序列化（内容变化 ⇒ 哈希变化）。 */
export function manifestHash(manifest: ReleaseManifest): string {
  const { releaseName: _name, ...rest } = manifest
  void _name
  return createHash('sha256').update(JSON.stringify(rest)).digest('hex')
}

type CheckVerdict = 'pass' | 'fail' | 'inconclusive'
type CheckFn = () => CheckVerdict

export class Verifier {
  private readonly db: DB
  private readonly clock: () => string

  constructor(db: DB, opts: { clock?: () => string } = {}) {
    this.db = db
    this.clock = opts.clock ?? nowIso
  }

  /**
   * 执行验证并持久化报告。candidateHash 与 manifest 实际哈希不符 ⇒ 完整性 fail。
   */
  verify(input: {
    manifest: ReleaseManifest
    candidateHash: string
    baselineReleaseId: string
  }): VerificationReport {
    const checks: VerificationCheck[] = []
    const metrics: Record<string, number> = {}
    const actualHash = manifestHash(input.manifest)

    // 1. 完整性
    checks.push(
      this.check('integrity_hash', () => {
        if (input.candidateHash !== actualHash) return 'fail'
        const required = ['persona', 'memories', 'skills', 'retrieval', 'routing', 'metrics'] as const
        const missing = required.filter((k) => (input.manifest as unknown as Record<string, unknown>)[k] === undefined)
        return missing.length === 0 ? 'pass' : 'fail'
      }),
    )

    // 2. 政策回归：硬性边界用例零失败（缺失 ⇒ inconclusive）
    checks.push(
      this.metricCheck('policy_regression', input.manifest.metrics.personaRegressionFailures, (v) => (v === 0 ? 'pass' : 'fail'), metrics),
    )

    // 3. 任务质量：Δ 的 95% CI 下界 ≥ −0.02
    checks.push(
      this.metricCheck('task_quality_ci_low', input.manifest.metrics.taskQualityDeltaCiLow, (v) => (v >= -0.02 ? 'pass' : 'fail'), metrics),
    )

    // 4. 工具执行：确定性权限/幂等测试全部通过
    checks.push(
      this.check('tool_execution', () => {
        const { toolTestsPassed, toolTestsTotal } = input.manifest.metrics
        if (toolTestsPassed === undefined || toolTestsTotal === undefined || toolTestsTotal <= 0) return 'inconclusive'
        metrics.toolTestsPassed = toolTestsPassed
        metrics.toolTestsTotal = toolTestsTotal
        return toolTestsPassed === toolTestsTotal ? 'pass' : 'fail'
      }),
    )

    // 5. 资源：目标负载无 OOM
    checks.push(
      this.check('resource_oom', () => {
        const oom = input.manifest.metrics.oomObserved
        if (oom === undefined) return 'inconclusive'
        metrics.oomObserved = oom ? 1 : 0
        return oom ? 'fail' : 'pass'
      }),
    )

    // 6. 数据与证据：无已撤销数据（记忆最新 revision 须 active；技能须 active）
    checks.push(
      this.check('data_evidence_revoked', () => {
        for (const m of input.manifest.memories) {
          const row = get<{ status: string }>(
            this.db,
            'SELECT status FROM memory_candidates WHERE id = ? ORDER BY revision DESC LIMIT 1',
            m.id,
          )
          if (!row || row.status !== 'active') return 'fail'
        }
        for (const s of input.manifest.skills) {
          const row = get<{ status: string }>(
            this.db,
            'SELECT status FROM skill_versions WHERE skill_id = ? AND version = ?',
            s.skillId,
            s.version,
          )
          if (!row || row.status !== 'active') return 'fail'
        }
        return 'pass'
      }),
    )

    // 7. 观察样本量（样本不足 ⇒ inconclusive，继续观察不晋级 §12.2）
    checks.push(
      this.check('observation_samples', () => {
        const obs = input.manifest.observation
        if (obs === undefined || obs.sessions < 2) return 'inconclusive'
        metrics.observationSessions = obs.sessions
        metrics.observationSamples = obs.samples
        return 'pass'
      }),
    )

    const verdict = checks.some((c) => c.verdict === 'fail')
      ? 'fail'
      : checks.some((c) => c.verdict === 'inconclusive')
        ? 'inconclusive'
        : 'pass'
    const report: VerificationReport = {
      reportId: `vr_${randomUUID().slice(0, 12)}`,
      candidateHash: input.candidateHash,
      baselineReleaseId: input.baselineReleaseId,
      verdict,
      checks,
      metrics,
      expiresAt: new Date(Date.parse(this.clock()) + 3_600_000).toISOString(),
    }
    run(
      this.db,
      `INSERT INTO verification_reports (report_id, candidate_hash, baseline_release_id, verdict, checks, metrics, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      report.reportId,
      report.candidateHash,
      report.baselineReleaseId,
      report.verdict,
      JSON.stringify(report.checks),
      JSON.stringify(report.metrics),
      report.expiresAt,
    )
    return report
  }

  private check(id: string, fn: CheckFn): VerificationCheck {
    try {
      const verdict: CheckVerdict = fn()
      return { id, verdict, evidenceRef: `check:${id}` }
    } catch (err) {
      return { id, verdict: 'fail', evidenceRef: `check:${id}:error:${(err as Error).message}` }
    }
  }

  /** 数值指标门：缺失 ⇒ inconclusive（不得当通过）。 */
  private metricCheck(
    id: string,
    value: number | undefined,
    judge: (v: number) => 'pass' | 'fail',
    metrics: Record<string, number>,
  ): VerificationCheck {
    return this.check(id, () => {
      if (value === undefined || Number.isNaN(value)) return 'inconclusive'
      metrics[id] = value
      return judge(value)
    })
  }
}
