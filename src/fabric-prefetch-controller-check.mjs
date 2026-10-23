#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createFabricPrefetchController } from "../web/live-adapter-fabric-prefetch-controller.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CONTROLLER_PATH = `${ROOT}/web/live-adapter-fabric-prefetch-controller.mjs`;
const ADAPTER_PATH = `${ROOT}/web/live-adapter.js`;
const CONTROLLER_SOURCE = await readFile(CONTROLLER_PATH, "utf8");
const ADAPTER_SOURCE = await readFile(ADAPTER_PATH, "utf8");

let assertions = 0;
let mutationsCaught = 0;

async function check(name, fn) {
  await fn();
  assertions += 1;
  process.stdout.write(`ok ${assertions} - ${name}\n`);
}

async function flush(turns = 8) {
  for (let i = 0; i < turns; i += 1) await Promise.resolve();
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createClock(start = 1000) {
  let now = start;
  let nextId = 1;
  const intervals = new Map();
  const timeouts = new Map();
  const setIntervalFn = (fn, ms) => {
    const id = nextId++;
    intervals.set(id, { fn, ms, due: now + ms });
    return id;
  };
  const clearIntervalFn = (id) => intervals.delete(id);
  const setTimeoutFn = (fn, ms) => {
    const id = nextId++;
    timeouts.set(id, { fn, ms, due: now + ms });
    return id;
  };
  const runDue = async (target) => {
    while (true) {
      const candidates = [
        ...Array.from(timeouts, ([id, timer]) => ({ id, timer, type: "timeout" })),
        ...Array.from(intervals, ([id, timer]) => ({ id, timer, type: "interval" })),
      ].filter((entry) => entry.timer.due <= target);
      if (!candidates.length) break;
      candidates.sort((a, b) => a.timer.due - b.timer.due || a.id - b.id);
      const next = candidates[0];
      now = next.timer.due;
      if (next.type === "timeout") timeouts.delete(next.id);
      else if (intervals.has(next.id)) intervals.get(next.id).due += next.timer.ms;
      await next.timer.fn();
      await flush();
    }
    now = target;
    await flush();
  };
  return {
    nowMs: () => now,
    nowIso: () => new Date(now).toISOString(),
    setIntervalFn,
    clearIntervalFn,
    setTimeoutFn,
    advance: async (ms) => runDue(now + ms),
    runNextTimeout: async () => {
      const due = Math.min(...Array.from(timeouts.values(), (timer) => timer.due));
      if (Number.isFinite(due)) await runDue(due);
    },
    setNow: (value) => { now = value; },
    intervalCount: () => intervals.size,
    timeoutCount: () => timeouts.size,
    intervalDelays: () => Array.from(intervals.values(), (timer) => timer.ms).sort((a, b) => a - b),
    timeoutDelays: () => Array.from(timeouts.values(), (timer) => timer.ms).sort((a, b) => a - b),
  };
}

function portal(id, x = 0, overrides = {}) {
  const target = overrides.target_location_id || `location-${id}`;
  return {
    portal_id: id,
    label: `Portal ${id}`,
    target_location_id: target,
    traversal: overrides.traversal || { mode: "bidirectional", allowed_entry_side: "both" },
    zones: overrides.zones || { prefetch: { radius_m: 10, hysteresis_ratio: 1.15 } },
    spatial_fabric_address:
      overrides.address === null
        ? null
        : overrides.address || {
            uri: `fabric://${target}`,
            authority: `http://${target}`,
            location_id: target,
            fabric_id: `fabric-${id}`,
            anchor: { portal_id: id },
            roi_hint: { radius_m: 6 },
            discovery: {
              well_known: "/.well-known/fabric",
              region_endpoint: "/fabric/region",
              presence_endpoint: "/fabric/presence",
            },
          },
    trigger_position: [x, 0, 0],
  };
}

function world(portals, locationId = "origin") {
  return {
    location_id: locationId,
    portal: portals[0] || null,
    portals,
  };
}

function evaluation(entry, center = entry.trigger_position, side = "front") {
  return {
    portal: entry,
    portal_key: String(entry.portal_id),
    portalCenter: center,
    local: { side },
    traversal: entry.traversal,
  };
}

function discovery(id) {
  return { fabric_id: `fabric-${id}` };
}

function chunk({
  id = "c0",
  band = 0,
  entities = [{ object_id: `entity-${id}` }],
  byteSize = 100,
  continuation = null,
  totals = { region_entities: entities.length, fabric_entities: entities.length, excluded_entities: 0 },
  ttl = 15000,
  avatars = null,
} = {}) {
  return {
    chunk: {
      chunk_id: id,
      band_index: band,
      band_label: `band-${band}`,
      band_range_m: [band, band + 1],
      entity_count: entities.length,
      byte_size: byteSize,
      freshness: { ttl_ms: ttl },
      entities,
    },
    continuation: continuation ? { cursor: continuation } : null,
    totals,
    freshness: { ttl_ms: ttl },
    avatars,
    region: { radius_m: 6 },
    portal: { trigger_position: [1, 0, 1] },
    presence: { ttl_ms: 4000, occupancy: { avatars: [] } },
  };
}

function legacy(id, entities = [{ object_id: "legacy-1" }]) {
  return {
    fabric_id: `fabric-${id}`,
    entities,
    totals: { region_entities: entities.length, fabric_entities: entities.length, excluded_entities: 0 },
    freshness: { ttl_ms: 15000 },
    presence: { ttl_ms: 4000, occupancy: { avatars: [] } },
    portal: { trigger_position: [1, 0, 1] },
  };
}

function makeEnv({ Controller = createFabricPrefetchController, fixtureCap = null } = {}) {
  const clock = createClock();
  const queue = [];
  const urls = [];
  const emits = [];
  const logs = [];
  const adopted = [];
  const targets = [];
  let pose = null;
  const getJson = async (url) => {
    urls.push(url);
    if (!queue.length) throw new Error(`unexpected GET ${url}`);
    const next = queue.shift();
    if (typeof next === "function") return next(url);
    if (next && typeof next.then === "function") return next;
    if (next instanceof Error) throw next;
    return next;
  };
  const controller = Controller({
    getJson,
    ...clock,
    resolveProxyBase: (address) => `/proxy/${address.location_id}`,
    portalKey: (entry) => entry && entry.portal_id != null ? String(entry.portal_id) : null,
    normalizeTraversal: (rule) => rule || { mode: "bidirectional", allowed_entry_side: "both" },
    portalEntrySideAllowed: (rule, side) =>
      rule.mode !== "one_way" || rule.allowed_entry_side === "both" || rule.allowed_entry_side === side,
    adoptDestinationPortalPose: (machine, poseValue) => adopted.push({ machine, pose: poseValue }),
    onTargetSetChanged: (value) => targets.push(value),
    emitState: () => emits.push(clock.nowMs()),
    log: (message) => logs.push(message),
    readCacheCapFixture: () => fixtureCap,
    getActiveBase: () => "/active",
    getAvatarPose: () => pose && pose.slice(),
  });
  return {
    controller,
    clock,
    queue,
    urls,
    emits,
    logs,
    adopted,
    targets,
    setPose: (value) => { pose = value ? value.slice() : null; },
    state: () => controller.compatibilityState(),
  };
}

async function settle(env, turns = 12) {
  await flush(turns);
  return env.state();
}

await check("reset builds keyed machines, budget-one scheduler, and one poller lifecycle", async () => {
  const env = makeEnv();
  const a = portal("a");
  const b = portal("b");
  env.queue.push({ occupancy: { avatars: [] } }, { occupancy: { avatars: [] } });
  const machines = env.controller.reset({ reason: "test", world: world([a, b]), clientMode: "player" });
  await settle(env);
  assert.deepEqual(Object.keys(machines), ["a", "b"]);
  assert.equal(env.state().scheduler.budget, 1);
  assert.equal(env.clock.intervalCount(), 1);
  assert.deepEqual(env.clock.intervalDelays(), [5000]);
  assert.equal(env.targets.length, 1);
});

await check("observer and single-portal reset issue no lobby occupancy traffic", async () => {
  const observer = makeEnv();
  observer.controller.reset({ world: world([portal("a"), portal("b")]), clientMode: "observer" });
  await settle(observer);
  assert.equal(observer.urls.length, 0);
  assert.equal(observer.clock.intervalCount(), 0);
  const single = makeEnv();
  single.controller.reset({ world: world([portal("a")]), clientMode: "player" });
  await settle(single);
  assert.equal(single.urls.length, 0);
});

await check("stationary bidirectional arrival seeds prefetch on reset without weakening one-way suppression", async () => {
  const arrived = makeEnv();
  const returnPortal = portal("return", 0);
  arrived.setPose([0, 0, 0]);
  arrived.queue.push(discovery("return"), chunk());
  arrived.controller.reset({
    reason: "promoted_to_destination",
    world: world([returnPortal], "destination"),
    clientMode: "player",
  });
  assert.deepEqual(arrived.urls, ["/proxy/location-return/.well-known/fabric"]);
  await arrived.clock.runNextTimeout();
  await settle(arrived);
  assert.equal(arrived.state().machines.return.status, "warm");
  assert.deepEqual(arrived.state().machines.return.presence.payload.occupancy.avatars, []);

  const oneWay = makeEnv();
  oneWay.setPose([0, 0, 0]);
  oneWay.controller.reset({
    reason: "promoted_to_one_way_destination",
    world: world([
      portal("one-way", 0, {
        traversal: { mode: "one_way", allowed_entry_side: "front" },
      }),
    ]),
    clientMode: "player",
  });
  assert.equal(oneWay.urls.length, 0);
  assert.equal(oneWay.state().machines["one-way"].status, "idle");
});

await check("zone entry starts discovery from update and preserves initiation order", async () => {
  const env = makeEnv();
  const a = portal("a");
  env.controller.reset({ world: world([a]), clientMode: "player" });
  assert.equal(env.urls.length, 0);
  env.queue.push(discovery("a"), chunk());
  env.controller.update({ avatar: { position: [0, 0, 0] }, evaluations: [evaluation(a)] });
  assert.deepEqual(env.urls, ["/proxy/location-a/.well-known/fabric"]);
  await settle(env);
  assert.equal(env.state().machines.a.status, "warm");
  assert.deepEqual(env.urls.slice(0, 2), [
    "/proxy/location-a/.well-known/fabric",
    "/proxy/location-a/fabric/region?anchor_portal_id=a&radius_m=6&chunked=1&scope=roi&max_entities=12&max_bytes=6144",
  ]);
});

await check("one-way blocked-side suppression retains geometric inside and performs no GET", async () => {
  const env = makeEnv();
  const a = portal("a", 0, { traversal: { mode: "one_way", allowed_entry_side: "front" } });
  env.controller.reset({ world: world([a]), clientMode: "player" });
  env.controller.update({ avatar: { position: [0, 0, 0] }, evaluations: [evaluation(a, [0, 0, 0], "back")] });
  const machine = env.state().machines.a;
  assert.equal(machine.zone.inside, true);
  assert.equal(machine.zone.arming_suppressed, true);
  assert.equal(machine.status, "idle");
  assert.equal(env.urls.length, 0);
});

await check("nearest/tie order, budget, queue, preemption margin, and gauges are exact", async () => {
  const tie = makeEnv();
  const a = portal("a");
  const b = portal("b");
  const pending = deferred();
  tie.queue.push(pending.promise);
  tie.controller.reset({ world: world([a, b]), clientMode: "observer" });
  tie.controller.update({
    avatar: { position: [0, 0, 0] },
    evaluations: [evaluation(b, [1, 0, 0]), evaluation(a, [-1, 0, 0])],
  });
  assert.deepEqual(tie.state().scheduler.priority_order, ["a", "b"]);
  assert.equal(tie.state().machines.a.status, "resolving");
  assert.equal(tie.state().machines.b.queued, true);
  assert.equal(tie.state().scheduler.active_load_count, 1);
  assert.equal(tie.state().scheduler.max_observed_active_loads, 1);

  const preempt = makeEnv();
  const pa = portal("a");
  const pb = portal("b");
  const bPending = deferred();
  const aPending = deferred();
  preempt.queue.push(bPending.promise, aPending.promise);
  preempt.controller.reset({ world: world([pa, pb]), clientMode: "observer" });
  preempt.controller.update({
    avatar: { position: [0, 0, 0] },
    evaluations: [evaluation(pa, [3, 0, 0]), evaluation(pb, [1, 0, 0])],
  });
  preempt.controller.update({
    avatar: { position: [0, 0, 0] },
    evaluations: [evaluation(pa, [0, 0, 0]), evaluation(pb, [0.5, 0, 0])],
  });
  assert.equal(preempt.state().machines.b.status, "resolving", "exact 0.5 m does not preempt");
  preempt.controller.update({
    avatar: { position: [0, 0, 0] },
    evaluations: [evaluation(pa, [0, 0, 0]), evaluation(pb, [0.501, 0, 0])],
  });
  assert.equal(preempt.state().machines.a.status, "resolving", ">0.5 m preempts");
  assert.equal(preempt.state().machines.b.status, "idle");
});

await check("walk-away generation discards deferred discovery without adoption or ready state", async () => {
  const env = makeEnv();
  const a = portal("a");
  const pending = deferred();
  env.queue.push(pending.promise);
  env.controller.reset({ world: world([a]), clientMode: "player" });
  env.controller.update({ avatar: { position: [0, 0, 0] }, evaluations: [evaluation(a)] });
  env.controller.update({ avatar: { position: [50, 0, 0] }, evaluations: [evaluation(a)] });
  pending.resolve(discovery("a"));
  await settle(env);
  const machine = env.state().machines.a;
  assert.equal(machine.status, "cooling");
  assert.equal(machine.resolve.well_known_fabric_id, null);
  assert.equal(env.adopted.length, 0);
  assert.equal(machine.events.some((event) => event.event === "fabric_prefetch_ready"), false);
});

await check("identity mismatch and rejection use exact attempts, backoff, and five-attempt ceiling", async () => {
  const env = makeEnv();
  const a = portal("a");
  env.controller.reset({ world: world([a]), clientMode: "player" });
  env.queue.push(...Array.from({ length: 5 }, () => ({ fabric_id: "wrong" })));
  const input = { avatar: { position: [0, 0, 0] }, evaluations: [evaluation(a)] };
  env.controller.update(input);
  await settle(env);
  assert.equal(env.state().machines.a.region.attempts, 1);
  assert.equal(env.state().machines.a.region.next_retry_at_ms, 2500);
  for (let attempt = 2; attempt <= 5; attempt += 1) {
    env.clock.setNow(env.state().machines.a.region.next_retry_at_ms);
    env.controller.update(input);
    await settle(env);
    assert.equal(env.state().machines.a.region.attempts, attempt);
  }
  const count = env.urls.length;
  env.clock.setNow(env.state().machines.a.region.next_retry_at_ms + 10000);
  env.controller.update(input);
  assert.equal(env.urls.length, count);

  const rejected = makeEnv();
  rejected.controller.reset({ world: world([a]), clientMode: "player" });
  rejected.queue.push(new Error("transport-down"));
  rejected.controller.update(input);
  await settle(rejected);
  assert.equal(rejected.state().machines.a.status, "error");
  assert.equal(rejected.state().machines.a.region.error, "transport-down");
});

await check("chunk routes, budgets, 24 ms yield, streaming, TTL, bytes, and synthesis are exact", async () => {
  const env = makeEnv();
  const a = portal("a");
  env.controller.reset({ world: world([a]), clientMode: "player" });
  env.queue.push(
    discovery("a"),
    chunk({ id: "near", band: 0, byteSize: 111, continuation: "1:0", ttl: 7000 }),
    chunk({ id: "far", band: 1, byteSize: 222, totals: { region_entities: 2, fabric_entities: 2 } }),
  );
  env.controller.update({ avatar: { position: [0, 0, 0] }, evaluations: [evaluation(a)] });
  await settle(env);
  assert.equal(env.clock.timeoutCount(), 1);
  assert.deepEqual(env.clock.timeoutDelays(), [24]);
  assert.equal(env.state().machines.a.region.streaming.entity_count, 1);
  await env.clock.advance(23);
  assert.equal(env.urls.length, 2);
  await env.clock.advance(1);
  await settle(env);
  const machine = env.state().machines.a;
  assert.equal(env.urls[2].endsWith("&cursor=1%3A0"), true);
  assert.equal(machine.region.ttl_ms, 7000);
  assert.equal(machine.region.bytes_total, 333);
  assert.equal(machine.region.progressive.chunk_count, 2);
  assert.equal(machine.region.payload.entities.length, 2);
  assert.deepEqual(machine.region.progressive.band_order, [0, 1]);
});

await check("first missing chunk falls back once while later missing chunk enters error", async () => {
  const fallback = makeEnv();
  const a = portal("a");
  fallback.controller.reset({ world: world([a]), clientMode: "player" });
  fallback.queue.push(discovery("a"), {}, legacy("a"));
  fallback.controller.update({ avatar: { position: [0, 0, 0] }, evaluations: [evaluation(a)] });
  await settle(fallback);
  assert.equal(fallback.state().machines.a.status, "warm");
  assert.equal(fallback.state().machines.a.region.progressive.mode, "legacy_single_response");
  assert.equal(fallback.urls.length, 3);
  assert.equal(fallback.urls[2], "/proxy/location-a/fabric/region?anchor_portal_id=a&radius_m=6");

  const broken = makeEnv();
  broken.controller.reset({ world: world([a]), clientMode: "player" });
  broken.queue.push(discovery("a"), chunk({ continuation: "1:0" }), {});
  broken.controller.update({ avatar: { position: [0, 0, 0] }, evaluations: [evaluation(a)] });
  await settle(broken);
  await broken.clock.advance(24);
  await settle(broken);
  assert.equal(broken.state().machines.a.status, "error");
  assert.match(broken.state().machines.a.region.error, /lost the chunk envelope/);
});

await check("render acknowledgement is idempotent and preserves render-before-final-load", async () => {
  const env = makeEnv();
  const a = portal("a");
  env.controller.reset({ world: world([a]), clientMode: "player" });
  env.queue.push(
    discovery("a"),
    chunk({ id: "near", continuation: "1:0" }),
    chunk({ id: "far", band: 1 }),
  );
  env.controller.update({ avatar: { position: [0, 0, 0] }, evaluations: [evaluation(a)] });
  await settle(env);
  const before = env.emits.length;
  env.controller.notifyChunkRendered("a", 1);
  const renderedAt = env.state().machines.a.region.chunks[0].rendered_at_ms;
  env.controller.notifyChunkRendered("a", 1);
  assert.equal(env.emits.length, before + 1);
  await env.clock.advance(24);
  await settle(env);
  assert.equal(renderedAt <= env.state().machines.a.region.chunks[1].loaded_at_ms, true);
});

await check("cache fixture, protections, LRU, synchronous stats, and unresolvable truth are exact", async () => {
  const env = makeEnv({ fixtureCap: "2000.9" });
  const a = portal("a");
  const b = portal("b");
  const c = portal("c");
  env.controller.reset({ world: world([a, b, c]), clientMode: "observer" });
  const state = env.state();
  for (const [index, machine] of Object.values(state.machines).entries()) {
    machine.region.payload = { entities: [{ object_id: machine.portal_key }] };
    machine.region.bytes_total = 1000;
    machine.status = "cooling";
    machine.last_used_at_ms = index + 1;
  }
  state.scheduler.selected_portal_id = "a";
  state.machines.c.zone.inside = true;
  env.controller._enforceCache("test");
  const debug = env.controller.debug();
  assert.equal(debug.keyed.cache.cap_bytes, 2000);
  assert.equal(debug.keyed.cache.cap_source, "query_param_fixture");
  assert.equal(state.machines.a.region.payload != null, true);
  assert.equal(state.machines.c.region.payload != null, true);
  assert.equal(state.machines.b.region.payload, null);
  assert.equal(debug.keyed.cache.total_bytes, 2000);
  assert.equal(debug.keyed.cache.eviction_count, 1);

  state.machines.b.region.payload = { entities: [{ object_id: "b2" }] };
  state.machines.b.region.bytes_total = 1000;
  state.machines.b.zone.inside = true;
  env.controller._enforceCache("protected");
  assert.equal(env.controller.debug().keyed.cache.over_cap_unresolvable, true);
});

await check("warm refresh cadence, stale reload, duplicate guard, TTL, errors, and self-stop are exact", async () => {
  const env = makeEnv();
  const a = portal("a");
  env.controller.reset({ world: world([a]), clientMode: "player" });
  const machine = env.state().machines.a;
  machine.status = "warm";
  machine.zone.inside = true;
  machine.region.loaded_at_ms = env.clock.nowMs();
  machine.region.ttl_ms = 10000;
  env.queue.push({ ttl_ms: 4321, occupancy: { avatars: [] } });
  env.controller._startPresenceTimer();
  env.controller._startPresenceTimer();
  assert.equal(env.clock.intervalCount(), 1);
  await env.clock.advance(2000);
  await settle(env);
  assert.equal(machine.presence.refresh_count, 1);
  assert.equal(machine.presence.ttl_ms, 4321);
  env.queue.push(new Error("presence-down"));
  await env.clock.advance(2000);
  await settle(env);
  assert.equal(machine.presence.error, "presence-down");

  machine.region.loaded_at_ms = 0;
  machine.region.ttl_ms = 1;
  machine.fetchInFlight = false;
  env.queue.push(discovery("a"), chunk());
  await env.clock.advance(2000);
  await settle(env);
  assert.equal(env.urls.some((url) => url.endsWith("/.well-known/fabric")), true);
  machine.status = "idle";
  await env.clock.advance(2000);
  assert.equal(env.clock.intervalCount(), 0);
});

await check("multi-portal occupancy polls immediately and every five seconds with error isolation", async () => {
  const env = makeEnv();
  const a = portal("a");
  const b = portal("b");
  env.queue.push(new Error("a-down"), { occupancy: { avatars: [{ player_id: "p" }] } });
  env.controller.reset({ world: world([a, b]), clientMode: "player" });
  await settle(env);
  const first = env.state().lobbyOccupancy;
  assert.equal(first.destinations.a.error, "a-down");
  assert.equal(first.destinations.b.occupancy.avatars.length, 1);
  assert.deepEqual(env.urls, [
    "/proxy/location-a/fabric/presence",
    "/proxy/location-b/fabric/presence",
  ]);
  env.queue.push({ occupancy: { avatars: [] } }, { occupancy: { avatars: [] } });
  await env.clock.advance(5000);
  await settle(env);
  assert.equal(env.urls.length, 4);
  env.controller.reset({ world: world([a, b]), clientMode: "observer" });
  assert.equal(env.state().lobbyOccupancy, null);
  assert.equal(env.clock.intervalCount(), 0);
});

await check("validation distinguishes unsupported, cold, stale, fresh, and mid-stream without traversal authority", async () => {
  const empty = makeEnv();
  assert.equal(empty.controller.proofBlock(empty.clock.nowIso()).reason, "prefetch_uninitialized");
  const unsupportedPortal = portal("u", 0, { address: null });
  empty.controller.reset({ world: world([unsupportedPortal]), clientMode: "player" });
  assert.equal(empty.controller.proofBlock(empty.clock.nowIso(), "u").reason, "no_address_on_portal");

  const env = makeEnv();
  const a = portal("a");
  env.controller.reset({ world: world([a]), clientMode: "player" });
  const machine = env.state().machines.a;
  assert.equal(env.controller.proofBlock(env.clock.nowIso(), "a").reason, "cold_at_commit");
  machine.region.payload = { totals: { fabric_entities: 1 }, entities: [{ object_id: "one" }] };
  machine.region.loaded_at_ms = env.clock.nowMs() - 1001;
  machine.region.ttl_ms = 1000;
  assert.equal(env.controller.proofBlock(env.clock.nowIso(), "a").reason, "region_stale_at_commit");
  machine.region.loaded_at_ms = env.clock.nowMs() - 1000;
  const fresh = env.controller.proofBlock(env.clock.nowIso(), "a");
  assert.equal(fresh.used, true);
  assert.equal(fresh.prefetch_before_commit, true);
  machine.region.payload = null;
  machine.region.streaming = { chunks_loaded: 1, entity_count: 2 };
  const mid = env.controller.proofBlock(env.clock.nowIso(), "a");
  assert.equal(mid.used, false);
  assert.equal(mid.progressive_at_commit.streaming_mid_pipeline, true);
  assert.equal(typeof env.controller.triggerHandoff, "undefined");
});

await check("promotion capture happens before reset and excludes streaming-only entities", async () => {
  const env = makeEnv();
  const a = portal("a");
  env.controller.reset({ world: world([a]), clientMode: "player" });
  const machine = env.state().machines.a;
  machine.region.payload = { entities: [{ object_id: "a" }, { object_id: "b" }] };
  const validation = { used: true, portal_key: "a" };
  const captured = env.controller.capturePromotionInput(validation);
  env.controller.reset({ reason: "promoted", world: world([a], "destination"), clientMode: "player" });
  assert.deepEqual(captured.origin_entity_ids, ["a", "b"]);
  machine.region.payload = null;
  machine.region.streaming = { entities: [{ object_id: "stream-only" }] };
  assert.deepEqual(env.controller.capturePromotionInput(validation).origin_entity_ids, []);
});

await check("warm completion resumes at 3:0 while cold starts at null with exact full-scope URL", async () => {
  const warm = makeEnv();
  const a = portal("a");
  warm.controller.reset({ world: world([a], "destination"), clientMode: "player" });
  warm.queue.push(chunk({ id: "full", entities: [{ object_id: "new" }], totals: { fabric_entities: 2 } }));
  warm.controller.startCompletion({
    handoff_id: "h1",
    validation: { used: true, portal_key: "a" },
    origin_entity_ids: ["old"],
    origin_entity_count: 1,
  });
  await settle(warm);
  assert.equal(
    warm.urls[0],
    "/active/fabric/region?anchor_portal_id=a&chunked=1&scope=full&max_entities=6&cursor=3%3A0",
  );

  const cold = makeEnv();
  cold.controller.reset({ world: world([a], "destination"), clientMode: "player" });
  cold.queue.push(chunk({ id: "full", totals: { fabric_entities: 1 } }));
  cold.controller.startCompletion({ validation: { used: false, portal_key: "a" }, origin_entity_ids: [], origin_entity_count: 0 });
  await settle(cold);
  assert.equal(cold.urls[0].includes("cursor="), false);
  assert.equal(cold.controller.completionDebug().origin_prefetch.resume_cursor, null);
});

await check("completion pacing, 64-chunk ceiling, cancellation, unsupported response, and errors are contained", async () => {
  const paced = makeEnv();
  const a = portal("a");
  paced.controller.reset({ world: world([a], "destination"), clientMode: "player" });
  paced.queue.push(
    chunk({ id: "one", continuation: "1:0", totals: { fabric_entities: 2 } }),
    chunk({ id: "two", band: 1, totals: { fabric_entities: 2 } }),
  );
  paced.controller.startCompletion({ origin_entity_ids: [], origin_entity_count: 0 });
  await settle(paced);
  assert.deepEqual(paced.clock.timeoutDelays(), [400]);
  await paced.clock.advance(399);
  assert.equal(paced.urls.length, 1);
  await paced.clock.advance(1);
  await settle(paced);
  assert.equal(paced.controller.completionDebug().chunk_count, 2);

  const limited = makeEnv();
  limited.controller.FABRIC_COMPLETION_PACING_MS = 0;
  limited.controller.reset({ world: world([a], "destination"), clientMode: "player" });
  for (let i = 0; i < 64; i += 1) {
    limited.queue.push(chunk({ id: `c${i}`, continuation: `${i + 1}:0`, totals: { fabric_entities: 64 } }));
  }
  limited.controller.startCompletion({ origin_entity_ids: [], origin_entity_count: 0 });
  for (let i = 0; i < 64; i += 1) {
    await settle(limited);
    await limited.clock.runNextTimeout();
  }
  await settle(limited);
  assert.equal(limited.urls.length, 64);
  assert.equal(limited.controller.completionDebug().chunk_count, 64);

  const cancelled = makeEnv();
  cancelled.controller.reset({ world: world([a], "destination"), clientMode: "player" });
  const pending = deferred();
  cancelled.queue.push(pending.promise, chunk({ id: "new", totals: { fabric_entities: 1 } }));
  const oldJob = cancelled.controller.startCompletion({ handoff_id: "old", origin_entity_ids: [], origin_entity_count: 0 });
  cancelled.controller.startCompletion({ handoff_id: "new", origin_entity_ids: [], origin_entity_count: 0 });
  await settle(cancelled);
  pending.resolve(chunk({ id: "old", totals: { fabric_entities: 1 } }));
  await settle(cancelled);
  assert.equal(oldJob.status, "cancelled");
  assert.equal(cancelled.controller.completionDebug().handoff_id, "new");

  const unsupported = makeEnv();
  unsupported.controller.reset({ world: world([a], "destination"), clientMode: "player" });
  unsupported.queue.push({});
  unsupported.controller.startCompletion({ origin_entity_ids: [], origin_entity_count: 0 });
  await settle(unsupported);
  assert.equal(unsupported.controller.completionDebug().status, "unsupported_by_server");

  const errored = makeEnv();
  errored.controller.reset({ world: world([a], "destination"), clientMode: "player" });
  errored.queue.push(new Error("completion-down"));
  errored.controller.startCompletion({ origin_entity_ids: [], origin_entity_count: 0 });
  await settle(errored);
  assert.equal(errored.controller.completionDebug().status, "error");
  assert.equal(errored.controller.completionDebug().error, "completion-down");
});

await check("completion deduplicates, samples input, reconciles, and mutates exact promotion records", async () => {
  const env = makeEnv();
  const a = portal("a");
  env.controller.reset({ world: world([a], "destination"), clientMode: "player" });
  const promotion = { promoted_at: env.clock.nowIso(), handoff_id: "h1" };
  env.controller.recordPromotion(promotion, { used: true, portal_key: "a" });
  env.queue.push(
    (url) => {
      env.setPose([0, 0, 0]);
      return chunk({
        id: "one",
        entities: [{ object_id: "origin" }, { object_id: "new-1" }],
        continuation: "1:0",
        totals: { fabric_entities: 3 },
      });
    },
    (url) => {
      env.setPose([0.1, 0, 0]);
      return chunk({
        id: "two",
        entities: [{ object_id: "new-1" }, { object_id: "new-2" }],
        totals: { fabric_entities: 3 },
      });
    },
  );
  env.controller.startCompletion({
    handoff_id: "h1",
    promotion_record: promotion,
    validation: { used: true, portal_key: "a" },
    origin_entity_ids: ["origin"],
    origin_entity_count: 1,
  });
  await settle(env);
  await env.clock.advance(400);
  await settle(env);
  const completion = env.controller.completionDebug();
  assert.equal(completion.entities_added, 2);
  assert.equal(completion.reconciliation.received_unique_entities, 3);
  assert.equal(completion.reconciliation.match, true);
  assert.equal(completion.reconciliation.input_during_completion.movement_samples, 1);
  assert.equal(promotion.fabric_completion.match, true);
  assert.strictEqual(
    env.controller.debug().last_promoted.fabric_completion,
    promotion.fabric_completion,
  );
});

await check("return-style cancellation clears completion without touching prefetch machines", async () => {
  const env = makeEnv();
  const a = portal("a");
  env.controller.reset({ world: world([a], "destination"), clientMode: "player" });
  const pending = deferred();
  env.queue.push(pending.promise);
  env.controller.startCompletion({ origin_entity_ids: [], origin_entity_count: 0 });
  const machines = env.state().machines;
  env.controller.cancelCompletion("return_to_lobby");
  assert.equal(env.controller.completionDebug(), null);
  assert.strictEqual(env.state().machines, machines);
  assert.equal(Object.keys(machines).length, 1);
});

await check("targeted departure removes only selected presence/snapshot/streaming/lobby projections", async () => {
  const env = makeEnv();
  const a = portal("a", 0, { target_location_id: "location-shared" });
  const b = portal("b", 1, { target_location_id: "location-other" });
  env.queue.push({ occupancy: { avatars: [] } }, { occupancy: { avatars: [] } });
  env.controller.reset({ world: world([a, b]), clientMode: "player" });
  await settle(env);
  const state = env.state();
  const avatars = [{ player_id: "gone" }, { player_id: "stay" }];
  state.machines.a.presence.payload = {
    occupancy: { avatars: avatars.map((value) => ({ ...value })), registered_player_count: 2 },
  };
  state.machines.a.region.payload = {
    avatars: { avatars: avatars.map((value) => ({ ...value })), avatars_in_circle: 2 },
  };
  state.machines.a.region.streaming = {
    avatars: { avatars: avatars.map((value) => ({ ...value })), avatars_in_circle: 2 },
  };
  state.machines.b.presence.payload = { occupancy: { avatars: [{ player_id: "gone" }] } };
  state.lobbyOccupancy.destinations.a = {
    target_location_id: "location-shared",
    occupancy: { avatars: avatars.map((value) => ({ ...value })), registered_player_count: 2 },
  };
  const result = env.controller.removePresencePlayer({
    playerId: "gone",
    targetLocationId: "location-shared",
    endpointKey: "a",
    receivedAtMs: env.clock.nowMs(),
  });
  assert.equal(result.prefetch_presence_removed, 1);
  assert.equal(result.prefetch_snapshot_removed, 2);
  assert.equal(result.lobby_occupancy_removed, 1);
  assert.deepEqual(result.affected_portal_keys, ["a"]);
  assert.deepEqual(state.machines.a.presence.payload.occupancy.avatars.map((value) => value.player_id), ["stay"]);
  assert.equal(state.machines.b.presence.payload.occupancy.avatars.length, 1);
});

await check("debug/validation fields, bounded windows, and compatibility references remain stable", async () => {
  const env = makeEnv();
  const a = portal("a");
  env.controller.reset({ world: world([a]), clientMode: "player" });
  const machine = env.state().machines.a;
  for (let i = 0; i < 45; i += 1) env.controller._event(machine, `event-${i}`);
  for (let i = 0; i < 65; i += 1) env.controller._schedulerEvent(`scheduler-${i}`);
  const debug = env.controller.debug({ focusPortalId: "a" });
  assert.equal(debug.validation.read_only_before_crossing, true);
  assert.equal(debug.validation.roi_standard_conformance, false);
  assert.equal(debug.events.length, 32);
  assert.equal(debug.keyed.scheduler_events.length, 20);
  assert.deepEqual(Object.keys(debug.keyed.machines), ["a"]);
  const compatibility = env.controller.compatibilityState();
  assert.strictEqual(compatibility.machines, env.state().machines);
  assert.strictEqual(compatibility.scheduler, env.state().scheduler);
});

function assertFacadeContainment(source) {
  const traversalIndex = source.indexOf('this._beginPortalTransition("plane_crossing", ev.portal);');
  const prefetchTryIndex = source.indexOf("try {\n        this._updateFabricPrefetch(avatar, evaluations);");
  const prefetchCatchIndex = source.indexOf("/* prefetch is additive — a prefetch fault must never break the tick */");
  assert.ok(traversalIndex >= 0 && prefetchTryIndex > traversalIndex && prefetchCatchIndex > prefetchTryIndex);
}

await check("facade contains injected prefetch exceptions after traversal evaluation and grants no traversal authority", async () => {
  assertFacadeContainment(ADAPTER_SOURCE);
  assert.equal(CONTROLLER_SOURCE.includes("_beginPortalTransition"), false);
  assert.equal(CONTROLLER_SOURCE.includes("triggerHandoff"), false);
  assert.equal(CONTROLLER_SOURCE.includes("portal/exit-intent"), false);
  assert.equal(CONTROLLER_SOURCE.includes("portal/arrival"), false);
});

function replaceOnce(source, anchor, replacement, name) {
  const index = source.indexOf(anchor);
  assert.notEqual(index, -1, `${name}: mutation anchor missing`);
  return source.slice(0, index) + replacement + source.slice(index + anchor.length);
}

const MUTATORS = {
  "blocked-side-loads": (source) =>
    replaceOnce(source, "      const suppressed = inside && blocked;", "      const suppressed = false;", "blocked-side-loads"),
  "budget-unbounded": (source) =>
    replaceOnce(source, "  FABRIC_PREFETCH_MAX_ACTIVE_LOADS: 1,", "  FABRIC_PREFETCH_MAX_ACTIVE_LOADS: 2,", "budget-unbounded"),
  "nearest-tie-reversed": (source) =>
    replaceOnce(
      source,
      "      return String(a.portal_key) < String(b.portal_key) ? -1 : 1;",
      "      return String(a.portal_key) > String(b.portal_key) ? -1 : 1;",
      "nearest-tie-reversed",
    ),
  "preempt-margin-removed": (source) =>
    replaceOnce(source, "  FABRIC_PREFETCH_PREEMPT_MARGIN_M: 0.5,", "  FABRIC_PREFETCH_PREEMPT_MARGIN_M: 0,", "preempt-margin-removed"),
  "generation-check-removed": (source) =>
    replaceOnce(
      source,
      "      if (machine.generation !== generation) {\n        this._event(machine, \"fabric_prefetch_pipeline_discarded\", {\n          stage: \"resolve\",",
      "      if (false) {\n        this._event(machine, \"fabric_prefetch_pipeline_discarded\", {\n          stage: \"resolve\",",
      "generation-check-removed",
    ),
  "legacy-fallback-removed": (source) =>
    replaceOnce(
      source,
      "          return null;\n        }\n        throw new Error(\"chunked region stream lost the chunk envelope mid-walk\");",
      "          throw new Error(\"legacy fallback removed\");\n        }\n        throw new Error(\"chunked region stream lost the chunk envelope mid-walk\");",
      "legacy-fallback-removed",
    ),
  "chunk-yield-removed": (source) =>
    replaceOnce(
      source,
      "      await this._delay(this.FABRIC_PREFETCH_CHUNK_YIELD_MS);",
      "      await Promise.resolve();",
      "chunk-yield-removed",
    ),
  "cache-protection-removed": (source) =>
    replaceOnce(
      source,
      "        .filter((machine) => machine.portal_key !== selected)\n",
      "",
      "cache-protection-removed",
    ),
  "presence-duplicate-timer": (source) =>
    replaceOnce(source, "    if (this._presenceTimer) return;", "    if (false) return;", "presence-duplicate-timer"),
  "occupancy-observer-enabled": (source) =>
    replaceOnce(
      source,
      "    if (this._clientMode !== \"player\" || portals.length < 2) {",
      "    if (false) {",
      "occupancy-observer-enabled",
    ),
  "validation-stale-used": (source) =>
    replaceOnce(
      source,
      "    const used = !!machine.region.payload && fresh;",
      "    const used = !!machine.region.payload;",
      "validation-stale-used",
    ),
  "promotion-capture-after-reset": (source) =>
    replaceOnce(
      source,
      "  capturePromotionInput(validation) {\n    const machine =",
      "  capturePromotionInput(validation) {\n    this.reset({ reason: \"mutated_capture_after_reset\", world: this._world, clientMode: this._clientMode });\n    const machine =",
      "promotion-capture-after-reset",
    ),
  "completion-cursor-cold": (source) =>
    replaceOnce(
      source,
      "        resume_cursor: warmResume ? \"3:0\" : null,",
      "        resume_cursor: \"3:0\",",
      "completion-cursor-cold",
    ),
  "completion-pacing-removed": (source) =>
    replaceOnce(
      source,
      "          await this._delay(this.FABRIC_COMPLETION_PACING_MS);",
      "          await Promise.resolve();",
      "completion-pacing-removed",
    ),
  "completion-generation-removed": (source) =>
    (() => {
      const anchor = "          if (generation !== this._completionGeneration || this._completion !== job) {";
      const count = source.split(anchor).length - 1;
      assert.equal(count, 2, "completion-generation-removed: expected both generation gates");
      return source.split(anchor).join("          if (false) {");
    })(),
  "completion-record-omitted": (source) =>
    replaceOnce(
      source,
      "        if (context.promotion_record) context.promotion_record.fabric_completion = completionSummary;",
      "        void context.promotion_record;",
      "completion-record-omitted",
    ),
  "departure-invalidation-off": (source) =>
    replaceOnce(
      source,
      "  removePresencePlayer({ playerId, targetLocationId, endpointKey, receivedAtMs } = {}) {\n",
      "  removePresencePlayer({ playerId, targetLocationId, endpointKey, receivedAtMs } = {}) {\n    return { prefetch_presence_removed: 0, prefetch_snapshot_removed: 0, lobby_occupancy_removed: 0, affected_portal_keys: [] };\n",
      "departure-invalidation-off",
    ),
  "debug-shape-drift": (source) =>
    replaceOnce(source, "      keyed: {", "      keyed_drift: {", "debug-shape-drift"),
};

async function loadMutatedFactory(name) {
  const source = MUTATORS[name](CONTROLLER_SOURCE);
  const url = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}#${name}`;
  const module = await import(url);
  return module.createFabricPrefetchController;
}

