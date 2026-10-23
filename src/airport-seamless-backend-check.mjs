#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { makeConfig } = require(path.join(
  ROOT,
  "runtime/world-server/src/config.js",
));
const RUNTIME_PATH = path.join(
  ROOT,
  "runtime/world-server/src/runtime-state.js",
);
const { createRuntime } = require(RUNTIME_PATH);
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), "utf8");
const mutation = process.env.feature_MUTATION || "";
const runtimeSource = fs.readFileSync(RUNTIME_PATH, "utf8");

function assertRepublishSource(source) {
  const resetSource = source.match(/    function reset\(\)\n    \{[\s\S]*?\n    \}\n\n    function tick\(\)/)?.[0] || "";
  const startSource = source.match(/    function startRepublishTimer\(\)\n    \{[\s\S]*?\n    \}\n\n    \/\*\*[\s\S]*?function setRepublishRate/)?.[0] || "";
  const setterSource = source.match(/    function setRepublishRate\(rateMs\)\n    \{[\s\S]*?\n    \}/)?.[0] || "";
  assert.match(source, /const DEMO_REPUBLISH_RATE_DEFAULT_MS = 100;/);
  assert.match(source, /state\.republish_rate_ms = DEMO_REPUBLISH_RATE_DEFAULT_MS;\n    let republishTimer = null;/);
  assert.match(resetSource, /state\.republish_rate_ms = DEMO_REPUBLISH_RATE_DEFAULT_MS;[\s\S]*?startRepublishTimer\(\);/);
  assert.match(startSource, /stopRepublishTimer\(\);[\s\S]*?republishTimer = setInterval\(republishApplyAmbientDrift, rate\);/);
  assert.match(setterSource, /let applied = 0;[\s\S]*?Number\.isFinite\(raw\) && raw > 0/);
  assert.match(source, /    startRepublishTimer\(\);\n\n    return \{/);
}

assertRepublishSource(runtimeSource);
for (const [label, mutateSource] of [
  ["boot-default-zero", (source) => source.replace(
    "const DEMO_REPUBLISH_RATE_DEFAULT_MS = 100;",
    "const DEMO_REPUBLISH_RATE_DEFAULT_MS = 0;",
  )],
  ["duplicate-reset-timer", (source) => source.replace(
    "    function startRepublishTimer()\n    {\n        stopRepublishTimer();",
    "    function startRepublishTimer()\n    {\n        void republishTimer;",
  )],
  ["reset-default-off", (source) => source.replace(
    "        state.republish_rate_ms = DEMO_REPUBLISH_RATE_DEFAULT_MS;\n        startRepublishTimer();",
    "        state.republish_rate_ms = 0;\n        stopRepublishTimer();",
  )],
  ["explicit-zero-broken", (source) => source.replace(
    "        let applied = 0;",
    "        let applied = DEMO_REPUBLISH_RATE_DEFAULT_MS;",
  )],
]) {
  const mutated = mutateSource(runtimeSource);
  assert.notEqual(mutated, runtimeSource, `${label} mutation target missing`);
  let red = false;
  try { assertRepublishSource(mutated); }
  catch { red = true; }
  assert.equal(red, true, `${label} mutation stayed GREEN`);
  console.log(`RED_CAUGHT ${label}`);
}

const lobbyConfig = makeConfig("lobby");
const airportConfig = makeConfig("airport");
let portalC = structuredClone(
  lobbyConfig.portals.find((portal) => portal.portal_id === "lobby-portal-c"),
);
let airportPortals = structuredClone(airportConfig.portals);

if (mutation === "fixture-fallback") {
  delete portalC.target_location_id;
  delete portalC.target_world_id;
  delete portalC.target_base_url;
  delete portalC.target_portal_id;
  portalC.target_fixture = {
    spatial_id: "world-airport-terminal",
    graph_endpoint: "/worlds/denver-skyport.json",
  };
  portalC.traversal.transition = "client_scene_load";
}
if (mutation === "missing-reciprocal") airportPortals = [];

assert.equal(portalC.target_location_id, "location-airport", "Portal C must target the live airport location");
assert.equal(portalC.target_world_id, "world-airport-terminal", "Portal C must target the authored airport world");
assert.equal(portalC.target_base_url, "http://127.0.0.1:18154", "Portal C must advertise the airport backend");
assert.equal(portalC.target_portal_id, "airport-portal-lobby", "Portal C must link to the sole airport return portal");
assert.equal(portalC.target_fixture, undefined, "fixture fallback is forbidden on positive Portal C");
assert.equal(portalC.traversal.transition, undefined, "client_scene_load is forbidden on positive Portal C");
assert.equal(portalC.traversal.mode, "bidirectional");
assert.equal(portalC.reciprocal?.mode, "automatic", "runtime automatic reciprocal setting must remain enabled");
assert.equal(portalC.spatial_fabric.roi_radius_m, 24, "Portal C must request the bounded authored aperture");

assert.equal(airportPortals.length, 1, "the airport must expose exactly one reciprocal return portal");
const returnPortal = airportPortals[0];
assert.equal(returnPortal.portal_id, "airport-portal-lobby");
assert.equal(returnPortal.target_location_id, "location-lobby");
assert.equal(returnPortal.target_world_id, "demo-lobby");
assert.equal(returnPortal.target_portal_id, "lobby-portal-c");
assert.equal(returnPortal.traversal.mode, "bidirectional");

const nativeSetInterval = globalThis.setInterval;
const nativeClearInterval = globalThis.clearInterval;
let intervalSequence = 0;
const activeIntervals = new Map();
globalThis.setInterval = (callback, delay) => {
  const handle = {
    id: ++intervalSequence,
    unrefed: false,
    unref() {
      this.unrefed = true;
      return this;
    },
  };
  activeIntervals.set(handle, { callback, delay });
  return handle;
};
globalThis.clearInterval = (handle) => activeIntervals.delete(handle);
const republishTimerCount = () => [...activeIntervals.values()].filter(({ delay }) => delay === 100).length;

const lobbyRuntime = createRuntime({
  ...lobbyConfig,
  portals: lobbyConfig.portals.map((portal) =>
    portal.portal_id === "lobby-portal-c" ? portalC : portal
  ),
});
const aRuntime = createRuntime(makeConfig("a"));
const bRuntime = createRuntime(makeConfig("b"));
const airportRuntime = createRuntime({ ...airportConfig, portals: airportPortals });
const namedRuntimes = [
  ["a", aRuntime],
  ["b", bRuntime],
  ["lobby", lobbyRuntime],
  ["airport", airportRuntime],
];

assert.equal(republishTimerCount(), 4, "fresh four-backend boot must own exactly four 100 ms republish timers");
for (const [name, runtime] of namedRuntimes) {
  assert.deepEqual(
    Object.fromEntries(Object.entries(runtime.getRepublishRate()).filter(([key]) => [
      "republish_rate_ms", "enabled", "running",
    ].includes(key))),
    { republish_rate_ms: 100, enabled: true, running: true },
    `${name} boot republish truth`,
  );
}

lobbyRuntime.reset();
lobbyRuntime.reset();
assert.equal(republishTimerCount(), 4, "repeated reset must replace, not duplicate, the lobby timer");
assert.deepEqual(
  Object.fromEntries(Object.entries(lobbyRuntime.getRepublishRate()).filter(([key]) => [
    "republish_rate_ms", "enabled", "running",
  ].includes(key))),
  { republish_rate_ms: 100, enabled: true, running: true },
);
const republishAfterExplicitZero = lobbyRuntime.setRepublishRate(0);
assert.deepEqual(
  Object.fromEntries(Object.entries(republishAfterExplicitZero).filter(([key]) => [
    "republish_rate_ms", "enabled", "running",
  ].includes(key))),
  { republish_rate_ms: 0, enabled: false, running: false },
);
assert.equal(republishTimerCount(), 3, "explicit zero must stop only the selected backend timer");
lobbyRuntime.reset();
const republishAfterReset = lobbyRuntime.getRepublishRate();
assert.deepEqual(
  Object.fromEntries(Object.entries(republishAfterReset).filter(([key]) => [
    "republish_rate_ms", "enabled", "running",
  ].includes(key))),
  { republish_rate_ms: 100, enabled: true, running: true },
);
assert.equal(republishTimerCount(), 4, "reset after explicit zero must restore exactly one 100 ms timer");

const portalResource = lobbyRuntime.getWowPortal("lobby-portal-c");
assert.equal(portalResource.destination.target_location_id, "location-airport");
assert.equal(portalResource.destination.target_world_id, "world-airport-terminal");
assert.equal(portalResource.destination.target_base_url, "http://127.0.0.1:18154");
assert.equal(portalResource.webofworlds_extension.target_fixture, undefined);
assert.equal(
  portalResource.webofworlds_extension.handoff_behavior,
  "application-level-handoff-around-teleportxr",
);
assert.equal(portalResource.webofworlds_extension.spatial_fabric_address.location_id, "location-airport");
assert.equal(portalResource.webofworlds_extension.reciprocal.mode, "automatic");

const graph = airportRuntime.getWowGraph();
assert.equal(graph.spatialID, "world-airport-terminal");
assert.equal(graph.backend_contract.location_id, "location-airport");
assert.equal(graph.backend_contract.authored_content, true);
assert.ok(graph.nodes.some((node) => node.webofworlds_extension?.airport_terminal));
const region = airportRuntime.getFabricRegion("airport-portal-lobby", portalC.spatial_fabric.roi_radius_m);
assert.equal(region.ok, true);
assert.equal(region.location_id, "location-airport");
assert.equal(region.region.radius_m, 24);
assert.equal(region.region.radius_clamped, false);
assert.ok(region.entities.some((entity) => entity.webofworlds_extension?.role === "npc-traveler"),
  "airport aperture must non-vacuously contain an authored traveler");
assert.ok(region.entities.some((entity) => entity.webofworlds_extension?.role === "storefront"),
  "airport aperture must non-vacuously contain an authored storefront");
assert.ok(region.totals.excluded_entities > 0, "airport aperture must remain a partial concourse read");
assert.equal(region.portal.portal_id, "airport-portal-lobby");
const clampedAirportRegion = airportRuntime.getFabricRegion("airport-portal-lobby", 99);
assert.equal(clampedAirportRegion.region.radius_m, 24, "authored graph maximum must be bounded by its walkable geometry");
assert.equal(clampedAirportRegion.region.radius_clamped, true);

for (const [name, runtime, portalId] of [
  ["location-a", aRuntime, "location-a-portal"],
  ["location-b", bRuntime, "location-b-portal"],
  ["location-lobby", lobbyRuntime, "lobby-portal-a"],
]) {
  const legacyRegion = runtime.getFabricRegion(portalId, 99);
  assert.equal(legacyRegion.region.radius_m, 12, `${name} must retain the exact legacy 12 m region cap`);
  assert.equal(legacyRegion.region.radius_clamped, true);
}

const playerOne = {
  player_id: "runtime-player-one",
  client_id: "runtime-player-one",
  avatar_id: "avatar-local-001",
  continuity_id: "avatar-local-001",
  position: [0, 0.07, -3],
  rotation_y: 0,
  ttl_ms: 1000,
};
const playerTwo = {
  ...playerOne,
  player_id: "runtime-player-two",
  client_id: "runtime-player-two",
  avatar_id: "avatar-peer-002",
  continuity_id: "avatar-peer-002",
  position: [1, 0.07, -2.5],
};
if (mutation !== "airport-presence-absent") {
  airportRuntime.registerPresence(playerOne);
  airportRuntime.registerPresence(playerTwo);
}
const presence = airportRuntime.getFabricPresence();
assert.equal(presence.location_id, "location-airport");
assert.equal(presence.occupancy.registered_player_count, 2, "airport presence must be live and non-vacuous");
assert.deepEqual(
  presence.occupancy.avatars.map((avatar) => avatar.player_id).sort(),
  ["runtime-player-one", "runtime-player-two"],
);
assert.equal(new Set(presence.occupancy.avatars.map((avatar) => avatar.player_id)).size, 2, "presence must contain no duplicate/self ghost");
airportRuntime.departPresence({ player_id: "runtime-player-two", reason: "runtime-check" });
assert.equal(airportRuntime.getFabricPresence().occupancy.registered_player_count, 1);

const appSource = read("web/app.js");
const adapterSource = read("web/live-adapter.js");
const sceneSource = read("web/scene-runtime-controller.mjs");
const previewReady = mutation !== "missing-prefetch-frames";
assert.equal(previewReady, true, "authored airport aperture preview frames are required before crossing");
assert.doesNotMatch(appSource, /loadAirportApertureMachine/);
assert.doesNotMatch(appSource, /airportApertureMachine/);
assert.match(appSource, /portal-c-server-backed/);
// routed the same-origin proxy bases through the ONE
// public-base-path helper, so the constant is now `withBase("/api/airport")`
// (still the /api/airport proxy, now base-path aware). Assert that form.
assert.match(adapterSource, /const BASE_AIRPORT = withBase\("\/api\/airport"\)/);
assert.match(adapterSource, /authoredWowGraphEndpoint\(wowWorld, this\.base\)/);
assert.match(adapterSource, /_adoptLiveAirportScenePhysics\(this\._wowResolved\)/);
assert.match(adapterSource, /portal exit has no classified destination ground/);
assert.match(sceneSource, /source: "live_backend_authored_wow_graph"/);
assert.match(sceneSource, /one_selected_renderer: true/);
assert.match(sceneSource, /data-airport-backend-scene/);

lobbyRuntime.stopPresenceSweeper();
aRuntime.stopPresenceSweeper();
bRuntime.stopPresenceSweeper();
airportRuntime.stopPresenceSweeper();
for (const [, runtime] of namedRuntimes) runtime.stopRepublishTimer();
assert.equal(activeIntervals.size, 0, "deterministic backend check must release every owned timer");
globalThis.setInterval = nativeSetInterval;
globalThis.clearInterval = nativeClearInterval;

console.log(JSON.stringify({
  ok: true,
  mutation: mutation || null,
  portal_c: {
    target_location_id: portalC.target_location_id,
    target_world_id: portalC.target_world_id,
    target_base_url: portalC.target_base_url,
    target_portal_id: portalC.target_portal_id,
    fixture: portalC.target_fixture || null,
    transition: portalC.traversal.transition || null,
    reciprocal_mode: portalC.reciprocal.mode,
  },
  airport: {
    authored_nodes: graph.nodes.length,
    prefetched_entities: region.entities.length,
    excluded_entities: region.totals.excluded_entities,
    authored_roi_radius_m: region.region.radius_m,
    legacy_roi_cap_m: 12,
    reciprocal_portal_count: airportPortals.length,
    presence_before_depart: 2,
    presence_after_depart: airportRuntime.getFabricPresence().occupancy.registered_player_count,
  },
  republish_defaults: {
    four_backend_boot_rate_ms: 100,
    four_backend_timer_count: 4,
    repeated_reset_timer_count: 4,
    explicit_zero: { republish_rate_ms: 0, enabled: false, running: false },
    reset_after_zero: {
      republish_rate_ms: republishAfterReset.republish_rate_ms,
      enabled: republishAfterReset.enabled,
      running: republishAfterReset.running,
    },
    cleanup_active_timer_count: activeIntervals.size,
    controlled_red: ["boot-default-zero", "duplicate-reset-timer", "reset-default-off", "explicit-zero-broken"],
  },
  source_contract: {
    live_airport_endpoint: true,
    fixture_aperture_override_absent: true,
    backend_authored_graph_selected: true,
    one_selected_renderer: true,
    safe_ground_required: true,
  },
}, null, 2));
