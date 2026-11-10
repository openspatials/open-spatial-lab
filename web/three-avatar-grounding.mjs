/** Sole/bone measurements and visual grounding stay with the evaluated renderer rig. */
const GROUNDING_FOOT_BONES = Object.freeze(["leftFoot", "rightFoot", "leftToes", "rightToes"]);
export function createThreeAvatarGrounding({ THREE, avatarLayers, logLine }) {
  const groundingCalibrationByModel = new Map();
  const groundingProbe = new THREE.Vector3();
  const groundingMatrix = new THREE.Matrix4();
  let groundingDebug = { active: false, mode: "none", model_offset_y_m: 0, residual_m: null };
  function calibrateAvatarGrounding(layer, model) {
    const rig = layer.avatarRig;
    const rigScale = rig.scale.y || 1;
    const modelScale = model.scale && model.scale.y ? model.scale.y : 1;
    const calibration = { soleLocalY: null, boneBind: [], model_scale_y: modelScale };
    try {
      const box = new THREE.Box3().setFromObject(model);
      if (Number.isFinite(box.min.y)) calibration.soleLocalY = (box.min.y - rig.position.y) / rigScale - model.position.y;
    } catch {}
    try {
      const vrm = layer.vrm;
      if (vrm && vrm.humanoid && typeof vrm.humanoid.getRawBoneNode === "function") {
        const meshes = [];
        model.traverse((node) => {
          if (node.isSkinnedMesh && node.skeleton && Array.isArray(node.skeleton.bones)) meshes.push(node);
        });
        for (const boneName of GROUNDING_FOOT_BONES) {
          const bone = vrm.humanoid.getRawBoneNode(boneName);
          if (!bone) continue;
          for (const mesh of meshes) {
            const index = mesh.skeleton.bones.indexOf(bone);
            if (index >= 0 && mesh.skeleton.boneInverses[index]) {
              groundingMatrix.copy(mesh.skeleton.boneInverses[index]).invert();
              calibration.boneBind.push({ bone, bindLocalY: groundingMatrix.elements[13] });
              break;
            }
          }
        }
      }
    } catch {}
    groundingCalibrationByModel.set(model.uuid, calibration);
    logLine(`grounding: avatar sole calibrated (bind sole ${calibration.soleLocalY === null ? "n/a" : calibration.soleLocalY.toFixed(3) + " m"}, ${calibration.boneBind.length} foot/toe bones tracked)`);
    return calibration;
  }

  function groundLayerVisualFeet(layer, deltaSeconds, publishDebug) {
    if (!layer || !layer.avatarRig || !layer._avatarModel || !layer.avatarRig.visible) return;
    const rig = layer.avatarRig;
    const model = layer._avatarModel;
    const calibration = groundingCalibrationByModel.get(model.uuid) || calibrateAvatarGrounding(layer, model);
    if (!calibration || calibration.soleLocalY === null) return;
    const locomotion = layer.avatar && layer.avatar.locomotion ? layer.avatar.locomotion : {};
    const renderedSurfaceY = Number(locomotion.rendered_surface_y_m);
    const logicalGroundY = Number(locomotion.logical_ground_y_m);
    const targetGroundY = Number.isFinite(renderedSurfaceY) ? renderedSurfaceY : rig.position.y;
    const airborne = layer.status && layer.status.avatar_grounded === false;
    const rigScale = rig.scale.y || 1;
    const modelScale = model.scale && model.scale.y ? model.scale.y : calibration.model_scale_y || 1;
    const soleBindWorldY = rig.position.y + rigScale * (model.position.y + calibration.soleLocalY);
    let animationLift = 0;
    let mode = "bind_pose_sole";
    if (calibration.boneBind.length) {
      let nowMin = Infinity;
      let bindMin = Infinity;
      for (const entry of calibration.boneBind) {
        entry.bone.getWorldPosition(groundingProbe);
        if (groundingProbe.y < nowMin) nowMin = groundingProbe.y;
        const bindWorldY = rig.position.y + rigScale * (model.position.y + modelScale * entry.bindLocalY);
        if (bindWorldY < bindMin) bindMin = bindWorldY;
      }
      if (Number.isFinite(nowMin) && Number.isFinite(bindMin)) {
        animationLift = nowMin - bindMin;
        mode = "bind_sole_plus_animated_feet";
      }
    }
    const error = (targetGroundY - (soleBindWorldY + animationLift)) / rigScale;
    if (!Number.isFinite(error)) return;
    const authoritativeAirportSurface = locomotion.ground_resolver_source === "airport_terminal.walkable_surfaces";
    const gain = airborne
      ? 0
      : authoritativeAirportSurface || Math.abs(error) > 0.35
        ? 1
        : Math.min(1, (Number(deltaSeconds) || 0.016) * 10);
    if (!airborne && Math.abs(error) > 0.0005) model.position.y += error * gain;
    const measuredSoleY = soleBindWorldY + animationLift + error * gain * rigScale;
    model.getWorldPosition(groundingProbe);
    if (publishDebug) groundingDebug = {
      active: true,
      mode,
      airborne,
      avatar_variant: layer.status?.avatar_variant || null,
      render_source: layer.status?.avatar_render_source || null,
      model_uuid: model.uuid,
      resolver_source: locomotion.ground_resolver_source || "avatar_rig_world_y",
      ground_surface_id: locomotion.ground_surface_id || null,
      query_xz_m: Array.isArray(locomotion.ground_query_xz_m) ? locomotion.ground_query_xz_m.slice(0, 2) : null,
      logical_ground_y_m: Number.isFinite(logicalGroundY) ? logicalGroundY : targetGroundY,
      logical_avatar_y_m: Number(rig.position.y.toFixed(4)),
      rendered_surface_y_m: Number(targetGroundY.toFixed(4)),
      measured_sole_y_m: Number(measuredSoleY.toFixed(4)),
      rig_root_y_m: Number(rig.position.y.toFixed(4)),
      model_world_y_m: Number(groundingProbe.y.toFixed(4)),
      model_offset_y_m: Number(model.position.y.toFixed(4)),
      residual_m: Number((measuredSoleY - targetGroundY).toFixed(4)),
      anim_lift_m: Number(animationLift.toFixed(4)),
      tracked_foot_bones: calibration.boneBind.length,
    };
  }

  function groundAvatarVisualFeet(deltaSeconds) {
    const layers = avatarLayers();
    groundLayerVisualFeet(layers.local, deltaSeconds, true);
    for (const layer of layers.peers) groundLayerVisualFeet(layer, deltaSeconds, false);
  }

  return { step: groundAvatarVisualFeet, debug: () => ({ ...groundingDebug }), reset(mode) { groundingCalibrationByModel.clear(); groundingDebug = { active: false, mode, model_offset_y_m: 0, residual_m: null }; } };
}
