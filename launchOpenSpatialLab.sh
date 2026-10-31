#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_DIR="${OSL_RUN_DIR:-$ROOT/.runtime}"
BACKEND_PID="$RUN_DIR/world-servers.pid"
FRONTEND_PID="$RUN_DIR/frontend.pid"
BACKEND_LOG="$RUN_DIR/world-servers.log"
FRONTEND_LOG="$RUN_DIR/frontend.log"

for command in node npm curl lsof; do
  if ! command -v "$command" >/dev/null 2>&1; then
    printf 'ERROR: required command is unavailable: %s\n' "$command" >&2
    exit 1
  fi
done

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
NPM_MAJOR="$(npm --version | cut -d. -f1)"
if [ "$NODE_MAJOR" != "22" ] || [ "$NPM_MAJOR" != "10" ]; then
  printf 'ERROR: Open Spatial Lab requires Node.js 22.x and npm 10.x (found Node %s, npm %s).\n' \
    "$(node --version)" "$(npm --version)" >&2
  exit 1
fi

# The worlds and their ports come from the worlds configuration (worlds.json, or the file named by
# OSL_WORLDS). A world listed there is launched; there is no second list of ports in this script.
WORLDS_FILE="$(node "$ROOT/src/worlds-config.js" file)" || exit 1
FRONTEND_PORT="$(node "$ROOT/src/worlds-config.js" frontend-port)" || exit 1
WORLD_PORTS_LINE="$(node "$ROOT/src/worlds-config.js" world-ports)" || exit 1
read -r -a WORLD_PORTS <<< "$WORLD_PORTS_LINE"
PORTS=("${WORLD_PORTS[@]}" "$FRONTEND_PORT")

mkdir -p "$RUN_DIR"
export OSL_RUN_DIR="$RUN_DIR"
export OSL_WORLDS="$WORLDS_FILE"
bash "$ROOT/stopOpenSpatialLab.sh" --quiet
rm -f "$RUN_DIR/launched-worlds.json"

for port in "${PORTS[@]}"; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    printf 'ERROR: port %s is already in use by another application.\n' "$port" >&2
    exit 1
  fi
done

node "$ROOT/tools/start-detached.mjs" "$BACKEND_PID" "$BACKEND_LOG" env \
  OSL_WOW_VALIDATE=1 node src/orchestrator.js serve-backends

node "$ROOT/tools/start-detached.mjs" "$FRONTEND_PID" "$FRONTEND_LOG" \
  node src/serve.js "$FRONTEND_PORT"

cleanup_on_error() {
  bash "$ROOT/stopOpenSpatialLab.sh" --quiet || true
}
trap cleanup_on_error ERR

for port in "${PORTS[@]}"; do
  ready=0
  for _ in {1..120}; do
    if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then ready=1; break; fi
    sleep 0.1
  done
  if [ "$ready" -ne 1 ]; then
    printf 'ERROR: service did not become ready on port %s. See %s.\n' "$port" "$RUN_DIR" >&2
    exit 1
  fi
done

# OSL_BIND_HOST is the address every server binds to (default 127.0.0.1). Placement mode and its write
# routes are on only when it is 127.0.0.1 AND the opt-in setting OSL_PLACEMENT_WRITES is 1 (off by default);
# otherwise placed portals are served read-only.
PROBE_HOST="${OSL_BIND_HOST:-127.0.0.1}"
case "$PROBE_HOST" in 0.0.0.0|::|"") PROBE_HOST=127.0.0.1 ;; esac
if [ "$(curl -sS -o /dev/null -w '%{http_code}' "http://$PROBE_HOST:$FRONTEND_PORT/")" != "200" ]; then
  printf 'ERROR: launcher did not return HTTP 200. See %s.\n' "$FRONTEND_LOG" >&2
  exit 1
fi

trap - ERR
printf '\nOpen Spatial Lab is ready.\n'
printf 'Launcher:            http://127.0.0.1:%s/\n' "$FRONTEND_PORT"
printf 'Lobby player:        http://127.0.0.1:%s/index.html?role=player&intro=bypass\n' "$FRONTEND_PORT"
printf 'Location A observer: http://127.0.0.1:%s/index.html?role=source&intro=bypass\n' "$FRONTEND_PORT"
printf 'Location B observer: http://127.0.0.1:%s/index.html?role=target&intro=bypass\n' "$FRONTEND_PORT"
printf 'Worlds (from %s):\n' "$WORLDS_FILE"
node -e 'const { loadWorlds } = require(process.argv[1]); for (const w of loadWorlds().worlds) console.log("  " + (w.name + ":").padEnd(19) + w.address + "  player: http://127.0.0.1:" + process.argv[2] + "/index.html?role=source&intro=bypass&wow=" + encodeURIComponent(w.address + "wow/spatial/1"));' "$ROOT/src/worlds-config.js" "$FRONTEND_PORT"
# Placement is on only when both hold: bound to 127.0.0.1, and the opt-in setting is 1 (off by default; this
# script never turns it on, it only reports what the caller's environment says).
if [ "${OSL_BIND_HOST:-127.0.0.1}" != "127.0.0.1" ]; then
  printf 'Placement:           OFF (servers bound to %s, not 127.0.0.1; placed portals are shown read-only)\n' "$OSL_BIND_HOST"
elif [ "${OSL_PLACEMENT_WRITES:-}" != "1" ]; then
  printf 'Placement:           OFF (the opt-in setting OSL_PLACEMENT_WRITES is not 1 in the environment this was started from; placed portals are shown read-only)\n'
else
  printf 'Placement:           ON (bound to 127.0.0.1, and the opt-in setting is on)\n'
fi
printf 'Check the worlds:    node tools/check-worlds.mjs\n'
printf 'Stop:                npm stop\n'
