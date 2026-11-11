/**
 * 观众画像字段存储（方案 §6.2 / §6.3 / §6.4）。
 *
 * - 每个字段保存 value / source_event_ids / observed_at / confidence_kind /
 *   expires_at / purpose；更新写新版本（superseded_by 链），可审计；
 * - 统计字段采用可重放聚合（直接从 events 表按事件时间计数）；
 * - 推测（inferred）与明确（viewer_stated/observed）分开；观众纠错直接
 *   覆盖推测值并保留审计链；
 * - 读取按 viewerKey 精确过滤（画像隔离），已删除（墓碑）不返回；
 * - 不从画像做敏感推断；画像默认 local-only、默认不进训练（用途字段）。
 */
import { all, get, jsonArr, nowIso, run, type DB } from '../storage/db.ts'

export type ConfidenceKind = 'observed' | 'inferred' | 'viewer_stated'

export interface ProfileField {
  readonly fieldId: number
  readonly viewerKey: string
  readonly fieldName: string
  readonly value: string
  readonly sourceEventIds: readonly string[]
  readonly observedAt: string
  readonly confidenceKind: ConfidenceKind
  readonly expiresAt: string | null
  readonly purpose: string
}

interface FieldRow {
  field_id: number
  viewer_key: string
  field_name: string
  value: string
  source_event_ids: string
  observed_at: string
  confidence_kind: ConfidenceKind
  expires_at: string | null
  purpose: string
}

export interface SetFieldInput {
  readonly viewerKey: string
  readonly fieldName: string
  readonly value: string
  readonly sourceEventIds?: readonly string[]
  readonly confidenceKind?: ConfidenceKind
  readonly purpose?: string
  readonly expiresAt?: string
}

export class ProfileStore {
  private readonly db: DB
  private readonly clock: () => string

  constructor(db: DB, opts: { clock?: () => string } = {}) {
    this.db = db
    this.clock = opts.clock ?? nowIso
  }

  /** 写字段新版本：旧版本挂 superseded_by（审计链保留）。 */
  setField(input: SetFieldInput): ProfileField {
    const now = this.clock()
    const current = get<{ field_id: number }>(
      this.db,
      `SELECT field_id FROM profile_fields
       WHERE viewer_key = ? AND field_name = ? AND superseded_by IS NULL`,
      input.viewerKey,
      input.fieldName,
    )
    const res = run(
      this.db,
      `INSERT INTO profile_fields (viewer_key, field_name, value, source_event_ids, observed_at, confidence_kind, expires_at, purpose)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      input.viewerKey,
      input.fieldName,
      input.value,
      JSON.stringify(input.sourceEventIds ?? []),
      now,
      input.confidenceKind ?? 'observed',
      input.expiresAt ?? null,
      input.purpose ?? 'service',
    )
    const newId = Number((res as { lastInsertRowid?: number | bigint }).lastInsertRowid ?? 0)
    if (current) {
      run(
        this.db,
        'UPDATE profile_fields SET superseded_by = ? WHERE field_id = ?',
        newId,
        current.field_id,
      )
    }
    return this.getField(newId) as ProfileField
  }

  /** 观众明确纠错：viewer_stated 直接覆盖（推测值仅留审计链）。 */
  viewerCorrection(input: SetFieldInput): ProfileField {
    return this.setField({ ...input, confidenceKind: 'viewer_stated', purpose: input.purpose ?? 'personalization' })
  }

  private getField(fieldId: number): ProfileField | undefined {
    const row = get<FieldRow>(this.db, 'SELECT * FROM profile_fields WHERE field_id = ?', fieldId)
    return row ? toField(row) : undefined
  }

  /**
   * 当前有效字段（隔离读）：仅该 viewerKey、最新版本、未过期、未被删除。
   * 一个观众的字段不会出现在另一观众的查询结果中（§20.2 画像隔离）。
   */
  currentFields(
    viewerKey: string,
    opts: { purposeExclude?: readonly string[]; now?: string } = {},
  ): readonly ProfileField[] {
    const now = opts.now ?? this.clock()
    const deleted = this.isDeleted(viewerKey)
    if (deleted) return []
    const rows = all<FieldRow>(
      this.db,
      `SELECT * FROM profile_fields
       WHERE viewer_key = ? AND superseded_by IS NULL
         AND (expires_at IS NULL OR expires_at > ?)`,
      viewerKey,
      now,
    )
    const exclude = new Set(opts.purposeExclude ?? [])
    return rows.map(toField).filter((f) => !exclude.has(f.purpose))
  }

  /** 可重放聚合：从事件表按观众统计互动（迟到事件按事件时间自然并入）。 */
  aggregateInteractionCounts(viewerKey: string): Readonly<Record<string, number>> {
    const rows = all<{ type: string; n: number }>(
      this.db,
      'SELECT type, COUNT(*) AS n FROM events WHERE viewer_key = ? GROUP BY type',
      viewerKey,
    )
    const out: Record<string, number> = {}
    for (const r of rows) out[r.type] = r.n
    return out
  }

  /** 首次/最近可观测互动时间与昵称（未知字段如实为 null，不伪造）。 */
  profileSummary(viewerKey: string): {
    viewerKey: string
    nickname: string | null
    firstSeenAt: string | null
    lastSeenAt: string | null
    deleted: boolean
  } {
    const row = get<{
      display_nickname: string | null
      first_seen_at: string | null
      last_seen_at: string | null
      deletion_status: string
    }>(this.db, 'SELECT * FROM viewer_profiles WHERE viewer_key = ?', viewerKey)
    if (!row) {
      return { viewerKey, nickname: null, firstSeenAt: null, lastSeenAt: null, deleted: false }
    }
    return {
      viewerKey,
      nickname: row.display_nickname,
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
      deleted: row.deletion_status === 'deleted' || this.isDeleted(viewerKey),
    }
  }

  /** 墓碑或 deletion_status=deleted ⇒ 已删除（查询时过滤，恢复后重放同样生效）。 */
  isDeleted(viewerKey: string): boolean {
    const tomb = get<{ n: number }>(
      this.db,
      'SELECT COUNT(*) AS n FROM deletion_tombstones WHERE viewer_key = ?',
      viewerKey,
    )
    if ((tomb?.n ?? 0) > 0) return true
    const profile = get<{ deletion_status: string }>(
      this.db,
      'SELECT deletion_status FROM viewer_profiles WHERE viewer_key = ?',
      viewerKey,
    )
    return profile?.deletion_status === 'deleted'
  }
}

function toField(r: FieldRow): ProfileField {
  return {
    fieldId: r.field_id,
    viewerKey: r.viewer_key,
    fieldName: r.field_name,
    value: r.value,
    sourceEventIds: jsonArr<string>(r.source_event_ids),
    observedAt: r.observed_at,
    confidenceKind: r.confidence_kind,
    expiresAt: r.expires_at,
    purpose: r.purpose,
  }
}
