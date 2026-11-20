# 快速开始（阶段 G · 本地模式）

> 目标硬件 RTX 4060 Ti 8GB；本机（无 NVIDIA GPU）可运行除真实推理/QLoRA 外的全部功能（dry-run 验证协议）。

## 1. 环境准备

```bash
pnpm install
pnpm test            # 插件契约测试
pnpm test:worker     # Python worker 11 例（dry-run，零依赖）
```

## 2. 首次自检

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

## 4. 直播面板

在 DSH 侧边栏打开「大肥鱼直播」。

1. **工作台**。完成角色配置后，在「主播互动」输入文字并发送。首次发送会进入本地预览，回复生成后默认按顺序朗读。回车发送，Shift+回车换行。使用麦克风转写需要浏览器支持中文离线语言包。
2. **开播和下播**。先完成角色授权与直播接入。点工作台的「开始直播」，在直播伴侣开播后回工作台点「我已在直播伴侣开播」。下播时先在直播伴侣结束推流，再点「确认已下播」。顶部的「紧急停止播出」会停止插件语音并切换到安全画面。外部推流请在直播伴侣停止。
3. **记录与学习**。可查看回复与反馈、礼物账本和观众画像。「训练」可运行训练演练及暂停或恢复学习，「治理与发布」可恢复稳定版本。训练演练用于检查流程，真实训练仍需在目标机验收。
4. **设置**。直接选择「角色与声音」「直播接入」「模型与云端」「数据用途」或「诊断」。在「诊断」可运行环境自检或导出脱敏报告。

### 抖音直播画面与音频

主播口型现在按音频播放时钟驱动；倾听时增加轻点头、眨眼和微动。重载插件后生效。横屏可在「直播画面 → 舞台设置」的右侧抽屉选择动态角色或本地原场景。原场景保留原片动作，只在播出语音时按当前帧的嘴部位置驱动口型。换角色后可选择该角色的原场景。详细能力与测量边界见 [表情与口型验收](avatar-motion-validation.md)。

1. 在 Mac 上打开插件的「直播画面 → 打开独立播出窗口」。在直播伴侣添加「程序窗口」，选择「大肥鱼直播画面」，将素材适配到所选的横屏或竖屏画布。独立窗口随舞台方向调整，窗口内只有播出画面，无需手动裁剪或安装 OBS。窗口尺寸会按显示器缩放，直播伴侣决定最终推流分辨率。
2. 点「启用播出声音」和「试播一句」，在伴侣音频表检查声音。可选 DSH 应用音频或匹配的输出设备。使用虚拟声卡时，在插件选对应输出、在伴侣选对应输入。只启用一条接收角色声音的音轨。
3. 在伴侣预览确认画面完整、声音正常后开播，回工作台确认。独立播出窗口可在插件切页时继续供采集。点击「暂停播出声音」可临时静音。紧急停止会中止声音并将独立窗口切换到安全画面，结束外部推流请在伴侣操作。用「关闭播出窗口」或在该窗口按 ⌘W 可关闭。
4. 截取角色画面时，保持直播画面所在窗口可见。若画面回退到静态素材、渲染停更，或插件连续两分钟没有播出评论或操作员回复，采集区上方会提醒操作员检查画面并确认主持状态。两分钟是插件提醒间隔。主持人离开时，可在直播伴侣切换现场画面或结束推流。

### 主播角色与 Live2D

在工作台「实时预览」选择 DSH 蓝发女仆、夏夏、沈露白、谷雨或贝拉。DSH 蓝发女仆使用 dsh-pet 的透明待机动画。四个鹅次元角色可用本地原片提取的图层做口型预览，开合由播放音频驱动。「设置 → 角色与声音」会显示各角色使用的渲染方式。夏夏的原画与三维骨骼共用一个角色及声线，可在「默认形象」切换。点「声音试听 → 试听互动声线」可试听角色声音。已有 `scene.mp4` 和 `mouth-track.json` 时，可运行 `node scripts/prepare-role-prototypes.mjs` 重新提取本地口型预览素材。已有立绘的 Mac 可运行 `node scripts/prepare-role-prototypes.mjs --motion-only`，在本机生成前景轮廓。

