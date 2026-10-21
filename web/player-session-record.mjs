/**
 * Pure value helpers for the browser player's reload-session record.
 *
 * Storage, clocks, navigation, and runtime state stay with app.js. This module
 * only parses and constructs the serializable record shared by those seams.
 */

const PLAYER_SESSION_RECORD_VERSION = 1;

/**
 * Parse the persisted JSON value while preserving the version-1 record shape.
 *
 * @param {string} serialized Persisted JSON from the caller-owned store.
 * @returns {object|null} The parsed version-1 record, or null when unreadable.
 */
export function parsePlayerSessionRecord(serialized) {
  try {
    const record = JSON.parse(serialized);
    if (!record || record.version !== PLAYER_SESSION_RECORD_VERSION) return null;
    return record;
  } catch {
    return null;
  }
}

/**
 * Build the exact reload-session value written by the browser composition root.
 *
 * @param {object} values Record inputs already selected from live runtime state.
 * @returns {object} A serializable version-1 player-session record.
 */
export function createPlayerSessionRecord({
  activeEndpointKey,
  locationId,
  position,
  rotationY,
  orbitAzimuthRad,
  orbitPolarRad,
  orbitDistanceM,
  cameraMode,
  savedAt,
}) {
  return {
    version: PLAYER_SESSION_RECORD_VERSION,
    active_endpoint_key: activeEndpointKey,
    location_id: locationId,
    position: Array.isArray(position) ? position.slice(0, 3).map(Number) : null,
    rotation_y: Number.isFinite(Number(rotationY)) ? Number(rotationY) : null,
    orbit_azimuth_rad: Number.isFinite(orbitAzimuthRad) ? Number(orbitAzimuthRad) : null,
    orbit_polar_rad: Number.isFinite(orbitPolarRad) ? Number(orbitPolarRad) : null,
    orbit_distance_m: Number.isFinite(orbitDistanceM) ? Number(orbitDistanceM) : null,
    camera_mode: cameraMode,
    saved_at: savedAt,
  };
}
