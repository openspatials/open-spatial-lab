/**
 * Patch 12 — canonical pure portal geometry.
 *
 * This module is intentionally plain-data only: no DOM, Three.js, network,
 * timers, storage, or mutable singleton state. It preserves two deliberately
 * distinct compatibility contracts:
 *
 * PROPER PORTAL ROTATION CONTRACT: crossing, real crossing-camera continuity,
 * aperture glue, and ring-plane alignment use local (x,y,z)->(-x,y,-z).
 *
 * LEGACY PREVIEW PROJECTION CONTRACT: mapCameraBetweenPortalFrames preserves
 * local position (x,y,z) and maps only the forward vector as (x,y,z)->(x,y,-z).
 * The legacy contract is intentionally not a proper portal rotation.
 */

export const PORTAL_AVATAR_SAMPLE_Y = 1.1;
export const PORTAL_FRAME_CENTER_Y = 1.35;
export const PORTAL_FRAME_WIDTH_M = 1.8;
export const PORTAL_FRAME_HEIGHT_M = 2.8;
export const PORTAL_TRIGGER_DEPTH_M = 0.8;
export const PORTAL_EXIT_OFFSET_M = 1.45;
export const PORTAL_EXIT_CLEARANCE_M = 0.25;
export const PORTAL_EXIT_OFFSET_MIN_M = PORTAL_TRIGGER_DEPTH_M + PORTAL_EXIT_CLEARANCE_M;
export const PORTAL_EXIT_OFFSET_MAX_M = PORTAL_EXIT_OFFSET_M;

const PORTAL_FRAME_PRESETS = Object.freeze({
  "location-a": { forward: [0, 0, 1] },
  "location-b": { forward: [-1, 0, 0] },
  "location-lobby": { forward: [0, 0, 1] },
});

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function clonePosition(value, fallback) {
  const src = Array.isArray(value) ? value : fallback;
  return [
    Number(src && src[0]) || 0,
    Number(src && src[1]) || 0,
    Number(src && src[2]) || 0,
  ];
}

export function cloneScale(value) {
  const src = Array.isArray(value) ? value : [1, 1, 1];
  return [
    Number(src && src[0]) || 1,
    Number(src && src[1]) || 1,
    Number(src && src[2]) || 1,
  ];
}

export function roundNumber(value, digits = 3) {
  const n = Number(value);
  return Number.isFinite(n) ? Number(n.toFixed(digits)) : 0;
}

export function roundVec3(value, digits = 3) {
  return clonePosition(value, [0, 0, 0]).map((entry) => roundNumber(entry, digits));
}

export function dot3(a, b) {
  return (Number(a && a[0]) || 0) * (Number(b && b[0]) || 0) +
    (Number(a && a[1]) || 0) * (Number(b && b[1]) || 0) +
    (Number(a && a[2]) || 0) * (Number(b && b[2]) || 0);
}

export function cross3(a, b) {
  return [
    (Number(a && a[1]) || 0) * (Number(b && b[2]) || 0) - (Number(a && a[2]) || 0) * (Number(b && b[1]) || 0),
    (Number(a && a[2]) || 0) * (Number(b && b[0]) || 0) - (Number(a && a[0]) || 0) * (Number(b && b[2]) || 0),
    (Number(a && a[0]) || 0) * (Number(b && b[1]) || 0) - (Number(a && a[1]) || 0) * (Number(b && b[0]) || 0),
  ];
}

export function normalizeVec3(value, fallback) {
  const v = clonePosition(value, fallback || [0, 0, 1]);
  const length = Math.hypot(v[0], v[1], v[2]);
  if (length <= 1e-6) return clonePosition(fallback || [0, 0, 1], [0, 0, 1]);
  return v.map((entry) => entry / length);
}

export function addScaled3(base, vector, scale) {
  return [
    Number(base && base[0]) + Number(vector && vector[0]) * scale,
    Number(base && base[1]) + Number(vector && vector[1]) * scale,
    Number(base && base[2]) + Number(vector && vector[2]) * scale,
  ];
}

export function subtract3(a, b) {
  return [
    Number(a && a[0]) - Number(b && b[0]),
    Number(a && a[1]) - Number(b && b[1]),
    Number(a && a[2]) - Number(b && b[2]),
  ];
}

export function yawFromVector(vector, fallbackYaw = 0) {
  const x = Number(vector && vector[0]) || 0;
  const z = Number(vector && vector[2]) || 0;
  return Math.hypot(x, z) > 1e-6 ? Math.atan2(x, z) : fallbackYaw;
}

