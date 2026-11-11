import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BlackboardConflictError, BlackboardStore } from './store.ts'
import { makeTmpDb } from '../testing/helpers.ts'

const write = {
  topic: '种田片段闲聊',
  pendingTasks: [],
  recentEventIds: ['evt_1'],
  activeReleaseId: 'rel-baseline',
  policyVersion: 'p1',
}

test('CAS 写入：首写 revision 0 → 1，续写 1 → 2', () => {
  const t = makeTmpDb()
  try {
    const store = new BlackboardStore(t.db)
    const s1 = store.write('sess-1', 0, write)
    assert.equal(s1.revision, 1)
    const s2 = store.write('sess-1', 1, { ...write, topic: '换话题' })
    assert.equal(s2.revision, 2)
    assert.equal(store.readLatest('sess-1')?.topic, '换话题')
  } finally {
    t.cleanup()
  }
})

test('CAS 冲突：过期 revision 拒绝写入', () => {
  const t = makeTmpDb()
  try {
    const store = new BlackboardStore(t.db)
    store.write('sess-1', 0, write)
    store.write('sess-1', 1, write)
    assert.throws(() => store.write('sess-1', 1, write), BlackboardConflictError)
  } finally {
    t.cleanup()
  }
})

test('TTL：过期快照读取为空（过期游戏状态不驱动动作）', () => {
  const t = makeTmpDb()
  try {
    let now = '2026-11-11T03:00:00.000Z'
    const store = new BlackboardStore(t.db, { clock: () => now })
    store.write('sess-1', 0, { ...write, ttlMs: 10_000 })
    assert.ok(store.readActive('sess-1') !== undefined)
    now = '2026-11-11T03:00:11.000Z'
    assert.equal(store.readActive('sess-1'), undefined)
    // 但过期快照仍占据 revision 基线：CAS 以 1 为准
    assert.equal(store.readLatest('sess-1')?.revision, 1)
  } finally {
    t.cleanup()
  }
})

test('场次隔离：不同 session 互不可见', () => {
  const t = makeTmpDb()
  try {
    const store = new BlackboardStore(t.db)
    store.write('sess-1', 0, write)
    assert.equal(store.readLatest('sess-2'), undefined)
    store.write('sess-2', 0, { ...write, topic: '另一个场次' })
    assert.equal(store.readLatest('sess-1')?.topic, '种田片段闲聊')
  } finally {
    t.cleanup()
  }
})
