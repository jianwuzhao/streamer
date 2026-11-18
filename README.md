# dsh-dafeiyu-evolve — 大肥鱼自学习直播插件

基于 [DSH 大肥鱼自学习直播全量实现方案 v4.0](DSH大肥鱼自学习直播方案_分析与优化.md) 的逐步实现。

- **目标硬件**：RTX 4060 Ti 8GB 显存 / 32GB 内存（Windows/Linux 实机，参数待实机校准）
- **开发环境**：macOS（Apple M1 Pro）/ Node ≥ 22.13 / pnpm —— GPU 相关功能以适配器接口 + 契约测试交付，实机验收在目标机执行
- **宿主兼容**：DeepSeek Harness `0.2.2-rc.1`（Electron Node 24，内嵌 `node:sqlite`，零原生编译依赖）
- **许可证**：待定（正式发布前补齐）

## 版本记录

| 版本 | 日期 | 说明 |
| --- | --- | --- |
| 0.17.1 | 2026-11-18 | 对话动作接线到直播画面 + 修复 0.17.0 遗留问题：①**对话动作真正生效**——0.17.0 只交付了 `src/avatar/dialogue-motion.ts` 模块与测试，`client.js` 为无构建单文件不能 import TS 模块，故未在预览生效；本版在 `client/client.js` 内联等价状态机 `createDialogueMotion` 并完成接线：「直播画面」页（`BroadcastStage`）由弹幕轮询（新增弹幕 → 视线移向互动区）与 `speech.phase` 边沿（pending→思考侧头、speaking→说话收敛、结束→收尾点头）驱动；独立播出窗口（`BroadcastOutput`）由 SSE 帧边沿与互动轮次驱动同一语义；两处渲染路径（Live2D 参数写入 / 2.5D 原型 draw 调用）经 `blendDialogueTargets` 叠加视线/头肩/点头/眉眼（安全与减少动态归零、说话期间降权 45%）。②**播放版本客户端消费**——SSE 帧的 `version` 跳变（切角色/打断/紧急停止）时旧口型立即作废收口，不再等 160ms 样本过期；「暂停播出声音」现在调用 `POST broadcast-window/interrupt` 作废独立窗口在途口型与动作。③**修复**——0.17.0 在 `client.js` 留下重复的 `applyVisemePose` 声明（vm 测试静默掩盖、`node --check` 失败），已删除；新增 `node --check client/client.js` 到本地验证习惯。④工作台内嵌小预览（`EciyuanPreview`）未接对话动作，属后续范围。TS 240 例全过（+2 对话动作 vm 用例）；渲染检查 181 样本 / 0 过期 / 0 页面错误 |
| 0.17.0 | 2026-11-18 | 四角色 2D 形象重构（按 [RuiC-2D × LiveTalking 方案](docs/ruic-2d-refactor-plan.md) 的"音频和口型时间线 / 动作与打断"两条落地）：①**口型时间线**——新增 `src/avatar/lip-timeline.ts`：口型样本按采样位置记录 `turnId`/`profileId`/`sampleRate`/起止采样与 6 维 viseme 权重（开口·闭唇·圆唇·横展·露齿·微笑），按实际播放位置短插值（连读过渡），窗口外返回 null 不做边缘外推；**闭唇（b/p/m）压制开口**，呼吸余量不能把嘴顶开；`LipTimelinePlayer` 同话轮只收更大顺序号、跨话轮与换角色拒收、打断递增播出版本；`measureFirstAudio` 分三段记账（审核完成 / 首段 PCM / 实际首音）并如实标注未测到为 null。②**对话动作事件**——新增 `src/avatar/dialogue-motion.ts`：把「弹幕到达 → 输入开始/停顿 → 等待回复 → 首音 → 尾音 → 收尾」翻译成姿态目标（视线/头肩/点头/眉眼），连发弹幕按合并窗口 + 重触发限频抵消刷屏，说话期间动作权重压到 45% 不抢口型，`interrupt()`/`safe` 回到中性并递增版本。③**播出播放版本与打断**——`BroadcastWindow` 在切角色/进出安全画面时递增 `playbackVersion`，带旧版本号的上行帧直接拒收（迟到帧不得恢复上一句）；新增 `POST broadcast-window/interrupt`，`live/stop` 与 `live/emergency-stop` 一律作废在途口型与动作。④**客户端渲染适配**——`client/client.js` 新增 `applyVisemePose`：viseme 驱动 `mouthForm`（圆唇为负、横展为正）、闭唇优先于音量余量；Live2D 与 2.5D 原型两条渲染路径都接同一组参数。未接入对齐时间线时由 `visemeFromSample` 只用音频的过零率代理给出**形状**维度（圆唇/横展），开合仍由原平滑器与呼吸余量决定，因此**行为逐位不变**（有等价测试）；viseme 全零时完整回退旧路径。TS 238 例全过（+17） |
| 0.16.0 | 2026-11-17 | 抖音直播间后台直读 + 播出画面声音链 + 角色口型原型：①**抖音后台读取**——新增 `src/platform/douyin-browser.ts`（playwright-core CDP 后台静音 Chrome 打开 `live.douyin.com` 房间页）与 `douyin-protocol.ts`（gzip + protobuf 裸解码网页数据流，DouyinBarrageGrab 系 wire 字段；读出评论/礼物/点赞/进房/关注/粉丝团/分享，64 位 ID 恒为十进制字符串）；`PlatformSettings.interactionSource` 二选一——`browser`（默认，填完整房间 URL）或 `relay`（沿用 env `DAFEIYU_DANMAKU_*` 转发源，行为不变）；②**播出画面与声音**——新增「直播画面」页（窗口捕获工作流：竖屏 1080×1920 / 横屏 1920×1080，直播伴侣同比例裁切推流）；「启用播出声音 / 试播一句 / 暂停播出声音」（应用音频或虚拟声卡，伴侣只收一条角色音轨；插件内切页不停声，紧急停止立即静音并显示安全画面）；「让主播回复」与按互动类型自动回复（每场重置，回复文字/模型/Token 记入互动与账本）；③**角色口型原型**——`client/assets/dsh-pet/`（DSH 蓝发女仆透明待机动画 + 静帧，取自 [dsh-pet 0.4.8](https://github.com/PC2005-cloud/dsh-pet) MIT）与 `scripts/prepare-role-prototypes.mjs`（本地原片提取口型图层）；Live2D 未安装时舞台回退口型原型/立绘（原为 CSS 桌宠）；④迁移 011 reply_generation_usage（`usage.tokens_total` / `reply_log.usage_id`——回复 Token 用量归因）；`src/adapters/response-lines.ts` 模型流式响应跨 chunk/UTF-8 边界按行解码；删除 `scripts/fetch-live2d-samples.sh`（Live2D 官方示例安装脚本，历史版本可复现）；依赖 +playwright-core 1.65.0 / +protobufjs 7.6.6（pnpm-workspace.yaml allowBuilds）；TS 202 例全过 |
| 0.15.3 | 2026-11-16 | 自定义网关接入（TokenHub 混元 hy4 实测）+ 推理模型兼容：①**端点 URL 字段**——`CloudSettings` 新增 `baseUrl`，「模型与云端」新增「端点 URL（自定义网关）」输入框；解析优先级 env `DAFEIYU_CLOUD_BASE_URL` > 界面端点 > 服务商预设，自定义网关（如腾讯 TokenHub `https://tokenhub.tencentmaas.com/v1` + hy4）无需任何环境变量即可接入、测试与保存；额度路由同链路（TokenHub 无 billing 接口 → 如实标注「以控制台为准」）。②**推理模型兼容**——测试请求 max_tokens 提到 512，`content` 空但 `reasoning_content` 非空视为端点验证通过（hy4/R1 系思考先消耗预算）；云端适配器在 `finish_reason=length` 且正文为空时单次补足 ≥1024 tokens 重试（仍属同一次逻辑生成）；TS 198 例全过 |
| 0.15.2 | 2026-11-16 | 额度/可用余额展示：新增 `GET cloud/quota`——按已保存的生效配置（env 优先）尽力查询：**DeepSeek 官方**走源站 `/user/balance`（总余额/赠送/充值三行 + 可用徽章，is_available=false 时标注停用）；**其余 OpenAI 兼容端点**（one-api/new-api 系）走 `dashboard/billing`（总额度/本年已用/可用余额，USD）；不支持的服务商（如腾讯混元）`supported:false` 如实标注「以控制台为准」，不编造数值。面板「模型与云端」新增「额度 / 可用余额」区块：进入页面自动查询、保存后自动刷新、可手动刷新；密钥未配置时提示先配置 |
| 0.15.1 | 2026-11-16 | 云端配置即时生效 + 连接测试门禁：①**保存即生效**——`OpenAICompatCloudAdapter` 改为 `resolve()` 实时视图（每次调用读取 env > 面板保存值），`featureGates` 云端门禁用 getter 包装：API Key / 服务商 / 模型 / 预算保存后**无需重载插件**立即生效；②**连接测试**——新增 `POST settings/cloud/test`：按「表单当前值 + 已填密钥」发起一次最小 chat 请求（不写入设置；端点/密钥解析与真实调用一致，env 优先），面板「模型与云端」新增「测试连接」按钮，**测试通过后「保存」才可点击**（任何字段改动重置测试状态），测试结果回显服务商返回文本或 HTTP 错误（401/403/404 带中文提示）；③部署卡加固——状态接口异常显式红字报错（旧后端场景提示重载插件），无快照时按钮可点击 POST 兜底，install 探测改后台刷新不阻塞响应 |
| 0.15.0 | 2026-11-16 | API Key 界面维护 + 国内镜像部署（ModelScope）：①**API Key 界面维护**——「模型与云端」新增密钥栏：保存/清除/掩码回显（首3+••••+尾4）与来源徽章（环境变量/界面维护/未配置），密钥存 `operator_settings` 的 `cloud_secret` 节（审计摘要不含值），任何读取路径明文永不回传；环境变量 `DAFEIYU_CLOUD_API_KEY` 仍优先，保存后重启插件生效；新增 `POST settings/cloud/key` 端点。②**ModelScope 国内直连**——`setup-ollama.mjs` 默认 `DAFEIYU_OLLAMA_SOURCE=modelscope`：从 ModelScope 直连下载 GGUF（断点续传 + 60s 停滞看门狗 + 百分比进度日志），经 `/api/blobs` + `/api/create` 导入为目标模型名并清理原始权重，全程无需代理；`registry` 可切回官方仓库（需代理）。③**未安装提示与进度条**——GET `model/deploy` 附带 `install` 探测（Ollama 服务/目标模型是否就绪，10s 缓存，running 期间不探测），部署卡显示「Ollama 服务/模型」状态徽章与未安装琥珀提示，按钮变「一键安装（ModelScope 直连）」；部署中显示百分比进度条（aria progressbar），curl `--progress-bar` 输出按 CR 独立成行进日志 |
| 0.14.1 | 2026-11-16 | 模型配置页白屏修复 + 一键部署本地模型：①**白屏修复**——向导「模型与云端」点击混元/DeepSeek 等预设即整页白屏，根因是 `<datalist>` 被挂成 `<input>`（void 元素）的 children，React 抛 `#137` 后卸载整棵树；现改为兄弟节点挂载，并对预设缺失 `models` 字段做防御；面板根新增 `PanelErrorBoundary`，渲染错误收敛为错误卡片（可重试）不再白屏。②**一键部署本地模型**——新增 `model/deploy` 端点（GET 状态轮询 / POST 幂等启动）与 `LocalModelDeployer`：子进程运行 `scripts/setup-ollama.mjs`（安装 Ollama → 拉取 qwen3:4b → 试运行验证），进度日志实时回显面板（running 期间 2s 轮询），Electron 宿主经 `ELECTRON_RUN_AS_NODE` 运行脚本，已就绪部分自动跳过 |
| 0.14.0 | 2026-11-13 | 形象与云端两步升级（对齐鹅次元的**形象层**架构、以官方 API 取其**底层智能**）：①**Live2D 桌宠渲染**——vendor 运行时随插件分发（Cubism Core + pixi.js 7 + pixi-live2d-display，`client/vendor/` + VENDOR-LICENSES.md），模型包按「数据目录 + manifest」管理（`data/models/<id>/`，不入仓库；`scripts/fetch-live2d-samples.sh` 一键安装 Live2D 官方示例角色，多 CDN 镜像回退）；新增 `src/avatar/model-store.ts`（扩展名白名单/路径穿越防护/24MB 单文件上限）与 host-api GET `avatar/catalog`、`avatar/vendor`、`avatar/model-file`（模型文件 base64 下发，客户端重写 FileReferences 为 blob URL）；桌宠小窗自动升级 Live2D 渲染（待机动作自动播放 / TapBody 点击互动 / 系统朗读期间按语音状态估算口型 / ResizeObserver 自适应），未安装或失败自动回退 CSS 大肥鱼；②**云端服务商预设**——内置 `CLOUD_PROVIDER_PRESETS`（腾讯云混元 `https://api.hunyuan.cloud.tencent.com/v1`、DeepSeek 官方），向导第 4 步预设选卡 + 模型名 datalist，端点解析优先级 env `DAFEIYU_CLOUD_BASE_URL` > 预设 > 不可路由占位（自定义服务商行为不变）；新增 env `DAFEIYU_VENDOR_DIR`；③**本地预览对话**——可保存所选模型，使用浏览器本地麦克风识别或键盘输入，由 Ollama 生成回复，可本地朗读并联动字幕和口型；④**本地角色声线**——`scripts/setup-role-voices.sh` / `synthesize-role-voice.py`（Qwen3-TTS 离线合成，Apple Silicon；参考录音 + 同名逐字稿 `.txt` 辅助模仿语气，详见 quick-start）；TS 173 例全过 |
| 0.13.0 | 2026-11-13 | 现实使用收敛重构：**删除「模拟开播」演练子系统**（服务/SQLite 双表写入/面板页签/simulation×7 API/CLI 脚本/演练报告文档；迁移 010 保留不回收）；移除语音互动死配置（`voiceInteractionEnabled` 与向导勾选，浏览器试听保留）；**环境变量前缀修正 `DAFEIFYU_*` → `DAFEIYU_*`**（原代码拼写与文档不一致，按文档设置会全部失效）；embedding 测试桩（哈希伪向量/语义映射桩）移出生产代码至 `src/testing/`，生产恒为 Ollama 真实语义模型、测试经 `createPlugin({ embeddingProvider })` 显式注入；`UnknownGpuProbe` 恒返回 RAM 样本（删重复的 `*_PROBE_RAM_ONLY` 内部钩子）；开播 preflight `stableReleaseAvailable` 由发布链如实派生（active 版本或钉住基线）；仓库清理：`.agents/`（4.6MB 无关设计技能）与 `training-worker/__pycache__` 解除 git 跟踪并 gitignore、本地运行时 `data/*.db` 清理；面板九页签 → 八页签；文件行数收敛（`settings/catalogs.ts`（内置目录）与 `index-wiring.ts`（装配辅助）拆出，`index.ts` 385 行 / `store.ts` 251 行 / `host-api.test.ts` 389 行；`migrations.ts` 为追加式迁移历史不拆、`client.js` 为宿主单入口无构建客户端半部，从 1289 行减至 1019 行）；TS 153 例全过 |
| 0.12.0 | 2026-11-13 | 主播信息改版为「角色档案卡」（参照 [腾讯《鹅次元》官网](https://eciyuan.qq.com/) 的 CHARACTERS 角色介绍）：新增 `BUILTIN_PROFILES` 目录——夏夏 / 沈露白 / 谷雨 / 贝拉 四个鹅次元角色 + 一个 **dsh-pet（插件中）** 桌宠角色，每份档案含中文名 / 英文名 / #人设标签 / 年龄·身高·星座·MBTI / 简介 / 主题色；`PersonaSettings` 新增 `profileId`（默认 `dsh-pet`，播出展示名跟随档案中文名）、`SettingsStore.getPersonaProfile()`；`settings` payload 与 `preview.persona` 带出 `profile` / `catalogs.profiles`、模拟开播 state/报告带出档案；首次配置第 3 步「主播形象」表单改为「角色档案」档案卡选择 + 展示，首页新增「主播信息 · 角色档案」卡；AI 标识 / 使用授权 / 音色 / 试听 / 语音互动与既有合规字段与状态机文案保持不变；TS 165 例全过 |
| 0.11.0 | 2026-11-12 | 阶段 J（大肥鱼桌宠 + 第一次模拟开播 + 语音互动）：虚拟形象默认换成「大肥鱼桌宠」（新增 2 款 deskpet 目录项、style=deskpet 标记，旧经典形象保留可回退）；PersonaSettings 新增 voiceInteractionEnabled（默认开启，浏览器本机语音识别/合成，录音不上传）；新增模拟开播服务与 SQLite 010 留痕表（simulation_runs / simulation_events），一键跑完内置首播脚本（开场→弹幕→语音→礼物→收尾），**不连接抖音、不推流、不切换生产播出状态、不写 reply_log/礼物账本/画像/训练样本**，感知事件以 replay=1 登记；回复经真实本地优先路由（本地不可达如实记 fallback + 已验证桌宠口吻模板，不伪装模型生成）；Web 面板新增「模拟开播」页签（桌宠小窗 + AI 标识常显 + 麦克风/朗读 + 事件流 + 演练报告）；status/voice-test 扩展断言；TS 163 例全过 |
| 0.10.0 | 2026-11-12 | 面板信息架构与布局重做（ui-ux-pro-max 设计流程，Real-Time Operations / dashboard 密度）：固定骨架（头部状态 + 横向页签 + 独立滚动内容区 + 常驻页脚紧急停止）；内容区改 CSS Grid `auto-fit minmax`（卡片等高、自动多列、窄屏单列），间距统一 4/8/12/16 节奏；首页加状态横幅（直播状态最高视觉权重，直播中绿/进行中琥珀语义底色）+ 6 项 KPI 磁贴；向导改左侧步骤轨 + 右侧单步面板（含逐步就绪徽章）；预览页画布与信息双栏；操作反馈改语义 toast（成功绿/失败红/进行中灰，role=status aria-live）；加载态 spinner（role=status + prefers-reduced-motion 停转）；页签 tablist + 左右方向键 + aria-selected/tabIndex；说明文字对比度修正至 5.3:1（原 2.8:1 不达 AA）；深色主题全走宿主 --dsw-* 变量；零功能变更，TS 151 例全过 |
| 0.9.1 | 2026-11-12 | 面板布局对齐宿主页面约定：铺满内容区（height:100% 自滚动、无居中限宽），卡片改响应式多列（dfy-cols/col/col-wide，宽屏并列、窄屏堆叠，对齐上下文洞察等宿主页的 lc-root/lc-cols 布局语言）；首页状态+预览并列、互动页回复+反馈+账本三列、治理页四卡两列、诊断页双列 |
| 0.9.0 | 2026-11-12 | 阶段 I（观众与治理面板）：观众页（伪名化概览/画像详情隔离读取/观众纠错 viewer_stated 覆盖推测/退出个性化/删除两步流——申请 received→验证后落墓碑、未验证不执行）、治理页（技能库全版本/记忆候选 L2·L4 生命周期与证据数/发布链灰度/审计与政策决策）、反馈状态推进（received→verifying→resolved/insufficient_evidence 操作员核实）；host-api 新增 audience×5 + governance×4 + feedback/advance 端点；TS 151 例 |
| 0.8.0 | 2026-11-12 | 阶段 H（面板与操作员设置，补齐方案 §24 界面缺口）：操作员设置域（主播形象：名称/内置形象/音色/试听语句/使用授权，AI 标识字面量不可关闭；直播接入：运行模式/内容类别/官方客户端入口/操作员登录声明，凭据永不入库；场景；云端覆盖重启生效，密钥仍走环境变量；数据用途确认；答谢点名开关——SQLite 009 持久化）、本地预览（进入/退出 + 浏览器渲染画布，预览≠开播、AI 标识常显）、开播 preflight 接实况设置（未配置给单一可操作原因）、Web 面板六页签（首页/首次配置向导五步+自检/直播预览/训练与学习/互动与账本/诊断导出，沿用 0.7.1 的 dsw 主题语言）、最近回复留痕（reply_log，反馈按回复归因，保留 500 条）、当日费用/礼物账本/训练进度/自检/诊断端点；TS 150 例 |
| 0.7.1 | 2026-11-12 | 界面适配 DSH 主界面：面板样式全部改用宿主 `--dsw-*` 设计变量（亮/暗主题随 `body[data-ds-dark-theme]` 自动切换，零 JS 参与）、图标重绘为 DSH 品牌语言（近黑底板 + 白色鱼剪影 + DeepSeek 蓝气泡）、状态徽章语义色映射（直播中=绿·呼吸点 / 进行中=琥珀 / 空闲=灰）、按钮/卡片对齐宿主层级（0.5px 描边 + 轻阴影风格）、键盘焦点可见与 `prefers-reduced-motion` 支持 |
| 0.7.0 | 2026-11-12 | 阶段 G（整体验收就绪）：首次配置自检（Node/Python/配置/数据目录/Ollama/GPU 逐项可修复动作，缺失能力如实标注）、诊断报告导出（聚合计数、无观众标识/正文/凭据）、全链路集成测试与故障注入（重复事件/政策阻断/重复连击/回滚 epoch 阻断/训练窗口禁用如实报告）、宿主接入适配层（define → createPlugin）、docs/quick-start；TS 139 例 |
| 0.6.0 | 2026-11-11 | 阶段 F（产品入口核心）：直播会话状态机（未配置→…→已结束；平台未确认绝不显示直播中；幂等开播；紧急停止≠暂停学习）、开播自检（单一可操作原因、AI 标识不可关闭、缺规则包 fail-closed）、抖音政策包（四来源钉住）、PlatformAdapter 契约（辅助模式默认、能力如实申报）、一键训练入口（暂停学习/训练完成≠发布）；TS 137 例 |
| 0.5.0 | 2026-11-11 | 阶段 E（自动发布与固化）：统一验证器（七道门→结构化报告，inconclusive 不放行）、联合发布控制器（candidate→staged→canary→active 状态链、灰度 5→20→50→100 每阶段≥2 场次、每日一次晋级、epoch 回滚）、自动固化（条件门→learned_stable L1/L3、去重键、反例撤回、注入过滤、30 天复核）；runtime 四接口实装；TS 132 例 |
| 0.4.0 | 2026-11-11 | 阶段 D（训练）：训练样本管道（用途过滤/脱敏/去重簇/heldout 隔离/30-70 回放配比）、训练窗口调度器（样本/资源/政策三门、champion 不动、断点续跑）、Python worker（分时状态机/检查点/授权协议/QLoRA 依赖守卫/GGUF 导出守卫）；TS 123 例 + Python 11 例 |
| 0.3.0 | 2026-11-11 | 阶段 C（检索优化）：BM25/向量/图谱三路召回、RRF 融合与重排、实时复检、token 预算截断、索引 generation 迁移与墓碑即时过滤、向量路降级、评测与消融（Recall@5/nDCG@5/延迟分位）；`runtime.retrieve` 实装；累计 115 项测试 |
| 0.2.0 | 2026-11-11 | 阶段 B（完整数据层）：L2/L4 记忆生命周期与矛盾处理、全量观众画像（伪名化身份/字段版本链/删除墓碑）、技能库（manifest/受控执行/示例技能包）、反馈状态机、礼物幂等账本与合并答谢；累计 103 项测试 |
| 0.1.0 | 2026-11-11 | 阶段 A（基础与资源）：插件骨架、统一配置、SQLite 存储基座、感知/黑板、本地优先路由、模型适配器、资源仲裁、政策授权骨架；70 项测试 |

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
| 口型时间线与对话动作（0.17.0–0.17.1，RuiC-2D × LiveTalking） | ✅ | ①`src/avatar/lip-timeline.ts`——按采样位置记录 6 维 viseme、按播放位置短插值、闭唇压制开口、同话轮顺序号/跨话轮与换角色拒收、打断递增播出版本、首音分三段记账（**数据结构就绪，等 TTS 发音时间戳接入**）；②对话动作（0.17.1 接线）——直播画面页与独立播出窗口由弹幕/思考/首音/尾音事件驱动视线与头肩，连发合并 + 重触发限频，说话期间动作降权不抢口型；③`BroadcastWindow` 播放版本与 `broadcast-window/interrupt`（切角色、停播、紧急停止一律作废旧帧，SSE 版本跳变立即收口）；④客户端 viseme 驱动 mouthForm（圆唇负/横展正），无 viseme 时行为不变；**实测口径见 [主播表情与口型：实现和验收](docs/avatar-motion-validation.md)**，音素级对齐与 ≤80ms 端到端误差仍为未验收项 |
| 观众画像管理与治理面板（§6.4/§24.2，I） | ✅ | 观众伪名化概览/详情隔离读取/纠错/退出个性化/删除两步流（墓碑优先）；技能库全版本、记忆候选生命周期、发布链灰度、审计与决策；反馈状态推进 |
| 大肥鱼桌宠形象（J，语音互动与模拟开播已于 0.13.0 移除） | ✅ | 内置形象目录含 2 款桌宠（默认选中，旧经典形象保留可回退）；本地预览渲染桌宠小窗（气泡字幕/悬浮动画/AI 标识常显）；音色试听用浏览器本机 TTS（录音不上传，最终音色以直播伴侣音轨为准） |
| Live2D 桌宠渲染（0.14.0，对齐鹅次元形象层） | ✅ | vendor 运行时（Cubism Core/pixi/pixi-live2d-display）随插件分发；模型包本地数据目录管理（Cubism 导出后手动放入，限本地/学习用途）；待机动作/点击互动/说话期口型驱动；未安装或失败自动回退角色口型原型/立绘（0.16.0，原为 CSS 桌宠）；资产经 host-api `avatar/*` 下发（base64 + blob URL，客户端保持单文件契约） |
| 一键部署本地模型（0.14.1） | ✅ | 「设置 → 模型与云端」一键安装并验证 Ollama + 本地模型（`model/deploy` 端点 + `LocalModelDeployer` 子进程复用 `scripts/setup-ollama.mjs`，幂等可重入），进度日志实时回显；命令行 `pnpm setup:ollama` 等价 |
| 云端服务商预设（0.14.0） | ✅ | 内置腾讯云混元 / DeepSeek 官方 OpenAI 兼容端点预设（选择预设后自动填入模型建议）；自定义服务商仍走 `DAFEIYU_CLOUD_BASE_URL`；密钥永不落库 |
| 工作台与管理（§24.2–24.4） | ✅ | 工作台常驻实时预览、直播控制、学习、待处理与费用；管理含配置、训练记录、互动账本、观众、治理和诊断 |

**待实机/宿主环节完成**：宿主内 install_bundle 安装与 Web UI 客户端半启用、continual-harness/live-studio 实适配、目标机 QLoRA 实跑、连续两小时真实集成试运行与新用户实测（§20.2/§25）。

## 开发

```bash
pnpm install
pnpm setup:ollama # 安装或复用 Ollama，下载 qwen3:4b 并验证推理
pnpm test        # 221 个单元/契约/集成测试（node:test）
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
- **工作台**并排呈现角色预览和主播互动。开播、下播与当日概况放在预览上方，直播状态和紧急停止固定在顶部。可发文字或使用浏览器麦克风转写，开播后默认自动回复评论，可直接在互动区调整。见 [直播互动接入](docs/quick-start.md#直播互动接入)。
- **直播画面**可在 Mac 上打开固定 9∶16 的独立播出窗口，直播伴侣通过「程序窗口」采集完整画面。角色、字幕和口型复用插件舞台，声音由 DSH 播放，插件内切页时继续更新。紧急停止或工作台连接中断会切换到安全画面。原生窗口和页面运行时随构建产物分发，使用时无需安装 OBS。见 [抖音直播画面与音频](docs/quick-start.md#抖音直播画面与音频)。

口型与倾听动作已接入播放时钟和实时推送，能力范围、可复现检查及尚待验收的同步目标见 [表情与口型验收](docs/avatar-motion-validation.md)。

夏夏、沈露白、谷雨、贝拉支持保留原图外貌的完整 2.5D 面部网格，联动眉眼、脸颊、下颌和口唇，并补建口腔内部。已生成模型位于本机 `data/models/eciyuan-*/face-rig.json`，随现有素材加载；制作与交互预览见 [四角色面部模型](docs/face-rig-models.md)。
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
