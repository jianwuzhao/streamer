/**
 * 事件去重与迟到窗口（方案 §2.4 / §6.3）。
 *
 * - event_id / (source, source_event_id) 双键去重，至少一次投递下消费者幂等；
 * - 接收游标 + 有界迟到窗口：窗口内迟到事件照常处理（可更新投影），
 *   窗口外只入库记录，不进入处理链路、不重放已完成动作。
 */
import { run, type DB } from '../storage/db.ts'
import type { LiveEnvelope } from '../types.ts'

export const DEFAULT_LATE_WINDOW_MS = 120_000

export interface EvaluateResult {
  /** (source, source_event_id) 已存在：重复事件，直接丢弃 */
  readonly duplicate: boolean
  /** occurredAt 落在接收游标的有界窗口之外 */
  readonly late: boolean
  /** 是否进入处理链路（非重复且窗口内） */
  readonly processed: boolean
}

export class EventDedup {
  private readonly lateWindowMs: number
  private readonly db: DB
  /** source → 该来源已见最大 receivedAt（毫秒） */
  private readonly cursor = new Map<string, number>()

  constructor(db: DB, opts: { lateWindowMs?: number } = {}) {
    this.db = db
    this.lateWindowMs = opts.lateWindowMs ?? DEFAULT_LATE_WINDOW_MS
  }

  /** 评估一个 envelope：重复/迟到判定（不写库）。 */
  evaluate(env: LiveEnvelope): EvaluateResult {
    const dup = this.db
      .prepare('SELECT 1 FROM events WHERE source = ? AND source_event_id = ?')
      .get(env.source, env.sourceEventId)
    if (dup) return { duplicate: true, late: false, processed: false }

    const cursorMs = this.cursor.get(env.source)
    if (cursorMs !== undefined) {
      const occurredMs = Date.parse(env.occurredAt)
      if (!Number.isNaN(occurredMs) && occurredMs < cursorMs - this.lateWindowMs) {
        return { duplicate: false, late: true, processed: false }
      }
    }
    return { duplicate: false, late: false, processed: true }
  }

  /** 入库并推进游标（调用方须先 evaluate 并按结果决定处理）。 */
  record(env: LiveEnvelope): void {
    run(
      this.db,
      `INSERT INTO events
         (event_id, source, source_event_id, room_id, session_id, viewer_key, type,
          occurred_at, received_at, provenance, purpose_tags, payload_ref,
          correlation_id, causal_event_ids, replay)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      env.eventId,
      env.source,
      env.sourceEventId,
      env.roomId,
      env.sessionId,
      env.viewerKey ?? null,
      env.type,
      env.occurredAt,
      env.receivedAt,
      env.provenance,
      JSON.stringify(env.purposeTags),
      env.payloadRef,
      env.correlationId ?? null,
      JSON.stringify(env.causalEventIds),
      env.replay ? 1 : 0,
    )
    const receivedMs = Date.parse(env.receivedAt)
    if (!Number.isNaN(receivedMs)) {
      const cur = this.cursor.get(env.source) ?? Number.NEGATIVE_INFINITY
      if (receivedMs > cur) this.cursor.set(env.source, receivedMs)
    }
  }

  /** 便捷组合：评估 + 入库 + 返回回执。 */
  ingest(env: LiveEnvelope): EvaluateResult & { eventId: string } {
    const verdict = this.evaluate(env)
    if (!verdict.duplicate) this.record(env)
    return { ...verdict, eventId: env.eventId }
  }
}
