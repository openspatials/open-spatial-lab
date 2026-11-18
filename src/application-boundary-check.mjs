import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createApplicationState } from "../web/application-state.mjs";
import { describeScene, normalizeGraph } from "../runtime/scene-core/public/scene-description.mjs";
import { buildWowScene } from "../web/wow-scene.mjs";
import { airportSurfaceBounds } from "../web/airport-walkable-surface.mjs";
import { createHarness, THREE, FakeTarget } from "../tools/behavior/controller-harness.mjs";
import { nodeChecks } from "../tools/behavior/node-checks.mjs";

const { check, finish } = nodeChecks("application-boundary");
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const idle = () => new Promise(resolve => setImmediate(resolve));
const stateFixture = () => {
  let live = { state: { avatar: { position: [0, 0, 0] } }, world: { title: "World", location_id: "lobby" }, wowResolved: () => null };
  return { state: createApplicationState({ getAdapter: () => live }), replace() { live = { ...live }; } };
};

await check("readiness", "Graph construction and publication wait for adapter readiness", async () => {
  const { state } = stateFixture();
  const gate = deferred();
  const calls = [];
  const handle = Object.freeze({ id: "opaque" });
  const pending = state.composeScene({
    prepare: () => ({ handle, ready: () => gate.promise, dispose: () => calls.push("dispose") }),
    construct: value => { assert.equal(value, handle); calls.push("construct", "publish"); return "mounted"; },
  });
  await idle();
  assert.deepEqual(calls, [], "no construction before readiness");
  gate.resolve();
  assert.equal(await pending, "mounted");
  assert.deepEqual(calls, ["construct", "publish"]);
  state.dispose();
});

await check("retired-readiness", "Disposed, replaced and cancelled readiness cannot construct or publish", async () => {
  for (const reason of ["dispose", "replace", "cancel", "adapter", "reject"]) {
    const fixture = stateFixture(), gate = deferred(), calls = [];
    const pending = fixture.state.composeScene({
      prepare: () => ({ handle: "old", ready: () => gate.promise, dispose: () => calls.push("dispose") }),
      construct: () => calls.push("stale-construction"),
    });
    const rejected = assert.rejects(pending, reason === "reject" ? /expected/ : { name: "AbortError" });
    if (reason === "dispose") fixture.state.dispose();
    if (reason === "cancel") fixture.state.cancelComposition();
    if (reason === "adapter") fixture.replace();
    if (reason === "replace") await fixture.state.composeScene({
      prepare: () => ({ ready: async () => {}, dispose() {} }), construct: () => calls.push("replacement"),
    });
    if (reason === "reject") gate.reject(new Error("expected")); else gate.resolve();
    await rejected;
    assert.equal(calls.includes("stale-construction"), false, `${reason}: stale graph published`);
    assert.equal(calls.filter(call => call === "dispose").length, 1, `${reason}: retired surface must release once`);
    fixture.state.dispose();
  }
});

