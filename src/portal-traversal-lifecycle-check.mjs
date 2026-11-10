import assert from "node:assert/strict";
import { createPortalTraversalHandoffController } from "../web/live-adapter-portal-traversal-controller.mjs";
import { nodeChecks } from "../tools/behavior/node-checks.mjs";
import { signManifestOntoPacket, verifyManifestFromPacket } from "../web/live-adapter-crossing-manifest.mjs";
import { publishCrossingDiagnostics } from "../web/live-adapter-crossing-diagnostics.mjs";

const { check, finish } = nodeChecks("portal-traversal-lifecycle");
const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function withClock(run) {
  const nativeTimeout = globalThis.setTimeout, nativeClear = globalThis.clearTimeout;
  const timers = new Map(); let clock = 0;
  globalThis.setTimeout = (fn, ms) => { const id = {}; timers.set(id, { fn, due: clock + ms }); return id; };
  globalThis.clearTimeout = id => timers.delete(id);
  const time = { now: () => clock, async advance(ms) {
    clock += ms;
    for (const [id, entry] of [...timers]) if (entry.due <= clock) { timers.delete(id); entry.fn(); }
    await flush();
  } };
  try { await run(time); assert.equal(timers.size, 0, "all observation timers released"); }
  finally { timers.clear(); globalThis.setTimeout = nativeTimeout; globalThis.clearTimeout = nativeClear; }
}

function harness(time, modes = {}) {
  const trace = [], gates = [], posts = [];
  let serial = 0, registered = "/a";
  const endpoint = key => ({ key, proxy_base: `/${key}`, backend_base_url: `https://${key}.invalid` });
  const world = key => ({ location_id: key, world_id: `world-${key}`, avatar: { avatar_id: "avatar", continuity_id: "person" }, portals: [], arrival: { position: [0, 0, 0] } });
  const host = { endpoint: endpoint("a"), world: world("a"), base: "/a", activeEndpointKey: "a", clientMode: "player", phase: "idle",
    avatar: { avatar_id: "avatar", continuity_id: "person", position: [0, 0, 0], rotation_y: 0, equippedItems: [] }, controls: { enabled: true }, resolveEndpoint: endpoint };
  const portal = { portal_id: "test", frame: null, target_frame: null, target_location_id: "b", target_base_url: "/b", trigger: { position: [0, 0, 0], radius_m: 1 } };
  const no = () => {};
  const answer = (kind, value) => {
    if (modes[kind] === "pending") { const gate = { ...deferred(), kind, value }; gates.push(gate); return gate.promise; }
    if (modes[kind] === "reject") return Promise.reject(new Error(`${kind} refused`));
    return Promise.resolve(value);
  };
  const controller = createPortalTraversalHandoffController({
    handoffPhases: { IDLE: "idle", ARRIVED: "arrived", DEPARTED: "departed", PORTAL_ACTIVE: "active" }, provenance: { LIVE: "live" }, nowMs: time.now, nowIso: () => new Date(time.now()).toISOString(),
    readHostSnapshot: () => host,
    applyTraversalPatch: patch => { Object.assign(host, patch); trace.push(["patch", structuredClone(patch)]); },
    transport: {
      postJson(url, body) {
        posts.push({ url, handoff: body.handoff_id ?? null, body, bytes: JSON.stringify(body) });
        if (url.endsWith("/exit-intent")) return answer("exit", { handoff_id: `h${++serial}`, source: { location_id: host.activeEndpointKey }, target: { location_id: host.activeEndpointKey === "a" ? "b" : "a", arrival_position: [0, 0, 0] } });
        trace.push(["arrival", body.handoff_id]); return answer("arrival", {});
      },
      getJson(url) { trace.push(["debug", url]); return answer("debug", { session: { arrival_count: 1 } }); },
    },
    resolveEndpointForLocation: x => x, oppositeEndpointKey: x => x === "a" ? "b" : "a",
    endpointDebug: (ep, w) => ({ endpoint_key: ep.key, proxy_base: ep.proxy_base, location_id: w?.location_id }),
    promoteActiveEndpoint(key) {
      Object.assign(host, { endpoint: endpoint(key), base: `/${key}`, activeEndpointKey: key, world: world(key) }); trace.push(["promote", key]);
      return answer("promotion", { promotion: "fixture", destinationSceneSource: "fixture" });
    },
    deriveFabricExitPose: () => ({ position: [0, 0, 0], rotation_y: 0 }), recordMarkerComparison: () => ({ marker_identity_equal: true }),
    previewDebug: () => null, navigatorDebug: () => null, broadcastPlayerPose: () => trace.push(["pose"]), emitState: () => trace.push(["emit"]),
    dispatchCrossing: value => trace.push(["dispatch", value.handoff_id]),
    visualTransition: { begin: no, commit: () => trace.push(["visual"]), abort: () => trace.push(["abort"]) }, log: message => trace.push(["log", message]),
    presence: {
      snapshot: () => ({ supported: true, registered_base: registered }), controlledIdentity: () => ({ player_id: "p", client_id: "c" }),
      departPresence(args) { trace.push(["depart", args.base]); registered = null; return answer("depart", {}); },
      registerPresence(args) { registered = host.base; trace.push(["register", registered, args.spawnReason]); return answer("register", modes.registrationRefused ? null : {}); },
    },
    peers: { broadcast: value => trace.push(["peer", value.type]) }, prefetch: { proofBlock: () => null }, policy: { evaluateRp1Gate: () => ({ decision: "allow" }) },
    crypto: modes.crypto || { signManifest: () => answer("sign", { signed: true }), verifyManifest: () => answer("verify", { present: false }) },
    assets: { defaultEquippedItems: () => [], defaultAvatarVariant: "fixture", resolveEquipmentItems: () => answer("equipment", []) },
    validation: { transformSnapshot: a => ({ position: a.position.slice(), rotation_y: a.rotation_y }) },
    movement: { speedMps: 1, facingSemanticsFromDelta: () => "forward" },
  });
  return { controller, host, trace, gates, posts, modes, begin: () => controller.beginTransition({ portal }), async drain() {
    for (let round = 0; round < 5; round++) { for (const gate of gates) gate.resolve(gate.value); await flush(); }
    controller.reset({ startsEmbodied: true }); await flush();
  } };
}
const arrivalPosts = h => h.posts.filter(post => post.url.endsWith("/arrival"));

