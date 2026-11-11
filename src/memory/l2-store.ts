/**
 * L2/L4 记忆存储与生命周期（方案 §5）。
 *
 * - 状态机：proposed → validated → active → challenged / expired / superseded；
 * - 每次状态变化写入新 revision（不可变），血缘（supersedes）保留；
 * - 过期在查询时立即生效，不依赖后台清理（§5.3）；
 * - 矛盾检测（保守规则）：同 layer+namespace+subject+scene 且 claim 不同、
 *   有效期重叠 → 双方 challenged，检索不把任何一方呈现为确定事实（§5.2）；
 * - persona_core 无写权限（配置语义校验已硬性禁止，本层不提供入口）。
 */
import { createHash, randomUUID } from 'node:crypto'
import { all, get, jsonArr, nowIso, run, type DB } from '../storage/db.ts'
import {
  countIndependentEvidence,
  MIN_INDEPENDENT_EVIDENCE,
  type EvidenceRef,
} from './evidence.ts'

export type MemoryLayer = 'L2' | 'L4'
export type MemoryStatus =
  | 'proposed'
  | 'validated'
  | 'active'
  | 'challenged'
  | 'expired'
  | 'superseded'

export interface MemoryEntry {
  readonly id: string
  readonly revision: number
  readonly layer: MemoryLayer
  readonly namespace: string
  readonly claim: string
  readonly kind: string
  readonly characterId: string
  readonly scene: string
  readonly subject: string
  readonly supportingEvidence: readonly string[]
  readonly counterEvidence: readonly string[]
  readonly status: MemoryStatus
  readonly validFrom: string
  readonly expiresAt: string
  readonly reviewAfter: string
  readonly supersedes: string | null
}

interface DbRow {
  id: string
  revision: number
  layer: MemoryLayer
  namespace: string
  claim: string
  kind: string
  character_id: string
  scene: string
  subject: string
  supporting_evidence: string
  counter_evidence: string
  status: MemoryStatus
  valid_from: string
  expires_at: string
  review_after: string
  supersedes: string | null
}

/** INSERT 入参形态（集合字段为数组，insert 时序列化）。 */
interface InsertRow {
  id: string
  revision: number
  layer: MemoryLayer
  namespace: string
  claim: string
  kind: string
  character_id: string
  scene: string
  subject: string
  supporting_evidence: readonly string[]
  counter_evidence: readonly string[]
  status: MemoryStatus
  valid_from: string
  expires_at: string
  review_after: string
  supersedes: string | null
}

export interface ProposeInput {
  readonly claim: string
  readonly namespace: string
  readonly layer?: MemoryLayer
  readonly kind?: string
  readonly scene: string
  /** 冲突判定用主体键（如 game_pacing.farming），调用方负责规范化 */
  readonly subject?: string
  readonly evidence: readonly EvidenceRef[]
  readonly evidenceConflicts?: readonly string[]
}

export interface ProposeResult {
  readonly ref: string
  readonly entry: MemoryEntry
  readonly independentEvidence: number
  /** 因本条目而被标记 challenged 的既有条目 */
  readonly challenged: readonly string[]
}

const toEntry = (r: DbRow): MemoryEntry => ({
  id: r.id,
  revision: r.revision,
  layer: r.layer,
  namespace: r.namespace,
  claim: r.claim,
  kind: r.kind,
  characterId: r.character_id,
  scene: r.scene,
  subject: r.subject,
  supportingEvidence: jsonArr<string>(r.supporting_evidence),
  counterEvidence: jsonArr<string>(r.counter_evidence),
  status: r.status,
  validFrom: r.valid_from,
  expiresAt: r.expires_at,
  reviewAfter: r.review_after,
  supersedes: r.supersedes,
})

export class MemoryStore {
  private readonly db: DB
  private readonly clock: () => string
  private readonly opts: {
    characterId: string
    l2TtlDays: number
    l2ReviewAfterDays: number
    l4TtlDays: number
    conflictDetection: boolean
  }

  constructor(
    db: DB,
    opts: {
      characterId: string
      l2TtlDays?: number
      l2ReviewAfterDays?: number
      l4TtlDays?: number
      conflictDetection?: boolean
      clock?: () => string
    },
  ) {
    this.db = db
    this.clock = opts.clock ?? nowIso
    this.opts = {
      characterId: opts.characterId,
      l2TtlDays: opts.l2TtlDays ?? 7,
      l2ReviewAfterDays: opts.l2ReviewAfterDays ?? 2,
      l4TtlDays: opts.l4TtlDays ?? 14,
      conflictDetection: opts.conflictDetection ?? true,
    }
  }

