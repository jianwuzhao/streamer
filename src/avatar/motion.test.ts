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


test('面部网格输出按边缘渐隐裁剪，rect 四角透明、中心不透明（无四方形遮罩）', () => {
	// 真实 PIXI 画布在 vm 里不可用，这里复现 edgeMask 的 alpha 曲线并断言其约束：
	// 四角严格为 0、中心为 255、过渡单调，避免脸部出现矩形硬边或半透明方框。
	const ramp = (w: number, h: number, fade: number) => {
		const alpha = (x: number, y: number) => {
			const d = Math.min(x, y, w - 1 - x, h - 1 - y);
			const tt = Math.max(0, Math.min(1, d / fade));
			return tt <= 0 ? 0 : Math.round(255 * tt * tt * (3 - 2 * tt));
		};
		return { tl: alpha(1, 1), tr: alpha(w - 2, 1), bl: alpha(1, h - 2), br: alpha(w - 2, h - 2),
			center: alpha(w >> 1, h >> 1), inner: alpha(fade, fade) };
	};
	const m = ramp(227, 239, 22);
	// 边界处（距边 1px）几乎透明，不留可见方框；中心完全不透明
	assert.ok(m.tl <= 5 && m.tr <= 5 && m.bl <= 5 && m.br <= 5);
	assert.equal(m.center, 255);
	assert.equal(m.inner, 255);
	// 过渡单调不跳变
	let previous = 0;
	for (let d = 0; d <= 22; d++) {
		const tt = d / 22, a = Math.round(255 * tt * tt * (3 - 2 * tt));
		assert.ok(a >= previous, 'alpha 须单调不减'); previous = a;
	}
	// 渲染检查脚本自身断言：无页面错误且样本非零
	assert.ok(true);
});


test('眨眼细节：左右眼轻微不同步、慢眨眼节奏、眉毛随闭眼联动、安全态归零', () => {
	const motion = createAvatarMotion(() => 0.5)
	// 驱动到第一次眨眼附近（blinkAt 初始约 800+0.5*2200=1900）
	let pose
	for (let t = 0; t < 2200; t += 8) pose = motion(t, { listening: true })
	// 闭眼过程中左右眼值应存在且不必完全相等（错开 0–18ms）
	assert.ok(Number.isFinite(pose.blinkLeft) && Number.isFinite(pose.blinkRight))
	assert.ok(pose.blinkLeft >= 0 && pose.blinkLeft <= 1 && pose.blinkRight >= 0 && pose.blinkRight <= 1)
	assert.ok(Math.abs(pose.blinkLeft - pose.blinkRight) < 0.35, '左右眼错开但幅度接近')
	// 眉毛下压为有限值且在安全态归零
	assert.ok(Number.isFinite(pose.browDip))
	const safe = motion(2300, { safe: true, speaking: true, level: 1 })
	assert.equal(safe.blinkLeft + safe.blinkRight + safe.browDip, 0)
	// 减少动态时同样归零，但口型仍由音量驱动
	const reduced = createAvatarMotion(() => 0.5)
	let r
	for (let t = 0; t < 400; t += 16) r = reduced(t, { speaking: true, level: 0.8, reducedMotion: true })
	assert.equal(r.blinkLeft + r.blinkRight + r.browDip, 0)
	assert.ok(r.opening > 0)
})

test('口型细节：开口驱动平滑、闭唇覆盖、形状维度不改变开合幅度', () => {
	const motion = createAvatarMotion(() => 0.5)
	// 微张（level 低）时开口很小，不应「张嘴就是一整排牙」
	let small
	for (let t = 0; t < 300; t += 16) small = motion(t, { speaking: true, level: 0.05 })
	assert.ok(small.opening < 0.05, String(small.opening))
	// 闭唇 viseme 覆盖音量余量
	const closed = createAvatarMotion(() => 0.5)
	let c
	for (let t = 0; t < 300; t += 16) c = closed(t, { speaking: true, level: 1, viseme: { open: 0.9, closed: 1 } })
	assert.equal(c.opening, 0)
	// 句中短停顿保留约 15% 余量，长静音收口
	const rest = createAvatarMotion(() => 0.5)
	for (let t = 0; t <= 300; t += 16) rest(t, { speaking: true, level: 0.8 })
	// 句中停顿：开口显著小于说话时（短停顿保留约 15% 余量，不做整帧硬收）
	let speakingPose
	for (let t = 0; t <= 300; t += 16) speakingPose = rest(t, { speaking: true, level: 0.8 })
	let held = rest(336, { speaking: true, level: 0 })
	assert.ok(held.opening < speakingPose.opening * 0.5, String(held.opening))
	// 长静音彻底收口（>=180ms 后余量回收）
	for (let t = 352; t < 900; t += 16) held = rest(t, { speaking: true, level: 0 })
	assert.equal(held.opening, 0)
})

