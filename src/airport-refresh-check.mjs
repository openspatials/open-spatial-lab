// deterministic compact-airport/entity-card guards.
// Each material regression is armed as a controlled RED mutation before the
// unchanged candidate is re-run GREEN.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateAirportEntityInventory } from "../web/airport-entity-manifest.mjs";
import { verifyManifestProfileA } from "../web/signing/um-signature-profile-a.mjs";
import { v04StructuralSchemaVerdict } from "../web/manifest/version-routing.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = path.join(ROOT, "web/worlds/denver-skyport.json");
const graph = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
const clone = (value) => JSON.parse(JSON.stringify(value));
const extension = (node) => node.webofworlds_extension || {};
const byRole = (value, role) => value.nodes.filter((node) => extension(node).role === role);
const position = (node) => [node.localTransform[12], node.localTransform[13], node.localTransform[14]];
const terminal = (value) => value.nodes.find((node) => extension(node).airport_terminal);
const gate = (value) => byRole(value, "flight-gate")[0];

function geometryGuard(value) {
  const definition = extension(terminal(value)).airport_terminal;
  const spawnZ = definition.entry_spawn.position_m[2];
  const gateZ = position(gate(value))[2];
  const route = gateZ - spawnZ;
  assert.ok(route >= 79 * 0.45 && route <= 79 * 0.55, `spawn-to-gate route ${route}m is outside 45–55% of prior 79m`);
  assert.ok(definition.length_m <= 50, `terminal length ${definition.length_m}m is not compact`);
  const surfaces = definition.walkable_surfaces;
  const boarding = extension(gate(value)).boarding;
  assert.ok(surfaces.some((surface) => surface.center_m[2] + surface.size_m[2] / 2 >= boarding.threshold.center_m[2] + 0.5), "walkable footprint must include the relocated threshold");
  assert.ok(boarding.approach.position_m[2] < boarding.components.entry_z_m, "gate approach must precede components entry");
  assert.ok(boarding.components.entry_z_m < boarding.threshold.center_m[2], "components entry must precede physical threshold");
  return { spawnZ, gateZ, route, terminalLength: definition.length_m, thresholdZ: boarding.threshold.center_m[2] };
}

function storeGuard(value) {
  const stores = byRole(value, "storefront");
  assert.equal(stores.length, 4, "four accepted storefronts must remain");
  assert.deepEqual(stores.map((node) => node.label), ["Skyline Coffee", "Frontier News & Travel", "High Plains Duty Free", "Mesa Kitchen"]);
  assert.ok(stores.every((node) => extension(node).shopping?.interaction_radius_m === 5.2), "shopping interaction radii must remain 5.2m");
  const z = stores.map((node) => position(node)[2]);
  const span = Math.max(...z) - Math.min(...z);
  const route = position(gate(value))[2] - extension(terminal(value)).airport_terminal.entry_spawn.position_m[2];
  assert.ok(span <= route * 0.45, `store span ${span}m exceeds 45% of ${route}m route`);
  assert.ok(stores.every((node) => Math.abs(position(node)[0]) - 3.1 >= 5.4), "store footprints must leave a clear central aisle");
  return { span, ratio: span / route, interactionRadii: stores.map((node) => extension(node).shopping.interaction_radius_m) };
}

