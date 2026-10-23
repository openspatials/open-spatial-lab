#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TRANSPORT_PATH = join(ROOT, "web/live-adapter-transport.mjs");
const ADAPTER_PATH = join(ROOT, "web/live-adapter.js");
const MUTATION = process.env.feature_TRANSPORT_MUTATION || "";
let transportSource = readFileSync(TRANSPORT_PATH, "utf8");
let adapterSource = readFileSync(ADAPTER_PATH, "utf8");

function replaceOnce(source, before, after) {
  assert.equal(source.includes(before), true, `mutation anchor missing: ${before}`);
  return source.replace(before, after);
}

if (MUTATION === "get-accept-header") {
  transportSource = replaceOnce(
    transportSource,
    'fetchImpl(url, { headers: { Accept: "application/json" } })',
    "fetchImpl(url, { headers: {} })",
  );
}
if (MUTATION === "get-error-body-read") {
  transportSource = replaceOnce(
    transportSource,
    "      if (!response.ok) throw new Error(`GET ${url} -> ${response.status}`);",
    "      if (!response.ok) { await response.json(); throw new Error(`GET ${url} -> ${response.status}`); }",
  );
}
if (MUTATION === "get-error-event") {
  transportSource = replaceOnce(
    transportSource,
    "    } catch (error) {\n      emitApiRequest({\n        id: sequence, method: \"GET\"",
    "    } catch (error) {\n      if (false) emitApiRequest({\n        id: sequence, method: \"GET\"",
  );
}
if (MUTATION === "get-parse-order") {
  transportSource = replaceOnce(
    transportSource,
    "      const data = await response.json();",
    "      const data = response.json();",
  );
}
if (MUTATION === "post-wire-body") {
  transportSource = replaceOnce(
    transportSource,
    "      body: JSON.stringify(body || {}),",
    "      body: JSON.stringify(body),",
  );
}
if (MUTATION === "post-error-body") {
  transportSource = replaceOnce(transportSource, "      error.body = data;", "      void data;");
}
if (MUTATION === "post-network-event") {
  transportSource = replaceOnce(
    transportSource,
    `    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body || {}),
    });`,
    `    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body || {}),
    }).catch((error) => {
      emitApiRequest({ id: sequence, method: "POST", url, status: 0, ok: false, error: error.message });
      throw error;
    });`,
  );
}
if (MUTATION === "post-event-order") {
  transportSource = replaceOnce(
    transportSource,
    "    emitApiRequest({\n      id: sequence, method: \"POST\"",
    "    if (response.ok) emitApiRequest({\n      id: sequence, method: \"POST\"",
  );
}
if (MUTATION === "validation-wow-guard") {
  transportSource = replaceOnce(
    transportSource,
    '    if (!/\\/wow\\//.test(String(url || ""))) return null;',
    "    if (false) return null;",
  );
}
if (MUTATION === "validation-unavailable") {
  transportSource = replaceOnce(
    transportSource,
    '    if (status !== "unavailable") contractValidation.observed += 1;',
    "    contractValidation.observed += 1;",
  );
}
if (MUTATION === "label-order") {
  transportSource = replaceOnce(
    transportSource,
    '  if (/\\/wow\\/portal\\//.test(value)) return "Portal";',
    '  if (/\\/wow\\/portal\\/(?:exit|arrival)/.test(value)) return "exit-intent (extension)";\n  if (/\\/wow\\/portal\\//.test(value)) return "Portal";',
  );
}
if (MUTATION === "display-path") {
  transportSource = replaceOnce(transportSource, "  return match ? match[1] : value;", "  return value;");
}
if (MUTATION === "sequence-on-completion") {
  transportSource = replaceOnce(
    transportSource,
    "    const sequence = ++requestSequence;\n    let status = 0;\n    let validation = null;",
    "    let sequence = 0;\n    let status = 0;\n    let validation = null;",
  );
  transportSource = replaceOnce(
    transportSource,
    '      const response = await fetchImpl(url, { headers: { Accept: "application/json" } });\n      status = response.status;',
    '      const response = await fetchImpl(url, { headers: { Accept: "application/json" } });\n      sequence = ++requestSequence;\n      status = response.status;',
  );
}
if (MUTATION === "synthetic-second-sequence") {
  transportSource = replaceOnce(
    transportSource,
    "  let requestSequence = 0;",
    "  let requestSequence = 0;\n  let syntheticRequestSequence = 0;",
  );
  transportSource = replaceOnce(
    transportSource,
    "    const detail = { id: ++requestSequence, at: nowIso(), ...record };",
    "    const detail = { id: ++syntheticRequestSequence, at: nowIso(), ...record };",
  );
  adapterSource = replaceOnce(
    adapterSource,
    'export { API_EVENTS } from "./live-adapter-transport.mjs";',
    "export const API_EVENTS = new EventTarget();",
  );
}
if (MUTATION === "unguarded-http-event") {
  transportSource = replaceOnce(
    transportSource,
    "    } catch (error) {\n      /* telemetry must never break a request */\n    }",
    "    } catch (error) {\n      throw error;\n    }",
  );
  adapterSource = replaceOnce(
    adapterSource,
    'export { API_EVENTS } from "./live-adapter-transport.mjs";',
    'export { API_EVENTS } from "./missing-transport.mjs";',
  );
}
if (MUTATION === "instrument-raw-fetch") {
  transportSource = replaceOnce(
    transportSource,
    "  function rawFetch(url, options) {\n    return fetchImpl(url, options);\n  }",
    '  function rawFetch(url, options) {\n    emitSyntheticApiRequest({ method: "RAW", url, path: displayPath(url) });\n    return fetchImpl(url, options);\n  }',
  );
  adapterSource = replaceOnce(
    adapterSource,
    "this._transport.rawFetch(`${this.demoProxyBase(endpointKey)}/demo/um/attach-point`",
    "this._transport.getJson(`${this.demoProxyBase(endpointKey)}/demo/um/attach-point`",
  );
}

