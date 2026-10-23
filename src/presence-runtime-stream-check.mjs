import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createPresenceController } from "../web/live-adapter-presence-controller.mjs";
import {
  createRuntimeStreamController,
  sameOriginWebSocketUrl,
} from "../web/live-adapter-runtime-stream-controller.mjs";
import { createPeerPresenceReducer } from "../web/live-adapter-peer-presence-reducer.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mutation = process.env.feature_P13_MUTATION || "";
let adapterSource = readFileSync(path.join(ROOT, "web/live-adapter.js"), "utf8");
let presenceSource = readFileSync(path.join(ROOT, "web/live-adapter-presence-controller.mjs"), "utf8");
let runtimeSource = readFileSync(path.join(ROOT, "web/live-adapter-runtime-stream-controller.mjs"), "utf8");
let peerSource = readFileSync(path.join(ROOT, "web/live-adapter-peer-presence-reducer.mjs"), "utf8");
let checks = 0;

function replaceOnce(source, before, after) {
  assert.equal(source.includes(before), true, `mutation anchor missing: ${before}`);
  return source.replace(before, after);
}

const mutations = {
  "heartbeat-cadence": () => { presenceSource = replaceOnce(presenceSource, "const PRESENCE_HEARTBEAT_INTERVAL_MS = 3000;", "const PRESENCE_HEARTBEAT_INTERVAL_MS = 3001;"); },
  "register-finally": () => { presenceSource = replaceOnce(presenceSource, "    } finally {\n      startHeartbeat();", "    } finally {\n      void startHeartbeat;"); },
  "duplicate-timer": () => { presenceSource = replaceOnce(presenceSource, "    if (!state.supported || heartbeatTimer) return heartbeatTimer;", "    if (!state.supported) return heartbeatTimer;"); },
  "stale-heartbeat-owner": () => { presenceSource = replaceOnce(presenceSource, "      if (base !== getBase() || getHandoffInFlight()) {", "      if (false) {"); },
  "registration-clear": () => { presenceSource = replaceOnce(presenceSource, "    state.registered_base = null;", "    void state.registered_base;"); },
  "pagehide-cleanup": () => { presenceSource = replaceOnce(presenceSource, "    stopHeartbeat();\n    void departPresence", "    void stopHeartbeat;\n    void departPresence"); },
  "runtime-reconnect": () => { runtimeSource = replaceOnce(runtimeSource, "record.reconnect_count * 500", "record.reconnect_count * 600"); },
  "stale-socket": () => { runtimeSource = replaceOnce(runtimeSource, "        if (runtimeSocket !== socket || runtimeGeneration !== generation) return;", "        void generation;"); },
  "event-cleanup": () => { runtimeSource = replaceOnce(runtimeSource, "    if (record.reconnect_timer) clearTimeoutFn(record.reconnect_timer);", "    void record.reconnect_timer;"); },
  "user-left-route": () => { runtimeSource = replaceOnce(runtimeSource, "onPresenceDeparture(endpointKey, message)", "null"); },
  "pose-cadence": () => { peerSource = replaceOnce(peerSource, "const PLAYER_POSE_MIN_INTERVAL_MS = 66;", "const PLAYER_POSE_MIN_INTERVAL_MS = 67;"); },
  "self-filter": () => { peerSource = replaceOnce(peerSource, "if (clientMode === \"player\" && playerId === controlledIdentity().player_id) return;", "if (false) return;"); },
  "targeted-departure": () => { peerSource = replaceOnce(peerSource, "          stalePruneDueAtMs = pose.received_at + PEER_PLAYER_POSE_STALE_MS;\n          delete peerPlayerPoses[peerClientId];\n          removed += 1;", "          void pose;\n          void peerClientId;\n          removed += 0;"); },
  "reference-restore": () => { peerSource = replaceOnce(peerSource, "    peerPlayerPoses = saved.peerPlayerPoses || {};", "    peerPlayerPoses = { ...(saved.peerPlayerPoses || {}) };"); },
  "debug-drift": () => { adapterSource = replaceOnce(adapterSource, "presence_registration: this._presenceDebug(),", "registration: this._presenceDebug(),"); },
  "private-bypass": () => { adapterSource = replaceOnce(adapterSource, "return this._presenceController.registerPresence({ spawnReason: reason });", "return this._transport.postJson(reason, {});"); },
  "source-mutation-route": () => { peerSource = replaceOnce(peerSource, "  function removeDepartedPlayer(input = {}) {", "  function ignoreDepartedPlayer(input = {}) {"); },
};
if (mutation) mutations[mutation]();

