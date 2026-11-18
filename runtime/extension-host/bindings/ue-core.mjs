// The ue-core/0 binding of ue:host@0.2.0 (which also serves ue:host@0.1.0 guests): the single import
// ue.call (i32 offset, i32 size) -> i64.
//
// Every call is a packet in the extension's own memory: an 8-byte little-endian header (subsystem u16, method u16,
// size u32) and `size` bytes of UTF-8 JSON, an object keyed by the WIT parameter names (an empty payload is {}). The
// (subsystem, method) numbers, the capability token of each function and its return form come from
// ../wit/method-numbers.json. A function that returns bytes gets them through the guest's Alloc and returns
// (ptr << 32) | len; the guest frees them with its own Free.
//
// Errors: -1 unknown method, -2 capability refused, -3 bad payload, -4 not found, -5 budget exceeded (including more
// than 32 active timers or 8 requests in flight for one attachment, and a storage write past 256 KiB), -6
// unimplemented.
//
// Lifecycle (the `lifecycle` export, which the sandbox worker uses in place of its RP1 defaults): _initialize if
// exported, then Init() -> i64 (negative is a failure); Open(attachment i64, ptr, len) with the JSON
// { declaration, attachment }; Close(attachment i64); Shutdown(). Events: Notify(ptr, len) -> i64 with the JSON
// { type: "timer", attachment, timer } or { type: "fetch", attachment, request, status, headers, body, bodyEncoding,
// error? }, sent only to the attachment that set the timer or made the request.
//
// Two halves. createImports and lifecycle run in the sandbox worker: they check every call, keep the timers, the
// requests in flight and each attachment's copy of its storage, and send what needs the page out as events.
// createHostServices runs on the host's side of the worker (the page, or the Node main thread): it makes the requests
// with the fetch it is given, writes storage to the backend it is given (an object with the localStorage interface),
// and hands each fetch result to the attachment that made the request. Both are injected, so Node runs these without a
// browser; in the browser the request comes from the page, and the remote server's CORS rules apply.
import METHOD_TABLE from "../wit/method-numbers.json" with { type: "json" };
import { fetchToken, placementKey } from "../capabilities.mjs";
import { readPath, splitPath } from "./rp1-sneeze-call.mjs";

export const NAME = "ue-core/0";
export const INTERFACE = "ue:host@0.2.0";
/** Every interface version this binding serves: 0.2.0 only adds to 0.1.0. */
export const INTERFACES = Object.freeze(["ue:host@0.1.0", "ue:host@0.2.0"]);
/** The imports this binding defines: module name -> field names. */
export const IMPORTS = Object.freeze({ ue: Object.freeze(["call"]) });

export const UE_ERRORS = Object.freeze({ UNKNOWN_METHOD: -1n, REFUSED: -2n, BAD_PAYLOAD: -3n, NOT_FOUND: -4n, BUDGET: -5n, UNIMPLEMENTED: -6n });
export const MAX_TIMERS = 32;
export const MAX_REQUESTS_IN_FLIGHT = 8;
export const MAX_RESPONSE_BYTES = 1024 * 1024;
export const FETCH_TIMEOUT_MS = 10000;
export const STORAGE_QUOTA_BYTES = 256 * 1024;
export const STORAGE_PREFIX = "ue-storage:";
export const FETCH_METHODS = Object.freeze(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);
/** The response headers a fetch result passes on; every other header is dropped. */
export const SAFE_RESPONSE_HEADERS = Object.freeze(["content-type", "content-length", "etag", "last-modified", "cache-control"]);
// Request headers an extension may not set (the browser's forbidden names, which the host sets or leaves out itself).
const FORBIDDEN_REQUEST_HEADERS = new Set(["accept-charset", "accept-encoding", "access-control-request-headers", "access-control-request-method",
  "connection", "content-length", "cookie", "cookie2", "date", "dnt", "expect", "host", "keep-alive", "origin", "referer", "te", "trailer",
  "transfer-encoding", "upgrade", "via"]);
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

const HEADER_SIZE = 8;
const NODE_CLASS = 1;
const ROOT_BASE = 2 ** 40;
const strict = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();
const IDENTITY_POSE = Object.freeze({ position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] });

class BadPayload extends Error {}
class NotFound extends Error {}

const key = (subsystem, method) => `${subsystem}:${method}`;
const pack = (ptr, len) => (BigInt(ptr) << 32n) | BigInt(len);

