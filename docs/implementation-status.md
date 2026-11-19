# 实现状态与架构参考

以下为 0.19.0 时的实现记录；面向用户的最新功能与限制见 [项目说明](../README.md)。

## 当前状态（阶段 A–I + 0.12.0 角色档案 + 0.13.0 收敛 + 0.14.0 Live2D 桌宠与云端预设 + 0.14.1 模型页白屏修复与一键部署本地模型 + 0.15.0 API Key 界面维护与 ModelScope 国内部署 + 0.16.0 抖音直读与播出画面声音链 + 0.17.0 口型时间线与对话动作，代码交付完成）

按方案 §20.1 的 A–G 七阶段 + 阶段 H（面板与操作员设置，§24）+ 阶段 I（观众与治理面板，§6.4/§24.2）+ 0.12.0（主播信息改版为 eciyuan.qq.com 式角色档案卡，含 dsh-pet 插件中档案）：**代码全部交付**（G 含自检/诊断/集成测试/宿主适配层与文档；H 含操作员设置域/本地预览/多页签面板；I 含观众画像管理与治理审计面板；实机项——真实推理/QLoRA/两小时试运行/新用户实测——按方案在目标机与宿主安装环节验收）：

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
| 操作员设置与本地预览（§24.1/§24.2，H） | ✅ | 设置域六节 SQLite 持久化（形象/接入/场景/云端覆盖/数据用途/答谢）；AI 标识字面量不可关闭；平台凭据永不入库；本地预览进入/退出 + 单一可操作原因；开播 preflight 接实况设置 |
| 角色档案 · 主播信息（0.12.0，参照 eciyuan.qq.com） | ✅ | `BUILTIN_PROFILES` 五份档案（夏夏 / 沈露白 / 谷雨 / 贝拉 四个鹅次元官网角色 + dsh-pet 插件中桌宠角色）：中文名 / 英文名 / #人设标签 / 年龄·身高·星座·MBTI / 简介 / 主题色；`PersonaSettings.profileId`（默认 dsh-pet）+ `getPersonaProfile()`；settings / preview 两处带出档案；「角色与声音」展示所选档案，工作台可快速切换角色；播出展示名跟随档案中文名，AI 标识 / 授权 / 音色等合规字段不变 |
| 口型时间线与对话动作（0.17.0–0.17.1，RuiC-2D × LiveTalking） | ✅ | ①`src/avatar/lip-timeline.ts`——按采样位置记录 6 维 viseme、按播放位置短插值、闭唇压制开口、同话轮顺序号/跨话轮与换角色拒收、打断递增播出版本、首音分三段记账（**数据结构就绪，等 TTS 发音时间戳接入**）；②对话动作（0.17.1 接线）——直播画面页与独立播出窗口由弹幕/思考/首音/尾音事件驱动视线与头肩，连发合并 + 重触发限频，说话期间动作降权不抢口型；③`BroadcastWindow` 播放版本与 `broadcast-window/interrupt`（切角色、停播、紧急停止一律作废旧帧，SSE 版本跳变立即收口）；④客户端 viseme 驱动 mouthForm（圆唇负/横展正），无 viseme 时行为不变；**实测口径见 [主播表情与口型：实现和验收](avatar-motion-validation.md)**，音素级对齐与 ≤80ms 端到端误差仍为未验收项 |
| 观众画像管理与治理面板（§6.4/§24.2，I） | ✅ | 观众伪名化概览/详情隔离读取/纠错/退出个性化/删除两步流（墓碑优先）；技能库全版本、记忆候选生命周期、发布链灰度、审计与决策；反馈状态推进 |
| 大肥鱼桌宠形象（J，语音互动与模拟开播已于 0.13.0 移除） | ✅ | 内置形象目录含 2 款桌宠（默认选中，旧经典形象保留可回退）；本地预览渲染桌宠小窗（气泡字幕/悬浮动画/AI 标识常显）；音色试听用浏览器本机 TTS（录音不上传，最终音色以直播伴侣音轨为准） |
| Live2D 桌宠渲染（0.14.0，对齐鹅次元形象层） | ✅ | vendor 运行时（Cubism Core/pixi/pixi-live2d-display）随插件分发；模型包本地数据目录管理（Cubism 导出后手动放入，限本地/学习用途）；待机动作/点击互动/说话期口型驱动；未安装或失败自动回退角色口型原型/立绘（0.16.0，原为 CSS 桌宠）；资产经 host-api `avatar/*` 下发（base64 + blob URL，客户端保持单文件契约） |
| 三维骨骼主播样板（0.19.0，夏夏重构版） | ✅ | 独立三维角色 + 独立场景 + 固定机位；`xiaxia.glb` 由 `pnpm avatar:build-3d` 从仓库内程序化几何重建；three.js 经 tsdown 打包随插件分发（lib/rigged-avatar.js，safari16.4）；资产经 `avatar/rigged` 端点下发；加载失败回退本地原立绘 |
| 一键部署本地模型（0.14.1） | ✅ | 「设置 → 模型与云端」一键安装并验证 Ollama + 本地模型（`model/deploy` 端点 + `LocalModelDeployer` 子进程复用 `scripts/setup-ollama.mjs`，幂等可重入），进度日志实时回显；命令行 `pnpm setup:ollama` 等价 |
| 云端服务商预设（0.14.0） | ✅ | 内置腾讯云混元 / DeepSeek 官方 OpenAI 兼容端点预设（选择预设后自动填入模型建议）；自定义服务商仍走 `DAFEIYU_CLOUD_BASE_URL`；密钥永不落库 |
| 工作台与管理（§24.2–24.4） | ✅ | 工作台常驻实时预览、直播控制、学习、待处理与费用；管理含配置、训练记录、互动账本、观众、治理和诊断 |

