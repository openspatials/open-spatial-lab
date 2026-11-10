import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createApplicationState } from "../web/application-state.mjs";
import { THREE, FakeTarget } from "../tools/behavior/controller-harness.mjs";
import { nodeChecks } from "../tools/behavior/node-checks.mjs";

const { check, finish } = nodeChecks("scene-lifecycle");
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const sourceUrl = new URL("../web/scene-runtime-controller.mjs", import.meta.url);
const source = readFileSync(sourceUrl, "utf8")
  .replace(/import \{ SpatialPortalPreviewManager \} from .*?;/, "const SpatialPortalPreviewManager = class {};")
  .replace(/import \{ composeBoundedPreview \} from .*?;/, "const composeBoundedPreview = () => { throw new Error('preview outside fixture'); };")
  .replace(/from "(\.\/[^\"]+)"/g, (_, path) => `from ${JSON.stringify(new URL(path, sourceUrl).href)}`);
const { createSceneRuntimeController } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
const graph = JSON.parse(readFileSync(new URL("../web/worlds/denver-skyport.json", import.meta.url)));

function fixture() {
  const trace = [], adapters = [], requests = [], frames = [], builds = [];
  const host = Object.assign(new FakeTarget(), { clientWidth: 800, clientHeight: 600 });
  const body = new FakeTarget(), elements = Object.fromEntries(["loc-title", "loc-meta", "live-backend"].map(id => [id, new FakeTarget()]));
  const documentTarget = { body, createElement: () => new FakeTarget(), getElementById: id => elements[id] };
  const windowTarget = Object.assign(new FakeTarget(), { __assembly: {}, location: { href: "http://fixture/" } });
  let ground = true, handoff = false, authored = true;
  const resolved = { graph, authored_graph: true, source: "client_fixture", spatialID: "world-airport-terminal", node_count: graph.nodes.length, graph_url: "http://fixture/graph.json", base_url: "http://fixture/assets/" };
  const live = { base: "http://fixture/backend", world: { title: "Terminal", location_id: "location-airport", world_id: "world-airport-terminal", session_id: "session", portals: [] },
    state: { phase: "idle", avatar: { position: [0, 0, 0] } }, wowResolved: () => authored ? resolved : null, debugState: () => ({}),
    _portalTraversalController: { inFlight: () => handoff }, resolveClientSceneLoad: async () => resolved,
    beginVisualTransition() { trace.push("begin-state"); }, commitVisualTransition() { trace.push("commit-state"); },
    enterClientSceneLoad: async () => { trace.push("enter-state"); live.world = { ...live.world, location_id: "world-airport-terminal" }; return { ok: true }; } };
  const applicationState = createApplicationState({ getAdapter: () => live });
  class Preview {
    constructor() { this.renderer = null; }
    bindScene(renderer) { trace.push(renderer ? "bind-preview" : "unbind-preview"); this.renderer = renderer; }
    pruneToPortalKeys() {} dispose() { trace.push("dispose-preview"); this.renderer = null; }
  }
  const controller = createSceneRuntimeController({
    THREE, applicationState, PortalPreviewManagerClass: Preview, isPlayer: true, role: "source", stageMode: true,
    getMount: () => host, getRuntime: applicationState.runtime, getAvatarLayers: () => ({ peers: [] }),
    documentTarget, windowTarget, locationHref: "http://fixture/", requestFrame: fn => { frames.push(fn); return frames.length; },
    cancelFrame() {}, portalKey: value => value.id, logLine: value => trace.push(value), showToast: () => trace.push("toast"), vec3Label: value => value.join(","),
    alignPortalVisual: () => { trace.push("align"); return {}; }, applyPlayerCamera: () => trace.push("camera"),
    onSceneChanged: scene => trace.push(scene ? "publish-scene" : "clear-scene"),
    buildWowScene: (_graph, _three, options) => {
      trace.push("build");
      assert.equal(options.width, 800); assert.equal(options.height, 600); assert.equal(options.sceneDescription.graph, graph);
      const built = { scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(), asset_nodes: [{}], render_summary: { walkable_extent: [10, 20] },
        airport_entity_runtime: { update() {}, dispose() { trace.push("dispose-entities"); },
          runtimeActorScene: record => record?.actor ? "shared-actor" : null, attachAsset: (...args) => trace.push(["attach-asset", ...args]) },
        airport_hud_overlay: { dispose() { trace.push("dispose-hud"); } } };
      builds.push({ built, options }); return built;
    },
    mountAirportTerminalContent: () => ({ storefront_count: 4, npc_count: 5, gate: { gate: "C1" },
      walkable_surface: { source: "fixture-ground", entry_ground: { ok: ground, surface_y_m: 0 }, surfaces: [{ center_m: [0, 0, 0], size_m: [10, 0, 20] }] } }),
    mountWowSceneAssets: (nodes, _three, options) => { const gate = deferred(); requests.push({ nodes, options, gate }); trace.push("load-assets"); return gate.promise; },
    loadGltf: url => `loaded:${url}`, cloneScene: value => value,
    createRenderAdapter: () => {
      const gate = deferred(), id = adapters.length;
      const adapter = { gate, disposed: 0, released: 0, renderer: { domElement: new FakeTarget(), forceContextLoss() { trace.push(`release:${id}`); adapter.released++; } },
        mount() {}, ready: () => gate.promise, attach() {}, useScene() { trace.push("use-scene"); }, requestRender() { trace.push("render"); },
        dispose() { trace.push(`dispose-adapter:${id}`); adapter.disposed++; } };
      adapters.push(adapter); return adapter;
    },
  });
  async function mount() { const pending = controller.mountLive({ world: live.world, phase: "idle" }); adapters.at(-1).gate.resolve(); return pending; }
  return { controller, applicationState, live, resolved, trace, body, elements, windowTarget, adapters, requests, frames, builds, mount,
    ground: value => { ground = value; }, handoff: value => { handoff = value; }, authored: value => { authored = value; },
    dispose() { controller.dispose(); applicationState.dispose(); } };
}

