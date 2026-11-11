"""worker 单元测试（纯标准库；dry-run 路径不依赖 torch）。

运行：python3 -m unittest discover -s training-worker -p 'test_*.py' -v
"""

from __future__ import annotations

import datetime
import json
import os
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from checkpoint import load_checkpoint, save_checkpoint  # noqa: E402
from states import dry_run_slice, run_state_machine  # noqa: E402
from worker import validate_decision  # noqa: E402

WORKER_DIR = os.path.dirname(os.path.abspath(__file__))


def future_iso(seconds: int = 3600) -> str:
    return (
        datetime.datetime.now(datetime.timezone.utc)
        + datetime.timedelta(seconds=seconds)
    ).isoformat().replace("+00:00", "Z")


def make_job(**over) -> dict:
    base = {
        "run_id": "run_test",
        "mode": "dry_run",
        "base_profile": "main-4b",
        "max_steps": 4,
        "wall_budget_s": 60,
        "samples": [{"text": f"样本 {i}"} for i in range(8)],
        "replay_fraction": 0.7,
        "checkpoint_dir": tempfile.mkdtemp(prefix="ckpt-"),
        "resume_from": None,
        "decision": {
            "id": "dec_1",
            "action": "train",
            "payloadHash": "h",
            "epoch": 0,
            "expiresAt": future_iso(),
            "result": "allow",
        },
    }
    base.update(over)
    return base


class CheckpointTests(unittest.TestCase):
    def test_roundtrip_and_resume(self) -> None:
        d = tempfile.mkdtemp(prefix="ckpt-")
        m1 = save_checkpoint(d, {"run_id": "r", "steps": 2, "data_cursor": 8, "rng_state": "cpu:2"})
        loaded = load_checkpoint(d, m1["checkpoint_id"])
        assert loaded is not None
        self.assertEqual(loaded["steps"], 2)
        self.assertEqual(loaded["data_cursor"], 8)
        # adapter 占位文件存在（协议完整性）
        self.assertTrue(
            os.path.exists(os.path.join(d, m1["checkpoint_id"], "adapter.safetensors"))
        )

    def test_missing_returns_none(self) -> None:
        d = tempfile.mkdtemp(prefix="ckpt-")
        self.assertIsNone(load_checkpoint(d, "ckpt_nope"))


class DryRunTests(unittest.TestCase):
    def test_slice_and_resume_accumulates_steps(self) -> None:
        job = make_job(max_steps=4)
        r1 = dry_run_slice(job)
        self.assertEqual(r1["state"], "ok")
        self.assertEqual(r1["steps"], 4)
        # 恢复：从上一检查点续跑
        job2 = make_job(max_steps=3, resume_from=r1["checkpoint_id"], checkpoint_dir=job["checkpoint_dir"])
        r2 = dry_run_slice(job2)
        self.assertEqual(r2["steps"], 7)  # 4 + 3
        self.assertTrue(r2["params_changed"])

    def test_resume_missing_checkpoint_fails(self) -> None:
        job = make_job(resume_from="ckpt_missing")
        r = dry_run_slice(job)
        self.assertEqual(r["state"], "error")


class StateMachineTests(unittest.TestCase):
    def test_order_and_receipt(self) -> None:
        job = make_job()
        events: list[str] = []

        class Recorder:  # 捕获 emit
            pass

        import states

        original = states.emit

        def spy(payload):
            events.append(json.dumps(payload, ensure_ascii=False))
            original(payload)

        states.emit = spy
        try:
            receipt = run_state_machine(job, dry_run_slice)
        finally:
            states.emit = original
        order = [json.loads(e)["state"] for e in events if '"state"' in e and '"receipt"' not in e]
        self.assertEqual(
            order,
            ["prepare_cpu", "drain_gpu", "train_slice", "checkpoint", "release_gpu", "warmup_champion"],
        )
        self.assertEqual(receipt["state"], "completed")
        self.assertEqual(receipt["steps"], 4)


class DecisionTests(unittest.TestCase):
    def test_valid(self) -> None:
        self.assertIsNone(validate_decision(make_job()))

    def test_expired(self) -> None:
        job = make_job()
        job["decision"]["expiresAt"] = "2000-01-01T00:00:00Z"
        self.assertIn("过期", validate_decision(job))

    def test_wrong_action(self) -> None:
        job = make_job()
        job["decision"]["action"] = "publish"
        self.assertIn("train", validate_decision(job))


class EndToEndTests(unittest.TestCase):
    def test_worker_process_dry_run(self) -> None:
        job = json.dumps(make_job(), ensure_ascii=False)
        proc = subprocess.run(
            [sys.executable, "worker.py"],
            input=job,
            capture_output=True,
            text=True,
            cwd=WORKER_DIR,
            timeout=30,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        lines = [json.loads(l) for l in proc.stdout.splitlines() if l.strip()]
        receipt = [l for l in lines if l.get("type") == "receipt"]
        self.assertEqual(len(receipt), 1)
        self.assertEqual(receipt[0]["state"], "completed")
        self.assertEqual(receipt[0]["steps"], 4)

    def test_worker_rejects_unauthorized(self) -> None:
        job = make_job()
        job["decision"]["result"] = "deny"
        proc = subprocess.run(
            [sys.executable, "worker.py"],
            input=json.dumps(job),
            capture_output=True,
            text=True,
            cwd=WORKER_DIR,
            timeout=30,
        )
        self.assertEqual(proc.returncode, 2)

    def test_worker_qlora_reports_missing_deps(self) -> None:
        try:
            import torch  # noqa: F401
            self.skipTest("本机存在 torch，跳过依赖缺失路径")
        except ImportError:
            pass
        job = make_job(mode="qlora")
        proc = subprocess.run(
            [sys.executable, "worker.py"],
            input=json.dumps(job),
            capture_output=True,
            text=True,
            cwd=WORKER_DIR,
            timeout=30,
        )
        self.assertEqual(proc.returncode, 3)
        self.assertIn("依赖缺失", proc.stdout)


if __name__ == "__main__":
    unittest.main()