await check("immediate", "Two crossings retain visual adjacency and ordered presence", () => withClock(async time => {
  const h = harness(time);
  for (const target of ["b", "a"]) {
    const start = h.trace.length; assert.equal(h.begin(), true); await flush();
    assert.equal(h.controller.inFlight(), false); assert.equal(h.host.activeEndpointKey, target);
    const trace = h.trace.slice(start), visual = trace.findIndex(event => event[0] === "visual");
    assert.equal(trace[visual + 1][0], "dispatch", "visual commit and dispatch remain adjacent");
    const departure = trace.findIndex(event => event[0] === "depart"), register = trace.findIndex(event => event[0] === "register");
    assert(visual < departure && departure < register, "departure precedes destination registration after visual commit");
  }
  assert.equal(arrivalPosts(h).length, 2); await h.drain();
}));

for (const mode of ["arrival", "debug"]) await check(`${mode}-deadline`, "Optional observation expires and another crossing proceeds without its answer", () => withClock(async time => {
  const h = harness(time, { [mode]: "pending" }); h.begin(); await flush();
  assert.equal(h.trace.filter(event => event[0] === "register").length, 1, "optional observation must not gate destination presence");
  await time.advance(15001);
  assert.equal(h.controller.inFlight(), false, `${mode}: optional request must not hold crossing after deadline`);
  const notification = h.controller.crossingDebug().server_notifications.arrival;
  assert.equal(notification.accepted, mode === "debug"); assert.equal(notification.outcome, mode === "debug" ? "accepted" : "unknown");
  assert.equal(notification.observation, "timed_out"); assert.equal(notification.arrival_count_after, null);
  assert.equal(h.trace.filter(event => event[0] === "register").length, 1);
  assert.equal(h.begin(), true); await flush(); assert.equal(arrivalPosts(h).length, 2, "one arrival POST per crossing, no retry");
  const before = JSON.stringify(h.controller.debug()), traceStart = h.trace.length;
  h.gates[0].resolve({ session: { arrival_count: 314 } }); await flush();
  assert.equal(JSON.stringify(h.controller.debug()), before, "expired observation cannot alter newer crossing");
  assert.equal(h.trace.length, traceStart, "expired observation publishes nothing");
  assert.equal(h.controller.inFlight(), true, "old answer must not release newer guard");
  h.gates[1].resolve(h.gates[1].value); await flush(); assert.equal(h.controller.inFlight(), false); await h.drain();
}));

