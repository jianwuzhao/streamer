# 第一次模拟开播 · 本机演练报告

> 执行时间：2026-11-13 09:24:42（Asia/Shanghai，UTC 2026-11-13T01:24:42Z）
> 执行方式：`node scripts/simulate-first-run.ts`（本机 CLI，直接装配插件，不依赖宿主 Web UI）
> 数据目录：`./data`（本机 `DAFEIYU_DATA_DIR` 默认；SQLite 已应用迁移 010）
> 复核命令：`pnpm test`（163 例全过）、`pnpm typecheck`、`node --check client/client.js`

## 1. 背景与目标

本机已有抖音直播环境，需要进行「第一次模拟开播」；同时虚拟形象换成**大肥鱼桌宠**，并支持**语音互动**。本演练用于在不接触真实平台的前提下，验证首播链路、桌宠形象、语音互动留痕与隔离约束全部可用。

## 2. 执行前状态

| 项 | 值 |
| --- | --- |
| 主播名称 | 大肥鱼 |
| 虚拟形象 | `fish-deskpet`（大肥鱼桌宠 · 青绿，目录首位、默认选中） |
| AI 标识 | `AI 生成内容`，字面量 `aiLabelVisible=true`（不可关闭，§23.2） |
| 音色 | `qing-wan`（清婉·女声，zh-CN） |
| 语音互动 | `voiceInteractionEnabled=true`（浏览器本机识别/朗读，录音不上传） |
| 使用授权 | `usageRightConfirmed=true` |
| 真实直播状态 | **未配置**（`liveStatus=unconfigured`） |
| 本地 Ollama | 未部署（`http://127.0.0.1:11434` 不可达），如实标注 |

> 说明：本机数据库中已存在 `fish-deskpet` 设置（此前会话切换过），脚本再次显式保存以确认桌宠 + 语音开关。旧经典形象（`fish-classic` / `fish-gold` / `fish-night`）保留在目录，可回退。

## 3. 演练脚本内容

一键演练 `runScript()`：自动开场 → 4 条互动 → 自动收尾。共 6 条事件（`system` 开场 1 + 互动 4 + `system` 收尾 1）。

| # | kind | 输入 | 桌宠回复（播出字幕 / TTS 文本） | route |
| --- | --- | --- | --- | --- |
| 1 | system | 第一次模拟开播开始（本机沙箱，未推流） | 大家好，我是大肥鱼，今天咱们一起把日子过好。 | fallback |
| 2 | danmaku | 大肥鱼今天种什么？ | 今天先种点踏实的小计划，别急，一样一样来～ | fallback |
| 3 | voice | 你好呀，能听到我说话吗？ | 听见啦～我在桌面上陪着你，慢慢说，咱们把日子过好。 | fallback |
| 4 | gift | 送出一个小心心 | 谢谢这份支持，先把日子过好，咱们接着种田。 | fallback |
| 5 | danmaku | 讲讲今天的安排吧～ | 安排就三条：好好吃饭、慢慢做事、有空来桌面看看我。 | fallback |
| 6 | system | 模拟开播结束（未推流、未产生平台动作） | 今天先聊到这儿，咱们下次接着把日子过好～ | fallback |

**route 全部为 `fallback`，这是如实结果**：本机未部署 Ollama，本地优先路由在 5s 本地窗口内不可达，云端未配置/预算禁用 ⇒ 不产生任何付费调用 ⇒ 按 §4.1 使用随版本验证的固定降级模板（桌宠口吻），**不伪装成模型生成**。目标机部署 Ollama + Qwen3-4B 后，同样脚本会如实记为 `local_gpu`。

## 4. 演练报告（结构化）

| 字段 | 值 |
| --- | --- |
| runNo | **1**（第一次模拟开播） |
| isFirst | **true** |
| status | ended |
| startedAt / endedAt | 2026-11-13T01:24:42.031Z / 2026-11-13T01:24:42.058Z（约 27ms） |
| eventCount | 6 |
| voiceCount | 1（语音互动 1 次） |
| routeCounts | `{ "fallback": 6 }` |
| aiLabelText | AI 生成内容 |
| avatarLabel | 大肥鱼桌宠 · 青绿 |

