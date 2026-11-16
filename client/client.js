/* dsh-dafeiyu-evolve · Web 客户端半（直播控制台）
 * 装载：宿主 client-modules 经 dsh.client 声明加载本文件（单文件装载契约）。
 * 交互：同源共享 API /api/dafeiyu/*（宿主 connection/request 承接）。
 *
 * 布局：语义化控制台骨架 —— 头部（身份+状态）/ 页签 / 可滚动内容区 / 固定页脚（紧急停止常显）。
 * 内容区用 CSS Grid（repeat(auto-fit,minmax)）而非 flex 换行堆叠：卡片等高对齐、间距走 gap、
 * 8px 节奏（8/12/16/24），宽屏自动多列、窄屏单列，与宿主内页（上下文洞察等）同语言。
 * 主题：dfy-* 类全部引用宿主 --dsw-* 设计变量并带降级值，亮/暗随 body[data-ds-dark-theme] 切换。 */
window.__ModuleLoader__.load({ id: "dsh-dafeiyu-evolve", factory: (require) => {
	const react = require("react");
	const { useState, useEffect, useCallback, useRef, createElement: h } = react;

	const PANEL_ID = "dafeiyu-live";
	const DSW_BLUE = "var(--dsw-static-deepseek-500, #4176e6)";
	const STYLE_ID = "dfy-panel-style";

	// ------------------------------------------------------------------ 样式（一次注入，幂等）

	const CSS = `
.dfy-root{height:100%;min-height:0;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base,#f6faf9);color:var(--dsw-alias-label-primary,#17303c);font-family:var(--dsw-font-family,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif);font-size:13px;line-height:1.5}
.dfy-root *,.dfy-root *::before,.dfy-root *::after{box-sizing:border-box}
.dfy-head{display:flex;align-items:center;gap:12px;padding:12px 16px;border-bottom:.5px solid var(--dsw-alias-border-l1,#d8e2e0)}
.dfy-head-t{min-width:0}
.dfy-head-t h2{margin:0;font-size:15px;font-weight:700}
.dfy-head-t p{margin:1px 0 0;font-size:11.5px}
.dfy-head-x{margin-left:auto;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dfy-tab{appearance:none;background:transparent;border:0;border-bottom:2px solid transparent;color:var(--dsw-alias-label-secondary,#45606b);font:inherit;font-size:12.5px;font-weight:500;padding:6px 10px 8px;border-radius:6px 6px 0 0;cursor:pointer;white-space:nowrap}
.dfy-tab:hover{color:var(--dsw-alias-label-primary,#17303c);background:var(--dsw-alias-interactive-bg-hover,rgba(15,94,87,.06))}
.dfy-tab-on{color:var(--dsw-alias-state-business-primary,#0f5e57);border-bottom-color:var(--dsw-alias-state-business-primary,#0f5e57);font-weight:700}
.dfy-body{flex:1;min-height:0;overflow-y:auto;padding:16px}
.dfy-foot{display:flex;align-items:center;gap:12px;padding:8px 16px;border-top:.5px solid var(--dsw-alias-border-l1,#d8e2e0);background:var(--dsw-alias-bg-layer-1,#fff)}
.dfy-foot .dfy-caption{flex:1;min-width:0}
.dfy-grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(min(320px,100%),1fr));align-items:start}
.dfy-spanall{grid-column:1/-1}
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
.dfy-note{display:grid;gap:8px;padding:8px 12px;border-radius:10px;font-size:12.5px;border:.5px solid transparent}
.dfy-note-warn{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#ffd166) 12%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#d9b44a) 50%,transparent)}
.dfy-note-ok{background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#1c7a54) 9%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#1c7a54) 28%,transparent);color:var(--dsw-alias-state-success-primary,#1c7a54)}
/* 状态横幅：直播状态最高视觉权重 */
/* 语义 toast：role=status / aria-live */
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
.dfy-input:disabled{color:var(--dsw-alias-label-tertiary,#5b6f6c);background:var(--dsw-alias-bg-layer-2,#eef2f1)}
.dfy-check{display:flex;align-items:flex-start;gap:8px;font-size:12.5px}
.dfy-check input{flex:0 0 auto;margin-top:3px}
.dfy-link{color:var(--dsw-alias-link,#0f5e57);text-decoration:none}
.dfy-link:hover{text-decoration:underline}
.dfy-choice{display:flex;flex-wrap:wrap;gap:8px}
.dfy-chip{appearance:none;display:inline-flex;align-items:center;gap:8px;padding:6px 10px;border-radius:10px;border:.5px solid var(--dsw-alias-border-l2,#d8e2e0);background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#17303c);font:inherit;font-size:12.5px;cursor:pointer}
.dfy-chip:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(15,94,87,.07))}
.dfy-chip-on{border:1.5px solid var(--dsw-alias-state-business-primary,#0f5e57);background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#0f5e57) 8%,transparent)}
.dfy-wizard{display:grid;gap:12px;grid-template-columns:minmax(180px,230px) minmax(0,1fr);align-items:start}
.dfy-rail{display:grid;gap:4px;align-content:start;padding:6px;border-radius:12px;background:var(--dsw-alias-bg-layer-1,#fff);border:.5px solid var(--dsw-alias-border-l1,#d8e2e0)}
.dfy-rail-i{appearance:none;display:grid;gap:2px;text-align:left;padding:8px 10px;border-radius:8px;border:.5px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary,#45606b);font:inherit;font-size:12.5px;cursor:pointer}
.dfy-rail-i:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(15,94,87,.06))}
.dfy-rail-i-on{background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#0f5e57) 9%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary,#0f5e57) 34%,transparent);color:var(--dsw-alias-label-primary,#17303c);font-weight:700}
.dfy-rail-n{font-size:11px;font-weight:500;color:var(--dsw-alias-label-tertiary,#5b6f6c)}
.dfy-canvas{position:relative;width:100%;aspect-ratio:16/9;border-radius:12px;overflow:hidden;border:.5px solid var(--dsw-alias-border-l2,#d8e2e0)}
/* 预览页画布 + 信息双栏：宽屏并排、窄屏堆叠 */
.dfy-split{display:grid;grid-template-columns:minmax(0,1.6fr) minmax(220px,1fr);gap:12px;align-items:start}
@media (max-width:760px){.dfy-split{grid-template-columns:1fr}}
.dfy-root button:focus-visible,.dfy-root a:focus-visible,.dfy-root input:focus-visible,.dfy-root select:focus-visible{outline:2px solid var(--dsw-focus-ring-color,rgba(15,94,87,.6));outline-offset:2px}
@media (max-width:760px){.dfy-wizard{grid-template-columns:1fr}.dfy-body{padding:12px}.dfy-head,.dfy-foot{padding-left:12px;padding-right:12px}.dfy-kpis{grid-template-columns:repeat(auto-fit,minmax(104px,1fr))}}
/* 大肥鱼桌宠：桌面小组件窗口（非 16:9 画布）+ 悬浮感 + 气泡 + 摆尾/呼吸动画 */
.dfy-pet-wrap{display:flex;justify-content:center;align-items:center;padding:18px;border-radius:16px;background:radial-gradient(circle at 50% 28%,var(--dsw-alias-interactive-bg-hover,rgba(15,94,87,.10)),transparent 72%)}
.dfy-pet-window{position:relative;width:min(360px,100%);border-radius:18px;overflow:hidden;border:.5px solid var(--dsw-alias-border-l2,#d8e2e0);box-shadow:0 14px 32px rgba(8,19,26,.24),0 2px 6px rgba(8,19,26,.12);background:var(--dsw-alias-bg-layer-1,#fff);animation:dfy-pet-float 4s ease-in-out infinite}
.dfy-pet-title{display:flex;align-items:center;gap:8px;padding:8px 12px;font-size:12px;font-weight:700;color:var(--dsw-alias-label-primary,#17303c);border-bottom:.5px solid var(--dsw-alias-border-l1,#e3ebe9);background:var(--dsw-alias-bg-layer-1,#fff)}
.dfy-pet-dots{display:inline-flex;gap:5px;flex:0 0 auto}
.dfy-pet-dots i{display:block;width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-error-primary,#c0392b)}
.dfy-pet-dots i:nth-child(2){background:var(--dsw-alias-state-warn-primary,#d9b44a)}
.dfy-pet-dots i:nth-child(3){background:var(--dsw-alias-state-success-primary,#1c7a54)}
.dfy-pet-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dfy-pet-title-tag{margin-left:auto;font-size:10.5px;font-weight:600;color:var(--dsw-alias-label-tertiary,#5b6f6c)}
.dfy-pet-scene{position:relative;display:flex;align-items:center;justify-content:center;min-height:180px;padding:16px;overflow:hidden;background:linear-gradient(155deg,var(--dsw-alias-state-business-primary,#0f5e57) 0%,#0a2724 100%)}
.dfy-pet-scene::after{content:"";position:absolute;inset:0;background:radial-gradient(circle at 78% 18%,rgba(255,209,102,.20),transparent 46%);pointer-events:none}
.dfy-pet-fish{position:relative;z-index:1;animation:dfy-pet-float 3.2s ease-in-out infinite;filter:drop-shadow(0 8px 12px rgba(0,0,0,.35))}
.dfy-pet-sway{display:block;transform-origin:70% 50%;animation:dfy-pet-tail 1.3s ease-in-out infinite}
.dfy-pet-bubbles{position:absolute;inset:0;pointer-events:none;z-index:1}
.dfy-pet-bubbles i{position:absolute;bottom:12px;width:8px;height:8px;border-radius:50%;background:rgba(255,255,255,.40);animation:dfy-pet-bubble 4.6s linear infinite}
.dfy-pet-bubbles i:nth-child(1){left:20%;animation-delay:0s}
.dfy-pet-bubbles i:nth-child(2){left:30%;width:6px;height:6px;animation-delay:1.5s}
.dfy-pet-bubbles i:nth-child(3){left:76%;animation-delay:2.7s}
.dfy-pet-ai{position:absolute;top:10px;right:10px;z-index:4;font-size:10.5px;font-weight:700;padding:3px 9px;border-radius:999px;background:rgba(192,57,43,.95);color:#fff;box-shadow:0 2px 6px rgba(0,0,0,.30)}
.dfy-pet-bubble{position:absolute;left:50%;top:16px;transform:translateX(-50%);z-index:3;max-width:80%;min-width:110px;padding:7px 12px;border-radius:14px;font-size:12px;font-weight:600;text-align:center;overflow-wrap:anywhere;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#17303c);border:.5px solid var(--dsw-alias-border-l1,#d8e2e0);box-shadow:0 4px 12px rgba(0,0,0,.20)}
.dfy-pet-bubble::after{content:"";position:absolute;left:50%;bottom:-6px;transform:translateX(-50%);border:6px solid transparent;border-top-color:var(--dsw-alias-bg-layer-1,#fff);border-bottom:0}
.dfy-pet-bubble-on{border-color:var(--dsw-alias-state-warn-primary,#ffd166);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-state-warn-primary,#ffd166) 55%,transparent),0 4px 12px rgba(0,0,0,.22)}
.dfy-pet-status{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;padding:8px 12px;font-size:11px;color:var(--dsw-alias-label-secondary,#45606b);background:var(--dsw-alias-bg-layer-2,#eef2f1)}
@keyframes dfy-pet-float{0%,100%{transform:translateY(0)}50%{transform:translateY(-7px)}}
@keyframes dfy-pet-tail{0%,100%{transform:rotate(-8deg)}50%{transform:rotate(8deg)}}
@keyframes dfy-pet-bubble{0%{transform:translateY(0);opacity:0}20%{opacity:.7}100%{transform:translateY(-120px);opacity:0}}
/* Live2D 桌宠场景：贴满场景区，canvas 透明背景叠在渐变底上；加载提示小字不挡模型 */
.dfy-pet-window-model{animation:none}
.dfy-pet-window-model .dfy-pet-scene{min-height:240px}
.dfy-pet-model-caption{margin:0;padding:8px 12px;min-height:36px;color:var(--dsw-alias-label-primary,#17303c);font-size:12px;text-align:center;overflow-wrap:anywhere;border-bottom:.5px solid var(--dsw-alias-border-l1,#d8e2e0)}
.dfy-pet-model-caption-on{background:var(--dsw-alias-interactive-bg-hover,#e7f4ef)}
.dfy-preview-conversation textarea,.dfy-model-picker select{width:100%;border:1px solid var(--dsw-alias-border-l2,#d8e2e0);border-radius:6px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#17303c);font:inherit;padding:6px 8px}
.dfy-preview-conversation textarea{resize:vertical}
.dfy-pet-l2d{position:absolute;inset:0;z-index:2;cursor:pointer}
.dfy-pet-l2d canvas{display:block;width:100%;height:100%}
.dfy-pet-l2d-note{position:absolute;bottom:6px;left:8px;max-width:70%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10px;color:rgba(255,255,255,.55);pointer-events:none}
/* 角色档案卡（参照 eciyuan.qq.com CHARACTERS）：中文名/英文名/#标签 + 年龄·身高·星座·MBTI */
.dfy-profiles{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(min(210px,100%),1fr));align-items:start}
.dfy-profile{position:relative;display:grid;gap:8px;min-width:0;padding:14px;border-radius:14px;border:.5px solid var(--dsw-alias-border-l2,#d8e2e0);background:var(--dsw-alias-bg-layer-1,#fff);cursor:pointer;transition:border-color .15s,box-shadow .15s,transform .15s}
.dfy-profile:hover{border-color:var(--dsw-alias-state-business-primary,#0f5e57);transform:translateY(-1px)}
.dfy-profile:focus-visible{outline:2px solid var(--dsw-focus-ring-color,rgba(15,94,87,.6));outline-offset:2px}
.dfy-profile-on{border:1.5px solid var(--dsw-alias-state-business-primary,#0f5e57);box-shadow:0 6px 18px color-mix(in srgb,var(--dsw-alias-state-business-primary,#0f5e57) 16%,transparent)}
.dfy-profile-top{display:flex;align-items:flex-start;gap:8px;min-width:0}
.dfy-profile-badge{flex:0 0 auto;width:40px;height:40px;border-radius:12px;display:flex;align-items:center;justify-content:center;color:#fff;font-size:16px;font-weight:800;letter-spacing:.5px}
.dfy-profile-name{min-width:0}
.dfy-profile-zh{font-size:16px;font-weight:800;line-height:1.2;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dfy-profile-en{font-size:10.5px;font-weight:700;letter-spacing:1.5px;color:var(--dsw-alias-label-tertiary,#5b6f6c)}
.dfy-profile-src{margin-left:auto;flex:0 0 auto;font-size:10px;font-weight:700;padding:2px 7px;border-radius:999px;background:var(--dsw-alias-bg-layer-2,#eef2f1);color:var(--dsw-alias-label-secondary,#45606b)}
.dfy-profile-src-plugin{background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#0f5e57) 14%,transparent);color:var(--dsw-alias-state-business-primary,#0f5e57)}
.dfy-profile-tag{font-size:11.5px;color:var(--dsw-alias-label-secondary,#45606b);overflow-wrap:anywhere}
.dfy-profile-tag b{color:var(--dsw-alias-state-business-primary,#0f5e57);font-weight:800;margin-right:3px}
.dfy-profile-info{display:grid;gap:4px;padding-top:8px;border-top:.5px dashed var(--dsw-alias-border-l1,#e3ebe9)}
.dfy-profile-kv{display:flex;justify-content:space-between;gap:8px;font-size:11.5px}
.dfy-profile-kv span:first-child{color:var(--dsw-alias-label-tertiary,#5b6f6c)}
.dfy-profile-kv strong{font-weight:700;overflow-wrap:anywhere;text-align:right}
.dfy-profile-bio{font-size:11px;color:var(--dsw-alias-label-tertiary,#5b6f6c);line-height:1.5;overflow-wrap:anywhere}
.dfy-preview-conversation{border-top:1px solid var(--dsw-alias-border-l1,#d8e2e0);padding-top:8px}
.dfy-preview-conversation .dfy-actions{margin-top:6px}
.dfy-preview-conversation .dfy-caption:empty{display:none}
.dfy-role-preview{border:.5px solid var(--dsw-alias-border-l2,#d8e2e0);border-radius:14px;overflow:hidden;background:var(--dsw-alias-bg-layer-1,#fff)}
.dfy-role-stage{position:relative;display:grid;place-items:center;min-height:220px;aspect-ratio:16/10;overflow:hidden}
.dfy-role-stage .dfy-idle-video-hidden{visibility:hidden}
.dfy-stage-voice{position:absolute;top:12px;left:12px;display:flex;align-items:center;gap:8px;border-radius:7px;padding:5px 8px;background:#17303c;color:#fff;font-size:12px}
.dfy-speech-meter{width:38px;height:4px;border-radius:4px;background:#54616a;overflow:hidden}
.dfy-speech-meter i{display:block;width:100%;height:100%;background:#94e2d9;transform:scaleX(.05);transform-origin:left}
.dfy-stage-message{position:absolute;z-index:4;left:12px;right:12px;bottom:12px;margin:0;padding:7px 9px;background:#17303c;color:#fff;border-radius:7px;font-size:12px;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.dfy-role-stage :is(img,video){display:block;width:100%;height:100%;position:absolute;inset:0;object-fit:cover;object-position:center}
.dfy-role-initial{font-size:28px;font-weight:700}
.dfy-role-caption{padding:10px 12px;display:grid;gap:4px}
.dfy-role-caption p{margin:0;overflow-wrap:anywhere}
.dfy-role-caption-speaking{background:var(--dsw-alias-interactive-bg-hover,#e7f4ef)}
.dfy-role-audio{display:grid;gap:5px}
.dfy-role-audio audio{width:100%;height:36px}
.dfy-l2d-hit{position:absolute;inset:0;background:transparent;border:0;cursor:pointer}
.dfy-l2d-hit:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#0f5e57);outline-offset:-3px}
.dfy-profile-hero{display:grid;gap:10px}
.dfy-profile-hero .dfy-profile-zh{font-size:24px}
.dfy-profile-hero .dfy-profile-en{font-size:12px;letter-spacing:3px}
.dfy-profile-hero .dfy-profile-info{grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px}
.dfy-desk-root{--desk-bg:var(--dsw-alias-bg-base,#edf2f1);--desk-sheet:var(--dsw-alias-bg-layer-1,#fff);--desk-line:var(--dsw-alias-border-l1,#dce5e2);--desk-text:var(--dsw-alias-label-primary,#102922);--desk-muted:var(--dsw-alias-label-secondary,#536a61);--desk-accent:var(--dsw-alias-state-business-primary,#176452);background:var(--desk-bg);color:var(--desk-text);font-family:var(--dsw-font-family,Inter,"PingFang SC","Microsoft YaHei",sans-serif)}
.dfy-desk-header{padding:10px 20px;background:var(--desk-sheet);min-height:54px}
.dfy-desk-header h2{font-size:15px;white-space:nowrap;margin:0;letter-spacing:.02em}
.dfy-desk-nav{display:flex;gap:4px;margin-left:10px}
.dfy-desk-body{padding:clamp(12px,2.4vw,28px)}
.dfy-workbench{max-width:1180px;margin:0 auto;display:grid;grid-template-columns:minmax(0,1fr) minmax(230px,29%);gap:18px;align-items:start}
.dfy-desk-preview,.dfy-desk-controls{min-width:0;border:1px solid var(--desk-line);border-radius:16px;background:var(--desk-sheet)}
.dfy-desk-preview{padding:14px;display:grid;gap:10px}
.dfy-desk-stage-head,.dfy-desk-selectors{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.dfy-desk-stage-head{justify-content:space-between}
.dfy-desk-stage-head h3,.dfy-desk-section h3{margin:0;font-size:13px;font-weight:700}
.dfy-desk-selectors{align-items:end}
.dfy-desk-selectors .dfy-field{flex:1;min-width:118px}
.dfy-desk-selectors select{min-width:0;width:100%;padding:6px 8px;border:1px solid var(--desk-line);background:var(--desk-sheet);color:inherit;border-radius:7px;font:inherit}
.dfy-desk-preview .dfy-role-stage{width:100%;aspect-ratio:auto;height:clamp(210px,35vh,350px)}
.dfy-desk-preview .dfy-role-stage :is(img,video){object-fit:cover;object-position:center 42%}
.dfy-desk-preview .dfy-pet-wrap{padding:0;background:none}
.dfy-desk-preview .dfy-pet-window{width:100%;box-shadow:none;animation:none}
.dfy-desk-preview .dfy-pet-scene{min-height:clamp(205px,31vh,320px)}
.dfy-desk-preview .dfy-preview-conversation{border-top:0;padding-top:0}
.dfy-desk-preview .dfy-preview-conversation textarea{border-color:var(--desk-line);background:var(--desk-bg)}
.dfy-desk-preview .dfy-role-audio{margin:0 0 8px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dfy-desk-preview .dfy-role-audio audio{width:min(320px,100%)}
.dfy-desk-preview .dfy-pet-model-caption,.dfy-desk-preview .dfy-role-caption{min-height:0}
.dfy-desk-speak-options{display:flex;gap:9px;align-items:center;flex-wrap:wrap}
.dfy-desk-speak-options label,.dfy-interaction-head label{display:flex;align-items:center;gap:5px;font-size:12px;color:var(--desk-muted)}
.dfy-interaction-head,.dfy-turn-head{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:7px}
.dfy-interaction-head h4{margin:0;font-size:14px}
.dfy-turns{list-style:none;margin:8px 0;padding:5px 8px;min-height:62px;max-height:260px;overflow:auto;overscroll-behavior:contain;border:1px solid var(--desk-line);border-radius:9px;background:var(--desk-bg)}
.dfy-turns li{padding:8px 3px;min-width:0}
.dfy-turns li+li{border-top:1px solid var(--desk-line)}
.dfy-turn-head time{margin-left:auto;color:var(--desk-muted);font-size:11px}
.dfy-turn-text,.dfy-turn-answer{margin:4px 0;overflow-wrap:anywhere;white-space:pre-wrap}
.dfy-turn-answer{border-left:2px solid var(--desk-accent);padding:4px 8px;background:var(--desk-sheet);border-radius:0 6px 6px 0}
.dfy-turn-meta{font-size:11px;color:var(--desk-muted)}
.dfy-canvas-subtitle{position:absolute;top:34px;left:12px;right:12px;color:#fff;font-size:12px;margin:0;overflow-wrap:anywhere}
.dfy-desk-safe{position:relative;min-height:205px;border-radius:12px;background:#142821;color:#e8f2ec;display:grid;align-content:center;justify-items:center;gap:8px}
.dfy-desk-safe strong{font-size:20px}
.dfy-desk-inline{margin:0;color:var(--desk-muted)}
.dfy-desk-controls{position:sticky;top:0;overflow:hidden}
.dfy-desk-section{padding:16px;display:grid;gap:9px}
.dfy-desk-section + .dfy-desk-section{border-top:1px solid var(--desk-line)}
.dfy-desk-section p{margin:0;overflow-wrap:anywhere}
.dfy-desk-state{font-size:clamp(17px,2.1vw,23px);font-weight:700;letter-spacing:-.02em}
.dfy-desk-link{display:block;text-align:center;text-decoration:none}
.dfy-desk-learning{display:grid;grid-template-columns:1fr 1fr;gap:6px}
.dfy-desk-summary{display:grid;grid-template-columns:1fr 1fr;margin:0;border-top:1px solid var(--desk-line)}
.dfy-desk-summary div{padding:12px 16px}
.dfy-desk-summary div + div{border-left:1px solid var(--desk-line)}
.dfy-desk-summary dt{font-size:12px;color:var(--desk-muted)}
.dfy-desk-summary dd{font-weight:650;margin:2px 0 0;font-variant-numeric:tabular-nums}
.dfy-desk-text-button{color:var(--desk-accent);font:inherit;background:none;border:0;padding:0;text-decoration:underline;cursor:pointer}
.dfy-desk-foot{min-height:50px;padding-inline:20px}
.dfy-desk-foot .dfy-caption{overflow-wrap:anywhere}
.dfy-desk-foot .dfy-btn{flex-shrink:0}
.dfy-manage{max-width:1180px;margin:0 auto;display:grid;grid-template-columns:140px minmax(0,1fr);gap:16px}
.dfy-manage-nav{display:flex;flex-direction:column;gap:4px;align-items:stretch}
.dfy-manage-nav button{text-align:left}
.dfy-manage-content{min-width:0}
@media(max-width:760px){
.dfy-workbench,.dfy-manage{grid-template-columns:minmax(0,1fr)}
.dfy-desk-controls{position:static}
.dfy-manage-nav{flex-direction:row;flex-wrap:wrap}
.dfy-desk-header,.dfy-desk-foot{padding-inline:10px;gap:6px}
.dfy-desk-nav{margin-left:0}
.dfy-desk-header .dfy-head-x{min-width:0}
}
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
			headers: body ? { "content-type": "application/json" } : undefined,
			body: body ? JSON.stringify(body) : undefined,
			credentials: "same-origin",
		});
		return res.json();
	}

	const Btn = ({ onClick, disabled, tone, title, children }) => h("button", {
		type: "button",
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

	/**
	 * 角色档案卡（仿 eciyuan.qq.com CHARACTERS）：
	 * 中文名 + 英文名 + #一句人设标签 + 年龄/身高/星座/MBTI 信息列表 + 来源徽章。
	 * selected/onSelect 存在时作为可选卡（button 语义 + 键盘可达）；hero 为只读放大展示。
	 */
	const ProfileCard = ({ profile: p, selected, onSelect, hero }) => {
		if (!p) return null;
		const cls = "dfy-profile" + (selected ? " dfy-profile-on" : "") + (hero ? " dfy-profile-hero" : "");
		const srcLabel = p.source === "plugin" ? "插件中" : "鹅次元";
		const body = [
			h("div", { className: "dfy-profile-top" },
				h("span", { className: "dfy-profile-badge", style: { background: (p.theme && p.theme.primary) || "#0f5e57" }, "aria-hidden": true }, (p.name || "?").slice(0, 1)),
				h("div", { className: "dfy-profile-name" },
					h("div", { className: "dfy-profile-zh" }, p.name),
					h("div", { className: "dfy-profile-en" }, p.enName)),
				h("span", { className: "dfy-profile-src" + (p.source === "plugin" ? " dfy-profile-src-plugin" : "") }, srcLabel)),
			h("div", { className: "dfy-profile-tag" }, h("b", null, "#"), p.tagline),
			h("div", { className: "dfy-profile-info" },
				[["年龄 / Age", "age"], ["身高 / Height", "height"], ["星座 / Zodiac", "zodiac"], ["性格 / MBTI", "mbti"]].map(([k, key]) =>
					h("div", { key: key, className: "dfy-profile-kv" }, h("span", null, k), h("strong", null, p[key] || "—")))),
			p.bio ? h("div", { className: "dfy-profile-bio" }, p.bio) : null,
		];
		if (onSelect) return h("button", { type: "button", className: cls, "aria-pressed": !!selected, onClick: onSelect }, body);
		return h("div", { className: cls }, body);
	};

	const Loading = ({ text }) => h("span", { className: "dfy-loading", role: "status" }, h("i", { className: "dfy-spin", "aria-hidden": true }), text || "加载中…");


	// ------------------------------------------------------------------ 图标（画布彩色鱼 / 导航单色剪影+蓝气泡）

	const FishIcon = ({ size = 16, theme, mouth }) => {
		if (theme) {
			return h("svg", { width: size, height: size, viewBox: "0 0 64 64", "aria-hidden": true },
				h("rect", { x: 2, y: 2, width: 60, height: 60, rx: 14, fill: theme.primary }),
				h("ellipse", { cx: 30, cy: 34, rx: 20, ry: 12, fill: theme.accent }),
				h("path", { d: "M46 28 L58 22 L54 34 L58 46 L46 40 Z", fill: theme.accent }),
				h("circle", { cx: 20, cy: 30, r: 3, fill: "#17303c" }),
				h("path", { ref: mouth, d: "M14 40 Q26 48 38 40", stroke: "#17303c", strokeWidth: 2.5, fill: "none", strokeLinecap: "round" }),
				h("circle", { cx: 44, cy: 14, r: 5, fill: "#4ecdc4", opacity: 0.85 }));
		}
		return h("svg", { width: size, height: size, viewBox: "0 0 64 64", "aria-hidden": true, style: { color: "inherit", flex: "0 0 auto" } },
			h("ellipse", { cx: 28, cy: 37, rx: 18, ry: 12, fill: "currentColor" }),
			h("path", { d: "M41 29 L57 22 L52 37 L57 52 L41 45 Z", fill: "currentColor" }),
			h("circle", { cx: 18.5, cy: 33, r: 2.8, fill: "var(--dsw-alias-bg-base, #f6faf9)" }),
			h("path", { d: "M14 42 Q25 48 36 44", stroke: "var(--dsw-alias-bg-base, #f6faf9)", strokeWidth: 2.2, fill: "none", strokeLinecap: "round" }),
			h("circle", { cx: 46, cy: 14, r: 4.2, fill: DSW_BLUE }),
			h("circle", { cx: 54, cy: 8.5, r: 2, fill: DSW_BLUE, opacity: 0.55 }));
	};

	// ------------------------------------------------------------------ 预览画布（浏览器渲染；本地预览 ≠ 已开播）

	const SCENE_BG = { teal: "#0f3d38", night: "#101c33", warm: "#3d2c10" };
	const AVATAR_THEME = {
		"fish-classic": { primary: "#0f5e57", accent: "#ffd166" },
		"fish-gold": { primary: "#8a6d1f", accent: "#ffe3a3" },
		"fish-night": { primary: "#1d3557", accent: "#7ae7ff" },
		"fish-deskpet": { primary: "#0f5e57", accent: "#ffd166" },
		"fish-deskpet-gold": { primary: "#8a6d1f", accent: "#ffe3a3" },
	};

	/** 桌宠形象判定：后端目录里 style==="deskpet" 的 avatarId 以 "deskpet" 标识。 */
	function isDeskpetId(avatarId) {
		return typeof avatarId === "string" && avatarId.indexOf("deskpet") !== -1;
	}

	// ------------------------------------------------------------------ Live2D 桌宠（0.14.0）
	// 架构对齐鹅次元的「形象层」：Cubism Core + pixi.js + pixi-live2d-display（vendor 随插件分发，
	// client/vendor/VENDOR-LICENSES.md），模型包本地数据目录管理（scripts/fetch-live2d-samples.sh）。
	// 客户端单文件契约：vendor 经 /api/dafeiyu/avatar/vendor 以脚本文本下发，blob <script> 顺序注入；
	// 模型文件经 /api/dafeiyu/avatar/model-file 以 base64 下发，重写 FileReferences 为 blob URL 后喂渲染器。
	// 任何一步失败都回退到 CSS 大肥鱼（不阻断预览）。

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

	function Live2DScene({ entry, onFail, speaking, mouthLevel }) {
		const host = useRef(null);
		const modelRef = useRef(null);
		const speechRef = useRef({ speaking: false, mouthLevel: null });
		const [ready, setReady] = useState(false);
		useEffect(() => { speechRef.current = { speaking, mouthLevel }; }, [speaking, mouthLevel]);
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
					const params = settings.getLipSyncParameters() || [];
					const mouthIds = params.length ? params : ["ParamMouthOpenY"];
					let opening = 0;
					internal.on("beforeModelUpdate", () => {
						const speech = speechRef.current;
						const speakingNow = speech.speaking;
						const desired = speakingNow ? (speech.mouthLevel?.() || 0) : 0;
						opening += (desired - opening) * (desired > opening ? 0.55 : 0.27);
						if (speakingNow || opening > 0.01) {
							for (const id of mouthIds) internal.coreModel.setParameterValueById(id, opening);
						}
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
		}, [entry]);
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

	/**
	 * 大肥鱼桌宠：圆角「桌面小组件」窗口（非 16:9 画布）。
	 * 标题栏 + 半透明渐变场景 + 摆尾/呼吸的胖鱼 + 嘴边气泡字幕 + 常显红色 AI 角标 + 底部状态条。
	 * 0.14.0：数据目录装有 Live2D 模型包时优先渲染 Live2D（待机动作/口型/点击互动），
	 * 未安装或加载失败自动回退 CSS 胖鱼；speaking 时气泡高亮；字幕容器 role=status。
	 */
	function DeskPet({ persona, speaking, subtitle, entry, fallback, mouthLevel, message }) {
		const p = persona || {};
		const theme = p.theme || AVATAR_THEME[p.avatarId] || AVATAR_THEME["fish-deskpet"];
		const name = p.name || "大肥鱼";
		const aiLabel = p.aiLabelText || "AI 生成内容";
		const text = subtitle || "大家好，我是大肥鱼～";
		const sceneBg = p.theme && p.theme.bg ? p.theme.bg : null;
		const [loadError, setLoadError] = useState("");
		const model = loadError ? null : entry;
		const detail = loadError ? "Live2D 加载失败：" + loadError : fallback;
		const mouth = useRef(null);
		useEffect(() => {
			if (!speaking || model || !mouth.current) return;
			const path = mouth.current;
			let frame;
			const tick = () => {
				const open = (mouthLevel?.() || 0) * 9;
				path.setAttribute("d", "M14 40 Q26 " + (38 - open / 2) + " 38 40 Q26 " + (46 + open) + " 14 40 Z");
				frame = requestAnimationFrame(tick);
			};
			path.setAttribute("fill", "#17303c");
			tick();
			return () => {
				cancelAnimationFrame(frame);
				path.setAttribute("fill", "none");
				path.setAttribute("d", "M14 40 Q26 48 38 40");
			};
		}, [speaking, model, mouthLevel]);
		return h("div", { className: "dfy-pet-wrap" },
			h("div", { className: "dfy-pet-window" + (model ? " dfy-pet-window-model" : "") },
				h("div", { className: "dfy-pet-title" },
					h("span", { className: "dfy-pet-dots", "aria-hidden": true }, h("i"), h("i"), h("i")),
					h("span", { className: "dfy-pet-name" }, name),
					h("span", { className: "dfy-pet-title-tag" }, "桌宠小组件")),
				h("div", { className: "dfy-pet-scene", style: sceneBg ? { background: sceneBg } : undefined },
					h("span", { className: "dfy-pet-ai", title: "AI 标识常显，不可隐藏" }, aiLabel),
					h("div", { className: "dfy-pet-bubbles", "aria-hidden": true }, h("i"), h("i"), h("i")),
					!model ? h("div", { className: "dfy-pet-bubble" + (speaking ? " dfy-pet-bubble-on" : ""), role: "status" }, text) : null,
					model ? h(Live2DScene, { entry: model, speaking, mouthLevel, onFail: setLoadError })
						: h("div", { className: "dfy-pet-fish" },
							h("span", { className: "dfy-pet-sway" }, h(FishIcon, { size: 116, theme, mouth }))),
					h(StageMessage, { message })),
			model ? h("p", { className: "dfy-pet-model-caption" + (speaking ? " dfy-pet-model-caption-on" : ""), role: "status" }, text) : null,
			h("div", { className: "dfy-pet-status" },
				h("span", { title: detail || undefined }, detail || (model ? model.name : "内置大肥鱼")),
					h("span", null, speaking ? "● 正在说话" : "○ 待机中"))));
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

	function EciyuanPreview({ persona, entry, sceneUrl, fallback, speaking, subtitle, compact, mouthLevel, message }) {
		const [failure, setFailure] = useState("");
		const [sceneFailed, setSceneFailed] = useState(false);
		const [portraitUnavailable, setPortraitUnavailable] = useState(false);
		const model = entry && !failure && !compact;
		const scene = !model && sceneUrl && !sceneFailed && !compact;
		const video = useRef(null);
		useEffect(() => {
			if (!scene || !video.current) return;
			const element = video.current;
			const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
			const update = () => {
				if (document.hidden || motion.matches || speaking) element.pause();
				else element.play().catch(() => {});
			};
			update();
			document.addEventListener("visibilitychange", update);
			motion.addEventListener("change", update);
			return () => {
				element.pause();
				document.removeEventListener("visibilitychange", update);
				motion.removeEventListener("change", update);
			};
		}, [scene, speaking]);
		return h("div", { className: "dfy-role-preview" },
			h("div", { className: "dfy-role-stage", style: { background: persona.theme?.bg, color: persona.theme?.accent } },
				h("span", { className: "dfy-pet-ai" }, persona.aiLabelText || "AI 生成内容"),
				model ? h(Live2DScene, { entry, speaking, mouthLevel, onFail: setFailure }) :
					h(react.Fragment, null,
						portraitUnavailable ? h("span", { className: "dfy-role-initial" }, persona.name) :
							h("img", { src: persona.media.portraitUrl, alt: persona.name + "的官方立绘", onError: () => setPortraitUnavailable(true) }),
						scene ? h("video", { ref: video, src: sceneUrl, muted: true, playsInline: true, loop: true,
							className: speaking ? "dfy-idle-video-hidden" : undefined,
							"aria-label": persona.name + "的待机动画", "aria-hidden": speaking || undefined,
							onError: () => setSceneFailed(true) }) : null),
				speaking && !model ? h("span", { className: "dfy-stage-voice" }, "正在说话", h(SpeechMeter, { level: mouthLevel })) : null,
				h(StageMessage, { message })),
			h("div", { className: "dfy-role-caption" + (speaking ? " dfy-role-caption-speaking" : "") },
				h("strong", null, persona.name),
				subtitle ? h("p", { role: "status" }, subtitle) : null,
				!compact ? h("p", { className: "dfy-caption" },
					model ? "Live2D · " + entry.name : scene ? "待机视频 · 语音回复时显示立绘" : (portraitUnavailable ? "官方立绘暂不可用" : "鹅次元官方立绘") +
						(failure ? " · 本地模型加载失败" : fallback ? " · " + fallback : "")) : null));
	}

	function StageMessage({ message }) {
		return message ? h("p", { className: "dfy-stage-message" }, message.author + " · " + message.text) : null;
	}

	function PreviewCanvas({ preview, compact, entry, sceneUrl, fallback, speaking, subtitle, mouthLevel, message }) {
		const p = preview || {};
		const onStage = !compact && p.scene?.danmakuOverlay !== false ? message : null;
		const persona = p.persona || { name: "大肥鱼", avatarId: "fish-classic", aiLabelText: "AI 生成内容" };
		if (persona.media) return h(EciyuanPreview, { key: persona.profileId + ":" + (entry?.id || "") + ":" + (sceneUrl || ""), persona, entry, sceneUrl, fallback, speaking, subtitle, compact, mouthLevel, message: onStage });
		const scene = p.scene || { title: "大肥鱼的直播间", danmakuOverlay: true };
		const theme = AVATAR_THEME[persona.avatarId] || AVATAR_THEME["fish-classic"];
		const bg = SCENE_BG[scene.background || "teal"] || SCENE_BG.teal;
		// 桌宠形象：改用桌面小组件窗口（compact 同样正常显示），不再用 16:9 全屏画布
		if (isDeskpetId(persona.avatarId)) {
			return h(DeskPet, { key: entry?.id || "builtin", persona, speaking, subtitle, entry, fallback, mouthLevel, message: onStage });
		}
		return h("div", {
			className: "dfy-canvas",
			style: { background: "linear-gradient(160deg, " + bg + " 0%, #08131a 100%)" },
		},
		h("div", { style: { position: "absolute", top: compact ? 8 : 12, left: compact ? 10 : 14, color: "#dfeeea", fontSize: compact ? 11.5 : 14, fontWeight: 700, textShadow: "0 1px 3px rgba(0,0,0,.45)", maxWidth: "70%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, scene.title),
		h("span", { style: { position: "absolute", top: compact ? 8 : 12, right: compact ? 10 : 14, fontSize: 10.5, fontWeight: 700, padding: "3px 8px", borderRadius: 999, background: "rgba(192,57,43,.92)", color: "#fff" } }, persona.aiLabelText || "AI 生成内容"),
		h("div", { style: { position: "absolute", left: 0, right: 0, bottom: compact ? 6 : onStage ? 48 : 12, display: "flex", alignItems: "center", justifyContent: "center", gap: 10 } },
			h(FishIcon, { size: compact ? 36 : 64, theme }),
			h("span", { style: { color: theme.accent, fontSize: compact ? 12.5 : 17, fontWeight: 700, textShadow: "0 1px 4px rgba(0,0,0,.45)", maxWidth: "55%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, persona.name)),
		h(StageMessage, { message: onStage }),
		subtitle && !compact ? h("p", { className: "dfy-canvas-subtitle" }, subtitle) : null);
	}

	// ------------------------------------------------------------------ 首页

	function WorkbenchControls({ status, act, busy, goTab, officialUrl, connected }) {
		const s = status;
		const live = s?.liveStatus === "live_confirmed";
		const awaiting = ["awaiting_platform", "stream_established"].includes(s?.liveStatus);
		const unconfigured = s && (!s.personaReady || !s.platformReady);
		const broadcastBusy = busy || !connected || !s;
		const primary = live ? "确认已下播" : awaiting ? "我已在直播伴侣开播" : unconfigured ? "完成首次配置" : "开始直播";
		const runPrimary = () => {
			if (live) return act("live/stop", {}, primary);
			if (awaiting) return act("live/operator-confirm", {}, primary);
			if (unconfigured) return goTab("wizard");
			return act("live/start", {}, primary);
		};
		const learning = s?.learningPaused ? "恢复学习" : "暂停学习";
		return h("aside", { className: "dfy-desk-controls", "aria-label": "直播和学习操作" },
			h("section", { className: "dfy-desk-section" },
				h("h3", null, "直播"),
				h("p", { className: "dfy-desk-state" }, s?.liveDisplay || "连接中…"),
				unconfigured && !live && !awaiting ? h("p", { className: "dfy-muted" }, s.personaReadyReason || s.platformReadyReason) : null,
				awaiting ? h("p", { className: "dfy-muted" }, "先在直播伴侣完成开播，再回来确认。") : null,
				live ? h("p", { className: "dfy-muted" }, "在直播伴侣结束直播后，回来确认。") : null,
				(awaiting || live) && officialUrl ? h("a", { className: "dfy-btn dfy-desk-link", href: officialUrl, target: "_blank", rel: "noreferrer" }, "打开直播伴侣说明") : null,
				h(Btn, { tone: "primary", disabled: broadcastBusy, onClick: runPrimary }, primary),
				awaiting ? h(Btn, { disabled: broadcastBusy, onClick: () => act("live/stop", {}, "取消开播") }, "取消开播") : null),
			h("section", { className: "dfy-desk-section" },
				h("h3", null, "学习"),
				h("p", { className: "dfy-muted" }, s?.learningPaused ? "学习已暂停" : s?.trainingEligible ? "满足当前训练条件" : s?.trainingEligibleDetail || "正在检查训练条件…"),
				h(Btn, { disabled: broadcastBusy || s.learningPaused || !s.trainingEligible,
					onClick: () => act("training/train-once", {}, "运行训练演练") }, "运行训练演练"),
				h("div", { className: "dfy-desk-learning" },
					h(Btn, { disabled: broadcastBusy, onClick: () => act(s.learningPaused ? "learning/resume" : "learning/pause", {}, learning) }, learning),
					h(Btn, { disabled: broadcastBusy || !s.activeReleaseId, onClick: () => act("release/rollback", {}, "恢复稳定版本") }, "恢复稳定版本"))),
			h("dl", { className: "dfy-desk-summary" },
				h("div", null, h("dt", null, "待处理"), h("dd", null, s ? h("button", { type: "button", className: "dfy-desk-text-button",
					onClick: () => goTab("interact") }, s.pendingIssues + " 条") : "—")),
				h("div", null, h("dt", null, "今日费用"), h("dd", null, s ? "¥" + s.todayCostCny.toFixed(2) : "—"))));
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
			if (r.ok) { setNote("已保存"); await load(); if (onSaved) onSaved(); }
			else setNote("保存失败：" + (r.error || "未知错误") + (r.issues ? "（" + r.issues.join("；") + "）" : ""));
			return r.ok;
		};

		const runSelfcheck = async () => {
			setNote("自检运行中…");
			const r = await api("selfcheck");
			setSelfcheck(r.ok ? r.report : null);
			setNote(r.ok ? "自检完成（不可达项如实标注）" : "自检失败：" + r.error);
		};

		if (data === null) return h("div", { className: "dfy-grid" }, h("div", { className: "dfy-card" }, h(Loading, { text: "加载设置…" })));

		const personaOk = data.readiness.persona.ready === true;
		const platformOk = data.readiness.platform.ready === true;
		const steps = [
			{ label: "数据与自检", hint: "环境逐项检查", state: selfcheck ? (selfcheck.allPassed ? "ok" : "warn") : null, body: h(SelfcheckStep, { report: selfcheck, run: runSelfcheck }) },
			{ label: "直播接入", hint: "平台与官方客户端", state: platformOk ? "ok" : "err", body: h(PlatformStep, { settings: data, save: save }) },
			{ label: "角色档案", hint: "主播信息 · 音色 · 授权", state: personaOk ? "ok" : "err", body: h(PersonaStep, { settings: data, save: save }) },
			{ label: "模型与云端", hint: "本地优先，云端选填", state: null, body: h(CloudStep, { settings: data, save: save, reload: load }) },
			{ label: "运行与数据用途", hint: "隐私下限确认", state: data.dataUsage.confirmed ? "ok" : "warn", body: h(DataUsageStep, { settings: data, save: save }) },
		];
		const done = personaOk && platformOk;

		return h("div", { className: "dfy-wizard" },
			h("nav", { className: "dfy-rail", role: "tablist", "aria-label": "配置步骤" },
				steps.map((st, i) => h("button", {
					key: i, type: "button", role: "tab", "aria-selected": i === step,
					className: "dfy-rail-i" + (i === step ? " dfy-rail-i-on" : ""),
					onClick: () => setStep(i),
				},
				h("span", { style: { display: "flex", alignItems: "center", gap: 6 } },
					h("span", null, (i + 1) + ". " + st.label),
					st.state ? h(Badge, { tone: st.state === "ok" ? "ok" : st.state === "err" ? "err" : "warn", text: st.state === "ok" ? "✓" : st.state === "err" ? "!" : "—" }) : null),
				h("span", { className: "dfy-rail-n" }, st.hint)))),
			h("div", { style: { display: "grid", gap: 12, minWidth: 0 } },
				h(Card, { title: steps[step].label, extra: h(Badge, { tone: personaOk && platformOk ? "ok" : "warn", text: (personaOk ? "形象✓ " : "形象✗ ") + (platformOk ? "接入✓" : "接入✗") }) },
					steps[step].body,
					h("div", { className: "dfy-actions" },
						h(Btn, { disabled: step === 0, onClick: () => setStep(step - 1) }, "上一步"),
						step < steps.length - 1 ? h(Btn, { tone: "primary", onClick: () => setStep(step + 1) }, "下一步") : null),
					note ? h("p", { className: "dfy-caption", style: { margin: 0 } }, note) : null,
					h("p", { className: "dfy-caption", style: { margin: 0 } }, data.notes.join("；"))),
				done ? h(Card, { title: "配置完成" },
					h("p", { style: { margin: 0 } }, "形象与接入已就绪：可先进入本地预览确认画面与 AI 标识，再开始直播（平台确认前不会显示直播中）。")) : null));
	}

	function SelfcheckStep({ report, run }) {
		return h("div", { style: { display: "grid", gap: 10 } },
			h("p", { className: "dfy-muted", style: { margin: 0 } }, "与安装器同款：Node / Python / 配置 / 数据目录 / 本地推理 / GPU 逐项检查，缺失能力如实标注并给修复动作。"),
			h("div", { className: "dfy-actions" }, h(Btn, { tone: "primary", onClick: run }, report ? "重新运行自检" : "运行自检")),
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
		return h("div", { style: { display: "grid", gap: 12 } },
			h("p", { className: "dfy-muted", style: { margin: 0 } }, "平台登录、实名与人脸认证在官方客户端完成；本插件只保存操作员声明，不保存任何凭据。"),
			h(Field, { label: "平台" }, h("input", { className: "dfy-input", value: "抖音（辅助模式默认）", disabled: true })),
			h(Field, { label: "运行模式" },
				h("select", { className: "dfy-select", value: mode, onChange: (e) => setMode(e.target.value) },
					h("option", { value: "assisted" }, "辅助直播（AI 辅助，真人控制播出）"),
					h("option", { value: "human_driven" }, "真人驱动（AI 仅建议，不代播）"))),
			h(Field, { label: "内容类别（选填）" },
				h("input", { className: "dfy-input", value: category, placeholder: "如：游戏/休闲聊天", onChange: (e) => setCategory(e.target.value) })),
			h("div", { style: { fontSize: 12 } },
				"官方客户端入口：", h("a", { className: "dfy-link", href: p.officialClientUrl, target: "_blank", rel: "noreferrer" }, "直播伴侣官方说明")),
			h("div", { className: "dfy-actions" },
				h(Btn, { tone: "primary", onClick: () => save("platform", { operationMode: mode, contentCategory: category }) }, "保存"),
				h(Btn, { onClick: () => save("platform", { operatorLoginConfirmedAt: new Date().toISOString() }) },
					p.operatorLoginConfirmedAt ? "已声明登录（" + p.operatorLoginConfirmedAt.slice(0, 16).replace("T", " ") + "）· 点击更新" : "我已在官方客户端登录直播账号")));
	}

	function PersonaStep({ settings, save }) {
		const p = settings.persona;
		const profiles = (settings.catalogs && settings.catalogs.profiles) || [];
		const [profileId, setProfileId] = useState(p.profileId || (settings.profile && settings.profile.id) || "dsh-pet");
		const [voice, setVoice] = useState(p.voiceId);
		const [phrase, setPhrase] = useState(p.samplePhrase);
		const [right, setRight] = useState(p.usageRightConfirmed);
		const [listenNote, setListenNote] = useState("");
		const audition = useRoleSpeech(profileId);

		const selected = profiles.find((x) => x.id === profileId) || settings.profile || null;
		const payload = () => ({ profileId: profileId, personaName: selected ? selected.name : p.personaName, voiceId: voice, samplePhrase: phrase, usageRightConfirmed: right });

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

		return h("div", { style: { display: "grid", gap: 12 } },
			h("p", { className: "dfy-muted", style: { margin: 0 } },
				"主播信息以角色档案呈现（参照 eciyuan.qq.com 的 CHARACTERS 角色介绍）：中文名 / 英文名 / #人设标签 / 年龄·身高·星座·MBTI。选择档案后播出展示名同步为该角色中文名。"),
			selected ? h(Card, { title: "当前角色档案", extra: h(Badge, { tone: selected.source === "plugin" ? "ok" : "idle", text: selected.source === "plugin" ? "dsh-pet · 插件中" : "鹅次元角色" }) },
				h(ProfileCard, { profile: selected, hero: true })) : null,
			h(Field, { label: "选择角色档案" },
				h("div", { className: "dfy-profiles" },
					profiles.map((x) => h(ProfileCard, { key: x.id, profile: x, selected: x.id === profileId, onSelect: () => setProfileId(x.id) })))),
			selected?.media ? h("p", { className: "dfy-caption" }, "本地音色随角色切换，试听和回复使用同一音色。") :
			h(Field, { label: "预览朗读风格（使用浏览器本地中文音色）" },
				h("div", { className: "dfy-choice" },
					settings.catalogs.voices.map((v) => h("button", {
						key: v.id, type: "button", className: "dfy-chip" + (voice === v.id ? " dfy-chip-on" : ""),
						onClick: () => setVoice(v.id),
					}, h("b", null, v.label.split("（")[0]), h("span", { className: "dfy-muted" }, v.style))))),
			h(Field, { label: "试听语句" },
				h("div", { style: { display: "grid", gap: 8, gridTemplateColumns: "minmax(0,1fr) auto" } },
					h("input", { className: "dfy-input", value: phrase, maxLength: 80, onChange: (e) => setPhrase(e.target.value) }),
					h(Btn, { onClick: listen }, audition.phase === "idle" ? "试听" : "停止试听")),
				h("span", { className: "dfy-caption", role: "status" }, listenNote || audition.note)),
			h("label", { className: "dfy-check" },
				h("input", { type: "checkbox", checked: right, onChange: (e) => setRight(e.target.checked) }),
				h("span", null, "我确认对所选角色形象与声音具有使用授权（开播前必须勾选）")),
			h("p", { className: "dfy-caption", style: { margin: 0 } }, "AI 标识在画面上常显且不可关闭（法规要求）。当前文案：" + p.aiLabelText),
			h("div", { className: "dfy-actions" },
				h(Btn, { tone: "primary", onClick: () => save("persona", payload()) }, "保存角色档案与播出设置")));
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
		const needInstall = !running && !ready;
		const pct = d && d.log ? lastPercent(d.log) : null;
		const label = !d ? (err ? "重试连接" : "检查部署状态…") : running ? "部署中…" :
			d.status === "failed" ? "重试部署" : needInstall ? "一键安装（ModelScope 直连）" : "重新验证";
		const badge = !d ? null : h(Badge, {
			tone: d.status === "ok" ? "ok" : d.status === "failed" ? "err" : running ? "warn" : "idle",
			dot: running, text: d.status === "ok" ? "已就绪" : d.status === "failed" ? "失败" : running ? "进行中" : "未部署",
		});
		return h(Card, { title: "本地模型（本地优先推理）", extra: badge },
			h("p", { className: "dfy-muted", style: { margin: 0 } },
				"一键安装并验证：", h("code", null, "Ollama"), " + ", h("code", null, (d && d.model) || "qwen3:4b"),
				"（", (d && d.ollamaUrl) || "http://127.0.0.1:11434", "）。模型权重默认经 ", h("code", null, "ModelScope"), " 国内镜像直连（无需代理）；已就绪部分自动跳过。"),
			install && !running ? h("div", { style: { display: "flex", gap: 8, flexWrap: "wrap" } },
				h(Badge, { tone: install.reachable ? "ok" : "err", text: "Ollama 服务 " + (install.reachable ? "已运行" : "未安装") }),
				h(Badge, { tone: install.modelInstalled ? "ok" : "err", text: (install.model || "qwen3:4b") + (install.modelInstalled ? " 已就绪" : " 未安装") })) : null,
			needInstall ? h("p", { className: "dfy-caption", style: { margin: 0, color: "var(--dsw-alias-state-warning-primary,#8a6d1f)" } },
				"本地模型未安装：一键安装将从 ModelScope 国内镜像直连下载权重（无需代理），自动安装 Ollama、导入模型并验证。") : null,
			running && pct !== null ? h("div", { role: "progressbar", "aria-valuenow": pct, "aria-valuemin": 0, "aria-valuemax": 100, "aria-label": "部署进度", style: { height: 8, borderRadius: 999, background: "var(--dsw-alias-bg-layer-2,#e6eceb)", overflow: "hidden" } },
				h("div", { style: { width: pct + "%", height: "100%", background: "var(--dsw-alias-state-business-primary,#0f5e57)", transition: "width .4s ease" } })) : null,
			running ? h("p", { className: "dfy-caption", style: { margin: 0 }, role: "status" }, pct !== null ? "进行中 · " + pct + "%" : "进行中…") : null,
			err ? h("p", { className: "dfy-caption", role: "alert", style: { margin: 0, color: "var(--dsw-alias-state-error-primary,#c0392b)" } },
				"部署状态异常：" + err + (String(err).includes("未知路径")
				? "。当前宿主加载的插件后端未包含该端点：请在 DeepSeek Harness 中重载大肥鱼插件，再刷新本页。"
				: "")) : null,
			h("div", { className: "dfy-actions" },
				h(Btn, { tone: "primary", disabled: running, onClick: start }, label),
				d && d.log && d.log.length ? h("span", { className: "dfy-caption", role: "status" }, "部署进程输出（最近 " + d.log.length + " 行）") : null),
			d && d.log && d.log.length ? h("pre", {
				tabIndex: 0, "aria-live": running ? "polite" : undefined,
				style: { margin: 0, maxHeight: 132, overflow: "auto", fontSize: 11.5, fontFamily: "ui-monospace,SFMono-Regular,Menlo,monospace", whiteSpace: "pre-wrap", overflowWrap: "anywhere", padding: "8px 10px", borderRadius: 8, background: "var(--dsw-alias-bg-layer-2,#eef3f2)" },
			}, d.log.slice(-14).join("\n")) : null,
			d && d.status === "failed" && d.error ? h("p", { className: "dfy-caption", style: { margin: 0, color: "var(--dsw-alias-state-error-primary,#c0392b)" } }, d.error) : null,
			h("p", { className: "dfy-caption", style: { margin: 0 } },
				"命令行等价：项目目录运行 ", h("code", null, "pnpm setup:ollama"), "。", h("code", null, "DAFEIYU_OLLAMA_SOURCE=registry"), " 可切回官方仓库（需代理）；", h("code", null, "DAFEIYU_MODELSCOPE_REPO"), " / ", h("code", null, "DAFEIYU_MODELSCOPE_FILE"), " 可自定义 GGUF。部署完成后本地优先路由自动使用该端点，无需重启插件。"));
	}

	function CloudStep({ settings, save, reload }) {
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
		const [quota, setQuota] = useState(null);
		const [quotaLoading, setQuotaLoading] = useState(false);
		// 额度/可用余额（0.15.2）：按已保存的生效配置查询（DeepSeek 余额 / OpenAI 兼容 billing；不支持则如实标注）
		const loadQuota = async () => {
			setQuotaLoading(true);
			try {
				const r = await api("cloud/quota");
				setQuota(r && typeof r.ok === "boolean" ? r : { ok: false, error: "未知错误" });
			} catch (e) { setQuota({ ok: false, error: (e && e.message) || "网络错误" }); }
			setQuotaLoading(false);
		};
		useEffect(() => { if (key.source !== "none") loadQuota(); }, [key.source]);
		const saveKey = async (body) => {
			setKeyNote("密钥保存中…");
			try {
				const r = await api("settings/cloud/key", body);
				setKeyNote(r.ok ? "已保存并即时生效" : "保存失败：" + (r.error || "未知错误"));
				if (r.ok) { setApiKey(""); setQuota(null); if (reload) await reload(); }
			} catch { setKeyNote("保存失败：网络错误"); }
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
			if (apiKey.trim() !== "") {
				setKeyNote("密钥保存中…");
				const kr = await api("settings/cloud/key", { apiKey: apiKey.trim() });
				if (!kr.ok) { setKeyNote("密钥保存失败：" + (kr.error || "未知错误")); return; }
				setApiKey("");
			}
			await save("cloud", { enabled: enabled, provider: provider, model: model, baseUrl: baseUrl.trim(), dailyBudgetCny: budget === "" ? null : Number(budget) });
			loadQuota();
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
		return h("div", { style: { display: "grid", gap: 12 } },
			h("p", { className: "dfy-muted", style: { margin: 0 } }, "本地优先：常规请求先走本地模型；未配置云端时不产生任何付费调用。云端仅作兜底，可全部留空。"),
			h(LocalModelDeployCard),
			presets.length > 0 ? h(Field, { label: "服务商预设（OpenAI 兼容端点）" },
				h("div", { className: "dfy-choice" },
					presets.map((p) => h("button", {
						key: p.id, type: "button",
						className: "dfy-chip" + (provider === p.id ? " dfy-chip-on" : ""),
						title: p.baseUrl, onClick: () => pickPreset(p),
					}, p.label)),
					h("button", {
						key: "_custom", type: "button",
						className: "dfy-chip" + (selPreset ? "" : " dfy-chip-on"),
						title: "自定义：服务商名自由填写，端点用 DAFEIYU_CLOUD_BASE_URL 提供",
						onClick: () => setProvider(""),
					}, "自定义"))) : null,
			selPreset ? h("p", { className: "dfy-caption", style: { margin: 0 } },
				"端点：" + selPreset.baseUrl + "（下方「端点 URL」或环境变量 DAFEIYU_CLOUD_BASE_URL 可覆盖）。" + selPreset.note) : h("p", { className: "dfy-caption", style: { margin: 0 } },
				"自定义网关：填写服务商名、模型名与「端点 URL」即可接入（OpenAI 兼容 /v1/chat/completions）。"),
			h("label", { className: "dfy-check" },
				h("input", { type: "checkbox", checked: enabled, onChange: (e) => { setEnabled(e.target.checked); setTest(null); } }),
				h("span", null, "启用第三方兜底（OpenAI 兼容端点）")),
			h("div", { style: { display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))" } },
				h(Field, { label: "服务商" }, h("input", { className: "dfy-input", value: provider, placeholder: selPreset ? selPreset.id : "留空 = 不覆盖配置文件", onChange: (e) => { setProvider(e.target.value); setTest(null); } })),
				h(Field, { label: "模型名" },
					h("div", { style: { display: "grid", gap: 4 } },
						h("input", { className: "dfy-input", list: "dfy-cloud-models", value: model, placeholder: "如 hunyuan-lite", onChange: (e) => { setModel(e.target.value); setTest(null); } }),
						// React 禁止 void 元素（input）携带 children：datalist 必须挂为兄弟节点（点击预设即白屏的根因）
						selModels.length > 0 ? h("datalist", { id: "dfy-cloud-models" }, selModels.map((m) => h("option", { key: m, value: m }))) : null)),
				h(Field, { label: "每日费用上限（元）" }, h("input", { className: "dfy-input", value: budget, placeholder: "未设置 ⇒ 付费禁用", onChange: (e) => { setBudget(e.target.value); setTest(null); } })),
				h(Field, { label: "端点 URL（自定义网关）" }, h("input", { className: "dfy-input", value: baseUrl, placeholder: selPreset ? "留空 = 预设端点" : "如 https://tokenhub.example.com/v1", title: "OpenAI 兼容端点，解析优先级：环境变量 > 此处 > 预设", onChange: (e) => { setBaseUrl(e.target.value); setTest(null); } }))),
			h(Field, { label: "API Key（云端兜底密钥）" },
				h("div", { style: { display: "grid", gap: 6 } },
					h("div", { style: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" } },
						h("span", { className: "dfy-caption", style: { margin: 0 } },
							key.source === "env" ? "环境变量 DAFEIYU_CLOUD_API_KEY 已配置（优先于界面值）"
							: key.source === "ui" ? "界面维护中：" + (key.masked || "••••") + (key.updatedAt ? " · 更新于 " + key.updatedAt.slice(0, 16).replace("T", " ") : "")
							: "未配置（云端兜底不可用；本地推理不受影响）"),
						h(Badge, { tone: key.source === "none" ? "err" : "ok", text: key.source === "env" ? "环境变量" : key.source === "ui" ? "界面维护" : "未配置" })),
					h("div", { style: { display: "grid", gap: 8, gridTemplateColumns: "minmax(0,1fr) auto auto auto" } },
						h("input", { type: "password", className: "dfy-input", value: apiKey, placeholder: "sk-…（保存在本插件数据目录，界面只回掩码）", autoComplete: "new-password", onChange: (e) => { setApiKey(e.target.value); setTest(null); } }),
						h(Btn, { disabled: testing, onClick: runTest, title: "按当前表单值与密钥发起一次最小测试请求（不保存）" }, testing ? "测试中…" : "测试连接"),
						h(Btn, { tone: "primary", disabled: !(test && test.ok), title: test && test.ok ? "测试已通过，可保存" : "先「测试连接」通过后再保存", onClick: doSave }, "保存"),
						key.source === "ui" ? h(Btn, { tone: "danger", title: "清除界面维护的密钥（不影响环境变量）", onClick: () => saveKey({ clear: true }) }, "清除密钥") : null),
					test ? h("span", { className: "dfy-caption", role: "status", style: { margin: 0, color: test.ok ? "var(--dsw-alias-state-success-primary,#1c7a54)" : "var(--dsw-alias-state-error-primary,#c0392b)" } },
						(test.ok ? "测试通过" : "测试失败") + (test.keySource === "env" ? "（使用环境变量密钥）" : "") + "：" + (test.ok ? test.detail || "模型已返回回复" : test.error || "未知错误")) : null,
					keyNote ? h("span", { className: "dfy-caption", role: "status" }, keyNote) : null)),
			h(Field, { label: "额度 / 可用余额（按已保存配置查询）" },
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
					quota && !quota.ok && quota.error ? h("span", { className: "dfy-caption", role: "alert", style: { margin: 0, color: "var(--dsw-alias-state-error-primary,#c0392b)" } }, quota.error) : null)),
			h("p", { className: "dfy-caption", style: { margin: 0 } }, "密钥仅存本插件数据目录（SQLite），界面与接口只回掩码；环境变量 DAFEIYU_CLOUD_API_KEY 优先。测试通过后保存，保存后即时生效、无需重载插件（混元用腾讯云密钥）。"));
	}

	function DataUsageStep({ settings, save }) {
		const d = settings.dataUsage;
		return h("div", { style: { display: "grid", gap: 12 } },
			h("p", { className: "dfy-muted", style: { margin: 0 } }, "运行模式与数据用途（隐私下限不可放宽，只能确认）："),
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

	function useLocalSpeech(role) {
		const utterance = useRef(null);
		const [phase, setPhase] = useState("idle");
		const [note, setNote] = useState("");
		const cancel = useCallback(() => {
			if (!utterance.current) return;
			utterance.current = null;
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
				setPhase("speaking");
				setNote("正在朗读 · " + voice.name);
			};
			const finish = (message) => {
				if (utterance.current !== item) return;
				utterance.current = null;
				setPhase("idle");
				setNote(message);
			};
			item.onend = () => finish("朗读完成");
			item.onerror = () => finish("朗读失败，请检查系统音色后重试");
			try { synth.speak(item); } catch { finish("朗读失败，请重试"); }
		};
		return { speak, stop, phase, note };
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
	};

	// Read PCM samples at the playback position without routing sound through a second audio device.
	function wavMouthLevel(bytes) {
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
				const total = Math.floor(length / stride);
				return (time) => {
					const center = Math.floor(time * sampleRate);
					const start = Math.max(0, center - Math.floor(sampleRate * 0.012));
					const end = Math.min(total, center + Math.ceil(sampleRate * 0.012));
					let energy = 0, count = 0;
					for (let i = start; i < end; i += 3) {
						const sample = wav.getInt16(payload + i * stride, true) / 32768;
						energy += sample * sample;
						count++;
					}
					return count ? Math.min(1, Math.max(0, (Math.sqrt(energy / count) - 0.009) * 12)) : 0;
				};
			}
			offset = payload + length + length % 2;
		}
		return () => 0;
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
			source.buffer = buffer;
			source.connect(analyser);
			const initial = !last;
			const start = Math.max(next, context.currentTime + (initial ? 0.085 : 0.025));
			next = start + buffer.duration;
			last = new Promise((resolve) => { source.onended = resolve; });
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
			await new Promise((resolve) => {
				if (signal.aborted) { resolve(); return; }
				signal.addEventListener("abort", resolve, { once: true });
				last.then(() => {
					signal.removeEventListener("abort", resolve);
					resolve();
				});
			});
		} finally {
			signal.removeEventListener("abort", aborted);
			await reader.cancel().catch(() => {});
		}
	}

	function useRoleSpeech(profileId) {
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
			playing.context?.close().catch(() => {});
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
		const level = useCallback(() => {
			const playing = active.current;
			if (playing?.analyser) {
				playing.analyser.getFloatTimeDomainData(playing.samples);
				let energy = 0;
				for (const sample of playing.samples) energy += sample * sample;
				return Math.min(1, Math.max(0, (Math.sqrt(energy / playing.samples.length) - 0.009) * 12));
			}
			if (!playing?.audio || playing.audio.paused) {
				return 0;
			}
			return playing.sampleLevel(playing.audio.currentTime);
		}, []);
		const speak = async (text, voiceId, interactionId) => {
			cancelAudio();
			browser.stop();
			usingBrowser.current = false;
			const playing = { controller: new AbortController() };
			if (window.AudioContext) {
				try {
					playing.context = new AudioContext();
					playing.context.resume().catch(() => {});
				} catch { /* Use the existing WAV playback path. */ }
			}
			active.current = playing;
			setPhase("pending");
			setNote("正在生成角色语音…");
			const finish = (message) => {
				if (active.current !== playing) return;
				cancelAudio();
				setPhase("idle");
				setNote(message);
			};
			try {
				const response = await fetch("/api/dafeiyu/preview/role-speech", {
					method: "POST", headers: { "content-type": "application/json" },
					body: JSON.stringify({ profileId, text: text.slice(0, 500), interactionId, stream: !!playing.context }), signal: playing.controller.signal,
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
					finish("朗读完成");
					return;
				}
				const result = await response.json();
				if (active.current !== playing) return;
				if (!result.ok) throw Object.assign(new Error(result.error || "角色音色暂不可用"), { status: response.status, fallback: result.fallback });
				const bytes = decodeAsset(result.result.audioBase64);
				playing.sampleLevel = wavMouthLevel(bytes);
				playing.url = URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
				const audio = playing.audio = new Audio(playing.url);
				audio.onplaying = () => {
					if (active.current !== playing) return;
					setPhase("speaking");
					setNote("正在朗读 · " + result.result.voiceName +
						(result.result.source === "reference" ? "（本地参考音色）" : "（系统音色）"));
				};
				audio.onended = () => finish("朗读完成");
				audio.onerror = () => finish("角色语音播放失败");
				await audio.play();
			} catch (error) {
				if (active.current !== playing) return;
				if (playing.streaming) {
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
			note: usingBrowser.current ? browser.note : note, level };
	}

	const REPLY_SOURCE = { local_gpu: "本地模型", local_cpu: "本地模型（CPU）", cloud: "云端模型", fallback: "预设回复" };
	const FALLBACK_REASON = {
		LOCAL_UNAVAILABLE: "模型暂不可用", LOCAL_TIMEOUT: "模型响应超时", POLICY_BLOCKED: "内容受到限制",
		QUALITY_GATE_FAILED: "模型没有生成可用回复",
	};
	const TURN_STATE = { waiting: "待回复", queued: "已排队", thinking: "正在组织回复…", expired: "已过期", error: "生成中断" };
	const FEED_STATE = {
		unconfigured: "直播弹幕未配置", invalid: "弹幕接入配置不完整",
		waiting: "等待弹幕源连接…", connected: "弹幕源已连接", error: "弹幕源连接中断，正在重试",
	};

	function previewTurnLabel(turn) {
		if (!turn.answer) return TURN_STATE[turn.status];
		const source = REPLY_SOURCE[turn.answer.route] || turn.answer.route;
		const detail = turn.answer.route === "fallback" ? FALLBACK_REASON[turn.answer.reasonCode] :
			turn.memoryUsed ? "参考 " + turn.memoryUsed + " 条本地记忆" : "";
		return [source, detail].filter(Boolean).join(" · ");
	}

	function PreviewConversation({ voiceId, publish, persona, samplePhrase, ensurePreview, readReplies, setReadReplies, live, running }) {
		const [text, setText] = useState("");
		const [state, setState] = useState(null);
		const [notice, setNotice] = useState("");
		const [sending, setSending] = useState(false);
		const [autoAnswer, setAutoAnswer] = useState(false);
		const [spoken, setSpoken] = useState(null);
		const sendingRef = useRef(false);
		const request = useRef(0);
		const answered = useRef(new Set());
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
			} catch {
				if (ticket === request.current) setNotice("互动消息暂时无法读取，正在重试");
			}
		}, []);
		useEffect(() => {
			let disposed = false;
			let timer;
			const poll = async () => {
				await load();
				if (!disposed) timer = setTimeout(poll, running ? 650 : 1600);
			};
			poll();
			return () => { disposed = true; clearTimeout(timer); request.current++; };
		}, [load, running]);
		useEffect(() => () => publish({ speaking: false, subtitle: "", message: null }), [publish]);

		const turns = state?.turns || [];
		const latest = turns.at(-1);
		const latestAnswer = turns.findLast((turn) => turn.answer);
		const busyTurn = turns.find((turn) => turn.status === "thinking");
		const activeTurn = speech.phase === "idle" ? busyTurn || latest : spoken;
		const caption = activeTurn?.answer?.text || "";
		useEffect(() => {
			publish({ speaking: speech.phase === "speaking", subtitle: caption, mouthLevel: speech.level, message: activeTurn });
		}, [publish, speech.phase, speech.level, caption, activeTurn?.id, activeTurn?.text, activeTurn?.author]);
		useEffect(() => {
			if (follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
		}, [latest?.id, latestAnswer?.id, busyTurn?.id]);

		const play = (turn) => {
			playback.current.seen.add(turn.answer.playbackKey);
			setSpoken(turn);
			sample.current?.pause();
			speech.speak(turn.answer.text, voiceId, state?.id || undefined);
		};
		useEffect(() => {
			if (!state) return;
			const queue = playback.current;
			if (queue.runId !== state.id) {
				if (queue.runId) {
					speech.stop();
					setSpoken(null);
					setAutoAnswer(false);
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
		}, [state, readReplies, speech.phase, mic.phase]);

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
		useEffect(() => {
			if (!live || !autoAnswer || !state?.id || state.mode !== "live" || sending || busyTurn ||
				speech.phase !== "idle" || mic.phase !== "idle") return;
			if (turns.some((turn) => turn.status === "queued")) return;
			const next = turns.find((turn) => turn.status === "waiting");
			if (next) void reply(next);
		}, [live, autoAnswer, state, sending, speech.phase, mic.phase]);

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
				h("h4", null, "主播互动"),
				live ? h("span", { className: "dfy-turn-meta", role: "status" }, FEED_STATE[state?.danmaku] || FEED_STATE.waiting) : null,
				live && ["connected", "error"].includes(state?.danmaku) ? h("label", null,
					h("input", { type: "checkbox", checked: autoAnswer, onChange: (event) => setAutoAnswer(event.target.checked) }),
					"自动回复弹幕") : null),
			h("ol", { className: "dfy-turns", ref: scroll, "aria-label": "消息与主播回复", tabIndex: 0,
				onScroll: (event) => {
					const el = event.currentTarget;
					follow.current = el.scrollHeight - el.clientHeight - el.scrollTop < 25;
				} },
				!turns.length ? h("li", { className: "dfy-turn-meta" }, live ? "等待操作员消息或直播弹幕" : "发送一条消息，开始和主播对话") : null,
				turns.map((turn) => h("li", { key: turn.id },
					h("div", { className: "dfy-turn-head" },
						h("strong", null, turn.author),
						turn.source === "danmaku" ? h("span", { className: "dfy-turn-meta" }, "直播弹幕") : null,
						h("time", { dateTime: turn.sentAt }, new Date(turn.sentAt).toLocaleTimeString("zh-CN"))),
					h("p", { className: "dfy-turn-text" }, turn.text),
					turn.answer ? h("div", { className: "dfy-turn-answer" },
						h("span", { className: "dfy-turn-meta" }, (persona?.name || "主播") + " · " + previewTurnLabel(turn)),
						h("p", { className: "dfy-turn-text" }, turn.answer.text),
						h(Btn, { tone: "ghost", disabled: speech.phase !== "idle" || mic.phase !== "idle",
							onClick: () => play(turn) }, "朗读回复")) :
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
					h("label", null, h("input", { type: "checkbox", checked: readReplies,
						onChange: (event) => {
							setReadReplies(event.target.checked);
							if (!event.target.checked && speech.phase !== "idle") speech.stop();
						} }), "自动朗读"),
					speech.phase !== "idle" ? h(Btn, { onClick: speech.stop }, "停止朗读") : null)),
			h("p", { className: "dfy-caption", role: "status" }, notice || mic.note || speech.note || (busyTurn ? "主播正在组织回复…" : "")),
			!live ? h("details", null, h("summary", { className: "dfy-turn-meta" }, "声音试听"),
				persona?.media ? h("div", { className: "dfy-role-audio" },
					h("span", { className: "dfy-caption" }, "官方录音"),
					h("audio", { ref: sample, controls: true, preload: "none", src: persona.media.sampleAudioUrl,
						"aria-label": persona.name + "的官方录音", onPlay: () => { if (speech.phase !== "idle") speech.stop(); },
						onError: () => setSampleError(true) }),
					sampleError ? h("p", { className: "dfy-caption", role: "status" }, "官方录音暂不可用") : null) : null,
				h(Btn, { disabled: speech.phase !== "idle" || mic.phase !== "idle",
					onClick: () => { sample.current?.pause(); setSpoken(null); speech.speak(sampleLine, voiceId); } }, "试听互动声线")) : null);
	}

	function Workbench({ status, act, busy, pending, settings, refresh, goTab, connected, emergency }) {
		const [preview, setPreview] = useState(null);
		const [catalog, setCatalog] = useState(null);
		const [selection, setSelection] = useState(null);
		const [modelNote, setModelNote] = useState("");
		const [caption, setCaption] = useState({ speaking: false, subtitle: "" });
		const [readReplies, setReadReplies] = useState(true);
		const request = useRef(0);
		const saving = useRef(false);
		const loadCatalog = useCallback(async () => {
			try {
				const result = await api("avatar/catalog");
				setCatalog(result.ok ? result.catalog : null);
			} catch { setCatalog(null); }
		}, []);
		useEffect(() => { loadCatalog(); }, [loadCatalog]);
		const load = useCallback(async () => {
			const ticket = ++request.current;
			try {
				const result = await api("preview");
				if (ticket === request.current && result.ok) setPreview(result.preview);
				return result.ok ? result.preview : null;
			} catch { return null; }
		}, []);
		const selected = settings?.persona;
		useEffect(() => {
			if (status?.personaReady && selected?.profileId && ROLE_BROWSER_VOICES[selected.profileId]) {
				api("preview/role-speech/warm", {}).catch(() => {});
			}
		}, [selected?.profileId, status?.personaReady]);
		useEffect(() => {
			load();
			return () => { request.current++; };
		}, [load, status?.liveStatus, selected?.profileId, selected?.avatarId, selected?.voiceId,
			selected?.live2dModelId, selected?.aiLabelText, settings?.scene?.background, settings?.scene?.title,
			settings?.scene?.danmakuOverlay, settings?.scene?.resolution, settings?.platform?.officialClientUrl]);

		const persona = selection || preview?.persona;
		const profiles = settings?.catalogs?.profiles || [];
		const models = catalog?.models || [];
		const roleMedia = persona?.media;
		const sceneUrl = roleMedia && catalog?.scenes?.includes(roleMedia.modelId)
			? "/api/dafeiyu/avatar/scene?id=" + encodeURIComponent(roleMedia.modelId) : undefined;
		const petModels = models.filter((model) => !model.id.startsWith("eciyuan-") || model.id === persona?.live2dModelId);
		const installed = roleMedia ? models.find((model) => model.id === roleMedia.modelId) :
			persona?.live2dModelId === undefined ? petModels[0] : petModels.find((model) => model.id === persona.live2dModelId);
		const runtimeReady = catalog && Object.values(catalog.vendors).every(Boolean);
		const entry = runtimeReady ? installed : null;
		const modelEnabled = roleMedia || persona?.live2dModelId !== null;
		const fallback = !modelEnabled ? "" : !catalog ? "本地模型目录暂不可用" :
			!installed ? (roleMedia ? "未安装该角色的 Live2D 模型" : "未找到本地模型 · 内置大肥鱼") :
			!runtimeReady ? "Live2D 运行时缺失" : "";
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
				setPreview((current) => current ? { ...current, persona: next } : current);
				await Promise.all([load(), refresh()]);
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
		const selectModel = (value) => {
			const id = value || null;
			save({ live2dModelId: id }, { ...persona, live2dModelId: id });
		};
		const ensurePreview = async () => {
			if (live || active) return;
			if (!editable || selection || saving.current || !status.personaReady) throw new Error("请先完成角色配置");
			const result = await api("preview/start", {});
			if (!result.ok || result.status?.liveStatus !== "local_preview") throw new Error(result.error || "当前无法进入本地预览");
			// The shared status refresh runs independently of the reply.
			load();
			refresh(true);
		};
		const officialUrl = preview?.officialClientUrl || settings?.platform?.officialClientUrl;

		return h("div", { className: "dfy-workbench" },
			h("section", { className: "dfy-desk-preview", "aria-label": "实时预览" },
				h("div", { className: "dfy-desk-stage-head" },
					h("h3", null, "实时预览"),
					active && !safe ? h(Btn, { tone: "ghost", disabled: busy,
						onClick: () => act("preview/stop", {}, "结束本地对话") }, "结束本地对话") :
						h(Badge, { tone: live ? "ok" : "idle", text: live ? "直播互动" : "本地画面" })),
				h("div", { className: "dfy-desk-selectors" },
					profiles.length && persona ? h(Field, { label: "角色" },
						h("select", { value: persona.profileId, "aria-label": "角色", disabled: !editable || !!selection,
							onChange: (event) => selectProfile(event.target.value) },
							profiles.map((profile) => h("option", { key: profile.id, value: profile.id }, profile.name)))) : null,
					!roleMedia && isDeskpetId(persona?.avatarId) ? h(Field, { label: "形象" },
						h("select", { value: persona.live2dModelId === undefined ? "auto:" : persona.live2dModelId ?? "",
							"aria-label": "形象", disabled: !editable || !!selection || !catalog, onChange: (event) => selectModel(event.target.value) },
							persona.live2dModelId === undefined ? h("option", { value: "auto:", disabled: true }, "自动选择本地模型") : null,
							h("option", { value: "" }, "内置大肥鱼"),
							persona.live2dModelId && !installed ? h("option", { value: persona.live2dModelId, disabled: true }, "缺少模型：" + persona.live2dModelId) : null,
							petModels.map((model) => h("option", { key: model.id, value: model.id }, model.name)))) : null,
					h(Btn, { tone: "ghost", onClick: loadCatalog }, "刷新模型")),
				selection || modelNote ? h("p", { className: "dfy-desk-inline", role: "status" }, modelNote || "正在保存…") : null,
				safe ? h("div", { className: "dfy-desk-safe" },
					h("strong", { role: "status" }, "安全场景"), h("span", null, "预览语音和动作已停止"),
					!emergency && connected && status.personaReady ? h(Btn, { onClick: () => act("preview/start", { resume: true }, "恢复本地预览") }, "恢复本地预览") : null,
					h("span", { className: "dfy-pet-ai" }, persona?.aiLabelText || "AI 生成内容")) :
					persona ? h(PreviewCanvas, { preview: { ...preview, persona }, entry, sceneUrl, fallback, ...caption }) :
						h("div", { className: "dfy-desk-safe", role: "status" }, "正在加载预览…"),
				canInteract && persona ? h(PreviewConversation, {
					key: persona?.profileId, persona, voiceId: persona?.voiceId, samplePhrase: selected?.samplePhrase, publish: setCaption,
					ensurePreview, readReplies, setReadReplies, live, running: live || active,
				}) : editable && !selection && !status.personaReady ? h("div", { className: "dfy-desk-inline" },
					h(Btn, { onClick: () => goTab("wizard") }, "配置角色与声音")) : null),
			h(WorkbenchControls, { status, act, busy: busy || !!selection, goTab, officialUrl, connected }));
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
		return h("div", { className: "dfy-grid" },
			h(Card, { title: "训练记录" },
				h(Row, { label: "训练机会", value: data ? (data.opportunity.admit ? "样本/资源/政策门通过" : data.opportunity.detail) : "—" }),
				h(Row, { label: "学习状态", value: status ? (status.learningPaused ? "已暂停" : "观察学习中") : "—" }),
				data && data.lastEntry ? h(Row, { label: "上次训练", value: (TRAIN_STATUS[data.lastEntry.status] || data.lastEntry.status) + "：" + data.lastEntry.detail }) : null,
				data && data.latestRun ? h(Row, { label: "最近窗口", value: (RUN_STATUS[data.latestRun.status] || data.latestRun.status) + " · " + data.latestRun.optimizer_steps + " 步" }) : null,
				h("div", { className: "dfy-actions" },
					h(Btn, { tone: "primary", disabled: busy || !status || !status.trainingEligible || status.learningPaused, onClick: async () => { await act("training/train-once", {}, "运行训练演练"); load(); } }, "运行训练演练"),
					h(Btn, { disabled: busy || !status, onClick: async () => { await act(status && status.learningPaused ? "learning/resume" : "learning/pause", {}, "切换学习状态"); load(); } }, status && status.learningPaused ? "恢复学习" : "暂停学习"),
					h(Btn, { tone: "ghost", onClick: load }, "刷新"))),
			h(Card, { title: "训练语义" },
				h(Row, { label: "样本门槛", value: "≥32 合格样本（非复制样本）" }),
				h(Row, { label: "资源门", value: "free_vram ≥ 峰值 + 余量" }),
				h(Row, { label: "champion", value: "全程不动" }),
				h("p", { className: "dfy-caption", style: { margin: 0 } }, "直播期间仅在资源窗口训练；样本不足如实说明条件；验证未通过继续使用稳定版本。")));
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
			const correction = label === "wrong" ? (window.prompt("正确说法（选填，作为纠错证据）：") || "") : "";
			const r = await api("feedback", { targetReplyId: reply.requestId, label: label, correction: correction || undefined });
			setNote(r.ok ? "反馈已提交：" + FB_STATUS[r.result.status] : "提交失败：" + r.error);
			load();
		};
		const advance = async (feedbackId, next, label) => {
			const r = await api("feedback/advance", { feedbackId: feedbackId, next: next });
			setNote(r.ok ? "已推进：" + label : "推进失败：" + r.error);
			load();
		};

		return h("div", { className: "dfy-grid" },
			h("section", { className: "dfy-card", style: { gridColumn: "1/-1" } },
				h("div", { className: "dfy-card-h" },
					h("h3", null, "最近回复"),
					note ? h("span", { className: "dfy-caption" }, note) : null,
					h(Btn, { tone: "ghost", onClick: load }, "刷新")),
				h("div", { className: "dfy-list" },
					data === null ? h(Loading, null) : data.replies.length === 0 ? h("p", { className: "dfy-muted", style: { margin: 0 } }, "暂无播出留痕（有问答后可见最近 50 条）") : null,
					(data ? data.replies : []).map((r) => h("div", { key: r.replyId, className: "dfy-item" },
						h("div", { className: "dfy-item-h" },
							h("span", { className: "dfy-caption" }, "问"),
							h("span", { className: "dfy-item-t", title: r.question }, r.question),
							h(Badge, { tone: "idle", text: r.route })),
						h("div", { className: "dfy-item-sub" }, "答：" + r.reply),
						h("div", { style: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" } },
							h("span", { className: "dfy-caption" }, "反馈"),
							["useful", "wrong", "off_persona", "too_slow"].map((lb) => h("button", { key: lb, type: "button", className: "dfy-pill", onClick: () => send(r, lb) }, FB_LABEL[lb])),
							r.feedback.length > 0 ? h("span", { className: "dfy-caption", style: { color: "var(--dsw-alias-state-success-primary,#1c7a54)" } }, r.feedback.map((f) => FB_LABEL[f.label] + "·" + FB_STATUS[f.status]).join("，")) : null))))),
			h(Card, { title: "反馈处理" },
				fbs === null ? h(Loading, null) : fbs.feedback.length === 0 ? h("p", { className: "dfy-muted", style: { margin: 0 } }, "暂无反馈") : null,
				h("div", { className: "dfy-list" },
					(fbs ? fbs.feedback : []).map((f) => h("div", { key: f.feedbackId, className: "dfy-item" },
						h("div", { className: "dfy-item-h" },
							h("span", { className: "dfy-item-t" }, FB_LABEL[f.label] || f.label),
							h(Badge, { tone: f.status === "resolved" ? "ok" : f.status === "received" ? "warn" : "idle", text: FB_STATUS[f.status] || f.status })),
						h("div", { className: "dfy-item-sub dfy-muted" }, f.correction ? "纠正：" + f.correction : (f.targetReplyId ? "已关联回复" : "片段级（未定位具体回复）")),
						h("div", { className: "dfy-pills" },
							f.status === "received" ? h("button", { type: "button", className: "dfy-pill", onClick: () => advance(f.feedbackId, "verifying", "核实中") }, "开始核实") : null,
							f.status === "verifying" ? h("button", { type: "button", className: "dfy-pill", onClick: () => advance(f.feedbackId, "resolved", "已修复") }, "已修复") : null,
							f.status === "verifying" ? h("button", { type: "button", className: "dfy-pill", onClick: () => advance(f.feedbackId, "insufficient_evidence", "证据不足") }, "证据不足") : null))))),
			gifts ? h(Card, { title: "礼物账本（标价不等于实际收入）" },
				h("div", { className: "dfy-kpis", style: { gridTemplateColumns: "repeat(auto-fit,minmax(88px,1fr))" } },
					h(Kpi, { label: "收到", value: String(gifts.totals.receivedQty) }),
					h(Kpi, { label: "待结算", value: String(gifts.totals.pendingSettlementQty) }),
					h(Kpi, { label: "已结算", value: String(gifts.totals.settledQty) }),
					h(Kpi, { label: "退款", value: String(gifts.totals.refundedQty) }),
					h(Kpi, { label: "未验证", value: String(gifts.totals.unverifiedCount) })),
				h("label", { className: "dfy-check" },
					h("input", { type: "checkbox", checked: gifts.ackSettings.nameMention, onChange: async (e) => { await api("settings/gifts", { nameMention: e.target.checked }); load(); } }),
					h("span", null, "答谢点名（关闭后统一说「谢谢这位朋友」；危险昵称仍不点名）")),
				h("div", { className: "dfy-list" },
					gifts.entries.map((e) => h("div", { key: e.entry_id, className: "dfy-item-h" },
						h("span", { className: "dfy-item-t" }, e.gift_id + " ×" + e.quantity_delta),
						h(Badge, { tone: e.verification_status === "verified" ? "ok" : "warn", text: e.verification_status === "verified" ? "已验证" : "未验证" }),
						h("span", { className: "dfy-caption", style: { marginLeft: "auto" } }, SETTLE[e.settlement_status] || e.settlement_status)))),
				h("p", { className: "dfy-caption", style: { margin: 0 } }, gifts.notes.join("；"))) : null);
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
			const s = await api("governance/skills");
			const m = await api("governance/memory");
			const r = await api("governance/releases");
			const a = await api("governance/audit");
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
					h(Btn, { disabled: busy || !status || !status.activeReleaseId, onClick: () => act("release/rollback", {}, "恢复稳定版本") }, "恢复稳定版本"))),
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
		return h("div", { className: "dfy-grid" },
			h(Card, { title: "环境自检", extra: h(Btn, { tone: "ghost", onClick: runCheck }, "运行") },
				note ? h("p", { className: "dfy-caption", style: { margin: 0 } }, note) : null,
				report ? h("div", { className: "dfy-list" },
					report.items.map((it) => h("div", { key: it.id, className: "dfy-item" },
						h("div", { className: "dfy-item-h" },
							h(Badge, { tone: it.ok ? "ok" : "err", text: it.ok ? "通过" : "缺失" }),
							h("span", { className: "dfy-item-t" }, it.label)),
						h("div", { className: "dfy-caption" }, it.detail + (it.fixAction ? "（修复：" + it.fixAction + "）" : ""))))) : h("p", { className: "dfy-muted", style: { margin: 0 } }, "点击「运行」执行环境自检。")),
			h(Card, { title: "诊断报告（脱敏导出）" },
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

	const MANAGE_TABS = [
		{ id: "wizard", label: "配置", render: (ctx) => h(WizardTab, { onSaved: ctx.refresh }) },
		{ id: "training", label: "训练记录", render: (ctx) => h(TrainingTab, ctx) },
		{ id: "interact", label: "互动与账本", render: () => h(InteractTab) },
		{ id: "audience", label: "观众", render: () => h(AudienceTab) },
		{ id: "gov", label: "治理", render: (ctx) => h(GovernanceTab, ctx) },
		{ id: "diag", label: "诊断", render: () => h(DiagTab) },
	];

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
		const [notice, setNotice] = useState("");
		const [pending, setPending] = useState("");
		const [emergency, setEmergency] = useState(false);
		const [connected, setConnected] = useState(true);
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
				if (configTicket === settingsTicket.current && result.ok) setSettings(result.settings);
			}).catch(() => {})]);
		}, []);

		useEffect(() => {
			let disposed = false;
			let timer;
			let ticks = 0;
			refresh();
			const poll = async () => {
				if (!document.hidden) await refresh(tab === "home" && ++ticks % 5 !== 0);
				if (!disposed) timer = setTimeout(poll, tab === "home" ? 1200 : 4000);
			};
			timer = setTimeout(poll, 1200);
			const visible = () => { if (!document.hidden) refresh(); };
			document.addEventListener("visibilitychange", visible);
			return () => {
				disposed = true;
				clearTimeout(timer);
				statusTicket.current++;
				settingsTicket.current++;
				document.removeEventListener("visibilitychange", visible);
			};
		}, [refresh, tab]);

		const act = async (path, body, label) => {
			const urgent = path === "live/emergency-stop";
			if (urgent ? emergencyAction.current : action.current || emergencyAction.current) return;
			const operation = { superseded: false };
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
		const current = MANAGE_TABS.find((item) => item.id === tab);
		const live = status?.liveStatus === "live_confirmed";
		const ctx = { status, settings, act, pending, busy: !!pending || emergency, connected, emergency, refresh, goTab: setTab };
		return h("div", { className: "dfy-root dfy-desk-root" },
			h("header", { className: "dfy-head dfy-desk-header" },
				h(FishIcon, { size: 26 }),
				h("h2", null, "大肥鱼直播"),
				h("nav", { className: "dfy-desk-nav", "aria-label": "页面" },
					h("button", { type: "button", className: "dfy-tab" + (!current ? " dfy-tab-on" : ""),
						"aria-current": !current ? "page" : undefined, onClick: () => setTab("home") }, "工作台"),
					h("button", { type: "button", className: "dfy-tab" + (current ? " dfy-tab-on" : ""),
						"aria-current": current ? "page" : undefined, onClick: () => setTab(current?.id || "wizard") }, "管理")),
				h("div", { className: "dfy-head-x" }, h(Badge, { tone: !connected ? "err" : live ? "ok" : "idle", dot: live && connected,
					text: !connected ? "连接中断" : status?.liveDisplay || "连接中…" }))),
			h("main", { className: "dfy-body dfy-desk-body" },
				current ? h("div", { className: "dfy-manage" },
					h("nav", { className: "dfy-manage-nav", "aria-label": "管理分类" },
						MANAGE_TABS.map((item) => h("button", { key: item.id, type: "button", className: "dfy-tab" + (item.id === tab ? " dfy-tab-on" : ""),
							"aria-current": item.id === tab ? "page" : undefined, onClick: () => setTab(item.id) }, item.label))),
					h("div", { className: "dfy-manage-content" }, current.render(ctx))) : h(Workbench, ctx)),
			h("footer", { className: "dfy-foot dfy-desk-foot" },
				h("span", { className: "dfy-caption", role: "status" }, notice || (!connected ? "正在重新连接…" : "")),
				h(Btn, { tone: "danger", disabled: emergency, onClick: () => act("live/emergency-stop", {}, "紧急停止播出") },
					emergency ? "正在停止…" : "紧急停止播出")));
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

	return { apply, inject: ["slots"], name: "dsh-dafeiyu-evolve" };
}});
