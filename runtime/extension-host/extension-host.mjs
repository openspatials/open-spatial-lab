// The extension host core: checks, sandboxes and runs one WebAssembly extension in its own worker. Pure JavaScript,
// no DOM. It reads a plain JSON declaration (module, interface, attach, requests, limits); reading one out of a
// manifest is a separate adapter.
//
// In order: the SHA-256 of the bytes against declaration.module.integrity, before compiling; compile; every import
// against the binding, refusing and naming any import the binding does not define; the memory section, refusing an
// initial size over the memory budget; a maximum-pages cap written into the bytes the worker compiles; the worker.
// Then Init (with _initialize first when the module exports it) and the first attachment's Open. A binding may run its
// own lifecycle in the worker (ue-core/0 does); its timers are kept here, and a due timer goes to its own attachment's
// Notify under the per-event budget. A binding may also have a host side (createHostServices: ue-core/0's network
// requests and storage backend), which runs here, with the fetch and the storage backend this host is given, and hands
// its events (fetch results) to one attachment's Notify the same way. Lifecycle calls and events run one at a time.
//
// The page may change an attachment's grant while the extension runs (setGrant: the user allowed or withdrew a token)
// and hand an attachment an event of its own (notify: a pointer event). A grant change reaches the worker at once, so
// the next call is checked against it, and the attachment's requests in flight whose token is no longer granted are
// aborted, their results dropped.
//
// The same host runs in Node and in a web page. The sandbox adapter is chosen here and loaded with a dynamic import,
// so a page never fetches the Node one: sandbox-web.mjs (a module Web Worker) when globalThis.Worker exists and
// `process` does not, sandbox-node.mjs (worker_threads) otherwise. Both run sandbox-guest.mjs inside the worker.
import { grantTokens } from "./capabilities.mjs";

const PAGE_BYTES = 65536;
const MIB = 1024 * 1024;

/** Bindings by name: each defines the imports an extension may have and builds them inside the worker. */
const BINDINGS = Object.freeze({
  "rp1-sneeze-call": new URL("./bindings/rp1-sneeze-call.mjs", import.meta.url).href,
  "ue-core/0": new URL("./bindings/ue-core.mjs", import.meta.url).href,
});

/** Sandbox adapters by name. */
const SANDBOXES = Object.freeze({
  node: new URL("./sandbox-node.mjs", import.meta.url).href,
  web: new URL("./sandbox-web.mjs", import.meta.url).href,
});

/** The adapter for this environment: "web" in a page (a Worker and no process), "node" otherwise. */
export function defaultSandbox() {
  return typeof globalThis.Worker === "function" && typeof globalThis.process === "undefined" ? "web" : "node";
}

/** The host's budgets. A declaration's limits may lower them, never raise them. */
export const DEFAULT_BUDGETS = Object.freeze({ initMs: 500, eventMs: 20, memoryBytes: 16 * MIB, startMs: 5000 });

const oneLine = (error) => String((error && error.message) || error).replace(/\s+/g, " ").trim();
const mib = (bytes) => `${Math.round((bytes / MIB) * 100) / 100} MiB`;

function toBytes(bytes) {
  if (bytes instanceof Uint8Array) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  throw new TypeError("bytes must be a Uint8Array or an ArrayBuffer");
}

/** `sha256-<base64>`, the Subresource Integrity form of the module's SHA-256. */
export async function integrityOf(bytes) {
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return `sha256-${btoa(binary)}`;
}

// ---- The module's sections, read without compiling ----

// Multiply-based LEB128 so a hostile 5-byte count cannot overflow a 32-bit shift.
function uleb(code, at) {
  let value = 0, shift = 0, byte, read = 0;
  do {
    if (at + read >= code.length) throw new Error("module ends inside a number");
    byte = code[at + read++];
    value += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  } while (byte & 0x80);
  return { value, read };
}

function encodeUleb(value) {
  const out = [];
  do {
    let byte = value % 128;
    value = Math.floor(value / 128);
    if (value) byte |= 0x80;
    out.push(byte);
  } while (value);
  return out;
}