await check("scene-readiness-integration", "The real scene runtime constructs only the current ready graph", async () => {
  const sourceUrl = new URL("../web/scene-runtime-controller.mjs", import.meta.url);
  let source = readFileSync(sourceUrl, "utf8")
    .replace(/import \{ SpatialPortalPreviewManager \} from .*?;/, "const SpatialPortalPreviewManager = class {};")
    .replace(/import \{ composeBoundedPreview \} from .*?;/, "const composeBoundedPreview = () => { throw new Error('preview outside fixture'); };");
  source = source.replace(/from "(\.\/[^\"]+)"/g, (_, path) => `from ${JSON.stringify(new URL(path, sourceUrl).href)}`);
  const { createSceneRuntimeController } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  const fixture = stateFixture(), gates = [], adapters = [], published = [], constructed = [];
  const mount = new FakeTarget(), body = new FakeTarget();
  const documentTarget = { body, createElement: () => new FakeTarget(), getElementById: () => null };
  class Scene {
    constructor(_mount, _role, world, options) {
      constructed.push(world.title); assert.equal(options.sceneDescription.world, world);
      this._impl = { renderAdapter: options.renderAdapter, renderer: options.renderAdapter.renderer, scene: {}, camera: {} };
      this.rendererKind = "webgl";
    }
    setAvatar() {} setPhase() {}
    dispose() { this._impl.renderAdapter.dispose(); }
  }
  const runtime = createSceneRuntimeController({
    THREE, applicationState: fixture.state, SceneClass: Scene, isPlayer: false, role: "source",
    locationHref: "http://localhost/?avatarRender=explicit",
    getMount: () => mount, getRuntime: fixture.state.runtime, getAvatarLayers: () => ({ peers: [] }),
    documentTarget, windowTarget: new FakeTarget(), onSceneChanged: scene => { if (scene) published.push(scene); },
    createRenderAdapter: () => {
      const gate = deferred(); gates.push(gate);
      const adapter = { renderer: { domElement: new FakeTarget(), forceContextLoss() { adapter.released++; } }, released: 0, disposed: 0,
        mount(host) { host.appendChild(this.renderer.domElement); }, ready: () => gate.promise, attach() {},
        sceneRoot: {}, bindings: [], poses: [], skinDisposals: 0,
        bindSkin(descriptor) { assert.equal(descriptor.schema, "avatar-render/1"); const skin = { supported: true, root: {} }; this.bindings.push(skin); return skin; },
        setSkinPose(skin, pose) { this.poses.push({ skin, pose }); }, add() {}, setVisible(node, visible) { node.visible = visible; },
        disposeSkin() { this.skinDisposals++; },
        dispose() { this.disposed++; this.renderer.domElement.parentNode?.removeChild(this.renderer.domElement); } };
      adapters.push(adapter); return adapter;
    },
  });
  runtime.publishTerminalReadyWorld("world-airport-terminal");
  assert.equal(body.getAttribute("data-airport-terminal-ready"), "1", "airport terminal alias published");
  runtime.publishTerminalReadyWorld("other-world");
  assert.equal(body.getAttribute("data-terminal-ready-world"), "other-world");
  assert.equal(body.getAttribute("data-airport-terminal-ready"), null, "other terminal is not airport readiness");
  runtime.publishTerminalReadyWorld(null);
  assert.equal(body.getAttribute("data-terminal-ready-world"), null, "null clears terminal publication");
  runtime.publishTerminalReadyWorld("world-airport-terminal");
  const first = runtime.mountLive({ world: { title: "old" }, sceneRole: "source", phase: "idle" });
  const oldResult = first.catch(error => error);
  await idle(); assert.equal(constructed.length, 0, "runtime must await ready before constructing");
  const second = runtime.mountLive({ world: { title: "new" }, sceneRole: "source", phase: "idle" });
  gates[1].resolve(); await second; gates[0].resolve(); assert.equal((await oldResult).name, "AbortError");
  assert.deepEqual(constructed, ["new"]); assert.equal(published.length, 1);
  assert.equal(body.getAttribute("data-terminal-ready-world"), null, "replacement clears old terminal publication");
  assert.equal(body.getAttribute("data-airport-terminal-ready"), null);
  assert.equal(adapters[0].disposed, 1); assert.equal(adapters[0].released, 1);
  const mesh = { isMesh: true, layers: { mask: 1 } }, model = { visible: true, traverse: callback => callback(mesh) };
  const pose = { rig: { schema: "avatar-render/1" }, jointLocalMatrices: [] };
  const layer = { _avatarModel: model, avatarRig: { visible: true }, evaluatedPose: () => pose, status: {} };
  runtime.publishEvaluatedPoses({ local: layer, peers: [] });
  runtime.publishEvaluatedPoses({ local: layer, peers: [] });
  assert.equal(adapters[1].bindings.length, 1, "explicit resources bind once per instance");
  assert.equal(adapters[1].poses[0].pose, pose, "common application sends complete poses, not just joint arrays");
  assert.equal(mesh.layers.mask, 0, "only independent mesh contributes pixels");
  model.visible = false; runtime.publishEvaluatedPoses({ local: layer, peers: [] });
  assert.equal(adapters[1].bindings[0].root.visible, false, "first person visibility reaches independent graph");
  runtime.publishEvaluatedPoses({ local: null, peers: [] });
  assert.equal(adapters[1].skinDisposals, 1, "retired avatar binding releases immediately");
  assert.equal(mesh.layers.mask, 1, "evaluator drawing mask restored on retirement");
  runtime.publishEvaluatedPoses({ local: layer, peers: [] });
  runtime.publishTerminalReadyWorld("world-airport-terminal");
  const failed = runtime.mountLive({ world: { title: "failed" }, sceneRole: "source", phase: "idle" });
  const failedReady = assert.rejects(failed, /readiness failed/);
  gates[2].reject(new Error("readiness failed")); await failedReady;
  assert.equal(body.getAttribute("data-terminal-ready-world"), "world-airport-terminal", "failed preparation preserves current mounted publication");
  const third = runtime.mountLive({ world: { title: "retired" }, sceneRole: "source", phase: "idle" });
  const thirdRejected = assert.rejects(third, { name: "AbortError" });
  runtime.dispose(); gates[3].resolve(); await thirdRejected;
  runtime.publishTerminalReadyWorld("world-airport-terminal");
  assert.equal(body.getAttribute("data-terminal-ready-world"), null, "disposed or retired mounts cannot publish terminal readiness");
  assert.equal(body.getAttribute("data-airport-terminal-ready"), null);
  assert.deepEqual(constructed, ["new"]); assert.equal(published.length, 1);
  assert.equal(adapters[2].disposed, 1); assert.equal(adapters[2].released, 1);
  assert.equal(adapters[3].disposed, 1); assert.equal(adapters[3].released, 1);
  assert.equal(adapters[1].skinDisposals, 2, "current avatar binding released on scene disposal");
  assert.equal(mount.children.length, 0, "all owned surfaces detached"); fixture.state.dispose();
});

