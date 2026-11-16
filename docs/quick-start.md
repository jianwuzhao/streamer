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

1. **实时预览**。选择角色或形象即可查看效果，选择会自动保存。完成角色授权后，输入文字或用麦克风转写，点「发送」会自动开启本地对话。可开启「自动朗读」让系统音色朗读每条回复。中文语音转写依赖浏览器离线语言包。
2. **开播和下播**。首次使用先完成角色授权并在直播伴侣登录。在工作台点「开始直播」，等待平台时按提示在直播伴侣开播，再点「我已在直播伴侣开播」。下播时先在直播伴侣结束推流，再点「确认已下播」。底部「紧急停止播出」立即进入本地安全场景，外部推流在直播伴侣停止。
3. **学习**。工作台提供运行训练演练、暂停或恢复学习，以及恢复稳定版本。条件不足时会显示原因。训练演练用于检查流程，真实训练仍需在目标机验收。
4. **管理**。配置、训练记录、互动与账本、观众、治理和诊断归在「管理」。五步配置依次涵盖环境自检、直播接入、角色与声音、模型与云端、运行与数据用途。

### 鹅次元角色预览

在工作台「实时预览」的「角色」下拉框中选夏夏、沈露白、谷雨或贝拉。每个角色优先展示已安装的本地 Live2D 或动态视频。视频静音循环，失败时显示[鹅次元官网立绘](https://eciyuan.qq.com/)。点「试听互动声线」可听到与新回复相同的声音。「官方录音（原声参考）」直接播放官网样本。安装本地参考语音后，工作台会预热 Qwen3-TTS。开启「自动朗读」后，回复文本就绪即开始语音合成，首批音频可播放时立即播报，后续音频继续生成。口型根据实际播放的音频变化。未安装参考音色时，界面会标明正在使用系统音色。

Apple Silicon Mac 可运行 `scripts/setup-role-voices.sh` 一次，安装本地运行时、模型及四段参考录音。默认用 Python 3.12，支持用 `DAFEIYU_VOICE_PYTHON` 指定解释器。合成在本机离线运行。参考录音旁如有同名 `.txt`，模型会用该录音的逐字稿辅助模仿语气。

如已有角色的 Live2D 模型包，把 `*.model3.json` 和配套文件放入对应目录，保持包内相对路径，然后点「刷新模型」。主界面视频可放为对应目录下的 `scene.mp4`。本机夏夏使用从虚拟机缓存确认的聊天主界面视频，其他三位使用官网角色动态片段。桌宠缓存的模型和聊天主界面素材是两套资源。对应视频旁的 `mouth-track.json` 记录嘴部位置，播放时根据生成语音的波形近似调整视频口型。更换视频后需替换对应的跟踪文件。Live2D 则直接驱动模型的嘴部参数。

| 角色 | 本地模型目录 |
| --- | --- |
| 夏夏 | `data/models/eciyuan-xiaxia/` |
| 沈露白 | `data/models/eciyuan-lubai/` |
| 谷雨 | `data/models/eciyuan-guyu/` |
| 贝拉 | `data/models/eciyuan-beila/` |

### Eciyuan 安装包分析

对 Windows 安装目录 `0.1.14.597` 与 `0.1.15.624` 做了静态检查。前者主要是 Qt 运行库。后者的 `Eciyuan.exe`、`FrameworkShaders/` 与 `webrtc_apm_bridge.dll` 提供了以下线索：

| 能力 | 安装包线索 | 本项目对应能力 |
| --- | --- | --- |
| 虚拟形象 | `EcyLive2DPet`、`.model3.json`、`live2d_url`、`prefetchLive2d` | 本地 Cubism 模型目录、待机动作、点击互动、失败时显示内置大肥鱼 |
| 语音输入 | `audioInputs`、`voiceActivityStarted` / `voiceActivityStopped`、`voiceCallHotkeyTriggered`、WebRTC 音频处理桥 | 用户手动启动单次浏览器本地识别，可编辑转写后发送，也可直接输入文字 |
| 语音输出 | `auto_play_tts`、`AVTtsMarkedAudioPlayer`、`LipSync` | 浏览器本地中文语音朗读、字幕与估算口型，可停止朗读 |

安装目录未发现独立的角色模型包或音色素材。上表依据文件名和二进制字符串，原客户端的服务端实现、语音识别模型和标记格式未验证。本项目的预览回复由现有 Ollama 路由生成，Live2D 使用自备模型或安装脚本提供的官方示例。

## 5. 宿主安装（DSH 插件）

构建产物 `pnpm build` → `lib/index.js`（宿主半经 `src/host-adapter.ts` define 接入）；安装：宿主内 `plugin_manager install_bundle <仓库目录>`（需用户确认；Web UI 客户端半随安装启用）。

## 6. 目标机（实机验收）

安装 Ollama + `Qwen/Qwen3-4B-Instruct-2507` 量化产物；`pip install -e training-worker`；按 [training-worker/README](../training-worker/README.md) 执行 QLoRA 窗口与实机验收（§20.2-D）。