await check("reset-late-debug", "Reset revokes old publication, profile, presence and guard release", () => withClock(async time => {
  const h = harness(time, { debug: "pending" }); h.begin(); await flush(); h.controller.reset({ startsEmbodied: true }); h.begin(); await flush();
  const traceStart = h.trace.length, snapshot = JSON.stringify(h.controller.debug());
  h.gates[0].resolve({ session: { arrival_count: 314 } }); await flush();
  assert.equal(h.trace.length, traceStart, "revoked debug must not publish or touch presence");
  assert.equal(JSON.stringify(h.controller.debug()), snapshot, "revoked debug must not change current profile/timing");
  assert.equal(h.controller.inFlight(), true, "revoked debug must not release newer guard");
  await h.drain();
}));

await check("observation-rejections", "Rejection stays unknown unless the POST was accepted; late rejection is inert", () => withClock(async time => {
  for (const mode of ["arrival", "debug"]) {
    const h = harness(time, { [mode]: "reject" }); h.begin(); await flush();
    const notification = h.controller.crossingDebug().server_notifications.arrival;
    assert.equal(h.controller.inFlight(), false); assert.equal(notification.accepted, mode === "debug");
    assert.equal(notification.outcome, mode === "debug" ? "accepted" : "unknown"); assert.equal(notification.observation, "failed");
    assert.equal(h.trace.some(event => event[0] === "abort"), false); await h.drain();
  }
  const h = harness(time, { arrival: "pending" }); h.begin(); await flush(); await time.advance(15001);
  const before = h.trace.length, snapshot = JSON.stringify(h.controller.debug());
  h.gates[0].reject(new Error("late transport rejection")); await flush();
  assert.equal(h.trace.length, before); assert.equal(JSON.stringify(h.controller.debug()), snapshot); await h.drain();
}));

for (const phase of ["exit", "sign", "verify", "promotion", "equipment", "depart", "register"]) await check(`reset-${phase}`, `Reset fences a late ${phase} completion and rejection`, () => withClock(async time => {
  for (const reject of [false, true]) {
    const h = harness(time, { [phase]: "pending" }); h.begin(); await flush();
    assert.equal(h.gates.length, 1, `${phase} reached`);
    h.controller.reset({ startsEmbodied: true }); h.modes[phase] = undefined; h.modes.debug = "pending";
    assert.equal(h.begin(), true); await flush();
    const before = h.trace.length, snapshot = JSON.stringify(h.controller.debug());
    if (reject) h.gates[0].reject(new Error(`late ${phase}`)); else h.gates[0].resolve(h.gates[0].value);
    await flush();
    assert.equal(h.trace.length, before, `revoked ${phase} must not publish, restore or touch presence`);
    assert.equal(JSON.stringify(h.controller.debug()), snapshot, `revoked ${phase} must preserve current record`);
    assert.equal(h.controller.inFlight(), true, `revoked ${phase} must not release newer guard`);
    await h.drain();
  }
}));

await check("registration-refused", "Destination registration determines the completion outcome", () => withClock(async time => {
  const h = harness(time, { registrationRefused: true }); h.begin(); await flush();
  assert.equal(h.controller.inFlight(), false);
  assert.equal(h.controller.crossingDebug().phase, "destination_registration_failed");
  assert.equal(h.controller.crossingDebug().presence_registration.accepted, false); await h.drain();
}));

