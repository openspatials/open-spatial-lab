// OGC GeoPose 1.0 Basic SDU builder (SHARED, single source of truth).
//
// This leaf module is the ONE place the demo constructs its OGC GeoPose 1.0
// (21-056r11) Basic-YPR + Basic-Quaternion Standardization Data Units (SDUs). It is
// imported by BOTH:
//   - the browser runtime (web/live-adapter.js), which emits these objects on the
//     wire in every avatar_context, AND
//   - the network-free schema validator (web/geopose-schema-conformance-check.mjs),
//     which validates THIS module's actual output against the vendored official OGC
//     JSON Schemas (web/spec/geopose/, hash-pinned byte-identical to schemas.opengis.net).
//
// until that task, the validator cited here was `docs/spec/geopose-schema-
// conformance-check.mjs` — A PATH THAT DID NOT EXIST IN THIS REPOSITORY AND NEVER HAD. The
// real one lived in a DIFFERENT repo and validated a DIFFERENT COPY of this builder, so
// `basic_sdu_schema_valid: true` below was a hardcoded literal NOTHING HERE EVER TESTED, and
// the UI painted it green by reading that same literal back. The validator now exists, imports
// THIS module, and is negative-tested three ways (--negative=schema|claim|hash). Never cite a
// verifier that does not exist: that is precisely how this defect happened, and cited
// GeoPose's "scoped true" as the PRECEDENT for the IWPS overclaim it went on to create.
// Sharing the builder means the thing that is validated is the exact thing that is
// emitted — there is no second copy to drift out of conformance (the audit's
// central warning: "GeoPose is shaped but not schema-validated").
//
// It has ZERO browser dependencies (pure functions over plain numbers/arrays), so it
// imports cleanly into Node from a `.mjs` file regardless of the prototype's
// package.json `type:commonjs` (which only governs `.js` resolution).
//
// ---------------------------------------------------------------------------
// SCOPE OF THE CONFORMANCE CLAIM — read this before touching the labels.
// ---------------------------------------------------------------------------
// Three DIFFERENT properties are deliberately kept separate here (a reusable
// distinction the roadmap generalizes to the other standards):
//
//   basic_sdu_schema_valid : true   — the emitted Basic-YPR + Basic-Quaternion
//                                      objects VALIDATE against the official OGC
//                                      GeoPose 1.0 Basic JSON Schemas
//                                      (schemas.opengis.net/geopose/1.0/schemata/).
//                                      This is structural / data conformance of the
//                                      Basic SDUs, and it is genuinely true — proven
//                                      by the re-runnable validator.
//   georeferenced          : false  — the lat/lon/h come from an ILLUSTRATIVE fake
//                                      origin via a flat local-tangent approximation,
//                                      NOT a geodetic transform against a real anchor.
//                                      The demo is Cartesian / LOCAL. STAYS FALSE.
//   full_geopose_conformance : false — schema-validity of two Basic SDUs is NOT the
//                                      whole GeoPose 1.0 conformance program (no TEAM
//                                      Engine run, no Advanced/Composite classes, no
//                                      georeferencing). STAYS FALSE.
//
// So `ogc_geopose_conformance` is a SCOPED true: schema-valid Basic SDUs ✓,
// georeferenced:false, NOT full-conformance-beyond-Basic-SDU-schema. Per the
// audit §6.3, schema-conformance and georeferencing are separable, and schema
// validity provably does NOT require real geodetic coordinates — which is exactly why
// this scoped true is honest and the georeferencing false must remain.

// Illustrative, NON-AUTHORITATIVE origin for the flat local-tangent placement. The
// lat/lon/h are shape-complete but carry NO real-world meaning (see georeferenced:false).
export const GEOPOSE_SHAPED_ORIGIN = { lat: 0.0, lon: 0.0, h: 0.0 };
// Flat metres-per-degree constant near the equator (illustrative only — a real
// GeoPose would use a proper geodetic transform, not this linear approximation).
export const GEOPOSE_SHAPED_M_PER_DEG = 111320;

