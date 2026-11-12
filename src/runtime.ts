/**
 * LearningRuntime 实现：阶段 A（ingest + answer）+ 阶段 B（画像投影、认知候选）。
 * 阶段 C/D/E 接口仍显式抛出 NotImplementedError（声明能力边界，不做静默空实现）。
 */
import type {
  AnswerReceipt,
  ContextBundle,
  DurableReceipt,
  LearningRuntime,
  LiveEnvelope,
  LiveRequest,
  PolicyDecision,
  ScopedQuery,
  VerificationReport,
} from './types.ts'
import { NotImplementedError } from './types.ts'
import type { BlackboardStore } from './blackboard/store.ts'
import type { DafeiyuConfigType, FeatureGates } from './config.ts'
import type { ConsolidationService } from './governance/consolidation.ts'
import type { ReleaseController } from './governance/release.ts'
import type { MemoryStore } from './memory/l2-store.ts'
import type { ProfileStore } from './audience/profile-store.ts'
import type { RetrievalService } from './retrieval/retrieval.ts'
import { EventDedup } from './perception/dedup.ts'
import { RequestRouter, type RouteContext, type UsageEntry, type UsageRecorder } from './routing/router.ts'
import { get, run, type DB } from './storage/db.ts'

/** usage 表记录器：路由每次尝试都留痕（模型生成、工具执行与播出分别记录 §2.2）。 */
export class SqliteUsageRecorder implements UsageRecorder {
  private readonly db: DB

  constructor(db: DB) {
    this.db = db
  }

