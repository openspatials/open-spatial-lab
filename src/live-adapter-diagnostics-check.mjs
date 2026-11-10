import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createLiveAdapterTransport } from "../web/live-adapter-transport.mjs";
import { clonePosition, cloneScale, yawQuaternion } from "../web/live-adapter-portal-geometry.mjs";
import { geoPoseShapedFromTransform } from "../web/geopose-basic-sdu.mjs";
import { UM_CONFORMANCE } from "../web/conformance/um-conformance.mjs";
import { IWPS_CONFORMANCE } from "../web/iwps-query-teleport.mjs";
import { nodeChecks } from "../tools/behavior/node-checks.mjs";
import { createPortalTraversalHandoffController } from "../web/live-adapter-portal-traversal-controller.mjs";
import { signManifestOntoPacket, verifyManifestFromPacket } from "../web/live-adapter-crossing-manifest.mjs";
import { publishCrossingDiagnostics } from "../web/live-adapter-crossing-diagnostics.mjs";
const { check, finish } = nodeChecks("live-adapter-diagnostics");
const root = new URL("../", import.meta.url), source = readFileSync(new URL("web/live-adapter.js", root), "utf8");
const methods = ["debugState", "apiPanelInfo", "apiFetchEndpoint", "presenterExitIntent", "presenterDeliverArrival"];
const section = (start, end) => { const at = source.indexOf(start); assert.ok(at >= 0, start); return source.slice(at, source.indexOf(end, at) + end.length); };
const bodies = methods.map(name => { const prefix = source.includes(`  async ${name}(`) ? "async " : ""; return section(`  ${prefix}${name}(`, "\n  }"); }).join(",\n");
const globals = ["oppositeEndpointKey", "endpointKeyForLocation", "strictProofBoundary", "transformSnapshot"].map(name => section(`function ${name}(`, "\n}")).join("\n");
const identity = section("const SPEC_IDENTITY =", "\n});");
const ENDPOINTS = Object.fromEntries(["a", "b", "lobby", "airport"].map(key => [key, { endpoint_key: key, proxy_base: `/api/${key}`, location_id: `location-${key}`, portal_id: `${key}-portal` }]));
const leaves = {};
for (const name of ["debug", "operator"]) {
  const url = new URL(`web/live-adapter-${name}.mjs`, root);
  if (existsSync(url)) Object.assign(leaves, await import(url));
}
const deps = { ...leaves, ENDPOINTS, PROVENANCE: { LIVE: "live" }, clonePosition, cloneScale, yawQuaternion, geoPoseShapedFromTransform, UM_CONFORMANCE, IWPS_CONFORMANCE };
// Execute the exact five facade methods and their existing pure helpers without booting a host or browser.
const actual = Function(...Object.keys(deps), `${identity}\n${globals}\nreturn {${bodies}};`)(...Object.values(deps));
const captured = {};
const capture = process.argv.includes("--capture");
const fixtureUrl = new URL("fixtures/live-adapter-diagnostics.json", import.meta.url);
const expected = capture ? null : JSON.parse(readFileSync(fixtureUrl));
const json = value => JSON.parse(JSON.stringify(value));
function observe(name, value) { captured[name] = json(value); if (!capture) assert.deepEqual(captured[name], expected[name], `captured ${name}`); }

