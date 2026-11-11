"""训练 worker 入口（方案 §9 / §11 授权）。

用法：python3 worker.py < job.json
- stdin：完整 TrainingJobSpec JSON（含 decision 授权）
- stdout：按行 JSON（state / receipt）
- 退出码：0 成功；2 授权不通过；3 依赖缺失；4 任务非法

外部 worker 必须显式携带身份和授权，不依赖进程本地上下文继承（§17）。
"""

from __future__ import annotations

import datetime
import json
import sys
from typing import Dict

from states import dry_run_slice, emit, run_state_machine


def _parse_expires(raw: str) -> datetime.datetime:
    return datetime.datetime.fromisoformat(raw.replace("Z", "+00:00"))


def validate_decision(job: Dict[str, object]) -> str | None:
    decision = job.get("decision")
    if not isinstance(decision, dict):
        return "缺少 decision"
    if decision.get("action") != "train":
        return f"action 非 train: {decision.get('action')}"
    if decision.get("result") != "allow":
        return f"决策非 allow: {decision.get('result')}"
    try:
        expires = _parse_expires(str(decision.get("expiresAt", "")))
    except ValueError:
        return "expiresAt 非法"
    if datetime.datetime.now(datetime.timezone.utc) >= expires:
        return "授权已过期"
    return None


def main() -> int:
    try:
        job = json.loads(sys.stdin.read())
    except json.JSONDecodeError as exc:
        emit({"type": "error", "error": f"job JSON 非法: {exc}"})
        return 4

    reason = validate_decision(job)
    if reason is not None:
        emit({"type": "error", "error": f"授权不通过: {reason}"})
        return 2

    mode = job.get("mode", "dry_run")
    try:
        if mode == "qlora":
            from qlora_slice import qlora_slice as slice_fn
        else:
            slice_fn = dry_run_slice
        receipt = run_state_machine(job, slice_fn)
    except ImportError as exc:
        receipt = {
            "type": "receipt",
            "run_id": job.get("run_id", ""),
            "steps": 0,
            "params_changed": False,
            "checkpoint_id": "",
            "state": "failed",
            "error": f"依赖缺失: {exc}",
        }
    except RuntimeError as exc:  # TrainingDependencyError 等
        receipt = {
            "type": "receipt",
            "run_id": job.get("run_id", ""),
            "steps": 0,
            "params_changed": False,
            "checkpoint_id": "",
            "state": "failed",
            "error": str(exc),
        }
    emit(receipt)
    return 0 if receipt.get("state") == "completed" else 3  # type: ignore[union-attr]


if __name__ == "__main__":
    sys.exit(main())