export function normalizeYawRad(value) {
  let yaw = Number(value) || 0;
  while (yaw > Math.PI) yaw -= Math.PI * 2;
  while (yaw < -Math.PI) yaw += Math.PI * 2;
  return yaw;
}

export function crossingYawDeltaRad(sourceFrame, targetFrame) {
  if (!sourceFrame || !targetFrame) return null;
  if (!Array.isArray(sourceFrame.forward) || !Array.isArray(targetFrame.forward)) return null;
  return normalizeYawRad(
    yawFromVector(targetFrame.forward, 0) + Math.PI - yawFromVector(sourceFrame.forward, 0),
  );
}

export function vectorFromYaw(yaw) {
  return [Math.sin(Number(yaw) || 0), 0, Math.cos(Number(yaw) || 0)];
}

export function yawQuaternion(yaw) {
  const half = (Number(yaw) || 0) / 2;
  return [0, Number(Math.sin(half).toFixed(6)), 0, Number(Math.cos(half).toFixed(6))];
}

export function portalIdForLocation(locationId) {
  return locationId ? `${locationId}-portal` : null;
}

export function fabricPortalKey(portal) {
  if (!portal) return null;
  if (typeof portal.string_portal_id === "string" && portal.string_portal_id) {
    return portal.string_portal_id;
  }
  return portal.portal_id != null ? String(portal.portal_id) : null;
}

export function mappedExitOffsetForApproach(approachSignedDistanceM, targetFrame = null) {
  const approach = Math.abs(Number(approachSignedDistanceM));
  const triggerDepth = Math.max(
    0.001,
    Number(targetFrame && targetFrame.trigger_depth_m) || PORTAL_TRIGGER_DEPTH_M,
  );
  const minimum = triggerDepth + PORTAL_EXIT_CLEARANCE_M;
  const declaredMaximum = Number(targetFrame && targetFrame.exit_offset_m);
  const maximum = Math.max(
    minimum,
    Number.isFinite(declaredMaximum) ? declaredMaximum : PORTAL_EXIT_OFFSET_MAX_M,
  );
  if (!Number.isFinite(approach)) return minimum;
  return clamp(
    approach + PORTAL_EXIT_CLEARANCE_M,
    minimum,
    maximum,
  );
}

export function portalFrameForLocation({
  portalId,
  locationId,
  triggerPosition,
  triggerRadius,
  targetLocationId,
}) {
  const preset = PORTAL_FRAME_PRESETS[locationId] || {};
  const forward = normalizeVec3(preset.forward || [0, 0, 1], [0, 0, 1]);
  const baseUp = normalizeVec3(preset.up || [0, 1, 0], [0, 1, 0]);
  const right = normalizeVec3(preset.right || cross3(baseUp, forward), [1, 0, 0]);
  const up = normalizeVec3(cross3(forward, right), baseUp);
  const ground = clonePosition(triggerPosition, [2.8, 0, -2.8]);
  const width = Number(preset.width_m || PORTAL_FRAME_WIDTH_M);
  const height = Number(preset.height_m || PORTAL_FRAME_HEIGHT_M);
  const triggerDepth = Number(preset.trigger_depth_m || PORTAL_TRIGGER_DEPTH_M);
  const exitOffset = Math.max(
    triggerDepth + 0.45,
    Number(preset.exit_offset_m || PORTAL_EXIT_OFFSET_M),
  );
  const frame = {
    portal_id: portalId || portalIdForLocation(locationId),
    location_id: locationId,
    position: roundVec3([ground[0], PORTAL_FRAME_CENTER_Y, ground[2]], 4),
    ground_center: roundVec3([ground[0], 0, ground[2]], 4),
    forward: roundVec3(forward, 6),
    up: roundVec3(up, 6),
    right: roundVec3(right, 6),
    width_m: width,
    height_m: height,
    trigger_depth_m: triggerDepth,
    exit_offset_m: exitOffset,
    legacy_trigger_radius_m: Number(triggerRadius) || null,
    linked_target_location_id: targetLocationId || null,
    linked_target_portal_id: portalIdForLocation(targetLocationId),
  };
  frame.yaw_radians = roundNumber(yawFromVector(frame.forward, 0), 6);
  return frame;
}

