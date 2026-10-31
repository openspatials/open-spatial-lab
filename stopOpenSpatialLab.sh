#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_DIR="${OSL_RUN_DIR:-$ROOT/.runtime}"
QUIET="${1:-}"

owned_pid() {
  local pid="$1"
  local cwd
  kill -0 "$pid" >/dev/null 2>&1 || return 1
  cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)"
  [ "$cwd" = "$ROOT" ]
}

for file in "$RUN_DIR/world-servers.pid" "$RUN_DIR/frontend.pid"; do
  if [ ! -f "$file" ]; then continue; fi
  pid="$(tr -cd '0-9' < "$file" || true)"
  if [ -n "$pid" ] && owned_pid "$pid"; then
    kill "$pid" >/dev/null 2>&1 || true
  fi
done

for _ in {1..80}; do
  alive=0
  for file in "$RUN_DIR/world-servers.pid" "$RUN_DIR/frontend.pid"; do
    [ -f "$file" ] || continue
    pid="$(tr -cd '0-9' < "$file" || true)"
    if [ -n "$pid" ] && owned_pid "$pid"; then alive=1; fi
  done
  [ "$alive" -eq 0 ] && break
  sleep 0.1
done

for file in "$RUN_DIR/world-servers.pid" "$RUN_DIR/frontend.pid"; do
  [ -f "$file" ] || continue
  pid="$(tr -cd '0-9' < "$file" || true)"
  if [ -n "$pid" ] && owned_pid "$pid"; then
    kill -9 "$pid" >/dev/null 2>&1 || true
  fi
  rm -f "$file"
done

# The ports to report on are the configured ones (worlds.json, or OSL_WORLDS).
CONFIGURED_PORTS="$(node "$ROOT/src/worlds-config.js" world-ports 2>/dev/null || true) $(node "$ROOT/src/worlds-config.js" frontend-port 2>/dev/null || true)"
rm -f "$RUN_DIR/launched-worlds.json"
for port in $CONFIGURED_PORTS; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    printf 'WARNING: port %s remains occupied by a process not owned by this checkout.\n' "$port" >&2
  fi
done

if [ "$QUIET" != "--quiet" ]; then
  printf 'Open Spatial Lab stopped. Configured frontend and world-server ports are released.\n'
fi
