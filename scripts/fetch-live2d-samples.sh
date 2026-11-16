#!/usr/bin/env bash
# 拉取 Live2D 官方开源示例角色模型到本地数据目录（桌宠 Live2D 渲染的形象来源）。
#
# 用法：
#   scripts/fetch-live2d-samples.sh              # 默认拉 Hiyori
#   scripts/fetch-live2d-samples.sh Mao Rice     # 拉多个（Haru/Mao/Mark/Natori/Ren/Rice/Wanko）
#
# 来源：Live2D 官方开源仓库 CubismWebSamples（github.com/Live2D/CubismWebSamples），
#       经 jsdelivr CDN 分发；角色素材适用 Live2D Free Material License Agreement
#       （仅限本地/学习用途；商用或公开分发前自行核对素材许可）。
# 安装位置：$DAFEIYU_DATA_DIR（缺省 <仓库>/data）/models/<模型名>/ —— data/ 已 gitignore，
#       模型不入仓库；重跑覆盖更新。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA_DIR="${DAFEIYU_DATA_DIR:-$REPO_ROOT/data}"
MODELS_DIR="$DATA_DIR/models"
LISTING_URL="https://data.jsdelivr.com/v1/packages/gh/Live2D/CubismWebSamples@master?structure=flat"
# CDN 镜像按序回退（本机网络对 cdn.jsdelivr.net/raw.githubusercontent 的 TLS 可能被干扰）
MIRRORS=("https://fastly.jsdelivr.net/gh" "https://gcore.jsdelivr.net/gh" "https://cdn.jsdelivr.net/gh")

fetch() { # fetch <path> <target>
  local path="$1" target="$2" m
  for m in "${MIRRORS[@]}"; do
    if curl -sfL --retry 2 --max-time 60 "$m/Live2D/CubismWebSamples@master/$path" -o "$target"; then return 0; fi
  done
  echo "下载失败：$path"; return 1
}

command -v curl >/dev/null || { echo "需要 curl"; exit 1; }
command -v jq >/dev/null || { echo "需要 jq"; exit 1; }

MODELS=("$@")
[ ${#MODELS[@]} -eq 0 ] && MODELS=(Hiyori)

LISTING="$(mktemp -t dafeiyu-l2d-listing)"
trap 'rm -f "$LISTING"' EXIT
echo "获取示例清单…"
curl -sfL --retry 3 "$LISTING_URL" -o "$LISTING"

mkdir -p "$MODELS_DIR"
for MODEL in "${MODELS[@]}"; do
  DEST="$MODELS_DIR/$MODEL"
  PREFIX="/Samples/Resources/$MODEL/"
  COUNT=$(jq -r --arg p "$PREFIX" '[.files[].name | select(startswith($p))] | length' "$LISTING")
  if [ "$COUNT" -eq 0 ]; then
    echo "未找到模型 ${MODEL}（可用：Haru Hiyori Mao Mark Natori Ren Rice Wanko）"; exit 1
  fi
  echo "安装 ${MODEL}（$COUNT 个文件）→ $DEST"
  mkdir -p "$DEST"
  jq -r --arg p "$PREFIX" '.files[].name | select(startswith($p)) | ltrimstr($p)' "$LISTING" | while IFS= read -r REL; do
    TARGET="$DEST/$REL"
    mkdir -p "$(dirname "$TARGET")"
    fetch "Samples/Resources/$MODEL/$REL" "$TARGET" || exit 1
  done
  cat > "$DEST/manifest.json" << EOF
{
  "name": "${MODEL}（Live2D 官方示例）",
  "source": "Live2D CubismWebSamples（github.com/Live2D/CubismWebSamples，经 jsdelivr）",
  "license": "Live2D Free Material License Agreement"
}
EOF
  echo "完成：${MODEL}（manifest 已写入；许可限本地/学习用途）"
done

echo "提示：刷新 Web 面板「直播预览」页签，桌宠将自动改用 Live2D 渲染（未安装时回退内置形象）。"
