/**
 * Canonical addressable-fabric prefetch owner.
 *
 * The controller is deliberately traversal-blind: it receives already-computed
 * portal evaluations, performs read-only destination GETs, and publishes state.
 * It cannot test, trigger, delay, or commit a crossing.
 */

import { portalLocalCoordinates } from "./live-adapter-portal-geometry.mjs";

const DEFAULTS = Object.freeze({
  FABRIC_PREFETCH_PRESENCE_REFRESH_MS: 2000,
  FABRIC_PREFETCH_MAX_ATTEMPTS: 5,
  FABRIC_PREFETCH_RETRY_BACKOFF_MS: 1500,
  FABRIC_PREFETCH_MAX_ACTIVE_LOADS: 1,
  FABRIC_PREFETCH_PREEMPT_MARGIN_M: 0.5,
  LOBBY_DESTINATION_OCCUPANCY_REFRESH_MS: 5000,
  FABRIC_PREFETCH_CHUNKED_ENABLED: true,
  FABRIC_PREFETCH_CHUNK_MAX_ENTITIES: 12,
  FABRIC_PREFETCH_CHUNK_MAX_BYTES: 6144,
  FABRIC_PREFETCH_CHUNK_YIELD_MS: 24,
  FABRIC_PREFETCH_CACHE_MAX_BYTES: 262144,
  FABRIC_COMPLETION_PACING_MS: 400,
  FABRIC_COMPLETION_CHUNK_MAX_ENTITIES: 6,
  FABRIC_COMPLETION_MAX_CHUNKS: 64,
});

function distance2d(a, b) {
  const dx = ((a && a[0]) || 0) - ((b && b[0]) || 0);
  const dz = ((a && a[2]) || 0) - ((b && b[2]) || 0);
  return Math.hypot(dx, dz);
}

function roundNumber(value, digits = 3) {
  const scale = 10 ** digits;
  return Math.round(Number(value) * scale) / scale;
}

function fabricEntitiesByteSize(entities) {
  if (!Array.isArray(entities) || !entities.length) return 0;
  try {
    let total = 0;
    const encoder = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;
    for (const entity of entities) {
      const json = JSON.stringify(entity);
      total += encoder ? encoder.encode(json).length : json.length;
    }
    return total;
  } catch (e) {
    return 0;
  }
}

function errorMessage(error) {
  return error && error.message ? error.message : String(error);
}

export function createFabricPrefetchController(dependencies = {}) {
  return new FabricPrefetchController(dependencies);
}

export class FabricPrefetchController {
  constructor({
    getJson,
    nowMs = () => Date.now(),
    nowIso = () => new Date().toISOString(),
    setIntervalFn = (fn, ms) => setInterval(fn, ms),
    clearIntervalFn = (id) => clearInterval(id),
    setTimeoutFn = (fn, ms) => setTimeout(fn, ms),
    resolveProxyBase,
    portalKey,
    normalizeTraversal,
    portalEntrySideAllowed,
    adoptDestinationPortalPose = () => {},
    onTargetSetChanged = () => {},
    emitState = () => {},
    log = () => {},
    readCacheCapFixture = () => null,
    getActiveBase = () => null,
    getAvatarPose = () => null,
  } = {}) {
    if (typeof getJson !== "function") throw new TypeError("fabric prefetch getJson is required");
    if (typeof resolveProxyBase !== "function") {
      throw new TypeError("fabric prefetch resolveProxyBase is required");
    }
    if (typeof portalKey !== "function") throw new TypeError("fabric prefetch portalKey is required");
    if (typeof normalizeTraversal !== "function") {
      throw new TypeError("fabric prefetch normalizeTraversal is required");
    }
    if (typeof portalEntrySideAllowed !== "function") {
      throw new TypeError("fabric prefetch portalEntrySideAllowed is required");
    }
    this._getJson = getJson;
    this._nowMs = nowMs;
    this._nowIso = nowIso;
    this._setInterval = setIntervalFn;
    this._clearInterval = clearIntervalFn;
    this._setTimeout = setTimeoutFn;
    this._resolveProxyBase = resolveProxyBase;
    this._portalKey = portalKey;
    this._normalizeTraversal = normalizeTraversal;
    this._portalEntrySideAllowed = portalEntrySideAllowed;
    this._adoptDestinationPortalPose = adoptDestinationPortalPose;
    this._onTargetSetChanged = onTargetSetChanged;
    this._emit = emitState;
    this._log = log;
    this._readCacheCapFixture = readCacheCapFixture;
    this._getActiveBase = getActiveBase;
    this._getAvatarPose = getAvatarPose;
    Object.assign(this, DEFAULTS);
    this._world = null;
    this._clientMode = "observer";
    this._focusPortalId = null;
    this._machines = null;
    this._scheduler = null;
    this._presenceTimer = null;
    this._lobbyOccupancy = null;
    this._lobbyOccupancyTimer = null;
    this._cacheCap = null;
    this._cacheStats = null;
    this._completion = null;
    this._completionGeneration = 0;
    this._lastPromoted = null;
  }

  _delay(ms) {
    return new Promise((resolve) => this._setTimeout(resolve, ms));
  }

  _makeMachine(portal, reason) {
    const address = portal ? portal.spatial_fabric_address || null : null;
    const zones = portal ? portal.zones || null : null;
    return {
      status: "idle",
      reason: reason || "init",
      supported: !!(address && zones && zones.prefetch),
      portal_id: portal ? portal.portal_id : null,
      portal_key: this._portalKey(portal),
      label: portal ? portal.label || null : null,
      target_location_id: portal ? portal.target_location_id || null : null,
      traversal: this._normalizeTraversal(portal ? portal.traversal : null),
      address,
      zones,
      zone: {
        inside: false,
        distance_m: null,
        entered_at: null,
        exited_at: null,
        arming_suppressed: false,
        suppressed_reason: null,
        suppression_episode: false,
      },
      resolve: { started_at: null, completed_at: null, well_known_fabric_id: null, error: null },
      region: {
        requested_at: null,
        loaded_at: null,
        loaded_at_ms: null,
        ttl_ms: null,
        payload: null,
        error: null,
        attempts: 0,
        next_retry_at_ms: null,
        chunks: [],
        bytes_total: 0,
        progressive: null,
        streaming: null,
      },
      presence: {
        refreshed_at: null,
        refreshed_at_ms: null,
        ttl_ms: null,
        payload: null,
        refresh_count: 0,
        error: null,
      },
      events: [],
      queued: false,
      queued_episode: false,
      generation: 0,
      fetchInFlight: false,
      presenceFetchInFlight: false,
      last_used_at_ms: null,
    };
  }

