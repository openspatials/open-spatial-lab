/**
 * pure contract resolver for fixture-backed lobby
 * portals. Loading, validation, rendering, avatar state, and presence remain
 * owned by the existing LiveAdapter/app/WoW scene paths.
 */

import {
  addScaled3,
  clonePosition,
  dot3,
  normalizeVec3,
  roundNumber,
  roundVec3,
  subtract3,
  yawFromVector,
  yawQuaternion,
} from "./live-adapter-portal-geometry.mjs";

export const CLIENT_SCENE_LOAD_TRANSITION = "client_scene_load";
export const CLIENT_SCENE_RETURN_TRANSITION = "client_scene_return";

/**
 * Recover only the shipped player-lobby Portal C when a recognized pre-
 * backend still advertises the exact A/B pair. Fresh A/B/C backends and every
 * other input are returned by identity so this cannot mask general drift.
 */
export function recoverAirportLobbyPortalResources(clientMode, wowWorld, wowPortals) {
  if (clientMode !== "player" || !Array.isArray(wowPortals)) return wowPortals;
  if (wowWorld?.id !== "demo-lobby" || wowWorld?.location?.id !== "location-lobby") {
    return wowPortals;
  }

  const resourceIds = wowPortals.map((portal) => portal?.webofworlds_extension?.portal_id || null);
  if (
    resourceIds.length === 3 &&
    resourceIds[0] === "lobby-portal-a" &&
    resourceIds[1] === "lobby-portal-b" &&
    resourceIds[2] === "lobby-portal-c"
  ) {
    return wowPortals;
  }

  const listed = wowWorld?.webofworlds_extension?.portals;
  const listedIds = Array.isArray(listed) ? listed.map((portal) => portal?.portal_id || null) : [];
  const expectedBackendTargets = [
    [1, "lobby-portal-a", "location-a", "demo-room-a", "http://127.0.0.1:18151"],
    [2, "lobby-portal-b", "location-b", "demo-room-b", "http://127.0.0.1:18152"],
  ];
  const exactStalePair =
    resourceIds.length === 2 &&
    resourceIds[0] === "lobby-portal-a" &&
    resourceIds[1] === "lobby-portal-b" &&
    listedIds.length === 2 &&
    listedIds[0] === "lobby-portal-a" &&
    listedIds[1] === "lobby-portal-b" &&
    wowWorld?.portals?.portal_count === 2 &&
    wowPortals.every((portal, index) => {
      const ext = portal?.webofworlds_extension;
      const destination = portal?.destination;
      const expected = expectedBackendTargets[index];
      return (
        portal?.id === expected[0] &&
        ext?.portal_id === expected[1] &&
        ext?.source_location_id === "location-lobby" &&
        ext?.source_world_id === "demo-lobby" &&
        !ext?.target_fixture &&
        destination?.target_location_id === expected[2] &&
        destination?.target_world_id === expected[3] &&
        destination?.target_base_url === expected[4]
      );
    });
  if (!exactStalePair) return wowPortals;

  return [...wowPortals, {
    id: 3,
    label: "Portal to Denver Skyport",
    geoPose: {
      position: { lat: 4.4, lon: 0, h: 0 },
      angles: { yaw: 0, pitch: 0, roll: 0 },
    },
    destination: {},
    webofworlds_extension: {
      portal_id: "lobby-portal-c",
      wow_id: 3,
      wow_resource: "/wow/portal/3",
      legacy_alias_endpoint: "/wow/portal/lobby-portal-c",
      source_location_id: "location-lobby",
      source_world_id: "demo-lobby",
      target_fixture: {
        spatial_id: "world-airport-terminal",
        graph_endpoint: "/worlds/denver-skyport.json",
      },
      handoff_behavior: "client-scene-load (same browser/player; no application-level handoff)",
      native_teleportxr_teleport: false,
      trigger: { position: [0, 0, -4.4], radius_m: 1.25 },
      arrival: { position: [0, 0, -3], rotation_y: 0 },
      zones: {
        prefetch: {
          type: "portal_center_planar_radius",
          radius_m: 3,
          hysteresis_ratio: 1.15,
          armed_entry_sides: ["front", "back"],
        },
        traversal: {
          type: "oval_frame_plane_crossing",
          width_m: 1.8,
          height_m: 2.8,
          trigger_depth_m: 0.8,
          armed_entry_sides: ["front", "back"],
        },
        invariant: "prefetch.radius_m > width_m/2 + trigger_depth_m + 0.5",
        invariant_min_prefetch_radius_m: 2.2,
        invariant_ok: true,
      },
      traversal_mode: "bidirectional",
      traversal: {
        mode: "bidirectional",
        transition: CLIENT_SCENE_LOAD_TRANSITION,
        allowed_entry_side: "both",
        blocked_entry_side: null,
        side_reference: "portal_frame_forward",
        frame_forward: [0, 0, 1],
        validation: {
          traversal_direction_standard_conformance: false,
          application_level: true,
        },
      },
      reciprocal: {
        mode: "automatic",
        validation: {
          automatic_reciprocal_standard_conformance: false,
          application_level: true,
        },
      },
    },
    proof_boundary: wowWorld.proof_boundary && typeof wowWorld.proof_boundary === "object"
      ? { ...wowWorld.proof_boundary }
      : {
          application_level_handoff: true,
          native_teleportxr_teleport: false,
          first_party_teleportxr_browser_rendering: false,
          standards_conformance: false,
        },
  }];
}

