import assert from "node:assert/strict";
import { createRequire } from "node:module";

// The lobby's debug state must list Portal A, Portal B and Portal C. With OSL_LOBBY_DEBUG_URL set, the check reads
// a lab that is already running (for example http://127.0.0.1:8143/api/lobby/debug/state). Without it, the check
// starts its own lobby world server on a free port, so it never depends on a lab someone else keeps running.
const require = createRequire(import.meta.url);

let url = process.env.OSL_LOBBY_DEBUG_URL || null;
let built = null;
if (!url) {
  const { createServer } = require("../runtime/world-server/src/server.js");
  built = createServer("lobby", {});
  await new Promise((resolveListen, rejectListen) => {
    built.server.once("error", rejectListen);
    built.server.listen(0, "127.0.0.1", resolveListen);
  });
  url = `http://127.0.0.1:${built.server.address().port}/debug/state`;
}

try {
  const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200, `lobby debug endpoint returned HTTP ${response.status}`);

  const state = await response.json();
  assert.equal(state?.location?.location_id, "location-lobby", "endpoint must be the lobby runtime");

  const portalIds = Array.isArray(state?.portals)
    ? state.portals.map((portal) => portal?.portal_id)
    : [];
  assert.deepEqual(
    portalIds,
    ["lobby-portal-a", "lobby-portal-b", "lobby-portal-c"],
    "the lobby must expose Portal A, Portal B, and Portal C"
  );

  console.log(JSON.stringify({
    result: "PASS",
    source: built ? "own-lobby-world-server" : "running-lab-lobby-debug-endpoint",
    url,
    location_id: state.location.location_id,
    portal_count: portalIds.length,
    portal_ids: portalIds,
  }, null, 2));
} finally {
  if (built) await built.closeAll();
}
