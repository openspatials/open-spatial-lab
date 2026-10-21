// Web of Worlds frames, GeoPose and geodesy: one implementation for the world server (CommonJS)
// and the browser (ES modules, through web/wow-geopose.mjs).
//
// THE FRAME CONVENTION. Every Web of Worlds coordinate is in metres, right-handed, +Y up. A
// graph's GeoPose anchors the graph's origin on the WGS-84 ellipsoid. At zero angles the graph's
// +X axis points east, +Y points up and +Z points south. All positions inside a graph are local
// to their parent node; they are never stored as Earth-centred or geographic values.
//
// THE ONE ASSUMPTION. GeoPose Basic-YPR gives yaw, pitch and roll in degrees. This file assumes
// that a positive angle turns right-handedly about the local east-north-up axis it names
// (positive yaw turns east toward north), and that the three turns compose as yaw about up, then
// pitch about north, then roll about east. The GeoPose working group has not confirmed either
// point. They live in ROTATION_CONVENTION and nowhere else, so a different answer is one edit.
//
// Geodesy follows EPSG method 9837 on WGS-84 (geographic to topocentric), in doubles.
(function (root, factory) {
  const api = factory();
  // CommonJS callers get module.exports. Every caller also gets the global, which is how the
  // ES-module face (web/wow-geopose.mjs) reaches the same object in a browser and in Node.
  if (typeof module === "object" && module.exports) module.exports = api;
  root.OslWowGeoPose = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const WGS84 = Object.freeze({
    a: 6378137.0,
    f: 1 / 298.257223563,
    e2: (1 / 298.257223563) * (2 - 1 / 298.257223563),
  });

  const ROTATION_CONVENTION = Object.freeze({
    order: "yaw-pitch-roll",
    // Row-major product, applied right to left: R = Rup(yaw) * Rnorth(pitch) * Reast(roll).
    // A sense of +1 turns right-handedly about the named axis; -1 reverses that turn.
    senses: Object.freeze({ yaw: 1, pitch: 1, roll: 1 }),
    status: "assumption, not yet confirmed with the GeoPose working group",
  });

  const RAD = Math.PI / 180;

  // ---------------------------------------------------------------------------------------
  // Vectors and matrices (plain arrays; matrices are row-major 3x3).
  // ---------------------------------------------------------------------------------------
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
  const matMul = (a, b) => {
    const out = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let i = 0; i < 3; i += 1) for (let j = 0; j < 3; j += 1) {
      out[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j];
    }
    return out;
  };
  const matVec = (m, v) => [dot(m[0], v), dot(m[1], v), dot(m[2], v)];

  // ---------------------------------------------------------------------------------------
  // Geodesy.
  // ---------------------------------------------------------------------------------------

  /** Geographic degrees and metres above the ellipsoid to Earth-centred, Earth-fixed metres. */
  function ecef(lat, lon, h) {
    const p = lat * RAD;
    const l = lon * RAD;
    const n = WGS84.a / Math.sqrt(1 - WGS84.e2 * Math.sin(p) ** 2);
    return [
      (n + h) * Math.cos(p) * Math.cos(l),
      (n + h) * Math.cos(p) * Math.sin(l),
      (n * (1 - WGS84.e2) + h) * Math.sin(p),
    ];
  }

  /** East, north and up unit vectors at (lat, lon), in Earth-centred coordinates. */
  function enuAxes(lat, lon) {
    const p = lat * RAD;
    const l = lon * RAD;
    return {
      east: [-Math.sin(l), Math.cos(l), 0],
      north: [-Math.sin(p) * Math.cos(l), -Math.sin(p) * Math.sin(l), Math.cos(p)],
      up: [Math.cos(p) * Math.cos(l), Math.cos(p) * Math.sin(l), Math.sin(p)],
    };
  }

  /** Earth-centred metres to geographic degrees and ellipsoidal height (iterative, to 1e-13 rad). */
  function geodetic(x, y, z) {
    const lon = Math.atan2(y, x);
    const p = Math.hypot(x, y);
    let lat = Math.atan2(z, p * (1 - WGS84.e2));
    let h = 0;
    for (let i = 0; i < 12; i += 1) {
      const sin = Math.sin(lat);
      const n = WGS84.a / Math.sqrt(1 - WGS84.e2 * sin * sin);
      h = Math.abs(Math.cos(lat)) > 1e-9 ? p / Math.cos(lat) - n : Math.abs(z) / Math.abs(sin) - n * (1 - WGS84.e2);
      const next = Math.atan2(z, p * (1 - (WGS84.e2 * n) / (n + h)));
      const moved = Math.abs(next - lat);
      lat = next;
      if (moved < 1e-14) break;
    }
    return { lat: lat / RAD, lon: lon / RAD, h };
  }

  // ---------------------------------------------------------------------------------------
  // Orientation.
  // ---------------------------------------------------------------------------------------
  const turn = (axis, angle) => {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    if (axis === 0) return [[1, 0, 0], [0, c, -s], [0, s, c]];
    if (axis === 1) return [[c, 0, s], [0, 1, 0], [-s, 0, c]];
    return [[c, -s, 0], [s, c, 0], [0, 0, 1]];
  };

  /** Rotation of a GeoPose's angles, in east-north-up coordinates (row-major 3x3). */
  function rotationFromAngles(angles) {
    const k = ROTATION_CONVENTION.senses;
    const yaw = turn(2, k.yaw * (angles.yaw || 0) * RAD);
    const pitch = turn(1, k.pitch * (angles.pitch || 0) * RAD);
    const roll = turn(0, k.roll * (angles.roll || 0) * RAD);
    return matMul(matMul(yaw, pitch), roll);
  }

  /** The angles, in degrees, of a rotation built by rotationFromAngles (pitch within +/-90). */
  function anglesFromRotation(r) {
    const k = ROTATION_CONVENTION.senses;
    const pitch = Math.asin(Math.max(-1, Math.min(1, -r[2][0])));
    let yaw;
    let roll;
    if (Math.abs(r[2][0]) < 1 - 1e-12) {
      yaw = Math.atan2(r[1][0], r[0][0]);
      roll = Math.atan2(r[2][1], r[2][2]);
    } else {
      // Gimbal lock: roll and yaw share an axis. Put everything in yaw.
      roll = 0;
      yaw = Math.atan2(-r[0][1], r[1][1]);
    }
    return { yaw: (yaw / RAD) * k.yaw, pitch: (pitch / RAD) * k.pitch, roll: (roll / RAD) * k.roll };
  }

  // ---------------------------------------------------------------------------------------
  // Frames. A frame is a graph's origin and axes in Earth-centred coordinates.
  // ---------------------------------------------------------------------------------------

  /**
   * The frame a graph anchored at `geoPose` defines. At zero angles X is east, Y is up and Z is
   * south; the angles turn that frame about its own origin.
   */
  function frameFromGeoPose(geoPose) {
    const { lat, lon, h } = geoPose.position;
    const axes = enuAxes(lat, lon);
    const r = rotationFromAngles(geoPose.angles || { yaw: 0, pitch: 0, roll: 0 });
    // Zero-angle X, Y, Z in east-north-up coordinates: east, up, south.
    const zero = [[1, 0, 0], [0, 0, 1], [0, -1, 0]];
    const toEcef = (enu) => add(add(scale(axes.east, enu[0]), scale(axes.north, enu[1])), scale(axes.up, enu[2]));
    const [x, y, z] = zero.map((v) => toEcef(matVec(r, v)));
    return { origin: ecef(lat, lon, h), axes: [x, y, z], geo: { lat, lon, h } };
  }

  /** Local metres in a frame to Earth-centred metres. */
  function localToEcef(frame, local) {
    return add(frame.origin, add(add(scale(frame.axes[0], local[0]), scale(frame.axes[1], local[1])), scale(frame.axes[2], local[2])));
  }

  /** Earth-centred metres to local metres in a frame. */
  function ecefToLocal(frame, v) {
    const d = sub(v, frame.origin);
    return [dot(frame.axes[0], d), dot(frame.axes[1], d), dot(frame.axes[2], d)];
  }

  /** A direction (not a position) in Earth-centred coordinates, expressed along a frame's axes. */
  function directionInFrame(frame, v) {
    return [dot(frame.axes[0], v), dot(frame.axes[1], v), dot(frame.axes[2], v)];
  }

  /** EPSG 9837: where a geographic point lies in the frame anchored at `anchor` (a GeoPose). */
  function geographicToLocal(anchor, point) {
    return ecefToLocal(frameFromGeoPose(anchor), ecef(point.lat, point.lon, point.h));
  }

  /** The inverse of geographicToLocal: the geographic position of local metres in the frame. */
  function localToGeographic(anchor, local) {
    const v = localToEcef(frameFromGeoPose(anchor), local);
    return geodetic(v[0], v[1], v[2]);
  }

  /**
   * A pose given in a graph's local frame (position in metres, yaw about +Y in radians, pitch about
   * the pose's lateral axis in radians) as a GeoPose Basic-YPR. The position is exact: real geodesy
   * through the graph's frame. The angles are the pose's angles about the graph's axes plus the
   * anchor's own angles, which is exact when the anchor turns only in yaw (the lab's anchors do).
   * Meridian convergence inside a graph (1.7e-5 rad over 100 m at 47.7 N) is not applied.
   */
  function localPoseToGeoPose(anchor, position, yawRad, pitchRad) {
    const here = localToGeographic(anchor, position);
    const own = anchor.angles || { yaw: 0, pitch: 0, roll: 0 };
    return {
      position: { lat: here.lat, lon: here.lon, h: here.h },
      angles: {
        yaw: (yawRad || 0) / RAD + own.yaw,
        pitch: (pitchRad || 0) / RAD + own.pitch,
        roll: own.roll,
      },
    };
  }

  // ---------------------------------------------------------------------------------------
  // The one GeoPose reader.
  // ---------------------------------------------------------------------------------------

  const READ_ERRORS = Object.freeze({
    NOT_AN_OBJECT: "GEOPOSE_NOT_AN_OBJECT",
    MISSING: "GEOPOSE_MISSING_MEMBER",
    NOT_A_NUMBER: "GEOPOSE_NOT_A_FINITE_NUMBER",
    LON_LAN_CONFLICT: "GEOPOSE_LON_LAN_CONFLICT",
    LAT_RANGE: "GEOPOSE_LATITUDE_OUT_OF_RANGE",
    LON_RANGE: "GEOPOSE_LONGITUDE_OUT_OF_RANGE",
  });
  const READ_WARNINGS = Object.freeze({
    LAN_DEPRECATED: "GEOPOSE_LAN_DEPRECATED",
    UNKNOWN_MEMBER: "GEOPOSE_UNKNOWN_MEMBER",
  });

  const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  const fail = (code, path, message) => ({ ok: false, error: { code, path, message } });

  /**
   * Reads one GeoPose Basic-YPR object. The world server uses it when it loads a graph's anchor
   * fixture, and the browser uses it on `Spatial.geoPose`. Returns `{ ok: true, geoPose, warnings }`
   * with the OGC member spelling (`lon`), or `{ ok: false, error: { code, path, message } }`.
   *
   * - `lan` (the World API's spelling) is read as `lon`, with a deprecation warning.
   * - `lon` and `lan` that disagree are refused.
   * - The OGC Basic-YPR schema sets no bounds, so latitude and longitude are bounded here.
   */
  function readGeoPose(raw) {
    if (!isObject(raw)) return fail(READ_ERRORS.NOT_AN_OBJECT, "", "a GeoPose must be an object");
    const warnings = [];
    if (!isObject(raw.position)) return fail(READ_ERRORS.MISSING, "position", "position is required");
    if (!isObject(raw.angles)) return fail(READ_ERRORS.MISSING, "angles", "angles is required");
    const pos = raw.position;
    const finite = (v) => typeof v === "number" && Number.isFinite(v);

    let lon = pos.lon;
    if (pos.lan !== undefined) {
      if (pos.lon !== undefined && pos.lon !== pos.lan) {
        return fail(READ_ERRORS.LON_LAN_CONFLICT, "position", `lon (${pos.lon}) and lan (${pos.lan}) disagree`);
      }
      if (lon === undefined) lon = pos.lan;
      warnings.push({ code: READ_WARNINGS.LAN_DEPRECATED, path: "position.lan", message: "`lan` is deprecated; use `lon`" });
    }
    const members = { "position.lat": pos.lat, "position.lon": lon, "position.h": pos.h };
    for (const k of ["yaw", "pitch", "roll"]) members[`angles.${k}`] = raw.angles[k];
    for (const [path, value] of Object.entries(members)) {
      if (value === undefined) return fail(READ_ERRORS.MISSING, path, `${path} is required`);
      if (!finite(value)) return fail(READ_ERRORS.NOT_A_NUMBER, path, `${path} must be a finite number`);
    }
    if (pos.lat < -90 || pos.lat > 90) return fail(READ_ERRORS.LAT_RANGE, "position.lat", `latitude ${pos.lat} is outside -90..90`);
    if (lon < -180 || lon > 180) return fail(READ_ERRORS.LON_RANGE, "position.lon", `longitude ${lon} is outside -180..180`);

    for (const k of Object.keys(pos)) {
      if (!["lat", "lon", "lan", "h"].includes(k)) warnings.push({ code: READ_WARNINGS.UNKNOWN_MEMBER, path: `position.${k}`, message: "ignored" });
    }
    return {
      ok: true,
      geoPose: {
        position: { lat: pos.lat, lon, h: pos.h },
        angles: { yaw: raw.angles.yaw, pitch: raw.angles.pitch, roll: raw.angles.roll },
      },
      warnings,
    };
  }

  return {
    WGS84,
    ROTATION_CONVENTION,
    READ_ERRORS,
    READ_WARNINGS,
    ecef,
    enuAxes,
    geodetic,
    rotationFromAngles,
    anglesFromRotation,
    frameFromGeoPose,
    localToEcef,
    ecefToLocal,
    directionInFrame,
    geographicToLocal,
    localToGeographic,
    localPoseToGeoPose,
    readGeoPose,
  };
});
