import { yawQuaternion, roundedVec3 } from "./application-debug-format.mjs";
import { UM_CONFORMANCE } from "./conformance/um-conformance.mjs";
import { IWPS_CONFORMANCE } from "./iwps-query-teleport.mjs";
function equipmentDebugFor(dbg, visual) {
  const av = dbg && dbg.avatar;
  const items = av && Array.isArray(av.equippedItems) ? av.equippedItems : [];
  const held = visual ? visual.has_held_item === true : items.some((item) => item.mode === "held");
  const worn = visual ? visual.has_worn_item === true : items.some((item) => item.mode === "worn");
  return {
    equipped_count: items.length,
    held_item_visible: held,
    worn_item_visible: worn,
    items,
  };
}
function projectAvatar(av, controls) {
  return av
      ? {
          ...av,
          position: roundedVec3(av.position),
          rotation_y: Number((Number(av.rotation_y) || 0).toFixed(6)),
          orientation: av.orientation || yawQuaternion(av.rotation_y),
          visible: true,
          locomotion_state: av.locomotion || controls,
          equippedItems: Array.isArray(av.equippedItems) ? av.equippedItems : [],
        }
      : null;
}

function projectMovement(controls, controllerMovement) {
  return {
      keys_down: controllerMovement.keys === "none" ? [] : controllerMovement.keys.split(" "),
      last_key_event: controllerMovement.last_key_event,
      last_planar_delta: roundedVec3(controls.last_planar_delta || controllerMovement.last_delta),
      movement_direction: controls.movement_direction || "none",
      movement_mode: controls.movement_mode || (controls.moving ? "walk" : "idle"),
      run_mode: controls.run_mode === true,
      speed_mps: Number(controls.speed_mps || 0),
      facing_semantics: controls.facing_semantics || "still",
      grounded: controls.grounded !== false,
      jump_height_m: Number(controls.jump_height_m || 0),
      controls_enabled: controls.enabled === true,
    };
}

function projectPortal(controls) {
  return {
      nearest_portal_id: controls.portal_frame_id || null,
      source_portal_id: controls.portal_frame_id || null,
      target_portal_id: controls.portal_linked_target_portal_id || null,
      portal_frame: controls.portal_frame || null,
      target_portal_frame: controls.portal_target_frame || null,
      portal_local_coordinates: controls.portal_local_coordinates || null,
      portal_signed_plane_distance_m: controls.portal_signed_plane_distance_m ?? null,
      inside_oval_aperture: controls.inside_oval_aperture === true,
      inside_trigger_volume: controls.inside_trigger_volume === true,
      portal_crossing_direction: controls.portal_crossing_direction || "unknown",
      portal_trigger_rearmed: controls.portal_trigger_rearmed === true,
      portal_handshake_ready: controls.portal_handshake_ready === true || controls.return_handshake_ready === true,
      portal_ready_blocker: controls.portal_ready_blocker || null,
      mapped_exit_transform: controls.mapped_exit_transform || null,
      mapped_exit_yaw: controls.mapped_exit_yaw ?? null,
    };
}

function projectTransition(dbg, controls, transitionPhase, HANDOFF_PHASES) {
  return {
      phase: transitionPhase,
      phase_history: Array.isArray(controls.portal_transition_phase_history)
        ? controls.portal_transition_phase_history
        : [],
      elapsed_s: Number(controls.portal_transition_elapsed_s || 0),
      handoff_id: dbg.handoff_id || null,
      source_exit_accepted:
        (dbg.phase === HANDOFF_PHASES.DEPARTED && !!dbg.handoff_id) ||
        !!(dbg.crossing && dbg.crossing.server_notifications?.exit_intent?.accepted === true),
      target_arrival_accepted:
        (dbg.phase === HANDOFF_PHASES.ARRIVED && !!dbg.handoff_id) ||
        !!(dbg.crossing && dbg.crossing.server_notifications?.arrival?.accepted === true),
      active_endpoint_switched: !!(dbg.crossing && dbg.crossing.active_endpoint_switched === true),
      mapped_target_pose: controls.mapped_exit_transform || null,
    };
}

function projectHandoff(dbg, preview) {
  return {
      handoff_id: dbg.handoff_id || null,
      direction: dbg.last_handoff_direction || `${dbg.active?.location_id || dbg.location_id}->${preview?.location_id || "unknown"}`,
      profile_version: "msf.player-view-handoff.v0.1",
      last_payload: dbg.last_handoff_payload || null,
    };
}

function projectObserverCorrelation(dbg, isPlayer, role) {
  return {
      source_observer_handoff_id: null,
      target_observer_handoff_id: null,
      source_visible_avatar_count: role === "source" ? dbg.visibility?.local_visible_avatar_count ?? null : null,
      target_visible_avatar_count: role === "target" ? dbg.visibility?.local_visible_avatar_count ?? null : null,
      player_visible_avatar_count: isPlayer ? dbg.visibility?.local_visible_avatar_count ?? null : null,
      one_visible_avatar_across_three_surfaces: dbg.visibility?.one_avatar_visible_invariant === true,
    };
}

export function canonicalDebugState(raw, facts) {
  const dbg = raw || {}, controls = dbg.controls || {}, av = dbg.avatar;
  const HANDOFF_PHASES = facts.handoffPhases;
  const camera = facts.isPlayer ? facts.camera : null;
  const preview = facts.isPlayer ? facts.preview : dbg.preview;
  const controllerMovement = facts.movement;
  const transitionPhase = controls.portal_transition_phase && controls.portal_transition_phase !== "none"
    ? controls.portal_transition_phase : dbg.phase === HANDOFF_PHASES.DEPARTED ? "source_exit_committed" : "none";
  return {
    ...dbg,
    renderer_kind: facts.rendererKind,
    client_mode: dbg.client_mode || (facts.isPlayer ? "player" : "observer"),
    preview,
    camera,
    avatar: projectAvatar(av, controls),
    movement: projectMovement(controls, controllerMovement),
    portal: projectPortal(controls),
    transition: projectTransition(dbg, controls, transitionPhase, HANDOFF_PHASES),
    handoff: projectHandoff(dbg, preview),
    equipment: equipmentDebugFor(dbg, facts.equipmentVisual),
    observer_correlation: projectObserverCorrelation(dbg, facts.isPlayer, facts.role),
    proof_boundary: dbg.proof_boundary || {
      application_level_handoff: true,
      native_teleportxr_teleport: false,
      first_party_teleportxr_browser_rendering: false,
      standards_conformance: false,
      um_conformance: { ...UM_CONFORMANCE },
      iwps_conformance: { ...IWPS_CONFORMANCE },
      web_of_worlds_conformance: false,
      spatial_fabric_conformance: false,
    },
    portal_aperture_occlusion: facts.portalApertureOcclusion,
    camera_wall_occlusion: facts.cameraWallOcclusion,
    portal_visual_alignment: facts.portalVisualAlignment,
    equipment_visual: facts.equipmentVisual,

  };
}