**待实机/宿主环节完成**：宿主内 install_bundle 安装与 Web UI 客户端半启用、continual-harness/live-studio 实适配、目标机 QLoRA 实跑、连续两小时真实集成试运行与新用户实测（§20.2/§25）。

## 开发

```bash
pnpm install
pnpm setup:ollama # 安装或复用 Ollama，下载 qwen3:4b 并验证推理
pnpm test        # 249 个单元/契约/集成测试（node:test）
pnpm test:worker # Python worker 11 例（unittest，纯标准库）
pnpm typecheck   # tsc --noEmit（strict + exactOptionalPropertyTypes）
pnpm build       # 宿主插件 + 播出页面；Mac 构建同时生成随包分发的原生窗口（需要 Xcode 命令行工具）
```

插件入口：`createPlugin({ configPath?, dataDir?, log? })` → `{ runtime, blackboard, arbiter, policy, dispose() }`（cordis 风格别名 `activate`）。阶段 A 不 import 宿主专属包，宿主事件接线（`agent/pre-step` waterfall、`session/event` 等）在后续阶段接入。

## 目录

```text
config/default.yaml        # §18 配置草案初值（mode: shadow）
src/
  index.ts / runtime.ts    # 插件入口 / LearningRuntime（A：ingest+answer；B：画像+认知候选；C：retrieve）
  config.ts / types.ts     # zod 配置 schema / §17 领域契约
  storage/                 # db、migrations（001–009）、outbox、publish
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
  installer/               # 首次配置自检、诊断报告导出
  integration/             # 全链路集成测试与故障注入
  live/                    # 直播会话状态机、一键训练入口（四主操作核心）、预览门
  settings/                # 操作员设置域（角色档案/形象/接入/场景/云端覆盖/数据用途/答谢，§24.1）
  avatar/                  # Live2D 桌宠资产服务（vendor 就绪探测 + 模型包扫描 + 安全下发）
  host-api-avatar.ts       # avatar/* GET 路由（catalog / vendor / model-file）
  testing/                 # 测试公共设施（临时库/资源桩/embedding 桩/评测夹具——不进生产路径）
  host-adapter.ts          # 宿主 define 接入层（cordis 行的 node 半）
skill-packages/            # 技能包目录（示例：gift-ack-phrase）
scripts/                   # setup-role-voices.sh / synthesize-role-voice.py（Qwen3-TTS 本地角色声线合成）
client/vendor/             # Live2D 渲染运行时（Cubism Core/pixi/pixi-live2d-display，许可见 VENDOR-LICENSES.md）
training-worker/           # Python 训练进程：分时状态机/检查点/QLoRA（dry-run 零依赖）
docs/                      # §25 文档集（随阶段补齐）
evals/                     # 评测数据集与结果（harness 在 src/retrieval/eval.ts）
policy-packs/              # 抖音政策包（四来源钉住，开播前 fail-closed 校验）
installer/                 # G 阶段
```

## Web 面板（客户端半）

