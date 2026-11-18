import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

// Execute the shipped, single-file host client; no second copy of the motion implementation.
const client = readFileSync(new URL('../../client/client.js', import.meta.url), 'utf8')
const { createAvatarMotion, avatarPcmFeatures, avatarPlaybackTime, avatarReplyEmotion } = runInNewContext(
  client + '\n;({ createAvatarMotion, avatarPcmFeatures, avatarPlaybackTime, avatarReplyEmotion })',
  { window: { __ModuleLoader__: { load() {} } } },
)

test('实际 PCM 播放位置驱动开口：静音、短音节和尾部边界，不以请求时间猜测', () => {
  const rate = 24000
  const data = new Float32Array(rate)
  for (let i = 2400; i < 4800; i++) data[i] = Math.sin(i * 2 * Math.PI * 180 / rate) * 0.1
  assert.equal(avatarPcmFeatures(data, rate, 0.05).level, 0)
  assert.ok(avatarPcmFeatures(data, rate, 0.15).level > 0.6)
  assert.equal(avatarPcmFeatures(data, rate, 0.3).level, 0)
  assert.equal(avatarPcmFeatures(data, rate, -1).level, 0)
  assert.equal(avatarPcmFeatures(data, rate, 1).level, 0)
  assert.equal(avatarPcmFeatures(data, 0, 0).level, 0)
})

test('优先输出设备时钟，时钟缺失或设备切换使用显式延迟回退，暂停时不驱动', () => {
  const context = { state: 'running', currentTime: 4, outputLatency: 0.08,
    getOutputTimestamp: () => ({ contextTime: 3.9, performanceTime: 1000 }) }
  assert.equal(avatarPlaybackTime(context, 1020), 3.92)
  assert.equal(avatarPlaybackTime({ ...context, state: 'suspended' }, 1020), null)
  assert.equal(avatarPlaybackTime({ ...context, getOutputTimestamp: () => ({ contextTime: 0, performanceTime: 0 }) }, 1020), 3.92)
  assert.equal(avatarPlaybackTime(context, 1500), 3.92)
})

test('口型平滑在 30/60/120 FPS 下均于 80ms 内跟随，短停顿保持但长静音收口', () => {
  for (const step of [1000 / 30, 1000 / 60, 1000 / 120]) {
    const motion = createAvatarMotion(() => 0.5)
    motion(0, { speaking: true, level: 0 })
    let pose
    for (let time = step; time <= 80; time += step) pose = motion(time, { speaking: true, level: 0.8 })
    assert.ok(pose.opening > 0.8, String(step))
    for (let time = 80; time <= 160; time += step) pose = motion(time, { speaking: true, level: 0 })
    assert.ok(pose.opening > 0.05 && pose.opening < 0.2)
    for (let time = 180; time < 700; time += step) pose = motion(time, { speaking: true, level: 0 })
    assert.equal(pose.opening, 0)
  }
})

test('倾听有眨眼与轻点头，安全态立即清零，减少动态仍保留准确口型', () => {
  const motion = createAvatarMotion(() => 0.5)
  motion(0, { listening: true })
  for (let time = 16; time < 550; time += 16) motion(time, { listening: true })
  assert.ok(motion(550, { listening: true }).nod > 0.15)
  const blink = motion(1900, { listening: true })
  assert.equal(blink.mode, 'listening')
  assert.ok(motion(1965, { listening: true }).blink > 0.95)
  const reduced = motion(2000, { speaking: true, level: 1, reducedMotion: true })
  assert.ok(reduced.opening > 0)
  assert.equal(reduced.blink + reduced.sway + reduced.nod + reduced.breath, 0)
  const safe = motion(2016, { safe: true, speaking: true, level: 1, emotion: 1 })
  assert.equal(safe.opening + safe.form + safe.expression + safe.blink + safe.nod, 0)
})

test('表情强度有界且严肃语境优先，未播出回复与原始输入不自动带笑', () => {
  assert.ok(avatarReplyEmotion('欢迎大家') > 0)
  assert.ok(avatarReplyEmotion('谢谢你的信任，但这种做法有危险') < 0)
  assert.equal(avatarReplyEmotion('一般说明'), 0)
  const motion = createAvatarMotion(() => 0.5)
  let pose
  for (let time = 0; time < 1000; time += 16) pose = motion(time, { speaking: true, level: 1, emotion: 999, form: 999 })
  assert.ok(pose.expression <= 0.35 && pose.form <= 1)
  for (let time = 1000; time < 3000; time += 16) pose = motion(time, { listening: true, emotion: 999 })
  assert.ok(Math.abs(pose.expression) < 0.001)
  assert.equal(pose.opening, 0)
})

