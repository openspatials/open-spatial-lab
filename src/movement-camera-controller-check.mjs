import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { createMovementCameraController } from "../web/movement-camera-controller.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MUTATION = process.env.feature_MOVEMENT_MUTATION || "";
let controllerSource = readFileSync(join(ROOT, "web/movement-camera-controller.mjs"), "utf8");
let adapterSource = readFileSync(join(ROOT, "web/live-adapter.js"), "utf8");
let appSource = readFileSync(join(ROOT, "web/app.js"), "utf8");

function replaceOnce(source, before, after) {
  assert.equal(source.includes(before), true, `mutation anchor missing: ${before}`);
  return source.replace(before, after);
}

if (MUTATION === "frame-order") controllerSource = replaceOnce(controllerSource, "    groundAvatarVisualFeet(deltaSeconds);", "    void deltaSeconds;");
if (MUTATION === "raf-singleton") controllerSource = replaceOnce(controllerSource, "started && frameHandle === null", "started");
if (MUTATION === "raf-cancel") controllerSource = replaceOnce(controllerSource, "cancelFrame(frameHandle);", "void frameHandle;");
if (MUTATION === "listener-cleanup") controllerSource = replaceOnce(controllerSource, "    removeListeners(globalListeners);", "    void globalListeners;");
if (MUTATION === "dt-cap") controllerSource = replaceOnce(controllerSource, "Math.min(0.05,", "Math.min(0.5,");
if (MUTATION === "auto-guard") controllerSource = replaceOnce(controllerSource, "if (!capabilities || autoHandoffStarted) return;", "if (!capabilities) return;");
if (MUTATION === "auto-reset") controllerSource = replaceOnce(controllerSource, "        autoHandoffStarted = false;\n        logLine(`client scene load failed", "        void autoHandoffStarted;\n        logLine(`client scene load failed");
if (MUTATION === "grounded-edge") controllerSource = replaceOnce(controllerSource, "          capabilities.broadcastPlayerPose({ force: true });", "          void grounded;");
if (MUTATION === "lazy-persist") controllerSource = replaceOnce(controllerSource, "      persistSession(false);", "      void persistSession;");
if (MUTATION === "camera-mode") controllerSource = replaceOnce(controllerSource, "        togglePlayerCameraMode();", "        void event;");
if (MUTATION === "preview-order") controllerSource = replaceOnce(controllerSource, "    if (isPlayer) sceneRuntime.renderChildFabricPreview", "    if (false) sceneRuntime.renderChildFabricPreview");
if (MUTATION === "host-refresh") controllerSource = replaceOnce(controllerSource, "      sceneMount = nextMount;", "      void nextMount;");
if (MUTATION === "public-facade") adapterSource = replaceOnce(adapterSource, "  broadcastPlayerPose({ force = false } = {}) {", "  broadcastPlayerPosePrivate({ force = false } = {}) {");
if (MUTATION === "patch8-compat") appSource = replaceOnce(appSource, "const destContent = isPlayer ? destinationLoadingContent() : null;", "const destContent = isPlayer ? featureDestinationLoadingContent : null;");
if (MUTATION === "run-input") controllerSource = replaceOnce(controllerSource, "run: runModifierKeys.size > 0", "run: false");
if (MUTATION === "run-overlap") controllerSource = replaceOnce(controllerSource, "else runModifierKeys.delete(event.code);", "else runModifierKeys.clear();");
if (MUTATION === "run-shortcut") controllerSource = replaceOnce(controllerSource, "(pressed && hasShortcutModifier)", "false");
if (MUTATION === "run-editable") controllerSource = replaceOnce(controllerSource, "if (pressed && typingTarget) return;", "if (false) return;");
if (MUTATION === "run-blur") controllerSource = replaceOnce(controllerSource, "addListener(windowTarget, \"blur\", resetControlState);", "addListener(windowTarget, \"blur\", () => {});");
if (MUTATION === "run-pagehide") controllerSource = replaceOnce(controllerSource, "      resetControlState();\n      persistSession(true);", "      persistSession(true);");
if (MUTATION === "crossing-held-invalidation") controllerSource = replaceOnce(
  controllerSource,
  '    for (const control of Object.values(CONTROL_KEY_MAP)) {\n      if (control !== "jump") controlState[control] = false;\n    }\n    runModifierKeys.clear();',
  "    void controlState;",
);
if (MUTATION === "crossing-repeat-rearm") controllerSource = replaceOnce(
  controllerSource,
  "    if (crossingSuppressedKeyCodes.has(event.code)) {",
  "    if (false) {",
);
if (MUTATION === "first-person-crossing-correction") controllerSource = replaceOnce(
  controllerSource,
  "        position.add(firstPersonCrossingCorrectionWorld);",
  "        void firstPersonCrossingCorrectionWorld;",
);
if (MUTATION === "avatar-focus-seed-height") controllerSource = replaceOnce(
  controllerSource,
  "(Number(avatarPosition[1]) || 0) + PLAYER_CAMERA_DEFAULT.look_target_height_m",
  "Number(avatarPosition[1]) || 0",
);
if (MUTATION === "orientation-escape") controllerSource = replaceOnce(
  controllerSource,
  '(CONTROL_KEY_MAP[event.code] || event.key === "Escape")',
  "CONTROL_KEY_MAP[event.code]",
);

