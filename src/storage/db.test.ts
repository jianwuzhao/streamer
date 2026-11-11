import assert from 'node:assert/strict'
import { test } from 'node:test'
import { all, jsonArr, migrate, openDatabase } from './db.ts'
import { makeTmpDb } from '../testing/helpers.ts'

test('迁移幂等：重复执行不重复应用', () => {
  const t = makeTmpDb()
  try {
    const second = migrate(t.db)
    assert.deepEqual(second.applied, [])
    assert.deepEqual([...second.alreadyApplied].sort(), [1, 2, 3, 4, 5, 6])
    const rows = all<{ version: number }>(t.db, 'SELECT version FROM schema_migrations ORDER BY version')
    assert.equal(rows.length, 6)
  } finally {
    t.cleanup()
  }
})

test('阶段 B 新表存在（记忆/画像/技能/反馈礼物）', () => {
  const t = makeTmpDb()
  try {
    const tables = all<{ name: string }>(
      t.db,
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    ).map((r) => r.name)
    for (const expected of [
      'memory_candidates',
      'viewer_profiles',
      'profile_fields',
      'privacy_requests',
      'deletion_tombstones',
      'skill_versions',
      'skill_runs',
      'feedback',
      'gift_ledger',
      'gift_ack',
    ]) {
      assert.ok(tables.includes(expected), `缺少表 ${expected}`)
    }
  } finally {
    t.cleanup()
  }
})

test('WAL 与外键已启用，阶段 A 表全部存在', () => {
  const t = makeTmpDb()
  try {
    const journal = t.db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }
    assert.equal(journal.journal_mode, 'wal')
    const fk = t.db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }
    assert.equal(fk.foreign_keys, 1)
    const tables = all<{ name: string }>(
      t.db,
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    ).map((r) => r.name)
    for (const expected of [
      'events',
      'session_state',
      'blackboard_snapshots',
      'decisions',
      'write_operations',
      'usage',
      'audit',
      'governance_state',
      'schema_migrations',
    ]) {
      assert.ok(tables.includes(expected), `缺少表 ${expected}`)
    }
  } finally {
    t.cleanup()
  }
})

test('jsonArr 安全解析：坏 JSON / 非数组 / 空值返回空数组', () => {
  assert.deepEqual(jsonArr<string>('["a","b"]'), ['a', 'b'])
  assert.deepEqual(jsonArr<string>('not json'), [])
  assert.deepEqual(jsonArr<string>('{"a":1}'), [])
  assert.deepEqual(jsonArr<string>(null), [])
})

test('openDatabase 自动创建父目录', () => {
  const t = makeTmpDb()
  const nested = `${t.dir}/a/b/c.db`
  try {
    const db = openDatabase(nested)
    db.close()
    assert.ok(true)
  } finally {
    t.cleanup()
  }
})
