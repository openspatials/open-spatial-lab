import { FABRIC_PORTAL_ATTACHMENT_SUBTYPE, fabricNodeId, fabricNodePosition, findFabricPortalAttachmentNode, findFabricPortalAttachmentNodes, findFabricActionTriggerNode, findFabricSpawnNode, resolveFabricReference, fabricSummary, yawFromQuaternionY } from "./live-adapter-world-discovery.mjs";
import { clonePosition, roundNumber, roundVec3, yawFromVector } from "./live-adapter-portal-geometry.mjs";

export function navigatorRecord({ base, marker, promotions }) {
  return {
    subsystem: "world_navigator",
    profile: "omb.world-navigator.local-validation.v0.1",
    claim: "local web validation; plain-JSON unsigned fabrics; no standards-conformance claim",
    context_id: marker ? marker.context_id : null,
    context_marker_id: marker ? marker.marker_id : null,
    single_context: true,
    status: "loading",
    root_fabric: { url: `${base}/fabric.json`, status: "loading" },
    child_fabric: null,
    portal_attachment: null,
    trigger_node: null,
    spawn: { source: "legacy_wow_projection", applied: false },
    fabrics_loaded: [],
    fabrics_loaded_count: 0,
    child_render: { active: false, reason: "renderer_not_attached_yet" },
    promotion_count: promotions.length,
    last_promotion: promotions.length
      ? promotions[promotions.length - 1]
      : null,
  };
}

export function navigatorSpawn(rootFabric) {
  const cam = rootFabric.primary && rootFabric.primary.camera;
  if (cam && Array.isArray(cam.position)) {
    const spawn = [Number(cam.position[0]) || 0, 0, Number(cam.position[2]) || 0];
    const manifestYaw = yawFromQuaternionY(cam.rotation);
    const spawnPortalNodes = findFabricPortalAttachmentNodes(rootFabric);
    const portalPos = spawnPortalNodes.length
      ? spawnPortalNodes
          .map((node) => fabricNodePosition(node))
          .reduce(
            (acc, p, _i, arr) => [
              acc[0] + Number(p[0] || 0) / arr.length,
              acc[1] + Number(p[1] || 0) / arr.length,
              acc[2] + Number(p[2] || 0) / arr.length,
            ],
            [0, 0, 0]
          )
      : null;
    const toPortal = portalPos
      ? [Number(portalPos[0]) - spawn[0], 0, Number(portalPos[2]) - spawn[2]]
      : null;
    const facesPortal = !!(toPortal && Math.hypot(toPortal[0], toPortal[2]) > 1e-6);
    const yaw = facesPortal ? roundNumber(yawFromVector(toPortal, manifestYaw), 6) : manifestYaw;
    return {
      source: "root_fabric_primary_camera",
      applied: true,
      position: spawn,
      rotation_y: yaw,
      rotation_source: facesPortal
        ? "faced_toward_portal_attachment_node"
        : "root_fabric_primary_camera_rotation",
      manifest_rotation_y: manifestYaw,
    };
  }

  return { source: "legacy_wow_projection", applied: false };
}

function projectRootNodes(navigator, rootFabric) {
  const portalNode = findFabricPortalAttachmentNode(rootFabric);
  const triggerNode = findFabricActionTriggerNode(rootFabric);
  const spawnNode = findFabricSpawnNode(rootFabric);
  if (triggerNode) {
    navigator.trigger_node = {
      node_id: fabricNodeId(triggerNode),
      name: triggerNode.Name || null,
      action: triggerNode.Resource ? triggerNode.Resource.sReference : null,
      position: roundVec3(fabricNodePosition(triggerNode), 4),
      bound_max: triggerNode.Bound && Array.isArray(triggerNode.Bound.Max)
        ? triggerNode.Bound.Max.slice(0, 3)
        : null,
    };
  }
  navigator.root_spawn_node = spawnNode
    ? {
        node_id: fabricNodeId(spawnNode),
        name: spawnNode.Name || null,
        position: roundVec3(fabricNodePosition(spawnNode), 4),
      }
    : null;

  return portalNode;
}