/** The payload as an object, or null when it is not a JSON object. */
function parsePayload(bytes) {
  if (bytes.length === 0) return {};
  let value;
  try { value = JSON.parse(strict.decode(bytes)); } catch { return null; }
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

const text = (args, name) => {
  if (typeof args[name] !== "string") throw new BadPayload(`${name} is not a string`);
  return args[name];
};
const id = (args, name) => {
  const value = typeof args[name] === "string" && /^\d+$/.test(args[name]) ? Number(args[name]) : args[name];
  if (!Number.isSafeInteger(value) || value < 0) throw new BadPayload(`${name} is not a node id`);
  return value;
};
const u32 = (args, name) => {
  const value = args[name];
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new BadPayload(`${name} is not a u32`);
  return value;
};
/** The request headers: a list of [name, value] string pairs, none of a forbidden name. */
const requestHeaders = (args) => {
  const list = args.headers === undefined || args.headers === null ? [] : args.headers;
  if (!Array.isArray(list)) throw new BadPayload("headers is not a list");
  return list.map((pair) => {
    if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== "string" || typeof pair[1] !== "string") throw new BadPayload("a header is not a pair of strings");
    const name = pair[0].toLowerCase();
    if (!HEADER_NAME.test(name) || /[\r\n\0]/.test(pair[1])) throw new BadPayload(`header ${pair[0]} is not valid`);
    if (FORBIDDEN_REQUEST_HEADERS.has(name) || name.startsWith("proxy-") || name.startsWith("sec-")) throw new BadPayload(`header ${pair[0]} may not be set`);
    return [name, pair[1]];
  });
};
const utf8Bytes = (value) => encoder.encode(value).length;
/** The size of one placement's storage: the UTF-8 bytes of every key and value. */
const storageBytes = (store) => {
  let size = 0;
  for (const [key, value] of store) size += utf8Bytes(key) + utf8Bytes(value);
  return size;
};
const numbers = (args, name, count) => {
  const value = args[name];
  if (!Array.isArray(value) || value.length !== count || !value.every(Number.isFinite)) throw new BadPayload(`${name} is not ${count} numbers`);
  return [...value];
};

function poseOf(attachment) {
  const pose = attachment && attachment.pose;
  if (!pose || typeof pose !== "object") return IDENTITY_POSE;
  const pick = (name, count) => (Array.isArray(pose[name]) && pose[name].length === count && pose[name].every(Number.isFinite) ? [...pose[name]] : IDENTITY_POSE[name]);
  return { position: pick("position", 3), rotation: pick("rotation", 4), scale: pick("scale", 3) };
}

// The binding's state for one instance: per-attachment pose and storage, the active timers (id -> { attachment,
// repeat }) and the requests in flight (id -> { attachment, token }).
const states = new WeakMap();
function stateOf(host) {
  if (!states.has(host)) states.set(host, { attachments: new Map(), timers: new Map(), nextTimer: 0, requests: new Map(), nextRequest: 0 });
  return states.get(host);
}

/**
 * The import object for one instance. `host` is the sandbox's side of the call (see rp1-sneeze-call.mjs), plus
 *   exports() -> the instance exports      current() -> the attachment index of the running lifecycle call, or null
 *   emit(event)                            removeNode(composed)
 */