const moduleUrl = MUTATION
  ? `data:text/javascript;base64,${Buffer.from(transportSource).toString("base64")}#${MUTATION}`
  : new URL("../web/live-adapter-transport.mjs", import.meta.url).href;
const production = await import(moduleUrl);

class FakeBus {
  constructor({ throws = false } = {}) {
    this.events = [];
    this.throws = throws;
  }
  dispatchEvent(event) {
    this.events.push(event);
    if (this.throws) throw new Error("listener failed");
    return true;
  }
}

function fakeEvent(type, init) {
  return { type, detail: init.detail };
}

function response({ status = 200, validation = null, value = {}, error = null, onJson = null } = {}) {
  let jsonCalls = 0;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => name === "X-OSL-WoW-Validation" ? validation : null },
    async json() {
      jsonCalls += 1;
      if (onJson) await onJson();
      if (error) throw error;
      return value;
    },
    get jsonCalls() { return jsonCalls; },
  };
}

function harness({ fetchImpl, bus = new FakeBus(), nowValues = [10, 14, 18, 22] } = {}) {
  const calls = [];
  const queue = [...nowValues];
  let iso = 0;
  const transport = production.createLiveAdapterTransport({
    fetchImpl: fetchImpl || (async (...args) => {
      calls.push(args);
      return response();
    }),
    apiEvents: bus,
    createCustomEvent: fakeEvent,
    nowMs: () => queue.length ? queue.shift() : nowValues.at(-1),
    nowIso: () => `2026-07-14T21:11:${String(++iso).padStart(2, "0")}.000Z`,
  });
  return { bus, calls, transport };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

let checks = 0;
const failures = [];
async function check(name, assertion) {
  try {
    await assertion();
    checks += 1;
    if (!MUTATION) console.log(`PASS ${String(checks).padStart(2, "0")} ${name}`);
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
    if (!MUTATION) throw error;
  }
}

await check("GET success preserves wire, parse-before-event, validation, labels, and payload", async () => {
  const gate = deferred();
  const res = response({ validation: "pass:World", value: { world_id: "w1" }, onJson: () => gate.promise });
  const calls = [];
  const { bus, transport } = harness({
    fetchImpl: async (...args) => { calls.push(args); return res; },
    nowValues: [10, 14],
  });
  const pending = transport.getJson("https://demo.test/wow/world?x=1");
  await Promise.resolve();
  assert.equal(bus.events.length, 0, "success telemetry must wait for JSON parsing");
  gate.resolve();
  assert.deepEqual(await pending, { world_id: "w1" });
  assert.deepEqual(calls, [["https://demo.test/wow/world?x=1", { headers: { Accept: "application/json" } }]]);
  assert.deepEqual(bus.events[0].detail, {
    id: 1,
    method: "GET",
    url: "https://demo.test/wow/world?x=1",
    path: "/wow/world?x=1",
    status: 200,
    ok: true,
    ms: 4,
    schema: "World",
    validation: {
      source: "X-OSL-WoW-Validation",
      status: "pass",
      schema: "World",
      raw: "pass:World",
      at: "2026-07-14T21:11:01.000Z",
    },
    at: "2026-07-14T21:11:02.000Z",
  });
});

await check("GET HTTP failure emits once, does not parse body, and rethrows the exact sparse error", async () => {
  const res = response({ status: 404, validation: "fail:World", value: { error: "hidden" } });
  const { bus, transport } = harness({ fetchImpl: async () => res });
  let caught;
  try { await transport.getJson("/wow/world"); } catch (error) { caught = error; }
  assert.equal(caught?.message, "GET /wow/world -> 404");
  assert.equal(Object.hasOwn(caught, "body"), false);
  assert.equal(Object.hasOwn(caught, "status"), false);
  assert.equal(res.jsonCalls, 0);
  assert.equal(bus.events.length, 1);
  assert.equal(bus.events[0].detail.id, 1);
  assert.equal(bus.events[0].detail.ok, false);
  assert.equal(bus.events[0].detail.error, "GET /wow/world -> 404");
});

await check("GET parse failure accounts the header, emits failure, and rethrows the same parser error", async () => {
  const parseError = new Error("invalid json");
  const { bus, transport } = harness({
    fetchImpl: async () => response({ validation: "pass:World", error: parseError }),
  });
  let caught;
  try { await transport.getJson("/wow/world"); } catch (error) { caught = error; }
  assert.equal(caught, parseError);
  assert.equal(bus.events[0].detail.status, 200);
  assert.equal(bus.events[0].detail.error, "invalid json");
  assert.equal(transport.wowContractValidationSnapshot().passed, 1);
});

await check("GET network failure emits status zero and rethrows the same rejection", async () => {
  const networkError = new Error("offline");
  const { bus, transport } = harness({ fetchImpl: async () => { throw networkError; } });
  let caught;
  try { await transport.getJson("/wow/world"); } catch (error) { caught = error; }
  assert.equal(caught, networkError);
  assert.equal(bus.events.length, 1);
  assert.equal(bus.events[0].detail.status, 0);
  assert.equal(bus.events[0].detail.validation, null);
  assert.equal(bus.events[0].detail.error, "offline");
});

await check("POST success preserves method, headers, falsy-body normalization, event shape, and return", async () => {
  const calls = [];
  const { bus, transport } = harness({
    fetchImpl: async (...args) => { calls.push(args); return response({ status: 201, value: { ok: 1 } }); },
  });
  assert.deepEqual(await transport.postJson("/portal/arrival", null), { ok: 1 });
  assert.deepEqual(calls[0], ["/portal/arrival", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: "{}",
  }]);
  assert.equal(bus.events[0].detail.id, 1);
  assert.equal(bus.events[0].detail.method, "POST");
  assert.equal(bus.events[0].detail.schema, "arrival (extension)");
  assert.equal(Object.hasOwn(bus.events[0].detail, "error"), false);
});

