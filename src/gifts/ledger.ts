/**
 * 礼物账本（方案 §10.2）。
 *
 * - 只接收授权平台事件；账本与学习证据分离；
 * - (platform, event_id) 幂等去重；连击按平台累计数计算增量，重复/乱序/
 *   断线补发不重复累加；
 * - 收到/待结算/已结算/退款/冲正分别记账；退款用抵消记录而非删除历史；
 * - 无稳定交易 ID 时用事件键去重并标记 verification_status=unverified；
 * - 标价（face_value）与实际结算分开，不当作实收。
 */
import { get, nowIso, run, type DB } from '../storage/db.ts'

export type SettlementStatus = 'received' | 'pending_settlement' | 'settled' | 'refunded' | 'reversed'

export interface GiftEventInput {
  readonly platform: string
  readonly roomId: string
  readonly eventId: string
  readonly viewerKey: string
  readonly giftId: string
  /** 无连击时直接给数量 */
  readonly quantity?: number | undefined
  /** 平台累计连击数（以此为增量基准） */
  readonly comboTotal?: number | undefined
  readonly comboId?: string | undefined
  readonly transactionId?: string | undefined
  readonly faceValue?: number | undefined
  readonly currency?: string | undefined
  readonly verified: boolean
  readonly receivedAt?: string | undefined
}

export interface IngestResult {
  readonly entryId: number | null
  readonly duplicate: boolean
  /** 乱序/重复累计通知：不入账（增量 ≤ 0） */
  readonly ignored: boolean
  readonly quantityDelta: number
}

export interface LedgerTotals {
  readonly receivedQty: number
  readonly pendingSettlementQty: number
  readonly settledQty: number
  readonly refundedQty: number
  readonly faceValueSum: number
  readonly unverifiedCount: number
}

export class GiftLedger {
  private readonly db: DB

  constructor(db: DB) {
    this.db = db
  }

  ingest(input: GiftEventInput): IngestResult {
    const dup = get<{ entry_id: number }>(
      this.db,
      'SELECT entry_id FROM gift_ledger WHERE platform = ? AND event_id = ?',
      input.platform,
      input.eventId,
    )
    if (dup) {
      return { entryId: dup.entry_id, duplicate: true, ignored: true, quantityDelta: 0 }
    }

    let delta: number
    if (input.comboId !== undefined && input.comboTotal !== undefined) {
      // 连击：按平台累计数计算增量，不得把累计通知再次累加
      const last = get<{ max_total: number }>(
        this.db,
        'SELECT MAX(combo_total) AS max_total FROM gift_ledger WHERE combo_id = ?',
        input.comboId,
      )
      const prev = last?.max_total ?? 0
      delta = Math.max(0, input.comboTotal - prev)
    } else {
      delta = input.quantity ?? 1
    }
    if (delta <= 0) {
      // 乱序/重复累计通知：只留痕不重复入账（§10.2 处理重复、乱序和断线补发）
      const res = run(
        this.db,
        `INSERT INTO gift_ledger (platform, room_id, event_id, viewer_key, gift_id, combo_id, combo_total,
           quantity_delta, unit, face_value, currency, settlement_status, verification_status, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'unit', ?, ?, 'received', ?, ?)`,
        input.platform,
        input.roomId,
        input.eventId,
        input.viewerKey,
        input.giftId,
        input.comboId ?? null,
        input.comboTotal ?? 0,
        input.faceValue ?? null,
        input.currency ?? null,
        input.verified ? 'verified' : 'unverified',
        input.receivedAt ?? nowIso(),
      )
      return {
        entryId: Number((res as { lastInsertRowid?: number | bigint }).lastInsertRowid ?? 0) || null,
        duplicate: false,
        ignored: true,
        quantityDelta: 0,
      }
    }

    const res = run(
      this.db,
      `INSERT INTO gift_ledger (platform, room_id, transaction_id, event_id, viewer_key, gift_id, combo_id, combo_total,
         quantity_delta, unit, face_value, currency, settlement_status, verification_status, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'unit', ?, ?, 'received', ?, ?)`,
      input.platform,
      input.roomId,
      input.transactionId ?? null,
      input.eventId,
      input.viewerKey,
      input.giftId,
      input.comboId ?? null,
      input.comboTotal ?? 0,
      delta,
      input.faceValue ?? null,
      input.currency ?? null,
      input.verified ? 'verified' : 'unverified',
      input.receivedAt ?? nowIso(),
    )
    return {
      entryId: Number((res as { lastInsertRowid?: number | bigint }).lastInsertRowid ?? 0) || null,
      duplicate: false,
      ignored: false,
      quantityDelta: delta,
    }
  }

