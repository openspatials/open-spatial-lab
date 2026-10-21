import * as THREE from "./vendor/scene-core/vendor/three/three.module.js";
import {
  addScaled3,
  clamp,
  fabricPortalKey,
  glueCameraThroughFrames,
  normalizeVec3,
  portalEntrySideAllowed,
  portalLocalCoordinates,
  properPortalLocalRotation,
  roundNumber,
  roundVec3,
  PORTAL_EXIT_OFFSET_MAX_M,
  PORTAL_TRIGGER_DEPTH_M,
} from "./live-adapter-portal-geometry.mjs";

/*
 * FULL-FIDELITY BOUNDED PORTAL WINDOWS.
 *
 * Every eligible aperture owns an independent composition of the destination's
 * canonical scene builder in RAW DESTINATION WORLD COORDINATES. It is rendered
 * through a camera that is the LIVE scene camera GLUED through the
 * portal frame pair with the PROPER PORTAL ISOMETRY: a 180° rotation about
 * the portal's up axis (source-frame local (x, y, z) -> target-frame local
 * (-x, y, -z), the look direction's lateral AND forward components flip).
 * fixed the pre-012 glue, which carried the lateral offset over
 * UN-negated — an improper reflection (det -1) that no camera pose can
 * realize, so the screen-space window sampled the destination MIRRORED
 * about the camera axis: off-axis viewing displaced the through-ring
 * content and head movement produced inverted parallax (the
 * screenshot). With the proper rotation the window identity holds exactly:
 * a point on the source portal plane and its mapped destination-plane point
 * project to the SAME NDC in their respective cameras, so the destination
 * ring lands pixel-on-pixel on the ring being looked through at EVERY
 * camera pose — asserted numerically by the ring-alignment probe below.
 * The same convention is applied by the real crossing remap
 * (mapTransformBetweenPortalFrames / mapCameraAcrossCrossing in
 * live-adapter-portal-geometry.mjs), so what the ring shows before the commit is what the
 * world shows after it. The aperture samples the render target in SCREEN
 * space, so the oval behaves like a window: the pixels inside the ring are
 * the pixels the destination will occupy after the crossing. A destination-
 * plane clipping plane keeps behind-portal geometry out of the through-ring
 * view. P4: the spatial rung arms for BOTH sides of a
 * bidirectional portal (render half). The SAME proper 180°
 * isometry serves both sides — it is the crossing's own map, so from either
 * face the through-ring view equals the post-commit arrival view; only the
 * destination eligibility always remains the reconciled target-frame-forward
 * half-space. A transformed-bounds awareness volume plus fragment clip planes
 * bounds both canonical content and full peer avatars. There are no proxy
 * rooms, capsules, grids, fixed-resolution targets, or reduced-detail portal
 * models. Cold/loading destinations keep the same aperture and clear it until
 * canonical content is available; they do not substitute an invented scene.
 */

// The destination world's OWN portal-ring coloring (app.js standing-oval
// rule: a location-b world colors its ring amber, every other world cyan) —
// the ring seen through the aperture must match the ring arrival shows.
function destWorldRingColor(locationId) {
  return String(locationId || "") === "location-b" ? 0xffc266 : 0x66e0ff;
}
const PORTAL_FRAME_CENTER_Y = 1.35;
const PEER_POSE_STALE_MS = 4000;
// The pass-level size floor, in DEVICE pixels of projected aperture area.
// evaluated raising this to 256 (a 16x16 box, the ~8-pixel
// radius authorizes) and REVERTED it: measured on the
// live lobby sweep, 256 culled `lobby-portal-a` at camera azimuth ~299°, where
// its true clipped footprint is a 5x32 device-pixel sliver at the left screen
// edge — real pixels the viewer can see. A pass that produces visible pixels
// must not be skipped, and the raise bought no measured passes anyway: the
// entire win came from the near/side clip in the projection below. Left at 16.
const MIN_PROJECTED_PORTAL_AREA_DEVICE_PX = 16;
const RADIAL_CLIP_PLANE_COUNT = 20;
const PORTAL_AVATAR_FAULTS = new Set([
  "capsule_only",
  "coarse_pose",
  "widen_circle",
  "dual_representation",
]);

function vec3(value, fallback) {
  const src = Array.isArray(value) ? value : fallback || [0, 0, 0];
  return [Number(src[0]) || 0, Number(src[1]) || 0, Number(src[2]) || 0];
}

function finiteVec3(value) {
  return Array.isArray(value) && value.length >= 3 && value.slice(0, 3).every((part) => Number.isFinite(Number(part)));
}

/** Destination-side bounded awareness authority. Radius comes from the
 * accepted destination region/circle; pose and into-destination half-space
 * come from the reconciled target portal frame. */
export function portalAwarenessVolume(machine, portalEntry) {
  const targetFrame = portalEntry?.target_frame;
  const circle = machine?.region?.avatars?.circle || machine?.region?.region || null;
  const authoredPortalRadius =
    portalEntry?.zones?.prefetch?.matching_destination_circle?.radius_m ??
    machine?.zones?.prefetch?.matching_destination_circle?.radius_m ??
    machine?.address?.roi_hint?.radius_m;
  const radius = Number(circle?.portal_preview_radius_m ?? circle?.radius_m ?? authoredPortalRadius);
  if (!targetFrame || !finiteVec3(targetFrame.position) || !finiteVec3(targetFrame.forward)) {
    return { valid: false, reason: "target_frame_unavailable" };
  }
  if (!Number.isFinite(radius) || radius <= 0) {
    return { valid: false, reason: "authored_preview_radius_unavailable" };
  }
  const forward = normalizeVec3(targetFrame.forward, [0, 0, 1]);
  return {
    valid: true,
    center: targetFrame.position.slice(0, 3).map(Number),
    forward,
    radius_m: radius,
    radius_source: circle?.portal_preview_radius_m != null
      ? "region.portal_preview_radius_m"
      : circle?.radius_m != null && machine?.region?.avatars?.circle
        ? "region.avatars.circle.radius_m"
        : circle?.radius_m != null
          ? "region.region.radius_m"
          : portalEntry?.zones?.prefetch?.matching_destination_circle?.radius_m != null
            ? "portal.zones.prefetch.matching_destination_circle.radius_m"
            : machine?.zones?.prefetch?.matching_destination_circle?.radius_m != null
              ? "machine.zones.prefetch.matching_destination_circle.radius_m"
              : "machine.address.roi_hint.radius_m",
    half_space: "target_frame_forward",
    plane_setback_m: 0.1,
  };
}

/** Conservative transformed-bounds admission. A long mesh remains eligible
 * when any part of its box enters the sphere and destination half-space. */
export function boundsIntersectPortalAwareness(bounds, volume) {
  if (!volume?.valid || !finiteVec3(bounds?.min) || !finiteVec3(bounds?.max)) {
    return { eligible: false, reason: "bounds_or_volume_invalid" };
  }
  const min = bounds.min;
  const max = bounds.max;
  const center = volume.center;
  let distanceSq = 0;
  for (let axis = 0; axis < 3; axis += 1) {
    const nearest = Math.max(Number(min[axis]), Math.min(Number(max[axis]), center[axis]));
    const delta = nearest - center[axis];
    distanceSq += delta * delta;
  }
  if (distanceSq > volume.radius_m * volume.radius_m) {
    return { eligible: false, reason: "outside_awareness_radius", distance_m: Math.sqrt(distanceSq) };
  }
  const forward = volume.forward;
  const support = [
    Number(forward[0] >= 0 ? max[0] : min[0]),
    Number(forward[1] >= 0 ? max[1] : min[1]),
    Number(forward[2] >= 0 ? max[2] : min[2]),
  ];
  const forwardExtent =
    (support[0] - center[0]) * forward[0] +
    (support[1] - center[1]) * forward[1] +
    (support[2] - center[2]) * forward[2];
  if (forwardExtent < -volume.plane_setback_m) {
    return { eligible: false, reason: "outside_destination_half_space", forward_extent_m: forwardExtent };
  }
  return {
    eligible: true,
    reason: "transformed_bounds_intersect_awareness",
    distance_m: Math.sqrt(distanceSq),
    forward_extent_m: forwardExtent,
  };
}

// per-frame scratch for the aperture projection below.
// Hoisted to module scope so the gate that runs once per active portal per
// display frame allocates nothing (the CPU audit's allocation-hygiene note for
// F8). Single-threaded and never re-entrant: each projection completes before
// the next begins. The corner signs are the aperture rim in frame-local
// (right, up) units of half-extent.
const APERTURE_CORNER_SIGNS = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
// Sutherland-Hodgman ping-pong buffers. Each clip plane adds at most one
// vertex, so a quad clipped against five planes yields at most nine; 12 is
// slack. Homogeneous clip space (x, y, z, w) — the divide happens only after
// every plane has been applied, which is the whole point of the repair.
const APERTURE_CLIP_A = Array.from({ length: 12 }, () => new THREE.Vector4());
const APERTURE_CLIP_B = Array.from({ length: 12 }, () => new THREE.Vector4());
const APERTURE_VIEW_PROJECTION = new THREE.Matrix4();
// Clip-space half-spaces, each as f(v) >= 0. Near is z + w >= 0; the four
// sides are the standard |x| <= w, |y| <= w. The far plane is deliberately
// absent: it cannot change an on-screen footprint, only discard depth.
const APERTURE_CLIP_PLANES = [
  (v) => v.z + v.w,
  (v) => v.x + v.w,
  (v) => v.w - v.x,
  (v) => v.y + v.w,
  (v) => v.w - v.y,
];

/** Project the source aperture to drawing-buffer pixels. The result is also
 * the per-portal render-target requirement; no fixed low-resolution target.
 *
 * WHY THE CLIP IS LOAD-BEARING. This function is the
 * pass-level visibility gate `renderActive` consumes: `visible:false` skips
 * the whole render-to-texture pass, and the returned rect IS the render
 * target's size. Before this repair the four rim corners were fed straight to
 * `Vector3.project`, which performs the perspective divide with NO clipping.
 * A corner at or behind the camera plane divides by w <= 0, so its NDC comes
 * back NEGATED and unbounded. The old code rejected only the case where ALL
 * FOUR corners were behind; with the mixed in-front/behind straddle that
 * happens whenever the viewer stands near an aperture and turns, the NDC
 * min/max was meaningless and the `Math.max(-1, …)/Math.min(1, …)` clamp
 * collapsed it to exactly [-1,1]^2 — so the gate answered `visible:true` with
 * the FULL drawing buffer, and `renderActive` then sized that portal's render
 * target to the entire viewport (measured: 2560x1720 = 4.40 Mpx, ~11x a
 * genuine aperture) and rendered a portal the viewer could not see. Measured
 * pre-repair, one lobby camera pose (azimuth 209.99°): `lobby-portal-c`, with
 * three of four corners behind the camera, returned `visible:true`,
 * `area_device_px 4403200`, while its one in-front corner projected to NDC
 * (-6.57, -6.97) — entirely off screen.
 *
 * Clipping the rim polygon against the near plane AND the four side planes in
 * homogeneous clip space, before any divide, makes the resulting box the
 * aperture's EXACT on-screen footprint rather than a bounding box of garbage.
 * It cannot over-cull: a polygon with no vertex inside the frustum covers no
 * pixel, so skipping its pass removes nothing the viewer could have seen. Both
 * faces of a bidirectional portal keep rendering — this is a screen-coverage
 * test, not a facing test; which faces may surface at all stays with
 * `_cameraOnAllowedSide` / the traversal rule, untouched here. */
export function projectedPortalApertureDevicePixels(portalEntry, camera, drawingWidth, drawingHeight) {
  const frame = portalEntry?.frame;
  if (!frame || !camera || !finiteVec3(frame.position)) return { visible: false, reason: "frame_or_camera_unavailable" };
  const center = vec3(frame.position, [0, PORTAL_FRAME_CENTER_Y, 0]);
  const right = vec3(frame.right, [1, 0, 0]);
  const up = vec3(frame.up, [0, 1, 0]);
  const halfWidth = (Number(frame.width_m) || 1.8) / 2;
  const halfHeight = (Number(frame.height_m) || 2.8) / 2;
  APERTURE_VIEW_PROJECTION.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  let source = APERTURE_CLIP_A;
  let target = APERTURE_CLIP_B;
  let count = APERTURE_CORNER_SIGNS.length;
  for (let corner = 0; corner < count; corner += 1) {
    const x = APERTURE_CORNER_SIGNS[corner][0] * halfWidth;
    const y = APERTURE_CORNER_SIGNS[corner][1] * halfHeight;
    source[corner]
      .set(
        center[0] + right[0] * x + up[0] * y,
        center[1] + right[1] * x + up[1] * y,
        center[2] + right[2] * x + up[2] * y,
        1,
      )
      .applyMatrix4(APERTURE_VIEW_PROJECTION);
  }
  let clippedByNear = false;
  for (let plane = 0; plane < APERTURE_CLIP_PLANES.length; plane += 1) {
    const inside = APERTURE_CLIP_PLANES[plane];
    let next = 0;
    for (let vertex = 0; vertex < count; vertex += 1) {
      const current = source[vertex];
      const following = source[(vertex + 1) % count];
      const currentDistance = inside(current);
      const followingDistance = inside(following);
      if (currentDistance >= 0) target[next++].copy(current);
      if ((currentDistance >= 0) !== (followingDistance >= 0)) {
        const span = currentDistance - followingDistance;
        const t = span === 0 ? 0 : currentDistance / span;
        target[next++].copy(current).lerp(following, t);
      }
    }
    const swap = source;
    source = target;
    target = swap;
    count = next;
    if (count === 0) {
      clippedByNear = plane === 0;
      break;
    }
  }
  if (count === 0) {
    // Nothing of the aperture survives the frustum: no pixel can be produced,
    // so the pass is skipped. The two reasons stay distinguishable for the
    // aperture telemetry that has always reported them.
    return { visible: false, reason: clippedByNear ? "aperture_behind_camera" : "aperture_outside_frustum" };
  }
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let vertex = 0; vertex < count; vertex += 1) {
    const point = source[vertex];
    // Every survivor satisfies |x| <= w and |y| <= w with w > 0, so the divide
    // is meaningful and each result already lies inside [-1, 1].
    const w = point.w;
    if (!(w > 1e-6)) continue;
    const ndcX = point.x / w;
    const ndcY = point.y / w;
    if (ndcX < minX) minX = ndcX;
    if (ndcX > maxX) maxX = ndcX;
    if (ndcY < minY) minY = ndcY;
    if (ndcY > maxY) maxY = ndcY;
  }
  if (!(maxX > minX && maxY > minY)) return { visible: false, reason: "aperture_outside_frustum" };
  const width = Math.max(1, Math.ceil((maxX - minX) * 0.5 * drawingWidth));
  const height = Math.max(1, Math.ceil((maxY - minY) * 0.5 * drawingHeight));
  const x = Math.max(0, Math.floor((minX * 0.5 + 0.5) * drawingWidth));
  const y = Math.max(0, Math.floor((minY * 0.5 + 0.5) * drawingHeight));
  const area = width * height;
  return {
    visible: area >= MIN_PROJECTED_PORTAL_AREA_DEVICE_PX,
    reason: area >= MIN_PROJECTED_PORTAL_AREA_DEVICE_PX ? "projected_aperture_visible" : "projected_area_below_threshold",
    x,
    y,
    width: Math.min(width, drawingWidth - x),
    height: Math.min(height, drawingHeight - y),
    area_device_px: area,
    threshold_device_px: MIN_PROJECTED_PORTAL_AREA_DEVICE_PX,
    drawing_buffer: { width: drawingWidth, height: drawingHeight },
  };
}

