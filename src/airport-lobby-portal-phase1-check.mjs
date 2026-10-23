import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { makeConfig } = require(path.join(root, "runtime/world-server/src/config.js"));
const airport = JSON.parse(await readFile(path.join(root, "web/worlds/denver-skyport.json"), "utf8"));
const lobby = makeConfig("lobby");

assert.equal(lobby.portals.length, 3, "the lobby must advertise Location A, Location B, and the airport");
assert.deepEqual(lobby.portals.map(({ portal_id }) => portal_id), ["lobby-portal-a", "lobby-portal-b", "lobby-portal-c"]);

const airportPortal = lobby.portals.find(({ portal_id }) => portal_id === "lobby-portal-c");
assert.ok(airportPortal, "lobby-portal-c must exist");
// SUPERSESSION: authored Portal C as a same-browser
// client_scene_load FIXTURE leaf. retired that positive path
// and re-pointed Portal C at the real airport BACKEND, with the same
// destination contract as A/B. The authoritative positive backend contract lives
// in src/airport-seamless-backend-check.mjs; this phase-1 proof now pins
// the lobby descriptor to that superseding state and asserts the fixture path is
// gone, while still guarding the preserved airport fixture ASSET below.
assert.equal(airportPortal.target_location_id, "location-airport", "runtime: Portal C now targets the live airport backend location");
assert.equal(airportPortal.target_world_id, "world-airport-terminal");
assert.equal(airportPortal.target_base_url, "http://127.0.0.1:18154", "runtime: Portal C advertises the airport backend node");
assert.equal(airportPortal.target_portal_id, "airport-portal-lobby", "runtime: Portal C links to the airport's explicit return portal");
assert.equal(airportPortal.target_fixture, undefined, "runtime retired the client-scene fixture target on Portal C");
assert.deepEqual(airportPortal.traversal, { mode: "bidirectional" }, "runtime retired the client_scene_load transition; Portal C is a backend handoff");
assert.equal(airportPortal.reciprocal?.mode, "automatic", "runtime automatic reciprocal setting stays enabled (deduped by the airport's explicit inverse)");

const terminal = airport.nodes.find(({ webofworlds_extension }) => webofworlds_extension?.airport_terminal)
  ?.webofworlds_extension.airport_terminal;
assert.ok(terminal, "the airport scene root must declare its terminal readiness contract");
assert.deepEqual(terminal.entry_spawn.position_m, [0, 0, -3]);
assert.equal(terminal.entry_spawn.facing, "+z");
assert.deepEqual(terminal.return_path, {
  mode: "existing_header_control",
  control_id: "btn-return-lobby",
  target_location_id: "location-lobby",
  target_world_id: "demo-lobby",
});
// The preserved airport fixture ASSET itself declares no portals; the
// LIVE airport crossing/return is now the backend (airport-portal-lobby),
// asserted in src/airport-seamless-backend-check.mjs. This guards the asset.
assert.deepEqual(airport.portals, [], "the preserved runtime airport fixture asset declares no portals of its own");
assert.equal(airport.world.proof_boundary.application_level_handoff, false);
assert.equal(airport.world.proof_boundary.standards_conformance, false);

console.log(JSON.stringify({
  result: "PASS",
  supersession: "runtime fixture leaf retired by runtime backend; see runtime check",
  lobby_portals: lobby.portals.map(({ portal_id }) => portal_id),
  airport_backend_target: {
    location_id: airportPortal.target_location_id,
    base_url: airportPortal.target_base_url,
    portal_id: airportPortal.target_portal_id,
  },
  transition: airportPortal.traversal,
  entry_spawn: terminal.entry_spawn,
  return_path: terminal.return_path,
  proof_boundary: airport.world.proof_boundary,
}, null, 2));