function* sections(code) {
  if (code.length < 8 || code[0] !== 0x00 || code[1] !== 0x61 || code[2] !== 0x73 || code[3] !== 0x6d) throw new Error("not a WebAssembly module");
  let at = 8;
  while (at < code.length) {
    const id = code[at];
    const size = uleb(code, at + 1);
    const start = at + 1 + size.read;
    const end = start + size.value;
    if (end > code.length) throw new Error("a section runs past the end of the module");
    yield { id, at, start, end };
    at = end;
  }
}

function memoryEntries(code, start) {
  const count = uleb(code, start);
  let at = start + count.read;
  const entries = [];
  for (let i = 0; i < count.value; i += 1) {
    const flags = code[at++];
    const min = uleb(code, at);
    at += min.read;
    let max = null;
    if (flags & 0x01) {
      const read = uleb(code, at);
      at += read.read;
      max = read.value;
    }
    entries.push({ flags, min: min.value, max });
  }
  return entries;
}

/** The memories a module defines (section 5), in 64 KiB pages: [{ flags, min, max }]. */
export function readMemorySection(code) {
  for (const section of sections(code)) if (section.id === 5) return { entries: memoryEntries(code, section.start) };
  return { entries: [] };
}

/** A copy of the module whose every defined memory has a maximum of at most `maxPages`. */
export function capMemory(code, maxPages) {
  for (const section of sections(code)) {
    if (section.id !== 5) continue;
    const entries = memoryEntries(code, section.start);
    const body = [...encodeUleb(entries.length)];
    for (const entry of entries) {
      const max = entry.max === null ? maxPages : Math.min(entry.max, maxPages);
      body.push(0x01, ...encodeUleb(entry.min), ...encodeUleb(max));
    }
    const out = new Uint8Array(section.at + 1 + encodeUleb(body.length).length + body.length + (code.length - section.end));
    out.set(code.subarray(0, section.at), 0);
    out.set([5, ...encodeUleb(body.length), ...body], section.at);
    out.set(code.subarray(section.end), section.at + 1 + encodeUleb(body.length).length + body.length);
    return out;
  }
  return code;
}

// ---- Loading ----

const defines = (binding, item) => item.kind === "function" && Object.hasOwn(binding.IMPORTS, item.module) && binding.IMPORTS[item.module].includes(item.name);

function budgetsFor(budgets, limits) {
  const out = { ...DEFAULT_BUDGETS };
  for (const name of Object.keys(DEFAULT_BUDGETS)) {
    if (Number.isFinite(budgets[name]) && budgets[name] > 0) out[name] = budgets[name];
    if (limits && Number.isFinite(limits[name]) && limits[name] > 0) out[name] = Math.min(out[name], limits[name]);
  }
  return out;
}

function requestedTokens(requests) {
  const list = Array.isArray(requests) ? requests : [];
  return new Set(list.map((item) => (typeof item === "string" ? item : item && item.capability)).filter(Boolean));
}

function snapshotFor(declaration, attachment) {
  return JSON.stringify({
    Resource: { qwResource: String(attachment.index), sName: String(attachment.name || ""), sReference: String(attachment.reference || declaration.module.url || "") },
    Container: { sContainer: String(attachment.container || ""), eTrust: 0 },
    Signature: { sAlgorithm: "", bSignatureValid: false, bChainTrusted: false, bChainExpired: false },
    Agent: { sBrowser_Name: "Open Spatial Lab", sEngine_Name: "extension-host", sPlatform: "", sLanguage: "" },
    Modules: [{ sUrl: String(declaration.module.url || ""), sHash: String(declaration.module.integrity || "") }],
  });
}

/** The most recent Notify events an extension keeps in `events`. */
const KEPT_EVENTS = 100;