// only the matching warm crossing takeover creates the
// doubled-ring moment; ordinary through-portal and unrelated portal views keep
// the destination return ring.
export function shouldSuppressDestinationRing(takeover, portalKey) {
  return !!(takeover && takeover.engaged && takeover.portal_key === portalKey);
}

/*
 * P3 — CLIENT SHARED-EDGE PORTAL IDENTITY + EXIT-POSE
 * DISTANCE PARITY (pure helpers; no DOM/renderer state — node-importable).
 *
 * Identity (client half): P1 made every backend portal one
 * side of a SHARED EDGE hosted by both endpoint worlds. The `/fabric/region`
 * response's `portal` member — the exact pose the adoption seam
 * (`_adoptDestinationPortalPoseForMachine`) already consumes — now carries
 * `shared_edge`, so the client can PROVE the adopted pose belongs to the
 * machine's own edge: the portal you look through / walk through is one
 * stable connection, never a context-dependent destination.
 *
 * Parity: the crossing commits the instant the avatar's
 * sample crosses the portal plane (|entry standoff| ~ a single movement step,
 * centimetres), but the applied exit standoff was floor-clamped to 1.05 m
 * (PORTAL_EXIT_OFFSET_MIN_M) — the avatar "jumps a few steps ahead of the
 * portal". The parity rule makes the exit standoff MIRROR the entry standoff,
 * which is exactly the proper portal rotation the camera glue and the
 * atomic camera handoff already apply — the avatar was the one
 * surface still violating the isometry. Re-triggering at the counterpart is
 * prevented by the traversal controller's rearm gate (`rearmRequired` /
 * `exitedSinceArrival`): the portal cannot re-fire until the avatar has left
 * the trigger volume once. Application-level proof only; no standards claim.
 */

/** Exit-standoff floor under parity: a 5 cm skin so the avatar sample never
 *  rests exactly ON the plane (side would read "plane" and flip-flop). */
export const PORTAL_EXIT_PARITY_MIN_M = 0.05;

/** P1 identity rule, derivable identically from either side of the edge:
 *  edge_id = 'edge--' + sort([source_location_id, target_location_id]). */
export function expectedPortalEdgeId(sourceLocationId, targetLocationId) {
  if (!sourceLocationId || !targetLocationId) return null;
  return "edge--" + [String(sourceLocationId), String(targetLocationId)].sort().join("--");
}

/**
 * Verify the served shared-edge identity of one portal machine against the
 * client's own portal entry (the projection of THIS side's descriptor).
 *
 * `machine` is the app-facing prefetch-machine debug projection
 * (`machine.region.destination_portal` = the raw region `portal` member =
 * the COUNTERPART portal's pose + its `shared_edge`); `portalEntry` is the
 * client world-projection portal entry for the same portal key.
 *
 * verified === true means: the adopted pose is the counterpart pose OF THIS
 * PORTAL'S OWN EDGE — same edge_id both sides derive, counterpart pointing
 * BACK at the very portal that adopts it. Absent on pre-P1 servers
 * (available:false; additive — never gates rendering in P3).
 */
export function portalSharedEdgeIdentity(machine, portalEntry) {
  const portalKey = portalEntry ? fabricPortalKey(portalEntry) : null;
  const source = portalEntry ? portalEntry.source_location_id : null;
  const target = portalEntry ? portalEntry.target_location_id : null;
  if (!portalEntry || !portalKey || !source || !target) {
    return { available: false, reason: "portal_entry_incomplete", portal_key: portalKey };
  }
  const expected = expectedPortalEdgeId(source, target);
  const destinationPortal =
    machine && machine.region && machine.region.destination_portal
      ? machine.region.destination_portal
      : null;
  const served = destinationPortal && destinationPortal.shared_edge
    ? destinationPortal.shared_edge
    : null;
  const anchorId =
    machine && machine.address && machine.address.anchor && machine.address.anchor.portal_id != null
      ? String(machine.address.anchor.portal_id)
      : null;
  if (!served) {
    return {
      available: false,
      reason: destinationPortal ? "server_predates_shared_edge" : "region_portal_pending",
      portal_key: portalKey,
      expected_edge_id: expected,
    };
  }
  const counterpartId =
    served.counterpart && served.counterpart.portal_id != null
      ? String(served.counterpart.portal_id)
      : null;
  const thisSideId =
    served.this_side && served.this_side.portal_id != null
      ? String(served.this_side.portal_id)
      : null;
  const checks = {
    // The same identity both sides derive — THE portal, not a per-side alias.
    edge_id_matches: served.edge_id === expected,
    // The adopted pose names THIS portal as its other side: walking/looking
    // through `portalKey` provably lands on ITS OWN counterpart.
    counterpart_points_back: counterpartId === String(portalKey),
    // The pose we anchored the region on is the edge's destination side.
    pose_is_this_edge_counterpart: anchorId == null || thisSideId === anchorId,
    endpoint_location_matches:
      !!served.this_side && String(served.this_side.location_id) === String(target),
  };
  const failures = Object.keys(checks).filter((name) => checks[name] !== true);
  return {
    available: true,
    verified: failures.length === 0,
    portal_key: portalKey,
    edge_id: served.edge_id || null,
    expected_edge_id: expected,
    anchor_portal_id: anchorId,
    counterpart_portal_id: counterpartId,
    this_side_portal_id: thisSideId,
    region_pose_endpoint:
      served.counterpart && served.counterpart.region_pose_endpoint
        ? served.counterpart.region_pose_endpoint
        : null,
    checks,
    failures,
    identity_rule: served.identity_rule || null,
    validation: { shared_edge_standard_conformance: false, application_level: true },
  };
}

/**
 * Exit-distance parity: compute the adjustment that makes the
 * exit standoff (distance from the DESTINATION portal plane at arrival) equal
 * the entry standoff (distance from the SOURCE portal plane at commit).
 *
 * Inputs are the crossing's own artifacts: the committed entry local
 * (`entry_local_coordinates.signed_plane_distance_m`), the crossing's adopted
 * target frame, and the adapter-applied landing position. Pure — the caller
 * (app.js crossing listener) applies `adjusted_position` inside the same
 * synchronous visual commit.
 */
export function computeExitPoseParity({
  entrySignedPlaneDistanceM,
  targetFrame,
  appliedExitPosition,
  maxStandoffM,
} = {}) {
  const entry = Math.abs(Number(entrySignedPlaneDistanceM));
  if (!Number.isFinite(entry)) {
    return { supported: false, reason: "entry_standoff_unavailable" };
  }
  if (
    !targetFrame ||
    !Array.isArray(targetFrame.position) ||
    !Array.isArray(targetFrame.forward) ||
    !Array.isArray(appliedExitPosition)
  ) {
    return { supported: false, reason: "target_frame_or_exit_position_unavailable" };
  }
  const local = portalLocalCoordinates(targetFrame, appliedExitPosition);
  const applied = local ? Number(local.signed_plane_distance_m) : NaN;
  if (!Number.isFinite(applied) || applied <= 0) {
    // The demo's crossing exits the destination's FRONT side; anything else is
    // not a floored-standoff landing and must not be "corrected".
    return { supported: false, reason: "applied_exit_not_front_side" };
  }
  const max = Number.isFinite(Number(maxStandoffM)) ? Number(maxStandoffM) : PORTAL_EXIT_OFFSET_MAX_M;
  const parity = clamp(entry, PORTAL_EXIT_PARITY_MIN_M, max);
  const delta = applied - parity;
  if (Math.abs(delta) > 2.5) {
    return {
      supported: false,
      reason: "delta_exceeds_sanity_bound",
      applied_standoff_m: roundNumber(applied, 4),
      parity_standoff_m: roundNumber(parity, 4),
    };
  }
  const forward = normalizeVec3(targetFrame.forward, [0, 0, 1]);
  const adjusted = addScaled3(appliedExitPosition, forward, -delta);
  // Distance parity is planar; the adapter's ground-resolved height is kept.
  adjusted[1] = Number(appliedExitPosition[1]) || 0;
  const triggerDepth = Number(targetFrame.trigger_depth_m) || PORTAL_TRIGGER_DEPTH_M;
  return {
    supported: true,
    entry_standoff_m: roundNumber(entry, 4),
    applied_standoff_m: roundNumber(applied, 4),
    parity_standoff_m: roundNumber(parity, 4),
    delta_m: roundNumber(delta, 4),
    adjusted_position: roundVec3(adjusted, 4),
    lateral_offset_m: local ? roundNumber(local.x, 4) : null,
    // Documents the rearm-gate reliance: a parity landing usually sits INSIDE
    // the counterpart trigger volume; the traversal controller's
    // rearmRequired/exitedSinceArrival gate is what prevents a re-fire until
    // the avatar walks out once (the plan's stated safety).
    inside_trigger_volume_after: parity <= triggerDepth,
    min_standoff_m: PORTAL_EXIT_PARITY_MIN_M,
    max_standoff_m: max,
    parity_rule:
      "exit standoff == entry standoff (clamped to [" +
      PORTAL_EXIT_PARITY_MIN_M +
      ", " +
      max +
      "] m) — runtime P3; supersedes the PORTAL_EXIT_OFFSET_MIN_M 1.05 m floor at the crossing consumer",
    validation: { exit_parity_standard_conformance: false, application_level: true },
  };
}

/*
 * P4 — BIDIRECTIONAL BOTH-SIDES RENDER (
 * render half) + PERIMETER SUBSCRIPTION GATE. Pure helpers —
 * no DOM/renderer state, node-importable.
 *
 * Side rule (#2): a viewer is "front" at source-local z >= -0.1 (the historic
 * arming tolerance, unchanged) and "back" below it. The spatial rung arms for
 * any viewer standing on an ALLOWED ENTRY side of the portal
 * (portalEntrySideAllowed — the canonical traversal rule): both faces of a
 * bidirectional portal, only the allowed face of a one-way portal.
 *
 * Perimeter rule (#7): this retained helper is the authoritative subscription
 * warmth verdict. deliberately decouples canonical aperture rendering
 * from that source-side subscription boundary: an eligible visible portal may
 * resolve and render canonical destination content while the region/presence
 * subscription remains cold. No distance is recomputed here.
 */

/** The front/back classification tolerance (m) along the portal's forward
 *  axis — the historic `z < -0.1` arming band, now named and shared. */
export const PORTAL_VIEWER_SIDE_TOLERANCE_M = 0.1;

/** Classify a signed source-local z as a viewer side. Null-safe. */
export function portalSideForLocalZ(z, toleranceM = PORTAL_VIEWER_SIDE_TOLERANCE_M) {
  const value = Number(z);
  if (!Number.isFinite(value)) return null;
  return value < -toleranceM ? "back" : "front";
}

/** Which side of `portalEntry.frame` a world-space camera position stands on.
 *  Raw plane distance (no avatar sample-height lift — this is the CAMERA). */
export function portalViewerSide(cameraPosition, portalEntry) {
  const frame = portalEntry ? portalEntry.frame : null;
  if (!frame || !Array.isArray(cameraPosition)) return null;
  const fp = Array.isArray(frame.position) ? frame.position : [0, PORTAL_FRAME_CENTER_Y, 0];
  const fwd = Array.isArray(frame.forward) ? frame.forward : [0, 0, 1];
  const z =
    ((Number(cameraPosition[0]) || 0) - (Number(fp[0]) || 0)) * (Number(fwd[0]) || 0) +
    ((Number(cameraPosition[1]) || 0) - (Number(fp[1]) || 0)) * (Number(fwd[1]) || 0) +
    ((Number(cameraPosition[2]) || 0) - (Number(fp[2]) || 0)) * (Number(fwd[2]) || 0);
  return {
    signed_plane_distance_m: roundNumber(z, 4),
    side: portalSideForLocalZ(z),
  };
}

