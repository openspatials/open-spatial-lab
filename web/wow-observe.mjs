// web/wow-observe.mjs
//
// Iteration 3: observe data points in any world, with nobody present and without becoming a user.
//
// A DATA POINT is a resource URL plus a JSON Pointer fragment (RFC 6901 §6, which the Web of Worlds
// media type allows): `{B}/wow/spatial/1/node/42#/properties/temperature` names node 42's temperature,
// `{A}/wow/world#/users/active_user_count` names A's user count. The pointer never passes through
// `children`; a child is named by its own node URL.
//
// AN OBSERVER reads each data point (a conditional GET, with entity tags) and follows its world's event
// stream (the World resource lists it under `services.events`). Each event carries the world's
// `revision`, the `time` of the change and the `urls` it changed; the observer re-reads only what an
// event names, in revision order. After a dropped connection it resumes with `since=<revision>`; when
// the world can no longer replay that far it answers `resync`, and the observer re-reads everything.
// Observing creates no user: the observer never registers presence.
//
// A world that requires authorization for its stream gets the access token as the stream's first
// message. Tokens never go in URLs.
//
// PURE: fetch and WebSocket are passed in (the browser's, or Node 22's), so this runs in the browser
// (the dashboard and the `?wow=` player), in a world server (mirroring) and in the iteration 3 proof.

export const WOW_MEDIA_TYPE = "application/wow+json";

/** Split a data-point URL into its resource URL and its JSON Pointer. */
export function parseDataPoint(url) {
  const u = new URL(url);
  const pointer = u.hash ? decodeURIComponent(u.hash.slice(1)) : "";
  u.hash = "";
  return { url, resource: u.href, pointer };
}

/** A world's base URL from one of its resource URLs: the base-URL rule, base plus `wow/...`. */
export function worldBaseOf(resourceUrl) {
  const u = new URL(resourceUrl);
  const at = u.pathname.indexOf("/wow/");
  u.pathname = at === -1 ? "/" : u.pathname.slice(0, at + 1);
  u.search = "";
  u.hash = "";
  return u.href;
}

/** The value a JSON Pointer names in a document (RFC 6901), or undefined. */
export function readPointer(doc, pointer) {
  if (!pointer) return doc;
  if (!pointer.startsWith("/")) return undefined;
  let node = doc;
  for (const raw of pointer.slice(1).split("/")) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (node === null || typeof node !== "object" || !(key in node)) return undefined;
    node = node[key];
  }
  return node;
}

/**
 * One world's event stream. It reads the World resource for `services.events`, connects, sends the
 * access token first when there is one, and reconnects with `since=<last revision>` until closed.
 *
 * @param {string} base   the world's base URL
 * @param {object} opts   { fetch, WebSocket, token, onHello, onEvent, onResync, onRequest, reconnect }
 */
export function openWorldStream(base, opts) {
  const WS = opts.WebSocket || globalThis.WebSocket;
  const fetchImpl = opts.fetch || globalThis.fetch;
  const state = { base, revision: null, socket: null, closed: false, connects: 0, world: null, eventsUrl: null, status: "connecting" };
  let queue = Promise.resolve();

  async function eventsUrl() {
    if (state.eventsUrl) return state.eventsUrl;
    const worldUrl = new URL("wow/world", base).href;
    if (opts.onRequest) opts.onRequest(worldUrl);
    const r = await fetchImpl(worldUrl, { headers: { Accept: WOW_MEDIA_TYPE }, cache: "no-store" });
    if (!r.ok) throw new Error(`${worldUrl} answered ${r.status}`);
    state.world = await r.json();
    const relative = state.world && state.world.services && state.world.services.events;
    if (!relative) throw new Error(`${worldUrl} lists no services.events`);
    const u = new URL(relative, base);
    u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
    state.eventsUrl = u.href;
    return state.eventsUrl;
  }

  async function connect() {
    if (state.closed) return;
    let url;
    try {
      url = await eventsUrl();
    } catch (error) {
      state.status = "unreachable";
      state.error = String((error && error.message) || error);
      if (opts.onStatus) opts.onStatus(state);
      scheduleReconnect();
      return;
    }
    if (state.revision !== null) url += (url.includes("?") ? "&" : "?") + "since=" + state.revision;
    if (opts.onRequest) opts.onRequest(url);
    state.connects += 1;
    const socket = new WS(url);
    state.socket = socket;
    socket.onopen = () => {
      if (opts.token) socket.send(JSON.stringify({ type: "auth", token: opts.token }));
    };
    socket.onmessage = (message) => {
      let evt;
      try { evt = JSON.parse(message.data); } catch { return; }
      // Events are handled one at a time, in the order the world sent them.
      queue = queue.then(() => handle(evt)).catch((error) => { state.error = String(error && error.message || error); });
    };
    socket.onclose = () => {
      if (state.socket === socket) state.socket = null;
      if (!state.closed) { state.status = "reconnecting"; if (opts.onStatus) opts.onStatus(state); scheduleReconnect(); }
    };
    socket.onerror = () => {};
  }

  function scheduleReconnect() {
    if (state.closed || opts.reconnect === false) return;
    setTimeout(connect, opts.reconnectMs || 500);
  }

  async function handle(evt) {
    if (evt.type === "hello") {
      const first = state.revision === null;
      state.status = "live";
      if (first) state.revision = evt.revision;
      if (opts.onHello) await opts.onHello(evt, first, state);
      if (opts.onStatus) opts.onStatus(state);
      return;
    }
    if (evt.type === "resync") {
      state.revision = evt.revision;
      if (opts.onResync) await opts.onResync(evt, state);
      return;
    }
    if (Number.isInteger(evt.revision)) {
      if (state.revision !== null && evt.revision <= state.revision) return; // already applied
      state.revision = evt.revision;
    }
    if (opts.onEvent) await opts.onEvent(evt, state);
  }

  connect();
  return {
    state,
    /** Drop the connection without closing the stream: it reconnects with `since`. */
    drop() { if (state.socket) state.socket.close(); },
    close() { state.closed = true; state.status = "closed"; if (state.socket) state.socket.close(); },
    idle: () => queue,
  };
}