async function catchMutation(name, fn) {
  let caught = false;
  try {
    await fn();
  } catch (error) {
    caught = true;
  }
  assert.equal(caught, true, `${name}: focused validation stayed green`);
  mutationsCaught += 1;
  process.stdout.write(`mutation ${mutationsCaught} - ${name} APPLIED/CAUGHT\n`);
}

await catchMutation("prefetch-exception-escapes", async () => {
  const mutated = replaceOnce(
    ADAPTER_SOURCE,
    "      try {\n        this._updateFabricPrefetch(avatar, evaluations);\n      } catch (e) {\n        /* prefetch is additive — a prefetch fault must never break the tick */\n      }",
    "      this._updateFabricPrefetch(avatar, evaluations);",
    "prefetch-exception-escapes",
  );
  assertFacadeContainment(mutated);
});

await catchMutation("blocked-side-loads", async () => {
  const Factory = await loadMutatedFactory("blocked-side-loads");
  const env = makeEnv({ Controller: Factory });
  const a = portal("a", 0, { traversal: { mode: "one_way", allowed_entry_side: "front" } });
  const pending = deferred();
  env.queue.push(pending.promise);
  env.controller.reset({ world: world([a]), clientMode: "player" });
  env.controller.update({ avatar: { position: [0, 0, 0] }, evaluations: [evaluation(a, [0, 0, 0], "back")] });
  assert.equal(env.urls.length, 0);
});

