# 快速开始（阶段 G · 本地模式）

> 目标硬件 RTX 4060 Ti 8GB；本机（无 NVIDIA GPU）可运行除真实推理/QLoRA 外的全部功能（dry-run 验证协议）。

## 1. 环境准备

```bash
pnpm install
pnpm test            # 163 项契约测试
pnpm test:worker     # Python worker 11 例（dry-run，零依赖）
```

## 2. 首次自检（向导同款清单）

```bash
DAFEIYU_DATA_DIR=./data node --input-type=module \
  -e "import('./src/installer/selfcheck.ts').then(async m => console.log(JSON.stringify(await m.runSelfCheck({ dataDir: './data' }), null, 1)))"
```

逐项输出 Node/Python/配置/数据目录/Ollama/GPU 结果与可修复动作；本机 GPU 项会如实标注"在线训练验收需目标机"。

## 3. 本地模式运行（装配插件）

```ts
import { createPlugin } from './lib/index.js'
const plugin = createPlugin({ dataDir: './data' })   // 未配置云端 ⇒ 云端禁用，不产生付费调用
```

四主操作映射：`plugin.live.session.start/stop`（开播/结束）、`plugin.live.trainingEntry.trainOnce`（训练一次）、`pauseLearning`（暂停学习）、`plugin.runtime.rollback(activeReleaseId)`（恢复稳定版本）；紧急停止 = `plugin.live.session.emergencyStop()`。

## 4. Web 面板操作流（向导 → 预览 → 开播）

宿主安装后侧边栏「大肥鱼直播」面板**九页签**（样式随宿主亮/暗主题自动切换）：

1. **首次配置**：①数据与自检（逐项结果与修复动作）→ ②直播接入（运行模式/内容类别/在官方客户端登录后点「我已在官方客户端登录直播账号」）→ ③主播形象（默认即「大肥鱼桌宠」；选形象/名称/音色，点「试听」用浏览器语音试听，勾选使用授权与「启用语音互动」——AI 标识固定常显不可关闭）→ ④模型与云端（可留空=纯本地）→ ⑤数据用途确认。
2. **直播预览**：点「进入本地预览」打开桌宠小窗（AI 标识角标常显）；本地预览 ≠ 已开播。形象未配置时给出单一可操作原因。
3. **模拟开播（第一次模拟开播）**：点「一键演练首播脚本」即可在本机跑完开场白 → 弹幕 → 语音互动 → 礼物 → 收尾；也可点「第一次模拟开播」后逐条发弹幕或按「🎤 开始说话」用麦克风语音互动（浏览器本机识别与朗读，录音不上传；不支持时可用文本兜底输入）。**此页全程不连接抖音、不推流、不改变真实直播状态**，事件流与演练报告如实标注路由分布与隔离声明。
4. **首页开播**（真实开播，与模拟开播分开）：向导完成前「开始直播」会被 preflight 拦下并提示缺什么；完成后开播停在「等待平台确认」，在直播伴侣完成开播后点「我已在官方客户端开播」。
5. **互动与账本 / 观众 / 治理 / 训练与学习 / 诊断**：最近回复+四类反馈（操作员可推进核实状态）、礼物账本汇总、观众画像管理（纠错/退出个性化/删除两步流）、技能库/记忆候选/发布链/审计、训练进度与机会门、自检重跑与脱敏诊断报告导出。

面板后端为同源 `/api/dafeiyu/*`（settings / preview / **simulation×7** / selfcheck / diagnostics / replies / feedback / gifts/summary / training/progress / costs / audience×5 / governance×4 + 四主操作）。模拟开播事件独立留痕，不写生产回复/账本/画像/训练样本。

## 5. 宿主安装（DSH 插件）

构建产物 `pnpm build` → `lib/index.js`（宿主半经 `src/host-adapter.ts` define 接入）；安装：宿主内 `plugin_manager install_bundle <仓库目录>`（需用户确认；Web UI 客户端半随安装启用）。

## 6. 目标机（实机验收）

安装 Ollama + `Qwen/Qwen3-4B-Instruct-2507` 量化产物；`pip install -e training-worker`；按 [training-worker/README](../training-worker/README.md) 执行 QLoRA 窗口与实机验收（§20.2-D）。