/**
 * Loads one extension and opens its first attachment ({ index, fabric, pose, placement }, where fabric.Data is the tree
 * DATA and NODE_MAP_DATA read, pose is optional, and placement { world, node } names where it is placed, for its
 * storage). Resolves, never rejects, to the extension: { ok, error, stage, binding, log, logEntries, nodes, refusals,
 * calls, events, memoryBytes, budgetExceeded, callMs, open(attachment), close(index), shutdown(), sandbox,
 * sandboxScope, running, setGrant(index, grant), grantOf(index), notify(index, event) }. logEntries are the log lines
 * with the attachment each came from; events are the Notify events
 * handed to the module ({ attachment, event }, the last 100). `stage` names where a refusal or failure happened:
 * declaration, integrity, compile, imports, memory, worker, init or open. `sandbox` ("node" or "web") overrides the
 * adapter defaultSandbox() chooses; sandboxScope is the kind of global the guest reported from inside the worker.
 * `fetch` makes the extension's network requests (the global fetch by default) and `storage` holds its storage (an
 * object with the localStorage interface; kept in memory by default).
 *
 * setGrant(index, grant) replaces one open attachment's grant (cut down to what the declaration requests, like the
 * first one) while the extension runs and resolves { ok, error, grant }. notify(index, event) hands one open attachment
 * a Notify event from the page; it resolves once the event has run. `running` is true while the worker runs and an
 * attachment is open.
 */