  reset({ reason, world, clientMode = this._clientMode } = {}) {
    this._world = world || null;
    this._clientMode = clientMode;
    const portals =
      this._world && Array.isArray(this._world.portals) && this._world.portals.length
        ? this._world.portals
        : this._world && this._world.portal
          ? [this._world.portal]
          : [];
    if (this._machines) {
      for (const machine of Object.values(this._machines)) machine.generation += 1;
    }
    this._machines = {};
    for (const portal of portals) {
      const key = this._portalKey(portal);
      if (key) this._machines[key] = this._makeMachine(portal, reason);
    }
    this._scheduler = {
      budget: this.FABRIC_PREFETCH_MAX_ACTIVE_LOADS,
      active_load_count: 0,
      max_observed_active_loads: 0,
      priority_order: [],
      selected_portal_id: null,
      events: [],
    };
    this._stopPresenceTimer();
    this._ensureLobbyOccupancyPoller();
    this._onTargetSetChanged(this.destinationTargets());

    // A promotion can leave the avatar already inside the destination world's
    // return-portal prefetch circle. There may be no subsequent movement tick:
    // a stationary player can turn the camera and look straight back through
    // the ring. Seed bidirectional machines from that accepted arrival pose so
    // prefetch does not incorrectly remain idle until the next key press.
    //
    // For one-way portals, reuse the canonical shared portal-frame geometry to
    // preserve blocked-side suppression. If that frame is unavailable, leave
    // the machine idle until the traversal controller supplies an evaluation.
    // This owner still has no traversal authority: the seed can only start or
    // suppress read-only destination prefetch.
    const machinesAtReset = this._machines;
    const seedFromCurrentPose = () => {
      if (this._machines !== machinesAtReset) return;
      const avatar = this._getAvatarPose();
      const avatarPosition = Array.isArray(avatar)
        ? avatar
        : avatar && Array.isArray(avatar.position)
          ? avatar.position
          : avatar && avatar.transform && Array.isArray(avatar.transform.position)
            ? avatar.transform.position
            : null;
      const canSeedFromArrival =
        this._clientMode === "player" &&
        avatar &&
        portals.length > 0 &&
        portals.every((portal) => {
          const traversal = this._normalizeTraversal(portal.traversal);
          return traversal.mode === "bidirectional" || !!(portal.frame && avatarPosition);
        });
      if (!canSeedFromArrival) return;
      this.update({
        avatar,
        evaluations: portals.map((portal) => ({
          portal,
          portal_key: this._portalKey(portal),
          portalCenter:
            (portal.frame && portal.frame.position) ||
            (portal.trigger && portal.trigger.position) ||
            portal.trigger_position ||
            [0, 0, 0],
          local:
            portal.frame && avatarPosition
              ? portalLocalCoordinates(portal.frame, avatarPosition)
              : null,
          traversal: this._normalizeTraversal(portal.traversal),
        })),
        focusPortalId: this._focusPortalId,
        world: this._world,
        clientMode: this._clientMode,
      });
    };
    seedFromCurrentPose();
    if (
      typeof reason === "string" &&
      (reason.startsWith("promoted_to_") || reason === "return_to_lobby")
    ) {
      // `_promoteActiveEndpoint()` resets the machines before the traversal
      // controller installs the mapped arrival pose. Re-read on the next task
      // so a player who arrives already inside the ring does not need to move.
      this._setTimeout(seedFromCurrentPose, 0);
    }
    return this._machines;
  }

  destinationTargets() {
    return Object.values(this._machines || {}).map((machine) => ({
      portal_key: machine.portal_key,
      portal_id: machine.portal_id,
      target_location_id: machine.target_location_id,
      address: machine.address,
    }));
  }

  _focusMachine() {
    const machines = this._machines || {};
    if (this._focusPortalId && machines[this._focusPortalId]) return machines[this._focusPortalId];
    const keys = Object.keys(machines);
    return keys.length ? machines[keys[0]] : null;
  }

  _event(machine, event, detail) {
    if (!machine) return;
    machine.events.push({ event, at: this._nowIso(), ...(detail || {}) });
    if (machine.events.length > 40) machine.events.splice(0, machine.events.length - 40);
  }

  _schedulerEvent(event, detail) {
    if (!this._scheduler) return;
    this._scheduler.events.push({ event, at: this._nowIso(), ...(detail || {}) });
    if (this._scheduler.events.length > 60) {
      this._scheduler.events.splice(0, this._scheduler.events.length - 60);
    }
  }

  _startPresenceTimer() {
    if (this._presenceTimer) return;
    this._presenceTimer = this._setInterval(() => {
      const warm = Object.values(this._machines || {}).filter((m) => m.status === "warm");
      if (!warm.length) {
        this._stopPresenceTimer();
        return;
      }
      const nowMs = this._nowMs();
      for (const machine of warm) {
        const stale =
          machine.region.loaded_at_ms == null ||
          machine.region.ttl_ms == null ||
          nowMs - machine.region.loaded_at_ms > machine.region.ttl_ms;
        if (stale) this._runPipeline(machine);
        else this.refreshPresence(machine);
      }
    }, this.FABRIC_PREFETCH_PRESENCE_REFRESH_MS);
  }

  _stopPresenceTimer() {
    if (this._presenceTimer) {
      this._clearInterval(this._presenceTimer);
      this._presenceTimer = null;
    }
  }