function actorGuard(value) {
  const travelers = byRole(value, "npc-traveler");
  const staff = byRole(value, "store-staff");
  assert.equal(travelers.length, 5, "five preserved travelers required");
  assert.equal(staff.length, 4, "one separate staff actor per store required");
  const subjects = [...travelers, ...staff].map((node) => extension(node).actor?.subject_id);
  assert.equal(new Set(subjects).size, 9, "traveler/staff subjects must be unique");
  assert.ok(travelers.every((node) => Math.abs(position(node)[0]) >= 3.5), "travelers must not form a centerline queue");
  const gaps = travelers.map((node) => position(node)[2]).sort((a, b) => a - b).slice(1).map((z, index, sorted) => z - travelers.map((node) => position(node)[2]).sort((a, b) => a - b)[index]);
  assert.ok(new Set(gaps.map((gap) => gap.toFixed(1))).size >= 3, "traveler longitudinal spacing must not be an even progression");
  const zones = travelers.map((node) => extension(node).universal_manifest.facets[0].entity.summary);
  assert.ok(["entry", "wayfinding", "commons", "concourse", "Gate A12"].every((term) => zones.some((zone) => zone.includes(term))), "travelers must cover five authored airport-use zones");
  const relationships = staff.map((node) => extension(node).store_relationship);
  assert.deepEqual(relationships.map((item) => item.store_node_id).sort((a, b) => a - b), [2, 3, 4, 5]);
  for (const node of staff) {
    const relation = extension(node).store_relationship;
    const store = value.nodes.find((candidate) => candidate.id === relation.store_node_id);
    assert.ok(store, `staff node ${node.id} references a missing store`);
    assert.equal(Math.sign(position(node)[0]), Math.sign(position(store)[0]), "staff must remain on their store side");
    assert.ok(Math.abs(position(node)[0]) > Math.abs(position(store)[0]), "staff must stand behind the inner service counter");
    assert.equal(relation.service_position, "behind-counter");
  }
  const phases = [...travelers, ...staff].map((node) => extension(node).idle_animation?.phase_offset);
  assert.ok([...travelers, ...staff].every((node) => extension(node).behavior === "looping-idle" && extension(node).idle_animation?.loop === "repeat"));
  assert.equal(new Set(phases).size, 9, "idle phases must be deterministic and non-lockstep");
  assert.ok(phases.every((phase) => phase > 0 && phase < 1));
  return { travelers: travelers.length, staff: staff.length, subjects, phases, storeRelationships: relationships };
}

async function manifestGuard(value) {
  const inventory = validateAirportEntityInventory(value);
  assert.equal(inventory.ok, true, inventory.errors.join("; "));
  assert.equal(inventory.records.length, 13, "one manifest/card record per 5 travelers + 4 staff + 4 stores");
  for (const { card } of inventory.records) {
    assert.equal(v04StructuralSchemaVerdict(card.manifest).result, "accept", `${card.manifest_id} must route through v0.4`);
    const signature = await verifyManifestProfileA(card.manifest);
    assert.equal(signature.ok, true, `${card.manifest_id}: ${signature.reason}`);
    const entity = card.manifest.facets.find((facet) => facet.name === "publicProfile").entity;
    assert.equal(card.display_name, entity.displayName);
    assert.equal(card.entity_type, entity.entityType);
    assert.equal(card.role, entity.role);
    assert.equal(card.summary, entity.summary);
    assert.equal(card.anchor_id, entity.anchorId);
    assert.equal(card.provenance.simulation, true);
    assert.equal(card.provenance.verification, "unverified");
    assert.equal(card.provenance.um_conformance_claimed, false);
  }
  return inventory;
}

