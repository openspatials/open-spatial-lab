/** Renderer-owned presentation; shared state arrives through plain runtime descriptions. */
import * as THREE from "./vendor/scene-core/vendor/three/three.module.js";
import { fabricPortalKey as appPortalKey } from "./live-adapter-portal-geometry.mjs";
import { imageLayerFlipForViewerSide, portalPerimeterLiveGate, portalSharedEdgeIdentity, portalViewerSide } from "./portal-spatial-preview.mjs?v=meeting-critical-destination";
import { ensurePortalPreviewTexture, drawPrefetchedRegionPreview, drawLabeledPortalPreview, isLivePreviewSourceType } from "./three-preview-canvas.mjs";

export function createThreePortalSurfaces({ getScene, getRuntime, getSceneRuntime, syncPortalRing, isPlayer, logLine }) {
let primaryEdgeMismatchLogged = false;
function ackFabricChunksRendered(portalKey, fp) {
  const adapter = getRuntime();
  try {
    if (!portalKey || !adapter || typeof adapter.notifyFabricChunkRendered !== "function") return;
    const region = fp && fp.region ? fp.region : null;
    const chunkCount = region && Array.isArray(region.chunks) ? region.chunks.length : 0;
    if (chunkCount > 0) adapter.notifyFabricChunkRendered(portalKey, chunkCount);
  } catch (e) {
    
  }
}

function previewCameraWorldPosition(impl) {

  if (!impl || !impl.camera || typeof impl.camera.getWorldPosition !== "function") return null;
  const v = impl.camera.getWorldPosition(new THREE.Vector3());
  return [v.x, v.y, v.z];
}

function applyPortalImageLayerFlip(texture, viewerSide) {

  const flip = imageLayerFlipForViewerSide(viewerSide);
  if (texture && texture.repeat && texture.offset) {
    texture.repeat.x = flip.repeat_x;
    texture.offset.x = flip.offset_x;
  }
  return flip;
}

function worldPortalEntryForKey(key) {
  const adapter = getRuntime();
  if (!adapter || !adapter.world || !key) return null;
  const entries =
    Array.isArray(adapter.world.portals) && adapter.world.portals.length
      ? adapter.world.portals
      : adapter.world.portal
        ? [adapter.world.portal]
        : [];
  for (const entry of entries) {
    if (appPortalKey(entry) === key) return entry;
  }
  return null;
}

function trySpatialApertureSurface(portalKey, machine, apertureMesh) {
  const sceneRuntimeController = getSceneRuntime();
  if (!sceneRuntimeController || !portalKey || !apertureMesh) return null;
  const entry = worldPortalEntryForKey(portalKey);
  if (!entry || (!machine && !entry.wow_resource)) return null;
  const surface = sceneRuntimeController.portalSurface(portalKey, machine, entry);
  if (!surface) return null;
  apertureMesh.material = surface.material;
  apertureMesh.position.z = 0.012;
  syncPortalRing(portalKey, entry, surface);

  if (machine) ackFabricChunksRendered(portalKey, machine);
  return surface;
}

function updatePortalPreviewSurface(debug) {

  const primary = updatePrimaryPortalPreviewSurface(debug);
  const additional = updateAdditionalPortalPreviewSurfaces(debug);
  if (primary && additional.length) primary.additional_portals = additional;
  return primary;
}

function updateAdditionalPortalPreviewSurfaces(debug) {
  const scene = getScene();
  if (!isPlayer || !scene || !debug) return [];
  const impl = scene._impl;
  if (!impl || scene.rendererKind !== "webgl" || !impl.additionalPortalGroups) return [];
  const keyedMachines =
    debug.fabric_prefetch && debug.fabric_prefetch.keyed && debug.fabric_prefetch.keyed.machines
      ? debug.fabric_prefetch.keyed.machines
      : {};
  const portalPreviews = debug.portal_previews || {};
  const cameraPosition = previewCameraWorldPosition(impl);
  const results = [];
  for (const key of Object.keys(impl.additionalPortalGroups)) {
    const rec = impl.additionalPortalGroups[key];
    if (!rec || !rec.aperture) continue;
    if (!rec.previewCanvas) {
      rec.previewCanvas = document.createElement("canvas");
      rec.previewCanvas.width = 1024;
      rec.previewCanvas.height = 1024;
      rec.previewTexture = new THREE.CanvasTexture(rec.previewCanvas);
      if ("SRGBColorSpace" in THREE) rec.previewTexture.colorSpace = THREE.SRGBColorSpace;
      rec.previewTexture.minFilter = THREE.LinearFilter;
      rec.previewTexture.magFilter = THREE.LinearFilter;
      rec.previewMaterial = new THREE.MeshBasicMaterial({
        map: rec.previewTexture,
        transparent: true,
        opacity: 0.96,
        side: THREE.DoubleSide,
      });
    }
    
    const machine = keyedMachines[key] || null;
    const entry = worldPortalEntryForKey(key);
    const liveGate = portalPerimeterLiveGate(machine);
    const viewerSide = cameraPosition && entry ? portalViewerSide(cameraPosition, entry) : null;

    const spatialSurface = trySpatialApertureSurface(key, machine, rec.aperture);
    if (spatialSurface) {
      results.push({
        portal_key: key,
        surface: "standing_oval_aperture_mesh",
        source_type: "prefetched_region_spatial_render",
        region_backed: true,
        target_location_id: rec.targetLocationId || null,
        live_gate: liveGate,
        viewer_side: viewerSide,
        spatial_render: spatialSurface.debug,
      });
      continue;
    }
    const preview =
      portalPreviews[key] || {
        source_type: "target_static_placeholder_labeled",
        location_id: rec.targetLocationId || "destination",
        target_portal_id: null,
      };

    const regionBacked = !(entry && entry.wow_resource) && !!(
      machine &&
      (machine.status === "warm" ||
        machine.status === "cooling" ||
        (machine.status === "loading" && machine.region && machine.region.streaming)) &&
      machine.region &&
      Array.isArray(machine.region.entities)
    );
    const imageSignature = [
      regionBacked ? "region" : "label",
      preview.source_type || "",
      preview.location_id || "",
      machine?.status || "",
      machine?.region?.loaded_at_ms || "",
      machine?.region?.chunks?.length || 0,
      machine?.region?.entities?.length || 0,
    ].join("|");
    if (imageSignature !== rec.previewImageSignature) {
      rec.previewImageSignature = imageSignature;
      if (regionBacked) {
        drawPrefetchedRegionPreview(rec.previewCanvas, preview, machine);
        ackFabricChunksRendered(key, machine);
      } else {
        drawLabeledPortalPreview(rec.previewCanvas, preview);
      }
      rec.previewTexture.needsUpdate = true;
    }
    rec.aperture.material = rec.previewMaterial;
    rec.aperture.position.z = 0.012;

    const imageFlip = applyPortalImageLayerFlip(rec.previewTexture, viewerSide);
    results.push({
      portal_key: key,
      surface: "standing_oval_aperture_mesh",
      source_type: regionBacked
        ? "prefetched_region_snapshot_labeled"
        : preview.source_type || "target_static_placeholder_labeled",
      region_backed: regionBacked,
      target_location_id: rec.targetLocationId || preview.location_id || null,

      live_gate: liveGate,
      viewer_side: viewerSide,
      
      image_layer: imageFlip,
    });
  }
  return results;
}

function updatePrimaryPortalPreviewSurface(debug) {
  const scene = getScene();
  const adapter = getRuntime();
  if (!isPlayer || !scene || !debug || !debug.preview) return null;
  const impl = scene._impl;
  if (!impl || scene.rendererKind !== "webgl" || !impl.directionalPortalAperture) {
    document.body.setAttribute("data-portal-preview-surface-active", "false");
    document.body.setAttribute("data-portal-preview-surface", "");
    return {
      active: false,
      renderer_kind: scene ? scene.rendererKind : "none",
      reason: "portal_preview_requires_webgl_oval_aperture",
    };
  }
  const bundle = ensurePortalPreviewTexture(impl);
  if (!bundle) {
    document.body.setAttribute("data-portal-preview-surface-active", "false");
    document.body.setAttribute("data-portal-preview-surface", "");
    return { active: false, renderer_kind: scene.rendererKind, reason: "portal_preview_aperture_missing" };
  }

  const keyedForPrimary =
    debug.fabric_prefetch && debug.fabric_prefetch.keyed && debug.fabric_prefetch.keyed.machines
      ? debug.fabric_prefetch.keyed.machines
      : null;
  const primaryEntryKey =
    adapter && adapter.world && adapter.world.portal ? appPortalKey(adapter.world.portal) : null;
  const primaryMachine =
    keyedForPrimary && primaryEntryKey && keyedForPrimary[primaryEntryKey]
      ? keyedForPrimary[primaryEntryKey]
      : debug.fabric_prefetch || null;

  const primaryEdge = portalSharedEdgeIdentity(
    primaryMachine,
    adapter && adapter.world ? adapter.world.portal : null
  );
  document.body.setAttribute("data-portal-edge-id", (primaryEdge && primaryEdge.edge_id) || "");
  document.body.setAttribute(
    "data-portal-edge-verified",
    primaryEdge && primaryEdge.available ? String(primaryEdge.verified === true) : ""
  );
  document.body.setAttribute(
    "data-portal-edge-reason",
    primaryEdge && !primaryEdge.available
      ? primaryEdge.reason || ""
      : primaryEdge && primaryEdge.verified !== true
        ? (primaryEdge.failures || []).join(",")
        : ""
  );
  if (primaryEdge && primaryEdge.available && primaryEdge.verified !== true && !primaryEdgeMismatchLogged) {
    primaryEdgeMismatchLogged = true;
    logLine(
      `portal identity: WARNING — adopted pose does not belong to this portal's edge ` +
        `(${(primaryEdge.failures || []).join(", ")}; expected ${primaryEdge.expected_edge_id})`
    );
  }

  const primaryLiveGate = portalPerimeterLiveGate(primaryMachine);
  const primaryViewerSide = portalViewerSide(
    previewCameraWorldPosition(impl),
    adapter && adapter.world ? adapter.world.portal : null
  );
  document.body.setAttribute("data-portal-perimeter-live", String(primaryLiveGate.live === true));
  document.body.setAttribute("data-portal-perimeter-reason", primaryLiveGate.reason || "");
  document.body.setAttribute(
    "data-portal-perimeter-inside",
    primaryLiveGate.inside == null ? "" : String(primaryLiveGate.inside)
  );
  document.body.setAttribute(
    "data-portal-perimeter-distance-m",
    primaryLiveGate.distance_m == null ? "" : String(primaryLiveGate.distance_m)
  );
  document.body.setAttribute(
    "data-portal-perimeter-radius-m",
    primaryLiveGate.radius_m == null ? "" : String(primaryLiveGate.radius_m)
  );
  document.body.setAttribute(
    "data-portal-perimeter-exit-radius-m",
    primaryLiveGate.exit_radius_m == null ? "" : String(primaryLiveGate.exit_radius_m)
  );
  document.body.setAttribute(
    "data-portal-viewer-side",
    primaryViewerSide && primaryViewerSide.side ? primaryViewerSide.side : ""
  );
  const spatialSurface = trySpatialApertureSurface(primaryEntryKey, primaryMachine, bundle.aperture);
  if (spatialSurface) {
    if (bundle.labelSprite) bundle.labelSprite.visible = false;

    document.body.setAttribute("data-portal-image-layer-active", "false");
    document.body.setAttribute("data-portal-preview-surface-active", "true");
    document.body.setAttribute("data-portal-preview-surface", "standing_oval_aperture_mesh");
    document.body.setAttribute("data-portal-preview-source-type", "prefetched_region_spatial_render");
    return {
      active: true,
      renderer_kind: scene.rendererKind,
      surface: "standing_oval_aperture_mesh",
      source_type: "prefetched_region_spatial_render",
      render_source: "prefetched_region_spatial_render_target",
      region_backed: true,
      fallback_labeled: false,
      readonly: debug.preview.readonly === true,
      target_location_id:
        (adapter.world.portal && adapter.world.portal.target_location_id) ||
        debug.preview.location_id ||
        null,
      target_portal_id: debug.preview.target_portal_id || null,
      fed_by_fabric_prefetch: true,
      live_gate: primaryLiveGate,
      viewer_side: primaryViewerSide,
      spatial_render: spatialSurface.debug,
    };
  }

  if (impl.childFabricRender && impl.childFabricRender.active) {
    bundle.aperture.material = impl.childFabricRender.material;
    bundle.aperture.position.z = 0.012;
    if (bundle.labelSprite) bundle.labelSprite.visible = false;

    document.body.setAttribute("data-portal-image-layer-active", "false");
    document.body.setAttribute("data-portal-preview-surface-active", "true");
    document.body.setAttribute("data-portal-preview-surface", "standing_oval_aperture_mesh");
    document.body.setAttribute("data-portal-preview-source-type", debug.preview.source_type || "");
    return {
      active: true,
      renderer_kind: scene.rendererKind,
      surface: "standing_oval_aperture_mesh",
      source_type: debug.preview.source_type,
      render_source: "child_fabric_render_target",
      child_fabric_url: debug.preview.child_fabric_url || null,
      fallback_labeled: false,
      readonly: debug.preview.readonly === true,
      target_location_id: debug.preview.location_id || null,
      target_portal_id: debug.preview.target_portal_id || null,

      fed_by_fabric_prefetch: !!(
        debug.fabric_prefetch &&
        debug.fabric_prefetch.status === "warm" &&
        debug.fabric_prefetch.region &&
        debug.fabric_prefetch.region.totals
      ),

      live_gate: primaryLiveGate,
      viewer_side: primaryViewerSide,
    };
  }

  const fabricPrefetch = debug.fabric_prefetch || null;

  const regionBacked = !(adapter && adapter.world && adapter.world.portal && adapter.world.portal.wow_resource) && !!(
    fabricPrefetch &&
    (fabricPrefetch.status === "warm" ||
      fabricPrefetch.status === "cooling" ||
      (fabricPrefetch.status === "loading" &&
        fabricPrefetch.region &&
        fabricPrefetch.region.streaming)) &&
    fabricPrefetch.region &&
    Array.isArray(fabricPrefetch.region.entities)
  );
  const imageSignature = [
    regionBacked ? "region" : "label",
    debug.preview.source_type || "",
    debug.preview.location_id || "",
    fabricPrefetch?.status || "",
    fabricPrefetch?.region?.loaded_at_ms || "",
    fabricPrefetch?.region?.chunks?.length || 0,
    fabricPrefetch?.region?.entities?.length || 0,
  ].join("|");

  if (imageSignature !== impl.portalPreviewImageSignature) {
    impl.portalPreviewImageSignature = imageSignature;
    if (regionBacked) {
      drawPrefetchedRegionPreview(bundle.canvas, debug.preview, fabricPrefetch);
      ackFabricChunksRendered(fabricPrefetch.portal_key, fabricPrefetch);
    } else {
      drawLabeledPortalPreview(bundle.canvas, debug.preview);
    }
    bundle.texture.needsUpdate = true;
  }
  bundle.aperture.material = bundle.material;
  bundle.aperture.position.z = 0.012;
  if (bundle.labelSprite) bundle.labelSprite.visible = false;

  const primaryImageFlip = applyPortalImageLayerFlip(bundle.texture, primaryViewerSide);
  document.body.setAttribute("data-portal-image-layer-active", "true");
  document.body.setAttribute("data-portal-image-flip", String(primaryImageFlip.mirrored === true));
  document.body.setAttribute("data-portal-image-legible", String(primaryImageFlip.legible_on_viewed_face === true));
  const effectiveSourceType = regionBacked
    ? "prefetched_region_snapshot_labeled"
    : debug.preview.source_type;
  document.body.setAttribute("data-portal-preview-surface-active", "true");
  document.body.setAttribute("data-portal-preview-surface", "standing_oval_aperture_mesh");
  document.body.setAttribute("data-portal-preview-source-type", effectiveSourceType || "");
  return {
    active: true,
    renderer_kind: scene.rendererKind,
    surface: "standing_oval_aperture_mesh",
    source_type: effectiveSourceType,
    fallback_labeled: !isLivePreviewSourceType(effectiveSourceType),
    region_backed: regionBacked,
    readonly: debug.preview.readonly === true,
    target_location_id: debug.preview.location_id || null,
    target_portal_id: debug.preview.target_portal_id || null,

    live_gate: primaryLiveGate,
    viewer_side: primaryViewerSide,
    
    image_layer: primaryImageFlip,
  };
}
return { updatePortalPreviewSurface };
}
