/**
 * 事务 outbox 与写入操作登记（方案 §11.2 写入幂等与对账）。
 *
 * 幂等键 = 对象 + revision + 目标命名空间；后端写入成功并保存真实引用后才能
 * 标记 staged/done；响应丢失时进入 reconcile_required，不重复盲写。
 */
import { nowIso, run, type DB } from './db.ts'

export type WriteOpStatus = 'pending' | 'staged' | 'reconcile_required' | 'done' | 'failed'

export interface WriteOperationRow {
  readonly op_id: string
  readonly idempotency_key: string
  readonly decision_id: string | null
  readonly target: string
  readonly payload_hash: string
  readonly status: WriteOpStatus
  readonly backend_ref: string | null
  readonly error: string | null
  readonly created_at: string
  readonly updated_at: string
}

export interface EnqueueResult {
  /** 本次调用是否真正插入（false = 幂等键已存在，返回既有操作） */
  readonly inserted: boolean
  readonly op: WriteOperationRow
}

function getOp(db: DB, opId: string): WriteOperationRow {
  const row = db
    .prepare('SELECT * FROM write_operations WHERE op_id = ?')
    .get(opId) as WriteOperationRow | undefined
  if (!row) throw new Error(`write_operation 不存在: ${opId}`)
  return row
}

function getByKey(db: DB, key: string): WriteOperationRow | undefined {
  return db.prepare('SELECT * FROM write_operations WHERE idempotency_key = ?').get(key) as
    | WriteOperationRow
    | undefined
}

/** 登记待写操作；幂等键冲突时返回既有操作（不重复登记）。 */
export function enqueueWriteOperation(
  db: DB,
  input: {
    opId: string
    idempotencyKey: string
    target: string
    payloadHash: string
    decisionId?: string
  },
): EnqueueResult {
  const existing = getByKey(db, input.idempotencyKey)
  if (existing) return { inserted: false, op: existing }
  run(
    db,
    `INSERT INTO write_operations (op_id, idempotency_key, decision_id, target, payload_hash, status)
     VALUES (?, ?, ?, ?, ?, 'pending')`,
    input.opId,
    input.idempotencyKey,
    input.decisionId ?? null,
    input.target,
    input.payloadHash,
  )
  return { inserted: true, op: getOp(db, input.opId) }
}

/** 后端写入成功并保存真实引用后调用（§11.2：保存真实 ID/版本/摘要才能标记 staged）。 */
export function markStaged(db: DB, opId: string, backendRef: string): WriteOperationRow {
  run(
    db,
    `UPDATE write_operations SET status = 'staged', backend_ref = ?, updated_at = ? WHERE op_id = ?`,
    backendRef,
    nowIso(),
    opId,
  )
  return getOp(db, opId)
}

export function markDone(db: DB, opId: string): WriteOperationRow {
  run(db, `UPDATE write_operations SET status = 'done', updated_at = ? WHERE op_id = ?`, nowIso(), opId)
  return getOp(db, opId)
}

/** 无法确认后端写入结果时调用：进入对账，禁止盲写。 */
export function markReconcileRequired(db: DB, opId: string, error?: string): WriteOperationRow {
  run(
    db,
    `UPDATE write_operations SET status = 'reconcile_required', error = COALESCE(?, error), updated_at = ? WHERE op_id = ?`,
    error ?? null,
    nowIso(),
    opId,
  )
  return getOp(db, opId)
}

export function markFailed(db: DB, opId: string, error: string): WriteOperationRow {
  run(
    db,
    `UPDATE write_operations SET status = 'failed', error = ?, updated_at = ? WHERE op_id = ?`,
    error,
    nowIso(),
    opId,
  )
  return getOp(db, opId)
}

export function listByStatus(db: DB, status: WriteOpStatus): WriteOperationRow[] {
  return db.prepare('SELECT * FROM write_operations WHERE status = ?').all(status) as unknown as WriteOperationRow[]
}

/**
 * 启动恢复扫描：进程中断遗留的 pending 操作标记为 reconcile_required，
 * 由对应处理器对账后决定补偿或完成（§16 启动恢复扫描未完成操作并对账）。
 */
export function recoverPendingOperations(db: DB): number {
  const res = run(
    db,
    `UPDATE write_operations SET status = 'reconcile_required', updated_at = ?
     WHERE status = 'pending'`,
    nowIso(),
  )
  return Number(res.changes)
}
