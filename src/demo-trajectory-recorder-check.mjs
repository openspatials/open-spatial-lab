import assert from "node:assert/strict";
import {
  DEMO_TRAJECTORY_SCHEMA,
  createDemoTrajectoryRecorder,
  demoTrajectoryActivation,
  validateDemoTrajectory,
} from "../web/demo-trajectory/trajectory-recorder.mjs";
import { assertNoTrajectoryGeometryShift } from "../web/demo-trajectory/trajectory-panel.mjs";

let clock = 1000;
let wallTick = 0;
const state = {
  location_id: "location-lobby",
  active: { location_id: "location-lobby", world_id: "fixture-world", endpoint_key: "lobby" },
  avatar: {
    position: [0, 0, 0],
    rotation_y: 0,
    orientation: [0, 0, 0, 1],
    locomotion_state: { moving: false, movement_mode: "idle", grounded: true },
  },
  camera: {
    mode: "third_person_follow",
    view_mode: "third_person",
    position: [0, 3.3, -5.5],
    target: [0, 1.1, 0],
    orbit: { azimuth_rad: Math.PI, polar_rad: 0.4, distance_m: 5.5 },
  },
  movement: {
    keys_down: [],
    movement_direction: "none",
    movement_mode: "idle",
    run_mode: false,
    speed_mps: 0,
    facing_semantics: "still",
    grounded: true,
  },
  portal: {
    nearest_portal_id: "location-a-portal",
    portal_crossing_direction: "unknown",
    inside_oval_aperture: false,
    inside_trigger_volume: false,
  },
  transition: { phase: "none" },
  source_health: { console_error_count: 0, page_error_count: 0 },
};
const persisted = [];
const recorder = createDemoTrajectoryRecorder({
  snapshot: () => structuredClone(state),
  persist: async (trace) => {
    persisted.push(structuredClone(trace));
    return { filename: `take-${persisted.length}.json`, sha256: String(persisted.length).repeat(64).slice(0, 64) };
  },
  monotonicNow: () => clock,
  wallNow: () => `2026-07-22T11:30:${String(wallTick++).padStart(2, "0")}Z`,
  autoSchedule: false,
});

recorder.start();
clock += 33.333;
state.avatar.position = [0, 0, 0.067];
state.avatar.locomotion_state = { moving: true, movement_mode: "walk", movement_direction: "forward", speed_mps: 2, grounded: true };
state.movement = { ...state.movement, keys_down: ["W"], movement_direction: "forward", movement_mode: "walk", speed_mps: 2, facing_semantics: "faces_travel_direction" };
recorder.sampleNow();
clock += 33.333;
state.avatar.position = [-0.067, 0, 0.067];
state.avatar.rotation_y = -Math.PI / 2;
state.avatar.orientation = [0, Math.sin(-Math.PI / 4), 0, Math.cos(-Math.PI / 4)];
state.movement = { ...state.movement, keys_down: ["A"], movement_direction: "left" };
recorder.sampleNow();
clock += 33.333;
state.avatar.locomotion_state = { moving: false, movement_mode: "idle", movement_direction: "none", speed_mps: 0, grounded: true };
state.movement = { ...state.movement, keys_down: [], movement_direction: "none", movement_mode: "idle", speed_mps: 0, facing_semantics: "still" };
recorder.sampleNow();
clock += 33.333;
const firstAccepted = await recorder.done();
assert.equal(firstAccepted.trace.schema_version, DEMO_TRAJECTORY_SCHEMA);
assert.equal(validateDemoTrajectory(firstAccepted.trace).length, 0);
assert.equal(recorder.snapshot().accepted_take_count, 1);
assert.ok(firstAccepted.trace.events.some((event) => event.name === "movement_direction_changed" && event.value === "left"));

const firstAcceptedBytes = JSON.stringify(firstAccepted.trace);
recorder.redo();
assert.equal(recorder.snapshot().status, "recording");
assert.equal(recorder.snapshot().accepted_take_count, 1);
assert.equal(JSON.stringify(recorder.snapshot().accepted_takes[0].trace), firstAcceptedBytes, "Redo must preserve the accepted trace");
clock += 40;
state.avatar.position = [0.013, 0, 0.067];
state.avatar.rotation_y = Math.PI / 2;
state.movement = { ...state.movement, keys_down: ["D"], movement_direction: "right", movement_mode: "walk", speed_mps: 2, facing_semantics: "faces_travel_direction" };
state.avatar.locomotion_state = { moving: true, movement_mode: "walk", movement_direction: "right", speed_mps: 2, grounded: true };
recorder.sampleNow();
clock += 40;
const secondAccepted = await recorder.done();
assert.equal(recorder.snapshot().accepted_take_count, 2);
assert.notDeepEqual(secondAccepted.trace.samples.at(-1).avatar.position, firstAccepted.trace.samples.at(-1).avatar.position);
assert.equal(JSON.stringify(recorder.snapshot().accepted_takes[0].trace), firstAcceptedBytes, "second acceptance must not overwrite first acceptance");

const missingAnchorRecorder = createDemoTrajectoryRecorder({
  snapshot: () => structuredClone(state),
  persist: async () => ({}),
  segments: [{ id: "missing-anchor", label: "Missing anchor" }],
  monotonicNow: () => clock,
  autoSchedule: false,
});
assert.throws(() => missingAnchorRecorder.start(), /missing a named start anchor/);

const nonMonotonic = structuredClone(firstAccepted.trace);
nonMonotonic.samples[2].t_ms = nonMonotonic.samples[1].t_ms;
assert.ok(validateDemoTrajectory(nonMonotonic).some((error) => error.includes("strictly monotonic")));

assert.equal(demoTrajectoryActivation({ location: { hostname: "127.0.0.1", search: "?demo_authoring=trajectory-v1" }, role: "player" }), true);
assert.equal(demoTrajectoryActivation({ location: { hostname: "127.0.0.1", search: "" }, role: "player" }), false);
assert.equal(demoTrajectoryActivation({ location: { hostname: "example.com", search: "?demo_authoring=trajectory-v1" }, role: "player" }), false);
assert.equal(demoTrajectoryActivation({ location: { hostname: "127.0.0.1", search: "?demo_authoring=trajectory-v1" }, role: "source" }), false);

const stableGeometry = {
  viewport: { width: 1200, height: 800 },
  canvases: [{ x: 10, y: 10, width: 580, height: 380 }],
  app: { x: 0, y: 0, width: 1200, height: 800 },
};
assert.equal(assertNoTrajectoryGeometryShift(stableGeometry, structuredClone(stableGeometry)), true);
const leakedGeometry = structuredClone(stableGeometry);
leakedGeometry.canvases[0].width -= 20;
assert.throws(() => assertNoTrajectoryGeometryShift(stableGeometry, leakedGeometry), /geometry leak/);

console.log(JSON.stringify({
  ok: true,
  happy_flow_samples: firstAccepted.trace.samples.length,
  semantic_events: firstAccepted.trace.events.map((event) => event.name),
  accepted_take_count: recorder.snapshot().accepted_take_count,
  controlled_red: ["missing_anchor", "non_monotonic_samples", "destructive_redo", "hosted_exposure", "geometry_leak"],
}));
