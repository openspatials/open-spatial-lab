import { createFabricPrefetchController } from "./live-adapter-fabric-prefetch-controller.mjs";
import { fabricPortalKey, normalizePortalTraversal, portalEntrySideAllowed } from "./live-adapter-portal-geometry.mjs";

export function bindFabricPrefetch(capabilities) {
  return createFabricPrefetchController({
    ...capabilities,
    nowMs: () => Date.now(), nowIso: () => new Date().toISOString(),
    setIntervalFn: (fn, ms) => setInterval(fn, ms), clearIntervalFn: (id) => clearInterval(id),
    setTimeoutFn: (fn, ms) => setTimeout(fn, ms),
    portalKey: fabricPortalKey, normalizeTraversal: normalizePortalTraversal, portalEntrySideAllowed,
    readCacheCapFixture: () => typeof window === "undefined" || !window.location
      ? null : new URLSearchParams(window.location.search).get("fabric_cache_cap_bytes"),
    destinationOccupancy: false,
  });
}

export function installFabricPrefetchViews({ defineProperty, readController }) {
    const fabricCompatibilityViews = {
      _fabricPrefetchMachines: "machines",
      _fabricPrefetchScheduler: "scheduler",
      _fabricCompletion: "completion",
      _lastPromotedFabricPrefetch: "lastPromoted",
      _lobbyDestinationOccupancy: "lobbyOccupancy",
      _fabricPresenceTimer: "presenceTimer",
      _lobbyDestinationOccupancyTimer: "lobbyOccupancyTimer",
      _fabricCacheCap: "cacheCap",
      _fabricCacheStats: "cacheStats",
    };
    for (const [property, stateKey] of Object.entries(fabricCompatibilityViews)) {
      defineProperty(property, {
        configurable: true,
        enumerable: false,
        get: () => readController().compatibilityState()[stateKey],
      });
    }
    for (const property of [
      "FABRIC_PREFETCH_PRESENCE_REFRESH_MS",
      "FABRIC_PREFETCH_MAX_ATTEMPTS",
      "FABRIC_PREFETCH_RETRY_BACKOFF_MS",
      "FABRIC_PREFETCH_MAX_ACTIVE_LOADS",
      "FABRIC_PREFETCH_PREEMPT_MARGIN_M",
      "LOBBY_DESTINATION_OCCUPANCY_REFRESH_MS",
      "FABRIC_PREFETCH_CHUNKED_ENABLED",
      "FABRIC_PREFETCH_CHUNK_MAX_ENTITIES",
      "FABRIC_PREFETCH_CHUNK_MAX_BYTES",
      "FABRIC_PREFETCH_CHUNK_YIELD_MS",
      "FABRIC_PREFETCH_CACHE_MAX_BYTES",
      "FABRIC_COMPLETION_PACING_MS",
      "FABRIC_COMPLETION_CHUNK_MAX_ENTITIES",
      "FABRIC_COMPLETION_MAX_CHUNKS",
    ]) {
      defineProperty(property, {
        configurable: true,
        enumerable: false,
        get: () => readController()[property],
        set: (value) => { readController()[property] = value; },
      });
    }
}
