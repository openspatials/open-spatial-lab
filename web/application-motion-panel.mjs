import { fixed3, vec3Label } from "./application-debug-format.mjs";
function renderAbsentMovement(writer, movement, camera, pressedKeys) {
    writer.text("m-keys", pressedKeys);
    writer.text("m-pos", "—");
    writer.text("m-delta", "—");
    writer.text("m-move-dir", "—");
    writer.text("m-rot", "—");
    writer.text("m-facing", "—");
    writer.text("m-flags", "—");
    writer.text("m-cam-yaw", camera ? fixed3(camera.rotation_y) : "—");
    writer.text("m-jump", "—");
    writer.text("m-portal-dist", "—");
    writer.bool("m-inside", null);
    writer.bool("m-auto", null);
    writer.text("m-last-key", movement.last_key_event);
}

function renderMovement(writer, dbg, facts) {
  const { movement, camera, pressedKeys } = facts;
  const av = dbg && dbg.avatar;
  const pos = av && Array.isArray(av.position) ? av.position : null;
  const controls = dbg && dbg.controls ? dbg.controls : {};
  if (!pos) return renderAbsentMovement(writer, movement, camera, pressedKeys);

  const movementMode = controls.movement_mode || (controls.moving ? "walk" : "idle");
  const groundedLabel = controls.grounded ? "grounded" : "airborne";
  const keys = movement.keys || pressedKeys;
  const positionLabel = vec3Label(pos);
  const deltaLabel = vec3Label(movement.last_delta);
  const portalDistance = fixed3(controls.portal_distance_m);

  writer.text("m-keys", keys);
  writer.text("m-pos", positionLabel);
  writer.text("m-delta", deltaLabel);
  writer.text("m-move-dir", controls.movement_direction || "none");
  writer.text("m-rot", fixed3(av.rotation_y));
  writer.text("m-facing", controls.facing_semantics || "still");
  writer.text("m-flags", `${movementMode} · ${fixed3(controls.speed_mps)} m/s / ${groundedLabel}`);
  writer.text("m-cam-yaw", camera ? fixed3(camera.rotation_y) : "—");
  writer.text("m-jump", fixed3(controls.jump_height_m));
  writer.text("m-portal-dist", portalDistance);
  writer.bool("m-inside", controls.inside_portal_trigger);
  writer.bool("m-auto", controls.auto_handoff_ready);
  writer.text("m-last-key", movement.last_key_event);

  writer.attribute("data-avatar-keys", keys);
  writer.attribute("data-avatar-position", positionLabel);
  writer.attribute("data-avatar-delta", deltaLabel);
  writer.attribute("data-avatar-rotation-y", fixed3(av.rotation_y));
  writer.attribute("data-portal-distance", portalDistance);
  writer.attribute("data-auto-handoff-ready", String(controls.auto_handoff_ready === true));
}

function portalFacts(dbg) {
  const controls = dbg && dbg.controls ? dbg.controls : {};
  const movementMode = controls.movement_mode || (controls.moving ? "walk" : "idle");
  const visibility = dbg && dbg.visibility ? dbg.visibility : {};
  const visualAlignment = dbg && dbg.portal_visual_alignment ? dbg.portal_visual_alignment : {};
  const payload = dbg && dbg.last_handoff_payload;
  const pose = dbg && dbg.last_pose_payload;
  const payloadTransform = payload && payload.avatar_context && payload.avatar_context.transform;
  const payloadFrameTransform = payload && payload.avatar_context && payload.avatar_context.portal_frame_transform;
  const mappedExitTransform =
    (payloadFrameTransform && payloadFrameTransform.mapped_exit_transform) ||
    controls.mapped_exit_transform ||
    null;
  const local = controls.portal_local_coordinates || {};
  const poseFields = pose
    ? [
        "transform",
        "pose_snapshot",
        "locomotion_state",
        "portal_entry_transform",
        "portal_center_transform",
        "portal_departure_transform",
        "portal_exit_transform",
        "portal_frame_transform",
        "mapped_exit_transform",
      ]
        .filter((key) => Object.prototype.hasOwnProperty.call(pose, key))
        .join(" ")
    : "—";

  return { controls, movementMode, visibility, visualAlignment, payloadTransform, mappedExitTransform, local, poseFields };
}