await catchMutation("budget-unbounded", async () => {
  const Factory = await loadMutatedFactory("budget-unbounded");
  const env = makeEnv({ Controller: Factory });
  const a = portal("a");
  const b = portal("b");
  env.queue.push(deferred().promise, deferred().promise);
  env.controller.reset({ world: world([a, b]), clientMode: "observer" });
  env.controller.update({ avatar: { position: [0, 0, 0] }, evaluations: [evaluation(a), evaluation(b)] });
  assert.equal(env.state().scheduler.active_load_count, 1);
});

await catchMutation("nearest-tie-reversed", async () => {
  const Factory = await loadMutatedFactory("nearest-tie-reversed");
  const env = makeEnv({ Controller: Factory });
  const a = portal("a");
  const b = portal("b");
  env.queue.push(deferred().promise);
  env.controller.reset({ world: world([a, b]), clientMode: "observer" });
  env.controller.update({ avatar: { position: [0, 0, 0] }, evaluations: [evaluation(a), evaluation(b)] });
  assert.deepEqual(env.state().scheduler.priority_order, ["a", "b"]);
});

await catchMutation("preempt-margin-removed", async () => {
  const Factory = await loadMutatedFactory("preempt-margin-removed");
  const env = makeEnv({ Controller: Factory });
  const a = portal("a");
  const b = portal("b");
  env.queue.push(deferred().promise, deferred().promise);
  env.controller.reset({ world: world([a, b]), clientMode: "observer" });
  env.controller.update({ avatar: { position: [0, 0, 0] }, evaluations: [evaluation(a, [3, 0, 0]), evaluation(b, [1, 0, 0])] });
  env.controller.update({ avatar: { position: [0, 0, 0] }, evaluations: [evaluation(a, [0, 0, 0]), evaluation(b, [0.25, 0, 0])] });
  assert.equal(env.state().machines.b.status, "resolving");
});