  update({ avatar, evaluations, focusPortalId = null, world, clientMode } = {}) {
    this._focusPortalId = focusPortalId;
    if (world !== undefined) this._world = world;
    if (clientMode !== undefined) this._clientMode = clientMode;
    if (!Array.isArray(evaluations) || !evaluations.length) return;
    const expectedKeys = evaluations.map((ev) => ev.portal_key).filter(Boolean).sort().join("|");
    const currentKeys = this._machines ? Object.keys(this._machines).sort().join("|") : null;
    if (currentKeys === null || currentKeys !== expectedKeys) {
      this.reset({
        reason: currentKeys === null ? "init" : "portal_set_changed",
        world: this._world,
        clientMode: this._clientMode,
      });
    }
    const machines = this._machines;
    const scheduler = this._scheduler;
    const nowMs = this._nowMs();
    const activeLoads = () =>
      Object.values(machines).filter((m) => m.status === "resolving" || m.status === "loading").length;
    const regionFreshFor = (m) =>
      m.region.loaded_at_ms != null &&
      m.region.ttl_ms != null &&
      nowMs - m.region.loaded_at_ms <= m.region.ttl_ms;
    const eligible = [];

    for (const evaluation of evaluations) {
      const machine = machines[evaluation.portal_key];
      if (!machine || !machine.supported) continue;
      const prefetchRadius = Number(machine.zones.prefetch.radius_m) || 0;
      const hysteresis = Number(machine.zones.prefetch.hysteresis_ratio) || 1.15;
      const distance = distance2d((avatar && avatar.position) || [0, 0, 0], evaluation.portalCenter);
      machine.zone.distance_m = roundNumber(distance, 3);
      const wasInside = machine.zone.inside;
      const inside = wasInside ? distance <= prefetchRadius * hysteresis : distance <= prefetchRadius;
      machine.zone.inside = inside;
      if (inside && !wasInside) {
        machine.zone.entered_at = this._nowIso();
        this._event(machine, "prefetch_zone_entered", { distance_m: machine.zone.distance_m });
      }
      if (!inside && wasInside) {
        machine.zone.exited_at = this._nowIso();
        this._event(machine, "prefetch_zone_exited", { distance_m: machine.zone.distance_m });
      }
      const rule = evaluation.traversal || this._normalizeTraversal(evaluation.portal.traversal);
      const currentSide = evaluation.local ? evaluation.local.side : null;
      const blocked =
        rule.mode === "one_way" &&
        (currentSide === "front" || currentSide === "back") &&
        !this._portalEntrySideAllowed(rule, currentSide);
      const suppressed = inside && blocked;
      machine.zone.arming_suppressed = suppressed;
      machine.zone.suppressed_reason = suppressed ? "one_way_blocked_side" : null;
      if (suppressed && !machine.zone.suppression_episode) {
        machine.zone.suppression_episode = true;
        this._event(machine, "fabric_prefetch_suppressed", {
          reason: "one_way_blocked_side",
          entry_side: currentSide,
          allowed_entry_side: rule.allowed_entry_side,
          distance_m: machine.zone.distance_m,
        });
        this._emit();
      } else if (!suppressed && machine.zone.suppression_episode) {
        machine.zone.suppression_episode = false;
      }
      if (inside && !suppressed) {
        eligible.push(machine);
        continue;
      }
      machine.queued = false;
      machine.queued_episode = false;
      const fresh = regionFreshFor(machine);
      if (["warm", "resolving", "loading"].includes(machine.status)) {
        if (machine.status === "resolving" || machine.status === "loading") {
          machine.generation += 1;
          const reason = suppressed ? "one_way_blocked_side" : "zone_exited";
          this._event(machine, "fabric_prefetch_cancelled", {
            reason,
            distance_m: machine.zone.distance_m,
          });
          this._schedulerEvent("fabric_prefetch_cancelled", {
            portal_id: machine.portal_key,
            reason,
            distance_m: machine.zone.distance_m,
          });
        }
        machine.status = "cooling";
        this._event(machine, "prefetch_cooling", { keeps_payload_until_ttl_expiry: true });
        this._emit();
      } else if (machine.status === "cooling" && !fresh && machine.region.payload) {
        machine.region.payload = null;
        machine.presence.payload = null;
        machine.status = "idle";
        this._event(machine, "prefetch_expired_dropped");
        this._emit();
      }
    }

    eligible.sort((a, b) => {
      const ad = a.zone.distance_m == null ? Infinity : a.zone.distance_m;
      const bd = b.zone.distance_m == null ? Infinity : b.zone.distance_m;
      if (ad !== bd) return ad - bd;
      return String(a.portal_key) < String(b.portal_key) ? -1 : 1;
    });
    const order = eligible.map((machine) => machine.portal_key);
    if (order.join("|") !== scheduler.priority_order.join("|")) {
      scheduler.priority_order = order;
      if (order.length) {
        this._schedulerEvent("fabric_prefetch_priority_ranked", {
          order: order.slice(),
          distances: eligible.map((machine) => ({
            portal_id: machine.portal_key,
            distance_m: machine.zone.distance_m,
          })),
        });
      }
    }
    const selected = order.length ? order[0] : null;
    if (selected !== scheduler.selected_portal_id) {
      scheduler.selected_portal_id = selected;
      if (selected) {
        this._schedulerEvent("fabric_prefetch_priority_selected", {
          portal_id: selected,
          distance_m: eligible[0].zone.distance_m,
          target_location_id: eligible[0].target_location_id,
        });
      }
    }

    if (eligible.length) {
      const nearest = eligible[0];
      const wantsSlot =
        ["idle", "cooling", "error"].includes(nearest.status) &&
        !(nearest.status === "cooling" && regionFreshFor(nearest));
      if (wantsSlot && activeLoads() >= scheduler.budget) {
        for (const machine of Object.values(machines)) {
          if (machine === nearest || !["resolving", "loading"].includes(machine.status)) continue;
          if (
            machine.zone.distance_m == null ||
            nearest.zone.distance_m == null ||
            machine.zone.distance_m <=
              nearest.zone.distance_m + this.FABRIC_PREFETCH_PREEMPT_MARGIN_M
          ) {
            continue;
          }
          machine.generation += 1;
          machine.status = "idle";
          machine.queued = false;
          machine.queued_episode = false;
          this._event(machine, "fabric_prefetch_cancelled", {
            reason: "superseded_by_nearer_portal",
            superseded_by: nearest.portal_key,
            distance_m: machine.zone.distance_m,
            nearer_distance_m: nearest.zone.distance_m,
          });
          this._schedulerEvent("fabric_prefetch_cancelled", {
            portal_id: machine.portal_key,
            reason: "superseded_by_nearer_portal",
            superseded_by: nearest.portal_key,
          });
          this._emit();
        }
      }
    }

    for (const machine of eligible) {
      const fresh = regionFreshFor(machine);
      if (machine.status === "idle" || machine.status === "cooling") {
        if (machine.status === "cooling" && fresh) {
          machine.status = "warm";
          machine.queued = false;
          machine.queued_episode = false;
          this._event(machine, "prefetch_rewarmed_from_cache");
          this._startPresenceTimer();
          this._emit();
        } else if (activeLoads() < scheduler.budget) {
          const wasQueued = machine.queued;
          machine.queued = false;
          machine.queued_episode = false;
          machine.status = "resolving";
          this._event(machine, "fabric_prefetch_started", {
            address_uri: machine.address ? machine.address.uri : null,
            ...(wasQueued ? { released_from_queue: true } : {}),
          });
          if (wasQueued) {
            this._schedulerEvent("fabric_prefetch_queue_released", { portal_id: machine.portal_key });
          }
          const active = activeLoads();
          scheduler.active_load_count = active;
          scheduler.max_observed_active_loads = Math.max(scheduler.max_observed_active_loads, active);
          this._emit();
          this._runPipeline(machine);
        } else if (!machine.queued_episode) {
          machine.queued = true;
          machine.queued_episode = true;
          const holders = Object.values(machines)
            .filter((candidate) => ["resolving", "loading"].includes(candidate.status))
            .map((candidate) => candidate.portal_key);
          const detail = {
            reason: "budget_exhausted",
            budget: scheduler.budget,
            holding_portals: holders,
          };
          this._event(machine, "fabric_prefetch_queued", {
            ...detail,
            distance_m: machine.zone.distance_m,
          });
          this._schedulerEvent("fabric_prefetch_queued", { portal_id: machine.portal_key, ...detail });
          this._emit();
        }
      } else if (machine.status === "error") {
        const due = machine.region.next_retry_at_ms == null || nowMs >= machine.region.next_retry_at_ms;
        if (
          machine.region.attempts < this.FABRIC_PREFETCH_MAX_ATTEMPTS &&
          due &&
          activeLoads() < scheduler.budget
        ) {
          machine.status = "resolving";
          this._event(machine, "fabric_prefetch_retry", { attempt: machine.region.attempts + 1 });
          const active = activeLoads();
          scheduler.active_load_count = active;
          scheduler.max_observed_active_loads = Math.max(scheduler.max_observed_active_loads, active);
          this._runPipeline(machine);
        }
      } else if (machine.status === "warm") {
        if (!fresh) {
          this._event(machine, "fabric_region_expired_refreshing");
          this._runPipeline(machine);
        } else {
          const age =
            machine.presence.refreshed_at_ms == null
              ? Infinity
              : nowMs - machine.presence.refreshed_at_ms;
          if (age > this.FABRIC_PREFETCH_PRESENCE_REFRESH_MS) this.refreshPresence(machine);
        }
      }
    }
    const active = activeLoads();
    scheduler.active_load_count = active;
    scheduler.max_observed_active_loads = Math.max(scheduler.max_observed_active_loads, active);
  }

