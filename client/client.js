// dsh-skip-quality: 操作员面板 UI 文案含「我确认…授权 / 我已在官方客户端登录」类勾选与按钮语，属界面确认文案（法规要求的操作员动作），非沟通记录
// dsh-skip-func-length: 宿主单入口无构建客户端半部：整个面板按 window.__ModuleLoader__.load 契约包在一个 module factory 内（仓库自 v0.13.0 起在 README/CHANGELOG 声明此架构例外）；拆分需引入构建步，与分发契约冲突
/* dsh-dafeiyu-evolve · Web 客户端半（直播控制台）
 * 装载：宿主 client-modules 经 dsh.client 声明加载本文件（单文件装载契约）。
 * 交互：同源共享 API /api/dafeiyu/*（宿主 connection/request 承接）。
 *
 * 布局：工作台、采集画面、记录与学习、设置共用导航和直播安全操作。
 * 主题：dfy-* 类全部引用宿主 --dsw-* 设计变量并带降级值，亮/暗随 body[data-ds-dark-theme] 切换。 */
// RuiC-2D/LiveTalking 口型参数 → 渲染姿态：闭唇优先，圆唇/横展决定 mouthForm 符号。
// 参数来自 src/avatar/lip-timeline.ts（纯数据，渲染端只做符号与缩放映射）。
function applyVisemePose(viseme, opening, form) {
	if (!viseme) return { opening, form };
	const unit = (v) => Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));
	const open = unit(viseme.open), closed = unit(viseme.closed);
	const round = unit(viseme.round), wide = unit(viseme.wide);
	// 全零表示没有可用口型：完全交还给旧的音量路径
	if (open === 0 && closed === 0 && round === 0 && wide === 0) return { opening, form };
	// 闭唇（b/p/m）压制开口：音量余量不能把嘴顶开
	const gated = opening * (1 - closed);
	return {
		opening: open > 0 ? Math.min(1, Math.max(gated, open * (1 - closed))) : gated,
		// 圆唇（o/u）为负、横展（e/i）为正，与 Live2D ParamMouthForm 方向一致
		form: Math.max(-1, Math.min(1, wide - round)),
	};
}

// 对话动作状态机（与 src/avatar/dialogue-motion.ts 语义对齐；client 是无构建单文件，不能
// import TS 模块，故内联一份等价实现，测试同样经 vm 执行本文件覆盖）。
// 弹幕/输入/思考/首音/尾音事件 → 姿态目标；连发弹幕合并 + 重触发限频；
// 说话期间动作降权不抢口型；打断/安全回中性并递增版本（渲染端据此丢弃旧插值）。
function createDialogueMotion(random = Math.random) {
	const NEUTRAL = { gazeX: 0, gazeY: 0, sway: 0, nod: 0, brow: 0, tilt: 0, blendMs: 320 };
	const RETRIGGER_MS = 1800, THINK_MS = 900, NOD_MS = 260;
	let phase = "listening", current = NEUTRAL, version = 0, reset = 0;
	let lastInteract = -Infinity, lastNod = -Infinity, lastEvent = -Infinity, side = 1;
	const commit = (targets) => { current = targets; version += 1; return targets; };
	const apply = (event, at) => {
		if (!Number.isFinite(at)) return current;
		const now = at < lastEvent ? lastEvent : at;
		lastEvent = now;
		if (event === "danmaku") {
			// 合并窗口与重触发限频合并为同一间隔判定（700ms 合并窗 < 1800ms 限频）
			if (phase === "safe" || now - lastInteract < RETRIGGER_MS) return current;
			lastInteract = now; side = -side;
			const scale = phase === "speaking" ? 0.35 : 1;
			return commit({ gazeX: side * 0.34 * scale, gazeY: -0.12 * scale, sway: side * 0.08 * scale,
				nod: Math.min(current.nod, 0.42 * scale), brow: -0.16 * scale, tilt: side * 0.09 * scale, blendMs: 420 });
		}
		if (event === "input-start" || event === "input-pause") {
			if (phase === "safe" || phase === "speaking" || now - lastNod < RETRIGGER_MS) return current;
			lastNod = now;
			return commit({ gazeX: current.gazeX * 0.5, gazeY: 0, sway: 0, nod: 0.72, brow: -0.1, tilt: 0, blendMs: NOD_MS });
		}
		if (event === "think") {
			if (phase === "safe" || phase === "thinking") return current;
			phase = "thinking";
			return commit({ gazeX: 0.18, gazeY: -0.2, sway: 0.05, nod: 0, brow: -0.18, tilt: 0.12, blendMs: THINK_MS });
		}
		if (event === "speak") {
			if (phase === "safe" || phase === "speaking") return current;
			phase = "speaking";
			return commit({ gazeX: current.gazeX * 0.4, gazeY: 0, sway: current.sway * 0.4, nod: 0, brow: 0.04,
				tilt: current.tilt * 0.4, blendMs: 280 });
		}
		if (event === "tail") {
			if (phase === "safe") return current;
			phase = "closing";
			return commit({ gazeX: current.gazeX * 0.3, gazeY: 0.05, sway: 0, nod: 0.16, brow: 0.1, tilt: 0, blendMs: 520 });
		}
		if (event === "interrupt" || event === "safe") {
			phase = event === "safe" ? "safe" : "listening";
			reset += 1;
			return commit(NEUTRAL);
		}
		if (event === "resume") {
			if (phase !== "safe") return current;
			phase = "listening"; lastInteract = lastNod = -Infinity;
			return commit({ ...NEUTRAL, blendMs: 260 });
		}
		return current;
	};
	return { apply, interrupt: (at) => apply("interrupt", at ?? lastEvent),
		get phase() { return phase; }, get targets() { return current; }, get version() { return version; }, get reset() { return reset; } };
}

// 对话动作目标 → 渲染端叠加量：安全/减少动态归零，说话期间降权，任何输入有界。
function blendDialogueTargets(targets, input = {}) {
	if (input.safe || input.reducedMotion || !targets) return { swing: 0, nod: 0, gaze: 0, brow: 0 };
	const clamp11 = (n) => Number.isFinite(n) ? Math.max(-1, Math.min(1, n)) : 0;
	const clamp01 = (n) => Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
	const weight = input.speaking ? 0.45 : 1;
	return {
		swing: clamp11(targets.sway + targets.tilt * 0.5) * weight,
		nod: clamp01(targets.nod) * weight,
		gaze: clamp11(targets.gazeX) * weight,
		brow: clamp11(targets.brow) * weight,
	};
}

function createDialogueBlend() {
	const neutral = blendDialogueTargets();
	let current = neutral, from = neutral, target, started = 0, reset;
	return (now, motion, input) => {
		if (!motion || input.safe || input.reducedMotion) {
			current = neutral;
			target = null;
			return current;
		}
		if (reset !== motion.reset) { current = neutral; target = null; reset = motion.reset; }
		if (target !== motion.targets) {
			target = motion.targets;
			from = current;
			started = now;
		}
		const goal = blendDialogueTargets(target, input);
		const t = Math.max(0, Math.min(1, (now - started) / target.blendMs));
		const ease = t * t * (3 - 2 * t);
		const tail = motion.phase === "closing" ? Math.sin(Math.PI * t) ** 2 : ease;
		current = Object.fromEntries(Object.keys(neutral).map((key) =>
			[key, from[key] * (1 - ease) + goal[key] * tail]));
		return current;
	};
}

function createBodyMotion() {
	const rest = { lean: 0, lift: 0, left: 0, right: 0 };
	let body = rest, previous, mode = "idle", started = 0, cueAt = -Infinity, side = 1;
	const pulse = (age, duration) => age > 0 && age < duration ? Math.sin(Math.PI * age / duration) ** 2 : 0;
	return (now, pose, dialogue, reduced) => {
		const dt = Math.min(90, Math.max(0, now - (previous ?? now - 16)));
		previous = now;
		if (reduced || pose.mode === "safe") {
			body = rest;
			mode = pose.mode;
			started = -Infinity;
			cueAt = -Infinity;
			return body;
		}
		if (mode !== pose.mode) {
			mode = pose.mode;
			started = now;
			if (mode === "speaking" && now - cueAt > 1600) {
				cueAt = now;
				side *= -1;
			}
		}
		const listening = mode === "listening";
		const speaking = mode === "speaking";
		const cue = speaking ? pulse(now - cueAt, 1250) : 0;
		const attention = listening ? pulse(now - started, 1350) : 0;
		const emphasis = pose.nod + dialogue.nod * .5;
		const lift = pose.breath * .18 + emphasis * .63 + attention * .35 + cue * .31;
		const lean = (listening ? .34 : speaking ? .17 : 0) + dialogue.swing * .75 + side * cue * .38 + pose.sway * .15;
		const gesture = cue * .9 + (speaking ? pose.nod * .75 : attention * .19);
		const mix = 1 - Math.exp(-dt / 110);
		body = {
			lean: body.lean + (lean - body.lean) * mix,
			lift: body.lift + (lift - body.lift) * mix,
			left: body.left + (gesture * (side < 0 ? 1 : .32) - body.left) * mix,
			right: body.right + (gesture * (side > 0 ? 1 : .32) - body.right) * mix,
		};
		return body;
	};
}

// Pure motion math is shared by both renderers and exercised with the real client in tests.
function createAvatarMotion(random = Math.random) {
	const clamp = (n, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : 0));
	const ease = (n) => { n = clamp(n); return n * n * (3 - 2 * n); };
	let previous, opening = 0, form = 0, expression = 0, lastVoice = -Infinity, held = 0;
	let blinkAt = 800 + random() * 2200, blinkStart = -Infinity;
	let poseAt = 0, poseEnd = 0, poseFrom = 0, poseTo = 0, pose = 0;
	let modeBefore = 'idle', listenAt = -Infinity, nextListen = Infinity;
	let nod = 0, emphasisAt = -Infinity, envelope = 0, previousLevel = 0;
	let gaze = 0, blinkClose = 65, blinkHold = 18, blinkOpen = 115, initialized = false;
	// 眨眼细节：左右眼轻微不同步（人眼并非完全同步），并让眉毛随闭眼轻微下压；
	// 偶尔一次较长的「慢眨眼」让节奏不机械。
	let blinkLeftLag = 0, blinkRightLag = 0, blinkSlow = false, browDip = 0;
	return (now, input = {}) => {
		if (!initialized) { blinkAt += now; initialized = true; }
		const dt = clamp(previous === undefined ? 16 : now - previous, 0, 100);
		previous = now;
		const mode = input.safe ? 'safe' : input.speaking ? 'speaking' : input.listening ? 'listening' : 'idle';
		if (mode === 'listening' && modeBefore !== mode) { listenAt = now; nextListen = now + 5200 + random() * 3500; }
		if (mode === 'listening' && now >= nextListen) { listenAt = now; nextListen = now + 5200 + random() * 3500; }
		modeBefore = mode;
		const level = mode === 'speaking' ? clamp(input.level) : 0;
		const voiced = level > 0.035;
		if (voiced) { lastVoice = now; held = level; }
		// A short intra-utterance pause keeps 15% of the last opening, never an idle open mouth.
		const rest = mode === 'speaking' && now - lastVoice < 180 ? Math.min(0.09, held * 0.15) : 0;
		const desired = voiced ? clamp((level - 0.025) * 1.15) : rest;
		opening += (desired - opening) * (1 - Math.exp(-dt / (desired > opening ? 12 : 28)));
		form += ((voiced ? clamp(input.form, -1, 1) : 0) - form) * (1 - Math.exp(-dt / 42));
		// Facial affect follows the phrase envelope, not each rapid jaw movement.
		envelope += (level - envelope) * (1 - Math.exp(-dt / 240));
		if (voiced && level - previousLevel > 0.22 && now - emphasisAt > 1100) emphasisAt = now;
		previousLevel = level;
		const mood = mode === 'speaking' ? clamp(input.emotion, -0.35, 0.35) : 0;
		expression += (mood * (0.6 + envelope * 0.4) - expression) * (1 - Math.exp(-dt / 180));
		if (now >= blinkAt) {
			blinkStart = now;
			blinkSlow = random() < 0.18;
			blinkClose = (blinkSlow ? 95 : 55) + random() * 20;
			blinkHold = (blinkSlow ? 34 : 10) + random() * 15;
			blinkOpen = (blinkSlow ? 190 : 100) + random() * 35;
			// 左右眼错开 0–18ms，避免像开关一样完全同步
			blinkLeftLag = random() * 18;
			blinkRightLag = random() * 18;
			blinkAt = now + (blinkSlow ? 3400 : 2700) + random() * 3700;
		}
		const blinkValue = (lag) => {
			const age = now - blinkStart - lag;
			if (!Number.isFinite(age) || age < 0) return 0;
			if (age < blinkClose) return ease(age / blinkClose);
			const opening = (age - blinkClose - blinkHold) / blinkOpen;
			return clamp(1 - ease(opening));
		};
		const blink = blinkValue(0);
		const blinkLeft = blinkValue(blinkLeftLag);
		const blinkRight = blinkValue(blinkRightLag);
		// 闭眼时眉毛轻微下压，睁眼回位（比纯眼皮闭合自然）
		browDip += (blink * -0.12 - browDip) * (1 - Math.exp(-dt / 90));
		if (now >= poseEnd) {
			poseFrom = pose; poseTo = random() * 2 - 1;
			poseAt = now; poseEnd = now + 1600 + random() * 2600;
		}
		pose = poseFrom + (poseTo - poseFrom) * ease((now - poseAt) / (poseEnd - poseAt));
		const seconds = now / 1000;
		const breath = 0.5 + 0.32 * Math.sin(seconds * 1.31) + 0.18 * Math.sin(seconds * 0.73 + 0.8);
		const listenAge = now - listenAt;
		const listenNod = mode === 'listening' && listenAge < 1100 ? Math.sin(ease(listenAge / 1100) * Math.PI) * 0.22 : 0;
		const emphasisAge = now - emphasisAt;
		const speechNod = mode === 'speaking' && emphasisAge < 650 ? Math.sin(ease(emphasisAge / 650) * Math.PI) * 0.12 : 0;
		// Carry pose across turn boundaries, avoiding a snap back to the neutral head.
		nod += (listenNod + speechNod - nod) * (1 - Math.exp(-dt / 95));
		gaze += (pose * (mode === 'listening' ? 0.1 : 0.2) - gaze) * (1 - Math.exp(-dt / 180));
		if (input.safe) { opening = 0; form = 0; expression = 0; lastVoice = -Infinity; held = 0; nod = 0; gaze = 0; envelope = 0; previousLevel = 0; emphasisAt = -Infinity; browDip = 0; }
		const reduced = input.reducedMotion || input.safe;
		// 有对齐口型时以 viseme 为准（闭唇/圆唇/横展），否则沿用音频估计的 level/form
		const viseme = input.safe ? null : input.viseme;
		const shaped = applyVisemePose(viseme, opening, form);
		const finalOpening = shaped.opening < 0.003 ? 0 : shaped.opening;
		return { mode, opening: finalOpening, form: shaped.form, expression,
			blink: reduced ? 0 : clamp(blink), blinkLeft: reduced ? 0 : clamp(blinkLeft), blinkRight: reduced ? 0 : clamp(blinkRight),
			browDip: reduced ? 0 : browDip, breath: reduced ? 0 : breath,
			gaze: reduced ? 0 : gaze, sway: reduced ? 0 : pose * 0.45, nod: reduced ? 0 : nod };
	};
}

function avatarReplyEmotion(text) {
	// Only call with the reply already admitted to playback. This is a restrained style hint,
	// not an emotion classifier or a content-moderation replacement.
	if (/抱歉|难过|危险|不能|不建议|去世|受伤|伤害|遗憾|担心|痛苦/.test(text || '')) return -0.22;
	if (/谢谢|感谢|欢迎|开心|恭喜|高兴|大家好/.test(text || '')) return 0.24;
	return 0;
}

function avatarPcmFeatures(data, sampleRate, time) {
	if (!data?.length || !Number.isFinite(sampleRate) || sampleRate <= 0 || !Number.isFinite(time) || time < 0 || time >= data.length / sampleRate) return { level: 0, form: 0 };
	const center = Math.floor(time * sampleRate);
	const radius = Math.ceil(sampleRate * 0.012);
	const start = Math.max(0, center - radius);
	const end = Math.min(data.length, center + radius + 1);
	const lowPass = 1 - Math.exp(-2 * Math.PI * 1100 / sampleRate);
	let energy = 0, lowEnergy = 0, total = 0, low = data[start];
	for (let i = start; i < end; i++) {
		const weight = 1 - Math.abs(i - center) / (radius + 1);
		const sample = data[i];
		low += lowPass * (sample - low);
		energy += weight * sample * sample;
		lowEnergy += weight * low * low;
		total += weight;
	}
	if (!energy) return { level: 0, form: 0 };
	const lowFraction = Math.min(1, lowEnergy / energy);
	const rms = Math.sqrt(energy / total);
	// A soft ceiling lets loud vowels keep their dynamics. Sibilants and breath
	// still move the mouth, with less jaw opening than low-band voiced sounds.
	const voiced = Math.min(1, Math.max(0, (lowFraction - 0.13) / 0.57));
	const level = (1 - Math.exp(-16 * Math.max(0, rms - 0.006))) * (0.33 + 0.67 * voiced);
	const form = level > 0.035 ? Math.max(-0.5, Math.min(0.6, (0.8 - lowFraction) * 2)) : 0;
	return { level, form };
}

function avatarPlaybackTime(context, now) {
	if (!context || context.state !== 'running') return null;
	const stamp = context.getOutputTimestamp?.();
	if (stamp && stamp.contextTime > 0 && stamp.performanceTime > 0 &&
		now >= stamp.performanceTime && now - stamp.performanceTime < 250) {
		return Math.min(context.currentTime, stamp.contextTime + (now - stamp.performanceTime) / 1000);
	}
	return Math.max(0, context.currentTime - Math.max(0, context.outputLatency || context.baseLatency || 0));
}