function implementationGuard() {
  const runtime = fs.readFileSync(path.join(ROOT, "web/airport-entity-runtime.mjs"), "utf8");
  const manifest = fs.readFileSync(path.join(ROOT, "web/airport-entity-manifest.mjs"), "utf8");
  const scene = fs.readFileSync(path.join(ROOT, "web/airport-terminal-scene.mjs"), "utf8");
  const controller = fs.readFileSync(path.join(ROOT, "web/scene-runtime-controller.mjs"), "utf8");
  const portalProof = fs.readFileSync(path.join(ROOT, "web/portal-render-controller.mjs"), "utf8");
  assert.match(scene, /placeholder\.visible = false/, "airport blue proxy cubes must be suppressed before first paint");
  assert.match(portalProof, /suppressAirportWowProxy/);
  assert.match(portalProof, /\^wow-node-\\d\+\$/, "hosted airport graph proxies must be suppressed without hiding unrelated validation objects");
  assert.match(runtime, /new THREE\.AnimationMixer\(actorState\.avatar\.scene\)/, "real humanoid mixers required");
  assert.match(runtime, /setLoop\(THREE\.LoopRepeat, Infinity\)/, "idle clips must actually loop");
  assert.match(runtime, /actorState\.action\.time = clips\.idle\.duration \* actorState\.phase/, "authored phases must seed action time");
  assert.match(runtime, /depthTest: true/);
  assert.match(runtime, /depthWrite: false/);
  assert.match(runtime, /CARD_LIMIT = 6/);
  assert.match(runtime, /frustum\.containsPoint/);
  assert.match(runtime, /state\.mesh\.quaternion\.copy\(camera\.quaternion\)/, "cards must billboard from the maintained camera");
  assert.match(runtime, /group\.parent\?\.remove\(group\)/, "card owner must remove its group on disposal");
  assert.match(runtime, /mixer\?\.uncacheRoot/, "idle mixer roots must be released");
  assert.match(controller, /airport_entity_runtime\?\.update\(seconds, built\.camera\)/, "selected renderer loop must own runtime updates");
  assert.match(controller, /airport_entity_runtime\?\.dispose\(\)/, "selected scene disposal must release the runtime");
  assert.doesNotMatch(runtime, /requestAnimationFrame|setInterval|position\s*:\s*["']fixed/, "runtime must not create a second loop or screen-fixed HUD");
  for (const forbidden of ["Joe", "Rose", "Helium", "Nea", "Jane", "Skyline Coffee", "Mesa Kitchen"]) {
    assert.ok(!runtime.includes(forbidden), `card renderer must not hard-code fixture text: ${forbidden}`);
  }
  assert.match(manifest, /publicProfile/, "card derivation must consume the UM publicProfile facet");
  return { cardLimit: 6, distanceM: 21, independentLoops: 0, depthOcclusion: true };
}

async function expectRed(name, mutate, guard) {
  const candidate = clone(graph);
  mutate(candidate);
  let message = "";
  try { await guard(candidate); } catch (error) { message = error.message; }
  assert.ok(message, `controlled RED ${name} did not fail`);
  return message;
}

const red = {};
red.old_full_length_route = await expectRed("old-full-length-route", (value) => {
  extension(terminal(value)).airport_terminal.length_m = 86;
  gate(value).localTransform[14] = 76;
}, geometryGuard);
red.spread_out_stores = await expectRed("spread-out-stores", (value) => {
  byRole(value, "storefront").forEach((node, index) => { node.localTransform[14] = [15, 28, 42, 55][index]; });
}, storeGuard);
red.missing_staff = await expectRed("missing-staff", (value) => { value.nodes = value.nodes.filter((node) => node.id !== 16); }, actorGuard);
red.centerline_even_travelers = await expectRed("centerline-even-travelers", (value) => {
  byRole(value, "npc-traveler").forEach((node, index) => { node.localTransform[12] = 0; node.localTransform[14] = 8 + index * 6; });
}, actorGuard);
red.synchronized_idle = await expectRed("synchronized-idle", (value) => {
  [...byRole(value, "npc-traveler"), ...byRole(value, "store-staff")].forEach((node) => { extension(node).idle_animation.phase_offset = 0; });
}, actorGuard);
red.duplicate_manifest = await expectRed("duplicate-manifest", (value) => {
  const records = [...byRole(value, "npc-traveler"), ...byRole(value, "store-staff"), ...byRole(value, "storefront")];
  extension(records[1]).universal_manifest["@id"] = extension(records[0]).universal_manifest["@id"];
}, manifestGuard);
red.wrong_object_anchor = await expectRed("wrong-object-anchor", (value) => {
  extension(byRole(value, "storefront")[0]).manifest_card_anchor.anchor_id = "airport-card-anchor-wrong-object";
}, manifestGuard);
red.tampered_card_text = await expectRed("tampered-card-text", (value) => {
  extension(byRole(value, "npc-traveler")[0]).universal_manifest.facets[0].entity.summary = "Hard-coded impostor text";
}, manifestGuard);

const geometry = geometryGuard(graph);
const stores = storeGuard(graph);
const actors = actorGuard(graph);
const inventory = await manifestGuard(graph);
const implementation = implementationGuard();

console.log(JSON.stringify({
  result: "PASS",
  green: { geometry, stores, actors, manifests: inventory.records.length, implementation },
  controlled_red: red,
}, null, 2));