const hookWindow: any = { __ModuleLoader__: { load({ factory }: any) {
  hookWindow.client = factory(() => ({ Component: class {} }))
} } }
const hookMath = runInNewContext(client.replace('\n\t\tapply, inject:', '\n\t\twaitForRoleOutput,\n\t\tapply, inject:') + '\n;window.client', {
  window: hookWindow, performance, setTimeout, clearTimeout,
})

test('语音源结束后等待输出设备尾音，不提前清空口型；取消立即释放等待', async () => {
  const { setTimeout: delay } = await import('node:timers/promises')
  let outputTime = 0.9
  const controller = new AbortController()
  const playing = { controller, timeline: [{ end: 1 }], context: {
    state: 'running', currentTime: 1.2,
    getOutputTimestamp: () => ({ contextTime: outputTime, performanceTime: performance.now() - 1 }),
  } }
  let done = false
  const waiting = hookMath.waitForRoleOutput(playing).then(() => { done = true })
  await delay(30)
  assert.equal(done, false)
  outputTime = 1
  await waiting
  assert.equal(done, true)
  outputTime = 0.9
  const cancelled = hookMath.waitForRoleOutput(playing)
  controller.abort()
  await cancelled
})


test('倾听到开口保持头部连续，快速音节不会让头部逐帧跟着抽动', () => {
  const motion = createAvatarMotion(() => 0.5)
  let before
  for (let time = 0; time <= 512; time += 16) before = motion(time, { listening: true })
  const after = motion(528, { speaking: true, level: 0.8 })
  assert.ok(Math.abs(after.nod - before.nod) < 0.04)
  let previous = after, maximumStep = 0
  for (let time = 544; time < 3000; time += 16) {
    const pose = motion(time, { speaking: true, level: time % 64 < 32 ? 0.9 : 0 })
    maximumStep = Math.max(maximumStep, Math.abs(pose.nod - previous.nod))
    previous = pose
  }
  assert.ok(maximumStep < 0.04)
})

test('延迟装载不立即眨眼，长时间倾听仍有克制的非周期回应', () => {
  const motion = createAvatarMotion(() => 0.5)
  assert.equal(motion(30000, { listening: true }).blink, 0)
  assert.equal(motion(30065, { listening: true }).blink, 0)
  let laterNod = 0
  for (let time = 30080; time < 40000; time += 16) {
    const pose = motion(time, { listening: true })
    if (time > 36000) laterNod = Math.max(laterNod, pose.nod)
  }
  assert.ok(laterNod > 0.15)
})

test('对齐口型驱动：闭唇压制开口，圆唇/横展决定 mouthForm 符号，无 viseme 时行为不变', () => {
	const motion = createAvatarMotion(() => 0.5)
	// 闭唇（b/p/m）：即使音量很高，开口也必须归零
	let pose
	for (let time = 0; time < 400; time += 16) pose = motion(time, { speaking: true, level: 1, viseme: { open: 0.9, closed: 1 } })
	assert.equal(pose.opening, 0)
	// 圆唇（o/u）→ mouthForm 为负；横展（e/i）→ 为正
	const round = createAvatarMotion(() => 0.5)
	for (let time = 0; time < 400; time += 16) pose = round(time, { speaking: true, level: 0.8, viseme: { open: 0.8, round: 1 } })
	assert.ok(pose.form < -0.5, String(pose.form))
	assert.ok(pose.opening > 0.5)
	const wide = createAvatarMotion(() => 0.5)
	for (let time = 0; time < 400; time += 16) pose = wide(time, { speaking: true, level: 0.8, viseme: { open: 0.8, wide: 1 } })
	assert.ok(pose.form > 0.5, String(pose.form))
	// 安全态优先于任何 viseme：画面必须收口
	const safe = createAvatarMotion(() => 0.5)
	for (let time = 0; time < 200; time += 16) pose = safe(time, { speaking: true, safe: true, level: 1, viseme: { open: 1, wide: 1 } })
	assert.equal(pose.opening + pose.form, 0)
	// 无 viseme 时仍是音量驱动的旧路径（不得被新代码悄悄改变）
	const legacy = createAvatarMotion(() => 0.5)
	for (let time = 0; time < 300; time += 16) pose = legacy(time, { speaking: true, level: 0.8, form: -0.6 })
	assert.ok(pose.opening > 0.5)
	assert.ok(pose.form < 0)
})


