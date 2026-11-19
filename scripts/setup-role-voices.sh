#!/usr/bin/env bash
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
runtime="${DAFEIYU_DATA_DIR:-$repo/data}/role-voices"
python="${DAFEIYU_VOICE_PYTHON:-python3.12}"
model="mlx-community/Qwen3-TTS-12Hz-0.6B-Base-4bit"
asset_base="https://upage.imtt.qq.com/m_imtt/gamebuddy/audio"

if [[ "$(uname -s)" != Darwin || "$(uname -m)" != arm64 ]]; then
  echo "本地参考音色需要 Apple Silicon Mac。" >&2
  exit 1
fi

mkdir -p "$runtime/references"
"$python" -m venv "$runtime/.venv"
"$runtime/.venv/bin/python" -m pip install --no-cache-dir 'mlx-audio==0.6.5'
HF_HUB_DISABLE_TELEMETRY=1 "$runtime/.venv/bin/hf" download "$model" --local-dir "$runtime/model"

for role in xiaxia lubai guyu beila; do
  slug="$role"
  [[ "$role" == lubai ]] && slug=shenlubai
  reference="$runtime/references/$role.wav"
  if [[ ! -s "$reference" ]]; then
    case "$role" in
      xiaxia) transcript='我们青铜才是高手最多的段位，大隐隐于市了解吗，嘿嘿。' ;;
      lubai) transcript='行吧，那些小妹妹好像是更可爱一点。诶，不会真不选我吧？' ;;
      guyu) transcript='赢了我陪你笑，输了我陪你待一会儿，或者我们干点别的什么也行，不着急。' ;;
      beila) transcript='这把输了下把赢回来，我们总不能一直输吧！' ;;
    esac
    temp="$(mktemp "$runtime/references/.reference.XXXXXX")"
    trap 'rm -f "$temp"' EXIT
    curl --fail --silent --show-error --location --max-time 30 "$asset_base/$slug.wav" --output "$temp"
    "$runtime/.venv/bin/python" -c 'import sys,wave; f=wave.open(sys.argv[1]); assert f.getnframes()>0' "$temp"
    mv "$temp" "$reference"
    if [[ ! -e "${reference%.wav}.txt" ]]; then
      printf '%s\n' "$transcript" > "${reference%.wav}.txt"
    fi
    trap - EXIT
  fi
done
echo "本地角色参考音色已准备好。"