  /**
   * 提出认知候选：独立证据达标 → validated 并自动转 active；
   * 与既有条目实质冲突（保守规则）→ 双方 challenged。
   */
  propose(input: ProposeInput): ProposeResult {
    const verdict = countIndependentEvidence(input.evidence)
    const independent = verdict.independent.length
    const layer = input.layer ?? 'L2'
    const now = this.clock()
    const id = `cog_${randomUUID().slice(0, 12)}`
    const ttlDays = layer === 'L2' ? this.opts.l2TtlDays : this.opts.l4TtlDays
    const reviewDays = layer === 'L2' ? this.opts.l2ReviewAfterDays : Math.ceil(ttlDays / 2)
    const expiresAt = new Date(Date.parse(now) + ttlDays * 86_400_000).toISOString()
    const reviewAfter = new Date(Date.parse(now) + reviewDays * 86_400_000).toISOString()

    // 保守矛盾检测：同主体同场景、claim 不同、有效期重叠、既有条目尚未失效
    const challenged: string[] = []
    if (this.opts.conflictDetection && (input.subject ?? '') !== '') {
      const candidates = all<DbRow>(
        this.db,
        `SELECT * FROM memory_candidates mc
         WHERE mc.subject = ? AND mc.scene = ? AND mc.layer = ? AND mc.namespace = ?
           AND mc.claim_hash != ? AND mc.status IN ('validated','active')
           AND mc.expires_at > ?
           AND mc.revision = (SELECT MAX(x.revision) FROM memory_candidates x WHERE x.id = mc.id)`,
        input.subject ?? '',
        input.scene,
        layer,
        input.namespace,
        claimHash(input.claim),
        now,
      )
      for (const c of candidates) challenged.push(`${c.id}:${c.revision}`)
    }
    const status: MemoryStatus =
      independent >= MIN_INDEPENDENT_EVIDENCE ? 'active' : 'proposed'

    const entry = this.insert({
      id,
      revision: 1,
      layer,
      namespace: input.namespace,
      claim: input.claim,
      kind: input.kind ?? (layer === 'L2' ? 'hypothesis' : 'verified_experience'),
      character_id: this.opts.characterId,
      scene: input.scene,
      subject: input.subject ?? '',
      supporting_evidence: verdict.independent.map((e) => e.eventId),
      counter_evidence: [...(input.evidenceConflicts ?? [])],
      status: challenged.length > 0 ? 'challenged' : status,
      valid_from: now,
      expires_at: expiresAt,
      review_after: reviewAfter,
      supersedes: null,
    })

    // 既有冲突条目双方保持版本并标记 challenged（§5.2）
    for (const ref of challenged) {
      const [id0] = ref.split(':')
      if (id0 !== undefined) this.transition(id0, 'challenged', input.evidence.map((e) => e.eventId))
    }
    return { ref: `${id}:1`, entry, independentEvidence: independent, challenged }
  }

  /** 检索可见条目：最新 revision、active 且未过期（查询时过期立即生效）。 */
  activeFor(scene: string, opts: { subject?: string; layer?: MemoryLayer; now?: string } = {}): readonly MemoryEntry[] {
    const now = opts.now ?? this.clock()
    const rows = all<DbRow>(
      this.db,
      `SELECT * FROM memory_candidates mc
       WHERE mc.scene = ? AND mc.status = 'active' AND mc.expires_at > ?
         ${opts.subject !== undefined ? 'AND mc.subject = ?' : ''}
         ${opts.layer !== undefined ? 'AND mc.layer = ?' : ''}
         AND mc.revision = (SELECT MAX(x.revision) FROM memory_candidates x WHERE x.id = mc.id)
       ORDER BY mc.updated_at DESC`,
      ...[scene, now, ...(opts.subject !== undefined ? [opts.subject] : []), ...(opts.layer !== undefined ? [opts.layer] : [])],
    )
    return rows.map(toEntry)
  }

  latest(id: string): MemoryEntry | undefined {
    const row = get<DbRow>(
      this.db,
      'SELECT * FROM memory_candidates WHERE id = ? ORDER BY revision DESC LIMIT 1',
      id,
    )
    return row ? toEntry(row) : undefined
  }

  /** 增加反例证据：新 revision，状态转 challenged（证据撤销传播的入口）。 */
  addCounterEvidence(id: string, eventId: string): MemoryEntry | undefined {
    const current = this.latest(id)
    if (!current) return undefined
    return this.insert({
      ...rowFromEntry(current),
      revision: current.revision + 1,
      counter_evidence: [...current.counterEvidence, eventId],
      status: current.status === 'proposed' ? 'proposed' : 'challenged',
    })
  }