await catchMutation("generation-check-removed", async () => {
  const Factory = await loadMutatedFactory("generation-check-removed");
  const env = makeEnv({ Controller: Factory });
  const a = portal("a");
  const pending = deferred();
  env.queue.push(pending.promise, new Error("stop-after-mutated-resolve"));
  env.controller.reset({ world: world([a]), clientMode: "player" });
  env.controller.update({ avatar: { position: [0, 0, 0] }, evaluations: [evaluation(a)] });
  env.controller.update({ avatar: { position: [50, 0, 0] }, evaluations: [evaluation(a)] });
  pending.resolve(discovery("a"));
  await settle(env);
  assert.equal(env.state().machines.a.resolve.well_known_fabric_id, null);
});

await catchMutation("legacy-fallback-removed", async () => {
  const Factory = await loadMutatedFactory("legacy-fallback-removed");
  const env = makeEnv({ Controller: Factory });
  const a = portal("a");
  env.queue.push(discovery("a"), {}, legacy("a"));
  env.controller.reset({ world: world([a]), clientMode: "player" });
  env.controller.update({ avatar: { position: [0, 0, 0] }, evaluations: [evaluation(a)] });
  await settle(env);
  assert.equal(env.state().machines.a.status, "warm");
});

await catchMutation("chunk-yield-removed", async () => {
  const Factory = await loadMutatedFactory("chunk-yield-removed");
  const env = makeEnv({ Controller: Factory });
  const a = portal("a");
  env.queue.push(discovery("a"), chunk({ continuation: "1:0" }), chunk({ id: "two" }));
  env.controller.reset({ world: world([a]), clientMode: "player" });
  env.controller.update({ avatar: { position: [0, 0, 0] }, evaluations: [evaluation(a)] });
  await settle(env);
  assert.equal(env.clock.timeoutCount(), 1);
});