await check("POST HTTP failure parses and emits before attaching body and rejecting", async () => {
  const order = [];
  const bus = new FakeBus();
  bus.dispatchEvent = (event) => { order.push("event"); bus.events.push(event); return true; };
  const { transport } = harness({ bus, fetchImpl: async () => response({ status: 409, value: { error: "drift" } }) });
  let caught;
  try { await transport.postJson("/portal/arrival", { handoff_id: "h1" }); } catch (error) { order.push("caught"); caught = error; }
  assert.deepEqual(order, ["event", "caught"]);
  assert.equal(caught?.message, "POST /portal/arrival -> 409");
  assert.deepEqual(caught?.body, { error: "drift" });
  assert.equal(Object.hasOwn(bus.events[0].detail, "error"), false);
  assert.equal(bus.events[0].detail.ok, false);
});

await check("POST invalid JSON becomes an empty object on both success and HTTP failure", async () => {
  const success = harness({ fetchImpl: async () => response({ error: new Error("bad json") }) }).transport;
  assert.deepEqual(await success.postJson("/movement", {}), {});
  const failed = harness({ fetchImpl: async () => response({ status: 400, error: new Error("bad json") }) }).transport;
  let caught;
  try { await failed.postJson("/portal/arrival", {}); } catch (error) { caught = error; }
  assert.deepEqual(caught?.body, {});
});

