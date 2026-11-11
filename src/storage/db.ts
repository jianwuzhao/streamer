/**
 * SQLite 存储基座：node:sqlite（宿主 Electron Node 24 / 开发机 Node 26 均内置），
 * 零原生编译依赖。WAL + 外键 + 版本化迁移（方案 §16）。
 */
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { MIGRATIONS } from './migrations.ts'

export type DB = DatabaseSync

export interface MigrationResult {
  readonly applied: readonly number[]
  readonly alreadyApplied: readonly number[]
}

/** 打开数据库并设置 PRAGMA（幂等）。 */
export function openDatabase(dbPath: string): DB {
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec('PRAGMA foreign_keys = ON;')
  db.exec('PRAGMA busy_timeout = 5000;')
  db.exec('PRAGMA synchronous = NORMAL;')
  return db
}

/** 执行版本化迁移：每个未应用版本在单事务内执行并登记；重复调用幂等。 */
export function migrate(db: DB): MigrationResult {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );`)
  const appliedRows = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{
    version: number
  }>
  const appliedSet = new Set(appliedRows.map((r) => r.version))

  const newlyApplied: number[] = []
  const alreadyApplied: number[] = []
  for (const m of [...MIGRATIONS].sort((a, b) => a.version - b.version)) {
    if (appliedSet.has(m.version)) {
      alreadyApplied.push(m.version)
      continue
    }
    db.exec('BEGIN;')
    try {
      db.exec(m.sql)
      db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)').run(m.version, m.name)
      db.exec('COMMIT;')
      newlyApplied.push(m.version)
    } catch (err) {
      db.exec('ROLLBACK;')
      throw new Error(`迁移 ${m.version} (${m.name}) 失败：${(err as Error).message}`)
    }
  }
  return { applied: newlyApplied, alreadyApplied }
}

// ---------------------------------------------------------------------------
// 轻量查询助手（统一 unknown → T 收窄）
// ---------------------------------------------------------------------------

export function all<T>(db: DB, sql: string, ...params: SQLInputValue[]): T[] {
  return db.prepare(sql).all(...params) as T[]
}

export function get<T>(db: DB, sql: string, ...params: SQLInputValue[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined
}

export function run(db: DB, sql: string, ...params: SQLInputValue[]): { changes: number | bigint } {
  return db.prepare(sql).run(...params) as { changes: number | bigint }
}

/** JSON 数组列的安全解析。 */
export function jsonArr<T>(text: string | null | undefined): T[] {
  if (text == null || text === '') return []
  try {
    const v = JSON.parse(text)
    return Array.isArray(v) ? (v as T[]) : []
  } catch {
    return []
  }
}

export function nowIso(): string {
  return new Date().toISOString()
}