function fixture() {
  const calls = [], requests = [], events = [], replies = [];
  const transport = createLiveAdapterTransport({ apiEvents: { dispatchEvent: event => events.push(event.detail) },
    createCustomEvent: (type, init) => ({ type, ...init }), nowMs: () => 10, nowIso: () => "fixture-time",
    fetchImpl: async (url, options) => {
      requests.push([url, options]);
      const reply = replies.shift(); assert.ok(reply, `unexpected request ${url}`);
      if (reply.error) throw new Error(reply.error);
      if (reply.wait) await reply.wait;
      return { ok: reply.status < 400, status: reply.status, headers: { get: () => reply.validation || null },
        json: async () => { if (reply.jsonError) throw new Error(reply.jsonError); return reply.value; } };
    } });
  const state = { phase: "idle", handoff_id: null, arrival_count: 0, avatar: { position: [1, 2, 3], rotation_y: 0, scale: [1, 1, 1] }, controls: { enabled: false },
    portal_previews: { p: { loaded: false } }, last_handoff_direction: "a-to-b", last_handoff_payload: { avatar_context: { geopose_shaped_pose: { fallback: true } } }, last_pose_payload: { sequence: 0 }, equipment_status: { count: 0 } };
  const host = { ...actual, role: "player", mode: "live", clientMode: "player", state,
    world: { location_id: "location-a", world_id: "world-a", session_id: "session", claim_boundary: { application_level_handoff: true }, portal: { target_location_id: "location-airport" } },
    endpoint: ENDPOINTS.a, activeEndpointKey: "a", base: "/api/a", _portalId: "alias/portal", _transport: transport,
    _wowSceneSource: { graph_url: "fixture", node_count: 0 }, _umIdentity: { verified: false, value: "identity" }, _viewMatch: { matches: false },
    _rootFabricManifest: { services: [{ name: "World", type: "world", endpoint: "./wow/world", default_id: 0 }] },
    _wowEndpointResolution: { resolved_from_services: true, base: "/api/a", resolution_rule: "advertised", provenance: Object.fromEntries(["world", "user", "portal", "view"].map(key => [key, { resolved_path: `/wow/${key}/1` }])) },
  };
  const reader = (name, value = { name }) => () => { calls.push(name); return value; };
  for (const name of ["_activeDebug", "_previewDebug", "controlledIdentity", "_playerContextMarkerDebug", "_navigatorDebug", "_rp1FailClosedDebug", "_fabricPrefetchDebug", "_presenceDebug", "_presencePushDebug", "_visibilityDebug", "_peerPlayersDebug", "_playerPoseBroadcastDebug", "boundaryStatus"]) host[name] = reader(name);
  host._coPresentPeerCount = reader("_coPresentPeerCount", 0);
  host._portalTraversalController = { debug: reader("traversal", { crossing: { accepted: false }, um_signing: { signed_on_exit: false, verified_on_arrival: null }, portal_transition: { phase: "idle" }, player_handoff_profile: false }) };
  host._clientSceneController = { debug: reader("client-scene", { active: false }) };
  host._peers = { livePoseDebug: reader("live-pose", { sequence: 0 }) };
  return { host, state, calls, requests, events, replies };
}

await check("debug-projection", "Current host projections preserve exact keys, aliases, nulls and reader order without fetch", () => {
  const h = fixture(), untouched = JSON.stringify(h.state), first = h.host.debugState();
  observe("debug-full", { output: first, calls: h.calls });
  assert.equal(first.avatar, h.state.avatar); assert.equal(first.controls, h.state.controls);
  assert.equal(Object.hasOwn(first.um_signing, "optional_diagnostics"), false, "absent optional diagnostics preserves the exact old key set");
  assert.equal(JSON.stringify(h.state), untouched); assert.equal(h.requests.length, 0, "debug must not fetch");
  assert.equal(first.proof_boundary.standards_conformance, false, "debug cannot upgrade conformance");
  assert.equal(first.co_present_peer_count, 0, "zero count retained");
  h.host.state = { ...h.state, avatar: null, portal_previews: null };
  h.host.world = { ...h.host.world, location_id: "location-b" };
  h.host._umIdentity = null; h.host._wowEndpointResolution = null; h.host._viewMatch = null; h.host._wowSceneSource = null; h.calls.length = 0;
  observe("debug-null-replaced", { output: h.host.debugState(), calls: h.calls });
  assert.equal(h.host.debugState().location_id, "location-b", "replacement read is current");
  assert.equal(h.requests.length, 0);
});

