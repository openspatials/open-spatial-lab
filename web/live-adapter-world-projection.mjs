/**
 * Patch 12 — pure live WoW portal/world projection.
 *
 * The module projects plain payloads only. It owns no adapter state, DOM,
 * renderer, transport, timers, or mutable singleton state.
 */

import {
  addScaled3,
  buildPortalFrameSet,
  clonePosition,
  normalizePortalTraversal,
  PORTAL_TRIGGER_DEPTH_M,
} from "./live-adapter-portal-geometry.mjs";
import {
  clientSceneLoadFieldsFromWowPortal,
  recoverAirportLobbyPortalResources,
} from "./airport-lobby-transition.mjs";

export const LIVE_PROVENANCE = "live";

export function portalEntryFromWowPortal(wowPortal, locationId) {
  if (!wowPortal) return null;
  const portalExtension = wowPortal.webofworlds_extension
    ? wowPortal.webofworlds_extension
    : {};
  const destination =
    wowPortal.destination && typeof wowPortal.destination === "object"
      ? wowPortal.destination
      : {};
  const targetLocationId = destination.target_location_id != null
    ? destination.target_location_id
    : portalExtension.target_location_id;
  const targetWorldId = destination.target_world_id != null
    ? destination.target_world_id
    : portalExtension.target_world_id;
  const targetBaseUrl = destination.target_base_url != null
    ? destination.target_base_url
    : portalExtension.target_base_url;
  const sceneLoadFields = clientSceneLoadFieldsFromWowPortal(wowPortal);
  const frameTargetLocationId = targetLocationId || sceneLoadFields.target_fixture?.spatial_id || null;
  const trigger = portalExtension && portalExtension.trigger
    ? portalExtension.trigger
    : { position: [2.8, 0, -2.8], radius_m: 1.25 };
  const triggerPosition = clonePosition(trigger.position, [2.8, 0, -2.8]);
  const triggerRadius = Number(trigger.radius_m) || 1.25;
  const portalFrames = buildPortalFrameSet({
    portalId: wowPortal.id,
    locationId,
    triggerPosition,
    triggerRadius,
    targetLocationId: frameTargetLocationId,
    targetWorldId,
    targetBaseUrl,
  });
  const traversal = normalizePortalTraversal(
    portalExtension.traversal || portalExtension.traversal_mode,
  );
  if (sceneLoadFields.traversal_transition) {
    traversal.transition = sceneLoadFields.traversal_transition;
  }
  return {
    _provenance: LIVE_PROVENANCE,
    portal_id: wowPortal.id,
    string_portal_id:
      portalExtension && typeof portalExtension.portal_id === "string"
        ? portalExtension.portal_id
        : null,
    label: wowPortal.label || null,
    source_location_id: portalExtension.source_location_id,
    source_world_id: portalExtension.source_world_id,
    target_location_id: targetLocationId,
    target_world_id: targetWorldId,
    target_base_url: targetBaseUrl,
    target_fixture: sceneLoadFields.target_fixture,
    reciprocal: sceneLoadFields.reciprocal,
    arrival: portalExtension.arrival || null,
    trigger: { position: triggerPosition, radius_m: triggerRadius },
    frame: portalFrames.active_frame,
    target_frame: portalFrames.target_frame,
    spatial_fabric_address: portalExtension.spatial_fabric_address || null,
    zones: portalExtension.zones || null,
    traversal,
  };
}

export function portalEntryFromWowNode(node, locationId) {
  if (!node || typeof node !== "object") return null;
  const extension =
    node.webofworlds_extension && typeof node.webofworlds_extension === "object"
      ? node.webofworlds_extension
      : {};
  let uriParams = {};
  if (
    typeof node.spatialAssetURI === "string" &&
    node.spatialAssetURI.indexOf("osl-portal:") === 0
  ) {
    try {
      const query = node.spatialAssetURI.slice(node.spatialAssetURI.indexOf("?") + 1);
      for (const pair of query.split("&")) {
        const equals = pair.indexOf("=");
        if (equals > 0) {
          uriParams[pair.slice(0, equals)] = decodeURIComponent(pair.slice(equals + 1));
        }
      }
    } catch (error) {
      /* labeled fallback only; preserve any successfully parsed prior pairs */
    }
  }
  const pick = (primary, fallback) => primary != null && primary !== ""
    ? primary
    : fallback != null && fallback !== "" ? fallback : null;
  const localTransform = Array.isArray(node.localTransform) ? node.localTransform : null;
  const triggerPosition = localTransform && localTransform.length >= 15
    ? [
        Number(localTransform[12]) || 0,
        Number(localTransform[13]) || 0,
        Number(localTransform[14]) || 0,
      ]
    : [2.8, 0, -2.8];
  const targetLocationId = pick(
    extension.target_location_id,
    uriParams.target_location_id,
  );
  const targetWorldId = pick(
    extension.target_world_id || extension.target_spatial_id,
    uriParams.target_world_id,
  );
  const targetBaseUrl = pick(extension.target_base_url, uriParams.target_base_url);
  const triggerRadius = 1.25;
  const portalFrames = buildPortalFrameSet({
    portalId: extension.portal_id || uriParams.target_portal_id || node.label,
    locationId,
    triggerPosition,
    triggerRadius,
    targetLocationId,
    targetWorldId,
    targetBaseUrl,
  });
  return {
    _provenance: LIVE_PROVENANCE,
    portal_id: Number.isInteger(node.id) ? node.id : extension.wow_id || null,
    string_portal_id:
      typeof extension.portal_id === "string" ? extension.portal_id : null,
    label: node.label || null,
    source_location_id:
      extension.source_location_id != null ? extension.source_location_id : locationId,
    source_world_id:
      extension.source_world_id != null ? extension.source_world_id : null,
    target_location_id: targetLocationId,
    target_world_id: targetWorldId,
    target_base_url: targetBaseUrl,
    trigger: { position: triggerPosition, radius_m: triggerRadius },
    frame: portalFrames.active_frame,
    target_frame: portalFrames.target_frame,
    spatial_fabric_address: extension.spatial_fabric_address || null,
    zones: extension.zones || null,
    traversal: normalizePortalTraversal(
      extension.traversal || extension.traversal_mode,
    ),
    reciprocal: extension.reciprocal && typeof extension.reciprocal === "object"
      ? { ...extension.reciprocal }
      : { mode: "disabled" },
    target_spatial_graph_endpoint:
      extension.target_spatial_graph_endpoint || null,
  };
}

