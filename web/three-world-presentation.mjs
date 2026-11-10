/** Renderer-owned presentation; shared state arrives through plain runtime descriptions. */
import * as THREE from "./vendor/scene-core/vendor/three/three.module.js";
import { hexColorFromFabricBackground, buildChildFabricGroup, buildRootFabricNodeVisuals, CHILD_FABRIC_LAYER } from "./three-fabric-presentation.mjs";

export function createThreeWorldPresentation({ getScene, getRuntime, isPlayer, logLine }) {
function disposePrefetchRing(ring) {
  ring.removeFromParent();
  ring.geometry.dispose();
  ring.material.dispose();
}

function ensureFabricPrefetchZoneRing(dbg) {
  const scene = getScene();
  if (!scene || scene.rendererKind !== "webgl") return;
  const impl = scene._impl;
  if (!impl || !impl.scene) return;
  const fp = dbg ? dbg.fabric_prefetch : null;
  let ring = impl.scene.getObjectByName("fabric-prefetch-zone-ring");
  const controls = dbg ? dbg.controls || {} : {};
  const center = Array.isArray(controls.portal_center) ? controls.portal_center : null;
  const radius =
    fp && fp.supported && fp.zones && fp.zones.prefetch
      ? Number(fp.zones.prefetch.radius_m) || 0
      : 0;
  if (!fp || !center || !(radius > 0)) {
    if (ring) ring.visible = false;
    ensureAdditionalFabricPrefetchZoneRings(impl, dbg);
    return;
  }
  if (ring && ring.userData.radius_m !== radius) {
    disposePrefetchRing(ring);
    ring = null;
  }
  if (!ring) {
    const segments = 96;
    const points = [];
    for (let i = 0; i <= segments; i += 1) {
      const a = (i / segments) * Math.PI * 2;
      points.push(new THREE.Vector3(Math.cos(a) * radius, 0.03, Math.sin(a) * radius));
    }
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    ring = new THREE.Line(
      geometry,
      new THREE.LineBasicMaterial({ color: 0x59c8ff, transparent: true, opacity: 0.55 })
    );
    ring.name = "fabric-prefetch-zone-ring";
    ring.userData.radius_m = radius;
    impl.scene.add(ring);
  }
  ring.position.set(center[0], 0, center[2]);
  ring.visible = true;
  ring.material.color.setHex(
    fp.status === "warm" ? 0x46d18a : fp.zone && fp.zone.inside ? 0xffcc55 : 0x59c8ff
  );
  ensureAdditionalFabricPrefetchZoneRings(impl, dbg);
}

function ensureAdditionalFabricPrefetchZoneRings(impl, dbg) {
  const scene = getScene();
  if (!impl.additionalFabricZoneRings) impl.additionalFabricZoneRings = {};
  const fp = dbg ? dbg.fabric_prefetch : null;
  const keyed = fp && fp.keyed ? fp.keyed : null;
  const machines = keyed && keyed.machines ? keyed.machines : {};
  const controls = dbg ? dbg.controls || {} : {};
  const portalSummaries = Array.isArray(controls.portals) ? controls.portals : [];
  const focusKey = keyed ? keyed.focus_portal_id : null;
  const wanted = new Set();
  for (const key of Object.keys(machines)) {
    if (key === focusKey) continue;
    const machine = machines[key];
    if (!machine || !machine.supported || !machine.zones || !machine.zones.prefetch) continue;
    const summary = portalSummaries.find((p) => p && p.portal_id === key);
    const ringCenter = summary && Array.isArray(summary.center) ? summary.center : null;
    const ringRadius = Number(machine.zones.prefetch.radius_m) || 0;
    if (!ringCenter || !(ringRadius > 0)) continue;
    wanted.add(key);
    let ring = impl.additionalFabricZoneRings[key];
    if (ring && ring.userData.radius_m !== ringRadius) {
      disposePrefetchRing(ring);
      ring = null;
    }
    if (!ring) {
      const segments = 96;
      const points = [];
      for (let i = 0; i <= segments; i += 1) {
        const a = (i / segments) * Math.PI * 2;
        points.push(new THREE.Vector3(Math.cos(a) * ringRadius, 0.03, Math.sin(a) * ringRadius));
      }
      ring = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(points),
        new THREE.LineBasicMaterial({ color: 0x59c8ff, transparent: true, opacity: 0.55 })
      );
      ring.name = `fabric-prefetch-zone-ring--${key}`;
      ring.userData.radius_m = ringRadius;
      impl.scene.add(ring);
      impl.additionalFabricZoneRings[key] = ring;
    }
    ring.position.set(ringCenter[0], 0, ringCenter[2]);
    ring.visible = true;
    ring.material.color.setHex(
      machine.status === "warm" ? 0x46d18a : machine.zone && machine.zone.inside ? 0xffcc55 : 0x59c8ff
    );
  }
  for (const key of Object.keys(impl.additionalFabricZoneRings)) {
    if (wanted.has(key)) continue;
    const stale = impl.additionalFabricZoneRings[key];
    if (stale) disposePrefetchRing(stale);
    delete impl.additionalFabricZoneRings[key];
  }
}