function projectPortalAttachment(navigator, portalNode, world) {
  const sReference = portalNode.Resource ? portalNode.Resource.sReference : null;
  const childUrl = resolveFabricReference(sReference);
  const portalNodePosition = roundVec3(fabricNodePosition(portalNode), 4);
  const wowFrameGround = world.portal && world.portal.frame
    ? clonePosition(world.portal.frame.ground_center, [0, 0, 0])
    : null;
  navigator.portal_attachment = {
    node_id: fabricNodeId(portalNode),
    name: portalNode.Name || null,
    bSubtype: FABRIC_PORTAL_ATTACHMENT_SUBTYPE,
    sReference: sReference || null,
    resolved_url: childUrl,
    transform_position: portalNodePosition,
    matches_wow_portal_frame: wowFrameGround
      ? Math.hypot(portalNodePosition[0] - wowFrameGround[0], portalNodePosition[2] - wowFrameGround[2]) <= 0.01
      : null,
  };
}

export function projectWorldNavigator({ base, rootFabric, world, marker, promotions }) {
  const navigator = navigatorRecord({ base, marker, promotions });
  if (!rootFabric) {
    navigator.status = "root_fabric_unavailable";
    navigator.root_fabric = { url: `${base}/fabric.json`, status: "error", fabric_role: "root",
      error: "root fabric manifest unavailable: root fabric manifest unavailable" };
    navigator.child_render = { active: false, reason: "root_fabric_unavailable" };
    return navigator;
  }
  navigator.root_fabric = { ...fabricSummary(`${base}/fabric.json`, rootFabric), fabric_role: "root" };
  navigator.spawn = navigatorSpawn(rootFabric);
  if (navigator.spawn.position) navigator.spawn = { ...navigator.spawn, position: roundVec3(navigator.spawn.position, 4) };
  const portalNode = projectRootNodes(navigator, rootFabric);
  if (!portalNode) {
    navigator.status = "no_portal_attachment_node";
    navigator.child_render = { active: false, reason: "no_portal_attachment_node_in_root_fabric" };
    return navigator;
  }
  projectPortalAttachment(navigator, portalNode, world);
  navigator.status = "root_fabric_loaded_destinations_previewed_by_their_own_data";
  navigator.child_render = { active: false, reason: "destination_shown_by_its_bounded_preview" };
  return navigator;
}

export function endpointPreview(endpoint, sourceEndpoint) {
  const preview = {
    state: "bounded_preview",
    source_type: "wow_bounded_preview",
    preview_source_type: "wow_bounded_preview",
    readonly: true,
    preview_readonly: true,
    endpoint_key: endpoint.endpoint_key || null,
    proxy_base: endpoint.proxy_base || null,
    backend_base_url: endpoint.backend_base_url || null,
    location_id: endpoint.location_id || null,
    preview_target_location_id: endpoint.location_id || null,
    world_id: endpoint.world_id || null,
    preview_target_world_id: endpoint.world_id || null,
    session_id: endpoint.session_id || null,
    target_portal_id: endpoint.portal_id || null,
    preview_target_portal_id: endpoint.portal_id || null,
    linked_source_portal_id: sourceEndpoint.portal_id,
    freshness_ms: 0,
    preview_freshness_ms: 0,
    captured_at: null,
    fallback_reason: null,
    preview_fallback_reason: null,
    projection_frame_source: "source_portal_frame+target_portal_frame",
    target_arrival_count_before_preview: null,
    target_arrival_count_current: null,
    target_state_revision_before_preview: null,
    target_state_revision_current: null,
    target_handoff_context_before_preview: false,
    target_handoff_context_current: false,
    target_debug_last_input_source: null,
    target_avatar_presence_created: false,
    target_mutation_count_during_preview: 0,
    source_camera_relative_to_portal: {},
    target_preview_camera_transform: {},
    preview_projection_transform: {},
  };
  return preview;
}

export function updateNavigatorMarker(navigator, marker) {
  if (!navigator || !marker) return;
  const loaded = [];
  if (navigator.root_fabric && navigator.root_fabric.status === "loaded") {
    loaded.push(navigator.root_fabric.container || navigator.root_fabric.url);
  }
  if (navigator.child_fabric && navigator.child_fabric.status === "loaded") {
    loaded.push(navigator.child_fabric.container || navigator.child_fabric.url);
  }
  navigator.fabrics_loaded = loaded;
  navigator.fabrics_loaded_count = loaded.length;
  marker.fabrics_loaded = loaded.slice();
  marker.fabrics_loaded_count = loaded.length;
  marker.root_fabric_url = navigator.root_fabric ? navigator.root_fabric.url : null;
  marker.child_fabric_url = navigator.child_fabric ? navigator.child_fabric.url : null;
  marker.upgraded_at = new Date().toISOString();
}
