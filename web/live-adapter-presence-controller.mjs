const PRESENCE_HEARTBEAT_INTERVAL_MS = 3000;
const PRESENCE_REGISTER_TTL_MS = 10000;
// the HIDDEN-DOCUMENT TTL.
//
// The heartbeat cadence below is never slowed: a 3 s beat against a 10 s TTL is
// what keeps visible liveness honest. The problem is that the browser, not this
// module, decides how often a hidden document's timers fire — a backgrounded
// document is throttled to roughly one wake per minute, which is six times the
// registered TTL. The entry then expires, the next beat upserts it back, and the
// window ping-pongs between present and absent while its player has not moved.
//
// The fix is to tell the server the truth about how often it can now expect to
// hear from us, instead of lying about being gone. 60000 ms is exactly the
// server's PRESENCE_TTL_MAX_MS ceiling (041 runtime-state.js), so it is accepted
// rather than clamped. It is applied by RE-REGISTERING on the visibility
// transition, because the server's heartbeat path deliberately re-arms the TTL
// captured at registration and ignores a heartbeat's requested_ttl_ms.
const PRESENCE_HIDDEN_TTL_MS = 60000;

function rounded(value, digits) {
  const scale = 10 ** digits;
  return Math.round(Number(value) * scale) / scale;
}

function roundedPosition(value) {
  return Array.isArray(value) ? value.slice(0, 3).map((entry) => rounded(entry, 4)) : null;
}

