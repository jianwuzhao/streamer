import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  enqueueWriteOperation,
  listByStatus,
  markDone,
  markReconcileRequired,
  markStaged,
  recoverPendingOperations,
} from './outbox.ts'
import { makeTmpDb } from '../testing/helpers.ts'

test('幂等键去重：同一键第二次 enqueue 返回既有操作', () => {
  const t = makeTmpDb()
  try {
    const first = enqueueWriteOperation(t.db, {
      opId: 'op-1',
      idempotencyKey: 'memory:L2:claim-001:rev1:evolving_cognition',
      target: 'memory',
      payloadHash: 'abc',
    })
    assert.equal(first.inserted, true)

    const second = enqueueWriteOperation(t.db, {
      opId: 'op-2',
      idempotencyKey: 'memory:L2:claim-001:rev1:evolving_cognition',
      target: 'memory',
      payloadHash: 'abc',
    })
    assert.equal(second.inserted, false)
    assert.equal(second.op.op_id, 'op-1')
    assert.equal(listByStatus(t.db, 'pending').length, 1)
  } finally {
    t.cleanup()
  }
})

test('状态流转：pending → staged(带后端引用) → done', () => {
  const t = makeTmpDb()
  try {
    const { op } = enqueueWriteOperation(t.db, {
      opId: 'op-1',
      idempotencyKey: 'k1',
      target: 'skill',
      payloadHash: 'h1',
    })
    markStaged(t.db, 'op-1', 'rsi:skill-abc@3')
    markDone(t.db, 'op-1')
    assert.equal(listByStatus(t.db, 'done').length, 1)
    assert.equal(op.status, 'pending')
  } finally {
    t.cleanup()
  }
})

test('启动恢复：遗留 pending 转 reconcile_required，不盲写', () => {
  const t = makeTmpDb()
  try {
    enqueueWriteOperation(t.db, { opId: 'op-1', idempotencyKey: 'k1', target: 'x', payloadHash: 'h' })
    enqueueWriteOperation(t.db, { opId: 'op-2', idempotencyKey: 'k2', target: 'x', payloadHash: 'h' })
    markReconcileRequired(t.db, 'op-2', 'backend response lost')
    const moved = recoverPendingOperations(t.db)
    assert.equal(moved, 1)
    assert.equal(listByStatus(t.db, 'pending').length, 0)
    assert.equal(listByStatus(t.db, 'reconcile_required').length, 2)
    // 幂等：再次恢复为 0
    assert.equal(recoverPendingOperations(t.db), 0)
  } finally {
    t.cleanup()
  }
})