  async _runPipeline(machine) {
    if (!machine || !machine.supported || machine.fetchInFlight) return;
    machine.fetchInFlight = true;
    const generation = machine.generation;
    const proxyBase = this._resolveProxyBase(machine.address);
    try {
      machine.resolve.started_at = machine.resolve.started_at || this._nowIso();
      const wellKnown = await this._getJson(
        `${proxyBase}${machine.address.discovery.well_known}`,
      );
      if (machine.generation !== generation) {
        this._event(machine, "fabric_prefetch_pipeline_discarded", {
          stage: "resolve",
          reason: "cancelled_while_in_flight",
        });
        return;
      }
      machine.resolve.well_known_fabric_id = wellKnown ? wellKnown.fabric_id || null : null;
      if (machine.resolve.well_known_fabric_id !== machine.address.fabric_id) {
        throw new Error(
          `fabric_id_mismatch: address says ${machine.address.fabric_id}, ` +
            `destination advertises ${machine.resolve.well_known_fabric_id}`,
        );
      }
      machine.resolve.completed_at = this._nowIso();
      machine.resolve.error = null;
      if (machine.status === "resolving") machine.status = "loading";
      this._event(machine, "fabric_address_resolved", {
        fabric_id: machine.resolve.well_known_fabric_id,
      });
      machine.region.requested_at = this._nowIso();
      const regionBase =
        `${proxyBase}${machine.address.discovery.region_endpoint}` +
        `?anchor_portal_id=${encodeURIComponent(machine.address.anchor.portal_id)}` +
        `&radius_m=${encodeURIComponent(machine.address.roi_hint.radius_m)}`;
      let region = null;
      if (this.FABRIC_PREFETCH_CHUNKED_ENABLED) {
        const streamed = await this._runChunkStream(machine, generation, regionBase);
        if (streamed === "cancelled") return;
        region = streamed;
      }
      if (!region) {
        const single = await this._getJson(regionBase);
        if (machine.generation !== generation) {
          this._event(machine, "fabric_prefetch_pipeline_discarded", {
            stage: "region",
            reason: "cancelled_while_in_flight",
          });
          return;
        }
        machine.region.chunks = [];
        machine.region.bytes_total = fabricEntitiesByteSize(single ? single.entities : null);
        machine.region.progressive = {
          mode: "legacy_single_response",
          chunk_count: 1,
          reason: this.FABRIC_PREFETCH_CHUNKED_ENABLED
            ? "destination_without_chunked_contract"
            : "chunked_streaming_disabled",
        };
        region = single;
      }
      machine.region.payload = region;
      machine.region.loaded_at = this._nowIso();
      machine.region.loaded_at_ms = this._nowMs();
      machine.region.ttl_ms =
        region && region.freshness ? Number(region.freshness.ttl_ms) || 15000 : 15000;
      machine.region.error = null;
      machine.region.next_retry_at_ms = null;
      machine.last_used_at_ms = this._nowMs();
      this._adoptDestinationPortalPose(machine, region ? region.portal : null);
      this._enforceCache("region_stored");
      if (region && region.presence) {
        machine.presence.payload = region.presence;
        machine.presence.refreshed_at = this._nowIso();
        machine.presence.refreshed_at_ms = this._nowMs();
        machine.presence.ttl_ms = Number(region.presence.ttl_ms) || 4000;
      }
      machine.status = machine.zone.inside ? "warm" : "cooling";
      if (machine.status === "warm") this._startPresenceTimer();
      this._event(machine, "fabric_prefetch_ready", {
        region_entities: region && region.totals ? region.totals.region_entities : null,
        fabric_entities: region && region.totals ? region.totals.fabric_entities : null,
        excluded_entities: region && region.totals ? region.totals.excluded_entities : null,
        occupancy_count:
          region && region.presence && region.presence.occupancy
            ? (region.presence.occupancy.avatars || []).length
            : null,
        progressive_mode: machine.region.progressive ? machine.region.progressive.mode : null,
        chunk_count: machine.region.progressive ? machine.region.progressive.chunk_count : null,
        cached_bytes: machine.region.bytes_total || 0,
      });
      this._log(
        `fabric prefetch ready: ${machine.address.fabric_id} portal-neighborhood ` +
          `r=${machine.address.roi_hint.radius_m}m -> ` +
          `${region && region.totals ? region.totals.region_entities : "?"}/` +
          `${region && region.totals ? region.totals.fabric_entities : "?"} entities (read-only)`,
      );
    } catch (error) {
      const message = errorMessage(error);
      if (machine.generation !== generation) {
        this._event(machine, "fabric_prefetch_pipeline_discarded", {
          stage: "error",
          reason: "cancelled_while_in_flight",
          error: message,
        });
      } else {
        machine.status = "error";
        machine.region.error = message;
        machine.region.attempts += 1;
        machine.region.next_retry_at_ms =
          this._nowMs() + this.FABRIC_PREFETCH_RETRY_BACKOFF_MS * machine.region.attempts;
        this._event(machine, "fabric_prefetch_error", {
          error: message,
          attempt: machine.region.attempts,
        });
        this._log(`fabric prefetch failed (attempt ${machine.region.attempts}): ${message}`);
      }
    } finally {
      machine.fetchInFlight = false;
      this._emit();
    }
  }

