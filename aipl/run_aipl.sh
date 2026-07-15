#!/usr/bin/env bash
# =============================================================================
# run_aipl.sh —— dofbot_xinu.abcl を本物の AIPL 処理系で実行する
#
#   ./aipl/run_aipl.sh              … 実行（実機非接続。サーボ指令をログ出力）
#   ./aipl/run_aipl.sh check        … 型検査 + 効果検査のみ
#   ./aipl/run_aipl.sh quiet        … サーボ指令を伏せて認識結果だけ見る
#
# 実機の DOFBOT を動かす場合:
#   DOFBOT_BACKEND=armlib ./aipl/run_aipl.sh          # DOFBOT の Raspberry Pi 上で
#   DOFBOT_BACKEND=http DOFBOT_URL=http://<ip>:8080 ./aipl/run_aipl.sh   # LAN 越し
# ソースは 1 行も変えずに実機のバスサーボが回る。
# =============================================================================
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
AIPL="${AIPL_HOME:-$HOME/ocaml-app/abclcp-project/src/python-aipl}"

if [[ ! -f "$AIPL/aipl_main.py" ]]; then
  echo "AIPL 処理系が見つかりません: $AIPL" >&2
  echo "AIPL_HOME=/path/to/abclcp-project/src/python-aipl を指定してください。" >&2
  exit 1
fi
if [[ ! -f "$ROOT/rl/dataset.json" ]]; then
  echo "手首カメラのフレームがありません。先に取得してください:" >&2
  echo "  node rl/capture_dataset.mjs" >&2
  exit 1
fi

export PYTHONIOENCODING=utf-8
export DOFBOT_FRAMES="$ROOT/rl/dataset.json"       # 手首カメラの実レンダ画像
export DOFBOT_MODEL="$ROOT/aipl/tinyml_model.json" # 学習済み TinyML の重み

cd "$AIPL"
case "${1:-run}" in
  check) exec python3 aipl_main.py "$ROOT/aipl/dofbot_xinu.abcl" --type-check --timeout 1 ;;
  quiet) DOFBOT_QUIET=1 exec python3 aipl_main.py "$ROOT/aipl/dofbot_xinu.abcl" --timeout 120 ;;
  *)     exec python3 aipl_main.py "$ROOT/aipl/dofbot_xinu.abcl" --timeout 120 ;;
esac