报告 notes（7 条隔离声明）：

1. 模拟开播在本机沙箱进行：未连接抖音、未推流、未读取平台状态，首页不会显示「直播中」。
2. 云端未配置/预算禁用时不产生任何第三方付费调用；本地模型未部署时回复如实来自已验证固定模板（route=fallback），不伪装为模型生成。
3. 演练事件独立留痕（simulation_events），不写生产回复、礼物账本、观众画像、训练样本或发布链。
4. 感知事件以 source=simulation、replay=1 登记：只记录、不更新生产黑板投影、不触发答谢/学习动作。
5. AI 标识在桌宠窗口常显且不可关闭（§23.2）。
6. 语音识别与朗读在浏览器本机完成，录音不上传；仅转写文本按模拟事件留痕。
7. 本场次不计入生产灰度、发布、固化或模型晋级，也不计入当日真实直播场次。

## 5. 隔离与合规复核（实际查询本机 DB）

| 复核项 | 结果 |
| --- | --- |
| 真实直播状态演变 | 未配置 → **未配置**（`liveStatusUnchanged=true`，未调用 `live/start`、未推流、未读平台状态） |
| `simulation_events` 行数 | 6 |
| `events` 中 `source=simulation AND replay=1` | 6 |
| `events` 中非 simulation 来源 | 0 |
| `reply_log`（生产播出留痕） | 0 |
| `gift_ledger`（礼物账本） | 0 |
| `viewer_profiles`（观众画像） | 0 |
| `training_samples`（训练样本） | 0 |
| `releases`（发布链） | 0 |
| `productionUntouched` | **true** |
| `aiLabelVisible` | true |

结论：**第一次模拟开播成功**，桌宠形象与语音互动链路可用，全程与生产链路隔离，未接触抖音平台。

## 6. Web 面板上的等价操作

宿主 Web GUI 刷新后：侧边栏「大肥鱼直播」→ **模拟开播** 页签 → 点「一键演练首播脚本」（或先「第一次模拟开播」再逐条互动）。

- **语音互动**：点「🎤 开始说话」，浏览器逐次申请麦克风权限；识别转写文本走 `POST /api/dafeiyu/simulation/voice`，桌宠气泡显示回复字幕并由 `speechSynthesis` 朗读；录音不上传、不入库。浏览器不支持识别/拒绝授权时，可用「文本兜底输入」按语音发送或按弹幕发送。
- **事件流**：显示弹幕/语音/礼物/系统每一条的问答与 route 徽章。
- **演练报告**：显示场次号、首场标记、事件数、语音数、路由分布与 7 条隔离声明。
- **真实开播仍在首页「开始直播」**，与模拟开播是两个独立入口；平台未确认绝不显示「直播中」。

## 7. 已知边界（如实标注）

- 本机无 NVIDIA GPU / 未部署 Ollama，回复走已验证固定模板；真实模型推理、QLoRA、两小时连续试运行按方案 §20.2 在目标机验收。
- 语音互动依赖浏览器 `SpeechRecognition` / `speechSynthesis`（Chrome/Edge 支持较好）；不支持时文本兜底输入仍可完成演练，录音环节如实不可用。
- 模拟开播不替代平台侧实名、人脸、推流与账号模式确认；真实首播仍需在直播伴侣完成平台确认。

## 8. 复现

```bash
# 干净重跑一次（会新增一场；如需「第一次」语义先清理演练留痕）
sqlite3 data/dafeiyu.db "DELETE FROM simulation_events; DELETE FROM simulation_runs; DELETE FROM events WHERE source='simulation'; DELETE FROM audit WHERE action='simulation';"
node scripts/simulate-first-run.ts

# 或 Web 面板：模拟开播 → 一键演练首播脚本
```