await check("authored-adoption", "Ready graph adoption precedes metadata; preview releases old context only after rebind", async () => {
  const h = fixture(), pending = h.controller.mountLive({ world: h.live.world, phase: "idle" });
  await tick(); assert.equal(h.builds.length, 0, "deferred readiness must prevent construction");
  assert.equal(h.body.getAttribute("data-terminal-ready-world"), null);
  h.adapters[0].gate.resolve(); const first = await pending;
  assert.equal(h.controller.scene(), first);
  assert.equal(h.body.getAttribute("data-terminal-ready-world"), "world-airport-terminal");
  assert.equal(h.body.getAttribute("data-airport-backend-scene"), "1");
  assert.equal(h.elements["live-backend"].textContent, "http://fixture/backend · authored /wow/graph");
  assert.equal(h.requests[0].options.baseUrl, h.resolved.graph_url, "authored URL priority");
  assert.deepEqual(h.trace.slice(h.trace.indexOf("use-scene"), h.trace.indexOf("load-assets")), ["use-scene", "publish-scene", "bind-preview", "align", "bind-preview", "camera", "render"]);
  const start = h.trace.length; await h.mount(); const replacement = h.trace.slice(start);
  assert.ok(replacement.indexOf("dispose-adapter:0") < replacement.indexOf("bind-preview"));
  assert.ok(replacement.indexOf("release:0") > replacement.indexOf("bind-preview"), "retired context waits for preview rebind");
  h.dispose(); assert.deepEqual(h.adapters.map(a => [a.disposed, a.released]), [[1, 1], [1, 1]]);
});

await check("construction-failure", "Readiness and ground failures preserve selected scene publication and release preparation", async () => {
  const h = fixture(), original = await h.mount();
  const rejected = h.controller.mountLive({ world: h.live.world });
  h.adapters.at(-1).gate.reject(new Error("ready failure")); await assert.rejects(rejected, /ready failure/);
  assert.equal(h.controller.scene(), original); assert.equal(h.builds.length, 1);
  assert.equal(h.body.getAttribute("data-terminal-ready-world"), "world-airport-terminal");
  h.ground(false); await assert.rejects(h.mount(), /no rendered entry ground/);
  assert.equal(h.controller.scene(), original, "failed construction must preserve selected scene");
  assert.equal(h.body.getAttribute("data-terminal-ready-world"), "world-airport-terminal", "failed construction must preserve mounted terminal publication");
  assert.deepEqual(h.adapters.map(a => a.disposed), [0, 1, 1]); h.dispose();
});

await check("deferred-assets", "Shared actor loading, handoff pacing and stale settlement keep scene identity", async () => {
  const h = fixture(); await h.mount(); const first = h.requests[0];
  assert.equal(first.options.loadGltf("unused", { actor: true }), "shared-actor");
  assert.equal(first.options.loadGltf("mesh", {}), "loaded:mesh");
  first.options.onAsset({ status: "loaded" }, "model", "record");
  assert.ok(h.trace.some(value => Array.isArray(value) && value[0] === "attach-asset" && value[2] === "model"), "asset completion reaches the entity runtime");
  h.handoff(true); let ready = false;
  const paced = first.options.beforeMount().then(() => { ready = true; }); await tick();
  assert.equal(ready, false); h.frames.shift()(); await tick(); assert.equal(ready, false, "handoff fence must hold while transfer is active");
  h.handoff(false); h.frames.shift()(); await tick(); assert.equal(ready, false, "one mount frame remains after handoff");
  h.frames.shift()(); await paced; assert.equal(ready, true);
  await h.mount(); assert.equal(first.options.shouldMount(), false, "replaced assets cannot mount");
  first.gate.resolve({ loaded: 9, failed: 3 }); await tick();
  assert.equal(h.body.getAttribute("data-wow-assets-loaded"), "0", "stale assets cannot publish over replacement");
  const second = h.requests[1]; second.gate.resolve({ loaded: 2, failed: 1 }); await tick();
  assert.equal(h.body.getAttribute("data-wow-assets-loaded"), "2");
  assert.equal(h.controller.liveAuthoredScene().assets.status, "settled");
  h.handoff(true); const cancelledPacing = second.options.beforeMount(); await tick();
  h.dispose(); assert.equal(second.options.shouldMount(), false);
  h.frames.shift()(); await tick(); h.frames.shift()(); await cancelledPacing;
  assert.equal(h.frames.length, 0, "retired handoff pacing drains its frames");
});