export function buildPortalFrameSet({
  portalId,
  locationId,
  triggerPosition,
  triggerRadius,
  targetLocationId,
  targetWorldId,
  targetBaseUrl,
}) {
  const activeFrame = portalFrameForLocation({
    portalId,
    locationId,
    triggerPosition,
    triggerRadius,
    targetLocationId,
  });
  const targetFrame = portalFrameForLocation({
    portalId: portalIdForLocation(targetLocationId),
    locationId: targetLocationId,
    triggerPosition,
    triggerRadius,
    targetLocationId: locationId,
  });
  return {
    active_frame: {
      ...activeFrame,
      target_world_id: targetWorldId || null,
      target_base_url: targetBaseUrl || null,
    },
    target_frame: {
      ...targetFrame,
      target_world_id: null,
      target_base_url: null,
      linked_target_portal_id: activeFrame.portal_id,
      pose_source: "source_trigger_placeholder",
    },
  };
}

export function portalSamplePosition(position) {
  const p = clonePosition(position, [0, 0, 0]);
  return [p[0], p[1] + PORTAL_AVATAR_SAMPLE_Y, p[2]];
}

export function portalLocalCoordinates(frame, position) {
  if (!frame) return null;
  const sample = portalSamplePosition(position);
  const origin = clonePosition(frame.position, [0, PORTAL_FRAME_CENTER_Y, 0]);
  const rel = subtract3(sample, origin);
  const local = {
    x: dot3(rel, frame.right),
    y: dot3(rel, frame.up),
    z: dot3(rel, frame.forward),
  };
  const halfWidth = Math.max(
    0.001,
    Number(frame.width_m || PORTAL_FRAME_WIDTH_M) / 2,
  );
  const halfHeight = Math.max(
    0.001,
    Number(frame.height_m || PORTAL_FRAME_HEIGHT_M) / 2,
  );
  const ovalValue = (local.x / halfWidth) ** 2 + (local.y / halfHeight) ** 2;
  const triggerDepth = Math.max(
    0.001,
    Number(frame.trigger_depth_m || PORTAL_TRIGGER_DEPTH_M),
  );
  return {
    sample_position: roundVec3(sample),
    x: roundNumber(local.x),
    y: roundNumber(local.y),
    z: roundNumber(local.z),
    signed_plane_distance_m: roundNumber(local.z),
    plane_distance_abs_m: roundNumber(Math.abs(local.z)),
    oval_value: roundNumber(ovalValue, 4),
    inside_oval_aperture: ovalValue <= 1,
    inside_trigger_volume: ovalValue <= 1 && local.z >= -0.08 && local.z <= triggerDepth,
    side: local.z > 0.08 ? "front" : local.z < -0.08 ? "back" : "plane",
  };
}

export function portalCrossingDirection(previousZ, currentZ) {
  if (!Number.isFinite(Number(previousZ)) || !Number.isFinite(Number(currentZ))) {
    return "unknown";
  }
  const prev = Number(previousZ);
  const current = Number(currentZ);
  if (
    prev > PORTAL_TRIGGER_DEPTH_M &&
    current <= PORTAL_TRIGGER_DEPTH_M &&
    current >= -0.08
  ) return "front_to_plane";
  if (prev > 0.08 && current < -0.08) return "front_to_back";
  if (prev < -0.08 && current >= -0.08) return "back_to_plane";
  if (current < prev - 0.02) return "approaching_plane";
  if (current > prev + 0.02) return "leaving_plane";
  return "steady";
}

export function normalizePortalTraversal(raw) {
  const source =
    typeof raw === "string" ? { mode: raw } : raw && typeof raw === "object" ? raw : {};
  const mode = source.mode === "one_way" ? "one_way" : "bidirectional";
  const allowed =
    mode === "one_way"
      ? source.allowed_entry_side === "back" ? "back" : "front"
      : "both";
  return {
    mode,
    allowed_entry_side: allowed,
    blocked_entry_side: mode === "one_way" ? allowed === "front" ? "back" : "front" : null,
    side_reference: "portal_frame_forward",
    validation:
      source.validation && typeof source.validation === "object"
        ? source.validation
        : { traversal_direction_standard_conformance: false, application_level: true },
  };
}

export function portalEntrySideAllowed(traversal, entrySide) {
  if (!traversal || traversal.mode !== "one_way") return true;
  return traversal.allowed_entry_side === entrySide;
}

/** Proper 180-degree rotation about portal-local up. */
export function properPortalLocalRotation(local) {
  return {
    x: -(Number(local && local.x) || 0),
    y: Number(local && local.y) || 0,
    z: -(Number(local && local.z) || 0),
  };
}