await check("POST network rejection emits nothing while consuming its request id", async () => {
  let attempt = 0;
  const networkError = new Error("reset");
  const { bus, transport } = harness({
    fetchImpl: async () => {
      attempt += 1;
      if (attempt === 1) throw networkError;
      return response({ value: { ok: true } });
    },
  });
  let caught;
  try { await transport.postJson("/movement", {}); } catch (error) { caught = error; }
  assert.equal(caught, networkError);
  assert.equal(bus.events.length, 0);
  await transport.postJson("/movement", {});
  assert.equal(bus.events[0].detail.id, 2);
});

await check("validation accounting preserves guard, precedence, unique schema order, and copied snapshots", async () => {
  const queued = [
    response({ validation: "pass:World" }),
    response({ validation: "fail:User" }),
    response({ validation: "error" }),
    response({ validation: null }),
    response({ validation: "pass:Ignored" }),
    response({ validation: "pass:World" }),
  ];
  const { transport } = harness({ fetchImpl: async () => queued.shift() });
  await transport.getJson("/wow/world");
  await transport.getJson("/wow/user/1");
  await transport.getJson("/wow/view/1");
  await transport.getJson("/wow/portal/1");
  await transport.getJson("/not-wow/resource");
  await transport.getJson("/wow/world");
  const first = transport.wowContractValidationSnapshot();
  assert.deepEqual({ status: first.status, observed: first.observed, passed: first.passed, failed: first.failed, errors: first.errors }, {
    status: "failed", observed: 4, passed: 2, failed: 1, errors: 1,
  });
  assert.deepEqual(first.schemas, ["World", "User"]);
  assert.equal(first.last.raw, "pass:World");
  assert.equal(first.standards_conformance, false);
  first.schemas.push("mutated");
  first.last.status = "mutated";
  const second = transport.wowContractValidationSnapshot();
  assert.deepEqual(second.schemas, ["World", "User"]);
  assert.equal(second.last.status, "pass");
});

await check("schema and display-path matrices preserve ordered compatibility labels", () => {
  const { transport } = harness();
  const labels = [
    ["/wow/world?x=1", "GET", "World"],
    ["/wow/user/1", "GET", "User"],
    ["/wow/view/1", "GET", "View"],
    ["/wow/portal/exit", "POST", "Portal"],
    ["/wow/portal/arrival", "POST", "Portal"],
    ["/fabric.json?x=1", "GET", "fabric manifest"],
    ["/portal/exit-intent", "POST", "exit-intent (extension)"],
    ["/portal/arrival", "POST", "arrival (extension)"],
    ["/movement?x=1", "POST", "movement (non-spec)"],
    ["/debug/state", "GET", "debug/state (non-spec)"],
    ["/reset", "POST", "reset (non-spec)"],
    ["/other", "POST", "POST"],
    ["/other", "GET", "resource"],
  ];
  for (const [url, method, expected] of labels) assert.equal(transport.schemaLabelForUrl(url, method), expected);
  assert.equal(transport.displayPath("https://example.test/api/a/wow/world?x=1"), "/api/a/wow/world?x=1");
  assert.equal(transport.displayPath("http://example.test/"), "/");
  assert.equal(transport.displayPath("/relative?q=1"), "/relative?q=1");
  assert.equal(transport.displayPath("//example.test/path"), "//example.test/path");
});

await check("concurrent GET ids follow request start while events follow completion", async () => {
  const pending = [deferred(), deferred()];
  let index = 0;
  const { bus, transport } = harness({ fetchImpl: () => pending[index++].promise });
  const first = transport.getJson("/wow/world");
  const second = transport.getJson("/wow/user/1");
  pending[1].resolve(response({ value: { second: true } }));
  assert.deepEqual(await second, { second: true });
  pending[0].resolve(response({ value: { first: true } }));
  assert.deepEqual(await first, { first: true });
  assert.deepEqual(bus.events.map((event) => event.detail.id), [2, 1]);
  assert.deepEqual(bus.events.map((event) => event.detail.path), ["/wow/user/1", "/wow/world"]);
});

await check("synthetic and HTTP records consume one shared initiation sequence", async () => {
  const pending = deferred();
  let request = 0;
  const { bus, transport } = harness({
    fetchImpl: async () => {
      request += 1;
      if (request === 1) return pending.promise;
      return response({ value: { posted: true } });
    },
  });
  const get = transport.getJson("/wow/world");
  const synthetic = transport.emitSyntheticApiRequest({ method: "RECEIPT", url: "urn:receipt:1", path: "urn:receipt:1", ok: true });
  assert.equal(synthetic.id, 2);
  pending.resolve(response({ value: { world: true } }));
  await get;
  await transport.postJson("/movement", {});
  assert.deepEqual(bus.events.map((event) => event.detail.id), [2, 1, 3]);
});