// Identity-preserving 2.5D facial mesh. All visible skin UVs come from the original portrait.
function createFaceRigModel(source, triangulate) {
	const { width, height, landmarks } = source;
	const required = ['contour', 'leftEye', 'rightEye', 'leftBrow', 'rightBrow', 'outerLips', 'innerLips', 'nose'];
	for (const name of required) if (!landmarks[name]?.length) throw new Error('Missing facial region: ' + name);
	const pixel = (points) => points.map(([x, y]) => [x * width, y * height]);
	const marks = Object.fromEntries(Object.entries(landmarks).map(([k, v]) => [k, pixel(v)]));
	// Vision's eye polygon is tight; include the eyelash border so original eye pixels cannot leak through closed lids.
	for (const name of ['leftEye','rightEye']) {
		const poly=marks[name],cx=poly.reduce((s,p)=>s+p[0],0)/poly.length,cy=poly.reduce((s,p)=>s+p[1],0)/poly.length;
		const a=poly.reduce((a,b)=>a[0]<b[0]?a:b),b=poly.reduce((a,b)=>a[0]>b[0]?a:b),angle=Math.atan2(b[1]-a[1],b[0]-a[0]);
		const c=Math.cos(angle),s=Math.sin(angle);
		marks[name]=poly.map(p=>{const x=((p[0]-cx)*c+(p[1]-cy)*s)*1.12,y=(-(p[0]-cx)*s+(p[1]-cy)*c)*1.55;return[cx+x*c-y*s,cy+x*s+y*c];});
	}
	const all = required.flatMap((name) => marks[name]);
	const xs = all.map(p => p[0]), ys = all.map(p => p[1]);
	const span = Math.max(...xs) - Math.min(...xs);
	const rect = [Math.max(0, Math.floor(Math.min(...xs) - span * .14)), Math.max(0, Math.floor(Math.min(...ys) - span * .3)),
		Math.min(width, Math.ceil(Math.max(...xs) + span * .14)), Math.min(height, Math.ceil(Math.max(...ys) + span * .12))];
	const points = [[rect[0], rect[1]], [rect[2], rect[1]], [rect[2], rect[3]], [rect[0], rect[3]]];
	const holes = [], regions = {};
	for (const name of ['leftEye', 'rightEye', 'innerLips']) {
		holes.push(points.length);
		regions[name] = marks[name].map(p => { points.push(p); return points.length - 1; });
	}
	let indices = triangulate(points.flat(), holes, 2);
	const cross = (a, b, c) => (b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
	const inside = (p, polygon) => {
		let yes = false;
		for (let i=0,j=polygon.length-1;i<polygon.length;j=i++) {
			const a=polygon[i], b=polygon[j];
			if ((a[1]>p[1]) !== (b[1]>p[1]) && p[0] < (b[0]-a[0])*(p[1]-a[1])/(b[1]-a[1])+a[0]) yes=!yes;
		}
		return yes;
	};
	const insert = (p) => {
		const existing = points.findIndex(q => Math.hypot(p[0]-q[0],p[1]-q[1]) < .4);
		if (existing >= 0) return existing;
		for (let i=0;i<indices.length;i+=3) {
			const [a,b,c]=indices.slice(i,i+3), area=cross(points[a],points[b],points[c]);
			const weights=[cross(points[b],points[c],p)/area,cross(points[c],points[a],p)/area,cross(points[a],points[b],p)/area];
			if (weights.every(w=>w>1e-5)) {
				const n=points.length; points.push(p); indices.splice(i,3,a,b,n,b,c,n,c,a,n); return n;
			}
		}
		return -1;
	};
	for (const name of ['outerLips','leftBrow','rightBrow','nose','noseCrest','contour','median']) regions[name]=(marks[name]||[]).map(insert).filter(i=>i>=0);
	// Subdivide across the whole face so cheeks and chin share deformation with the lips.
	for (let y=rect[1]+span/16;y<rect[3];y+=span/16) for(let x=rect[0]+span/16;x<rect[2];x+=span/16) {
		if (!['leftEye','rightEye','innerLips'].some(k=>inside([x,y],marks[k]))) insert([x,y]);
	}
	// Improve the inserted triangulation while retaining every facial boundary edge.
	for(let pass=0;pass<30;pass++) {
		const edges=new Map(),used=new Set();let flips=0;
		for(let i=0;i<indices.length;i+=3)for(let k=0;k<3;k++) {
			const a=indices[i+k],b=indices[i+(k+1)%3],c=indices[i+(k+2)%3],key=Math.min(a,b)+':'+Math.max(a,b);
			if(!edges.has(key)) {edges.set(key,{i,a,b,c});continue;}
			const old=edges.get(key),d=old.c;
			if(used.has(i)||used.has(old.i)||c===d)continue;
			if(cross(points[a],points[b],points[c])*cross(points[a],points[b],points[d])>=0||
				cross(points[c],points[d],points[a])*cross(points[c],points[d],points[b])>=0)continue;
			const angle=(o,p,q)=>{
				const u=[p[0]-o[0],p[1]-o[1]],v=[q[0]-o[0],q[1]-o[1]];
				return Math.acos(Math.max(-1,Math.min(1,(u[0]*v[0]+u[1]*v[1])/(Math.hypot(...u)*Math.hypot(...v)))));
			};
			if(angle(points[c],points[a],points[b])+angle(points[d],points[a],points[b])<=Math.PI+.0001)continue;
			const tri=(a,b,c)=>cross(points[a],points[b],points[c])>0?[a,b,c]:[a,c,b];
			indices.splice(i,3,...tri(c,d,a));indices.splice(old.i,3,...tri(d,c,b));
			used.add(i);used.add(old.i);flips++;
		}
		if(!flips)break;
	}
	const basis = (polygon) => {
		const left=polygon.reduce((a,b)=>a[0]<b[0]?a:b), right=polygon.reduce((a,b)=>a[0]>b[0]?a:b);
		const dx=right[0]-left[0], dy=right[1]-left[1], w=Math.hypot(dx,dy);
		return { x:(left[0]+right[0])/2, y:(left[1]+right[1])/2, width:w, cos:dx/w, sin:dy/w };
	};
	const mouth=basis(marks.innerLips), eyes=[basis(marks.leftEye),basis(marks.rightEye)];
	const lipLocal=marks.innerLips.map(p=>[(p[0]-mouth.x)*mouth.cos+(p[1]-mouth.y)*mouth.sin,-(p[0]-mouth.x)*mouth.sin+(p[1]-mouth.y)*mouth.cos]);
	const li=lipLocal.reduce((a,p,i)=>p[0]<lipLocal[a][0]?i:a,0),ri=lipLocal.reduce((a,p,i)=>p[0]>lipLocal[a][0]?i:a,0);
	const arc=(start,end)=>{const a=[];for(let i=(start+1)%lipLocal.length;i!==end;i=(i+1)%lipLocal.length)a.push(i);return a;};
	const a=arc(li,ri),b=arc(ri,li),mean=a=>{
		const weights=a.map(i=>Math.max(.001,1-(lipLocal[i][0]/(mouth.width*.5))**2));
		return a.reduce((sum,i,k)=>sum+lipLocal[i][1]*weights[k],0)/weights.reduce((a,b)=>a+b,0);
	};
	const lowerLip=new Set((mean(a)>mean(b)?a:b).map(i=>regions.innerLips[i]));
	const lipCorners=new Set([regions.innerLips[li],regions.innerLips[ri]]);
	const controls=['jawOpen','mouthRound','smile','browLeft','browRight','blinkLeft','blinkRight'];
	const targets=Object.fromEntries(controls.map(k=>[k,new Array(points.length*2).fill(0)]));
	const local=(p,b)=>[(p[0]-b.x)*b.cos+(p[1]-b.y)*b.sin, -(p[0]-b.x)*b.sin+(p[1]-b.y)*b.cos];
	const add=(key,i,dx,dy,b)=>{targets[key][i*2]+=dx*b.cos-dy*b.sin;targets[key][i*2+1]+=dx*b.sin+dy*b.cos;};
	const fall=(v)=>Math.exp(-v*v);
	for(let i=0;i<points.length;i++) {
		const p=points[i], [x,y]=local(p,mouth), w=mouth.width;
		const edge=Math.min(1,(p[0]-rect[0])/(span*.12),(rect[2]-p[0])/(span*.12),(p[1]-rect[1])/(span*.12),(rect[3]-p[1])/(span*.12));
		const boundary=Math.max(0,edge);
		const mouthVertex=regions.innerLips.includes(i)||regions.outerLips.includes(i);
		const jaw=mouthVertex ? (lipCorners.has(i)?0:lowerLip.has(i) ? .28 : -.06)*fall(x/(w*.55)) :
			(y>0 ? .16*fall(x/(w*1.4))*fall(y/(w*1.8)) : -.025*fall(x/(w*.6))*fall(y/(w*.35)));
		add('jawOpen',i,0,jaw*w*boundary,mouth);
		const influence=fall(x/(w*.8))*fall(y/(w*.7))*boundary;
		add('mouthRound',i,-x*.18*influence,0,mouth);
		add('smile',i,x*.06*influence,-Math.min(.5,Math.abs(x)/w)*w*.12*influence,mouth);
		for(let e=0;e<2;e++) {
			const b=eyes[e], [ex,ey]=local(p,b), name=e?'rightEye':'leftEye';
			const poly=marks[name].map(q=>local(q,b));
			const upper=Math.min(...poly.map(q=>q[1])), lower=Math.max(...poly.map(q=>q[1]));
			const line=upper*.2+lower*.8;
			let shift=0;
			if(regions[name].includes(i)) shift=(line-ey)*.985;
			else if(Math.abs(ex)<b.width*.9) {
				const fadeX=Math.max(0,1-(Math.max(0,Math.abs(ex)/b.width-.5)/.4)**2);
				shift=ey<0?(line-upper)*fall((ey-upper)/(b.width*.42))*fadeX:(line-lower)*fall((ey-lower)/(b.width*.28))*fadeX;
			}
			add(e?'blinkRight':'blinkLeft',i,0,shift*boundary,b);
			const brow=marks[e?'rightBrow':'leftBrow'];
			const by=brow.reduce((sum,q)=>sum+local(q,b)[1],0)/brow.length;
			add(e?'browRight':'browLeft',i,0,-b.width*.05*fall(ex/(b.width*.7))*fall((ey-by)/(b.width*.3))*boundary,b);
		}
	}
	// Harmonic propagation moves a continuous face surface around the independently controlled boundaries.
	// Mean-value weights are positive and reproduce the neutral vertex coordinates.
	const adjacency=points.map(()=>new Map());
	for(let i=0;i<indices.length;i+=3) {
		const tri=indices.slice(i,i+3);
		for(let k=0;k<3;k++) {
			const center=tri[k], a=tri[(k+1)%3], b=tri[(k+2)%3];
			const u=[points[a][0]-points[center][0],points[a][1]-points[center][1]];
			const v=[points[b][0]-points[center][0],points[b][1]-points[center][1]];
			const lu=Math.hypot(...u),lv=Math.hypot(...v);
			const cosine=Math.max(-.999999,Math.min(.999999,(u[0]*v[0]+u[1]*v[1])/(lu*lv)));
			const tangent=Math.sqrt((1-cosine)/(1+cosine));
			for(const [n,len] of [[a,lu],[b,lv]]) adjacency[center].set(n,(adjacency[center].get(n)||0)+tangent/len);
		}
	}
	const neighbors=adjacency.map(row=>{const sum=[...row.values()].reduce((a,b)=>a+b,0);return [...row].map(([i,w])=>[i,w/sum]);});
	const pins=new Set([0,1,2,3,...regions.leftEye,...regions.rightEye,...regions.innerLips,...regions.leftBrow,...regions.rightBrow,...regions.nose]);
	for(const target of Object.values(targets)) {
		for(let iteration=0;iteration<600;iteration++) {
			let change=0;
			for(let i=0;i<points.length;i++) {
				if(pins.has(i))continue;
				let dx=0,dy=0;
				for(const [n,w] of neighbors[i]){dx+=target[n*2]*w;dy+=target[n*2+1]*w;}
				change=Math.max(change,Math.abs(dx-target[i*2]),Math.abs(dy-target[i*2+1]));
				target[i*2]=dx;target[i*2+1]=dy;
			}
			if(change<.0001)break;
		}
	}
	return { version:1, kind:'dafeiyu-face-2.5d', width,height,rect,points:points.flat(),indices,regions,targets,mouth,eyes,
		parts:['faceSkin','jaw','cheeks','leftBrow','rightBrow','upperLip','lowerLip','leftEyelid','rightEyelid','leftEyeball','rightEyeball','oralCavity','upperTeeth','lowerTeeth','tongue'],
		controls: [...controls,'gazeX','gazeY','tongueRaise'], sourceSha256:source.sourceSha256 };
}

function deformFaceRig(model, controls, vertices = new Float32Array(model.points.length)) {
	vertices.set(model.points);
	for(const [name,target] of Object.entries(model.targets)) {
		const min = name === 'mouthRound' ? -.35 : name === 'smile' || name.startsWith('brow') ? -1 : 0;
		const raw = controls[name], weight = Number.isFinite(raw) ? Math.max(min, Math.min(1, raw)) : 0;
		if(!weight)continue;
		for(let i=0;i<vertices.length;i++)vertices[i]+=target[i]*weight;
	}
	return vertices;
}

function lipAperture(model, vertices) {
	const { x, y, cos, sin } = model.mouth;
	const lip = model.regions.innerLips.map((i) => {
		const dx = vertices[i * 2] - x, dy = vertices[i * 2 + 1] - y;
		return [dx * cos + dy * sin, -dx * sin + dy * cos];
	});
	const left = Math.min(...lip.map(([u]) => u)), right = Math.max(...lip.map(([u]) => u));
	const center = (left + right) / 2;
	let top = Infinity, bottom = -Infinity;
	for (let i = 0; i < lip.length; i++) {
		const [u, v] = lip[i], [nextU, nextV] = lip[(i + 1) % lip.length];
		if ((u <= center) === (nextU <= center)) continue;
		const atCenter = v + (nextV - v) * (center - u) / (nextU - u);
		top = Math.min(top, atCenter);
		bottom = Math.max(bottom, atCenter);
	}
	return { left, right, center, top, bottom, height: Math.max(0, bottom - top) };
}

function faceMouthControls(opening, form) {
	return {
		jawOpen: .78 * opening ** 1.12,
		mouthRound: -form * (form > 0 ? .33 : .72),
		tongueRaise: opening * Math.max(0, form) * .3,
	};
}

function createFaceRigRenderer(PIXI, model, image) {
	const [left,top,right,bottom]=model.rect;
	const app=new PIXI.Application({width:right-left,height:bottom-top,resolution:1,backgroundAlpha:0,antialias:true,autoStart:false});
	const texture=PIXI.Texture.from(image);
	const root=new PIXI.Container();root.position.set(-left,-top);app.stage.addChild(root);
	const uvs=new Float32Array(model.points.map((v,i)=>v/(i%2?model.height:model.width)));
	const vertices=new Float32Array(model.points);
	const skin=new PIXI.SimpleMesh(texture,vertices,uvs,new Uint16Array(model.indices),PIXI.DRAW_MODES.TRIANGLES);
	const interiors={};
	for(const name of ['leftEye','rightEye','innerLips']) {
		const group=new PIXI.Container(), original=new PIXI.Sprite(texture), mask=new PIXI.Graphics();
		group.addChild(original);root.addChild(group,mask);group.mask=mask;
		interiors[name]={group,original,mask};
	}
	const oral=new PIXI.Graphics();interiors.innerLips.group.addChild(oral);
	root.addChild(skin);
	const lashes=new PIXI.Graphics();root.addChild(lashes);
	const clipped=document.createElement('canvas');clipped.width=right-left;clipped.height=bottom-top;
	const clipContext=clipped.getContext('2d');
	// PIXI 画布是 rect 大小的整块不透明矩形（网格外边界即 rect 四角）。
	// 说话/转头时网格形变而 UV 仍指向原图固定位置，rect 边界会露出一条四方形接缝。
	// 边缘渐隐掩码让边界处平滑淡出到下方原图，而不是硬切或半透明方框。
	const edgeMask=document.createElement('canvas');edgeMask.width=right-left;edgeMask.height=bottom-top;
	{
		const ec=edgeMask.getContext('2d'), w=edgeMask.width, h=edgeMask.height, fade=22;
		const data=ec.createImageData(w,h);
		for(let y=0;y<h;y++) for(let x=0;x<w;x++){
			const d=Math.min(x,y,w-1-x,h-1-y);
			const t=Math.max(0,Math.min(1,d/fade));
			const a=t<=0?0:Math.round(255*t*t*(3-2*t));
			const i=(y*w+x)*4;
			data.data[i]=255;data.data[i+1]=255;data.data[i+2]=255;data.data[i+3]=a;
		}
		ec.putImageData(data,0,0);
	}
	let destroyed=false;
	const polygon=(name)=>model.regions[name].flatMap(i=>[vertices[i*2],vertices[i*2+1]]);
	return {
		update(controls) {
			if(destroyed)return;
			deformFaceRig(model,controls,vertices);skin.vertices=vertices;
			lashes.clear();
			for(const name of ['leftEye','rightEye','innerLips']) {
				const {mask,original}=interiors[name];
				mask.clear().beginFill(0xffffff).drawPolygon(polygon(name)).endFill();
				if(name!=='innerLips') {
					const eye=model.eyes[name==='leftEye'?0:1];
					original.position.set((controls.gazeX||0)*eye.width*.045,(controls.gazeY||0)*eye.width*.03);
					const blink=Math.max(0,Math.min(1,controls[name==='leftEye'?'blinkLeft':'blinkRight']||0));
					if(blink>.7){const points=polygon(name);lashes.lineStyle(Math.max(.7,eye.width*.022),0x392b29,(blink-.7)/.3*.8).moveTo(points[0],points[1]);for(let i=2;i<points.length;i+=2)lashes.lineTo(points[i],points[i+1]);}

				}
			}
			const m = model.mouth;
			const open = controls.jawOpen || 0;
			const { left, right, center, top, bottom, height } = lipAperture(model, vertices);
			oral.clear();
			oral.position.set(m.x, m.y);
			oral.rotation = Math.atan2(m.sin, m.cos);
			if (open > .04 && height > .5) {
				const span = right - left;
				const round = Math.max(0, controls.mouthRound || 0);
				// The lip polygon masks every layer. Darken the full opening first so
				// the source's closed-lip texture doesn't show through as a second mouth.
				oral.alpha = Math.min(1, (open - .04) * 9);
				oral.beginFill(0x301a20).drawRect(left - 1, top - span, span + 2, height + 2 * span).endFill();
				oral.beginFill(0x201218, .7).drawEllipse(center, top + height * .49, span * .31, height * .38).endFill();

				const reveal = Math.max(0, Math.min(1, (open - .24) / .35));
				const half = span * (.32 - round * .11);
				const tooth = Math.min(height * .28, span * .064);
				if (reveal > 0) {
					oral.beginFill(0xcab7ad, reveal * .82)
						.moveTo(center - half, top - tooth * .75).quadraticCurveTo(center, top - tooth, center + half, top - tooth * .75)
						.quadraticCurveTo(center + half, top + tooth * .6, center, top + tooth)
						.quadraticCurveTo(center - half, top + tooth * .6, center - half, top - tooth * .75).closePath().endFill();
				}
				const tongue = Math.max(0, (open - .43) / .33);
				if (tongue > 0) {
					const lift = (controls.tongueRaise || 0) * height * .15;
					oral.beginFill(0x75424a, Math.min(.62, tongue * .62))
						.drawEllipse(center, bottom - height * .09 - lift, span * .23, height * .22).endFill();
				}
			}
			app.renderer.render(app.stage);
		},
		draw(context, silhouette) {
			clipContext.clearRect(0,0,clipped.width,clipped.height);
			clipContext.globalCompositeOperation='source-over';clipContext.drawImage(app.view,0,0);
			clipContext.globalCompositeOperation='destination-in';
			if(silhouette) clipContext.drawImage(silhouette,-left,-top);
			// 边缘渐隐：消除 rect 矩形四方形接缝（形变时尤其明显）
			clipContext.drawImage(edgeMask,0,0);
			clipContext.globalCompositeOperation='source-over';
			context.drawImage(clipped,left,top);
		},
		destroy() { if(destroyed)return;destroyed=true;app.destroy(true,{children:true,texture:true,baseTexture:true}); },
	};
}

window.__ModuleLoader__.load({ id: "dsh-dafeiyu-evolve", factory: (require) => {
	const react = require("react");
	const { useState, useEffect, useLayoutEffect, useCallback, useRef, createElement: h } = react;

	const PANEL_ID = "dafeiyu-live";
	const DSW_BLUE = "var(--dsw-static-deepseek-500, #4176e6)";
	const STYLE_ID = "dfy-panel-style";
	const jsonHeaders = { "content-type": "application/json" };

	// ------------------------------------------------------------------ 样式（一次注入，幂等）

	const CSS = `
.dfy-root{height:100%;min-height:0;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base,#f6faf9);color:var(--dsw-alias-label-primary,#17303c);font-family:var(--dsw-font-family,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif);font-size:13px;line-height:1.5}
.dfy-root *,.dfy-root *::before,.dfy-root *::after{box-sizing:border-box}
.dfy-head{display:flex;align-items:center;gap:12px;padding:12px 16px;border-bottom:.5px solid var(--dsw-alias-border-l1,#d8e2e0)}
.dfy-head-x{margin-left:auto;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dfy-tab{appearance:none;background:transparent;border:0;border-bottom:2px solid transparent;color:var(--dsw-alias-label-secondary,#45606b);font:inherit;font-size:12.5px;font-weight:500;padding:6px 10px 8px;border-radius:6px 6px 0 0;cursor:pointer;white-space:nowrap}
.dfy-tab:hover{color:var(--dsw-alias-label-primary,#17303c);background:var(--dsw-alias-interactive-bg-hover,rgba(15,94,87,.06))}
.dfy-tab-on{color:var(--dsw-alias-state-business-primary,#0f5e57);border-bottom-color:var(--dsw-alias-state-business-primary,#0f5e57);font-weight:700}
.dfy-body{flex:1;min-height:0;overflow-y:auto;padding:16px}
.dfy-grid{display:grid;gap:12px;grid-template-columns:repeat(2,minmax(0,1fr));align-items:start}
.dfy-kpis{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(118px,1fr))}
.dfy-kpi{display:flex;flex-direction:column;gap:2px;min-width:0;padding:8px 12px;border-radius:10px;background:var(--dsw-alias-bg-layer-1,#fff);border:.5px solid var(--dsw-alias-border-l1,#d8e2e0)}
.dfy-kpi-l{font-size:11px;color:var(--dsw-alias-label-tertiary,#5b6f6c);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dfy-kpi-v{font-size:15px;font-weight:700;line-height:1.35;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dfy-card{min-width:0;padding:12px 16px;border-radius:12px;background:var(--dsw-alias-bg-layer-1,#fff);border:.5px solid var(--dsw-alias-border-l1,#d8e2e0)}
.dfy-card-h{display:flex;align-items:center;gap:8px;margin:0 0 10px}
.dfy-card-h h3{margin:0;flex:1;min-width:0;font-size:13px;font-weight:700}
.dfy-card-b{display:grid;gap:12px}
.dfy-row{display:flex;justify-content:space-between;align-items:baseline;gap:12px;padding:4px 0;border-bottom:.5px dashed var(--dsw-alias-border-l1,#e3ebe9);font-size:12.5px}
.dfy-row:last-child{border-bottom:0;padding-bottom:0}
.dfy-row-l{flex:0 0 auto;color:var(--dsw-alias-label-tertiary,#5b6f6c)}
.dfy-row-v{min-width:0;font-weight:600;text-align:right;overflow-wrap:anywhere}
.dfy-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;font-weight:500}
.dfy-muted{color:var(--dsw-alias-label-tertiary,#5b6f6c)}
.dfy-caption{color:var(--dsw-alias-label-tertiary,#5b6f6c);font-size:11.5px}
.dfy-actions{display:flex;flex-wrap:wrap;gap:8px}
.dfy-stack{display:grid;gap:12px;min-width:0}
.dfy-stack>p,.dfy-stack>dl{margin:0}
.dfy-stack dl{display:grid;gap:8px}
.dfy-stack dl>div{display:grid;grid-template-columns:88px minmax(0,1fr);gap:12px}
.dfy-stack dd{margin:0}
.dfy-btn{appearance:none;display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:32px;padding:6px 12px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l2,#d8e2e0);background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#17303c);font:inherit;font-size:12.5px;font-weight:600;cursor:pointer;transition:background .15s,filter .15s,opacity .15s}
.dfy-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(15,94,87,.07))}
.dfy-btn:disabled{opacity:.45;cursor:not-allowed}
.dfy-btn-pri{background:var(--dsw-alias-state-business-primary,#0f5e57);border-color:transparent;color:var(--dsw-alias-label-primary-inverted,#fff)}
.dfy-btn-pri:hover:not(:disabled){background:var(--dsw-alias-state-business-primary,#0f5e57);filter:brightness(1.12)}
.dfy-btn-ghost{background:transparent;border-color:transparent;color:var(--dsw-alias-link,#0f5e57)}
.dfy-btn-danger{background:var(--dsw-alias-state-error-primary,#c0392b);border-color:transparent;color:#fff}
.dfy-btn-danger:hover:not(:disabled){background:var(--dsw-alias-state-error-primary,#c0392b);filter:brightness(1.08)}
.dfy-badge{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:700;white-space:nowrap}
.dfy-b-ok{background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#1c7a54) 14%,transparent);color:var(--dsw-alias-state-success-primary,#1c7a54)}
.dfy-b-err{background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#c0392b) 13%,transparent);color:var(--dsw-alias-state-error-primary,#c0392b)}
.dfy-b-warn{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#b8860b) 16%,transparent);color:var(--dsw-alias-state-warn-label,#8a6d1f)}
.dfy-b-idle{background:var(--dsw-alias-bg-layer-2,#e9eeed);color:var(--dsw-alias-label-secondary,#45606b)}
.dfy-dot{width:6px;height:6px;border-radius:50%;background:currentColor;animation:dfy-breathe 1.8s ease-in-out infinite}
@keyframes dfy-breathe{0%,100%{opacity:.35}50%{opacity:1}}
/* 加载态 */
.dfy-loading{display:inline-flex;align-items:center;gap:8px;color:var(--dsw-alias-label-tertiary,#5b6f6c);font-size:12.5px}
.dfy-spin{width:13px;height:13px;border-radius:50%;border:2px solid var(--dsw-alias-border-l3,#c9d6d3);border-top-color:var(--dsw-alias-state-business-primary,#0f5e57);animation:dfy-spin .7s linear infinite}
@keyframes dfy-spin{to{transform:rotate(360deg)}}
.dfy-list{display:grid}
.dfy-item{display:grid;gap:4px;min-width:0;padding:8px 0;border-bottom:.5px solid var(--dsw-alias-border-l1,#e6ecea);font-size:12.5px}
.dfy-item:first-child{padding-top:0}
.dfy-item:last-child{border-bottom:0;padding-bottom:0}
.dfy-item-h{display:flex;align-items:center;gap:8px;min-width:0}
.dfy-item-t{min-width:0;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dfy-item-sub{min-width:0;overflow-wrap:anywhere}
/* 行容器类直接作为列表子项时，同样获得列表项的间距与分隔线（兼容列表项内嵌行的情况） */
.dfy-list>.dfy-item-h,.dfy-list>.dfy-item-sub{display:flex;align-items:center;gap:8px;min-width:0;padding:8px 0;border-bottom:.5px solid var(--dsw-alias-border-l1,#e6ecea);font-size:12.5px}
.dfy-list>.dfy-item-sub{align-items:flex-start}
.dfy-list>.dfy-item-h:first-child,.dfy-list>.dfy-item-sub:first-child{padding-top:0}
.dfy-list>.dfy-item-h:last-child,.dfy-list>.dfy-item-sub:last-child{border-bottom:0;padding-bottom:0}
.dfy-pills{display:flex;flex-wrap:wrap;gap:8px}
.dfy-pill{appearance:none;min-height:24px;padding:2px 8px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l2,#d8e2e0);background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#17303c);font:inherit;font-size:11.5px;cursor:pointer}
.dfy-pill:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(15,94,87,.07))}
.dfy-field{display:grid;gap:4px;font-size:12.5px}
.dfy-field>span{font-weight:600}
.dfy-input,.dfy-select{width:100%;min-height:32px;padding:6px 10px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l2,#d8e2e0);background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#17303c);font:inherit;font-size:12.5px}
.dfy-check{display:flex;align-items:flex-start;gap:8px;font-size:12.5px}
.dfy-check input{flex:0 0 auto;margin-top:3px}
.dfy-link{color:var(--dsw-alias-link,#0f5e57);text-decoration:none}
.dfy-link:hover{text-decoration:underline}
.dfy-choice{display:flex;flex-wrap:wrap;gap:8px}
.dfy-chip{appearance:none;display:inline-flex;align-items:center;gap:8px;padding:6px 10px;border-radius:10px;border:.5px solid var(--dsw-alias-border-l2,#d8e2e0);background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#17303c);font:inherit;font-size:12.5px;cursor:pointer}
.dfy-chip:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(15,94,87,.07))}
.dfy-chip-on{border:1.5px solid var(--dsw-alias-state-business-primary,#0f5e57);background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#0f5e57) 8%,transparent)}
.dfy-root button:focus-visible,.dfy-root a:focus-visible,.dfy-root input:focus-visible,.dfy-root select:focus-visible,.dfy-root textarea:focus-visible,.dfy-root summary:focus-visible{outline:2px solid var(--dsw-focus-ring-color,rgba(15,94,87,.6));outline-offset:2px}
@media (max-width:760px){.dfy-body{padding:12px}.dfy-kpis{grid-template-columns:repeat(auto-fit,minmax(104px,1fr))}}
.dfy-pet-ai{position:absolute;top:10px;right:10px;z-index:4;font-size:10.5px;font-weight:700;padding:3px 9px;border-radius:999px;background:rgba(192,57,43,.95);color:#fff;box-shadow:0 2px 6px rgba(0,0,0,.30)}
.dfy-preview-conversation textarea{width:100%;border:1px solid var(--dsw-alias-border-l2,#d8e2e0);border-radius:6px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#17303c);font:inherit;padding:6px 8px}
.dfy-preview-conversation textarea{resize:vertical}
.dfy-pet-l2d{position:absolute;inset:0;z-index:2;cursor:pointer}
.dfy-pet-l2d canvas{display:block;width:100%;height:100%}
.dfy-pet-l2d-note{position:absolute;bottom:6px;left:8px;max-width:70%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10px;color:rgba(255,255,255,.55);pointer-events:none}
.dfy-role-preview{border:.5px solid var(--dsw-alias-border-l2,#d8e2e0);border-radius:14px;overflow:hidden;background:var(--dsw-alias-bg-layer-1,#fff)}
.dfy-role-stage{position:relative;display:grid;place-items:center;min-height:220px;aspect-ratio:16/10;overflow:hidden}
.dfy-role-art,.dfy-broadcast-avatar{position:absolute;inset:0;display:grid;place-items:center}
.dfy-role-art[hidden],.dfy-broadcast-avatar[hidden],.dfy-rig-surface[hidden]{display:none}
.dfy-stage-voice{position:absolute;top:12px;left:12px;display:flex;align-items:center;gap:8px;border-radius:7px;padding:5px 8px;background:#17303c;color:#fff;font-size:12px}
.dfy-speech-meter{width:38px;height:4px;border-radius:4px;background:#54616a;overflow:hidden}
.dfy-speech-meter i{display:block;width:100%;height:100%;background:#94e2d9;transform:scaleX(.05);transform-origin:left}
.dfy-stage-message{position:absolute;z-index:4;left:12px;right:12px;bottom:12px;margin:0;padding:7px 9px;background:#17303c;color:#fff;border-radius:7px;font-size:12px;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.dfy-role-stage :is(img,video){display:block;width:100%;height:100%;position:absolute;inset:0;object-fit:cover;object-position:center}
.dfy-rigged-avatar,.dfy-rigged-poster,.dfy-rigged-canvas{position:absolute;inset:0;width:100%;height:100%}
.dfy-rigged-avatar{display:grid;place-items:center;overflow:hidden;background:var(--stage-dark,#6d5b50)}
.dfy-rigged-poster{object-fit:cover}
.dfy-rigged-poster[hidden]{display:none}
.dfy-rigged-canvas{display:block}
.dfy-role-initial{font-size:28px;font-weight:700}
.dfy-role-caption{padding:10px 12px;display:grid;gap:4px}
.dfy-role-caption p{margin:0;overflow-wrap:anywhere}
.dfy-speech-caption{box-sizing:border-box;min-width:0;height:calc(3.9em + 2px);padding:.55em .85em;overflow:hidden;
  background:rgba(18,34,48,.70);-webkit-backdrop-filter:blur(14px) saturate(125%);backdrop-filter:blur(14px) saturate(125%);
  color:#fff;border:1px solid rgba(255,255,255,.32);border-radius:.85em;box-shadow:0 5px 20px #10263635;
  font-weight:600;line-height:1.4;text-align:center}
.dfy-caption-scroll{height:100%;overflow:hidden}
.dfy-caption-scroll p{min-height:100%;display:grid;align-content:center;margin:0;white-space:pre-wrap;overflow-wrap:anywhere}
.dfy-role-audio{display:grid;gap:5px}
.dfy-role-audio audio{width:100%;height:36px}
.dfy-l2d-hit{position:absolute;inset:0;background:transparent;border:0;cursor:pointer}
.dfy-l2d-hit:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#0f5e57);outline-offset:-3px}
.dfy-desk-root{
  --desk-bg:var(--dsw-alias-bg-base,#eef3f4);--desk-sheet:var(--dsw-alias-bg-layer-1,#fff);
  --desk-line:var(--dsw-alias-border-l1,#d5e0e3);--desk-text:var(--dsw-alias-label-primary,#172d36);
  --desk-muted:var(--dsw-alias-label-secondary,#48606a);--desk-accent:var(--dsw-alias-state-business-primary,#115f58);
  --desk-gutter:clamp(12px,2vw,28px);
  container:dfy-panel / inline-size;background:var(--desk-bg);color:var(--desk-text);
  font-family:var(--dsw-font-family,Inter,"PingFang SC","Microsoft YaHei",sans-serif);
}
.dfy-desk-header{padding:0 var(--desk-gutter);background:var(--desk-sheet);min-height:54px;gap:20px}
.dfy-brand{display:flex;align-items:center;gap:8px;white-space:nowrap;flex:none}
.dfy-brand h2{font-size:15px;margin:0}
.dfy-desk-nav,.dfy-subnav{display:flex;gap:8px;min-width:0}
.dfy-desk-nav .dfy-tab{min-height:44px;align-self:stretch}
.dfy-head-x{flex-wrap:nowrap;gap:10px}
.dfy-head-x button{white-space:nowrap}
.dfy-head-x .dfy-btn-ghost{color:var(--dsw-alias-state-error-primary,#a32c23)}
.dfy-header-notice{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:4px var(--desk-gutter);background:var(--desk-sheet);border-bottom:1px solid var(--desk-line);overflow-wrap:anywhere}
.dfy-header-notice button{flex:none}
.dfy-desk-body{padding:16px var(--desk-gutter) 24px}
.dfy-desk-body:has(.dfy-inline-stage:not([hidden])){padding-bottom:16px}
.dfy-workbench,.dfy-manage{max-width:1440px;margin:0 auto;display:grid;gap:14px;min-width:0}
.dfy-workbench-grid{display:grid;grid-template-columns:minmax(0,1.33fr) minmax(0,1fr);gap:14px;align-items:stretch}
.dfy-command,.dfy-desk-preview,.dfy-preview-conversation,.dfy-interaction-placeholder{
  min-width:0;border:1px solid var(--desk-line);border-radius:12px;background:var(--desk-sheet);
}
.dfy-command{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px 16px;padding:10px 12px}
.dfy-command-actions{display:flex;align-items:center;flex-wrap:wrap;gap:6px 8px;min-width:0}
.dfy-command-actions p{margin:0;color:var(--desk-muted);overflow-wrap:anywhere}
.dfy-command-metrics{display:flex;align-items:center;gap:12px;margin:0;flex-wrap:wrap}
.dfy-command-metrics div{display:flex;align-items:baseline;gap:6px}
.dfy-command-metrics dt{color:var(--desk-muted);font-size:12px}
.dfy-command-metrics dd{margin:0;font-weight:650;font-variant-numeric:tabular-nums}
.dfy-desk-text-button{color:var(--desk-accent);font:inherit;background:none;border:0;padding:0;text-decoration:underline;cursor:pointer}
.dfy-desk-preview,.dfy-preview-conversation,.dfy-interaction-placeholder{padding:12px;display:grid;gap:10px}
.dfy-preview-conversation{display:flex;flex-direction:column}
.dfy-desk-stage-head,.dfy-interaction-head,.dfy-turn-head{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:6px 10px}
.dfy-desk-stage-head h3,.dfy-interaction-head h3,.dfy-interaction-placeholder h3{margin:0;font-size:15px}
.dfy-desk-stage-head .dfy-select{width:auto;max-width:100%}
.dfy-desk-preview .dfy-role-stage{width:100%;min-height:0;aspect-ratio:auto;height:clamp(230px,49vh,570px)}
.dfy-desk-preview .dfy-role-stage :is(img,video){object-fit:contain}
.dfy-preview-conversation textarea{display:block;border-color:var(--desk-line);background:var(--desk-bg)}
.dfy-preview-conversation p,.dfy-interaction-placeholder p{margin:0}
.dfy-preview-conversation .dfy-caption:empty{display:none}
.dfy-preview-conversation .dfy-actions{margin-top:8px}
.dfy-desk-speak-options{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.dfy-desk-speak-options label{display:flex;align-items:center;gap:5px;color:var(--desk-muted);font-size:12px}
.dfy-turns{list-style:none;margin:0;padding:4px 10px;flex:1 0 auto;min-height:clamp(140px,30vh,330px);height:0;overflow:auto;overscroll-behavior:contain;border:1px solid var(--desk-line);border-radius:8px;background:var(--desk-bg)}
.dfy-turns li{padding:8px 2px;min-width:0}
.dfy-turns li+li{border-top:1px solid var(--desk-line)}
.dfy-turn-head time{margin-left:auto;color:var(--desk-muted);font-size:11px}
.dfy-preview-conversation .dfy-turn-text,.dfy-turn-answer{margin:4px 0;overflow-wrap:anywhere;white-space:pre-wrap}
.dfy-turn-answer{border-left:2px solid var(--desk-accent);padding:4px 8px;background:var(--desk-sheet);border-radius:0 6px 6px 0}
.dfy-turn-meta{font-size:11.5px;color:var(--desk-muted)}
.dfy-details>summary{width:fit-content;cursor:pointer;color:var(--desk-accent);font-weight:600;padding:4px 0}
.dfy-details[open]>summary{margin-bottom:6px}
.dfy-role-audio audio{max-width:320px}
.dfy-desk-safe{position:relative;min-height:180px;border-radius:10px;background:#142821;color:#e8f2ec;display:grid;align-content:center;justify-items:center;gap:8px;padding:16px;text-align:center}
.dfy-desk-safe strong{font-size:18px}
.dfy-desk-inline{margin:0;color:var(--desk-muted)}
.dfy-manage-content{min-width:0}
.dfy-subnav{border-bottom:1px solid var(--desk-line);flex-wrap:wrap}
.dfy-subnav .dfy-tab{font-size:13px;min-height:36px}
.dfy-form-grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(min(235px,100%),1fr))}
.dfy-form-card{max-width:800px}
.dfy-form-card .dfy-caption:empty{display:none}
.dfy-field-action{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:end;gap:8px}
.dfy-model-settings{display:grid;gap:14px;grid-template-columns:minmax(0,1fr) minmax(0,1.45fr);align-items:start}
.dfy-form-fields{display:grid;gap:12px;min-width:0;border:0;padding:0;margin:0}
.dfy-form-fields>p{margin:0}
@container dfy-panel (max-width:880px){.dfy-model-settings{grid-template-columns:minmax(0,1fr)}}
.dfy-settings-stack{display:grid;gap:12px}
.dfy-profile-info{display:grid;gap:8px}
.dfy-profile-info :is(h3,p){margin:0}
.dfy-profile-info h3{font-size:16px}
.dfy-profile-meta{display:flex;align-items:baseline;gap:8px 14px;flex-wrap:wrap;margin:0;padding:8px 0;border-block:1px solid var(--desk-line)}
.dfy-profile-meta div{display:flex;gap:6px}
.dfy-profile-meta dt{font-size:12px;color:var(--desk-muted)}
.dfy-profile-meta dd{margin:0;font-weight:600}
@container dfy-panel (max-width:840px){
  .dfy-desk-header{gap:6px 12px}
  .dfy-desk-nav,.dfy-subnav{gap:2px}
}
@container dfy-panel (max-width:720px){
  .dfy-desk-header{flex-wrap:wrap;padding-top:8px}
  .dfy-desk-nav{order:3;width:100%;overflow-x:auto}
  .dfy-desk-nav .dfy-tab{flex:1;padding-inline:6px}
  .dfy-grid{grid-template-columns:minmax(0,1fr)}
}
@container dfy-panel (max-width:390px){
  .dfy-head-x{gap:4px}
  .dfy-head-x .dfy-btn{padding-inline:6px}
  .dfy-brand svg{display:none}
  .dfy-desk-nav .dfy-tab{min-height:40px}
}

.dfy-inline-stage{position:relative;isolation:isolate;display:grid;grid-template-rows:auto minmax(0,1fr);gap:8px;width:100%;height:100%;min-width:0}
.dfy-inline-stage[hidden]{display:none}
.dfy-inline-stage-controls{width:100%;display:flex;justify-content:center;align-items:center;gap:8px;flex-wrap:wrap}
.dfy-inline-stage-controls select{width:auto;max-width:100%}
.dfy-stage-health{flex-basis:100%;margin:0;min-height:1.5em;text-align:center;color:var(--dsw-alias-state-warn-label,#8a5610);font-size:12px}
.dfy-inline-stage-frame{container-type:size;display:grid;place-items:center;min-width:0;min-height:0}
.dfy-output-window{container-type:size;display:grid;place-items:center;background:#10212c;width:100vw;height:100vh;overflow:hidden;font-family:-apple-system,"PingFang SC",sans-serif;line-height:1.5}
.dfy-output-window .dfy-broadcast{height:auto}
.dfy-broadcast{--ratio:.5625;position:relative;isolation:isolate;width:min(100%,calc(100cqh * var(--ratio)));aspect-ratio:var(--ratio);overflow:hidden;container-type:inline-size;background:radial-gradient(ellipse at 50% 38%,var(--stage-color,#1d6253),var(--stage-dark,#071c1a) 78%);color:#fff}
.dfy-broadcast-landscape{--ratio:1.777778}
.dfy-broadcast .dfy-pet-ai{z-index:4;top:5%;right:6%;font-size:clamp(10px,2.6cqw,22px)}
.dfy-broadcast-art{position:absolute;inset:11% 5% 17%;display:grid;place-items:center}
.dfy-broadcast-avatar>img,.dfy-broadcast-art>video{max-width:100%;max-height:100%;width:100%;height:100%;object-fit:contain;position:absolute;inset:0}
.dfy-broadcast-art .dfy-pet-l2d{inset:0;position:absolute}
.dfy-broadcast-art .dfy-l2d-hit,.dfy-broadcast-art .dfy-pet-l2d-note{display:none}
.dfy-broadcast-avatar>.dfy-rig-surface,.dfy-role-art>.dfy-rig-surface{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;object-position:center}
.dfy-idle-scene{opacity:0;pointer-events:none}
.dfy-room-person .dfy-idle-scene{object-fit:cover;object-position:center 40%}
.dfy-idle-scene.dfy-idle-scene-on{opacity:1}
.dfy-room-pet .dfy-broadcast-avatar>canvas.dfy-rig-surface{transform-origin:50% 68%}
.dfy-broadcast-caption{position:absolute;z-index:3;bottom:7%;left:6%;right:6%;font-size:clamp(13px,4cqw,38px)}
.dfy-broadcast-safe{position:absolute;inset:0;display:grid;place-items:center;font-size:clamp(18px,5cqw,42px);font-weight:650}
.dfy-broadcast{background:#b2c3cd}
.dfy-broadcast-art{inset:0}
.dfy-room-person .dfy-broadcast-avatar>.dfy-rig-surface,.dfy-room-person .dfy-broadcast-avatar>img{object-fit:cover;object-position:center 42%}
.dfy-room-pet .dfy-broadcast-art{inset:34% 5% 9%}
.dfy-room-backdrop{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;filter:blur(22px) brightness(.8);transform:scale(1.12)}
.dfy-broadcast:after{content:"";position:absolute;inset:0;pointer-events:none;background:linear-gradient(#10263655,transparent 30%,transparent 65%,#1026368c);z-index:1}
.dfy-broadcast-reference:after{content:none}
.dfy-room-overlay{position:absolute;inset:4% 5% auto;z-index:3;color:#173047;font-size:clamp(10px,3cqw,27px)}
.dfy-room-heading{display:flex;align-items:baseline;flex-wrap:wrap;gap:.35em .6em;color:white;text-shadow:0 2px 8px #10263690;margin-bottom:.8em;padding-right:28%}
.dfy-room-heading strong{font-size:1.65em;letter-spacing:.05em;overflow-wrap:anywhere}
.dfy-room-heading span{font-size:.8em}
.dfy-room-card{border:1px solid #ffffff70;background:rgba(237,246,255,.42);-webkit-backdrop-filter:blur(22px) saturate(145%);backdrop-filter:blur(22px) saturate(145%);border-radius:1em;padding:.8em;box-shadow:inset 0 1px 0 #ffffff60,0 4px 20px #10263618;min-width:0;text-shadow:0 1px 2px #ffffff65}
.dfy-room-card p{font-size:.83em;line-height:1.5;margin:.25em 0;overflow:hidden;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow-wrap:anywhere}
.dfy-room-card p b{margin-right:.5em}
.dfy-broadcast .dfy-pet-ai{top:4%;right:5%;font-size:clamp(9px,2.5cqw,22px);background:#243b51b5}
.dfy-broadcast-safe{z-index:3;background:#173047}
/* Full-bleed scene with independent broadcast widgets. All sizes scale with the 16:9 canvas. */
.dfy-broadcast-landscape{
  --stage-ink:#2c405e;--stage-muted:#516682;--stage-paper:#f6fbffe6;--stage-rim:#ffffffee;
  --stage-blue:#246fb4;--stage-pink:#a13c69;--stage-tint:#dcedff;--stage-ribbon:linear-gradient(110deg,#2879be,#91558e);
  --stage-bubble:#252c49;--stage-caption-ink:#ffe1ef;
  background:linear-gradient(#a2deec,#e6f8f6 55%,#abcdd0);color:var(--stage-ink)
}
.dfy-broadcast-landscape[data-stage-theme="night"]{
  --stage-ink:#eaf5ff;--stage-muted:#b9cde4;--stage-paper:#102b50e6;--stage-rim:#85c6ff70;
  --stage-blue:#a8e2ff;--stage-pink:#d9c4ff;--stage-tint:#23456a;--stage-ribbon:linear-gradient(110deg,#23588d,#62549f);
  --stage-bubble:#081b36;--stage-caption-ink:#c5eeff;
  background:radial-gradient(ellipse at 48% -15%,#5dbfe4 0%,#184571 43%,#07132d 85%);
}
.dfy-broadcast-landscape[data-stage-theme="warm"]{
  --stage-ink:#fff1ea;--stage-muted:#f1d3e2;--stage-paper:#46264de8;--stage-rim:#ffd4df8a;
  --stage-blue:#ffd4a4;--stage-pink:#ffd0ed;--stage-tint:#684169;--stage-ribbon:linear-gradient(110deg,#98557a,#935034);
  --stage-bubble:#38223f;--stage-caption-ink:#ffe4ba;
  background:radial-gradient(ellipse at 52% 88%,#ffd08c,transparent 42%),linear-gradient(#221d46,#793c71 53%,#db7382 79%,#6a426c 80%,#422b58);
}
.dfy-broadcast-landscape:after{content:none}
.dfy-wide-scene,.dfy-wide-scene>img,.dfy-wide-atmosphere{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}
.dfy-wide-scene>img{object-fit:cover}
.dfy-wide-scene:after{content:"";position:absolute;inset:0;box-shadow:inset 0 0 11cqw #172a472e}
.dfy-wide-atmosphere{
  background:linear-gradient(116deg,transparent 25%,#fff6d951 40%,transparent 52%,#fff6d931 60%,transparent 73%);
  animation:dfy-stage-light 14s ease-in-out infinite alternate
}
[data-stage-theme="night"] .dfy-wide-atmosphere{
  transform-origin:52% 0;
  background:conic-gradient(from 121deg at 52% -5%,transparent,#a3e8ff31 8deg,transparent 19deg,#70c6ff21 35deg,transparent 44deg,#b7efef27 50deg,transparent 60deg);
}
[data-stage-theme="warm"] .dfy-wide-atmosphere{
  background:radial-gradient(circle at 52% 73%,#fff0c2 0 4.5%,#ffc7806b 5%,transparent 15%),repeating-linear-gradient(0deg,transparent 0 1.1cqw,#ffe8cb0d 1.18cqw 1.25cqw);
}
@keyframes dfy-stage-light{from{opacity:.58}to{opacity:1}}
.dfy-wide-floats{position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:1}
.dfy-wide-floats i{
  position:absolute;bottom:-6%;left:var(--x);width:var(--size);aspect-ratio:1;border-radius:50%;
  background:radial-gradient(circle at 32% 26%,#fff 0 8%,transparent 15%),radial-gradient(circle at 45% 45%,#fff1 45%,#d5f6ffaa 76%,#fff9 81%,transparent 88%);
  animation:dfy-stage-float var(--period) linear var(--delay) infinite;opacity:.45
}
[data-stage-theme="warm"] .dfy-wide-floats i{background:radial-gradient(circle,#fff1bd 5%,#ffd09277 25%,transparent 64%)}
@keyframes dfy-stage-float{0%{transform:translate(0,0);opacity:0}12%,86%{opacity:.56}55%{transform:translate(1.8cqw,-33cqw)}100%{transform:translate(-.6cqw,-62cqw);opacity:0}}
.dfy-broadcast-landscape .dfy-pet-ai{
  top:3.6%;right:2.4%;font-size:1.08cqw;padding:.45em .9em;border:1px solid var(--stage-rim);
  background:var(--stage-paper);color:var(--stage-ink);text-shadow:none;box-shadow:0 .3cqw 1cqw #10274433;
}
.dfy-wide-heading{position:absolute;z-index:3;top:3%;left:2.4%;display:flex;align-items:center;gap:.55cqw;max-width:74%;font-size:1.15cqw}
.dfy-wide-heading strong,.dfy-wide-name{
  background:var(--stage-ribbon);color:#fff;border:.13cqw solid #fffffff0;border-radius:3em;
  padding:.32em .9em;font-size:1.65cqw;font-weight:750;letter-spacing:.06em;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;box-shadow:0 .32cqw .9cqw #18335439;
}
.dfy-wide-state{
  display:flex;align-items:center;gap:.4em;background:var(--stage-paper);border:1px solid var(--stage-rim);
  border-radius:2em;padding:.36em .75em;white-space:nowrap;font-weight:650;box-shadow:0 .24cqw .7cqw #18335424;
}
.dfy-wide-state:before{content:"";width:.42em;height:.42em;border-radius:50%;background:var(--stage-muted)}
.dfy-wide-state[data-live="true"]:before{background:#fb617e;box-shadow:0 0 .55cqw #fb617e9e}
.dfy-wide-panel{
  position:absolute;z-index:3;box-sizing:border-box;display:flex;flex-direction:column;gap:.68cqw;
  background:var(--stage-paper);color:var(--stage-ink);border:.13cqw solid var(--stage-rim);
  border-radius:1.45cqw;padding:1cqw 1.15cqw;font-size:1.23cqw;overflow:hidden;
  box-shadow:0 .65cqw 1.4cqw -.35cqw #1429504d;-webkit-backdrop-filter:blur(.65cqw) saturate(120%);backdrop-filter:blur(.65cqw) saturate(120%);
}
.dfy-wide-panel h3{display:flex;align-items:center;gap:.45em;flex:none;font-size:1.35cqw;letter-spacing:.06em;margin:0;white-space:nowrap;color:var(--stage-blue)}
.dfy-wide-panel h3:before{content:"";flex:none;width:.74em;height:.6em;border-radius:.26em .26em .26em .08em;background:currentColor}
.dfy-wide-panel h3:after{content:"";flex:1;height:.12cqw;min-width:0;opacity:.32;background:repeating-linear-gradient(90deg,currentColor 0 .44cqw,transparent .44cqw .7cqw)}
.dfy-wide-panel p{margin:0;line-height:1.45;overflow-wrap:anywhere;white-space:pre-wrap}
.dfy-wide-panel b{display:block;color:var(--stage-muted);font-size:1.03cqw;font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dfy-wide-notice{top:11%;left:2.4%;width:23%;height:31%}
.dfy-wide-notice h3,.dfy-wide-gifts h3{color:var(--stage-pink)}
.dfy-wide-notice h3:before{height:.56em;width:.56em;border-radius:50%;box-shadow:inset .15em .13em #fff9}
.dfy-wide-notice p{height:100%;overflow:auto;scrollbar-width:thin}
.dfy-wide-chat{top:44%;left:2.4%;width:23%;bottom:4.5%}
.dfy-wide-chat .dfy-wide-rows{justify-content:flex-end}
.dfy-wide-gifts{top:14%;right:2.4%;width:22%;max-height:30%}
.dfy-wide-gifts h3:before{height:.56em;width:.56em;border-radius:.12em;transform:rotate(45deg)}
.dfy-wide-queue{right:2.4%;bottom:4.5%;width:22%;max-height:39%;background:var(--stage-bubble);color:#f4f8fe}
.dfy-wide-queue h3,.dfy-wide-queue b{color:#cadbff}
.dfy-wide-queue h3:before{width:.52em;height:.52em;background:none;border:.12em solid;border-width:0 .12em .12em 0;border-radius:0;transform:rotate(-45deg)}
.dfy-wide-rows{display:flex;flex-direction:column;gap:.5cqw;flex:1;min-height:0;overflow:hidden}
.dfy-wide-item{flex:none;min-width:0}
.dfy-wide-item p{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden}
.dfy-wide-chat .dfy-wide-item>p{width:fit-content;max-width:100%;margin-top:.14cqw;padding:.3em .55em;background:var(--stage-tint);border-radius:.12em .65em .65em .65em}
.dfy-wide-gifts .dfy-wide-item{padding:.42cqw .6cqw;background:var(--stage-tint);border-radius:.55cqw}
.dfy-wide-queue .dfy-wide-item p{font-size:1.04cqw}
.dfy-wide-empty{opacity:.76;font-size:1.11cqw}
.dfy-broadcast-landscape .dfy-broadcast-art{z-index:2}
.dfy-broadcast-landscape.dfy-room-pet .dfy-broadcast-art,.dfy-broadcast-landscape.dfy-room-cutout .dfy-broadcast-art{inset:9% 29% 17%;filter:drop-shadow(0 .5cqw .7cqw #142d5a55)}
.dfy-broadcast-landscape.dfy-room-cutout .dfy-broadcast-art :is(.dfy-rig-surface,img){object-fit:contain;object-position:center}
/* Feather the edges of portrait crops before they meet the illustrated scene. */
.dfy-broadcast-landscape.dfy-room-matted .dfy-broadcast-art{
  --stage-crop-fade:linear-gradient(90deg,transparent 15%,#000 21%,#000 79%,transparent 85%);
  -webkit-mask-image:var(--stage-crop-fade);mask-image:var(--stage-crop-fade);
}
.dfy-broadcast-landscape .dfy-stage-matte{
  -webkit-mask:var(--stage-matte) center / contain no-repeat;mask:var(--stage-matte) center / contain no-repeat;
}
.dfy-broadcast-landscape .dfy-stage-matte>.dfy-rig-surface{object-fit:contain;object-position:center}
.dfy-broadcast-landscape.dfy-room-person:not(.dfy-room-cutout) .dfy-broadcast-art{
  inset:13% 31% 17%;border-radius:47% 47% 27% 27% / 33% 33% 17% 17%;overflow:hidden;
  border:.18cqw solid var(--stage-rim);box-shadow:0 .65cqw 2.4cqw #10274455;background:#273049;
}
.dfy-broadcast-landscape .dfy-broadcast-caption{
  left:28.5%;right:28.5%;bottom:4.6%;height:calc(3.9em + 2px);font-size:1.88cqw;
  overflow:visible;border:.14cqw solid var(--stage-rim);border-radius:.95em;color:var(--stage-caption-ink);
  background:var(--stage-bubble);backdrop-filter:none;box-shadow:0 .45cqw 1.25cqw #172a4b48;animation:dfy-stage-speech .22s ease-out
}
.dfy-broadcast-landscape .dfy-broadcast-caption:before{
  content:"";position:absolute;top:-.46em;left:calc(50% - .4em);width:.8em;aspect-ratio:1;
  border:solid var(--stage-rim);border-width:.14cqw 0 0 .14cqw;background:var(--stage-bubble);transform:rotate(45deg);
}
@keyframes dfy-stage-speech{from{opacity:0;transform:translateY(.45cqw)}}
.dfy-wide-name{position:absolute;z-index:3;bottom:20.7%;left:50%;transform:translateX(-50%);font-size:1.24cqw;max-width:34%}
.dfy-wide-gift-alert{
  position:absolute;z-index:4;top:12%;left:50%;transform:translateX(-50%);max-width:42%;border-radius:2em;
  background:var(--stage-ribbon);color:#fff;border:.13cqw solid #fff;padding:.4em .9em;overflow:hidden;
  white-space:nowrap;text-overflow:ellipsis;font-size:1.24cqw;font-weight:700;box-shadow:0 .45cqw 1.1cqw #172a4b48;
  animation:dfy-stage-gift .25s ease-out
}
@keyframes dfy-stage-gift{from{opacity:0;transform:translate(-50%,-.45cqw)}}
.dfy-stage-drawer-shade{position:absolute;inset:0;z-index:5;background:#0a22295c;border-radius:10px}
.dfy-stage-drawer{
  position:absolute;inset:0 0 0 auto;z-index:6;box-sizing:border-box;display:grid;grid-template-rows:auto minmax(0,1fr);
  width:min(440px,100%);height:100%;max-width:100%;max-height:100%;margin:0;padding:0;overflow:hidden;
  color:var(--desk-text);background:var(--desk-sheet);border:1px solid var(--desk-line);border-radius:12px;
  box-shadow:-14px 0 38px #0a222930;animation:dfy-stage-drawer-in .18s ease-out
}
@keyframes dfy-stage-drawer-in{from{opacity:0;transform:translateX(16px)}}
.dfy-stage-drawer-head{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:12px 16px;border-bottom:1px solid var(--desk-line)}
.dfy-stage-drawer-head h3{font-size:15px;margin:0}
.dfy-stage-settings{display:grid;grid-template-rows:minmax(0,1fr) auto;min-height:0;margin:0}
.dfy-stage-settings-body{display:block;min-height:0;min-width:0;box-sizing:border-box;overflow:auto;overscroll-behavior:contain;padding:14px 16px}
.dfy-stage-settings section{display:grid;gap:10px;min-width:0}
.dfy-stage-settings section+section{margin-top:14px;padding-top:14px;border-top:1px solid var(--desk-line)}
.dfy-stage-settings :is(h4,p){margin:0}
.dfy-stage-settings h4{font-size:13px}
.dfy-stage-settings .dfy-form-grid{grid-template-columns:repeat(auto-fit,minmax(min(168px,100%),1fr))}
.dfy-stage-settings input[type="checkbox"]{accent-color:var(--desk-accent)}
.dfy-stage-settings input[readonly]{background:var(--desk-sheet);color:var(--desk-muted)}
.dfy-stage-settings textarea{box-sizing:border-box;width:100%;min-height:70px;resize:vertical}
.dfy-stage-settings-footer{display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:11px 16px;border-top:1px solid var(--desk-line)}
.dfy-stage-source-preview{display:flex;align-items:center;gap:12px;min-width:0}
.dfy-stage-source-preview img{width:min(36%,180px);aspect-ratio:16/9;object-fit:contain;border-radius:6px;background:var(--desk-sheet)}
.dfy-stage-source-preview>div{display:grid;gap:4px}
.dfy-stage-source-preview strong{font-size:13px}
.dfy-stage-settings .dfy-actions{margin:0}
.dfy-inline-stage-controls{justify-content:space-between;padding:0 2px}
.dfy-inline-stage-controls .dfy-actions{margin:0}
.dfy-stage-health:empty{display:none}
.dfy-broadcast .dfy-original-stage-video{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;opacity:1;z-index:1}
.dfy-broadcast .dfy-original-stage-mouth{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;pointer-events:none;z-index:2}
.dfy-broadcast-original{background:#101820}
.dfy-event-options{min-width:0;display:flex;flex-wrap:wrap;gap:6px 12px;font-size:12px;margin:0;padding:0;border:0}
.dfy-event-options label{display:flex;align-items:center;gap:4px}
@media (prefers-reduced-motion:reduce){.dfy-root *{animation:none!important;transition:none!important}}
`;

	function ensureStyle() {
		if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
		const style = document.createElement("style");
		style.id = STYLE_ID;
		style.textContent = CSS;
		document.head.appendChild(style);
	}

	// ------------------------------------------------------------------ 基础件

	async function api(path, body) {
		const res = await fetch("/api/dafeiyu/" + path, {
			method: body ? "POST" : "GET",
			headers: body ? jsonHeaders : undefined,
			body: body ? JSON.stringify(body) : undefined,
			credentials: "same-origin",
		});
		return res.json();
	}

	const Btn = ({ onClick, disabled, tone, title, type = "button", children }) => h("button", {
		type,
		className: "dfy-btn" + (tone === "primary" ? " dfy-btn-pri" : tone === "ghost" ? " dfy-btn-ghost" : tone === "danger" ? " dfy-btn-danger" : ""),
		onClick, disabled, title,
	}, children);

	const Badge = ({ tone, text, dot }) => h("span", { className: "dfy-badge dfy-b-" + (tone || "idle") },
		dot ? h("i", { className: "dfy-dot" }) : null, text);

	const Kpi = ({ label, value, tone, title }) => h("div", { className: "dfy-kpi", title: title || value },
		h("span", { className: "dfy-kpi-l" }, label),
		h("strong", { className: "dfy-kpi-v", style: tone === "ok" ? { color: "var(--dsw-alias-state-success-primary,#1c7a54)" } : tone === "err" ? { color: "var(--dsw-alias-state-error-primary,#c0392b)" } : undefined }, value));

	const Row = ({ label, value, mono }) => h("div", { className: "dfy-row" },
		h("span", { className: "dfy-row-l" }, label),
		h("span", { className: "dfy-row-v" + (mono ? " dfy-mono" : "") }, value));

	const Card = ({ title, children, extra }) => h("section", { className: "dfy-card" },
		title ? h("div", { className: "dfy-card-h" }, h("h3", null, title), extra || null) : null,
		h("div", { className: "dfy-card-b" }, children));

	const Field = ({ label, children }) => h("label", { className: "dfy-field" }, h("span", null, label), children);

	function ProfileInfo({ profile, modelStatus }) {
		return h("div", { className: "dfy-profile-info" },
			h("h3", null, profile.name, profile.enName ? h("span", { className: "dfy-caption" }, " · " + profile.enName) : null),
			profile.tagline ? h("p", null, profile.tagline) : null,
			h("dl", { className: "dfy-profile-meta" },
				[["年龄", "age"], ["身高", "height"], ["星座", "zodiac"], ["MBTI", "mbti"]].map(([label, key]) =>
					h("div", { key }, h("dt", null, label), h("dd", null, profile[key] || "—")))),
			profile.bio ? h("p", { className: "dfy-muted" }, profile.bio) : null,
			h("p", { className: "dfy-caption" }, (profile.source === "plugin" ? "DSH 桌宠" : "鹅次元") + " · " + modelStatus));
	}

	const Loading = ({ text }) => h("span", { className: "dfy-loading", role: "status" }, h("i", { className: "dfy-spin", "aria-hidden": true }), text || "加载中…");


	// ------------------------------------------------------------------ 导航图标

	const FishIcon = ({ size = 16 }) => {
		return h("svg", { width: size, height: size, viewBox: "0 0 64 64", "aria-hidden": true, style: { color: "inherit", flex: "0 0 auto" } },
			h("ellipse", { cx: 28, cy: 37, rx: 18, ry: 12, fill: "currentColor" }),
			h("path", { d: "M41 29 L57 22 L52 37 L57 52 L41 45 Z", fill: "currentColor" }),
			h("circle", { cx: 18.5, cy: 33, r: 2.8, fill: "var(--dsw-alias-bg-base, #f6faf9)" }),
			h("path", { d: "M14 42 Q25 48 36 44", stroke: "var(--dsw-alias-bg-base, #f6faf9)", strokeWidth: 2.2, fill: "none", strokeLinecap: "round" }),
			h("circle", { cx: 46, cy: 14, r: 4.2, fill: DSW_BLUE }),
			h("circle", { cx: 54, cy: 8.5, r: 2, fill: DSW_BLUE, opacity: 0.55 }));
	};

	// ------------------------------------------------------------------ 预览画布（浏览器渲染；本地预览 ≠ 已开播）

	// ------------------------------------------------------------------ Live2D 桌宠（0.14.0）
	// 架构对齐鹅次元的「形象层」：Cubism Core + pixi.js + pixi-live2d-display（vendor 随插件分发，
	// client/vendor/VENDOR-LICENSES.md），模型包从对应角色的本地数据目录加载。
	// 客户端单文件契约：vendor 经 /api/dafeiyu/avatar/vendor 以脚本文本下发，blob <script> 顺序注入；
	// 模型文件经 /api/dafeiyu/avatar/model-file 以 base64 下发，重写 FileReferences 为 blob URL 后喂渲染器。
	// 模型加载失败时可以使用对应角色的素材预览。

	const L2_MIME = { ".png": "image/png", ".webp": "image/webp", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".json": "application/json", ".wav": "audio/wav", ".mp3": "audio/mpeg" };
	let live2dStack;

	function decodeAsset(base64) {
		return Uint8Array.from(atob(base64), (byte) => byte.charCodeAt(0));
	}

	function ensureLive2DStack() {
		if (live2dStack) return live2dStack;
		live2dStack = (async () => {
			for (const name of ["core", "pixi", "extension"]) {
				const r = await api("avatar/vendor?name=" + name);
				if (!r.ok) throw new Error(r.error || "Live2D 运行时不可用");
				const url = URL.createObjectURL(new Blob([r.vendor.text], { type: "text/javascript" }));
				const script = document.createElement("script");
				try {
					await new Promise((resolve, reject) => {
						script.src = url;
						script.onload = resolve;
						script.onerror = () => reject(new Error("无法加载 Live2D 运行时"));
						document.head.appendChild(script);
					});
				} finally {
					script.remove();
					URL.revokeObjectURL(url);
				}
			}
			const PIXI = window.PIXI;
			const LD = PIXI?.live2d;
			if (!LD?.Live2DModel || !LD.Cubism4ModelSettings) throw new Error("Live2D 渲染栈未就绪");
			return { PIXI, LD };
		})().catch((err) => {
			live2dStack = null;
			throw err;
		});
		return live2dStack;
	}

	async function loadLive2DSettings(LD, entry, urls, signal) {
		const file = async (path) => {
			const query = new URLSearchParams({ id: entry.id, path });
			const response = await fetch("/api/dafeiyu/avatar/model-file?" + query, { signal });
			const result = await response.json();
			if (!result.ok) throw new Error(result.error || path);
			signal.throwIfAborted();
			return decodeAsset(result.file.base64);
		};
		const raw = JSON.parse(new TextDecoder().decode(await file(entry.entry)));
		const references = raw.FileReferences;
		const base = entry.entry.slice(0, entry.entry.lastIndexOf("/") + 1);
		const resources = new Map();
		const ref = (rel) => {
			if (typeof rel !== "string" || !rel || /^[\\/]|^[a-z]+:/i.test(rel)) throw new Error("模型包含非本地资源");
			if (!resources.has(rel)) resources.set(rel, (async () => {
				const bytes = await file(base + rel);
				const ext = rel.slice(rel.lastIndexOf(".")).toLowerCase();
				const url = URL.createObjectURL(new Blob([bytes], { type: L2_MIME[ext] || "application/octet-stream" }));
				urls.add(url);
				return url;
			})());
			return resources.get(rel);
		};
		for (const key of ["Moc", "Physics", "Pose", "UserData", "DisplayInfo"]) {
			if (references[key]) references[key] = await ref(references[key]);
		}
		references.Textures = await Promise.all(references.Textures.map(ref));
		for (const expression of references.Expressions || []) expression.File = await ref(expression.File);
		for (const group of Object.values(references.Motions || {})) {
			for (const motion of group) {
				motion.File = await ref(motion.File);
				if (motion.Sound) motion.Sound = await ref(motion.Sound);
			}
		}
		raw.url = new URL("/" + entry.entry, window.location.origin).href;
		const settings = new LD.Cubism4ModelSettings(raw);
		settings.resolveURL = (path) => {
			if (!urls.has(path)) throw new Error("模型包含未登记的资源");
			return path;
		};
		return settings;
	}

	function Live2DScene({ entry, onFail, speaking, listening, emotion, mouthLevel, viseme, dialogue, safe, onLipSync, onFrame }) {
		const host = useRef(null);
		const modelRef = useRef(null);
		const speechRef = useRef({ speaking: false, mouthLevel: null });
		const [ready, setReady] = useState(false);
		speechRef.current = { speaking, listening, emotion, mouthLevel, viseme, dialogue, safe };
		useEffect(() => {
			const controller = new AbortController();
			const urls = new Set();
			let app, model, observer;
			const dispose = () => {
				observer?.disconnect();
				const destroyTextures = { children: true, texture: true, baseTexture: true };
				if (model && !model.destroyed) model.destroy(destroyTextures);
				app?.destroy(true, destroyTextures);
				app = null;
				model = null;
				modelRef.current = null;
				for (const url of urls) URL.revokeObjectURL(url);
				urls.clear();
			};
			(async () => {
				try {
					const { PIXI, LD } = await ensureLive2DStack();
					controller.signal.throwIfAborted();
					const settings = await loadLive2DSettings(LD, entry, urls, controller.signal);
					controller.signal.throwIfAborted();
					const surface = host.current;
					app = new PIXI.Application({ backgroundAlpha: 0, antialias: true,
						autoDensity: true, resolution: Math.min(2, window.devicePixelRatio || 1) });
					const loaded = await LD.Live2DModel.from(settings, { autoInteract: false, ticker: app.ticker });
					if (controller.signal.aborted) {
						loaded.destroy({ children: true, texture: true, baseTexture: true });
						return;
					}
					model = loaded;
					modelRef.current = model;
					const internal = model.internalModel;
					const core = internal.coreModel;
					const calibration = entry.lipSync || {};
					const params = calibration.ids?.length ? calibration.ids : settings.getLipSyncParameters() || [];
					const mouths = (params.length ? params : ["ParamMouthOpenY"]).flatMap((id) => {
						const index = core.getParameterIndex(id);
						if (index < 0 || index >= core.getParameterCount()) return [];
						const min = core.getParameterMinimumValue(index), max = core.getParameterMaximumValue(index);
						const clamp = (value) => Math.max(min, Math.min(max, value));
						const closed = clamp(calibration.closed ?? core.getParameterDefaultValue(index));
						const open = clamp(calibration.open ?? max);
						return open === closed ? [] : [{ index, closed, open }];
					});
					onLipSync?.(mouths.length > 0);
					const motion = createAvatarMotion();
					const dialogueBlend = createDialogueBlend();
					const bodyMotion = createBodyMotion();
					const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
					const parameter = (id) => {
						const index = core.getParameterIndex(id);
						if (index < 0 || index >= core.getParameterCount()) return null;
						return { index, min: core.getParameterMinimumValue(index), max: core.getParameterMaximumValue(index) };
					};
					const face = Object.fromEntries(["ParamEyeLOpen", "ParamEyeROpen", "ParamAngleX", "ParamAngleY", "ParamAngleZ",
						"ParamBreath", "ParamMouthForm", "ParamBrowLY", "ParamBrowRY", "ParamEyeBallX", "ParamEyeBallY",
						"ParamBodyAngleX", "ParamBodyAngleY", "ParamBodyAngleZ"].map((id) => [id, parameter(id)]));
					const set = (id, value, additive = false) => {
						const p = face[id];
						if (p) core.setParameterValueByIndex(p.index, Math.max(p.min, Math.min(p.max,
							value + (additive ? core.getParameterValueByIndex(p.index) : 0))));
					};
					internal.on("beforeModelUpdate", () => {
						const speech = speechRef.current;
						const sample = speech.mouthLevel?.sample?.() || { level: speech.mouthLevel?.() || 0 };
						const now = performance.now();
						const pose = motion(now, { ...speech, ...sample, reducedMotion: reduced.matches,
							viseme: speech.viseme?.sample?.() ?? speech.viseme,
							level: Math.max(0, (sample.level - (calibration.threshold ?? 0.03)) * (calibration.gain ?? 1.1)) });
						for (const { index, closed, open } of mouths) core.setParameterValueByIndex(index, closed + (open - closed) * pose.opening);
						// 对话动作叠加：弹幕视线/思考侧头/收尾点头（安全与减少动态时 blend 自身归零）
						const add = dialogueBlend(now, speech.dialogue?.current,
							{ safe: !!speech.safe, reducedMotion: reduced.matches, speaking: !!speech.speaking });
						const body = bodyMotion(now, pose, add, reduced.matches);
						set("ParamMouthForm", pose.form * 0.35 + pose.expression);
						set("ParamBrowLY", pose.expression * 0.25 + add.brow * 0.15 + pose.browDip * 0.5, true);
						set("ParamBrowRY", pose.expression * 0.25 + add.brow * 0.15 + pose.browDip * 0.5, true);
						if (!reduced.matches) {
							// Multiply the existing eye state to preserve authored expressions and motion.
							const eyeStates = [["ParamEyeLOpen", pose.blinkLeft], ["ParamEyeROpen", pose.blinkRight]];
							for (const [id, closed] of eyeStates) {
								const p = face[id];
								if (p) set(id, core.getParameterValueByIndex(p.index) * (1 - closed));
							}
							set("ParamEyeBallX", pose.gaze + add.gaze * 0.6, true);
							set("ParamEyeBallY", -pose.nod * 0.08 - add.nod * 0.05, true);
							set("ParamAngleX", pose.sway * 2.5 + add.swing * 1.2, true);
							set("ParamAngleY", -pose.nod * 4 - add.nod * 2, true);
							set("ParamAngleZ", pose.sway * 1.5 + add.swing * 0.8, true);
							set("ParamBodyAngleX", (body.right - body.left) * 2.5, true);
							set("ParamBodyAngleY", body.lift * 3.2, true);
							set("ParamBodyAngleZ", body.lean * 2.4, true);
							set("ParamBreath", pose.breath);
						}
						if (onFrame && !app.renderer.gl?.isContextLost()) onFrame();
					});
					model.anchor.set(0.5, 1);
					app.stage.addChild(model);
					surface.appendChild(app.view);
					const fit = () => {
						const width = Math.max(1, surface.clientWidth);
						const height = Math.max(1, surface.clientHeight);
						app.renderer.resize(width, height);
						model.scale.set(Math.min(width / internal.originalWidth, height / internal.originalHeight) * 0.94);
						model.position.set(width / 2, height * 0.97);
					};
					fit();
					observer = new ResizeObserver(fit);
					observer.observe(surface);
					setReady(true);
				} catch (error) {
					if (!controller.signal.aborted) {
						controller.abort();
						dispose();
						onFail(error.message);
					}
				}
			})();
			return () => { controller.abort(); dispose(); };
		}, [entry, onFrame]);
		const tap = () => {
			const model = modelRef.current;
			if (!model) return;
			const groups = model.internalModel.settings.motions || {};
			const group = ["Tap", "TapBody", "Flick"].find((key) => groups[key]?.length);
			if (group) model.motion(group, undefined, 3).catch(() => {});
			else model.expression().catch(() => {});
		};
		return h("div", { className: "dfy-pet-l2d", ref: host },
			ready ? h("button", { className: "dfy-l2d-hit", type: "button", onClick: tap, "aria-label": "触发形象动作" }) :
				h("span", { className: "dfy-pet-l2d-note", role: "status" }, "形象加载中…"));
	}

	function paintMouth(context, image, mouth, dsh) {
		const x = mouth.x * image.naturalWidth;
		const y = mouth.y * image.naturalHeight;
		const span = mouth.width * image.naturalWidth;
		const patch = document.createElement("canvas");
		const width = patch.width = Math.ceil(span * 1.22);
		const height = patch.height = Math.ceil(span * 0.66);
		const layer = patch.getContext("2d");
		layer.translate(width / 2, height / 2);
		layer.rotate(-mouth.tilt);
		layer.drawImage(image, -x, -y);
		const original = layer.getImageData(0, 0, width, height).data;
		const warped = layer.createImageData(width, height);
		layer.resetTransform();
		const upperLip = height / 2 - span * 0.035;
		const lowerLip = height / 2 + span * 0.06;
		const end = height - 0.5;
		const weights = Array.from({ length: width }, (_, col) => {
			const position = Math.min(1, Math.abs(col + 0.5 - width / 2) / (span * 0.48));
			return Math.cos(position * Math.PI / 2) ** 2;
		});
		return (opening, form = 0) => {
			for (let col = 0; col < width; col++) {
				const shape = Math.max(0, Math.cos(Math.min(1, Math.abs(col + 0.5 - width / 2) / (span * (0.48 + form * 0.045))) * Math.PI / 2)) ** 2;
				const drop = span * (dsh ? 0.18 : 0.115) * opening * shape;
				const lip = lowerLip + drop;
				for (let row = 0; row < height; row++) {
					const py = row + 0.5;
					if (py <= upperLip || py >= end) continue;
					const source = (py <= lip ?
						upperLip + (py - upperLip) * (lowerLip - upperLip) / (lip - upperLip) :
						lowerLip + (py - lip) * (end - lowerLip) / (end - lip)) - 0.5;
					const top = Math.floor(source);
					const mix = source - top;
					const first = (top * width + col) * 4;
					const pixel = (row * width + col) * 4;
					for (let ch = 0; ch < 3; ch++) {
						warped.data[pixel + ch] = original[first + ch] * (1 - mix) + original[first + width * 4 + ch] * mix;
					}
					warped.data[pixel + 3] = 255 * Math.min(1, weights[col] * 6, py - upperLip, end - py);
				}
			}
			layer.putImageData(warped, 0, 0);
			context.save();
			context.translate(x, y);
			context.rotate(mouth.tilt);
			context.drawImage(patch, -width / 2, -height / 2);
			context.restore();
		};
	}

	function paintEyes(context, image, eyes) {
		const patches = eyes.map((eye) => {
			const width = Math.ceil(eye.width * image.naturalWidth * 1.5);
			const height = Math.ceil(eye.height * image.naturalHeight * 2.4);
			const patch = document.createElement("canvas"); patch.width = width; patch.height = height;
			const layer = patch.getContext("2d");
			layer.translate(width / 2, height / 2); layer.rotate(-eye.tilt);
			layer.drawImage(image, -eye.x * image.naturalWidth, -eye.y * image.naturalHeight);
			return { eye, patch, width, height, pixels: layer.getImageData(0, 0, width, height), layer };
		});
		return (blink) => {
			if (blink < 0.01) return;
			for (const { eye, patch, width, height, pixels, layer } of patches) {
				const out = layer.createImageData(width, height);
				const half = height * 0.24, edge = height / 2;
				for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
					const edgeMix = Math.max(0, Math.min(1, (Math.abs(x - width / 2) / (width * 0.48) - 0.72) / 0.28));
					const weight = 1 - edgeMix * edgeMix * (3 - 2 * edgeMix);
					const closure = blink * weight;
					const compressed = half * (1 - closure * 0.975);
					const center = edge + half * 0.42 * closure;
					const top = center - compressed, bottom = center + compressed;
					const sourceY = y < top ? y * (edge - half) / top : y > bottom ?
						edge + half + (y - bottom) * (height - edge - half) / (height - bottom) :
						edge - half + (y - top) * half / compressed;
					const sy = Math.max(0, Math.min(height - 1.001, sourceY));
					const source = (Math.floor(sy) * width + x) * 4, mix = sy % 1;
					const dest = (y * width + x) * 4;
					for (let c = 0; c < 3; c++) out.data[dest + c] = pixels.data[source + c] * (1 - mix) + pixels.data[source + width * 4 + c] * mix;
					out.data[dest + 3] = pixels.data[source + 3] * Math.min(1, x / 4, (width - 1 - x) / 4, y / 3, (height - 1 - y) / 3);
				}
				layer.putImageData(out, 0, 0);
				context.save(); context.translate(eye.x * image.naturalWidth, eye.y * image.naturalHeight);
				context.rotate(eye.tilt); context.drawImage(patch, -width / 2, -height / 2); context.restore();
			}
		};
	}

	function preparePrototypeHead(image, silhouette, mouth) {
		const width = image.naturalWidth;
		const height = image.naturalHeight;
		const neck = height * (mouth.y + 0.105);
		const fade = height * 0.08;
		const bottom = Math.min(height, Math.ceil(neck + fade));
		if (neck >= bottom) return null;
		const figure = document.createElement("canvas");
		const underlay = document.createElement("canvas");
		figure.width = underlay.width = width;
		figure.height = underlay.height = bottom;
		const color = figure.getContext("2d");
		const plate = underlay.getContext("2d");
		if (!color || !plate) return null;
		color.drawImage(image, 0, 0);
		plate.drawImage(silhouette, 0, 0);
		const pixels = color.getImageData(0, 0, width, bottom);
		const outline = plate.getImageData(0, 0, width, bottom).data;
		const fill = plate.createImageData(width, bottom);

		// Extend the nearby room beneath the original outline. Only the thin band
		// that a small head turn can reveal needs its background reconstructed.
		const count = width * bottom;
		const reach = Math.ceil(width * 0.024);
		const unvisited = 65_535;
		const distance = new Uint16Array(count).fill(unvisited);
		const nearest = new Int32Array(count);
		const queue = new Int32Array(count);
		let tail = 0;
		for (let p = 0; p < count; p++) {
			if (outline[p * 4 + 3] > 8) continue;
			distance[p] = 0;
			nearest[p] = p;
			queue[tail++] = p;
		}
		const visit = (next, from) => {
			if (distance[next] !== unvisited) return;
			distance[next] = distance[from] + 1;
			nearest[next] = nearest[from];
			queue[tail++] = next;
		};
		for (let cursor = 0; cursor < tail; cursor++) {
			const p = queue[cursor];
			if (distance[p] >= reach) break;
			const x = p % width;
			if (x > 0) visit(p - 1, p);
			if (x < width - 1) visit(p + 1, p);
			if (p >= width) visit(p - width, p);
			if (p + width < count) visit(p + width, p);
		}
		for (let y = 0; y < bottom; y++) {
			const blend = Math.max(0, Math.min(1, (neck + fade - y) / fade));
			const weight = blend * blend * (3 - 2 * blend);
			for (let x = 0; x < width; x++) {
				const p = y * width + x;
				const offset = p * 4;
				const alpha = outline[offset + 3];
				pixels.data[offset + 3] = alpha > 8 ? Math.round(alpha * weight) : 0;
				if (distance[p] === 0 || distance[p] > reach) continue;
				const original = nearest[p] * 4;
				for (let ch = 0; ch < 3; ch++) fill.data[offset + ch] = pixels.data[original + ch];
				fill.data[offset + 3] = Math.round(255 * weight * Math.min(1, alpha / 160));
			}
		}
		color.putImageData(pixels, 0, 0);
		plate.putImageData(fill, 0, 0);
		return { figure, underlay, x: mouth.x * width, y: neck };
	}

	function prepareBodySleeves(image, profileId) {
		// Areas drawn from each portrait. Keep held props, the mixing bowl and
		// the surfboard outside the localized arm gesture.
		const regions = {
			xiaxia: [[.15, .84, .22, .24, "left"], [.87, .83, .22, .23, "right"]],
			lubai: [[.76, .70, .21, .16, "right"]],
			guyu: [[.13, .61, .15, .14, "left"], [.80, .69, .18, .20, "right"]],
			beila: [[.40, .55, .14, .12, "left"], [.82, .46, .17, .13, "right"]],
		};
		const width = image.naturalWidth, height = image.naturalHeight;
		return (regions[profileId] || []).map(([cx, cy, rx, ry, side]) => {
			const x = Math.floor((cx - rx) * width), y = Math.floor((cy - ry) * height);
			const patch = document.createElement("canvas");
			const feather = document.createElement("canvas");
			patch.width = feather.width = Math.ceil(rx * width * 2);
			patch.height = feather.height = Math.ceil(ry * height * 2);
			const buffer = patch.getContext("2d");
			const stencil = feather.getContext("2d");
			stencil.scale(patch.width, patch.height);
			const fade = stencil.createRadialGradient(.5, .5, .07, .5, .5, .5);
			fade.addColorStop(0, "black");
			fade.addColorStop(.45, "#000a");
			fade.addColorStop(1, "transparent");
			stencil.fillStyle = fade;
			stencil.fillRect(0, 0, 1, 1);
			return { x, y, side, patch, feather, buffer };
		});
	}

	function useIdleScene(src, enabled, onFrame, fullStage = false) {
		const videoRef = useRef(null);
		const [allowed, setAllowed] = useState(() => !document.hidden && (fullStage || !window.matchMedia("(prefers-reduced-motion: reduce)").matches));
		const [playing, setPlaying] = useState(null);
		const [failed, setFailed] = useState(null);
		const canPlay = !!src && src !== failed && enabled && allowed;
		// Both surfaces switch in the same render, once this source is playing.
		const active = canPlay && playing === src;

		useEffect(() => {
			const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
			const update = () => setAllowed(!document.hidden && (fullStage || !reduced.matches));
			update();
			document.addEventListener("visibilitychange", update);
			reduced.addEventListener("change", update);
			return () => {
				document.removeEventListener("visibilitychange", update);
				reduced.removeEventListener("change", update);
			};
		}, [fullStage]);
		useLayoutEffect(() => {
			setPlaying(null);
			const video = videoRef.current;
			if (!canPlay || !video) return;
			let cancelled = false;
			video.play().catch(() => { if (!cancelled) setPlaying(null); });
			return () => { cancelled = true; video.pause(); };
		}, [src, canPlay]);

		useEffect(() => {
			const video = videoRef.current;
			if (!active || !video || !onFrame) return;
			if (video.requestVideoFrameCallback) {
				let frame;
				const report = () => { onFrame(); frame = video.requestVideoFrameCallback(report); };
				frame = video.requestVideoFrameCallback(report);
				return () => video.cancelVideoFrameCallback(frame);
			}
			let frame;
			let lastTime = -1;
			const report = () => {
				if (lastTime !== video.currentTime) { lastTime = video.currentTime; onFrame(); }
				frame = requestAnimationFrame(report);
			};
			frame = requestAnimationFrame(report);
			return () => cancelAnimationFrame(frame);
		}, [src, active, onFrame]);

		return { active, props: src && src !== failed ? {
			key: src, ref: videoRef, src, muted: true, playsInline: true, loop: true, preload: "metadata", "aria-hidden": !active,
			className: "dfy-idle-scene" + (active ? " dfy-idle-scene-on" : ""),
			onPlaying: (event) => { if (canPlay && !event.currentTarget.paused) setPlaying(src); },
			onWaiting: () => setPlaying(null),
			onPause: (event) => { if (event.currentTarget.paused) setPlaying(null); },
			onError: () => { setPlaying(null); setFailed(src); },
		} : null };
	}

	function RolePrototype({ persona, speaking, listening, emotion, mouthLevel, viseme, dialogue, safe, visible = true, idleAllowed = true, onError, onFrame, onMotionReady }) {
		const target = useRef(null);
		const [rig, setRig] = useState(null);
		const [idle, setIdle] = useState(null);
		const idleScene = useIdleScene(rig && idle, visible && idleAllowed && !speaking && !listening && !safe, onFrame);
		const speechRef = useRef({});
		speechRef.current = { speaking, listening, emotion, mouthLevel, viseme, dialogue, safe, visible: visible && !idleScene.active };
		const motion = useRef(null);
		motion.current ??= createAvatarMotion();
		const id = persona.media?.modelId;
		const dsh = id === "dsh-pet";
		useEffect(() => {
			const controller = new AbortController();
			let url;
			(async () => {
				try {
					const response = await fetch("/api/dafeiyu/avatar/prototype?id=" + encodeURIComponent(id),
						{ signal: controller.signal });
					if (!response.ok) throw new Error("角色素材无法加载");
					const data = await response.json();
					const image = new Image();
					image.src = "data:image/png;base64," + data.image;
					await image.decode();
					const decodeMask = async (base64) => {
						if (!base64) return null;
						const candidate = new Image();
						candidate.src = "data:image/png;base64," + base64;
						await candidate.decode().catch(() => {});
						return candidate.naturalWidth === image.naturalWidth && candidate.naturalHeight === image.naturalHeight ? candidate : null;
					};
					const [mask, silhouette] = await Promise.all([decodeMask(data.motionMask), decodeMask(data.headMask)]);
					if (controller.signal.aborted) return;
					const head = mask && silhouette ? preparePrototypeHead(image, silhouette, data.mouth) : null;
					const faceStack = data.faceRig ? await ensureLive2DStack().catch(() => null) : null;
					if (controller.signal.aborted) return;
					setRig({ image, mouth: data.mouth, eyes: data.eyes || [], mask, head, faceRig: faceStack ? data.faceRig : null, PIXI: faceStack?.PIXI });
					onMotionReady?.(id, dsh || !!mask);
				} catch (error) {
					if (!controller.signal.aborted) { console.warn("形象加载失败", error.message); onError?.(); }
				}
			})();
			if (dsh) {
				fetch("/api/dafeiyu/avatar/dsh-idle", { signal: controller.signal })
					.then((response) => response.ok ? response.blob() : null).then((blob) => {
						if (blob && !controller.signal.aborted) {
							url = URL.createObjectURL(blob);
							setIdle(url);
						}
					}).catch(() => {});
			}
			return () => { controller.abort(); if (url) URL.revokeObjectURL(url); };
		}, [id, dsh, onMotionReady]);

		useEffect(() => {
			const surface = target.current;
			if (!rig || !surface) return;
			const { image, mouth, eyes, mask, head } = rig;
			const width = surface.width = image.naturalWidth;
			const height = surface.height = image.naturalHeight;
			const context = surface.getContext("2d");
			if (!context) return;
			let face;
			try { face = rig.faceRig ? createFaceRigRenderer(rig.PIXI, rig.faceRig, image) : null; }
			catch (error) {
				console.warn("完整面部渲染器不可用，继续使用原型口型", error.message);
				surface.dataset.faceRig = "prototype";
			}
			const drawMouth = face ? () => {} : paintMouth(context, image, mouth, dsh);
			const drawEyes = face ? () => {} : paintEyes(context, image, eyes);
			const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
			const dialogueBlend = createDialogueBlend();
			const bodyMotion = createBodyMotion();
			let frame;
			let lastPose = 0;
			const centerX = mouth.x * width;
			const shoulderY = height * Math.min(1, mouth.y + 0.11);
			const pivot = height * ({ beila: .71, guyu: .82, lubai: .86 }[persona.profileId] ?? .95);
			const torsoFade = mask ? context.createLinearGradient(0, 0, 0, height) : null;
			torsoFade?.addColorStop(Math.min(.84, shoulderY / height - .018), "transparent");
			torsoFade?.addColorStop(Math.min(.93, shoulderY / height + .075), "black");
			torsoFade?.addColorStop(Math.min(.97, pivot / height + .01), "black");
			torsoFade?.addColorStop(Math.min(1, pivot / height + .09), "transparent");
			const sleeves = mask ? prepareBodySleeves(image, persona.profileId) : [];
			const draw = (amount, breath = 0, sway = 0, nod = 0, blink = 0, form = 0, expression = 0, gaze = 0,
				blinkL = blink, blinkR = blink, browDip = 0, body = { lean: 0, lift: 0, left: 0, right: 0 }) => {
				face?.update({ ...faceMouthControls(amount, form), smile: expression,
					blinkLeft: blinkL, blinkRight: blinkR,
					browLeft: expression * .6 + browDip, browRight: expression * .5 + browDip,
					gazeX: gaze, gazeY: -nod });
				context.clearRect(0, 0, width, height);
				const skew = mask ? -.046 * body.lean : 0;
				const roll = mask ? .012 * (body.right - body.left) : 0;
				const stretch = mask ? 1 + breath * .013 + body.lift * .038 : 1;
				const dx = -skew * pivot, dy = -roll * centerX - (stretch - 1) * pivot;
				if (!mask) {
					context.drawImage(image, 0, 0);
				} else if (breath > 0 || body.lift > 0 || body.lean !== 0) {
					context.save();
					context.transform(1, roll, skew, stretch, dx, dy);
					context.drawImage(image, 0, 0);
					context.restore();
					for (const { x, y, side, patch, feather, buffer } of sleeves) {
						const amount = body[side];
						if (amount < .018) continue;
						const inward = (side === "left" ? 1 : -1) * width * .017 * amount;
						const rise = height * .021 * amount;
						buffer.resetTransform();
						buffer.clearRect(0, 0, patch.width, patch.height);
						buffer.save();
						buffer.setTransform(1, roll, skew, stretch, dx - x + inward, dy - y - rise);
						buffer.drawImage(image, 0, 0);
						buffer.restore();
						buffer.save();
						buffer.globalCompositeOperation = "destination-in";
						buffer.drawImage(feather, 0, 0);
						buffer.restore();
						context.drawImage(patch, x, y);
					}
					context.save();
					context.globalCompositeOperation = "destination-in";
					context.fillStyle = torsoFade;
					context.fillRect(0, 0, width, height);
					context.restore();
				}
				if (!head) { face?.draw(context); if (amount > 0) drawMouth(amount, form); drawEyes(blink); }
				if (mask) {
					// The room stays on the original layer. Clip the moving copy at the original silhouette.
					context.save();
					context.globalCompositeOperation = "destination-in";
					context.drawImage(mask, 0, 0);
					context.restore();
				}
				if (head) {
					context.drawImage(head.underlay, 0, 0);
					context.save();
					const shoulderX = skew * (head.y - pivot);
					const shoulderY = (stretch - 1) * (head.y - pivot);
					context.translate(head.x + shoulderX + sway * width * 0.002,
						head.y + shoulderY + nod * height * 0.006);
					context.rotate(sway * 0.011 + roll * .35);
					context.translate(-head.x, -head.y);
					context.drawImage(head.figure, 0, 0);
					face?.draw(context, head.figure);
					if (amount > 0) drawMouth(amount, form);
					drawEyes(blink);
					context.restore();
				}
			};
			draw(0);
			const tick = (now) => {
				frame = requestAnimationFrame(tick);
				const speech = speechRef.current;
				if (!speech.visible || context.isContextLost?.() || now - lastPose < 16) return;
				const sample = speech.mouthLevel?.sample?.() || { level: speech.mouthLevel?.() || 0 };
				const pose = motion.current(now, { ...speech, ...sample, reducedMotion: reduced.matches,
					viseme: speech.viseme?.sample?.() ?? speech.viseme });
				// 对话动作叠加：弹幕视线/思考侧头/收尾点头（安全与减少动态时 blend 自身归零）
				const add = dialogueBlend(now, speech.dialogue?.current,
					{ safe: !!speech.safe, reducedMotion: reduced.matches, speaking: !!speech.speaking });
				const body = bodyMotion(now, pose, add, reduced.matches);
				draw(pose.opening, pose.breath, pose.sway + add.swing * 0.35, pose.nod + add.nod * 0.7,
					Math.max(pose.blink, Math.max(0, pose.expression) * 0.25), pose.form + pose.expression * 0.4,
					pose.expression + add.brow * 0.25, pose.gaze + add.gaze * 0.6,
					pose.blinkLeft, pose.blinkRight, pose.browDip, body);
				if (!mask && dsh && !reduced.matches) {
					surface.style.transform = `translate(${pose.sway}%, ${-pose.breath * 0.55 + pose.nod * 0.6}%) rotate(${pose.sway}deg)`;
				} else surface.style.transform = "";
				lastPose = now;
				onFrame?.();
			};
			frame = requestAnimationFrame(tick);
			return () => { cancelAnimationFrame(frame); face?.destroy(); };
		}, [rig, dsh, onFrame, persona.profileId]);

		if (!rig) return h("span", { className: "dfy-role-initial" }, persona.name);
		return h(react.Fragment, null,
			rig.mask ? h("img", { src: rig.image.src, className: "dfy-rig-surface", hidden: idleScene.active, alt: "", "aria-hidden": true }) : null,
			h("canvas", { ref: target, className: "dfy-rig-surface", hidden: idleScene.active, "data-face-rig": rig.faceRig ? "full" : "prototype", "data-face-role": persona.profileId || persona.id, role: "img", "aria-label": persona.name + (rig.faceRig ? "完整面部预览" : "口型预览") }),
			idleScene.props ? h("video", { ...idleScene.props, className: idleScene.props.className + " dfy-rig-surface", "aria-label": persona.name + "待机动画" }) : null);
	}

	function SpeechMeter({ level }) {
		const bar = useRef(null);
		useEffect(() => {
			let frame;
			const tick = () => {
				const el = bar.current;
				if (!el) return;
				el.style.transform = "scaleX(" + Math.max(0.05, level?.() || 0) + ")";
				frame = requestAnimationFrame(tick);
			};
			tick();
			return () => cancelAnimationFrame(frame);
		}, [level]);
		return h("span", { className: "dfy-speech-meter", "aria-hidden": true }, h("i", { ref: bar }));
	}

	function SpeechCaption({ line, progress, className = "" }) {
		const viewport = useRef(null);
		useLayoutEffect(() => {
			const element = viewport.current;
			const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
			let reached = 0, frame, height, limit, lineHeight, offset = 0, last = performance.now();
			element.scrollTop = 0;
			const scroll = (now) => {
				frame = undefined;
				reached = Math.max(reached, Math.min(1, progress?.() || 0));
				const position = reached * (height + limit) - height * .55;
				const target = reached >= .97 ? limit : Math.max(0, Math.min(limit, Math.floor(position / lineHeight) * lineHeight));
				offset += (target - offset) * (1 - Math.exp(-Math.max(0, now - last) / 48));
				last = now;
				const moving = !reduced.matches && Math.abs(target - offset) > .5;
				if (!moving) offset = target;
				element.scrollTop = offset;
				if (reached < .97 || moving) frame = requestAnimationFrame(scroll);
			};
			const measure = () => {
				height = element.clientHeight;
				limit = element.scrollHeight - height;
				lineHeight = parseFloat(getComputedStyle(element).lineHeight);
				cancelAnimationFrame(frame);
				if (limit > 0 && lineHeight > 0) scroll(performance.now());
			};
			const observer = new ResizeObserver(measure);
			observer.observe(element);
			observer.observe(element.firstElementChild);
			measure();
			return () => { observer.disconnect(); cancelAnimationFrame(frame); };
		}, [line, progress]);
		return h("div", { className: "dfy-speech-caption " + className, role: "status" },
			h("div", { ref: viewport, className: "dfy-caption-scroll" }, h("p", null, line)));
	}

	let riggedRuntime;

	function loadRiggedRuntime(id) {
		if (riggedRuntime) return riggedRuntime;
		riggedRuntime = new Promise((resolve, reject) => {
			const script = document.createElement("script");
			script.src = "/api/dafeiyu/avatar/rigged?id=" + encodeURIComponent(id) + "&asset=runtime";
			script.onload = () => {
				script.remove();
				if (window.__DafeiyuRiggedAvatar) resolve(window.__DafeiyuRiggedAvatar);
				else reject(new Error("三维渲染器未就绪"));
			};
			script.onerror = () => { script.remove(); reject(new Error("三维渲染器无法加载")); };
			document.head.appendChild(script);
		}).catch((error) => { riggedRuntime = null; throw error; });
		return riggedRuntime;
	}

	function RiggedRole({ persona, speaking, listening, emotion, mouthLevel, safe, onFrame }) {
		const host = useRef(null);
		const [status, setStatus] = useState("loading");
		const [posterFailed, setPosterFailed] = useState(false);
		const input = useRef(null);
		input.current = { speaking, listening, emotion, mouthLevel, safe, onFrame };
		const id = persona.media.modelId;
		useEffect(() => {
			const controller = new AbortController();
			const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
			const face = createAvatarMotion();
			let stage, frame, previous = 0;
			const fail = () => {
				cancelAnimationFrame(frame);
				stage?.dispose();
				stage = null;
				if (!controller.signal.aborted) setStatus("failed");
			};
			void (async () => {
				try {
					const runtime = await loadRiggedRuntime(id);
					controller.signal.throwIfAborted();
					stage = await runtime.mount(host.current,
						"/api/dafeiyu/avatar/rigged?id=" + encodeURIComponent(id) + "&asset=model", controller.signal, fail);
					if (controller.signal.aborted) { stage.dispose(); stage = null; return; }
					const draw = (now) => {
						try {
							if (now - previous >= 15) {
								const state = input.current;
								const sample = state.mouthLevel?.sample?.() || { level: state.mouthLevel?.() || 0 };
								const pose = face(now, { ...state, ...sample, reducedMotion: reduced.matches });
								stage.render({ pose });
								state.onFrame?.();
								previous = now;
							}
							frame = requestAnimationFrame(draw);
						} catch (error) { console.warn("三维角色渲染失败", error.message); fail(); }
					};
					draw(performance.now());
					if (stage) setStatus("ready");
				} catch (error) {
					if (!controller.signal.aborted) { console.warn("三维角色加载失败", error.message); fail(); }
				}
			})();
			return () => { controller.abort(); cancelAnimationFrame(frame); stage?.dispose(); };
		}, [id]);
		return h("div", { className: "dfy-rigged-avatar", ref: host, role: "img", "aria-label": persona.name + "原图姿势与动态口型",
			"data-rigged-role": id, "data-rigged-status": status },
			!posterFailed ? h("img", { className: "dfy-rigged-poster", src: persona.media.portraitUrl, alt: "", hidden: status === "ready",
				onError: () => setPosterFailed(true) }) : status !== "ready" ? h("span", { className: "dfy-role-initial" }, persona.name) : null);
	}

	function EciyuanPreview({ persona, entry, sceneUrl, prototype, rigged, fallback, speaking, listening, subtitle, captionProgress, mouthLevel, message }) {
		const [failure, setFailure] = useState("");
		const [portraitUnavailable, setPortraitUnavailable] = useState(false);
		const [mouthReady, setMouthReady] = useState(null);
		const [prototypeFailed, setPrototypeFailed] = useState(false);
		const model = !rigged && entry && !failure && (mouthReady !== false || !prototype || prototypeFailed);
		const rig = !rigged && !model && prototype && !prototypeFailed;
		const attending = (listening || !!message) && !speaking;
		const emotion = speaking ? avatarReplyEmotion(subtitle) : 0;
		const { dialogue, engaged } = useDialoguePresentation({ speaking, listening: attending, profileId: persona.profileId, allowTail: false });
		const scene = useIdleScene(!rigged && !model && !rig && sceneUrl, !speaking && !engaged);
		return h("div", { className: "dfy-role-preview" },
			h("div", { className: "dfy-role-stage", style: { background: persona.theme?.bg, color: persona.theme?.accent } },
				h("span", { className: "dfy-pet-ai" }, persona.aiLabelText || "AI 生成内容"),
				h("div", { className: "dfy-role-art", hidden: scene.active },
					rigged ? h(RiggedRole, { persona, speaking, listening: attending, emotion, mouthLevel }) :
					model ? h(Live2DScene, { entry, speaking, listening: attending, emotion, mouthLevel, dialogue, onFail: setFailure, onLipSync: setMouthReady }) :
					rig ? h(RolePrototype, { key: persona.profileId, persona, speaking, listening: attending, emotion, mouthLevel, dialogue, visible: !scene.active, idleAllowed: !engaged, onError: () => setPrototypeFailed(true) }) :
						portraitUnavailable || !persona.media.portraitUrl ? h("span", { className: "dfy-role-initial" }, persona.name) :
							h("img", { src: persona.media.portraitUrl, alt: persona.name + "的官方立绘", onError: () => setPortraitUnavailable(true) })),
				scene.props ? h("video", { ...scene.props, "aria-label": persona.name + "的待机动画" }) : null,
				speaking && !rigged && !model && !rig ? h("span", { className: "dfy-stage-voice" }, "正在说话", h(SpeechMeter, { level: mouthLevel })) : null,
				h(StageMessage, { message })),
			h("div", { className: "dfy-role-caption" },
				subtitle && speaking ? h(SpeechCaption, { line: subtitle, progress: captionProgress }) : null,
				h("p", { className: "dfy-caption" },
					rigged ? "原图姿势 · 动态口型" : model ? "Live2D · " + entry.name + (mouthReady === false ? " · 缺少可用口型参数" : "") :
					scene.active ? "待机动画" : rig ? (persona.source === "plugin" ? "DSH 原版动画 · 音频口型" : "原片口型原型") : (portraitUnavailable ? "官方立绘暂不可用" : "鹅次元官方立绘") +
						(failure ? " · 本地模型加载失败" : fallback ? " · " + fallback : ""))));
	}

	function StageMessage({ message }) {
		return message ? h("p", { className: "dfy-stage-message" }, message.author + " · " + message.text) : null;
	}

	function PreviewCanvas({ preview, compact, entry, sceneUrl, prototype, rigged, fallback, speaking, listening, subtitle, captionProgress, mouthLevel, message }) {
		const persona = preview?.persona;
		if (!persona?.media) return null;
		const onStage = preview.scene?.danmakuOverlay !== false ? message : null;
		return h(EciyuanPreview, { key: persona.profileId + ":" + (entry?.id || "") + ":" + (sceneUrl || ""),
			persona, entry, sceneUrl, prototype, rigged, fallback, speaking, listening, subtitle, captionProgress, mouthLevel, message: onStage });
	}

	function WorkbenchControls({ status, act, busy, goTab, officialUrl, connected }) {
		const live = status?.liveStatus === "live_confirmed";
		const awaiting = ["awaiting_platform", "stream_established"].includes(status?.liveStatus);
		const missing = !status || live || awaiting ? null :
			!status.personaReady ? ["persona", "配置角色", status.personaReadyReason] :
			!status.platformReady ? ["platform", "配置直播接入", status.platformReadyReason] : null;
		const disabled = busy || !connected || !status;
		const primary = live ? "确认已下播" : awaiting ? "我已在直播伴侣开播" : missing ? missing[1] : "开始直播";
		const runPrimary = () => {
			if (missing) return goTab(missing[0]);
			return act(live ? "live/stop" : awaiting ? "live/operator-confirm" : "live/start", {}, primary);
		};
		return h("section", { className: "dfy-command", "aria-label": "直播操作和当日概况" },
			h("div", { className: "dfy-command-actions" },
				h(Btn, { tone: "primary", disabled, onClick: runPrimary }, primary),
				awaiting ? h(Btn, { disabled, onClick: () => act("live/stop", {}, "取消开播") }, "取消开播") : null,
				missing ? h("p", null, missing[2]) : awaiting || live ? h("p", null,
					"请先在",
					officialUrl ? h("a", { className: "dfy-link", href: officialUrl, target: "_blank", rel: "noreferrer" }, "直播伴侣") : "直播伴侣",
					awaiting ? "开播，再回来确认。" : "结束推流，再回来确认。") : null),
			status ? h("dl", { className: "dfy-command-metrics" },
				h("div", null, h("dt", null, "待处理反馈"), h("dd", null, h("button", { type: "button", className: "dfy-desk-text-button",
					"aria-label": "待处理反馈 " + status.pendingIssues + " 条", onClick: () => goTab("feedback") }, status.pendingIssues + " 条"))),
				h("div", null, h("dt", null, "今日费用"), h("dd", null, "¥" + status.todayCostCny.toFixed(2)))) : null);
	}

	// ------------------------------------------------------------------ 设置

	function SelfcheckStep({ report, run, busy }) {
		return h("div", { style: { display: "grid", gap: 10 } },
			h("p", { className: "dfy-muted", style: { margin: 0 } }, "检查运行环境、配置、数据目录和本地推理。"),
			h("div", { className: "dfy-actions" }, h(Btn, { tone: "primary", disabled: busy, onClick: run }, busy ? "自检运行中…" : report ? "重新运行自检" : "运行自检")),
			report ? h("div", { className: "dfy-list" },
				report.items.map((it) => h("div", { key: it.id, className: "dfy-item" },
					h("div", { className: "dfy-item-h" },
						h(Badge, { tone: it.ok ? "ok" : "err", text: it.ok ? "通过" : "缺失" }),
						h("span", { className: "dfy-item-t" }, it.label),
						h("span", { className: "dfy-caption", style: { marginLeft: "auto" } }, it.detail)),
					it.fixAction ? h("span", { className: "dfy-caption" }, "修复：" + it.fixAction) : null)),
				h("p", { className: "dfy-caption", style: { margin: 0 } },
					"本地模式" + (report.canRunLocalMode ? "可用" : "不可用（须先修复必过项）") + "；在线训练验收" + (report.canAcceptOnlineTraining ? "条件满足" : "需目标机"))) : null);
	}

	function PlatformStep({ settings, save }) {
		const p = settings.platform;
		const [mode, setMode] = useState(p.operationMode);
		const [category, setCategory] = useState(p.contentCategory);
		const [roomUrl, setRoomUrl] = useState(p.roomUrl || "");
		const [source, setSource] = useState(p.interactionSource || "browser");
		return h("div", { style: { display: "grid", gap: 12 } },
			h("p", { className: "dfy-muted", style: { margin: 0 } },
				"在", h("a", { className: "dfy-link", href: p.officialClientUrl, target: "_blank", rel: "noreferrer" }, "抖音直播伴侣"),
				"完成登录、实名与人脸认证，然后在这里确认登录。"),
			h("div", { className: "dfy-form-grid" },
				h(Field, { label: "运行模式" },
					h("select", { className: "dfy-select", value: mode, onChange: (e) => setMode(e.target.value) },
						h("option", { value: "assisted" }, "辅助直播（AI 辅助，真人控制播出）"),
						h("option", { value: "human_driven" }, "真人驱动（AI 仅建议，不代播）"))),
				h(Field, { label: "内容类别（选填）" },
					h("input", { className: "dfy-input", value: category, placeholder: "如：游戏/休闲聊天", onChange: (e) => setCategory(e.target.value) })),
				h(Field, { label: "互动来源" },
					h("select", { className: "dfy-select", value: source, onChange: (e) => setSource(e.target.value) },
						h("option", { value: "browser" }, "后台读取抖音直播间"),
						h("option", { value: "relay" }, "已配置的互动转发源"))),
				source === "browser" ? h(Field, { label: "抖音直播间链接" },
					h("input", { className: "dfy-input", type: "url", value: roomUrl,
						placeholder: "https://live.douyin.com/…", onChange: (e) => setRoomUrl(e.target.value) })) : null),
			h("div", { className: "dfy-actions" },
				h(Btn, { tone: "primary", onClick: () => save("platform", { operationMode: mode, contentCategory: category, roomUrl, interactionSource: source }) }, "保存"),
				h(Btn, { onClick: () => save("platform", { operatorLoginConfirmedAt: new Date().toISOString() }) },
					p.operatorLoginConfirmedAt ? "已声明登录（" + p.operatorLoginConfirmedAt.slice(0, 16).replace("T", " ") + "）· 点击更新" : "我已在官方客户端登录直播账号")));
	}

	function PersonaStep({ settings, save, catalog, reloadCatalog }) {
		const p = settings.persona;
		const profiles = (settings.catalogs && settings.catalogs.profiles) || [];
		const [profileId, setProfileId] = useState(p.profileId || (settings.profile && settings.profile.id) || "dsh-pet");
		const [appearance, setAppearance] = useState(p.appearance || "standard");
		const [voice, setVoice] = useState(p.voiceId);
		const [phrase, setPhrase] = useState(p.samplePhrase);
		const [right, setRight] = useState(p.usageRightConfirmed);
		const [listenNote, setListenNote] = useState("");
		const audition = useRoleSpeech(profileId);

		const selected = profiles.find((x) => x.id === profileId) || settings.profile || null;
		const payload = () => ({ profileId, appearance: profileId === "xiaxia" ? appearance : "standard", personaName: selected ? selected.name : p.personaName, voiceId: voice, samplePhrase: phrase, usageRightConfirmed: right });

		const listen = () => {
			if (audition.phase !== "idle") { audition.stop(); return; }
			const draft = phrase.trim();
			if (!draft) { setListenNote("请输入试听语句"); return; }
			if (selected?.media && (profileId !== p.profileId || !p.usageRightConfirmed)) {
				setListenNote("保存角色与使用授权后即可试听");
				return;
			}
			setListenNote("");
			audition.speak(draft, voice);
		};

		const modelId = selected?.media?.modelId;
		const model = catalog?.models.find((item) => item.id === modelId);
		const modelStatus = profileId === "xiaxia" && appearance === "rigged" ? "三维骨骼形象" : !catalog ? "模型状态暂不可用" :
			model?.lipSyncDeclared ? "Live2D 口型已配置" : catalog.prototypes?.includes(modelId) ? "音频驱动口型" :
			model ? "Live2D 已安装" : "使用角色立绘";

		return h("div", { className: "dfy-settings-stack" },
			h("div", { className: "dfy-form-grid" },
				h(Field, { label: "选择角色" },
					h("select", { className: "dfy-select", value: profileId, onChange: (e) => setProfileId(e.target.value) },
						profiles.map((role) => h("option", { key: role.id, value: role.id }, role.name)))),
				profileId === "xiaxia" ? h(Field, { label: "默认形象" },
					h("select", { className: "dfy-select", "aria-label": "默认形象", value: appearance, onChange: (e) => setAppearance(e.target.value) },
						h("option", { value: "standard" }, "原画形象"), h("option", { value: "rigged" }, "三维骨骼"))) : null),
			selected ? h(ProfileInfo, { profile: selected, modelStatus }) : null,
			h("div", { className: "dfy-actions" }, h(Btn, { onClick: reloadCatalog }, "刷新模型")),
			selected?.media ? null : h(Field, { label: "预览朗读风格" },
				h("select", { className: "dfy-select", value: voice, onChange: (e) => setVoice(e.target.value) },
					settings.catalogs.voices.map((v) => h("option", { key: v.id, value: v.id }, v.label)))),
			h("div", { className: "dfy-field-action" },
				h(Field, { label: "试听语句" },
					h("input", { className: "dfy-input", value: phrase, maxLength: 80, onChange: (e) => setPhrase(e.target.value) })),
				h(Btn, { onClick: listen }, audition.phase === "idle" ? "试听" : "停止试听")),
			h("span", { className: "dfy-caption", role: "status" }, listenNote || audition.note),
			h("label", { className: "dfy-check" },
				h("input", { type: "checkbox", checked: right, onChange: (e) => setRight(e.target.checked) }),
				h("span", null, "我确认对所选角色形象与声音具有播出使用授权")),
			h("p", { className: "dfy-caption", style: { margin: 0 } }, "播出画面固定显示「" + p.aiLabelText + "」标识。"),
			h("div", { className: "dfy-actions" },
				h(Btn, { tone: "primary", onClick: () => save("persona", payload()) }, "保存角色设置")));
	}

	/** 取日志中最后一个百分比（下载/导入进度条数据源；无百分比返回 null）。 */
	const lastPercent = (log) => {
		if (!Array.isArray(log)) return null;
		for (let i = log.length - 1; i >= 0; i--) {
			const m = String(log[i] || "").match(/(\d{1,3})\s*%/);
			if (m) return Math.max(0, Math.min(100, Number(m[1])));
		}
		return null;
	};

	/**
	 * 一键部署本地模型（0.15）：POST/GET /api/dafeiyu/model/deploy 轮询部署状态，
	 * 展示 Ollama 安装/模型下载（ModelScope 直连）/导入/验证的进程输出与进度条；
	 * GET 附带 install 探测（服务/模型是否就绪）用于「未安装提示」；running 期间 2s 轮询。
	 */
	function LocalModelDeployCard() {
		const [deploy, setDeploy] = useState(null);
		const [err, setErr] = useState("");
		const latest = useRef(null);
		latest.current = deploy;
		useEffect(() => {
			let stopped = false;
			let timer;
			const poll = async () => {
				try {
				const r = await api("model/deploy");
				if (stopped) return;
				// 状态接口异常必须显式报错（旧后端对未知路径回 ok:false），不允许静默停在「检查部署状态…」
				if (r && r.ok && r.deploy) { setDeploy(r.deploy); setErr(""); }
				else setErr((r && r.error) ? String(r.error) : "部署状态接口无响应");
				} catch (e) {
					if (!stopped) setErr("部署状态获取失败：" + (e && e.message ? e.message : "网络错误"));
				}
				if (!stopped) timer = setTimeout(poll, latest.current && latest.current.status === "running" ? 2000 : 8000);
			};
			poll();
			return () => { stopped = true; clearTimeout(timer); };
		}, []);
		const start = async () => {
			setErr("");
			try {
				const r = await api("model/deploy", {});
				if (r && r.ok && r.deploy) { setDeploy(r.deploy); setErr(""); }
				else setErr((r && r.error) ? String(r.error) : "启动失败");
			} catch (e) {
				setErr("启动请求失败：" + (e && e.message ? e.message : "网络错误"));
			}
		};
		const d = deploy;
		const running = d && d.status === "running";
		const install = d && d.install;
		const ready = !!(d && (d.status === "ok" || (install && install.ready)));
		const needInstall = !!d && !running && !ready;
		const pct = d && d.log ? lastPercent(d.log) : null;
		const label = !d ? (err ? "重试连接" : "检查部署状态…") : running ? "部署中…" :
			d.status === "failed" ? "重试部署" : needInstall ? "一键安装（ModelScope 直连）" : "重新验证";
		const badge = !d ? null : h(Badge, {
			tone: ready ? "ok" : d.status === "failed" ? "err" : running ? "warn" : "idle",
			dot: running, text: ready ? "已就绪" : d.status === "failed" ? "失败" : running ? "进行中" : "未部署",
		});
		return h(Card, { title: "本地模型", extra: badge },
			h(Row, { label: "Ollama 模型", value: (d && d.model) || "qwen3:4b" }),
			install && !running ? h("div", { style: { display: "flex", gap: 8, flexWrap: "wrap" } },
				h(Badge, { tone: install.reachable ? "ok" : "err", text: "Ollama 服务 " + (install.reachable ? "已运行" : "未安装") }),
				h(Badge, { tone: install.modelInstalled ? "ok" : "err", text: (install.model || "qwen3:4b") + (install.modelInstalled ? " 已就绪" : " 未安装") })) : null,
			needInstall ? h("p", { className: "dfy-caption", style: { margin: 0, color: "var(--dsw-alias-state-warning-primary,#8a6d1f)" } },
				"本地模型未安装。将通过 ModelScope 下载、导入并验证。") : null,
			running && pct !== null ? h("div", { role: "progressbar", "aria-valuenow": pct, "aria-valuemin": 0, "aria-valuemax": 100, "aria-label": "部署进度", style: { height: 8, borderRadius: 999, background: "var(--dsw-alias-bg-layer-2,#e6eceb)", overflow: "hidden" } },
				h("div", { style: { width: pct + "%", height: "100%", background: "var(--dsw-alias-state-business-primary,#0f5e57)", transition: "width .4s ease" } })) : null,
			running ? h("p", { className: "dfy-caption", style: { margin: 0 }, role: "status" }, pct !== null ? "进行中 · " + pct + "%" : "进行中…") : null,
			err ? h("p", { className: "dfy-caption", role: "alert", style: { margin: 0, color: "var(--dsw-alias-state-error-primary,#c0392b)" } },
				"部署状态异常：" + err + (String(err).includes("未知路径")
				? "。当前宿主加载的插件后端未包含该端点：请在 DeepSeek Harness 中重载大肥鱼插件，再刷新本页。"
				: "")) : null,
			h("div", { className: "dfy-actions" },
				h(Btn, { tone: "primary", disabled: running, onClick: start }, label)),
			d?.log?.length ? h("details", { className: "dfy-details", open: running || d.status === "failed" || undefined },
				h("summary", null, "部署日志"), h("pre", {
				tabIndex: 0, "aria-live": running ? "polite" : undefined,
				style: { margin: 0, maxHeight: 132, overflow: "auto", fontSize: 11.5, fontFamily: "ui-monospace,SFMono-Regular,Menlo,monospace", whiteSpace: "pre-wrap", overflowWrap: "anywhere", padding: "8px 10px", borderRadius: 8, background: "var(--dsw-alias-bg-layer-2,#eef3f2)" },
			}, d.log.slice(-14).join("\n"))) : null,
			d && d.status === "failed" && d.error ? h("p", { className: "dfy-caption", style: { margin: 0, color: "var(--dsw-alias-state-error-primary,#c0392b)" } }, d.error) : null);
	}

	function CloudStep({ settings, save, reload, feedback }) {
		const c = settings.cloud;
		const presets = (settings.catalogs && settings.catalogs.cloudProviders) || [];
		const key = settings.cloudKey || { source: "none", masked: null, updatedAt: null };
		const [enabled, setEnabled] = useState(c.enabled);
		const [provider, setProvider] = useState(c.provider);
		const [model, setModel] = useState(c.model);
		const [budget, setBudget] = useState(c.dailyBudgetCny === null ? "" : String(c.dailyBudgetCny));
		const [baseUrl, setBaseUrl] = useState(c.baseUrl || "");
		const [apiKey, setApiKey] = useState("");
		const [keyNote, setKeyNote] = useState("");
		const [test, setTest] = useState(null);
		const [testing, setTesting] = useState(false);
		const [saving, setSaving] = useState(false);
		const [quota, setQuota] = useState(null);
		const [quotaLoading, setQuotaLoading] = useState(false);
		// 额度/可用余额（0.15.2）：按已保存的生效配置查询（DeepSeek 余额 / OpenAI 兼容 billing；不支持则如实标注）
		const loadQuota = useCallback(async () => {
			setQuotaLoading(true);
			try {
				const r = await api("cloud/quota");
				setQuota(r && typeof r.ok === "boolean" ? r : { ok: false, error: "未知错误" });
			} catch (e) { setQuota({ ok: false, error: (e && e.message) || "网络错误" }); }
			setQuotaLoading(false);
		}, []);
		useEffect(() => {
			setQuota(null);
			if (key.source !== "none") loadQuota();
		}, [loadQuota, key.source, key.updatedAt, c.provider, c.model, c.baseUrl, c.enabled]);
		const clearKey = async () => {
			setSaving(true);
			setTest(null);
			setKeyNote("正在清除密钥…");
			try {
				const r = await api("settings/cloud/key", { clear: true });
				setKeyNote(r.ok ? "已清除密钥" : "清除失败 · " + (r.error || "未知错误"));
				if (r.ok) { setApiKey(""); await reload(); }
			} catch { setKeyNote("清除失败 · 网络错误"); }
			finally { setSaving(false); }
		};
		// 连接测试（0.15.1）：按「表单当前值 + 已填密钥」测试，不写入设置；通过后才能保存
		const runTest = async () => {
			setTesting(true);
			setTest(null);
			try {
				const r = await api("settings/cloud/test", {
					provider: provider, model: model,
					...(baseUrl.trim() !== "" ? { baseUrl: baseUrl.trim() } : {}),
					...(apiKey.trim() !== "" ? { apiKey: apiKey.trim() } : {}),
				});
				setTest(r && typeof r.ok === "boolean" ? r : { ok: false, error: (r && r.error) || "未知错误" });
			} catch (e) { setTest({ ok: false, error: (e && e.message) || "网络错误" }); }
			setTesting(false);
		};
		const doSave = async () => {
			setSaving(true);
			setKeyNote("");
			const newKey = apiKey.trim();
			try {
				if (newKey) {
					const kr = await api("settings/cloud/key", { apiKey: newKey });
					if (!kr.ok) throw new Error(kr.error);
					setApiKey("");
				}
				const ok = await save("cloud", { enabled, provider, model, baseUrl: baseUrl.trim(), dailyBudgetCny: budget === "" ? null : Number(budget) });
				if (ok) setTest(null);
				else if (newKey) setKeyNote("API Key 已保存");
			} catch (error) { setKeyNote("密钥保存失败 · " + error.message); }
			finally { setSaving(false); }
		};
		const selPreset = presets.find((p) => p.id === provider) || null;
		// 白屏修复（0.14.1）：预设目录缺 models 字段时不再抛错（React 未捕获异常会卸载整棵树导致白屏）
		const selModels = Array.isArray(selPreset && selPreset.models) ? selPreset.models : [];
		const pickPreset = (p) => {
			setProvider(p.id || "");
			const models = Array.isArray(p.models) ? p.models : [];
			if (!models.includes(model)) setModel(models[0] || "");
			setBaseUrl("");
			setTest(null);
		};
		return h("div", { className: "dfy-model-settings" },
			h(LocalModelDeployCard),
			h(Card, { title: "云端模型" },
				h("fieldset", { className: "dfy-form-fields", "aria-label": "云端模型配置", disabled: testing || saving },
					h("label", { className: "dfy-check" },
						h("input", { type: "checkbox", checked: enabled, onChange: (e) => { setEnabled(e.target.checked); setTest(null); } }),
						h("span", null, "启用云端回复")),
					presets.length > 0 ? h("div", { className: "dfy-choice" },
						presets.map((p) => h("button", {
							key: p.id, type: "button",
							className: "dfy-chip" + (provider === p.id ? " dfy-chip-on" : ""),
							"aria-pressed": provider === p.id, title: p.baseUrl, onClick: () => pickPreset(p),
						}, p.label)),
						h("button", {
							type: "button", className: "dfy-chip" + (selPreset ? "" : " dfy-chip-on"),
							"aria-pressed": !selPreset, onClick: () => pickPreset({ id: "" }),
						}, "自定义")) : null,
					h("div", { className: "dfy-form-grid" },
						h(Field, { label: "服务商" }, h("input", { className: "dfy-input", value: provider, placeholder: selPreset ? selPreset.id : "留空 = 不覆盖配置文件", onChange: (e) => { setProvider(e.target.value); setTest(null); } })),
						h(Field, { label: "模型名" },
							h("div", { style: { display: "grid", gap: 4 } },
								h("input", { className: "dfy-input", list: "dfy-cloud-models", value: model, placeholder: "如 hunyuan-lite", onChange: (e) => { setModel(e.target.value); setTest(null); } }),
								// React 禁止 void 元素（input）携带 children：datalist 必须挂为兄弟节点（点击预设即白屏的根因）
								selModels.length > 0 ? h("datalist", { id: "dfy-cloud-models" }, selModels.map((m) => h("option", { key: m, value: m }))) : null)),
						h(Field, { label: "每日费用上限（元）" }, h("input", { className: "dfy-input", value: budget, placeholder: "未设置 ⇒ 付费禁用", onChange: (e) => { setBudget(e.target.value); setTest(null); } })),
						h(Field, { label: "端点 URL（自定义网关）" }, h("input", { className: "dfy-input", value: baseUrl, placeholder: selPreset ? "留空 = 预设端点" : "如 https://tokenhub.example.com/v1", title: "OpenAI 兼容端点，解析优先级：环境变量 > 此处 > 预设", onChange: (e) => { setBaseUrl(e.target.value); setTest(null); } }))),
					h("div", { className: "dfy-settings-stack" },
						h(Field, { label: "API Key" },
							h("input", { type: "password", className: "dfy-input", value: apiKey,
								placeholder: key.source === "none" ? "输入云端 API Key" : "输入新密钥以替换", autoComplete: "new-password",
								onChange: (e) => { setApiKey(e.target.value); setTest(null); } })),
						h("span", { className: "dfy-caption" }, key.source === "env" ? "正在使用环境变量提供的密钥" :
							key.source === "ui" ? "已保存 · " + (key.masked || "••••") : "尚未配置密钥"),
						h("div", { className: "dfy-actions" },
							h(Btn, { onClick: runTest }, testing ? "测试中…" : "测试连接"),
							h(Btn, { tone: "primary", disabled: !(test && test.ok), title: test && test.ok ? "测试已通过，可保存" : "先「测试连接」通过后再保存", onClick: doSave }, "保存"),
							key.source === "ui" ? h(Btn, { tone: "danger", onClick: clearKey }, "清除密钥") : null),
						test ? h("span", { className: "dfy-caption", role: "status", style: { margin: 0, color: test.ok ? "var(--dsw-alias-state-success-primary,#1c7a54)" : "var(--dsw-alias-state-error-primary,#c0392b)" } },
							(test.ok ? "测试通过" : "测试失败") + (test.keySource === "env" ? "（使用环境变量密钥）" : "") + "：" + (test.ok ? test.detail || "模型已返回回复" : test.error || "未知错误")) : null,
						keyNote ? h("span", { className: "dfy-caption", role: "status" }, keyNote) : null,
						feedback)),
				h("section", { "aria-label": "额度 / 可用余额" },
					h("strong", null, "额度 / 可用余额"),
					h("div", { style: { display: "grid", gap: 6 } },
						h("div", { style: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" } },
							key.source === "none" ? h("span", { className: "dfy-caption", style: { margin: 0 } }, "配置并保存 API Key 后可查询额度") :
							quota && quota.ok && quota.supported ? h(Badge, { tone: "ok", text: "可用 " + ((quota.quota && quota.quota.availableText) || "—") }) :
							quota && quota.ok && quota.supported === false ? h(Badge, { tone: "idle", text: "不支持余额查询" }) :
							quota && quota.error ? h(Badge, { tone: "err", text: "查询失败" }) : h(Badge, { tone: "idle", text: "未查询" }),
							key.source !== "none" ? h(Btn, { disabled: quotaLoading, onClick: loadQuota }, quotaLoading ? "查询中…" : "刷新额度") : null),
						quota && quota.ok && quota.supported && quota.quota && quota.quota.details ? h("div", { style: { display: "grid", gap: 2 } },
							quota.quota.details.map((d, i) => h("span", { key: i, className: "dfy-caption", style: { margin: 0 } }, d.label + "：" + d.value)),
							quota.fetchedAt ? h("span", { className: "dfy-caption", style: { margin: 0 } }, "查询于 " + new Date(quota.fetchedAt).toLocaleTimeString()) : null) : null,
						quota && quota.ok && quota.supported === false ? h("span", { className: "dfy-caption", style: { margin: 0 } }, quota.note || "额度以服务商控制台为准") : null,
						quota && !quota.ok && quota.error ? h("span", { className: "dfy-caption", role: "alert", style: { margin: 0, color: "var(--dsw-alias-state-error-primary,#c0392b)" } }, quota.error) : null))));
	}

	function DataUsageStep({ settings, save }) {
		const d = settings.dataUsage;
		return h("div", { style: { display: "grid", gap: 12 } },
			h(Row, { label: "运行模式", value: "观察学习：记录与训练候选，不替换直播版本" }),
			h(Row, { label: "画像用于参数训练", value: "不允许（默认拒绝）" }),
			h(Row, { label: "个性化退出", value: "始终可用" }),
			h(Row, { label: "礼物金额训练权重", value: "固定为 0" }),
			h("label", { className: "dfy-check" },
				h("input", { type: "checkbox", checked: d.confirmed, onChange: (e) => save("data-usage", { confirmed: e.target.checked }) }),
				h("span", null, "我已了解并确认上述数据用途设置")),
			h("p", { className: "dfy-caption", style: { margin: 0 } }, "确认后仍处于观察学习；达到验证条件才小范围采用，自动发布不跳过验证。"));
	}

	// ------------------------------------------------------------------ 直播预览

	function estimateSpeechDuration(text) {
		const tokens = text.match(/\p{Script=Han}|[\p{L}\p{N}]+|[，。！？、；：,.!?]/gu) || [];
		const units = tokens.reduce((sum, word) => sum + (/^[\x00-\x7f]+$/.test(word) ? Math.max(1, word.length / 3) : 1), 0);
		return Math.max(1, units / 4.3);
	}

	function useLocalSpeech(role) {
		const utterance = useRef(null);
		const caption = useRef(null);
		const [phase, setPhase] = useState("idle");
		const [note, setNote] = useState("");
		const cancel = useCallback(() => {
			if (!utterance.current) return;
			utterance.current = null;
			caption.current = null;
			window.speechSynthesis.cancel();
		}, []);
		useEffect(() => {
			window.speechSynthesis?.getVoices();
			return cancel;
		}, [cancel, role]);
		const stop = () => {
			cancel();
			setPhase("idle");
			setNote("已停止朗读");
		};
		const speak = (text, voiceId) => {
			cancel();
			setPhase("idle");
			const synth = window.speechSynthesis;
			if (!synth || !window.SpeechSynthesisUtterance) {
				setNote("当前浏览器不支持朗读");
				return;
			}
			const voices = synth.getVoices().filter((voice) => voice.localService && /^zh(?:[-_]|$)/i.test(voice.lang));
			const mandarin = voices.filter((v) => /^zh[-_]CN$/i.test(v.lang));
		const candidates = mandarin.length ? mandarin : voices;
		const voice = role ? candidates.find((v) => v.name.includes(role.name)) ||
			candidates[role.index % candidates.length] : candidates[0];
			if (!voice) {
				setNote("浏览器未提供本地中文音色，请在系统中启用后重试");
				return;
			}
			const item = new SpeechSynthesisUtterance(text);
			item.voice = voice;
			item.lang = voice.lang;
			const style = {
				"qing-wan": [0.95, 1.05], "chen-lang": [0.9, 0.9],
				"tong-qu": [1.08, 1.15], "ping-shi": [1, 1],
			}[voiceId] || [1, 1];
			[item.rate, item.pitch] = role ? [role.rate, role.pitch] : style;
			utterance.current = item;
			setPhase("pending");
			setNote("准备朗读…");
			item.onstart = () => {
				if (utterance.current !== item) return;
				caption.current = { start: performance.now(), duration: estimateSpeechDuration(text) / item.rate, boundary: null };
				setPhase("speaking");
				setNote("正在朗读 · " + voice.name);
			};
			item.onboundary = (event) => {
				if (utterance.current === item && caption.current && event.charIndex > 0) caption.current.boundary = event.charIndex / text.length;
			};
			const finish = (message) => {
				if (utterance.current !== item) return;
				utterance.current = null;
				caption.current = null;
				setPhase("idle");
				setNote(message);
			};
			item.onend = () => finish("朗读完成");
			item.onerror = () => finish("朗读失败，请检查系统音色后重试");
			try { synth.speak(item); } catch { finish("朗读失败，请重试"); }
		};
		const captionProgress = useCallback(() => {
			const timing = caption.current;
			return timing ? timing.boundary ?? Math.min(.94, (performance.now() - timing.start) / 1000 / timing.duration) : 0;
		}, []);
		return { speak, stop, phase, note, captionProgress };
	}

	function useLocalRecognition(onTranscript) {
		const capture = useRef(null);
		const [phase, setPhase] = useState("idle");
		const [note, setNote] = useState("");
		useEffect(() => () => {
			const session = capture.current;
			capture.current = null;
			if (session?.started) session.recognition.abort();
		}, []);
		const start = async () => {
			if (capture.current) return;
			const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
			let recognition;
			try { recognition = Recognition && new Recognition(); } catch { /* 受限的宿主可能不允许构造识别器 */ }
			if (!recognition || !("processLocally" in recognition)) {
				setNote("当前浏览器不支持本地语音识别，可直接输入文字");
				return;
			}
			const session = { recognition, started: false };
			capture.current = session;
			setPhase("checking");
			setNote("检查中文离线识别…");
			const finish = (message) => {
				if (capture.current !== session) return;
				capture.current = null;
				setPhase("idle");
				setNote(message);
			};
			try {
				recognition.lang = "zh-CN";
				recognition.processLocally = true;
				recognition.continuous = false;
				recognition.interimResults = false;
				if (Recognition.available) {
					const availability = await Recognition.available({ langs: ["zh-CN"], processLocally: true });
					if (capture.current !== session) return;
					if (availability !== "available") {
						finish(availability === "downloadable" || availability === "downloading"
							? "简体中文离线语言包未就绪，请安装后重试，或直接输入文字"
							: "简体中文离线识别不可用，可直接输入文字");
						return;
					}
				}
				recognition.onstart = () => {
					if (capture.current !== session) return;
					setPhase("listening");
					setNote("正在听…");
				};
				let transcript = "";
				recognition.onresult = (event) => {
					if (capture.current !== session) return;
					for (let i = event.resultIndex; i < event.results.length; i++) {
						if (event.results[i].isFinal) transcript += event.results[i][0].transcript;
					}
					if (transcript.trim()) onTranscript(transcript.trim().slice(0, 500));
				};
				recognition.onerror = (event) => finish({
					"not-allowed": "麦克风权限未开启，可直接输入文字",
					"service-not-allowed": "浏览器未允许本地识别，可直接输入文字",
					"audio-capture": "未找到可用的麦克风",
					"language-not-supported": "简体中文离线语言包不可用",
					"no-speech": "没有听到语音，请重试",
				}[event.error] || "语音识别未完成，可直接输入文字");
				recognition.onend = () => finish(transcript.trim() ? "转写完成，可编辑后发送" : "语音识别已结束");
				session.started = true;
				recognition.start();
			} catch {
				finish("无法启动本地语音识别，可直接输入文字");
			}
		};
		const stop = () => {
			const session = capture.current;
			if (!session) return;
			if (session.started) {
				setPhase("stopping");
				setNote("正在结束识别…");
				session.recognition.stop();
			} else {
				capture.current = null;
				setPhase("idle");
				setNote("已取消识别");
			}
		};
		return { start, stop, phase, note };
	}

	const ROLE_BROWSER_VOICES = {
		xiaxia: { name: "Sandy", index: 0, rate: 1.02, pitch: 1.12 },
		lubai: { name: "Tingting", index: 1, rate: 0.88, pitch: 0.86 },
		guyu: { name: "Flo", index: 2, rate: 0.94, pitch: 0.97 },
		beila: { name: "Shelley", index: 3, rate: 1.15, pitch: 1.03 },
		"xiaxia-3d": { name: "Sandy", index: 0, rate: 1.02, pitch: 1.12 },
	};

	// Read PCM samples at the playback position without routing sound through a second audio device.
	function wavMouthSample(bytes) {
		const wav = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		let sampleRate = 0, channels = 0;
		for (let offset = 12; offset + 8 <= wav.byteLength;) {
			const chunk = wav.getUint32(offset);
			const length = wav.getUint32(offset + 4, true);
			const payload = offset + 8;
			if (payload + length > wav.byteLength) break;
			if (chunk === 0x666d7420 && length >= 16) {
				if (wav.getUint16(payload, true) !== 1 || wav.getUint16(payload + 14, true) !== 16) break;
				channels = wav.getUint16(payload + 2, true);
				sampleRate = wav.getUint32(payload + 4, true);
			}
			if (chunk === 0x64617461 && sampleRate && channels) {
				const stride = 2 * channels;
				const samples = new Float32Array(Math.floor(length / stride));
				for (let i = 0; i < samples.length; i++) {
					let sum = 0;
					for (let ch = 0; ch < channels; ch++) sum += wav.getInt16(payload + i * stride + 2 * ch, true);
					samples[i] = sum / (channels * 32768);
				}
				return (time) => avatarPcmFeatures(samples, sampleRate, time);
			}
			offset = payload + length + length % 2;
		}
		return () => ({ level: 0, form: 0 });
	}

	function waitForRoleOutput(playing) {
		const end = playing.timeline.at(-1)?.end;
		const signal = playing.controller.signal;
		if (end === undefined || signal.aborted) return Promise.resolve();
		return new Promise((resolve) => {
			let timer;
			const deadline = performance.now() + 1000;
			const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
			const check = () => {
				const time = avatarPlaybackTime(playing.context, performance.now());
				if (signal.aborted || time === null || time >= end || performance.now() >= deadline) done();
				else timer = setTimeout(check, 10);
			};
			signal.addEventListener("abort", done, { once: true });
			check();
		});
	}

	function appendRoleChunk(playing, start, buffer) {
		playing.timeline.push({ start, end: start + buffer.duration, offset: playing.captionDuration,
			data: buffer.getChannelData(0), sampleRate: buffer.sampleRate });
		playing.captionDuration += buffer.duration;
	}

	function roleCaptionProgress(playing) {
		if (!playing) return 0;
		if (playing.audio) {
			const { currentTime, duration } = playing.audio;
			return Number.isFinite(duration) && duration > 0 ? currentTime / duration : 0;
		}
		const time = avatarPlaybackTime(playing.context, performance.now());
		if (time === null || !playing.timeline.length) return 0;
		let elapsed = playing.timeline[0].offset;
		for (const { start, end, offset } of playing.timeline) {
			if (time < start) break;
			elapsed = offset + Math.min(end, time) - start;
			if (time < end) break;
		}
		// Pending network gaps do not count toward playback, and buffered audio
		// alone does not tell us how much of a streamed reply remains.
		const duration = playing.captionComplete ? playing.captionDuration : Math.max(playing.captionEstimate, playing.captionDuration);
		return Math.min(playing.captionComplete ? 1 : .94, elapsed / duration);
	}

	async function playRoleStream(response, playing, onStart) {
		const context = playing.context;
		const reader = response.body.getReader();
		const decode = new TextDecoder();
		let pending = "";
		let next = 0;
		let ended = false;
		let last;
		const analyser = playing.analyser = context.createAnalyser();
		analyser.fftSize = 512;
		playing.samples = new Float32Array(analyser.fftSize);
		analyser.connect(context.destination);
		const signal = playing.controller.signal;
		const aborted = () => reader.cancel().catch(() => {});
		signal.addEventListener("abort", aborted, { once: true });
		function consume(line) {
			if (!line) return;
			const message = JSON.parse(line);
			if (message.type === "end") { ended = true; return; }
			if (message.type === "error") throw new Error(message.error || "角色语音播放中断");
			if (message.type !== "audio" || ended) throw new Error("角色语音数据有误");
			const bytes = decodeAsset(message.pcm);
			const pcm = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
			const buffer = context.createBuffer(1, Math.floor(bytes.byteLength / 2), message.sampleRate);
			const data = buffer.getChannelData(0);
			for (let i = 0; i < data.length; i++) data[i] = pcm.getInt16(i * 2, true) / 32768;
			const source = context.createBufferSource();
			playing.sources.add(source);
			source.buffer = buffer;
			source.connect(analyser);
			const initial = !last;
			const start = Math.max(next, context.currentTime + (initial ? 0.085 : 0.025));
			next = start + buffer.duration;
			last = new Promise((resolve) => { source.onended = () => { playing.sources.delete(source); resolve(); }; });
			appendRoleChunk(playing, start, buffer);
			source.start(start);
			if (initial) {
				playing.startTimer = setTimeout(() => {
					if (!signal.aborted && context.state === "running") onStart(message.voiceName);
				}, Math.max(0, (start - context.currentTime) * 1000));
			}
		}
		try {
			while (!signal.aborted) {
				const { value, done } = await reader.read();
				if (done || signal.aborted) break;
				pending += decode.decode(value, { stream: true });
				const lines = pending.split("\n");
				pending = lines.pop();
				for (const line of lines) consume(line);
			}
			signal.throwIfAborted();
			if (pending.trim()) consume(pending);
			if (!ended || !last) throw new Error("角色语音播放中断");
			playing.captionComplete = true;
			await new Promise((resolve) => {
				if (signal.aborted) { resolve(); return; }
				signal.addEventListener("abort", resolve, { once: true });
				last.then(() => {
					signal.removeEventListener("abort", resolve);
					resolve();
				});
			});
			await waitForRoleOutput(playing);
		} finally {
			signal.removeEventListener("abort", aborted);
			await reader.cancel().catch(() => {});
		}
	}

	function useRoleSpeech(profileId, stageContext) {
		const browser = useLocalSpeech(ROLE_BROWSER_VOICES[profileId]);
		const [phase, setPhase] = useState("idle");
		const [note, setNote] = useState("");
		const active = useRef(null);
		const usingBrowser = useRef(false);
		const cancelAudio = useCallback(() => {
			const playing = active.current;
			active.current = null;
			if (!playing) return;
			playing.controller.abort();
			clearTimeout(playing.startTimer);
			for (const source of playing.sources) {
				try { source.stop(); } catch { /* The source already ended. */ }
			}
			playing.analyser?.disconnect();
			if (!playing.sharedContext) playing.context?.close().catch(() => {});
			playing.onDone?.(false);
			if (playing.audio) {
				playing.audio.pause();
				playing.audio.removeAttribute("src");
				playing.audio.load();
			}
			if (playing.url) URL.revokeObjectURL(playing.url);
		}, []);
		useEffect(() => {
			cancelAudio();
			usingBrowser.current = false;
			setPhase("idle");
			setNote("");
			return cancelAudio;
		}, [cancelAudio, profileId]);
		const stop = () => {
			cancelAudio();
			browser.stop();
			usingBrowser.current = false;
			setPhase("idle");
			setNote("已停止朗读");
		};
		const sample = useCallback(() => {
			const playing = active.current;
			const now = performance.now();
			if (playing?.context) {
				const time = avatarPlaybackTime(playing.context, now);
				if (time === null) return { level: 0, form: 0 };
				while (playing.timeline.length && playing.timeline[0].end < time - 0.5) playing.timeline.shift();
				const chunk = playing.timeline.find((item) => time >= item.start && time < item.end);
				if (chunk) return avatarPcmFeatures(chunk.data, chunk.sampleRate, time - chunk.start);
			}
			return playing?.audio && !playing.audio.paused ? playing.sampleWav(playing.audio.currentTime) : { level: 0, form: 0 };
		}, []);
		const level = useCallback(() => sample().level, [sample]);
		level.sample = sample;
		const captionProgress = useCallback(() => usingBrowser.current ? browser.captionProgress() : roleCaptionProgress(active.current),
			[browser.captionProgress]);
		const speak = async (text, voiceId, interactionId, stage) => {
			cancelAudio();
			browser.stop();
			usingBrowser.current = false;
			const playing = { controller: new AbortController(), sources: new Set(), onDone: stage?.done,
				sharedContext: !!stageContext, context: stageContext?.current, timeline: [],
				captionDuration: 0, captionComplete: false, captionEstimate: estimateSpeechDuration(text.slice(0, 500)) };
			if (!playing.context && !stageContext && window.AudioContext) {
				try {
					playing.context = new AudioContext();
					playing.context.resume().catch(() => {});
				} catch { /* Use the existing WAV playback path. */ }
			}
			active.current = playing;
			setPhase("pending");
			setNote("正在生成角色语音…");
			const finish = (message, ok = false) => {
				if (active.current !== playing) return;
				const done = playing.onDone;
				playing.onDone = undefined;
				cancelAudio();
				done?.(ok);
				setPhase("idle");
				setNote(message);
			};
			try {
				const response = await fetch("/api/dafeiyu/preview/role-speech", {
					method: "POST", headers: jsonHeaders,
					body: JSON.stringify({ profileId, text: text.slice(0, 500), interactionId, stream: !!playing.context,
						stageOwner: stage?.owner, playbackKey: stage?.key }), signal: playing.controller.signal,
				});
				if (response.headers.get("content-type")?.includes("application/x-ndjson")) {
					playing.streaming = true;
					const context = playing.context;
					if (context.state !== "running") {
						await Promise.race([context.resume(), new Promise((_, reject) =>
							setTimeout(() => reject(new Error("请点击朗读以播放语音")), 700))]);
					}
					await playRoleStream(response, playing, (name) => {
						if (active.current !== playing) return;
						setPhase("speaking");
						setNote("正在朗读 · " + name + "（本地参考音色）");
					});
					finish("朗读完成", true);
					return;
				}
				const result = await response.json();
				if (active.current !== playing) return;
				if (!result.ok) throw Object.assign(new Error(result.error || "角色音色暂不可用"), { status: response.status, fallback: result.fallback });
				const bytes = decodeAsset(result.result.audioBase64);
				if (stageContext) {
					const context = playing.context;
					if (!context || context.state !== "running") throw new Error("请重新启用播出音频");
					const buffer = await context.decodeAudioData(bytes.buffer);
					if (active.current !== playing) return;
					const analyser = playing.analyser = context.createAnalyser();
					analyser.fftSize = 512;
					playing.samples = new Float32Array(analyser.fftSize);
					analyser.connect(context.destination);
					const source = context.createBufferSource();
					const start = context.currentTime + 0.025;
					source.buffer = buffer;
					source.connect(analyser);
					playing.sources.add(source);
					source.onended = () => { void waitForRoleOutput(playing).then(() => finish("朗读完成", true)); };
					appendRoleChunk(playing, start, buffer);
					playing.captionComplete = true;
					source.start(start);
					playing.startTimer = setTimeout(() => {
						if (active.current === playing && context.state === "running") {
							setPhase("speaking");
							setNote("正在朗读 · " + result.result.voiceName);
						}
					}, 25);
					return;
				}
				playing.sampleWav = wavMouthSample(bytes);
				playing.url = URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
				const audio = playing.audio = new Audio(playing.url);
				audio.onplaying = () => {
					if (active.current !== playing) return;
					setPhase("speaking");
					setNote("正在朗读 · " + result.result.voiceName +
						(result.result.source === "reference" ? "（本地参考音色）" : "（系统音色）"));
				};
				audio.onended = () => finish("朗读完成", true);
				audio.onerror = () => finish("角色语音播放失败");
				await audio.play();
			} catch (error) {
				if (active.current !== playing) return;
				if (playing.streaming || stageContext) {
					finish(error.message || "角色语音播放中断");
					return;
				}
				if (playing.audio) {
					finish(error.name === "NotAllowedError" ? "请点击朗读以播放语音" : "角色语音播放失败");
					return;
				}
				cancelAudio();
				setPhase("idle");
				setNote(error.message);
				if (error.fallback === true || error.status === 404 || (!error.status && (error instanceof TypeError || error.name === "SyntaxError"))) {
					usingBrowser.current = true;
					browser.speak(text, voiceId);
				}
			}
		};
		return { speak, stop, phase: usingBrowser.current ? browser.phase : phase,
			note: usingBrowser.current ? browser.note : note, level, captionProgress };
	}


	function BroadcastOverlay({ live, speaking, title, turns }) {
		const messages = turns.filter((turn) => turn.source === "danmaku").slice(-3);
		const pending = turns.filter((turn) => ["queued", "thinking"].includes(turn.status)).length;
		const activity = !live ? "直播预览" : speaking ? "正在回复" : pending ? pending + " 条待回复" : "";
		return h("div", { className: "dfy-room-overlay" },
			h("header", { className: "dfy-room-heading" },
				h("strong", null, title),
				activity ? h("span", null, activity) : null),
			live ? h("section", { className: "dfy-room-card", "aria-label": "直播间互动" },
				messages.length ? messages.map((turn) => h("p", { key: turn.id },
					h("b", null, "观众互动"), h("span", null, turn.status === "answered" ? "已回复" : "已收到，等待回应"))) :
					h("p", null, "发条评论，和主播聊聊天")) : null);
	}

	const STAGE_FLOATS = [[28, .8, 18, -3], [34, 1.55, 21, -8], [41, .52, 17, -13],
		[58, .8, 14, -5], [65, 1.34, 23, -12], [72, .59, 16, -10], [90, 1.03, 21, -4]];

	function LandscapeScene({ theme }) {
		return h("div", { className: "dfy-wide-scene", "aria-hidden": true },
			theme === "teal" ? h("img", { src: "/api/dafeiyu/avatar/stage-backdrop", alt: "" }) : null,
			h("div", { className: "dfy-wide-atmosphere" }),
			h("div", { className: "dfy-wide-floats" }, STAGE_FLOATS.map(([x, size, period, delay]) =>
				h("i", { key: x, style: { "--x": x + "%", "--size": size + "cqw", "--period": period + "s", "--delay": delay + "s" } }))));
	}

	function StageGiftAlert({ id, author, text, sentAt }) {
		const [visible, setVisible] = useState(() => Date.now() - Date.parse(sentAt) < 5500);
		useEffect(() => {
			const remaining = Date.parse(sentAt) + 5500 - Date.now();
			if (remaining <= 0 || !Number.isFinite(remaining)) return;
			const timer = setTimeout(() => setVisible(false), remaining);
			return () => clearTimeout(timer);
		}, [id, sentAt]);
		return visible ? h("div", { className: "dfy-wide-gift-alert", role: "status" },
			"♥ ", author || "直播间观众", " · ", text) : null;
	}

	function LandscapeOverlay({ scene, title, persona, live, speaking, turns = [] }) {
		const audience = turns.filter((turn) => turn.source === "danmaku");
		const chat = scene?.danmakuOverlay !== false ? audience.filter((turn) => !turn.kind || turn.kind === "comment").slice(-4) : [];
		const gifts = audience.filter((turn) => turn.kind === "gift").slice(-3);
		const queue = turns.filter((turn) => ["waiting", "queued", "thinking"].includes(turn.status)).slice(0, 3);
		const rows = (items, empty) => items.length ? items.map((turn) => h("div", { className: "dfy-wide-item", key: turn.id },
			h("b", null, turn.author || "直播间观众"), h("p", null, turn.text))) : h("p", { className: "dfy-wide-empty" }, empty);
		const panel = (name, title, content) => h("section", { className: "dfy-wide-panel dfy-wide-" + name, "aria-label": title },
			h("h3", null, title), name === "notice" ? content : h("div", { className: "dfy-wide-rows" }, content));
		const latestGift = gifts.at(-1);
		return h(react.Fragment, null,
			h("header", { className: "dfy-wide-heading" }, h("strong", null, title),
				h("span", { className: "dfy-wide-state", "data-live": live }, !live ? "预览 · 未开播" : speaking ? "正在回复" : "直播中")),
			panel("notice", "直播公告", h("p", null, scene?.notice || "欢迎来到直播间，发条弹幕和我聊聊吧。")),
			panel("chat", "观众弹幕", rows(chat, scene?.danmakuOverlay === false ? "弹幕展示已关闭" : "等待你的第一条弹幕")),
			panel("gifts", "礼物致谢", rows(gifts, "暂无礼物")),
			panel("queue", "等待回应", queue.length ? queue.map((turn) => h("div", { className: "dfy-wide-item", key: turn.id },
				h("b", null, turn.author || "直播间观众"), h("p", null, turn.status === "thinking" ? "正在组织回复…" : turn.status === "queued" ? "已排队，即将回复" : "等待选择回复"))) :
				h("p", { className: "dfy-wide-empty" }, "暂无待回复互动")),
			persona ? h("div", { className: "dfy-wide-name" }, persona.name) : null,
			live && latestGift ? h(StageGiftAlert, { key: latestGift.id, ...latestGift }) : null);
	}

	function originalStageUrl(id) {
		return "/api/dafeiyu/avatar/original-stage?id=" + encodeURIComponent(id);
	}

	function stageSceneId(scene, profileId) {
		return scene?.roleScenes?.[profileId] ?? scene?.originalScene ?? "";
	}

	function findOriginalStage(scene, stages, profileId) {
		return scene?.broadcastLayout === "landscape" ? stages?.find((item) =>
			item.profileId === profileId && item.lipSync && item.id === stageSceneId(scene, profileId)) : undefined;
	}

	function roomTitle(scene, roleName) {
		return scene?.titleMode === "custom" && scene.title ? scene.title : (roleName || "大肥鱼") + "的直播间";
	}

	function StageSettingsDrawer({ settings, catalog, reloadCatalog, refresh, onClose }) {
		const closeButton = useRef(null);
		const { save, saving, note } = useSettingsSave(refresh);
		useLayoutEffect(() => { closeButton.current?.focus(); }, []);
		const dismiss = () => { if (!saving) onClose(); };
		return h(react.Fragment, null,
			h("div", { className: "dfy-stage-drawer-shade", "aria-hidden": true, onClick: dismiss }),
			h("dialog", { id: "dfy-stage-settings-drawer", open: true, className: "dfy-stage-drawer", "aria-labelledby": "dfy-stage-drawer-title",
				onKeyDown: (event) => { if (event.key === "Escape") { event.stopPropagation(); dismiss(); } } },
				h("header", { className: "dfy-stage-drawer-head" },
					h("h3", { id: "dfy-stage-drawer-title" }, "舞台设置"),
					h("button", { type: "button", className: "dfy-btn dfy-btn-ghost", ref: closeButton, disabled: saving, onClick: dismiss }, "关闭")),
				h(StageSettingsForm, { settings, catalog, reloadCatalog, save, saving, note })));
	}

	function StageSettingsForm({ settings, save, catalog, reloadCatalog, saving, note }) {
		useEffect(() => { void reloadCatalog(); }, [reloadCatalog]);
		const saved = { ...settings.scene, titleMode: settings.scene.titleMode || "role", originalScene: settings.scene.originalScene || "" };
		const [edits, setEdits] = useState(null);
		const draft = edits ?? saved;
		const change = (key) => (event) => {
			const { value, type, checked } = event.target;
			setEdits((old) => ({ ...(old ?? saved), [key]: type === "checkbox" ? checked : value }));
		};
		const profileId = settings.profile?.id;
		const stages = (catalog?.originalStages || []).filter((item) => item.profileId === profileId);
		const original = findOriginalStage(draft, stages, profileId);
		const stageId = stageSceneId(draft, profileId);
		const changeStage = (event) => {
			const value = event.target.value;
			setEdits((old) => {
				const current = old ?? saved;
				return { ...current, roleScenes: { ...current.roleScenes, [profileId]: value } };
			});
		};
		const wide = draft.broadcastLayout === "landscape";
		const missing = wide && !!stageId && !original &&
			(stages.some((item) => item.id === stageId) || Object.hasOwn(draft.roleScenes || {}, profileId));
		const saveStage = (event) => {
			event.preventDefault();
			const { title, titleMode, notice, broadcastLayout, roleScenes, background, danmakuOverlay } = draft;
			void save("scene", {
				title: titleMode === "role" ? title.trim() || settings.scene.title : title,
				titleMode, notice, broadcastLayout, roleScenes, background, danmakuOverlay,
			});
		};

		return h("form", { className: "dfy-stage-settings", onSubmit: saveStage },
			h("fieldset", { className: "dfy-stage-settings-body dfy-form-fields", disabled: saving },
				h("section", { "aria-labelledby": "dfy-stage-picture-fields" },
					h("h4", { id: "dfy-stage-picture-fields" }, "画面与素材"),
					h("div", { className: "dfy-form-grid" },
						h(Field, { label: "画面方向" },
							h("select", { className: "dfy-select", "aria-label": "画面方向", value: draft.broadcastLayout, onChange: change("broadcastLayout") },
								h("option", { value: "portrait" }, "竖屏 · 1080×1920"),
								h("option", { value: "landscape" }, "横屏 · 1920×1080"))),
						wide ? h(Field, { label: "横屏素材" },
							h("select", { className: "dfy-select", "aria-label": "横屏素材", value: original?.id || (missing ? stageId : ""), onChange: changeStage },
								h("option", { value: "" }, "动态角色 + 舞台布景"),
								missing && !stages.some((item) => item.id === stageId) ? h("option", { value: stageId, disabled: true }, "原场景素材不可用") : null,
								stages.map(({ id, name, lipSync }) => h("option", { key: id, value: id, disabled: !lipSync }, name + (lipSync ? " · 原场景" : " · 缺少口型数据"))))) : null,
						wide ? h(Field, { label: original ? "面板配色" : "舞台主题" },
							h("select", { className: "dfy-select", "aria-label": original ? "面板配色" : "舞台主题", value: draft.background, onChange: change("background") },
								[["teal", "海边小屋"], ["night", "深海"], ["warm", "晚霞"]].map(([value, label]) => h("option", { key: value, value }, label)))) : null),
					original ? h("div", { className: "dfy-stage-source-preview" },
						original.hasPoster ? h("img", { src: originalStageUrl(original.id) + "&asset=poster", alt: original.name + "预览" }) : null,
						h("div", null, h("strong", null, original.name),
							h("p", { className: "dfy-caption" }, "原片静音循环，嘴型随角色语音变化。"))) :
						wide && !stages.length ? h("p", { className: "dfy-caption" },
							!catalog ? "正在读取场景素材…" : Array.isArray(catalog.originalStages) ?
								"当前角色没有本地原场景，可使用动态角色。" : "重载大肥鱼插件后可选择原场景。") : null),
				h("section", { "aria-labelledby": "dfy-stage-overlay-fields" },
					h("h4", { id: "dfy-stage-overlay-fields" }, "标题与互动"),
					h("div", { className: "dfy-form-grid" },
						h(Field, { label: "命名方式" },
							h("select", { className: "dfy-select", "aria-label": "命名方式", value: draft.titleMode, onChange: change("titleMode") },
								h("option", { value: "role" }, "跟随角色"),
								h("option", { value: "custom" }, "自定义"))),
						h(Field, { label: "直播间名称" },
							h("input", { className: "dfy-input", value: draft.titleMode === "custom" ? draft.title : roomTitle(draft, settings.profile?.name),
								onChange: change("title"), readOnly: draft.titleMode === "role", required: true, maxLength: 30 }))),
					wide ? h(Field, { label: "直播公告" },
						h("textarea", { className: "dfy-input", value: draft.notice, onChange: change("notice"), maxLength: 300 })) : null,
					h("label", { className: "dfy-check" }, h("input", { type: "checkbox", checked: draft.danmakuOverlay, onChange: change("danmakuOverlay") }), "展示观众弹幕"))),
			h("footer", { className: "dfy-stage-settings-footer" },
				h(Btn, { type: "submit", tone: "primary", disabled: saving || !!missing }, "保存舞台设置"),
				note ? h("p", { className: "dfy-caption", role: "status" }, note) : null));
	}

	const BROADCAST_INTERACTION_REMINDER_MS = 120_000;

	function useStageHealth({ visible, live, safe, renderer, catalogReady, missingMotion, lastInteractionAt }) {
		const [notice, setNotice] = useState("");
		const lastFrame = useRef(0);
		const liveActivity = useRef(0);
		const onFrame = useCallback(() => { lastFrame.current = performance.now(); }, []);
		useEffect(() => { liveActivity.current = live ? Date.now() : 0; }, [live]);
		useEffect(() => {
			if (live) liveActivity.current = Math.max(liveActivity.current, lastInteractionAt);
		}, [live, lastInteractionAt]);
		useEffect(() => {
			if (!visible || safe) { setNotice(""); return; }
			const started = performance.now();
			const check = () => {
				const last = lastFrame.current > started ? lastFrame.current : 0;
				const stalled = last ? performance.now() - last >= 3500 : performance.now() - started >= 10_000;
				const quiet = live && Date.now() - liveActivity.current >= BROADCAST_INTERACTION_REMINDER_MS;
				const action = "请检查直播伴侣采集，必要时切换真人画面或结束推流。";
				setNotice(document.hidden ? "直播画面已隐藏。" + action :
					!renderer && catalogReady ? "当前仅有静态素材。" + action :
					missingMotion ? "角色尚未准备前景轮廓，仅口型随语音更新。" :
					stalled ? "角色画面未更新。" + action :
					quiet ? "插件内已有 2 分钟没有播出评论或操作员回复。请确认主播在场并继续实时互动。" : "");
			};
			check();
			const timer = setInterval(check, 1000);
			document.addEventListener("visibilitychange", check);
			return () => { clearInterval(timer); document.removeEventListener("visibilitychange", check); };
		}, [visible, live, safe, renderer, catalogReady, missingMotion]);
		return { notice, onFrame };
	}

	function useBroadcastArtwork(persona, catalog) {
		const [roomBackdrop, setRoomBackdrop] = useState("");
		const [failure, setFailure] = useState(null);
		const [prototypeFailure, setPrototypeFailure] = useState(null);
		const [prototypeMotion, setPrototypeMotion] = useState(null);
		const markPrototypeMotion = useCallback((id, ready) => setPrototypeMotion({ id, ready }), []);
		const modelId = persona?.media?.modelId;
		const rigged = catalog?.rigged?.includes(modelId);
		const prototype = catalog?.prototypes?.includes(modelId) && prototypeFailure !== persona?.profileId;
		const model = !rigged && modelId && catalog && Object.values(catalog.vendors).every(Boolean) ?
			catalog.models.find((item) => item.id === modelId && item.id !== failure) : null;

		useEffect(() => {
			setFailure(null);
			setPrototypeFailure(null);
		}, [catalog]);

		useEffect(() => {
			let disposed = false;
			setRoomBackdrop("");
			if (modelId === "dsh-pet") {
				api("avatar/prototype?id=eciyuan-xiaxia").then((result) => {
					if (!disposed && result.ok) setRoomBackdrop("data:image/png;base64," + result.image);
				}).catch(() => {});
			}
			return () => { disposed = true; };
		}, [modelId]);

		return {
			roomBackdrop, model, prototype, rigged, markPrototypeMotion, setFailure, setPrototypeFailure,
			scenes: catalog?.scenes ?? [],
			originalStages: catalog?.originalStages ?? [],
			missingMotion: !model && prototype && prototypeMotion?.id === modelId && !prototypeMotion.ready,
		};
	}

	function useStageMatte(id) {
		const [loaded, setLoaded] = useState(null);
		useEffect(() => {
			if (!id) return;
			const source = "/api/dafeiyu/avatar/stage-matte?id=" + encodeURIComponent(id);
			const image = new Image();
			image.onload = () => setLoaded({ id, source });
			image.src = source;
			return () => { image.onload = null; };
		}, [id]);
		return loaded?.id === id ? loaded?.source : null;
	}

	function useOriginalMouthTrack(id) {
		const [loaded, setLoaded] = useState(null);
		useEffect(() => {
			if (!id) return;
			const controller = new AbortController();
			fetch(originalStageUrl(id) + "&asset=mouth", { signal: controller.signal })
				.then((res) => res.ok ? res.json() : null)
				.then((data) => {
					if (!controller.signal.aborted && data?.ok && Array.isArray(data.frames)) setLoaded({ id, frames: data.frames });
				}).catch(() => {});
			return () => controller.abort();
		}, [id]);
		return loaded?.id === id ? loaded?.frames : null;
	}

	function stageMouthAt(frames, time) {
		let left = 0, right = frames.length - 1;
		if (time <= frames[left][0]) return frames[left];
		if (time >= frames[right][0]) return frames[right];
		while (right - left > 1) {
			const middle = (left + right) >> 1;
			if (frames[middle][0] <= time) left = middle;
			else right = middle;
		}
		const a = frames[left], b = frames[right];
		const f = (time - a[0]) / (b[0] - a[0]);
		return a.map((value, i) => value + (b[i] - value) * f);
	}

	// Follow the actual lip crease inside the tracked mouth instead of extending one flat line.
	function traceStageLipCrease(source, width, height, span, creases, smoothed) {
		const center = height / 2;
		const search = Math.max(2, Math.round(span * .065));
		const minY = Math.floor(center) - search, maxY = Math.ceil(center) + search;
		const luma = (i) => source[i] * .2126 + source[i + 1] * .7152 + source[i + 2] * .0722;
		for (let x = 0; x < width; x++) {
			const distance = Math.abs(x + .5 - width / 2) / (span * .48);
			if (distance >= 1) { creases[x] = center; continue; }
			let sum = 0, weight = 0;
			for (let y = minY; y <= maxY; y++) {
				const i = (y * width + x) * 4;
				const flank = Math.max(0, (luma(i - width * 8) + luma(i + width * 8)) / 2 - luma(i));
				const proximity = 1 - Math.abs(y + .5 - center) / (search + 1);
				const w = flank * flank * Math.max(0, proximity) ** 1.4;
				sum += (y + .5) * w; weight += w;
			}
			creases[x] = weight > 0 ? center + (sum / weight - center) * (1 - distance ** 4) : center;
		}
		for (let x = 0; x < width; x++) {
			let sum = 0, weight = 0;
			for (let offset = -3; offset <= 3; offset++) {
				const w = 4 - Math.abs(offset);
				sum += creases[Math.max(0, Math.min(width - 1, x + offset))] * w;
				weight += w;
			}
			smoothed[x] = sum / weight;
		}
	}

	// Reuse the current picture's lip texture. The transparent patch never repaints the rest of the scene.
	function createStageMouthPatch() {
		const surface = document.createElement("canvas");
		const context = surface.getContext("2d", { willReadFrequently: true });
		let result, creases, smoothed;
		return (output, video, track, opening, form) => {
			const [, nx, ny, nw, tilt] = track;
			const x = nx * video.videoWidth, y = ny * video.videoHeight, span = nw * video.videoWidth;
			const width = Math.ceil(span * 1.38), height = Math.ceil(span * .92);
			if (!context || x - width < 0 || y - height < 0 || x + width > video.videoWidth || y + height > video.videoHeight) return;
			if (!result || surface.width !== width || surface.height !== height) {
				surface.width = width; surface.height = height;
				result = context.createImageData(width, height);
				creases = new Float32Array(width);
				smoothed = new Float32Array(width);
			}
			context.clearRect(0, 0, width, height);
			context.save();
			context.translate(width / 2, height / 2);
			context.rotate(-tilt);
			context.drawImage(video, -x, -y);
			context.restore();

			const source = context.getImageData(0, 0, width, height).data;
			const pixels = result.data;
			traceStageLipCrease(source, width, height, span, creases, smoothed);
			for (let col = 0; col < width; col++) {
				const distance = Math.abs(col + .5 - width / 2) / (span * (.45 + .045 * form));
				const shape = distance >= 1 ? 0 : Math.cos(distance * Math.PI / 2) ** 1.65;
				const crease = smoothed[col];
				const lipEdge = Math.max(1, span * .023);
				const fromTop = crease - lipEdge, fromBottom = crease + lipEdge;
				const gap = opening * span * shape;
				const top = fromTop, bottom = fromBottom + gap * .15;
				const fadeX = Math.min(1, shape * 5);
				const upperLip = (Math.floor(crease - span * .053) * width + col) * 4;
				const lowerLip = (Math.floor(crease + span * .064) * width + col) * 4;
				for (let row = 0; row < height; row++) {
					const index = (row * width + col) * 4, py = row + .5;
					pixels[index + 3] = 0;
					if (!shape || py <= top) continue;
					const middle = (py - top) / (bottom - top);
					const sampleY = py >= bottom ? fromBottom + (py - bottom) * (height - fromBottom) / (height - bottom) :
						fromTop + middle * (fromBottom - fromTop);
					const srcY = Math.max(0, Math.min(height - 1.01, sampleY - .5));
					const lo = Math.floor(srcY), fraction = srcY - lo;
					const from = (lo * width + col) * 4;
					// Retain the source lip colors. Soften the stretched crease and shade only the inner opening.
					const depth = middle > 0 && middle < 1 ? Math.sin(middle * Math.PI) ** 2 * opening * shape : 0;
					for (let ch = 0; ch < 3; ch++) {
						const warped = source[from + ch] * (1 - fraction) + source[from + width * 4 + ch] * fraction;
						const rimColor = source[upperLip + ch] * .62 + source[lowerLip + ch] * .38;
						const interior = Math.max(warped * .9, rimColor * .68);
						const shaded = warped + (interior - warped) * depth;
						// A stretched crease must not turn brighter source pixels into a uniform dark bar.
						pixels[index + ch] = middle < 1.25 ? Math.max(shaded, source[index + ch] * .82) : shaded;
					}
					pixels[index + 3] = 255 * fadeX * Math.min(1, (py - top) / 2, (height - py) / 3);
				}
			}

			context.putImageData(result, 0, 0);
			output.save();
			output.translate(x, y);
			output.rotate(tilt);
			output.drawImage(surface, -width / 2, -height / 2);
			output.restore();
		};
	}

	function StageMouthOverlay({ frames, videoRef, active, speaking, mouthLevel }) {
		const target = useRef(null);
		const sample = useRef(mouthLevel);
		sample.current = mouthLevel;
		useEffect(() => {
			const canvas = target.current, video = videoRef.current;
			if (!canvas || !video || !active || !speaking) return;
			const context = canvas.getContext("2d");
			if (!context) return;
			canvas.width = video.videoWidth; canvas.height = video.videoHeight;
			const paint = createStageMouthPatch();
			let frame, lastTime = 0, opening = 0, lastPatch = null;
			const clear = () => {
				if (!lastPatch) return;
				const [, x, y, span] = lastPatch;
				const radius = span * canvas.width;
				context.clearRect(x * canvas.width - radius, y * canvas.height - radius, 2 * radius, 2 * radius);
				lastPatch = null;
			};
			const tick = (now) => {
				if (now - lastTime >= 28) {
					lastTime = now;
					const pose = sample.current?.sample?.() || { level: sample.current?.() || 0, form: 0 };
					const target = Math.pow(Math.max(0, Math.min(1, pose.level || 0)), .82);
					opening += (target - opening) * (target > opening ? .72 : .86);
					const form = Math.max(-1, Math.min(1, pose.form || 0));
					clear();
					if (opening >= .028 && video.readyState >= 2) {
						lastPatch = stageMouthAt(frames, video.currentTime);
						paint(context, video, lastPatch, opening, form);
					}
				}
				frame = requestAnimationFrame(tick);
			};
			frame = requestAnimationFrame(tick);
			return () => { cancelAnimationFrame(frame); clear(); };
		}, [frames, videoRef, active, speaking]);
		return h("canvas", { ref: target, className: "dfy-original-stage-mouth", "aria-hidden": true });
	}

	function BroadcastPicture({ persona, layout, scene: sceneSettings, artwork, visible = true, live, safe, speaking, listening, engaged, line, captionProgress, mouthLevel, viseme, dialogue, turns, onFrame }) {
		const { roomBackdrop, model, prototype, rigged, markPrototypeMotion, setFailure, setPrototypeFailure, scenes, originalStages } = artwork;
		const emotion = speaking ? avatarReplyEmotion(line) : 0;
		const sceneId = persona?.media?.modelId;
		const original = findOriginalStage(sceneSettings, originalStages, persona?.profileId);
		const frames = useOriginalMouthTrack(original?.id);
		const originalVideo = useIdleScene(original && frames && visible && !safe ? originalStageUrl(original.id) : null, true, onFrame, true);
		const showOriginal = !!originalVideo.props;
		const sceneUrl = !showOriginal && !rigged && !model && !prototype && sceneId !== "dsh-pet" && scenes.includes(sceneId) && !safe && visible ?
			"/api/dafeiyu/avatar/scene?id=" + encodeURIComponent(sceneId) : null;
		const scene = useIdleScene(sceneUrl, !speaking && !engaged, onFrame);
		const wide = layout === "landscape";
		const title = roomTitle(sceneSettings, persona?.name);
		const theme = sceneSettings?.background || "teal";
		const matte = useStageMatte(!showOriginal && wide && visible && !safe && prototype && !rigged && !model && sceneId !== "dsh-pet" ? sceneId : null);
		return h("div", { className: "dfy-broadcast" + (persona?.media?.modelId === "dsh-pet" ? " dfy-room-pet" : " dfy-room-person") + (wide ? " dfy-broadcast-landscape" : "") + (rigged ? " dfy-broadcast-reference" : "") + (model || matte ? " dfy-room-cutout" : "") + (matte ? " dfy-room-matted" : "") + (showOriginal ? " dfy-broadcast-original" : ""),
			"data-stage-theme": theme,
			"aria-label": layout === "landscape" ? "直播画面 1920×1080" : "直播画面 1080×1920",
			style: { "--stage-color": persona?.theme?.primary, "--stage-dark": persona?.theme?.bg } },
		showOriginal ? h(react.Fragment, null,
			h("video", { ...originalVideo.props, className: "dfy-original-stage-video",
				poster: original.hasPoster ? originalStageUrl(original.id) + "&asset=poster" : undefined }),
			h(StageMouthOverlay, { key: original.id, frames, videoRef: originalVideo.props.ref,
				active: originalVideo.active, speaking, mouthLevel })) :
		!safe && visible && wide ? h(LandscapeScene, { theme }) :
			!wide && roomBackdrop ? h("img", { className: "dfy-room-backdrop", src: roomBackdrop, alt: "" }) : null,
		h("span", { className: "dfy-pet-ai" }, persona?.aiLabelText || "AI 生成内容"),
		!safe && visible ? (wide ? h(LandscapeOverlay, { scene: sceneSettings, title, live, speaking, persona: showOriginal ? null : persona, turns }) : h(BroadcastOverlay, { live, speaking, title, turns })) : null,
		safe ? h("div", { className: "dfy-broadcast-safe" }, "播出已暂停") : visible && !showOriginal ?
			h("div", { className: "dfy-broadcast-art" },
				h("div", { className: "dfy-broadcast-avatar" + (matte ? " dfy-stage-matte" : ""), hidden: scene.active,
					style: matte ? { "--stage-matte": `url("${matte}")` } : undefined },
					rigged ? h(RiggedRole, { key: persona.profileId, persona, speaking, listening, emotion, mouthLevel, safe, onFrame }) :
					model ? h(Live2DScene, { key: model.id, entry: model, speaking, listening, emotion, mouthLevel, viseme, dialogue, safe, onFrame,
						onFail: () => setFailure(model.id), onLipSync: (ok) => { if (!ok && prototype) setFailure(model.id); } }) :
						prototype ? h(RolePrototype, { key: persona.profileId, persona, speaking, listening, emotion, mouthLevel, viseme, dialogue, safe, visible: !scene.active, idleAllowed: !engaged, onFrame,
							onMotionReady: markPrototypeMotion, onError: () => setPrototypeFailure(persona.profileId) }) :
							persona?.media?.portraitUrl ? h("img", { src: persona.media.portraitUrl, alt: persona.name }) :
								persona ? h("span", { className: "dfy-role-initial" }, persona.name) : null),
				scene.props ? h("video", { ...scene.props, "aria-hidden": true }) : null) : null,
		!safe && visible && speaking && line ? h(SpeechCaption, { className: "dfy-broadcast-caption", line, progress: captionProgress }) : null);
	}

	function useBroadcastWindow(frame, owner) {
		const [open, setOpen] = useState(false);
		const [pending, setPending] = useState(false);
		const [notice, setNotice] = useState("");
		const playbackVersion = useRef(null);
		const current = useRef(frame);
		current.current = frame;

		const control = async (action) => {
			setPending(true);
			setNotice("");
			try {
				const result = await api("broadcast-window/" + action, { owner: owner.current });
				if (!result.ok) throw new Error(result.error || "请重载大肥鱼插件");
				if (action === "open" && !Number.isSafeInteger(result.playbackVersion)) throw new Error("请重载大肥鱼插件");
				playbackVersion.current = result.playbackVersion ?? null;
				setOpen(action === "open");
			} catch (error) {
				setNotice("播出窗口操作失败 · " + error.message);
			} finally {
				setPending(false);
			}
		};

		useEffect(() => {
			if (!open) return;
			const lifecycle = new AbortController();
			let timer;
			const send = async () => {
				const started = performance.now();
				const { speaking, listening, subtitle, captionProgress, level, safe, profileId } = current.current;
				const sample = speaking ? (level.sample?.() || { level: level(), form: 0 }) : { level: 0, form: 0 };
				const body = JSON.stringify({ owner: owner.current, playbackVersion: playbackVersion.current, speaking, listening, subtitle, safe, profileId,
					...sample, captionProgress: speaking ? captionProgress() : undefined, sampledAt: Date.now() });
				try {
					const response = await fetch("/api/dafeiyu/broadcast-window/frame", {
						method: "POST", headers: jsonHeaders, body,
						signal: AbortSignal.any([lifecycle.signal, AbortSignal.timeout(1200)]),
					});
					const result = await response.json();
					if (lifecycle.signal.aborted) return;
					if (result.ok && !result.open) { setOpen(false); return; }
					if (result.ok && Number.isSafeInteger(result.playbackVersion)) playbackVersion.current = result.playbackVersion;
				} catch { /* A disconnected preview will switch to the safe scene. */ }
				if (!lifecycle.signal.aborted) timer = setTimeout(send, Math.max(0, 16 - (performance.now() - started)));
			};
			void send();
			return () => { lifecycle.abort(); clearTimeout(timer); };
		}, [open, owner]);

		return { open, pending, notice, control };
	}

	function useDialoguePresentation({ safe, speaking, listening, profileId, version, turns, allowTail = true }) {
		const dialogue = useRef(null);
		dialogue.current ??= createDialogueMotion();
		const edge = useRef(null);
		const seenTurns = useRef(new Set());
		const [closing, setClosing] = useState(false);
		const [reacting, setReacting] = useState(false);

		useLayoutEffect(() => {
			const now = performance.now();
			const motion = dialogue.current;
			const previous = edge.current;
			edge.current = { safe, speaking, listening, profileId, version };
			setClosing(false);
			if (safe) { motion.apply("safe", now); return; }
			const continuous = previous && !previous.safe && previous.profileId === profileId && previous.version === version;
			if (previous?.safe) motion.apply("resume", now);
			else if (!continuous) motion.interrupt(now);
			if (speaking) motion.apply("speak", now);
			else if (listening) motion.apply("think", now);
			else if (continuous && previous.speaking && allowTail) {
				const { blendMs } = motion.apply("tail", now);
				setClosing(true);
				const timer = setTimeout(() => {
					motion.interrupt(performance.now());
					setClosing(false);
				}, blendMs);
				return () => clearTimeout(timer);
			} else if (continuous && (previous.listening || previous.speaking)) motion.interrupt(now);
		}, [safe, speaking, listening, profileId, version, allowTail]);

		useEffect(() => {
			if (!turns?.length) { seenTurns.current.clear(); return; }
			const fresh = turns.some((turn) => turn.source === "danmaku" && !seenTurns.current.has(turn.id));
			seenTurns.current = new Set(turns.map((turn) => turn.id));
			if (!fresh || safe || dialogue.current.phase === "closing") return;
			const motion = dialogue.current;
			const before = motion.targets;
			if (motion.apply("danmaku", performance.now()) === before || speaking || listening) return;
			setReacting(true);
			const timer = setTimeout(() => {
				if (motion.phase === "listening") motion.interrupt(performance.now());
				setReacting(false);
			}, 700);
			return () => { clearTimeout(timer); setReacting(false); };
		}, [turns, safe, speaking, listening, profileId, version]);

		return { dialogue, engaged: listening || closing || reacting };
	}

	function BroadcastOutput() {
		const [preview, setPreview] = useState(null);
		const [catalog, setCatalog] = useState(null);
		const [turns, setTurns] = useState([]);
		const [frame, setFrame] = useState({ safe: true });
		const latest = useRef({ level: 0, form: 0, sampledAt: 0 });
		const captionProgress = useCallback(() => latest.current.captionProgress, []);
		const mouthLevel = useCallback(() => Date.now() - latest.current.sampledAt < 160 ? latest.current.level : 0, []);
		mouthLevel.sample = () => ({ level: mouthLevel(), form: mouthLevel() ? latest.current.form : 0 });
		const metrics = useRef({ frameAges: [], renderIntervals: [], lastRender: 0, staleFrames: 0 });
		const onFrame = useCallback(() => {
			const now = performance.now(), m = metrics.current;
			if (m.lastRender) { m.renderIntervals.push(now - m.lastRender); if (m.renderIntervals.length > 600) m.renderIntervals.shift(); }
			m.lastRender = now;
			if (latest.current.speaking) {
				const age = Date.now() - latest.current.sampledAt;
				if (age >= 0 && age < 160) { m.frameAges.push(age); if (m.frameAges.length > 600) m.frameAges.shift(); }
				else m.staleFrames++;
			}
		}, []);
		const outputLayout = preview?.scene?.broadcastLayout || "portrait";
		useEffect(() => {
			if (preview) window.webkit?.messageHandlers?.stageLayout?.postMessage(outputLayout);
		}, [outputLayout, !!preview]);
		const persona = preview?.persona;
		const live = preview?.liveStatus === "live_confirmed";
		const artwork = useBroadcastArtwork(persona, catalog);
		const safe = !preview || frame.safe || frame.profileId !== persona?.profileId;
		const motion = useDialoguePresentation({ safe, speaking: frame.speaking, listening: frame.listening,
			profileId: persona?.profileId, version: frame.version, turns });

		useEffect(() => {
			window.webkit?.messageHandlers?.broadcastReady?.postMessage("ready");
		}, []);

		useEffect(() => {
			const stream = new EventSource("/frames");
			let received = performance.now();
			const reset = () => { latest.current = { level: 0, form: 0, sampledAt: 0 }; setFrame({ safe: true }); };
			stream.onmessage = (event) => {
				try {
					const result = JSON.parse(event.data);
					received = performance.now();
					// Only server-accepted samples reach the renderer after a version change.
					latest.current = result;
					setFrame((old) => old.safe === result.safe && old.profileId === result.profileId && old.speaking === result.speaking &&
						old.listening === result.listening && old.subtitle === result.subtitle && old.version === result.version ? old : result);
				} catch { reset(); }
			};
			stream.onerror = reset;
			const watchdog = setInterval(() => { if (performance.now() - received > 250) reset(); }, 50);
			const percentile = (data, q) => data.length ? [...data].sort((a, b) => a - b)[Math.min(data.length - 1, Math.floor(data.length * q))] : null;
			window.__dafeiyuMotionMetrics = () => ({
				// Delivery age is a diagnostic, not a camera/speaker end-to-end sync certification.
				sampleToRenderP95Ms: percentile(metrics.current.frameAges, 0.95),
				renderIntervalP95Ms: percentile(metrics.current.renderIntervals, 0.95),
				staleFrames: metrics.current.staleFrames, samples: metrics.current.frameAges.length,
			});
			return () => { stream.close(); clearInterval(watchdog); delete window.__dafeiyuMotionMetrics; };
		}, []);

		useEffect(() => {
			const controller = new AbortController();
			let timer;
			const get = async (path) => {
				const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(1800)]);
				return (await fetch("/api/dafeiyu/" + path, { signal })).json();
			};
			const refreshCatalog = async () => {
				try {
					const result = await get("avatar/catalog");
					if (!controller.signal.aborted && result.ok) setCatalog(result.catalog);
				} catch { /* Keep the last working catalogue. */ }
			};
			const poll = async () => {
				try {
					const result = await get("preview");
					if (!controller.signal.aborted && result.ok) {
						setPreview(result.preview);
						if (result.preview.liveStatus === "live_confirmed") {
							const interaction = await get("interaction");
							if (!controller.signal.aborted && interaction.ok) setTurns(interaction.turns);
						} else setTurns([]);
					}
				} catch { /* The fast frame loop handles disconnects. */ }
				if (!controller.signal.aborted) timer = setTimeout(poll, 1000);
			};
			void refreshCatalog();
			void poll();
			window.addEventListener("focus", refreshCatalog);
			return () => {
				controller.abort();
				clearTimeout(timer);
				window.removeEventListener("focus", refreshCatalog);
			};
		}, []);

		return h("main", { className: "dfy-root dfy-output-window" },
			h(BroadcastPicture, { persona, layout: preview?.scene?.broadcastLayout || "portrait", scene: preview?.scene, artwork, live, safe,
				speaking: frame.speaking, listening: frame.listening, line: frame.subtitle, captionProgress, mouthLevel, dialogue: motion.dialogue,
				engaged: motion.engaged, turns, onFrame }));
	}

	function BroadcastStage({ status, settings, preview, catalog, visible, emergency, controls, publish, refresh, reloadCatalog }) {
		const [drawerOpen, setDrawerOpen] = useState(false);
		const stageSettingsButton = useRef(null);
		useEffect(() => { if (!visible) setDrawerOpen(false); }, [visible]);
		const closeDrawer = () => {
			setDrawerOpen(false);
			stageSettingsButton.current?.focus();
		};
		const [armed, setArmed] = useState(false);
		const [notice, setNotice] = useState("");
		const [outputs, setOutputs] = useState([]);
		const [output, setOutput] = useState("");
		const [line, setLine] = useState("");
		const [turns, setTurns] = useState([]);
		const owner = useRef(null);
		owner.current ??= crypto.randomUUID();
		const audio = useRef(null);
		const completed = useRef(null);
		const active = useRef(null);
		const handlers = useRef(null);
		const unlock = useRef(null);
		const persona = preview?.persona;
		const speech = useRoleSpeech(persona?.profileId, audio);
		handlers.current = { speech, persona };
		const live = status?.liveStatus === "live_confirmed";
		const safe = emergency || status?.liveStatus === "safe_scene";
		const layout = settings?.scene?.broadcastLayout || preview?.scene?.broadcastLayout || "portrait";
		const artwork = useBroadcastArtwork(persona, catalog);
		const lastInteractionAt = turns.reduce((latest, turn) => {
			if ((turn.source !== "operator" && turn.kind !== "comment") || turn.playback !== "played") return latest;
			return Math.max(latest, Date.parse(turn.sentAt) || 0);
		}, 0);
		const original = findOriginalStage(settings?.scene || preview?.scene, artwork.originalStages, persona?.profileId);
		const health = useStageHealth({ visible, live, safe, renderer: original ? "video:" + original.id : artwork.model ? "model:" + artwork.model.id : artwork.rigged || artwork.prototype ? "rig:" + persona.profileId : "",
			catalogReady: !!catalog && !!preview, missingMotion: !original && artwork.missingMotion,
			lastInteractionAt });

		const speaking = speech.phase === "speaking" && !safe;
		const listening = !safe && !speaking && (speech.phase === "pending" ||
			(live && turns.some((turn) => ["queued", "thinking"].includes(turn.status))));
		const motion = useDialoguePresentation({ safe, speaking, listening, profileId: persona?.profileId, turns, allowTail: armed });

		useEffect(() => {
			if (!live || safe) { setTurns([]); return; }
			const controller = new AbortController();
			let timer;
			const update = async () => {
				try {
					const response = await fetch("/api/dafeiyu/interaction", {
						signal: AbortSignal.any([controller.signal, AbortSignal.timeout(2500)]),
					});
					const result = await response.json();
					if (result.ok && !controller.signal.aborted) setTurns(result.turns);
				} catch { /* 下一次轮询继续读取。 */ }
				if (!controller.signal.aborted) timer = setTimeout(update, 1500);
			};
			update();
			return () => { controller.abort(); clearTimeout(timer); };
		}, [live, safe]);

		const release = useCallback(() => {
			fetch("/api/dafeiyu/interaction/stage", {
				method: "POST", headers: jsonHeaders, keepalive: true,
				body: JSON.stringify({ owner: owner.current, release: true }),
			}).catch(() => {});
		}, []);
		const stop = useCallback(() => {
			unlock.current = null;
			handlers.current.speech.stop();
			active.current = null;
			// 暂停播出声音 = 打断：让独立窗口作废在途口型与动作（旧版本上行帧随后被拒收）
			fetch("/api/dafeiyu/broadcast-window/interrupt", {
				method: "POST", headers: jsonHeaders, keepalive: true,
				body: JSON.stringify({ owner: owner.current }),
			}).catch(() => {});
			setLine("");
			setArmed(false);
		}, []);
		useEffect(() => {
			const quit = () => { stop(); release(); };
			window.addEventListener("pagehide", quit);
			navigator.mediaDevices?.enumerateDevices().then((devices) => setOutputs(devices.filter((device) =>
				device.kind === "audiooutput" && device.deviceId && device.deviceId !== "default"))).catch(() => {});
			return () => {
				window.removeEventListener("pagehide", quit);
				unlock.current = null;
				audio.current?.close().catch(() => {});
			};
		}, [release, stop]);
		useEffect(() => { if (safe) stop(); }, [safe, stop]);

		useEffect(() => {
			if (!armed || !live || safe || !persona?.profileId) return;
			const lifecycle = new AbortController();
			let timer;
			let confirmedAt = Date.now();
			const poll = async () => {
				try {
					const ack = completed.current;
					const response = await fetch("/api/dafeiyu/interaction/stage", {
						method: "POST", credentials: "same-origin", headers: jsonHeaders,
						body: JSON.stringify({ owner: owner.current, playingKey: active.current?.key,
							completedKey: ack?.key, completedOk: ack?.ok }),
						signal: AbortSignal.any([lifecycle.signal, AbortSignal.timeout(1800)]),
					});
					const result = await response.json();
					if (lifecycle.signal.aborted) return;
					if (!result.ok) throw new Error("播出连接暂时不可用");
					confirmedAt = Date.now();
					if (completed.current === ack) completed.current = null;
					const { speech, persona } = handlers.current;
					if (active.current && (!result.owner || active.current.runId !== result.runId)) {
						speech.stop();
						active.current = null;
						setLine("");
					}
					setNotice(result.runId && !result.owner ? "另一个 DSH 页面正在播出" : "");
					if (result.reply && result.owner && !active.current) {
						const reply = result.reply;
						if (reply.profileId !== persona?.profileId || audio.current?.state !== "running") {
							stop();
							setNotice("播出音频已断开，请重新启用");
						} else {
							active.current = { runId: result.runId, key: reply.key };
							setLine(reply.text.slice(0, 500));
							speech.speak(reply.text, persona.voiceId, result.runId, {
								owner: owner.current, key: reply.key,
								done: (ok) => {
									completed.current = { key: reply.key, ok };
									active.current = null;
									setLine("");
								},
							});
						}
					}
				} catch {
					if (lifecycle.signal.aborted) return;
					if (active.current && Date.now() - confirmedAt >= 3500) {
						handlers.current.speech.stop();
						active.current = null;
						setLine("");
					}
					setNotice("播出连接中断，正在重试");
				}
				if (!lifecycle.signal.aborted) timer = setTimeout(poll, 300);
			};
			poll();
			return () => {
				lifecycle.abort();
				clearTimeout(timer);
				if (active.current) handlers.current.speech.stop();
				active.current = null;
				release();
			};
		}, [armed, live, safe, persona?.profileId, release, stop]);

		const enable = async () => {
			if (armed || unlock.current || safe) return;
			const ticket = unlock.current = {};
			const deadline = AbortSignal.timeout(1500);
			try {
				const context = audio.current ??= new AudioContext();
				await Promise.race([context.resume(), new Promise((_, reject) => {
					deadline.addEventListener("abort", () => reject(deadline.reason), { once: true });
				})]);
				if (output || context.sinkId) await context.setSinkId(output);
				if (context.state !== "running") throw new Error("音频未启动");
				if (unlock.current === ticket) {
					setArmed(true);
					setNotice("");
				}
			} catch {
				if (unlock.current === ticket) setNotice("音频未启用，请点击「启用播出声音」");
			} finally {
				if (unlock.current === ticket) unlock.current = null;
			}
		};
		controls.current = { enable, stop };
		const test = () => {
			const text = "大家好，我是" + persona.name + "，现在正在测试直播声音。";
			setLine(text);
			speech.speak(text, persona.voiceId, undefined, { owner: owner.current, done: () => setLine("") });
		};
		const outputWindow = useBroadcastWindow({ safe, speaking, listening, subtitle: speaking ? line : "", captionProgress: speech.captionProgress, level: speech.level,
			profileId: persona?.profileId }, owner);
		useEffect(() => {
			publish({ speaking, listening, subtitle: speaking ? line : "", captionProgress: speech.captionProgress, mouthLevel: speech.level });
		}, [publish, speaking, listening, line, speech.level, speech.captionProgress]);

		return h("section", { className: "dfy-inline-stage", hidden: !visible, "aria-label": "插件内直播画面" },
			h("div", { className: "dfy-inline-stage-controls" },
				h("div", { className: "dfy-actions" },
					h("button", { type: "button", className: "dfy-btn", ref: stageSettingsButton,
						disabled: !settings, "aria-haspopup": "dialog", "aria-expanded": drawerOpen,
						"aria-controls": drawerOpen ? "dfy-stage-settings-drawer" : undefined,
						onClick: () => { setDrawerOpen(true); void refresh(); } }, "舞台设置"),
					h(Badge, { tone: "idle", text: layout === "landscape" ? original?.name || "横屏 · 16:9" : "竖屏 · 9:16" })),
				h("div", { className: "dfy-actions" },
					h(Btn, { tone: "primary", disabled: outputWindow.pending,
						onClick: () => outputWindow.control("open") }, outputWindow.pending ? "正在操作…" :
						outputWindow.open ? "显示播出窗口" : "打开独立播出窗口"),
					outputWindow.open ? h(Btn, { disabled: outputWindow.pending,
						onClick: () => outputWindow.control("close") }, "关闭播出窗口") : null,
					h(Badge, { tone: armed ? "ok" : "idle", text: armed ? "播出声音已启用" : "播出声音未启用" }),
					!armed && outputs.length ? h("select", { className: "dfy-select", value: output, "aria-label": "播出音频设备", onChange: (event) => setOutput(event.target.value) },
						h("option", { value: "" }, "默认音频输出"),
						outputs.map((device, i) => h("option", { key: device.deviceId, value: device.deviceId }, device.label || "音频设备 " + (i + 1)))) : null,
					armed ? h(Btn, { onClick: stop }, "暂停播出声音") :
						h(Btn, { tone: "primary", disabled: !persona || safe, onClick: enable }, "启用播出声音"),
					!live ? h(Btn, { disabled: !armed || !persona || safe || speech.phase !== "idle", onClick: test }, "试播一句") : null),
				outputWindow.notice ? h("span", { className: "dfy-caption", role: "status" }, outputWindow.notice) : null,
				notice || speech.note ? h("span", { className: "dfy-caption", role: "status" }, notice || speech.note) : null,
				h("p", { className: "dfy-stage-health", role: "status" }, health.notice)),
			h("div", { className: "dfy-inline-stage-frame" },
				h(BroadcastPicture, { persona, layout, scene: settings?.scene || preview?.scene, artwork, visible, live, safe, speaking, listening, line, captionProgress: speech.captionProgress,
					mouthLevel: speech.level, dialogue: motion.dialogue, engaged: motion.engaged, turns, onFrame: health.onFrame })),
			visible && drawerOpen && settings ? h(StageSettingsDrawer, { settings, catalog, reloadCatalog, refresh, onClose: closeDrawer }) : null);
	}

	const REPLY_SOURCE = { local_gpu: "本地模型", local_cpu: "本地模型（CPU）", cloud: "云端模型", fallback: "预设回复" };
	const FALLBACK_REASON = {
		LOCAL_UNAVAILABLE: "模型暂不可用", LOCAL_TIMEOUT: "模型响应超时", POLICY_BLOCKED: "内容受到限制",
		QUALITY_GATE_FAILED: "模型没有生成可用回复",
	};
	const TURN_STATE = { waiting: "待回复", queued: "已排队", thinking: "正在组织回复…", expired: "已过期", error: "生成中断" };
	const INTERACTION_LABEL = {
		comment: "评论", gift: "礼物", like: "点赞", join: "进房", follow: "关注", fansclub: "粉丝团", share: "分享",
	};
	const PLAYBACK = { pending: "等待播出", playing: "语音播出中", played: "已播出", failed: "播出中断", skipped: "未播出" };
	const FEED_STATE = {
		unconfigured: "尚未配置直播间或互动源", invalid: "转发源配置不完整",
		waiting: "等待直播间互动", connected: "正在接收直播互动", error: "连接中断，正在重连",
		protocol: "互动消息解析失败，正在等待新数据", browser_error: "无法启动采集 Chrome，正在重试",
		room_error: "直播间无法打开，请核对链接",
		room_offline: "抖音房间未开播或已结束，正在重试",
	};

	function replyUsage(answer) {
		if (answer.route === "fallback") return "预设回复";
		const tokens = (value) => Number.isSafeInteger(value) ? String(value) : "未返回";
		return (answer.model || "模型未记录") + " · 输入 " + tokens(answer.tokensIn) +
			" · 输出 " + tokens(answer.tokensOut) + " · 共 " + tokens(answer.tokensTotal) + " Token";
	}

	function previewTurnLabel(turn) {
		if (!turn.answer) return TURN_STATE[turn.status];
		const source = REPLY_SOURCE[turn.answer.route] || turn.answer.route;
		const detail = turn.answer.route === "fallback" ? FALLBACK_REASON[turn.answer.reasonCode] :
			turn.memoryUsed ? "参考 " + turn.memoryUsed + " 条本地记忆" : "";
		return [source, detail].filter(Boolean).join(" · ");
	}

	function PreviewConversation({ voiceId, publish, persona, samplePhrase, ensurePreview, readReplies, setReadReplies, active, live, running, onEndPreview, busy }) {
		const [text, setText] = useState("");
		const [state, setState] = useState(null);
		const [notice, setNotice] = useState("");
		const [sending, setSending] = useState(false);
		const [spoken, setSpoken] = useState(null);
		const sendingRef = useRef(false);
		const request = useRef(0);
		const answered = useRef(new Set());
		const [automaticDraft, setAutomaticDraft] = useState(null);
		const playback = useRef({ runId: undefined, seen: new Set() });
		const speech = useRoleSpeech(persona?.profileId);
		const mic = useLocalRecognition(setText);
		const sample = useRef(null);
		const scroll = useRef(null);
		const follow = useRef(true);
		const [sampleError, setSampleError] = useState(false);
		const sampleLine = (samplePhrase || "").trim() || "你好呀，这是我的互动声线。";
		const load = useCallback(async () => {
			const ticket = ++request.current;
			try {
				const result = await api("interaction");
				if (ticket !== request.current) return;
				if (!result.ok) throw new Error(result.error);
				setState(result);
				setNotice((note) => note === "互动消息暂时无法读取，正在重试" ? "" : note);
				return result.turns?.some((turn) => turn.status === "thinking" || turn.status === "queued");
			} catch {
				if (ticket === request.current) setNotice("互动消息暂时无法读取，正在重试");
			}
		}, []);
		useEffect(() => {
			let disposed = false;
			let timer;
			const poll = async () => {
				const generating = await load();
				if (!disposed) timer = setTimeout(poll, generating ? 180 : running ? 500 : 1200);
			};
			poll();
			return () => { disposed = true; clearTimeout(timer); request.current++; };
		}, [load, running]);
		useEffect(() => () => publish({ speaking: false, subtitle: "", message: null }), [publish]);

		const turns = state?.turns || [];
		const automatic = automaticDraft ?? state?.automatic ?? [];
		const canChangeAutomatic = automaticDraft === null && state?.mode === "live";
		const latest = turns.at(-1);
		const latestAnswer = turns.findLast((turn) => turn.answer);
		const busyTurn = turns.find((turn) => turn.status === "thinking");
		const activeTurn = speech.phase === "idle" ?
			busyTurn || (latest?.status === "queued" ? latest : null) : spoken;
		const caption = activeTurn?.answer?.text || "";
		useEffect(() => {
			publish({ speaking: speech.phase === "speaking", listening: mic.phase === "listening" || !!busyTurn || speech.phase === "pending",
				subtitle: caption.slice(0, 500), captionProgress: speech.captionProgress, mouthLevel: speech.level, message: activeTurn });
		}, [publish, speech.phase, speech.level, speech.captionProgress, mic.phase, !!busyTurn, caption, activeTurn?.id, activeTurn?.text, activeTurn?.author]);
		useEffect(() => {
			if (follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
		}, [latest?.id, latestAnswer?.id, busyTurn?.id, busyTurn?.draft]);

		const play = (turn) => {
			playback.current.seen.add(turn.answer.playbackKey);
			setSpoken(turn);
			sample.current?.pause();
			speech.speak(turn.answer.text, voiceId, state?.id || undefined);
		};
		useEffect(() => {
			if (!state) return;
			if (live) {
				if (playback.current.runId !== state.id) {
					speech.stop();
					setSpoken(null);
					playback.current = { runId: state.id, seen: new Set() };
				}
				return;
			}
			const queue = playback.current;
			if (queue.runId !== state.id) {
				if (queue.runId) {
					speech.stop();
					setSpoken(null);
				}
				const previous = queue.runId === undefined ? turns.flatMap((turn) => turn.answer ? [turn.answer.playbackKey] : []) : [];
				playback.current = { runId: state.id, seen: new Set(previous) };
				answered.current.clear();
				if (queue.runId) return;
			}
			const seen = playback.current.seen;
			const keys = new Set(turns.flatMap((turn) => turn.answer ? [turn.answer.playbackKey] : []));
			for (const key of seen) if (!keys.has(key)) seen.delete(key);
			if (!readReplies) {
				for (const key of keys) seen.add(key);
				return;
			}
			if (speech.phase !== "idle" || mic.phase !== "idle") return;
			const next = turns.find((turn) => turn.answer && !seen.has(turn.answer.playbackKey));
			if (next) play(next);
		}, [state, live, readReplies, speech.phase, mic.phase]);

		const reply = async (turn) => {
			if (answered.current.has(turn.id)) return;
			answered.current.add(turn.id);
			try {
				const result = await api("interaction/reply", { id: turn.id });
				if (!result.ok) throw new Error(result.error || "无法回复弹幕");
				setNotice("");
				await load();
			} catch (error) {
				setNotice(error.message || "无法回复弹幕");
			} finally {
				answered.current.delete(turn.id);
			}
		};
		const toggleAutomatic = async (kind) => {
			const enabled = state?.automatic || [];
			const kinds = enabled.includes(kind) ? enabled.filter((item) => item !== kind) : [...enabled, kind];
			setAutomaticDraft(kinds);
			try {
				const result = await api("interaction/automatic", { kinds });
				if (!result.ok) throw new Error(result.error);
				await load();
			} catch (error) {
				setNotice(error.message || "自动回复设置失败");
			} finally {
				setAutomaticDraft(null);
			}
		};
		const replay = async (turn) => {
			try {
				const result = await api("interaction/replay", { id: turn.id });
				if (!result.ok) throw new Error(result.error);
				await load();
			} catch (error) { setNotice(error.message || "无法重新播出"); }
		};


		const send = async (event) => {
			event.preventDefault();
			const message = text.trim();
			if (!message || sendingRef.current || mic.phase !== "idle") return;
			sendingRef.current = true;
			setSending(true);
			setNotice("");
			sample.current?.pause();
			try {
				await ensurePreview();
				const result = await api("interaction/send", { text: message });
				if (!result.ok) throw new Error(result.error || "发送失败");
				setText((draft) => draft.trim() === message ? "" : draft);
				follow.current = true;
				await load();
			} catch (error) {
				setNotice(error.message || "发送失败，请重试");
			} finally {
				sendingRef.current = false;
				setSending(false);
			}
		};

		return h("section", { className: "dfy-preview-conversation", "aria-label": "主播互动" },
			h("div", { className: "dfy-interaction-head" },
				h("h3", null, "主播互动"),
				live ? h("span", { className: "dfy-turn-meta", role: "status" }, FEED_STATE[state?.danmaku] || FEED_STATE.waiting) :
				active ? h(Btn, { tone: "ghost", disabled: busy || sending, onClick: onEndPreview }, "结束本地对话") : null),
			live && !state?.stageReady ? h("p", { className: "dfy-caption" }, "在「直播画面」启用声音后，回复会自动播出。") : null,
			live ? h("div", { className: "dfy-desk-speak-options" },
				h("label", null, h("input", { type: "checkbox", checked: automatic.includes("comment"), disabled: !canChangeAutomatic,
					onChange: () => toggleAutomatic("comment") }), "自动回复评论"),
				h("details", { className: "dfy-details" },
					h("summary", null, "其他互动自动回复"),
					h("fieldset", { className: "dfy-event-options", "aria-label": "其他自动回复类型", disabled: !canChangeAutomatic },
						Object.entries(INTERACTION_LABEL).filter(([kind]) => kind !== "comment").map(([kind, label]) =>
							h("label", { key: kind }, h("input", { type: "checkbox", checked: automatic.includes(kind),
								onChange: () => toggleAutomatic(kind) }), label))))) : null,
			h("ol", { className: "dfy-turns", ref: scroll, "aria-label": "消息与主播回复", tabIndex: 0,
				onScroll: (event) => {
					const el = event.currentTarget;
					follow.current = el.scrollHeight - el.clientHeight - el.scrollTop < 25;
				} },
				!turns.length ? h("li", { className: "dfy-turn-meta" }, live ? "等待操作员消息或直播弹幕" : "发送一条消息，开始和主播对话") : null,
				turns.map((turn) => h("li", { key: turn.id },
					h("div", { className: "dfy-turn-head" },
						h("strong", null, turn.author),
						turn.source === "danmaku" ? h("span", { className: "dfy-turn-meta" }, INTERACTION_LABEL[turn.kind] || "评论") : null,
						h("time", { dateTime: turn.sentAt }, new Date(turn.sentAt).toLocaleTimeString("zh-CN"))),
					h("p", { className: "dfy-turn-text" }, turn.text),
					turn.answer ? h("div", { className: "dfy-turn-answer" },
						h("span", { className: "dfy-turn-meta" }, (persona?.name || "主播") + " · " + previewTurnLabel(turn)),
						turn.answer.route !== "fallback" ? h("span", { className: "dfy-turn-meta" }, replyUsage(turn.answer)) : null,
						h("p", { className: "dfy-turn-text" }, turn.answer.text),
						live ? h("div", { className: "dfy-turn-head" },
							h("span", { className: "dfy-turn-meta" }, PLAYBACK[turn.playback]),
							["failed", "played", "skipped"].includes(turn.playback) ? h(Btn, { tone: "ghost", onClick: () => replay(turn) }, "在舞台重播") : null)
							: h(Btn, { tone: "ghost", disabled: speech.phase !== "idle" || mic.phase !== "idle",
								onClick: () => play(turn) }, "朗读回复")) :
						turn.draft ? h("div", { className: "dfy-turn-answer", "aria-busy": true },
							h("span", { className: "dfy-turn-meta" }, (persona?.name || "主播") + " · 正在回复"),
							h("p", { className: "dfy-turn-text" }, turn.draft)) :
						h("div", { className: "dfy-turn-head" },
							h("span", { className: "dfy-turn-meta" }, previewTurnLabel(turn)),
							turn.status === "waiting" ? h(Btn, { tone: "ghost", onClick: () => reply(turn) }, "让主播回复") : null)))),
			h("form", { onSubmit: send, "aria-busy": sending },
				h(Field, { label: "发消息给主播" }, h("textarea", { rows: 2, maxLength: 500, value: text,
					onChange: (event) => setText(event.target.value), placeholder: "输入文字，或点麦克风转写",
					onKeyDown: (event) => {
						if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229) return;
						event.preventDefault();
						event.currentTarget.form.requestSubmit();
					} })),
				h("div", { className: "dfy-desk-speak-options dfy-actions" },
					h("button", { type: "submit", className: "dfy-btn dfy-btn-pri", disabled: !text.trim() || sending || mic.phase !== "idle" },
						sending ? "正在发送…" : "发送"),
					mic.phase === "idle"
						? h(Btn, { disabled: speech.phase !== "idle", onClick: () => { sample.current?.pause(); mic.start(); } }, "麦克风")
						: h(Btn, { disabled: mic.phase === "stopping", onClick: mic.stop }, mic.phase === "checking" ? "取消识别" : "结束识别"),
					!live ? h("label", null, h("input", { type: "checkbox", checked: readReplies,
						onChange: (event) => {
							setReadReplies(event.target.checked);
							if (!event.target.checked && speech.phase !== "idle") speech.stop();
						} }), "自动朗读") : null,
					speech.phase !== "idle" ? h(Btn, { onClick: speech.stop }, "停止朗读") : null)),
			h("p", { className: "dfy-caption", role: "status" }, notice || mic.note || speech.note || (busyTurn ? "主播正在组织回复…" : "")),
			!live ? h("details", { className: "dfy-details" }, h("summary", null, "声音试听"),
				persona?.media?.sampleAudioUrl ? h("div", { className: "dfy-role-audio" },
					h("span", { className: "dfy-caption" }, "官方录音"),
					h("audio", { ref: sample, controls: true, preload: "none", src: persona.media.sampleAudioUrl,
						"aria-label": persona.name + "的官方录音", onPlay: () => { if (speech.phase !== "idle") speech.stop(); },
						onError: () => setSampleError(true) }),
					sampleError ? h("p", { className: "dfy-caption", role: "status" }, "官方录音暂不可用") : null) : null,
				h(Btn, { disabled: speech.phase !== "idle" || mic.phase !== "idle",
					onClick: () => { sample.current?.pause(); setSpoken(null); speech.speak(sampleLine, voiceId); } }, "试听互动声线")) : null);
	}

	function Workbench({ status, act, busy, pending, settings, preview, catalog, reloadPreview, refresh, goTab, connected, emergency, liveCaption }) {
		const [selection, setSelection] = useState(null);
		const [modelNote, setModelNote] = useState("");
		const [caption, setCaption] = useState({ speaking: false, subtitle: "" });
		const [readReplies, setReadReplies] = useState(true);
		const saving = useRef(false);
		const selected = settings?.persona;
		useEffect(() => {
			if (status?.personaReady && selected?.profileId && ROLE_BROWSER_VOICES[selected.profileId]) {
				api("preview/role-speech/warm", {}).catch(() => {});
			}
		}, [selected?.profileId, status?.personaReady]);

		const persona = selection || preview?.persona;
		const profiles = settings?.catalogs?.profiles || [];
		const models = catalog?.models || [];
		const roleMedia = persona?.media;
		const sceneUrl = roleMedia && catalog?.scenes?.includes(roleMedia.modelId)
			? "/api/dafeiyu/avatar/scene?id=" + encodeURIComponent(roleMedia.modelId) : undefined;
		const installed = models.find((model) => model.id === roleMedia?.modelId);
		const runtimeReady = catalog && Object.values(catalog.vendors).every(Boolean);
		const entry = runtimeReady ? installed : null;
		const prototype = catalog?.prototypes?.includes(roleMedia?.modelId);
		const rigged = catalog?.rigged?.includes(roleMedia?.modelId);
		const fallback = installed && !runtimeReady ? "Live2D 运行时缺失" : "";

		const locked = ["self_check", "awaiting_platform", "stream_established", "live_confirmed", "ending"].includes(status?.liveStatus);
		const safe = emergency || status?.liveStatus === "safe_scene";
		const editable = connected && !!status && !locked && !pending.startsWith("live/") && pending !== "preview/stop" && !safe;
		const active = status?.liveStatus === "local_preview";
		const live = status?.liveStatus === "live_confirmed";
		const canInteract = connected && status?.personaReady && !safe && !selection && !pending.startsWith("live/") &&
			pending !== "preview/stop" && (live || editable);
		const save = async (patch, next) => {
			if (saving.current || !editable) return;
			saving.current = true;
			setModelNote("");
			setSelection(next);
			try {
				const result = await api("settings/persona", patch);
				if (!result.ok) throw new Error(result.error);
				await Promise.all([reloadPreview(), refresh()]);
			} catch (error) {
				setModelNote(error.message || "保存失败，已恢复上次选择");
			} finally {
				saving.current = false;
				setSelection(null);
			}
		};
		const selectProfile = (id) => {
			const profile = profiles.find((item) => item.id === id);
			if (!profile) return;
			save({ profileId: id, personaName: profile.name }, { ...persona, ...profile, profileId: id, media: profile.media || null });
		};
		const ensurePreview = async () => {
			if (live || active) return;
			if (!editable || selection || saving.current || !status.personaReady) throw new Error("请先完成角色配置");
			const result = await api("preview/start", {});
			if (!result.ok || result.status?.liveStatus !== "local_preview") throw new Error(result.error || "当前无法进入本地预览");
			refresh(true);
		};
		const officialUrl = preview?.officialClientUrl || settings?.platform?.officialClientUrl;

		const interactionHint = safe ? "恢复本地预览后即可继续互动。" :
			!connected ? "连接恢复后即可继续互动。" :
			!status ? "正在连接直播服务…" :
			!status.personaReady ? "配置角色后即可发送消息。" :
			selection ? "正在切换角色…" : "等待直播状态切换。";

		return h("div", { className: "dfy-workbench" },
			h(WorkbenchControls, { status, act, busy: busy || !!selection, goTab, officialUrl, connected }),
			h("div", { className: "dfy-workbench-grid" },
				h("section", { className: "dfy-desk-preview", "aria-label": "实时预览" },
					h("div", { className: "dfy-desk-stage-head" },
						h("h3", null, "实时预览"),
						profiles.length && persona ? h("select", { className: "dfy-select", value: persona.profileId,
							"aria-label": "预览角色", disabled: !editable || !!selection, onChange: (event) => selectProfile(event.target.value) },
							profiles.map((profile) => h("option", { key: profile.id, value: profile.id }, profile.name))) : null),
					selection || modelNote ? h("p", { className: "dfy-desk-inline", role: "status" }, modelNote || "正在保存…") : null,
					safe ? h("div", { className: "dfy-desk-safe" },
						h("strong", null, "安全场景"), h("span", null, "预览语音和动作已停止"),
						!emergency && connected && status?.personaReady ? h(Btn, { disabled: busy,
							onClick: () => act("preview/start", { resume: true }, "恢复本地预览") }, "恢复本地预览") : null,
						h("span", { className: "dfy-pet-ai" }, persona?.aiLabelText || "AI 生成内容")) :
						roleMedia ? h(PreviewCanvas, { preview: { ...preview, persona }, entry, sceneUrl, prototype, rigged, fallback, ...(live ? { ...caption, ...liveCaption } : caption) }) :
							h("div", { className: "dfy-desk-safe" }, persona?.name || (preview ? "配置角色后可预览" : "正在加载预览…"))),
				canInteract && persona ? h(PreviewConversation, {
					key: persona.profileId, persona, voiceId: persona.voiceId, samplePhrase: selected?.samplePhrase, publish: setCaption,
					ensurePreview, readReplies, setReadReplies, active, live, running: live || active,
					onEndPreview: () => act("preview/stop", {}, "结束本地对话"), busy,
				}) : h("section", { className: "dfy-interaction-placeholder" },
					h("h3", null, "主播互动"), h("p", { className: "dfy-muted" }, interactionHint))));
	}

	// ------------------------------------------------------------------ 训练与学习

	const TRAIN_STATUS = {
		checking_samples: "检查样本", waiting_resource: "等待资源", training: "训练中", verifying: "验证中",
		canary: "小范围采用", published: "已发布", insufficient_samples: "样本不足", verification_failed: "验证未通过",
		cancelled: "已取消", learning_paused: "学习已暂停",
	};
	const RUN_STATUS = {
		pending: "排队", prepare_cpu: "准备CPU", drain_gpu: "释放GPU", train_slice: "训练切片", checkpoint: "保存检查点",
		release_gpu: "归还GPU", warmup_champion: "回热主力", completed: "完成", failed: "失败", cancelled: "取消",
	};

	function TrainingTab({ status, act, busy }) {
		const [data, setData] = useState(null);
		const load = useCallback(async () => {
			const r = await api("training/progress");
			if (r.ok) setData(r);
		}, []);
		useEffect(() => {
			load();
			const timer = setInterval(() => { if (!document.hidden) load(); }, 2500);
			return () => clearInterval(timer);
		}, [load]);
		return h("div", { className: "dfy-form-card" },
			h(Card, { title: "训练记录", extra: h(Btn, { tone: "ghost", onClick: load }, "刷新") },
				h(Row, { label: "训练机会", value: data ? (data.opportunity.admit ? "样本/资源/政策门通过" : data.opportunity.detail) : "—" }),
				h(Row, { label: "学习状态", value: status ? (status.learningPaused ? "已暂停" : "观察学习中") : "—" }),
				data && data.lastEntry ? h(Row, { label: "上次训练", value: (TRAIN_STATUS[data.lastEntry.status] || data.lastEntry.status) + "：" + data.lastEntry.detail }) : null,
				data && data.latestRun ? h(Row, { label: "最近窗口", value: (RUN_STATUS[data.latestRun.status] || data.latestRun.status) + " · " + data.latestRun.optimizer_steps + " 步" }) : null,
				h("div", { className: "dfy-actions" },
					h(Btn, { tone: "primary", disabled: busy || !status || !status.trainingEligible || status.learningPaused, onClick: async () => { await act("training/train-once", {}, "运行训练演练"); load(); } }, "运行训练演练"),
					h(Btn, { disabled: busy || !status, onClick: async () => { await act(status?.learningPaused ? "learning/resume" : "learning/pause", {}, "切换学习状态"); load(); } }, status?.learningPaused ? "恢复学习" : "暂停学习")),
				h("details", { className: "dfy-details" },
					h("summary", null, "训练条件"),
					h(Row, { label: "样本", value: "至少 32 条非重复合格样本" }),
					h(Row, { label: "显存", value: "足够覆盖峰值和预留量" }),
					h("p", { className: "dfy-caption", style: { margin: 0 } }, "直播期间在资源空闲时训练。通过验证后才可发布候选版本。"))));
	}

	// ------------------------------------------------------------------ 互动与账本

	const FB_LABEL = { useful: "有用", wrong: "答错", off_persona: "不像大肥鱼", too_slow: "响应太慢", not_remembered: "不该记住", complaint: "投诉", privacy: "隐私" };
	const FB_STATUS = { received: "已收到", verifying: "核实中", resolved: "已修复", insufficient_evidence: "证据不足" };
	const SETTLE = { received: "已收到", pending_settlement: "待结算", settled: "已结算", refunded: "退款", reversed: "冲正" };

	function ReplyHistory({ refresh }) {
		const [data, setData] = useState(null);
		const [error, setError] = useState("");
		const [note, setNote] = useState("");
		const request = useRef(0);
		const load = useCallback(async () => {
			const ticket = ++request.current;
			try {
				const result = await api("replies");
				if (ticket !== request.current) return;
				if (!result.ok) throw new Error(result.error);
				setData(result);
				setError("");
			} catch (error) {
				if (ticket === request.current) setError("回复记录读取失败 · " + error.message);
			}
		}, []);
		useEffect(() => {
			let disposed = false;
			let timer;
			const poll = async () => {
				if (!document.hidden) await load();
				if (!disposed) timer = setTimeout(poll, 1200);
			};
			poll();
			return () => { disposed = true; clearTimeout(timer); request.current++; };
		}, [load]);

		const send = async (reply, label) => {
			const correction = label === "wrong" ? window.prompt("正确说法（选填）：") : "";
			if (correction === null) return;
			try {
				const r = await api("feedback", { targetReplyId: reply.requestId, label, correction: correction || undefined });
				if (!r.ok) throw new Error(r.error);
				setNote("反馈已提交 · " + FB_STATUS[r.result.status]);
				await Promise.all([load(), refresh(true)]);
			} catch (error) { setNote("反馈提交失败 · " + error.message); }
		};

		return h(Card, { title: "最近回复", extra: h(Btn, { tone: "ghost", onClick: load }, "刷新") },
			note || error ? h("p", { className: "dfy-caption", role: "status", style: { margin: 0 } }, error || note) : null,
			h("div", { className: "dfy-list" },
				data === null ? (error ? null : h(Loading, null)) : data.replies.length === 0 ? h("p", { className: "dfy-muted", style: { margin: 0 } }, "有播出回复后，这里会显示最近 50 条。") : null,
				(data ? data.replies : []).map((r) => h("div", { key: r.replyId, className: "dfy-item" },
					h("div", { className: "dfy-item-h" },
						h("span", { className: "dfy-caption" }, "问"),
						h("span", { className: "dfy-item-t", title: r.question }, r.question),
						h(Badge, { tone: "idle", text: REPLY_SOURCE[r.route] || r.route })),
					r.route !== "fallback" ? h("div", { className: "dfy-item-sub dfy-muted" }, replyUsage(r)) : null,
					h("div", { className: "dfy-item-sub" }, "答：" + r.reply),
					h("details", { className: "dfy-details" },
							h("summary", null, "评价回复"),
							h("div", { className: "dfy-pills" },
								["useful", "wrong", "off_persona", "too_slow"].map((lb) => h("button", {
									key: lb, type: "button", className: "dfy-pill", onClick: () => send(r, lb),
								}, FB_LABEL[lb])))),
						r.feedback.length > 0 ? h("span", { className: "dfy-caption" },
							r.feedback.map((f) => FB_LABEL[f.label] + " · " + FB_STATUS[f.status]).join("，")) : null))));
	}

	function FeedbackTab({ refresh }) {
		const [fbs, setFbs] = useState(null);
		const [note, setNote] = useState("");
		const load = useCallback(async () => {
			try {
				const r = await api("feedback");
				if (!r.ok) throw new Error(r.error);
				setFbs(r);
			} catch (error) { setNote("反馈读取失败 · " + error.message); }
		}, []);
		useEffect(() => { load(); }, [load]);
		const advance = async (feedbackId, next, label) => {
			try {
				const r = await api("feedback/advance", { feedbackId, next });
				if (!r.ok) throw new Error(r.error);
				setNote("反馈已更新 · " + label);
				await Promise.all([load(), refresh(true)]);
			} catch (error) { setNote("反馈更新失败 · " + error.message); }
		};

		return h(Card, { title: "反馈处理", extra: h(Btn, { tone: "ghost", onClick: load }, "刷新") },
			note ? h("p", { className: "dfy-caption", role: "status", style: { margin: 0 } }, note) : null,
			fbs === null ? (note ? null : h(Loading, null)) : fbs.feedback.length === 0 ? h("p", { className: "dfy-muted", style: { margin: 0 } }, "暂无反馈") : null,
			h("div", { className: "dfy-list" },
				(fbs ? fbs.feedback : []).map((f) => h("div", { key: f.feedbackId, className: "dfy-item" },
					h("div", { className: "dfy-item-h" },
						h("span", { className: "dfy-item-t" }, FB_LABEL[f.label] || f.label),
						h(Badge, { tone: f.status === "resolved" ? "ok" : f.status === "received" ? "warn" : "idle", text: FB_STATUS[f.status] || f.status })),
					h("div", { className: "dfy-item-sub dfy-muted" }, f.correction ? "纠正：" + f.correction : (f.targetReplyId ? "已关联回复" : "片段级（未定位具体回复）")),
					h("div", { className: "dfy-pills" },
						f.status === "received" ? h("button", { type: "button", className: "dfy-pill", onClick: () => advance(f.feedbackId, "verifying", "核实中") }, "开始核实") : null,
						f.status === "verifying" ? h("button", { type: "button", className: "dfy-pill", onClick: () => advance(f.feedbackId, "resolved", "已修复") }, "已修复") : null,
						f.status === "verifying" ? h("button", { type: "button", className: "dfy-pill", onClick: () => advance(f.feedbackId, "insufficient_evidence", "证据不足") }, "证据不足") : null)))));
	}

	function GiftsTab() {
		const [gifts, setGifts] = useState(null);
		const [note, setNote] = useState("");
		const [nameMentionDraft, setNameMentionDraft] = useState(null);
		const saving = nameMentionDraft !== null;
		const load = useCallback(async () => {
			try {
				const r = await api("gifts/summary");
				if (!r.ok) throw new Error(r.error);
				setGifts(r);
			} catch (error) { setNote("礼物账本读取失败 · " + error.message); }
		}, []);
		useEffect(() => { load(); }, [load]);
		const save = async (nameMention) => {
			setNameMentionDraft(nameMention);
			setNote("正在保存答谢设置…");
			try {
				const r = await api("settings/gifts", { nameMention });
				if (!r.ok) throw new Error(r.error);
				setGifts((current) => ({ ...current, ackSettings: r.value }));
				setNote("已更新答谢设置");
			} catch (error) { setNote("答谢设置保存失败 · " + error.message); }
			finally { setNameMentionDraft(null); }
		};
		return h("div", { className: "dfy-settings-stack" },
			note ? h("p", { className: "dfy-caption", role: "status", style: { margin: 0 } }, note) : null,
			!gifts ? (note ? h(Btn, { onClick: load }, "重试") : h(Loading)) : h(Card, { title: "礼物账本", extra: h(Btn, { tone: "ghost", disabled: saving, onClick: load }, "刷新") },
				h("div", { className: "dfy-kpis", style: { gridTemplateColumns: "repeat(auto-fit,minmax(88px,1fr))" } },
					h(Kpi, { label: "收到", value: String(gifts.totals.receivedQty) }),
					h(Kpi, { label: "待结算", value: String(gifts.totals.pendingSettlementQty) }),
					h(Kpi, { label: "已结算", value: String(gifts.totals.settledQty) }),
					h(Kpi, { label: "退款", value: String(gifts.totals.refundedQty) }),
					h(Kpi, { label: "未验证", value: String(gifts.totals.unverifiedCount) })),
				h("label", { className: "dfy-check" },
					h("input", { type: "checkbox", disabled: saving, checked: nameMentionDraft ?? gifts.ackSettings.nameMention, onChange: (e) => save(e.target.checked) }),
					h("span", null, "答谢时称呼观众")),
				h("div", { className: "dfy-list" },
					gifts.entries.map((e) => h("div", { key: e.entry_id, className: "dfy-item-h" },
						h("span", { className: "dfy-item-t" }, e.gift_id + " ×" + e.quantity_delta),
						h(Badge, { tone: e.verification_status === "verified" ? "ok" : "warn", text: e.verification_status === "verified" ? "已验证" : "未验证" }),
						h("span", { className: "dfy-caption", style: { marginLeft: "auto" } }, SETTLE[e.settlement_status] || e.settlement_status)))),
				h("p", { className: "dfy-caption", style: { margin: 0 } }, gifts.notes.join("；"))));
	}

	// ------------------------------------------------------------------ 观众画像（§6.4）

	const PRIVACY_KIND = { view: "查看", correction: "纠错", personalization_off: "退出个性化", deletion: "删除", export: "导出" };
	const PRIVACY_STATUS = { received: "已受理", verifying: "核实中", resolved: "已办结", rejected: "已驳回" };
	const CONFIDENCE = { observed: "观察", inferred: "推测", viewer_stated: "观众明确" };

	function AudienceTab() {
		const [overview, setOverview] = useState(null);
		const [detail, setDetail] = useState(null);
		const [note, setNote] = useState("");
		const load = useCallback(async () => {
			const r = await api("audience/overview");
			if (r.ok) setOverview(r);
		}, []);
		useEffect(() => { load() }, [load]);

		const openViewer = async (viewerKey) => {
			setNote("加载画像…");
			const r = await api("audience/profile?viewer=" + encodeURIComponent(viewerKey));
			if (r.ok) { setDetail(r); setNote(""); } else setNote("加载失败：" + r.error);
		};
		const correction = async (viewerKey) => {
			const fieldName = window.prompt("纠错字段名（如 favorite_topic）：");
			if (!fieldName) return;
			const value = window.prompt("观众明确的说法：");
			if (!value) return;
			const r = await api("audience/correction", { viewerKey: viewerKey, fieldName: fieldName, value: value });
			setNote(r.ok ? "纠错已记录（viewer_stated 覆盖推测，保留审计链）" : "失败：" + r.error);
			if (r.ok && detail) openViewer(viewerKey);
		};
		const actViewer = async (path, body, label) => {
			const r = await api(path, body);
			setNote(r.ok ? label + " 完成" + (r.result && r.result.detail ? "：" + r.result.detail : "") : label + " 失败：" + r.error);
			await load();
			if (detail) openViewer(detail.summary.viewerKey);
		};

		const d = detail;
		const pendingDeletion = d ? d.requests.find((r) => r.kind === "deletion" && r.status === "received") : null;
		return h("div", { className: "dfy-grid" },
			h(Card, { title: "观众（伪名化身份）", extra: h(Btn, { tone: "ghost", onClick: load }, "刷新") },
				note ? h("p", { className: "dfy-caption", style: { margin: 0 } }, note) : null,
				overview === null ? h(Loading, null) : null,
				overview && overview.viewers.length === 0 ? h("p", { className: "dfy-muted", style: { margin: 0 } }, "暂无观众画像（授权事件到达后建立）") : null,
				overview ? h(Row, { label: "墓碑数（已删除）", value: String(overview.tombstoneCount) }) : null,
				overview && overview.viewers.length > 0 ? h("div", { className: "dfy-choice" },
					overview.viewers.map((v) => h("button", {
						key: v.viewerKey, type: "button", className: "dfy-chip" + (d && d.summary.viewerKey === v.viewerKey ? " dfy-chip-on" : ""),
						onClick: () => openViewer(v.viewerKey),
					}, v.nickname || v.viewerKey.slice(0, 12), v.deletionStatus !== "active" ? h(Badge, { tone: "err", text: v.deletionStatus === "deleted" ? "已删除" : "删除中" }) : null))) : null,
				overview && overview.requests.length > 0 ? h("div", null,
					h("p", { className: "dfy-caption", style: { margin: "8px 0 4px" } }, "最近权利请求"),
					h("div", { className: "dfy-list" },
						overview.requests.map((r) => h("div", { key: r.requestId, className: "dfy-item-h" },
							h("span", { className: "dfy-item-t" }, PRIVACY_KIND[r.kind] || r.kind),
							h("span", { className: "dfy-caption", style: { marginLeft: "auto" } }, PRIVACY_STATUS[r.status] || r.status))))) : null,
				overview ? h("p", { className: "dfy-caption", style: { margin: 0 } }, overview.notes.join("；")) : null),
			d ? h(Card, { title: "画像详情", extra: h(Badge, { tone: d.summary.deleted ? "err" : "ok", text: d.summary.deleted ? "已删除" : "在册" }) },
				h(Row, { label: "伪名键", value: d.summary.viewerKey.slice(0, 22) + "…", mono: true }),
				h(Row, { label: "首次互动", value: (d.summary.firstSeenAt || "—").slice(0, 16).replace("T", " ") }),
				h(Row, { label: "最近互动", value: (d.summary.lastSeenAt || "—").slice(0, 16).replace("T", " ") }),
				h(Row, { label: "互动聚合", value: Object.keys(d.interactions).length === 0 ? "无" : Object.entries(d.interactions).map(([k, n]) => k + "×" + n).join("，") }),
				h("div", { className: "dfy-list" },
					d.fields.length === 0 ? h("p", { className: "dfy-muted", style: { margin: 0 } }, "无当前有效字段") : null,
					d.fields.map((f) => h("div", { key: f.fieldId, className: "dfy-item" },
						h("div", { className: "dfy-item-h" },
							h("span", { className: "dfy-item-t" }, f.fieldName),
							h(Badge, { tone: f.confidenceKind === "viewer_stated" ? "ok" : f.confidenceKind === "inferred" ? "warn" : "idle", text: CONFIDENCE[f.confidenceKind] || f.confidenceKind })),
						h("div", { className: "dfy-item-sub" }, f.value),
						h("div", { className: "dfy-caption" }, "用途 " + f.purpose + " · 来源 " + f.sourceEventIds.length + " 条")))),
				h("div", { className: "dfy-actions" },
					h(Btn, { onClick: () => correction(d.summary.viewerKey) }, "纠错"),
					h(Btn, { onClick: () => actViewer("audience/personalization-off", { viewerKey: d.summary.viewerKey }, "退出个性化") }, "退出个性化"),
					pendingDeletion
						? h(Btn, { tone: "danger", onClick: () => actViewer("audience/deletion-execute", { requestId: pendingDeletion.requestId, viewerKey: d.summary.viewerKey, verificationPassed: true }, "执行删除") }, "执行删除（已验证身份）")
						: h(Btn, { onClick: () => actViewer("audience/deletion-request", { viewerKey: d.summary.viewerKey }, "提交删除申请") }, "提交删除申请")),
				h("p", { className: "dfy-caption", style: { margin: 0 } }, "删除为两步流：提交申请 → 验证观众身份后执行（落墓碑，查询即过滤）。")) : null);
	}

	// ------------------------------------------------------------------ 治理（技能/记忆/发布/审计）

	const SKILL_STATUS_CN = { draft: "草稿", validated: "已验证", staged: "已暂存", canary: "灰度", active: "生效", suspended: "已暂停", superseded: "已替代" };
	const MEMORY_STATUS_CN = { proposed: "假设中", validated: "已验证", active: "生效", challenged: "被质疑", expired: "已过期", superseded: "被替代" };
	const RELEASE_STATUS_CN = { candidate: "候选", rejected: "已拒绝", staged: "已暂存", canary: "灰度", active: "生效", suspended: "已暂停", rolled_back: "已回滚", retired: "已退役" };

	function GovernanceTab({ status, act, busy }) {
		const [data, setData] = useState(null);
		const load = useCallback(async () => {
			const [s, m, r, a] = await Promise.all([
				api("governance/skills"), api("governance/memory"), api("governance/releases"), api("governance/audit"),
			]);
			if (s.ok && m.ok && r.ok && a.ok) {
				setData({ skills: s.skills, memories: m.memories, memoryNotes: m.notes, active: r.activeReleaseId, releases: r.releases, audits: a.audits, decisions: a.decisions, auditNotes: a.notes });
			}
		}, []);
		useEffect(() => { load() }, [load]);
		return h("div", { className: "dfy-grid" },
			h(Card, { title: "技能库", extra: h(Btn, { tone: "ghost", onClick: load }, "刷新") },
				data === null ? h(Loading, null) : null,
				data && data.skills.length === 0 ? h("p", { className: "dfy-muted", style: { margin: 0 } }, "无已注册技能") : null,
				h("div", { className: "dfy-list" },
					(data ? data.skills : []).map((s) => h("div", { key: s.skillId + "@" + s.version, className: "dfy-item" },
						h("div", { className: "dfy-item-h" },
							h("span", { className: "dfy-item-t" }, s.skillId),
							h("span", { className: "dfy-caption" }, "v" + s.version),
							h(Badge, { tone: s.status === "active" ? "ok" : "idle", text: SKILL_STATUS_CN[s.status] || s.status })),
						h("div", { className: "dfy-caption", title: s.description || "" }, (s.kind || "—") + " · 权限 " + s.permissions + (s.description ? " · " + s.description : "")))))),
			h(Card, { title: "记忆候选（L2/L4）" },
				data && data.memories.length === 0 ? h("p", { className: "dfy-muted", style: { margin: 0 } }, "暂无记忆候选") : null,
				h("div", { className: "dfy-list" },
					(data ? data.memories : []).slice(0, 20).map((m) => h("div", { key: m.id + "@" + m.revision, className: "dfy-item" },
						h("div", { className: "dfy-item-h" },
							h("span", { className: "dfy-item-t", title: m.claim }, m.claim),
							h(Badge, { tone: m.status === "active" ? "ok" : m.status === "challenged" ? "err" : "idle", text: MEMORY_STATUS_CN[m.status] || m.status })),
						h("div", { className: "dfy-caption" }, m.layer + " · 证据 " + m.supportingEvidence.length + "/" + m.counterEvidence.length + " · " + m.scene + " · 复核 " + m.reviewAfter.slice(0, 10))))),
				data ? h("p", { className: "dfy-caption", style: { margin: 0 } }, data.memoryNotes.join("；")) : null),
			h(Card, { title: "发布链", extra: status && status.activeReleaseId ? h(Badge, { tone: "ok", text: status.activeReleaseId }) : h(Badge, { tone: "idle", text: "基线" }) },
				data && data.releases.length === 0 ? h("p", { className: "dfy-muted", style: { margin: 0 } }, "暂无发布记录（基线运行）") : null,
				h("div", { className: "dfy-list" },
					(data ? data.releases : []).map((r) => h("div", { key: r.release_id, className: "dfy-item-h" },
						h("span", { className: "dfy-item-t" }, r.release_id),
						r.canary_fraction > 0 && r.canary_fraction < 1 ? h("span", { className: "dfy-caption" }, "灰度 " + Math.round(r.canary_fraction * 100) + "%") : null,
						h("span", { style: { marginLeft: "auto" } }, h(Badge, { tone: r.release_id === (data && data.active) ? "ok" : r.status === "rolled_back" ? "err" : "idle", text: RELEASE_STATUS_CN[r.status] || r.status }))))),
				h("div", { className: "dfy-actions" },
					h(Btn, { disabled: busy || !status || !status.activeReleaseId, onClick: async () => { await act("release/rollback", {}, "恢复稳定版本"); await load(); } }, "恢复稳定版本"))),
			h(Card, { title: "审计与决策" },
				data && data.decisions.length > 0 ? h("div", { className: "dfy-list" },
					data.decisions.map((x) => h("div", { key: x.decision_id, className: "dfy-item-h" },
						h("span", { className: "dfy-item-t", title: x.decision_id }, x.action),
						h("span", { className: "dfy-caption", style: { marginLeft: "auto" } }, x.result)))) : null,
				data && data.audits.length > 0 ? h("div", { className: "dfy-list" },
					data.audits.slice(0, 12).map((a) => h("div", { key: a.audit_id, className: "dfy-item-sub dfy-caption" },
						a.created_at.slice(5, 16).replace("T", " ") + " · " + a.action + " · " + a.summary))) : h("p", { className: "dfy-muted", style: { margin: 0 } }, "暂无审计事件"),
				data ? h("p", { className: "dfy-caption", style: { margin: 0 } }, data.auditNotes.join("；")) : null));
	}

	// ------------------------------------------------------------------ 诊断

	function DiagTab() {
		const [report, setReport] = useState(null);
		const [diag, setDiag] = useState(null);
		const [checking, setChecking] = useState(false);
		const [checkError, setCheckError] = useState("");
		const [reportError, setReportError] = useState("");
		const runCheck = async () => {
			setChecking(true);
			setCheckError("");
			try {
				const r = await api("selfcheck");
				if (!r.ok) throw new Error(r.error);
				setReport(r.report);
			} catch (error) { setCheckError("自检失败 · " + error.message); }
			finally { setChecking(false); }
		};
		const loadDiag = async () => {
			setReportError("");
			try {
				const r = await api("diagnostics");
				if (!r.ok) throw new Error(r.error);
				setDiag(r);
			} catch (error) { setReportError("报告生成失败 · " + error.message); }
		};
		const exportJson = () => {
			if (!diag) return;
			const blob = new Blob([JSON.stringify(diag.report, null, 2)], { type: "application/json" });
			const a = document.createElement("a");
			a.href = URL.createObjectURL(blob);
			a.download = "dafeiyu-diagnostics-" + diag.report.generatedAt.replace(/[:.]/g, "-") + ".json";
			a.click();
			URL.revokeObjectURL(a.href);
		};
		return h("div", { className: "dfy-grid" },
			h(Card, { title: "环境自检" },
				h(SelfcheckStep, { report, run: runCheck, busy: checking }),
				checkError ? h("p", { className: "dfy-caption", role: "alert" }, checkError) : null),
			h(Card, { title: "诊断报告（脱敏导出）" },
				reportError ? h("p", { className: "dfy-caption", role: "alert" }, reportError) : null,
				h("p", { className: "dfy-caption", style: { margin: 0 } }, diag ? diag.disclosure.join("；") : "报告仅含聚合计数与状态分布，不含观众标识、正文、凭据。"),
				h("div", { className: "dfy-actions" },
					h(Btn, { onClick: loadDiag }, "生成预览"),
					h(Btn, { tone: "primary", disabled: !diag, onClick: exportJson }, "导出 JSON")),
				diag ? h("div", null,
					h(Row, { label: "生成时间", value: diag.report.generatedAt.replace("T", " ").slice(0, 19) }),
					h(Row, { label: "迁移版本", value: diag.report.schemaMigrations.join(", ") }),
					h(Row, { label: "事件 / 记忆候选 / 画像", value: diag.report.counts.events + " / " + diag.report.counts.memory_candidates + " / " + diag.report.counts.viewer_profiles }),
					h(Row, { label: "账本 / 反馈 / 样本", value: diag.report.counts.gift_ledger + " / " + diag.report.counts.feedback + " / " + diag.report.counts.training_samples })) : null));
	}

	// ------------------------------------------------------------------ 面板外壳

	const RECORD_PAGES = [
		{ id: "replies", label: "回复记录", View: ReplyHistory },
		{ id: "feedback", label: "反馈处理", View: FeedbackTab },
		{ id: "gifts", label: "礼物账本", View: GiftsTab },
		{ id: "audience", label: "观众", View: AudienceTab },
		{ id: "training", label: "训练", View: TrainingTab },
		{ id: "gov", label: "治理与发布", View: GovernanceTab },
	];
	function ConfigBackupStep({ reload }) {
		const [pending, setPending] = useState(false);
		const [preview, setPreview] = useState(null);
		const [note, setNote] = useState("");
		const fileInput = useRef(null);
		const exportConfig = async () => {
			setPending(true); setNote("");
			try {
				const r = await api("settings/export");
				if (!r.ok) throw new Error(r.error);
				const url = URL.createObjectURL(new Blob([JSON.stringify(r.backup, null, 2) + "\n"], { type: "application/json" }));
				const link = document.createElement("a");
				link.href = url; link.download = "dafeiyu-settings-" + r.backup.exportedAt.replace(/[:.]/g, "-") + ".json";
				document.body.appendChild(link); link.click(); link.remove();
				setTimeout(() => URL.revokeObjectURL(url), 1000);
				setNote("配置已导出；文件包含直播间与自定义端点，请妥善保管。");
			} catch (err) { setNote("导出失败 · " + err.message); }
			finally { setPending(false); }
		};
		const readConfig = async (event) => {
			const file = event.target.files?.[0]; event.target.value = "";
			setPreview(null); setNote("");
			if (!file) return;
			setPending(true);
			try {
				if (file.size > 131000) throw new Error("配置文件不能超过 128 KB");
				const backup = JSON.parse(await file.text());
				const r = await api("settings/import/validate", { backup });
				if (!r.ok) throw new Error(r.issues?.join("；") || r.error);
				setPreview(r.backup);
			} catch (err) { setNote("导入失败 · " + err.message); }
			finally { setPending(false); }
		};
		const importConfig = async () => {
			setPending(true); setNote("");
			try {
				const r = await api("settings/import", { backup: preview, confirm: true });
				if (!r.ok) throw new Error(r.issues?.join("；") || r.error);
				setPreview(null); await reload();
				setNote("配置已导入。请重新确认角色使用授权、平台登录和数据用途，并在模型与云端测试连接后启用云端。");
			} catch (err) { setNote("导入失败 · " + err.message); }
			finally { setPending(false); }
		};
		return h("div", { className: "dfy-stack" },
			h("p", { className: "dfy-caption" }, "备份角色、直播接入、画面、模型、数据用途和礼物设置。API Key、环境变量、角色素材、对话、观众画像与训练数据不包含在内。"),
			h("p", { className: "dfy-caption" }, "导入将覆盖以上六项设置；密钥保留在本机。请先下播并退出本地预览。导入后云端关闭，授权与登录声明需重新确认。"),
			h("div", { className: "dfy-actions" },
				h(Btn, { onClick: exportConfig, disabled: pending }, "导出配置"),
				h(Btn, { onClick: () => fileInput.current?.click(), disabled: pending }, "选择配置文件")),
			h("input", { ref: fileInput, type: "file", accept: ".json,application/json", hidden: true, "aria-label": "选择配置备份 JSON 文件", onChange: readConfig, disabled: pending }),
			preview ? h("section", { "aria-label": "导入预览", className: "dfy-stack" },
				h("strong", null, "导入预览 · v" + preview.version),
				h("p", { className: "dfy-caption" }, "导出时间：" + preview.exportedAt),
				h("dl", null, Object.entries({ "角色": preview.sections.persona.personaName,
					"直播间": preview.sections.platform.roomUrl || "未填写", "画面标题": preview.sections.scene.titleMode === "custom" ? preview.sections.scene.title : "跟随角色",
					"云端模型": preview.sections.cloud.model || "未填写", "云端端点": preview.sections.cloud.baseUrl || "服务商预设",
					"礼物点名": preview.sections.gifts.nameMention ? "开启" : "关闭" }).map(([key, value]) =>
					h("div", { key, style: { overflowWrap: "anywhere" } }, h("dt", null, key), h("dd", null, value)))),
				h("div", { className: "dfy-actions" },
					h(Btn, { tone: "primary", disabled: pending, onClick: importConfig }, pending ? "处理中…" : "确认覆盖并导入"),
					h(Btn, { disabled: pending, onClick: () => setPreview(null) }, "取消"))) : null,
			note ? h("p", { role: "status", className: "dfy-caption" }, note) : null);
	}

	function CommunityStep() {
		const link = (url, text) => h("a", { href: url, target: "_blank", rel: "noopener noreferrer" }, text);
		return h("div", { className: "dfy-stack" },
			h("p", null, "大肥鱼 · 本地优先的 AI 直播控制台"),
			h("p", { className: "dfy-caption" }, "提交使用场景、期待的操作与验收方式；在已有需求下补充意见，避免重复提交。赞助自愿，不代表功能交付承诺。"),
			h("div", { className: "dfy-actions" },
				link("https://github.com/jianwuzhao/streamer/issues", "需求墙 / Feature wall"),
				link("https://github.com/jianwuzhao/streamer/issues/new?template=feature_request.yml", "提交需求 / Request a feature"),
				link("https://github.com/jianwuzhao/streamer#赞助", "赞助 / Sponsor"),
				link("https://github.com/jianwuzhao/streamer/blob/master/README.en.md", "English guide")));
	}

	const SETTINGS_PAGES = [
		{ id: "persona", label: "角色与声音", View: PersonaStep },
		{ id: "platform", label: "直播接入", View: PlatformStep },
		{ id: "cloud", label: "模型与云端", View: CloudStep },
		{ id: "data", label: "数据用途", View: DataUsageStep },
		{ id: "backup", label: "配置备份", View: ConfigBackupStep },
		{ id: "community", label: "支持与需求", View: CommunityStep },
		{ id: "diag", label: "诊断", View: DiagTab },
	];
	const PAGES = [
		{ id: "home", label: "工作台" },
		{ id: "stage", label: "直播画面" },
		{ id: "records", label: "记录与学习", sections: RECORD_PAGES },
		{ id: "settings", label: "设置", sections: SETTINGS_PAGES },
	];

	function SectionNav({ items, current, onSelect, label, className }) {
		return h("nav", { className, "aria-label": label },
			items.map((item) => h("button", { type: "button", key: item.id,
				className: "dfy-tab" + (current === item.id ? " dfy-tab-on" : ""),
				"aria-current": current === item.id ? "page" : undefined,
				onClick: () => onSelect(item.id),
			}, item.label)));
	}

	function useSettingsSave(refresh) {
		const [note, setNote] = useState("");
		const [saving, setSaving] = useState(false);
		const save = async (section, body) => {
			if (saving) return false;
			setSaving(true);
			setNote("保存中…");
			try {
				const r = await api("settings/" + section, body);
				if (!r.ok) throw new Error(r.issues?.join("；") || r.error);
				await refresh();
				setNote("已保存");
				return true;
			} catch (error) {
				setNote("保存失败 · " + error.message);
				return false;
			} finally { setSaving(false); }
		};

		return { save, saving, note };
	}

	function SettingsPage({ page, settings, settingsError, refresh, catalog, reloadCatalog }) {
		const { save, saving, note } = useSettingsSave(refresh);
		if (page.View === DiagTab) return h(DiagTab);
		if (!settings) return settingsError ? h(Card, null,
			h("p", { role: "alert", style: { margin: 0 } }, settingsError),
			h("div", { className: "dfy-actions" }, h(Btn, { onClick: () => refresh() }, "重试"))) :
			h(Card, null, h(Loading, { text: "正在加载设置…" }));
		const feedback = note ? h("p", { className: "dfy-caption", role: "status", style: { margin: 0 } }, note) : null;
		const view = h(page.View, { settings, catalog, reloadCatalog, save, reload: refresh, feedback });
		return page.View === CloudStep ? view :
			h("div", { className: "dfy-form-card" }, h(Card, { title: page.label },
				h("fieldset", { className: "dfy-form-fields", "aria-label": page.label, disabled: saving }, view), feedback));
	}

	// 渲染错误兜底（0.14.1）：React 未捕获的渲染错误会卸载整棵树（白屏）；
	// 边界把错误收敛成面板内错误卡并提供「重试渲染」，宿主 slot 层不再收到崩溃。
	class PanelErrorBoundary extends react.Component {
		constructor(props) {
			super(props);
			this.state = { error: null };
		}
		static getDerivedStateFromError(error) { return { error: error }; }
		componentDidCatch(error) { console.error("[dafeiyu] 面板渲染错误:", error); }
		render() {
			if (!this.state.error) return this.props.children;
			const message = String((this.state.error && this.state.error.message) || this.state.error);
			return h("div", { className: "dfy-root dfy-desk-root" },
				h("main", { className: "dfy-body dfy-desk-body" },
					h("div", { className: "dfy-grid" },
						h(Card, { title: "面板渲染出错（已阻止白屏）" },
							h("p", { className: "dfy-mono", style: { margin: 0, overflowWrap: "anywhere" } }, message),
							h("p", { className: "dfy-caption", style: { margin: 0 } }, "可点击重试渲染；若反复出现请把上方错误信息反馈给开发者。"),
							h("div", { className: "dfy-actions" },
							h(Btn, { tone: "primary", onClick: () => this.setState({ error: null }) }, "重试渲染"))))));
		}
	}

	function Panel() {
		const [tab, setTab] = useState("home");
		const [status, setStatus] = useState(null);
		const [settings, setSettings] = useState(null);
		const [settingsError, setSettingsError] = useState("");
		const [preview, setPreview] = useState(null);
		const [catalog, setCatalog] = useState(null);
		const [notice, setNotice] = useState("");
		const [pending, setPending] = useState("");
		const [emergency, setEmergency] = useState(false);
		const [connected, setConnected] = useState(true);
		const [liveCaption, setLiveCaption] = useState({});
		const main = useRef(null);
		const lastPages = useRef({});
		const stageControls = useRef(null);
		const previewTicket = useRef(0);
		const catalogTicket = useRef(0);
		const statusTicket = useRef(0);
		const settingsTicket = useRef(0);
		const action = useRef(null);
		const emergencyAction = useRef(false);

		const refresh = useCallback(async (statusOnly = false) => {
			const ticket = ++statusTicket.current;
			const statusRequest = api("status").then((result) => {
				if (!result.ok) throw new Error(result.error);
				if (ticket === statusTicket.current) { setStatus(result.status); setConnected(true); }
			}).catch(() => { if (ticket === statusTicket.current) setConnected(false); });
			if (statusOnly) return statusRequest;
			const configTicket = ++settingsTicket.current;
			await Promise.all([statusRequest, api("settings").then((result) => {
				if (!result.ok) throw new Error(result.error);
				if (configTicket === settingsTicket.current) {
					setSettings(result.settings);
					setSettingsError("");
				}
			}).catch((error) => {
				if (configTicket === settingsTicket.current) setSettingsError("设置读取失败 · " + error.message);
			})]);
		}, []);

		const fastPolling = tab === "home" || tab === "stage";
		useEffect(() => {
			let disposed = false;
			let timer;
			let ticks = 0;
			refresh();
			const poll = async () => {
				if (!document.hidden) await refresh(fastPolling && ++ticks % 5 !== 0);
				if (!disposed) timer = setTimeout(poll, fastPolling ? 1200 : 4000);
			};
			timer = setTimeout(poll, fastPolling ? 1200 : 4000);
			const visible = () => { if (!document.hidden) refresh(); };
			document.addEventListener("visibilitychange", visible);
			return () => {
				disposed = true;
				clearTimeout(timer);
				statusTicket.current++;
				settingsTicket.current++;
				document.removeEventListener("visibilitychange", visible);
			};
		}, [refresh, fastPolling]);

		const reloadPreview = useCallback(async () => {
			const ticket = ++previewTicket.current;
			try {
				const result = await api("preview");
				if (ticket === previewTicket.current && result.ok) setPreview(result.preview);
			} catch { /* Keep the last successful preview while reconnecting. */ }
		}, []);
		const reloadCatalog = useCallback(async () => {
			const ticket = ++catalogTicket.current;
			try {
				const result = await api("avatar/catalog");
				if (ticket === catalogTicket.current && result.ok) setCatalog(result.catalog);
			} catch { /* Keep the last successful catalog while reconnecting. */ }
		}, []);
		const persona = settings?.persona;
		const scene = settings?.scene;
		useEffect(() => {
			reloadPreview();
			return () => { previewTicket.current++; };
		}, [reloadPreview, connected, status?.liveStatus, persona?.profileId, persona?.avatarId, persona?.voiceId,
			persona?.live2dModelId, persona?.appearance, persona?.aiLabelText, scene?.background, scene?.title, scene?.titleMode, scene?.danmakuOverlay,
			scene?.resolution, scene?.broadcastLayout, scene?.notice, scene?.originalScene, settings?.platform?.officialClientUrl]);
		useEffect(() => {
			reloadCatalog();
			return () => { catalogTicket.current++; };
		}, [reloadCatalog, connected]);
		useEffect(() => { if (main.current) main.current.scrollTop = 0; }, [tab]);

		const act = async (path, body, label) => {
			const urgent = path === "live/emergency-stop";
			if (urgent ? emergencyAction.current : action.current || emergencyAction.current) return;
			const operation = { superseded: false };
			if (urgent || path === "live/stop") stageControls.current?.stop();
			if (path === "live/start" || path === "live/operator-confirm") void stageControls.current?.enable();
			if (urgent) {
				emergencyAction.current = true;
				if (action.current) action.current.superseded = true;
				setEmergency(true);
			} else {
				action.current = operation;
				setPending(path);
			}
			setNotice(label + "…");
			try {
				const args = path === "live/start" ? { idempotencyKey: crypto.randomUUID?.() || String(Date.now()), ...body } : body || {};
				const result = await api(path, args);
				if (operation.superseded) return;
				if (!result.ok) throw new Error(result.error || "操作失败");
				if (result.status) {
					statusTicket.current++;
					setStatus(result.status);
					setConnected(true);
				}
				const detail = result.result?.reason || result.result?.detail;
				setNotice(detail ? label + " · " + detail :
					urgent && status?.liveStatus === "live_confirmed" ? "已停止本地输出，请在直播伴侣停止推流" : label + "完成");
			} catch (error) {
				if (!operation.superseded) setNotice(label + "失败 · " + error.message);
			} finally {
				if (urgent) {
					emergencyAction.current = false;
					setEmergency(false);
				} else {
					action.current = null;
					setPending("");
				}
				if (!operation.superseded) refresh(true);
			}
		};
		const page = PAGES.find((item) => item.id === tab || item.sections?.some((section) => section.id === tab));
		const section = page.sections?.find((item) => item.id === tab);
		const showStage = page.id === "stage";
		const live = status?.liveStatus === "live_confirmed";
		const enableLiveAudio = () => { void stageControls.current?.enable(); };
		const goTab = (id) => {
			const group = PAGES.find((p) => p.sections?.some((item) => item.id === id));
			if (group) lastPages.current[group.id] = id;
			if (id !== tab && !pending && !emergency && status?.liveStatus !== "safe_scene") setNotice("");
			if (id === "stage" && live) enableLiveAudio();
			setTab(id);
		};
		const selectPage = (id) => {
			if (page.id === id) return;
			const group = PAGES.find((item) => item.id === id);
			goTab(lastPages.current[id] || group.sections?.[0].id || id);
		};
		const ctx = { status, settings, preview, catalog, reloadPreview, act, pending, busy: !!pending || emergency,
			connected, emergency, refresh, goTab, liveCaption };
		const stopProminent = emergency || live || ["self_check", "awaiting_platform", "stream_established", "ending"].includes(status?.liveStatus) ||
			pending === "live/start" || pending === "live/operator-confirm";
		const stateTone = !connected ? "err" : live ? "ok" : stopProminent ? "warn" : "idle";
		const stateLabel = !connected ? "连接中断" :
			status?.liveStatus === "unconfigured" && status.personaReady && status.platformReady ? "待开播" :
			status?.liveDisplay || "连接中…";

		return h("div", { className: "dfy-root dfy-desk-root" },
			h("header", { className: "dfy-head dfy-desk-header" },
				h("div", { className: "dfy-brand" }, h(FishIcon, { size: 23 }), h("h2", null, "大肥鱼直播")),
				h(SectionNav, { items: PAGES, current: page.id, onSelect: selectPage, label: "主导航", className: "dfy-desk-nav" }),
				h("div", { className: "dfy-head-x" },
					h(Badge, { tone: stateTone, dot: live && connected, text: stateLabel }),
					h(Btn, { tone: stopProminent ? "danger" : "ghost", disabled: emergency,
						onClick: () => act("live/emergency-stop", {}, "紧急停止播出") }, emergency ? "正在停止…" : "紧急停止播出"))),
			notice ? h("div", { className: "dfy-header-notice" },
				h("span", { role: "status" }, notice), h(Btn, { tone: "ghost", onClick: () => setNotice("") }, "关闭提示")) : null,
			h("main", { className: "dfy-body dfy-desk-body", ref: main },
				h(BroadcastStage, { status, settings, preview, catalog, visible: showStage, emergency, controls: stageControls, publish: setLiveCaption, refresh, reloadCatalog }),
				section ? h("div", { className: "dfy-manage" },
					h(SectionNav, { items: page.sections, current: section.id, onSelect: goTab, label: page.label, className: "dfy-subnav" }),
					h("div", { className: "dfy-manage-content", key: section.id },
						page.id === "settings" ? h(SettingsPage, { page: section, settings, settingsError, refresh, catalog, reloadCatalog }) :
							h(section.View, ctx))) :
					showStage ? null : h(Workbench, ctx)));
	}

	const apply = (ctx) => {
		ensureStyle();
		ctx.slots.inject("sidebar.panellist", () => ctx.slots.register(
			{ name: "sidebar.panellist", id: PANEL_ID, order: 60, label: () => "大肥鱼直播" },
			(owner = {}) => h(FishIcon, { size: owner.size ?? 16 })));
		ctx.slots.inject("main", () => ctx.slots.register(
			{ name: "main", key: PANEL_ID },
			() => h(PanelErrorBoundary, null, h(Panel))));
	};

	return {
		apply, inject: ["slots"], name: "dsh-dafeiyu-evolve",
		mountBroadcastWindow(root) {
			ensureStyle();
			root.render(h(BroadcastOutput));
		},
	};
}});
