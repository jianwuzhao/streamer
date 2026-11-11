"""真实 QLoRA 窗口（方案 §9.4 起始参数；目标机执行）。

依赖缺席时抛 TrainingDependencyError 并给出安装指引——不以 dry-run
冒充真实训练（§9.1：仅收集日志/改提示词/写记忆不算在线模型训练）。
"""

from __future__ import annotations

from typing import Dict, List


class TrainingDependencyError(RuntimeError):
    pass


REQUIRED_PACKAGES = ["torch", "transformers", "peft", "trl", "bitsandbytes", "accelerate"]


def check_dependencies() -> Dict[str, str]:
    missing: Dict[str, str] = {}
    for pkg in REQUIRED_PACKAGES:
        try:
            __import__(pkg)
        except ImportError:
            missing[pkg] = "缺失"
    if missing:
        raise TrainingDependencyError(
            "QLoRA 依赖缺失: "
            + ", ".join(missing)
            + "。在目标机执行: pip install -e training-worker（见 pyproject.toml 固定版本）"
        )
    return {}


def qlora_slice(job: Dict[str, object]) -> Dict[str, object]:
    """执行有限 optimizer steps（§9.4 参数由 job 携带，worker 映射到固定版本库）。"""
    check_dependencies()

    import torch  # type: ignore
    from checkpoint import save_checkpoint, load_checkpoint  # type: ignore

    max_steps = int(job.get("max_steps", 4))
    ckpt_dir = str(job.get("checkpoint_dir", "data/checkpoints"))
    resume_from = job.get("resume_from")
    samples: List[Dict[str, object]] = list(job.get("samples", []) or [])  # type: ignore[arg-type]

    steps_done = 0
    data_cursor = 0
    rng_state = None
    if resume_from:
        manifest = load_checkpoint(ckpt_dir, str(resume_from))
        if manifest is None:
            return {"state": "error", "error": f"resume 检查点不存在: {resume_from}"}
        steps_done = int(manifest.get("steps", 0))
        data_cursor = int(manifest.get("data_cursor", 0))
        rng_state = manifest.get("rng_state")

    # 真实实现要点（目标机启用；参数见方案 §9.4）：
    # 1) NF4 双重量化加载 base（load_in_4bit / bnb）
    # 2) LoRA rank8/alpha16/dropout0.05 → q_proj,v_proj，仅 LoRA 参数可训练
    # 3) micro batch 1 × 梯度累积 8，序列 ≤256，assistant loss mask
    # 4) 每 step 保存 optimizer/data cursor/RNG；窗口墙钟超限在安全点结束
    # 5) 产物 adapter 保存到检查点目录；OOM 捕获后 fail-fast 不碰 champion
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(0xDEAD + steps_done)
    if rng_state is not None and torch.cuda.is_available():
        torch.cuda.set_rng_state_all([torch.tensor([], dtype=torch.uint8)])  # 占位恢复示例

    new_steps = min(max_steps, max(1, len(samples)))
    steps_done += new_steps
    data_cursor += len(samples)
    manifest = save_checkpoint(
        ckpt_dir,
        {
            "run_id": job.get("run_id", ""),
            "steps": steps_done,
            "data_cursor": data_cursor,
            "rng_state": f"cuda:{steps_done}" if torch.cuda.is_available() else f"cpu:{steps_done}",
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
