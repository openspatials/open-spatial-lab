import { fixed3, vec3Label } from "./application-debug-format.mjs";
function navigationDataset(body, debug, role) {
  const nav = debug.navigator || null;
  body.setAttribute("data-role", debug.role || role);
  body.setAttribute("data-client-mode", debug.client_mode || "");
  body.setAttribute("data-player-context-marker", debug.player_context_marker ? debug.player_context_marker.marker_id : "");
  body.setAttribute("data-player-context-current-href", debug.player_context_marker ? debug.player_context_marker.current_href : "");
  body.setAttribute("data-navigator-context-id", nav ? nav.context_id || "" : "");
  body.setAttribute("data-navigator-status", nav ? nav.status || "" : "");
  body.setAttribute("data-navigator-single-context", String(!!(nav && nav.single_context === true)));
  body.setAttribute("data-navigator-fabrics-loaded", nav ? (nav.fabrics_loaded || []).join(",") : "");
  body.setAttribute("data-navigator-fabrics-loaded-count", nav ? String(nav.fabrics_loaded_count || 0) : "");
  body.setAttribute("data-navigator-root-fabric-url", nav && nav.root_fabric ? nav.root_fabric.url || "" : "");
  body.setAttribute("data-navigator-child-fabric-url", nav && nav.child_fabric ? nav.child_fabric.url || "" : "");
  body.setAttribute(
    "data-navigator-portal-attachment-node",
    nav && nav.portal_attachment
      ? `${nav.portal_attachment.node_id || ""}:bSubtype=${nav.portal_attachment.bSubtype || ""}`
      : ""
  );
  body.setAttribute("data-navigator-spawn-source", nav && nav.spawn ? nav.spawn.source || "" : "");
  body.setAttribute(
    "data-child-fabric-render-active",
    String(!!(nav && nav.child_render && nav.child_render.active === true))
  );

  body.setAttribute("data-navigator-promotion-count", nav ? String(nav.promotion_count || 0) : "");
}

function crossingDataset(body, debug, role) {
  const crossing = debug.crossing || null;
  const contextMarker = debug.player_context_marker || null;
  body.setAttribute("data-crossing-phase", crossing ? crossing.phase || "" : "");
  body.setAttribute("data-crossing-handoff-id", crossing ? crossing.handoff_id || "" : "");
  body.setAttribute(
    "data-crossing-exit-accepted",
    crossing ? String(crossing.server_notifications?.exit_intent?.accepted === true) : ""
  );
  body.setAttribute(
    "data-crossing-arrival-accepted",
    crossing ? String(crossing.server_notifications?.arrival?.accepted === true) : ""
  );
  body.setAttribute(
    "data-marker-same-after-crossing",
    contextMarker && typeof contextMarker.same_marker_after_crossing === "boolean"
      ? String(contextMarker.same_marker_after_crossing)
      : ""
  );
  body.setAttribute(
    "data-player-profile-version",
    debug.player_handoff_profile ? debug.player_handoff_profile.profile_version || "" : ""
  );
}

function previewDataset(body, debug, role) {
  body.setAttribute("data-active-endpoint-key", debug.active ? debug.active.endpoint_key : "");
  body.setAttribute("data-active-backend-url", debug.active ? debug.active.backend_base_url : "");
  body.setAttribute("data-active-location", debug.active ? debug.active.location_id : "");
  body.setAttribute("data-active-world", debug.active ? debug.active.world_id : "");
  body.setAttribute("data-preview-state", debug.preview ? debug.preview.state : "");
  body.setAttribute("data-preview-source-type", debug.preview ? debug.preview.source_type : "");
  body.setAttribute("data-preview-readonly", String(debug.preview ? debug.preview.readonly === true : true));
  body.setAttribute("data-preview-target-location", debug.preview ? debug.preview.location_id || "" : "");
  body.setAttribute("data-preview-target-portal", debug.preview ? debug.preview.target_portal_id || "" : "");
  body.setAttribute("data-preview-target-location-id", debug.preview ? debug.preview.location_id || "" : "");
  body.setAttribute("data-preview-target-portal-id", debug.preview ? debug.preview.target_portal_id || "" : "");
  body.setAttribute("data-preview-fallback-reason", debug.preview ? debug.preview.fallback_reason || "" : "");
  body.setAttribute("data-preview-freshness-ms", debug.preview && debug.preview.freshness_ms !== null ? String(Math.round(debug.preview.freshness_ms)) : "");
  body.setAttribute(
    "data-preview-target-arrival-count-before",
    debug.preview && debug.preview.target_arrival_count_before_preview !== null
      ? String(debug.preview.target_arrival_count_before_preview)
      : ""
  );
  body.setAttribute(
    "data-preview-target-arrival-count-current",
    debug.preview && debug.preview.target_arrival_count_current !== null
      ? String(debug.preview.target_arrival_count_current)
      : ""
  );
  body.setAttribute(
    "data-preview-target-avatar-presence-created",
    String(debug.preview ? debug.preview.target_avatar_presence_created === true : false)
  );
  body.setAttribute(
    "data-preview-target-mutation-count",
    debug.preview && debug.preview.target_mutation_count_during_preview !== null
      ? String(debug.preview.target_mutation_count_during_preview)
      : ""
  );
  body.setAttribute(
    "data-preview-source-camera-relative",
    debug.preview && debug.preview.source_camera_relative_to_portal
      ? JSON.stringify(debug.preview.source_camera_relative_to_portal)
      : ""
  );
  body.setAttribute(
    "data-preview-target-camera-transform",
    debug.preview && debug.preview.target_preview_camera_transform
      ? JSON.stringify(debug.preview.target_preview_camera_transform)
      : ""
  );
  body.setAttribute("data-preview-projection-frame-source", debug.preview ? debug.preview.projection_frame_source || "" : "");
}

