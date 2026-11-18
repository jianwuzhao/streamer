import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  applyClosedOverride, createLipTimeline, evaluateLipTimeline, LipTimelineError,
  LipTimelinePlayer, LIP_MAX_FRAMES, measureFirstAudio, VISEME_KEYS,
} from './lip-timeline.ts'

const base = (overrides: Record<string, unknown> = {}) => ({
  turnId: 'turn-1', profileId: 'xiaxia', sampleRate: 24_000,
  startSample: 0, endSample: 24_000, frames: [], ...overrides,
})

test('时间线校验：非法 sampleRate/窗口/帧位置一律显式报错，不静默丢弃', () => {
  const bad = (input: Record<string, unknown>, code: string) =>
    assert.throws(() => createLipTimeline(input as any), (err: any) => err instanceof LipTimelineError && err.code === code)
  bad(base({ sampleRate: 100 }), 'invalid_sample_rate')
  bad(base({ sampleRate: 24_000.5 }), 'invalid_sample_rate')
  bad(base({ startSample: 100, endSample: 100 }), 'invalid_window')
  bad(base({ startSample: 200, endSample: 100 }), 'invalid_window')
  bad(base({ turnId: '' }), 'invalid_turn')
  bad(base({ profileId: 'x'.repeat(121) }), 'invalid_profile')
  bad(base({ source: 'guess' }), 'invalid_frame')
  // 帧位置落在窗口外：拒绝而不是忽略，避免口型在句中留空洞
  bad(base({ frames: [{ sample: 24_001, visemes: { open: 1 } }] }), 'invalid_frame')
  bad(base({ frames: [{ sample: -1, visemes: { open: 1 } }] }), 'invalid_frame')
  // 权重越界不是错误：钳到 0–1 后继续，整句不因单帧越界而丢弃
  const clamped = createLipTimeline(base({ frames: [{ sample: 10, visemes: { open: 5, closed: -2 } }] }) as any)
  assert.deepEqual(clamped.frames[0]!.visemes, { open: 1, closed: 0, round: 0, wide: 0, teeth: 0, smile: 0 })
})

test('帧上限与去重：同位置后者覆盖，按采样位置升序，缺省来源按降级', () => {
  const frames = Array.from({ length: LIP_MAX_FRAMES + 1 }, (_, i) => ({ sample: i, visemes: { open: 0.5 } }))
  assert.throws(() => createLipTimeline(base({ endSample: LIP_MAX_FRAMES, frames }) as any),
    (err: any) => err.code === 'too_many_frames')
  const timeline = createLipTimeline(base({ frames: [
    { sample: 400, visemes: { open: 0.4 } }, { sample: 100, visemes: { open: 0.1 } },
    { sample: 400, visemes: { open: 0.9 } },
  ] }) as any)
  assert.deepEqual(timeline.frames.map((f) => f.sample), [100, 400])
  assert.equal(timeline.frames[1]!.visemes.open, 0.9)
  // 未声明来源时按 estimated：不允许把估计结果说成对齐结果
  assert.equal(timeline.source, 'estimated')
  assert.equal(evaluateLipTimeline(timeline, 400)!.degraded, true)
})

test('求值按播放位置短插值，窗口外返回 null 不做边缘外推', () => {
  const timeline = createLipTimeline(base({ startSample: 1000, endSample: 2000, frames: [
    { sample: 1000, visemes: { open: 0, round: 0 } },
    { sample: 2000, visemes: { open: 1, round: 1 } },
  ] }) as any)
  assert.equal(evaluateLipTimeline(timeline, 999), null)
  assert.equal(evaluateLipTimeline(timeline, 2001), null)
  assert.equal(evaluateLipTimeline(timeline, Number.NaN), null)
  // 中点线性插值：连读过渡，不跳变
  const middle = evaluateLipTimeline(timeline, 1500)!
  assert.ok(Math.abs(middle.open - 0.5) < 1e-9 && Math.abs(middle.round - 0.5) < 1e-9)
  // 首帧之前保持在首帧（不外推），末帧之后保持末帧
  assert.equal(evaluateLipTimeline(timeline, 1000)!.open, 0)
  assert.equal(evaluateLipTimeline(timeline, 2000)!.open, 1)
  // 空帧表给出全零而不是 null：句子还没算出口型时也应收口
  const empty = evaluateLipTimeline(createLipTimeline(base() as any), 100)!
  assert.equal(VISEME_KEYS.every((key) => empty[key] === 0), true)
})