export function vectorFromFrameLocal(frame, local) {
  return [
    frame.right[0] * local.x + frame.up[0] * local.y + frame.forward[0] * local.z,
    frame.right[1] * local.x + frame.up[1] * local.y + frame.forward[1] * local.z,
    frame.right[2] * local.x + frame.up[2] * local.y + frame.forward[2] * local.z,
  ];
}

export function positionFromFrameLocal(frame, local) {
  const origin = clonePosition(frame && frame.position, [0, PORTAL_FRAME_CENTER_Y, 0]);
  return addScaled3(
    addScaled3(
      addScaled3(origin, frame.right, Number(local && local.x) || 0),
      frame.up,
      Number(local && local.y) || 0,
    ),
    frame.forward,
    Number(local && local.z) || 0,
  );
}

export function mapTransformBetweenPortalFrames({
  sourceFrame,
  targetFrame,
  entryTransform,
  entryLocal,
}) {
  if (!sourceFrame || !targetFrame || !entryTransform) return null;
  const local = entryLocal || portalLocalCoordinates(sourceFrame, entryTransform.position);
  const halfWidth = Math.max(
    0.001,
    Number(targetFrame.width_m || PORTAL_FRAME_WIDTH_M) / 2,
  );
  const localX = clamp(
    Number(local && local.x) || 0,
    -halfWidth + 0.08,
    halfWidth - 0.08,
  );
  const mappedLocal = properPortalLocalRotation({ x: localX, y: 0, z: 0 });
  const targetGround = clonePosition(
    targetFrame.ground_center,
    [targetFrame.position[0], 0, targetFrame.position[2]],
  );
  const approachSignedDistanceM = local ? local.signed_plane_distance_m : null;
  const exitOffset = mappedExitOffsetForApproach(approachSignedDistanceM, targetFrame);
  const triggerDepth = Math.max(
    0.001,
    Number(targetFrame.trigger_depth_m) || PORTAL_TRIGGER_DEPTH_M,
  );
  const minimumExitOffset = triggerDepth + PORTAL_EXIT_CLEARANCE_M;
  const maximumExitOffset = Math.max(
    minimumExitOffset,
    Number(targetFrame.exit_offset_m) || PORTAL_EXIT_OFFSET_MAX_M,
  );
  const lateralPosition = addScaled3(targetGround, targetFrame.right, mappedLocal.x);
  const exitPosition = addScaled3(lateralPosition, targetFrame.forward, exitOffset);
  exitPosition[1] = 0;

  const yawVector = vectorFromYaw(entryTransform.rotation_y);
  const localYaw = properPortalLocalRotation({
    x: dot3(yawVector, sourceFrame.right),
    y: 0,
    z: dot3(yawVector, sourceFrame.forward),
  });
  const mappedDirection = vectorFromFrameLocal(targetFrame, localYaw);
  mappedDirection[1] = 0;
  const exitYaw = yawFromVector(
    mappedDirection,
    yawFromVector(targetFrame.forward, 0),
  );
  const mappedExitTransform = {
    position: roundVec3(exitPosition, 4),
    rotation_y: roundNumber(exitYaw, 6),
    orientation: yawQuaternion(exitYaw),
    scale: cloneScale(entryTransform.scale),
  };
  return {
    source_portal_frame: sourceFrame,
    target_portal_frame: targetFrame,
    entry_local_coordinates: local,
    lateral_offset_m: roundNumber(localX),
    mapped_lateral_offset_m: roundNumber(mappedLocal.x),
    exit_offset_m: roundNumber(exitOffset),
    landing_policy: {
      source: "traversed_edge_target_frame",
      entry_plane_sample_m: Number.isFinite(Number(approachSignedDistanceM))
        ? roundNumber(Math.abs(Number(approachSignedDistanceM)))
        : null,
      trigger_depth_m: roundNumber(triggerDepth),
      actor_clearance_m: PORTAL_EXIT_CLEARANCE_M,
      minimum_standoff_m: roundNumber(minimumExitOffset),
      maximum_standoff_m: roundNumber(maximumExitOffset),
      standoff_m: roundNumber(exitOffset),
      outside_trigger_rearm_zone: exitOffset > triggerDepth,
      rule:
        "max(entry-plane sample + actor clearance, target trigger depth + actor clearance), bounded by the traversed target frame exit offset",
    },
    approach_signed_distance_m: Number.isFinite(Number(approachSignedDistanceM))
      ? roundNumber(Math.abs(Number(approachSignedDistanceM)))
      : null,
    mapped_direction: roundVec3(
      normalizeVec3(mappedDirection, targetFrame.forward),
      6,
    ),
    exit_yaw_radians: roundNumber(exitYaw, 6),
    mapped_exit_transform: mappedExitTransform,
    linked_target_portal_id: sourceFrame.linked_target_portal_id,
  };
}