function segmentBetween(source, start, end) {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `missing segment start: ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(to, -1, `missing segment end: ${end}`);
  return source.slice(from, to);
}

function assertOrder(source, tokens, label) {
  let cursor = -1;
  for (const token of tokens) {
    const next = source.indexOf(token, cursor + 1);
    assert.notEqual(next, -1, `${label}: missing ${token}`);
    assert.ok(next > cursor, `${label}: out of order ${token}`);
    cursor = next;
  }
}

class FakeTarget {
  constructor(id = "") {
    this.id = id;
    this.style = {};
    this.hidden = false;
    this.parentNode = null;
    this.children = [];
    this.attributes = new Map();
    this.listeners = new Map();
  }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  dispatch(type, init = {}) {
    const event = { type, target: this, preventDefault() {}, stopPropagation() {}, ...init };
    for (const listener of this.listeners.get(type) || []) listener(event);
    return event;
  }
  listenerCount(type) { return this.listeners.get(type)?.size || 0; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) || null; }
  appendChild(child) { child.parentNode = this; this.children.push(child); }
  removeChild(child) { this.children = this.children.filter((value) => value !== child); child.parentNode = null; }
}

function createHarness({
  isPlayer = true,
  sceneLoadTarget = null,
  mountClientSceneLoad = async () => ({ ok: true }),
  isTypingTarget = () => false,
} = {}) {
  const trace = [];
  const frames = new Map();
  const cancelled = [];
  let nextFrame = 1;
  let clock = 0;
  const windowTarget = new FakeTarget("window");
  const mount = new FakeTarget("scene-mount");
  let currentMount = mount;
  const body = new FakeTarget("body");
  const documentTarget = new FakeTarget("document");
  documentTarget.body = body;
  documentTarget.createElement = (tag) => new FakeTarget(tag);
  const state = {
    avatar: { avatar_id: "avatar", position: [0, 0, 0], rotation_y: 0 },
    controls: { grounded: true },
    preview: { source_type: "fixture" },
  };
  const stepped = [];
  const forced = [];
  const runtime = {
    state,
    world: { location_id: "location-a" },
    stepAvatar(input, dt) { trace.push("step"); stepped.push({ input: { ...input }, dt }); },
    debugState: () => ({ avatar: state.avatar, controls: state.controls }),
    shouldAutoHandoff: () => false,
    markAutoHandoffObserved: () => trace.push("auto-observed"),
    broadcastPlayerPose: (options) => { trace.push("pose"); forced.push(options); },
  };
  const sceneCamera = new THREE.PerspectiveCamera();
  const localCamera = new THREE.PerspectiveCamera();
  let hostScene = new THREE.Scene();
  const avatarRig = new THREE.Group();
  hostScene.add(avatarRig);
  const localLayer = { camera: localCamera, avatarRig };
  const sceneRuntime = {
    avatarHost: () => ({ scene: hostScene, camera: sceneCamera, renderer: {} }),
    mountClientSceneLoad,
    renderChildFabricPreview: () => trace.push("child"),
    renderPortalPreviews: () => trace.push("portal"),
  };
  const controller = createMovementCameraController({
    THREE,
    isPlayer,
    role: isPlayer ? "player" : "source",
    windowTarget,
    documentTarget,
    lookup: (id) => id === "scene-mount" ? currentMount : null,
    requestFrame: (callback) => { const id = nextFrame++; frames.set(id, callback); return id; },
    cancelFrame: (id) => { cancelled.push(id); frames.delete(id); },
    now: () => clock,
    getRuntime: () => runtime,
    sceneRuntime,
    getAvatarLayers: () => ({ local: localLayer, peers: [] }),
    resolveClientSceneLoadTraversal: () => { trace.push("handoff"); return sceneLoadTarget; },
    persistPlayerSession: () => trace.push("persist"),
    refreshViewMatch: () => trace.push("verify"),
    renderOrientation: () => trace.push("orientation"),
    refreshDebugProjection: () => trace.push("debug"),
    updateMovementProjection: () => trace.push("movement-debug"),
    applyPortalOcclusion: () => { trace.push("camera"); return { active: false }; },
    logLine: () => {},
    showToast: () => trace.push("toast"),
    isTypingTarget,
  });
  return {
    controller, trace, frames, cancelled, windowTarget, documentTarget, mount, state, stepped, forced,
    sceneCamera, localCamera, avatarRig,
    setMount(nextMount) { currentMount = nextMount; },
    rehostAvatar(nextScene = new THREE.Scene()) {
      hostScene = nextScene;
      hostScene.add(avatarRig);
      return nextScene;
    },
    setClock(value) { clock = value; },
    runNextFrame(timestamp) {
      const [id, callback] = frames.entries().next().value || [];
      assert.ok(callback, "expected one queued frame");
      frames.delete(id);
      callback(timestamp);
    },
  };
}

let checks = 0;
async function check(name, assertion) {
  await assertion();
  checks += 1;
  process.stdout.write(`PASS ${String(checks).padStart(2, "0")} ${name}\n`);
}

const tickSource = segmentBetween(controllerSource, "  function tick(timestamp) {", "  function cameraButtonStyle() {");
const stopSource = segmentBetween(controllerSource, "  function stop() {", "  function handleCrossing(detail = {}) {");
const autoSource = segmentBetween(controllerSource, "  function maybeTriggerAutoHandoff() {", "  function scheduleNextFrame() {");

await check("production frame order and lifecycle tokens remain canonical", () => {
  assertOrder(tickSource, [
    "capabilities.stepAvatar(input, deltaSeconds);",
    "maybeTriggerAutoHandoff();",
    "capabilities.broadcastPlayerPose({ force: true });",
    "stepOrbitCamera(deltaSeconds);",
    "applyPlayerCamera();",
    "persistSession(false);",
    "groundAvatarVisualFeet(deltaSeconds);",
    "sceneRuntime.renderChildFabricPreview",
    "sceneRuntime.renderPortalPreviews();",
    "refreshViewMatch(timestamp);",
    "scheduleNextFrame();",
  ], "frame");
  assert.match(controllerSource, /started && frameHandle === null/);
  assert.match(stopSource, /cancelFrame\(frameHandle\)/);
  assert.match(stopSource, /removeListeners\(globalListeners\)/);
  assert.match(stopSource, /removeListeners\(mountListeners\)/);
});

await check("dt is capped at 50 ms and player movement is camera-relative", () => {
  assert.match(tickSource, /Math\.min\(0\.05,/);
  const harness = createHarness();
  harness.controller.start();
  harness.trace.length = 0;
  harness.windowTarget.dispatch("keydown", { code: "KeyW", repeat: false });
  harness.trace.length = 0;
  harness.runNextFrame(1000);
  assert.equal(harness.stepped[0].dt, 0.05);
  assert.equal(harness.stepped[0].input.forward, true);
  assert.equal(Number.isFinite(harness.stepped[0].input.camera_yaw), true);
  assertOrder(harness.trace.join("|"), ["step", "handoff", "camera", "persist", "child", "portal", "verify"], "runtime frame");
  harness.controller.dispose();
});

await check("Shift run input is hold-only, overlap-safe, repeat-safe, and lifecycle-safe", () => {
  assert.equal((controllerSource.match(/run: runModifierKeys\.size > 0/g) || []).length, 2);
  assert.match(controllerSource, /else runModifierKeys\.delete\(event\.code\);/);
  assert.match(controllerSource, /const hasShortcutModifier = event\.metaKey \|\| event\.ctrlKey \|\| event\.altKey;/);
  assert.match(controllerSource, /if \(\(!control && !isRunKey\) \|\| \(pressed && hasShortcutModifier\)\) return;/);
  assert.match(controllerSource, /if \(pressed && typingTarget\) return;/);
  assert.match(controllerSource, /addListener\(windowTarget, "blur", resetControlState\);/);
  assert.match(controllerSource, /addListener\(windowTarget, "pagehide", \(\) => \{\s+resetControlState\(\);/);
  const harness = createHarness({ isTypingTarget: (target) => target?.editable === true });
  const editable = new FakeTarget("editable");
  editable.editable = true;
  harness.controller.start();

  harness.windowTarget.dispatch("keydown", { code: "KeyW", repeat: false });
  harness.windowTarget.dispatch("keydown", { code: "ShiftLeft", repeat: false });
  harness.windowTarget.dispatch("keydown", { code: "ShiftLeft", repeat: true });
  harness.runNextFrame(50);
  assert.equal(harness.stepped.at(-1).input.forward, true);
  assert.equal(harness.stepped.at(-1).input.run, true);

  harness.windowTarget.dispatch("keydown", { code: "ShiftRight", repeat: false });
  harness.windowTarget.dispatch("keyup", { code: "ShiftLeft", repeat: false });
  harness.runNextFrame(100);
  assert.equal(harness.stepped.at(-1).input.run, true);

  harness.windowTarget.dispatch("keyup", { code: "ShiftRight", repeat: false });
  harness.runNextFrame(150);
  assert.equal(harness.stepped.at(-1).input.forward, true);
  assert.equal(harness.stepped.at(-1).input.run, false);

  harness.windowTarget.dispatch("keydown", { code: "ShiftLeft", repeat: false });
  harness.windowTarget.dispatch("keyup", { code: "ShiftLeft", repeat: false, target: editable });
  harness.runNextFrame(175);
  assert.equal(harness.stepped.at(-1).input.run, false, "editable-target release clears a Shift held before focus changed");

  harness.windowTarget.dispatch("keydown", { code: "ShiftRight", repeat: false });
  harness.windowTarget.dispatch("keyup", { code: "ShiftRight", repeat: false, metaKey: true });
  harness.runNextFrame(180);
  assert.equal(harness.stepped.at(-1).input.run, false, "shortcut-modified release clears the final held Shift");

  harness.windowTarget.dispatch("keyup", { code: "KeyW", repeat: false });
  harness.windowTarget.dispatch("keydown", { code: "ShiftLeft", repeat: false, metaKey: true });
  harness.windowTarget.dispatch("keydown", { code: "KeyW", repeat: false, ctrlKey: true });
  harness.windowTarget.dispatch("keydown", { code: "ShiftRight", repeat: false, target: editable });
  harness.runNextFrame(200);
  assert.equal(harness.stepped.at(-1).input.forward, false);
  assert.equal(harness.stepped.at(-1).input.run, false);

  harness.windowTarget.dispatch("keydown", { code: "ShiftLeft", repeat: false });
  harness.windowTarget.dispatch("blur");
  harness.runNextFrame(250);
  assert.equal(harness.stepped.at(-1).input.run, false);

  harness.windowTarget.dispatch("keydown", { code: "ShiftRight", repeat: false });
  harness.documentTarget.hidden = true;
  harness.documentTarget.dispatch("visibilitychange");
  harness.runNextFrame(300);
  assert.equal(harness.stepped.at(-1).input.run, false);

  harness.documentTarget.hidden = false;
  harness.windowTarget.dispatch("keydown", { code: "ShiftLeft", repeat: false });
  harness.windowTarget.dispatch("pagehide");
  harness.runNextFrame(350);
  assert.equal(harness.stepped.at(-1).input.run, false);

  harness.windowTarget.dispatch("keydown", { code: "ShiftLeft", repeat: false });
  assert.equal(harness.controller.movementDebug().run_mode, true);
  harness.controller.stop();
  assert.equal(harness.controller.movementDebug().run_mode, false);
  harness.controller.dispose();
});

await check("crossing-held planar and run keys stay latched off until keyup plus a fresh keydown", () => {
  assert.match(controllerSource, /crossingSuppressedKeyCodes\.has\(event\.code\)/);
  assert.match(controllerSource, /if \(control !== "jump" && controlState\[control\]\) crossingSuppressedKeyCodes\.add\(code\);/);
  assert.match(controllerSource, /if \(control !== "jump"\) controlState\[control\] = false;/);
  const harness = createHarness();
  harness.controller.start();

  harness.windowTarget.dispatch("keydown", { code: "KeyW", repeat: false });
  harness.windowTarget.dispatch("keydown", { code: "ShiftLeft", repeat: false });
  assert.equal(harness.controller.movementDebug().keys, "forward run");
  assert.equal(harness.controller.handleCrossing({ kind: "world_crossing" }), false);
  assert.equal(harness.controller.movementDebug().keys, "none");
  assert.equal(harness.controller.movementDebug().run_mode, false);

  harness.windowTarget.dispatch("keydown", { code: "KeyW", repeat: true });
  harness.windowTarget.dispatch("keydown", { code: "ShiftLeft", repeat: true });
  harness.runNextFrame(50);
  assert.equal(harness.stepped.at(-1).input.forward, false);
  assert.equal(harness.stepped.at(-1).input.run, false);
  assert.equal(harness.controller.movementDebug().keys, "none");

  harness.windowTarget.dispatch("keyup", { code: "KeyW", repeat: false });
  harness.windowTarget.dispatch("keyup", { code: "ShiftLeft", repeat: false });
  harness.windowTarget.dispatch("keydown", { code: "KeyW", repeat: false });
  harness.runNextFrame(100);
  assert.equal(harness.stepped.at(-1).input.forward, true);
  assert.equal(harness.stepped.at(-1).input.run, false);

  harness.windowTarget.dispatch("keydown", { code: "ShiftLeft", repeat: false });
  harness.runNextFrame(150);
  assert.equal(harness.stepped.at(-1).input.forward, true);
  assert.equal(harness.stepped.at(-1).input.run, true);
  harness.controller.dispose();
});

await check("start is idempotent and stop/dispose remove RAF and listeners", () => {
  const harness = createHarness();
  assert.equal(harness.controller.start(), true);
  assert.equal(harness.controller.start(), false);
  assert.equal(harness.frames.size, 1);
  assert.equal(harness.windowTarget.listenerCount("keydown"), 2);
  assert.equal(harness.controller.stop(), true);
  assert.equal(harness.frames.size, 0);
  assert.equal(harness.cancelled.length, 1);
  assert.equal(harness.windowTarget.listenerCount("keydown"), 0);
  assert.equal(harness.controller.start(), true);
  assert.equal(harness.frames.size, 1);
  harness.controller.dispose();
  assert.equal(harness.frames.size, 0);
});

await check("Escape reuses the singleton movement listener for orientation dismissal", () => {
  assert.match(controllerSource, /CONTROL_KEY_MAP\[event\.code\] \|\| event\.key === "Escape"/);
  const harness = createHarness();
  assert.equal(harness.controller.start(), true);
  assert.equal(harness.controller.start(), false);
  assert.equal(harness.windowTarget.listenerCount("keydown"), 2);
  harness.trace.length = 0;
  harness.windowTarget.dispatch("keydown", { code: "Escape", key: "Escape", repeat: false });
  assert.equal(harness.trace.filter((entry) => entry === "orientation").length, 1);
  harness.controller.dispose();
  harness.trace.length = 0;
  harness.windowTarget.dispatch("keydown", { code: "Escape", key: "Escape", repeat: false });
  assert.equal(harness.trace.filter((entry) => entry === "orientation").length, 0);
});

await check("observer input remains world-fixed and server view modes remain operable", () => {
  const harness = createHarness({ isPlayer: false });
  harness.controller.start();
  harness.runNextFrame(100);
  assert.equal(Object.hasOwn(harness.stepped[0].input, "camera_yaw"), false);
  assert.equal(harness.controller.setServerViewMode("top_down"), "top_down");
  assert.equal(harness.controller.serverViewCameraState().mode, "top_down");
  harness.controller.dispose();
});

await check("client-scene auto handoff is single-flight and a failure resets the guard", async () => {
  let rejectLoad;
  let loads = 0;
  const load = () => { loads += 1; return new Promise((_, reject) => { rejectLoad = reject; }); };
  const harness = createHarness({ sceneLoadTarget: { spatial_id: "airport" }, mountClientSceneLoad: load });
  harness.controller.start();
  harness.runNextFrame(16);
  harness.runNextFrame(32);
  assert.equal(loads, 1);
  rejectLoad(new Error("expected failure"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  harness.runNextFrame(48);
  assert.equal(loads, 2);
  harness.controller.dispose();
});

await check("grounded edges force the public pose facade", () => {
  const harness = createHarness();
  harness.controller.start();
  harness.runNextFrame(16);
  harness.state.controls.grounded = false;
  harness.runNextFrame(32);
  assert.deepEqual(harness.forced, [{ force: true }]);
  harness.controller.dispose();
});

await check("camera button, key toggle, orbit drive, and changed-host remount continuity are preserved", () => {
  const harness = createHarness();
  harness.controller.start();
  const button = harness.mount.children.find((child) => child.id === "btn-camera-mode");
  assert.ok(button);
  assert.equal(button.getAttribute("data-camera-view-mode"), "third_person");
  harness.windowTarget.dispatch("keydown", { code: "KeyC", repeat: false });
  assert.equal(harness.controller.playerCameraMode(), "first_person");
  const orbit = harness.controller.orbitBy(0.2, 0.1, 0.5);
  assert.ok(orbit.azimuth > 0);
  const replacementMount = new FakeTarget("scene-mount-recomposed");
  harness.setMount(replacementMount);
  harness.controller.refreshSceneHost();
  assert.equal(harness.mount.listenerCount("mousedown"), 0);
  assert.ok(replacementMount.children.some((child) => child.id === "btn-camera-mode"));
  harness.controller.dispose();
});

await check("first-person portal mapping survives destination scene rehost without a camera snap", () => {
  assert.match(controllerSource, /position\.add\(firstPersonCrossingCorrectionWorld\);[\s\S]*target\.add\(firstPersonCrossingCorrectionWorld\);/);
  const harness = createHarness();
  harness.controller.start();
  harness.controller.setPlayerCameraMode("first_person");
  const forward = [0, -Math.sin(0.22), Math.cos(0.22)];
  const mapping = {
    position: [4, 2, 5],
    focus: [3, 1.35, 4],
    forward,
  };
  harness.state.avatar.position = [3, 0, 4];
  assert.equal(harness.controller.handleCrossing({ kind: "world_crossing", camera_mapping: mapping }), true);
  harness.rehostAvatar();
  harness.avatarRig.position.set(...harness.state.avatar.position);
  harness.controller.applyPlayerCamera();
  harness.controller.updatePlayerCamera({ avatar: harness.state.avatar });
  const camera = harness.controller.playerCameraDebug();
  const distance = (left, right) => Math.hypot(...left.map((value, index) => value - right[index]));
  assert.ok(distance(camera.position, mapping.position) <= 0.002, "mapped first-person position must commit exactly");
  assert.ok(
    distance(camera.target, mapping.position.map((value, index) => value + forward[index])) <= 0.002,
    "mapped first-person focus ray must commit exactly",
  );
  assert.ok(camera.portal_crossing_camera_correction, "rehost correction must remain explicit in camera debug state");
  harness.controller.applyPlayerCamera();
  assert.ok(distance(harness.sceneCamera.position.toArray(), mapping.position) <= 0.000001, "next camera application snapped after commit");
  harness.controller.dispose();
});

await check("avatar-position camera seeds include the canonical eye-level focus before the first destination frame", () => {
  assert.match(controllerSource, /\(Number\(avatarPosition\[1\]\) \|\| 0\) \+ PLAYER_CAMERA_DEFAULT\.look_target_height_m/);
  const harness = createHarness();
  harness.controller.start();
  harness.controller.seedOrbitCamera({ azimuth: Math.PI, avatarPosition: [0, 0.07, -3] });
  harness.controller.updatePlayerCamera({ avatar: harness.state.avatar });
  assert.deepEqual(harness.controller.playerCameraDebug().target, [0, 1.42, -3]);
  harness.controller.dispose();
});

await check("public adapter facade delegates without exposing mutable movement internals", () => {
  assert.match(adapterSource, /broadcastPlayerPose\(\{ force = false \} = \{\}\) \{[\s\S]*return this\._maybeBroadcastPlayerPose\(\{ force: force === true \}\);/);
  assert.doesNotMatch(controllerSource, /LiveAdapter|\._maybeBroadcastPlayerPose|\._movementBounds|\._wowLocalWalk/);
  assert.match(appSource, /broadcastPlayerPose: \(options\) => adapter\.broadcastPlayerPose\(options\)/);
});

await check("Patch 8 arrival-content and SceneRuntime compatibility remain live", () => {
  assert.match(appSource, /const destContent = isPlayer \? destinationLoadingContent\(\) : null;/);
  assert.match(appSource, /movementCameraController\.handleCrossing\(detail\)/);
  assert.match(appSource, /sceneRuntimeController\.mountClientSceneLoad\(target\)/);
  assert.doesNotMatch(controllerSource, /new Scene|new THREE\.WebGLRenderer|SpatialPortalPreviewManager/);
});

await check("camera mode, auto-handoff reset, lazy persistence, and preview seams are explicit", () => {
  assert.match(controllerSource, /if \(!capabilities \|\| autoHandoffStarted\) return;/);
  assert.match(autoSource, /autoHandoffStarted = false;[\s\S]*client scene load failed/);
  assert.match(controllerSource, /event\.code !== "KeyC"[\s\S]*togglePlayerCameraMode\(\);/);
  assert.match(tickSource, /applyPlayerCamera\(\);[\s\S]*persistSession\(false\);/);
  assert.match(tickSource, /if \(isPlayer\) sceneRuntime\.renderChildFabricPreview[\s\S]*renderPortalPreviews[\s\S]*refreshViewMatch/);
  assert.match(controllerSource, /if \(nextMount !== sceneMount\) \{[\s\S]*sceneMount = nextMount;/);
});

await check("camera-wall treatment selects the real blocker and restores exact state across lifecycle boundaries", () => {
  const harness = createHarness();
  const material = new THREE.MeshStandardMaterial({ color: 0x2a7ac4, side: THREE.DoubleSide });
  const leftWall = new THREE.Mesh(new THREE.PlaneGeometry(12, 5), material);
  leftWall.rotation.y = Math.PI / 2;
  leftWall.position.set(-6, 2.5, 0);
  const backWall = new THREE.Mesh(new THREE.PlaneGeometry(12, 5), material);
  backWall.position.set(0, 2.5, -6);
  const scene = new THREE.Scene();
  scene.add(leftWall, backWall);
  const camera = new THREE.PerspectiveCamera();
  const impl = { scene, camera };
  const blockedCamera = new THREE.Vector3(-8, 1.35, 0);
  const clearCamera = new THREE.Vector3(-5, 1.35, 0);
  const focus = new THREE.Vector3(0, 1.35, 0);
  const options = {
    impl,
    candidates: [],
    wallCandidates: [leftWall, backWall],
    sceneId: scene.uuid,
    worldId: "location-a",
  };
  const materialPreimage = {
    transparent: material.transparent,
    opacity: material.opacity,
    depthWrite: material.depthWrite,
    depthTest: material.depthTest,
    side: material.side,
    color: material.color.getHexString(),
    emissive: material.emissive.getHexString(),
  };

  harness.controller.updatePortalOcclusion(blockedCamera, focus, "player_third_person", options);
  let state = harness.controller.cameraWallOcclusionState();
  assert.equal(state.active, true);
  assert.equal(state.hit_wall.uuid, leftWall.uuid);
  assert.equal(state.affected_meshes[0].uuid, leftWall.uuid);
  assert.equal(leftWall.visible, false);
  assert.equal(backWall.visible, true);
  assert.deepEqual({
    transparent: material.transparent,
    opacity: material.opacity,
    depthWrite: material.depthWrite,
    depthTest: material.depthTest,
    side: material.side,
    color: material.color.getHexString(),
    emissive: material.emissive.getHexString(),
  }, materialPreimage, "shared wall material is never mutated");

  harness.controller.updatePortalOcclusion(clearCamera, focus, "player_third_person", options);
  assert.equal(leftWall.visible, false, "one-frame clear hysteresis prevents corner flicker");
  harness.controller.updatePortalOcclusion(clearCamera, focus, "player_third_person", options);
  state = harness.controller.cameraWallOcclusionState();
  assert.equal(state.active, false);
  assert.equal(leftWall.visible, true, "wall restores within two updates");
  assert.deepEqual(state.restored.at(-1).original_state.materials, state.restored.at(-1).restored_state.materials);

  harness.controller.updatePortalOcclusion(blockedCamera, focus, "player_third_person", options);
  harness.controller.updatePortalOcclusion(blockedCamera, focus, "player_first_person", options);
  assert.equal(leftWall.visible, true, "first person restores immediately");

  harness.controller.updatePortalOcclusion(blockedCamera, focus, "player_third_person", { ...options, faultArm: "disabled" });
  assert.equal(leftWall.visible, true, "disabled treatment preserves raw-depth wall");
  assert.equal(harness.controller.cameraWallOcclusionState().hit_wall.uuid, leftWall.uuid);

  harness.controller.updatePortalOcclusion(blockedCamera, focus, "player_third_person", { ...options, faultArm: "wrong_wall" });
  state = harness.controller.cameraWallOcclusionState();
  assert.equal(state.hit_wall.uuid, leftWall.uuid);
  assert.equal(state.affected_meshes[0].uuid, backWall.uuid);
  assert.equal(leftWall.visible, true);
  assert.equal(backWall.visible, false);
  harness.controller.updatePortalOcclusion(blockedCamera, focus, "player_first_person", options);

  harness.controller.updatePortalOcclusion(blockedCamera, focus, "player_third_person", options);
  harness.controller.updatePortalOcclusion(clearCamera, focus, "player_third_person", { ...options, faultArm: "non_restoration" });
  harness.controller.updatePortalOcclusion(clearCamera, focus, "player_third_person", { ...options, faultArm: "non_restoration" });
  assert.equal(leftWall.visible, false, "non-restoration fault remains observably wrong");
  harness.controller.updatePortalOcclusion(clearCamera, focus, "player_first_person", options);
  assert.equal(leftWall.visible, true);

  harness.controller.updatePortalOcclusion(blockedCamera, focus, "player_third_person", options);
  harness.controller.updatePortalOcclusion(blockedCamera, focus, "player_third_person", {
    impl: { scene: new THREE.Scene(), camera },
    candidates: [],
    wallCandidates: [],
    sceneId: "replacement",
    worldId: "location-b",
  });
  assert.equal(leftWall.visible, true, "scene replacement restores the stale wall");

  harness.controller.updatePortalOcclusion(blockedCamera, focus, "player_third_person", options);
  harness.controller.dispose();
  assert.equal(leftWall.visible, true, "controller disposal restores the wall");
});

if (!MUTATION) {
  const mutationArms = [
    "frame-order", "raf-singleton", "raf-cancel", "listener-cleanup", "dt-cap", "auto-guard",
    "auto-reset", "grounded-edge", "lazy-persist", "camera-mode", "preview-order", "host-refresh", "public-facade", "patch8-compat",
    "run-input", "run-overlap", "run-shortcut", "run-editable", "run-blur", "run-pagehide",
    "crossing-held-invalidation", "crossing-repeat-rearm",
    "first-person-crossing-correction",
    "avatar-focus-seed-height",
    "orientation-escape",
  ];
  for (const arm of mutationArms) {
    let red = false;
    try {
      execFileSync(process.execPath, [fileURLToPath(import.meta.url)], {
        cwd: ROOT,
        env: { ...process.env, feature_MOVEMENT_MUTATION: arm },
        encoding: "utf8",
        stdio: "pipe",
      });
    } catch (error) {
      red = Number.isInteger(error.status) && error.status !== 0;
    }
    assert.equal(red, true, `mutation ${arm} must turn RED`);
    process.stdout.write(`RED_CAUGHT ${arm}\n`);
  }
  process.stdout.write(`feature_MOVEMENT_CAMERA_CONTROLLER PASS ${checks}/16 mutations=${mutationArms.length}/${mutationArms.length}\n`);
}
