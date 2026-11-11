import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ResourceArbiter, taskRank } from './arbiter.ts'
import type { ResourceSample } from './probe.ts'
import { FakeProbeHandle as FakeProbe } from '../testing/fake-probe.ts'

const vram = (freeMb: number): ResourceSample => ({
  timestampMs: 1,
  totalVramMb: 8192,
  usedVramMb: 8192 - freeMb,
  freeVramMb: freeMb,
  gpuUtilPct: 50,
})

test('优先级排序：播出安全 > 实时回答 > 反馈复盘 > 后台任务（§3.2）', () => {
  assert.ok(taskRank('broadcast_safety') < taskRank('realtime_local_answer'))
  assert.ok(taskRank('realtime_local_answer') < taskRank('feedback_review'))
  assert.ok(taskRank('feedback_review') < taskRank('approved_background'))
})

test('训练准入：free_vram ≥ peak + reserve 通过', async () => {
  const arbiter = new ResourceArbiter(new FakeProbe(vram(3000)))
  await arbiter.sampleOnce()
  const res = arbiter.evaluateTrainingAdmission({ measuredTrainingPeakMb: 2500, reserveMb: 400 })
  assert.deepEqual(res, { admit: true, freeVramMb: 3000, requiredMb: 2900 })
})

test('训练准入：显存不足 → 延后并给出原因', async () => {
  const arbiter = new ResourceArbiter(new FakeProbe(vram(2800)))
  await arbiter.sampleOnce()
  const res = arbiter.evaluateTrainingAdmission({ measuredTrainingPeakMb: 2500, reserveMb: 400 })
  assert.equal(res.admit, false)
  if (!res.admit) {
    assert.equal(res.reason, 'insufficient_vram')
    assert.ok(res.detail.includes('2800'))
  }
})

test('训练准入：探测不可用 → fail-safe 不准入（开发机场景）', async () => {
  const arbiter = new ResourceArbiter(new FakeProbe(null))
  await arbiter.sampleOnce()
  const res = arbiter.evaluateTrainingAdmission({ measuredTrainingPeakMb: 2500, reserveMb: 400 })
  assert.equal(res.admit, false)
  if (!res.admit) assert.equal(res.reason, 'probe_unavailable')
  // latest() 保持 null（失败采样不入环）
  assert.equal(arbiter.latest(), null)
})

test('采样环：保留有限历史，start/stop 生命周期正常', async () => {
  const arbiter = new ResourceArbiter(new FakeProbe(vram(1000)), { keepSamples: 3 })
  try {
    arbiter.start()
    await arbiter.sampleOnce()
    await arbiter.sampleOnce()
    await arbiter.sampleOnce()
    await arbiter.sampleOnce()
    await arbiter.sampleOnce()
    // 环上限 3（start 的首次采样 + 4 次手动，最多保留 3）
    for (let i = 0; i < 5; i++) await Promise.resolve()
    assert.ok(arbiter.latest() !== null)
  } finally {
    arbiter.stop()
  }
})