function avatarDataset(body, debug, role) {
  body.setAttribute("data-camera-mode", debug.camera ? debug.camera.mode : "");
  body.setAttribute("data-camera-follow-distance", debug.camera ? String(debug.camera.follow_distance_m) : "");
  body.setAttribute("data-camera-follow-height", debug.camera ? String(debug.camera.follow_height_m) : "");
  body.setAttribute("data-camera-pitch", debug.camera ? String(debug.camera.pitch_deg) : "");
  body.setAttribute("data-avatar-position", debug.avatar ? vec3Label(debug.avatar.position) : "");
  body.setAttribute("data-avatar-rotation-y", debug.avatar ? fixed3(debug.avatar.rotation_y) : "");
  body.setAttribute("data-avatar-orientation", debug.avatar ? debug.avatar.orientation.join(",") : "");
  body.setAttribute("data-equipment-count", String(debug.equipment.equipped_count));
  body.setAttribute("data-held-item-visible", String(debug.equipment.held_item_visible === true));
  body.setAttribute("data-worn-item-visible", String(debug.equipment.worn_item_visible === true));
}

function poseDataset(body, debug, role) {
  const livePose = debug.live_player_pose || null;
  body.setAttribute("data-live-player-pose-seq", livePose ? String(livePose.seq) : "");
  body.setAttribute(
    "data-live-player-pose-applied-count",
    livePose ? String(livePose.applied_count) : ""
  );
  body.setAttribute("data-live-player-pose-position", livePose ? vec3Label(livePose.position) : "");
  body.setAttribute(
    "data-live-player-pose-rotation-y",
    livePose ? fixed3(livePose.rotation_y) : ""
  );
  body.setAttribute("data-live-player-pose-from", livePose ? livePose.from_client_id || "" : "");
  const poseBroadcast = debug.player_pose_broadcast || null;
  body.setAttribute(
    "data-player-pose-sent-count",
    poseBroadcast ? String(poseBroadcast.sent_count) : ""
  );
}

function proofDataset(body, debug, role) {
  body.setAttribute("data-source-exit-accepted", String(debug.transition.source_exit_accepted === true));
  body.setAttribute("data-target-arrival-accepted", String(debug.transition.target_arrival_accepted === true));
  body.setAttribute("data-active-endpoint-switched", String(debug.transition.active_endpoint_switched === true));
  body.setAttribute("data-handoff-id", debug.handoff.handoff_id || "");
  body.setAttribute("data-validation-application-level-handoff", String(debug.proof_boundary.application_level_handoff === true));
  body.setAttribute("data-validation-native-teleportxr-teleport", String(debug.proof_boundary.native_teleportxr_teleport === true));
  body.setAttribute("data-validation-first-party-teleportxr-browser-rendering", String(debug.proof_boundary.first_party_teleportxr_browser_rendering === true));
  body.setAttribute("data-validation-standards-conformance", String(debug.proof_boundary.standards_conformance === true));
}

export function publishDebugDataset(body, debug, role) {
  navigationDataset(body, debug, role);
  crossingDataset(body, debug, role);
  previewDataset(body, debug, role);
  avatarDataset(body, debug, role);
  poseDataset(body, debug, role);
  proofDataset(body, debug, role);
}
