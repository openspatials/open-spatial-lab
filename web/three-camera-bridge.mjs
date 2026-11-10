/** Adapts camera arrays and completed-rig measurements to three.js objects. */
import { createThreeCameraOcclusion } from "./three-camera-occlusion.mjs";
import { createThreeAvatarGrounding } from "./three-avatar-grounding.mjs";
export function createThreeCameraBridge({ THREE, sceneRuntime, getAvatarLayers, getRuntime, logLine = () => {} }) {
  const avatarLayers = () => { const layers = getAvatarLayers(); return { local: layers.local, peers: Array.from(layers.peers || []) }; };
  const occlusion = createThreeCameraOcclusion({ THREE, runtime: getRuntime });
  const grounding = createThreeAvatarGrounding({ THREE, avatarLayers, logLine });
  let lastScene = null, mountToken = 0;
  function setCameraTransform(camera, position, target) {
    if (!camera || !camera.position || typeof camera.lookAt !== "function") return null;
    camera.position.set(position.x, position.y, position.z);
    camera.lookAt(target);
    if (typeof camera.updateProjectionMatrix === "function") camera.updateProjectionMatrix();
    const quaternion = camera.quaternion;
    return quaternion
      ? [quaternion.x, quaternion.y, quaternion.z, quaternion.w].map((entry) => Number(entry.toFixed(6)))
      : [0, 0, 0, 1];
  }

  function syncPeerLayerCameras(position, target, up = null) {
    for (const layer of avatarLayers().peers) {
      if (!layer || !layer.camera) continue;
      if (up && layer.camera.up) layer.camera.up.copy(up);
      setCameraTransform(layer.camera, position, target);
    }
  }

  function avatarHeadWorldPosition() {
    const layer = avatarLayers().local;
    if (!layer || !layer.avatarRig) return null;
    const vrm = layer.vrm;
    try {
      const bone =
        (vrm && vrm.humanoid && typeof vrm.humanoid.getRawBoneNode === "function" && vrm.humanoid.getRawBoneNode("head")) ||
        (vrm && vrm.humanoid && typeof vrm.humanoid.getNormalizedBoneNode === "function" && vrm.humanoid.getNormalizedBoneNode("head")) ||
        null;
      if (bone && typeof bone.getWorldPosition === "function") return bone.getWorldPosition(new THREE.Vector3());
    } catch {}
    const rig = layer.avatarRig;
    return new THREE.Vector3(rig.position.x, rig.position.y + 1.55 * (rig.scale.y || 1), rig.position.z);
  }

  function syncFirstPersonAvatarVisibility(mode) {
    const layer = avatarLayers().local;
    if (!layer || !layer._avatarModel) return;
    const visible = mode !== "first_person";
    if (layer._avatarModel.visible !== visible) layer._avatarModel.visible = visible;
  }


  function measure() {
    const layers = avatarLayers();
    const host = sceneRuntime.avatarHost?.();
    if (host?.scene !== lastScene) { lastScene = host?.scene; mountToken += 1; }
    return {
      mountToken, rigHosted: !!host?.scene && layers.local?.avatarRig?.parent === host.scene,
      head: avatarHeadWorldPosition()?.toArray() || null,
      equipment: layers.local?.debugState?.() || null,
      sceneCameraPosition: host?.camera?.position?.toArray() || null,
      avatarCameraPosition: layers.local?.camera?.position?.toArray() || null,
    };
  }
  function apply({ position, target, up = [0, 1, 0] }) {
    const layers = avatarLayers();
    const host = sceneRuntime.avatarHost?.();
    const p = new THREE.Vector3(...position), t = new THREE.Vector3(...target), u = new THREE.Vector3(...up);
    const quaternions = [];
    for (const camera of [layers.local?.camera, host?.camera]) {
      if (camera?.up) camera.up.copy(u);
      const quaternion = setCameraTransform(camera, p, t);
      if (quaternion) quaternions.push(quaternion);
    }
    syncPeerLayerCameras(p, t, u);
    return quaternions;
  }
  return Object.freeze({ measure, apply, setAvatarVisibility: syncFirstPersonAvatarVisibility,
    applyDocumentPosition(position) { sceneRuntime.avatarHost()?.camera?.position.fromArray(position); },
    ground: grounding.step, groundingState: grounding.debug, resetGrounding: grounding.reset,
    updatePortalOcclusion(position, target, mode, options) {
      return occlusion.updatePortalOcclusion(Array.isArray(position) ? new THREE.Vector3(...position) : position,
        Array.isArray(target) ? new THREE.Vector3(...target) : target, mode, options);
    },
    restoreCameraWallTreatment: occlusion.restoreCameraWallTreatment,
    portalOcclusionState: occlusion.portalState, cameraWallOcclusionState: occlusion.wallState,
    dispose() { occlusion.restoreCameraWallTreatment("controller_disposed"); grounding.reset("disposed"); },
  });
}
