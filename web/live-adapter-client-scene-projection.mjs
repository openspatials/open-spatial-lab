export function clientSceneWorld({ origin, contract, resolved, spawn, avatar, reciprocalPortal, role, provenance }) {
  return {
        _provenance: provenance,
        role_binding: role,
        location_id: contract.spatial_id,
        world_id: contract.spatial_id,
        session_id: origin.world ? origin.world.session_id : null,
        title: resolved.graph.title || "Denver Skyport",
        claim_boundary: {
          application_level_handoff: false,
          native_teleportxr_teleport: false,
          first_party_teleportxr_browser_rendering: false,
          standards_conformance: false,
        },
        portal: reciprocalPortal,
        portals: reciprocalPortal ? [reciprocalPortal] : [],
        avatar: {
          _provenance: provenance,
          avatar_id: avatar.avatar_id,
          continuity_id: avatar.continuity_id,
          display_name: avatar.display_name,
          spawn_position: spawn.slice(),
          rotation_y: contract.entry_spawn.rotation_y,
        },
        arrival: { kind: "client_scene_load", position: spawn.slice() },
        initial_arrival_count: 0,
      };
}

export function clientScenePreview({ origin, target, reciprocalPortal }) {
  return reciprocalPortal ? {
        state: "active",
        source_type: "automatic_reciprocal_origin_snapshot_labeled",
        readonly: true,
        location_id: origin.world.location_id,
        world_id: origin.world.world_id,
        target_portal_id: target.portal_id,
        linked_source_portal_id: reciprocalPortal.string_portal_id,
        captured_at: new Date().toISOString(),
        fallback_reason: null,
        projection_frame_source: "automatic_reciprocal_inverse_frames",
        source_camera_relative_to_portal: {},
        target_preview_camera_transform: {},
        preview_projection_transform: {},
      } : null;
}

export function clientSceneControls({ origin, entryGround }) {
  return {
        ...origin.controls,
        enabled: true,
        moving: false,
        movement_mode: "idle",
        run_mode: false,
        speed_mps: 0,
        grounded: true,
        jump_height_m: 0,
        movement_direction: "none",
        last_planar_delta: [0, 0, 0],
        portal_focus_portal_id: null,
        portal_count: 0,
        portals: [],
        ground_query_ok: true,
        ground_query_reason: null,
        ground_surface_id: entryGround.surface_id,
        ground_y_m: entryGround.surface_y_m,
        logical_ground_y_m: entryGround.surface_y_m,
        rendered_surface_y_m: entryGround.surface_y_m,
        ground_query_xz_m: [entryGround.query_x_m, entryGround.query_z_m],
        ground_resolver_source: entryGround.resolver_source,
      };
}