export function createPresenceController({
  transport,
  clientMode,
  playerId,
  clientId,
  supported = clientMode === "player",
  getBase,
  getLocationId,
  getAvatar,
  getHandoffInFlight = () => false,
  onForcePose = () => {},
  onCloseEventStreams = () => {},
  onLog = () => {},
  nowMs = () => Date.now(),
  setIntervalFn = (...args) => setInterval(...args),
  clearIntervalFn = (handle) => clearInterval(handle),
  pagehideTarget = typeof window !== "undefined" ? window : null,
  visibilityTarget = typeof document !== "undefined" ? document : null,
  navigatorLike = typeof navigator !== "undefined" ? navigator : null,
  BlobCtor = typeof Blob !== "undefined" ? Blob : null,
} = {}) {
  const state = {
    supported: clientMode === "player" && supported === true,
    player_id: playerId || clientId,
    registered: false,
    registered_base: null,
    registered_location_id: null,
    registered_at: null,
    last_heartbeat_at: null,
    heartbeat_count: 0,
    register_count: 0,
    depart_count: 0,
    last_error: null,
    events: [],
  };
  let heartbeatTimer = null;
  let pagehideInstalled = false;
  let visibilityInstalled = false;

  const nowIso = () => new Date(nowMs()).toISOString();

  const documentIsHidden = () => visibilityTarget?.hidden === true;

  /** The TTL this client asks the server to hold it for. See PRESENCE_HIDDEN_TTL_MS. */
  const requestedTtlMs = () => (documentIsHidden() ? PRESENCE_HIDDEN_TTL_MS : PRESENCE_REGISTER_TTL_MS);

  function record(event, detail) {
    state.events.push({ event, at: nowIso(), ...(detail || {}) });
    if (state.events.length > 24) state.events.splice(0, state.events.length - 24);
  }

  function controlledIdentity() {
    return {
      player_id: state.player_id,
      client_id: clientId,
      scope: "browser_session",
      stable_across_in_page_handoff: true,
      reload_stable: false,
    };
  }

  function presenceIdentity() {
    const avatar = getAvatar() || {};
    const identity = controlledIdentity();
    return {
      player_id: identity.player_id,
      client_id: identity.client_id,
      avatar_id: avatar.avatar_id || null,
      continuity_id: avatar.continuity_id || avatar.avatar_id || null,
      display_name: avatar.display_name || null,
      position: roundedPosition(avatar.position),
      rotation_y: Number.isFinite(Number(avatar.rotation_y))
        ? rounded(Number(avatar.rotation_y), 6)
        : null,
      requested_ttl_ms: requestedTtlMs(),
    };
  }

  function startHeartbeat() {
    if (!state.supported || heartbeatTimer) return heartbeatTimer;
    heartbeatTimer = setIntervalFn(() => {
      void heartbeat();
    }, PRESENCE_HEARTBEAT_INTERVAL_MS);
    return heartbeatTimer;
  }

  function stopHeartbeat() {
    if (heartbeatTimer) {
      clearIntervalFn(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function installPagehide() {
    if (pagehideInstalled || !pagehideTarget || !pagehideTarget.addEventListener) return;
    pagehideInstalled = true;
    pagehideTarget.addEventListener("pagehide", handlePagehide);
  }

  function handlePagehide() {
    stopHeartbeat();
    void departPresence({ base: getBase(), reason: "pagehide", beacon: true });
    onCloseEventStreams();
  }

  function installVisibility() {
    if (visibilityInstalled || !visibilityTarget || !visibilityTarget.addEventListener) return;
    visibilityInstalled = true;
    visibilityTarget.addEventListener("visibilitychange", handleVisibilityChange);
  }

  /**
   * re-arm the server-side TTL for the visibility state we
   * are entering. This never departs, never stops the heartbeat and never
   * reports a liveness this window does not have — it only changes how long the
   * server will wait before calling us gone, so a throttled hidden document
   * cannot expire and re-register between beats. Returning to visible restores
   * the 10 s TTL immediately, so a departure stays as observable as before.
   */
  function handleVisibilityChange() {
    if (!state.supported || !state.registered) return;
    void registerPresence(documentIsHidden() ? "visibility_hidden" : "visibility_visible");
  }

  async function registerPresence(input = {}) {
    if (!state.supported) return null;
    const spawnReason = typeof input === "string" ? input : input.spawnReason;
    const base = getBase();
    try {
      const output = await transport.postJson(`${base}/fabric/presence/register`, {
        ...presenceIdentity(),
        reason: spawnReason,
      });
      state.registered = true;
      state.registered_base = base;
      state.registered_location_id = (output && output.location_id) || getLocationId();
      state.registered_at = nowIso();
      state.register_count += 1;
      state.last_error = null;
      record("presence_registered", {
        base,
        reason: spawnReason,
        location_id: state.registered_location_id,
        registered_player_count: output ? output.registered_player_count : null,
      });
      installPagehide();
      installVisibility();
      onLog(
        `presence registered with ${base} (${spawnReason}); location ${state.registered_location_id}; ` +
          `registry size ${output ? output.registered_player_count : "?"}`,
      );
      return output;
    } catch (error) {
      state.last_error = `register:${error.message}`;
      record("presence_register_failed", { base, reason: spawnReason, error: error.message });
      onLog(
        `presence register failed against ${base}: ${error.message} ` +
          `(best-effort; heartbeat upsert self-heals, server TTL guards ghosts)`,
      );
      return null;
    } finally {
      startHeartbeat();
    }
  }

  async function departPresence(input = {}) {
    if (!state.supported) return null;
    const base = input.base || input.baseKey || state.registered_base || getBase();
    const reason = input.reason;
    const body = { player_id: state.player_id, reason };
    state.depart_count += 1;
    if (input.beacon && navigatorLike && navigatorLike.sendBeacon && BlobCtor) {
      try {
        navigatorLike.sendBeacon(
          `${base}/fabric/presence/depart`,
          new BlobCtor([JSON.stringify(body)], { type: "application/json" }),
        );
        record("presence_depart_beacon", { base, reason });
        return null;
      } catch (error) {
        /* fall through to the transport path */
      }
    }
    try {
      const output = await transport.postJson(`${base}/fabric/presence/depart`, body);
      record("presence_departed", { base, reason });
      onLog(`presence departed ${base} (${reason})`);
      return output;
    } catch (error) {
      state.last_error = `depart:${error.message}`;
      record("presence_depart_failed", { base, reason, error: error.message });
      return null;
    }
  }

  async function heartbeat() {
    if (!state.supported || getHandoffInFlight()) return null;
    const base = getBase();
    try {
      const output = await transport.postJson(
        `${base}/fabric/presence/heartbeat`,
        presenceIdentity(),
      );
      if (base !== getBase() || getHandoffInFlight()) {
        record("presence_heartbeat_stale", { base, current_base: getBase() });
        return output;
      }
      state.registered = true;
      state.registered_base = base;
      state.registered_location_id =
        (output && output.location_id) || state.registered_location_id;
      state.last_heartbeat_at = nowIso();
      state.heartbeat_count += 1;
      if (output && output.upserted) record("presence_heartbeat_upserted", { base });
      onForcePose({ force: true });
      return output;
    } catch (error) {
      state.last_error = `heartbeat:${error.message}`;
      record("presence_heartbeat_failed", { base, error: error.message });
      return null;
    }
  }

  function setSupported(next) {
    state.supported = clientMode === "player" && next === true;
    if (!state.supported) stopHeartbeat();
    return state.supported;
  }

  function clearRegistration() {
    state.registered = false;
    state.registered_base = null;
    state.registered_location_id = null;
  }

  function snapshot() {
    return { ...state, events: state.events.slice() };
  }

  function debug() {
    return {
      _claim:
        "runtime server-side presence registration — explicit " +
        "register/heartbeat/depart session actions against the player's CURRENT " +
        "active server; TTL expiry on the server guards ghost occupancy",
      supported: state.supported,
      player_id: state.player_id,
      registered: state.registered,
      registered_base: state.registered_base,
      registered_location_id: state.registered_location_id,
      registered_at: state.registered_at,
      heartbeat_interval_ms: PRESENCE_HEARTBEAT_INTERVAL_MS,
      requested_ttl_ms: requestedTtlMs(),
      heartbeat_count: state.heartbeat_count,
      last_heartbeat_at: state.last_heartbeat_at,
      register_count: state.register_count,
      depart_count: state.depart_count,
      last_error: state.last_error,
      events: state.events.slice(-10),
    };
  }

  const compatibilityView = Object.freeze({
    get supported() { return state.supported; },
    get player_id() { return state.player_id; },
  });

  function dispose() {
    stopHeartbeat();
    if (pagehideInstalled && pagehideTarget && pagehideTarget.removeEventListener) {
      pagehideTarget.removeEventListener("pagehide", handlePagehide);
    }
    pagehideInstalled = false;
  }

  // arm the pagehide depart beacon for EVERY player-mode
  // session at creation, not only inside registerPresence's success path. A
  // session re-established by a heartbeat upsert (the initial register POST
  // failed against a momentarily unready backend) previously installed no
  // listener and so closed WITHOUT departing. handlePagehide's departPresence
  // still no-ops when presence is unsupported (observer/preview windows), so it
  // is safe to arm eagerly for the whole player-mode lifetime.
  if (clientMode === "player") installPagehide();

  return {
    controlledIdentity,
    registerPresence,
    departPresence,
    heartbeat,
    startHeartbeat,
    stopHeartbeat,
    installPagehide,
    recordEvent: record,
    setSupported,
    clearRegistration,
    snapshot,
    debug,
    compatibilityView: () => compatibilityView,
    dispose,
  };
}

export const PRESENCE_TIMING = Object.freeze({
  heartbeat_interval_ms: PRESENCE_HEARTBEAT_INTERVAL_MS,
  requested_ttl_ms: PRESENCE_REGISTER_TTL_MS,
});
