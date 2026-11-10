/** Three.js presentation of plain world/preview descriptions. */
import * as THREE from "./vendor/scene-core/vendor/three/three.module.js";
import { ringColorsOf } from "./worlds-list.mjs";
import { fabricPortalKey as appPortalKey } from "./live-adapter-portal-geometry.mjs";

export function alignPortalVisualToTrigger(sceneInstance, world) {
  const portal = world && world.portal;
  const frame = portal && portal.frame;
  const trigger = portal && portal.trigger;
  const center = frame && Array.isArray(frame.position)
    ? frame.position.slice(0, 3)
    : trigger && Array.isArray(trigger.position)
      ? trigger.position.slice(0, 3)
      : null;
  const radius = trigger ? Number(trigger.radius_m || 0) : 0;
  if (!sceneInstance || !center || !frame) {
    return { aligned: false, reason: "missing_scene_or_portal_frame" };
  }
  const impl = sceneInstance._impl;
  if (!impl || !impl.scene) {
    return {
      aligned: false,
      renderer_kind: sceneInstance.rendererKind,
      trigger_center: center,
      radius_m: radius,
      frame,
      reason: "portal_visual_not_addressable",
    };
  }
  if (sceneInstance.rendererKind !== "webgl" || !impl.scene) {
    return {
      aligned: false,
      renderer_kind: sceneInstance.rendererKind,
      trigger_center: center,
      radius_m: radius,
      frame,
      reason: "standing_oval_requires_webgl_scene_access",
    };
  }
  if (impl.portalGroup) impl.portalGroup.visible = false;
  const { color, fill: fillColor } = ringColorsOf(world && world.location_id);
  if (!impl.directionalPortalGroup) {
    impl.directionalPortalGroup = new THREE.Group();
    impl.directionalPortalGroup.name = "directional-standing-oval-portal";
    const ringMat = new THREE.MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: 0.72,
      roughness: 0.32,
      metalness: 0.24,
    });
    const ring = new THREE.Mesh(new THREE.TorusGeometry(1, 0.075, 18, 80), ringMat);
    ring.name = "standing-oval-ring";
    impl.directionalPortalGroup.add(ring);
    const apertureMat = new THREE.MeshBasicMaterial({
      color: fillColor,
      transparent: true,
      opacity: 0.16,
      side: THREE.DoubleSide,
    });
    const aperture = new THREE.Mesh(new THREE.CircleGeometry(0.92, 72), apertureMat);
    aperture.name = "standing-oval-aperture";
    // the aperture fill is always WANTED; only the
    // camera/player occlusion gate may subtract it (see
    // updatePortalApertureOcclusion).
    aperture.userData.portalSurfaceWanted = true;
    impl.directionalPortalGroup.add(aperture);
    impl.directionalPortalAperture = aperture;
    const horizon = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(-0.62, 0, 0.01),
        new THREE.Vector3(0.62, 0, 0.01),
      ]),
      new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35 })
    );
    horizon.name = "portal-frame-right-axis";
    impl.directionalPortalGroup.add(horizon);
    impl.scene.add(impl.directionalPortalGroup);
  }
  // the direction ArrowHelper ("portal-forward-debug-arrow")
  // is not used — direction is expressed by the portal
  // data itself (traversal rule) and, for one-way portals, by the opaque
  // blocked side below. A stale arrow from a pre-removal scene graph is
  // dropped defensively so recomposed scenes can never resurrect it.
  if (impl.directionalPortalArrow) {
    if (impl.scene && typeof impl.scene.remove === "function") {
      impl.scene.remove(impl.directionalPortalArrow);
    }
    impl.directionalPortalArrow = null;
  }
  if (!impl.directionalPortalAperture && impl.directionalPortalGroup && typeof impl.directionalPortalGroup.getObjectByName === "function") {
    impl.directionalPortalAperture = impl.directionalPortalGroup.getObjectByName("standing-oval-aperture");
  }
  // the blocked side of a one-way portal is VISIBLY
  // OPAQUE. A separate single-sided disc renders only toward the blocked
  // half-space (CircleGeometry normals face local +Z = frame "front", so
  // BackSide shows the disc only to viewers on the "back" half-space and
  // FrontSide only to the "front"), while the allowed side keeps the normal
  // translucent aperture + preview ladder untouched. Hidden entirely on
  // bidirectional portals.
  if (!impl.directionalPortalBlockedPanel && impl.directionalPortalGroup) {
    const blockedPanel = new THREE.Mesh(
      new THREE.CircleGeometry(0.98, 72),
      new THREE.MeshBasicMaterial({ color: 0x11162a, side: THREE.BackSide })
    );
    blockedPanel.name = "standing-oval-aperture-blocked-side";
    blockedPanel.visible = false;
    impl.directionalPortalGroup.add(blockedPanel);
    impl.directionalPortalBlockedPanel = blockedPanel;
  }
  const traversal = portal && portal.traversal ? portal.traversal : null;
  const oneWay = !!(traversal && traversal.mode === "one_way");
  const blockedSide = oneWay ? traversal.blocked_entry_side || "back" : null;
  if (impl.directionalPortalBlockedPanel) {
    impl.directionalPortalBlockedPanel.visible = oneWay;
    // blocked panel is WANTED exactly when the
    // portal is one-way. The occlusion gate may only subtract it — and it only
    // does so for a camera it is standing BETWEEN and the player, i.e. for
    // someone who has already come through. A player who has NOT crossed sees
    // it from the same side as their own avatar, so it stays opaque for them.
    impl.directionalPortalBlockedPanel.userData.portalSurfaceWanted = oneWay;
    if (oneWay) {
      impl.directionalPortalBlockedPanel.position.z = blockedSide === "front" ? 0.02 : -0.02;
      impl.directionalPortalBlockedPanel.material.side =
        blockedSide === "front" ? THREE.FrontSide : THREE.BackSide;
    }
  }
  const forward = Array.isArray(frame.forward) ? frame.forward : [0, 0, 1];
  const yaw = Math.atan2(Number(forward[0]) || 0, Number(forward[2]) || 0);
  impl.directionalPortalGroup.visible = true;
  impl.directionalPortalGroup.position.set(center[0], center[1], center[2]);
  impl.directionalPortalGroup.rotation.set(0, yaw, 0);
  impl.directionalPortalGroup.scale.set(
    Math.max(0.001, Number(frame.width_m || 1.8) / 2),
    Math.max(0.001, Number(frame.height_m || 2.8) / 2),
    1
  );
  if (typeof impl.directionalPortalGroup.updateMatrixWorld === "function") impl.directionalPortalGroup.updateMatrixWorld(true);
  const visualCenter = [
    Number(impl.directionalPortalGroup.position.x.toFixed(3)),
    Number(impl.directionalPortalGroup.position.y.toFixed(3)),
    Number(impl.directionalPortalGroup.position.z.toFixed(3)),
  ];
  const aligned =
    Math.abs(visualCenter[0] - Number(center[0] || 0)) <= 0.002 &&
    Math.abs(visualCenter[1] - Number(center[1] || 0)) <= 0.002 &&
    Math.abs(visualCenter[2] - Number(center[2] || 0)) <= 0.002;
  // ADDITIONAL portals (N>1 worlds — the lobby). The
  // PRIMARY portal above keeps its node names and impl
  // singletons; every additional
  // portal gets its own standing-oval group — same ring/aperture/blocked-side
  // recipe, node names suffixed with the portal key, tinted by DESTINATION
  // (A = cyan, B = amber). Stale groups are pruned when the world changes.
  const portalList =
    world && Array.isArray(world.portals) && world.portals.length ? world.portals : [portal];
  if (!impl.additionalPortalGroups) impl.additionalPortalGroups = {};
  const wantedKeys = new Set();
  const additionalPortals = [];
  for (let index = 1; index < portalList.length; index += 1) {
    const entry = portalList[index];
    const entryKey = appPortalKey(entry);
    const entryFrame = entry && entry.frame;
    if (!entry || !entryFrame || !entryKey) continue;
    wantedKeys.add(entryKey);
    let rec = impl.additionalPortalGroups[entryKey];
    const { color: entryColor, fill: entryFill } = ringColorsOf(entry.target_location_id);
    if (!rec) {
      const group = new THREE.Group();
      group.name = `directional-standing-oval-portal--${entryKey}`;
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(1, 0.075, 18, 80),
        new THREE.MeshStandardMaterial({
          color: entryColor,
          emissive: entryColor,
          emissiveIntensity: 0.72,
          roughness: 0.32,
          metalness: 0.24,
        })
      );
      ring.name = `standing-oval-ring--${entryKey}`;
      group.add(ring);
      const aperture = new THREE.Mesh(
        new THREE.CircleGeometry(0.92, 72),
        new THREE.MeshBasicMaterial({
          color: entryFill,
          transparent: true,
          opacity: 0.16,
          side: THREE.DoubleSide,
        })
      );
      aperture.name = `standing-oval-aperture--${entryKey}`;
      aperture.userData.portalSurfaceWanted = true;
      group.add(aperture);
      const blockedPanel = new THREE.Mesh(
        new THREE.CircleGeometry(0.98, 72),
        new THREE.MeshBasicMaterial({ color: 0x11162a, side: THREE.BackSide })
      );
      blockedPanel.name = `standing-oval-aperture-blocked-side--${entryKey}`;
      blockedPanel.visible = false;
      blockedPanel.userData.portalSurfaceWanted = false;
      group.add(blockedPanel);
      impl.scene.add(group);
      rec = { group, aperture, blockedPanel };
      impl.additionalPortalGroups[entryKey] = rec;
    }
    rec.targetLocationId = entry.target_location_id || null;
    const entryTraversal = entry.traversal || null;
    const entryOneWay = !!(entryTraversal && entryTraversal.mode === "one_way");
    const entryBlockedSide = entryOneWay ? entryTraversal.blocked_entry_side || "back" : null;
    rec.blockedPanel.visible = entryOneWay;
    rec.blockedPanel.userData.portalSurfaceWanted = entryOneWay;
    if (entryOneWay) {
      rec.blockedPanel.position.z = entryBlockedSide === "front" ? 0.02 : -0.02;
      rec.blockedPanel.material.side =
        entryBlockedSide === "front" ? THREE.FrontSide : THREE.BackSide;
    }
    const entryCenter = Array.isArray(entryFrame.position)
      ? entryFrame.position
      : entry.trigger && Array.isArray(entry.trigger.position)
        ? entry.trigger.position
        : [0, 0, 0];
    const entryForward = Array.isArray(entryFrame.forward) ? entryFrame.forward : [0, 0, 1];
    const entryYaw = Math.atan2(Number(entryForward[0]) || 0, Number(entryForward[2]) || 0);
    rec.group.visible = true;
    rec.group.position.set(entryCenter[0], entryCenter[1], entryCenter[2]);
    rec.group.rotation.set(0, entryYaw, 0);
    rec.group.scale.set(
      Math.max(0.001, Number(entryFrame.width_m || 1.8) / 2),
      Math.max(0.001, Number(entryFrame.height_m || 2.8) / 2),
      1
    );
    if (typeof rec.group.updateMatrixWorld === "function") rec.group.updateMatrixWorld(true);
    additionalPortals.push({
      portal_key: entryKey,
      target_location_id: entry.target_location_id || null,
      visual_center: [
        Number(rec.group.position.x.toFixed(3)),
        Number(rec.group.position.y.toFixed(3)),
        Number(rec.group.position.z.toFixed(3)),
      ],
      traversal_mode: entryTraversal ? entryTraversal.mode : "bidirectional",
      one_way: entryOneWay,
      blocked_entry_side: entryBlockedSide,
      blocked_panel_visible: rec.blockedPanel.visible,
      aligned:
        Math.abs(rec.group.position.x - Number(entryCenter[0] || 0)) <= 0.002 &&
        Math.abs(rec.group.position.z - Number(entryCenter[2] || 0)) <= 0.002,
    });
  }
  for (const staleKey of Object.keys(impl.additionalPortalGroups)) {
    if (wantedKeys.has(staleKey)) continue;
    const stale = impl.additionalPortalGroups[staleKey];
    if (stale && stale.group && impl.scene && typeof impl.scene.remove === "function") {
      impl.scene.remove(stale.group);
    }
    delete impl.additionalPortalGroups[staleKey];
  }
  return {
    aligned,
    // N-portal evidence beside the primary's alignment.
    portal_count: portalList.length,
    additional_portals: additionalPortals,
    renderer_kind: sceneInstance.rendererKind,
    trigger_center: center,
    legacy_trigger_center: trigger && trigger.position ? trigger.position.slice(0, 3) : null,
    visual_center: visualCenter,
    visual_forward: frame.forward,
    radius_m: radius,
    oval_width_m: Number(frame.width_m || 0),
    oval_height_m: Number(frame.height_m || 0),
    trigger_depth_m: Number(frame.trigger_depth_m || 0),
    linked_target_portal_id: frame.linked_target_portal_id,
    frame,
    visual_kind: "standing_oval_webgl",
    horizontal_ring_hidden: !impl.portalGroup || impl.portalGroup.visible === false,
    // traversal-direction affordance evidence, read from
    // the LIVE scene graph (not echoed config) so the e2e proves the arrow is
    // gone and the one-way blocked side actually renders opaque.
    traversal_mode: traversal ? traversal.mode : "bidirectional",
    one_way: oneWay,
    blocked_entry_side: blockedSide,
    blocked_panel_visible: !!(
      impl.directionalPortalBlockedPanel && impl.directionalPortalBlockedPanel.visible
    ),
    blocked_panel_opaque: !!(
      impl.directionalPortalBlockedPanel &&
      impl.directionalPortalBlockedPanel.material &&
      impl.directionalPortalBlockedPanel.material.transparent !== true
    ),
    direction_arrow_node_present: !!(
      impl.scene &&
      typeof impl.scene.getObjectByName === "function" &&
      impl.scene.getObjectByName("portal-forward-debug-arrow")
    ),
    reason: aligned ? "standing_oval_aligned_to_portal_frame" : "visual_center_mismatch",
  };
}
