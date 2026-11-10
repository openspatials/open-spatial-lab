import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SourceTextModule, SyntheticModule, createContext, runInContext } from "node:vm";
import { execFileSync } from "node:child_process";

const root = fileURLToPath(new URL("..", import.meta.url));
const intervals = new Map(), timeouts = new Map(), sockets = [], channels = [];
let nextHandle = 1, now = 10000;
function target() {
  const listeners = new Map();
  return { listeners, addEventListener(name, fn) {
    if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn);
  }, removeEventListener(name, fn) { listeners.get(name)?.delete(fn); } };
}
const windowLike = { ...target(), location: { protocol: "http:", host: "fixture.invalid", href: "http://fixture.invalid/", search: "" } };
const documentLike = { ...target(), hidden: false };
class Socket {
  constructor(url) { this.url = url; this.closed = false; sockets.push(this); }
  close() { this.closed = true; this.onclose?.(); }
}
class Channel {
  constructor(name) { this.name = name; this.messages = []; this.closed = false; channels.push(this); }
  postMessage(message) { assert.equal(this.closed, false); this.messages.push(structuredClone(message)); }
  close() { this.closed = true; }
}
const clock = {
  setInterval(fn, ms) { const id = nextHandle++; intervals.set(id, { fn, ms }); return id; },
  clearInterval(id) { intervals.delete(id); },
  setTimeout(fn, ms) { const id = nextHandle++; timeouts.set(id, { fn, ms }); return id; },
  clearTimeout(id) { timeouts.delete(id); },
};
Object.assign(globalThis, { window: windowLike, document: documentLike, WebSocket: Socket, BroadcastChannel: Channel, ...clock });
Date.now = () => now;
const context = createContext({ console, EventTarget, Event, CustomEvent, crypto: globalThis.crypto,
  TextEncoder, TextDecoder, URL, URLSearchParams, Date, Uint8Array, ArrayBuffer, Buffer, atob, btoa,
  structuredClone, window: windowLike, document: documentLike, WebSocket: Socket, BroadcastChannel: Channel, ...clock });
const modules = new Map();
const pendingModules = new Map();
function load(path) {
  if (!pendingModules.has(path)) pendingModules.set(path, loadModule(path));
  return pendingModules.get(path);
}
async function loadModule(path) {
  if (path.endsWith("/web/vendor/scene-core/frontend-contract.js")) path = resolve(root, "runtime/scene-core/public/frontend-contract.js");
  if (modules.has(path)) return modules.get(path);
  let fake = null;
  if (path.endsWith("/locomotion.mjs")) fake = { Locomotion: class { constructor() { throw Error("movement is outside lifecycle fixture"); } } };
  if (path.endsWith("/avatar/actionforge-avatar.mjs")) fake = { motionRecord() { throw Error("movement is outside lifecycle fixture"); } };
  if (path.endsWith("/avatar-equipment-layer.js")) fake = { DEFAULT_AVATAR_VARIANT: "collection-adam", AVATAR_VARIANTS: {} };
  if (process.argv.includes("--binding-contract") && path.endsWith("/live-adapter-portal-traversal-controller.mjs")) {
    fake = { createPortalTraversalHandoffController: capabilities => ({ ...capabilities, cancel() {} }) };
  }
  if (fake || (path.endsWith(".mjs") && !path.endsWith("-binding.mjs") && !path.includes("/live-adapter-movement"))) {
    const native = fake || await import(pathToFileURL(path));
    const module = new SyntheticModule(Object.keys(native), function() { for (const key of Object.keys(native)) this.setExport(key, native[key]); }, { context, identifier: path });
    modules.set(path, module); return module;
  }
  let source = readFileSync(path, "utf8");
  if (path.endsWith("/live-adapter.js")) {
    for (const [flag, before, after] of [
      ["--skip-stream-dispose", "    this._runtimeStreams.dispose();", "    void this._runtimeStreams;"],
      ["--skip-traversal-cancel", "    this._beginWorldNavigation();\n    this._portalTraversalController.cancel();\n    this._fabricPrefetchController.dispose();", "    this._beginWorldNavigation();\n    this._fabricPrefetchController.dispose();"],
    ]) if (process.argv.includes(flag)) { assert.ok(source.includes(before), "control anchor exists"); source = source.replace(before, after); }
  }
  const module = new SourceTextModule(source, { context, identifier: path }); modules.set(path, module);
  await module.link(ref => load(resolve(dirname(path), ref))); return module;
}
const module = await load(resolve(root, "web/live-adapter.js")); await module.evaluate();
const { LiveAdapter } = module.namespace;
const json = value => JSON.parse(JSON.stringify(value));
const local = value => runInContext(`JSON.parse(${JSON.stringify(JSON.stringify(value))})`, context);
const listenerCount = object => [...object.listeners.values()].reduce((n, set) => n + set.size, 0);
const resources = () => ({ sockets: sockets.length, channels: channels.length, intervals: intervals.size, timeouts: timeouts.size, window: listenerCount(windowLike), document: listenerCount(documentLike) });
const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };
const calls = [];
const transport = { emitSyntheticApiRequest: event => calls.push(["synthetic", event.method]), getJson: async url => { calls.push(["get", url]); return null; }, postJson: async (url, body) => { calls.push(["post", url, json(body)]); return { location_id: "current-location", registered_player_count: 1 }; } };
let checks = 0;
async function check(name, fn) { try { await fn(); console.log(`PASS ${++checks} ${name}`); } catch (error) { console.error(`FAIL ${name}: ${error.message}`); throw error; } }
function seed(host, location = "location-a") {
  host.world = { location_id: location, world_id: "world-a", session_id: "session", portal: null, portals: [], claim_boundary: {}, avatar: { spawn_position: [0, 0, 0], rotation_y: 0 }, arrival: { position: [0, 0, 1] } };
  host.state.avatar = local({ avatar_id: "avatar", continuity_id: "person", display_name: "Fixture", position: [1, 0, 2], rotation_y: 0, equippedItems: [] });
}