/**
 * THE deterministic region-subscription warmth rule (#7). `machine` is the prefetch
 * controller's app-facing machine projection; the verdict consumes the
 * controller's OWN `zone.inside` (never a recomputed distance), so the flip
 * happens exactly where the controller's perimeter events fire:
 * entering at `zones.prefetch.radius_m`, leaving at radius x hysteresis.
 * `live:false` retires region/presence subscription work. canonical
 * portal rendering is independently eligible and does not fall to an image.
 */
export function portalPerimeterLiveGate(machine) {
  const base = {
    live: false,
    inside: null,
    distance_m: null,
    radius_m: null,
    exit_radius_m: null,
    hysteresis_ratio: null,
    rule:
      "region/presence subscription stays live only while the prefetch controller's " +
      "zone.inside is true; runtime canonical portal rendering is independent",
    validation: { perimeter_gate_standard_conformance: false, application_level: true },
  };
  if (!machine || !machine.supported) {
    return { ...base, reason: "machine_unsupported" };
  }
  const zone = machine.zone && typeof machine.zone === "object" ? machine.zone : null;
  const prefetch = machine.zones && machine.zones.prefetch ? machine.zones.prefetch : null;
  const radius = prefetch ? Number(prefetch.radius_m) : NaN;
  // Mirrors (evidence only — the verdict never recomputes membership) the
  // controller's exit hysteresis: radius x (zones.prefetch.hysteresis_ratio || 1.15).
  const ratio =
    prefetch && Number.isFinite(Number(prefetch.hysteresis_ratio)) && Number(prefetch.hysteresis_ratio) > 0
      ? Number(prefetch.hysteresis_ratio)
      : 1.15;
  if (!zone) {
    // No zone state -> no perimeter proof -> never live (this is what retires
    // synthetic always-warm machines like the old serverBApertureMachine).
    return {
      ...base,
      reason: "perimeter_zone_unavailable",
      radius_m: Number.isFinite(radius) ? radius : null,
      exit_radius_m: Number.isFinite(radius) ? roundNumber(radius * ratio, 4) : null,
      hysteresis_ratio: ratio,
    };
  }
  const inside = zone.inside === true;
  return {
    ...base,
    live: inside,
    reason: inside ? "inside_portal_perimeter" : "outside_portal_perimeter",
    inside,
    distance_m: Number.isFinite(Number(zone.distance_m)) ? Number(zone.distance_m) : null,
    radius_m: Number.isFinite(radius) ? radius : null,
    exit_radius_m: Number.isFinite(radius) ? roundNumber(radius * ratio, 4) : null,
    hysteresis_ratio: ratio,
  };
}

/*
 * P5 — FAR-AWAY STILL-IMAGE LAYER, LEGIBLE ON BOTH SIDES
 * . When the viewer is OUTSIDE the portal's circled perimeter,
 * the P4 gate refuses the live spatial render (portalPerimeterLiveGate.live ===
 * false) and the aperture falls to the 2D IMAGE rungs — the labeled placeholder
 * / prefetched-region CanvasTexture painted in app.js. Those rungs draw a canvas
 * whose text + mini-map read correctly on the portal's FRONT face; the aperture
 * mesh material is THREE.DoubleSide, so the BACK face shows that same canvas
 * horizontally MIRRORED (text backwards — the screenshot). A single flat
 * texture on one plane CANNOT read correctly from both faces at once (the faces
 * are mirror images), so the legible orientation is chosen PER FACE from P4's
 * viewer side: identity on the front (byte-identical pre-P5), a horizontal
 * texture flip (u -> 1 - u) on the back so the DoubleSide back-face mirror
 * cancels to legible. Only the horizontal axis is transformed; the vertical
 * orientation and the canvas content are untouched, and the spatial rung's own
 * DoubleSide window (already correct from both faces by construction —
 * P4) and the always-camera-facing billboard label are NOT flipped.
 *
 * Because the aperture's CircleGeometry normals face local +Z = the frame FRONT
 * (app.js standing-oval build), a "front" viewer sees the texture-correct face
 * and a "back" viewer sees the mirrored back face; the flip is therefore keyed
 * to viewer_side === "back". The controlled player is a single viewer looking at
 * exactly one face per frame, so the face being viewed is always legible; the
 * momentarily-unviewed opposite face carries the transient mirror and is never
 * seen (the flip re-evaluates every surface pass as the viewer crosses sides).
 */

/** THE per-face legibility rule for the 2D still-image rung. `viewerSide` is
 *  P4's classification — the {side} object from portalViewerSide, or a bare
 *  "front"/"back" string; anything else (null/unknown) defaults to the front
 *  identity so the pre-P5 render is preserved. Returns the horizontal texture
 *  transform (three.js repeat.x / offset.x) that keeps the VIEWED face legible:
 *  front -> u (identity), back -> 1 - u (horizontal mirror that cancels the
 *  DoubleSide back-face mirror). Pure; node-importable. */
export function imageLayerFlipForViewerSide(viewerSide) {
  const side =
    viewerSide && typeof viewerSide === "object" ? viewerSide.side : viewerSide;
  const back = side === "back";
  return {
    viewer_side: side === "front" || side === "back" ? side : null,
    // The horizontal texture mirror that cancels the DoubleSide back-face
    // mirror. u' = u * repeat_x + offset_x  ->  front: u,  back: 1 - u.
    mirrored: back,
    repeat_x: back ? -1 : 1,
    offset_x: back ? 1 : 0,
    // Legible on the face actually being viewed, by construction: front face +
    // identity = legible (the preserved baseline); back face's geometric mirror
    // composed with this horizontal flip = mirror∘mirror = identity = legible.
    legible_on_viewed_face: true,
    rule:
      "front viewer -> identity UV (u); back viewer -> horizontal flip (1 - u) " +
      "so the DoubleSide back-face mirror cancels to legible text — runtime P5, " +
      "owner issue #3 (far still-image legible on both sides)",
    validation: { image_legibility_standard_conformance: false, application_level: true },
  };
}

function roundForSignature(n) {
  return Math.round((Number(n) || 0) * 20) / 20; // 5 cm buckets
}

// P2 — THROUGH-PORTAL sRGB OUTPUT ENCODE (
// the other side of the portal renders dark / figures over there invisible).
//
// The destination scene is rendered into a WebGLRenderTarget by the MAIN
// renderer. In three.js r160 the output color space for a non-XR render-target
// render is forced to LinearSRGBColorSpace (three.module.js:20753 / :30139), so
// the destination shader does NOT append the sRGB OETF — the render-target
// texels the aperture samples are LINEAR-light. The aperture/takeover meshes are
// then drawn to the CANVAS (default framebuffer), which three.js expects to hold
// sRGB-ENCODED bytes: for its own standard materials it appends
// <colorspace_fragment> (LinearTosRGB) because renderer.outputColorSpace is the
// default SRGBColorSpace. three.js does NOT append that OETF to a custom
// ShaderMaterial, so the old shaders (`gl_FragColor = texture2D(uMap, uv)`) wrote
// linear-light straight to an sRGB-interpreted canvas — a full gamma too dark,
// uniformly crushing room, walls and avatars while every standard-material rung
// stayed correct. This is a COLOUR-SPACE bug, not lighting/IBL (the preview's
// ambient 0.75 already exceeds the live world's 0.6).
//
// Fix: apply the sRGB OETF once, in-shader, at the single correct point — the
// linear render target -> sRGB canvas blit. `SRGB_OETF_GLSL` is byte-for-byte
// three.js r160's `sRGBTransferOETF` (the exact function LinearTosRGB runs for
// standard materials targeting the canvas), so the through-ring pixel equals the
// pixel the same scene produces when entered directly. OETF ONLY, no tone map:
// the renderer's toneMapping is the default NoToneMapping, so the direct render
// applies no tone curve and neither must the aperture (parity would break
// otherwise). NOT a double-encode: three appends nothing to ShaderMaterials and
// the canvas is a plain RGBA8 (non-sRGB) drawing buffer, so this manual OETF is
// the one and only linear->sRGB step, exactly matching the direct path. The
// render-target `texture.colorSpace = SRGBColorSpace` tag (_ensureRecord) is
// deliberately LEFT as-is: it selects the SRGB8_ALPHA8 internal format, so the
// GPU sRGB-decodes on sample and the shader receives linear either way; flipping
// it to Linear would change what readRenderTargetPixels returns and move the
// existing warm-through-ring texel thresholds. Proven by
// src/portal-through-srgb-parity-proof.mjs (canvas readback: through == direct,
// pre-fix raw is measurably darker, and no over-bright double-encode).
const SRGB_OETF_GLSL = [
  "vec3 osl_linearToSRGB(vec3 c) {",
  "  return mix(",
  "    pow(c, vec3(0.41666)) * 1.055 - vec3(0.055),",
  "    c * 12.92,",
  "    vec3(lessThanEqual(c, vec3(0.0031308)))",
  "  );",
  "}",
].join("\n");

/** Screen-space projective material: the fragment samples the render target
 *  at the fragment's own NDC position, so the aperture mesh acts as a window
 *  into the destination render rather than a "TV screen" with its own UVs.
 * P2: the sampled linear render-target texel is sRGB-encoded before
 *  output so the through-ring view matches the directly-entered room. */
export function makeApertureWindowMaterial(texture) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: texture },
      // bottom-left normalized crop in the direct drawing buffer
      uViewport: { value: new THREE.Vector4(0, 0, 1, 1) },
    },
    vertexShader: [
      "varying vec4 vClip;",
      "void main() {",
      "  vClip = projectionMatrix * modelViewMatrix * vec4(position, 1.0);",
      "  gl_Position = vClip;",
      "}",
    ].join("\n"),
    fragmentShader: [
      "uniform sampler2D uMap;",
      "uniform vec4 uViewport;",
      "varying vec4 vClip;",
      SRGB_OETF_GLSL,
      "void main() {",
      "  vec2 ndc = vClip.xy / max(vClip.w, 1e-5);",
      "  vec2 fullUv = ndc * 0.5 + 0.5;",
      "  vec2 uv = (fullUv - uViewport.xy) / max(uViewport.zw, vec2(1e-5));",
      "  vec4 texel = texture2D(uMap, uv);",
      "  gl_FragColor = vec4(osl_linearToSRGB(texel.rgb), texel.a);",
      "}",
    ].join("\n"),
    side: THREE.DoubleSide,
    depthWrite: true,
    transparent: false,
    toneMapped: false,
  });
}

/** Fullscreen takeover material: same texture, quad already in NDC. The
 *  render target was drawn with the mapped main-camera projection at the
 *  canvas aspect, so the quad's 0..1 UVs land pixel-for-pixel on the view
 *  the aperture was already showing. P2: identical sRGB output encode
 *  as the aperture window — the takeover samples the SAME linear render target,
 *  so it must apply the SAME OETF or the whole-viewport commit frame would flash
 *  a gamma darker than the aperture it replaces. */
