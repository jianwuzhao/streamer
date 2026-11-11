# training-worker（阶段 D 已实现）

独立 Python 训练进程（方案 §3 / §9）。**dry-run 模式零依赖（仅标准库）**，在任何机器验证状态机/检查点/授权协议；真实 QLoRA 需目标机安装固定依赖（`pyproject.toml`）。

## 结构

```text
training-worker/
├── worker.py          # 入口：stdin 收 job JSON（含 train 授权）→ stdout 按行 state/receipt
├── states.py          # 分时状态机：prepare_cpu→drain_gpu→train_slice→checkpoint→release_gpu→warmup_champion
├── qlora_slice.py     # 真实 QLoRA 窗口（依赖缺失明确报错，不以 dry-run 冒充真实训练 §9.1）
├── checkpoint.py      # 检查点清单（参数/优化器引用/数据游标/RNG），恢复唯一依据
├── export_gguf.py     # GGUF 导出守卫（NF4 权重不得直接转换 §9.5）
├── test_worker.py     # unittest（11 例，纯标准库）
└── pyproject.toml     # 目标机固定依赖清单（torch/transformers/peft/trl/bitsandbytes/accelerate/gguf）
```

## 协议

```jsonc
// stdin（TrainingJobSpec）
{ "run_id": "...", "mode": "dry_run|qlora", "base_profile": "main-4b",
  "max_steps": 4, "wall_budget_s": 60, "samples": [{"text": "..."}],
  "replay_fraction": 0.7, "checkpoint_dir": "...", "resume_from": null,
  "decision": { "action": "train", "result": "allow", "expiresAt": "...", ... } }
// stdout：{"type":"state","state":"prepare_cpu"} … {"type":"receipt","steps":4,"params_changed":true,"checkpoint_id":"ckpt_...","state":"completed"}
```

退出码：0 成功｜2 授权不通过｜3 依赖缺失/训练失败｜4 任务非法。

## 与插件主进程的契约

- TS 侧 `TrainingScheduler`（`src/training/scheduler.ts`）：机会评估（样本门 ≥32、资源门 `free_vram ≥ peak+reserve` fail-safe、政策门 payloadHash 绑定）→ 批量构建（30/70 回放配比、簇/场次上限、heldout 隔离）→ 状态机落库（training_runs/checkpoints）
- challenger 专用 adapter，champion 全程不动（§9.1）；断点续跑从最近 checkpoint（数据游标+步数）
- 真实梯度更新（qlora 模式）仅目标机执行；本仓库测试为 dry-run（协议/检查点/恢复全验证）

## 运行与测试

```bash
python3 -m unittest discover -s training-worker -p 'test_*.py' -v   # 11 例
pnpm test:worker                                                     # 同上（npm script）
```

## 目标机验收（§20.2-D）

直播期间非零 optimizer step、参数变化可追踪、检查点可恢复、GPU 推理预热后恢复正常服务；量化产物重测五项（质量/工具契约/显存/延迟/安全）后才可进入发布门。