test('音频估计口型：只给形状维度，开合仍走原平滑，无形状时与旧版逐位一致', () => {
	// 取同一串输入，比较「显式 viseme」与「仅音量」两条路径
	const drive = (motion: (now: number, input: Record<string, unknown>) => any, input: Record<string, unknown>) => {
		const poses = []
		for (let time = 0; time < 640; time += 16) poses.push(motion(time, { speaking: true, ...input }))
		return poses
	}
	// visemeFromSample 的等价输入：form < 0 → 圆唇；form > 0 → 横展
	const roundOnly = drive(createAvatarMotion(() => 0.5), { level: 0.7, form: 0, viseme: { round: 0.9 } })
	const wideOnly = drive(createAvatarMotion(() => 0.5), { level: 0.7, form: 0, viseme: { wide: 0.9 } })
	const roundForm = roundOnly.at(-1).form
	const wideForm = wideOnly.at(-1).form
	assert.ok(roundForm < -0.5 && wideForm > 0.5, roundForm + ' / ' + wideForm)
	// 两条路径的开合都来自同一个音量平滑器：形状不影响开口幅度
	assert.ok(Math.abs(roundOnly.at(-1).opening - wideOnly.at(-1).opening) < 1e-9)
	// 全零 viseme（没有可用口型）必须完全回退到旧路径
	const zeroViseme = drive(createAvatarMotion(() => 0.5), { level: 0.7, form: -0.4, viseme: { open: 0, closed: 0, round: 0, wide: 0 } })
	const legacy = drive(createAvatarMotion(() => 0.5), { level: 0.7, form: -0.4 })
	assert.deepEqual(zeroViseme.at(-1), legacy.at(-1))
})


test('对话动作状态机：弹幕视线交替且限频合并，思考/说话/收尾阶段推进，安全与打断回中性', () => {
	const { createDialogueMotion, blendDialogueTargets } = runInNewContext(
		client + '\n;({ createDialogueMotion, blendDialogueTargets })',
		{ window: { __ModuleLoader__: { load() {} } } },
	)
	const motion = createDialogueMotion(() => 0.5)
	// 弹幕：视线移向互动区，且连续两次方向交替
	const first = motion.apply('danmaku', 1000)
	assert.ok(first.gazeX !== 0)
	// 限频窗口内的刷屏被合并（引用同一对象 = 姿态未变）
	assert.equal(motion.apply('danmaku', 1600), first)
	assert.equal(motion.apply('danmaku', 2000), first)
	const second = motion.apply('danmaku', 3000)
	assert.ok(Math.sign(second.gazeX) !== Math.sign(first.gazeX))
	// 阶段推进：思考侧头 → 说话收敛 → 收尾点头
	const thinking = motion.apply('think', 4000)
	assert.ok(thinking.tilt > 0 && thinking.gazeY < 0)
	const speaking = motion.apply('speak', 5000)
	assert.ok(Math.abs(speaking.tilt) < thinking.tilt && speaking.nod === 0)
	const closing = motion.apply('tail', 6000)
	assert.ok(closing.nod > 0)
	// 打断：回到中性并递增版本（vm realm 对象不做原型严格比较，逐字段断言）
	const before = motion.version
	const neutral = motion.interrupt(7000)
	assert.deepEqual({ ...neutral }, { gazeX: 0, gazeY: 0, sway: 0, nod: 0, brow: 0, tilt: 0, blendMs: 320 })
	assert.ok(motion.version > before)
	// 安全态拒收一切事件；resume 恢复倾听
	motion.apply('safe', 8000)
	assert.equal(motion.apply('danmaku', 9000).gazeX, 0)
	assert.equal(motion.apply('think', 9100).tilt, 0)
	motion.apply('resume', 9200)
	assert.ok(motion.apply('danmaku', 9500).gazeX !== 0)
})

test('对话动作合成：安全/减少动态归零，说话期间降权，参数有界', () => {
	const { createDialogueMotion, blendDialogueTargets } = runInNewContext(
		client + '\n;({ createDialogueMotion, blendDialogueTargets })',
		{ window: { __ModuleLoader__: { load() {} } } },
	)
	const motion = createDialogueMotion(() => 0.5)
	const targets = motion.apply('danmaku', 1000)
	const normal = blendDialogueTargets(targets)
	assert.ok(normal.gaze !== 0 && normal.swing !== 0)
	const zeros = (input: Record<string, unknown>) => ({ ...blendDialogueTargets(targets, input as any) })
	assert.deepEqual(zeros({ safe: true }), { swing: 0, nod: 0, gaze: 0, brow: 0 })
	assert.deepEqual(zeros({ reducedMotion: true }), { swing: 0, nod: 0, gaze: 0, brow: 0 })
	assert.deepEqual({ ...blendDialogueTargets(null) }, { swing: 0, nod: 0, gaze: 0, brow: 0 })
	const speaking = blendDialogueTargets(targets, { speaking: true })
	assert.ok(Math.abs(speaking.gaze) < Math.abs(normal.gaze))
})

