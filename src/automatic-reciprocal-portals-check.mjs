import assert from "node:assert/strict";
import { createRequire } from "node:module";

import {
  automaticReciprocalPortal,
  clientSceneLoadTarget,
  CLIENT_SCENE_RETURN_TRANSITION,
  resolveClientSceneLoadTraversal,
} from "../web/airport-lobby-transition.mjs";
import { portalEntryFromWowPortal } from "../web/live-adapter-world-projection.mjs";

const require = createRequire(import.meta.url);
const { makeConfig } = require("../runtime/world-server/src/config.js");
const { createRuntime } = require("../runtime/world-server/src/runtime-state.js");

const mutation = process.env.feature_MUTATION || "none";
const config = makeConfig("lobby");
const runtime = createRuntime(config);
const originWorld = {
  location_id: config.location_id,
  world_id: config.world_id,
  base_url: "http://127.0.0.1:8143",
};
const portals = config.portals.map((declared) => portalEntryFromWowPortal(
  runtime.getWowPortal(declared.portal_id),
  config.location_id,
));
// migrated the LIVE lobby-portal-c from a same-browser
// client_scene_load FIXTURE target to a real airport BACKEND target
// (target_base_url :18154, target_portal_id airport-portal-lobby, no
// target_fixture, no client_scene_load transition). deliberately PRESERVED
// the generic automatic-reciprocal SYNTHESIS for client-scene destinations "still
// used elsewhere" (scope line: "preserve any generic client-scene
// functionality still used elsewhere"; the resolver is still called at
// web/live-adapter.js). This proof pins that PRESERVED generic contract by
// exercising the reciprocal-enabled client-scene portal shape (as lobby-portal-c
// carried, and as any fixture world's reciprocal portal carries),
// NOT the now-backend live Portal C.
const liveLobbyPortalC = () =>
  structuredClone(portals.find((portal) => portal.string_portal_id === "lobby-portal-c"));
const clientSceneLobbyPortalC = () => {
  const portal = liveLobbyPortalC();
  portal.target_fixture = {
    spatial_id: "world-airport-terminal",
    graph_endpoint: "/worlds/denver-skyport.json",
  };
  portal.traversal.transition = "client_scene_load";
  portal.target_frame.location_id = "world-airport-terminal";
  return portal;
};
const source = clientSceneLobbyPortalC();

// New production reality: the LIVE backend lobby-portal-c is NOT a
// client-scene synthesis source. Its explicit airport-portal-lobby return wins
// deduplication and is the sole ring, so automatic synthesis must decline
// closed for the backend Portal C. This keeps the proof anchored to current truth.
const liveBackendPortalC = liveLobbyPortalC();
assert.equal(liveBackendPortalC.target_fixture, null, "runtime: live Portal C carries no fixture target");
assert.equal(liveBackendPortalC.traversal.transition, undefined, "runtime: live Portal C no longer client_scene_loads");
assert.deepEqual(
  automaticReciprocalPortal({
    sourcePortal: liveBackendPortalC,
    destinationSpatialId: "world-airport-terminal",
    originWorld,
  }),
  { portal: null, synthesized: false, reason: "invalid_reciprocal_destination" },
  "runtime: backend Portal C must not synthesize a client-scene reciprocal (airport-portal-lobby is the explicit sole ring)",
);

assert.equal(portals.length, 3, "the lobby must retain exactly its three authored portals");
assert.deepEqual(
  portals.filter((portal) => portal.string_portal_id !== "lobby-portal-c").map((portal) => ({
    id: portal.string_portal_id,
    reciprocal: portal.reciprocal,
    traversal: portal.traversal.mode,
  })),
  [
    { id: "lobby-portal-a", reciprocal: { mode: "disabled", validation: { automatic_reciprocal_standard_conformance: false, application_level: true } }, traversal: "bidirectional" },
    { id: "lobby-portal-b", reciprocal: { mode: "disabled", validation: { automatic_reciprocal_standard_conformance: false, application_level: true } }, traversal: "bidirectional" },
  ],
  "the explicit backend pair must stay explicit and must not opt into synthesis",
);
assert.equal(source.reciprocal.mode, "automatic");
assert.equal(source.traversal.mode, "bidirectional");
assert.equal(source.traversal.transition, "client_scene_load");
assert.equal(source.target_fixture.spatial_id, "world-airport-terminal");
assert.equal(source.target_frame.location_id, "world-airport-terminal");

