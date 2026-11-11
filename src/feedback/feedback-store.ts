/**
 * 反馈采集与纠错（方案 §10.1）。
 *
 * - feedback 记录反馈与目标归因（回复/技能运行），无法归因时标记片段级；
 * - 纠错流程：received → verifying → resolved / insufficient_evidence；
 * - 明确隐私/越权问题可立即升级（暂停对应条目由记忆/技能侧处理）；
 * - 普通观众意见不能覆写他人画像或核心人设（本模块不提供写入口）。
 */
import { randomUUID } from 'node:crypto'
import { all, get, nowIso, run, type DB } from '../storage/db.ts'

export type FeedbackLabel =
  | 'useful'
  | 'wrong'
  | 'off_persona'
  | 'too_slow'
  | 'not_remembered'
  | 'complaint'
  | 'privacy'

export type FeedbackStatus = 'received' | 'verifying' | 'resolved' | 'insufficient_evidence'

export interface FeedbackRecordInput {
  readonly sourceEventId?: string
  readonly actorKind: 'viewer' | 'operator' | 'system'
  readonly viewerKey?: string
  readonly targetReplyId?: string
  readonly targetSkillRunId?: string
  readonly label: FeedbackLabel
  readonly correction?: string
  readonly evidence?: readonly string[]
  readonly consentScope?: string
}

export interface FeedbackRecord {
  readonly feedbackId: string
  readonly label: FeedbackLabel
  readonly status: FeedbackStatus
  readonly targetReplyId: string | null
  readonly targetSkillRunId: string | null
  /** 无法定位具体回复时为 true（片段级反馈，不强行归因） */
  readonly fragment: boolean
  readonly correction: string | null
}

interface Row {
  feedback_id: string
  label: FeedbackLabel
  status: FeedbackStatus
  target_reply_id: string | null
  target_skill_run_id: string | null
  correction: string | null
}

export class FeedbackStore {
  private readonly db: DB
  private readonly clock: () => string

  constructor(db: DB, opts: { clock?: () => string } = {}) {
    this.db = db
    this.clock = opts.clock ?? nowIso
  }

  record(input: FeedbackRecordInput): FeedbackRecord {
    const feedbackId = `fb_${randomUUID().slice(0, 12)}`
    const attributed = input.targetReplyId !== undefined || input.targetSkillRunId !== undefined
    run(
      this.db,
      `INSERT INTO feedback (feedback_id, source_event_id, actor_kind, viewer_key, target_reply_id,
        target_skill_run_id, label, correction, evidence, consent_scope, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      feedbackId,
      input.sourceEventId ?? null,
      input.actorKind,
      input.viewerKey ?? null,
      input.targetReplyId ?? null,
      input.targetSkillRunId ?? null,
      input.label,
      input.correction ?? null,
      JSON.stringify(input.evidence ?? []),
      input.consentScope ?? null,
      'received',
    )
    return {
      feedbackId,
      label: input.label,
      status: 'received',
      targetReplyId: input.targetReplyId ?? null,
      targetSkillRunId: input.targetSkillRunId ?? null,
      fragment: !attributed,
      correction: input.correction ?? null,
    }
  }

  /** 状态推进：received → verifying → resolved | insufficient_evidence。 */
  advance(feedbackId: string, next: FeedbackStatus, note?: string): FeedbackRecord {
    const allowed: Record<FeedbackStatus, FeedbackStatus[]> = {
      received: ['verifying', 'resolved', 'insufficient_evidence'],
      verifying: ['resolved', 'insufficient_evidence'],
      resolved: [],
      insufficient_evidence: [],
    }
    const current = this.get(feedbackId)
    if (!current) throw new Error(`反馈不存在: ${feedbackId}`)
    if (!allowed[current.status].includes(next)) {
      throw new Error(`反馈状态不可从 ${current.status} 迁移到 ${next}`)
    }
    run(
      this.db,
      `UPDATE feedback SET status = ?, updated_at = ? WHERE feedback_id = ?`,
      next,
      this.clock(),
      feedbackId,
    )
    if (note !== undefined) {
      run(this.db, `INSERT INTO audit (action, summary) VALUES ('feedback', ?)`, `${feedbackId} → ${next}: ${note}`)
    }
    return this.get(feedbackId) as FeedbackRecord
  }

  /** 隐私/越权投诉立即升级：直接 resolved 并写审计（供下游暂停条目）。 */
  escalate(feedbackId: string): FeedbackRecord {
    const current = this.get(feedbackId)
    if (!current) throw new Error(`反馈不存在: ${feedbackId}`)
    run(this.db, `UPDATE feedback SET status = 'resolved', updated_at = ? WHERE feedback_id = ?`, this.clock(), feedbackId)
    run(
      this.db,
      `INSERT INTO audit (action, summary) VALUES ('feedback_escalation', ?)`,
      `${feedbackId} label=${current.label} 立即升级处理`,
    )
    return this.get(feedbackId) as FeedbackRecord
  }

  get(feedbackId: string): FeedbackRecord | undefined {
    const row = get<Row>(this.db, 'SELECT * FROM feedback WHERE feedback_id = ?', feedbackId)
    return row ? toRecord(row) : undefined
  }

  /** 定位某条回复的全部反馈（管理员纠错入口）。 */
  byTargetReply(replyId: string): readonly FeedbackRecord[] {
    return all<Row>(this.db, 'SELECT * FROM feedback WHERE target_reply_id = ? ORDER BY created_at', replyId).map(toRecord)
  }

  /** 按严重性排序的待处理队列（负面反馈不按打赏排序，§10.1）。 */
  pendingQueue(): readonly FeedbackRecord[] {
    return all<Row>(
      this.db,
      `SELECT * FROM feedback WHERE status IN ('received','verifying') ORDER BY created_at`,
    ).map(toRecord)
  }
}

function toRecord(r: Row): FeedbackRecord {
  return {
    feedbackId: r.feedback_id,
    label: r.label,
    status: r.status,
    targetReplyId: r.target_reply_id,
    targetSkillRunId: r.target_skill_run_id,
    fragment: r.target_reply_id === null && r.target_skill_run_id === null,
    correction: r.correction,
  }
}
