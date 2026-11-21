// The extension host cases, shared by the Node check (src/extension-host-check.mjs) and the browser page
// (browser-check.html). Plain functions with no Node imports: each takes { loadExtension, fixtures, net } and throws on
// failure. A case with `only: "web"` runs in the browser alone.
//
// `net` is the test server of the network cases (net-server.mjs), on another origin: { origin, url(path), seen(),
// reset(), fetch }. seen() resolves its records; fetch is the fetch the host is given (undefined in the browser, where
// the host uses the page's own fetch and the page holds a cookie for the test server's host; in Node, a fetch that adds
// that cookie only when a request asks for credentials, as a browser would).
//
// Fixtures are read through loadFixtures(read), where read(path) resolves the bytes of a file named from the code
// folder: readFile in Node, fetch in the browser.
import { TEST_MODULES, UE_TEST_MODULES } from "./test-modules.mjs";

// ---- Assertions (no node:assert in a browser) ----

class CaseError extends Error {}
const show = (value) => {
  try { return JSON.stringify(value); } catch { return String(value); }
};
function same(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => Object.hasOwn(b, key) && same(a[key], b[key]));
}
function assert(value, message) {
  if (!value) throw new CaseError(message || "assertion failed");
}
assert.equal = (actual, expected, message) => {
  if (!Object.is(actual, expected)) throw new CaseError(message || `${show(actual)} is not ${show(expected)}`);
};
assert.deepEqual = (actual, expected, message) => {
  if (!same(actual, expected)) throw new CaseError(`${message || "values differ"}: ${show(actual)} is not ${show(expected)}`);
};
assert.match = (text, pattern, message) => {
  if (!pattern.test(text)) throw new CaseError(message || `${show(text)} does not match ${pattern}`);
};

// ---- Fixtures ----

const FIXTURE_FILES = {
  quickstart: "src/fixtures/extension-host/quickstart.wasm",
  map: "src/fixtures/extension-host/map.wasm",
  legacyMap: "src/fixtures/extension-host/sneezedoc-map.wasm",
  stoolMap: "src/fixtures/extension-host/stool-map.json",
  wit: "runtime/extension-host/wit/ue-host.wit",
  methodNumbers: "runtime/extension-host/wit/method-numbers.json",
  methodLock: "runtime/extension-host/wit/method-numbers.lock.json",
};
const HELLO_BODY = "hello from the test server: é ☃";
const SAFE_HEADERS = ["content-type", "content-length", "etag", "last-modified", "cache-control"];
const STORAGE_PREFIX = "ue-storage:";

/** Reads every fixture through `read(path)`, which resolves a Uint8Array (or ArrayBuffer) for a code-folder path. */
export async function loadFixtures(read) {
  const raw = {};
  for (const [name, path] of Object.entries(FIXTURE_FILES)) raw[name] = new Uint8Array(await read(path));
  const text = (bytes) => new TextDecoder().decode(bytes);
  return {
    QUICKSTART: raw.quickstart,
    MAP: raw.map,
    LEGACY_MAP: raw.legacyMap,
    STOOL_MAP: JSON.parse(text(raw.stoolMap)),
    WIT: text(raw.wit),
    METHOD_NUMBERS: JSON.parse(text(raw.methodNumbers)).methods,
    METHOD_LOCK: JSON.parse(text(raw.methodLock)).methods,
    METHOD_PACKAGE: JSON.parse(text(raw.methodNumbers)).package,
  };
}

// ---- Helpers ----

const MIB = 1024 * 1024;
const ALL = ["ue.console.log", "ue.data.read", "ue.scene.nodes"];
const UE_ALL = ["ue.console.log", "ue.data.read", "ue.scene.nodes", "ue.scene.read", "ue.clock.read", "ue.clock.timer"];
const UE = UE_TEST_MODULES;

/** The Subresource Integrity form of the SHA-256, computed here and not by the host under test. */
async function sri(bytes) {
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return `sha256-${btoa(binary)}`;
}
const declare = async (bytes, url) => ({
  module: { url, integrity: await sri(bytes), binding: "rp1-sneeze-call" },
  interface: "rp1-sneeze-call",
  attach: { kind: "world-node" },
  requests: ALL,
  limits: {},
});
const ueDeclare = async (bytes, url) => ({
  module: { url, integrity: await sri(bytes), binding: "ue-core/0" },
  interface: "ue:host@0.1.0",
  attach: { kind: "world-node" },
  requests: UE_ALL,
  limits: {},
});
const loaders = (loadExtension) => ({
  load: async (bytes, url, more = {}) => loadExtension({ bytes, declaration: await declare(bytes, url), grant: ALL, ...more }),
  ueLoad: async (bytes, url, more = {}) => loadExtension({ bytes, declaration: await ueDeclare(bytes, url), grant: UE_ALL, ...more }),
});
const stool = (fabric) => ({ index: 2, fabric });
const sameNode = (node) => ({ class: node.class, name: node.name, reference: node.reference });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ticksOf = (extension) => extension.logEntries.filter((entry) => entry.text === "tick");

// ---- ue:host@0.2.0 helpers ----

