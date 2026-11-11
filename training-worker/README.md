# training-worker（阶段 D 占位）

独立 Python 训练进程，按方案 §3（8GB 分时部署）与 §9（在线/离线训练）在阶段 D 实现。当前仓库不包含任何训练代码。

## 计划结构（阶段 D）

```text
training-worker/
├── pyproject.toml          # 固定版本训练库（transformers/peft/trl/bitsandbytes）
├── worker.py               # 入口：显式携带身份与授权，不依赖进程本地上下文继承
├── states.py               # 分时状态机：LIVE_GPU→PREPARE_CPU→DRAIN_GPU→TRAIN_SLICE→CHECKPOINT→RELEASE_GPU→WARMUP_CHAMPION
├── qlora_slice.py          # 在线 QLoRA 窗口（micro batch 1、每窗口 ≤4 optimizer steps、墙钟 ≤60s）
├── offline.py              # 离线训练、历史回放、消融
├── export_gguf.py          # adapter 合并→GGUF 转换→量化（NF4 权重不得直接当 GGUF 发布）
└── checkpoints/            # 参数、optimizer、数据游标、RNG 状态
```

## 与插件主进程的契约

- 由资源仲裁器（`src/resources/arbiter.ts`）的准入结果决定窗口：`free_vram ≥ measured_training_peak + reserve`
- 训练请求必须携带 PolicyService 签发的 `train` 授权（payloadHash 绑定训练配置）
- 训练只更新 challenger，绝不原地修改正在服务的 champion 权重（§9.1）
- 进程退出前确认显存释放；仅 `pause` 不足以释放（§9.2）

## 验收（目标机实机）

直播期间非零 optimizer step、参数变化可追踪、检查点可恢复、GPU 推理预热后恢复正常服务（方案 §20.2）。