export function createImports(host) {
  const state = stateOf(host);
  const current = () => {
    const index = host.current();
    if (index === null || !state.attachments.has(index)) throw new NotFound("no attachment is current");
    return index;
  };
  const rootOf = (index) => ROOT_BASE + index;
  const ownedNode = (composed) => {
    const node = host.node(BigInt(composed));
    if (!node || node.attachment !== current()) throw new NotFound(`no node ${composed} in this attachment`);
    return node;
  };

  const IMPLS = {
    "console.log": (args) => {
      if (!Number.isInteger(args.level) || args.level < 0 || args.level > 255) throw new BadPayload("level is not a u8");
      host.log(host.current(), text(args, "text"));
    },
    "data.has": (args) => (readPath(host.attachment(current()) || {}, ["Data", ...splitPath(text(args, "path"))]) === undefined ? 0n : 1n),
    "data.get": (args) => {
      const value = readPath(host.attachment(current()) || {}, ["Data", ...splitPath(text(args, "path"))]);
      if (value === undefined) throw new NotFound("no such path");
      return encoder.encode(JSON.stringify(value));
    },
    "scene.attachment-root": () => BigInt(rootOf(current())),
    "scene.node-create": nodeCreate,
    "scene.node-set-transform": (args) => {
      const node = ownedNode(id(args, "node"));
      const fields = { position: numbers(args, "position", 3), rotation: numbers(args, "rotation", 4), scale: numbers(args, "scale", 3) };
      host.updateNode(BigInt(node.composed), fields);
    },
    "scene.node-set-resource": (args) => {
      const node = ownedNode(id(args, "node"));
      host.updateNode(BigInt(node.composed), { reference: text(args, "resource") });
    },
    "scene.node-remove": (args) => {
      const node = ownedNode(id(args, "node"));
      host.removeNode(BigInt(node.composed));
    },
    "scene.attachment-pose": () => encoder.encode(JSON.stringify(state.attachments.get(current()).pose)),
    "clock.wall-ms": () => BigInt(Date.now()),
    "clock.monotonic-ns": () => BigInt(Math.round(globalThis.performance.now() * 1e6)),
    "timer.set": (args) => {
      const attachment = current();
      const delayMs = args["delay-ms"];
      if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 0xffffffff) throw new BadPayload("delay-ms is not a u32");
      if (typeof args.repeat !== "boolean") throw new BadPayload("repeat is not a bool");
      const owned = [...state.timers.values()].filter((timer) => timer.attachment === attachment).length;
      if (owned >= MAX_TIMERS) return UE_ERRORS.BUDGET;
      const timer = ++state.nextTimer;
      state.timers.set(timer, { attachment, repeat: args.repeat });
      host.emit({ kind: "timer-set", attachment, timer, delayMs, repeat: args.repeat });
      return BigInt(timer);
    },
    "timer.clear": (args) => {
      const timer = args.id;
      if (!Number.isInteger(timer) || timer < 0 || timer > 0xffffffff) throw new BadPayload("id is not a u32");
      const owned = state.timers.get(timer);
      if (!owned || owned.attachment !== current()) throw new NotFound(`no timer ${timer} in this attachment`);
      state.timers.delete(timer);
      host.emit({ kind: "timer-clear", timer });
    },
    "network.fetch": (args, entry) => {
      const attachment = current();
      const url = text(args, "url");
      const token = fetchToken(url);
      if (token === null) throw new BadPayload("url is not an http(s) URL without credentials");
      if (!host.allows(token)) return host.refuse(token, entry.wit, UE_ERRORS.REFUSED);
      const method = text(args, "method");
      if (!FETCH_METHODS.includes(method)) throw new BadPayload(`method ${method} is not one of ${FETCH_METHODS.join(", ")}`);
      const headers = requestHeaders(args);
      const body = args.body === undefined || args.body === null ? null : text(args, "body");
      if (body !== null && (method === "GET" || method === "HEAD")) throw new BadPayload(`a ${method} request has no body`);
      const inFlight = [...state.requests.values()].filter((request) => request.attachment === attachment).length;
      if (inFlight >= MAX_REQUESTS_IN_FLIGHT) return UE_ERRORS.BUDGET;
      const request = ++state.nextRequest;
      state.requests.set(request, { attachment, token });
      host.emit({ kind: "fetch", attachment, request, url: new URL(url).href, method, headers, body });
      return BigInt(request);
    },
    "network.abort": (args, entry) => {
      const request = u32(args, "id");
      const owned = state.requests.get(request);
      if (!owned || owned.attachment !== current()) throw new NotFound(`no request ${request} in this attachment`);
      if (!host.allows(owned.token)) return host.refuse(owned.token, entry.wit, UE_ERRORS.REFUSED);
      state.requests.delete(request);
      host.emit({ kind: "fetch-abort", request });
    },
    "storage.get": (args) => {
      const store = storeOf(current());
      const key = text(args, "key");
      if (!store.has(key)) throw new NotFound("no such key");
      return encoder.encode(store.get(key));
    },
    "storage.set": (args) => {
      const attachment = current();
      const store = storeOf(attachment);
      const key = text(args, "key"), value = text(args, "value");
      const size = storageBytes(store) - (store.has(key) ? utf8Bytes(key) + utf8Bytes(store.get(key)) : 0) + utf8Bytes(key) + utf8Bytes(value);
      if (size > STORAGE_QUOTA_BYTES) return UE_ERRORS.BUDGET;
      store.set(key, value);
      host.emit({ kind: "storage-set", attachment, key, value });
    },
    "storage.delete": (args) => {
      const attachment = current();
      const store = storeOf(attachment);
      const key = text(args, "key");
      if (!store.has(key)) throw new NotFound("no such key");
      store.delete(key);
      host.emit({ kind: "storage-delete", attachment, key });
    },
  };
  const storeOf = (attachment) => state.attachments.get(attachment).storage;

  function nodeCreate(args) {
    const attachment = current();
    const parent = id(args, "parent");
    const name = text(args, "name"), kind = text(args, "kind");
    const resource = args.resource === undefined || args.resource === null ? "" : text(args, "resource");
    if (parent !== rootOf(attachment)) ownedNode(parent);
    const composed = host.createNode({ attachment, parent: BigInt(parent), class: NODE_CLASS, index: null, name, reference: resource });
    host.updateNode(composed, { kind });
    return composed;
  }

  const METHODS = new Map(METHOD_TABLE.methods.map((entry) => [key(entry.subsystem, entry.method), { ...entry, impl: IMPLS[entry.wit] }]));

  const writeBytes = (bytes) => {
    const alloc = host.exports() && host.exports().Alloc;
    if (typeof alloc !== "function") return UE_ERRORS.UNIMPLEMENTED;
    const ptr = alloc(bytes.length) >>> 0;
    const memory = host.memory();
    if (ptr === 0 || !memory || ptr + bytes.length > memory.buffer.byteLength) return UE_ERRORS.BAD_PAYLOAD;
    new Uint8Array(memory.buffer, ptr, bytes.length).set(bytes);
    return pack(ptr, bytes.length);
  };

  return {
    ue: {
      call(offset, size) {
        offset >>>= 0;
        size >>>= 0;
        const memory = host.memory();
        if (!memory || size < HEADER_SIZE || offset + size > memory.buffer.byteLength) return UE_ERRORS.BAD_PAYLOAD;
        const view = new DataView(memory.buffer, offset, HEADER_SIZE);
        const entry = METHODS.get(key(view.getUint16(0, true), view.getUint16(2, true)));
        if (!entry) return UE_ERRORS.UNKNOWN_METHOD;
        if (!entry.impl) return UE_ERRORS.UNIMPLEMENTED;
        // A per-origin token (network) is checked by the function, against the origin of the request.
        const perOrigin = entry.token.endsWith(":<origin>");
        if (!perOrigin && !host.allows(entry.token)) return host.refuse(entry.token, entry.wit, UE_ERRORS.REFUSED);
        const length = view.getUint32(4, true);
        if (HEADER_SIZE + length > size) return UE_ERRORS.BAD_PAYLOAD;
        const args = parsePayload(new Uint8Array(memory.buffer, offset + HEADER_SIZE, length));
        if (args === null) return UE_ERRORS.BAD_PAYLOAD;
        let result;
        try {
          result = entry.impl(args, entry);
        } catch (error) {
          if (error instanceof BadPayload) return UE_ERRORS.BAD_PAYLOAD;
          if (error instanceof NotFound) return UE_ERRORS.NOT_FOUND;
          throw error;
        }
        if (typeof result === "bigint" && result < 0n) return result;
        if (entry.returns === "bytes") return writeBytes(result);
        if (entry.returns === "scalar") return result;
        return 0n;
      },
    },
  };
}