async function until(condition, label) {
  for (let tries = 0; tries < 4000; tries++) {
    if (condition()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail(label);
}

function diagnosticCrypto() {
  const tasks = [], events = [];
  return { tasks, events,
    signManifest: (packet, world) => signManifestOntoPacket(packet, world, {}, "collection-adam"),
    verifyManifest: verifyManifestFromPacket,
    enrichManifest(packet, operation) {
      const gate = deferred();
      const task = { gate, packet, operation, done: null };
      tasks.push(task);
      operation.publish({ state: "pending", handoff_id: packet.handoff_id });
      task.done = gate.promise.then(() => publishCrossingDiagnostics(packet, {
        ...operation, transport: { emitSyntheticApiRequest: event => events.push(event) },
      }));
      return task.done;
    },
  };
}

await check("optional-signing-independent", "Real signed arrival completes while optional diagnostics wait; sent bytes stay fixed", () => withClock(async time => {
  const crypto = diagnosticCrypto(), h = harness(time, { crypto });
  h.begin(); await until(() => crypto.tasks.length === 1 && !h.controller.inFlight(), "crossing waits for optional diagnostics");
  assert.equal(h.host.activeEndpointKey, "b");
  const arrival = arrivalPosts(h)[0]; assert.ok(arrival);
  assert.equal(h.controller.debug().um_signing.verified_on_arrival.verified, true);
  assert.equal(h.controller.debug().um_signing.optional_diagnostics.state, "pending");
  crypto.tasks[0].gate.resolve(); await crypto.tasks[0].done; await flush();
  assert.equal(JSON.stringify(arrival.body), arrival.bytes, "late optional diagnostics changed a sent packet");
  const diagnostic = h.controller.debug().um_signing.optional_diagnostics;
  assert.equal(diagnostic.state, "complete"); assert.equal(Object.keys(diagnostic.surfaces).length, 13);
  assert.equal(crypto.events.length, 10); await h.drain();
}));

for (const action of ["reset", "new-crossing", "cancel"]) await check(`optional-${action}`, `A ${action} revokes the old optional diagnostic publisher`, () => withClock(async time => {
  const crypto = diagnosticCrypto(), h = harness(time, { crypto }); h.begin();
  await until(() => crypto.tasks.length === 1 && !h.controller.inFlight(), "first crossing completes");
  if (action === "reset") h.controller.reset({ startsEmbodied: true });
  if (action === "cancel") h.controller.cancel();
  if (action === "new-crossing") { assert.equal(h.begin(), true); await until(() => crypto.tasks.length === 2 && !h.controller.inFlight(), "new crossing completes"); }
  const before = JSON.stringify(h.controller.debug()), count = h.trace.length;
  crypto.tasks[0].gate.resolve(); await crypto.tasks[0].done; await flush();
  assert.equal(JSON.stringify(h.controller.debug()), before, "old diagnostics changed the current record");
  assert.equal(h.trace.length, count, "old diagnostics published state"); assert.equal(crypto.events.length, 0);
  for (const task of crypto.tasks.slice(1)) { task.gate.resolve(); await task.done; }
  await h.drain();
}));

await check("optional-rejected", "A rejected optional task reports failure without blocking or an unhandled rejection", () => withClock(async time => {
  const crypto = diagnosticCrypto(), h = harness(time, { crypto }); h.begin();
  await until(() => crypto.tasks.length === 1 && !h.controller.inFlight(), "required crossing completes");
  crypto.tasks[0].gate.reject(new Error("planted optional rejection")); await crypto.tasks[0].done.catch(() => {}); await flush();
  assert.equal(h.controller.debug().um_signing.optional_diagnostics.state, "failed");
  assert.equal(h.controller.debug().um_signing.optional_diagnostics.error, "planted optional rejection");
  assert.equal(h.host.activeEndpointKey, "b"); await h.drain();
}));

const file = "web/live-adapter-portal-traversal-controller.mjs";
await finish({ checkFile: "src/portal-traversal-lifecycle-check.mjs", faults: [
  { statement: "optional-reset", name: "optional publisher ignores operation lifetime", expect: /old diagnostics changed the current record|old diagnostics published state/, edits: [{ file, find: "const isCurrent = () => isCurrentOperation(operation) && packet.handoff_id === handoffId &&", replace: "const isCurrent = () => true && packet.handoff_id === handoffId &&" }] },
  { statement: "arrival-deadline", name: "optional deadline omitted", expect: /optional request must not hold crossing after deadline/, edits: [{ file, find: 'withinLimit(Promise.race([work, cancelled]), "the optional arrival observation")', replace: 'Promise.race([work, cancelled])' }] },
  { statement: "debug-deadline", name: "debug observation gates presence", expect: /optional observation must not gate destination presence/, edits: [{ file, find: 'const equipmentStatus = await assets.resolveEquipmentItems(equippedItems);', replace: 'await arrivalPromise; const equipmentStatus = await assets.resolveEquipmentItems(equippedItems);' }] },
  { statement: "reset-verify", name: "operation identity check omitted", expect: /revoked verify must not publish/, edits: [{ file, find: 'return operation === activeOperation && operation.generation === operationGeneration;', replace: 'return true;' }] },
] });