const ue2Declare = async (bytes, url, requests) => ({
  module: { url, integrity: await sri(bytes), binding: "ue-core/0" },
  interface: "ue:host@0.2.0",
  attach: { kind: "world-node" },
  requests,
  limits: {},
});
const fetchToken = (origin) => `ue.network.fetch:${origin}`;
const fetchRequest = (url, method = "GET") => ({ url, method, headers: [], body: null });
const fetchEvents = (extension) => (extension.events || []).filter((item) => item.event && item.event.type === "fetch");
/** Polls `test` every 25 ms until it is true or `ms` pass; resolves its last value. */
async function until(test, ms = 3000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await test();
    if (value || Date.now() > end) return value;
    await sleep(25);
  }
}
/** Loads the fetcher: attachment 1 fetches `request`; the grant and the requests name `tokens` beyond UE_ALL. */
async function loadFetcher(loadExtension, net, { request, tokens, grant = tokens, times = 1, fetch = net && net.fetch }) {
  const bytes = UE.ueFetcher({ times });
  return loadExtension({
    bytes, declaration: await ue2Declare(bytes, "fetcher.wasm", [...UE_ALL, ...tokens]), grant: [...UE_ALL, ...grant],
    attachment: { index: 1, fabric: { Data: request ? { fetch: request } : {} } }, fetch,
  });
}
/** A storage backend with the localStorage interface, kept in a Map, with a snapshot of its items. */
function memoryStorage() {
  const items = new Map();
  return {
    getItem: (key) => (items.has(key) ? items.get(key) : null),
    setItem: (key, value) => { items.set(key, String(value)); },
    removeItem: (key) => { items.delete(key); },
    get length() { return items.size; },
    key: (index) => [...items.keys()][index] ?? null,
    snapshot: () => JSON.stringify([...items].sort()),
    keys: () => [...items.keys()],
  };
}
/** Loads the storage user at the placement (world, node), with `data` as its Data and `storage` as the backend. */
async function loadStorageUser(loadExtension, { storage, world, node, data = {}, grant = [...UE_ALL, "ue.storage.local"] }) {
  const bytes = UE.ueStorageUser();
  return loadExtension({
    bytes, declaration: await ue2Declare(bytes, "storage-user.wasm", [...UE_ALL, "ue.storage.local"]), grant, storage,
    attachment: { index: 1, fabric: { Data: data }, placement: { world, node } },
  });
}