await check("panel-projection", "API panel preserves service provenance and current focus routing without requests", () => {
  const h = fixture(); observe("panel-full", h.host.apiPanelInfo());
  assert.equal(h.host.apiPanelInfo().services[0].default_id, 0, "service zero ID retained");
  h.host.activeEndpointKey = "lobby"; h.host.endpoint = ENDPOINTS.lobby;
  observe("panel-focus", h.host.apiPanelInfo());
  assert.equal(h.host.apiPanelInfo().target.endpoint_key, "airport", "focus fallback uses existing location resolver");
  h.host._rootFabricManifest = null; h.host._wowEndpointResolution = null; h.host._viewMatch = null;
  observe("panel-empty", h.host.apiPanelInfo()); assert.equal(h.requests.length, 0);
});

await check("resource-inspection", "Explicit resource actions retain encoded IDs, schemas, fallback bodies and one telemetry sequence", async () => {
  const h = fixture(), results = [];
  for (const [kind, id] of [["world", null], ["user", 0], ["user", ""], ["view", "a/b"], ["portal", null], ["fabric", null]]) {
    h.replies.push({ status: 200, value: { resource: kind }, validation: "pass:World" }); results.push(await h.host.apiFetchEndpoint(kind, id));
  }
  results.push(await h.host.apiFetchEndpoint("missing", 1));
  h.replies.push({ status: 404 }, { status: 404, value: { error: "absent" } });
  results.push(await h.host.apiFetchEndpoint("user", "bad"));
  h.replies.push({ error: "offline" }, { error: "still offline" });
  results.push(await h.host.apiFetchEndpoint("view", 9));
  h.replies.push({ status: 404 }, { status: 404, jsonError: "invalid JSON" });
  results.push(await h.host.apiFetchEndpoint("portal", "?"));
  assert.deepEqual(h.events.map(e => e.id), [1, 2, 3, 4, 5, 6, 7, 8, 9], "raw recovery must not allocate another API ID");
  assert.equal(results[1].url, "/api/a/wow/user/0", "explicit zero resource ID retained");
  assert.equal(results[4].url, "/api/a/wow/portal/alias%2Fportal", "default portal alias encoded");
  assert.equal(results[7].json.error, "absent", "failure recovery retains live response body");
  observe("resource-inspection", { results, requests: h.requests, events: h.events });
});

