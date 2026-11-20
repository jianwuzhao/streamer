import assert from 'node:assert/strict'
import { test } from 'node:test'
import { blendMotionTargets, DialogueMotion, NEUTRAL_TARGETS } from './dialogue-motion.ts'

test('对话阶段推进：倾听 → 思考 → 说话 → 收尾，动作由事件触发而非待机', () => {
  const motion = new DialogueMotion()
  assert.equal(motion.currentPhase, 'listening')
  const thinking = motion.apply('think', 1000)
  assert.equal(motion.currentPhase, 'thinking')
  // 思考慢过渡：侧头、视线偏上、轻微皱眉
  assert.equal(thinking.tilt, 0.12)
  assert.ok(thinking.gazeY < 0)
  assert.ok(thinking.brow < 0)
  assert.ok(thinking.blendMs >= 800)
  const speaking = motion.apply('speak', 2000)
  assert.equal(motion.currentPhase, 'speaking')
  // 说话期间姿态收敛，让口型成为主角
  assert.ok(speaking.nod === 0 && Math.abs(speaking.tilt) < 0.12)
  const closing = motion.apply('tail', 3000)
  assert.equal(motion.currentPhase, 'closing')
  assert.ok(closing.nod > 0)
  // 三个事件各生效一次（初始倾听态不是事件）
  assert.equal(motion.stats().applied, 3)
})

test('连发弹幕合并：合并窗口内只触发一次，重触发限频，说话期间幅度压小', () => {
  const motion = new DialogueMotion({ mergeWindowMs: 700, retriggerMs: 1800 })
  const first = motion.apply('danmaku', 1000)
  assert.ok(first.gazeX !== 0)
  // 同一窗口内的后续弹幕：吞掉，姿态不变（引用同一对象）
  assert.equal(motion.apply('danmaku', 1200), first)
  assert.equal(motion.apply('danmaku', 1600), first)
  assert.equal(motion.stats().coalesced, 2)
  // 过了合并窗口但未过重触发间隔：仍被吞（刷屏不能变成不停点头）
  assert.equal(motion.apply('danmaku', 2000), first)
  assert.equal(motion.stats().coalesced, 3)
  // 过了重触发间隔：重新触发，且视线方向交替（不总往同一边看）
  const second = motion.apply('danmaku', 3000)
  assert.ok(second.gazeX !== 0 && Math.sign(second.gazeX) !== Math.sign(first.gazeX))
  assert.equal(motion.stats().applied, 2)
  // 说话期间同一次互动幅度被压到 35%
  motion.apply('speak', 5000)
  const during = motion.apply('danmaku', 6000)
  assert.ok(Math.abs(during.gazeX) < Math.abs(first.gazeX))
})

test('点头候选受限频约束，说话期间拒绝点头以免与口型冲突', () => {
  const motion = new DialogueMotion({ retriggerMs: 1800 })
  const first = motion.apply('input-start', 1000)
  assert.ok(first.nod > 0)
  assert.equal(motion.apply('input-pause', 1200), first)
  assert.equal(motion.stats().coalesced, 1)
  motion.apply('speak', 5000)
  const before = motion.stats()
  motion.apply('input-start', 6000)
  assert.equal(motion.stats().rejected, before.rejected + 1)
  assert.equal(motion.currentPhase, 'speaking')
})

test('轻互动抬眉点头，和弹幕共用限频，安全态保持中性', () => {
  const motion = new DialogueMotion()
  const reaction = motion.apply('reaction', 1000)
  assert.ok(reaction.nod > 0 && reaction.brow > 0)
  assert.equal(motion.apply('danmaku', 1200), reaction)
  motion.apply('safe', 2000)
  assert.equal(motion.apply('reaction', 4000), NEUTRAL_TARGETS)
})

test('打断与紧急停止：回到中性、递增版本、清空在途动作', () => {
  const motion = new DialogueMotion()
  motion.apply('think', 1000)
  const versionsBefore = motion.currentVersion
  const interrupted = motion.apply('interrupt', 2000)
  assert.deepEqual(interrupted, NEUTRAL_TARGETS)
  assert.equal(motion.currentPhase, 'listening')
  assert.ok(motion.currentVersion > versionsBefore)
  assert.equal(motion.stats().interruptions, 1)
  const safe = motion.apply('safe', 3000)
  assert.deepEqual(safe, NEUTRAL_TARGETS)
  assert.equal(motion.currentPhase, 'safe')
  // 安全态里一切都拒收：弹幕/思考不得把画面从暂停里拉出来
  const rejectedBefore = motion.stats().rejected
  motion.apply('danmaku', 4000)
  motion.apply('think', 4500)
  motion.apply('speak', 4600)
  assert.ok(motion.stats().rejected >= rejectedBefore + 3)
  assert.equal(motion.currentPhase, 'safe')
  // 恢复后回到倾听，版本继续递增（旧在途动作仍然作废）
  const resumeVersion = motion.currentVersion
  motion.apply('resume', 5000)
  assert.equal(motion.currentPhase, 'listening')
  assert.ok(motion.currentVersion > resumeVersion)
})

test('时间倒退按更晚处理，非法时间戳不改变状态', () => {
  const motion = new DialogueMotion({ mergeWindowMs: 700, retriggerMs: 100 })
  motion.apply('danmaku', 5000)
  // 迟到的事件（时钟回退）不应重置合并窗口而多触发一次
  const late = motion.apply('danmaku', 4000)
  assert.equal(motion.stats().coalesced, 1)
  assert.equal(motion.stats().applied, 1)
  assert.ok(late.gazeX !== 0)
  const before = motion.targets
  assert.equal(motion.apply('think', Number.NaN), before)
  assert.equal(motion.currentPhase, 'listening')
})

test('与既有渲染器合成：安全态/减少动态归零，说话期间动作权重压低', () => {
  const targets = { gazeX: 0.8, gazeY: -0.2, sway: 0.4, nod: 0.6, brow: 0.5, tilt: 0.4, blendMs: 300 }
  const normal = blendMotionTargets(targets)
  assert.ok(normal.swing > 0 && normal.nod > 0 && normal.gaze > 0)
  assert.deepEqual(blendMotionTargets(targets, { safe: true }), { swing: 0, nod: 0, gaze: 0, brow: 0 })
  assert.deepEqual(blendMotionTargets(targets, { reducedMotion: true }), { swing: 0, nod: 0, gaze: 0, brow: 0 })
  const speaking = blendMotionTargets(targets, { speaking: true })
  assert.ok(Math.abs(speaking.gaze) < Math.abs(normal.gaze))
  // 参数有界：任何输入都不产生越界姿态
  const extreme = blendMotionTargets({ gazeX: 9, gazeY: 9, sway: -9, nod: 9, brow: -9, tilt: 9, blendMs: 0 })
  assert.ok(Math.abs(extreme.gaze) <= 1 && extreme.nod <= 1 && Math.abs(extreme.swing) <= 1)
})