export function makeTakeoverMaterial(texture) {
  return new THREE.ShaderMaterial({
    uniforms: { uMap: { value: texture } },
    vertexShader: [
      "varying vec2 vUv;",
      "void main() {",
      "  vUv = uv;",
      "  gl_Position = vec4(position.xy, 0.0, 1.0);",
      "}",
    ].join("\n"),
    fragmentShader: [
      "uniform sampler2D uMap;",
      "varying vec2 vUv;",
      SRGB_OETF_GLSL,
      "void main() {",
      "  vec4 texel = texture2D(uMap, vUv);",
      "  gl_FragColor = vec4(osl_linearToSRGB(texel.rgb), texel.a);",
      "}",
    ].join("\n"),
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
}

function disposeObject(root, { disposeTextures = true } = {}) {
  if (!root || typeof root.traverse !== "function") return;
  root.traverse((node) => {
    const sharedAssetInstance = node.userData?.portalSharedAssetInstance === true;
    if (!sharedAssetInstance && node.geometry && typeof node.geometry.dispose === "function") node.geometry.dispose();
    const mats = Array.isArray(node.material) ? node.material : node.material ? [node.material] : [];
    for (const m of mats) {
      if (disposeTextures && !sharedAssetInstance) {
        for (const v of Object.values(m)) {
          if (v && v.isTexture && typeof v.dispose === "function") v.dispose();
        }
      }
      if (typeof m.dispose === "function") m.dispose();
    }
  });
}

function applyPreviewClipping(root, clipPlanes) {
  if (!root || !Array.isArray(clipPlanes) || !clipPlanes.length) return;
  root.traverse((node) => {
    const mats = Array.isArray(node.material) ? node.material : node.material ? [node.material] : [];
    for (const material of mats) material.clippingPlanes = clipPlanes;
  });
}

export class SpatialPortalPreviewManager {
  constructor(opts = {}) {
    this.records = new Map(); // portalKey -> record
    this.renderer = null;
    this.mainCamera = null;
    this.hostScene = null; // the live impl.scene (for the takeover quad)
    this.controlledPlayerId =
      typeof opts.controlledPlayerId === "function" ? opts.controlledPlayerId : () => null;
    this.AvatarLayerClass = opts.AvatarLayerClass || null;
    this.getMount = typeof opts.getMount === "function" ? opts.getMount : () => null;
    this.motionPreference = opts.motionPreference || null;
    this.nowMs = typeof opts.nowMs === "function" ? opts.nowMs : () => Date.now();
    this.resolveDestinationContent = typeof opts.resolveDestinationContent === "function"
      ? opts.resolveDestinationContent
      : async (entry) => ({
          kind: "legacy_world",
          location_id: entry?.target_location_id || null,
          world_id: entry?.target_world_id || null,
          revision: "test-default",
          world: { location_id: entry?.target_location_id || null, color: "#3aa0ff" },
        });
    this.composeDestinationContent = typeof opts.composeDestinationContent === "function"
      ? opts.composeDestinationContent
      : null;
    this.destinationSources = new Map();
    const queryFault =
      typeof window !== "undefined"
        ? new URLSearchParams(window.location.search).get("portal_avatar_fault")
        : null;
    this.avatarFault = PORTAL_AVATAR_FAULTS.has(opts.avatarFault)
      ? opts.avatarFault
        : PORTAL_AVATAR_FAULTS.has(queryFault)
        ? queryFault
        : null;
    this.peerPlayers = new Map();
    this.avatarRepresentationCreateCount = 0;
    this.avatarRepresentationDisposeCount = 0;
    // P4: per-portal record of the last live-vs-image gate decision
    // (perimeter verdict + viewer side + the reason that won) — the evidence
    // surface the deterministic-flip proof and the P5 image layer consume.
    this.surfaceGates = new Map();
    this._identityFilterByMachine = new WeakMap();
    this._lastIdentityFilter = null;
    this.takeover = {
      engaged: false,
      portal_key: null,
      engaged_at: null,
      frames_rendered: 0,
      last_engaged: null, // survives disengage for evidence
    };
    this._takeoverQuad = null;
    this._tmpVec = new THREE.Vector3();
    this._tmpVec2 = new THREE.Vector2();
    this._tmpBox = new THREE.Box3();
    this._tmpProjection = new THREE.Matrix4();
    this._tmpDirection = new THREE.Vector3();
    this._tmpAvatarBox = new THREE.Box3();
    this._cameraPosition = [0, 0, 0];
    this._cameraForward = [0, 0, -1];
  }

  /** (Re)bind to the live scene internals. Called at boot and after every
   *  recompose — the old scene owned the takeover quad, so it dies with it. */
  bindScene(renderer, camera, hostScene) {
    const hostChanged = !!(this.hostScene && hostScene && this.hostScene !== hostScene);
    if (hostChanged) {
      for (const rec of this.records.values()) {
        this._disposeRecord(rec);
      }
      this.records.clear();
      this.destinationSources.clear();
    }
    this.renderer = renderer || null;
    this.mainCamera = camera || null;
    this.hostScene = hostScene || null;
    // Per-material clipping (the destination-plane clip on preview materials
    // only; main-scene materials carry no clip planes and are unaffected).
    if (this.renderer) this.renderer.localClippingEnabled = true;
    if (this.takeover.engaged) {
      // The scene that displayed the takeover is gone; the promoted world now
      // renders live — the takeover has completed its job.
      this.takeover.engaged = false;
      this.takeover.portal_key = null;
    }
    this._takeoverQuad = null;
  }

  /** Drop records whose portal keys no longer exist (world switched). */
  pruneToPortalKeys(validKeys) {
    const keep = new Set(validKeys || []);
    for (const [key, rec] of this.records) {
      if (keep.has(key)) continue;
      this._disposeRecord(rec);
      this.records.delete(key);
    }
    for (const key of this.surfaceGates.keys()) {
      if (!keep.has(key)) this.surfaceGates.delete(key);
    }
  }

  _disposeRecord(rec) {
    if (!rec) return;
    this._disposeAvatarRepresentations(rec);
    try { rec.composition?.dispose?.(); } catch {}
    if (rec.scene) disposeObject(rec.scene);
    if (rec.renderTarget) rec.renderTarget.dispose();
    if (rec.apertureMaterial) rec.apertureMaterial.dispose();
    if (rec.takeoverMaterial) rec.takeoverMaterial.dispose();
  }

  dispose() {
    for (const rec of this.records.values()) this._disposeRecord(rec);
    this.records.clear();
    this.surfaceGates.clear();
    this.bindScene(null, null, null);
    this.peerPlayers.clear();
    this.destinationSources.clear();
  }

  surfaceActive(portalKey) {
    const rec = this.records.get(portalKey);
    return !!(rec && rec.active);
  }

  setPeerPlayers(peers) {
    const next = new Map();
    for (const peer of Array.isArray(peers) ? peers : []) {
      if (!peer || !peer.player_id || !Array.isArray(peer.position)) continue;
      const lastSeenMs = Math.max(0, Number(peer.last_seen_ms) || 0);
      if (lastSeenMs > PEER_POSE_STALE_MS) continue;
      next.set(peer.player_id, {
        ...peer,
        received_at_ms: this.nowMs() - lastSeenMs,
      });
    }
    this.peerPlayers = next;
    for (const rec of this.records.values()) {
      if (rec.machine && rec.portalEntry) {
        this._reconcileAvatarRepresentations(rec, rec.machine, rec.portalEntry);
      }
    }
  }

  _disposeAvatarRepresentations(rec) {
    if (!rec || !rec.avatarRepresentations) return;
    for (const representation of rec.avatarRepresentations.values()) {
      if (representation.layer) {
        try { representation.layer.dispose(); } catch {}
      }
      representation.disposed = true;
      this.avatarRepresentationDisposeCount += 1;
    }
    rec.avatarRepresentations.clear();
    rec.avatarProxies = [];
    rec.avatarCulling = new Map();
  }

  /** The freshest destination avatar set for the through-ring render.
   *
   *  the LIVE presence poll — not the one-shot region
   *  prefetch snapshot — is the authoritative "who is standing in the
   *  destination circle right now" truth. `machine.presence.occupancy.avatars`
   *  (the destination `/fabric/presence` registry, refreshed every ~2 s) is the
   *  fresh set of registered players in the destination location, with their
   *  live register/heartbeat positions; it ADDS a player who walked into the
   *  circle after the prefetch AND drops one who left or departed. We keep only
   *  the players inside the destination-side circle at the server's OWN radius
   *  (never widened), and enrich each with the region snapshot's read-time
   *  projection metadata when the same player_id was captured there.
   *
   *  The pre-167 code gated the whole set on the region snapshot and used the
   *  presence poll only to nudge already-snapshotted positions — so a live
   *  player the snapshot missed never rendered (the defect) and one who
   *  left lingered. When the presence poll has not populated yet (the brief
   *  warm frame before the first poll) we fall back to the freshly captured
   *  snapshot so the frame is not blank. */
  _destinationAvatars(machine) {
    const region = machine && machine.region ? machine.region : null;
    const snapshot =
      region && region.avatars && Array.isArray(region.avatars.avatars) ? region.avatars.avatars : [];
    const live =
      machine && machine.presence && machine.presence.occupancy && Array.isArray(machine.presence.occupancy.avatars)
        ? machine.presence.occupancy.avatars
        : null;
    let candidates = snapshot;
    const circle =
      (region && region.avatars && region.avatars.circle) || (region && region.region) || null;
    const center =
      circle && Array.isArray(circle.center) && circle.center.length >= 3 &&
      circle.center.slice(0, 3).every((value) => Number.isFinite(Number(value)))
        ? circle.center.slice(0, 3).map(Number)
        : null;
    const baseRadius = circle ? Number(circle.radius_m) : NaN;
    const circleValid = !!center && Number.isFinite(baseRadius) && baseRadius >= 0;
    const radius = circleValid && this.avatarFault === "widen_circle" ? baseRadius + 1 : baseRadius;

    // Presence not polled yet — start from the just-captured snapshot rather
    // than a blank frame; the next poll (~2 s) takes over as the live truth.
    if (live) {
      // The destination-side circle geometry (server read-time projection): the
      // avatars object carries its own circle; the region sub-object is the
      // fallback. Membership stays the SERVER's radius — never widened here.
      const snapById = new Map();
      for (const a of snapshot) {
        if (a && a.player_id) snapById.set(a.player_id, a);
      }
      candidates = [];
      for (const entry of live) {
        if (!entry || !Array.isArray(entry.position)) continue;
        const pos = entry.position;
        // Circle membership from live positions at the server-truth radius.
        // Missing/invalid bounded geometry fails closed; never invents
        // a proxy representation for a location-wide presence member.
        let distance = null;
        let inside = false;
        if (circleValid) {
          const dx = (Number(pos[0]) || 0) - (Number(center[0]) || 0);
          const dz = (Number(pos[2]) || 0) - (Number(center[2]) || 0);
          distance = Math.hypot(dx, dz);
          inside = distance <= radius;
        }
        const snap = entry.player_id ? snapById.get(entry.player_id) : null;
        candidates.push({
          ...(snap || {}),
          player_id: entry.player_id || (snap ? snap.player_id : null),
          avatar_id: entry.avatar_id ?? (snap ? snap.avatar_id : null),
          display_name: entry.display_name ?? (snap ? snap.display_name : null),
          position: pos.slice(0, 3),
          rotation_y: entry.rotation_y ?? (snap ? snap.rotation_y : 0),
          distance_from_anchor_m:
            distance != null ? Number(distance.toFixed(3)) : snap ? snap.distance_from_anchor_m : null,
          inside_destination_circle: inside,
          destination_circle_valid: circleValid,
          destination_circle_center: center ? center.slice() : null,
          destination_circle_radius_m: circleValid ? radius : null,
          authoritative_presence_position: pos.slice(0, 3),
        });
      }
    } else {
      candidates = snapshot.map((entry) => {
        const pos = entry && Array.isArray(entry.position) ? entry.position : null;
        let distance = null;
        let inside = false;
        if (pos && circleValid) {
          distance = Math.hypot(Number(pos[0]) - center[0], Number(pos[2]) - center[2]);
          inside = distance <= radius;
        }
        return {
          ...entry,
          distance_from_anchor_m: distance == null
            ? entry && entry.distance_from_anchor_m != null ? entry.distance_from_anchor_m : null
            : Number(distance.toFixed(3)),
          inside_destination_circle: inside,
          destination_circle_valid: circleValid,
          destination_circle_center: center ? center.slice() : null,
          destination_circle_radius_m: circleValid ? radius : null,
          authoritative_presence_position: pos ? pos.slice(0, 3) : null,
        };
      });
    }

    // Part A: presence player_id is the stable controlled-session key
    // across the A/B handoff. Reject that key at the final representation
    // boundary, regardless of whether it arrived through live occupancy or the
    // snapshot fallback. Hosted avatar/profile fields are deliberately ignored:
    // a real peer may share all of them and must remain visible.
    const controlledPlayerId = String(this.controlledPlayerId() || "");
    const inputPlayerIds = candidates.map((avatar) => avatar && avatar.player_id).filter(Boolean);
    const avatars = controlledPlayerId
      ? candidates.filter((avatar) => !avatar || avatar.player_id !== controlledPlayerId)
      : candidates;
    const identityFilter = {
      controlled_player_id: controlledPlayerId || null,
      input_player_ids: inputPlayerIds,
      suppressed_player_ids: controlledPlayerId
        ? inputPlayerIds.filter((playerId) => playerId === controlledPlayerId)
        : [],
      rendered_player_ids: avatars.map((avatar) => avatar && avatar.player_id).filter(Boolean),
      source: live ? "live_presence" : "snapshot_fallback",
      applied_at: new Date().toISOString(),
    };
    this._lastIdentityFilter = identityFilter;
    if (machine && typeof machine === "object") {
      this._identityFilterByMachine.set(machine, identityFilter);
    }
    return avatars;
  }

  _signature(machine, portalEntry) {
    // the target frame pose is part of the signature so
    // a reconciled/adopted destination portal pose rebuilds the ring onto the
    // corrected glue plane.
    const tf = portalEntry ? portalEntry.target_frame : null;
    const tfPos = tf && Array.isArray(tf.position) ? tf.position : [0, 0, 0];
    const tfFwd = tf && Array.isArray(tf.forward) ? tf.forward : [0, 0, 1];
    const parts = [
      portalEntry && portalEntry.target_location_id,
      machine && machine.region && machine.region.region ? machine.region.region.radius_m : null,
      `controlled:${String(this.controlledPlayerId() || "")}`,
      `tf:${roundForSignature(tfPos[0])}:${roundForSignature(tfPos[2])}` +
        `:${roundForSignature(tfFwd[0])}:${roundForSignature(tfFwd[2])}` +
        `:${tf && tf.pose_source ? tf.pose_source : "preset"}`,
    ];
    const awareness = portalAwarenessVolume(machine, portalEntry);
    parts.push(
      awareness.valid
        ? `awareness:${awareness.radius_source}:${roundForSignature(awareness.radius_m)}`
        : `awareness-invalid:${awareness.reason}`,
    );
    return parts.join("|");
  }

  _poseForAvatar(avatar, portalEntry) {
    if (!avatar || !avatar.player_id || this.avatarFault === "coarse_pose") return null;
    const pose = this.peerPlayers.get(avatar.player_id);
    if (!pose || pose.location_id !== portalEntry.target_location_id) return null;
    if (!Array.isArray(pose.position) || this.nowMs() - pose.received_at_ms > PEER_POSE_STALE_MS) return null;
    return pose;
  }

  _fullAvatarSnapshot(avatar, pose) {
    return {
      avatar_id: pose.avatar_id || avatar.avatar_id || null,
      continuity_id: pose.continuity_id || avatar.continuity_id || null,
      display_name: pose.display_name || avatar.display_name || null,
      position: pose.position.slice(0, 3),
      rotation_y: Number(pose.rotation_y) || 0,
      avatar_variant: pose.avatar_variant || avatar.avatar_variant || null,
      equippedItems: Array.isArray(pose.equippedItems) ? pose.equippedItems : [],
      locomotion: pose.locomotion && typeof pose.locomotion === "object" ? { ...pose.locomotion } : {},
      transition_visual:
        pose.transition_visual && typeof pose.transition_visual === "object"
          ? { ...pose.transition_visual }
          : null,
    };
  }

  _reconcileAvatarRepresentations(rec, machine, portalEntry) {
    if (!rec || !rec.scene) return;
    const now = this.nowMs();
    const avatars = this._destinationAvatars(machine);
    rec.identityFilter =
      (machine && this._identityFilterByMachine.get(machine)) || this._lastIdentityFilter;
    const liveIds = new Set();
    const previousPlayerIds = Array.from(rec.avatarRepresentations.keys());
    rec.avatarCulling = rec.avatarCulling || new Map();
    rec.avatarCulling.clear();

    for (const avatar of avatars) {
      const playerId = avatar && avatar.player_id;
      if (!playerId || !Array.isArray(avatar.position)) continue;
      const presencePosition = avatar.authoritative_presence_position || avatar.position;
      const pose = this._poseForAvatar(avatar, portalEntry);
      const classificationPosition = pose ? pose.position : presencePosition;
      const px = Number(classificationPosition[0]) || 0;
      const py = Number(classificationPosition[1]) || 0;
      const pz = Number(classificationPosition[2]) || 0;
      const bodyBounds = {
        min: [px - 0.45, py, pz - 0.45],
        max: [px + 0.45, py + 2.1, pz + 0.45],
      };
      const volumeHit = boundsIntersectPortalAwareness(bodyBounds, rec.awarenessVolume);
      const desiredFull = volumeHit.eligible && !!pose && !!this.AvatarLayerClass && this.avatarFault !== "capsule_only";
      if (!desiredFull) {
        rec.avatarCulling.set(playerId, {
          player_id: playerId,
          eligible: false,
          reason: !volumeHit.eligible
            ? volumeHit.reason
            : !pose
              ? "fresh_same_destination_pose_unavailable"
              : !this.AvatarLayerClass
                ? "full_avatar_layer_unavailable"
                : "controlled_capsule_fault_arm",
          bounds: bodyBounds,
        });
        continue;
      }

      liveIds.add(playerId);
      let representation = rec.avatarRepresentations.get(playerId);
      if (!representation) {
        representation = {
          player_id: playerId,
          state: "loading_full",
          proxy: null,
          layer: null,
          desired_full: true,
          latest_avatar: null,
          last_pose_seq: null,
          last_avatar_signature: null,
          body_bounds: bodyBounds,
          pose_samples: [],
          created_at_ms: now,
          disposed: false,
        };
        rec.avatarRepresentations.set(playerId, representation);
        this.avatarRepresentationCreateCount += 1;
      }

      representation.body_bounds = bodyBounds;
      representation.desired_full = desiredFull;
      representation.distance_from_anchor_m = Number(volumeHit.distance_m.toFixed(4));
      representation.circle_valid = avatar.destination_circle_valid === true;
      representation.circle_center = rec.awarenessVolume?.center?.slice() || null;
      representation.circle_radius_m = rec.awarenessVolume?.radius_m ?? null;
      representation.pose_source = "player-pose";

      const fullAvatar = this._fullAvatarSnapshot(avatar, pose);
      representation.latest_avatar = fullAvatar;
      if (!representation.layer) {
        const mount = this.getMount();
        if (!mount) {
          representation.state = "loading_full";
          continue;
        }
        representation.state = "loading_full";
        const layer = new this.AvatarLayerClass(
          mount,
          "player",
          { location_id: portalEntry.target_location_id },
          {
            host: { scene: rec.scene, camera: rec.camera, renderer: this.renderer },
            motionPreference: this.motionPreference,
          }
        );
        representation.layer = layer;
        layer.__portalPreview = true;
        if (layer.avatarRig) layer.avatarRig.userData.portalPreviewAvatar = true;
        layer.avatar = fullAvatar;
        if (layer.avatarRig) layer.avatarRig.visible = false;
        layer.ready.then(() => {
          if (representation.disposed || rec.avatarRepresentations.get(playerId) !== representation) return;
          if (representation.latest_avatar) layer.setAvatar(representation.latest_avatar);
          applyPreviewClipping(layer.avatarRig, rec.clipPlanes);
          if (layer.avatarRig) layer.avatarRig.visible = false;
        });
      }

      const layer = representation.layer;
      const newPose = representation.last_pose_seq !== pose.seq;
      if (newPose) {
        representation.last_pose_seq = pose.seq;
        representation.last_pose_received_at_ms = pose.received_at_ms;
        representation.pose_samples.push({
          seq: pose.seq,
          received_at_ms: pose.received_at_ms,
          accepted_at_ms: now,
          position: pose.position.slice(0, 3),
          aperture_frame_at_ms: null,
          pose_to_aperture_ms: null,
        });
        if (representation.pose_samples.length > 64) representation.pose_samples.shift();
      }
      if (layer && layer.avatarRig && layer.status && layer.status.renderer !== "failed") {
        const avatarSignature = JSON.stringify([
          pose.seq,
          fullAvatar.avatar_variant,
          fullAvatar.equippedItems,
          fullAvatar.transition_visual,
        ]);
        if (avatarSignature !== representation.last_avatar_signature) {
          representation.last_avatar_signature = avatarSignature;
          layer.setAvatar(fullAvatar);
        }
        const requestedVariant = fullAvatar.avatar_variant;
        const variantReady = !requestedVariant || layer.status.avatar_variant === requestedVariant;
        if (layer.isSettled() && variantReady) {
          representation.state = "full";
          layer.avatarRig.visible = true;
          representation.full_visible_at_ms = representation.full_visible_at_ms || now;
        } else {
          representation.state = "loading_full";
          layer.avatarRig.visible = false;
        }
      }
      rec.avatarCulling.set(playerId, {
        player_id: playerId,
        eligible: representation.state === "full",
        reason: representation.state === "full" ? "full_avatar_awareness_eligible" : "full_avatar_loading",
        bounds: bodyBounds,
      });
    }

    for (const [playerId, representation] of rec.avatarRepresentations) {
      if (liveIds.has(playerId)) continue;
      if (representation.layer) {
        try { representation.layer.dispose(); } catch {}
      }
      representation.disposed = true;
      rec.avatarRepresentations.delete(playerId);
      this.avatarRepresentationDisposeCount += 1;
    }
    rec.avatarProxies = [];
    const nextPlayerIds = Array.from(rec.avatarRepresentations.keys());
    rec.lastAvatarReconcile = {
      at: new Date(now).toISOString(),
      at_ms: now,
      previous_player_ids: previousPlayerIds,
      next_player_ids: nextPlayerIds,
      removed_player_ids: previousPlayerIds.filter((playerId) => !nextPlayerIds.includes(playerId)),
      added_player_ids: nextPlayerIds.filter((playerId) => !previousPlayerIds.includes(playerId)),
    };
  }

  _buildPreviewScene(rec, machine, portalEntry) {
    this._disposeAvatarRepresentations(rec);
    try { rec.composition?.dispose?.(); } catch {}
    if (rec.scene) disposeObject(rec.scene);
    if (!rec.destinationContent || !this.composeDestinationContent) {
      rec.scene = null;
      rec.composition = null;
      rec.contentObjects = [];
      return;
    }
    const composition = this.composeDestinationContent(rec.destinationContent, {
      portal_key: rec.portalKey,
      portal_entry: portalEntry,
      width: rec.renderTarget.width,
      height: rec.renderTarget.height,
    });
    if (!composition?.scene) throw new Error("canonical portal composition returned no scene");
    const scene = composition.scene;
    rec.composition = composition;
    if (composition.presentation?.assets?.status === "pending") {
      rec.contentStatus = "loading_assets";
    }
    rec.roomDressing = composition.presentation || null;
    rec.awarenessVolume = portalAwarenessVolume(machine, portalEntry);
    rec.clipPlanes = [];

    if (rec.awarenessVolume.valid) {
      const volume = rec.awarenessVolume;
      const center = new THREE.Vector3(...volume.center);
      const forward = new THREE.Vector3(...volume.forward).normalize();
      // Fixed destination-forward half-space: reciprocal source-side viewing
      // never changes which side of the destination is spatially eligible.
      rec.clipPlanes.push(new THREE.Plane(
        forward.clone(),
        -forward.dot(center) + volume.plane_setback_m,
      ));
      for (let index = 0; index < RADIAL_CLIP_PLANE_COUNT; index += 1) {
        const y = 1 - (index / (RADIAL_CLIP_PLANE_COUNT - 1)) * 2;
        const radial = Math.sqrt(Math.max(0, 1 - y * y));
        const theta = index * Math.PI * (3 - Math.sqrt(5));
        const outward = new THREE.Vector3(Math.cos(theta) * radial, y, Math.sin(theta) * radial);
        rec.clipPlanes.push(new THREE.Plane(
          outward.clone().negate(),
          outward.dot(center) + volume.radius_m,
        ));
      }
    }

    // The destination portal ring (the frame the player emerges from).
    // drawn at the RECONCILED target frame pose — the
    // same plane the camera glue maps the source portal onto — so the ring
    // through the window lands ON the ring being looked through by
    // construction. Colored with the DESTINATION world's own ring rule (the
    // color arrival will show), not the source world's accent. The region
    // payload's own portal pose is recorded beside it for agreement evidence.
    const destPortal = machine.region ? machine.region.destination_portal : null;
    const targetFrame = portalEntry.target_frame || null;
    rec.destRing = null;
    rec.destRingMesh = null;
    if (destPortal && targetFrame && Array.isArray(targetFrame.position)) {
      const ringColor = destWorldRingColor(portalEntry.target_location_id);
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(1, 0.075, 18, 80),
        new THREE.MeshStandardMaterial({
          color: ringColor,
          emissive: ringColor,
          emissiveIntensity: 0.72,
          roughness: 0.32,
          metalness: 0.24,
        })
      );
      const tp = targetFrame.position;
      ring.position.set(Number(tp[0]) || 0, Number(tp[1]) || PORTAL_FRAME_CENTER_Y, Number(tp[2]) || 0);
      const fwd = Array.isArray(targetFrame.forward) ? targetFrame.forward : [0, 0, 1];
      ring.rotation.y = Math.atan2(Number(fwd[0]) || 0, Number(fwd[2]) || 0);
      ring.scale.set(
        (Number(targetFrame.width_m) || 1.8) / 2,
        (Number(targetFrame.height_m) || 2.8) / 2,
        1
      );
      ring.name = "dest-portal-ring";
      scene.add(ring);
      rec.destRingMesh = ring;
      const payloadTrigger = Array.isArray(destPortal.trigger_position)
        ? destPortal.trigger_position
        : null;
      rec.destRing = {
        world_position: [ring.position.x, ring.position.y, ring.position.z],
        yaw: ring.rotation.y,
        color: `#${new THREE.Color(ringColor).getHexString()}`,
        target_frame_pose_source: targetFrame.pose_source || "preset_placeholder",
        payload_trigger_position: payloadTrigger ? payloadTrigger.slice(0, 3) : null,
        // Planar distance between the glue plane's anchor and the destination
        // server's own hosted portal pose — ~0 when the target frame has been
        // reconciled from the region payload (the requirement).
        target_frame_vs_payload_m: payloadTrigger
          ? Math.hypot(
              (Number(tp[0]) || 0) - (Number(payloadTrigger[0]) || 0),
              (Number(tp[2]) || 0) - (Number(payloadTrigger[2]) || 0)
            )
          : null,
      };
    }

    // Registered players inside the destination-side circle — the
    // "avatars standing within the circle", placed at live registry positions.
    // Destination-plane clip: the through-ring view must only contain what
    // lies beyond the destination portal plane (the region the player walks
    // into), never geometry behind it. Slight setback keeps the destination
    // ring itself visible.
    const tf = portalEntry.target_frame || null;
    if (tf && Array.isArray(tf.forward) && Array.isArray(tf.position)) {
      const n = new THREE.Vector3(tf.forward[0], tf.forward[1], tf.forward[2]).normalize();
      // Keep the destination-forward basis available for parity/debug proof.
      // Viewer side never changes the eligible destination half-space.
      // `plane_offset` = n . target_frame.position.
      rec.clipBasis = {
        normal: n.clone(),
        plane_offset:
          n.x * (Number(tf.position[0]) || 0) +
          n.y * (Number(tf.position[1]) || 0) +
          n.z * (Number(tf.position[2]) || 0),
      };
      rec.clipPlaneSide = "front";
      rec.clipPlane = rec.clipPlanes[0] || null;
    } else {
      rec.clipPlane = null;
      rec.clipBasis = null;
      rec.clipPlaneSide = null;
    }

    rec.scene = scene;
    rec.entityMeshes = [];
    rec.avatarProxies = [];
    rec.avatarRepresentations = rec.avatarRepresentations || new Map();
    this._indexCanonicalContent(rec);
    this._reconcileAvatarRepresentations(rec, machine, portalEntry);
  }

  _indexCanonicalContent(rec) {
    if (!rec?.scene) return;
    rec.scene.updateWorldMatrix(true, true);
    const priorBaseVisibility = new Map(
      (rec.contentObjects || []).map((item) => [item.node, item.base_visible]),
    );
    rec.contentObjects = [];
    rec.scene.traverse((node) => {
      if (!node || (!node.isMesh && !node.isLine && !node.isPoints) || node === rec.destRingMesh) return;
      for (let parent = node; parent; parent = parent.parent) {
        if (parent.userData?.portalPreviewAvatar) return;
        if (parent === rec.scene) break;
      }
      let sharedAssetInstance = false;
      for (let parent = node; parent; parent = parent.parent) {
        if (String(parent.name || "").startsWith("wow-asset:")) sharedAssetInstance = true;
        if (parent === rec.scene) break;
      }
      node.userData.portalSharedAssetInstance = sharedAssetInstance;
      const sourceMaterials = Array.isArray(node.material) ? node.material : node.material ? [node.material] : [];
      if (sharedAssetInstance && sourceMaterials.length && !node.userData.__portalMaterialsCloned) {
        const cloned = sourceMaterials.map((material) => material.clone());
        node.material = Array.isArray(node.material) ? cloned : cloned[0];
        node.userData.__portalMaterialsCloned = true;
      }
      applyPreviewClipping(node, rec.clipPlanes);
      const box = new THREE.Box3().setFromObject(node);
      if (box.isEmpty()) return;
      rec.contentObjects.push({
        node,
        bounds: box,
        bounds_array: {
          min: [box.min.x, box.min.y, box.min.z],
          max: [box.max.x, box.max.y, box.max.z],
        },
        base_visible: priorBaseVisibility.has(node)
          ? priorBaseVisibility.get(node)
          : node.visible !== false,
        dynamic: !!node.isSkinnedMesh || node.userData?.portalDynamicBounds === true,
        id: node.name || node.uuid,
        last_reason: null,
      });
    });
    rec.canonicalInventory = rec.contentObjects.map((item) => item.id);
    rec.assetIndexStatus = rec.composition?.presentation?.assets?.status || null;
    rec.contentInventoryRevision = rec.composition?.inventory_revision ?? null;
  }

  _requestDestinationContent(rec, portalEntry) {
    const destinationKey = [
      portalEntry?.target_location_id || "",
      portalEntry?.target_world_id || "",
    ].join("|");
    if (rec.destinationKey && rec.destinationKey !== destinationKey) {
      this._disposeAvatarRepresentations(rec);
      try { rec.composition?.dispose?.(); } catch {}
      if (rec.scene) disposeObject(rec.scene);
      rec.scene = null;
      rec.composition = null;
      rec.destinationContent = null;
      rec.signature = null;
    }
    rec.destinationKey = destinationKey;
    let source = this.destinationSources.get(destinationKey);
    if (!source) {
      source = { status: "loading", value: null, error: null };
      this.destinationSources.set(destinationKey, source);
      source.promise = Promise.resolve()
        .then(() => this.resolveDestinationContent(portalEntry))
        .then((value) => {
          if (!value) throw new Error("canonical destination resolver returned no content");
          source.status = "ready";
          source.value = value;
          for (const candidate of this.records.values()) {
            if (candidate.destinationKey !== destinationKey) continue;
            candidate.destinationContent = value;
            candidate.contentStatus = "ready";
            candidate.contentError = null;
            candidate.signature = null;
            try {
              this._buildPreviewScene(candidate, candidate.machine, candidate.portalEntry);
              candidate.signature = this._signature(candidate.machine, candidate.portalEntry);
            } catch (error) {
              candidate.contentStatus = "error";
              candidate.contentError = error?.message || String(error);
            }
          }
          this.renderActive();
          return value;
        })
        .catch((error) => {
          source.status = "error";
          source.error = error?.message || String(error);
          for (const candidate of this.records.values()) {
            if (candidate.destinationKey !== destinationKey) continue;
            candidate.contentStatus = "error";
            candidate.contentError = source.error;
          }
          return null;
        });
    }
    rec.contentStatus = source.status;
    rec.contentError = source.error;
    if (source.status === "ready") rec.destinationContent = source.value;
  }

  _ensureRecord(portalKey, machine, portalEntry) {
    let rec = this.records.get(portalKey);
    if (!rec) {
      const renderTarget = new THREE.WebGLRenderTarget(1, 1, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
      });
      // P2: keep the SRGB tag. It selects the SRGB8_ALPHA8 internal
      // format (three r160 setupRenderTarget -> getInternalFormat, non-XR RT),
      // so the GPU sRGB-decodes on sample and the aperture/takeover shaders
      // receive LINEAR texels — which they re-encode via SRGB_OETF_GLSL. It is
      // NOT the output-encode fix (that lives in the shaders); it is left as-is
      // because flipping it to Linear would change the bytes readRenderTargetPixels
      // returns and shift the existing warm-through-ring texel thresholds.
      if ("SRGBColorSpace" in THREE) renderTarget.texture.colorSpace = THREE.SRGBColorSpace;
      rec = {
        portalKey,
        scene: null,
        camera: new THREE.PerspectiveCamera(60, 1, 0.05, 80),
        renderTarget,
        apertureMaterial: makeApertureWindowMaterial(renderTarget.texture),
        takeoverMaterial: null,
        signature: null,
        entityMeshes: [],
        avatarProxies: [],
        avatarRepresentations: new Map(),
        avatarCulling: new Map(),
        active: false,
        cameraMapped: false,
        lastCameraTransform: null,
        framesRendered: 0,
        portalEntry: null,
        // evidence fields (filled by _buildPreviewScene).
        roomDressing: null,
        destRing: null,
        destRingMesh: null,
        identityFilter: null,
        lastAvatarReconcile: null,
        // P3: shared-edge identity of the portal this record renders.
        sharedEdge: null,
        // P4: both-sides render state (viewer side + clip aim).
        viewerSide: null,
        clipBasis: null,
        clipPlaneSide: null,
        clipPlanes: [],
        awarenessVolume: null,
        contentObjects: [],
        canonicalInventory: [],
        composition: null,
        destinationContent: null,
        destinationKey: null,
        contentStatus: "loading",
        contentError: null,
        apertureProjection: null,
        frustum: new THREE.Frustum(),
        lastRenderAtMs: null,
      };
      this.records.set(portalKey, rec);
    }
    rec.portalEntry = portalEntry;
    rec.machine = machine;
    // P3: the record's shared-edge identity — recomputed on every ensure
    // (pure, cheap) so the adopted-pose identity assertion tracks the machine's
    // live region payload. Additive evidence only; P4 owns any render gating.
    rec.sharedEdge = portalSharedEdgeIdentity(machine, portalEntry);
    this._requestDestinationContent(rec, portalEntry);
    const sig = this._signature(machine, portalEntry);
    if (rec.destinationContent && sig !== rec.signature) {
      this._buildPreviewScene(rec, machine, portalEntry);
      rec.signature = sig;
    } else if (rec.scene) {
      this._reconcileAvatarRepresentations(rec, machine, portalEntry);
    }
    return rec;
  }

  /** Explicit support gate. Canonical destination composition is independent
   *  of region snapshot warmth and the old proxy inventory. */
  static machineRenderable(machine) {
    // Canonical destination composition is independent of the old region
    // proxy inventory and source-side prefetch perimeter. The machine remains
    // useful for authored awareness/presence truth, but cold/loading state must
    // produce a truthful bounded loading window, never a still/proxy rung.
    return !machine || machine.supported !== false;
  }

  /** Signed camera distance along the SOURCE portal's forward axis. */
  _cameraFrontLocalZ(portalEntry) {
    if (!this.mainCamera || !portalEntry || !portalEntry.frame) return null;
    const frame = portalEntry.frame;
    const fp = Array.isArray(frame.position) ? frame.position : [0, PORTAL_FRAME_CENTER_Y, 0];
    const fwd = Array.isArray(frame.forward) ? frame.forward : [0, 0, 1];
    this.mainCamera.getWorldPosition(this._tmpVec);
    return (
      (this._tmpVec.x - fp[0]) * fwd[0] +
      (this._tmpVec.y - fp[1]) * fwd[1] +
      (this._tmpVec.z - fp[2]) * fwd[2]
    );
  }

  /** Which side of the SOURCE portal plane the live camera stands on
   *  ("front"/"back", null when unknown). One boundary rule for the surface
   *  gate AND the per-frame glue (portalSideForLocalZ). */
  _cameraViewerSide(portalEntry) {
    return portalSideForLocalZ(this._cameraFrontLocalZ(portalEntry));
  }

  /** Side gate — P4 (#2 render half): the spatial rung arms for ANY
   *  viewer standing on an ALLOWED ENTRY side of the portal (canonical
   *  portalEntrySideAllowed): BOTH faces of a bidirectional portal, only the
   *  allowed face of a one-way portal. The same proper 180° isometry serves
   *  both sides (it is the crossing's own map — see renderActive); the
   *  blocked side of a one-way portal keeps the pre-011 aperture ladder. */
  _cameraOnAllowedSide(portalEntry) {
    const side = this._cameraViewerSide(portalEntry);
    if (side == null) return false;
    return portalEntrySideAllowed(portalEntry ? portalEntry.traversal : null, side);
  }

  /** Surface selection entry point: returns the aperture material bundle when
   *  the spatial rung should own this portal's aperture, else null.
   *
   *  Viewer-side eligibility and canonical destination resolution determine
   *  ownership. The perimeter verdict remains evidence/subscription truth. */
  surfaceForPortal(portalKey, machine, portalEntry) {
    const perimeter = portalPerimeterLiveGate(machine);
    const viewerSide = this._cameraViewerSide(portalEntry);
    const attempt = {
      portal_key: portalKey || null,
      reason: null,
      viewer_side: viewerSide,
      perimeter,
    };
    this.lastSurfaceAttempt = attempt;
    const refuse = (reason) => {
      attempt.reason = reason;
      const rec = this.records.get(portalKey);
      if (rec) rec.active = false;
      this._noteSurfaceGate(portalKey, false, attempt);
      return null;
    };
    if (!this.renderer || !this.mainCamera) {
      return refuse("renderer_or_camera_unavailable");
    }
    if (!portalKey || !portalEntry || !portalEntry.frame || !portalEntry.target_frame) {
      return refuse("portal_frames_unavailable");
    }
    if (!SpatialPortalPreviewManager.machineRenderable(machine)) {
      return refuse("destination_machine_explicitly_unsupported");
    }
    if (!this._cameraOnAllowedSide(portalEntry)) {
      return refuse("camera_on_blocked_side");
    }
    const rec = this._ensureRecord(portalKey, machine, portalEntry);
    rec.active = true;
    attempt.reason = rec.awarenessVolume && !rec.awarenessVolume.valid
      ? "canonical_destination_awareness_unavailable"
      : rec.contentStatus === "ready"
      ? "canonical_destination_visible"
      : rec.contentStatus === "error"
        ? "canonical_destination_unavailable"
        : "canonical_destination_loading";
    this._noteSurfaceGate(portalKey, true, attempt);
    return {
      material: rec.apertureMaterial,
      record: rec,
      debug: this._recordDebug(rec),
    };
  }

  /** P4: per-portal live-vs-image gate ledger entry. */
  _noteSurfaceGate(portalKey, live, attempt) {
    if (!portalKey) return;
    this.surfaceGates.set(portalKey, {
      portal_key: portalKey,
      live,
      surface: live ? "live_spatial_render" : "image_rungs",
      reason: attempt.reason,
      viewer_side: attempt.viewer_side,
      perimeter: attempt.perimeter,
      at_ms: this.nowMs(),
    });
  }

  /** P4 (#2): aim the destination clip plane at the half-space the
   *  viewer's side of the window looks into. Front viewers (glued camera
   *  BEHIND the destination plane) see the destination's front half-space —
   *  the byte-identical pre-P4 clip; back viewers (glued camera IN FRONT of
   *  the destination plane, looking back) see the destination's back
   *  half-space. The ±0.1 m setback keeps the destination ring visible from
   *  both faces. Mutates the ONE shared Plane instance in place. */
  _syncClipPlaneForViewerSide(rec, viewerSide) {
    if (!rec) return;
    // The source can be viewed from either allowed face, but destination
    // eligibility is always the target frame's authored into-destination
    // half-space. Reciprocal viewing must not reveal the back half of a world.
    rec.clipPlaneSide = "target_frame_forward";
    rec.sourceViewerSide = viewerSide === "back" ? "back" : "front";
  }

  /** Per-frame: map the live camera through each active portal's frame pair
   *  and render that portal's destination preview into its render target. */
  renderActive() {
    if (!this.renderer || !this.mainCamera) return;
    const renderer = this.renderer;
    const drawing = typeof renderer.getDrawingBufferSize === "function"
      ? renderer.getDrawingBufferSize(this._tmpVec2)
      : renderer.getSize(this._tmpVec2);
    const drawingWidth = Math.max(1, Math.round(drawing.x));
    const drawingHeight = Math.max(1, Math.round(drawing.y));

    this.mainCamera.updateMatrixWorld(true);
    this.mainCamera.getWorldPosition(this._tmpVec);
    const camPos = this._cameraPosition;
    camPos[0] = this._tmpVec.x;
    camPos[1] = this._tmpVec.y;
    camPos[2] = this._tmpVec.z;
    const fwd = this._tmpDirection;
    this.mainCamera.getWorldDirection(fwd);
    const camFwdVec = this._cameraForward;
    camFwdVec[0] = fwd.x;
    camFwdVec[1] = fwd.y;
    camFwdVec[2] = fwd.z;

    for (const rec of this.records.values()) {
      if (!rec.active || !rec.portalEntry) continue;
      const takeoverActive = this.takeover.engaged && this.takeover.portal_key === rec.portalKey;
      const projected = takeoverActive
        ? {
            visible: true,
            reason: "crossing_takeover_full_view",
            x: 0,
            y: 0,
            width: drawingWidth,
            height: drawingHeight,
            area_device_px: drawingWidth * drawingHeight,
            threshold_device_px: MIN_PROJECTED_PORTAL_AREA_DEVICE_PX,
            drawing_buffer: { width: drawingWidth, height: drawingHeight },
          }
        : projectedPortalApertureDevicePixels(
            rec.portalEntry,
            this.mainCamera,
            drawingWidth,
            drawingHeight,
          );
      rec.apertureProjection = projected;
      if (!projected.visible) {
        rec.cameraMapped = false;
        rec.renderEligible = false;
        if (!rec.culledTargetCleared) {
          const previousTarget = renderer.getRenderTarget();
          renderer.setRenderTarget(rec.renderTarget);
          renderer.clear();
          renderer.setRenderTarget(previousTarget);
          rec.culledTargetCleared = true;
        }
        continue;
      }
      rec.culledTargetCleared = false;
      rec.renderEligible = true;
      const rtW = Math.max(1, projected.width);
      const rtH = Math.max(1, projected.height);
      if (rec.renderTarget.width !== rtW || rec.renderTarget.height !== rtH) {
        rec.renderTarget.setSize(rtW, rtH);
      }
      rec.apertureMaterial.uniforms.uViewport.value.set(
        projected.x / drawingWidth,
        projected.y / drawingHeight,
        rtW / drawingWidth,
        rtH / drawingHeight,
      );
      if (!rec.scene) {
        const previousTarget = renderer.getRenderTarget();
        renderer.setRenderTarget(rec.renderTarget);
        renderer.clear();
        renderer.setRenderTarget(previousTarget);
        continue;
      }
      if (!rec.awarenessVolume?.valid) {
        const previousTarget = renderer.getRenderTarget();
        renderer.setRenderTarget(rec.renderTarget);
        renderer.clear();
        renderer.setRenderTarget(previousTarget);
        continue;
      }
      const preRenderAssetStatus = rec.composition?.presentation?.assets?.status || null;
      if (preRenderAssetStatus === "pending") {
        const previousTarget = renderer.getRenderTarget();
        renderer.setRenderTarget(rec.renderTarget);
        renderer.clear();
        renderer.setRenderTarget(previousTarget);
        continue;
      }
      if (rec.contentStatus === "loading_assets") {
        rec.contentStatus = preRenderAssetStatus === "error" ? "ready_with_asset_errors" : "ready";
      }
      if (rec.machine) this._reconcileAvatarRepresentations(rec, rec.machine, rec.portalEntry);
      const glued = glueCameraThroughFrames(
        rec.portalEntry.frame,
        rec.portalEntry.target_frame,
        camPos,
        camFwdVec
      );
      // P4 (#2): the glue serves BOTH sides with the one proper 180°
      // isometry — the crossing's own map, so from either face the through-
      // ring view equals the post-commit arrival view. Only an entry side the
      // traversal rule blocks (one-way portals) keeps the pre-011 ladder.
      if (!glued) {
        rec.cameraMapped = false;
        continue;
      }
      const viewerSide = portalSideForLocalZ(glued.source_local.z);
      if (
        viewerSide == null ||
        !portalEntrySideAllowed(rec.portalEntry.traversal || null, viewerSide)
      ) {
        rec.cameraMapped = false;
        continue;
      }
      // The window shows the destination half-space beyond the mapped camera:
      // flip the destination clip plane with the viewer side.
      this._syncClipPlaneForViewerSide(rec, viewerSide);
      rec.viewerSide = viewerSide;
      const t = {
        position: glued.position,
        target: [
          glued.position[0] + glued.forward[0] * 4,
          glued.position[1] + glued.forward[1] * 4,
          glued.position[2] + glued.forward[2] * 4,
        ],
        rotation_y: Math.atan2(glued.forward[0], glued.forward[2]),
      };
      rec.camera.fov = this.mainCamera.fov;
      rec.camera.near = this.mainCamera.near;
      rec.camera.far = Math.max(this.mainCamera.far, 80);
      rec.camera.aspect = drawingWidth / drawingHeight;
      rec.camera.position.set(t.position[0], t.position[1], t.position[2]);
      rec.camera.lookAt(t.target[0], t.target[1], t.target[2]);
      const topOffset = Math.max(0, drawingHeight - projected.y - rtH);
      rec.camera.setViewOffset(
        drawingWidth,
        drawingHeight,
        projected.x,
        topOffset,
        rtW,
        rtH,
      );
      rec.camera.updateProjectionMatrix();
      rec.camera.updateMatrixWorld(true);
      rec.cameraMapped = true;
      rec.lastCameraTransform = {
        position: t.position.slice(),
        target: t.target.slice(),
        rotation_y: t.rotation_y,
        source_local: glued.source_local,
        // P4: which face of the source portal this frame was mapped
        // for (the clip plane is aimed at the matching destination half-space).
        viewer_side: viewerSide,
      };

      // The takeover texture already sits behind/inside the source ring. Draw
      // the destination scene and avatars, but not its redundant return ring,
      // for the matching commit-in-flight crossing only.
      const secondaryRingSuppressed = shouldSuppressDestinationRing(this.takeover, rec.portalKey);
      if (rec.destRingMesh) rec.destRingMesh.visible = !secondaryRingSuppressed;
      if (rec.destRing) rec.destRing.secondary_ring_suppressed = secondaryRingSuppressed;

      const now = this.nowMs();
      const elapsedSeconds = rec.lastRenderAtMs == null
        ? 0
        : Math.min(0.05, Math.max(0, (now - rec.lastRenderAtMs) / 1000));
      rec.lastRenderAtMs = now;
      rec.composition?.update?.(elapsedSeconds, rec.camera);
      const assetStatus = rec.composition?.presentation?.assets?.status || null;
      const contentInventoryRevision = rec.composition?.inventory_revision ?? null;
      if (
        assetStatus !== rec.assetIndexStatus ||
        contentInventoryRevision !== rec.contentInventoryRevision
      ) this._indexCanonicalContent(rec);
      rec.scene.updateWorldMatrix(true, true);
      rec.frustum.setFromProjectionMatrix(
        this._tmpProjection.multiplyMatrices(rec.camera.projectionMatrix, rec.camera.matrixWorldInverse),
      );
      let eligibleObjectCount = 0;
      let culledObjectCount = 0;
      for (const item of rec.contentObjects || []) {
        if (item.dynamic) {
          item.bounds.setFromObject(item.node);
          item.bounds_array.min[0] = item.bounds.min.x;
          item.bounds_array.min[1] = item.bounds.min.y;
          item.bounds_array.min[2] = item.bounds.min.z;
          item.bounds_array.max[0] = item.bounds.max.x;
          item.bounds_array.max[1] = item.bounds.max.y;
          item.bounds_array.max[2] = item.bounds.max.z;
        }
        const bounds = item.bounds_array;
        const awareness = boundsIntersectPortalAwareness(bounds, rec.awarenessVolume);
        const inFrustum = awareness.eligible && rec.frustum.intersectsBox(item.bounds);
        item.node.visible = item.base_visible && awareness.eligible && inFrustum;
        item.last_reason = !item.base_visible
          ? "canonical_builder_hidden"
          : !awareness.eligible
            ? awareness.reason
            : !inFrustum
              ? "outside_portal_camera_frustum"
              : "bounds_intersect_awareness_and_frustum";
        if (item.node.visible) eligibleObjectCount += 1;
        else culledObjectCount += 1;
      }
      rec.objectCulling = rec.objectCulling || {};
      rec.objectCulling.eligible_count = eligibleObjectCount;
      rec.objectCulling.culled_count = culledObjectCount;

      for (const representation of rec.avatarRepresentations.values()) {
        const rig = representation.layer?.avatarRig;
        if (!rig) continue;
        const body = representation.body_bounds;
        const bodyBox = this._tmpAvatarBox;
        bodyBox.min.set(body.min[0], body.min[1], body.min[2]);
        bodyBox.max.set(body.max[0], body.max[1], body.max[2]);
        const inFrustum = rec.frustum.intersectsBox(bodyBox);
        rig.visible = representation.state === "full" && inFrustum;
        const culling = rec.avatarCulling.get(representation.player_id) || {};
        culling.eligible = rig.visible;
        culling.reason = rig.visible
            ? "full_avatar_bounds_intersect_awareness_and_frustum"
            : representation.state !== "full"
              ? "full_avatar_loading"
              : "outside_portal_camera_frustum";
        culling.frustum_intersects = inFrustum;
        rec.avatarCulling.set(representation.player_id, culling);
      }

      const prevTarget = renderer.getRenderTarget();
      renderer.setRenderTarget(rec.renderTarget);
      renderer.clear();
      renderer.render(rec.scene, rec.camera);
      renderer.setRenderTarget(prevTarget);
      rec.framesRendered += 1;
      const frameAt = this.nowMs();
      for (const representation of rec.avatarRepresentations.values()) {
        for (const sample of representation.pose_samples) {
          if (sample.aperture_frame_at_ms != null) continue;
          sample.aperture_frame_at_ms = frameAt;
          sample.pose_to_aperture_ms = Math.max(0, frameAt - sample.received_at_ms);
        }
      }

      if (this.takeover.engaged && this.takeover.portal_key === rec.portalKey) {
        this.takeover.frames_rendered += 1;
        if (this.takeover.last_engaged) {
          this.takeover.last_engaged.frames_rendered = this.takeover.frames_rendered;
          // The mapped (destination-space) camera of the final takeover
          // frames — the e2e compares this with the live camera right after
          // promotion (the two are the same mapping, so the residual is just
          // the travel during the transfer window).
          this.takeover.last_engaged.last_camera = rec.lastCameraTransform
            ? {
                position: rec.lastCameraTransform.position.slice(),
                target: rec.lastCameraTransform.target.slice(),
                rotation_y: rec.lastCameraTransform.rotation_y,
              }
            : null;
        }
      }
    }
  }

  /** Crossing takeover: while the warm crossing commits (departed -> promoted,
   *  ~tens of ms), the ring's content — the SAME mapped destination render —
   *  covers the whole viewport, so the world outside the ring is already the
   *  destination when the promotion lands. Never engaged on cold crossings;
   *  not a DOM overlay, not a card, adds zero delay. */
  engageTakeover(portalKey) {
    const rec = this.records.get(portalKey);
    const attempt = { at: new Date().toISOString(), portal_key: portalKey, reason: null };
    this.takeover.last_attempt = attempt;
    if (!rec || !rec.active || !rec.cameraMapped || !this.hostScene) {
      attempt.reason = !rec
        ? "no_record_for_portal"
        : !rec.active
          ? "record_inactive"
          : !rec.cameraMapped
            ? "camera_not_mapped"
            : "no_host_scene";
      return false;
    }
    if (this.takeover.engaged && this.takeover.portal_key === portalKey) return true;
    this.takeover.engaged = true;
    this.takeover.portal_key = portalKey;
    this.takeover.engaged_at = new Date().toISOString();
    this.takeover.frames_rendered = 0;
    this.takeover.last_engaged = {
      portal_key: portalKey,
      engaged_at: this.takeover.engaged_at,
      // Honest accounting: a same-frame promotion (transfer faster than one
      // display frame) leaves this at 0 — the takeover was armed but the
      // destination went live before another frame was needed.
      frames_rendered: 0,
      // The mapped destination-space camera at engage time (fresh from the
      // last aperture frame) — compared post-arrival with the live camera.
      last_camera: rec.lastCameraTransform
        ? {
            position: rec.lastCameraTransform.position.slice(),
            target: rec.lastCameraTransform.target.slice(),
            rotation_y: rec.lastCameraTransform.rotation_y,
          }
        : null,
    };
    // Apertures normally use a direct-density crop. Before exposing the
    // fullscreen takeover quad, synchronously redraw the same destination at
    // full drawing-buffer dimensions so no cropped texture is stretched.
    this.renderActive();
    this.takeover.frames_rendered = 0;
    this.takeover.last_engaged.frames_rendered = 0;
    if (!rec.takeoverMaterial) rec.takeoverMaterial = makeTakeoverMaterial(rec.renderTarget.texture);
    if (!this._takeoverQuad) {
      this._takeoverQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), rec.takeoverMaterial);
      this._takeoverQuad.name = "portal-takeover-window";
      this._takeoverQuad.frustumCulled = false;
      this._takeoverQuad.renderOrder = 9999;
      this.hostScene.add(this._takeoverQuad);
    } else {
      this._takeoverQuad.material = rec.takeoverMaterial;
    }
    return true;
  }

  disengageTakeover() {
    if (this._takeoverQuad && this._takeoverQuad.parent) {
      this._takeoverQuad.parent.remove(this._takeoverQuad);
    }
    this._takeoverQuad = null;
    this.takeover.engaged = false;
    this.takeover.portal_key = null;
  }

  _recordDebug(rec) {
    return {
      portal_key: rec.portalKey,
      active: rec.active,
      camera_mapped: rec.cameraMapped,
      // P3: the shared-edge identity of the portal this record renders —
      // the adopted destination pose provably belongs to THIS portal's own edge.
      shared_edge_identity: rec.sharedEdge || null,
      // P4: both-sides render evidence — which face the last mapped
      // frame served, which destination half-space the clip plane kept, and
      // the perimeter verdict that let this record be live at all.
      viewer_side: rec.viewerSide || null,
      clip_plane_side: rec.clipPlaneSide || null,
      both_sides_render:
        "one proper 180deg isometry serves front AND back viewers; the " +
        "awareness half-space remains target-frame-forward for both source viewer sides",
      perimeter_gate: portalPerimeterLiveGate(rec.machine),
      projection: "screen_space_projective_window",
      // the glue is the proper 180°-about-up portal
      // rotation (local x AND z negated), one convention with the crossing
      // remap (mapTransformBetweenPortalFrames / mapCameraAcrossCrossing).
      camera_mapping: "portal-frame 180deg rotation glue (shared with the crossing remap)",
      glue_convention: "proper_rotation_180deg_about_up",
      destination_coordinates: "raw destination world space (no re-basing)",
      canonical_content_status: rec.contentStatus,
      canonical_content_error: rec.contentError,
      canonical_content_source: rec.composition?.source || null,
      canonical_content_revision: rec.composition?.revision || rec.destinationContent?.revision || null,
      canonical_inventory: rec.canonicalInventory || [],
      canonical_object_count: rec.contentObjects?.length || 0,
      entity_mesh_count: rec.contentObjects?.length || 0,
      avatar_proxy_count: 0,
      avatar_full_count: Array.from(rec.avatarRepresentations.values()).filter(
        (entry) => entry.state === "full" && entry.layer && entry.layer.avatarRig && entry.layer.avatarRig.visible
      ).length,
      avatar_representation_count: rec.avatarRepresentations.size,
      avatar_fault: this.avatarFault,
      avatar_representations: Array.from(rec.avatarRepresentations.values()).map((entry) => {
        const rig = entry.layer && entry.layer.avatarRig;
        const latest = entry.pose_samples.length ? entry.pose_samples[entry.pose_samples.length - 1] : null;
        const positionError = rig && latest
          ? Math.hypot(
              rig.position.x - latest.position[0],
              rig.position.y - latest.position[1],
              rig.position.z - latest.position[2]
            )
          : null;
        return {
          player_id: entry.player_id,
          state: entry.state,
          proxy_visible: !!(entry.proxy && entry.proxy.visible),
          full_visible: !!(rig && rig.visible),
          visible_representation_count:
            (entry.proxy && entry.proxy.visible ? 1 : 0) + (rig && rig.visible ? 1 : 0),
          pose_source: entry.pose_source,
          pose_seq: entry.last_pose_seq,
          distance_from_anchor_m: entry.distance_from_anchor_m,
          circle_valid: entry.circle_valid,
          circle_center: entry.circle_center,
          circle_radius_m: entry.circle_radius_m,
          world_position: rig
            ? [rig.position.x, rig.position.y, rig.position.z]
            : null,
          rotation_y: rig ? rig.rotation.y : null,
          avatar_variant: entry.layer && entry.layer.status ? entry.layer.status.avatar_variant : null,
          avatar_render_source: entry.layer && entry.layer.status ? entry.layer.status.avatar_render_source : null,
          transition_visual: entry.latest_avatar && entry.latest_avatar.transition_visual
            ? { ...entry.latest_avatar.transition_visual }
            : null,
          avatar_visual_scale:
            entry.layer && entry.layer.status ? entry.layer.status.avatar_visual_scale : null,
          attached_item_count:
            entry.layer && typeof entry.layer.debugState === "function"
              ? entry.layer.debugState().attached_item_count
              : null,
          animation_state: entry.layer && entry.layer.status ? entry.layer.status.current_animation_state : null,
          locomotion_movement_mode:
            entry.layer && entry.layer.status ? entry.layer.status.locomotion_movement_mode : null,
          grounded: entry.layer && entry.layer.status ? entry.layer.status.avatar_grounded : null,
          jump_height_m: entry.layer && entry.layer.status ? entry.layer.status.avatar_jump_height_m : null,
          position_error_m: positionError == null ? null : Number(positionError.toFixed(5)),
          latest_pose_to_aperture_ms: latest ? latest.pose_to_aperture_ms : null,
          pose_samples: entry.pose_samples.map((sample) => ({ ...sample })),
        };
      }),
      controlled_identity_filter: rec.identityFilter || null,
      last_avatar_reconcile: rec.lastAvatarReconcile || null,
      awareness_volume: rec.awarenessVolume || null,
      awareness_clip_plane_count: rec.clipPlanes?.length || 0,
      radial_fragment_clip: (rec.clipPlanes?.length || 0) > 1,
      object_culling: {
        ...(rec.objectCulling || { eligible_count: 0, culled_count: 0 }),
        objects: (rec.contentObjects || []).map((item) => ({
          id: item.id,
          reason: item.last_reason,
          bounds: item.bounds_array,
          dynamic_bounds: item.dynamic,
          hosted_scene_object: item.node.userData?.hostedSceneObject || null,
        })),
      },
      avatar_culling: Array.from(rec.avatarCulling || new Map(), ([, value]) => value),
      frames_rendered: rec.framesRendered,
      render_target: {
        width: rec.renderTarget.width,
        height: rec.renderTarget.height,
        sizing_rule: "projected aperture device-pixel crop at direct drawing-buffer density",
        fixed_low_resolution: false,
      },
      projected_aperture: rec.apertureProjection || null,
      last_camera: rec.lastCameraTransform,
      // evidence surfaces: destination room dressing +
      // the destination ring pose/color/agreement + the ring-alignment probe
      // (source-ring vs dest-ring NDC deltas — ~0 when the window is aligned).
      room_dressing: rec.roomDressing || null,
      dest_ring: rec.destRing || null,
      ring_alignment: this._ringAlignmentProbe(rec),
      spatial_render_standard_conformance: false,
    };
  }

  /** the window-identity probe. For the portal plane's
   *  center and four rim points (±halfWidth along right, ±halfHeight along
   *  up), project the SOURCE point through the LIVE camera and the mapped
   *  DESTINATION point (local x negated — the 180° rotation) through the
   *  GLUED camera. When the aperture is a correct window the two NDC
   *  positions agree per point at ANY camera pose; the max delta is the
   *  machine regression bound for the misalignment screenshot. */
  _ringAlignmentProbe(rec) {
    if (!rec.cameraMapped || !this.mainCamera || !rec.portalEntry) return null;
    const frame = rec.portalEntry.frame;
    const targetFrame = rec.portalEntry.target_frame;
    if (!frame || !targetFrame) return null;
    const sp = vec3(frame.position, [0, PORTAL_FRAME_CENTER_Y, 0]);
    const sr = vec3(frame.right, [1, 0, 0]);
    const su = vec3(frame.up, [0, 1, 0]);
    const tp = vec3(targetFrame.position, [0, PORTAL_FRAME_CENTER_Y, 0]);
    const tr = vec3(targetFrame.right, [1, 0, 0]);
    const tu = vec3(targetFrame.up, [0, 1, 0]);
    const halfW = (Number(frame.width_m) || 1.8) / 2;
    const halfH = (Number(frame.height_m) || 2.8) / 2;
    const samples = [
      { label: "center", a: 0, b: 0 },
      { label: "right_rim", a: halfW, b: 0 },
      { label: "left_rim", a: -halfW, b: 0 },
      { label: "top_rim", a: 0, b: halfH },
      { label: "bottom_rim", a: 0, b: -halfH },
    ];
    this.mainCamera.updateMatrixWorld(true);
    rec.camera.updateMatrixWorld(true);
    const points = [];
    let maxDelta = 0;
    for (const s of samples) {
      const srcWorld = new THREE.Vector3(
        sp[0] + sr[0] * s.a + su[0] * s.b,
        sp[1] + sr[1] * s.a + su[1] * s.b,
        sp[2] + sr[2] * s.a + su[2] * s.b
      );
      // Canonical proper 180° rotation: source-plane local (a,b,0) ->
      // target-plane local (-a,b,0).
      const mappedPlane = properPortalLocalRotation({ x: s.a, y: s.b, z: 0 });
      const dstWorld = new THREE.Vector3(
        tp[0] + tr[0] * mappedPlane.x + tu[0] * mappedPlane.y,
        tp[1] + tr[1] * mappedPlane.x + tu[1] * mappedPlane.y,
        tp[2] + tr[2] * mappedPlane.x + tu[2] * mappedPlane.y
      );
      const srcNdc = srcWorld.clone().project(this.mainCamera);
      const dstNdc = dstWorld.clone().project(rec.camera);
      const viewport = rec.apertureMaterial.uniforms.uViewport.value;
      const dstFullNdc = new THREE.Vector2(
        (viewport.x + (dstNdc.x * 0.5 + 0.5) * viewport.z) * 2 - 1,
        (viewport.y + (dstNdc.y * 0.5 + 0.5) * viewport.w) * 2 - 1,
      );
      const delta = Math.hypot(srcNdc.x - dstFullNdc.x, srcNdc.y - dstFullNdc.y);
      if (delta > maxDelta) maxDelta = delta;
      points.push({
        label: s.label,
        source_ndc: [Number(srcNdc.x.toFixed(5)), Number(srcNdc.y.toFixed(5))],
        dest_ndc: [Number(dstFullNdc.x.toFixed(5)), Number(dstFullNdc.y.toFixed(5))],
        dest_crop_ndc: [Number(dstNdc.x.toFixed(5)), Number(dstNdc.y.toFixed(5))],
        ndc_delta: Number(delta.toFixed(6)),
      });
    }
    return {
      convention: "dest_local_x_negated_180deg_rotation",
      points,
      max_ndc_delta: Number(maxDelta.toFixed(6)),
    };
  }

  /** read back aperture render-target texels at the NDC
   *  positions where given DESTINATION-world points project through the glued
   *  camera — the machine check that the through-ring view actually shows the
   *  destination room's material colors (blue Location A room, not a black
   *  void). Returns null when the record is not actively rendering. */
  sampleApertureTexels(portalKey, worldPoints) {
    const rec = this.records.get(portalKey);
    if (!rec || !rec.active || !rec.cameraMapped || !this.renderer || !rec.scene) return null;
    const rt = rec.renderTarget;
    if (!rt || !rt.width || !rt.height) return null;
    rec.camera.updateMatrixWorld(true);
    const out = [];
    for (const wp of Array.isArray(worldPoints) ? worldPoints : []) {
      const p = Array.isArray(wp) ? wp : wp && Array.isArray(wp.position) ? wp.position : null;
      if (!p) continue;
      const ndc = new THREE.Vector3(
        Number(p[0]) || 0,
        Number(p[1]) || 0,
        Number(p[2]) || 0
      ).project(rec.camera);
      const inView = Math.abs(ndc.x) <= 1 && Math.abs(ndc.y) <= 1 && ndc.z > -1 && ndc.z < 1;
      let rgba = null;
      if (inView) {
        const px = Math.min(rt.width - 1, Math.max(0, Math.round((ndc.x * 0.5 + 0.5) * (rt.width - 1))));
        const py = Math.min(rt.height - 1, Math.max(0, Math.round((ndc.y * 0.5 + 0.5) * (rt.height - 1))));
        const buf = new Uint8Array(4);
        try {
          this.renderer.readRenderTargetPixels(rt, px, py, 1, 1, buf);
          rgba = [buf[0], buf[1], buf[2], buf[3]];
        } catch (e) {
          rgba = null;
        }
      }
      out.push({
        world_point: [Number(p[0]) || 0, Number(p[1]) || 0, Number(p[2]) || 0],
        label: wp && wp.label ? wp.label : null,
        ndc: [Number(ndc.x.toFixed(4)), Number(ndc.y.toFixed(4))],
        in_view: inView,
        rgba,
      });
    }
    return {
      portal_key: portalKey,
      render_target: { width: rt.width, height: rt.height },
      samples: out,
    };
  }

  /** Evidence surface: per-record state + per-entity camera-space positions
   *  (the numeric continuity proof the e2e scene compares across the
   *  crossing) + takeover bookkeeping. */
  debug() {
    const records = {};
    for (const [key, rec] of this.records) {
      const entry = this._recordDebug(rec);
      entry.entities = (rec.contentObjects || []).map((item) => {
        const mesh = item.node;
        const cameraSpace = rec.cameraMapped
          ? mesh.getWorldPosition(new THREE.Vector3()).applyMatrix4(rec.camera.matrixWorldInverse)
          : null;
        return {
          object_id: item.id,
          world_position: mesh.getWorldPosition(new THREE.Vector3()).toArray(),
          culling_reason: item.last_reason,
          dynamic_bounds: item.dynamic,
          hosted_scene_object: mesh.userData?.hostedSceneObject || null,
          camera_space: cameraSpace
            ? [
                Number(cameraSpace.x.toFixed(4)),
                Number(cameraSpace.y.toFixed(4)),
                Number(cameraSpace.z.toFixed(4)),
              ]
            : null,
        };
      });
      entry.avatars = Array.from(rec.avatarRepresentations.values()).map((representation) => ({
        player_id: representation.player_id,
        display_name: representation.latest_avatar?.display_name || null,
        representation: representation.state,
        world_position: representation.layer && representation.layer.avatarRig
          ? [
              representation.layer.avatarRig.position.x,
              representation.layer.avatarRig.position.y,
              representation.layer.avatarRig.position.z,
            ]
          : null,
        distance_from_anchor_m: representation.distance_from_anchor_m,
      }));
      records[key] = entry;
    }
    return {
      _claim:
        "runtime full-fidelity bounded portal windows — shared canonical " +
        "destination composition, transformed-bounds awareness, fragment clipping, " +
        "direct-density targets, strict full-or-absent peers; local validation layer, " +
        "spatial_render_standard_conformance:false",
      avatar_representation_create_count: this.avatarRepresentationCreateCount,
      avatar_representation_dispose_count: this.avatarRepresentationDisposeCount,
      records,
      takeover: {
        engaged: this.takeover.engaged,
        portal_key: this.takeover.portal_key,
        engaged_at: this.takeover.engaged_at,
        frames_rendered: this.takeover.frames_rendered,
        last_engaged: this.takeover.last_engaged,
        last_attempt: this.takeover.last_attempt || null,
      },
      last_surface_attempt: this.lastSurfaceAttempt || null,
      // Per-portal canonical surface decisions. The retained perimeter verdict
      // is subscription warmth evidence, not a image fallback gate.
      surface_gates: Object.fromEntries(this.surfaceGates),
    };
  }
}