export function cameraForwardFromTransform(cameraTransform) {
  const position = cameraTransform && Array.isArray(cameraTransform.position)
    ? cameraTransform.position
    : null;
  const target = cameraTransform && Array.isArray(cameraTransform.target)
    ? cameraTransform.target
    : null;
  if (position && target) {
    return normalizeVec3(subtract3(target, position), [0, 0, -1]);
  }
  const yaw = Number(cameraTransform && cameraTransform.rotation_y) || 0;
  return vectorFromYaw(yaw);
}

/** Proper crossing/aperture glue: local position and forward both use (-x,y,-z). */
export function glueCameraThroughFrames(sourceFrame, targetFrame, camPos, camFwd) {
  if (!sourceFrame || !targetFrame) return null;
  const sourcePosition = clonePosition(
    sourceFrame.position,
    [0, PORTAL_FRAME_CENTER_Y, 0],
  );
  const relative = subtract3(camPos, sourcePosition);
  const local = {
    x: dot3(relative, sourceFrame.right),
    y: dot3(relative, sourceFrame.up),
    z: dot3(relative, sourceFrame.forward),
  };
  const localForward = {
    x: dot3(camFwd, sourceFrame.right),
    y: dot3(camFwd, sourceFrame.up),
    z: dot3(camFwd, sourceFrame.forward),
  };
  const mappedPositionLocal = properPortalLocalRotation(local);
  const mappedForwardLocal = properPortalLocalRotation(localForward);
  const position = positionFromFrameLocal(targetFrame, mappedPositionLocal);
  const forward = normalizeVec3(
    vectorFromFrameLocal(targetFrame, mappedForwardLocal),
    targetFrame.forward,
  );
  return { position, forward, source_local: local };
}

/**
 * Legacy preview projection compatibility contract.
 * Position stays (x,y,z); only camera-forward z is inverted.
 */
export function mapCameraBetweenPortalFrames({
  sourceFrame,
  targetFrame,
  cameraTransform,
}) {
  const position = cameraTransform && Array.isArray(cameraTransform.position)
    ? cameraTransform.position
    : null;
  if (!sourceFrame || !targetFrame || !position) {
    return {
      source_camera_relative_to_portal: {},
      target_preview_camera_transform: {},
      preview_projection_transform: {},
    };
  }
  const relative = subtract3(
    position,
    clonePosition(sourceFrame.position, [0, PORTAL_FRAME_CENTER_Y, 0]),
  );
  const localPosition = {
    x: roundNumber(dot3(relative, sourceFrame.right), 4),
    y: roundNumber(dot3(relative, sourceFrame.up), 4),
    z: roundNumber(dot3(relative, sourceFrame.forward), 4),
  };
  const sourceForward = cameraForwardFromTransform(cameraTransform);
  const localForward = {
    x: roundNumber(dot3(sourceForward, sourceFrame.right), 6),
    y: roundNumber(dot3(sourceForward, sourceFrame.up), 6),
    z: roundNumber(dot3(sourceForward, sourceFrame.forward), 6),
  };
  const mappedForward = normalizeVec3(
    vectorFromFrameLocal(targetFrame, {
      x: localForward.x,
      y: localForward.y,
      z: -localForward.z,
    }),
    targetFrame.forward,
  );
  const targetPosition = positionFromFrameLocal(targetFrame, localPosition);
  const targetLookAt = addScaled3(targetPosition, mappedForward, 2.5);
  const targetYaw = yawFromVector(
    mappedForward,
    yawFromVector(targetFrame.forward, 0),
  );
  const sourceRelative = {
    frame_id: sourceFrame.portal_id ? `${sourceFrame.portal_id}-frame` : null,
    portal_id: sourceFrame.portal_id || null,
    location_id: sourceFrame.location_id || null,
    local_position: localPosition,
    local_forward: localForward,
    world_position: roundVec3(position, 4),
    world_target: Array.isArray(cameraTransform.target)
      ? roundVec3(cameraTransform.target, 4)
      : null,
    orientation: Array.isArray(cameraTransform.orientation)
      ? cameraTransform.orientation.slice(0, 4)
      : null,
  };
  const targetTransform = {
    frame_id: targetFrame.portal_id ? `${targetFrame.portal_id}-frame` : null,
    portal_id: targetFrame.portal_id || null,
    location_id: targetFrame.location_id || null,
    position: roundVec3(targetPosition, 4),
    target: roundVec3(targetLookAt, 4),
    forward: roundVec3(mappedForward, 6),
    rotation_y: roundNumber(targetYaw, 6),
    orientation: yawQuaternion(targetYaw),
  };
  return {
    source_camera_relative_to_portal: sourceRelative,
    target_preview_camera_transform: targetTransform,
    preview_projection_transform: {
      projection_frame_source: "source_portal_frame+target_portal_frame",
      source_portal_id: sourceFrame.portal_id || null,
      target_portal_id: targetFrame.portal_id || null,
      source_local_position: localPosition,
      source_local_forward: localForward,
      target_camera_position: targetTransform.position,
      target_camera_forward: targetTransform.forward,
      target_camera_rotation_y: targetTransform.rotation_y,
      camera_forward_z_mapping:
        "source local forward z is inverted into target frame for aperture view",
    },
  };
}