// Machine-readable descriptor of the scoped conformance status. Emitted alongside the
// SDUs so any consumer (and the UI) reads the exact same scoped truth. Reusable shape:
// { standard, basic_sdu_schema_valid, georeferenced, full_conformance, scoped_claim }.
export const GEOPOSE_CONFORMANCE = Object.freeze({
  standard: "OGC GeoPose 1.0 (21-056r11)",
  targets: ["Basic-YPR", "Basic-Quaternion"],
  // The emitted Basic SDUs validate against the official OGC JSON Schemas. PROVEN by
  // web/geopose-schema-conformance-check.mjs — re-runnable, network-free, in CI, and bound to
  // THIS builder by import (never by regex over its text). It goes RED if the builder stops
  // emitting schema-valid SDUs (--negative=schema mutates it to {x,y,z} and demands red).
  basic_sdu_schema_valid: true,
  // No real geodetic anchor — illustrative origin + flat approximation. STAYS FALSE.
  georeferenced: false,
  // Basic-SDU schema-validity is not the full GeoPose conformance program. STAYS FALSE.
  full_conformance: false,
  schemas: [
    "schemas.opengis.net/geopose/1.0/schemata/GeoPose.Basic.YPR.Schema.json",
    "schemas.opengis.net/geopose/1.0/schemata/GeoPose.Basic.Quaternion.Schema.json",
  ],
  // The one-line scoped claim, worded so it cannot be read as georeferencing or full
  // conformance. This is the string the UI + wire label surface.
  scoped_claim:
    "OGC GeoPose 1.0 Basic-YPR/Quaternion SDU — schema-valid (structural/data conformance); " +
    "georeferenced:false; NOT full GeoPose conformance beyond the Basic-SDU schema",
});

// ---------------------------------------------------------------------------
// Private pure helpers (local copies so this module has no cross-file coupling;
// identical semantics to the same-named helpers in live-adapter.js).
// ---------------------------------------------------------------------------
function clonePosition(value, fallback) {
  const src = Array.isArray(value) ? value : fallback;
  return [Number(src && src[0]) || 0, Number(src && src[1]) || 0, Number(src && src[2]) || 0];
}
function roundNumber(value, digits = 3) {
  const n = Number(value);
  return Number.isFinite(n) ? Number(n.toFixed(digits)) : 0;
}
function roundVec3(value, digits = 3) {
  return clonePosition(value, [0, 0, 0]).map((entry) => roundNumber(entry, digits));
}
function yawQuaternion(yaw) {
  const half = (Number(yaw) || 0) / 2;
  return [0, Number(Math.sin(half).toFixed(6)), 0, Number(Math.cos(half).toFixed(6))];
}
// A finite number or 0 (honest default — never NaN into the schema).
function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