await check("presenter-actions", "Exit and delivery use existing transport and retain wrong-node and error semantics", async () => {
  const h = fixture(), state = JSON.stringify(h.host.state);
  let resolve; const wait = new Promise(done => { resolve = done; });
  h.replies.push({ status: 201, value: { handoff_id: "h" }, wait });
  const pending = h.host.presenterExitIntent(); h.host.activeEndpointKey = "b"; resolve();
  const exited = await pending;
  assert.equal(exited.endpoint_key, "b", "exit response retains current endpoint key after await");
  h.host.activeEndpointKey = "lobby";
  const packet = { target: { location_id: "location-airport" }, handoff_id: "h", edited: true };
  const results = [exited];
  h.replies.push({ status: 200, value: { session: { arrival_count: 2 } } }, { status: 201, value: { accepted: true } }, { status: 200, value: { session: { arrival_count: 3 } } });
  results.push(await h.host.presenterDeliverArrival(packet));
  assert.equal(results[1].arrival_count_delta, 1, "real before/after delta retained");
  h.replies.push({ status: 200, value: { session: { arrival_count: 0 } } }, { status: 400, value: { error: "wrong node" } });
  results.push(await h.host.presenterDeliverArrival(packet, { toWrongNode: true }));
  assert.equal(results[2].delivered_to_endpoint, "lobby", "wrong-node action must use source fallback");
  assert.equal(results[2].status, 400); assert.equal(results[2].response.error, "wrong node");
  h.replies.push({ error: "before unavailable" }, { status: 201, value: {} }, { error: "after unavailable" });
  results.push(await h.host.presenterDeliverArrival(null));
  assert.equal(results[3].arrival_count_delta, null, "missing observations remain unknown");
  h.replies.push({ status: 200, value: {} }, { error: "post unavailable" });
  results.push(await h.host.presenterDeliverArrival(packet));
  h.replies.push({ error: "exit unavailable" }); await assert.rejects(h.host.presenterExitIntent(), /exit unavailable/);
  assert.equal(JSON.stringify(h.host.state), state, "operator actions cannot mutate traversal state");
  observe("presenter-actions", { results, requests: h.requests, events: h.events });
});
// Reuse the existing lifecycle check's exact fixture functions, without executing its check suite.
// The controller, signing and diagnostics are real modules; only transport and the clock are fixtures.
await check("combined-optional-diagnostics", "Actual traversal diagnostics remain visible through the facade across completion and retirement", async () => {
  const lifecycle = readFileSync(new URL("src/portal-traversal-lifecycle-check.mjs", root), "utf8");
  const names = ["deferred", "withClock", "harness", "until", "diagnosticCrypto"];
  const functions = names.map(name => {
    const start = lifecycle.search(new RegExp(`^(?:async )?function ${name}\\(`, "m"));
    assert.ok(start >= 0, `existing lifecycle fixture ${name}`);
    return lifecycle.slice(start, lifecycle.indexOf("\n}", start) + 2);
  }).join("\n");
  const flush = lifecycle.match(/^const flush = .*;$/m)?.[0];
  assert.ok(flush, "existing lifecycle flush fixture");
  const dependencies = { assert, createPortalTraversalHandoffController, signManifestOntoPacket, verifyManifestFromPacket, publishCrossingDiagnostics };
  const control = Function(...Object.keys(dependencies), `${flush}\n${functions}\nreturn {withClock,harness,until,diagnosticCrypto,flush};`)(...Object.values(dependencies));
  await control.withClock(async time => {
    for (const outcome of ["complete", "failed", "reset", "new-crossing", "cancel"]) {
      const crypto = control.diagnosticCrypto(), traversal = control.harness(time, { crypto });
      const host = fixture().host;
      host._portalTraversalController = traversal.controller;
      const projected = () => {
        const current = traversal.controller.debug().um_signing.optional_diagnostics;
        const before = JSON.stringify(current), visible = host.debugState().um_signing;
        assert.ok(Object.hasOwn(visible, "optional_diagnostics"), "optional diagnostic field must reach facade");
        assert.equal(visible.optional_diagnostics, current, "current diagnostic identity must reach facade");
        assert.equal(JSON.stringify(current), before, "projection must not mutate diagnostic record");
        return visible.optional_diagnostics;
      };
      try {
        assert.equal(projected(), null, "explicit empty diagnostic field retained");
        traversal.begin();
        await control.until(() => crypto.tasks.length === 1 && !traversal.controller.inFlight(), "first real crossing completes");
        assert.equal(projected().state, "pending");
        assert.equal(projected().handoff_id, "h1");
        const first = crypto.tasks[0], arrival = traversal.posts.find(post => post.url.endsWith("/arrival"));
        if (outcome === "failed") {
          first.gate.reject(new Error("diagnostic projection rejection"));
          await first.done.catch(() => {}); await control.flush();
          assert.equal(projected().state, "failed");
          assert.equal(projected().error, "diagnostic projection rejection");
        } else if (outcome === "complete") {
          first.gate.resolve(); await first.done; await control.flush();
          const complete = projected();
          assert.equal(complete.state, "complete");
          assert.equal(Object.keys(complete.surfaces).length, 13);
          assert.equal(complete.handoff_id, first.packet.handoff_id);
          assert.equal(complete.manifest_id, first.packet.avatar_context.um_manifest_v04["@id"]);
          assert.equal(complete.signature_value, first.packet.avatar_context.um_manifest_v04.signature.value);
        } else {
          if (outcome === "reset") traversal.controller.reset({ startsEmbodied: true });
          if (outcome === "cancel") traversal.controller.cancel();
          if (outcome === "new-crossing") {
            assert.equal(traversal.begin(), true);
            await control.until(() => crypto.tasks.length === 2 && !traversal.controller.inFlight(), "second real crossing completes");
            assert.equal(projected().handoff_id, "h2", "new handoff identity is visible");
          }
          const current = projected(), before = JSON.stringify(current), emissions = traversal.trace.length;
          first.gate.resolve(); await first.done; await control.flush();
          assert.equal(projected(), current, "retired task cannot replace visible current diagnostic identity");
          assert.equal(JSON.stringify(projected()), before, "retired task cannot change visible diagnostic values");
          assert.equal(traversal.trace.length, emissions, "retired task cannot emit a visible update");
          if (outcome === "reset") assert.equal(projected(), null);
          if (outcome === "new-crossing") {
            crypto.tasks[1].gate.resolve(); await crypto.tasks[1].done; await control.flush();
            assert.equal(projected().state, "complete");
            assert.equal(projected().handoff_id, "h2", "current completion retains the new identity");
          }
        }
        assert.equal(JSON.stringify(arrival.body), arrival.bytes, "projection cannot mutate the sent diagnostic packet");
      } finally {
        for (const task of crypto.tasks) task.gate.resolve();
        await Promise.allSettled(crypto.tasks.map(task => task.done));
        await traversal.drain();
      }
    }
  });
});
if (capture) writeFileSync(fixtureUrl, JSON.stringify(captured, null, 2) + "\n");
const fault = (statement, name, file, find, replace, expect) => ({ statement, name, expect, edits: [{ file, find, replace }] });
await finish({ checkFile: "src/live-adapter-diagnostics-check.mjs", faults: capture ? [] : [
  fault("combined-optional-diagnostics", "optional signing diagnostics lost", "web/live-adapter-debug.mjs", '...(Object.hasOwn(signing, "optional_diagnostics") ? { optional_diagnostics: signing.optional_diagnostics } : {}),', '...{},', /optional diagnostic field must reach facade/),
  fault("debug-projection", "debug performs extra fetch", "web/live-adapter.js", "const traversal = this._portalTraversalController.debug();", "const traversal = this._portalTraversalController.debug(); void this._transport.rawFetch('/forbidden').catch(() => {});", /debug must not fetch/),
  fault("debug-projection", "live avatar projection omitted", "web/live-adapter-debug.mjs", "avatar: state.avatar,", "avatar: null,", /captured debug-full/),
  fault("panel-projection", "zero service ID lost", "web/live-adapter-debug.mjs", "default_id: svc.default_id ?? null", "default_id: svc.default_id || null", /captured panel-full/),
  fault("resource-inspection", "resource zero ID lost", "web/live-adapter-operator.mjs", 'id != null && id !== "" ? id : 1', 'id || 1', /explicit zero resource ID retained/),
  fault("resource-inspection", "raw recovery incorrectly logged", "web/live-adapter-operator.mjs", "transport.rawFetch(url,", "transport.getJson(url,", /raw recovery must not allocate another API ID/),
  { statement: "presenter-actions", name: "early endpoint value used", expect: /exit response retains current endpoint key after await/, edits: [
    { file: "web/live-adapter-operator.mjs", find: "const packet = await transport.postJson(url, { portal_id: portalId });", replace: "const originalKey = readEndpointKey(); const packet = await transport.postJson(url, { portal_id: portalId });" },
    { file: "web/live-adapter-operator.mjs", find: "endpoint_key: readEndpointKey(),", replace: "endpoint_key: originalKey," },
  ] },
  fault("presenter-actions", "wrong-node action ignored", "web/live-adapter.js", "opts.toWrongNode ? wrongKey : realTargetKey", "realTargetKey", /wrong-node action must use source fallback/),
  fault("presenter-actions", "missing arrival observations invented", "web/live-adapter-operator.mjs", "before != null && after != null ? after - before : null", "before != null && after != null ? after - before : 0", /missing observations remain unknown/),
] });