if (process.argv.includes("--binding-contract")) {
  const host = new LiveAdapter("player", { transport }); seed(host);
  const binding = host._portalTraversalController;
  host.base = "/api/changed"; host.world.avatar.continuity_id = "current-person";
  assert.equal(binding.readHostSnapshot().base, "/api/changed");
  assert.equal(binding.readHostSnapshot().world, host.world);
  const controls = host.state.controls, avatar = host.state.avatar;
  binding.applyTraversalPatch({ controls: { moving: true }, avatar: { rotation_y: 1.2 }, avatarMode: "merge" });
  assert.equal(host.state.controls, controls); assert.equal(host.state.avatar, avatar); assert.equal(avatar.rotation_y, 1.2);
  const packet = { handoff_id: "binding", source: { location_id: "a" }, target: { location_id: "b" }, avatar_context: { equippedItems: [] } };
  const signed = await binding.crypto.signManifest(packet); assert.equal(signed.signed, true);
  assert.equal((await binding.crypto.verifyManifest(packet)).verified, true);
  const wire = JSON.stringify(packet), publications = [];
  await binding.crypto.enrichManifest(packet, { isCurrent: () => true, publish: record => publications.push(record) });
  assert.equal(publications.at(-1).state, "complete", JSON.stringify(Object.entries(publications.at(-1).surfaces).filter(([, value]) => value?.error))); assert.equal(Object.keys(publications.at(-1).surfaces).length, 13);
  assert.equal(JSON.stringify(packet), wire);
  host.dispose(); const count = publications.length;
  await binding.crypto.enrichManifest(packet, { isCurrent: () => true, publish: record => publications.push(record) });
  assert.equal(publications.length, count, "disposed facade blocks diagnostic publication");
  console.log("PASS actual constructor binding: current host references, merge identities, real signed/verified payload, 13 diagnostics, disposed publication fence");
  process.exit(0);
}