- `client/client.js` 由 DSH 装载。在侧边栏打开「大肥鱼直播」，顶部可切换「工作台」「直播画面」「记录与学习」「设置」。界面随宿主切换亮暗主题。
- **工作台**并排呈现角色预览和主播互动。开播、下播与当日概况放在预览上方，直播状态和紧急停止固定在顶部。可发文字或使用浏览器麦克风转写，开播后默认自动回复评论，可直接在互动区调整。见 [直播互动接入](quick-start.md#直播互动接入)。
- **直播画面**可在 Mac 上打开固定 9∶16 的独立播出窗口，直播伴侣通过「程序窗口」采集完整画面。角色、字幕和口型复用插件舞台，声音由 DSH 播放，插件内切页时继续更新。紧急停止或工作台连接中断会切换到安全画面。原生窗口和页面运行时随构建产物分发，使用时无需安装 OBS。见 [抖音直播画面与音频](quick-start.md#抖音直播画面与音频)。

口型与倾听动作已接入播放时钟和实时推送，能力范围、可复现检查及尚待验收的同步目标见 [表情与口型验收](avatar-motion-validation.md)。

夏夏、沈露白、谷雨、贝拉支持保留原图外貌的完整 2.5D 面部网格，联动眉眼、脸颊、下颌和口唇，并补建口腔内部。已生成模型位于本机 `data/models/eciyuan-*/face-rig.json`，随现有素材加载；制作与交互预览见 [四角色面部模型](face-rig-models.md)。
- **记录与学习**集中查看回复记录、反馈处理、礼物账本、观众画像、训练、治理与发布。训练演练和暂停学习在「训练」，恢复稳定版本在「治理与发布」的发布链。
- **设置**可直接打开角色与声音、直播接入、模型与云端、数据用途和诊断。模型页包含 Ollama 安装、云端连接测试、密钥维护和额度查询。环境自检与脱敏报告统一在「诊断」。
- 后端：`/api/dafeiyu/*` 经宿主 `connection/request`（同源认证共享 API；`src/host-api.ts`）——status、settings（六节读写 + `cloudKey` 密钥掩码状态 + `settings/cloud/key` 密钥维护 + `profile` 当前档案 + `catalogs.profiles`/`catalogs.cloudProviders` 目录）、preview（start/stop/chat/voice-test；`preview.persona` 带档案中文名/英文名/#标签）、avatar（catalog/vendor/model-file——Live2D 桌宠资产）、selfcheck、model/deploy（GET 部署状态轮询，附 `install` 安装探测 / POST 幂等启动）、diagnostics、replies、feedback（+advance）、gifts/summary、training/progress、costs、audience（overview/profile/correction/personalization-off/deletion 两步流）、governance（skills/memory/releases/audit）与四主操作端点
- 面板变更需浏览器页刷新后生效；后端改动需 `pnpm build` 后重载宿主插件（本机 profile 以 `link:` 软链仓库，构建产物 `lib/index.js` 立即生效）

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
| `DAFEIYU_OLLAMA_MODEL` | 覆盖本地对话模型名 | `qwen3:4b` |
| `DAFEIYU_OLLAMA_CPU_URL` | CPU 接答实例端点（训练窗口） | 同上 |
| `DAFEIYU_CLOUD_BASE_URL` / `DAFEIYU_CLOUD_API_KEY` | 第三方端点/密钥；密钥与自定义端点均可在面板「模型与云端」维护（环境变量优先，界面只回掩码）；选内置预设（腾讯云混元/DeepSeek）或填「端点 URL」（如 TokenHub）时端点可省环境变量 | 未设置且界面未维护 ⇒ 云端禁用 |
| `DAFEIYU_OLLAMA_SOURCE` | 模型权重来源：`modelscope`（国内镜像直连，无需代理）/ `registry`（官方仓库，通常需代理） | `modelscope` |
| `DAFEIYU_MODELSCOPE_REPO` / `DAFEIYU_MODELSCOPE_FILE` | 自定义 ModelScope GGUF 仓库与文件名（需同时设置；默认按模型名内置映射，如 qwen3:4b → Qwen/Qwen3-4B-GGUF 的 Q4_K_M） | 内置映射 |
| `DAFEIYU_MODELSCOPE_BASE` | ModelScope 站点基址（自建镜像用） | `https://modelscope.cn` |
| `DAFEIYU_PROBE` | 资源探测：`auto`（nvidia-smi）/ `ram-only` | `auto` |
| `DAFEIYU_VENDOR_DIR` | Live2D vendor 运行时目录（Cubism Core/pixi/pixi-live2d-display） | `<包根>/client/vendor` |
| `DAFEIYU_DANMAKU_URL` / `DAFEIYU_DANMAKU_ROOM_ID` / `DAFEIYU_DANMAKU_TOKEN` | 授权弹幕转发服务地址、房间 ID 与访问令牌 | 未设置时工作台显示弹幕未配置 |

> 本仓库为代码交付（阶段 A–I + 0.12.0 角色档案 + 0.13.0 现实使用收敛 + 0.14.0 Live2D 桌宠与云端预设 + 0.14.1 模型页白屏修复与一键部署本地模型 + 0.15.0 API Key 界面维护与 ModelScope 国内部署），不代表插件已安装、平台权限已取得、在线训练已验证或一键开播可用；实机项按方案 §20 在目标机与宿主安装环节验收。Live2D 官方示例模型（data/models/）与 vendor 运行时（client/vendor/）的许可均限本地/学习用途，商用或公开分发前自行核对 Live2D 条款。