const airport = JSON.parse(readFileSync(new URL("../web/worlds/denver-skyport.json", import.meta.url)));
function transactionFixture({ failEnter = false, gate = null, surfaces = null } = {}) {
  const trace = [];
  let active = false, entry;
  const live = {
    state: { avatar: {} }, world: { location_id: "lobby" },
    resolveClientSceneLoad: async () => { trace.push("resolve"); return { graph: airport }; },
    beginVisualTransition: () => trace.push("begin"), commitVisualTransition: () => trace.push("commit-state"),
    abortVisualTransition: () => trace.push("abort"), debugState: () => ({ client_scene_load: { active } }),
    enterClientSceneLoad: async value => { trace.push("enter"); entry = value; if (gate) await gate.promise;
      if (!value.isCurrent()) return { ok: false, reason: "retired" };
      active = true; if (failEnter) throw new Error("entered then failed"); return { ok: true }; },
    returnFromClientSceneLoad: async () => { trace.push("return"); active = false; return { ok: true }; },
  };
  const state = createApplicationState({ getAdapter: () => live });
  const target = { transition: "client_scene_load", spatial_id: airport.spatialID, graph_endpoint: "fixture" };
  const renderer = {
    isCurrent: () => true,
    prepare: async () => { trace.push("prepare"); return { handle: "opaque", walkable: {
      entry_ground: { ok: true, surface_y_m: 6 }, surfaces: surfaces || [{ center_m: [10, 5, 30], size_m: [4, 2, 8] }],
    }, dispose: () => trace.push("release") }; },
    commit: (handle, value) => { assert.equal(handle, "opaque"); trace.push("publish"); return value; },
    rollback: () => trace.push("rollback-renderer"),
  };
  return { state, live, target, renderer, trace, entry: () => entry };
}

await check("client-transaction", "Application entry preserves ordering, exact x/z bounds and rollback", async () => {
  const h = transactionFixture();
  await h.state.loadClientScene(h.target, h.renderer);
  assert.deepEqual(h.trace, ["resolve", "prepare", "begin", "enter", "commit-state", "publish"], "transaction phases must be ordered");
  assert.deepEqual(h.entry().bounds, { minX: 8, maxX: 12, minZ: 26, maxZ: 34 }, "movement bounds use x/z and existing keys");
  assert.equal(h.entry().contract.entry_spawn.position[1], 6);
  assert.equal(airportSurfaceBounds([]), null, "empty surfaces preserve null bounds");
  const bad = transactionFixture({ failEnter: true });
  await assert.rejects(bad.state.loadClientScene(bad.target, bad.renderer), /entered then failed/);
  assert.deepEqual(bad.trace, ["resolve", "prepare", "begin", "enter", "release", "return", "abort"]);
  h.state.dispose(); bad.state.dispose();
});