Apple Silicon Mac 可运行 `scripts/setup-role-voices.sh` 一次，安装本地运行时、模型及四段参考录音。默认用 Python 3.12，支持用 `DAFEIYU_VOICE_PYTHON` 指定解释器。合成在本机离线运行。参考录音旁如有同名 `.txt`，模型会用该录音的逐字稿辅助模仿语气。

如已在 Cubism 完成模型绑定并导出，把 `*.model3.json` 和配套文件放入对应目录，保持包内相对路径，然后在「设置 → 角色与声音」点「刷新模型」。待机视频可放为对应目录下的 `scene.mp4`，用于工作台预览。直播画面优先渲染 Live2D，其次使用口型原型。带前景轮廓的口型原型会渲染轻微呼吸。头部、头发和配饰同层转动，嘴部随语音更新，背景保持固定。更换或重新裁切立绘后需重新生成轮廓。旧素材仍可按已有轮廓渲染呼吸和口型。角色包可以在 `manifest.json` 加入 `"lipSync": { "ids": ["ParamMouthOpenY"], "closed": 0, "open": 0.85, "gain": 1.1, "threshold": 0.03 }`，参数须对应实际模型。默认使用模型 `LipSync` 配置或 `ParamMouthOpenY`，按模型范围缩放。角色设置显示模型和口型配置状态，安装后重新打开舞台。

| 角色 | 本地模型目录 |
| --- | --- |
| DSH 蓝发女仆 | `data/models/dsh-pet/` |
| 夏夏 | `data/models/eciyuan-xiaxia/` |
| 沈露白 | `data/models/eciyuan-lubai/` |
| 谷雨 | `data/models/eciyuan-guyu/` |
| 贝拉 | `data/models/eciyuan-beila/` |

### 回复模型与本地记忆

打开「设置 → 模型与云端 → 本地模型」，从 Qwen、DeepSeek、Llama、Gemma、Phi 和 Mistral 中选择所需规格。已安装的模型可直接切换。首次使用时点击「一键部署并启用」，面板会复用或安装 Ollama、下载所选模型、试生成一条中文回复，并在验证成功后自动启用。部署时可查看进度和日志。在仓库目录运行 `pnpm setup:ollama` 默认部署 `qwen3:4b`，可通过 `DAFEIYU_OLLAMA_MODEL` 指定其他模型标签。

Windows 10 22H2 或更新版本可使用面板完成部署。插件按宿主架构选择 x64 或 ARM64 官方压缩包，校验后解压到插件数据目录的 `ollama` 文件夹，无需管理员权限。安装时需要访问 GitHub。服务在后台运行，系统重启后可在面板再次部署以启动服务并复用已有模型。macOS 和 Linux 也可通过同一入口部署，Linux 需要支持 Zstandard 的 `tar` 和 `zstd`。

已有 ModelScope 映射的 Qwen3 规格默认直连。Lythri 与 Baby Boon 由 Ollama 从 Hugging Face 拉取 GGUF，其余文本模型预设通过 Ollama 官方仓库下载。可通过 `DAFEIYU_OLLAMA_SOURCE=registry` 让 Ollama 直接拉取所选标签，或通过 `DAFEIYU_MODELSCOPE_REPO` 和 `DAFEIYU_MODELSCOPE_FILE` 为默认模型指定 GGUF。仓库访问受限时，可配置代理的 HTTP 或混合端口，示例端口需替换为实际端口。[模型性能与优劣对比及 DuplexJev 配置](model-comparison.md)

```bash
DAFEIYU_OLLAMA_PROXY=http://127.0.0.1:7890 pnpm setup:ollama
```