await catchMutation("cache-protection-removed", async () => {
  const Factory = await loadMutatedFactory("cache-protection-removed");
  const env = makeEnv({ Controller: Factory, fixtureCap: "1024" });
  const a = portal("a");
  const b = portal("b");
  env.controller.reset({ world: world([a, b]), clientMode: "observer" });
  const state = env.state();
  for (const machine of Object.values(state.machines)) {
    machine.region.payload = { entities: [{ object_id: machine.portal_key }] };
    machine.region.bytes_total = 1024;
    machine.status = "cooling";
  }
  state.scheduler.selected_portal_id = "a";
  state.machines.a.last_used_at_ms = 0;
  state.machines.b.last_used_at_ms = 10;
  env.controller._enforceCache("mutation");
  assert.notEqual(state.machines.a.region.payload, null);
});

await catchMutation("presence-duplicate-timer", async () => {
  const Factory = await loadMutatedFactory("presence-duplicate-timer");
  const env = makeEnv({ Controller: Factory });
  env.controller._startPresenceTimer();
  env.controller._startPresenceTimer();
  assert.equal(env.clock.intervalCount(), 1);
});

await catchMutation("occupancy-observer-enabled", async () => {
  const Factory = await loadMutatedFactory("occupancy-observer-enabled");
  const env = makeEnv({ Controller: Factory });
  env.controller.reset({ world: world([portal("a"), portal("b")]), clientMode: "observer" });
  await settle(env);
  assert.equal(env.urls.length, 0);
});

