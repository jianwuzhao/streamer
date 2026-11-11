/**
 * 黑板存储：Session 工作记忆投影（方案 §2.4）。
 *
 * - 按角色/场次隔离，保存任务状态和事实引用，不保存模型隐式推理；
 * - 写入使用 revision 比较与交换（CAS），冲突受控；
 * - 过期快照（含过期游戏状态）不可继续驱动动作：读取时过滤。
 */
import { all, jsonArr, nowIso, run, type DB } from '../storage/db.ts'
import type { BlackboardSnapshot } from '../types.ts'

export const DEFAULT_TTL_MS = 30_000

export class BlackboardConflictError extends Error {
  public readonly sessionId: string
  public readonly expectedRevision: number
  public readonly actualRevision: number
  constructor(sessionId: string, expectedRevision: number, actualRevision: number) {
    super(
      `黑板写入冲突：session=${sessionId} 期望 revision=${expectedRevision}，实际 ${actualRevision}`,
    )
    this.name = 'BlackboardConflictError'
    this.sessionId = sessionId
    this.expectedRevision = expectedRevision
    this.actualRevision = actualRevision
  }
}

interface SnapshotRow {
  readonly id: number
  readonly session_id: string
  readonly revision: number
  readonly topic: string
  readonly game_state_ref: string | null
  readonly pending_tasks: string
  readonly recent_event_ids: string
  readonly active_release_id: string
  readonly policy_version: string
  readonly expires_at: string
  readonly created_at: string
}

function rowToSnapshot(row: SnapshotRow): BlackboardSnapshot {
  return {
    revision: row.revision,
    sessionId: row.session_id,
    topic: row.topic,
    ...(row.game_state_ref !== null ? { gameStateRef: row.game_state_ref } : {}),
    pendingTasks: jsonArr<string>(row.pending_tasks),
    recentEventIds: jsonArr<string>(row.recent_event_ids),
    activeReleaseId: row.active_release_id,
    policyVersion: row.policy_version,
    expiresAt: row.expires_at,
  }
}

export interface BlackboardWrite {
  readonly topic: string
  readonly gameStateRef?: string
  readonly pendingTasks: readonly string[]
  readonly recentEventIds: readonly string[]
  readonly activeReleaseId: string
  readonly policyVersion: string
  /** TTL 毫秒数，写入时换算为 expiresAt */
  readonly ttlMs?: number
}

export class BlackboardStore {
  private readonly db: DB
  private readonly clock: () => string

  constructor(db: DB, opts: { clock?: () => string } = {}) {
    this.db = db
    this.clock = opts.clock ?? nowIso
  }

  /** 当前最新 revision（含已过期快照，作为 CAS 基线）；无快照返回 undefined。 */
  readLatest(sessionId: string): BlackboardSnapshot | undefined {
    const rows = all<SnapshotRow>(
      this.db,
      'SELECT * FROM blackboard_snapshots WHERE session_id = ? ORDER BY revision DESC LIMIT 1',
      sessionId,
    )
    const row = rows[0]
    return row ? rowToSnapshot(row) : undefined
  }

  /** 读取未过期快照；过期即视为不存在（过期游戏状态不可继续驱动动作）。 */
  readActive(sessionId: string): BlackboardSnapshot | undefined {
    const latest = this.readLatest(sessionId)
    if (!latest) return undefined
    const expiresMs = Date.parse(latest.expiresAt)
    if (!Number.isNaN(expiresMs) && Date.parse(this.clock()) >= expiresMs) return undefined
    return latest
  }

  /**
   * CAS 写入：expectedRevision 必须等于当前最新 revision（首写传 0）。
   * 成功后 revision = expectedRevision + 1，expiresAt = clock() + ttlMs。
   */
  write(sessionId: string, expectedRevision: number, next: BlackboardWrite): BlackboardSnapshot {
    const current = this.readLatest(sessionId)
    const actualRevision = current?.revision ?? 0
    if (expectedRevision !== actualRevision) {
      throw new BlackboardConflictError(sessionId, expectedRevision, actualRevision)
    }
    const revision = actualRevision + 1
    const ttlMs = next.ttlMs ?? DEFAULT_TTL_MS
    const expiresAt = new Date(Date.parse(this.clock()) + ttlMs).toISOString()
    run(
      this.db,
      `INSERT INTO blackboard_snapshots
         (session_id, revision, topic, game_state_ref, pending_tasks, recent_event_ids,
          active_release_id, policy_version, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      sessionId,
      revision,
      next.topic,
      next.gameStateRef ?? null,
      JSON.stringify(next.pendingTasks),
      JSON.stringify(next.recentEventIds),
      next.activeReleaseId,
      next.policyVersion,
      expiresAt,
    )
    return {
      revision,
      sessionId,
      topic: next.topic,
      ...(next.gameStateRef !== undefined ? { gameStateRef: next.gameStateRef } : {}),
      pendingTasks: next.pendingTasks,
      recentEventIds: next.recentEventIds,
      activeReleaseId: next.activeReleaseId,
      policyVersion: next.policyVersion,
      expiresAt,
    }
  }
}
