// The movement and camera controller, run as it is: the real module in Node, given fakes for the window, the document and
// the scene runtime. Each planted fault edits a copy of the module and must turn the named check red (tools/behavior/node-checks.mjs).
import assert from "node:assert/strict";
import { THREE, FakeTarget, bodyBelowFloor, createHarness } from "../tools/behavior/controller-harness.mjs";
import { cameraWallTreatment } from "../tools/behavior/camera-wall-check.mjs";
import { crossingHeldKeys, shiftRunInput } from "../tools/behavior/controller-input-checks.mjs";
import { controllerFaults } from "../tools/behavior/controller-faults.mjs";
import { nodeChecks } from "../tools/behavior/node-checks.mjs";

const { check, finish } = nodeChecks("movement-camera-controller");

/** Each of `names` appears in `trace` in this order. */
function assertOrder(trace, names, label) {
  let cursor = -1;
  for (const name of names) {
    const next = trace.indexOf(name, cursor + 1);
    assert.notEqual(next, -1, `${label}: missing ${name} (${trace.join(" ")})`);
    cursor = next;
  }
}

const pressed = (harness, code, init = {}) => harness.windowTarget.dispatch("keydown", { code, repeat: false, ...init });
const distance = (left, right) => Math.hypot(...left.map((value, index) => value - right[index]));

await check("dt-cap-and-frame-order", "A frame steps at most 50 ms, camera-relative, and does its parts in order", () => {
  const harness = createHarness();
  harness.controller.start();
  pressed(harness, "KeyW");
  harness.trace.length = 0;
  harness.runNextFrame(1000);
  assert.equal(harness.stepped[0].dt, 0.05, "dt is capped at 50 ms");
  assert.equal(harness.stepped[0].input.forward, true);
  assert.equal(Number.isFinite(harness.stepped[0].input.camera_yaw), true, "the step carries the camera yaw");
  assertOrder(harness.trace, ["step", "handoff", "camera", "persist", "child", "portal", "verify"], "frame order");
  harness.controller.dispose();
});

await check("feet-grounded-each-frame", "A frame puts the avatar's feet on the floor", () => {
  const harness = createHarness({ model: bodyBelowFloor() });
  harness.controller.start();
  const lowest = () => new THREE.Box3().setFromObject(harness.model).min.y;
  assert.ok(lowest() < -0.4, "the model starts under the floor");
  harness.runNextFrame(16);
  assert.ok(Math.abs(lowest()) < 0.01, `the feet stay ${(-lowest()).toFixed(3)} m under the floor`);
  harness.controller.dispose();
});

await check("shift-run-input", "Shift run input is hold-only, overlap-safe, repeat-safe and lifecycle-safe", shiftRunInput);
await check("crossing-held-keys", "Keys held at a crossing stay off until released and pressed again", crossingHeldKeys);

await check("start-stop-lifecycle", "Start is idempotent; stop and dispose remove the frame, the listeners and the button", () => {
  const harness = createHarness();
  assert.equal(harness.controller.start(), true);
  assert.equal(harness.controller.start(), false);
  assert.equal(harness.frames.size, 1, "one frame is queued");
  assert.equal(harness.windowTarget.listenerCount("keydown"), 2);
  const button = harness.mount.children.find((child) => child.id === "btn-camera-mode");
  assert.ok(button && harness.mount.listenerCount("mousedown") === 1, "the mount holds the camera button and its drag listener");
  assert.equal(harness.controller.stop(), true);
  assert.equal(harness.frames.size, 0, "a frame is still queued after stop");
  assert.equal(harness.cancelled.length, 1);
  assert.equal(harness.windowTarget.listenerCount("keydown"), 0, "keydown listeners remain after stop");
  assert.equal(harness.mount.listenerCount("mousedown"), 0, "the mount keeps its listeners after stop");
  assert.equal(harness.mount.children.includes(button), false, "the camera button stays in the mount after stop");
  assert.equal(harness.controller.start(), true);
  assert.equal(harness.frames.size, 1);
  harness.controller.dispose();
  assert.equal(harness.frames.size, 0);
});

await check("stop-inside-a-frame", "A controller stopped during a frame schedules no more", () => {
  let holder = null;
  const harness = createHarness({ onStep: () => holder.controller.stop() });
  holder = harness;
  harness.controller.start();
  harness.runNextFrame(16);
  assert.equal(harness.frames.size, 0, "a frame is still queued after the controller stopped itself");
  harness.controller.dispose();
});

await check("escape-dismisses-orientation", "Escape uses the one movement listener to dismiss the orientation card", () => {
  const harness = createHarness();
  assert.equal(harness.controller.start(), true);
  assert.equal(harness.controller.start(), false);
  assert.equal(harness.windowTarget.listenerCount("keydown"), 2);
  harness.trace.length = 0;
  harness.windowTarget.dispatch("keydown", { code: "Escape", key: "Escape", repeat: false });
  assert.equal(harness.trace.filter((entry) => entry === "orientation").length, 1, "Escape dismisses the orientation card once");
  harness.controller.dispose();
  harness.trace.length = 0;
  harness.windowTarget.dispatch("keydown", { code: "Escape", key: "Escape", repeat: false });
  assert.equal(harness.trace.filter((entry) => entry === "orientation").length, 0);
});