await catchMutation("validation-stale-used", async () => {
  const Factory = await loadMutatedFactory("validation-stale-used");
  const env = makeEnv({ Controller: Factory });
  const a = portal("a");
  env.controller.reset({ world: world([a]), clientMode: "player" });
  const machine = env.state().machines.a;
  machine.region.payload = { entities: [] };
  machine.region.loaded_at_ms = 0;
  machine.region.ttl_ms = 1;
  assert.equal(env.controller.proofBlock(env.clock.nowIso(), "a").used, false);
});

await catchMutation("promotion-capture-after-reset", async () => {
  const Factory = await loadMutatedFactory("promotion-capture-after-reset");
  const env = makeEnv({ Controller: Factory });
  const a = portal("a");
  env.controller.reset({ world: world([a]), clientMode: "player" });
  env.state().machines.a.region.payload = { entities: [{ object_id: "keep" }] };
  assert.deepEqual(env.controller.capturePromotionInput({ used: true, portal_key: "a" }).origin_entity_ids, ["keep"]);
});

await catchMutation("completion-cursor-cold", async () => {
  const Factory = await loadMutatedFactory("completion-cursor-cold");
  const env = makeEnv({ Controller: Factory });
  const a = portal("a");
  env.queue.push(chunk());
  env.controller.reset({ world: world([a], "destination"), clientMode: "player" });
  env.controller.startCompletion({ validation: { used: false }, origin_entity_ids: [], origin_entity_count: 0 });
  await settle(env);
  assert.equal(env.urls[0].includes("cursor="), false);
});

