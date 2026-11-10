import { fabricNodeId, fabricNodePosition, findFabricPortalAttachmentNode, findFabricPortalAttachmentNodes } from "./live-adapter-world-discovery.mjs";
import { PORTAL_EXIT_OFFSET_MIN_M, PORTAL_EXIT_OFFSET_MAX_M, addScaled3, clamp, clonePosition, normalizeVec3, roundNumber, roundVec3, yawFromVector } from "./live-adapter-portal-geometry.mjs";

export function deriveFabricExitPose(frameMapping, { root, world, resolveGround }) {
  const mapped =
    frameMapping && frameMapping.mapped_exit_transform ? frameMapping.mapped_exit_transform : null;
  if (mapped && Array.isArray(mapped.position)) {
    return counterpartExitPose(frameMapping, mapped, { root, world, resolveGround });
  }
  const portalBack = root ? findFabricPortalAttachmentNode(root) : null;
  const cam =
    root && root.primary && root.primary.camera && Array.isArray(root.primary.camera.position)
      ? root.primary.camera.position
      : null;
  if (!portalBack || !cam) {
    return fallbackExitPose(mapped, world, resolveGround);
  }
  const anchor = fabricNodePosition(portalBack);
  const dir = normalizeVec3([Number(cam[0]) - anchor[0], 0, Number(cam[2]) - anchor[2]], [0, 0, 1]);
  const right = [dir[2], 0, -dir[0]];
  const exitOffset =
    frameMapping && Number.isFinite(Number(frameMapping.exit_offset_m))
      ? clamp(Number(frameMapping.exit_offset_m), PORTAL_EXIT_OFFSET_MIN_M, PORTAL_EXIT_OFFSET_MAX_M)
      : PORTAL_EXIT_OFFSET_MIN_M;
  const lateral =
    frameMapping && Number.isFinite(Number(frameMapping.mapped_lateral_offset_m))
      ? Number(frameMapping.mapped_lateral_offset_m)
      : frameMapping && Number.isFinite(Number(frameMapping.lateral_offset_m))
        ? -Number(frameMapping.lateral_offset_m)
        : 0;
  const position = addScaled3(addScaled3([anchor[0], 0, anchor[2]], dir, exitOffset), right, lateral);
  const ground = resolveGround(position[0], position[2]);
  if (!ground.ok) {
    throw new Error(`portal exit has no classified destination ground: ${ground.reason}`);
  }
  position[1] = ground.surface_y_m;
  const rounded = roundVec3(position, 4);
  const rotation =
    mapped && Number.isFinite(Number(mapped.rotation_y))
      ? Number(mapped.rotation_y)
      : yawFromVector(dir, 0);
  return fabricExitRecord({ portalBack, anchor, cam, dir, exitOffset, lateral, rounded, rotation, mapped });
}

function fallbackExitPose(mapped, world, resolveGround) {
    const fallbackPosition = mapped
      ? clonePosition(mapped.position, world ? world.arrival.position : [0, 0, 3.6])
      : world
        ? world.arrival.position.slice()
        : [0, 0, 3.6];
    const fallbackGround = resolveGround(fallbackPosition[0], fallbackPosition[2]);
    if (!fallbackGround.ok) {
      throw new Error(`portal exit has no classified destination ground: ${fallbackGround.reason}`);
    }
    fallbackPosition[1] = fallbackGround.surface_y_m;
    return {
      source: "portal_frame_mapping_fallback",
      position: fallbackPosition,
      rotation_y: mapped
        ? Number(mapped.rotation_y) || 0
        : world
          ? Number(world.arrival.rotation_y) || 0
          : 0,
      matches_frame_mapping: null,
    };

}

function fabricExitRecord({ portalBack, anchor, cam, dir, exitOffset, lateral, rounded, rotation, mapped }) {
  return {
    source: "promoted_fabric_portal_back_node+primary_camera",
    portal_back_node: { node_id: fabricNodeId(portalBack), position: roundVec3(anchor, 4) },
    primary_camera_position: roundVec3(cam, 4),
    into_world_direction: roundVec3(dir, 6),
    exit_offset_m: roundNumber(exitOffset, 3),
    lateral_offset_m: roundNumber(lateral, 3),
    position: rounded,
    rotation_y: roundNumber(rotation, 6),
    yaw_from_fabric_direction: roundNumber(yawFromVector(dir, 0), 6),
    frame_mapped_exit: mapped
      ? {
          position: roundVec3(mapped.position, 4),
          rotation_y: roundNumber(Number(mapped.rotation_y) || 0, 6),
        }
      : null,
    matches_frame_mapping: mapped
      ? Math.abs(rounded[0] - Number(mapped.position[0] || 0)) <= 0.05 &&
        Math.abs(rounded[2] - Number(mapped.position[2] || 0)) <= 0.05
      : null,
  };
}