  record(entry: UsageEntry): number | null {
    try {
      const res = run(
        this.db,
        `INSERT INTO usage (request_id, generation_epoch, route, reason_code, model, latency_ms, tokens_in, tokens_out, cost_cny)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        entry.requestId,
        entry.epoch,
        entry.route,
        entry.reasonCode ?? null,
        entry.model ?? null,
        entry.latencyMs,
        entry.tokensIn ?? null,
        entry.tokensOut ?? null,
        entry.costCny ?? 0,
      )
      return Number((res as { lastInsertRowid?: number | bigint }).lastInsertRowid ?? 0) || null
    } catch {
      return null
    }
  }
}

export interface RuntimeDeps {
  readonly db: DB
  readonly config: DafeiyuConfigType
  readonly featureGates: FeatureGates
  readonly dedup: EventDedup
  readonly router: RequestRouter
  readonly blackboard: BlackboardStore
  readonly memory?: MemoryStore
  readonly profiles?: ProfileStore
  readonly retrieval?: RetrievalService
  readonly releases?: ReleaseController
  readonly consolidation?: ConsolidationService
}

interface EventRow {
  readonly event_id: string
  readonly viewer_key: string | null
  readonly received_at: string
}

export class DafeiyuRuntime implements LearningRuntime {
  private readonly deps: RuntimeDeps

  constructor(deps: RuntimeDeps) {
    this.deps = deps
  }

  async ingest(event: LiveEnvelope): Promise<DurableReceipt> {
    const verdict = this.deps.dedup.ingest(event)
    return {
      eventId: verdict.eventId,
      duplicate: verdict.duplicate,
      late: verdict.late,
      processed: verdict.processed,
    }
  }

  async answer(request: LiveRequest, ctx?: RouteContext): Promise<AnswerReceipt> {
    const receipt = await this.deps.router.route(request, ctx ?? { recentReplies: [] })
    this.logReply(request, receipt)
    return receipt
  }

  /**
   * reply_log：播出的问答留痕（「最近回复」与反馈归因目标 §10.1）。
   * request_id 幂等（重试不重复记录）；仅保留最近 500 条；留痕失败不阻断播出。
   */
  private logReply(request: LiveRequest, receipt: AnswerReceipt): void {
    try {
      run(
        this.deps.db,
        `INSERT INTO reply_log (request_id, session_id, question_text, reply_text, route)
         VALUES (?, ?, ?, ?, ?) ON CONFLICT(request_id) DO NOTHING`,
        request.requestId,
        request.sessionId,
        request.text,
        receipt.text,
        receipt.route,
      )
      run(
        this.deps.db,
        `DELETE FROM reply_log WHERE reply_id NOT IN (SELECT reply_id FROM reply_log ORDER BY reply_id DESC LIMIT 500)`,
      )
    } catch {
      // 留痕失败不阻断播出（usage 表仍另有路由留痕）
    }
  }

  /**
   * 画像投影（阶段 B）：按事件推进观众画像（最近互动 + 版本号）；
   * 统计字段为查询时可重放聚合（ProfileStore.aggregateInteractionCounts），
   * 不在写入路径冗余存储。观众身份由宿主适配器经 ViewerIdentity 解析后
   * 以 viewerKey 进入事件；本方法不创建未知来源的身份档案（未知如实为空）。
   */
  async updateProfile(eventId: string): Promise<{ revision: number }> {
    const row = get<EventRow>(this.deps.db, 'SELECT event_id, viewer_key, received_at FROM events WHERE event_id = ?', eventId)
    if (!row) throw new Error(`事件不存在: ${eventId}`)
    if (row.viewer_key === null) return { revision: 0 }
    const current = get<{ profile_version: number }>(
      this.deps.db,
      'SELECT profile_version FROM viewer_profiles WHERE viewer_key = ?',
      row.viewer_key,
    )
    if (!current) return { revision: 0 } // 身份未解析：不伪造档案
    const next = current.profile_version + 1
    run(
      this.deps.db,
      `UPDATE viewer_profiles SET last_seen_at = ?, profile_version = ? WHERE viewer_key = ?`,
      row.received_at,
      next,
      row.viewer_key,
    )
    return { revision: next }
  }

  /** 认知候选（阶段 B）：证据独立性、矛盾检测与生命周期由 MemoryStore 执行。 */
  async proposeCognition(input: {
    claim: string
    namespace: string
    scene: string
    subject?: string
    layer?: 'L2' | 'L4'
    evidenceRefs: readonly string[]
  }): Promise<{ ref: string; status: string; challenged: readonly string[] }> {
    if (this.deps.memory === undefined) {
      throw new NotImplementedError('proposeCognition', 'B（未装配 MemoryStore）')
    }
    const result = this.deps.memory.propose({
      claim: input.claim,
      namespace: input.namespace,
      scene: input.scene,
      ...(input.subject !== undefined ? { subject: input.subject } : {}),
      ...(input.layer !== undefined ? { layer: input.layer } : {}),
      evidence: input.evidenceRefs.map((eventId) => ({ eventId })),
    })
    return { ref: result.ref, status: result.entry.status, challenged: result.challenged }
  }

  // ---- 阶段 C/D/E ---------------------------------------------------------

  /** 三路检索（阶段 C）：融合上下文装配（记忆 top-K + 技能 top-K + 预算截断）。 */
  async retrieve(query: ScopedQuery): Promise<ContextBundle> {
    if (this.deps.retrieval === undefined) {
      throw new NotImplementedError('retrieve', 'C（未装配 RetrievalService）')
    }
    const result = await this.deps.retrieval.retrieve({
      text: query.text,
      characterId: query.characterId,
      ...(query.namespaces !== undefined ? { namespaces: query.namespaces } : {}),
      ...(query.viewerKey !== undefined ? { viewerKey: query.viewerKey } : {}),
    })
    return { memories: result.memories, skills: result.skills, injectedTokens: result.injectedTokens }
  }

  trainSlice(): Promise<never> {
    throw new NotImplementedError('trainSlice', 'D（经 TrainingScheduler.executeWindow 调用）')
  }

  /** 阶段 E：对候选执行七道门验证（不改变发布状态；inconclusive 不放行）。 */
  async evaluateRelease(candidate: { releaseId: string; candidateHash: string }): Promise<VerificationReport> {
    if (this.deps.releases === undefined) {
      throw new NotImplementedError('evaluateRelease', 'E（未装配 ReleaseController）')
    }
    const release = this.deps.releases.get(candidate.releaseId)
    if (!release) throw new Error(`发布不存在: ${candidate.releaseId}`)
    const { Verifier } = await import('./governance/verifier.ts')
    const verifier = new Verifier(this.deps.db)
    return verifier.verify({
      manifest: JSON.parse(release.manifest) as import('./governance/verifier.ts').ReleaseManifest,
      candidateHash: candidate.candidateHash,
      baselineReleaseId: release.previous_release_id ?? 'baseline',
    })
  }

  /** 阶段 E：授权校验 → 自动检查 → 灰度 → 激活（无逐次人工点击 §12.1）。 */
  async publish(grant: PolicyDecision): Promise<{ releaseId: string }> {
    if (this.deps.releases === undefined) {
      throw new NotImplementedError('publish', 'E（未装配 ReleaseController）')
    }
    if (grant.result !== 'allow') throw new Error('publish 授权非 allow')
    // payloadHash 绑定候选哈希（issuePublishGrant 签发）
    const releaseId = this.deps.releases.findIdByCandidateHash(grant.payloadHash)
    if (releaseId === null) throw new Error('publish 授权未绑定有效候选')
    const report = this.deps.releases.runAutomatedChecks(releaseId)
    if (report.verdict !== 'pass') {
      throw new Error(`自动检查未通过（${report.verdict}），不发布`)
    }
    this.deps.releases.enterCanary(releaseId)
    const manifest = JSON.parse(this.deps.releases.get(releaseId)?.manifest ?? '{}') as {
      observation?: { sessions: number; samples: number }
    }
    // 观察数据来自 manifest；每阶段至少两场次，不足 ⇒ 停留灰度（§12.3）
    this.deps.releases.advanceCanary(releaseId, manifest.observation ?? { sessions: 0, samples: 0 })
    return { releaseId }
  }

  /** 阶段 E：固化（授权 payloadHash = memory:<sourceId>；条件门全过才写 learned_stable）。 */
  async consolidate(grant: PolicyDecision, sourceMemoryId: string): Promise<{ stableRevision: number }> {
    if (this.deps.consolidation === undefined) {
      throw new NotImplementedError('consolidate', 'E（未装配 ConsolidationService）')
    }
    return this.deps.consolidation.consolidate(grant, sourceMemoryId)
  }

  /** 阶段 E：回滚（epoch+1 阻断 + 恢复上一联合版本 §12.4）。 */
  async rollback(releaseId: string): Promise<{ restoredReleaseId: string }> {
    if (this.deps.releases === undefined) {
      throw new NotImplementedError('rollback', 'E（未装配 ReleaseController）')
    }
    return this.deps.releases.rollback(releaseId)
  }
}
