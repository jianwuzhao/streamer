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
.dfy-tabs{display:flex;gap:2px;padding:4px 16px 0;overflow-x:auto;scrollbar-width:none}
.dfy-tabs::-webkit-scrollbar{display:none}
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
.dfy-banner{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:12px 16px;border-radius:12px;border:.5px solid var(--dsw-alias-border-l1,#d8e2e0);background:var(--dsw-alias-bg-layer-1,#fff)}
.dfy-banner-live{border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#1c7a54) 42%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#1c7a54) 8%,var(--dsw-alias-bg-layer-1,#fff))}
.dfy-banner-busy{border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#b8860b) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#b8860b) 9%,var(--dsw-alias-bg-layer-1,#fff))}
.dfy-banner-main{display:grid;gap:2px;min-width:0}
.dfy-banner-main strong{font-size:17px;font-weight:700;line-height:1.25}
.dfy-banner-side{margin-left:auto;display:flex;gap:8px;flex-wrap:wrap}
/* 语义 toast：role=status / aria-live */
.dfy-toast{display:flex;align-items:center;gap:8px;padding:8px 12px;border-radius:8px;font-size:12.5px;border:.5px solid transparent;margin-top:12px}
.dfy-toast-ok{background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#1c7a54) 10%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#1c7a54) 30%,transparent);color:var(--dsw-alias-state-success-primary,#1c7a54)}
.dfy-toast-err{background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#c0392b) 10%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#c0392b) 30%,transparent);color:var(--dsw-alias-state-error-primary,#c0392b)}
.dfy-toast-busy{background:var(--dsw-alias-bg-layer-2,#eef2f1);border-color:var(--dsw-alias-border-l1,#d8e2e0);color:var(--dsw-alias-label-secondary,#45606b)}
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
@media (max-width:760px){.dfy-wizard{grid-template-columns:1fr}.dfy-body{padding:12px}.dfy-head,.dfy-tabs,.dfy-foot{padding-left:12px;padding-right:12px}.dfy-kpis{grid-template-columns:repeat(auto-fit,minmax(104px,1fr))}}
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
.dfy-profile-hero{display:grid;gap:10px}
.dfy-profile-hero .dfy-profile-zh{font-size:24px}
.dfy-profile-hero .dfy-profile-en{font-size:12px;letter-spacing:3px}
.dfy-profile-hero .dfy-profile-info{grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px}
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

	/** 语义 toast：成功 / 失败 / 进行中，role=status + aria-live。 */
	const Toast = ({ note }) => {
		if (!note) return null;
		const tone = note.endsWith("…") ? "busy" : /失败|未通过|无效|错误/.test(note) ? "err" : "ok";
		return h("div", { className: "dfy-toast dfy-toast-" + tone, role: "status", "aria-live": "polite" }, note);
	};

	// ------------------------------------------------------------------ 图标（画布彩色鱼 / 导航单色剪影+蓝气泡）

	const FishIcon = ({ size = 16, theme }) => {
		if (theme) {
			return h("svg", { width: size, height: size, viewBox: "0 0 64 64", "aria-hidden": true },
				h("rect", { x: 2, y: 2, width: 60, height: 60, rx: 14, fill: theme.primary }),
				h("ellipse", { cx: 30, cy: 34, rx: 20, ry: 12, fill: theme.accent }),
				h("path", { d: "M46 28 L58 22 L54 34 L58 46 L46 40 Z", fill: theme.accent }),
				h("circle", { cx: 20, cy: 30, r: 3, fill: "#17303c" }),
				h("path", { d: "M14 40 Q26 48 38 40", stroke: "#17303c", strokeWidth: 2.5, fill: "none", strokeLinecap: "round" }),
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

	/**
	 * 大肥鱼桌宠：圆角「桌面小组件」窗口（非 16:9 画布）。
	 * 标题栏 + 半透明渐变场景 + 摆尾/呼吸的胖鱼 + 嘴边气泡字幕 + 常显红色 AI 角标 + 底部状态条。
	 * 纯展示组件；speaking 时气泡高亮；字幕容器 role=status / aria-live=polite。
	 */
	function DeskPet({ persona, speaking, subtitle }) {
		const p = persona || {};
		const theme = p.theme || AVATAR_THEME[p.avatarId] || AVATAR_THEME["fish-deskpet"];
		const name = p.name || "大肥鱼";
		const aiLabel = p.aiLabelText || "AI 生成内容";
		const text = subtitle || "大家好，我是大肥鱼～";
		const sceneBg = p.theme && p.theme.bg ? p.theme.bg : null;
		return h("div", { className: "dfy-pet-wrap" },
			h("div", { className: "dfy-pet-window" },
				h("div", { className: "dfy-pet-title" },
					h("span", { className: "dfy-pet-dots", "aria-hidden": true }, h("i"), h("i"), h("i")),
					h("span", { className: "dfy-pet-name" }, name),
					h("span", { className: "dfy-pet-title-tag" }, "桌宠小组件")),
				h("div", { className: "dfy-pet-scene", style: sceneBg ? { background: sceneBg } : undefined },
					h("span", { className: "dfy-pet-ai", title: "AI 标识常显，不可隐藏" }, aiLabel),
					h("div", { className: "dfy-pet-bubbles", "aria-hidden": true }, h("i"), h("i"), h("i")),
					h("div", { className: "dfy-pet-bubble" + (speaking ? " dfy-pet-bubble-on" : ""), role: "status", "aria-live": "polite" }, text),
					h("div", { className: "dfy-pet-fish" },
						h("span", { className: "dfy-pet-sway" }, h(FishIcon, { size: 116, theme: theme })))),
				h("div", { className: "dfy-pet-status" },
					h("span", null, "本地预览 · 未推流 · AI 标识常显"),
					h("span", null, speaking ? "● 正在说话" : "○ 待机中"))));
	}

	function PreviewCanvas({ preview, compact }) {
		const p = preview || {};
		const persona = p.persona || { name: "大肥鱼", avatarId: "fish-classic", aiLabelText: "AI 生成内容" };
		const scene = p.scene || { title: "大肥鱼的直播间", danmakuOverlay: true };
		const theme = AVATAR_THEME[persona.avatarId] || AVATAR_THEME["fish-classic"];
		const bg = SCENE_BG[scene.background || "teal"] || SCENE_BG.teal;
		// 桌宠形象：改用桌面小组件窗口（compact 同样正常显示），不再用 16:9 全屏画布
		if (isDeskpetId(persona.avatarId)) {
			return h("div", { style: { minWidth: 0 } },
				h(DeskPet, { persona: persona, speaking: false, subtitle: "大家好，我是大肥鱼～" }),
				h("p", { className: "dfy-caption", style: { margin: "8px 2px 0" } },
					"大肥鱼桌宠 · 本地预览（未推流）· AI 标识常显"));
		}
		return h("div", {
			className: "dfy-canvas",
			style: { background: "linear-gradient(160deg, " + bg + " 0%, #08131a 100%)" },
		},
		h("div", { style: { position: "absolute", top: compact ? 8 : 12, left: compact ? 10 : 14, color: "#dfeeea", fontSize: compact ? 11.5 : 14, fontWeight: 700, textShadow: "0 1px 3px rgba(0,0,0,.45)", maxWidth: "70%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, scene.title),
		h("span", { style: { position: "absolute", top: compact ? 8 : 12, right: compact ? 10 : 14, fontSize: 10.5, fontWeight: 700, padding: "3px 8px", borderRadius: 999, background: "rgba(192,57,43,.92)", color: "#fff" } }, persona.aiLabelText || "AI 生成内容"),
		h("div", { style: { position: "absolute", left: 0, right: 0, bottom: compact ? 6 : 12, display: "flex", alignItems: "center", justifyContent: "center", gap: 10 } },
			h(FishIcon, { size: compact ? 36 : 64, theme }),
			h("span", { style: { color: theme.accent, fontSize: compact ? 12.5 : 17, fontWeight: 700, textShadow: "0 1px 4px rgba(0,0,0,.45)", maxWidth: "55%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, persona.name)),
		scene.danmakuOverlay && !compact ? h("div", { style: { position: "absolute", top: 40, left: 14, right: 14, fontSize: 11, color: "rgba(255,255,255,.75)", display: "grid", gap: 3 } },
			h("span", null, "「先把手上的事做完」"),
			h("span", { style: { marginLeft: 36 } }, "「大肥鱼今天种什么？」")) : null,
		h("span", { style: { position: "absolute", bottom: 6, left: 10, fontSize: 10, color: "rgba(255,255,255,.55)" } },
			p.previewActive ? "本地预览（未推流） · AI 标识常显" : "未在预览"));
	}

	// ------------------------------------------------------------------ 首页

	function HomeTab({ status, settings, act, busy, goTab }) {
		const s = status;
		const live = s && s.liveStatus === "live_confirmed";
		const starting = s && ["self_check", "local_preview", "awaiting_platform", "stream_established"].includes(s.liveStatus);
		const canTrain = s && s.trainingEligible && !s.learningPaused;
		const needWizard = s && (!s.personaReady || !s.platformReady);
		return h("div", { className: "dfy-grid" },
			h("div", { className: "dfy-banner " + (live ? "dfy-banner-live" : starting ? "dfy-banner-busy" : "") + " dfy-spanall" },
				h(FishIcon, { size: 30, theme: AVATAR_THEME["fish-classic"] }),
				h("div", { className: "dfy-banner-main" },
					h("strong", null, s ? s.liveDisplay : "连接中…"),
					h("span", { className: "dfy-caption" },
						live ? "平台已确认直播中 · 紧急停止可立即进入安全场景"
							: starting ? "开播流程进行中：确认形象与 AI 标识正常后等待平台确认"
								: "未开播 · 先完成配置，再进入本地预览确认画面")),
				h("div", { className: "dfy-banner-side" },
					s ? h(Badge, { tone: s.personaReady ? "ok" : "err", text: s.personaReady ? "形象就绪" : "形象未配置" }) : null,
					s ? h(Badge, { tone: s.platformReady ? "ok" : "err", text: s.platformReady ? "接入就绪" : "接入未配置" }) : null)),
			h("div", { className: "dfy-kpis dfy-spanall" },
				h(Kpi, { label: "直播状态", value: s ? s.liveDisplay : "—", tone: live ? "ok" : undefined }),
				h(Kpi, { label: "学习状态", value: s ? (s.learningPaused ? "已暂停" : "观察学习中") : "—" }),
				h(Kpi, { label: "当前版本", value: s && s.activeReleaseId ? s.activeReleaseId : "基线", title: s && s.activeReleaseId ? s.activeReleaseId : "基线" }),
				h(Kpi, { label: "当日费用", value: s ? s.todayCostCny.toFixed(2) + " 元" : "—", title: "以服务商账单为准" }),
				h(Kpi, { label: "云端兜底", value: s ? (s.cloudEnabled ? "已启用" : "未配置") : "—" }),
				h(Kpi, { label: "待处理", value: s ? s.pendingIssues + " 条" : "—", tone: s && s.pendingIssues > 0 ? "err" : undefined })),
			needWizard ? h("div", { className: "dfy-note dfy-note-warn dfy-spanall" },
				h("strong", null, "首次配置未完成"),
				h("span", { className: "dfy-muted" }, !s.personaReady ? s.personaReadyReason : s.platformReadyReason),
				h("div", { className: "dfy-actions" },
					h(Btn, { tone: "primary", disabled: busy, onClick: () => goTab("wizard") }, "去首次配置"))) : null,
			s && s.liveStatus === "awaiting_platform" ? h("div", { className: "dfy-note dfy-note-warn dfy-spanall" },
				h("span", null, "平台状态待确认：在直播伴侣完成开播后，回来同步状态。"),
				h("div", { className: "dfy-actions" },
					h(Btn, { disabled: busy, onClick: () => act("live/operator-confirm", {}, "我已在官方客户端开播") }, "我已在官方客户端开播"))) : null,
			h(Card, { title: "主操作", extra: h(Badge, { tone: s && s.personaReady ? "ok" : "err", text: s && s.personaReady ? "形象就绪" : "形象未配置" }) },
				h("div", { className: "dfy-actions" },
					h(Btn, { tone: "primary", disabled: busy || !s || live, onClick: () => act("live/start", {}, "开始直播") }, starting ? "开播进行中…" : "开始直播"),
					h(Btn, { disabled: busy || !s || (!live && !starting), onClick: () => act("live/stop", {}, "结束直播") }, "结束直播"),
					h(Btn, { disabled: busy || !s || !canTrain, onClick: () => act("training/train-once", {}, "训练一次") }, "训练一次"),
					h(Btn, { disabled: busy || !s, onClick: () => act(s && s.learningPaused ? "learning/resume" : "learning/pause", {}, s && s.learningPaused ? "恢复学习" : "暂停学习") }, s && s.learningPaused ? "恢复学习" : "暂停学习"),
					h(Btn, { disabled: busy || !s || !s.activeReleaseId, onClick: () => act("release/rollback", {}, "恢复稳定版本") }, "恢复稳定版本")),
				h("p", { className: "dfy-caption" }, "开播流程：自检 → 本地预览 → 等待平台确认；平台未确认绝不显示「直播中」。")),
			h(Card, { title: "运行信息", extra: h(Badge, { tone: s && s.platformReady ? "ok" : "err", text: s && s.platformReady ? "接入就绪" : "接入未配置" }) },
				h(Row, { label: "运行模式", value: s ? s.mode + (s.killSwitch ? "（killSwitch）" : "") : "—" }),
				h(Row, { label: "训练机会", value: s ? (s.trainingEligible ? "三门通过" : s.trainingEligibleDetail) : "—" }),
				h(Row, { label: "云端配置", value: s ? (s.cloudEnabled ? "已启用（按日预算）" : "未配置：不产生付费调用") : "—" })),
			settings && settings.profile ? h(Card, { title: "主播信息 · 角色档案",
				extra: h(Badge, { tone: settings.profile.source === "plugin" ? "ok" : "idle", text: settings.profile.source === "plugin" ? "dsh-pet · 插件中" : "鹅次元角色" }) },
				h(ProfileCard, { profile: settings.profile, hero: true }),
				h("div", { className: "dfy-actions" },
					h(Btn, { tone: "ghost", onClick: () => goTab("wizard") }, "更换角色档案"))) : null,
			s && s.previewActive ? h(Card, { title: "本地预览进行中", extra: h(Btn, { tone: "ghost", onClick: () => goTab("preview") }, "打开预览") },
				h(PreviewCanvas, { preview: { previewActive: true, persona: { name: "大肥鱼", aiLabelText: "AI 生成内容" }, scene: {} }, compact: true })) : null);
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
			{ label: "模型与云端", hint: "本地优先，云端选填", state: null, body: h(CloudStep, { settings: data, save: save }) },
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

		const selected = profiles.find((x) => x.id === profileId) || settings.profile || null;
		const payload = () => ({ profileId: profileId, personaName: selected ? selected.name : p.personaName, voiceId: voice, samplePhrase: phrase, usageRightConfirmed: right });

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

		return h("div", { style: { display: "grid", gap: 12 } },
			h("p", { className: "dfy-muted", style: { margin: 0 } },
				"主播信息以角色档案呈现（参照 eciyuan.qq.com 的 CHARACTERS 角色介绍）：中文名 / 英文名 / #人设标签 / 年龄·身高·星座·MBTI。选择档案后播出展示名同步为该角色中文名。"),
			selected ? h(Card, { title: "当前角色档案", extra: h(Badge, { tone: selected.source === "plugin" ? "ok" : "idle", text: selected.source === "plugin" ? "dsh-pet · 插件中" : "鹅次元角色" }) },
				h(ProfileCard, { profile: selected, hero: true })) : null,
			h(Field, { label: "选择角色档案" },
				h("div", { className: "dfy-profiles" },
					profiles.map((x) => h(ProfileCard, { key: x.id, profile: x, selected: x.id === profileId, onSelect: () => setProfileId(x.id) })))),
			h(Field, { label: "音色（最终播出音色以直播伴侣音轨为准）" },
				h("div", { className: "dfy-choice" },
					settings.catalogs.voices.map((v) => h("button", {
						key: v.id, type: "button", className: "dfy-chip" + (voice === v.id ? " dfy-chip-on" : ""),
						onClick: () => setVoice(v.id),
					}, h("b", null, v.label), h("span", { className: "dfy-muted" }, v.style))))),
			h(Field, { label: "试听语句" },
				h("div", { style: { display: "grid", gap: 8, gridTemplateColumns: "minmax(0,1fr) auto" } },
					h("input", { className: "dfy-input", value: phrase, maxLength: 80, onChange: (e) => setPhrase(e.target.value) }),
					h(Btn, { onClick: listen }, "试听")),
				listenNote ? h("span", { className: "dfy-caption" }, listenNote) : null),
			h("label", { className: "dfy-check" },
				h("input", { type: "checkbox", checked: right, onChange: (e) => setRight(e.target.checked) }),
				h("span", null, "我确认对所选角色形象与声音具有使用授权（开播前必须勾选）")),
			h("p", { className: "dfy-caption", style: { margin: 0 } }, "AI 标识在画面上常显且不可关闭（法规要求）。当前文案：" + p.aiLabelText),
			h("div", { className: "dfy-actions" },
				h(Btn, { tone: "primary", onClick: () => save("persona", payload()) }, "保存角色档案与播出设置")));
	}

	function CloudStep({ settings, save }) {
		const c = settings.cloud;
		const [enabled, setEnabled] = useState(c.enabled);
		const [provider, setProvider] = useState(c.provider);
		const [model, setModel] = useState(c.model);
		const [budget, setBudget] = useState(c.dailyBudgetCny === null ? "" : String(c.dailyBudgetCny));
		return h("div", { style: { display: "grid", gap: 12 } },
			h("p", { className: "dfy-muted", style: { margin: 0 } }, "本地优先：常规请求先走本地模型；未配置云端时不产生任何付费调用。云端仅作兜底，可全部留空。"),
			h(Row, { label: "本地预设", value: "Ollama · Qwen3-4B-Instruct（随安装固定）" }),
			h("label", { className: "dfy-check" },
				h("input", { type: "checkbox", checked: enabled, onChange: (e) => setEnabled(e.target.checked) }),
				h("span", null, "启用第三方兜底（OpenAI 兼容端点）")),
			h("div", { style: { display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))" } },
				h(Field, { label: "服务商" }, h("input", { className: "dfy-input", value: provider, placeholder: "留空 = 不覆盖配置文件", onChange: (e) => setProvider(e.target.value) })),
				h(Field, { label: "模型名" }, h("input", { className: "dfy-input", value: model, placeholder: "如 deepseek-chat", onChange: (e) => setModel(e.target.value) })),
				h(Field, { label: "每日费用上限（元）" }, h("input", { className: "dfy-input", value: budget, placeholder: "未设置 ⇒ 付费禁用", onChange: (e) => setBudget(e.target.value) }))),
			h("p", { className: "dfy-caption", style: { margin: 0, color: "var(--dsw-alias-state-error-primary,#c0392b)" } }, "API Key 不在界面保存：以环境变量 DAFEIYU_CLOUD_API_KEY 提供；覆盖在重启插件后生效。"),
			h("div", { className: "dfy-actions" },
				h(Btn, { tone: "primary", onClick: () => save("cloud", { enabled: enabled, provider: provider, model: model, dailyBudgetCny: budget === "" ? null : Number(budget) }) }, "保存")));
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

	function PreviewTab({ status, act, busy }) {
		const [preview, setPreview] = useState(null);
		const load = useCallback(async () => {
			const r = await api("preview");
			if (r.ok) setPreview(r.preview);
		}, []);
		useEffect(() => { load() }, [load, status && status.liveStatus]);

		const active = preview && preview.previewActive;
		const inFlow = status && ["local_preview", "awaiting_platform", "stream_established", "live_confirmed", "self_check"].includes(status.liveStatus);
		return h("div", { className: "dfy-grid" },
			h("section", { className: "dfy-card", style: { gridColumn: "1/-1" } },
				h("div", { className: "dfy-card-h" }, h("h3", null, "本地预览（浏览器渲染画布）"), h(Badge, { tone: active ? "ok" : "idle", text: active ? "预览中" : "未预览" })),
				h("div", { className: "dfy-split" },
					h(PreviewCanvas, { preview: preview }),
					h("div", { style: { display: "grid", gap: 10, alignContent: "start" } },
						h(Row, { label: "当前状态", value: preview ? preview.liveDisplay : "—" }),
						h(Row, { label: "角色档案", value: preview && preview.persona ? preview.persona.name + (preview.persona.enName ? " / " + preview.persona.enName : "") : "—" }),
						preview && preview.persona && preview.persona.tagline ? h(Row, { label: "#人设", value: preview.persona.tagline }) : null,
						h(Row, { label: "AI 标识", value: preview && preview.persona ? preview.persona.aiLabelText : "—" }),
						h("div", { className: "dfy-actions" },
							h(Btn, { tone: "primary", disabled: busy || active, onClick: async () => { await act("preview/start", {}, "进入本地预览"); load(); } }, active ? "预览中" : "进入本地预览"),
							h(Btn, { disabled: busy || !inFlow || (status && status.liveStatus === "live_confirmed"), onClick: async () => { await act("preview/stop", {}, "退出预览"); load(); } }, "退出预览"),
							h(Btn, { tone: "ghost", onClick: load }, "刷新")),
						h("p", { className: "dfy-caption", style: { margin: 0 } }, "本地预览 ≠ 已开播：预览不推流。确认形象、声音与 AI 标识正常后再开始直播。")))),
			preview && preview.liveStatus === "awaiting_platform" ? h(Card, { title: "平台状态待确认" },
				h("p", { style: { margin: 0 } }, "官方客户端（直播伴侣）完成开播后回来自行同步状态："),
				h("div", { className: "dfy-actions" },
					h("a", { className: "dfy-link", href: preview.officialClientUrl, target: "_blank", rel: "noreferrer" }, "打开直播伴侣说明"),
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
		return h("div", { className: "dfy-grid" },
			h(Card, { title: "一键训练（训练完成 ≠ 发布）" },
				h(Row, { label: "训练机会", value: data ? (data.opportunity.admit ? "样本/资源/政策门通过" : data.opportunity.detail) : "—" }),
				h(Row, { label: "学习状态", value: status ? (status.learningPaused ? "已暂停" : "观察学习中") : "—" }),
				data && data.lastEntry ? h(Row, { label: "上次训练", value: (TRAIN_STATUS[data.lastEntry.status] || data.lastEntry.status) + "：" + data.lastEntry.detail }) : null,
				data && data.latestRun ? h(Row, { label: "最近窗口", value: (RUN_STATUS[data.latestRun.status] || data.latestRun.status) + " · " + data.latestRun.optimizer_steps + " 步" }) : null,
				h("div", { className: "dfy-actions" },
					h(Btn, { tone: "primary", disabled: busy || !status || !status.trainingEligible || status.learningPaused, onClick: async () => { await act("training/train-once", {}, "训练一次"); load(); } }, "训练一次"),
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
		const [settings, setSettings] = useState(null);
		const [note, setNote] = useState("");
		const [busy, setBusy] = useState(false);

		const refresh = useCallback(async () => {
			try {
				const r = await api("status");
				if (r.ok) setStatus(r.status);
			} catch { /* 面板离线时保留上次状态 */ }
			try {
				const s = await api("settings");
				if (s.ok) setSettings(s.settings);
			} catch { /* 面板离线时保留上次设置 */ }
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
				if (r.ok && r.result && typeof r.result === "object" && r.result.reason) setNote(label + "未通过：" + r.result.reason);
				else setNote(label + (r.ok ? " 完成" : " 失败：" + (r.error || "未知错误")));
				if (r.ok && r.status) setStatus(r.status); else await refresh();
			} catch (e) { setNote(label + " 请求失败：" + e.message); }
			setBusy(false);
		};

		const ctx = { status: status, settings: settings, act: act, busy: busy, refresh: refresh, goTab: setTab };
		const current = TABS.find((t) => t.id === tab) || TABS[0];
		const live = status && status.liveStatus === "live_confirmed";
		const starting = status && ["self_check", "local_preview", "awaiting_platform", "stream_established"].includes(status.liveStatus);
		const headTone = live ? "ok" : starting ? "warn" : "idle";

		return h("div", { className: "dfy-root" },
			h("header", { className: "dfy-head" },
				h(FishIcon, { size: 26 }),
				h("div", { className: "dfy-head-t" },
					h("h2", null, "大肥鱼直播"),
					h("p", { className: "dfy-caption" }, "本地优先 · 自学习直播 · 平台未确认不显示直播中")),
				h("div", { className: "dfy-head-x" },
					h(Badge, { tone: headTone, dot: live, text: status ? status.liveDisplay : "连接中…" }),
					status ? h(Badge, { tone: status.personaReady && status.platformReady ? "ok" : "err", text: status.personaReady && status.platformReady ? "配置就绪" : "待配置" }) : null)),
			h("nav", { className: "dfy-tabs", role: "tablist", "aria-label": "面板页签",
				onKeyDown: (e) => {
					if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
					e.preventDefault();
					const i = TABS.findIndex((t) => t.id === tab);
					const next = e.key === "ArrowRight" ? (i + 1) % TABS.length : (i - 1 + TABS.length) % TABS.length;
					setTab(TABS[next].id);
				} },
				TABS.map((t) => h("button", {
					key: t.id, type: "button", role: "tab", "aria-selected": tab === t.id,
					tabIndex: tab === t.id ? 0 : -1,
					className: "dfy-tab" + (tab === t.id ? " dfy-tab-on" : ""),
					onClick: () => setTab(t.id),
				}, t.label))),
			h("div", { className: "dfy-body" },
				current.render(ctx),
				h(Toast, { note: note })),
			h("footer", { className: "dfy-foot" },
				h("span", { className: "dfy-caption" }, "紧急停止立即进入安全场景（停语音与动作）；与「暂停学习」不同。"),
				h(Btn, { tone: "danger", disabled: busy || !status, onClick: () => act("live/emergency-stop", {}, "紧急停止播出") }, "紧急停止播出")));
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