export function counterpartExitPose(frameMapping, mapped, { root, world, resolveGround }) {
  const targetFrame =
    frameMapping && frameMapping.target_portal_frame ? frameMapping.target_portal_frame : null;
  const counterpartGround =
    targetFrame && Array.isArray(targetFrame.ground_center)
      ? [Number(targetFrame.ground_center[0]) || 0, 0, Number(targetFrame.ground_center[2]) || 0]
      : targetFrame && Array.isArray(targetFrame.position)
        ? [Number(targetFrame.position[0]) || 0, 0, Number(targetFrame.position[2]) || 0]
        : null;
  const exitPosition = clonePosition(
    mapped.position,
    world ? world.arrival.position : [0, 0, 3.6],
  );
  const ground = resolveGround(exitPosition[0], exitPosition[2]);
  if (!ground.ok) {
    throw new Error(`portal exit has no classified destination ground: ${ground.reason}`);
  }
  exitPosition[1] = ground.surface_y_m;
  const rounded = roundVec3(exitPosition, 4);
  const portalNodes = root ? findFabricPortalAttachmentNodes(root) : [];
  const hostingNode = nearestPortalNode(portalNodes, counterpartGround);
  const exitOffset =
    frameMapping && Number.isFinite(Number(frameMapping.exit_offset_m))
      ? Number(frameMapping.exit_offset_m)
      : null;
  const lateral =
    frameMapping && Number.isFinite(Number(frameMapping.mapped_lateral_offset_m))
      ? Number(frameMapping.mapped_lateral_offset_m)
      : frameMapping && Number.isFinite(Number(frameMapping.lateral_offset_m))
        ? -Number(frameMapping.lateral_offset_m)
        : null;
  return counterpartRecord({ targetFrame, counterpartGround, hostingNode, portalNodes, exitOffset, frameMapping, lateral, rounded, mapped });
}

function nearestPortalNode(portalNodes, counterpartGround) {
  let hostingNode = null;
  if (counterpartGround) {
    for (const node of portalNodes) {
      const p = fabricNodePosition(node);
      const d = Math.hypot(p[0] - counterpartGround[0], p[2] - counterpartGround[2]);
      if (!hostingNode || d < hostingNode.distance_to_counterpart_m) {
        hostingNode = {
          node_id: fabricNodeId(node),
          position: roundVec3(p, 4),
          distance_to_counterpart_m: d,
        };
      }
    }
  }
  return hostingNode;
}

function counterpartRecord({ targetFrame, counterpartGround, hostingNode, portalNodes, exitOffset, frameMapping, lateral, rounded, mapped }) {
  return {
    source: "traversed_edge_counterpart_frame_mapping",
    target_frame_portal_id: targetFrame ? targetFrame.portal_id || null : null,
    target_frame_location_id: targetFrame ? targetFrame.location_id || null : null,
    target_frame_ground_center: counterpartGround ? roundVec3(counterpartGround, 4) : null,
    hosting_fabric_node: hostingNode
      ? {
          node_id: hostingNode.node_id,
          position: hostingNode.position,
          distance_to_counterpart_m: roundNumber(hostingNode.distance_to_counterpart_m, 4),
        }
      : null,
    fabric_portal_node_count: portalNodes.length,
    exit_offset_m: exitOffset === null ? null : roundNumber(exitOffset, 3),
    landing_policy:
      frameMapping && frameMapping.landing_policy
        ? { ...frameMapping.landing_policy }
        : null,
    lateral_offset_m: lateral === null ? null : roundNumber(lateral, 3),
    position: rounded,
    rotation_y: roundNumber(Number(mapped.rotation_y) || 0, 6),
    frame_mapped_exit: {
      position: roundVec3(mapped.position, 4),
      rotation_y: roundNumber(Number(mapped.rotation_y) || 0, 6),
    },
    matches_frame_mapping: true,
  };
}