await catchMutation("completion-pacing-removed", async () => {
  const Factory = await loadMutatedFactory("completion-pacing-removed");
  const env = makeEnv({ Controller: Factory });
  const a = portal("a");
  env.queue.push(chunk({ continuation: "1:0" }), chunk({ id: "two" }));
  env.controller.reset({ world: world([a], "destination"), clientMode: "player" });
  env.controller.startCompletion({ origin_entity_ids: [], origin_entity_count: 0 });
  await settle(env);
  assert.equal(env.clock.timeoutCount(), 1);
});

await catchMutation("completion-generation-removed", async () => {
  const Factory = await loadMutatedFactory("completion-generation-removed");
  const env = makeEnv({ Controller: Factory });
  const a = portal("a");
  const pending = deferred();
  env.queue.push(pending.promise, chunk({ id: "new" }));
  env.controller.reset({ world: world([a], "destination"), clientMode: "player" });
  const old = env.controller.startCompletion({ handoff_id: "old", origin_entity_ids: [], origin_entity_count: 0 });
  env.controller.startCompletion({ handoff_id: "new", origin_entity_ids: [], origin_entity_count: 0 });
  await settle(env);
  pending.resolve(chunk({ id: "old" }));
  await settle(env);
  assert.equal(old.status, "cancelled");
});

