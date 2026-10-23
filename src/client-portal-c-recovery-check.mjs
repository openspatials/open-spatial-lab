import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";

import {
  clientSceneLoadFieldsFromWowPortal,
  clientSceneLoadTarget,
  recoverAirportLobbyPortalResources,
} from "../web/airport-lobby-transition.mjs";

const require = createRequire(import.meta.url);
const { makeConfig } = require("../runtime/world-server/src/config.js");
const { createRuntime } = require("../runtime/world-server/src/runtime-state.js");

const clone = (value) => JSON.parse(JSON.stringify(value));
const portalId = (portal) => portal?.webofworlds_extension?.portal_id || null;

function assertRecoveredAirportPortal(portals) {
  assert.deepEqual(
    portals.map(portalId),
    ["lobby-portal-a", "lobby-portal-b", "lobby-portal-c"],
    "the player lobby must expose A, B, then C exactly once"
  );
  const airport = portals[2];
  const ext = airport.webofworlds_extension;
  assert.equal(airport.id, 3);
  assert.equal(airport.label, "Portal to Denver Skyport");
  assert.deepEqual(ext.target_fixture, {
    spatial_id: "world-airport-terminal",
    graph_endpoint: "/worlds/denver-skyport.json",
  });
  assert.deepEqual(ext.trigger, { position: [0, 0, -4.4], radius_m: 1.25 });
  assert.equal(ext.traversal.mode, "bidirectional");
  assert.equal(ext.traversal.transition, "client_scene_load");
  assert.equal(airport.destination?.target_base_url, undefined);
  assert.equal(airport.destination?.target_portal_id, undefined);
  assert.equal(ext.target_base_url, undefined);
  assert.equal(ext.target_portal_id, undefined);

  const fields = clientSceneLoadFieldsFromWowPortal(airport);
  const target = clientSceneLoadTarget({
    string_portal_id: ext.portal_id,
    label: airport.label,
    target_fixture: fields.target_fixture,
    arrival: ext.arrival,
    traversal: { ...ext.traversal, transition: fields.traversal_transition },
  });
  assert.ok(target, "Portal C must resolve only as a client scene-load target");
  assert.equal(target.transition, "client_scene_load");
  assert.equal(target.spatial_id, "world-airport-terminal");
  return target;
}

const runtime = createRuntime(makeConfig("lobby"));
const freshWorld = runtime.getWowWorld();
const freshPortals = [1, 2, 3].map((id) => runtime.getWowPortalResource(id));
const staleWorld = clone(freshWorld);
staleWorld.portals.portal_count = 2;
staleWorld.webofworlds_extension.portals = staleWorld.webofworlds_extension.portals.slice(0, 2);
const stalePortals = freshPortals.slice(0, 2).map(clone);
const staleBefore = clone(stalePortals);

const recovered = recoverAirportLobbyPortalResources("player", staleWorld, stalePortals);
const target = assertRecoveredAirportPortal(recovered);
assert.deepEqual(stalePortals, staleBefore, "the recovery must not mutate the backend resources");
assert.deepEqual(recovered.slice(0, 2), staleBefore, "A/B descriptors must remain deep-equal");
assert.strictEqual(recovered[0], stalePortals[0], "Portal A identity must be preserved");
assert.strictEqual(recovered[1], stalePortals[1], "Portal B identity must be preserved");

const freshResult = recoverAirportLobbyPortalResources("player", freshWorld, freshPortals);
assert.strictEqual(freshResult, freshPortals, "a fresh A/B/C backend must remain byte- and identity-stable");
assert.deepEqual(freshResult.map(portalId), ["lobby-portal-a", "lobby-portal-b", "lobby-portal-c"]);

const observerResult = recoverAirportLobbyPortalResources("observer", staleWorld, stalePortals);
assert.strictEqual(observerResult, stalePortals, "non-player clients must not be repaired");
const otherWorld = clone(staleWorld);
otherWorld.id = "demo-room-a";
otherWorld.location.id = "location-a";
const otherWorldResult = recoverAirportLobbyPortalResources("player", otherWorld, stalePortals);
assert.strictEqual(otherWorldResult, stalePortals, "other worlds must not be repaired");
const malformed = clone(stalePortals);
malformed[1].webofworlds_extension.source_location_id = "location-b";
const malformedResult = recoverAirportLobbyPortalResources("player", staleWorld, malformed);
assert.strictEqual(malformedResult, malformed, "malformed lobby resources must not be silently repaired");
const driftedTarget = clone(stalePortals);
driftedTarget[0].destination.target_base_url = "http://127.0.0.1:19999";
const driftedTargetResult = recoverAirportLobbyPortalResources("player", staleWorld, driftedTarget);
assert.strictEqual(driftedTargetResult, driftedTarget, "unknown backend drift must not be hidden");

assert.throws(
  () => assertRecoveredAirportPortal(recovered.slice(0, 2)),
  /player lobby must expose A, B, then C/,
  "anti-vacuity: removing Portal C must turn the contract RED"
);
const mutated = clone(recovered);
mutated[2].webofworlds_extension.traversal.transition = "application_level_handoff";
assert.throws(
  () => assertRecoveredAirportPortal(mutated),
  /client_scene_load|resolve only as a client scene-load target/,
  "anti-vacuity: mutating the transition must turn the contract RED"
);
const impersonatingBackend = clone(recovered);
impersonatingBackend[2].destination.target_base_url = "http://127.0.0.1:18154";
const impersonatingFields = clientSceneLoadFieldsFromWowPortal(impersonatingBackend[2]);
assert.equal(clientSceneLoadTarget({
  string_portal_id: "lobby-portal-c",
  target_base_url: impersonatingBackend[2].destination.target_base_url,
  target_fixture: impersonatingFields.target_fixture,
  traversal: { transition: impersonatingFields.traversal_transition },
}), null, "anti-vacuity: Portal C must not impersonate a backend target");

const adapterSource = await readFile(new URL("../web/live-adapter.js", import.meta.url), "utf8");
assert.match(
  adapterSource,
  /recoverAirportLobbyPortalResources\(role, wowWorld, fetchedPortalList\)/,
  "the live world projection must consume the recovery helper"
);

console.log(JSON.stringify({
  result: "PASS",
  stale_backend_portals: staleBefore.map(portalId),
  recovered_portals: recovered.map(portalId),
  fresh_backend_unchanged: freshResult === freshPortals,
  backend_portals_deep_equal: true,
  airport_target: target,
  malformed_and_other_world_unchanged: true,
  anti_vacuity: ["portal-c-removal-red", "transition-mutation-red", "backend-impersonation-red"],
}, null, 2));