// ---------------------------------------------------------------------------
// The builder. Maps the avatar's LOCAL Cartesian transform (Three.js scene metres,
// +X east, +Y up, +Z south / toward the camera; rotation_y = yaw about the up axis)
// into OGC GeoPose 1.0 Basic-YPR + Basic-Quaternion SDUs.
//
// GeoPose outer frame is EPSG:4979 (WGS-84 lat/lon/ellipsoidal height); inner frame
// is LTP-ENU (Local Tangent Plane East-North-Up). Those FRAME LABELS are shaped only;
// the coordinate VALUES are a labeled demo-local projection (georeferenced:false).
// ---------------------------------------------------------------------------
export function geoPoseShapedFromTransform(transform) {
  const t = transform || {};
  const pos = clonePosition(t.position, [0, 0, 0]);
  const yaw = num(t.rotation_y);
  // carry REAL pitch/roll from the transform if the avatar ever provides
  // them (radians, tilt about the local ENU axes). Today the avatar's DoF is
  // yaw-only, so no transform supplies pitch/roll and these resolve to 0 — which is
  // the avatar's TRUE upright orientation, not a placeholder fill. If a future
  // movement model adds tilt, the real values flow through here automatically.
  const pitch = num(t.pitch !== undefined ? t.pitch : t.rotation_x);
  const roll = num(t.roll !== undefined ? t.roll : t.rotation_z);
  // Local ENU offsets (metres): east = +X, north = -Z (scene +Z points south),
  // up = +Y. This is a LOCAL tangent-plane placement, NOT a geodetic projection.
  const east_m = pos[0];
  const north_m = -pos[2];
  const up_m = pos[1];
  const lat = GEOPOSE_SHAPED_ORIGIN.lat + north_m / GEOPOSE_SHAPED_M_PER_DEG;
  const lon =
    GEOPOSE_SHAPED_ORIGIN.lon +
    east_m / (GEOPOSE_SHAPED_M_PER_DEG * Math.cos((GEOPOSE_SHAPED_ORIGIN.lat * Math.PI) / 180) || 1);
  const h = GEOPOSE_SHAPED_ORIGIN.h + up_m;
  const quat = Array.isArray(t.orientation) ? t.orientation : yawQuaternion(yaw);
  const position = {
    lat: roundNumber(lat, 8),
    lon: roundNumber(lon, 8),
    h: roundNumber(h, 4),
  };
  const pitchDeg = roundNumber((pitch * 180) / Math.PI, 4);
  const rollDeg = roundNumber((roll * 180) / Math.PI, 4);
  const tiltActive = pitchDeg !== 0 || rollDeg !== 0;
  return {
    _claim:
      "OGC GeoPose 1.0 Basic-YPR/Quaternion SDU — SCHEMA-VALID (structural/data " +
      "conformance, validated against the official OGC JSON Schemas) but NOT " +
      "georeferenced and NOT full GeoPose conformance. See ogc_geopose_conformance.",
    _spec: "OGC GeoPose 1.0 (21-056r11) Basic targets — Clause 2.3 / Clause 8",
    _frame_note:
      "LOCAL Cartesian frame (Three.js metres) mapped into schema-valid GeoPose Basic " +
      "SDUs; the lat/lon/h come from an ILLUSTRATIVE non-authoritative fake origin (flat " +
      "local-tangent approximation), not a geodetic projection. georeferenced:false.",
    frame_reference: {
      outer_frame: "EPSG:4979 (WGS-84 lat/lon/ellipsoidal height) — frame LABEL only",
      inner_frame: "LTP-ENU (Local Tangent Plane East-North-Up) — frame LABEL only",
      georeferenced: false,
      origin_is_illustrative: true,
      illustrative_origin: { ...GEOPOSE_SHAPED_ORIGIN },
    },
    // OGC GeoPose 1.0 Basic-YPR (Clause 2.3 / Clause 8): position{lat,lon,h} + angles{yaw,pitch,roll}
    basic_ypr: {
      position,
      angles: {
        yaw: roundNumber((yaw * 180) / Math.PI, 4),
        pitch: pitchDeg,
        roll: rollDeg,
      },
      _angles_units:
        "degrees; yaw about up axis. pitch/roll carried from the transform when present; " +
        (tiltActive
          ? "currently non-zero (avatar is tilting)."
          : "0 today because the avatar's DoF is yaw-only — this is its true upright orientation, not a placeholder."),
    },
    // OGC GeoPose 1.0 Basic-Quaternion (Clause 2.3 / Clause 8): position{lat,lon,h} + quaternion{x,y,z,w}
    basic_quaternion: {
      position,
      quaternion: {
        x: roundNumber(quat[0], 6),
        y: roundNumber(quat[1], 6),
        z: roundNumber(quat[2], 6),
        w: roundNumber(quat[3], 6),
      },
    },
    local_source_transform: {
      position: roundVec3(pos, 4),
      rotation_y_radians: roundNumber(yaw, 6),
      pitch_radians: roundNumber(pitch, 6),
      roll_radians: roundNumber(roll, 6),
    },
    // SCOPED conformance descriptor (see GEOPOSE_CONFORMANCE / the header block).
    // standards_conformance stays false: schema-valid Basic SDUs are not the whole
    // GeoPose conformance program, and nothing here is georeferenced.
    standards_conformance: false,
    // SCOPED true. Not a bare boolean — an object stating exactly WHAT is true
    // (Basic-SDU schema-validity) and WHAT stays false (georeferencing, full conformance).
    ogc_geopose_conformance: {
      basic_sdu_schema_valid: true,
      georeferenced: false,
      full_conformance: false,
      claim: GEOPOSE_CONFORMANCE.scoped_claim,
    },
    georeferenced: false,
  };
}