export function clientSceneLoadFieldsFromWowPortal(wowPortal) {
  const ext = wowPortal && wowPortal.webofworlds_extension;
  if (!ext || typeof ext !== "object") return { target_fixture: null, traversal_transition: null };
  const fixture = ext.target_fixture && typeof ext.target_fixture === "object"
    ? { ...ext.target_fixture }
    : null;
  const transition = ext.traversal && typeof ext.traversal.transition === "string"
    ? ext.traversal.transition
    : null;
  const reciprocal = ext.reciprocal && typeof ext.reciprocal === "object"
    ? { ...ext.reciprocal }
    : { mode: "disabled" };
  return { target_fixture: fixture, traversal_transition: transition, reciprocal };
}

function portalKey(portal) {
  if (!portal || typeof portal !== "object") return null;
  return portal.string_portal_id || portal.portal_id || null;
}

export function clientSceneLoadTarget(portal) {
  if (!portal || typeof portal !== "object") return null;
  const traversal = portal.traversal && typeof portal.traversal === "object"
    ? portal.traversal
    : {};
  const fixture = portal.target_fixture && typeof portal.target_fixture === "object"
    ? portal.target_fixture
    : null;
  if (traversal.transition === CLIENT_SCENE_RETURN_TRANSITION) {
    if (!portal.target_location_id || !portalKey(portal)) return null;
    return {
      portal_id: portalKey(portal),
      spatial_id: portal.target_location_id,
      transition: CLIENT_SCENE_RETURN_TRANSITION,
      arrival: portal.arrival || null,
      proof_boundary: {
        application_level_handoff: false,
        standards_conformance: false,
      },
    };
  }
  if (traversal.transition !== CLIENT_SCENE_LOAD_TRANSITION || !fixture) return null;
  if (portal.target_base_url || portal.target_portal_id) return null;
  if (typeof fixture.spatial_id !== "string" || !fixture.spatial_id) return null;
  if (typeof fixture.graph_endpoint !== "string" || !fixture.graph_endpoint) return null;
  return {
    portal_id: portalKey(portal),
    label: portal.label || null,
    spatial_id: fixture.spatial_id,
    graph_endpoint: fixture.graph_endpoint,
    arrival: portal.arrival || null,
    reciprocal: portal.reciprocal && typeof portal.reciprocal === "object"
      ? { ...portal.reciprocal }
      : { mode: "disabled" },
    transition: CLIENT_SCENE_LOAD_TRANSITION,
    proof_boundary: {
      application_level_handoff: false,
      standards_conformance: false,
    },
  };
}

