import {
  createPlayerSessionRecord,
  parsePlayerSessionRecord,
} from "./player-session-record.mjs";

const PLAYER_SESSION_STORAGE_KEY = "wow-player-session-v1";
const PLAYER_SESSION_SAVE_INTERVAL_MS = 400;

function navigationTypeAtBoot(readNavigationEntries) {
  try {
    const entries = readNavigationEntries();
    return entries && entries[0] && entries[0].type ? entries[0].type : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Own the browser player's manual-reload persistence policy.
 *
 * The caller retains runtime snapshot composition and supplies narrow browser
 * dependencies so this controller stays deterministic and directly testable.
 *
 * @param {object} dependencies Persistence and clock dependencies.
 * @returns {object} Manual-reload boot, restore, and persistence operations.
 */
export function createPlayerSessionController({
  getStorage,
  readNavigationEntries,
  elapsedNow,
  savedAtNow,
}) {
  const bootNavigationType = navigationTypeAtBoot(readNavigationEntries);
  let saveThrottleAt = 0;

  function readRecord() {
    try {
      const storage = getStorage();
      const raw = storage ? storage.getItem(PLAYER_SESSION_STORAGE_KEY) : null;
      return raw ? parsePlayerSessionRecord(raw) : null;
    } catch {
      return null;
    }
  }

  function resolveBootActive({ isPlayer, activeParam }) {
    if (isPlayer && bootNavigationType === "reload") {
      const record = readRecord();
      if (record && (record.active_endpoint_key === "a" || record.active_endpoint_key === "b")) {
        return record.active_endpoint_key;
      }
    }
    return activeParam;
  }

  function readRestorable({ isPlayer, activeEndpointKey }) {
    if (!isPlayer || bootNavigationType !== "reload") return null;
    const record = readRecord();
    if (!record || record.active_endpoint_key !== activeEndpointKey) return null;
    return Array.isArray(record.position) ? record : null;
  }

  function persist({ isPlayer, force = false, getSnapshot }) {
    if (!isPlayer || typeof getSnapshot !== "function") return false;
    const now = elapsedNow();
    if (!force && now - saveThrottleAt < PLAYER_SESSION_SAVE_INTERVAL_MS) return false;
    saveThrottleAt = now;

    try {
      const snapshot = getSnapshot();
      if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return false;
      const record = createPlayerSessionRecord({
        activeEndpointKey: snapshot.activeEndpointKey || snapshot.activeParam || "a",
        locationId: snapshot.locationId,
        position: snapshot.position,
        rotationY: snapshot.rotationY,
        orbitAzimuthRad: snapshot.orbitAzimuthRad,
        orbitPolarRad: snapshot.orbitPolarRad,
        orbitDistanceM: snapshot.orbitDistanceM,
        cameraMode: snapshot.cameraMode,
        savedAt: savedAtNow(),
      });
      const storage = getStorage();
      if (!storage) return false;
      storage.setItem(PLAYER_SESSION_STORAGE_KEY, JSON.stringify(record));
      return true;
    } catch {
      return false;
    }
  }

  return Object.freeze({ persist, readRestorable, resolveBootActive });
}