// ---- Lifecycle ----

/** Writes `json` into guest memory through Alloc and calls `fn(ptr, len)`, then Free. */
function withPayload({ exports, memory }, json, fn) {
  if (typeof exports.Alloc !== "function") throw new Error("the module exports no Alloc");
  const bytes = encoder.encode(JSON.stringify(json));
  const ptr = exports.Alloc(bytes.length) >>> 0;
  const buffer = memory();
  if (!buffer || ptr === 0 || ptr + bytes.length > buffer.buffer.byteLength) throw new Error(`Alloc returned ${ptr}, outside memory`);
  new Uint8Array(buffer.buffer, ptr, bytes.length).set(bytes);
  try {
    return fn(ptr, bytes.length);
  } finally {
    if (typeof exports.Free === "function") exports.Free(ptr, bytes.length);
  }
}

const required = (exports, name) => {
  if (typeof exports[name] !== "function") throw new Error(`the module exports no ${name}`);
  return exports[name];
};

/** The lifecycle the sandbox worker runs for this binding. Each call gets { exports, host, record, memory }. */
export const lifecycle = Object.freeze({
  init({ exports, record }) {
    if (typeof exports._initialize === "function") {
      record("_initialize");
      exports._initialize();
    }
    record("Init");
    const result = required(exports, "Init")();
    if (typeof result !== "bigint") throw new Error("Init does not return an i64");
    if (result < 0n) throw new Error(`Init returned ${result}`);
  },
  open(context, { index, declaration, attachment, storage }) {
    const { exports, host, record } = context;
    const state = stateOf(host);
    state.attachments.set(index, { pose: poseOf(attachment), storage: storageEntries(storage) });
    const open = required(exports, "Open");
    record(`Open ${index}`);
    try {
      withPayload(context, { declaration, attachment: { index, pose: state.attachments.get(index).pose } }, (ptr, len) => open(BigInt(index), ptr, len));
    } catch (error) {
      state.attachments.delete(index);
      throw error;
    }
  },
  close({ exports, host, record }, { index }) {
    const state = stateOf(host);
    record(`Close ${index}`);
    try {
      if (typeof exports.Close === "function") exports.Close(BigInt(index));
    } finally {
      for (const [timer, owner] of state.timers) if (owner.attachment === index) state.timers.delete(timer);
      for (const [request, owner] of state.requests) if (owner.attachment === index) state.requests.delete(request);
      state.attachments.delete(index);
    }
  },
  shutdown({ exports, record }) {
    record("Shutdown");
    if (typeof exports.Shutdown === "function") exports.Shutdown();
  },
  // A grant change for one attachment (setGrant): its requests whose token is no longer granted leave the in-flight
  // count; the host's side has aborted them and drops their results.
  grant({ host }, { index }) {
    const state = stateOf(host);
    for (const [request, owner] of state.requests) if (owner.attachment === index && !host.allowsFor(index, owner.token)) state.requests.delete(request);
  },
  notify(context, { index, timer, event }) {
    const state = stateOf(context.host);
    const notify = required(context.exports, "Notify");
    let payload;
    if (event) {
      // A host event (a fetch result): the request is no longer in flight.
      if (event.type === "fetch") state.requests.delete(event.request);
      payload = { ...event, attachment: index };
    } else {
      const owner = state.timers.get(timer);
      if (owner && !owner.repeat) state.timers.delete(timer);
      payload = { type: "timer", attachment: index, timer };
    }
    context.host.emit({ kind: "notify", attachment: index, event: payload });
    const result = withPayload(context, payload, (ptr, len) => notify(ptr, len));
    if (typeof result === "bigint" && result < 0n) throw new Error(`Notify returned ${result}`);
  },
});