Windows PowerShell 使用 `$env:DAFEIYU_OLLAMA_PROXY = 'http://127.0.0.1:7890'; pnpm setup:ollama`。未指定时读取 `HTTPS_PROXY` 或 `ALL_PROXY`，macOS 还会尝试读取系统 HTTP(S) 代理。只配置了 PAC、TUN 或 SOCKS 时，可用 `direct` 强制直连，或显式填写可用的 HTTP 代理。本机 API 始终直连。已运行的 Ollama 使用它启动时的代理，必要时退出该服务后重跑配置。安装包无法在线获取时，可用 `DAFEIYU_OLLAMA_ARCHIVE` 指向同一版本的官方归档，模型下载仍需要访问模型仓库。[Ollama 代理说明](https://docs.ollama.com/faq#how-do-i-use-ollama-behind-a-proxy) · [官方安装包](https://github.com/ollama/ollama/releases/tag/v0.40.16)

工作台默认使用 `http://127.0.0.1:11434` 与 `qwen3:4b`。如通过 `DAFEIYU_OLLAMA_URL` 或 `DAFEIYU_OLLAMA_MODEL` 自定义，请让宿主使用相同的设置。主播会结合角色、本场对话及命中的本地记忆生成回复。

操作员消息可使用云端兜底。在「设置 → 模型与云端」设置服务商、模型与预算；自定义 OpenAI 兼容网关（如腾讯 TokenHub：端点 `https://tokenhub.tencentmaas.com/v1`、模型 `hy4`）直接填「端点 URL」即可，无需环境变量。在同页「API Key」栏填写密钥后点「测试连接」（推理模型如 hy4 返回思考内容也算通过）（界面只回掩码；也可给宿主设置 `DAFEIYU_CLOUD_API_KEY`，环境变量优先），测试通过后「保存」才可点击，保存后即时生效、无需重载插件。同页「额度 / 可用余额」区块按已保存配置自动查询：DeepSeek 官方显示总余额/赠送/充值，OpenAI 兼容网关（one-api/new-api 系）显示总额度/本年已用/可用余额；未提供查询接口的服务商（如腾讯混元）会如实标注，额度以其控制台为准。模型暂不可用时，工作台会明确显示预设回复及原因。

### 直播互动接入

在「设置 → 直播接入」选择「后台读取抖音直播间」，保存完整的 `https://live.douyin.com/...` 地址。确认开播后，大肥鱼用后台静音 Chrome 读取该房间的评论、礼物、点赞、进房、关注、粉丝团和分享。工作台显示采集状态。抖音网页显示未开播或直播已结束时，插件会自动重试。若此时直播伴侣已在推流，请核对填入的房间链接。若抖音网页需要登录，可在「直播接入」改用已配置的互动转发源。

每场默认自动回复评论、欢迎进房和感谢礼物。工作台可分别调整自动回复类型，关闭自动回复后仍可点「让主播回复」。进房欢迎和礼物感谢使用角色专属话术，点赞等互动使用角色动作，这些事件无需调用模型。

普通对话优先走本地，复杂问题、本地答复未通过或操作员选择「深度回复」时，才按权限和预算使用云端。仅配置本地或云端时，使用可用的单一模型。需要云端回复观众弹幕时，在「模型与云端」勾选「允许发送公开弹幕给云端模型」，并在「数据用途」确认。每日请求上限默认 100 次。可选填服务商输入和输出单价，以估算费用。模型回复通过检查后，按播出队列朗读。

工作台支持直播中切换主播。同一观众的近期对话独立接续，称呼和互动偏好由各主播独立积累。「直播记忆」显示本场节目进度，操作员确认保留后，其他主播在后续场次也能按主题接续。「记录与学习 → 观众」可查看参与场次、近期话题和分主播的互动记忆，并处理纠正或退出个性化。

继续使用已有转发服务时，选择「已配置的互动转发源」，将读取地址 `DAFEIYU_DANMAKU_URL`、直播间 ID `DAFEIYU_DANMAKU_ROOM_ID` 与访问令牌 `DAFEIYU_DANMAKU_TOKEN` 设在宿主进程环境变量里，再重载插件。

转发服务需要提供 HTTPS 读取地址，也支持本机环回 HTTP。插件发送带 `roomId`、`since` 和可选 `cursor` 参数的 GET 请求，并在 `Authorization` 头中携带 Bearer 令牌。`since` 是本场互动开始的 ISO 8601 时间。服务按接收顺序返回最多 100 条，下一次请求携带上次返回的游标，空结果返回空数组。`nickname` 和用于延续同一人对话的伪名 `viewerId` 为可选字段。示例响应如下。

```json
{
  "cursor": "next-page",
  "messages": [{
    "id": "platform-event-123",
    "roomId": "room-123",
    "sentAt": "2026-11-16T02:30:00Z",
    "nickname": "小雨",
    "viewerId": "viewer-001",
    "text": "晚上好，今天聊什么？"
  }]
}
```

转发服务负责申请与验证上游授权，并把平台事件转换成这个格式。抖音开放平台的直播间评论能力适用于已挂载玩法和已获授权的评论事件。可用范围以实际权限为准。[抖音开放平台的评论能力说明](https://developer.open-douyin.com/docs/resource/zh-CN/interaction/jierushuoming/hudongshuju/pinglunshuju)

### Eciyuan 安装包分析

对 Windows 安装目录 `0.1.14.597` 与 `0.1.15.624` 做了静态检查。前者主要是 Qt 运行库。后者的 `Eciyuan.exe`、`FrameworkShaders/` 与 `webrtc_apm_bridge.dll` 提供了以下线索：

| 能力 | 安装包线索 | 本项目对应能力 |
| --- | --- | --- |
| 虚拟形象 | `EcyLive2DPet`、`.model3.json`、`live2d_url`、`prefetchLive2d` | 本地 Cubism 模型目录、待机动作、点击互动、加载失败时显示对应角色的口型预览或立绘 |
| 语音输入 | `audioInputs`、`voiceActivityStarted` / `voiceActivityStopped`、`voiceCallHotkeyTriggered`、WebRTC 音频处理桥 | 用户手动启动单次浏览器本地识别，可编辑转写后发送，也可直接输入文字 |
| 语音输出 | `auto_play_tts`、`AVTtsMarkedAudioPlayer`、`LipSync` | 本地音频输出、字幕、Live2D 音量口型与停止朗读 |

安装目录未发现独立的角色模型包或音色素材。上表依据文件名和二进制字符串，原客户端的服务端实现、语音识别模型和标记格式未验证。本项目的预览回复由现有 Ollama 路由生成，Live2D 使用自备模型或安装脚本提供的官方示例。

## 5. 宿主安装（DSH 插件）

构建产物 `pnpm build` → `lib/index.js`（宿主半经 `src/host-adapter.ts` define 接入）；安装：宿主内 `plugin_manager install_bundle <仓库目录>`（宿主安装流程自带确认步骤；Web UI 客户端半随安装启用）。

## 6. 目标机（实机验收）

安装 Ollama 并运行 `ollama pull qwen3:4b`。训练端运行 `pip install -e training-worker`，再按 [训练组件说明](../training-worker/README.md) 执行 QLoRA 窗口与实机验收（§20.2-D）。

## 配置备份与需求反馈

在「设置 → 配置备份」导出 JSON，迁移时选择文件、检查摘要并确认覆盖。仅恢复六类面板设置，不携带密钥、运行数据库、模型和角色素材。下播并退出预览后才能导入；恢复后重新确认授权、登录、数据用途，并测试云端连接。详见 [备份说明](../README.md#配置导入与导出)。

在「设置 → 支持与需求」打开需求墙、提交功能建议、查看赞助方式或英文说明。不要把 API Key 或原始配置备份提交到公开 Issues。