async function check(name, fn) {
  await fn();
  checks += 1;
  console.log(`PASS ${String(checks).padStart(2, "0")} ${name}`);
}

function fakeTimers() {
  let next = 1;
  const intervals = new Map();
  const timeouts = new Map();
  return {
    intervals,
    timeouts,
    setIntervalFn(fn, ms) { const id = next++; intervals.set(id, { fn, ms }); return id; },
    clearIntervalFn(id) { intervals.delete(id); },
    setTimeoutFn(fn, ms) { const id = next++; timeouts.set(id, { fn, ms }); return id; },
    clearTimeoutFn(id) { timeouts.delete(id); },
  };
}

function fakeTarget() {
  const listeners = new Map();
  return {
    listeners,
    addEventListener(name, fn) { listeners.set(name, fn); },
    removeEventListener(name, fn) { if (listeners.get(name) === fn) listeners.delete(name); },
  };
}

await check("source ownership and dependency direction are explicit", () => {
  assert.match(adapterSource, /createPresenceController\(\{/);
  assert.match(adapterSource, /createRuntimeStreamController\(\{/);
  assert.match(adapterSource, /createPeerPresenceReducer\(\{/);
  assert.doesNotMatch(presenceSource, /live-adapter\.js|app\.js|WebSocket|BroadcastChannel/);
  assert.doesNotMatch(runtimeSource, /live-adapter\.js|app\.js|fetch\(/);
  assert.doesNotMatch(peerSource, /live-adapter\.js|app\.js|fetch\(/);
  assert.match(peerSource, /function removeDepartedPlayer\(input = \{\}\)/);
  for (const token of [
    "const PRESENCE_HEARTBEAT_INTERVAL_MS = 3000;",
    "    } finally {\n      startHeartbeat();",
    "    if (!state.supported || heartbeatTimer) return heartbeatTimer;",
    "      if (base !== getBase() || getHandoffInFlight()) {",
    "    state.registered_base = null;",
    "    stopHeartbeat();\n    void departPresence",
  ]) assert.equal(presenceSource.includes(token), true, `presence owner token missing: ${token}`);
  for (const token of [
    "record.reconnect_count * 500",
    "        if (runtimeSocket !== socket || runtimeGeneration !== generation) return;",
    "    if (record.reconnect_timer) clearTimeoutFn(record.reconnect_timer);",
    "onPresenceDeparture(endpointKey, message)",
  ]) assert.equal(runtimeSource.includes(token), true, `runtime owner token missing: ${token}`);
  for (const token of [
    "const PLAYER_POSE_MIN_INTERVAL_MS = 66;",
    'if (clientMode === "player" && playerId === controlledIdentity().player_id) return;',
    "          stalePruneDueAtMs = pose.received_at + PEER_PLAYER_POSE_STALE_MS;\n          delete peerPlayerPoses[peerClientId];\n          removed += 1;",
    "    peerPlayerPoses = saved.peerPlayerPoses || {};",
  ]) assert.equal(peerSource.includes(token), true, `peer owner token missing: ${token}`);
  assert.match(adapterSource, /presence_registration: this\._presenceDebug\(\),/);
  assert.match(adapterSource, /return this\._presenceController\.registerPresence\(\{ spawnReason: reason \}\);/);
});

await check("presence identity, role inertness, register, retry timer, and clear transition", async () => {
  let now = 1000;
  let fail = false;
  const calls = [];
  const timers = fakeTimers();
  const target = fakeTarget();
  const controller = createPresenceController({
    transport: { async postJson(url, body) { calls.push({ url, body }); if (fail) throw new Error("offline"); return { location_id: "location-a", registered_player_count: 1 }; } },
    clientMode: "player", playerId: "p1", clientId: "p1", supported: true,
    getBase: () => "/api/a", getLocationId: () => "location-a",
    getAvatar: () => ({ avatar_id: "avatar", continuity_id: "continuity", position: [1.23456, 0, 2], rotation_y: 0.1234567 }),
    nowMs: () => now, pagehideTarget: target, ...timers,
  });
  assert.deepEqual(controller.controlledIdentity(), controller.controlledIdentity());
  await controller.registerPresence({ spawnReason: "spawn" });
  assert.equal(calls[0].body.requested_ttl_ms, 10000);
  assert.equal(timers.intervals.size, 1);
  assert.equal(Array.from(timers.intervals.values())[0].ms, 3000);
  assert.equal(target.listeners.has("pagehide"), true);
  fail = true;
  await controller.registerPresence({ spawnReason: "retry" });
  assert.equal(timers.intervals.size, 1);
  controller.clearRegistration();
  assert.equal(controller.snapshot().registered, false);
  controller.dispose();
  assert.equal(timers.intervals.size, 0);

  const observer = createPresenceController({
    transport: { postJson() { throw new Error("must not call"); } }, clientMode: "observer",
    playerId: "o", clientId: "o", supported: true, getBase: () => "/api/a",
    getLocationId: () => "a", getAvatar: () => null, ...fakeTimers(),
  });
  assert.equal(await observer.registerPresence({ spawnReason: "spawn" }), null);
});

await check("presence heartbeat handoff guard, force pose, departure, beacon, and pagehide", async () => {
  let handoff = true;
  let forced = 0;
  let streamsClosed = 0;
  const calls = [];
  const beacons = [];
  const timers = fakeTimers();
  const target = fakeTarget();
  const controller = createPresenceController({
    transport: { async postJson(url, body) { calls.push({ url, body }); return { location_id: "location-a" }; } },
    clientMode: "player", playerId: "p", clientId: "p", supported: true,
    getBase: () => "/api/a", getLocationId: () => "location-a", getAvatar: () => ({}),
    getHandoffInFlight: () => handoff, onForcePose: () => { forced += 1; },
    onCloseEventStreams: () => { streamsClosed += 1; },
    navigatorLike: { sendBeacon(url) { beacons.push(url); return true; } },
    BlobCtor: class {}, pagehideTarget: target, ...timers,
  });
  await controller.registerPresence({ spawnReason: "spawn" });
  assert.equal(timers.intervals.size, 1);
  assert.equal(await controller.heartbeat(), null);
  handoff = false;
  await controller.heartbeat();
  assert.equal(forced, 1);
  await controller.departPresence({ base: "/api/a", reason: "crossing" });
  await controller.departPresence({ reason: "pagehide", beacon: true });
  assert.equal(beacons[0], "/api/a/fabric/presence/depart");
  target.listeners.get("pagehide")();
  assert.equal(timers.intervals.size, 0);
  assert.equal(beacons.length, 2);
  assert.equal(streamsClosed, 1);
});

await check("a heartbeat started on the source cannot overwrite accepted destination ownership", async () => {
  let base = "/api/a";
  let handoff = false;
  let resolveSourceHeartbeat;
  const sourceHeartbeat = new Promise((resolve) => { resolveSourceHeartbeat = resolve; });
  const controller = createPresenceController({
    transport: {
      async postJson(url) {
        if (url === "/api/a/fabric/presence/heartbeat") return sourceHeartbeat;
        return { location_id: base === "/api/a" ? "location-a" : "location-b", registered_player_count: 1 };
      },
    },
    clientMode: "player", playerId: "p", clientId: "p", supported: true,
    getBase: () => base,
    getLocationId: () => base === "/api/a" ? "location-a" : "location-b",
    getAvatar: () => ({}), getHandoffInFlight: () => handoff, ...fakeTimers(),
  });
  await controller.registerPresence({ spawnReason: "spawn" });
  const lateSourceHeartbeat = controller.heartbeat();
  handoff = true;
  base = "/api/b";
  await controller.registerPresence({ spawnReason: "portal_arrival" });
  handoff = false;
  resolveSourceHeartbeat({ location_id: "location-a", registered_player_count: 0 });
  await lateSourceHeartbeat;
  const state = controller.snapshot();
  assert.equal(state.registered_base, "/api/b");
  assert.equal(state.registered_location_id, "location-b");
  assert.equal(state.register_count, 2);
  assert.equal(state.heartbeat_count, 0);
  assert.equal(state.events.at(-1).event, "presence_heartbeat_stale");
});

class FakeSocket {
  static sockets = [];
  constructor(url) { this.url = url; this.readyState = 0; FakeSocket.sockets.push(this); }
  close() { this.readyState = 3; if (this.onclose) this.onclose(); }
  open() { this.readyState = 1; if (this.onopen) this.onopen(); }
  message(value) { if (this.onmessage) this.onmessage({ data: JSON.stringify(value) }); }
}

await check("runtime and keyed event streams preserve singleton, asymmetry, reconnect, and stale guards", () => {
  FakeSocket.sockets = [];
  const timers = fakeTimers();
  const departures = [];
  let wanted = ["b", "a", "a"];
  const controller = createRuntimeStreamController({
    getActiveEndpointKey: () => "a", getDesiredEventEndpointKeys: () => wanted,
    isEndpointKey: (key) => ["a", "b"].includes(key), createWebSocket: (url) => new FakeSocket(url),
    locationLike: { protocol: "http:", host: "example.test" }, onPresenceDeparture: (key, message) => { departures.push({ key, message }); return { received_at_ms: 1 }; },
    ...timers,
  });
  const runtime1 = controller.connectRuntimeStream();
  const runtime2 = controller.connectRuntimeStream();
  runtime1.message({ type: "state", state: { debug: {} } });
  assert.notEqual(runtime1, runtime2);
  controller.syncEventStreams();
  const eventA = FakeSocket.sockets.find((socket) => socket.url.endsWith("/api/a/events"));
  const eventB = FakeSocket.sockets.find((socket) => socket.url.endsWith("/api/b/events"));
  eventA.open();
  eventA.message({ type: "hello", users: ["ignored"] });
  eventA.message({ type: "user_left", player_id: "p" });
  assert.equal(departures.length, 1);
  eventA.close();
  assert.equal(Array.from(timers.timeouts.values())[0].ms, 1250);
  wanted = ["b"];
  controller.syncEventStreams();
  assert.equal(timers.timeouts.size, 0);
  eventB.close();
  assert.equal(timers.timeouts.size, 1);
  controller.closeEventStreams();
  assert.equal(timers.timeouts.size, 0);
  controller.closeRuntimeStream();
});

await check("same-origin WebSocket URL derives ws/wss without visitor loopback", () => {
  assert.equal(sameOriginWebSocketUrl("a", "/events", { protocol: "https:", host: "demo.test" }), "wss://demo.test/api/a/events");
  assert.doesNotMatch(runtimeSource, /ws:\/\/127\.0\.0\.1/);
});

function peerFixture({ mode = "player" } = {}) {
  let now = 0;
  const sent = [];
  const external = [];
  const channels = [];
  const world = { location_id: "location-a", world_id: "world-a" };
  const avatar = { avatar_id: "av", continuity_id: "c", display_name: "Player", position: [0, 0, 0], rotation_y: 0, equippedItems: [] };
  const controls = {
    moving: false,
    movement_mode: "idle",
    run_mode: false,
    speed_mps: 0,
    grounded: true,
    portal_transition_phase: "none",
  };
  const reducer = createPeerPresenceReducer({
    clientMode: mode, clientId: mode === "player" ? "self" : "observer",
    controlledIdentity: () => ({ player_id: "self" }), getContext: () => ({ world, avatar, controls, phase: "idle", wowLocalWalk: false }),
    defaultAvatarVariant: "default", nowMs: () => now,
    createBroadcastChannel: () => { const channel = { postMessage(message) { sent.push(message); }, close() {} }; channels.push(channel); return channel; },
    onExternalPresenceDeparture: (input) => { external.push(input); return { prefetch_presence_removed: 2 }; },
  });
  return { reducer, sent, external, channels, avatar, controls, setNow(value) { now = value; } };
}

await check("peer pose cadence, state edges, forced pose, self filter, and stale pruning are exact", () => {
  const fixture = peerFixture();
  assert.equal(fixture.reducer.broadcastPlayerPose(), true);
  fixture.setNow(65);
  assert.equal(fixture.reducer.broadcastPlayerPose(), false);
  fixture.controls.moving = true;
  fixture.controls.movement_mode = "run";
  fixture.controls.run_mode = true;
  fixture.controls.speed_mps = 4.7;
  assert.equal(fixture.reducer.broadcastPlayerPose(), true);
  assert.deepEqual(
    {
      movement_mode: fixture.sent.at(-1).locomotion.movement_mode,
      run_mode: fixture.sent.at(-1).locomotion.run_mode,
      speed_mps: fixture.sent.at(-1).locomotion.speed_mps,
    },
    { movement_mode: "run", run_mode: true, speed_mps: 4.7 },
  );
  assert.equal(fixture.reducer.broadcastPlayerPose({ force: true }), true);
  fixture.reducer.recordPeerPlayerPose({ client_id: "self", player_id: "self", location_id: "location-a" });
  assert.equal(fixture.reducer.peerPlayersDebug().length, 0);
  fixture.reducer.recordPeerPlayerPose({
    client_id: "peer",
    player_id: "peer",
    location_id: "location-a",
    position: [1, 0, 0],
    locomotion: { moving: true, movement_mode: "run", run_mode: true, speed_mps: 4.7 },
  });
  assert.equal(fixture.reducer.coPresentPeerCount(), 1);
  assert.equal(fixture.reducer.peerPlayersDebug()[0].locomotion.movement_mode, "run");
  fixture.setNow(4066);
  assert.equal(fixture.reducer.peerPlayersDebug().length, 0);
});

await check("peer snapshot clear restore preserves store and live-pose references", () => {
  const fixture = peerFixture({ mode: "observer" });
  fixture.reducer.recordPeerPlayerPose({ client_id: "peer", player_id: "peer", location_id: "location-a", position: [1, 0, 0] });
  const saved = fixture.reducer.snapshot();
  fixture.reducer.clear();
  assert.notEqual(fixture.reducer.snapshot().peerPlayerPoses, saved.peerPlayerPoses);
  fixture.reducer.restore(saved);
  assert.equal(fixture.reducer.snapshot().peerPlayerPoses, saved.peerPlayerPoses);
  assert.equal(fixture.reducer.snapshot().livePlayerPose, saved.livePlayerPose);
});

await check("targeted departure and BroadcastChannel routing retain distinct debug surfaces", () => {
  const fixture = peerFixture();
  fixture.reducer.recordPeerPlayerPose({ client_id: "peer", player_id: "peer", location_id: "location-a", position: [1, 0, 0] });
  const result = fixture.reducer.removeDepartedPlayer({ playerId: "peer", locationId: "location-a", receivedAtMs: 1 });
  assert.equal(result.peer_pose_removed, 1);
  assert.equal(result.prefetch_presence_removed, 2);
  fixture.reducer.listenForCrossWindow();
  fixture.channels[0].onmessage({ data: { type: "player-pose-request", client_id: "other" } });
  assert.equal(fixture.sent.some((message) => message.type === "player-pose"), true);
  assert.notDeepEqual(fixture.reducer.visibilityDebug(), fixture.reducer.peerPlayersDebug());
});

await check("facade delegates all Patch 15 lifecycle seams without mutable private bypasses", () => {
  for (const token of [
    "departPresence(input = {})", "stopPresenceHeartbeat()", "registerPresence(input = {})",
    "presenceSnapshot()", "clearPresenceRegistration()", "closeRuntimeStream()",
    "connectRuntimeStream(endpointKey)", "syncPresenceEventStreams(endpointKeys)",
    "peerPresenceSnapshot()", "clearPeerPresence()", "restorePeerPresence(snapshot)",
    "broadcastPlayerPose({ force = false } = {})",
  ]) assert.equal(adapterSource.includes(token), true, `facade seam missing: ${token}`);
  assert.match(adapterSource, /presence_registration: this\._presenceDebug\(\)/);
  assert.match(adapterSource, /presence_push: this\._presencePushDebug\(\)/);
});

if (!mutation) {
  for (const name of Object.keys(mutations)) {
    let red = false;
    try {
      execFileSync(process.execPath, [fileURLToPath(import.meta.url)], {
        cwd: ROOT,
        env: { ...process.env, feature_P13_MUTATION: name },
        stdio: "pipe",
      });
    } catch (error) {
      red = Number.isInteger(error.status) && error.status !== 0;
    }
    assert.equal(red, true, `mutation ${name} must turn RED`);
    console.log(`RED_CAUGHT ${name}`);
  }
  console.log(`feature_PRESENCE_RUNTIME_STREAM PASS ${checks}/${checks} mutations=${Object.keys(mutations).length}/${Object.keys(mutations).length}`);
}