/** The storage entries an Open brings ({ key: value } of strings) as a Map. */
function storageEntries(entries) {
  const store = new Map();
  if (entries && typeof entries === "object") for (const [key, value] of Object.entries(entries)) if (typeof value === "string") store.set(key, value);
  return store;
}

// ---- The host's side: requests and the storage backend ----

class FetchFailed extends Error {
  constructor(code, status = 0) {
    super(`fetch failed: ${code}`);
    this.code = code;
    this.status = status;
  }
}

/** A storage backend with the localStorage interface, kept in memory: the default when none is given. */
export function memoryStorage() {
  const items = new Map();
  return {
    getItem: (key) => (items.has(key) ? items.get(key) : null),
    setItem: (key, value) => { items.set(key, String(value)); },
    removeItem: (key) => { items.delete(key); },
  };
}

const TEXT_TYPE = /^text\/|[/+](?:json|xml)(?:;|$)|javascript|x-www-form-urlencoded/i;
const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

function base64(bytes) {
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary);
}

/** The body as text when its type is textual and it is UTF-8, otherwise as base64. */
function encodeBody(bytes, type) {
  if (TEXT_TYPE.test(type || "")) {
    try { return { body: strictUtf8.decode(bytes), bodyEncoding: "text" }; } catch { /* not UTF-8: base64 */ }
  }
  return { body: base64(bytes), bodyEncoding: "base64" };
}

/** The response body, refused (-5) once it is over MAX_RESPONSE_BYTES. */
async function readCapped(response) {
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_RESPONSE_BYTES) throw new FetchFailed(UE_ERRORS.BUDGET);
      chunks.push(value);
    }
  } catch (error) {
    reader.cancel().catch(() => {});
    throw error;
  }
  const bytes = new Uint8Array(received);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}

/**
 * The host's side of the binding for one extension. `fetch` makes the requests (the page's fetch by default), `storage`
 * holds each placement's storage under STORAGE_PREFIX (memoryStorage() by default), `deliver(index, event)` hands an
 * event to one attachment's Notify, `attachments()` lists the open attachments.
 */