export async function loadExtension({ bytes, declaration, grant = [], budgets = {}, attachment = { index: 1, fabric: { Data: {} } }, sandbox: sandboxKind, fetch: fetchImpl, storage } = {}) {
  const nodes = new Map();
  const attachments = new Set();
  const timers = new Map();
  let sandbox = null;
  let services = null;
  let limits = DEFAULT_BUDGETS;
  let queue = Promise.resolve();
  let requested = new Set();
  let firstGrant = [];
  const grants = new Map();

  const extension = {
    ok: false, error: null, stage: null, binding: null, sandbox: null, sandboxScope: null, log: [], logEntries: [], refusals: [], calls: [], events: [], memoryBytes: 0, budgetExceeded: false, callMs: null,
    get nodes() { return [...nodes.values()].map((node) => ({ ...node })); },
    get running() { return !!sandbox && !sandbox.ended && attachments.size > 0; },
    open: (next) => openAttachment(next),
    close: (index) => closeAttachment(index),
    async shutdown() { for (const index of [...attachments]) await closeAttachment(index); },
    setGrant: async (index, next) => setGrant(index, next),
    grantOf: (index) => [...(grants.get(index) || firstGrant)],
    notify: (index, event) => deliver(index, event),
  };
  const fail = (stage, error) => {
    extension.ok = false;
    extension.stage = stage;
    extension.error = error;
    return extension;
  };
  const onEvent = (event) => {
    if (event.kind === "log") {
      extension.log.push(event.text);
      extension.logEntries.push({ attachment: event.attachment, text: event.text });
    }
    else if (event.kind === "refusal") extension.refusals.push({ token: event.token, call: event.call, result: event.result });
    else if (event.kind === "call") extension.calls.push(event.name);
    else if (event.kind === "node") nodes.set(event.node.composed, event.node);
    else if (event.kind === "node-update" && nodes.has(event.composed)) Object.assign(nodes.get(event.composed), event.fields);
    else if (event.kind === "node-remove") for (const composed of event.composed) nodes.delete(composed);
    else if (event.kind === "timer-set") setTimer(event);
    else if (event.kind === "timer-clear") clearTimer(event.timer);
    else if (event.kind === "notify") {
      extension.events.push({ attachment: event.attachment, event: event.event });
      if (extension.events.length > KEPT_EVENTS) extension.events.shift();
    } else if (services) services.onEvent(event);
  };
  const releaseAttachment = (forIndex) => {
    for (const [composed, node] of nodes) if (node.attachment === forIndex) nodes.delete(composed);
  };
  // One call at a time: a due timer can fire while another call runs.
  const serial = (task) => {
    const next = queue.then(task);
    queue = next.catch(() => {});
    return next;
  };
  const runNow = async (op, args, budgetMs) => {
    const result = await sandbox.call(op, args, budgetMs);
    extension.memoryBytes = Math.max(extension.memoryBytes, result.memoryBytes || 0);
    if (result.budgetExceeded) {
      extension.budgetExceeded = true;
      extension.callMs = result.callMs;
    }
    if (sandbox.ended) {
      clearTimers();
      if (services) services.closeAll();
    }
    return result;
  };
  const run = (op, args, budgetMs) => serial(() => runNow(op, args, budgetMs));

  // A host-side event for one attachment (a fetch result): to its Notify, while it is open.
  const deliver = (index, event) => serial(async () => {
    if (!sandbox || sandbox.ended || !attachments.has(index)) return;
    await runNow("notify", { index, event }, limits.eventMs);
  });

  // A grant change for one open attachment, at once: the worker checks the next call against it, and the requests in
  // flight whose token it no longer names are aborted.
  function setGrant(index, next) {
    if (!sandbox || sandbox.ended || !attachments.has(index)) return { ok: false, error: `attachment ${index} is not open` };
    const tokens = [...grantTokens(next)].filter((token) => requested.has(token));
    grants.set(index, new Set(tokens));
    sandbox.setGrant(index, tokens);
    if (services && typeof services.revoke === "function") services.revoke(index, (token) => tokens.includes(token));
    return { ok: true, error: null, grant: tokens };
  }

  // Timers, set by the binding in the worker. Each is owned by the attachment that set it.
  function clearTimer(id) {
    const timer = timers.get(id);
    if (!timer) return;
    clearTimeout(timer.handle);
    clearInterval(timer.handle);
    timers.delete(id);
  }
  function clearTimers(forIndex) {
    for (const [id, timer] of timers) if (forIndex === undefined || timer.attachment === forIndex) clearTimer(id);
  }
  function setTimer({ attachment: owner, timer: id, delayMs, repeat }) {
    if (!attachments.has(owner) || timers.has(id)) return;
    const due = () => fire(id);
    const handle = repeat ? setInterval(due, Math.max(1, delayMs)) : setTimeout(due, delayMs);
    if (handle && typeof handle.unref === "function") handle.unref();
    timers.set(id, { attachment: owner, repeat, handle });
  }
  function fire(id) {
    serial(async () => {
      const timer = timers.get(id);
      if (!timer || !sandbox || sandbox.ended) return;
      if (!timer.repeat) timers.delete(id);
      // A due timer goes only to the attachment that set it.
      const targets = [timer.attachment];
      for (const index of targets) await runNow("notify", { index, timer: id }, limits.eventMs);
    });
  }

  async function openAttachment(next) {
    if (!sandbox || sandbox.ended) return { ok: false, error: "the extension is not running" };
    const index = Number(next && next.index);
    if (!Number.isSafeInteger(index) || index <= 0 || attachments.has(index)) return { ok: false, error: `attachment index ${next && next.index} is not new` };
    attachments.add(index);
    const result = await run("open", {
      index, fabric: next.fabric || { Data: {} }, snapshot: snapshotFor(declaration, next),
      declaration, attachment: { index, pose: next.pose || null }, ...(services ? services.openArgs(index, next) : {}),
    }, limits.eventMs);
    if (!result.ok) {
      if (services) services.closeAttachment(index);
      attachments.delete(index);
      releaseAttachment(Number(next.index));
      if (sandbox.ended) fail("open", result.error);
    }
    return { ok: result.ok, error: result.error };
  }
  async function closeAttachment(index) {
    if (!sandbox || !attachments.has(index)) return { ok: false, error: `attachment ${index} is not open` };
    const result = await serial(async () => {
      if (services) services.closeAttachment(index);
      const closed = await runNow("close", { index }, limits.eventMs);
      clearTimers(index);
      return closed;
    });
    attachments.delete(index);
    grants.delete(index);
    releaseAttachment(index);
    if (attachments.size === 0 && !sandbox.ended) {
      await run("shutdown", {}, limits.eventMs);
      sandbox.terminate();
      clearTimers();
    }
    return { ok: result.ok, error: result.error };
  }

  // The declaration.
  if (!declaration || typeof declaration !== "object" || !declaration.module || typeof declaration.module.integrity !== "string") {
    return fail("declaration", "the declaration has no module.integrity");
  }
  const bindingUrl = BINDINGS[declaration.module.binding];
  if (!bindingUrl) return fail("declaration", `no binding named ${declaration.module.binding}`);
  let code;
  try {
    code = toBytes(bytes);
  } catch (error) {
    return fail("declaration", oneLine(error));
  }
  limits = budgetsFor(budgets || {}, declaration.limits);

  // 1. Integrity, before compiling.
  const digest = await integrityOf(code);
  if (digest !== declaration.module.integrity) {
    return fail("integrity", `the SHA-256 of the module does not match module.integrity (${digest})`);
  }

  // 2. Compile.
  let module;
  try {
    module = await WebAssembly.compile(code);
  } catch (error) {
    return fail("compile", `compile: ${oneLine(error)}`);
  }

  // 3. Imports: every one must be defined by the binding.
  const binding = await import(bindingUrl);
  extension.binding = binding.NAME;
  const interfaces = binding.INTERFACES || [binding.INTERFACE];
  if (declaration.interface !== undefined && !interfaces.includes(declaration.interface)) {
    return fail("declaration", `interface ${declaration.interface} is not ${interfaces.join(" or ")}, the interface${interfaces.length > 1 ? "s" : ""} of binding ${binding.NAME}`);
  }
  const wanted = WebAssembly.Module.imports(module);
  const unknown = wanted.filter((item) => !defines(binding, item));
  if (unknown.length) {
    return fail("imports", `refused: imports the binding ${binding.NAME} does not define: ${unknown.map((item) => `${item.module}.${item.name}`).join(", ")}`);
  }

  // 4. Memory: refuse an initial size over budget, then cap the maximum.
  const budgetPages = Math.floor(limits.memoryBytes / PAGE_BYTES);
  const memory = readMemorySection(code);
  for (const entry of memory.entries) {
    if (entry.flags & ~0x01) return fail("memory", `refused: memory flags ${entry.flags} (shared or 64-bit memory) are not supported`);
    if (entry.min > budgetPages) {
      return fail("memory", `refused: initial memory of ${entry.min} pages (${mib(entry.min * PAGE_BYTES)}) is over the memory budget of ${mib(limits.memoryBytes)} (${budgetPages} pages)`);
    }
  }
  const capped = capMemory(code, budgetPages);

  // 5. The worker, with the grant cut down to what the declaration requests.
  const kind = sandboxKind === undefined ? defaultSandbox() : sandboxKind;
  if (!Object.hasOwn(SANDBOXES, kind)) return fail("worker", `no sandbox named ${kind}`);
  extension.sandbox = kind;
  const { startSandbox } = await import(SANDBOXES[kind]);
  requested = requestedTokens(declaration.requests);
  const tokens = [...grantTokens(grant)].filter((token) => requested.has(token));
  firstGrant = tokens;
  if (typeof binding.createHostServices === "function") {
    services = binding.createHostServices({ declaration, fetch: fetchImpl, storage, deliver, attachments: () => [...attachments] });
  }
  const started = await startSandbox({ bytes: capped, bindingUrl, grant: tokens, onEvent, startMs: limits.startMs });
  if (!started.ok) return fail("worker", started.error);
  sandbox = started.sandbox;
  extension.sandboxScope = started.scope || null;

  // 6. Init, then the first attachment.
  const init = await run("init", {}, limits.initMs);
  if (!init.ok) {
    sandbox.terminate();
    return fail("init", init.error);
  }
  const opened = await openAttachment(attachment);
  if (!opened.ok) {
    if (!sandbox.ended) sandbox.terminate();
    return fail("open", opened.error);
  }
  extension.ok = true;
  return extension;
}