if (mutation === "disable-setting") source.reciprocal.mode = "disabled";
if (mutation === "pair-one-way") source.traversal.mode = "one_way";
if (mutation === "wrong-orientation") source.arrival.position = [0, 0, -5.8];
if (mutation === "unsafe-arrival") source.arrival.position = [0, 0, -4.3];

const first = automaticReciprocalPortal({
  sourcePortal: source,
  destinationSpatialId: "world-airport-terminal",
  originWorld,
});
assert.ok(first.portal, `automatic reciprocal must synthesize (${first.reason})`);
assert.equal(first.synthesized, true);
assert.equal(first.reason, "automatic_reciprocal_synthesized");
assert.equal(first.duplicate_count, 0);

const second = automaticReciprocalPortal({
  sourcePortal: source,
  destinationSpatialId: "world-airport-terminal",
  originWorld,
});
assert.deepEqual(second, first, "identical source data must derive an identical descriptor");

const reciprocal = first.portal;
assert.equal(reciprocal.string_portal_id, "reciprocal--lobby-portal-c--world-airport-terminal");
assert.equal(reciprocal.source_location_id, "world-airport-terminal");
assert.equal(reciprocal.target_location_id, "location-lobby");
assert.equal(reciprocal.target_world_id, "demo-lobby");
assert.equal(reciprocal.target_portal_id, "lobby-portal-c");
assert.equal(reciprocal.target_base_url, null, "local return must not masquerade as a backend handoff");
assert.equal(reciprocal.frame.location_id, "world-airport-terminal");
assert.equal(reciprocal.frame.linked_target_location_id, "location-lobby");
assert.equal(reciprocal.target_frame.location_id, "location-lobby");
assert.equal(reciprocal.target_frame.linked_target_location_id, "world-airport-terminal");
assert.deepEqual(reciprocal.frame.ground_center, source.target_frame.ground_center);
assert.deepEqual(reciprocal.frame.forward, source.target_frame.forward);
assert.deepEqual(reciprocal.target_frame.ground_center, source.frame.ground_center);
assert.deepEqual(reciprocal.zones, source.zones, "inverse edge must preserve prefetch/traversal geometry");
assert.notEqual(reciprocal.zones, source.zones, "inverse zones must not alias mutable source state");
assert.equal(reciprocal.traversal.mode, "bidirectional");
assert.equal(reciprocal.traversal.transition, CLIENT_SCENE_RETURN_TRANSITION);
assert.equal(reciprocal.spatial_fabric_address.location_id, "location-lobby");
assert.equal(reciprocal.spatial_fabric_address.anchor.portal_id, "lobby-portal-c");
assert.equal(reciprocal.reciprocal.synthesized, true);
assert.deepEqual(reciprocal.arrival.position, [0, 0, -2.95]);
assert.equal(first.safe_arrival.destination_clearance_m, 1.4);
assert.ok(first.safe_arrival.destination_clearance_m > first.safe_arrival.minimum_clearance_m);

const returnTarget = clientSceneLoadTarget(reciprocal);
assert.deepEqual(returnTarget, {
  portal_id: reciprocal.string_portal_id,
  spatial_id: "location-lobby",
  transition: CLIENT_SCENE_RETURN_TRANSITION,
  arrival: reciprocal.arrival,
  proof_boundary: {
    application_level_handoff: false,
    standards_conformance: false,
  },
});
assert.deepEqual(resolveClientSceneLoadTraversal(
  { portals: [reciprocal] },
  {
    portal_focus_portal_id: reciprocal.string_portal_id,
    portals: [{
      portal_id: reciprocal.string_portal_id,
      crossed_plane: true,
      crossing_commit_allowed: true,
    }],
  },
), returnTarget, "the inverse edge must resolve only after a committed plane crossing");
assert.equal(resolveClientSceneLoadTraversal(
  { portals: [reciprocal] },
  {
    portal_focus_portal_id: reciprocal.string_portal_id,
    portals: [{
      portal_id: reciprocal.string_portal_id,
      crossed_plane: false,
      crossing_commit_allowed: true,
    }],
  },
), null, "proximity must not trigger the reciprocal return");

