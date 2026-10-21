import { applyBase, BASE_PATH } from "./base-path.mjs";

// the same-origin WebSocket URL. Scheme is derived from location (ws:
// locally, wss: behind HTTPS — never hardcoded). The path is prefixed with the deploy-time public
// base path (the injected BASE_PATH, NOT the page path — a page at {base}/w/a/ still upgrades at
// {base}/api/a/…). `base` is exposed for deterministic testing of both modes in one process; the
// runtime default is the active BASE_PATH, so root mode is byte-for-byte unchanged.
export function sameOriginWebSocketUrl(endpointKey, wsPath, locationLike = globalThis.location, base = BASE_PATH) {
  const protocol = locationLike.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${locationLike.host}${applyBase(base, `/api/${endpointKey}${wsPath}`)}`;
}

export function createRuntimeStreamController({
  getActiveEndpointKey,
  getDesiredEventEndpointKeys,
  isEndpointKey,
  createWebSocket = (url) => new WebSocket(url),
  locationLike = typeof window !== "undefined" ? window.location : null,
  pagehideTarget = typeof window !== "undefined" ? window : null,
  setTimeoutFn = (...args) => setTimeout(...args),
  clearTimeoutFn = (handle) => clearTimeout(handle),
  nowMs = () => Date.now(),
  onRuntimeState = () => {},
  onPresenceDeparture = () => null,
  onPresenceDepartureApplied = () => {},
  onLog = () => {},
  fallbackPollMs = () => null,
  fallbackPeerStaleMs = 4000,
  fallbackServerTtlMs = 10000,
} = {}) {
  let runtimeSocket = null;
  let runtimeGeneration = 0;
  let pagehideInstalled = false;
  const eventStreams = new Map();
  const push = { events: [], last_departure: null };
  const nowIso = () => new Date(nowMs()).toISOString();

  function websocketUrl(endpointKey, path) {
    return sameOriginWebSocketUrl(endpointKey, path, locationLike);
  }

  function desiredKeys(input) {
    const values = input || getDesiredEventEndpointKeys() || [];
    return Array.from(new Set(values.filter((key) => isEndpointKey(key)))).sort();
  }

  function closeRuntimeStream() {
    runtimeGeneration += 1;
    const socket = runtimeSocket;
    runtimeSocket = null;
    try {
      if (socket) socket.close();
    } catch (error) {
      /* best effort */
    }
  }

  function connectRuntimeStream(endpointKey = getActiveEndpointKey()) {
    closeRuntimeStream();
    if (!isEndpointKey(endpointKey) || !locationLike) return null;
    const generation = ++runtimeGeneration;
    try {
      const socket = createWebSocket(websocketUrl(endpointKey, "/runtime-state"));
      runtimeSocket = socket;
      socket.onmessage = (event) => {
        if (runtimeSocket !== socket || runtimeGeneration !== generation) return;
        try {
          const message = JSON.parse(event.data);
          if (message && message.type === "state") onRuntimeState(message);
        } catch (error) {
          /* runtime stream remains observation-only and best effort */
        }
      };
      socket.onerror = () => {
        if (runtimeSocket === socket && runtimeGeneration === generation) {
          onLog("runtime-state WS error (best-effort; ignored)");
        }
      };
      return socket;
    } catch (error) {
      if (runtimeGeneration === generation) runtimeSocket = null;
      onLog(`runtime-state WS unavailable: ${error.message}`);
      return null;
    }
  }

  function closeEventStream(endpointKey) {
    const record = eventStreams.get(endpointKey);
    if (!record) return;
    record.intentional_close = true;
    if (record.reconnect_timer) clearTimeoutFn(record.reconnect_timer);
    record.reconnect_timer = null;
    try {
      if (record.ws) record.ws.close();
    } catch (error) {
      /* best effort */
    }
    eventStreams.delete(endpointKey);
  }

  function closeEventStreams() {
    for (const endpointKey of Array.from(eventStreams.keys())) closeEventStream(endpointKey);
  }

  function recordDeparture(record) {
    if (!record) return;
    push.last_departure = record;
    push.events.push(record);
    if (push.events.length > 24) push.events.splice(0, push.events.length - 24);
  }

  function openEventStream(endpointKey) {
    if (!isEndpointKey(endpointKey) || !locationLike) return null;
    let record = eventStreams.get(endpointKey);
    if (record && record.ws && (record.ws.readyState === 0 || record.ws.readyState === 1)) {
      return record.ws;
    }
    if (!record) {
      record = {
        endpoint_key: endpointKey,
        state: "idle",
        ws: null,
        reconnect_timer: null,
        reconnect_count: 0,
        connect_count: 0,
        connected_at: null,
        hello_at: null,
        last_event_at: null,
        last_error: null,
        intentional_close: false,
        generation: 0,
      };
      eventStreams.set(endpointKey, record);
    }
    record.intentional_close = false;
    record.state = "connecting";
    record.connect_count += 1;
    const generation = ++record.generation;
    try {
      const socket = createWebSocket(websocketUrl(endpointKey, "/events"));
      record.ws = socket;
      socket.onopen = () => {
        if (eventStreams.get(endpointKey) !== record || record.generation !== generation) return;
        record.state = "open";
        record.connected_at = nowIso();
        record.last_error = null;
      };
      socket.onmessage = (event) => {
        if (eventStreams.get(endpointKey) !== record || record.generation !== generation) return;
        try {
          const message = JSON.parse(event.data);
          record.last_event_at = nowIso();
          if (message && message.type === "hello") {
            record.hello_at = record.last_event_at;
          } else if (message && message.type === "user_left") {
            const departure = onPresenceDeparture(endpointKey, message);
            recordDeparture(departure);
            onPresenceDepartureApplied(departure);
          }
        } catch (error) {
          record.last_error = `message:${error.message}`;
        }
      };
      socket.onerror = () => {
        if (eventStreams.get(endpointKey) === record && record.generation === generation) {
          record.last_error = "websocket_error";
        }
      };
      socket.onclose = () => {
        if (eventStreams.get(endpointKey) !== record || record.generation !== generation) return;
        record.state = "closed";
        record.ws = null;
        if (record.intentional_close || !desiredKeys().includes(endpointKey)) return;
        record.reconnect_count += 1;
        const delayMs = Math.min(5000, 750 + record.reconnect_count * 500);
        record.reconnect_timer = setTimeoutFn(() => {
          if (eventStreams.get(endpointKey) !== record || record.intentional_close) return;
          record.reconnect_timer = null;
          openEventStream(endpointKey);
        }, delayMs);
      };
      return socket;
    } catch (error) {
      record.state = "unavailable";
      record.ws = null;
      record.last_error = error.message;
      return null;
    }
  }

  function handlePagehide() {
    closeEventStreams();
  }

  function syncEventStreams(endpointKeys) {
    if (!pagehideInstalled && pagehideTarget && pagehideTarget.addEventListener) {
      pagehideInstalled = true;
      pagehideTarget.addEventListener("pagehide", handlePagehide);
    }
    const wanted = new Set(desiredKeys(endpointKeys));
    for (const key of Array.from(eventStreams.keys())) {
      if (!wanted.has(key)) closeEventStream(key);
    }
    for (const key of wanted) openEventStream(key);
    return Array.from(wanted);
  }

  function debug() {
    const connections = {};
    for (const [endpointKey, record] of eventStreams) {
      connections[endpointKey] = {
        state: record.state,
        connect_count: record.connect_count,
        reconnect_count: record.reconnect_count,
        connected_at: record.connected_at,
        hello_at: record.hello_at,
        last_event_at: record.last_event_at,
        last_error: record.last_error,
      };
    }
    return {
      _claim:
        "runtime browser consumption of the existing backend /events user_left push; " +
        "targeted player_id invalidation, with poll/stale/TTL retained as fallbacks",
      endpoint_keys: desiredKeys(),
      connections,
      last_departure: push.last_departure,
      events: push.events.slice(-10),
      fallback_poll_ms: fallbackPollMs(),
      fallback_peer_stale_ms: fallbackPeerStaleMs,
      fallback_server_ttl_ms: fallbackServerTtlMs,
    };
  }

  function snapshot() {
    return { runtimeSocket, eventStreams, push };
  }

  function dispose() {
    closeRuntimeStream();
    closeEventStreams();
    if (pagehideInstalled && pagehideTarget && pagehideTarget.removeEventListener) {
      pagehideTarget.removeEventListener("pagehide", handlePagehide);
    }
    pagehideInstalled = false;
  }

  return {
    connectRuntimeStream,
    closeRuntimeStream,
    syncEventStreams,
    closeEventStream,
    closeEventStreams,
    openEventStream,
    debug,
    snapshot,
    dispose,
  };
}