function portalGeometry(writer, dbg, facts) {
  const { controls, movementMode, visibility, visualAlignment, payloadTransform, mappedExitTransform, local, poseFields } = facts;
  writer.text("p-location", dbg && dbg.location_id ? dbg.location_id : "—");
  writer.text("p-phase", controls.portal_transition_phase || "none");
  writer.text("p-center", vec3Label(controls.portal_center));
  writer.text("p-radius", fixed3(controls.portal_radius_m));
  writer.text("p-distance", fixed3(controls.portal_distance_m));
  writer.text("p-frame-id", controls.portal_frame_id || "—");
  writer.text("p-frame-forward", vec3Label(controls.portal_frame_forward));
  writer.text("p-frame-right", vec3Label(controls.portal_frame_right));
  writer.text(
    "p-frame-size",
    controls.portal_frame_width_m && controls.portal_frame_height_m
      ? `${fixed3(controls.portal_frame_width_m)} / ${fixed3(controls.portal_frame_height_m)}`
      : "—"
  );
  writer.text("p-trigger-depth", fixed3(controls.portal_trigger_depth_m));
  writer.text(
    "p-local",
    local && typeof local.x === "number" ? `${fixed3(local.x)}, ${fixed3(local.y)}, ${fixed3(local.z)}` : "—"
  );
  writer.text("p-plane-distance", fixed3(controls.portal_signed_plane_distance_m));
  writer.bool("p-inside-oval", controls.inside_oval_aperture);
  writer.bool("p-inside-volume", controls.inside_trigger_volume);
  writer.text(
    "p-crossing",
    controls.portal_entry_crossing_direction ||
      controls.portal_last_crossing_direction ||
      controls.portal_crossing_direction ||
      "—"
  );
}

function portalCrossing(writer, dbg, facts) {
  const { controls, movementMode, visibility, visualAlignment, payloadTransform, mappedExitTransform, local, poseFields } = facts;
  writer.text("p-linked-portal", controls.portal_linked_target_portal_id || "—");
  writer.text("p-target", controls.portal_target_location_id || "—");
  writer.bool("p-rearmed", controls.portal_trigger_rearmed);
  writer.bool("p-handshake", controls.return_handshake_ready || controls.portal_handshake_ready);
  writer.text("p-blocker", controls.portal_ready_blocker || "—");
  writer.text("p-visual-center", vec3Label(visualAlignment.visual_center));
  writer.bool("p-visual-aligned", visualAlignment.aligned);
  writer.text("p-move-dir", controls.movement_direction || "none");
  writer.text("p-facing", controls.facing_semantics || "still");
  writer.text("p-visible", visibility.visible_avatar_count === undefined ? "—" : String(visibility.visible_avatar_count));
  writer.bool("p-invariant", visibility.one_avatar_visible_invariant);
  writer.text("p-direction", dbg && dbg.last_handoff_direction ? dbg.last_handoff_direction : "—");
  writer.text("p-payload-pos", payloadTransform ? vec3Label(payloadTransform.position) : "—");
  writer.text("p-payload-yaw", payloadTransform ? fixed3(payloadTransform.rotation_y) : "—");
  writer.text("p-mapped-exit-pos", mappedExitTransform ? vec3Label(mappedExitTransform.position) : "—");
  writer.text("p-mapped-exit-yaw", mappedExitTransform ? fixed3(mappedExitTransform.rotation_y) : fixed3(controls.mapped_exit_yaw));
  writer.text("p-pose-fields", poseFields);
}

