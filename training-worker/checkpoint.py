"""检查点清单（方案 §9.2 CHECKPOINT：参数、优化器、数据游标与 RNG 状态）。

目录结构：<checkpoint_dir>/<checkpoint_id>/{manifest.json, adapter.safetensors}
- dry-run 的 adapter 文件是协议占位（真实权重仅在目标机 qlora 模式产生）；
- manifest 是恢复的唯一依据（数据游标 + 步数 + RNG）。
"""

from __future__ import annotations

import json
import os
import uuid
from typing import Dict, Optional


def save_checkpoint(checkpoint_dir: str, fields: Dict[str, object]) -> Dict[str, object]:
    checkpoint_id = f"ckpt_{uuid.uuid4().hex[:12]}"
    path = os.path.join(checkpoint_dir, checkpoint_id)
    os.makedirs(path, exist_ok=True)
    manifest = {
        "checkpoint_id": checkpoint_id,
        **fields,
        "completed_at": __import__("datetime").datetime.now(
            __import__("datetime").timezone.utc
        ).isoformat(),
    }
    with open(os.path.join(path, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=1)
    # dry-run 占位 adapter（真实 NF4 权重不得直接当 GGUF 发布 §9.5）
    with open(os.path.join(path, "adapter.safetensors"), "wb") as f:
        f.write(b"dry-run adapter placeholder; real weights require qlora mode on target machine")
    return manifest


def load_checkpoint(checkpoint_dir: str, checkpoint_id: str) -> Optional[Dict[str, object]]:
    manifest_path = os.path.join(checkpoint_dir, checkpoint_id, "manifest.json")
    if not os.path.exists(manifest_path):
        return None
    with open(manifest_path, "r", encoding="utf-8") as f:
        return json.load(f)  # type: ignore[no-any-return]


def latest_checkpoint(checkpoint_dir: str) -> Optional[Dict[str, object]]:
    if not os.path.isdir(checkpoint_dir):
        return None
    best: Optional[Dict[str, object]] = None
    for name in sorted(os.listdir(checkpoint_dir)):
        manifest = load_checkpoint(checkpoint_dir, name)
        if manifest is None:
            continue
        if best is None or str(manifest.get("completed_at", "")) > str(best.get("completed_at", "")):
            best = manifest
    return best
