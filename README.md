# dsh-dafeiyu-evolve — 大肥鱼自学习直播插件

基于 [DSH 大肥鱼自学习直播全量实现方案 v4.0](DSH大肥鱼自学习直播方案_分析与优化.md) 的逐步实现。

- **目标硬件**：RTX 4060 Ti 8GB 显存 / 32GB 内存（Windows/Linux 实机，参数待实机校准）
- **开发环境**：macOS（Apple M1 Pro）/ Node ≥ 22.13 / pnpm —— GPU 相关功能以适配器接口 + mock 契约测试交付，实机验收在目标机执行
- **宿主兼容**：DeepSeek Harness `0.2.2-rc.1`（Electron Node 24，内嵌 `node:sqlite`，零原生编译依赖）
- **许可证**：待定（正式发布前补齐）

## 版本记录

| 版本 | 日期 | 说明 |
| --- | --- | --- |
| 0.6.0 | 2026-11-11 | 阶段 F（产品入口核心）：直播会话状态机（未配置→…→已结束；平台未确认绝不显示直播中；幂等开播；紧急停止≠暂停学习）、开播自检（单一可操作原因、AI 标识不可关闭、缺规则包 fail-closed）、抖音政策包（四来源钉住）、PlatformAdapter 契约（辅助模式默认、能力如实申报）、一键训练入口（暂停学习/训练完成≠发布）；TS 137 例 |
| 0.5.0 | 2026-11-11 | 阶段 E（自动发布与固化）：统一验证器（七道门→结构化报告，inconclusive 不放行）、联合发布控制器（candidate→staged→canary→active 状态链、灰度 5→20→50→100 每阶段≥2 场次、每日一次晋级、epoch 回滚）、自动固化（条件门→learned_stable L1/L3、去重键、反例撤回、注入过滤、30 天复核）；runtime 四接口实装；TS 132 例 |
| 0.4.0 | 2026-11-11 | 阶段 D（训练）：训练样本管道（用途过滤/脱敏/去重簇/heldout 隔离/30-70 回放配比）、训练窗口调度器（样本/资源/政策三门、champion 不动、断点续跑）、Python worker（分时状态机/检查点/授权协议/QLoRA 依赖守卫/GGUF 导出守卫）；TS 123 例 + Python 11 例 |
| 0.3.0 | 2026-11-11 | 阶段 C（检索优化）：BM25/向量/图谱三路召回、RRF 融合与重排、实时复检、token 预算截断、索引 generation 迁移与墓碑即时过滤、向量路降级、评测与消融（Recall@5/nDCG@5/延迟分位）；`runtime.retrieve` 实装；累计 115 项测试 |
| 0.2.0 | 2026-11-11 | 阶段 B（完整数据层）：L2/L4 记忆生命周期与矛盾处理、全量观众画像（伪名化身份/字段版本链/删除墓碑）、技能库（manifest/受控执行/示例技能包）、反馈状态机、礼物幂等账本与合并答谢；累计 103 项测试 |
| 0.1.0 | 2026-11-11 | 阶段 A（基础与资源）：插件骨架、统一配置、SQLite 存储基座、感知/黑板、本地优先路由、模型适配器、资源仲裁、政策授权骨架；70 项测试 |

## 当前状态（阶段 A–F 已完成）

按方案 §20.1 的 A–G 七阶段逐步交付。**当前完成阶段 A–F**（F 为产品入口核心：状态机/政策包/适配契约已就绪，**Web UI 客户端半随宿主接入在 G 阶段安装时启用**）：

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
| L2/L4 记忆（§5） | ✅ | 独立证据判定（同簇/同账号/同源派生不计数）、生命周期 proposed→active→challenged/superseded、查询时过期、修订血缘保留、保守矛盾检测（双方 challenged 不呈现为事实） |
| 全量观众画像（§6） | ✅ | HMAC 伪名化身份键（昵称变化不换身份/跨平台不合并）、字段版本链（value/来源/置信/用途/TTL）、可重放聚合、观众纠错覆盖推测、删除墓碑+传播状态（未建成系统如实标注）、画像隔离读取、退出个性化 |
| 技能库（§7） | ✅ | manifest zod 校验、版本不可覆盖、生命周期逐级推进、权限扩张拒晋级、受控执行（active 实时检查/权限/schema/幂等/后置条件/技能 fallback）、包目录加载与播种（示例 `skill-packages/gift-ack-phrase`） |
| 反馈（§10.1） | ✅ | 归因记录（无目标→片段级）、received→verifying→resolved/insufficient_evidence 状态机、隐私投诉立即升级、按回复定位 |
| 礼物账本与答谢（§10.2） | ✅ | (platform,event_id) 幂等、连击按累计数算增量（重复/乱序不重复累加）、退款抵消记录不删历史、未验证如实标记、合并答谢（30s/10s/6s、危险昵称不点名、本地模板不调模型） |
| 三路检索（§8） | ✅ | BM25（中文 bigram）+ 向量（目标机 Qwen3-Embedding-0.6B via Ollama；测试桩语义映射）+ 图谱（逐跳作用域校验/2 跳/50 节点/高出度截断）；RRF 融合、证据质量与多样性重排、实时复检（challenged/过期/撤销不注入）、记忆 top-3 + 技能 top-2 + token 预算截断；索引 outbox 幂等消费、generation 迁移（building→active 原子切换）、墓碑即时过滤、向量路损坏降级词法并显式标记；评测 harness（Recall@5/nDCG@5/p50/p95）与三路消融 |
| LearningRuntime | ✅ A+B+C 范围 | `ingest`/`answer`/`updateProfile`/`proposeCognition`/`retrieve` 实装；D/E 接口显式 `NotImplementedError` |