function portalDataset(writer, dbg, facts) {
  const { controls, movementMode, visibility, visualAlignment, payloadTransform, mappedExitTransform, local, poseFields } = facts;
  writer.attribute("data-active-location", dbg && dbg.location_id ? dbg.location_id : "");
  writer.attribute("data-portal-transition-phase", controls.portal_transition_phase || "none");
  writer.attribute("data-portal-center", vec3Label(controls.portal_center));
  writer.attribute("data-portal-radius", fixed3(controls.portal_radius_m));
  writer.attribute("data-portal-frame-id", controls.portal_frame_id || "");
  writer.attribute("data-portal-frame-forward", vec3Label(controls.portal_frame_forward));
  writer.attribute("data-portal-frame-right", vec3Label(controls.portal_frame_right));
  writer.attribute("data-portal-frame-size", `${fixed3(controls.portal_frame_width_m)},${fixed3(controls.portal_frame_height_m)}`);
  writer.attribute("data-portal-trigger-depth", fixed3(controls.portal_trigger_depth_m));
  writer.attribute("data-portal-local-coordinates", local && typeof local.x === "number" ? `${fixed3(local.x)},${fixed3(local.y)},${fixed3(local.z)}` : "");
  writer.attribute("data-portal-signed-plane-distance", fixed3(controls.portal_signed_plane_distance_m));
  writer.attribute("data-inside-oval-aperture", String(controls.inside_oval_aperture === true));
  writer.attribute("data-inside-trigger-volume", String(controls.inside_trigger_volume === true));
  writer.attribute("data-portal-crossing-direction", controls.portal_crossing_direction || "");
  writer.attribute("data-portal-entry-crossing-direction", controls.portal_entry_crossing_direction || "");
  writer.attribute("data-portal-traversal-mode", controls.portal_traversal_mode || "");
  writer.attribute("data-portal-allowed-entry-side", controls.portal_allowed_entry_side || "");
  writer.attribute("data-portal-current-entry-side", controls.portal_current_entry_side || "");
  writer.attribute("data-portal-entry-side-allowed", String(controls.portal_entry_side_allowed !== false));
  writer.attribute("data-portal-traversal-rejected-count", String(controls.portal_traversal_rejected_count || 0));
  writer.attribute("data-portal-transition-phase-history", Array.isArray(controls.portal_transition_phase_history) ? controls.portal_transition_phase_history.join(",") : "");
  writer.attribute("data-linked-target-portal", controls.portal_linked_target_portal_id || "");
  writer.attribute("data-portal-target-location", controls.portal_target_location_id || "");
  writer.attribute("data-portal-trigger-rearmed", String(controls.portal_trigger_rearmed === true));
  writer.attribute("data-portal-handshake-ready", String((controls.return_handshake_ready || controls.portal_handshake_ready) === true));
  writer.attribute("data-portal-ready-blocker", controls.portal_ready_blocker || "");
  writer.attribute("data-portal-visual-center", vec3Label(visualAlignment.visual_center));
  writer.attribute("data-portal-visual-aligned", String(visualAlignment.aligned === true));
  writer.attribute("data-movement-direction", controls.movement_direction || "none");
  writer.attribute("data-movement-mode", movementMode);
  writer.attribute("data-run-mode", String(controls.run_mode === true));
  writer.attribute("data-movement-speed-mps", fixed3(controls.speed_mps));
  writer.attribute("data-facing-semantics", controls.facing_semantics || "still");
  writer.attribute("data-visible-avatar-count", visibility.visible_avatar_count === undefined ? "" : String(visibility.visible_avatar_count));
  writer.attribute("data-one-avatar-invariant", String(visibility.one_avatar_visible_invariant === true));
  writer.attribute("data-handoff-direction", dbg && dbg.last_handoff_direction ? dbg.last_handoff_direction : "");
  writer.attribute("data-mapped-exit-position", mappedExitTransform ? vec3Label(mappedExitTransform.position) : "");
  writer.attribute("data-mapped-exit-yaw", mappedExitTransform ? fixed3(mappedExitTransform.rotation_y) : fixed3(controls.mapped_exit_yaw));
  writer.attribute("data-payload-pose-fields", poseFields);
}
export function createApplicationMotionPanel(writer) {
  return { render(debug, movementFacts) {
    renderMovement(writer, debug, movementFacts);
    const facts = portalFacts(debug);
    portalGeometry(writer, debug, facts); portalCrossing(writer, debug, facts); portalDataset(writer, debug, facts);
  } };
}