/** The functions of each interface in a WIT file, as "interface.function" names, in file order. */
function witFunctions(text) {
  const names = [];
  const lines = text.replace(/\/\/.*$/gm, "").split("\n");
  let current = null, depth = 0;
  for (const line of lines) {
    const opened = /^\s*interface\s+([a-z][a-z0-9-]*)\s*\{/.exec(line);
    if (depth === 0 && opened) current = opened[1];
    const fn = /^\s*([a-z][a-z0-9-]*)\s*:\s*func\s*\(/.exec(line);
    if (current && depth === 1 && fn) names.push(`${current}.${fn[1]}`);
    depth += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
    if (depth === 0) current = null;
  }
  return names;
}

// ---- The cases ----

export const CASES = [
  { id: "sandbox-is-worker", only: "web", says: "The guest runs in a dedicated Web Worker, not on the page", async run({ loadExtension, fixtures }) {
    const { load } = loaders(loadExtension);
    const result = await load(fixtures.QUICKSTART, "quickstart.wasm", { attachment: { index: 2, fabric: { Data: {} } } });
    assert.equal(result.ok, true, String(result.error));
    const scope = result.sandboxScope;
    await result.shutdown();
    assert.equal(scope, "DedicatedWorkerGlobalScope", `the guest ran in ${scope}, not a DedicatedWorkerGlobalScope`);
  } },

  { id: "integrity", says: "A wrong module.integrity is refused before compiling, and no node exists", async run({ loadExtension, fixtures }) {
    const declaration = await declare(fixtures.QUICKSTART, "quickstart.wasm");
    declaration.module.integrity = await sri(new TextEncoder().encode("another module"));
    const result = await loadExtension({ bytes: fixtures.QUICKSTART, declaration, grant: ALL });
    assert.equal(result.ok, false, "a wrong integrity loads");
    assert.equal(result.stage, "integrity", "refused before compiling");
    assert.match(String(result.error), /does not match/, "the error says the hash does not match");
    assert.equal(result.nodes.length, 0, "no node exists");
  } },

  { id: "import-refused", says: "An import the binding does not define is refused before instantiation, by name", async run({ loadExtension, fixtures }) {
    const { load } = loaders(loadExtension);
    const result = await load(fixtures.LEGACY_MAP, "sneezedoc-map.wasm", { attachment: stool(fixtures.STOOL_MAP) });
    assert.equal(result.ok, false, "a legacy import loads");
    assert.equal(result.stage, "imports", "refused before instantiation");
    assert.match(String(result.error), /Console\.Log/, "the error names Console.Log");
    assert.equal(result.nodes.length, 0);
  } },

  { id: "capability-refused", says: "Without ue.scene.nodes no node is made, the refusal names it, the call gets a negative error", async run({ loadExtension, fixtures }) {
    const result = await loadExtension({
      bytes: fixtures.QUICKSTART, declaration: await declare(fixtures.QUICKSTART, "quickstart.wasm"), grant: ["ue.console.log"], attachment: { index: 2, fabric: { Data: {} } },
    });
    assert.equal(result.ok, true, `the extension still runs: ${result.error}`);
    assert.equal(result.nodes.length, 0, "a node was made without ue.scene.nodes");
    const refusal = result.refusals.find((item) => item.token === "ue.scene.nodes");
    assert(refusal, "the refusals name ue.scene.nodes");
    assert(refusal.result < 0, `the refused call returned ${refusal.result}, not a negative error`);
    assert.deepEqual(result.log, ["hello from wasm"], "the granted log still works");
    await result.shutdown();
  } },

  { id: "memory-initial", says: "A module that declares 2,048 initial pages is refused under a 16 MiB budget", async run({ loadExtension }) {
    const { load } = loaders(loadExtension);
    const result = await load(TEST_MODULES.initialPages2048(), "initial-2048.wasm", { budgets: { memoryBytes: 16 * MIB } });
    assert.equal(result.ok, false, "a 128 MiB module loads under a 16 MiB budget");
    assert.equal(result.stage, "memory", "refused before instantiation");
    assert.match(String(result.error), /memory budget of 16 MiB/, "the error names the memory budget");
  } },

  { id: "memory-growth", says: "A module that grows memory reaches the cap, memory.grow returns -1, memory stays in budget", async run({ loadExtension }) {
    const { load } = loaders(loadExtension);
    const result = await load(TEST_MODULES.growsMemory(), "grows.wasm", { budgets: { memoryBytes: 16 * MIB } });
    assert.equal(result.ok, true, `memory.grow never returned -1 before 300 pages: ${result.error}`);
    assert(result.memoryBytes <= 16 * MIB, `memory reached ${result.memoryBytes} bytes, over the 16 MiB budget`);
    assert.equal(result.memoryBytes, 16 * MIB, "the module stopped short of the cap");
    await result.shutdown();
  } },

  { id: "cpu-watchdog", says: "A module whose Init loops for ever is ended within its budget plus 250 ms", async run({ loadExtension }) {
    const { load } = loaders(loadExtension);
    let ticks = 0;
    const beat = setInterval(() => { ticks += 1; }, 10);
    let guardTimer = null;
    const guard = new Promise((resolve) => { guardTimer = setTimeout(() => resolve({ unended: true }), 3000); });
    try {
      const result = await Promise.race([load(TEST_MODULES.loopsForever(), "loops.wasm", { budgets: { initMs: 500 } }), guard]);
      assert(!result.unended, "the watchdog did not end the run within 3 s");
      assert.equal(result.ok, false);
      assert.equal(result.budgetExceeded, true, "the result does not say the budget was exceeded");
      assert.match(String(result.error), /budget/, "the error names the budget");
      assert(result.callMs <= 500 + 250, `Init ran ${result.callMs} ms before it was ended`);
      assert(ticks >= 10, `the main thread answered its timer ${ticks} times during the run`);
    } finally {
      clearInterval(beat);
      clearTimeout(guardTimer);
    }
  } },

  { id: "initialize-first", says: "A module that needs _initialize loads and its Init does not trap", async run({ loadExtension }) {
    const { load } = loaders(loadExtension);
    const result = await load(TEST_MODULES.needsInitialize(), "needs-initialize.wasm");
    assert.equal(result.ok, true, `Init trapped: ${result.error}`);
    assert.deepEqual(result.calls.slice(0, 2), ["_initialize", "Init"]);
    await result.shutdown();
  } },

  { id: "lifecycle", says: "One instance serves two attachments; Close releases its own nodes; Shutdown runs after the last Close", async run({ loadExtension, fixtures }) {
    const { load } = loaders(loadExtension);
    const result = await load(fixtures.MAP, "map.wasm", { attachment: stool(fixtures.STOOL_MAP) });
    assert.equal(result.ok, true, String(result.error));
    const second = await result.open({ index: 3, fabric: fixtures.STOOL_MAP });
    assert.equal(second.ok, true, String(second.error));
    assert.deepEqual(result.nodes.map((node) => node.attachment), [2, 3], "each attachment has its node");
    await result.close(2);
    assert.deepEqual(result.nodes.map((node) => node.attachment), [3], "the first attachment's nodes are not gone after its Close");
    await result.close(3);
    assert.equal(result.nodes.length, 0, "nodes remain after the last Close");
    assert.deepEqual(result.calls, ["Init", "Open 2", "Open 3", "Close 2", "Close 3", "Shutdown"], "lifecycle calls");
  } },

  { id: "rp1-quickstart", says: "quickstart.wasm writes its log line and yields one Physical root node, Stool, assets/Stool.glb", async run({ loadExtension, fixtures }) {
    const { load } = loaders(loadExtension);
    const result = await load(fixtures.QUICKSTART, "quickstart.wasm", { attachment: { index: 2, fabric: { Data: {} } } });
    assert.equal(result.ok, true, String(result.error));
    assert.deepEqual(result.log, ["hello from wasm"], "the log line");
    assert.deepEqual(result.nodes.map(sameNode), [{ class: 73, name: "Stool", reference: "assets/Stool.glb" }], "quickstart nodes");
    assert.equal(result.nodes[0].parent, null, "the node is a root");
    await result.shutdown();
  } },

  { id: "rp1-map", says: "map.wasm with stool-map.json injects one node, assets/Stool.glb, as RP1's engine did", async run({ loadExtension, fixtures }) {
    const { load } = loaders(loadExtension);
    const result = await load(fixtures.MAP, "map.wasm", { attachment: stool(fixtures.STOOL_MAP) });
    assert.equal(result.ok, true, String(result.error));
    assert.deepEqual(result.nodes.map(sameNode), [{ class: 73, name: "Stool", reference: "assets/Stool.glb" }], "map nodes");
    assert(result.log.includes("Map WASM: Open (twFabricIx=2)"), "the module's own log line");
    await result.shutdown();
  } },

  { id: "rp1-key-case", says: "The same extension with the scene under data.scene yields no nodes", async run({ loadExtension, fixtures }) {
    const { load } = loaders(loadExtension);
    const lowered = { ...fixtures.STOOL_MAP, data: { scene: fixtures.STOOL_MAP.Data.Scene } };
    delete lowered.Data;
    const result = await load(fixtures.MAP, "map.wasm", { attachment: stool(lowered) });
    assert.equal(result.ok, true, String(result.error));
    assert.equal(result.nodes.length, 0, "keys matched without their case");
    await result.shutdown();
  } },

  // ---- ue:host@0.1.0: the WIT file, its method table and the frozen copy ----

  { id: "wit-table-agree", says: "Every function in ue-host.wit has exactly one method-table entry, and every entry names a function", async run({ fixtures }) {
    const functions = witFunctions(fixtures.WIT);
    const table = fixtures.METHOD_NUMBERS;
    assert.equal(functions.length, 18, `ue-host.wit declares ${functions.length} interface functions, not 18`);
    for (const fn of functions) {
      const entries = table.filter((entry) => entry.wit === fn);
      assert.equal(entries.length, 1, `${fn} has ${entries.length} table entries, not exactly one`);
    }
    for (const entry of table) assert(functions.includes(entry.wit), `the table entry ${entry.wit} names no function in ue-host.wit`);
    const numbers = table.map((entry) => `${entry.subsystem}.${entry.method}`);
    assert.equal(new Set(numbers).size, numbers.length, "two table entries share a (subsystem, method) number");
    for (const entry of table) {
      assert(["none", "scalar", "bytes"].includes(entry.returns), `${entry.wit} returns ${entry.returns}`);
      assert.match(String(entry.token), /^ue\.[a-z]+\.[a-z]+(?::<origin>)?$/, `${entry.wit} has no capability token`);
    }
  } },

  { id: "method-numbers-frozen", says: "Every entry of method-numbers.lock.json is unchanged in method-numbers.json", async run({ fixtures }) {
    const table = fixtures.METHOD_NUMBERS;
    const lock = fixtures.METHOD_LOCK;
    for (const frozen of lock) {
      const entry = table.find((item) => item.wit === frozen.wit);
      assert(entry, `the frozen entry ${frozen.wit} is gone from the table`);
      assert.deepEqual(entry, frozen, `the frozen entry ${frozen.wit} changed`);
    }
    for (const entry of table) {
      if (lock.some((frozen) => frozen.wit === entry.wit)) continue;
      const reused = lock.find((frozen) => frozen.subsystem === entry.subsystem && frozen.method === entry.method);
      assert(!reused, `the new entry ${entry.wit} reuses the number ${entry.subsystem}.${entry.method} of ${reused && reused.wit}`);
    }
  } },

  // ---- ue-core/0: the binding of ue:host@0.1.0 ----

  { id: "concurrent-loads", says: "Three ue-core/0 extensions loaded at once all load (the binding is imported once); it runs before any other case loads ue-core/0, so the page imports the binding here first", async run({ loadExtension }) {
    const { ueLoad } = loaders(loadExtension);
    const results = await Promise.all([1, 2, 3].map(() => ueLoad(UE.ueNodeMaker(), "node-maker.wasm")));
    for (const result of results) if (result.ok) await result.shutdown();
    const failed = results.filter((result) => !result.ok).map((result) => `${result.stage}: ${result.error}`);
    assert.deepEqual(failed, [], "extensions loaded at once failed");
  } },

  { id: "binding-select", says: "ue-core/0 loads the ue-core binding, rp1-sneeze-call the RP1 one, an unknown binding is refused before compiling", async run({ loadExtension, fixtures }) {
    const { load, ueLoad } = loaders(loadExtension);
    const ue = await ueLoad(UE.ueNodeMaker(), "node-maker.wasm");
    assert.equal(ue.ok, true, `ue-core/0 did not load: ${ue.error}`);
    assert.equal(ue.binding, "ue-core/0", `ue-core/0 did not load the ue-core binding, but ${ue.binding}`);
    await ue.shutdown();
    const rp1 = await load(fixtures.QUICKSTART, "quickstart.wasm", { attachment: { index: 2, fabric: { Data: {} } } });
    assert.equal(rp1.ok, true, String(rp1.error));
    assert.equal(rp1.binding, "rp1-sneeze-call", `rp1-sneeze-call loaded ${rp1.binding}`);
    await rp1.shutdown();
    const junk = new TextEncoder().encode("not a module");
    const declaration = { ...(await ueDeclare(junk, "junk.wasm")), module: { url: "junk.wasm", integrity: await sri(junk), binding: "ue-core/9" } };
    const unknown = await loadExtension({ bytes: junk, declaration, grant: UE_ALL });
    assert.equal(unknown.ok, false, "an unknown binding loads");
    assert.equal(unknown.stage, "declaration", `an unknown binding was refused at stage ${unknown.stage}, not before compiling`);
    assert.match(String(unknown.error), /no binding named ue-core\/9/);
  } },

  { id: "ue-core-node", says: "The node maker yields exactly one node, Box, assets/Box.glb, under the attachment root", async run({ loadExtension }) {
    const { ueLoad } = loaders(loadExtension);
    const result = await ueLoad(UE.ueNodeMaker(), "node-maker.wasm");
    assert.equal(result.ok, true, String(result.error));
    const root = result.log.find((line) => line.startsWith("attachment-root "));
    assert(root && Number(root.split(" ")[1]) > 0, `attachment-root returned ${root}`);
    assert.deepEqual(result.nodes.map((node) => ({ name: node.name, reference: node.reference, kind: node.kind })),
      [{ name: "Box", reference: "assets/Box.glb", kind: "mesh" }], "node maker nodes");
    assert.equal(result.nodes[0].parent, root.split(" ")[1], "the node is not under the attachment root");
    assert.equal(result.log.find((line) => line.startsWith("node-create ")), `node-create ${result.nodes[0].composed}`, "node-create returned another id");
    await result.shutdown();
  } },

  { id: "ue-core-unknown-method", says: "A method the table does not define returns -1", async run({ loadExtension }) {
    const { ueLoad } = loaders(loadExtension);
    const result = await ueLoad(UE.ueUnknownMethod(), "unknown-method.wasm");
    assert.equal(result.ok, true, String(result.error));
    assert.deepEqual(result.log, ["unknown-method -1"], "the unknown method's result");
    await result.shutdown();
  } },

  { id: "ue-core-refused", says: "Without ue.scene.nodes the node maker yields no node, the call returns -2, the refusal names ue.scene.nodes", async run({ loadExtension }) {
    const { ueLoad } = loaders(loadExtension);
    const result = await ueLoad(UE.ueNodeMaker(), "node-maker.wasm", { grant: ["ue.console.log"] });
    assert.equal(result.ok, true, `the extension still runs: ${result.error}`);
    assert.equal(result.nodes.length, 0, "a node was made without ue.scene.nodes");
    assert.deepEqual(result.log, ["attachment-root -2", "node-create -2"], "the refused calls' results");
    const refusal = result.refusals.find((item) => item.token === "ue.scene.nodes");
    assert(refusal, "the refusals name ue.scene.nodes");
    assert.equal(refusal.result, -2, `the refusal records ${refusal.result}`);
    await result.shutdown();
  } },

  { id: "ue-core-bad-payload", says: "A payload that is not JSON returns -3", async run({ loadExtension }) {
    const { ueLoad } = loaders(loadExtension);
    const result = await ueLoad(UE.ueBadPayload(), "bad-payload.wasm");
    assert.equal(result.ok, true, String(result.error));
    assert.deepEqual(result.log, ["bad-payload -3"], "the bad payload's result");
    await result.shutdown();
  } },

  { id: "ue-core-data-get", says: "The data reader logs the exact JSON value of title: Alloc, the write and the packing are right", async run({ loadExtension }) {
    const { ueLoad } = loaders(loadExtension);
    const title = "Lab \"title\" é ☃";
    const result = await ueLoad(UE.ueDataReader(), "data-reader.wasm", { attachment: { index: 1, fabric: { Data: { title, other: 1 } } } });
    assert.equal(result.ok, true, `the data reader failed: ${result.error}`);
    assert.deepEqual(result.log, [title], "the logged title");
    const missing = await ueLoad(UE.ueDataReader(), "data-reader.wasm", { attachment: { index: 1, fabric: { Data: {} } } });
    assert.deepEqual(missing.log, ["data.get -4"], "a missing path");
    await result.shutdown();
    await missing.shutdown();
  } },

  { id: "ue-core-timer-directed", says: "With two attachments open, a timer set by attachment 1 notifies only attachment 1", async run({ loadExtension }) {
    const { ueLoad } = loaders(loadExtension);
    const result = await ueLoad(UE.ueTimerUser(), "timer-user.wasm");
    assert.equal(result.ok, true, String(result.error));
    const second = await result.open({ index: 2, fabric: { Data: {} } });
    assert.equal(second.ok, true, String(second.error));
    await sleep(150);
    const ticks = ticksOf(result);
    await result.shutdown();
    assert(result.log.includes("timer.set 1"), `timer.set did not return id 1: ${result.log.slice(0, 3)}`);
    assert(ticks.some((entry) => entry.attachment === 1), "attachment 1 got no timer event");
    assert.deepEqual(ticks.filter((entry) => entry.attachment !== 1), [], "an attachment that set no timer got a timer event");
  } },

  { id: "ue-core-timer-cap", says: "The 33rd timer of one attachment returns -5", async run({ loadExtension }) {
    const { ueLoad } = loaders(loadExtension);
    const result = await ueLoad(UE.ueTimerFlooder(), "timer-flooder.wasm");
    assert.equal(result.ok, true, String(result.error));
    assert.deepEqual(result.log, ["timers set 32", "timer 33 -5"], "the timer cap");
    await result.shutdown();
  } },

  { id: "ue-core-timer-release", says: "After Close, that attachment's timers send no more events", async run({ loadExtension }) {
    const { ueLoad } = loaders(loadExtension);
    const result = await ueLoad(UE.ueTimerUser(), "timer-user.wasm");
    assert.equal(result.ok, true, String(result.error));
    await result.open({ index: 2, fabric: { Data: {} } });
    await sleep(100);
    await result.close(1);
    const before = ticksOf(result).length;
    assert(before > 0, "attachment 1 got no timer event before its Close");
    await sleep(150);
    const after = ticksOf(result).length;
    await result.shutdown();
    assert.equal(after, before, `${after - before} timer events reached attachment 1 after its Close`);
  } },

  { id: "ue-core-sandbox", says: "The ue-core/0 memory and CPU modules are refused or ended as in Step 1", async run({ loadExtension }) {
    const { ueLoad } = loaders(loadExtension);
    const initial = await ueLoad(UE.ueInitialPages2048(), "ue-initial-2048.wasm", { budgets: { memoryBytes: 16 * MIB } });
    assert.equal(initial.ok, false, "the ue-core 128 MiB module loads under a 16 MiB budget");
    assert.equal(initial.stage, "memory", `the ue-core memory module was refused at stage ${initial.stage}, not memory`);
    assert.match(String(initial.error), /memory budget of 16 MiB/);
    const grows = await ueLoad(UE.ueGrowsMemory(), "ue-grows.wasm", { budgets: { memoryBytes: 16 * MIB } });
    assert.equal(grows.ok, true, `the ue-core growth module never got -1 from memory.grow: ${grows.error}`);
    assert.equal(grows.memoryBytes, 16 * MIB, `the ue-core growth module reached ${grows.memoryBytes} bytes`);
    await grows.shutdown();
    let guardTimer = null;
    const guard = new Promise((resolve) => { guardTimer = setTimeout(() => resolve({ unended: true }), 3000); });
    try {
      const loops = await Promise.race([ueLoad(UE.ueLoopsForever(), "ue-loops.wasm", { budgets: { initMs: 500 } }), guard]);
      assert(!loops.unended, "the watchdog did not end the ue-core loop within 3 s");
      assert.equal(loops.ok, false);
      assert.equal(loops.budgetExceeded, true, "the ue-core loop did not exceed its budget");
      assert(loops.callMs <= 500 + 250, `the ue-core Init ran ${loops.callMs} ms before it was ended`);
    } finally {
      clearTimeout(guardTimer);
    }
  } },

  // ---- Time budgets: a soft limit per event, a hard limit, a row of overruns, a budget per second ----

  { id: "event-soft-overrun", says: "A Notify of about 60 ms is counted as an overrun of the 20 ms event budget, and the extension keeps running", async run({ loadExtension }) {
    const bytes = UE.ueBusyTimer({ delayMs: 50, busyMs: 60, busyCalls: 1 });
    const result = await loadExtension({ bytes, declaration: await ueDeclare(bytes, "busy-once.wasm"), grant: UE_ALL });
    assert.equal(result.ok, true, String(result.error));
    try {
      await until(() => !result.running || (result.overruns >= 1 && ticksOf(result).length >= 3), 3000);
      assert(result.running, `the worker was ended at the soft limit: ${result.error}`);
      assert(result.overruns >= 1, `the 60 ms call was not counted: overruns ${result.overruns}`);
      assert(ticksOf(result).length >= 3, `the extension got ${ticksOf(result).length} timer events after its slow call`);
      assert.equal(result.budgetExceeded, false, "a soft overrun set budgetExceeded");
    } finally {
      await result.shutdown();
    }
  } },

  { id: "event-hard-limit", says: "A Notify that does not return is ended at the 250 ms hard limit", async run({ loadExtension }) {
    const bytes = UE.ueBusyTimer({ delayMs: 30, busyMs: 4000, busyCalls: 1 });
    const result = await loadExtension({ bytes, declaration: await ueDeclare(bytes, "busy-forever.wasm"), grant: UE_ALL });
    assert.equal(result.ok, true, String(result.error));
    try {
      const ended = await until(() => !result.running, 3000);
      assert(ended, "a Notify that does not return was not ended within 3 s");
      assert.equal(result.budgetExceeded, true, "the result does not say the budget was exceeded");
      assert(result.callMs >= 240 && result.callMs <= 250 + 250, `the Notify was ended after ${result.callMs} ms, not at the 250 ms hard limit`);
      assert.match(String(result.error), /250 ms/, "the error does not name the 250 ms hard limit");
    } finally {
      await result.shutdown();
    }
  } },

  { id: "event-overruns-in-a-row", says: "Ten soft overruns in a row end the worker", async run({ loadExtension }) {
    const bytes = UE.ueBusyTimer({ delayMs: 10, busyMs: 30 });
    const result = await loadExtension({ bytes, declaration: await ueDeclare(bytes, "busy-always.wasm"), grant: UE_ALL, budgets: { secondMs: 1000 } });
    assert.equal(result.ok, true, String(result.error));
    try {
      const ended = await until(() => !result.running, 3000);
      assert(ended, `ten overruns in a row did not end the worker: it runs after 3 s with ${result.overruns} overruns`);
      assert(result.overruns >= 10, `the worker was ended after ${result.overruns} overruns`);
      assert.match(String(result.error), /in a row/, "the error does not say the overruns came in a row");
    } finally {
      await result.shutdown();
    }
  } },

  { id: "second-budget-holds", says: "An extension that asks for more than 250 ms of work per second has its timer events held and is not ended; another extension's events still arrive", async run({ loadExtension }) {
    const { ueLoad } = loaders(loadExtension);
    const bytes = UE.ueBusyTimer({ delayMs: 5, busyMs: 10 });
    const busy = await loadExtension({ bytes, declaration: await ueDeclare(bytes, "busy-10ms.wasm"), grant: UE_ALL, budgets: { eventMs: 200 } });
    assert.equal(busy.ok, true, String(busy.error));
    const other = await ueLoad(UE.ueTimerUser(), "timer-user.wasm");
    assert.equal(other.ok, true, String(other.error));
    const started = Date.now();
    await sleep(1600);
    const elapsed = Date.now() - started;
    const busyTicks = ticksOf(busy).length, otherTicks = ticksOf(other).length, held = busy.heldEvents, running = busy.running, error = busy.error;
    await busy.shutdown();
    await other.shutdown();
    assert(running, `the busy extension was ended: ${error}`);
    assert(held > 0, `no event of the busy extension was held (${busyTicks} calls of 10 ms in ${elapsed} ms)`);
    assert(busyTicks <= 60, `the busy extension ran ${busyTicks} calls of 10 ms in ${elapsed} ms, over 250 ms per second`);
    assert(otherTicks >= 10, `the other extension got ${otherTicks} timer events while the busy one was held`);
  } },

  // ---- ue:host@0.2.0: additive to 0.1.0 ----

  { id: "wit-additive", says: "Every 0.1.0 entry of the lock file is unchanged, the 0.2.0 network and storage rows are present, and a 0.1.0 guest still loads", async run({ loadExtension, fixtures }) {
    const table = fixtures.METHOD_NUMBERS;
    const lock = fixtures.METHOD_LOCK;
    assert.equal(fixtures.METHOD_PACKAGE, "ue:host@0.2.0", `the method table is for ${fixtures.METHOD_PACKAGE}, not ue:host@0.2.0`);
    const first = lock.filter((entry) => entry.since === undefined);
    assert.equal(first.length, 13, `the lock file has ${first.length} 0.1.0 entries, not 13`);
    for (const frozen of first) {
      const entry = table.find((item) => item.wit === frozen.wit);
      assert(entry, `the 0.1.0 entry ${frozen.wit} is gone from the table`);
      assert.deepEqual(entry, frozen, `the 0.1.0 entry ${frozen.wit} changed`);
    }
    const added = [["network.fetch", 6, 1], ["network.abort", 6, 2], ["storage.get", 7, 1], ["storage.set", 7, 2], ["storage.delete", 7, 3]];
    for (const [wit, subsystem, method] of added) {
      for (const [name, rows] of [["table", table], ["lock file", lock]]) {
        const entry = rows.find((item) => item.wit === wit);
        assert(entry, `the 0.2.0 row ${wit} is not in the ${name}`);
        assert.deepEqual([entry.subsystem, entry.method, entry.since], [subsystem, method, "0.2.0"], `the 0.2.0 row ${wit} in the ${name}`);
      }
    }
    assert.equal(lock.length, 18, `the lock file has ${lock.length} rows, not 18`);
    const { ueLoad } = loaders(loadExtension);
    const old = await ueLoad(UE.ueNodeMaker(), "node-maker.wasm");
    assert.equal(old.ok, true, `a ue:host@0.1.0 guest did not load: ${old.error}`);
    assert.equal(old.nodes.length, 1, "the ue:host@0.1.0 guest made no node");
    await old.shutdown();
  } },

  // ---- ue:host@0.2.0: network ----

  { id: "net-needs-grant", says: "A fetch without its origin token returns -2, the refusal names the token, and no request is made", async run({ loadExtension, net }) {
    await net.reset();
    const token = fetchToken(net.origin);
    const result = await loadFetcher(loadExtension, net, { request: fetchRequest(net.url("/hello")), tokens: [token], grant: [] });
    assert.equal(result.ok, true, String(result.error));
    await sleep(300);
    const seen = await net.seen();
    await result.shutdown();
    assert.deepEqual(result.log, ["fetch -2"], "the fetch without its origin token returned");
    const refusal = result.refusals.find((item) => item.token === token);
    assert(refusal, `the refusals do not name ${token}: ${show(result.refusals)}`);
    assert.equal(seen.length, 0, `the test server saw ${seen.length} requests without its origin token`);
  } },

  { id: "net-origin-exact", says: "A grant for https://a.example allows https://A.EXAMPLE:443 but not http://a.example, https://a.example:8443 or https://b.a.example", async run({ loadExtension }) {
    const calls = [];
    const fake = async (url) => {
      calls.push(String(url));
      return new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
    };
    const token = fetchToken("https://a.example");
    const run = async (url) => {
      const result = await loadFetcher(loadExtension, null, { request: fetchRequest(url), tokens: [token], fetch: fake });
      assert.equal(result.ok, true, String(result.error));
      await until(() => fetchEvents(result).length > 0, 500);
      await result.shutdown();
      return result.log.filter((line) => line.startsWith("fetch "));
    };
    for (const url of ["http://a.example/x", "https://a.example:8443/x", "https://b.a.example/x"]) {
      assert.deepEqual(await run(url), ["fetch -2"], `${url} was allowed by a grant for https://a.example`);
    }
    assert.deepEqual(calls, [], "a refused fetch reached fetch()");
    assert.deepEqual(await run("https://a.example/x"), ["fetch 1"], "https://a.example/x was refused");
    assert.deepEqual(await run("https://A.EXAMPLE:443/y"), ["fetch 1"], "https://A.EXAMPLE:443/y was refused");
    assert.deepEqual(calls, ["https://a.example/x", "https://a.example/y"], "the fetched URLs");
  } },

  { id: "net-fetch-ok", says: "A granted fetch returns status 200 and the exact body through Notify, to the owning attachment only, with only safe headers", async run({ loadExtension, net }) {
    await net.reset();
    const result = await loadFetcher(loadExtension, net, { request: fetchRequest(net.url("/hello")), tokens: [fetchToken(net.origin)] });
    assert.equal(result.ok, true, String(result.error));
    const second = await result.open({ index: 2, fabric: { Data: {} } });
    assert.equal(second.ok, true, String(second.error));
    await until(() => fetchEvents(result).length > 0);
    await sleep(200);
    const events = fetchEvents(result);
    const notified = result.logEntries.filter((entry) => entry.text === "notified");
    await result.shutdown();
    assert(result.log.includes("fetch 1") && result.log.includes("data.get -4"), `the fetcher's calls: ${show(result.log)}`);
    assert.deepEqual(events.filter((item) => item.attachment !== 1).map((item) => item.attachment), [], "the fetch result reached another attachment");
    assert.deepEqual(notified.filter((entry) => entry.attachment !== 1).map((entry) => entry.attachment), [], "Notify ran for another attachment");
    assert.equal(events.length, 1, `${events.length} fetch results reached attachment 1`);
    assert.equal(notified.length, 1, "the guest's Notify did not run once");
    const event = events[0].event;
    assert.deepEqual([event.attachment, event.request, event.status, event.bodyEncoding, event.error], [1, 1, 200, "text", undefined], "attachment, request, status, bodyEncoding, error");
    assert.equal(event.body, HELLO_BODY, "the body is not the exact body the server sent");
    const names = event.headers.map(([name]) => name);
    assert(names.includes("content-type"), `the result headers have no content-type: ${show(event.headers)}`);
    assert.deepEqual(names.filter((name) => !SAFE_HEADERS.includes(name)), [], "the result passes on headers outside the safe list");
  } },

  { id: "net-no-credentials", says: "The test server sees no cookie and no Authorization header added by the host", async run({ loadExtension, net }) {
    await net.reset();
    const result = await loadFetcher(loadExtension, net, { request: fetchRequest(net.url("/hello")), tokens: [fetchToken(net.origin)] });
    assert.equal(result.ok, true, String(result.error));
    await until(() => fetchEvents(result).length > 0);
    const seen = await net.seen();
    await result.shutdown();
    const hello = seen.filter((record) => record.path === "/hello");
    assert.equal(hello.length, 1, `the test server saw ${hello.length} requests for /hello`);
    assert.equal(hello[0].cookie, "", `the test server saw a cookie: ${hello[0].cookie}`);
    assert.equal(hello[0].authorization, "", `the test server saw an Authorization header: ${hello[0].authorization}`);
  } },

  { id: "net-redirect-refused", says: "A 302 response yields a result with error -4, and the redirect target is never requested", async run({ loadExtension, net }) {
    await net.reset();
    const result = await loadFetcher(loadExtension, net, { request: fetchRequest(net.url("/redirect")), tokens: [fetchToken(net.origin)] });
    assert.equal(result.ok, true, String(result.error));
    await until(() => fetchEvents(result).length > 0);
    await sleep(200);
    const seen = await net.seen();
    const events = fetchEvents(result);
    await result.shutdown();
    assert.deepEqual(seen.filter((record) => record.path === "/target").map((record) => record.path), [], "the redirect target was requested");
    assert.equal(events.length, 1, `${events.length} fetch results`);
    assert.equal(events[0].event.error, -4, `the redirect result has error ${events[0].event.error}, not -4`);
  } },

  { id: "net-caps", says: "A response over 1 MiB gives -5, and the 9th concurrent request of one attachment gives -5", async run({ loadExtension, net }) {
    await net.reset();
    const token = fetchToken(net.origin);
    const big = await loadFetcher(loadExtension, net, { request: fetchRequest(net.url("/big")), tokens: [token] });
    assert.equal(big.ok, true, String(big.error));
    await until(() => fetchEvents(big).length > 0, 5000);
    const bigEvents = fetchEvents(big);
    await big.shutdown();
    assert.equal(bigEvents.length, 1, `${bigEvents.length} results for the 1 MiB + 1 byte response`);
    assert.equal(bigEvents[0].event.error, -5, `the 1 MiB + 1 byte response has error ${bigEvents[0].event.error}, not -5`);
    assert.equal(bigEvents[0].event.body, "", "the over-cap response passes on a body");
    const many = await loadFetcher(loadExtension, net, { request: fetchRequest(net.url("/slow")), tokens: [token], times: 9 });
    assert.equal(many.ok, true, String(many.error));
    const log = [...many.log];
    await many.shutdown();
    assert.deepEqual(log.slice(0, 8).filter((line) => !/^fetch [1-9]\d*$/.test(line)), [], `the first 8 concurrent requests were not all started: ${show(log)}`);
    assert.equal(log[8], "fetch -5", `the 9th concurrent request returned ${log[8]}`);
  } },

  { id: "net-close-aborts", says: "After Close, the attachment's request in flight is aborted and no result reaches the guest", async run({ loadExtension, net }) {
    await net.reset();
    const result = await loadFetcher(loadExtension, net, { request: fetchRequest(net.url("/slow")), tokens: [fetchToken(net.origin)] });
    assert.equal(result.ok, true, String(result.error));
    await result.open({ index: 2, fabric: { Data: {} } });
    const started = await until(async () => (await net.seen()).some((record) => record.path === "/slow"));
    assert(started, "the test server never saw the request");
    await result.close(1);
    const record = await until(async () => (await net.seen()).find((item) => item.path === "/slow" && (item.aborted || item.completed)), 4000);
    await sleep(100);
    const events = fetchEvents(result);
    const notified = result.logEntries.filter((entry) => entry.text === "notified");
    await result.shutdown();
    assert(record, "the test server saw the request neither end nor go away");
    assert.equal(record.aborted, true, "the request in flight was not aborted at Close");
    assert.deepEqual(events.map((item) => item.attachment), [], "a fetch result reached the guest after Close");
    assert.deepEqual(notified.map((entry) => entry.attachment), [], "Notify ran after Close");
  } },

  { id: "grant-live", says: "A grant changes while the extension runs: an added origin token lets the next fetch through at once; a withdrawn one makes the next fetch return -2 and aborts the attachment's requests in flight", async run({ loadExtension, net }) {
    await net.reset();
    const token = fetchToken(net.origin);
    const bytes = UE.ueFetcher({ every: 250 });
    const result = await loadExtension({
      bytes, declaration: await ue2Declare(bytes, "polling-fetcher.wasm", [...UE_ALL, token]), grant: UE_ALL,
      attachment: { index: 1, fabric: { Data: { fetch: fetchRequest(net.url("/slow")) } } }, fetch: net && net.fetch,
    });
    assert.equal(result.ok, true, String(result.error));
    const fetchLines = () => result.log.filter((line) => line.startsWith("fetch "));
    try {
      assert.equal(typeof result.setGrant, "function", "the extension has no setGrant");
      await until(() => fetchLines().length >= 2, 3000);
      assert.deepEqual([...new Set(fetchLines())], ["fetch -2"], `before the grant, the fetches returned ${show(fetchLines())}`);
      assert.equal((await net.seen()).length, 0, "the test server saw a request before the grant");
      // Allow: the origin token joins the grant while the extension runs.
      const allowedAt = fetchLines().length;
      const allowed = await result.setGrant(1, [...UE_ALL, token]);
      assert(allowed && allowed.ok, `setGrant returned ${show(allowed)}`);
      const through = await until(() => fetchLines().slice(allowedAt).some((line) => /^fetch [1-9]\d*$/.test(line)), 3000);
      assert(through, `after the grant was added, no fetch went through without a reload: ${show(fetchLines().slice(allowedAt))}`);
      const inFlight = await until(async () => (await net.seen()).some((record) => record.path === "/slow" && !record.completed && !record.aborted), 3000);
      assert(inFlight, "no request was in flight before the withdrawal");
      // Withdraw: the next call returns -2 and the requests in flight are aborted.
      const withdrawnAt = fetchLines().length;
      const withdrawn = await result.setGrant(1, UE_ALL);
      assert(withdrawn && withdrawn.ok, `setGrant returned ${show(withdrawn)}`);
      await sleep(50);
      const resultsAt = fetchEvents(result).length;
      await until(() => fetchLines().length >= withdrawnAt + 3, 3000);
      await sleep(1700);
      const after = fetchLines().slice(withdrawnAt);
      const seen = await net.seen();
      assert(after.length > 0, "the fetcher made no call after the withdrawal");
      assert.deepEqual([...new Set(after)], ["fetch -2"], `after the withdrawal the fetches returned ${show(after)}; the withdrawal was not applied without a reload`);
      const slow = seen.filter((record) => record.path === "/slow");
      assert(slow.some((record) => record.aborted), `no request in flight was aborted at the withdrawal: ${show(slow)}`);
      assert.equal(fetchEvents(result).length, resultsAt, "a fetch result reached the guest after the withdrawal");
    } finally {
      await result.shutdown();
    }
  } },

  // ---- ue:host@0.2.0: storage ----

  { id: "storage-partition", says: "Two placements of the same module do not see each other's keys; one placement keeps its keys across loads and world URL queries", async run({ loadExtension }) {
    const storage = memoryStorage();
    const world = "https://worlds.example.org/world.json";
    const first = await loadStorageUser(loadExtension, { storage, world: `${world}?a=1#top`, node: "7", data: { set: { key: "note", value: "value-one" } } });
    assert.equal(first.ok, true, String(first.error));
    await first.shutdown();
    assert.deepEqual(first.log, ["get -4", "set 0", "value-one"], "the first placement's calls");
    const other = await loadStorageUser(loadExtension, { storage, world, node: "8", data: { set: { key: "note", value: "value-two" } } });
    assert.equal(other.ok, true, String(other.error));
    await other.shutdown();
    assert.deepEqual(other.log, ["get -4", "set 0", "value-two"], "the second placement saw the first placement's key");
    const again = await loadStorageUser(loadExtension, { storage, world: `${world}?b=2`, node: "7", data: { delete: { key: "note" } } });
    assert.equal(again.ok, true, String(again.error));
    await again.shutdown();
    assert.deepEqual(again.log, ["value-one", "delete 0", "get -4"], "the first placement, loaded again");
    assert.deepEqual(storage.keys().filter((key) => !key.startsWith(STORAGE_PREFIX)), [], "storage outside the ue-storage: prefix");
  } },

  { id: "storage-quota", says: "A write past 256 KiB for one placement returns -5, and the stored data is unchanged", async run({ loadExtension }) {
    const storage = memoryStorage();
    const place = { storage, world: "https://worlds.example.org/world.json", node: "3" };
    const first = await loadStorageUser(loadExtension, { ...place, data: { set: { key: "note", value: "kept" } } });
    assert.equal(first.ok, true, String(first.error));
    await first.shutdown();
    assert.deepEqual(first.log, ["get -4", "set 0", "kept"], "the small write");
    const before = storage.snapshot();
    const big = await loadStorageUser(loadExtension, { ...place, data: { set: { key: "note", value: "x".repeat(256 * 1024) } } });
    assert.equal(big.ok, true, String(big.error));
    await big.shutdown();
    assert.deepEqual(big.log, ["kept", "set -5", "kept"], "a write past 256 KiB");
    assert.equal(storage.snapshot(), before, "the stored data changed after the refused write");
  } },
];
