# dsh-dafeiyu-evolve — 大肥鱼自学习直播插件

基于 [DSH 大肥鱼自学习直播全量实现方案 v4.0](DSH大肥鱼自学习直播方案_分析与优化.md) 的逐步实现。

- **目标硬件**：RTX 4060 Ti 8GB 显存 / 32GB 内存（Windows/Linux 实机，参数待实机校准）
- **开发环境**：macOS（Apple M1 Pro）/ Node ≥ 22.13 / pnpm —— GPU 相关功能以适配器接口 + mock 契约测试交付，实机验收在目标机执行
- **宿主兼容**：DeepSeek Harness `0.2.2-rc.1`（Electron Node 24，内嵌 `node:sqlite`，零原生编译依赖）
- **许可证**：待定（正式发布前补齐）

## 版本记录

| 版本 | 日期 | 说明 |
| --- | --- | --- |
| 0.1.0 | 2026-11-11 | 阶段 A（基础与资源）：插件骨架、统一配置、SQLite 存储基座、感知/黑板、本地优先路由、模型适配器、资源仲裁、政策授权骨架；70 项测试 |

## 当前状态（阶段 A 已完成）

按方案 §20.1 的 A–G 七阶段逐步交付。**当前完成阶段 A（基础与资源）**：

| 模块 | 状态 | 说明 |
| --- | --- | --- |
| 统一配置（§18 全量 schema） | ✅ | `config/default.yaml` + zod 校验；null 预算 ⇒ 付费能力禁用并报明确原因 |
| 存储基座（§16） | ✅ | `node:sqlite` + WAL + 版本化迁移 + 事务 outbox（幂等键/对账）+ 原子产物发布 |
| 感知事件（§2.4） | ✅ | `LiveEnvelope` 规范化、双键去重、接收游标 + 有界迟到窗口 |
| 黑板（§2.4） | ✅ | Session 投影、revision CAS、TTL 过期过滤、场次隔离 |
| 本地优先路由（§4） | ✅ | 九原因码、共享预算（12s/5s/1.5s）、本地 GPU→CPU→云端一次、schema 修复一次、`POLICY_BLOCKED` 硬阻断、固定降级回复、`request_id+generation_epoch` 播出去重、迟到候选丢弃 |
| 模型适配器（§3.1/§4.3） | ✅ | Ollama（超时/不可达映射原因码、能力探测）、OpenAI 兼容云端（预算硬闸门）、固定降级模板 |
| 资源仲裁（§3.2） | ✅ | 1s 采样环、优先级排序、训练准入 `free_vram ≥ peak + reserve`（探测不可用 fail-safe） |
| 政策授权骨架（§11.1） | ✅ | PolicyDecision 签发/校验、payloadHash 绑定、治理 epoch、TTL、fail-closed |
| LearningRuntime | ✅ 阶段 A 范围 | `ingest`/`answer` 全链路；其余接口显式 `NotImplementedError`（B–E 阶段实现） |

**未完成（后续阶段）**：B 数据层（L2/L4、画像、技能库）→ C 检索 → D 训练（Python worker）→ E 发布/固化 → F 产品入口（Web UI、抖音规则包）→ G 整体验收。

## 开发

```bash
pnpm install
pnpm test        # 70 个单元/契约测试（node:test，零额外依赖）
pnpm typecheck   # tsc --noEmit（strict + exactOptionalPropertyTypes）
pnpm build       # tsdown → lib/index.js（ESM，宿主插件规范）
```

插件入口：`createPlugin({ configPath?, dataDir?, log? })` → `{ runtime, blackboard, arbiter, policy, dispose() }`（cordis 风格别名 `activate`）。阶段 A 不 import 宿主专属包，宿主事件接线（`agent/pre-step` waterfall、`session/event` 等）在后续阶段接入。

## 目录

```text
config/default.yaml        # §18 配置草案初值（mode: shadow）
src/
  index.ts / runtime.ts    # 插件入口 / LearningRuntime（阶段 A：ingest+answer）
  config.ts / types.ts     # zod 配置 schema / §17 领域契约
  storage/                 # db、migrations、outbox、publish
  perception/              # envelope、dedup（去重+迟到窗口）
  blackboard/              # Session 工作记忆（CAS+TTL）
  routing/                 # 预算、质量门、本地优先路由器
  adapters/                # model-adapter、ollama、cloud、fallback
  resources/               # probe（nvidia-smi）、arbiter
  governance/              # policy-decision（授权骨架）
  testing/                 # 测试公共设施
training-worker/           # 阶段 D：Python 训练进程（占位）
docs/                      # §25 文档集（随阶段补齐）
evals/ skill-packages/ policy-packs/ installer/   # 后续阶段
```

## 关键运行语义（已实现并测试）

- 常规请求先本地；所有跳过/升级均记录原因码，usage 表留痕
- 每逻辑请求最多一次第三方生成、一次本地 schema 修复；云端未配置/预算 null/耗尽 ⇒ 不发起付费调用
- 政策阻断（人设硬边界）不以任何模型绕过，直接固定降级回复
- 迟到的本地/云端结果按 generation_epoch 丢弃，同一回复只播一次
- 事件按 `(source, source_event_id)` 去重；迟到窗口外只记录不处理
- 启动恢复：遗留 pending 写操作转 `reconcile_required`，不盲写

## 环境变量

| 变量 | 作用 | 默认 |
| --- | --- | --- |
| `DAFEIYU_DATA_DIR` | 数据目录（SQLite） | `./data` |
| `DAFEIYU_OLLAMA_URL` | GPU 本地推理端点 | `http://127.0.0.1:11434` |
| `DAFEIYU_OLLAMA_CPU_URL` | CPU 接答实例端点（训练窗口） | 同上 |
| `DAFEIYU_CLOUD_BASE_URL` / `DAFEIYU_CLOUD_API_KEY` | 第三方端点/密钥（仅引用，不入库） | 未设置 ⇒ 云端禁用 |
| `DAFEIYU_PROBE` | 资源探测：`auto`（nvidia-smi）/ `ram-only` | `auto` |

> 本仓库当前为阶段 A 交付，不代表插件已安装、平台权限已取得、在线训练已验证或一键开播可用；这些按方案 §20 在后续阶段与实机证据一并交付。
