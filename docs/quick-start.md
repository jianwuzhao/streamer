# 快速开始（阶段 G · 本地模式）

> 目标硬件 RTX 4060 Ti 8GB；本机（无 NVIDIA GPU）可运行除真实推理/QLoRA 外的全部功能（dry-run 验证协议）。

## 1. 环境准备

```bash
pnpm install
pnpm test            # 插件契约测试
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

## 4. 工作台和管理

打开 DSH 侧边栏的「大肥鱼直播」。工作台常显实时预览、直播操作、学习状态、待处理问题与当日费用。

1. **主播互动**。完成角色配置后，在工作台输入文字并发送。首次发送会进入本地预览，开播确认后仍可发消息。问题立即显示在互动列表与舞台上，回复生成后默认按顺序朗读。回车发送，Shift+回车换行。中文语音转写依赖浏览器离线语言包。
2. **开播和下播**。首次使用先完成角色授权并在直播伴侣登录。在工作台点「开始直播」，等待平台时按提示在直播伴侣开播，再点「我已在直播伴侣开播」。下播时先在直播伴侣结束推流，再点「确认已下播」。底部「紧急停止播出」立即进入本地安全场景，外部推流在直播伴侣停止。
3. **学习**。工作台提供运行训练演练、暂停或恢复学习，以及恢复稳定版本。条件不足时会显示原因。训练演练用于检查流程，真实训练仍需在目标机验收。
4. **管理**。配置、训练记录、互动与账本、观众、治理和诊断归在「管理」。五步配置依次涵盖环境自检、直播接入、角色与声音、模型与云端、运行与数据用途。

### 鹅次元角色预览

在工作台「实时预览」选择夏夏、沈露白、谷雨或贝拉。有对应 Live2D 模型的角色会按实际播放的音频驱动嘴部参数。只有预录视频的角色在待机时循环视频，回复时切到角色立绘，显示字幕与音量条。点「声音试听 → 试听互动声线」可试听回复所用的本地声音。参考音色可用时通过 Qwen3-TTS 播放分块音频。系统音色或浏览器朗读的来源也会在界面显示。

Apple Silicon Mac 可运行 `scripts/setup-role-voices.sh` 一次，安装本地运行时、模型及四段参考录音。默认用 Python 3.12，支持用 `DAFEIYU_VOICE_PYTHON` 指定解释器。合成在本机离线运行。参考录音旁如有同名 `.txt`，模型会用该录音的逐字稿辅助模仿语气。

如已有角色的 Live2D 模型包，把 `*.model3.json` 和配套文件放入对应目录，保持包内相对路径，然后点「刷新模型」。待机视频可放为对应目录下的 `scene.mp4`。

| 角色 | 本地模型目录 |
| --- | --- |
| 夏夏 | `data/models/eciyuan-xiaxia/` |
| 沈露白 | `data/models/eciyuan-lubai/` |
| 谷雨 | `data/models/eciyuan-guyu/` |
| 贝拉 | `data/models/eciyuan-beila/` |

### 回复模型与本地记忆

在仓库目录运行 `pnpm setup:ollama`，或在面板「管理 → 模型与云端」点「一键安装」。配置会复用已运行的服务或已安装的 Ollama，必要时下载并校验官方安装包，然后启动本机服务、下载 `qwen3:4b` 权重并导入、试生成一条中文回复。模型权重默认经 [ModelScope](https://modelscope.cn) 国内镜像直连（约 2.5 GB，无需代理、支持断点续传）；未安装时面板会给出提示并可一键安装，安装全程显示百分比进度与进程输出。支持 macOS、Linux 和 Windows 的 x64、ARM64，Linux 解包需要支持 Zstandard 的 `tar` 和 `zstd`。脚本安装的程序位于数据目录下的 `ollama` 文件夹。脚本启动的服务在当前登录会话后台运行，重启后可再次运行命令。

模型权重走 ModelScope 直连，不需要代理；仅 Ollama 安装包仍从 GitHub 下载，国内网络可用以下方式指定 Clash 等代理的 HTTP 或混合端口（示例端口需换成自己的实际端口）。也可用 `DAFEIYU_OLLAMA_SOURCE=registry` 把模型下载切回 Ollama 官方仓库（同样需要代理），或用 `DAFEIYU_MODELSCOPE_REPO` / `DAFEIYU_MODELSCOPE_FILE` 指定其它 ModelScope GGUF。

```bash
DAFEIYU_OLLAMA_PROXY=http://127.0.0.1:7890 pnpm setup:ollama
```

Windows PowerShell 使用 `$env:DAFEIYU_OLLAMA_PROXY = 'http://127.0.0.1:7890'; pnpm setup:ollama`。未指定时读取 `HTTPS_PROXY` 或 `ALL_PROXY`，macOS 还会尝试读取系统 HTTP(S) 代理。只配置了 PAC、TUN 或 SOCKS 时，可用 `direct` 强制直连，或显式填写可用的 HTTP 代理。本机 API 始终直连。已运行的 Ollama 使用它启动时的代理，必要时退出该服务后重跑配置。安装包无法在线获取时，可用 `DAFEIYU_OLLAMA_ARCHIVE` 指向同一版本的官方归档，模型下载仍需要访问模型仓库。[Ollama 代理说明](https://docs.ollama.com/faq#how-do-i-use-ollama-behind-a-proxy) · [官方安装包](https://github.com/ollama/ollama/releases/tag/v0.40.16)

工作台默认使用 `http://127.0.0.1:11434` 与 `qwen3:4b`。如通过 `DAFEIYU_OLLAMA_URL` 或 `DAFEIYU_OLLAMA_MODEL` 自定义，请让宿主使用相同的设置。主播会结合角色、本场对话及命中的本地记忆生成回复。

