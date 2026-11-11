import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  BudgetExpiredError,
  GenerationRegistry,
  makePlaybackKey,
  RequestBudget,
} from './budget.ts'

const spec = { totalDeadlineMs: 12_000, localAttemptMs: 5_000, outputReserveMs: 1_500 }

test('共享预算：随时间递减，扣除播出预留', () => {
  let now = 1_000_000
  const b = new RequestBudget(spec, () => now).start()
  try {
    assert.equal(b.elapsedMs(), 0)
    assert.equal(b.remainingMs(), 12_000)
    assert.equal(b.availableForGenerationMs(), 10_500)
    assert.equal(b.localRemainingMs(), Math.min(5_000, 10_500))
    now += 6_000
    assert.equal(b.remainingMs(), 6_000)
    // 本地阶段预算已过：localRemaining ≤ 0，但总预算仍在
    assert.ok(b.localRemainingMs() <= 0)
    now += 6_000
    assert.ok(b.remainingMs() <= 0)
    assert.throws(() => b.throwIfExpired(), BudgetExpiredError)
  } finally {
    b.dispose()
  }
})

test('各阶段不重新获得完整超时：本地剩余被总预算钳制', () => {
  let now = 0
  const b = new RequestBudget(spec, () => now).start()
  try {
    now = 9_000 // 本地预算窗口（5s）已过很久，总预算剩 3s
    assert.equal(b.availableForGenerationMs(), 1_500)
    assert.equal(b.localRemainingMs(), Math.min(-4_000, 1_500))
  } finally {
    b.dispose()
  }
})

test('GenerationRegistry：epoch 分配与迟到丢弃（§4.2）', () => {
  const reg = new GenerationRegistry()
  const e1 = reg.nextEpoch('req-1') // 本地
  const e2 = reg.nextEpoch('req-1') // 云端升级
  assert.equal(e1, 1)
  assert.equal(e2, 2)
  // 云端（最新）结果可签发
  assert.equal(reg.shouldDeliver('req-1', e2), true)
  reg.markIssued('req-1', e2)
  // 签发后：任何后续/迟到结果（含本地 e1、乃至新 e3）都不再播出
  assert.equal(reg.shouldDeliver('req-1', e1), false)
  const e3 = reg.nextEpoch('req-1')
  assert.equal(reg.shouldDeliver('req-1', e3), false)
  reg.cleanup('req-1')
  assert.equal(reg.shouldDeliver('req-1', 4), false)
})

test('makePlaybackKey：request_id + generation_epoch', () => {
  assert.equal(makePlaybackKey('r1', 3), 'r1#3')
  assert.notEqual(makePlaybackKey('r1', 3), makePlaybackKey('r1', 4))
})
