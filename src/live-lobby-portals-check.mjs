import assert from "node:assert/strict";

const url = process.env.OSL_LOBBY_DEBUG_URL
  || "http://127.0.0.1:8143/api/lobby/debug/state";
const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
assert.equal(response.status, 200, `live lobby debug endpoint returned HTTP ${response.status}`);

const state = await response.json();
assert.equal(state?.location?.location_id, "location-lobby", "endpoint must be the live lobby runtime");

const portalIds = Array.isArray(state?.portals)
  ? state.portals.map((portal) => portal?.portal_id)
  : [];
assert.deepEqual(
  portalIds,
  ["lobby-portal-a", "lobby-portal-b", "lobby-portal-c"],
  "live lobby must expose Portal A, Portal B, and Portal C"
);

console.log(JSON.stringify({
  result: "PASS",
  source: "live-running-lobby-debug-endpoint",
  url,
  location_id: state.location.location_id,
  portal_count: portalIds.length,
  portal_ids: portalIds,
}, null, 2));
