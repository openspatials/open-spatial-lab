import { portalLocalCoordinates } from "./live-adapter-portal-geometry.mjs";

function measureExitPose(record, avatar, exitPose, targetFrame) {
  const policy = exitPose.landing_policy || null;
  const local = targetFrame
    ? portalLocalCoordinates(targetFrame, avatar.position)
    : null;
  const correctionM = Math.hypot(
    Number(avatar.position[0]) - Number(exitPose.position[0]),
    Number(avatar.position[1]) - Number(exitPose.position[1]),
    Number(avatar.position[2]) - Number(exitPose.position[2])
  );
  const standoffM = local ? Number(local.signed_plane_distance_m) : NaN;
  const triggerDepthM = Number(policy && policy.trigger_depth_m);
  const actorClearanceM = Number(policy && policy.actor_clearance_m);
  const safeMinimumM = triggerDepthM + actorClearanceM;
  record.parity = {
    supported:
      !!policy && Number.isFinite(standoffM) && Number.isFinite(safeMinimumM),
    entry_standoff_m: policy ? policy.entry_plane_sample_m : null,
    applied_standoff_m: Number.isFinite(standoffM)
      ? Number(standoffM.toFixed(4))
      : null,
    parity_standoff_m: policy ? policy.standoff_m : null,
    delta_m: Number(correctionM.toFixed(4)),
    adjusted_position: avatar.position.slice(0, 3),
    inside_trigger_volume_after:
      Number.isFinite(standoffM) && Number.isFinite(triggerDepthM)
        ? standoffM <= triggerDepthM
        : null,
    landing_policy: policy,
  };
  if (!record.parity.supported) {
    record.guard_failure =
      "portal landing guard: canonical traversed-edge policy unavailable";
  } else if (correctionM > 0.05) {
    record.guard_failure = `portal landing guard: dispatch drift ${correctionM.toFixed(
      4
    )} m exceeds 0.05 m`;
  } else if (standoffM + 1e-6 < safeMinimumM) {
    record.guard_failure =
      `portal landing guard: ${standoffM.toFixed(4)} m is inside the ` +
      `${safeMinimumM.toFixed(4)} m trigger-plus-clearance boundary`;
  }
  record.reason = record.guard_failure
    ? "landing_guard_failed"
    : "canonical_exit_pose_verified";
}

export function inspectExitPose(dbg, detail, expectedPortalEdgeId) {
  if (!dbg || !detail || detail.kind !== "world_navigator_composition_crossing")
    return null;
  const profile = dbg ? dbg.player_handoff_profile : null;
  const portalInfo = profile ? profile.portal : null;
  const targetFrame = portalInfo ? portalInfo.target_portal_frame : null;
  const avatar = dbg ? dbg.avatar : null; // live reference into adapter state
  const exitPose = detail.exit_pose || null;
  const arrivalFallbackUsed = !!(
    exitPose &&
    exitPose.source === "portal_frame_mapping_fallback" &&
    !(
      profile &&
      profile.player_pose_at_crossing &&
      profile.player_pose_at_crossing.mapped_exit_transform
    )
  );
  const fromLocation = detail.from ? detail.from.location_id : null;
  const toLocation = detail.to ? detail.to.location_id : null;
  const record = {
    at: new Date().toISOString(),
    kind: detail.kind,
    handoff_id: detail.handoff_id || null,
    applied: false,
    reason: null,
    source_portal_id: portalInfo ? portalInfo.source_portal_id : null,
    target_portal_id: portalInfo ? portalInfo.target_portal_id : null,
    edge_id: expectedPortalEdgeId(fromLocation, toLocation),
    exit_pose_source: exitPose ? exitPose.source || null : null,
    arrival_fallback_used: arrivalFallbackUsed,
    parity: null,
    camera_mapping_translated: false,
  };
  if (
    !avatar ||
    !Array.isArray(avatar.position) ||
    !exitPose ||
    !Array.isArray(exitPose.position)
  ) {
    record.reason = "avatar_or_exit_pose_unavailable";
  } else {
    measureExitPose(record, avatar, exitPose, targetFrame);
  }
  return record;
}

export function inspectCrossingHeading(
  dbg,
  detail,
  reframeCrossingCameraMapping
) {
  if (!dbg || !detail || detail.kind !== "world_navigator_composition_crossing")
    return null;
  const profile = dbg ? dbg.player_handoff_profile : null;
  const profileMatches =
    profile &&
    (!detail.handoff_id ||
      !profile.handoff_id ||
      profile.handoff_id === detail.handoff_id);
  const portalInfo = profileMatches ? profile.portal : null;
  const frameMapping =
    portalInfo &&
    portalInfo.source_portal_frame &&
    portalInfo.target_portal_frame
      ? {
          source_portal_frame: portalInfo.source_portal_frame,
          target_portal_frame: portalInfo.target_portal_frame,
        }
      : null;
  const pose = profileMatches ? profile.player_pose_at_crossing : null;
  const sourceMapping = detail.camera_mapping || null;
  const record = reframeCrossingCameraMapping({
    detail,
    frameMapping,
    entryTransform:
      (sourceMapping && sourceMapping.source_avatar_entry_transform) ||
      (pose ? pose.portal_entry_transform : null),
    cameraTransform:
      (sourceMapping && sourceMapping.source_camera_transform) ||
      (profileMatches && profile.camera
        ? profile.camera.camera_transform
        : null),
  });
  const lastCrossingHeadingContinuity = {
    at: new Date().toISOString(),
    handoff_id: detail.handoff_id || null,
    profile_matched: profileMatches === true,
    reframe: record,
    heading_continuity: detail.heading_continuity || null,
    applied_remap: null, // filled in by handleAdapterCrossing after the seed
    basis_yaw_after: null,
    camera_yaw_after: null,
  };
  if (!record || !record.validated || record.changed) {
    lastCrossingHeadingContinuity.guard_failure =
      `crossing heading guard: ${
        record ? record.reason : "validation unavailable"
      } ` +
      `for ${
        record && record.source_portal_id ? record.source_portal_id : "?"
      } -> ` +
      `${record && record.target_portal_id ? record.target_portal_id : "?"}`;
  }
  return lastCrossingHeadingContinuity;
}

export function publishExitPose(body, record, logLine) {
  if (!record) return;
  body.setAttribute("data-exit-parity-applied", String(record.applied));
  body.setAttribute(
    "data-exit-parity-entry-m",
    record.parity && Number.isFinite(record.parity.entry_standoff_m)
      ? String(record.parity.entry_standoff_m)
      : ""
  );
  body.setAttribute(
    "data-exit-parity-exit-m",
    record.parity && Number.isFinite(record.parity.parity_standoff_m)
      ? String(
          record.applied
            ? record.parity.parity_standoff_m
            : record.parity.applied_standoff_m
        )
      : ""
  );
  body.setAttribute(
    "data-exit-parity-delta-m",
    record.parity && Number.isFinite(record.parity.delta_m)
      ? String(record.parity.delta_m)
      : ""
  );
  body.setAttribute("data-exit-pose-source", record.exit_pose_source || "");
  body.setAttribute(
    "data-exit-arrival-fallback-used",
    String(record.arrival_fallback_used)
  );
  body.setAttribute("data-crossing-edge-id", record.edge_id || "");
  if (record.arrival_fallback_used) {
    logLine(
      "exit parity: WARNING — crossing landed on the per-world arrival fallback (retired path)"
    );
  }
}