await check("HTTP telemetry failures stay contained without normalizing request behavior", async () => {
  const bus = new FakeBus({ throws: true });
  const { transport } = harness({ bus, fetchImpl: async () => response({ value: { ok: true } }) });
  assert.deepEqual(await transport.getJson("/wow/world"), { ok: true });
  assert.deepEqual(await transport.postJson("/movement", {}), { ok: true });
  const failed = harness({ bus, fetchImpl: async () => response({ status: 400, value: { error: "bad" } }) }).transport;
  let caught;
  try { await failed.postJson("/portal/arrival", {}); } catch (error) { caught = error; }
  assert.deepEqual(caught?.body, { error: "bad" });
});

await check("raw exclusions, singleton identity, direct re-export, injection, and dependency direction are canonical", async () => {
  const calls = [];
  const { bus, transport } = harness({
    fetchImpl: async (...args) => { calls.push(args); return response({ validation: "pass:World", value: { ok: true } }); },
  });
  await transport.rawFetch("/demo/portal-view", { headers: { Accept: "application/json" } });
  await transport.rawFetch("/wow/world", { headers: { Accept: "application/json" } });
  assert.equal(bus.events.length, 0);
  assert.equal(transport.wowContractValidationSnapshot().observed, 0);
  await transport.getJson("/plain");
  assert.equal(bus.events[0].detail.id, 1);
  assert.equal(production.DEFAULT_LIVE_ADAPTER_TRANSPORT.apiEvents, production.API_EVENTS);

  assert.match(adapterSource, /export \{ API_EVENTS \} from "\.\/live-adapter-transport\.mjs";/);
  assert.match(adapterSource, /this\._transport = opts\.transport \|\| DEFAULT_LIVE_ADAPTER_TRANSPORT;/);
  assert.match(adapterSource, /featureSignManifestOntoPacket\(packet, world, transport\)/);
  assert.match(adapterSource, /featureSignManifestOntoPacket\(packet, this\.world, this\._transport\)/);
  assert.equal(adapterSource.match(/this\._transport\.rawFetch\(/g)?.length, 7);
  assert.equal(adapterSource.match(/transport\.emitSyntheticApiRequest\(/g)?.length, 5);
  assert.doesNotMatch(adapterSource, /\bawait\s+fetch\s*\(/);
  assert.doesNotMatch(adapterSource, /function (?:getJson|postJson|recordWowContractValidation)\b|\b_apiRequestSeq\b|new EventTarget\(\)/);
  assert.doesNotMatch(transportSource, /^import\s/m);
  assert.doesNotMatch(transportSource, /from ["']\.\/(?:app|live-adapter|panel|portal-render|manifest)/);
  assert.doesNotMatch(transportSource, /\/api\/(?:a|b|lobby)|\/demo\/|fabric\/presence|client_scene|document\.|window\./);
  assert.equal(calls.length, 3);
});

if (MUTATION) {
  assert.ok(failures.length > 0, `mutation ${MUTATION} must turn at least one focused contract RED`);
  throw new Error(`controlled mutation ${MUTATION} caught RED: ${failures.join(" | ")}`);
}

const mutationArms = [
  "get-accept-header",
  "get-error-body-read",
  "get-error-event",
  "get-parse-order",
  "post-wire-body",
  "post-error-body",
  "post-network-event",
  "post-event-order",
  "validation-wow-guard",
  "validation-unavailable",
  "label-order",
  "display-path",
  "sequence-on-completion",
  "synthetic-second-sequence",
  "unguarded-http-event",
  "instrument-raw-fetch",
];

let redCaught = 0;
for (const arm of mutationArms) {
  let turnedRed = false;
  try {
    execFileSync(process.execPath, [fileURLToPath(import.meta.url)], {
      cwd: ROOT,
      env: { ...process.env, feature_TRANSPORT_MUTATION: arm },
      encoding: "utf8",
      stdio: "pipe",
    });
  } catch (error) {
    turnedRed = Number.isInteger(error.status) && error.status !== 0;
  }
  assert.equal(turnedRed, true, `mutation arm ${arm} must turn the transport check RED`);
  redCaught += 1;
  console.log(`RED_CAUGHT ${arm}`);
}

assert.equal(checks, 14);
console.log(`feature_LIVE_ADAPTER_TRANSPORT PASS ${checks}/14 mutations=${redCaught}/${mutationArms.length}`);
