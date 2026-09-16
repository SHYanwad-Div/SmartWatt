#!/usr/bin/env bash
# Smart Watt v2 - one-command start on Linux/macOS.
#   ./run.sh            synthetic data (no hardware)
#   ./run.sh both       simulator + real ESP32 over MQTT
#   ./run.sh mqtt       real hardware only
set -euo pipefail
cd "$(dirname "$0")"

SOURCE="${1:-sim}"
PORT="${SW_PORT:-8000}"

[ -f .env ] || cp .env.example .env
python3 -m pip install --quiet -r requirements.txt

if [ ! -f frontend/dist/index.html ]; then
  echo "Building dashboard (first run)..."
  (cd frontend && { [ -d node_modules ] || npm install --no-audit --no-fund; } && npm run build)
fi

echo
echo "Smart Watt v2 -> http://localhost:${PORT}   (source: ${SOURCE})"
echo "Sign in as home / home123 (homeowner) or utility / utility123 (read-only)."
SW_SOURCE="$SOURCE" SW_PORT="$PORT" exec python3 -m uvicorn app.main:app --app-dir backend --host 0.0.0.0 --port "$PORT"