await check("retired-entry", "Disposal during asynchronous entry cannot commit or draw", async () => {
  for (const phase of ["resolve", "prepare", "enter"]) {
    const gate = deferred(), h = transactionFixture({ gate: phase === "enter" ? gate : null });
    if (phase === "resolve") h.live.resolveClientSceneLoad = () => gate.promise;
    if (phase === "prepare") {
      const prepare = h.renderer.prepare;
      h.renderer.prepare = async () => { await gate.promise; return prepare(); };
    }
    const pending = h.state.loadClientScene(h.target, h.renderer);
    await idle();
    await assert.rejects(h.state.loadClientScene(h.target, h.renderer), /already in flight/);
    let retired = false;
    const settled = pending.catch(error => { assert.equal(error.name, "AbortError"); retired = true; });
    h.state.dispose(); await idle();
    assert.equal(retired, true, `${phase}: cancellation must reject before remote settlement`);
    assert.equal(h.trace.filter(call => call === "release").length, phase === "enter" ? 1 : 0, `${phase}: prepared renderer releases immediately`);
    gate.resolve({ graph: airport }); await settled; await idle();
    assert.equal(h.trace.includes("commit-state"), false, "retired entry must not commit");
    assert.equal(h.trace.includes("publish"), false, "retired entry must not draw");
    assert.equal(h.trace.filter(call => call === "release").length, phase === "resolve" ? 0 : 1, `${phase}: prepared renderer releases exactly once`);
  }
});

await check("plain-camera", "Input, smoothing, both camera modes and crossing run on plain records", () => {
  let mountToken = 1, head = [2, 3, 4];
  const applied = [];
  const bridge = {
    measure: () => ({ mountToken, rigHosted: true, head, equipment: null }),
    apply: intent => { assert.equal(Array.isArray(intent.position), true); applied.push(structuredClone(intent)); return [[0, 0, 0, 1]]; },
    setAvatarVisibility() {}, ground() {}, groundingState: () => ({}), resetGrounding() {},
    cameraWallOcclusionState: () => null, restoreCameraWallTreatment() {}, dispose() {},
  };
  const h = createHarness({ cameraBridge: bridge });
  h.controller.start();
  h.controller.orbitBy(1, .1, 1);
  h.runNextFrame(16);
  assert.ok(h.controller.orbitState().azimuth > 0 && h.controller.orbitState().azimuth < 1, "camera smoothing must interpolate");
  h.controller.setPlayerCameraMode("first_person");
  h.controller.handleCrossing({ camera_mapping: { position: [20, 4, 30], focus: [20, 4, 31], forward: [0, 0, 1] } });
  assert.notDeepEqual(applied.at(-1).position, [20, 4, 30], "mapping waits for destination mount");
  mountToken = 2; head = [10, 3, 20]; h.controller.applyPlayerCamera();
  assert.deepEqual(applied.at(-1).position, [20, 4, 30], "plain mount token commits mapped camera");
  h.controller.setPlayerCameraMode("third_person");
  h.controller.handleCrossing({ heading_continuity: { crossing_yaw_delta_rad: Math.PI / 2 } });
  assert.ok(Math.abs(h.controller.movementBasisYaw() - Math.PI / 2) < 1e-12, "heading and movement basis agree");
  h.controller.dispose(); assert.equal(h.frames.size, 0);
  const observer = createHarness({ isPlayer: false, cameraBridge: bridge });
  observer.controller.start(); observer.controller.setServerViewMode("top_down");
  assert.deepEqual(applied.at(-1), { position: [0, 14.5, 0], target: [0, 0, 0], up: [0, 0, -1], room_half_extent_m: 6 });
  observer.controller.dispose(); assert.equal(observer.frames.size, 0);
});