function setupWorldNavigatorRender() {
  const scene = getScene();
  const adapter = getRuntime();
  if (!isPlayer || !scene || !adapter || typeof adapter.setChildFabricRenderState !== "function") return;
  const impl = scene._impl;
  const navigatorDebug = adapter.debugState().navigator || null;
  if (impl && impl.scene && scene.rendererKind === "webgl" && navigatorDebug) {
    buildRootFabricNodeVisuals(impl, navigatorDebug);
  }
  const manifest = typeof adapter.childFabricManifest === "function" ? adapter.childFabricManifest() : null;
  if (!manifest) {
    adapter.setChildFabricRenderState({ active: false, reason: "child_fabric_not_loaded" });
    return;
  }
  if (scene.rendererKind !== "webgl" || !impl || !impl.scene || !impl.renderer) {
    adapter.setChildFabricRenderState({
      active: false,
      reason: `renderer_is_${scene.rendererKind}; child fabric loaded in-context but labeled placeholder shown`,
    });
    return;
  }
  if (!impl.directionalPortalAperture) {
    adapter.setChildFabricRenderState({ active: false, reason: "standing_oval_aperture_unavailable" });
    return;
  }

  const attachment = navigatorDebug && navigatorDebug.portal_attachment ? navigatorDebug.portal_attachment : {};
  const childInfo = navigatorDebug && navigatorDebug.child_fabric ? navigatorDebug.child_fabric : {};
  const childPortal = childInfo.child_portal_node && Array.isArray(childInfo.child_portal_node.position)
    ? childInfo.child_portal_node.position.slice(0, 3)
    : [2.8, 0, -2.8];
  const childSpawn = childInfo.child_spawn_node && Array.isArray(childInfo.child_spawn_node.position)
    ? childInfo.child_spawn_node.position.slice(0, 3)
    : [-0.4, 0, -2.8];
  const dirRaw = [childSpawn[0] - childPortal[0], 0, childSpawn[2] - childPortal[2]];
  const dirLen = Math.hypot(dirRaw[0], dirRaw[2]) || 1;
  const dir = [dirRaw[0] / dirLen, 0, dirRaw[2] / dirLen];
  const right = [dir[2], 0, -dir[0]];
  const portalYaw = Math.atan2(dir[0], dir[2]);

  const childIsLocationA = String(childInfo.container || "").toLowerCase() === "location-a";
  const group = buildChildFabricGroup(manifest, {
    url: childInfo.url || null,
    attachedAtNodeId: attachment.node_id || null,
    portalYaw,
    labelPosition: [childSpawn[0], 0, childSpawn[2]],
    accent: childIsLocationA ? 0x3aa0ff : 0xff7a3a,
    accentFill: childIsLocationA ? 0x2bd4ff : 0xffb14d,
    accentCss: childIsLocationA ? "#2bd4ff" : "#ffb14d",
    suppressReturnPortal: true,
  });
  impl.scene.add(group);

  const renderTarget = new THREE.WebGLRenderTarget(768, 768, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
  });
  if ("SRGBColorSpace" in THREE) renderTarget.texture.colorSpace = THREE.SRGBColorSpace;
  const frame = adapter.world && adapter.world.portal ? adapter.world.portal.frame : null;
  const apertureAspect =
    frame && Number(frame.width_m) > 0 && Number(frame.height_m) > 0
      ? Number(frame.width_m) / Number(frame.height_m)
      : 1.8 / 2.8;
  const camera = new THREE.PerspectiveCamera(62, apertureAspect, 0.05, 60);
  camera.layers.set(CHILD_FABRIC_LAYER);
  impl.childFabricRender = {
    active: true,
    group,
    renderTarget,
    camera,
    material: new THREE.MeshBasicMaterial({
      map: renderTarget.texture,
      side: THREE.DoubleSide,
      toneMapped: false,
      transparent: true,
      opacity: 0.96,
    }),
    clearColor: new THREE.Color(
      hexColorFromFabricBackground(manifest.primary ? manifest.primary.background : null)
    ),
    anchor: { portal: childPortal, spawn: childSpawn, dir, right },
    camera_source: "child_fabric_portal_node->child_spawn_node (source-camera parallax)",
  };
  adapter.setChildFabricRenderState({
    active: true,
    surface: "standing_oval_aperture_mesh",
    render_kind: "webgl_render_target",
    texture_size: 768,
    layer: CHILD_FABRIC_LAYER,
    single_scene: true,
    scene_shared_with_root: true,
    camera_source: impl.childFabricRender.camera_source,
    attached_at_portal_node: attachment.node_id || null,
    attachment_transform_position: attachment.transform_position || null,
    group_name: group.name,
  });
  logLine(
    `world-navigator: child fabric '${childInfo.container || "?"}' attached at portal node ` +
      `${attachment.node_id || "?"} (bSubtype 255); aperture now renders the live child-fabric texture`
  );
}
return { ensureFabricPrefetchZoneRing, setupWorldNavigatorRender };
}
