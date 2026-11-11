/**
 * 自动固化服务（方案 §13）。
 *
 * - 成熟 L2/L4 → learned_stable 的 L1/L3；persona_core 无写权限；
 * - 初始条件：≥3 独立场次、≥5 独立证据（去重簇口径按独立证据近似，实机
 *   校准时替换为显式簇数据）、7 天观察、无未解决反例；
 * - 事务：eligible → proposed → policy_checked → staged_stable →
 *   active_stable；失败不删除原条目；治理层强制 review_at/valid_until；
 * - 反例即时暂停（challenged）；撤销传播（evidence 撤销 → 派生稳定条目失效）；
 * - 查询时过滤 revoked/过期（注入前强制 §13.3）。
 */
import { randomUUID } from 'node:crypto'
import { all, get, nowIso, run, type DB } from '../storage/db.ts'
import type { PolicyDecision } from '../types.ts'
import type { PolicyService } from './policy-decision.ts'
import type { MemoryStore } from '../memory/l2-store.ts'
import type { MemoryEntry } from '../memory/l2-store.ts'

export interface ConsolidationConditions {
  readonly minIndependentSessions: number
  readonly minEvidenceClusters: number
  readonly observationDays: number
  readonly reviewEveryDays: number
}

export interface EligibilityReport {
  readonly eligible: boolean
  readonly independentSessions: number
  readonly independentEvidence: number
  readonly observationDays: number
  readonly blockers: readonly string[]
}

interface StableRow {
  id: string
  revision: number
  layer: 'L1' | 'L3'
  claim: string
  scope: string
  source_consolidation: string
  review_at: string
  valid_until: string
  revoked_at: string | null
}

export class ConsolidationService {
  private readonly db: DB
  private readonly policy: PolicyService
  private readonly memory: MemoryStore
  private readonly conditions: ConsolidationConditions
  private readonly clock: () => string

  constructor(
    db: DB,
    policy: PolicyService,
    memory: MemoryStore,
    opts: { conditions?: Partial<ConsolidationConditions>; clock?: () => string } = {},
  ) {
    this.db = db
    this.policy = policy
    this.memory = memory
    this.clock = opts.clock ?? nowIso
    this.conditions = {
      minIndependentSessions: opts.conditions?.minIndependentSessions ?? 3,
      minEvidenceClusters: opts.conditions?.minEvidenceClusters ?? 5,
      observationDays: opts.conditions?.observationDays ?? 7,
      reviewEveryDays: opts.conditions?.reviewEveryDays ?? 30,
    }
  }

  /** 条件评估（确定性，不调用 LLM）。 */
  evaluateEligibility(sourceMemoryId: string): EligibilityReport {
    const entry = this.memory.latest(sourceMemoryId)
    if (!entry) return { eligible: false, independentSessions: 0, independentEvidence: 0, observationDays: 0, blockers: ['来源条目不存在'] }
    const blockers: string[] = []
    if (entry.status !== 'active') blockers.push(`来源状态 ${entry.status} 非 active`)

    // 独立证据（近似去重簇：按事件独立性；含反例即不成熟）
    const events = all<{ session_id: string }>(
      this.db,
      `SELECT DISTINCT e.session_id FROM events e
       WHERE e.event_id IN (${entry.supportingEvidence.map(() => '?').join(',') || "''"})`,
      ...entry.supportingEvidence,
    )
    const independentSessions = new Set(events.map((e) => e.session_id)).size
    const independentEvidence = entry.supportingEvidence.length
    if (independentSessions < this.conditions.minIndependentSessions) {
      blockers.push(`独立场次 ${independentSessions} < ${this.conditions.minIndependentSessions}`)
    }
    if (independentEvidence < this.conditions.minEvidenceClusters) {
      blockers.push(`独立证据 ${independentEvidence} < ${this.conditions.minEvidenceClusters}（去重簇近似口径）`)
    }
    if (entry.counterEvidence.length > 0) blockers.push('存在未解决反例')

    const observationDays =
      (Date.parse(this.clock()) - Date.parse(entry.validFrom)) / 86_400_000
    if (observationDays < this.conditions.observationDays) {
      blockers.push(`观察 ${observationDays.toFixed(1)} 天 < ${this.conditions.observationDays} 天`)
    }
    // 固化内容边界（§13.2）：不得包含观众资料/权限/短期标记
    if (/vw_[a-f0-9]{6,}/.test(entry.claim)) blockers.push('claim 含观众伪名（禁止固化观众资料）')
    if (/(权限|禁止|允许).*(写入|修改)/.test(entry.claim)) blockers.push('claim 涉及权限变化')

    return {
      eligible: blockers.length === 0,
      independentSessions,
      independentEvidence,
      observationDays: Number(observationDays.toFixed(2)),
      blockers,
    }
  }