function finiteVec3(value) {
  return Array.isArray(value) && value.length >= 3 && value.slice(0, 3).every((entry) =>
    typeof entry === "number" && Number.isFinite(entry)
  );
}

function usableFrame(frame) {
  return !!(
    frame &&
    finiteVec3(frame.position) &&
    finiteVec3(frame.ground_center) &&
    finiteVec3(frame.forward) &&
    finiteVec3(frame.up) &&
    finiteVec3(frame.right) &&
    Math.hypot(...frame.forward.slice(0, 3).map(Number)) > 0.99 &&
    Number(frame.width_m) > 0 &&
    Number(frame.height_m) > 0 &&
    Number(frame.trigger_depth_m) > 0
  );
}

function cloneFrame(frame, overrides) {
  return {
    ...JSON.parse(JSON.stringify(frame)),
    position: clonePosition(frame.position, [0, 0, 0]),
    ground_center: clonePosition(frame.ground_center, [0, 0, 0]),
    forward: roundVec3(normalizeVec3(frame.forward, [0, 0, 1]), 6),
    up: roundVec3(normalizeVec3(frame.up, [0, 1, 0]), 6),
    right: roundVec3(normalizeVec3(frame.right, [1, 0, 0]), 6),
    ...overrides,
  };
}

function inverseFabricAddress(originWorld, sourcePortalId, zones) {
  const authority = originWorld.base_url;
  const radius = Number(zones?.prefetch?.matching_destination_circle?.radius_m) || 5;
  return {
    profile_version: "osl.spatial-fabric-address.v0",
    uri: `osl-fabric+http://${authority.replace(/^https?:\/\//, "")}/fabric.json#portal=${sourcePortalId}&roi_radius_m=${radius}`,
    authority,
    fabric_id: `local-fabric-${originWorld.location_id}`,
    world_id: originWorld.world_id,
    location_id: originWorld.location_id,
    anchor: { type: "portal", portal_id: sourcePortalId },
    roi_hint: { type: "portal_neighborhood_radius", radius_m: radius },
    discovery: {
      well_known: "/.well-known/spatial-fabric",
      fabric_manifest: "/fabric.json",
      region_endpoint: "/fabric/region",
      presence_endpoint: "/fabric/presence",
    },
    validation: {
      address_scheme_standard_conformance: false,
      application_level: true,
    },
  };
}

/**
 * Derive at most one runtime-ready inverse edge for a fixture-backed scene.
 * Every invalid or ambiguous input returns a labeled refusal and no portal.
 */
