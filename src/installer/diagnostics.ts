/**
 * 诊断报告导出（方案 §24.8）：导出前展示将包含的内容；默认去除密钥及观众直接标识。
 * 报告只含聚合计数与状态分布——不含任何观众伪名、正文、凭据引用值。
 */
import { all, get, type DB } from '../storage/db.ts'

export interface DiagnosticReport {
  readonly generatedAt: string
  readonly schemaMigrations: readonly number[]
  readonly counts: Readonly<Record<string, number>>
  readonly releaseStatus: Readonly<Record<string, number>>
  readonly trainingRunStatus: Readonly<Record<string, number>>
  readonly tombstones: number
  readonly notes: readonly string[]
}

const COUNTED_TABLES = [
  'events', 'memory_candidates', 'viewer_profiles', 'profile_fields',
  'skill_versions', 'skill_runs', 'feedback', 'gift_ledger', 'gift_ack',
  'training_samples', 'training_runs', 'checkpoints', 'releases',
  'verification_reports', 'learned_stable', 'consolidations', 'write_operations',
] as const

function groupCount(db: DB, sql: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const row of all<{ status: string; n: number }>(db, sql)) out[row.status] = row.n
  return out
}

export function exportDiagnosticReport(db: DB, now = (): string => new Date().toISOString()): DiagnosticReport {
  const counts: Record<string, number> = {}
  for (const table of COUNTED_TABLES) {
    counts[table] = get<{ n: number }>(db, `SELECT COUNT(*) AS n FROM ${table}`)?.n ?? 0
  }
  return {
    generatedAt: now(),
    schemaMigrations: all<{ version: number }>(db, 'SELECT version FROM schema_migrations ORDER BY version').map((r) => r.version),
    counts,
    releaseStatus: groupCount(db, 'SELECT status, COUNT(*) AS n FROM releases GROUP BY status'),
    trainingRunStatus: groupCount(db, 'SELECT status, COUNT(*) AS n FROM training_runs GROUP BY status'),
    tombstones: get<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM deletion_tombstones')?.n ?? 0,
    notes: [
      '报告仅含聚合计数与状态分布；不含观众标识、正文、凭据',
      '云端费用以服务商账单为准；礼物标价不等于实际收入',
    ],
  }
}