操作员消息可使用云端兜底。在「管理 → 模型与云端」设置服务商、模型与预算；自定义 OpenAI 兼容网关（如腾讯 TokenHub：端点 `https://tokenhub.tencentmaas.com/v1`、模型 `hy4`）直接填「端点 URL」即可，无需环境变量。在同页「API Key」栏填写密钥后点「测试连接」（推理模型如 hy4 返回思考内容也算通过）（界面只回掩码；也可给宿主设置 `DAFEIYU_CLOUD_API_KEY`，环境变量优先），测试通过后「保存」才可点击，保存后即时生效、无需重载插件。同页「额度 / 可用余额」区块按已保存配置自动查询：DeepSeek 官方显示总余额/赠送/充值，OpenAI 兼容网关（one-api/new-api 系）显示总额度/本年已用/可用余额；未提供查询接口的服务商（如腾讯混元）会如实标注，额度以其控制台为准。直播观众的消息在本机处理。模型暂不可用时，工作台会明确显示预设回复及原因。

### 直播弹幕接入

将已授权弹幕转发服务的读取地址 `DAFEIYU_DANMAKU_URL`、直播间 ID `DAFEIYU_DANMAKU_ROOM_ID` 与其访问令牌 `DAFEIYU_DANMAKU_TOKEN` 设在宿主进程的环境变量里，再重载插件。确认开播后，工作台显示弹幕源状态。弹幕收到后显示在列表与舞台，可以按条点击「让主播回复」，也可开启「自动回复弹幕」。工作台负责语音输出，推流仍由直播伴侣负责。

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
| 虚拟形象 | `EcyLive2DPet`、`.model3.json`、`live2d_url`、`prefetchLive2d` | 本地 Cubism 模型目录、待机动作、点击互动、失败时显示内置大肥鱼 |
| 语音输入 | `audioInputs`、`voiceActivityStarted` / `voiceActivityStopped`、`voiceCallHotkeyTriggered`、WebRTC 音频处理桥 | 用户手动启动单次浏览器本地识别，可编辑转写后发送，也可直接输入文字 |
| 语音输出 | `auto_play_tts`、`AVTtsMarkedAudioPlayer`、`LipSync` | 本地音频输出、字幕、Live2D 音量口型与停止朗读 |

安装目录未发现独立的角色模型包或音色素材。上表依据文件名和二进制字符串，原客户端的服务端实现、语音识别模型和标记格式未验证。本项目的预览回复由现有 Ollama 路由生成，Live2D 使用自备模型或安装脚本提供的官方示例。

## 5. 宿主安装（DSH 插件）

构建产物 `pnpm build` → `lib/index.js`（宿主半经 `src/host-adapter.ts` define 接入）；安装：宿主内 `plugin_manager install_bundle <仓库目录>`（需用户确认；Web UI 客户端半随安装启用）。

## 6. 目标机（实机验收）

安装 Ollama 并运行 `ollama pull qwen3:4b`。训练端运行 `pip install -e training-worker`，再按 [训练组件说明](../training-worker/README.md) 执行 QLoRA 窗口与实机验收（§20.2-D）。