/** Proper avatar-relative real-camera continuity through a crossing. */
export function mapCameraAcrossCrossing({
  sourceFrame,
  targetFrame,
  cameraTransform,
  avatarEntryPosition,
  avatarEntryYaw,
  avatarExitPosition,
  avatarExitYaw,
  lookTargetHeightM = 1.35,
}) {
  const camPos = cameraTransform && Array.isArray(cameraTransform.position)
    ? cameraTransform.position
    : null;
  if (
    !sourceFrame ||
    !targetFrame ||
    !camPos ||
    !Array.isArray(avatarEntryPosition) ||
    !Array.isArray(avatarExitPosition)
  ) return null;

  const offset = subtract3(camPos, avatarEntryPosition);
  const localOffset = {
    x: dot3(offset, sourceFrame.right),
    y: dot3(offset, sourceFrame.up),
    z: dot3(offset, sourceFrame.forward),
  };
  const mappedOffset = vectorFromFrameLocal(
    targetFrame,
    properPortalLocalRotation(localOffset),
  );
  const position = [
    avatarExitPosition[0] + mappedOffset[0],
    (Number(avatarExitPosition[1]) || 0) +
      mappedOffset[1] +
      (Number(avatarEntryPosition[1]) || 0),
    avatarExitPosition[2] + mappedOffset[2],
  ];
  const sourceForward = cameraForwardFromTransform(cameraTransform);
  const localForward = {
    x: dot3(sourceForward, sourceFrame.right),
    y: dot3(sourceForward, sourceFrame.up),
    z: dot3(sourceForward, sourceFrame.forward),
  };
  const forward = normalizeVec3(
    vectorFromFrameLocal(
      targetFrame,
      properPortalLocalRotation(localForward),
    ),
    targetFrame.forward,
  );
  const focus = [
    Number(avatarExitPosition[0]) || 0,
    (Number(avatarExitPosition[1]) || 0) + lookTargetHeightM,
    Number(avatarExitPosition[2]) || 0,
  ];
  const behindDot = (yaw, avatarPosition, cameraPosition) => {
    const facing = vectorFromYaw(yaw);
    const toCamera = normalizeVec3(
      [
        cameraPosition[0] - avatarPosition[0],
        0,
        cameraPosition[2] - avatarPosition[2],
      ],
      [0, 0, 1],
    );
    return roundNumber(
      facing[0] * toCamera[0] + facing[2] * toCamera[2],
      4,
    );
  };
  return {
    method:
      "avatar-relative rigid remap through source->target portal frames (180deg rotation about up: lateral+forward negated, runtime) — Demo-A mapCrossing recipe",
    position: roundVec3(position, 4),
    focus: roundVec3(focus, 4),
    forward: roundVec3(forward, 6),
    camera_offset_local: {
      x: roundNumber(localOffset.x, 4),
      y: roundNumber(localOffset.y, 4),
      z: roundNumber(localOffset.z, 4),
    },
    behind_dot_before: Number.isFinite(Number(avatarEntryYaw))
      ? behindDot(avatarEntryYaw, avatarEntryPosition, camPos)
      : null,
    behind_dot_after: Number.isFinite(Number(avatarExitYaw))
      ? behindDot(avatarExitYaw, avatarExitPosition, position)
      : null,
  };
}
