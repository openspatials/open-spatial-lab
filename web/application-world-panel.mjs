import { fixed3, vec3Label } from "./application-debug-format.mjs";
function previewSourceCameraLabel(preview) {
  const rel = preview && preview.source_camera_relative_to_portal;
  const local = rel && rel.local_position;
  const forward = rel && rel.local_forward;
  return local
    ? `local=${fixed3(local.x)},${fixed3(local.y)},${fixed3(local.z)} f=${fixed3(forward && forward.x)},${fixed3(forward && forward.y)},${fixed3(forward && forward.z)}`
    : "—";
}
function previewTargetCameraLabel(preview) {
  const target = preview && preview.target_preview_camera_transform;
  return target && Array.isArray(target.position)
    ? `${vec3Label(target.position)} yaw=${fixed3(target.rotation_y)}`
    : "—";
}
function clientCard(writer, debug) {
  writer.text("c-mode", debug.client_mode || "—");
  writer.text("c-active", debug.active ? `${debug.active.endpoint_key} ${debug.active.location_id}` : "—");
  writer.text(
    "c-preview",
    debug.preview
      ? `${debug.preview.state} ${debug.preview.location_id || ""} ${debug.preview.source_type || ""} fresh=${debug.preview.freshness_ms ?? "—"}ms`
      : "—"
  );
  writer.text(
    "c-marker",
    debug.player_context_marker ? debug.player_context_marker.marker_id : "—"
  );
  writer.text(
    "c-camera",
    debug.camera ? `${debug.camera.mode} d=${debug.camera.follow_distance_m} h=${debug.camera.follow_height_m}` : "observer"
  );
  writer.text(
    "c-validation",
    debug.proof_boundary
      ? `native=${debug.proof_boundary.native_teleportxr_teleport} std=${debug.proof_boundary.standards_conformance}`
      : "—"
  );
}

function navigatorIdentity(writer, debug) {
  const nav = debug && debug.navigator ? debug.navigator : null;
  writer.text("n-context", nav ? nav.context_id || "—" : "—");
  writer.bool("n-single", nav ? nav.single_context === true : null);
  writer.text("n-status", nav ? nav.status || "—" : "—");
  writer.text(
    "n-root",
    nav && nav.root_fabric
      ? `${nav.root_fabric.container || nav.root_fabric.url || "—"} · ${nav.root_fabric.status || "—"}`
      : "—"
  );
  writer.text(
    "n-child",
    nav && nav.child_fabric
      ? `${nav.child_fabric.container || nav.child_fabric.url || "—"} · ${nav.child_fabric.status || "—"}`
      : "—"
  );
  writer.text(
    "n-fabrics",
    nav ? `${nav.fabrics_loaded_count || 0} in one context: ${(nav.fabrics_loaded || []).join(", ") || "—"}` : "—"
  );
  writer.text(
    "n-portal-node",
    nav && nav.portal_attachment
      ? `${nav.portal_attachment.node_id || "?"} bSubtype=${nav.portal_attachment.bSubtype} → ${
          nav.portal_attachment.sReference || "—"
        }`
      : "—"
  );
  writer.text(
    "n-spawn",
    nav && nav.spawn ? `${nav.spawn.source}${nav.spawn.applied ? "" : " (not applied)"}` : "—"
  );
}

function navigatorRendering(writer, debug) {
  const nav = debug && debug.navigator ? debug.navigator : null;
  writer.text(
    "n-child-render",
    nav && nav.child_render
      ? nav.child_render.active
        ? `active · ${nav.child_render.surface || "—"} · frames=${nav.child_render.frame_count || 0}`
        : `inactive · ${nav.child_render.reason || "—"}`
      : "—"
  );
  writer.text(
    "n-trust",
    nav && nav.root_fabric && nav.root_fabric.status === "loaded"
      ? `${nav.root_fabric.format || "plain-json"} · ${nav.root_fabric.signed ? "signed" : "UNSIGNED (labeled)"}`
      : "—"
  );
  const crossing = debug && debug.crossing ? debug.crossing : null;
  writer.text(
    "n-promotion",
    crossing && crossing.fabric_promotion
      ? `${crossing.fabric_promotion.demoted_root_container || "?"} → ${
          crossing.fabric_promotion.promoted_root_container || "?"
        } · ${crossing.phase}`
      : nav && nav.promotion_count
        ? `promotions=${nav.promotion_count}`
        : "none"
  );
  const marker = debug && debug.player_context_marker ? debug.player_context_marker : null;
  writer.bool(
    "n-marker-crossing",
    marker && typeof marker.same_marker_after_crossing === "boolean"
      ? marker.same_marker_after_crossing
      : null
  );
}