await check("observer-input", "Observer input stays world-fixed, runs with Shift, and the server view modes work", () => {
  const harness = createHarness({ isPlayer: false });
  harness.controller.start();
  pressed(harness, "KeyW");
  pressed(harness, "ShiftLeft");
  harness.runNextFrame(100);
  const input = harness.stepped[0].input;
  assert.equal(Object.hasOwn(input, "camera_yaw"), false, "an observer's step carries no camera yaw");
  assert.equal(input.forward, true);
  assert.equal(input.run, true, "the observer does not run with Shift held");
  assert.equal(harness.controller.setServerViewMode("top_down"), "top_down");
  assert.equal(harness.controller.serverViewCameraState().mode, "top_down");
  harness.controller.dispose();
});

await check("auto-handoff-single-flight", "A client-scene load starts once, and a failed one lets the next frame try again", async () => {
  let rejectLoad;
  let loads = 0;
  const load = () => { loads += 1; return new Promise((_, reject) => { rejectLoad = reject; }); };
  const harness = createHarness({ sceneLoadTarget: { spatial_id: "airport" }, mountClientSceneLoad: load });
  harness.controller.start();
  harness.runNextFrame(16);
  harness.runNextFrame(32);
  assert.equal(loads, 1, `the scene load started ${loads} times in two frames`);
  rejectLoad(new Error("expected failure"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  harness.runNextFrame(48);
  assert.equal(loads, 2, `after a failure the load started ${loads} times in all, not 2`);
  harness.controller.dispose();
});

await check("grounded-edge-pose", "Leaving the ground tells the world at once, through the runtime's public pose call", () => {
  const harness = createHarness();
  harness.controller.start();
  harness.runNextFrame(16);
  harness.state.controls.grounded = false;
  harness.runNextFrame(32);
  assert.deepEqual(harness.forced, [{ force: true }], "the pose was not forced on the grounded edge");
  harness.controller.dispose();
});

await check("camera-button-and-host", "The camera button, the C key, orbit drive and a changed host keep working", () => {
  const harness = createHarness();
  harness.controller.start();
  const button = harness.mount.children.find((child) => child.id === "btn-camera-mode");
  assert.ok(button);
  assert.equal(button.getAttribute("data-camera-view-mode"), "third_person");
  harness.windowTarget.dispatch("keydown", { code: "KeyC", repeat: false });
  assert.equal(harness.controller.playerCameraMode(), "first_person", "the C key does not switch to first person");
  assert.ok(harness.controller.orbitBy(0.2, 0.1, 0.5).azimuth > 0);
  const replacementMount = new FakeTarget("scene-mount-recomposed");
  harness.setMount(replacementMount);
  harness.controller.refreshSceneHost();
  assert.equal(harness.mount.listenerCount("mousedown"), 0, "the old mount keeps its listeners after a remount");
  assert.ok(replacementMount.children.some((child) => child.id === "btn-camera-mode"), "the replacement mount gets no camera button");
  harness.controller.dispose();
});

await check("first-person-crossing", "A first-person view mapped through a portal survives the rehost without a snap", () => {
  const harness = createHarness();
  harness.controller.start();
  harness.controller.setPlayerCameraMode("first_person");
  const forward = [0, -Math.sin(0.22), Math.cos(0.22)];
  const mapping = { position: [4, 2, 5], focus: [3, 1.35, 4], forward };
  harness.state.avatar.position = [3, 0, 4];
  assert.equal(harness.controller.handleCrossing({ kind: "world_crossing", camera_mapping: mapping }), true);
  harness.rehostAvatar();
  harness.avatarRig.position.set(...harness.state.avatar.position);
  harness.controller.applyPlayerCamera();
  harness.controller.updatePlayerCamera({ avatar: harness.state.avatar });
  const camera = harness.controller.playerCameraDebug();
  assert.ok(distance(camera.position, mapping.position) <= 0.002, "mapped first-person position must commit exactly");
  assert.ok(distance(camera.target, mapping.position.map((value, index) => value + forward[index])) <= 0.002, "mapped first-person focus ray must commit exactly");
  assert.ok(camera.portal_crossing_camera_correction, "rehost correction must remain explicit in camera debug state");
  harness.controller.applyPlayerCamera();
  assert.ok(distance(harness.sceneCamera.position.toArray(), mapping.position) <= 0.000001, "next camera application snapped after commit");
  harness.controller.dispose();
});

await check("eye-level-seed", "A camera seeded from an avatar position looks at eye level, before the first destination frame", () => {
  const harness = createHarness();
  harness.controller.start();
  harness.controller.seedOrbitCamera({ azimuth: Math.PI, avatarPosition: [0, 0.07, -3] });
  harness.controller.updatePlayerCamera({ avatar: harness.state.avatar });
  assert.deepEqual(harness.controller.playerCameraDebug().target, [0, 1.42, -3], "the camera does not look at eye level");
  harness.controller.dispose();
});

await check("return-to-lobby-camera", "Returning to the lobby puts the camera back behind the avatar", () => {
  const harness = createHarness();
  harness.controller.start();
  harness.controller.seedOrbitCamera({ azimuth: 1.3 });
  assert.equal(harness.controller.debug().orbit.azimuth, 1.3);
  harness.controller.handleCrossing({ kind: "return_to_lobby" });
  assert.equal(harness.controller.debug().orbit.azimuth, 0, "the camera azimuth was not reset on the return to the lobby");
  harness.controller.dispose();
});

await check("camera-wall-treatment", "The camera-wall treatment hides the real blocker and restores exact state across lifecycle boundaries", cameraWallTreatment);

await finish({ checkFile: "src/movement-camera-controller-check.mjs", faults: controllerFaults });
