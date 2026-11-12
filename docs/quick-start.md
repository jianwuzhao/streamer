# 快速开始（阶段 G · 本地模式）

> 目标硬件 RTX 4060 Ti 8GB；本机（无 NVIDIA GPU）可运行除真实推理/QLoRA 外的全部功能（dry-run 验证协议）。

## 1. 环境准备

```bash
pnpm install
pnpm test            # 139 项契约测试
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

## 4. 宿主安装（DSH 插件）

构建产物 `pnpm build` → `lib/index.js`（宿主半经 `src/host-adapter.ts` define 接入）；安装：宿主内 `plugin_manager install_bundle <仓库目录>`（需用户确认；Web UI 客户端半随安装启用）。

## 5. 目标机（实机验收）

安装 Ollama + `Qwen/Qwen3-4B-Instruct-2507` 量化产物；`pip install -e training-worker`；按 [training-worker/README](../training-worker/README.md) 执行 QLoRA 窗口与实机验收（§20.2-D）。