  /**
   * 自动固化链（policy grant 校验 + 条件门 + 灰度后 active_stable）。
   * 失败不删除原条目；成功后写 learned_stable 新 revision。
   */
  consolidate(grant: PolicyDecision, sourceMemoryId: string): { stableRevision: number } {
    // 政策门：仅接受未过期 allow 的 consolidate 授权（payloadHash 绑定来源条目）
    const verify = this.policy.verify(grant, {
      payloadHash: `memory:${sourceMemoryId}`,
      now: this.clock(),
    })
    if (!verify.valid) throw new Error(`固化授权无效: ${verify.reason}`)

    const report = this.evaluateEligibility(sourceMemoryId)
    if (!report.eligible) {
      throw new Error(`固化条件不满足: ${report.blockers.join('; ')}`)
    }
    const entry = this.memory.latest(sourceMemoryId) as MemoryEntry

    // 去重键：同 claim 已有稳定条目 ⇒ 不重复固化（§13.3）
    const duplicate = get<{ id: string }>(
      this.db,
      `SELECT id FROM learned_stable WHERE claim = ? AND revoked_at IS NULL ORDER BY revision DESC LIMIT 1`,
      entry.claim,
    )
    if (duplicate) throw new Error(`稳定条目已存在（去重键命中）: ${duplicate.id}`)

    const consolidationId = `cons_${randomUUID().slice(0, 10)}`
    const stableId = `stable_${randomUUID().slice(0, 10)}`
    const now = this.clock()
    const reviewAt = new Date(Date.parse(now) + this.conditions.reviewEveryDays * 86_400_000).toISOString()
    const validUntil = new Date(Date.parse(now) + 365 * 86_400_000).toISOString()

    // 事务状态链（无逐次人工点击）：eligible → proposed → policy_checked → staged_stable → active_stable
    for (const status of ['proposed', 'policy_checked', 'staged_stable'] as const) {
      run(
        this.db,
        `INSERT INTO consolidations (consolidation_id, source_id, source_revision, stable_id, stable_revision, status,
           evidence_clusters, independent_sessions, observation_days, gates, review_at, valid_until)
         VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(consolidation_id) DO UPDATE SET status = excluded.status`,
        consolidationId,
        sourceMemoryId,
        entry.revision,
        stableId,
        status,
        report.independentEvidence,
        report.independentSessions,
        report.observationDays,
        JSON.stringify({ blockers: report.blockers, grantedBy: 'policy_service' }),
        reviewAt,
        validUntil,
      )
    }
    // learned_stable L1（稳定认知）；L3（流程）由调用方按 kind 归类，默认 L1
    const layer: 'L1' | 'L3' = entry.kind.includes('process') || entry.scene.includes('flow') ? 'L3' : 'L1'
    run(
      this.db,
      `INSERT INTO learned_stable (id, revision, layer, namespace, claim, scope, source_consolidation, review_at, valid_until)
       VALUES (?, 1, ?, 'learned_stable', ?, ?, ?, ?, ?)`,
      stableId,
      layer,
      entry.claim,
      `${entry.characterId}/${entry.scene}`,
      consolidationId,
      reviewAt,
      validUntil,
    )
    run(
      this.db,
      `INSERT INTO consolidations (consolidation_id, source_id, source_revision, stable_id, stable_revision, status,
         evidence_clusters, independent_sessions, observation_days, gates, review_at, valid_until)
       VALUES (?, ?, ?, ?, 1, 'active_stable', ?, ?, ?, ?, ?, ?)
       ON CONFLICT(consolidation_id) DO UPDATE SET status = 'active_stable'`,
      consolidationId,
      sourceMemoryId,
      entry.revision,
      stableId,
      report.independentEvidence,
      report.independentSessions,
      report.observationDays,
      JSON.stringify({ blockers: report.blockers }),
      reviewAt,
      validUntil,
    )
    return { stableRevision: 1 }
  }

  /** 反例：即时暂停（challenged），证据撤销传播入口。 */
  counterExample(stableId: string, evidenceRef: string): void {
    run(
      this.db,
      `UPDATE consolidations SET status = 'challenged' WHERE stable_id = ? AND status = 'active_stable'`,
      stableId,
    )
    const latest = this.latestStable(stableId)
    if (latest) {
      run(
        this.db,
        `INSERT INTO learned_stable (id, revision, layer, namespace, claim, scope, source_consolidation, review_at, valid_until, revoked_at)
         VALUES (?, ?, 'L1', 'learned_stable', ?, ?, ?, ?, ?, ?)`,
        stableId,
        latest.revision + 1,
        latest.claim,
        latest.scope,
        latest.source_consolidation,
        latest.review_at,
        latest.valid_until,
        this.clock(),
      )
    }
    run(this.db, `INSERT INTO audit (action, summary) VALUES ('consolidation_challenged', ?)`, `${stableId} 反例 ${evidenceRef}`)
  }

  /** 撤销稳定条目（保留审计，不物理删除）。 */
  revoke(stableId: string): void {
    run(this.db, `UPDATE learned_stable SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`, this.clock(), stableId)
    run(this.db, `UPDATE consolidations SET status = 'revoked', revoked_at = ? WHERE stable_id = ?`, this.clock(), stableId)
  }

  /** 注入前强制过滤：未撤销、未过期、按作用域。 */
  activeStable(scopePrefix: string, now?: string): readonly StableRow[] {
    const at = now ?? this.clock()
    return all<StableRow>(
      this.db,
      `SELECT ls.* FROM learned_stable ls
       WHERE ls.revoked_at IS NULL AND ls.valid_until > ? AND ls.scope LIKE ? || '%'
         AND ls.revision = (SELECT MAX(x.revision) FROM learned_stable x WHERE x.id = ls.id)`,
      at,
      scopePrefix,
    )
  }

  /** 到期复核列表（初始 30 天）。 */
  reviewDue(now?: string): readonly StableRow[] {
    return all<StableRow>(
      this.db,
      `SELECT ls.* FROM learned_stable ls
       WHERE ls.revoked_at IS NULL AND ls.review_at <= ?
         AND ls.revision = (SELECT MAX(x.revision) FROM learned_stable x WHERE x.id = ls.id)`,
      now ?? this.clock(),
    )
  }

  private latestStable(stableId: string): StableRow | undefined {
    return get<StableRow>(
      this.db,
      'SELECT * FROM learned_stable WHERE id = ? ORDER BY revision DESC LIMIT 1',
      stableId,
    )
  }
}