const stableReuse = automaticReciprocalPortal({
  sourcePortal: source,
  destinationSpatialId: "world-airport-terminal",
  originWorld,
  destinationPortals: [structuredClone(reciprocal)],
});
assert.equal(stableReuse.reason, "stable_synthesized_reciprocal_reused");
assert.equal(stableReuse.duplicate_count, 1);
assert.deepEqual(stableReuse.portal, reciprocal);

const explicit = structuredClone(reciprocal);
explicit.portal_id = "airport-explicit-return";
explicit.string_portal_id = "airport-explicit-return";
explicit.frame.portal_id = "airport-explicit-return";
explicit.reciprocal.synthesized = false;
const explicitReuse = automaticReciprocalPortal({
  sourcePortal: source,
  destinationSpatialId: "world-airport-terminal",
  originWorld,
  destinationPortals: [explicit, structuredClone(reciprocal)],
});
assert.equal(explicitReuse.reason, "explicit_reciprocal_reused");
assert.equal(explicitReuse.synthesized, false);
assert.equal(explicitReuse.duplicate_count, 2);
assert.equal(explicitReuse.portal.string_portal_id, "airport-explicit-return");

const invalidCases = [
  ["disabled setting", (candidate) => { candidate.reciprocal.mode = "disabled"; }, "automatic_reciprocal_disabled"],
  ["one-way source", (candidate) => { candidate.traversal.mode = "one_way"; }, "one_way_source_not_pairable"],
  ["missing inverse frame", (candidate) => { candidate.target_frame = null; }, "invalid_inverse_frame"],
  ["wrong destination", (candidate) => { candidate.target_frame.location_id = "wrong-world"; }, "inverse_frame_destination_mismatch"],
  ["invalid zones", (candidate) => { candidate.zones.invariant_ok = false; }, "invalid_inverse_zones"],
  ["missing arrival", (candidate) => { candidate.arrival.position = [0, null, 0]; }, "invalid_inverse_arrival"],
  ["wrong orientation", (candidate) => { candidate.arrival.position = [0, 0, -5.8]; }, "invalid_inverse_orientation"],
  ["unsafe seam arrival", (candidate) => { candidate.arrival.position = [0, 0, -4.3]; }, "unsafe_inverse_arrival"],
  ["unsafe lateral arrival", (candidate) => { candidate.arrival.position = [1.25, 0, -3]; }, "unsafe_inverse_arrival"],
];
for (const [label, mutate, reason] of invalidCases) {
  const candidate = clientSceneLobbyPortalC();
  mutate(candidate);
  const rejected = automaticReciprocalPortal({
    sourcePortal: candidate,
    destinationSpatialId: "world-airport-terminal",
    originWorld,
  });
  assert.equal(rejected.portal, null, `${label} must fail closed`);
  assert.equal(rejected.reason, reason, `${label} must remain diagnosable`);
}

const invalidExisting = structuredClone(reciprocal);
invalidExisting.arrival.position = [Number.NaN, 0, 0];
assert.deepEqual(automaticReciprocalPortal({
  sourcePortal: clientSceneLobbyPortalC(),
  destinationSpatialId: "world-airport-terminal",
  originWorld,
  destinationPortals: [invalidExisting],
}), { portal: null, synthesized: false, reason: "explicit_reciprocal_invalid" });

assert.deepEqual(automaticReciprocalPortal({
  sourcePortal: null,
  destinationSpatialId: "world-airport-terminal",
  originWorld,
}), { portal: null, synthesized: false, reason: "missing_source_portal" });

console.log(JSON.stringify({
  result: "PASS",
  mutation,
  authored_lobby_portal_count: portals.length,
  reciprocal_portal_count: 1,
  reciprocal_id: reciprocal.string_portal_id,
  return_arrival: reciprocal.arrival,
  safe_arrival: first.safe_arrival,
  explicit_pair_deduplicated: true,
  invalid_cases_rejected: invalidCases.length + 1,
  one_way_rejected: true,
  local_return_without_backend_handoff: reciprocal.target_base_url === null,
}, null, 2));