test('闭唇压制开口：b/p/m 必须闭口，不能被呼吸余量顶开', () => {
  assert.equal(applyClosedOverride(0.09, 1), 0)
  assert.ok(Math.abs(applyClosedOverride(0.5, 0.5) - 0.25) < 1e-9)
  assert.equal(applyClosedOverride(0.3, 0), 0.3)
  assert.equal(applyClosedOverride(5, 0), 1)
  assert.equal(applyClosedOverride(0.5, 9), 0)
  assert.equal(applyClosedOverride(Number.NaN, 0.5), 0)
  // 时间线求值时同样生效：闭唇帧的开口归零，其余维度保留
  const timeline = createLipTimeline(base({ frames: [
    { sample: 0, visemes: { open: 0.8, closed: 1, teeth: 0.2 } },
    { sample: 1000, visemes: { open: 0.8, closed: 0 } },
  ] }) as any)
  const closed = evaluateLipTimeline(timeline, 0)!
  assert.equal(closed.open, 0)
  assert.equal(closed.closed, 1)
  assert.equal(closed.teeth, 0.2)
  assert.equal(evaluateLipTimeline(timeline, 1000)!.open, 0.8)
})

test('播放器只接受同话轮内更新的顺序号，跨话轮与换角色拒收', () => {
  const player = new LipTimelinePlayer()
  const first = createLipTimeline(base({ sequence: 1, frames: [{ sample: 0, visemes: { open: 0.2 } }] }) as any)
  assert.equal(player.load(first), true)
  // 同话轮旧顺序号：拒收（迟到的重算结果不得覆盖新结果）
  assert.equal(player.load(createLipTimeline(base({ sequence: 1, frames: [] }) as any)), false)
  assert.equal(player.load(createLipTimeline(base({ sequence: 2, frames: [{ sample: 0, visemes: { open: 0.9 } }] }) as any)), true)
  assert.equal(player.evaluate(0)!.open, 0.9)
  // 同话轮但角色不符：拒收（角色切换后旧口型作废）
  assert.equal(player.load(createLipTimeline(base({ sequence: 3, profileId: 'lubai', frames: [] }) as any)), false)
  // 换话轮：接受，旧话轮样本在求值时被丢弃
  const next = createLipTimeline(base({ turnId: 'turn-2', sequence: 0, frames: [{ sample: 0, visemes: { open: 0.1 } }] }) as any)
  assert.equal(player.load(next), true)
  assert.equal(player.evaluate(0, 'turn-1'), null)
  assert.ok(Math.abs(player.evaluate(0, 'turn-2')!.open - 0.1) < 1e-9)
  const stats = player.stats()
  // 接受：seq1、seq2、turn-2；拒收：seq1 重复、seq3 换角色
  assert.equal(stats.applied, 3)
  assert.equal(stats.rejected, 2)
})

test('装载时窗口外的口型直接拒收，过期判断与打断递增播放版本', () => {
  const player = new LipTimelinePlayer()
  const timeline = createLipTimeline(base({ startSample: 1000, endSample: 2000, frames: [] }) as any)
  // 播放位置还没进入该段：拒收，避免把未开始的样本当作当前口型
  assert.equal(player.load(timeline, 500), false)
  assert.equal(player.load(timeline, 1500), true)
  assert.equal(player.isExpired(2000), false)
  assert.equal(player.isExpired(2001), true)
  const before = player.playbackVersion
  assert.equal(player.interrupt(), before + 1)
  assert.equal(player.evaluate(1500), null)
  assert.equal(player.timeline, undefined)
})

test('降级留痕：估计来源计入 degraded，对齐来源不计', () => {
  const player = new LipTimelinePlayer()
  player.load(createLipTimeline(base({ turnId: 'a', source: 'aligned', frames: [] }) as any))
  player.load(createLipTimeline(base({ turnId: 'b', frames: [] }) as any))
  player.load(createLipTimeline(base({ turnId: 'c', source: 'estimated', frames: [] }) as any))
  assert.equal(player.stats().degraded, 2)
  assert.equal(player.stats().applied, 3)
})

test('首音预算分三段记录，目标区间 1–2 秒，未测到如实为 null', () => {
  const budget = measureFirstAudio({ inputEndAt: 1000, reviewDoneAt: 1400, firstPcmAt: 1800, firstAudibleAt: 2600 })
  assert.deepEqual(budget, { reviewMs: 400, pcmMs: 800, audibleMs: 1600, withinTarget: true })
  assert.equal(measureFirstAudio({ inputEndAt: 1000, firstAudibleAt: 5000 }).withinTarget, false)
  assert.equal(measureFirstAudio({ inputEndAt: 1000, firstAudibleAt: 1000 }).withinTarget, false)
  // 没测到实际首音时不能假定达标
  const unmeasured = measureFirstAudio({ inputEndAt: 1000, firstPcmAt: 1500 })
  assert.equal(unmeasured.audibleMs, null)
  assert.equal(unmeasured.withinTarget, null)
  assert.equal(measureFirstAudio({ inputEndAt: Number.NaN, firstPcmAt: 1500 }).pcmMs, null)
  // 早于输入结束的时间戳不可信，按未测得处理
  assert.equal(measureFirstAudio({ inputEndAt: 2000, firstPcmAt: 1500 }).pcmMs, null)
})
