import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PolicyService } from './policy-decision.ts'
import { makeTmpDb } from '../testing/helpers.ts'

test('签发与校验：allow + 未过期 + 哈希匹配 + epoch 未超越', () => {
  const t = makeTmpDb()
  try {
    let now = '2026-11-11T03:00:00.000Z'
    const svc = new PolicyService(t.db, { policyVersion: 'pv-1', clock: () => now })
    const dec = svc.issue({ action: 'memory_write', payloadHash: 'h1', ttlMs: 60_000 })
    assert.equal(dec.actor, 'policy_service')
    assert.equal(dec.result, 'allow')
    assert.equal(dec.epoch, 0)
    now = '2026-11-11T03:00:30.000Z'
    assert.deepEqual(svc.verify(dec, { payloadHash: 'h1' }), { valid: true })
    // 决策与审计均已落库
    const auditCount = t.db.prepare('SELECT COUNT(*) AS n FROM audit').get() as { n: number }
    assert.equal(auditCount.n, 1)
  } finally {
    t.cleanup()
  }
})

test('过期凭证拒绝', () => {
  const t = makeTmpDb()
  try {
    let now = '2026-11-11T03:00:00.000Z'
    const svc = new PolicyService(t.db, { policyVersion: 'pv-1', clock: () => now })
    const dec = svc.issue({ action: 'train', payloadHash: 'h1', ttlMs: 1_000 })
    now = '2026-11-11T03:00:02.000Z'
    assert.deepEqual(svc.verify(dec), { valid: false, reason: 'expired' })
  } finally {
    t.cleanup()
  }
})

test('payloadHash 不匹配拒绝（正文变化即失效 §11.1）', () => {
  const t = makeTmpDb()
  try {
    const svc = new PolicyService(t.db, { policyVersion: 'pv-1' })
    const dec = svc.issue({ action: 'publish', payloadHash: 'original' })
    assert.deepEqual(svc.verify(dec, { payloadHash: 'tampered' }), {
      valid: false,
      reason: 'hash_mismatch',
    })
  } finally {
    t.cleanup()
  }
})

test('治理纪元：bumpEpoch 后旧凭证失效（§12.4 回滚）', () => {
  const t = makeTmpDb()
  try {
    const svc = new PolicyService(t.db, { policyVersion: 'pv-1' })
    const old = svc.issue({ action: 'consolidate', payloadHash: 'h1' })
    assert.equal(svc.verify(old).valid, true)
    assert.equal(svc.bumpEpoch(), 1)
    const fresh = svc.issue({ action: 'consolidate', payloadHash: 'h2' })
    assert.equal(fresh.epoch, 1)
    assert.deepEqual(svc.verify(old), { valid: false, reason: 'epoch_superseded' })
    assert.equal(svc.verify(fresh).valid, true)
  } finally {
    t.cleanup()
  }
})

test('非 allow 结果不可作为授权', () => {
  const t = makeTmpDb()
  try {
    const svc = new PolicyService(t.db, { policyVersion: 'pv-1' })
    const deny = svc.issue({ action: 'publish', payloadHash: 'h1', result: 'deny' })
    assert.deepEqual(svc.verify(deny), { valid: false, reason: 'not_allow' })
  } finally {
    t.cleanup()
  }
})