export function wowWorldSpatialId(wowWorld) {
  if (!wowWorld || typeof wowWorld !== "object") return null;
  const extension =
    wowWorld.webofworlds_extension && typeof wowWorld.webofworlds_extension === "object"
      ? wowWorld.webofworlds_extension
      : {};
  return (
    (typeof extension.spatialID === "string" && extension.spatialID) ||
    (typeof extension.spatial_id === "string" && extension.spatial_id) ||
    (wowWorld.id != null ? String(wowWorld.id) : null) ||
    (wowWorld.location && wowWorld.location.id != null
      ? String(wowWorld.location.id)
      : null) ||
    null
  );
}

export function worldFromLive(role, wowWorld, wowPortal, wowUser) {
  const isSource = role === "source" || role === "player";
  const location = wowWorld.location;
  const avatar = wowWorld.presence.avatars[0] || {};
  const fetchedPortalList = (
    Array.isArray(wowPortal) ? wowPortal : [wowPortal]
  ).filter(Boolean);
  const wowPortalList = recoverAirportLobbyPortalResources(
    role,
    wowWorld,
    fetchedPortalList,
  );
  const portals = wowPortalList
    .map((entry) => portalEntryFromWowPortal(entry, location.id))
    .filter(Boolean);
  const primary = portals[0] || null;
  const primaryExtension =
    wowPortalList[0] && wowPortalList[0].webofworlds_extension
      ? wowPortalList[0].webofworlds_extension
      : {};
  const arrival = primaryExtension && primaryExtension.arrival
    ? primaryExtension.arrival
    : { position: [0, 0, 3.6], rotation_y: Math.PI };
  const triggerPosition = primary
    ? clonePosition(primary.trigger.position, [2.8, 0, -2.8])
    : [2.8, 0, -2.8];
  const triggerRadius = primary
    ? Number(primary.trigger.radius_m) || 1.25
    : 1.25;
  const spawnFrame = primary ? primary.frame : null;
  const spawnGround = portals.length
    ? [
        portals.reduce(
          (sum, portal) => sum + Number(portal.frame.ground_center[0] || 0),
          0,
        ) / portals.length,
        0,
        portals.reduce(
          (sum, portal) => sum + Number(portal.frame.ground_center[2] || 0),
          0,
        ) / portals.length,
      ]
    : triggerPosition;
  const sourceSpawn = spawnFrame
    ? addScaled3(
        clonePosition(spawnGround, triggerPosition),
        spawnFrame.forward,
        Math.max(
          2.4,
          (Number(spawnFrame.trigger_depth_m) || PORTAL_TRIGGER_DEPTH_M) + 2.4,
        ),
      )
    : [
        triggerPosition[0],
        0,
        triggerPosition[2] + Math.max(2.4, triggerRadius + 1.9),
      ];
  sourceSpawn[1] = 0;

  const world = {
    _provenance: LIVE_PROVENANCE,
    role_binding: role,
    location_id: location.id,
    world_id: wowWorld.id,
    session_id: wowWorld.session.id,
    title: location.title,
    base_url: `http://127.0.0.1:${location.port}`,
    color:
      location.id === "location-lobby"
        ? "#42d68a"
        : isSource ? "#3aa0ff" : "#ff7a3a",
    claim_boundary: wowWorld.proof_boundary,
    portal: primary,
    portals,
  };
  world.avatar = {
    _provenance: LIVE_PROVENANCE,
    avatar_id: avatar.avatar_id || "avatar-local-001",
    continuity_id: avatar.continuity_id || "avatar-local-001",
    display_name: avatar.display_name || "poc-user",
    spawn_position: isSource ? sourceSpawn : [0, 0, 3.2],
    rotation_y: 0,
  };
  world.arrival = {
    _provenance: LIVE_PROVENANCE,
    position: clonePosition(arrival.position, [0, 0, 3.6]),
    orientation: [0, 0, 0, 1],
    rotation_y: arrival.rotation_y,
  };
  world.initial_arrival_count = wowWorld.session.arrival_count || 0;
  return world;
}
