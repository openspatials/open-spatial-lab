import {
  clamp,
  crossingYawDeltaRad,
  mapCameraAcrossCrossing,
  normalizeYawRad,
  subtract3,
} from "./live-adapter-portal-geometry.mjs";

function cameraValidationRecord(detail) {
  return {
    kind: detail && detail.kind ? detail.kind : null,
    applied: false,
    changed: false,
    synthesized: false,
    validated: false,
    reason: null,
    crossing_yaw_delta_rad: null,
    source_portal_id: null,
    target_portal_id: null,
    pre_reframe_forward_yaw_rad: null,
    reframed_forward_yaw_rad: null,
    position_correction_m: null,
    focus_correction_m: null,
    forward_correction_deg: null,
    movement_basis_correction_deg: null,
    identity_match: false,
  };
}

function crossingInputReason(record, detail, frameMapping, entryTransform) {
  if (!detail || detail.kind !== "world_navigator_composition_crossing") {
    return "not_a_composition_crossing";
  }
  const sourceFrame = frameMapping ? frameMapping.source_portal_frame : null;
  const targetFrame = frameMapping ? frameMapping.target_portal_frame : null;
  const deltaYaw = crossingYawDeltaRad(sourceFrame, targetFrame);
  if (deltaYaw === null) return "traversed_edge_frames_unavailable";
  record.crossing_yaw_delta_rad = Number(deltaYaw.toFixed(6));
  record.source_portal_id = sourceFrame.portal_id || null;
  record.target_portal_id = targetFrame.portal_id || null;
  const heading = detail.heading_continuity;
  if (!heading || heading.source_portal_id !== record.source_portal_id ||
      heading.target_portal_id !== record.target_portal_id) {
    return "source_heading_continuity_unavailable";
  }
  if (!entryTransform || !Array.isArray(entryTransform.position) ||
      !detail.exit_pose || !Array.isArray(detail.exit_pose.position)) {
    return "entry_or_exit_pose_unavailable";
  }
  return null;
}

function forwardYaw(forward) {
  return Number(Math.atan2(Number(forward[0]) || 0, Number(forward[2]) || 0).toFixed(6));
}

function positionErrorMeters(actual, expected) {
  return Number(Math.hypot(...subtract3(actual, expected)).toFixed(6));
}

function vectorErrorDegrees(actual, expected) {
  const actualLength = Math.max(1e-9, Math.hypot(...actual.slice(0, 3).map(Number)));
  const expectedLength = Math.max(1e-9, Math.hypot(...expected.slice(0, 3).map(Number)));
  // Keep non-finite diagnostic values; geometry's normalized-vector fallback would hide them.
  const dot = actual.slice(0, 3).reduce(
    (sum, value, index) => sum + Number(value) * Number(expected[index]), 0,
  ) / (actualLength * expectedLength);
  return Number((Math.acos(clamp(dot, -1, 1)) * 180 / Math.PI).toFixed(6));
}

function cameraMappingErrors(record, mapping, remapped) {
  record.reframed_forward_yaw_rad = forwardYaw(remapped.forward);
  if (!mapping || !Array.isArray(mapping.position) || !Array.isArray(mapping.focus) ||
      !Array.isArray(mapping.forward) || !Array.isArray(mapping.movement_basis_forward)) {
    return "source_camera_mapping_unavailable";
  }
  record.pre_reframe_forward_yaw_rad = forwardYaw(mapping.forward);
  record.position_correction_m = positionErrorMeters(mapping.position, remapped.position);
  record.focus_correction_m = positionErrorMeters(mapping.focus, remapped.focus);
  record.forward_correction_deg = vectorErrorDegrees(mapping.forward, remapped.forward);
  record.movement_basis_correction_deg = vectorErrorDegrees(mapping.movement_basis_forward, remapped.forward);
  record.identity_match =
    mapping.frame_source === "packet.avatar_context.portal_frame_transform" &&
    mapping.source_portal_id === record.source_portal_id &&
    mapping.target_portal_id === record.target_portal_id;
  return null;
}

function cameraMappingMatches(record, heading) {
  record.changed =
    !record.identity_match ||
    record.position_correction_m > 0.05 ||
    record.focus_correction_m > 0.05 ||
    record.forward_correction_deg > 1 ||
    record.movement_basis_correction_deg > 1 ||
    Math.abs(normalizeYawRad(
      Number(heading.crossing_yaw_delta_rad) - Number(record.crossing_yaw_delta_rad),
    )) > Math.PI / 180;
  record.validated = !record.changed;
  record.reason = record.changed ? "source_mapping_mismatch" : "source_mapping_validated";
}

// The traversed edge owns the mapping. Recompute only to validate it, never to replace it.
export function validateCrossingCameraMapping({ detail, frameMapping, entryTransform, cameraTransform, lookTargetHeightM }) {
  const record = cameraValidationRecord(detail);
  record.reason = crossingInputReason(record, detail, frameMapping, entryTransform);
  if (record.reason) return record;
  const exitPose = detail.exit_pose;
  const remapped = cameraTransform ? mapCameraAcrossCrossing({
    sourceFrame: frameMapping.source_portal_frame,
    targetFrame: frameMapping.target_portal_frame,
    cameraTransform,
    avatarEntryPosition: entryTransform.position,
    avatarEntryYaw: Number(entryTransform.rotation_y) || 0,
    avatarExitPosition: exitPose.position,
    avatarExitYaw: Number(exitPose.rotation_y) || 0,
    lookTargetHeightM,
  }) : null;
  if (!remapped) {
    record.reason = "no_entry_camera_transform";
    return record;
  }
  record.reason = cameraMappingErrors(record, detail.camera_mapping, remapped);
  if (!record.reason) cameraMappingMatches(record, detail.heading_continuity);
  return record;
}
