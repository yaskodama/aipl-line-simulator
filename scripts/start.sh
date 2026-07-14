#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-8080}"
cd "$ROOT"
URL="http://localhost:${PORT}"
echo "AIPL 3D Line Simulator"
echo "Open: $URL"
if command -v open >/dev/null 2>&1; then
  (sleep 1; open "$URL") >/dev/null 2>&1 &
fi
python3 -m http.server "$PORT"