await check("scene-description", "Active builders consume plain light and graph label descriptions", async () => {
  const fixture = stateFixture();
  const graph = { spatialID: "test", root: 1, nodes: [{ id: 1, children: [{ id: 2, label: "Nested light", spatialAssetURI: "osl-light:directional?intensity=0.37&color=123456" }] }] };
  assert.equal(normalizeGraph(graph).nodes.size, 2);
  const description = fixture.state.sceneDescription({ graph });
  assert.equal(description.graph, graph, "projection retains canonical graph authority");
  description.nodes.find(node => node.id === 2).light.intensity = .23;
  const built = buildWowScene(graph, THREE, { sceneDescription: description });
  const lights = []; built.scene.traverse(node => { if (node.isLight) lights.push(node); });
  assert.equal(lights.length, 1); assert.equal(lights[0].intensity, .23, "authored builder consumes supplied lighting");
  assert.equal(lights[0].color.getHex(), 0x123456);
  const stage = buildWowScene({ nodes: [{ id: 1 }] }, THREE);
  const stageLights = []; stage.scene.traverse(node => { if (node.isLight) stageLights.push(node.intensity); });
  assert.deepEqual(stageLights, [.6, .85, .4], "authored default intensities stay exact");
  const path = new URL("../runtime/scene-core/public/canonical-world-content.js", import.meta.url);
  const source = readFileSync(path, "utf8").replace('"./scene-description.mjs"', JSON.stringify(new URL("./scene-description.mjs", path).href));
  const { mountCanonicalWorldContent } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  const world = { color: "#3aa0ff" }, plain = describeScene({ world }), scene = new THREE.Scene();
  mountCanonicalWorldContent(scene, THREE, world, { sceneDescription: plain });
  assert.deepEqual(scene.children.filter(node => node.isLight).map(node => [node.intensity, node.position.toArray()]), [[.75, [0, 0, 0]], [.9, [4, 8, 6]]]);
  assert.deepEqual(fixture.state.describeObjects([{ object_id: "old" }, { object_id: "restricted", asset_access: "restricted" }]).map(object => object.asset_access), ["public", "restricted"]);
  fixture.state.dispose();
});

await check("prefetch-ring-lifetime", "Replaced and deleted rings release only their own resources once", async () => {
  const engine = await import(new URL("../runtime/scene-core/public/vendor/three/three.module.js", import.meta.url).href);
  const moduleUrl = new URL("../web/three-world-presentation.mjs", import.meta.url);
  const source = readFileSync(moduleUrl, "utf8")
    .replace(/import \* as THREE from .*?;/, "const THREE = globalThis.__ringFixtureEngine;")
    .replace(/import \{ hexColorFromFabricBackground[^;]+;/, "const CHILD_FABRIC_LAYER = 1;");
  globalThis.__ringFixtureEngine = engine;
  const { createThreeWorldPresentation } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  delete globalThis.__ringFixtureEngine;
  const scene = new engine.Scene(), impl = { scene };
  const presentation = createThreeWorldPresentation({ getScene: () => ({ rendererKind: "webgl", _impl: impl }) });
  const machine = radius => ({ supported: true, zones: { prefetch: { radius_m: radius } } });
  const debug = { controls: { portal_center: [0, 0, 0], portals: [{ portal_id: "extra", center: [4, 0, 0] }] }, fabric_prefetch: { ...machine(2), keyed: { focus_portal_id: "focus", machines: { extra: machine(2) } } } };
  const counts = ring => {
    const count = { geometry: 0, material: 0 };
    ring.geometry.addEventListener("dispose", () => count.geometry++);
    ring.material.addEventListener("dispose", () => count.material++);
    return count;
  };
  const unrelated = new engine.Mesh(new engine.BoxGeometry(), new engine.MeshBasicMaterial()); scene.add(unrelated);
  const unrelatedCounts = counts(unrelated);
  const update = () => presentation.ensureFabricPrefetchZoneRing(debug);
  update();
  const primary = scene.getObjectByName("fabric-prefetch-zone-ring"), extra = impl.additionalFabricZoneRings.extra;
  const primaryCounts = counts(primary), extraCounts = counts(extra);
  update(); assert.equal(scene.getObjectByName(primary.name), primary); assert.equal(impl.additionalFabricZoneRings.extra, extra);
  assert.deepEqual(primaryCounts, { geometry: 0, material: 0 }); assert.deepEqual(extraCounts, { geometry: 0, material: 0 });
  debug.fabric_prefetch.zones.prefetch.radius_m = 3; debug.fabric_prefetch.keyed.machines.extra = machine(3); update(); update();
  assert.equal(primary.parent, null); assert.equal(extra.parent, null);
  assert.deepEqual(primaryCounts, { geometry: 1, material: 1 }, "primary ring resources release once");
  assert.deepEqual(extraCounts, { geometry: 1, material: 1 }, "additional ring resources release once");
  const replacement = impl.additionalFabricZoneRings.extra, replacementCounts = counts(replacement);
  debug.fabric_prefetch.keyed.machines = {}; update(); update();
  assert.equal(replacement.parent, null); assert.equal(impl.additionalFabricZoneRings.extra, undefined);
  assert.deepEqual(replacementCounts, { geometry: 1, material: 1 }, "deleted ring resources release once");
  assert.equal(unrelated.parent, scene); assert.deepEqual(unrelatedCounts, { geometry: 0, material: 0 });
  for (const node of [...scene.children]) { node.removeFromParent(); node.geometry.dispose(); node.material.dispose(); }
});

await check("module-routes", "Browser and Node resolve shared projection to the same source", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url)));
  const html = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
  const map = JSON.parse(html.match(/<script type="importmap">([\s\S]*?)<\/script>/)[1]).imports;
  assert.equal(map["#scene-description"], "./vendor/scene-core/scene-description.mjs");
  assert.equal(packageJson.imports["#scene-description"], "./runtime/scene-core/public/scene-description.mjs");
});