export function automaticReciprocalPortal({
  sourcePortal,
  destinationSpatialId,
  originWorld,
  destinationPortals = [],
} = {}) {
  if (!sourcePortal) return { portal: null, synthesized: false, reason: "missing_source_portal" };
  if (sourcePortal.reciprocal?.mode !== "automatic") {
    return { portal: null, synthesized: false, reason: "automatic_reciprocal_disabled" };
  }
  if (sourcePortal.traversal?.mode !== "bidirectional") {
    return { portal: null, synthesized: false, reason: "one_way_source_not_pairable" };
  }
  const sourcePortalId = portalKey(sourcePortal);
  const fixtureSpatialId = sourcePortal.target_fixture?.spatial_id || null;
  if (!sourcePortalId || !destinationSpatialId || fixtureSpatialId !== destinationSpatialId) {
    return { portal: null, synthesized: false, reason: "invalid_reciprocal_destination" };
  }
  if (
    !originWorld ||
    !originWorld.location_id ||
    !originWorld.world_id ||
    typeof originWorld.base_url !== "string" ||
    !originWorld.base_url
  ) {
    return { portal: null, synthesized: false, reason: "invalid_inverse_target" };
  }

  const derivedId = `reciprocal--${sourcePortalId}--${destinationSpatialId}`;
  const candidates = (Array.isArray(destinationPortals) ? destinationPortals : [])
    .filter(Boolean)
    .filter((portal) => {
      const key = portalKey(portal);
      const targetPortalId = portal.target_portal_id || portal.frame?.linked_target_portal_id;
      const targetLocationId = portal.target_location_id || portal.destination?.target_location_id;
      const reciprocalOf = portal.derived_from?.source_portal_id || portal.reciprocal?.source_portal_id;
      return key === derivedId || reciprocalOf === sourcePortalId || (
        targetPortalId === sourcePortalId && targetLocationId === originWorld.location_id
      );
    })
    .sort((left, right) => String(portalKey(left)).localeCompare(String(portalKey(right))));
  if (candidates.length) {
    const explicit = candidates[0];
    if (
      !usableFrame(explicit.frame) ||
      !usableFrame(explicit.target_frame) ||
      !finiteVec3(explicit.trigger?.position) ||
      !finiteVec3(explicit.arrival?.position) ||
      explicit.traversal?.mode !== "bidirectional" ||
      explicit.traversal?.transition !== CLIENT_SCENE_RETURN_TRANSITION
    ) {
      return { portal: null, synthesized: false, reason: "explicit_reciprocal_invalid" };
    }
    return {
      portal: explicit,
      synthesized: explicit.reciprocal?.synthesized === true,
      reason: explicit.reciprocal?.synthesized === true
        ? "stable_synthesized_reciprocal_reused"
        : "explicit_reciprocal_reused",
      duplicate_count: candidates.length,
    };
  }

  const sourceFrame = sourcePortal.frame;
  const destinationFrame = sourcePortal.target_frame;
  const zones = sourcePortal.zones;
  if (!usableFrame(sourceFrame) || !usableFrame(destinationFrame)) {
    return { portal: null, synthesized: false, reason: "invalid_inverse_frame" };
  }
  if (destinationFrame.location_id !== destinationSpatialId) {
    return { portal: null, synthesized: false, reason: "inverse_frame_destination_mismatch" };
  }
  if (
    !zones?.prefetch ||
    !zones?.traversal ||
    zones.invariant_ok !== true ||
    Number(zones.prefetch.radius_m) <= Number(zones.invariant_min_prefetch_radius_m)
  ) {
    return { portal: null, synthesized: false, reason: "invalid_inverse_zones" };
  }
  if (!finiteVec3(sourcePortal.arrival?.position)) {
    return { portal: null, synthesized: false, reason: "invalid_inverse_arrival" };
  }

  const destinationForward = normalizeVec3(destinationFrame.forward, [0, 0, 1]);
  const arrivalDelta = subtract3(sourcePortal.arrival.position, destinationFrame.ground_center);
  const forwardClearance = dot3(arrivalDelta, destinationForward);
  const lateralOffset = Math.abs(dot3(arrivalDelta, destinationFrame.right));
  const minimumClearance = Number(destinationFrame.trigger_depth_m) + 0.2;
  if (forwardClearance <= 0) {
    return { portal: null, synthesized: false, reason: "invalid_inverse_orientation" };
  }
  if (
    forwardClearance < minimumClearance ||
    lateralOffset > Number(destinationFrame.width_m) / 2 - 0.08
  ) {
    return { portal: null, synthesized: false, reason: "unsafe_inverse_arrival" };
  }

  const sourceForward = normalizeVec3(sourceFrame.forward, [0, 0, 1]);
  const returnClearance = Math.max(
    Number(sourceFrame.exit_offset_m) || 0,
    Number(sourceFrame.trigger_depth_m) + 0.25,
  );
  const returnPosition = roundVec3(
    addScaled3(sourceFrame.ground_center, sourceForward, returnClearance),
    4,
  );
  const returnYaw = roundNumber(yawFromVector(sourceForward, 0), 6);
  const reciprocalFrame = cloneFrame(destinationFrame, {
    portal_id: derivedId,
    location_id: destinationSpatialId,
    linked_target_location_id: originWorld.location_id,
    linked_target_portal_id: sourcePortalId,
    pose_source: "automatic_reciprocal_inverse_target_frame",
  });
  const inverseTargetFrame = cloneFrame(sourceFrame, {
    portal_id: sourcePortalId,
    location_id: originWorld.location_id,
    linked_target_location_id: destinationSpatialId,
    linked_target_portal_id: derivedId,
    pose_source: "automatic_reciprocal_source_frame",
  });
  const portal = {
    _provenance: sourcePortal._provenance,
    portal_id: derivedId,
    string_portal_id: derivedId,
    label: `Return through ${sourcePortal.label || sourcePortalId}`,
    source_location_id: destinationSpatialId,
    source_world_id: destinationSpatialId,
    target_location_id: originWorld.location_id,
    target_world_id: originWorld.world_id,
    target_base_url: null,
    target_portal_id: sourcePortalId,
    target_fixture: null,
    arrival: {
      position: returnPosition,
      rotation_y: returnYaw,
      orientation: yawQuaternion(returnYaw),
    },
    trigger: {
      position: clonePosition(reciprocalFrame.ground_center, [0, 0, 0]),
      radius_m: Number(sourcePortal.trigger?.radius_m) || 1.25,
    },
    frame: reciprocalFrame,
    target_frame: inverseTargetFrame,
    spatial_fabric_address: inverseFabricAddress(originWorld, sourcePortalId, zones),
    zones: JSON.parse(JSON.stringify(zones)),
    traversal: {
      ...sourcePortal.traversal,
      mode: "bidirectional",
      transition: CLIENT_SCENE_RETURN_TRANSITION,
      allowed_entry_side: "both",
      blocked_entry_side: null,
    },
    reciprocal: {
      mode: "disabled",
      synthesized: true,
      source_portal_id: sourcePortalId,
      destination_spatial_id: destinationSpatialId,
      stable_identity: derivedId,
    },
    derived_from: {
      source_portal_id: sourcePortalId,
      source_destination_spatial_id: destinationSpatialId,
      source_arrival_position: clonePosition(sourcePortal.arrival.position, [0, 0, 0]),
      inverse_frame_id: reciprocalFrame.portal_id,
    },
  };
  return {
    portal,
    synthesized: true,
    reason: "automatic_reciprocal_synthesized",
    duplicate_count: 0,
    safe_arrival: {
      destination_clearance_m: roundNumber(forwardClearance, 3),
      minimum_clearance_m: roundNumber(minimumClearance, 3),
      return_position: returnPosition,
    },
  };
}