/**
 * An observer of data points.
 *
 * @param {object} opts
 *   fetch, WebSocket   the implementations to use
 *   token              an access token for streams that require one (sent first, never in a URL)
 *   streamBudget       the most event streams to hold; points in other worlds are marked "over budget"
 *   onChange(point)    called after each change of a watched point
 *   onRequest(url)     called with every URL the observer requests, so a caller can audit them
 */
export function createObserver(opts = {}) {
  const fetchImpl = opts.fetch || globalThis.fetch;
  const points = new Map(); // data-point URL -> point
  const resources = new Map(); // resource URL -> { etag, body, status }
  const streams = new Map(); // world base -> stream
  const budget = Number.isInteger(opts.streamBudget) ? opts.streamBudget : Infinity;

  async function read(resource) {
    const kept = resources.get(resource);
    const headers = { Accept: WOW_MEDIA_TYPE };
    if (kept && kept.etag) headers["If-None-Match"] = kept.etag;
    if (opts.onRequest) opts.onRequest(resource);
    let r;
    try {
      r = await fetchImpl(resource, { headers, cache: "no-store" });
    } catch (error) {
      const failed = { status: 0, body: null, error: String((error && error.message) || error) };
      resources.set(resource, failed);
      return failed;
    }
    if (r.status === 304 && kept) return kept;
    const entry = { status: r.status, etag: r.headers.get("etag"), lastModified: r.headers.get("last-modified"), body: r.ok ? await r.json() : null };
    if (!r.ok) { try { await r.text(); } catch { /* ignore */ } }
    resources.set(resource, entry);
    return entry;
  }

  async function refresh(point, revision, time) {
    const entry = await read(point.resource);
    const value = entry.status === 200 ? readPointer(entry.body, point.pointer) : undefined;
    const before = JSON.stringify(point.value);
    point.status = entry.status === 200 ? (value === undefined ? "no such value" : "ok") : entry.status === 404 || entry.status === 410 ? "gone" : entry.status === 0 ? "unreachable" : `HTTP ${entry.status}`;
    point.value = value;
    if (revision !== undefined) point.revision = revision;
    if (time) point.time = time;
    else if (!point.time && entry.lastModified) point.time = new Date(entry.lastModified).toISOString();
    point.reads += 1;
    if (opts.onChange && (JSON.stringify(value) !== before || revision !== undefined)) opts.onChange(point);
    return point;
  }

  function pointsOf(base) {
    return [...points.values()].filter((p) => p.base === base);
  }

  function streamFor(base) {
    if (streams.has(base)) return streams.get(base);
    if (streams.size >= budget) return null;
    const stream = openWorldStream(base, {
      fetch: fetchImpl,
      WebSocket: opts.WebSocket,
      token: typeof opts.token === "function" ? opts.token(base) : opts.token,
      onRequest: opts.onRequest,
      reconnectMs: opts.reconnectMs,
      onStatus: opts.onStatus,
      async onHello(evt, first) {
        if (first) for (const p of pointsOf(base)) await refresh(p, evt.revision, p.time || null);
      },
      async onResync(evt) {
        for (const p of pointsOf(base)) await refresh(p, evt.revision, evt.time || null);
        if (opts.onResync) opts.onResync(base, evt);
      },
      async onEvent(evt) {
        const changed = new Set((evt.urls || []).map((u) => new URL(u, base).href));
        for (const p of pointsOf(base)) {
          if (changed.has(p.resource)) await refresh(p, evt.revision, evt.time);
        }
        if (opts.onEvent) opts.onEvent(base, evt);
      },
    });
    streams.set(base, stream);
    return stream;
  }

  return {
    points,
    streams,
    /** Watch a data point; resolves with the point once its first value is read. */
    async watch(url) {
      const parsed = parseDataPoint(url);
      const point = { ...parsed, base: worldBaseOf(parsed.resource), value: undefined, revision: null, time: null, status: "pending", reads: 0 };
      points.set(url, point);
      const stream = streamFor(point.base);
      if (!stream) { point.status = "over budget"; return point; }
      await refresh(point, stream.state.revision === null ? undefined : stream.state.revision);
      return point;
    },
    /** Every stream's queue settled. */
    async idle() { for (const s of streams.values()) await s.idle(); },
    close() { for (const s of streams.values()) s.close(); },
  };
}