const fault = (statement, name, file, find, replace, expect) => ({ statement, name, expect, edits: [{ file, find, replace }] });
await finish({ checkFile: "src/application-boundary-check.mjs", faults: [
  fault("scene-readiness-integration", "terminal clear omitted", "web/scene-runtime-controller.mjs", 'publishTerminalReadyWorld(null);', 'void 0;', /replacement clears old terminal publication/),
  fault("scene-readiness-integration", "retired terminal publication allowed", "web/scene-runtime-controller.mjs", 'if (disposed && spatialId) return;', 'void disposed;', /disposed or retired mounts cannot publish terminal readiness/),
  fault("prefetch-ring-lifetime", "ring geometry is not released", "web/three-world-presentation.mjs", "ring.geometry.dispose();", "void ring.geometry;", /primary ring resources release once/),
  fault("prefetch-ring-lifetime", "ring material is not released", "web/three-world-presentation.mjs", "ring.material.dispose();", "void ring.material;", /primary ring resources release once/),
  fault("readiness", "readiness is skipped", "web/application-state.mjs", "await Promise.race([prepared.ready(), cancelled]);", "await Promise.resolve();", /no construction before readiness/),
  fault("scene-readiness-integration", "scene runtime bypasses application readiness", "web/scene-runtime-controller.mjs", "return composeRenderer(renderAdapter => mountReadyLive({ ...options, renderAdapter }), { allowCanvas: !activeAuthoredGraph(options.world) });", "return Promise.resolve(mountReadyLive({ ...options, renderAdapter: prepareRenderer().handle }));", /runtime must await ready before constructing/),
  fault("scene-readiness-integration", "evaluator still contributes pixels", "web/scene-runtime-controller.mjs", "mesh.layers.mask = 0;", "mesh.layers.mask = 1;", /only independent mesh contributes pixels/),
  fault("scene-readiness-integration", "retired binding is not released", "web/scene-runtime-controller.mjs", "binding.adapter.disposeSkin?.(binding.skin);", "void binding.skin;", /retired avatar binding releases immediately/),
  fault("retired-readiness", "stale ready callbacks can build", "web/application-state.mjs", "if (disposed || generation !== compositionGeneration || adapter() !== live) throw retired();", "if (false) throw retired();", /Missing expected rejection/),
  fault("retired-readiness", "retired renderer is not released", "web/application-state.mjs", "released = true; prepared.dispose();", "released = true;", /retired surface must release once/),
  fault("client-transaction", "z bounds read height", "web/airport-walkable-surface.mjs", "surface.center_m[2] - halfZ", "surface.center_m[1] - halfZ", /movement bounds use x\/z/),
  fault("client-transaction", "state commits after draw", "web/application-state.mjs", "live.commitVisualTransition?.({ emit: true });", "void live.commitVisualTransition;", /transaction phases must be ordered/),
  fault("retired-entry", "disposal waits for entry completion", "web/application-state.mjs", "cancelClientScene?.(); cancelComposition();", "cancelComposition();", /cancellation must reject before remote settlement/),
  fault("plain-camera", "smoothing snaps", "web/movement-camera-controller.mjs", "Math.min(1, Math.max(0, (Number(deltaSeconds) || 0) * dampingPerSecond))", "1", /camera smoothing must interpolate/),
  fault("plain-camera", "crossing ignores mount token", "web/movement-camera-controller.mjs", "measured.mountToken !== pendingFirstPersonCrossingMapping.source_mount", "true", /mapping waits for destination mount/),
  fault("scene-description", "builder ignores supplied light description", "web/wow-scene.mjs", "opts.sceneDescription || describeScene({ graph })", "describeScene({ graph })", /authored builder consumes supplied lighting/),
] });