/** Return the declared scene-load target only on the exact crossing edge. */
export function resolveClientSceneLoadTraversal(world, controls) {
  if (!world || !controls || !Array.isArray(world.portals)) return null;
  const focusKey = controls.portal_focus_portal_id || null;
  const status = Array.isArray(controls.portals)
    ? controls.portals.find((entry) => entry && entry.portal_id === focusKey)
    : null;
  if (!status || status.crossed_plane !== true || status.crossing_commit_allowed !== true) return null;
  const portal = world.portals.find((entry) => portalKey(entry) === focusKey);
  return clientSceneLoadTarget(portal);
}

export function airportSceneContract(graph, target) {
  if (!graph || !target || typeof graph !== "object") return null;
  const spatialId = graph.spatialID || graph.spatial_id || null;
  if (spatialId !== target.spatial_id) return null;
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : Object.values(graph.nodes || {});
  const airport = nodes
    .map((node) => node && node.webofworlds_extension && node.webofworlds_extension.airport_terminal)
    .find(Boolean);
  const boundary = graph.world && graph.world.proof_boundary ? graph.world.proof_boundary : null;
  if (!airport || !boundary) return null;
  if (boundary.application_level_handoff !== false || boundary.standards_conformance !== false) return null;
  const entry = airport.entry_spawn;
  const returnPath = airport.return_path;
  if (!entry || !Array.isArray(entry.position_m) || entry.position_m.length !== 3) return null;
  if (!returnPath || returnPath.control_id !== "btn-return-lobby") return null;
  return {
    spatial_id: spatialId,
    graph_endpoint: target.graph_endpoint,
    entry_spawn: {
      position: entry.position_m.slice(0, 3).map(Number),
      rotation_y: Number(entry.rotation_y) || 0,
    },
    return_path: { ...returnPath },
    proof_boundary: {
      application_level_handoff: false,
      standards_conformance: false,
    },
  };
}
