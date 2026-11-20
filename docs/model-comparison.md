# 本地模型性能与优劣对比

在「设置 → 模型与云端 → 本地模型」展开「模型性能与优劣」，可查看同一份对比。以下尺寸来自 Ollama 仓库或模型发布者，代表权重下载量。实际内存、显存和响应速度取决于量化版本、上下文和硬件。Lythri、Baby Boon 与 DuplexJev 的分数或速度来自发布者在各自条件下的测试，大肥鱼未使用统一环境复测，不宜横向排名。

## 文本回复模型

已有模型可直接切换。首次部署时，原有 Qwen3 预设优先走 ModelScope；Lythri 与 Baby Boon 由 Ollama 从 Hugging Face 拉取 GGUF；其他预设使用 Ollama 官方仓库。Lythri 基于 Gemma 4，需要支持该架构的 Ollama。Baby Boon 的 30 tok/s 来自作者对 v12 的测试，其当前模型权重接入只使用文本回复。

| 模型 | 性能参考 | 核心优势 | 主要局限 |
| --- | --- | --- | --- |
| [Qwen3 0.6B](https://ollama.com/library/qwen3:0.6b) | 约 523 MB（Ollama 仓库） | 中文短问候，下载开销小 | 复杂问题和长对话容易丢失细节 |
| [Qwen3 1.7B](https://ollama.com/library/qwen3:1.7b) | 约 1.4 GB（Ollama 仓库） | 适合低资源中文短回复 | 多条件指令能力低于同系列大规格 |
| [Qwen3 4B](https://ollama.com/library/qwen3:4b) | 约 2.5 GB（Ollama 仓库） | 中文弹幕、角色扮演与多轮对话 | 比 1.7B 占用更多内存 |
| [Qwen3 8B](https://ollama.com/library/qwen3:8b) | 约 5.2 GB（Ollama 仓库） | 适合更复杂的多轮对话与角色设定 | 会比小规格占用更多内存，低配机器首次响应较慢 |
| [Qwen2.5 0.5B](https://ollama.com/library/qwen2.5:0.5b) | 约 398 MB（Ollama 仓库） | 适合资源紧张时的简单中文回复 | 长上下文和复杂指令能力有限 |
| [Qwen2.5 3B](https://ollama.com/library/qwen2.5:3b) | 约 1.9 GB（Ollama 仓库） | 中文问答与短摘要，资源开销居中 | 复杂推理优先考虑更大规格 |
| [Qwen2.5 7B](https://ollama.com/library/qwen2.5:7b) | 约 4.7 GB（Ollama 仓库） | 中文指令、多轮问答与结构化文本 | 下载和驻留开销大于 3B |
| [DeepSeek-R1 1.5B](https://ollama.com/library/deepseek-r1:1.5b) | 约 1.1 GB（Ollama 仓库） | 适合低资源的简单逻辑问答 | 小规格的复杂推理能力有限 |
| [DeepSeek-R1 7B](https://ollama.com/library/deepseek-r1:7b) | 约 4.7 GB（Ollama 仓库） | 适合数学、逻辑类弹幕 | 推理过程耗时，直播短回复需留意时限 |
| [DeepSeek-R1 8B](https://ollama.com/library/deepseek-r1:8b) | 约 5.2 GB（Ollama 仓库） | 适合较复杂的数学与代码问答 | 内存和推理开销偏高 |
| [Llama 3.2 1B](https://ollama.com/library/llama3.2:1b) | 约 1.3 GB（Ollama 仓库） | 适合轻量英文对话与简单归纳 | 中文并非官方列出的重点支持语言 |
| [Llama 3.2 3B](https://ollama.com/library/llama3.2:3b) | 约 2.0 GB（Ollama 仓库） | 英文对话、摘要与信息提取 | 复杂任务和中文直播需试跑 |
| [Llama 3.1 8B](https://ollama.com/library/llama3.1:8b) | 约 4.9 GB（Ollama 仓库） | 多轮对话、摘要与长文本 | 内存开销较高，中文需实测 |
| [Gemma 3 270M](https://ollama.com/library/gemma3:270m) | 约 292 MB（Ollama 仓库） | 适合固定格式和极短提示 | 开放式问答能力有限 |
| [Gemma 3 1B](https://ollama.com/library/gemma3:1b) | 约 806 MB（Ollama 仓库） | 适合轻量短答和简单分类 | 复杂指令及长对话能力有限 |
| [Gemma 3 4B](https://ollama.com/library/gemma3:4b) | 约 3.4 GB（Ollama 仓库） | 适合多语言问答与摘要 | 大肥鱼当前仅使用文本输入 |
| [Phi-4 Mini 3.8B](https://ollama.com/library/phi4-mini:3.8b) | 约 2.5 GB（Ollama 仓库） | 适合数学、逻辑与简短指令 | 中文角色口吻建议先预览检查 |
| [Mistral 7B](https://ollama.com/library/mistral:7b) | 约 4.4 GB（Ollama 仓库） | 适合通用对话与文本整理 | 中文直播体验需实测 |
| [Lythri 4B-A2B](https://huggingface.co/Lythri/Lythri-4B-A2B) | 4.63B 总参数 / 2.3B 活跃；MMLU 55.23，GSM8K 28.81 | 偏向自然对话与情绪理解，系列内资源开销较低 | 数学和指令遵循较弱，作者未将其定位为医疗或危机工具 |
| [Lythri 7B-A4B](https://huggingface.co/Lythri/Lythri-7B-A4B) | 7.46B 总参数 / 4.5B 活跃；MMLU 69.09，GSM8K 62.02 | 偏向情绪对话，知识与数学成绩高于同系列 4B | 内存开销更高，作者报告的 IFEval 为 31.05 |
| [Baby Boon 1.7B](https://pypi.org/project/baby-boon/) | 约 1.1 GB；作者测得约 30 tok/s（v12，Ryzen 9 9900X） | 面向英语社交闲聊，小模型可用 CPU | 主要面向英语。Ollama 权重接入未包含作者客户端的语气与表情解析及防护；勿用于医疗、急救或危机应答 |

## DuplexJev 语音判定

DuplexJev 的输入为原始音频，可判断讲话是否结束。它通过独立的 DuplexJev 网关接入，直播文字仍由上方选择的 Ollama 模型处理。以下数据来自发布方，误截断率越低越好。公开权重为 CC BY-NC 4.0，商业用途须取得授权。

| 模型 | 性能参考 | 核心优势 | 主要局限 |
| --- | --- | --- | --- |
| [DuplexJev-4B-Para](https://github.com/adventists-ai/duplexjev#models) | v1.4，约 10 GB 显存；Smart Turn 92.9，英语 300 ms 误截断率 21.8% | 适合语轮、重音与非语言声音判定 | 需要独立语音服务；公开权重仅限非商业用途 |
| [DuplexJev-32B-Para](https://github.com/adventists-ai/duplexjev#models) | v1.5，80 GB 显存；Smart Turn 94.4，英语 300 ms 误截断率 17.7% | 比 4B 更适合多语言语轮判定 | 显存需求最高；公开权重仅限非商业用途 |
| [DuplexJev-4B-Para-LiveTurn](https://github.com/adventists-ai/duplexjev#models) | 约 10 GB 显存；300 ms 误截断率英语 25.5%、中文 38.8% | 专注直播语音轮次结束判定 | 用途较专一；公开权重仅限非商业用途 |
| [DuplexJev-32B-Vision](https://github.com/adventists-ai/duplexjev#models) | 预览版，80 GB 显存；作者报告人脸与语音情绪匹配 93.5 | 可结合图片与语音进行判断 | 本面板测试仅传 WAV 音频；公开权重仅限非商业用途 |

### 连接本机网关

在支持 vLLM 和对应 GPU 的环境下，按发布方的安装说明启动一个 DuplexJev 模型及其网关。以下以 4B-Para 为例。Windows 可在配置 GPU 支持的 WSL 2 内运行 Linux 版 vLLM，并确认 Windows 宿主能通过本机端口访问网关。

```text
vllm serve adventists-ai/DuplexJev-4B-Para --host 127.0.0.1 --max-model-len 4096 --port 8000
duplexjev gateway --vllm http://127.0.0.1:8000/v1 --port 8020
```

分别在两个终端启动上述服务。大肥鱼默认连接 `http://127.0.0.1:8020`。如需更改本机端口，在启动宿主前设置 `DAFEIYU_DUPLEXJEV_URL`。在模型设置中展开「DuplexJev 语音判定」，选择语言和不超过 1 MiB 的 WAV 文件，再点击「测试语轮」。测试显示服务报告的模型、判断结果和置信度。切换 DuplexJev 版本时，在 vLLM 服务端更换模型。测试为手动上传，音频走本机回环接口。

[DuplexJev 安装与运行说明](https://github.com/adventists-ai/duplexjev#quick-start) · [网关接口](https://github.com/adventists-ai/duplexjev/blob/main/duplexjev/gateway.py)