  /** 修订：同 id 新 revision 取代旧 revision，血缘（supersedes 链）保留。 */
  supersede(id: string, newClaim: string, evidence: readonly EvidenceRef[]): MemoryEntry | undefined {
    const current = this.latest(id)
    if (!current) return undefined
    const verdict = countIndependentEvidence(evidence)
    const now = this.clock()
    const ttlDays = current.layer === 'L2' ? this.opts.l2TtlDays : this.opts.l4TtlDays
    return this.insert({
      ...rowFromEntry(current),
      revision: current.revision + 1,
      claim: newClaim,
      supporting_evidence: verdict.independent.map((e) => e.eventId),
      status: verdict.independent.length >= MIN_INDEPENDENT_EVIDENCE ? 'active' : 'proposed',
      valid_from: now,
      expires_at: new Date(Date.parse(now) + ttlDays * 86_400_000).toISOString(),
      supersedes: `${current.id}:${current.revision}`,
    })
  }

  /** 状态迁移（challenged/superseded 等）：写新 revision，旧 revision 保留。 */
  transition(id: string, status: MemoryStatus, evidenceEventIds: readonly string[] = []): MemoryEntry | undefined {
    const current = this.latest(id)
    if (!current) return undefined
    return this.insert({
      ...rowFromEntry(current),
      revision: current.revision + 1,
      status,
      supporting_evidence: [
        ...current.supportingEvidence,
        ...evidenceEventIds.filter((e) => !current.supportingEvidence.includes(e)),
      ],
    })
  }

  /** 到期复核列表（review_after 已到且最新 revision 仍 active）。 */
  reviewDue(now?: string): readonly MemoryEntry[] {
    const rows = all<DbRow>(
      this.db,
      `SELECT * FROM memory_candidates mc
       WHERE mc.status = 'active' AND mc.review_after <= ?
         AND mc.revision = (SELECT MAX(x.revision) FROM memory_candidates x WHERE x.id = mc.id)
       ORDER BY mc.review_after`,
      now ?? this.clock(),
    )
    return rows.map(toEntry)
  }

  /** 血缘链（修订保留全部来源）。 */
  lineage(id: string): readonly MemoryEntry[] {
    return all<DbRow>(this.db, 'SELECT * FROM memory_candidates WHERE id = ? ORDER BY revision', id).map(toEntry)
  }

  // -------------------------------------------------------------------------

  private insert(r: InsertRow): MemoryEntry {
    run(
      this.db,
      `INSERT INTO memory_candidates
         (id, revision, layer, namespace, claim, claim_hash, kind, character_id, scene, subject,
          supporting_evidence, counter_evidence, status, valid_from, expires_at, review_after, supersedes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      r.id,
      r.revision,
      r.layer,
      r.namespace,
      r.claim,
      claimHash(r.claim),
      r.kind,
      r.character_id,
      r.scene,
      r.subject,
      JSON.stringify(r.supporting_evidence),
      JSON.stringify(r.counter_evidence),
      r.status,
      r.valid_from,
      r.expires_at,
      r.review_after,
      r.supersedes,
    )
    return {
      id: r.id,
      revision: r.revision,
      layer: r.layer,
      namespace: r.namespace,
      claim: r.claim,
      kind: r.kind,
      characterId: r.character_id,
      scene: r.scene,
      subject: r.subject,
      supportingEvidence: r.supporting_evidence,
      counterEvidence: r.counter_evidence,
      status: r.status,
      validFrom: r.valid_from,
      expiresAt: r.expires_at,
      reviewAfter: r.review_after,
      supersedes: r.supersedes,
    }
  }
}

function rowFromEntry(e: MemoryEntry): InsertRow {
  return {
    id: e.id,
    revision: e.revision,
    layer: e.layer,
    namespace: e.namespace,
    claim: e.claim,
    kind: e.kind,
    character_id: e.characterId,
    scene: e.scene,
    subject: e.subject,
    supporting_evidence: [...e.supportingEvidence],
    counter_evidence: [...e.counterEvidence],
    status: e.status,
    valid_from: e.validFrom,
    expires_at: e.expiresAt,
    review_after: e.reviewAfter,
    supersedes: e.supersedes,
  }
}

export function claimHash(claim: string): string {
  return createHash('sha256').update(claim).digest('hex')
}
