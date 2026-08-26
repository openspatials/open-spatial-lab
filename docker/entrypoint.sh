#!/usr/bin/env bash
set -euo pipefail

BACKEND_PID=""
FRONTEND_PID=""

stop() {
  trap - SIGINT SIGTERM
  for pid in "$FRONTEND_PID" "$BACKEND_PID"; do
    if [ -n "$pid" ] && kill -0 "$pid" >/dev/null 2>&1; then
      kill "$pid" >/dev/null 2>&1 || true
    fi
  done
  wait "$FRONTEND_PID" "$BACKEND_PID" 2>/dev/null || true
  exit 0
}
trap stop SIGINT SIGTERM

node src/orchestrator.js serve-backends &
BACKEND_PID=$!

node src/serve.js "${OSL_FRONTEND_PORT:-8143}" &
FRONTEND_PID=$!

# Exit (and let the container restart) if either process dies.
wait -n "$BACKEND_PID" "$FRONTEND_PID"
stop
