#!/usr/bin/env bash
set -euo pipefail

BACKEND_PID=""
FRONTEND_PID=""

# stop CODE: stop both processes, then exit with CODE.
stop() {
  local code="${1:-0}"
  trap - SIGINT SIGTERM
  for pid in "$FRONTEND_PID" "$BACKEND_PID"; do
    if [ -n "$pid" ] && kill -0 "$pid" >/dev/null 2>&1; then
      kill "$pid" >/dev/null 2>&1 || true
    fi
  done
  wait "$FRONTEND_PID" "$BACKEND_PID" 2>/dev/null || true
  exit "$code"
}
# A stop request from Docker is a clean exit (0).
trap 'stop 0' SIGINT SIGTERM

node src/orchestrator.js serve-backends &
BACKEND_PID=$!

node src/serve.js "${OSL_FRONTEND_PORT:-8143}" &
FRONTEND_PID=$!

echo "entrypoint: worlds say they live at ${OSL_PUBLIC_ORIGIN:-(OSL_PUBLIC_ORIGIN not set)}/w/{key}/; make that address reach port ${OSL_FRONTEND_PORT:-8143} of this container" >&2

# Lab adjustment: if either process dies, stop the other and exit NON-ZERO, so that
# "docker run --restart on-failure" (and any orchestrator) sees a failure and restarts the container.
status=0
wait -n "$BACKEND_PID" "$FRONTEND_PID" || status=$?
if [ "$status" -eq 0 ]; then status=1; fi
echo "entrypoint: a process exited (status $status); stopping the other and exiting with $status" >&2
stop "$status"