export function createHostServices({ declaration, fetch: doFetch = (...args) => globalThis.fetch(...args), storage = memoryStorage(), deliver, attachments }) {
  const requests = new Map();
  const partitions = new Map();

  function storageKeyFor(placement) {
    return STORAGE_PREFIX + placementKey({ world: placement.world, node: placement.node, integrity: declaration.module.integrity, attach: declaration.attach });
  }
  function readPartition(key) {
    try {
      const value = JSON.parse(storage.getItem(key) || "{}");
      return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    } catch {
      return {};
    }
  }
  function writePartition(index, change) {
    const key = partitions.get(index);
    if (key === undefined) return;
    const entries = readPartition(key);
    change(entries);
    try {
      if (Object.keys(entries).length) storage.setItem(key, JSON.stringify(entries));
      else storage.removeItem(key);
    } catch { /* the backend refused the write; the extension's copy keeps the value for this run */ }
  }

  async function perform(request) {
    const { controller } = request;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, FETCH_TIMEOUT_MS);
    try {
      const init = {
        method: request.method,
        headers: request.headers,
        credentials: "omit",
        redirect: "manual",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        signal: controller.signal,
      };
      if (request.body !== null) init.body = request.body;
      const response = await doFetch(request.url, init);
      // redirect: "manual" gives an opaque redirect in a browser and the 3xx response itself in Node.
      if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
        if (response.body) response.body.cancel().catch(() => {});
        throw new FetchFailed(UE_ERRORS.NOT_FOUND, response.status);
      }
      let bytes;
      try {
        bytes = await readCapped(response);
      } catch (error) {
        if (error instanceof FetchFailed) error.status = response.status;
        throw error;
      }
      const headers = SAFE_RESPONSE_HEADERS.filter((name) => response.headers.get(name) !== null).map((name) => [name, response.headers.get(name)]);
      return { status: response.status, headers, ...encodeBody(bytes, response.headers.get("content-type")) };
    } catch (error) {
      if (!controller.signal.aborted) controller.abort();
      const code = error instanceof FetchFailed ? error.code : timedOut ? UE_ERRORS.BUDGET : UE_ERRORS.NOT_FOUND;
      return { status: (error && error.status) || 0, headers: [], body: "", bodyEncoding: "text", error: Number(code) };
    } finally {
      clearTimeout(timer);
    }
  }

  async function start(event) {
    const request = { attachment: event.attachment, controller: new AbortController(), method: event.method, url: event.url, headers: event.headers, body: event.body };
    requests.set(event.request, request);
    const result = await perform(request);
    // A request aborted by the extension or by its attachment's Close is no longer listed: its result is dropped.
    if (requests.get(event.request) !== request) return;
    requests.delete(event.request);
    const targets = [request.attachment];
    for (const index of targets) deliver(index, { type: "fetch", attachment: index, request: event.request, ...result });
  }

  return {
    /** The extra Open arguments of an attachment: its placement's storage. */
    openArgs(index, attachment) {
      const placement = (attachment && attachment.placement) || {};
      const key = storageKeyFor({ world: placement.world || "", node: placement.node === undefined ? String(index) : placement.node });
      partitions.set(index, key);
      return { storage: readPartition(key) };
    },
    /** Handles one event of the binding from the worker; false when it is not one of these. */
    onEvent(event) {
      if (event.kind === "fetch") start(event);
      else if (event.kind === "fetch-abort") {
        const request = requests.get(event.request);
        if (request) {
          requests.delete(event.request);
          request.controller.abort();
        }
      } else if (event.kind === "storage-set") writePartition(event.attachment, (entries) => { entries[event.key] = event.value; });
      else if (event.kind === "storage-delete") writePartition(event.attachment, (entries) => { delete entries[event.key]; });
      else return false;
      return true;
    },
    /** Close: aborts the attachment's requests in flight; their results are dropped. */
    closeAttachment(index) {
      for (const [id, request] of requests) {
        if (request.attachment === index) request.controller.abort();
        if (request.attachment === index) requests.delete(id);
      }
      partitions.delete(index);
    },
    /** A grant change: aborts the attachment's requests in flight whose origin token `keep` no longer accepts. */
    revoke(index, keep) {
      for (const [id, request] of requests) {
        if (request.attachment !== index || keep(fetchToken(request.url))) continue;
        request.controller.abort();
        requests.delete(id);
      }
    },
    /** The extension ended: aborts every request in flight. */
    closeAll() {
      for (const index of new Set([...requests.values()].map((request) => request.attachment))) this.closeAttachment(index);
    },
    attachments,
  };
}
