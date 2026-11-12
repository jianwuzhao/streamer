/* dsh-dafeiyu-evolve · Web 客户端半（六页签直播面板）
 * 装载：宿主 client-modules 经 dsh.client 声明加载本文件；
 * 交互：同源共享 API /api/dafeiyu/*（宿主 connection/request 承接）。
 * 页签：首页 / 首次配置（§24.1 五步+自检）/ 直播预览 / 训练与学习 /
 *       互动与账本 / 诊断；紧急停止播出常显（优先于一切后台任务）。
 * 主题：dfy-* 类引用宿主 design-platform 的 --dsw-* 设计变量并带降级值，
 *       亮/暗主题随 body[data-ds-dark-theme] 自动切换（零 JS 参与）。 */
window.__ModuleLoader__.load({ id: "dsh-dafeiyu-evolve", factory: (require) => {
	const react = require("react");
	const { useState, useEffect, useCallback, createElement: h } = react;

	const PANEL_ID = "dafeiyu-live";
	const DSW_BLUE = "var(--dsw-static-deepseek-500, #4176e6)";

	// ------------------------------------------------------------------ 样式注入（幂等；dfy-* 全部走 --dsw-* 变量 + 降级值）

	const STYLE_ID = "dfy-panel-style";
	function ensureStyle() {
		if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
		const style = document.createElement("style");
		style.id = STYLE_ID;
		style.textContent = `
.dfy-panel { font-family: var(--dsw-font-family, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif); color: var(--dsw-alias-label-primary, #17303c); background: var(--dsw-alias-bg-base, #f6faf9); }
.dfy-panel, .dfy-panel * { box-sizing: border-box; }
.dfy-panel h2 { margin: 0; font-size: 17px; }
.dfy-panel h3 { margin: 0; font-size: 13.5px; }
.dfy-muted { color: var(--dsw-alias-label-tertiary, #5b6f6c); }
.dfy-caption { color: var(--dsw-alias-label-caption, #8aa09b); }
.dfy-card { background: var(--dsw-alias-bg-layer-1, #ffffff); border: 0.5px solid var(--dsw-alias-border-l1, #d8e2e0); border-radius: var(--dsw-radius-lg, 12px); padding: 12px 14px; margin-bottom: 12px; }
.dfy-stat { display: flex; justify-content: space-between; gap: 12px; font-size: 12.5px; padding: 4px 0; border-bottom: 0.5px dashed var(--dsw-alias-border-l1, #d8e2e0); }
.dfy-stat-label { color: var(--dsw-alias-label-tertiary, #5b6f6c); flex: 0 0 auto; }
.dfy-stat-value { font-weight: 600; color: var(--dsw-alias-label-primary, #17303c); text-align: right; word-break: break-all; }
.dfy-btn { flex: 1 1 40%; padding: 10px 12px; border-radius: var(--dsw-radius-md, 10px); cursor: pointer; font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary, #17303c); background: var(--dsw-alias-bg-layer-1, #ffffff); border: 0.5px solid var(--dsw-alias-border-l2, #d8e2e0); }
.dfy-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, #eef4f2); }
.dfy-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.dfy-btn-primary { color: var(--dsw-alias-label-primary-inverted, #ffffff); background: var(--dsw-alias-state-business-primary, #0f5e57); border-color: transparent; }
.dfy-btn-primary:hover:not(:disabled) { background: var(--dsw-alias-state-business-primary, #0f5e57); opacity: 0.92; }
.dfy-btn-ghost { background: transparent; border-color: transparent; color: var(--dsw-alias-link, #0f5e57); }
.dfy-badge { display: inline-flex; align-items: center; font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 999px; margin-left: 6px; white-space: nowrap; }
.dfy-badge-ok { background: color-mix(in srgb, var(--dsw-alias-state-success-primary, #1c7a54) 13%, transparent); color: var(--dsw-alias-state-success-primary, #1c7a54); }
.dfy-badge-err { background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #c0392b) 12%, transparent); color: var(--dsw-alias-state-error-primary, #c0392b); }
.dfy-badge-warn { background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #b8860b) 15%, transparent); color: var(--dsw-alias-state-warn-label, #8a6d1f); }
.dfy-badge-idle { background: var(--dsw-alias-bg-layer-2, #e4ebe9); color: var(--dsw-alias-label-secondary, #45606b); }
.dfy-badge-live { background: color-mix(in srgb, var(--dsw-alias-state-success-primary, #1c7a54) 13%, transparent); color: var(--dsw-alias-state-success-primary, #1c7a54); }
.dfy-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; display: inline-block; margin-right: 5px; animation: dfy-breathe 1.6s ease-in-out infinite; }
@keyframes dfy-breathe { 0%, 100% { opacity: 0.35; } 50% { opacity: 1; } }
.dfy-tab { padding: 6px 12px; border-radius: 999px; font-size: 12.5px; font-weight: 500; cursor: pointer; border: 0.5px solid var(--dsw-alias-border-l2, #d8e2e0); background: var(--dsw-alias-bg-layer-1, #ffffff); color: var(--dsw-alias-label-primary, #17303c); }
.dfy-tab:hover { background: var(--dsw-alias-interactive-bg-hover, #eef4f2); }
.dfy-tab-active { border-color: transparent; background: var(--dsw-alias-state-business-primary, #0f5e57); color: var(--dsw-alias-label-primary-inverted, #ffffff); font-weight: 700; }
.dfy-emergency { position: sticky; bottom: 12px; margin-top: 18px; width: 100%; padding: 12px; border-radius: var(--dsw-radius-lg, 12px); cursor: pointer; background: var(--dsw-alias-state-error-primary, #c0392b); color: var(--dsw-alias-label-primary-inverted, #ffffff); font-size: 14px; font-weight: 700; border: none; }
.dfy-emergency:disabled { opacity: 0.45; cursor: not-allowed; }
.dfy-input, .dfy-select { width: 100%; padding: 8px 10px; border-radius: var(--dsw-radius-sm, 8px); border: 0.5px solid var(--dsw-alias-border-l2, #d8e2e0); font-size: 13px; color: var(--dsw-alias-label-primary, #17303c); background: var(--dsw-alias-bg-layer-1, #ffffff); }
.dfy-input:disabled { color: var(--dsw-alias-label-tertiary, #5b6f6c); background: var(--dsw-alias-bg-layer-2, #eef2f1); }
.dfy-link { color: var(--dsw-alias-link, #0f5e57); text-decoration: none; }
.dfy-link:hover { text-decoration: underline; }
.dfy-note-warn { font-size: 12.5px; background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #ffd166) 14%, transparent); border: 0.5px solid var(--dsw-alias-state-warn-primary, #d9b44a); border-radius: var(--dsw-radius-md, 10px); padding: 8px 12px; margin-bottom: 12px; }
.dfy-note-ok { font-size: 12px; color: var(--dsw-alias-state-success-primary, #1c7a54); }
.dfy-chip { display: inline-flex; align-items: center; gap: 8px; padding: 7px 10px; border-radius: var(--dsw-radius-md, 10px); cursor: pointer; text-align: left; font-size: 12.5px; color: var(--dsw-alias-label-primary, #17303c); background: var(--dsw-alias-bg-layer-1, #ffffff); border: 0.5px solid var(--dsw-alias-border-l2, #d8e2e0); }
.dfy-chip:hover { background: var(--dsw-alias-interactive-bg-hover, #eef4f2); }
.dfy-chip-active { border: 1.5px solid var(--dsw-alias-state-business-primary, #0f5e57); background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #0f5e57) 9%, transparent); }
.dfy-pill { padding: 3px 9px; font-size: 11.5px; border-radius: 999px; border: 0.5px solid var(--dsw-alias-border-l2, #d8e2e0); background: var(--dsw-alias-bg-layer-1, #ffffff); cursor: pointer; color: var(--dsw-alias-label-primary, #17303c); }
.dfy-pill:hover { background: var(--dsw-alias-interactive-bg-hover, #eef4f2); }
.dfy-panel button:focus-visible, .dfy-panel a:focus-visible, .dfy-panel input:focus-visible, .dfy-panel select:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, rgba(15, 94, 87, 0.55)); outline-offset: 1px; }
@media (prefers-reduced-motion: reduce) { .dfy-panel *, .dfy-panel *::before { animation: none !important; transition: none !important; } }
`;
		document.head.appendChild(style);
	}

	// ------------------------------------------------------------------ 基础件

	async function api(path, body) {
		const res = await fetch("/api/dafeiyu/" + path, {
			method: body ? "POST" : "GET",
			headers: body ? { "content-type": "application/json" } : undefined,
			body: body ? JSON.stringify(body) : undefined,
			credentials: "same-origin",
		});
		return res.json();
	}

	const Btn = ({ onClick, disabled, tone, children, style }) => h("button", {
		onClick, disabled,
		className: "dfy-btn" + (tone === "primary" ? " dfy-btn-primary" : tone === "ghost" ? " dfy-btn-ghost" : ""),
		style: style || undefined,
	}, children);

	const Stat = ({ label, value }) => h("div", { className: "dfy-stat" },
		h("span", { className: "dfy-stat-label" }, label), h("span", { className: "dfy-stat-value" }, value));

	const Card = ({ title, children, extra }) => h("div", { className: "dfy-card" },
		title ? h("div", { style: { display: "flex", alignItems: "center", marginBottom: 8 } },
			h("h3", { style: { margin: 0, fontSize: 13.5, flex: 1 } }, title), extra || null) : null,
		children);

	const Badge = ({ tone, text, dot }) => h("span", {
		className: "dfy-badge dfy-badge-" + (tone || "idle"),
	}, dot ? h("i", { className: "dfy-dot" }) : null, text);

	const Field = ({ label, children }) => h("label", { style: { display: "block", marginBottom: 10, fontSize: 12.5 } },
		h("span", { style: { display: "block", marginBottom: 4, fontWeight: 600 } }, label), children);

	// ------------------------------------------------------------------ 图标：侧边栏=单色剪影（currentColor + DeepSeek 蓝气泡）；画布=彩色主题鱼

	const FishIcon = ({ size = 16, theme }) => {
		if (theme) {
			const t = theme;
			return h("svg", { width: size, height: size, viewBox: "0 0 64 64", "aria-hidden": true },
				h("rect", { x: 2, y: 2, width: 60, height: 60, rx: 14, fill: t.primary }),
				h("ellipse", { cx: 30, cy: 34, rx: 20, ry: 12, fill: t.accent }),
				h("path", { d: "M46 28 L58 22 L54 34 L58 46 L46 40 Z", fill: t.accent }),
				h("circle", { cx: 20, cy: 30, r: 3, fill: "#17303c" }),
				h("path", { d: "M14 40 Q26 48 38 40", stroke: "#17303c", strokeWidth: 2.5, fill: "none", strokeLinecap: "round" }),
				h("circle", { cx: 44, cy: 14, r: 5, fill: "#4ecdc4", opacity: 0.85 }));
		}
		// 品牌语言：近黑底板省略（透明底随宿主导航）——单色剪影 + 蓝气泡
		return h("svg", { width: size, height: size, viewBox: "0 0 64 64", "aria-hidden": true, style: { color: "inherit" } },
			h("ellipse", { cx: 28, cy: 37, rx: 18, ry: 12, fill: "currentColor" }),
			h("path", { d: "M41 29 L57 22 L52 37 L57 52 L41 45 Z", fill: "currentColor" }),
			h("circle", { cx: 18.5, cy: 33, r: 2.8, fill: "var(--dsw-alias-bg-base, #f6faf9)" }),
			h("path", { d: "M14 42 Q25 48 36 44", stroke: "var(--dsw-alias-bg-base, #f6faf9)", strokeWidth: 2.2, fill: "none", strokeLinecap: "round" }),
			h("circle", { cx: 46, cy: 14, r: 4.2, fill: DSW_BLUE }),
			h("circle", { cx: 54, cy: 8.5, r: 2, fill: DSW_BLUE, opacity: 0.55 }));
	};

	// ------------------------------------------------------------------ 预览画布（浏览器渲染；本地预览 ≠ 已开播）

	const SCENE_BG = { teal: "#0f3d38", night: "#101c33", warm: "#3d2c10" };

	function PreviewCanvas({ preview, compact }) {
		const p = preview || {};
		const persona = p.persona || { name: "大肥鱼", avatarId: "fish-classic", aiLabelText: "AI 生成内容" };
		const scene = p.scene || { title: "大肥鱼的直播间", danmakuOverlay: true };
		const themes = { "fish-classic": { primary: "#0f5e57", accent: "#ffd166" }, "fish-gold": { primary: "#8a6d1f", accent: "#ffe3a3" }, "fish-night": { primary: "#1d3557", accent: "#7ae7ff" } };
		const theme = themes[persona.avatarId] || themes["fish-classic"];
		const bg = SCENE_BG[scene.background || "teal"];
		return h("div", {
			style: {
				position: "relative", width: "100%", aspectRatio: "16 / 9", borderRadius: 12, overflow: "hidden",
				background: "linear-gradient(160deg, " + bg + " 0%, #08131a 100%)", border: "0.5px solid var(--dsw-alias-border-l2, #d8e2e0)",
			},
		},
		h("div", { style: { position: "absolute", top: 10, left: 12, color: "#dfeeea", fontSize: compact ? 12 : 15, fontWeight: 700, textShadow: "0 1px 3px rgba(0,0,0,.4)" } }, scene.title),
		h("div", { style: { position: "absolute", top: 12, right: 12 } },
			h("span", { style: { fontSize: 11, fontWeight: 700, padding: "3px 9px", borderRadius: 999, background: "rgba(192,57,43,.92)", color: "#fff" } }, persona.aiLabelText || "AI 生成内容")),
		h("div", { style: { position: "absolute", left: 0, right: 0, bottom: compact ? 8 : 14, display: "flex", alignItems: "center", justifyContent: "center", gap: 10 } },
			h(FishIcon, { size: compact ? 40 : 72, theme: theme }),
			h("span", { style: { color: theme.accent, fontSize: compact ? 13 : 18, fontWeight: 700, textShadow: "0 1px 4px rgba(0,0,0,.5)" } }, persona.name)),
		scene.danmakuOverlay && !compact ? h("div", { style: { position: "absolute", top: 44, left: 14, fontSize: 11.5, color: "rgba(255,255,255,.78)" } },
			h("div", null, "「先把手上的事做完」"),
			h("div", { style: { marginLeft: 40, marginTop: 3 } }, "「大肥鱼今天种什么？」")) : null,
		h("div", { style: { position: "absolute", bottom: 8, left: 12, fontSize: 10.5, color: "rgba(255,255,255,.55)" } },
			p.previewActive ? "本地预览（未推流） · AI 标识常显" : "未在预览"));
	}

	// ------------------------------------------------------------------ 首页

	function HomeTab({ status, act, busy, goTab }) {
		const s = status;
		const live = s && s.liveStatus === "live_confirmed";
		const starting = s && ["self_check", "local_preview", "awaiting_platform", "stream_established"].includes(s.liveStatus);
		const canTrain = s && s.trainingEligible && !s.learningPaused;
		const needWizard = s && (!s.personaReady || !s.platformReady);
		return h("div", null,
			needWizard ? h("div", { className: "dfy-note-warn" },
				h("div", { style: { fontWeight: 700, marginBottom: 4 } }, "首次配置未完成"),
				h("div", { className: "dfy-muted", style: { marginBottom: 8 } }, !s.personaReady ? s.personaReadyReason : s.platformReadyReason),
				h(Btn, { tone: "primary", disabled: busy, style: { flex: "0 0 auto", padding: "6px 14px" }, onClick: () => goTab("wizard") }, "去首次配置")) : null,
			h(Card, { title: "当前状态", extra: h("span", null,
				h(Badge, { tone: s && s.personaReady ? "ok" : "err", text: s && s.personaReady ? "形象就绪" : "形象未配置" }),
				h(Badge, { tone: s && s.platformReady ? "ok" : "err", text: s && s.platformReady ? "接入就绪" : "接入未配置" })) },
				h(Stat, { label: "直播状态", value: s ? s.liveDisplay : "—" }),
				h(Stat, { label: "运行模式", value: s ? s.mode + (s.killSwitch ? "（killSwitch）" : "") : "—" }),
				h(Stat, { label: "学习状态", value: s ? (s.learningPaused ? "已暂停" : "观察学习中") : "—" }),
				h(Stat, { label: "当前版本", value: s && s.activeReleaseId ? s.activeReleaseId : "基线" }),
				h(Stat, { label: "云端兜底", value: s ? (s.cloudEnabled ? "已启用" : "未配置（不产生付费调用）") : "—" }),
				h(Stat, { label: "训练机会", value: s ? (s.trainingEligible ? "样本/资源/政策门通过" : s.trainingEligibleDetail) : "—" }),
				h(Stat, { label: "当日费用", value: s ? s.todayCostCny.toFixed(2) + " 元（以服务商账单为准）" : "—" }),
				h(Stat, { label: "待处理问题", value: s ? s.pendingIssues + " 条反馈待核实" : "—" })),
			s && s.previewActive ? h(Card, { title: "本地预览进行中", extra: h(Btn, { tone: "ghost", style: { flex: "0 0 auto", padding: "4px 10px" }, onClick: () => goTab("preview") }, "打开预览") },
				h(PreviewCanvas, { preview: { previewActive: true, persona: { name: "大肥鱼", aiLabelText: "AI 生成内容" }, scene: {} }, compact: true })) : null,
			s && s.liveStatus === "awaiting_platform" ? h("div", { className: "dfy-note-warn" },
				"平台状态待确认：在直播伴侣完成开播后，点击「我已在官方客户端开播」同步状态。") : null,
			h("div", { style: { display: "flex", flexWrap: "wrap", gap: 10 } },
				h(Btn, { tone: "primary", disabled: busy || !s || live, onClick: () => act("live/start", {}, "开始直播") }, starting ? "开播进行中…" : "开始直播"),
				h(Btn, { disabled: busy || !s || (!live && !starting), onClick: () => act("live/stop", {}, "结束直播") }, "结束直播"),
				s && s.liveStatus === "awaiting_platform" ? h(Btn, { disabled: busy, onClick: () => act("live/operator-confirm", {}, "我已在官方客户端开播") }, "我已在官方客户端开播") : null,
				h(Btn, { disabled: busy || !s || !canTrain, onClick: () => act("training/train-once", {}, "训练一次") }, "训练一次"),
				h(Btn, { disabled: busy || !s, onClick: () => act(s && s.learningPaused ? "learning/resume" : "learning/pause", {}, s && s.learningPaused ? "恢复学习" : "暂停学习") }, s && s.learningPaused ? "恢复学习" : "暂停学习"),
				h(Btn, { disabled: busy || !s || !s.activeReleaseId, onClick: () => act("release/rollback", {}, "恢复稳定版本") }, "恢复稳定版本")));
	}

	// ------------------------------------------------------------------ 首次配置向导（§24.1 五步 + 自检）

	function WizardTab({ onSaved }) {
		const [step, setStep] = useState(0);
		const [data, setData] = useState(null);
		const [note, setNote] = useState("");
		const [selfcheck, setSelfcheck] = useState(null);

		const load = useCallback(async () => {
			const r = await api("settings");
			if (r.ok) setData(r.settings);
		}, []);
		useEffect(() => { load() }, [load]);

		const save = async (section, body) => {
			setNote("保存中…");
			const r = await api("settings/" + section, body);
			if (r.ok) { setNote("已保存 ✓"); await load(); if (onSaved) onSaved(); }
			else setNote("保存失败：" + (r.error || "未知错误") + (r.issues ? "（" + r.issues.join("；") + "）" : ""));
			return r.ok;
		};

		const runSelfcheck = async () => {
			setNote("自检运行中…");
			const r = await api("selfcheck");
			setSelfcheck(r.ok ? r.report : null);
			setNote(r.ok ? "自检完成（不可达项如实标注）" : "自检失败：" + r.error);
		};

		if (data === null) return h("p", { className: "dfy-muted", style: { fontSize: 12.5 } }, "加载设置…");

		const steps = [
			{ label: "① 数据与自检", body: h(SelfcheckStep, { report: selfcheck, run: runSelfcheck }) },
			{ label: "② 直播接入", body: h(PlatformStep, { settings: data, save: save }) },
			{ label: "③ 主播形象", body: h(PersonaStep, { settings: data, save: save }) },
			{ label: "④ 模型与云端", body: h(CloudStep, { settings: data, save: save }) },
			{ label: "⑤ 运行模式与数据用途", body: h(DataUsageStep, { settings: data, save: save }) },
		];
		const personaOk = data.readiness.persona.ready === true;
		const platformOk = data.readiness.platform.ready === true;
		const done = personaOk && platformOk;

		return h("div", null,
			h(Card, { title: "首次配置向导（§24.1 五项输入）", extra: h("span", null,
				h(Badge, { tone: personaOk ? "ok" : "err", text: personaOk ? "形象✓" : "形象✗" }),
				h(Badge, { tone: platformOk ? "ok" : "err", text: platformOk ? "接入✓" : "接入✗" }),
				h(Badge, { tone: data.dataUsage.confirmed ? "ok" : "idle", text: data.dataUsage.confirmed ? "用途✓" : "用途—" })) },
				h("div", { style: { display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 } },
					steps.map((st, i) => h("button", {
						key: i, onClick: () => setStep(i),
						className: "dfy-chip" + (i === step ? " dfy-chip-active" : ""),
					}, st.label))),
				steps[step] ? steps[step].body : null,
				h("div", { style: { display: "flex", gap: 10, marginTop: 12 } },
					h(Btn, { disabled: step === 0, onClick: () => setStep(step - 1), style: { flex: "0 0 90px" } }, "上一步"),
					step < steps.length - 1 ? h(Btn, { tone: "primary", onClick: () => setStep(step + 1), style: { flex: "0 0 90px" } }, "下一步") : null),
				note ? h("p", { className: "dfy-muted", style: { fontSize: 12, marginTop: 10, wordBreak: "break-all" } }, note) : null,
				h("p", { className: "dfy-caption", style: { fontSize: 11, marginTop: 8 } }, data.notes.join("；"))),
			done ? h(Card, { title: "配置完成" },
				h("p", { style: { fontSize: 12.5, margin: "0 0 8px" } }, "主播形象与直播接入已就绪。可以先进入本地预览确认画面与 AI 标识，再开始直播（平台确认前不会显示直播中）。")) : null);
	}

	function SelfcheckStep({ report, run }) {
		return h("div", null,
			h("p", { className: "dfy-muted", style: { fontSize: 12.5 } }, "安装器同款自检清单：Node/Python/配置/数据目录/本地推理/GPU 逐项检查，缺失能力如实标注并给修复动作。"),
			h(Btn, { tone: "primary", onClick: run, style: { flex: "0 0 130px" } }, report ? "重新运行自检" : "运行自检"),
			report ? h("div", { style: { marginTop: 10 } },
				report.items.map((it) => h("div", { key: it.id, style: { fontSize: 12.5, padding: "5px 0", borderBottom: "0.5px dashed var(--dsw-alias-border-l1, #d8e2e0)" } },
					h("span", { style: { color: it.ok ? "var(--dsw-alias-state-success-primary, #1c7a54)" : "var(--dsw-alias-state-error-primary, #c0392b)", fontWeight: 700, marginRight: 8 } }, it.ok ? "✓" : "✗"),
					h("b", null, it.label),
					h("span", { className: "dfy-muted" }, " — " + it.detail),
					it.fixAction ? h("div", { style: { color: "var(--dsw-alias-state-error-primary, #c0392b)", fontSize: 11.5, marginTop: 2 } }, "修复：" + it.fixAction) : null)),
				h("p", { className: "dfy-muted", style: { fontSize: 11.5, marginTop: 6 } },
					"本地模式" + (report.canRunLocalMode ? "可用" : "不可用（须先修复必过项）") + "；在线训练验收" + (report.canAcceptOnlineTraining ? "条件满足" : "需目标机（RTX 4060 Ti 8GB）"))) : null);
	}

	function PlatformStep({ settings, save }) {
		const p = settings.platform;
		const [mode, setMode] = useState(p.operationMode);
		const [category, setCategory] = useState(p.contentCategory);
		return h("div", null,
			h("p", { className: "dfy-muted", style: { fontSize: 12.5 } }, "平台登录、实名与人脸认证在官方客户端完成；本插件只保存操作员声明，不保存任何凭据。"),
			h(Field, { label: "平台" }, h("input", { value: "抖音（辅助模式默认）", disabled: true, className: "dfy-input" })),
			h(Field, { label: "运行模式" },
				h("select", { value: mode, onChange: (e) => setMode(e.target.value), className: "dfy-select" },
					h("option", { value: "assisted" }, "辅助直播（AI 辅助，真人控制播出）"),
					h("option", { value: "human_driven" }, "真人驱动（AI 仅建议，不代播）"))),
			h(Field, { label: "内容类别（选填）" }, h("input", { value: category, onChange: (e) => setCategory(e.target.value), placeholder: "如：游戏/休闲聊天", className: "dfy-input" })),
			h("div", { style: { fontSize: 12, marginBottom: 10 } },
				"官方客户端入口：", h("a", { href: p.officialClientUrl, target: "_blank", rel: "noreferrer", className: "dfy-link" }, "直播伴侣官方说明")),
			h("div", { style: { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" } },
				h(Btn, { tone: "primary", onClick: () => save("platform", { operationMode: mode, contentCategory: category }), style: { flex: "0 0 100px" } }, "保存"),
				h(Btn, { onClick: () => save("platform", { operatorLoginConfirmedAt: new Date().toISOString() }), style: { flex: "1 1 60%" } },
					p.operatorLoginConfirmedAt ? "已声明登录 ✓（" + p.operatorLoginConfirmedAt.slice(0, 16).replace("T", " ") + "，点击更新）" : "我已在官方客户端登录直播账号")));
	}

	function PersonaStep({ settings, save }) {
		const p = settings.persona;
		const [name, setName] = useState(p.personaName);
		const [avatar, setAvatar] = useState(p.avatarId);
		const [voice, setVoice] = useState(p.voiceId);
		const [phrase, setPhrase] = useState(p.samplePhrase);
		const [right, setRight] = useState(p.usageRightConfirmed);
		const [listenNote, setListenNote] = useState("");

		const listen = async () => {
			setListenNote("准备试听…");
			const r = await api("preview/voice-test");
			if (!r.ok) { setListenNote("试听失败：" + r.error); return; }
			if (typeof window.speechSynthesis === "undefined") { setListenNote("当前浏览器不支持语音合成"); return; }
			window.speechSynthesis.cancel();
			const u = new SpeechSynthesisUtterance(r.result.phrase);
			u.lang = r.result.voice.lang;
			window.speechSynthesis.speak(u);
			setListenNote("正在试听（" + r.result.note + "）");
		};

		return h("div", null,
			h(Field, { label: "主播名称" }, h("input", { value: name, onChange: (e) => setName(e.target.value), maxLength: 24, className: "dfy-input" })),
			h(Field, { label: "内置形象（预览与播出画面使用）" },
				h("div", { style: { display: "flex", gap: 8, flexWrap: "wrap" } },
					settings.catalogs.avatars.map((a) => h("button", {
						key: a.id, onClick: () => setAvatar(a.id),
						className: "dfy-chip" + (avatar === a.id ? " dfy-chip-active" : ""),
					}, h(FishIcon, { size: 26, theme: a.theme }), a.label)))),
			h(Field, { label: "音色（元数据；最终播出音色以直播伴侣音轨为准）" },
				h("div", { style: { display: "flex", gap: 8, flexWrap: "wrap" } },
					settings.catalogs.voices.map((v) => h("button", {
						key: v.id, onClick: () => setVoice(v.id),
						className: "dfy-chip" + (voice === v.id ? " dfy-chip-active" : ""),
					}, h("b", null, v.label), h("span", { className: "dfy-muted" }, " · " + v.style))))),
			h(Field, { label: "试听语句" },
				h("div", { style: { display: "flex", gap: 8 } },
					h("input", { value: phrase, onChange: (e) => setPhrase(e.target.value), maxLength: 80, className: "dfy-input", style: { flex: 1 } }),
					h(Btn, { onClick: listen, style: { flex: "0 0 76px" } }, "试听")),
				listenNote ? h("p", { className: "dfy-muted", style: { fontSize: 11.5, margin: "4px 0 0" } }, listenNote) : null),
			h("label", { style: { display: "flex", gap: 8, alignItems: "flex-start", fontSize: 12.5, marginBottom: 10 } },
				h("input", { type: "checkbox", checked: right, onChange: (e) => setRight(e.target.checked), style: { marginTop: 3 } }),
				h("span", null, "我确认对所选形象与声音具有使用授权（开播前必须勾选）")),
			h("div", { className: "dfy-muted", style: { fontSize: 11.5, marginBottom: 10 } }, "AI 标识在画面上常显且不可关闭（法规要求 §23.2）。当前文案：" + p.aiLabelText),
			h(Btn, { tone: "primary", onClick: () => save("persona", { personaName: name, avatarId: avatar, voiceId: voice, samplePhrase: phrase, usageRightConfirmed: right }), style: { flex: "0 0 100px" } }, "保存"));
	}

	function CloudStep({ settings, save }) {
		const c = settings.cloud;
		const [enabled, setEnabled] = useState(c.enabled);
		const [provider, setProvider] = useState(c.provider);
		const [model, setModel] = useState(c.model);
		const [budget, setBudget] = useState(c.dailyBudgetCny === null ? "" : String(c.dailyBudgetCny));
		return h("div", null,
			h("p", { className: "dfy-muted", style: { fontSize: 12.5 } }, "本地优先：常规请求先走本地模型，未配置云端时不产生任何付费调用。云端仅作兜底，可留空。"),
			h(Stat, { label: "本地预设", value: "Ollama · Qwen3-4B-Instruct-2507（随安装固定）" }),
			h("label", { style: { display: "flex", gap: 8, alignItems: "center", fontSize: 12.5, margin: "10px 0" } },
				h("input", { type: "checkbox", checked: enabled, onChange: (e) => setEnabled(e.target.checked) }),
				"启用第三方兜底（OpenAI 兼容端点）"),
			h(Field, { label: "服务商（如 openai / deepseek / 自建网关）" }, h("input", { value: provider, onChange: (e) => setProvider(e.target.value), className: "dfy-input", placeholder: "留空 = 不覆盖 config.yaml" })),
			h(Field, { label: "模型名" }, h("input", { value: model, onChange: (e) => setModel(e.target.value), className: "dfy-input", placeholder: "如 deepseek-chat" })),
			h(Field, { label: "每日费用上限（元；必填才启用付费调用）" }, h("input", { value: budget, onChange: (e) => setBudget(e.target.value), className: "dfy-input", placeholder: "未设置 ⇒ 付费调用禁用" })),
			h("p", { style: { fontSize: 11.5, color: "var(--dsw-alias-state-error-primary, #c0392b)", margin: "0 0 10px" } }, "API Key 不在本界面保存：请以环境变量 DAFEIFYU_CLOUD_API_KEY 提供；上述覆盖在重启插件后生效。"),
			h(Btn, { tone: "primary", onClick: () => save("cloud", { enabled: enabled, provider: provider, model: model, dailyBudgetCny: budget === "" ? null : Number(budget) }), style: { flex: "0 0 100px" } }, "保存"));
	}

	function DataUsageStep({ settings, save }) {
		const d = settings.dataUsage;
		return h("div", null,
			h("p", { className: "dfy-muted", style: { fontSize: 12.5 } }, "运行模式与数据用途（隐私下限不可放宽，只能确认）："),
			h(Stat, { label: "运行模式", value: "观察学习（shadow）：记录与训练候选，不替换直播版本" }),
			h(Stat, { label: "观众画像用于参数训练", value: "不允许（默认拒绝）" }),
			h(Stat, { label: "个性化退出", value: "始终可用" }),
			h(Stat, { label: "礼物金额训练权重", value: "固定为 0（不作为奖励）" }),
			h("label", { style: { display: "flex", gap: 8, alignItems: "center", fontSize: 12.5, margin: "10px 0" } },
				h("input", { type: "checkbox", checked: d.confirmed, onChange: (e) => save("data-usage", { confirmed: e.target.checked }) }),
				"我已了解并确认上述数据用途设置"),
			h("p", { className: "dfy-muted", style: { fontSize: 11.5 } }, "确认后新安装仍处于观察学习；达到验证条件才小范围采用，自动发布不跳过验证。"));
	}

	// ------------------------------------------------------------------ 直播预览

	function PreviewTab({ status, act, busy }) {
		const [preview, setPreview] = useState(null);
		const load = useCallback(async () => {
			const r = await api("preview");
			if (r.ok) setPreview(r.preview);
		}, []);
		useEffect(() => { load() }, [load, status && status.liveStatus]);

		const active = preview && preview.previewActive;
		const inFlow = status && ["local_preview", "awaiting_platform", "stream_established", "live_confirmed", "self_check"].includes(status.liveStatus);
		return h("div", null,
			h(Card, { title: "本地预览（浏览器渲染画布）" },
				h(PreviewCanvas, { preview: preview }),
				h("div", { style: { display: "flex", gap: 10, marginTop: 10, flexWrap: "wrap" } },
					h(Btn, { tone: "primary", disabled: busy || active, onClick: async () => { await act("preview/start", {}, "进入本地预览"); load(); }, style: { flex: "0 0 130px" } }, active ? "预览中" : "进入本地预览"),
					h(Btn, { disabled: busy || !inFlow || status.liveStatus === "live_confirmed", onClick: async () => { await act("preview/stop", {}, "退出预览"); load(); }, style: { flex: "0 0 110px" } }, "退出预览"),
					h(Btn, { tone: "ghost", onClick: load, style: { flex: "0 0 70px" } }, "刷新")),
				h("p", { className: "dfy-muted", style: { fontSize: 12, marginTop: 8 } },
					"本地预览 ≠ 已开播：预览不推流；「" + (preview ? preview.liveDisplay : "—") + "」。确认形象、声音与 AI 标识正常后再开始直播。")),
			preview && preview.liveStatus === "awaiting_platform" ? h(Card, { title: "平台状态待确认" },
				h("p", { style: { fontSize: 12.5, margin: "0 0 8px" } }, "官方客户端（直播伴侣）完成开播后回来自行同步状态："),
				h("div", { style: { display: "flex", gap: 10 } },
					h("a", { href: preview.officialClientUrl, target: "_blank", rel: "noreferrer" }, h(Btn, { tone: "ghost", style: { flex: "0 0 150px" } }, "打开直播伴侣说明")),
					h(Btn, { tone: "primary", disabled: busy, onClick: () => act("live/operator-confirm", {}, "我已在官方客户端开播") }, "我已在官方客户端开播"))) : null);
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
		useEffect(() => { load() }, [load]);
		return h("div", null,
			h(Card, { title: "一键训练（训练完成 ≠ 发布）" },
				h(Stat, { label: "训练机会", value: data ? (data.opportunity.admit ? "样本/资源/政策门通过" : data.opportunity.detail) : "—" }),
				h(Stat, { label: "学习状态", value: status ? (status.learningPaused ? "已暂停" : "观察学习中") : "—" }),
				data && data.lastEntry ? h(Stat, { label: "上次训练", value: (TRAIN_STATUS[data.lastEntry.status] || data.lastEntry.status) + "：" + data.lastEntry.detail }) : null,
				data && data.latestRun ? h(Stat, { label: "最近窗口（training_runs）", value: (RUN_STATUS[data.latestRun.status] || data.latestRun.status) + " · " + data.latestRun.optimizer_steps + " 步" + (data.latestRun.error ? " · " + data.latestRun.error : "") }) : null,
				h("div", { style: { display: "flex", gap: 10, marginTop: 10, flexWrap: "wrap" } },
					h(Btn, { tone: "primary", disabled: busy || !status || !status.trainingEligible || status.learningPaused, onClick: async () => { await act("training/train-once", {}, "训练一次"); load(); }, style: { flex: "0 0 100px" } }, "训练一次"),
					h(Btn, { disabled: busy || !status, onClick: async () => { await act(status && status.learningPaused ? "learning/resume" : "learning/pause", {}, status && status.learningPaused ? "恢复学习" : "暂停学习"); load(); }, style: { flex: "0 0 110px" } }, status && status.learningPaused ? "恢复学习" : "暂停学习"),
					h(Btn, { tone: "ghost", onClick: load, style: { flex: "0 0 70px" } }, "刷新")),
				h("p", { className: "dfy-muted", style: { fontSize: 11.5, marginTop: 8 } }, "样本不足时如实说明条件；验证未通过继续使用稳定版本。直播期间仅在资源窗口训练，champion 全程不动。")));
	}

	// ------------------------------------------------------------------ 互动与账本

	const FB_LABEL = { useful: "有用", wrong: "答错", off_persona: "不像大肥鱼", too_slow: "响应太慢", not_remembered: "不该记住", complaint: "投诉", privacy: "隐私" };
	const FB_STATUS = { received: "已收到", verifying: "核实中", resolved: "已修复", insufficient_evidence: "证据不足" };
	const SETTLE = { received: "已收到", pending_settlement: "待结算", settled: "已结算", refunded: "退款", reversed: "冲正" };

	function InteractTab() {
		const [data, setData] = useState(null);
		const [fbs, setFbs] = useState(null);
		const [gifts, setGifts] = useState(null);
		const [note, setNote] = useState("");
		const load = useCallback(async () => {
			const r1 = await api("replies");
			if (r1.ok) setData(r1);
			const r2 = await api("feedback");
			if (r2.ok) setFbs(r2);
			const r3 = await api("gifts/summary");
			if (r3.ok) setGifts(r3);
		}, []);
		useEffect(() => { load() }, [load]);

		const send = async (reply, label) => {
			const correction = label === "wrong" ? (window.prompt("正确说法（选填，将作为纠错证据）：") || "") : "";
			const r = await api("feedback", { targetReplyId: reply.requestId, label: label, correction: correction || undefined });
			setNote(r.ok ? "反馈已提交：" + FB_STATUS[r.result.status] : "提交失败：" + r.error);
			load();
		};

		const advance = async (feedbackId, next, label) => {
			const r = await api("feedback/advance", { feedbackId: feedbackId, next: next });
			setNote(r.ok ? "已推进：" + label : "推进失败：" + r.error);
			load();
		};

		return h("div", null,
			h(Card, { title: "最近回复（反馈关联到当时的回复与版本 §10.1）", extra: h(Btn, { tone: "ghost", onClick: load, style: { flex: "0 0 60px", padding: "4px 10px" } }, "刷新") },
				note ? h("p", { className: "dfy-note-ok", style: { margin: "0 0 6px" } }, note) : null,
				data && data.replies.length === 0 ? h("p", { className: "dfy-muted", style: { fontSize: 12.5 } }, "暂无播出留痕（有问答后此处可见最近 50 条）") : null,
				(data ? data.replies : []).map((r) => h("div", { key: r.replyId, style: { padding: "8px 0", borderBottom: "0.5px dashed var(--dsw-alias-border-l1, #d8e2e0)", fontSize: 12.5 } },
					h("div", { className: "dfy-muted" }, "问：" + r.question),
					h("div", { style: { margin: "3px 0" } }, "答：" + r.reply + h("span", { className: "dfy-muted", style: { fontSize: 11 } }, "（" + r.route + "）")),
					h("div", { style: { display: "flex", gap: 6, flexWrap: "wrap", marginTop: 4, alignItems: "center" } },
						h("span", { className: "dfy-muted", style: { fontSize: 11 } }, "反馈："),
						["useful", "wrong", "off_persona", "too_slow"].map((lb) => h("button", {
							key: lb, onClick: () => send(r, lb), className: "dfy-pill",
						}, FB_LABEL[lb])),
						r.feedback.length > 0 ? h("span", { className: "dfy-note-ok", style: { fontSize: 11 } }, r.feedback.map((f) => FB_LABEL[f.label] + "·" + FB_STATUS[f.status]).join("，")) : null)))),
			h(Card, { title: "反馈处理状态" },
				fbs && fbs.feedback.length === 0 ? h("p", { className: "dfy-muted", style: { fontSize: 12.5 } }, "暂无反馈") : null,
				(fbs ? fbs.feedback : []).map((f) => h("div", { key: f.feedbackId, style: { display: "flex", gap: 8, fontSize: 12.5, padding: "4px 0", borderBottom: "0.5px dashed var(--dsw-alias-border-l1, #d8e2e0)", alignItems: "center" } },
					h("span", { style: { flex: "0 0 84px" } }, FB_LABEL[f.label] || f.label),
					h("span", { className: "dfy-muted", style: { flex: 1 } }, f.correction ? "纠正：" + f.correction : (f.targetReplyId ? "已关联回复" : "片段级（未定位具体回复）")),
					f.status === "received" ? h("button", { className: "dfy-pill", onClick: () => advance(f.feedbackId, "verifying", "核实中") }, "开始核实") : null,
					f.status === "verifying" ? h("button", { className: "dfy-pill", onClick: () => advance(f.feedbackId, "resolved", "已修复") }, "已修复") : null,
					f.status === "verifying" ? h("button", { className: "dfy-pill", onClick: () => advance(f.feedbackId, "insufficient_evidence", "证据不足") }, "证据不足") : null,
					h("span", { style: { fontWeight: 700, color: f.status === "resolved" ? "var(--dsw-alias-state-success-primary, #1c7a54)" : undefined, flex: "0 0 60px", textAlign: "right" } }, FB_STATUS[f.status] || f.status)))),
			gifts ? h(Card, { title: "礼物账本（标价不等于实际收入）" },
				h(Stat, { label: "收到 / 待结算 / 已结算", value: gifts.totals.receivedQty + " / " + gifts.totals.pendingSettlementQty + " / " + gifts.totals.settledQty }),
				h(Stat, { label: "退款（抵消记录）", value: String(gifts.totals.refundedQty) }),
				h(Stat, { label: "标价合计（仅供参考）", value: gifts.totals.faceValueSum.toFixed(2) }),
				h(Stat, { label: "未验证条目 / 待答谢", value: gifts.totals.unverifiedCount + " / " + gifts.pendingAckCount }),
				h("label", { style: { display: "flex", gap: 8, alignItems: "center", fontSize: 12.5, margin: "8px 0" } },
					h("input", { type: "checkbox", checked: gifts.ackSettings.nameMention, onChange: async (e) => { await api("settings/gifts", { nameMention: e.target.checked }); load(); } }),
					"答谢点名（关闭后统一说「谢谢这位朋友」；危险昵称仍不点名）"),
				gifts.entries.length > 0 ? h("div", { style: { marginTop: 6 } },
					gifts.entries.map((e) => h("div", { key: e.entry_id, style: { display: "flex", gap: 8, fontSize: 12, padding: "3px 0", className: "dfy-muted" } },
						h("span", { style: { flex: 1 } }, e.gift_id + " ×" + e.quantity_delta),
						h("span", null, SETTLE[e.settlement_status] || e.settlement_status),
						h("span", { style: { color: e.verification_status === "verified" ? "var(--dsw-alias-state-success-primary, #1c7a54)" : "var(--dsw-alias-state-warn-label, #8a6d1f)" } }, e.verification_status === "verified" ? "已验证" : "未验证")))) : null,
				h("p", { className: "dfy-caption", style: { fontSize: 11.5, marginTop: 8 } }, gifts.notes.join("；"))) : null);
	}

	// ------------------------------------------------------------------ 诊断

	function DiagTab() {
		const [report, setReport] = useState(null);
		const [diag, setDiag] = useState(null);
		const [note, setNote] = useState("");
		const runCheck = async () => { setNote("自检运行中…"); const r = await api("selfcheck"); setReport(r.ok ? r.report : null); setNote(r.ok ? "自检完成" : "自检失败：" + r.error); };
		const loadDiag = async () => { const r = await api("diagnostics"); setDiag(r.ok ? r : null); };
		const exportJson = () => {
			if (!diag) return;
			const blob = new Blob([JSON.stringify(diag.report, null, 2)], { type: "application/json" });
			const a = document.createElement("a");
			a.href = URL.createObjectURL(blob);
			a.download = "dafeiyu-diagnostics-" + diag.report.generatedAt.replace(/[:.]/g, "-") + ".json";
			a.click();
			URL.revokeObjectURL(a.href);
		};
		return h("div", null,
			h(Card, { title: "首次配置自检（向导同款）", extra: h(Btn, { tone: "ghost", onClick: runCheck, style: { flex: "0 0 76px", padding: "4px 10px" } }, "运行") },
				report ? report.items.map((it) => h("div", { key: it.id, style: { fontSize: 12.5, padding: "4px 0", borderBottom: "0.5px dashed var(--dsw-alias-border-l1, #d8e2e0)" } },
					h("span", { style: { color: it.ok ? "var(--dsw-alias-state-success-primary, #1c7a54)" : "var(--dsw-alias-state-error-primary, #c0392b)", fontWeight: 700, marginRight: 8 } }, it.ok ? "✓" : "✗"),
					h("b", null, it.label),
					h("span", { className: "dfy-muted" }, " — " + it.detail + (it.fixAction ? "（修复：" + it.fixAction + "）" : "")))) : h("p", { className: "dfy-muted", style: { fontSize: 12.5 } }, "点击「运行」执行环境自检。"),
				note ? h("p", { className: "dfy-muted", style: { fontSize: 12, marginTop: 6 } }, note) : null),
			h(Card, { title: "诊断报告导出（脱敏）" },
				h("p", { className: "dfy-muted", style: { fontSize: 12.5 } }, "导出前先看将包含的内容：" + (diag ? diag.disclosure.join("；") : "报告仅含聚合计数与状态分布，不含观众标识、正文、凭据")),
				h("div", { style: { display: "flex", gap: 10 } },
					h(Btn, { onClick: loadDiag, style: { flex: "0 0 110px" } }, "生成预览"),
					h(Btn, { tone: "primary", disabled: !diag, onClick: exportJson, style: { flex: "0 0 110px" } }, "导出 JSON")),
				diag ? h("div", { style: { marginTop: 8 } },
					h(Stat, { label: "生成时间", value: diag.report.generatedAt.replace("T", " ").slice(0, 19) }),
					h(Stat, { label: "迁移版本", value: diag.report.schemaMigrations.join(", ") }),
					h(Stat, { label: "事件/记忆候选/画像", value: diag.report.counts.events + " / " + diag.report.counts.memory_candidates + " / " + diag.report.counts.viewer_profiles }),
					h(Stat, { label: "礼物账本/反馈/训练样本", value: diag.report.counts.gift_ledger + " / " + diag.report.counts.feedback + " / " + diag.report.counts.training_samples })) : null));
	}

	// ------------------------------------------------------------------ 观众画像（§6.4 管理入口）

	const PRIVACY_KIND = { view: '查看', correction: '纠错', personalization_off: '退出个性化', deletion: '删除', export: '导出' };
	const PRIVACY_STATUS = { received: '已受理', verifying: '核实中', resolved: '已办结', rejected: '已驳回' };
	const CONFIDENCE = { observed: '观察', inferred: '推测', viewer_stated: '观众明确' };

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
			setNote("加载观众画像…");
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
			if (r.ok && detail && detail.summary.viewerKey === viewerKey) openViewer(viewerKey);
		};

		const actViewer = async (path, body, label) => {
			const r = await api(path, body);
			setNote(r.ok ? label + " ✓" + (r.result && r.result.detail ? "：" + r.result.detail : "") : label + " 失败：" + r.error);
			await load();
			if (detail) openViewer(detail.summary.viewerKey);
		};

		const d = detail;
		const pendingDeletion = d ? d.requests.find((r) => r.kind === "deletion" && r.status === "received") : null;
		return h("div", null,
			h(Card, { title: "观众（伪名化身份，管理入口）", extra: h(Btn, { tone: "ghost", onClick: load, style: { flex: "0 0 60px", padding: "4px 10px" } }, "刷新") },
				note ? h("p", { className: "dfy-muted", style: { fontSize: 12, margin: "0 0 6px" } }, note) : null,
				overview === null ? h("p", { className: "dfy-muted", style: { fontSize: 12.5 } }, "加载中…") : null,
				overview && overview.viewers.length === 0 ? h("p", { className: "dfy-muted", style: { fontSize: 12.5 } }, "暂无观众画像（授权事件到达后建立）") : null,
				overview && overview.viewers.length > 0 ? h("div", { style: { marginBottom: 8 } },
					h(Stat, { label: "墓碑数（已删除）", value: String(overview.tombstoneCount) }),
					overview.viewers.map((v) => h("button", {
						key: v.viewerKey, onClick: () => openViewer(v.viewerKey),
						className: "dfy-chip", style: { marginRight: 6, marginBottom: 6 },
					}, (v.nickname || v.viewerKey.slice(0, 12)) + (v.deletionStatus !== "active" ? "（" + (v.deletionStatus === "deleted" ? "已删除" : "删除申请中") + "）" : "")))) : null,
				overview && overview.requests.length > 0 ? h("div", null,
					h("div", { style: { fontWeight: 700, fontSize: 12, margin: "6px 0 4px" } }, "最近权利请求"),
					overview.requests.map((r) => h("div", { key: r.requestId, style: { display: "flex", gap: 8, fontSize: 12, padding: "2px 0", className: "dfy-muted" } },
						h("span", { style: { flex: "0 0 96px" } }, PRIVACY_KIND[r.kind] || r.kind),
						h("span", { style: { flex: 1 } }, (r.viewerKey || "").slice(0, 14) + "…"),
						h("span", { style: { flex: "0 0 64px", textAlign: "right" } }, PRIVACY_STATUS[r.status] || r.status)))) : null,
				overview ? h("p", { className: "dfy-caption", style: { fontSize: 11, marginTop: 8 } }, overview.notes.join("；")) : null),
			d ? h(Card, { title: "画像详情 · " + (d.summary.nickname || d.summary.viewerKey.slice(0, 16)), extra: h(Badge, { tone: d.summary.deleted ? "err" : "ok", text: d.summary.deleted ? "已删除" : "在册" }) },
				h(Stat, { label: "伪名键", value: d.summary.viewerKey.slice(0, 24) + "…" }),
				h(Stat, { label: "首次/最近互动", value: (d.summary.firstSeenAt || "—").slice(0, 16).replace("T", " ") + " / " + (d.summary.lastSeenAt || "—").slice(0, 16).replace("T", " ") }),
				h(Stat, { label: "互动聚合（事件表可重放）", value: Object.keys(d.interactions).length === 0 ? "无" : Object.entries(d.interactions).map(([k, n]) => k + "×" + n).join("，") }),
				d.fields.length > 0 ? h("div", { style: { marginTop: 6 } },
					h("div", { style: { fontWeight: 700, fontSize: 12, margin: "6px 0 4px" } }, "当前有效字段（隔离读取）"),
					d.fields.map((f) => h("div", { key: f.fieldId, style: { fontSize: 12, padding: "3px 0", borderBottom: "0.5px dashed var(--dsw-alias-border-l1, #d8e2e0)" } },
						h("b", null, f.fieldName), " = " + f.value,
						h("span", { className: "dfy-muted" }, "（" + (CONFIDENCE[f.confidenceKind] || f.confidenceKind) + " · " + f.purpose + " · 来源 " + f.sourceEventIds.length + " 条）")))) : h("p", { className: "dfy-muted", style: { fontSize: 12 } }, "无当前有效字段"),
				d.requests.length > 0 ? h("div", { style: { marginTop: 6 } },
					h("div", { style: { fontWeight: 700, fontSize: 12, margin: "6px 0 4px" } }, "该观众的权利请求"),
					d.requests.map((r) => h("div", { key: r.requestId, style: { fontSize: 12, padding: "2px 0", className: "dfy-muted" } },
						(PRIVACY_KIND[r.kind] || r.kind) + " · " + (PRIVACY_STATUS[r.status] || r.status) + (r.requestId ? " · " + r.requestId : "")))) : null,
				h("div", { style: { display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 } },
					h(Btn, { onClick: () => correction(d.summary.viewerKey), style: { flex: "0 0 90px" } }, "纠错"),
					h(Btn, { onClick: () => actViewer("audience/personalization-off", { viewerKey: d.summary.viewerKey }, "退出个性化"), style: { flex: "1 1 40%" } }, "退出个性化"),
					pendingDeletion ? h(Btn, { tone: "primary", onClick: () => actViewer("audience/deletion-execute", { requestId: pendingDeletion.requestId, viewerKey: d.summary.viewerKey, verificationPassed: true }, "执行删除（已验证）"), style: { flex: "1 1 40%" } }, "执行删除（已验证身份）") : h(Btn, { onClick: () => actViewer("audience/deletion-request", { viewerKey: d.summary.viewerKey }, "提交删除申请"), style: { flex: "1 1 40%" } }, "提交删除申请")),
				h("p", { className: "dfy-caption", style: { fontSize: 11, marginTop: 8 } }, "删除为两步流：提交申请（已受理）→ 验证观众身份后执行（落墓碑，查询即过滤）。")) : null);
	}

	// ------------------------------------------------------------------ 治理（技能/记忆/发布/审计）

	const SKILL_STATUS_CN = { draft: "草稿", validated: "已验证", staged: "已暂存", canary: "灰度", active: "active", suspended: "已暂停", superseded: "已替代" };
	const MEMORY_STATUS_CN = { proposed: "假设中", validated: "已验证", active: "生效", challenged: "被质疑", expired: "已过期", superseded: "被替代" };
	const RELEASE_STATUS_CN = { candidate: "候选", rejected: "已拒绝", staged: "已暂存", canary: "灰度", active: "生效", suspended: "已暂停", rolled_back: "已回滚", retired: "已退役" };

	function GovernanceTab({ status, act, busy }) {
		const [data, setData] = useState(null);
		const load = useCallback(async () => {
			const [s, m, r, a] = await Promise.all([api("governance/skills"), api("governance/memory"), api("governance/releases"), api("governance/audit")]);
			if (s.ok && m.ok && r.ok && a.ok) setData({ skills: s.skills, memories: m.memories, memoryNotes: m.notes, active: r.activeReleaseId, releases: r.releases, audits: a.audits, decisions: a.decisions, auditNotes: a.notes });
		}, []);
		useEffect(() => { load() }, [load]);
		return h("div", null,
			h(Card, { title: "技能库（版本不可原地覆盖；权限扩张拒晋级）", extra: h(Btn, { tone: "ghost", onClick: load, style: { flex: "0 0 60px", padding: "4px 10px" } }, "刷新") },
				data === null ? h("p", { className: "dfy-muted", style: { fontSize: 12.5 } }, "加载中…") : null,
				data && data.skills.length === 0 ? h("p", { className: "dfy-muted", style: { fontSize: 12.5 } }, "无已注册技能") : null,
				(data ? data.skills : []).map((s) => h("div", { key: s.skillId + "@" + s.version, style: { display: "flex", gap: 8, fontSize: 12.5, padding: "5px 0", borderBottom: "0.5px dashed var(--dsw-alias-border-l1, #d8e2e0)", alignItems: "center" } },
					h("span", { style: { flex: 1 }, title: s.description || "" }, h("b", null, s.skillId), h("span", { className: "dfy-muted" }, " v" + s.version + (s.kind ? " · " + s.kind : ""))),
					h("span", { className: "dfy-muted", style: { flex: "0 0 76px", textAlign: "right" } }, "权限 " + s.permissions),
					h(Badge, { tone: s.status === "active" ? "ok" : "idle", text: SKILL_STATUS_CN[s.status] || s.status })))),
			h(Card, { title: "记忆候选（L2/L4 生命周期）" },
				data && data.memories.length === 0 ? h("p", { className: "dfy-muted", style: { fontSize: 12.5 } }, "暂无记忆候选") : null,
				(data ? data.memories : []).slice(0, 20).map((m) => h("div", { key: m.id + "@" + m.revision, style: { fontSize: 12.5, padding: "5px 0", borderBottom: "0.5px dashed var(--dsw-alias-border-l1, #d8e2e0)" } },
					h("div", null, h("b", null, "[" + m.layer + "]"), " " + (m.claim.length > 46 ? m.claim.slice(0, 46) + "…" : m.claim)),
					h("div", { className: "dfy-muted", style: { fontSize: 11.5 } },
						"证据 " + m.supportingEvidence.length + " 支持 / " + m.counterEvidence.length + " 反例 · 场景 " + m.scene + " · 复核 " + m.reviewAfter.slice(0, 10)),
					h("div", { style: { marginTop: 2 } }, h(Badge, { tone: m.status === "active" ? "ok" : m.status === "challenged" ? "err" : "idle", text: MEMORY_STATUS_CN[m.status] || m.status })))),
				data ? h("p", { className: "dfy-caption", style: { fontSize: 11, marginTop: 6 } }, data.memoryNotes.join("；")) : null),
			h(Card, { title: "发布链（灰度 5→20→50→100，每日一次晋级）", extra: status && status.activeReleaseId ? h(Badge, { tone: "ok", text: "active：" + status.activeReleaseId }) : h(Badge, { tone: "idle", text: "基线（无发布版本）" }) },
				data && data.releases.length === 0 ? h("p", { className: "dfy-muted", style: { fontSize: 12.5 } }, "暂无发布记录（基线运行）" ) : null,
				(data ? data.releases : []).map((r) => h("div", { key: r.release_id, style: { display: "flex", gap: 8, fontSize: 12.5, padding: "4px 0", alignItems: "center" } },
					h("span", { style: { flex: 1 } }, r.release_id),
					r.canary_fraction > 0 && r.canary_fraction < 1 ? h("span", { className: "dfy-muted" }, "灰度 " + Math.round(r.canary_fraction * 100) + "%") : null,
					h(Badge, { tone: r.release_id === (data && data.active) ? "ok" : r.status === "rolled_back" ? "err" : "idle", text: RELEASE_STATUS_CN[r.status] || r.status }))),
				h("div", { style: { display: "flex", gap: 10, marginTop: 8 } },
					h(Btn, { disabled: busy || !status || !status.activeReleaseId, onClick: () => act("release/rollback", {}, "恢复稳定版本"), style: { flex: "0 0 130px" } }, "恢复稳定版本"))),
			h(Card, { title: "审计与决策（最近）" },
				data && data.decisions.length > 0 ? h("div", { style: { marginBottom: 6 } },
					h("div", { style: { fontWeight: 700, fontSize: 12, margin: "4px 0" } }, "政策决策"),
					data.decisions.map((d) => h("div", { key: d.decision_id, style: { display: "flex", gap: 8, fontSize: 12, padding: "2px 0", className: "dfy-muted" } },
						h("span", { style: { flex: 1 } }, d.action + " · " + d.decision_id),
						h(Badge, { tone: d.result === "allow" ? "ok" : d.result === "deny" ? "err" : "warn", text: d.result })))) : null,
				data && data.audits.length > 0 ? h("div", null,
					h("div", { style: { fontWeight: 700, fontSize: 12, margin: "4px 0" } }, "审计事件"),
					data.audits.slice(0, 15).map((a) => h("div", { key: a.audit_id, style: { fontSize: 11.5, padding: "2px 0", className: "dfy-muted" } },
						a.created_at.slice(5, 16).replace("T", " ") + " · " + a.action + " · " + a.summary))) : h("p", { className: "dfy-muted", style: { fontSize: 12.5 } }, "暂无审计事件"),
				data ? h("p", { className: "dfy-caption", style: { fontSize: 11, marginTop: 6 } }, data.auditNotes.join("；")) : null));
	}

	// ------------------------------------------------------------------ 面板外壳

	const TABS = [
		{ id: "home", label: "首页", render: (ctx) => h(HomeTab, ctx) },
		{ id: "wizard", label: "首次配置", render: (ctx) => h(WizardTab, { onSaved: ctx.refresh }) },
		{ id: "preview", label: "直播预览", render: (ctx) => h(PreviewTab, ctx) },
		{ id: "training", label: "训练与学习", render: (ctx) => h(TrainingTab, ctx) },
		{ id: "interact", label: "互动与账本", render: () => h(InteractTab) },
		{ id: "audience", label: "观众", render: () => h(AudienceTab) },
		{ id: "gov", label: "治理", render: (ctx) => h(GovernanceTab, ctx) },
		{ id: "diag", label: "诊断", render: () => h(DiagTab) },
	];

	function Panel() {
		const [tab, setTab] = useState("home");
		const [status, setStatus] = useState(null);
		const [note, setNote] = useState("");
		const [busy, setBusy] = useState(false);

		const refresh = useCallback(async () => {
			try {
				const r = await api("status");
				if (r.ok) setStatus(r.status);
			} catch { /* 面板离线时保留上次状态 */ }
		}, []);

		useEffect(() => {
			refresh();
			const t = setInterval(refresh, 5000);
			return () => clearInterval(t);
		}, [refresh]);

		const act = async (path, body, label) => {
			setBusy(true); setNote(label + "…");
			try {
				const r = await api(path, body || {});
				setNote(label + (r.ok ? " ✓" : " 失败：" + (r.error || "未知错误")));
				if (r.ok && r.status) setStatus(r.status); else await refresh();
				if (r.ok && r.result && typeof r.result === "object" && r.result.reason) setNote(label + "未通过：" + r.result.reason);
				else if (r.ok && r.result && typeof r.result === "object" && r.result.detail) setNote(label + "：" + r.result.detail);
			} catch (e) { setNote(label + " 请求失败：" + e.message); }
			setBusy(false);
		};

		const ctx = { status: status, act: act, busy: busy, refresh: refresh, goTab: setTab };
		const current = TABS.find((t) => t.id === tab) || TABS[0];
		const live = status && status.liveStatus === "live_confirmed";
		const starting = status && ["self_check", "local_preview", "awaiting_platform", "stream_established"].includes(status.liveStatus);
		const headTone = live ? "ok" : starting ? "warn" : "idle";

		return h("div", { className: "dfy-panel", style: { padding: 18, maxWidth: 620, margin: "0 auto", minHeight: "100%" } },
			h("div", { style: { display: "flex", alignItems: "center", gap: 10, marginBottom: 6 } },
				h(FishIcon, { size: 30 }),
				h("h2", { style: { margin: 0, fontSize: 17, flex: 1 } }, "大肥鱼直播"),
				live || starting || status ? h(Badge, { tone: headTone, dot: live, text: status ? status.liveDisplay : "连接中…" }) : h(Badge, { tone: "idle", text: "连接中…" })),
			h("p", { className: "dfy-muted", style: { fontSize: 12, margin: "0 0 12px" } }, "本地优先 · 自学习直播系统 · 平台未确认绝不显示直播中"),
			h("div", { style: { display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 14 } },
				TABS.map((t) => h("button", {
					key: t.id, onClick: () => setTab(t.id),
					className: "dfy-tab" + (tab === t.id ? " dfy-tab-active" : ""),
				}, t.label))),
			current.render(ctx),
			note && tab !== "wizard" && tab !== "interact" ? h("p", { className: "dfy-muted", style: { fontSize: 12, marginTop: 10, wordBreak: "break-all" } }, note) : null,
			h("button", {
				disabled: busy || !status, onClick: () => act("live/emergency-stop", {}, "紧急停止播出"), className: "dfy-emergency",
			}, "紧急停止播出"),
			h("p", { className: "dfy-caption", style: { fontSize: 11, marginTop: 8 } }, "紧急停止播出立即进入安全场景（停止语音与动作输出）；与「暂停学习」（仅停学习写入/训练/发布）不同。"));
	}

	const apply = (ctx) => {
		ensureStyle();
		ctx.slots.inject("sidebar.panellist", () => ctx.slots.register(
			{ name: "sidebar.panellist", id: PANEL_ID, order: 60, label: () => "大肥鱼直播" },
			(owner = {}) => h(FishIcon, { size: owner.size ?? 16 })));
		ctx.slots.inject("main", () => ctx.slots.register(
			{ name: "main", key: PANEL_ID },
			() => h(Panel)));
	};

	return { apply, inject: ["slots"], name: "dsh-dafeiyu-evolve" };
}});
