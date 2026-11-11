/**
 * 权利请求与删除传播（方案 §6.4 / §16）。
 *
 * 删除通过事务 outbox 传播到画像、缓存、向量、图谱、训练候选和备份恢复
 * 墓碑；恢复备份必须重新应用删除记录。阶段 B：向量/图谱/训练候选尚未建成，
 * 传播状态如实记录为 not_applicable（不得虚报完成）；查询路径即时过滤。
 * 审计保留最小无原文记录。不可把伪名化称为匿名化。
 */
import { randomUUID } from 'node:crypto'
import { get, nowIso, run, type DB } from '../storage/db.ts'

export type PrivacyRequestKind = 'view' | 'correction' | 'personalization_off' | 'deletion' | 'export'

export type PropagationPhase = 'profiles' | 'retrieval_cache' | 'vectors' | 'graph' | 'training_candidates' | 'backups'

export interface DeletionReceipt {
  readonly requestId: string
  readonly tombstoneId: string
  readonly propagation: Readonly<Record<PropagationPhase, string>>
}

/** 阶段 B 各传播目标的真实状态（未建成的系统如实标注）。 */
const PHASE_B_PROPAGATION: Readonly<Record<PropagationPhase, string>> = {
  profiles: 'done',
  retrieval_cache: 'not_applicable_phase_c',
  vectors: 'not_applicable_phase_c',
  graph: 'not_applicable_phase_c',
  training_candidates: 'not_applicable_phase_d',
  backups: 'pending_backup_cycle',
}

export class DeletionService {
  private readonly db: DB

  constructor(db: DB, opts: { clock?: () => string } = {}) {
    this.db = db
    this.clock = opts.clock ?? nowIso
  }
  private readonly clock: () => string

  /** 提交权利请求（需运营/自助验证后执行）。 */
  submitRequest(viewerKey: string, kind: PrivacyRequestKind, payload?: object): string {
    const requestId = `pr_${randomUUID().slice(0, 12)}`
    run(
      this.db,
      `INSERT INTO privacy_requests (request_id, viewer_key, kind, status, payload)
       VALUES (?, ?, ?, 'received', ?)`,
      requestId,
      viewerKey,
      kind,
      JSON.stringify(payload ?? {}),
    )
    return requestId
  }

  /**
   * 执行删除（验证通过后）：请求 resolved + 墓碑 + profile 标记 + outbox 传播记录。
   * 未验证（verificationPassed=false）→ 请求保持 received 并返回 null（不返回他人画像）。
   */
  executeDeletion(requestId: string, opts: { verificationPassed: boolean; viewerKey: string }): DeletionReceipt | null {
    const request = get<{ viewer_key: string; kind: string; status: string }>(
      this.db,
      'SELECT * FROM privacy_requests WHERE request_id = ?',
      requestId,
    )
    if (!request || request.viewer_key !== opts.viewerKey || request.kind !== 'deletion') return null
    if (!opts.verificationPassed) return null

    const now = this.clock()
    const tombstoneId = `tomb_${randomUUID().slice(0, 12)}`
    run(
      this.db,
      `INSERT INTO deletion_tombstones (tombstone_id, viewer_key, scope, propagation)
       VALUES (?, ?, 'profile_full', ?)`,
      tombstoneId,
      opts.viewerKey,
      JSON.stringify(PHASE_B_PROPAGATION),
    )
    run(
      this.db,
      `UPDATE viewer_profiles SET deletion_status = 'deleted' WHERE viewer_key = ?`,
      opts.viewerKey,
    )
    run(
      this.db,
      `UPDATE privacy_requests SET status = 'resolved', resolved_at = ? WHERE request_id = ?`,
      now,
      requestId,
    )
    // 最小无原文审计（不保留字段正文）
    run(
      this.db,
      `INSERT INTO audit (action, summary) VALUES ('profile_deletion', ?)`,
      `${tombstoneId} viewer=${opts.viewerKey} request=${requestId}`,
    )
    return { requestId, tombstoneId, propagation: PHASE_B_PROPAGATION }
  }

  /** 退出个性化：字段保留但 purpose 过滤生效（仍维护服务与安全事件）。 */
  personalizationOff(viewerKey: string): string {
    const requestId = this.submitRequest(viewerKey, 'personalization_off')
    this.setFieldPurposePrefix(viewerKey, 'service_no_personalization')
    run(
      this.db,
      `UPDATE privacy_requests SET status = 'resolved', resolved_at = ? WHERE request_id = ?`,
      this.clock(),
      requestId,
    )
    return requestId
  }

  /** 删除墓碑清单（恢复流程重放删除时使用）。 */
  tombstones(): readonly { tombstoneId: string; viewerKey: string; propagation: Record<string, string> }[] {
    const rows = this.db
      .prepare('SELECT tombstone_id, viewer_key, propagation FROM deletion_tombstones ORDER BY created_at')
      .all() as Array<{ tombstone_id: string; viewer_key: string; propagation: string }>
    return rows.map((r) => ({
      tombstoneId: r.tombstone_id,
      viewerKey: r.viewer_key,
      propagation: JSON.parse(r.propagation) as Record<string, string>,
    }))
  }

  private setFieldPurposePrefix(viewerKey: string, purpose: string): void {
    run(
      this.db,
      `UPDATE profile_fields SET purpose = ? WHERE viewer_key = ? AND superseded_by IS NULL`,
      purpose,
      viewerKey,
    )
  }
}
