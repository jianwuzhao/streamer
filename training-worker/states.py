"""分时训练状态机（方案 §9.2）。

LIVE_GPU → PREPARE_CPU → DRAIN_GPU → TRAIN_SLICE → CHECKPOINT
→ RELEASE_GPU → WARMUP_CHAMPION → LIVE_GPU

- 每步向 stdout 输出一行 JSON 事件（TS 侧记录 training_runs）；
- TRAIN_SLICE 由 dry_run（合成梯度，任何机器可跑）或 qlora（真实，
  依赖缺席时明确报错）执行；
- 任何失败不改变 champion（worker 全程不接触服务权重）。
"""

from __future__ import annotations

import json
import sys
from typing import Callable, Dict, List, Optional

STATES = [
    "prepare_cpu",
    "drain_gpu",
    "train_slice",
    "checkpoint",
    "release_gpu",
    "warmup_champion",
]


def emit(payload: Dict[str, object]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def run_state_machine(
    job: Dict[str, object],
    train_slice: Callable[[Dict[str, object]], Dict[str, object]],
) -> Dict[str, object]:
    """顺序执行状态机；train_slice 返回训练结果（steps/params_changed/checkpoint）。"""
    for state in STATES:
        emit({"type": "state", "state": state})
        if state == "train_slice":
            result = train_slice(job)
            if result.get("state") != "ok":
                return {
                    "type": "receipt",
                    "run_id": job.get("run_id", ""),
                    "steps": 0,
                    "params_changed": False,
                    "checkpoint_id": "",
                    "state": "failed",
                    "error": str(result.get("error", "train_slice failed")),
                }
    checkpoint = result  # type: ignore[assignment]
    return {
        "type": "receipt",
        "run_id": job.get("run_id", ""),
        "steps": int(checkpoint.get("steps", 0)),  # type: ignore[union-attr]
        "params_changed": bool(checkpoint.get("params_changed", False)),  # type: ignore[union-attr]
        "checkpoint_id": str(checkpoint.get("checkpoint_id", "")),  # type: ignore[union-attr]
        "state": "completed",
    }


def dry_run_slice(job: Dict[str, object]) -> Dict[str, object]:
    """合成梯度窗口：执行状态机/检查点协议验证，不加载任何模型。

    目标机验收必须用 qlora 模式（§9.1：仅记录/改提示词不算在线训练）。
    """
    from checkpoint import save_checkpoint, load_checkpoint

    max_steps = int(job.get("max_steps", 4))
    run_id = str(job.get("run_id", ""))
    ckpt_dir = str(job.get("checkpoint_dir", "data/checkpoints"))
    resume_from = job.get("resume_from")  # type: ignore[assignment]

    steps_done = 0
    data_cursor = 0
    if resume_from:
        manifest = load_checkpoint(ckpt_dir, str(resume_from))
        if manifest is None:
            return {"state": "error", "error": f"resume 检查点不存在: {resume_from}"}
        steps_done = int(manifest.get("steps", 0))
        data_cursor = int(manifest.get("data_cursor", 0))

    samples = job.get("samples", []) or []
    new_steps = min(max_steps, max(1, len(samples)))
    steps_done += new_steps
    data_cursor += len(samples)
    manifest = save_checkpoint(
        ckpt_dir,
        {
            "run_id": run_id,
            "steps": steps_done,
            "data_cursor": data_cursor,
            "rng_state": f"dryrun:{steps_done}",
            "base_profile": job.get("base_profile", ""),
            "params_changed": new_steps > 0,
        },
    )
    return {
        "state": "ok",
        "steps": steps_done,
        "params_changed": new_steps > 0,
        "checkpoint_id": manifest["checkpoint_id"],
    }