await catchMutation("completion-record-omitted", async () => {
  const Factory = await loadMutatedFactory("completion-record-omitted");
  const env = makeEnv({ Controller: Factory });
  const a = portal("a");
  const promotion = {};
  env.queue.push(chunk());
  env.controller.reset({ world: world([a], "destination"), clientMode: "player" });
  env.controller.startCompletion({ promotion_record: promotion, origin_entity_ids: [], origin_entity_count: 0 });
  await settle(env);
  assert.equal(promotion.fabric_completion.match, true);
});

await catchMutation("departure-invalidation-off", async () => {
  const Factory = await loadMutatedFactory("departure-invalidation-off");
  const env = makeEnv({ Controller: Factory });
  const a = portal("a");
  env.controller.reset({ world: world([a]), clientMode: "player" });
  env.state().machines.a.presence.payload = { occupancy: { avatars: [{ player_id: "gone" }] } };
  const result = env.controller.removePresencePlayer({ playerId: "gone", targetLocationId: "location-a" });
  assert.equal(result.prefetch_presence_removed, 1);
});

await catchMutation("debug-shape-drift", async () => {
  const Factory = await loadMutatedFactory("debug-shape-drift");
  const env = makeEnv({ Controller: Factory });
  env.controller.reset({ world: world([portal("a")]), clientMode: "player" });
  assert.equal(env.controller.debug().keyed.portal_count, 1);
});

assert.equal(assertions, 23);
assert.equal(mutationsCaught, 19);
process.stdout.write(`feature_FABRIC_PREFETCH_CONTROLLER PASS ${assertions}/${assertions} mutations=${mutationsCaught}/${mutationsCaught}\n`);