  /** 结算状态推进（官方账单对账入口：received/pending → settled）。 */
  settle(entryId: number): void {
    run(
      this.db,
      `UPDATE gift_ledger SET settlement_status = 'settled' WHERE entry_id = ? AND settlement_status IN ('received','pending_settlement')`,
      entryId,
    )
  }

  markPendingSettlement(entryId: number): void {
    run(
      this.db,
      `UPDATE gift_ledger SET settlement_status = 'pending_settlement' WHERE entry_id = ? AND settlement_status = 'received'`,
      entryId,
    )
  }

  /** 退款：抵消记录（负增量 + refunded），原记录保留、历史不删除。 */
  refund(originalEntryId: number, refundRef: string): number | null {
    const original = get<{
      platform: string
      room_id: string
      viewer_key: string
      gift_id: string
      quantity_delta: number
      face_value: number | null
      currency: string | null
    }>(this.db, 'SELECT * FROM gift_ledger WHERE entry_id = ?', originalEntryId)
    if (!original) return null
    const res = run(
      this.db,
      `INSERT INTO gift_ledger (platform, room_id, event_id, viewer_key, gift_id, quantity_delta, unit,
         face_value, currency, settlement_status, refund_ref, verification_status, received_at)
       VALUES (?, ?, ?, ?, ?, ?, 'unit', ?, ?, 'refunded', ?, 'verified', ?)`,
      original.platform,
      original.room_id,
      `refund:${refundRef}:${originalEntryId}`,
      original.viewer_key,
      original.gift_id,
      -original.quantity_delta,
      original.face_value,
      original.currency,
      refundRef,
      nowIso(),
    )
    return Number((res as { lastInsertRowid?: number | bigint }).lastInsertRowid ?? 0) || null
  }

  /** 聚合：收到的礼物、待结算、已结算、退款与未对账项（标价 ≠ 实收）。 */
  totals(): LedgerTotals {
    const row = get<{
      received_qty: number
      pending_qty: number
      settled_qty: number
      refunded_qty: number
      face_sum: number
      unverified: number
    }>(
      this.db,
      `SELECT
         COALESCE(SUM(CASE WHEN quantity_delta > 0 AND settlement_status IN ('received','settled','pending_settlement') THEN quantity_delta ELSE 0 END), 0) AS received_qty,
         COALESCE(SUM(CASE WHEN settlement_status = 'pending_settlement' THEN quantity_delta ELSE 0 END), 0) AS pending_qty,
         COALESCE(SUM(CASE WHEN settlement_status = 'settled' THEN quantity_delta ELSE 0 END), 0) AS settled_qty,
         COALESCE(SUM(CASE WHEN settlement_status = 'refunded' THEN -quantity_delta ELSE 0 END), 0) AS refunded_qty,
         COALESCE(SUM(CASE WHEN quantity_delta > 0 THEN face_value ELSE 0 END), 0) AS face_sum,
         COALESCE(SUM(CASE WHEN verification_status = 'unverified' THEN 1 ELSE 0 END), 0) AS unverified
       FROM gift_ledger`,
    )
    return {
      receivedQty: row?.received_qty ?? 0,
      pendingSettlementQty: row?.pending_qty ?? 0,
      settledQty: row?.settled_qty ?? 0,
      refundedQty: row?.refunded_qty ?? 0,
      faceValueSum: row?.face_sum ?? 0,
      unverifiedCount: row?.unverified ?? 0,
    }
  }

  entry(entryId: number): { entryId: number; viewerKey: string; giftId: string; quantityDelta: number; settlementStatus: SettlementStatus } | undefined {
    const row = this.db
      .prepare('SELECT entry_id, viewer_key, gift_id, quantity_delta, settlement_status FROM gift_ledger WHERE entry_id = ?')
      .get(entryId) as
      | { entry_id: number; viewer_key: string; gift_id: string; quantity_delta: number; settlement_status: SettlementStatus }
      | undefined
    return row
      ? {
          entryId: row.entry_id,
          viewerKey: row.viewer_key,
          giftId: row.gift_id,
          quantityDelta: row.quantity_delta,
          settlementStatus: row.settlement_status,
        }
      : undefined
  }
}