function previewCard(writer, debug) {
  const preview = debug && debug.preview ? debug.preview : null;
  writer.text("pr-source", preview ? preview.source_type || "none" : "—");
  writer.bool("pr-readonly", preview ? preview.readonly === true : null);
  writer.text(
    "pr-target",
    preview ? `${preview.location_id || "—"} · ${preview.target_portal_id || "—"}` : "—"
  );
  writer.text("pr-freshness", preview && preview.freshness_ms !== null ? `${Math.round(preview.freshness_ms)} ms` : "—");
  writer.text("pr-fallback", preview ? preview.fallback_reason || "—" : "—");
  writer.text(
    "pr-arrivals",
    preview
      ? `${preview.target_arrival_count_before_preview ?? "—"} → ${preview.target_arrival_count_current ?? "—"}`
      : "—"
  );
  writer.bool("pr-presence", preview ? preview.target_avatar_presence_created === true : null);
  writer.text("pr-mutations", preview ? String(preview.target_mutation_count_during_preview ?? "—") : "—");
  writer.text("pr-source-camera", previewSourceCameraLabel(preview));
  writer.text("pr-target-camera", previewTargetCameraLabel(preview));
  writer.text("pr-projection", preview ? preview.projection_frame_source || "—" : "—");
}

function geoPoseCoordinates(writer, dbg) {
  const gp = dbg && dbg.geopose_shaped_pose;
  const ypr = gp && gp.basic_ypr;
  const quat = gp && gp.basic_quaternion;
  const frame = gp && gp.frame_reference;
  const local = gp && gp.local_source_transform;
  const posLabel = (p) =>
    p ? `${fixed3(p.lat)}, ${fixed3(p.lon)}, ${fixed3(p.h)}` : "—";
  writer.text("gp-ypr-pos", ypr ? posLabel(ypr.position) : "—");
  writer.text(
    "gp-ypr-ang",
    ypr && ypr.angles
      ? `${fixed3(ypr.angles.yaw)}, ${fixed3(ypr.angles.pitch)}, ${fixed3(ypr.angles.roll)}`
      : "—"
  );
  writer.text(
    "gp-quat",
    quat && quat.quaternion
      ? `${fixed3(quat.quaternion.x)}, ${fixed3(quat.quaternion.y)}, ${fixed3(quat.quaternion.z)}, ${fixed3(quat.quaternion.w)}`
      : "—"
  );
  writer.text("gp-outer", frame ? frame.outer_frame : "—");
  writer.text("gp-inner", frame ? frame.inner_frame : "—");
  writer.text(
    "gp-local",
    local ? `${vec3Label(local.position)} · yaw ${fixed3(local.rotation_y_radians)}` : "—"
  );
}

function geoPoseScope(writer, dbg) {
  const gp = dbg && dbg.geopose_shaped_pose, ypr = gp && gp.basic_ypr;
  const conf = gp ? gp.ogc_geopose_conformance : null;
  const schemaValid = conf && typeof conf === "object" ? conf.basic_sdu_schema_valid === true : undefined;
  writer.bool("gp-schema-valid", schemaValid);
  writer.bool("gp-georef", gp ? gp.georeferenced === true : undefined);
  writer.text(
    "gp-conf",
    conf && typeof conf === "object"
      ? "Basic-YPR/Quaternion SDU schema-valid ✓ · georeferenced:false · NOT full GeoPose conformance"
      : gp
      ? String(conf)
      : "—"
  );
  const gpConfEl = writer.element("gp-conf");
  if (gpConfEl) {
    gpConfEl.classList.toggle("std-scoped-true", schemaValid === true);
  }
  writer.attribute(
    "data-geopose-shaped",
    gp
      ? "basic-sdu-schema-valid:true:georeferenced:false:full-conformance:false:standards_conformance=false"
      : ""
  );
  writer.attribute(
    "data-geopose-ypr-position",
    ypr && ypr.position ? `${ypr.position.lat},${ypr.position.lon},${ypr.position.h}` : ""
  );
}
export function createApplicationWorldPanel(writer) {
  return {
    render(debug) { clientCard(writer, debug); previewCard(writer, debug); navigatorIdentity(writer, debug); navigatorRendering(writer, debug); },
    renderGeoPose(debug) { geoPoseCoordinates(writer, debug); geoPoseScope(writer, debug); },
  };
}