**未完成（后续阶段）**：G 整体验收（Web UI 客户端半接入宿主、安装器与首次配置向导、continual-harness/live-studio 实适配、故障注入与长稳、诊断导出）。

## 开发

```bash
pnpm install
pnpm test        # 137 个单元/契约测试（node:test）
pnpm test:worker # Python worker 11 例（unittest，纯标准库）
pnpm typecheck   # tsc --noEmit（strict + exactOptionalPropertyTypes）
pnpm build       # tsdown → lib/index.js（ESM，宿主插件规范）
```

插件入口：`createPlugin({ configPath?, dataDir?, log? })` → `{ runtime, blackboard, arbiter, policy, dispose() }`（cordis 风格别名 `activate`）。阶段 A 不 import 宿主专属包，宿主事件接线（`agent/pre-step` waterfall、`session/event` 等）在后续阶段接入。

## 目录

```text
config/default.yaml        # §18 配置草案初值（mode: shadow）
src/
  index.ts / runtime.ts    # 插件入口 / LearningRuntime（A：ingest+answer；B：画像+认知候选；C：retrieve）
  config.ts / types.ts     # zod 配置 schema / §17 领域契约
  storage/                 # db、migrations（001–005）、outbox、publish
  perception/              # envelope、dedup（去重+迟到窗口）
  blackboard/              # Session 工作记忆（CAS+TTL）
  routing/                 # 预算、质量门、本地优先路由器
  adapters/                # model-adapter、ollama、cloud、fallback
  resources/               # probe（nvidia-smi）、arbiter
  governance/              # policy-decision、verifier（七道门）、release（联合发布/灰度/回滚）、consolidation（learned_stable）
  memory/                  # L2/L4 生命周期、独立证据、矛盾检测
  audience/                # 伪名化身份、字段版本链、删除墓碑
  skills/                  # 注册表、受控执行器、包加载、schema 校验
  feedback/                # 反馈归因与纠错状态机
  gifts/                   # 幂等账本（连击/退款）、合并答谢
  retrieval/               # BM25、embedding、向量库、图谱、索引器、三路融合、评测
  training/                # 样本管道、训练窗口调度器、Python worker 启动器（另见 training-worker/）
  platform/                # PlatformAdapter 契约（辅助模式）、抖音政策包加载校验
  live/                    # 直播会话状态机、一键训练入口（四主操作核心）
  testing/                 # 测试公共设施
skill-packages/            # 技能包目录（示例：gift-ack-phrase）
training-worker/           # Python 训练进程：分时状态机/检查点/QLoRA（dry-run 零依赖）
docs/                      # §25 文档集（随阶段补齐）
evals/                     # 评测数据集与结果（harness 在 src/retrieval/eval.ts）
policy-packs/              # 抖音政策包（四来源钉住，开播前 fail-closed 校验）
installer/                 # G 阶段
```

## 关键运行语义（已实现并测试）

- 常规请求先本地；所有跳过/升级均记录原因码，usage 表留痕
- 每逻辑请求最多一次第三方生成、一次本地 schema 修复；云端未配置/预算 null/耗尽 ⇒ 不发起付费调用
- 政策阻断（人设硬边界）不以任何模型绕过，直接固定降级回复
- 迟到的本地/云端结果按 generation_epoch 丢弃，同一回复只播一次
- 事件按 `(source, source_event_id)` 去重；迟到窗口外只记录不处理
- L2 假设需 ≥2 独立证据（同簇/同账号/同源派生不计数）；矛盾双方 challenged，检索不呈现为确定事实；过期查询时立即失效；修订保留血缘
- 画像按伪名化身份键隔离；观众纠错覆盖推测并留审计；删除墓碑优先于任何读取；传播状态对未建成系统如实标注
- 技能执行前实时检查撤销状态；版本不可原地覆盖；权限扩张无法自动晋级；失败走技能 fallback 不编造成功；同请求同技能幂等
- 礼物按事件键幂等入账，连击按平台累计数计算增量，退款为抵消记录不删历史；答谢合并窗口内合并、危险昵称不点名
- 训练样本先用途过滤再脱敏（vw_* 伪名/手机号/长数字不入参数）；heldout 冻结集不参与梯度；批量按簇/场次限量、30/70 回放配比
- 训练窗口三门（样本 ≥32、free_vram ≥ peak+reserve fail-safe、政策 train 授权 payloadHash 绑定）；challenger 专用 adapter，champion 全程不动；断点续跑承载数据游标+步数
- Python worker 授权不通过即退出（码 2）；QLoRA 依赖缺失明确报错，不以 dry-run 冒充真实训练；NF4 权重不得直接转 GGUF
- 发布只读结构化验证报告（七道门：完整性/政策回归/任务质量 CI 下界/工具执行/资源 OOM/数据证据/观察样本）；指标缺失 ⇒ inconclusive 继续观察，不放宽不跳过
- 灰度 5%→20%→50%→100%，每阶段至少两场次，样本不足停留当前阶段；每天最多一次模型晋级
- 回滚抬高治理 epoch（旧授权即刻失效）、恢复上一联合版本、被撤回版本标记 rolled_back
- 固化条件门（≥3 独立场次、≥5 独立证据、7 天观察、无反例、内容边界）；learned_stable 注入前强制过滤（撤销/过期）；反例即时暂停并留审计
- 开播状态机：平台未确认绝不显示「直播中」；无平台状态读取能力时停在「等待平台确认」并提示官方客户端入口；幂等任务键防重复开播；异常重启不自动公开开播
- 开播自检输出单一可操作原因；AI 标识不可见即阻断（模型与技能无权关闭）；政策包缺失/校验失败 fail-closed
- 紧急停止播出立即进入安全场景（优先于后台任务），与暂停学习（停新学习写入/训练/发布）是两个独立操作
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
