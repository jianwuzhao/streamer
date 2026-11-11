"""GGUF 导出守卫（方案 §9.5）。

- 训练用 NF4 权重不能直接当作 GGUF 发布；
- 正确流程：原始基础权重加载 adapter → 合并 → 转换 → 量化 → 重测
  （质量/工具契约/显存/延迟/安全边界）→ 才可进入发布门；
- 本模块在目标机提供 CLI；依赖缺席时明确报错，不产出伪 GGUF。
"""

from __future__ import annotations


class ExportDependencyError(RuntimeError):
    pass


def export_gguf(adapter_dir: str, base_weights_dir: str, out_path: str) -> str:
    for pkg in ("torch", "transformers", "gguf"):
        try:
            __import__(pkg)
        except ImportError as exc:
            raise ExportDependencyError(
                f"GGUF 导出依赖缺失（{pkg}）。目标机执行: pip install -e training-worker；"
                "并准备匹配的原始基础权重（NF4 权重不得直接转换 §9.5）"
            ) from exc

    # 真实流程（目标机启用）：
    # 1) 以 bfloat16 加载原始基础权重 + adapter（LoRA merge_and_unload）
    # 2) convert_hf_to_gguf.py 转换 → 目标量化（如 Q4_K_M）
    # 3) 哈希登记产物；量化后必须重测五项（§9.5）才可发布
    raise ExportDependencyError("导出实现需在目标机启用（本仓库不含合并/转换的实机路径）")
