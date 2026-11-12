/* dsh-dafeiyu-evolve · Web 客户端半（四主操作直播面板）
 * 装载：宿主 client-modules 经 dsh.client 声明加载本文件；
 * 交互：同源共享 API /api/dafeiyu/*（宿主 connection/request 承接）。 */
window.__ModuleLoader__.load({ id: "dsh-dafeiyu-evolve", factory: (require) => {
	const react = require("react");
	const { useState, useEffect, useCallback, createElement: h } = react;

	const PANEL_ID = "dafeiyu-live";
	const C = { teal: "#0f5e57", gold: "#ffd166", ink: "#17303c", red: "#c0392b", line: "#d8e2e0", bg: "#f6faf9" };

	const FishIcon = ({ size = 16 }) => h("svg", { width: size, height: size, viewBox: "0 0 64 64", "aria-hidden": true },
		h("rect", { x: 2, y: 2, width: 60, height: 60, rx: 14, fill: C.teal }),
		h("ellipse", { cx: 30, cy: 34, rx: 20, ry: 12, fill: C.gold }),
		h("path", { d: "M46 28 L58 22 L54 34 L58 46 L46 40 Z", fill: C.gold }),
		h("circle", { cx: 20, cy: 30, r: 3, fill: C.ink }),
		h("path", { d: "M14 40 Q26 48 38 40", stroke: C.ink, strokeWidth: 2.5, fill: "none", strokeLinecap: "round" }),
		h("circle", { cx: 44, cy: 14, r: 5, fill: "#4ecdc4", opacity: 0.85 }));

	async function api(path, body) {
		const res = await fetch("/api/dafeiyu/" + path, {
			method: body ? "POST" : "GET",
			headers: body ? { "content-type": "application/json" } : undefined,
			body: body ? JSON.stringify(body) : undefined,
			credentials: "same-origin",
		});
		return res.json();
	}

	const Btn = ({ onClick, disabled, tone, children }) => h("button", {
		onClick, disabled,
		style: {
			flex: "1 1 40%", padding: "10px 12px", borderRadius: 10, border: "none", cursor: disabled ? "not-allowed" : "pointer",
			fontSize: 13, fontWeight: 600, color: tone === "primary" ? "#fff" : C.ink,
			background: tone === "primary" ? C.teal : tone === "ghost" ? "transparent" : "#fff",
			border: tone === "ghost" ? "none" : "1px solid " + C.line,
			boxShadow: tone === "primary" ? "0 2px 8px rgba(15,94,87,.25)" : "none",
			opacity: disabled ? 0.45 : 1,
		},
	}, children);

	const Stat = ({ label, value }) => h("div", { style: { display: "flex", justifyContent: "space-between", fontSize: 12.5, padding: "4px 0", borderBottom: "1px dashed " + C.line } },
		h("span", { style: { color: "#5b6f6c" } }, label), h("span", { style: { fontWeight: 600, color: C.ink } }, value));

	function Panel() {
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
				if (r.ok && r.result && typeof r.result === "object" && r.result.detail) setNote(label + "：" + r.result.detail);
			} catch (e) { setNote(label + " 请求失败：" + e.message); }
			setBusy(false);
		};

		const s = status;
		const live = s && (s.liveStatus === "live_confirmed");
		const starting = s && ["self_check", "local_preview", "awaiting_platform", "stream_established"].includes(s.liveStatus);
		const canTrain = s && s.trainingEligible && !s.learningPaused;

		return h("div", { style: { padding: 18, maxWidth: 560, margin: "0 auto", color: C.ink, background: C.bg, minHeight: "100%" } },
			h("div", { style: { display: "flex", alignItems: "center", gap: 10, marginBottom: 6 } },
				h(FishIcon, { size: 30 }),
				h("h2", { style: { margin: 0, fontSize: 17, flex: 1 } }, "大肥鱼直播"),
				h("span", {
					style: { fontSize: 12, fontWeight: 700, padding: "3px 10px", borderRadius: 999, background: live ? C.teal : starting ? C.gold : "#e4ebe9", color: live ? "#fff" : C.ink },
				}, s ? s.liveDisplay : "连接中…")),
			h("p", { style: { fontSize: 12, color: "#5b6f6c", margin: "0 0 14px" } },
				"本地优先 · 自学习直播系统（阶段 A–G 交付）"),
			h("div", { style: { background: "#fff", borderRadius: 12, padding: "10px 14px", marginBottom: 12, boxShadow: "0 1px 4px rgba(23,48,60,.06)" } },
				h(Stat, { label: "运行模式", value: s ? s.mode + (s.killSwitch ? "（killSwitch）" : "") : "—" }),
				h(Stat, { label: "学习状态", value: s ? (s.learningPaused ? "已暂停" : "观察学习中") : "—" }),
				h(Stat, { label: "当前版本", value: s && s.activeReleaseId ? s.activeReleaseId : "基线" }),
				h(Stat, { label: "云端兜底", value: s ? (s.cloudEnabled ? "已启用" : "未配置（不产生付费调用）") : "—" }),
				h(Stat, { label: "训练机会", value: s ? (s.trainingEligible ? "样本/资源/政策门通过" : s.trainingEligibleDetail) : "—" })),
			s && s.liveStatus === "awaiting_platform" ? h("div", { style: { fontSize: 12.5, background: "#fff7df", border: "1px solid " + C.gold, borderRadius: 10, padding: "8px 12px", marginBottom: 12 } },
				"平台状态待确认：在直播伴侣完成开播后，点击「我已在官方客户端开播」同步状态。") : null,
			h("div", { style: { display: "flex", flexWrap: "wrap", gap: 10 } },
				h(Btn, { tone: "primary", disabled: busy || !s || live, onClick: () => act("live/start", {}, "开始直播") }, starting ? "开播进行中…" : "开始直播"),
				h(Btn, { disabled: busy || !s || (!live && !starting), onClick: () => act("live/stop", {}, "结束直播") }, "结束直播"),
				s && s.liveStatus === "awaiting_platform" ? h(Btn, { disabled: busy, onClick: () => act("live/operator-confirm", {}, "我已在官方客户端开播") }, "我已在官方客户端开播") : null,
				h(Btn, { disabled: busy || !s || !canTrain, onClick: () => act("training/train-once", {}, "训练一次") }, "训练一次"),
				h(Btn, { disabled: busy || !s, onClick: () => act(s && s.learningPaused ? "learning/resume" : "learning/pause", {}, s && s.learningPaused ? "恢复学习" : "暂停学习") }, s && s.learningPaused ? "恢复学习" : "暂停学习"),
				h(Btn, { disabled: busy || !s || !s.activeReleaseId, onClick: () => act("release/rollback", {}, "恢复稳定版本") }, "恢复稳定版本")),
			note ? h("p", { style: { fontSize: 12, color: "#5b6f6c", marginTop: 10, wordBreak: "break-all" } }, note) : null,
			h("button", {
				disabled: busy || !s, onClick: () => act("live/emergency-stop", {}, "紧急停止播出"),
				style: {
					position: "sticky", bottom: 12, marginTop: 18, width: "100%", padding: 12, borderRadius: 12, cursor: "pointer",
					background: C.red, color: "#fff", fontSize: 14, fontWeight: 700, border: "none",
					boxShadow: "0 4px 14px rgba(192,57,43,.35)",
				},
			}, "紧急停止播出"),
			h("p", { style: { fontSize: 11, color: "#8aa09b", marginTop: 8 } }, "紧急停止播出立即进入安全场景；与「暂停学习」（仅停学习写入/训练/发布）不同。"));
	}

	const apply = (ctx) => {
		ctx.slots.inject("sidebar.panellist", () => ctx.slots.register(
			{ name: "sidebar.panellist", id: PANEL_ID, order: 60, label: () => "大肥鱼直播" },
			(owner = {}) => h(FishIcon, { size: owner.size ?? 16 })));
		ctx.slots.inject("main", () => ctx.slots.register(
			{ name: "main", key: PANEL_ID },
			() => h(Panel)));
	};

	return { apply, inject: [], name: "dsh-dafeiyu-evolve" };
}});