  async _runChunkStream(machine, generation, regionBase) {
    const chunks = [];
    const entities = [];
    let cursor = null;
    let first = null;
    let lastTotals = null;
    let roundTrips = 0;
    machine.region.chunks = chunks;
    machine.region.bytes_total = 0;
    machine.region.progressive = null;
    machine.region.streaming = null;
    for (let i = 0; i < 64; i += 1) {
      const url =
        `${regionBase}&chunked=1&scope=roi` +
        `&max_entities=${this.FABRIC_PREFETCH_CHUNK_MAX_ENTITIES}` +
        `&max_bytes=${this.FABRIC_PREFETCH_CHUNK_MAX_BYTES}` +
        (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
      const response = await this._getJson(url);
      if (machine.generation !== generation) {
        this._event(machine, "fabric_prefetch_pipeline_discarded", {
          stage: "region_chunk",
          reason: "cancelled_while_in_flight",
          chunks_loaded_before_cancel: chunks.length,
        });
        machine.region.streaming = null;
        return "cancelled";
      }
      roundTrips += 1;
      if (!response || !response.chunk) {
        if (i === 0) {
          this._event(machine, "fabric_prefetch_chunk_mode_unavailable", {
            fallback: "legacy_single_response",
          });
          return null;
        }
        throw new Error("chunked region stream lost the chunk envelope mid-walk");
      }
      if (i === 0) first = response;
      lastTotals = response.totals || lastTotals;
      const chunk = {
        chunk_id: response.chunk.chunk_id,
        band_index: response.chunk.band_index,
        band_label: response.chunk.band_label,
        band_range_m: response.chunk.band_range_m,
        entity_count: response.chunk.entity_count,
        byte_size: response.chunk.byte_size,
        ...(response.chunk.byte_budget_exceeded_by_single_entity
          ? { byte_budget_exceeded_by_single_entity: true }
          : {}),
        freshness: response.chunk.freshness || null,
        truncated: !!response.truncated,
        truncation_reason: response.truncation_reason || null,
        loaded_at: this._nowIso(),
        loaded_at_ms: this._nowMs(),
        rendered_at: null,
        rendered_at_ms: null,
      };
      chunks.push(chunk);
      machine.region.bytes_total += chunk.byte_size || 0;
      for (const entity of response.chunk.entities || []) entities.push(entity);
      machine.region.streaming = {
        active: true,
        scope: "roi",
        entities: entities.slice(),
        avatars: first && first.avatars ? first.avatars : null,
        chunks_loaded: chunks.length,
        entity_count: entities.length,
        started_at: chunks[0].loaded_at,
      };
      this._event(machine, "fabric_prefetch_chunk_loaded", {
        chunk_id: chunk.chunk_id,
        band_index: chunk.band_index,
        band_label: chunk.band_label,
        entity_count: chunk.entity_count,
        byte_size: chunk.byte_size,
        truncated: chunk.truncated,
        truncation_reason: chunk.truncation_reason,
        continuation_cursor: response.continuation ? response.continuation.cursor : null,
        entities_accumulated: entities.length,
      });
      machine.last_used_at_ms = this._nowMs();
      this._enforceCache("chunk_stored");
      this._emit();
      if (!response.continuation) break;
      cursor = response.continuation.cursor;
      await this._delay(this.FABRIC_PREFETCH_CHUNK_YIELD_MS);
      if (machine.generation !== generation) {
        this._event(machine, "fabric_prefetch_pipeline_discarded", {
          stage: "region_chunk_yield",
          reason: "cancelled_while_in_flight",
          chunks_loaded_before_cancel: chunks.length,
        });
        machine.region.streaming = null;
        return "cancelled";
      }
    }
    machine.region.progressive = {
      mode: "chunked",
      scope: "roi",
      chunk_count: chunks.length,
      continuation_round_trips: roundTrips,
      budget_truncated_responses: chunks.filter(
        (chunk) => chunk.truncated && chunk.truncation_reason !== "band_boundary",
      ).length,
      band_order: chunks.map((chunk) => chunk.band_index),
      first_chunk_loaded_at: chunks.length ? chunks[0].loaded_at : null,
      last_chunk_loaded_at: chunks.length ? chunks[chunks.length - 1].loaded_at : null,
      client_max_entities: this.FABRIC_PREFETCH_CHUNK_MAX_ENTITIES,
      client_max_bytes: this.FABRIC_PREFETCH_CHUNK_MAX_BYTES,
      chunking_standard_conformance: false,
    };
    machine.region.streaming = null;
    const {
      chunk: _chunk,
      continuation: _continuation,
      truncated: _truncated,
      truncation_reason: _truncationReason,
      budget: _budget,
      ...contextFields
    } = first || {};
    return {
      ...contextFields,
      entities,
      totals: { ...(lastTotals || {}), truncated: false },
      freshness: {
        captured_at: this._nowIso(),
        ttl_ms:
          (chunks[0] && chunks[0].freshness && Number(chunks[0].freshness.ttl_ms)) || 15000,
      },
    };
  }

  notifyChunkRendered(portalKey, chunksRendered) {
    const machine = (this._machines || {})[portalKey];
    const count = Number(chunksRendered) || 0;
    if (!machine || !Array.isArray(machine.region.chunks) || count <= 0) return;
    const nowIso = this._nowIso();
    const nowMs = this._nowMs();
    let acknowledged = 0;
    for (let i = 0; i < Math.min(count, machine.region.chunks.length); i += 1) {
      const chunk = machine.region.chunks[i];
      if (chunk.rendered_at == null) {
        chunk.rendered_at = nowIso;
        chunk.rendered_at_ms = nowMs;
        acknowledged += 1;
        this._event(machine, "fabric_prefetch_chunk_rendered", {
          chunk_id: chunk.chunk_id,
          band_index: chunk.band_index,
          band_label: chunk.band_label,
          chunks_rendered: i + 1,
        });
      }
    }
    if (acknowledged) {
      machine.last_used_at_ms = nowMs;
      this._emit();
    }
  }

  _cacheCapBytes() {
    if (this._cacheCap) return this._cacheCap;
    let cap = this.FABRIC_PREFETCH_CACHE_MAX_BYTES;
    let source = "default";
    try {
      const raw = this._readCacheCapFixture();
      const parsed = Number(raw);
      if (raw != null && Number.isFinite(parsed) && parsed >= 1024) {
        cap = Math.floor(parsed);
        source = "query_param_fixture";
      }
    } catch (e) {
      /* default cap */
    }
    this._cacheCap = { cap_bytes: cap, source };
    return this._cacheCap;
  }

  _machineBytes(machine) {
    if (!machine) return 0;
    const holdsData =
      machine.region.payload ||
      machine.region.streaming ||
      (Array.isArray(machine.region.chunks) && machine.region.chunks.length);
    return holdsData ? machine.region.bytes_total || 0 : 0;
  }

  _enforceCache(trigger) {
    const machines = this._machines || {};
    const cap = this._cacheCapBytes();
    const stats =
      this._cacheStats ||
      (this._cacheStats = {
        max_observed_bytes: 0,
        peak_pre_enforcement_bytes: 0,
        eviction_count: 0,
        last_eviction: null,
        over_cap_unresolvable: false,
      });
    let total = Object.values(machines).reduce((sum, machine) => sum + this._machineBytes(machine), 0);
    stats.peak_pre_enforcement_bytes = Math.max(stats.peak_pre_enforcement_bytes, total);
    const before = total;
    if (total > cap.cap_bytes) {
      const selected = this._scheduler ? this._scheduler.selected_portal_id : null;
      const candidates = Object.values(machines)
        .filter((machine) => this._machineBytes(machine) > 0)
        .filter((machine) => machine.portal_key !== selected)
        .filter((machine) => !machine.zone.inside)
        .filter((machine) => !["resolving", "loading"].includes(machine.status))
        .sort((a, b) => (a.last_used_at_ms || 0) - (b.last_used_at_ms || 0));
      for (const victim of candidates) {
        if (total <= cap.cap_bytes) break;
        const freed = this._machineBytes(victim);
        victim.region.payload = null;
        victim.region.streaming = null;
        victim.region.chunks = [];
        victim.region.bytes_total = 0;
        victim.region.progressive = null;
        victim.presence.payload = null;
        if (["warm", "cooling", "error"].includes(victim.status)) victim.status = "idle";
        total -= freed;
        stats.eviction_count += 1;
        stats.last_eviction = {
          portal_id: victim.portal_key,
          bytes_freed: freed,
          cache_bytes_before: before,
          cache_bytes_after: total,
          cap_bytes: cap.cap_bytes,
          trigger,
          at: this._nowIso(),
        };
        this._event(victim, "fabric_prefetch_evicted", {
          reason: "cache_cap_lru",
          trigger,
          bytes_freed: freed,
          cache_bytes_before: before,
          cache_bytes_after: total,
          cap_bytes: cap.cap_bytes,
          last_used_at_ms: victim.last_used_at_ms,
        });
        this._schedulerEvent("fabric_prefetch_evicted", {
          portal_id: victim.portal_key,
          reason: "cache_cap_lru",
          bytes_freed: freed,
          cache_bytes_after: total,
          cap_bytes: cap.cap_bytes,
        });
        this._emit();
      }
      stats.over_cap_unresolvable = total > cap.cap_bytes;
    } else {
      stats.over_cap_unresolvable = false;
    }
    stats.max_observed_bytes = Math.max(stats.max_observed_bytes, total);
  }

  _cacheDebug() {
    const machines = this._machines || {};
    const cap = this._cacheCapBytes();
    const stats = this._cacheStats || {
      max_observed_bytes: 0,
      peak_pre_enforcement_bytes: 0,
      eviction_count: 0,
      last_eviction: null,
      over_cap_unresolvable: false,
    };
    let total = 0;
    const byPortal = {};
    for (const key of Object.keys(machines)) {
      const bytes = this._machineBytes(machines[key]);
      byPortal[key] = bytes;
      total += bytes;
    }
    return {
      _claim:
        "runtime prefetch cache accounting — total cached region bytes " +
        "bounded by cap_bytes via LRU eviction across cooled portals; local validation layer.",
      cap_bytes: cap.cap_bytes,
      cap_source: cap.source,
      total_bytes: total,
      bytes_by_portal: byPortal,
      max_observed_bytes_post_enforcement: stats.max_observed_bytes,
      peak_pre_enforcement_bytes: stats.peak_pre_enforcement_bytes,
      eviction_count: stats.eviction_count,
      last_eviction: stats.last_eviction,
      over_cap_unresolvable: stats.over_cap_unresolvable,
    };
  }

  async refreshPresence(machineOrPortalKey) {
    const machine =
      typeof machineOrPortalKey === "string"
        ? (this._machines || {})[machineOrPortalKey]
        : machineOrPortalKey;
    if (!machine || !machine.supported || !machine.address || machine.presenceFetchInFlight) return;
    machine.presenceFetchInFlight = true;
    const proxyBase = this._resolveProxyBase(machine.address);
    try {
      const presence = await this._getJson(
        `${proxyBase}${machine.address.discovery.presence_endpoint}`,
      );
      machine.presence.payload = presence;
      machine.presence.refreshed_at = this._nowIso();
      machine.presence.refreshed_at_ms = this._nowMs();
      machine.presence.ttl_ms = Number(presence && presence.ttl_ms) || 4000;
      machine.presence.refresh_count += 1;
      machine.presence.error = null;
      if (machine.presence.refresh_count === 1) {
        this._event(machine, "fabric_presence_refresh_started", {
          interval_ms: this.FABRIC_PREFETCH_PRESENCE_REFRESH_MS,
        });
      }
      this._emit();
    } catch (error) {
      machine.presence.error = errorMessage(error);
    } finally {
      machine.presenceFetchInFlight = false;
    }
  }

  _ensureLobbyOccupancyPoller() {
    this._stopLobbyOccupancyPoller();
    const portals = this._world && Array.isArray(this._world.portals) ? this._world.portals : [];
    if (this._clientMode !== "player" || portals.length < 2) {
      this._lobbyOccupancy = null;
      return;
    }
    this._lobbyOccupancy = {
      _claim:
        "multi-portal destination occupancy read — read-only GET /fabric/presence " +
        "against each portal destination (runtime registry truth); local validation layer.",
      refresh_ms: this.LOBBY_DESTINATION_OCCUPANCY_REFRESH_MS,
      updated_at: null,
      destinations: {},
    };
    const poll = async () => {
      const store = this._lobbyOccupancy;
      if (!store) return;
      for (const portal of portals) {
        const key = this._portalKey(portal);
        const address = portal.spatial_fabric_address || null;
        if (!key || !address || !address.discovery) continue;
        const proxyBase = this._resolveProxyBase(address);
        if (!proxyBase) continue;
        try {
          const presence = await this._getJson(
            `${proxyBase}${address.discovery.presence_endpoint}`,
          );
          store.destinations[key] = {
            portal_id: key,
            target_location_id: portal.target_location_id || null,
            occupancy: presence && presence.occupancy ? presence.occupancy : null,
            captured_at: this._nowIso(),
            error: null,
          };
        } catch (error) {
          store.destinations[key] = {
            portal_id: key,
            target_location_id: portal.target_location_id || null,
            occupancy: null,
            captured_at: this._nowIso(),
            error: errorMessage(error),
          };
        }
      }
      store.updated_at = this._nowIso();
      this._emit();
    };
    poll();
    this._lobbyOccupancyTimer = this._setInterval(
      poll,
      this.LOBBY_DESTINATION_OCCUPANCY_REFRESH_MS,
    );
  }

  _stopLobbyOccupancyPoller() {
    if (this._lobbyOccupancyTimer) {
      this._clearInterval(this._lobbyOccupancyTimer);
      this._lobbyOccupancyTimer = null;
    }
  }

  _machineDebug(machine, nowMs) {
    if (!machine) return null;
    return {
      status: machine.status,
      supported: machine.supported,
      portal_id: machine.portal_id,
      portal_key: machine.portal_key,
      label: machine.label,
      target_location_id: machine.target_location_id,
      address: machine.address,
      zones: machine.zones,
      zone: { ...machine.zone },
      traversal: machine.traversal,
      queued: machine.queued,
      resolve: { ...machine.resolve },
      region: {
        requested_at: machine.region.requested_at,
        loaded_at: machine.region.loaded_at,
        age_ms:
          machine.region.loaded_at_ms != null ? nowMs - machine.region.loaded_at_ms : null,
        ttl_ms: machine.region.ttl_ms,
        attempts: machine.region.attempts,
        error: machine.region.error,
        totals: machine.region.payload ? machine.region.payload.totals : null,
        entities: machine.region.payload
          ? machine.region.payload.entities
          : machine.region.streaming
            ? machine.region.streaming.entities
            : null,
        avatars: machine.region.payload
          ? machine.region.payload.avatars || null
          : machine.region.streaming
            ? machine.region.streaming.avatars || null
            : null,
        region: machine.region.payload ? machine.region.payload.region : null,
        destination_spawn: machine.region.payload ? machine.region.payload.spawn : null,
        destination_portal: machine.region.payload ? machine.region.payload.portal : null,
        bytes_total: machine.region.bytes_total || 0,
        chunks: Array.isArray(machine.region.chunks)
          ? machine.region.chunks.map((chunk) => ({ ...chunk }))
          : [],
        progressive: machine.region.progressive ? { ...machine.region.progressive } : null,
        streaming: machine.region.streaming
          ? {
              active: true,
              chunks_loaded: machine.region.streaming.chunks_loaded,
              entity_count: machine.region.streaming.entity_count,
              started_at: machine.region.streaming.started_at,
            }
          : null,
      },
      presence: {
        refreshed_at: machine.presence.refreshed_at,
        age_ms:
          machine.presence.refreshed_at_ms != null
            ? nowMs - machine.presence.refreshed_at_ms
            : null,
        ttl_ms: machine.presence.ttl_ms,
        refresh_count: machine.presence.refresh_count,
        error: machine.presence.error,
        occupancy:
          machine.presence.payload && machine.presence.payload.occupancy
            ? machine.presence.payload.occupancy
            : null,
        presence_scope:
          machine.presence.payload && machine.presence.payload.presence_scope
            ? machine.presence.payload.presence_scope
            : null,
      },
      events: machine.events.slice(-32),
    };
  }

  debug({ focusPortalId = this._focusPortalId } = {}) {
    if (!this._machines) return null;
    this._focusPortalId = focusPortalId;
    const nowMs = this._nowMs();
    const focus = this._focusMachine();
    const projection = this._machineDebug(focus, nowMs) || {};
    const scheduler = this._scheduler || {};
    const keyedMachines = {};
    for (const key of Object.keys(this._machines)) {
      keyedMachines[key] = this._machineDebug(this._machines[key], nowMs);
    }
    return {
      _claim:
        "addressable spatial fabric portal prefetch — project-local validation layer " +
        "(RP1 whitepaper documents proximity+LOD as a principle only; no published " +
        "standard defines a fabric region query). roi_standard_conformance:false.",
      ...projection,
      keyed: {
        _claim:
          "runtime keyed N-portal prefetch store — nearest-zone-first " +
          "priority, bounded concurrent loads, cancellation/cooling on walk-away; " +
          "local validation layer, no standards conformance claim.",
        portal_count: Object.keys(this._machines).length,
        budget: scheduler.budget ?? null,
        active_load_count: scheduler.active_load_count ?? 0,
        max_observed_active_loads: scheduler.max_observed_active_loads ?? 0,
        priority_order: Array.isArray(scheduler.priority_order)
          ? scheduler.priority_order.slice()
          : [],
        selected_portal_id: scheduler.selected_portal_id ?? null,
        focus_portal_id: focus ? focus.portal_key : null,
        machines: keyedMachines,
        scheduler_events: Array.isArray(scheduler.events) ? scheduler.events.slice(-20) : [],
        destination_occupancy: this._lobbyOccupancy,
        cache: this._cacheDebug(),
      },
      completion: this.completionDebug(),
      last_promoted: this._lastPromoted,
      validation: { read_only_before_crossing: true, roi_standard_conformance: false },
    };
  }

  proofBlock(commitIso, portalKey) {
    const machine =
      (portalKey && (this._machines || {})[portalKey]) || this._focusMachine();
    const commitMs = this._nowMs();
    if (!machine || !machine.supported) {
      return {
        _claim: "addressable spatial fabric portal prefetch validation — local layer only",
        used: false,
        reason: machine ? "no_address_on_portal" : "prefetch_uninitialized",
        prefetch_before_commit: false,
        roi_standard_conformance: false,
      };
    }
    const fresh =
      machine.region.loaded_at_ms != null &&
      machine.region.ttl_ms != null &&
      commitMs - machine.region.loaded_at_ms <= machine.region.ttl_ms;
    const used = !!machine.region.payload && fresh;
    if (used) machine.last_used_at_ms = commitMs;
    return {
      _claim: "addressable spatial fabric portal prefetch validation — local layer only",
      used,
      reason: used
        ? null
        : machine.region.payload
          ? "region_stale_at_commit"
          : "cold_at_commit",
      status_at_commit: machine.status,
      portal_key: machine.portal_key,
      address_uri: machine.address ? machine.address.uri : null,
      fabric_id: machine.address ? machine.address.fabric_id : null,
      zone_entered_at: machine.zone.entered_at,
      region_loaded_at: machine.region.loaded_at,
      presence_refreshed_at: machine.presence.refreshed_at,
      warm_age_ms_at_commit:
        machine.region.loaded_at_ms != null ? commitMs - machine.region.loaded_at_ms : null,
      region_totals: machine.region.payload ? machine.region.payload.totals : null,
      occupancy_at_commit:
        machine.presence.payload && machine.presence.payload.occupancy
          ? {
              avatars: (machine.presence.payload.occupancy.avatars || []).map(
                (avatar) => avatar.display_name || avatar.avatar_id,
              ),
              registered_player_count:
                machine.presence.payload.occupancy.registered_player_count ?? null,
              arrival_count: machine.presence.payload.occupancy.arrival_count,
              live_subscriber_count: machine.presence.payload.occupancy.live_subscriber_count,
            }
          : null,
      prefetch_before_commit:
        machine.region.loaded_at_ms != null && machine.region.loaded_at_ms <= commitMs,
      destination_circle:
        machine.region.payload && machine.region.payload.avatars
          ? {
              radius_m:
                machine.region.payload.region &&
                machine.region.payload.region.radius_m != null
                  ? machine.region.payload.region.radius_m
                  : null,
              avatars_in_circle_at_commit:
                machine.region.payload.avatars.avatars_in_circle ?? null,
              includes_avatars: true,
            }
          : null,
      progressive_at_commit: machine.region.streaming
        ? {
            streaming_mid_pipeline: true,
            chunks_loaded: machine.region.streaming.chunks_loaded,
            entities_accumulated: machine.region.streaming.entity_count,
          }
        : machine.region.progressive
          ? {
              mode: machine.region.progressive.mode,
              chunk_count: machine.region.progressive.chunk_count,
              budget_truncated_responses:
                machine.region.progressive.budget_truncated_responses ?? null,
            }
          : null,
      committed_at: commitIso,
      roi_standard_conformance: false,
    };
  }

  capturePromotionInput(validation) {
    const machine =
      validation && validation.portal_key && this._machines ? this._machines[validation.portal_key] : null;
    const originEntityIds =
      machine && machine.region.payload && Array.isArray(machine.region.payload.entities)
        ? machine.region.payload.entities.map((entity) => entity.object_id)
        : [];
    return {
      validation: validation || null,
      origin_entity_ids: originEntityIds,
      origin_entity_count: originEntityIds.length,
    };
  }

  recordPromotion(record, validation) {
    this._lastPromoted = {
      promoted_at: record ? record.promoted_at : null,
      handoff_id: record ? record.handoff_id : null,
      promoted_with_prefetch: !!(validation && validation.used),
      validation: validation || null,
    };
    return this._lastPromoted;
  }

  startCompletion(context = {}) {
    if (this._clientMode !== "player" || !this._world) return;
    const anchorPortalId = this._world.portal ? this._portalKey(this._world.portal) : null;
    if (!anchorPortalId) return;
    this._completionGeneration += 1;
    const generation = this._completionGeneration;
    const warmResume = !!(context.validation && context.validation.used) && context.origin_entity_count > 0;
    const job = {
      _claim:
        "runtime post-arrival background fabric completion — paced " +
        "read-only chunked GETs finish the promoted world's remaining entities " +
        "without blocking interaction; local validation layer.",
      status: "running",
      location_id: this._world.location_id,
      fabric_id: "local-fabric-" + this._world.location_id,
      anchor_portal_id: anchorPortalId,
      handoff_id: context.handoff_id || null,
      started_at: this._nowIso(),
      started_at_ms: this._nowMs(),
      pacing_ms: this.FABRIC_COMPLETION_PACING_MS,
      chunk_max_entities: this.FABRIC_COMPLETION_CHUNK_MAX_ENTITIES,
      origin_prefetch: {
        used: !!(context.validation && context.validation.used),
        portal_key: context.validation ? context.validation.portal_key : null,
        entity_count: context.origin_entity_count || 0,
        resume_cursor: warmResume ? "3:0" : null,
        resume_rule: warmResume
          ? "warm prefetch already holds the complete ROI (bands 0-2); completion resumes at the beyond-ROI band"
          : "cold or stale at commit; completion walks the full fabric from the near band",
      },
      chunks: [],
      entities_added: 0,
      bytes_total: 0,
      input_activity: {
        rule:
          "avatar pose sampled before every chunk fetch; a positive movement " +
          "sample means input was processed while completion was in flight",
        sample_count: 0,
        movement_samples: 0,
        max_step_m: 0,
        first_sample_at: null,
        last_sample_at: null,
      },
      reconciliation: null,
      completed_at: null,
      completed_at_ms: null,
      error: null,
      events: [],
      cancel_reason: null,
    };
    this._completion = job;
    const jobEvent = (event, detail) => {
      job.events.push({ event, at: this._nowIso(), ...(detail || {}) });
      if (job.events.length > 40) job.events.splice(0, job.events.length - 40);
    };
    jobEvent("fabric_completion_started", {
      resume_cursor: job.origin_prefetch.resume_cursor,
      origin_entities: job.origin_prefetch.entity_count,
      pacing_ms: job.pacing_ms,
    });
    this._emit();
    const seen = new Set(context.origin_entity_ids || []);
    let lastSamplePos = null;
    const sampleInput = () => {
      const raw = this._getAvatarPose();
      const position = Array.isArray(raw)
        ? raw.slice()
        : raw && Array.isArray(raw.position)
          ? raw.position.slice()
          : raw && raw.transform && Array.isArray(raw.transform.position)
            ? raw.transform.position.slice()
            : null;
      if (!position) return;
      const nowIso = this._nowIso();
      job.input_activity.sample_count += 1;
      if (!job.input_activity.first_sample_at) job.input_activity.first_sample_at = nowIso;
      job.input_activity.last_sample_at = nowIso;
      if (lastSamplePos) {
        const step = Math.hypot(
          position[0] - lastSamplePos[0],
          position[1] - lastSamplePos[1],
          position[2] - lastSamplePos[2],
        );
        if (step > 0.02) {
          job.input_activity.movement_samples += 1;
          job.input_activity.max_step_m = Math.max(
            job.input_activity.max_step_m,
            Number(step.toFixed(3)),
          );
        }
      }
      lastSamplePos = position;
    };
    const run = async () => {
      try {
        let cursor = job.origin_prefetch.resume_cursor;
        let expectedTotals = null;
        for (let i = 0; i < this.FABRIC_COMPLETION_MAX_CHUNKS; i += 1) {
          sampleInput();
          const url =
            `${this._getActiveBase()}/fabric/region` +
            `?anchor_portal_id=${encodeURIComponent(job.anchor_portal_id)}` +
            `&chunked=1&scope=full` +
            `&max_entities=${this.FABRIC_COMPLETION_CHUNK_MAX_ENTITIES}` +
            (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
          const response = await this._getJson(url);
          if (generation !== this._completionGeneration || this._completion !== job) {
            job.status = "cancelled";
            jobEvent("fabric_completion_cancelled", {
              reason: job.cancel_reason || "superseded_by_new_promotion",
            });
            return;
          }
          if (!response || !response.chunk) {
            job.status = "unsupported_by_server";
            jobEvent("fabric_completion_unsupported", {
              reason: "destination_without_chunked_contract",
            });
            this._emit();
            return;
          }
          expectedTotals = response.totals || expectedTotals;
          let added = 0;
          for (const entity of response.chunk.entities || []) {
            if (!seen.has(entity.object_id)) {
              seen.add(entity.object_id);
              added += 1;
            }
          }
          job.entities_added += added;
          job.bytes_total += response.chunk.byte_size || 0;
          job.chunks.push({
            chunk_id: response.chunk.chunk_id,
            band_index: response.chunk.band_index,
            band_label: response.chunk.band_label,
            entity_count: response.chunk.entity_count,
            new_entities: added,
            byte_size: response.chunk.byte_size,
            truncated: !!response.truncated,
            truncation_reason: response.truncation_reason || null,
            continuation_cursor: response.continuation ? response.continuation.cursor : null,
            loaded_at: this._nowIso(),
          });
          jobEvent("fabric_completion_chunk_loaded", {
            chunk_id: response.chunk.chunk_id,
            band_label: response.chunk.band_label,
            entity_count: response.chunk.entity_count,
            new_entities: added,
            entities_total: seen.size,
          });
          this._emit();
          if (!response.continuation) break;
          cursor = response.continuation.cursor;
          await this._delay(this.FABRIC_COMPLETION_PACING_MS);
        }
        if (generation !== this._completionGeneration || this._completion !== job) {
          job.status = "cancelled";
          jobEvent("fabric_completion_cancelled", {
            reason: job.cancel_reason || "superseded_by_new_promotion",
          });
          return;
        }
        sampleInput();
        const expected = expectedTotals ? expectedTotals.fabric_entities : null;
        job.completed_at = this._nowIso();
        job.completed_at_ms = this._nowMs();
        job.reconciliation = {
          expected_fabric_entities: expected,
          origin_prefetch_entities: job.origin_prefetch.entity_count,
          completion_added_entities: job.entities_added,
          received_unique_entities: seen.size,
          match: expected != null && seen.size === expected,
          duration_ms: job.completed_at_ms - job.started_at_ms,
          input_during_completion: {
            sample_count: job.input_activity.sample_count,
            movement_samples: job.input_activity.movement_samples,
            max_step_m: job.input_activity.max_step_m,
          },
        };
        job.status = job.reconciliation.match ? "complete" : "complete_with_mismatch";
        jobEvent("fabric_completion_reconciled", {
          match: job.reconciliation.match,
          received_unique_entities: seen.size,
          expected_fabric_entities: expected,
          duration_ms: job.reconciliation.duration_ms,
        });
        const completionSummary = {
          status: job.status,
          started_at: job.started_at,
          completed_at: job.completed_at,
          entities_added: job.entities_added,
          received_unique_entities: seen.size,
          expected_fabric_entities: expected,
          match: job.reconciliation.match,
          recorded_at: this._nowIso(),
        };
        if (context.promotion_record) context.promotion_record.fabric_completion = completionSummary;
        if (this._lastPromoted && this._lastPromoted.handoff_id === job.handoff_id) {
          this._lastPromoted.fabric_completion = completionSummary;
        }
        jobEvent("fabric_completion_recorded_into_promotion", { handoff_id: job.handoff_id });
        this._emit();
        this._log(
          `fabric completion ${job.status}: ${job.location_id} ` +
            `${seen.size}/${expected != null ? expected : "?"} entities ` +
            `(+${job.entities_added} beyond prefetch) in ${job.reconciliation.duration_ms}ms, ` +
            `${job.input_activity.movement_samples} movement samples during completion`,
        );
      } catch (error) {
        if (this._completion === job && generation === this._completionGeneration) {
          job.status = "error";
          job.error = errorMessage(error);
          jobEvent("fabric_completion_error", { error: job.error });
          this._emit();
        }
      }
    };
    run();
    return job;
  }

  cancelCompletion(reason = "cancelled") {
    this._completionGeneration += 1;
    if (this._completion) this._completion.cancel_reason = reason;
    this._completion = null;
  }

  completionDebug() {
    const job = this._completion;
    if (!job) return null;
    return {
      _claim: job._claim,
      status: job.status,
      location_id: job.location_id,
      fabric_id: job.fabric_id,
      anchor_portal_id: job.anchor_portal_id,
      handoff_id: job.handoff_id,
      started_at: job.started_at,
      pacing_ms: job.pacing_ms,
      chunk_max_entities: job.chunk_max_entities,
      origin_prefetch: { ...job.origin_prefetch },
      chunk_count: job.chunks.length,
      chunks: job.chunks.slice(-12).map((chunk) => ({ ...chunk })),
      entities_added: job.entities_added,
      bytes_total: job.bytes_total,
      input_activity: { ...job.input_activity },
      reconciliation: job.reconciliation ? { ...job.reconciliation } : null,
      completed_at: job.completed_at,
      error: job.error,
      events: job.events.slice(-12),
    };
  }

  removePresencePlayer({ playerId, targetLocationId, endpointKey, receivedAtMs } = {}) {
    const output = {
      prefetch_presence_removed: 0,
      prefetch_snapshot_removed: 0,
      lobby_occupancy_removed: 0,
      affected_portal_keys: [],
      presence_refresh_count_before: {},
      presence_refresh_count_after: {},
      next_poll_due_at_ms: null,
    };
    if (!playerId) return output;
    const removePlayer = (owner, key) => {
      if (!owner || !Array.isArray(owner[key])) return 0;
      const before = owner[key].length;
      owner[key] = owner[key].filter((avatar) => !avatar || avatar.player_id !== playerId);
      return before - owner[key].length;
    };
    for (const [portalKey, machine] of Object.entries(this._machines || {})) {
      if (!machine || (targetLocationId && machine.target_location_id !== targetLocationId)) continue;
      output.presence_refresh_count_before[portalKey] = Number(machine.presence.refresh_count || 0);
      const occupancy = machine.presence.payload && machine.presence.payload.occupancy;
      const liveRemoved = removePlayer(occupancy, "avatars");
      if (occupancy && liveRemoved && "registered_player_count" in occupancy) {
        occupancy.registered_player_count = occupancy.avatars.length;
      }
      const regionAvatars = machine.region.payload && machine.region.payload.avatars;
      const streamingAvatars = machine.region.streaming && machine.region.streaming.avatars;
      const regionRemoved = removePlayer(regionAvatars, "avatars");
      const streamingRemoved = removePlayer(streamingAvatars, "avatars");
      const snapshotRemoved = regionRemoved + streamingRemoved;
      if (regionAvatars && regionRemoved && "avatars_in_circle" in regionAvatars) {
        regionAvatars.avatars_in_circle = regionAvatars.avatars.length;
      }
      if (streamingAvatars && streamingRemoved && "avatars_in_circle" in streamingAvatars) {
        streamingAvatars.avatars_in_circle = streamingAvatars.avatars.length;
      }
      output.prefetch_presence_removed += liveRemoved;
      output.prefetch_snapshot_removed += snapshotRemoved;
      output.presence_refresh_count_after[portalKey] = Number(machine.presence.refresh_count || 0);
      const received = receivedAtMs == null ? this._nowMs() : receivedAtMs;
      const nextPoll =
        machine.presence.refreshed_at_ms != null
          ? machine.presence.refreshed_at_ms + this.FABRIC_PREFETCH_PRESENCE_REFRESH_MS
          : received + this.FABRIC_PREFETCH_PRESENCE_REFRESH_MS;
      output.next_poll_due_at_ms =
        output.next_poll_due_at_ms == null
          ? nextPoll
          : Math.min(output.next_poll_due_at_ms, nextPoll);
      if (liveRemoved || snapshotRemoved) {
        output.affected_portal_keys.push(portalKey);
        this._event(machine, "presence_user_left_push", {
          endpoint_key: endpointKey,
          player_id: playerId,
          live_removed: liveRemoved,
          snapshot_removed: snapshotRemoved,
        });
      }
    }
    const destinations = this._lobbyOccupancy ? this._lobbyOccupancy.destinations : {};
    for (const destination of Object.values(destinations || {})) {
      if (!destination || (targetLocationId && destination.target_location_id !== targetLocationId)) {
        continue;
      }
      const removed = removePlayer(destination.occupancy, "avatars");
      output.lobby_occupancy_removed += removed;
      if (
        destination.occupancy &&
        removed &&
        "registered_player_count" in destination.occupancy
      ) {
        destination.occupancy.registered_player_count = destination.occupancy.avatars.length;
      }
    }
    return output;
  }

  compatibilityState() {
    return {
      machines: this._machines,
      scheduler: this._scheduler,
      completion: this._completion,
      lastPromoted: this._lastPromoted,
      lobbyOccupancy: this._lobbyOccupancy,
      presenceTimer: this._presenceTimer,
      lobbyOccupancyTimer: this._lobbyOccupancyTimer,
      cacheCap: this._cacheCap,
      cacheStats: this._cacheStats,
    };
  }

  dispose() {
    this._stopPresenceTimer();
    this._stopLobbyOccupancyPoller();
    if (this._machines) {
      for (const machine of Object.values(this._machines)) machine.generation += 1;
    }
    this.cancelCompletion("disposed");
  }
}
