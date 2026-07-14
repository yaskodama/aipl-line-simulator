#!/usr/bin/env bash
# =============================================================================
# run.sh — AIPL 3D ライン作業シミュレータ (Yahboom DOFBOT 6DOF) 起動スクリプト
#   実機 DOFBOT 相当の 6 軸アーム / 12 Xinu / Capability 推論 / Pick&Place を
#   ブラウザで開く。HTTP サーバを nohup で常駐させ、ターミナルを閉じても継続する。
#
# 使い方:
#   ./run.sh            … サーバ起動 + ブラウザで開く（既定）
#   ./run.sh start      … サーバ起動 + 画面を開く
#   ./run.sh open       … 画面をブラウザで開くだけ（起動済みなら）
#   ./run.sh stop       … サーバ停止
#   ./run.sh restart    … 再起動
#   ./run.sh status     … 稼働状態を表示
#   PORT=9000 ./run.sh  … 別ポートで起動
# =============================================================================
set -euo pipefail

PORT="${PORT:-8022}"
FILE="index.html"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"   # このスクリプトのある場所 = 配信ルート
URL="http://localhost:${PORT}/${FILE}"
LOG="${DIR}/.run.log"

is_up() { curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/${FILE}" 2>/dev/null | grep -q 200; }

open_browser() {
  if   command -v open     >/dev/null 2>&1; then open "$URL"          # macOS
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL"      # Linux
  else echo "ブラウザで開いてください: $URL"; fi
}

do_stop() {
  local pids; pids="$(lsof -ti:"$PORT" 2>/dev/null || true)"
  if [ -n "$pids" ]; then echo "$pids" | xargs kill -9 2>/dev/null || true; echo "[dofbot-sim] 停止しました (port ${PORT})"; else echo "[dofbot-sim] 稼働中のサーバはありません"; fi
}

do_start() {
  if is_up; then
    echo "[dofbot-sim] 既に稼働中 → $URL"
  else
    echo "[dofbot-sim] サーバ起動中 (port ${PORT}) …"
    ( cd "$DIR" && nohup python3 -m http.server "$PORT" --bind 127.0.0.1 >"$LOG" 2>&1 & )
    for _ in 1 2 3 4 5 6 7 8 9 10; do is_up && break; sleep 0.3; done
    is_up && echo "[dofbot-sim] 起動 → $URL" || { echo "[dofbot-sim] 起動失敗。ログ: $LOG"; exit 1; }
  fi
  open_browser
}

case "${1:-start}" in
  start|"") do_start ;;
  open)     is_up && open_browser || { echo "[dofbot-sim] 未起動です。'./run.sh start' で起動してください"; exit 1; } ;;
  stop)     do_stop ;;
  restart)  do_stop; sleep 1; do_start ;;
  status)   is_up && echo "[dofbot-sim] 稼働中 → $URL" || echo "[dofbot-sim] 停止"; ;;
  *)        echo "使い方: $0 {start|open|stop|restart|status}   (PORT=9000 で別ポート)"; exit 1 ;;
esac