await check("client-adoption", "Client transaction, asset publication and recomposition retain route-specific outputs", async () => {
  const h = fixture(); h.authored(false);
  const target = { transition: "client_scene_load", spatial_id: "world-airport-terminal", graph_endpoint: "/worlds/denver-skyport.json" };
  const pending = h.controller.mountClientSceneLoad(target); await tick(); h.adapters[0].gate.resolve();
  const surface = await pending;
  assert.ok(h.trace.indexOf("commit-state") < h.trace.indexOf("publish-scene"), "client state commits before scene publication");
  assert.equal(surface.assets.status, "pending"); assert.equal(h.body.getAttribute("data-client-scene-load"), "airport");
  assert.equal(h.requests[0].options.baseUrl, h.resolved.base_url, "client URL priority");
  h.requests[0].gate.resolve({ loaded: 1, failed: 0 }); await tick();
  assert.equal(surface.assets.status, "settled"); assert.equal(h.body.getAttribute("data-wow-assets-loaded"), "1");
  const recompose = h.controller.recomposeLive("fixture"); h.adapters[1].gate.resolve(); await recompose;
  assert.equal(surface.recomposition.ground_contract_source, "fixture-ground");
  assert.equal(h.requests[1].options.baseUrl, h.resolved.base_url);
  h.requests[1].gate.resolve({ loaded: 7, failed: 0 }); await tick();
  assert.equal(surface.assets.loaded, 1, "recomposition does not replace the transaction's asset summary");
  h.authored(true); h.ground(false);
  await assert.rejects(h.mount(), /no rendered entry ground/);
  assert.equal(h.controller.clientSceneLoad(), surface, "failed authored construction preserves mounted client publication");
  assert.equal(h.body.getAttribute("data-terminal-ready-world"), "world-airport-terminal");
  h.ground(true); await h.mount();
  assert.equal(h.controller.clientSceneLoad(), null, "successful authored adoption clears old client publication");
  assert.equal(h.body.getAttribute("data-client-scene-load"), null);
  h.dispose(); assert.equal(h.body.getAttribute("data-client-scene-load"), null);
  assert.equal(h.windowTarget.__airportLobbySceneLoad, undefined);
});

await check("asset-failure", "Asset rejection reports the original request error without claiming settled assets", async () => {
  const h = fixture(); await h.mount();
  h.requests[0].gate.reject(new Error("asset unavailable")); await tick();
  assert.equal(h.controller.liveAuthoredScene().assets.status, "error");
  assert.equal(h.controller.liveAuthoredScene().assets.error, "asset unavailable");
  assert.equal(h.body.getAttribute("data-wow-assets-loaded"), "0"); h.dispose();
});

const fault = (statement, name, file, find, replace, expect) => ({ statement, name, expect, edits: [{ file, find, replace }] });
await finish({ checkFile: "src/scene-lifecycle-check.mjs", faults: [
  fault("construction-failure", "clear publication before validation", "web/scene-runtime-controller.mjs", "if (authoredGraph) {", "if (authoredGraph) { clearClientScenePublication();", /failed construction must preserve mounted terminal publication/),
  fault("deferred-assets", "stale settlements publish", "web/scene-content.mjs", "if (!isCurrent()) return;", "void isCurrent;", /stale assets cannot publish over replacement/),
  fault("deferred-assets", "retired assets can mount", "web/scene-content.mjs", "shouldMount: isCurrent", "shouldMount: () => true", /replaced assets cannot mount/),
  fault("deferred-assets", "handoff fence skipped", "web/scene-content.mjs", "!isCurrent() || !isHandoffInFlight()", "true", /handoff fence must hold while transfer is active/),
  fault("deferred-assets", "entity attachment omitted", "web/scene-content.mjs", "void built.airport_entity_runtime?.attachAsset(item, model, record);", "void model;", /asset completion reaches the entity runtime/),
  fault("authored-adoption", "context released while preview holds it", "web/scene-runtime-controller.mjs", "if (previewManager.renderer === renderer) return true;", "void renderer;", /retired context waits for preview rebind/),
] });