await check("construction keeps one EventTarget and creates no sockets channels or timers", () => {
  for (const role of ["source", "target", "player"]) {
    const before = resources(), host = new LiveAdapter(role, { transport });
    assert.ok(host instanceof EventTarget); assert.equal(host.clientMode, role === "player" ? "player" : "observer");
    for (const key of ["sockets", "channels", "intervals", "timeouts"]) assert.equal(resources()[key], before[key]);
    assert.equal(listenerCount(windowLike), before.window + (role === "player" ? 1 : 0));
    assert.equal(host.state.controls.portal_ready_blocker, "init"); host.dispose(); assert.equal(listenerCount(windowLike), before.window);
  }
  assert.throws(() => new LiveAdapter("invalid", { transport }), /invalid role/);
});
await check("presence and streams read current host and preserve callback/listener identity", async () => {
  const host = new LiveAdapter("player", { transport }); seed(host); const identity = json(host.controlledIdentity());
  const pagehide = [...windowLike.listeners.get("pagehide")][0];
  host.base = "/api/b"; host.activeEndpointKey = "b"; host.world.location_id = "location-b";
  await host.registerPresence({ spawnReason: "fixture" }); assert.equal(calls.at(-1)[1], "/api/b/fabric/presence/register");
  assert.equal(calls.at(-1)[2].avatar_id, "avatar"); assert.equal(intervals.size, 1); assert.equal([...intervals.values()][0].ms, 3000);
  await host.registerPresence({ spawnReason: "again" }); assert.equal(intervals.size, 1); assert.ok(windowLike.listeners.get("pagehide").has(pagehide));
  host.connectRuntimeStream(); host.syncPresenceEventStreams(); assert.ok(sockets.at(-1).url.includes("/api/b/events"));
  assert.deepEqual(json(host.controlledIdentity()), identity); host.dispose();
});
await check("broadcast throttle and late-bound peer callbacks keep current state", () => {
  const host = new LiveAdapter("player", { transport }); seed(host); host.listenForCrossWindow(); const channel = channels.at(-1);
  host.broadcastPlayerPose({ force: true }); const count = channel.messages.length;
  host.state.avatar.position[0] += 1; now += 65; host.broadcastPlayerPose(); assert.equal(channel.messages.length, count);
  now += 1; host.broadcastPlayerPose(); assert.equal(channel.messages.length, count + 1);
  host.world.location_id = "location-b"; now += 66; host.broadcastPlayerPose({ force: true }); assert.equal(channel.messages.at(-1).location_id, "location-b");
  let emits = 0; host._emit = () => { emits++; };
  channel.onmessage({ data: { type: "visibility-state", client_id: "other", location_id: "location-b", visible_avatar_count: 1, at: now } });
  assert.ok(emits > 0, "callback resolves current emit method"); host.dispose();
});
await check("dispose revokes traversal first and closes exact owned resources once", async () => {
  const host = new LiveAdapter("player", { transport }); seed(host); await host.registerPresence({ spawnReason: "fixture" });
  host.connectRuntimeStream(); host.syncPresenceEventStreams(); host.listenForCrossWindow();
  const order = [];
  for (const [field, method, label] of [["_portalTraversalController", "cancel", "traversal"], ["_fabricPrefetchController", "dispose", "prefetch"], ["_runtimeStreams", "dispose", "streams"], ["_presenceController", "dispose", "presence"], ["_peers", "dispose", "peers"]]) {
    const owner = host[field]; host[field] = { ...owner, [method]: (...args) => { order.push(label); return owner[method](...args); } };
  }
  host.dispose(); host.dispose(); assert.deepEqual(order, ["traversal", "prefetch", "streams", "presence", "peers"], "traversal revoked before resource teardown");
  assert.ok(sockets.every(socket => socket.closed), "all runtime/event sockets closed"); assert.ok(channels.every(channel => channel.closed));
  assert.equal(intervals.size, 0); assert.equal(timeouts.size, 0); assert.equal(listenerCount(windowLike), 0); assert.equal(listenerCount(documentLike), 0);
  const before = resources(); host.listenForCrossWindow(); host.connectRuntimeStream(); host.syncPresenceEventStreams(); host._startPresenceHeartbeat(); await host.registerPresence({});
  assert.deepEqual(resources(), before, "disposed owners cannot create resources");
});
await check("pending registration and init cannot create resources after disposal", async () => {
  const gate = deferred(); const host = new LiveAdapter("player", { transport: { ...transport, postJson: () => gate.promise } }); seed(host);
  const registering = host.registerPresence({}); host.dispose(); const before = resources(); gate.resolve({}); await registering;
  assert.deepEqual(resources(), before, "late register creates no resources");
  const read = deferred(); const boot = new LiveAdapter("player", { transport: { ...transport, getJson: () => read.promise } });
  const starting = boot.init(); boot.dispose(); const snapshot = resources(); read.resolve(null); await starting;
  assert.deepEqual(resources(), snapshot, "late init creates no resources"); assert.equal(boot.world, null);
});
await check("visual staging preserves frozen projection and rollback identities", () => {
  const host = new LiveAdapter("player", { transport }); seed(host); const avatar = host.state.avatar, controls = host.state.controls, state = host.state, world = host.world;
  const staged = host.beginVisualTransition({ reason: "fixture" }); assert.equal(staged.staged, true); assert.notEqual(staged.state.avatar, avatar);
  avatar.position[0] = 88; host.world = { ...world, location_id: "changed" }; host.state.controls.moving = true;
  assert.equal(host.visualRuntimeSnapshot().state.avatar.position[0], 1); assert.equal(host.visualDebugState().location_id, "location-a");
  assert.equal(host.abortVisualTransition({ restore: true }), true); assert.equal(host.world, world); assert.equal(host.state, state); assert.equal(host.state.avatar, avatar); assert.equal(host.state.controls, controls); assert.equal(avatar.position[0], 1);
  host.beginVisualTransition(); let emits = 0; host.addEventListener("state", () => emits++); assert.equal(host.commitVisualTransition({ emit: true }), true); assert.equal(emits, 1); assert.equal(host.commitVisualTransition(), false); host.dispose();
});
await check("actual client binding preserves departure adoption registration and visual event order", async () => {
  const register = deferred(), trace = []; let visualAtCrossing;
  const host = new LiveAdapter("player", { transport: { ...transport, postJson: async (url) => {
    if (url.endsWith("/register")) { trace.push("register-start"); return register.promise; }
    trace.push("depart"); return {};
  } } });
  seed(host, "location-lobby"); const world = host.world, avatar = host.state.avatar;
  host._maybeBroadcastPlayerPose = () => trace.push("pose");
  host.addEventListener("state", () => trace.push("state"));
  host.addEventListener("crossing", () => { visualAtCrossing = host.visualRuntimeSnapshot().staged; trace.push("crossing"); });
  const graph = { title: "Fixture terminal", nodes: [{ webofworlds_extension: { airport_terminal: { walkable_surfaces: [
    { surface_id: "floor", classification: "walkable", shape: "box", center_m: [0, 1, 0], size_m: [20, 2, 20] },
  ] } } }] };
  const input = { target: { transition: "client_scene_load", spatial_id: "fixture-terminal", graph_endpoint: "/fixture", portal_id: "entry" },
    contract: { spatial_id: "fixture-terminal", entry_spawn: { position: [1, 0, 2], rotation_y: 1 }, proof_boundary: { application_level_handoff: false, standards_conformance: false } },
    resolved: { graph, graph_url: "/fixture", spatialID: "fixture-terminal", node_count: 1 }, bounds: { minX: -10, maxX: 10, minZ: -10, maxZ: 10 } };
  assert.equal((await host.enterClientSceneLoad(input)).ok, true); assert.equal(trace[0], "depart");
  assert.equal(host.state.avatar, avatar); assert.deepEqual(json(avatar.position), [1, 2, 2]); assert.equal(host.world.location_id, "fixture-terminal");
  assert.equal(host.state.controls.ground_surface_id, "floor"); assert.equal(host._clientSceneController.debug().reciprocal.synthesized, false);
  host.beginVisualTransition(); trace.length = 0;
  const result = await host.returnFromClientSceneLoad();
  assert.equal(result.ok, true); assert.equal(host.world, world); assert.equal(host.state.avatar, avatar);
  assert.equal(visualAtCrossing, false, "visual projection released before crossing event");
  assert.equal(trace[0], "register-start"); assert.equal(trace.at(-1), "crossing"); assert.ok(trace.indexOf("pose") < trace.indexOf("crossing"));
  assert.equal(host.presenceSnapshot().registered, false, "visual return does not await network registration");
  host.dispose(); const before = resources(); register.resolve({}); await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(resources(), before);
});
const bindingOutput = execFileSync(process.execPath, ["--experimental-vm-modules", fileURLToPath(import.meta.url), "--binding-contract"], { encoding: "utf8", stdio: "pipe" });
assert.match(bindingOutput, /PASS actual constructor binding/);
console.log(bindingOutput.trim());
console.log(JSON.stringify({ passed: checks, bindingContract: true, resources: resources(), liveResources: sockets.filter(s => !s.closed).length + channels.filter(c => !c.closed).length, network: false }));
