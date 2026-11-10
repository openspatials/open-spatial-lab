import { clonePosition, fabricPortalKey, portalFrameForLocation } from "./live-adapter-portal-geometry.mjs";

export function adoptHostedPortalPose(world, triggerPosition) {
  const portal = world && world.portal;
  if (!portal || !Array.isArray(triggerPosition)) return { changed: false, frame: portal ? portal.frame : null };
  const current = clonePosition(portal.trigger && portal.trigger.position, [2.8, 0, -2.8]);
  const next = clonePosition(triggerPosition, current);
  next[1] = 0;
  if (Math.abs(next[0] - current[0]) < 1e-4 && Math.abs(next[2] - current[2]) < 1e-4) {
    return { changed: false, frame: portal.frame };
  }
  const radius = Number(portal.trigger && portal.trigger.radius_m) || 1.25;
  portal.trigger = { position: next, radius_m: radius };
  const rebuilt = portalFrameForLocation({
    portalId: portal.portal_id,
    locationId: world.location_id,
    triggerPosition: next,
    triggerRadius: radius,
    targetLocationId: portal.target_location_id,
    forward: portal.frame ? portal.frame.forward : undefined,
  });
  portal.frame = {
    ...rebuilt,
    target_world_id: portal.target_world_id || null,
    target_base_url: portal.target_base_url || null,
  };
  return { changed: true, frame: portal.frame };
}

export function adoptHostedTargetPortalPose(world, triggerPosition) {
  const portal = world && world.portal;
  if (!portal || !portal.target_frame || !Array.isArray(triggerPosition)) {
    return { changed: false, frame: portal ? portal.target_frame : null };
  }
  const current = clonePosition(portal.target_frame.ground_center, [2.8, 0, -2.8]);
  const next = clonePosition(triggerPosition, current);
  next[1] = 0;
  if (Math.abs(next[0] - current[0]) < 1e-4 && Math.abs(next[2] - current[2]) < 1e-4) {
    return { changed: false, frame: portal.target_frame };
  }
  const rebuilt = portalFrameForLocation({
    portalId: portal.target_frame.portal_id,
    locationId: portal.target_location_id,
    triggerPosition: next,
    triggerRadius: Number(portal.trigger && portal.trigger.radius_m) || 1.25,
    targetLocationId: world.location_id,
    forward: portal.target_frame.forward,
  });
  portal.target_frame = {
    ...rebuilt,
    target_world_id: null,
    target_base_url: null,
    linked_target_portal_id: portal.frame ? portal.frame.portal_id : rebuilt.linked_target_portal_id,
    pose_source: "hosted_point_reload",
  };
  return { changed: true, frame: portal.target_frame };
}

export function adoptDestinationPortalPose(world, machine, portalPose, onLog) {
  if (
    !machine ||
    !machine.portal_key ||
    !portalPose ||
    !Array.isArray(portalPose.trigger_position) ||
    !world
  ) {
    return { changed: false, frame: null };
  }
  const entries =
    Array.isArray(world.portals) && world.portals.length
      ? world.portals
      : world.portal
        ? [world.portal]
        : [];
  const entry = entries.find((p) => fabricPortalKey(p) === machine.portal_key) || null;
  if (!entry || !entry.target_frame) return { changed: false, frame: null };
  if (entry.wow_resource) return { changed: false, frame: entry.target_frame };
  const next = clonePosition(portalPose.trigger_position, null);
  if (!next) return { changed: false, frame: entry.target_frame };
  next[1] = 0;
  const tf = entry.target_frame;
  const current = clonePosition(
    tf.ground_center,
    Array.isArray(tf.position) ? [tf.position[0], 0, tf.position[2]] : [0, 0, 0]
  );
  const alreadyAdopted = tf.pose_source === "destination_region_portal_pose";
  if (
    alreadyAdopted &&
    Math.abs(next[0] - current[0]) < 1e-4 &&
    Math.abs(next[2] - current[2]) < 1e-4
  ) {
    return { changed: false, frame: tf };
  }
  entry.target_frame = destinationPortalFrame(world, entry, portalPose, next);
  const moved = Math.hypot(next[0] - current[0], next[2] - current[2]);
  onLog(
    `fabric region: destination portal pose adopted for ${machine.portal_key} -> ` +
      `[${next[0]}, 0, ${next[2]}]${moved > 1e-4 ? ` (placeholder was ${moved.toFixed(2)} m off)` : " (placeholder already matched)"}`
  );
  return { changed: true, frame: entry.target_frame };
}

function destinationPortalFrame(world, entry, portalPose, next) {
  const tf = entry.target_frame;
  const rebuilt = portalFrameForLocation({
    portalId: tf.portal_id,
    locationId: entry.target_location_id,
    triggerPosition: next,
    triggerRadius:
      Number(portalPose.trigger_radius_m) ||
      Number(entry.trigger && entry.trigger.radius_m) ||
      1.25,
    targetLocationId: world.location_id,
    forward: Array.isArray(portalPose.forward) ? portalPose.forward : tf.forward,
  });
  return {
    ...rebuilt,
    target_world_id: null,
    target_base_url: null,
    linked_target_portal_id: entry.frame ? entry.frame.portal_id : rebuilt.linked_target_portal_id,
    pose_source: "destination_region_portal_pose",
    pose_adopted_at: new Date().toISOString(),
  };
}

