/** Renderer-owned ray tests and reversible wall/surface treatment. */
const roundedVec3 = values => values.map(value => Number(value.toFixed(3)));
export function createThreeCameraOcclusion({ THREE, runtime }) {
  let portalOcclusionDebug = null, cameraWallOcclusionDebug = null;
  let activeCameraWall = null, cameraWallClearFrames = 0, lastCameraWallRestoration = null;
  const cameraWallOriginals = new Map();
const CAMERA_WALL_HYSTERESIS_M = 0.08;
const PORTAL_APERTURE_SEGMENT_MARGIN_M = 0.6;
const PORTAL_APERTURE_PLANE_EPS_M = 0.02;
  function wallMaterialState(mesh) {
    const materials = Array.isArray(mesh && mesh.material) ? mesh.material : mesh && mesh.material ? [mesh.material] : [];
    return materials.map((material) => ({
      uuid: material.uuid || null,
      transparent: material.transparent === true,
      opacity: Number(material.opacity),
      depth_write: material.depthWrite !== false,
      depth_test: material.depthTest !== false,
      side: material.side ?? null,
      color: material.color && typeof material.color.getHexString === "function" ? material.color.getHexString() : null,
      emissive: material.emissive && typeof material.emissive.getHexString === "function" ? material.emissive.getHexString() : null,
    }));
  }

  function cameraWallIdentity(mesh) {
    if (!mesh) return null;
    mesh.updateMatrixWorld(true);
    const point = mesh.getWorldPosition(new THREE.Vector3());
    const normal = new THREE.Vector3(0, 0, 1)
      .applyMatrix3(new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld))
      .normalize();
    return mesh.name || `room-wall@${roundedVec3(point.toArray()).join(",")}:normal=${roundedVec3(normal.toArray()).join(",")}`;
  }

  function restoreCameraWallTreatment(reason) {
    const restored = [];
    for (const [mesh, original] of cameraWallOriginals) {
      mesh.visible = original.visible;
      restored.push({
        identity: original.identity,
        uuid: mesh.uuid || null,
        original_state: original,
        restored_state: { visible: mesh.visible, materials: wallMaterialState(mesh) },
      });
    }
    cameraWallOriginals.clear();
    activeCameraWall = null;
    cameraWallClearFrames = 0;
    if (restored.length) lastCameraWallRestoration = restored;
    return restored.length ? { reason, meshes: restored } : null;
  }

  function updateCameraWallOcclusion(
    position,
    target,
    cameraMode,
    { impl, wallCandidates = [], sceneId = null, worldId = null } = {},
  ) {
    const candidates = Array.from(new Set(wallCandidates.filter((mesh) => mesh && mesh.isMesh)));
    const previousActive = activeCameraWall;
    const previousOriginal = previousActive ? cameraWallOriginals.get(previousActive) : null;
    const previousClearFrames = cameraWallClearFrames;
    const restoredMeshes = [];
    for (const [mesh, original] of cameraWallOriginals) {
      mesh.visible = original.visible;
      restoredMeshes.push({
        identity: original.identity,
        uuid: mesh.uuid || null,
        original_state: original,
        restored_state: { visible: mesh.visible, materials: wallMaterialState(mesh) },
      });
    }
    cameraWallOriginals.clear();
    activeCameraWall = null;
    if (restoredMeshes.length) lastCameraWallRestoration = restoredMeshes;

    const base = {
      active: false,
      camera_mode: cameraMode || null,
      scene_id: sceneId || (impl && impl.scene ? impl.scene.uuid : null),
      world_id: worldId || null,
      candidate_count: candidates.length,
      restoration_frame_budget: 2,
      restored: restoredMeshes.length ? restoredMeshes : lastCameraWallRestoration,
      candidates: [],
      hit_wall: null,
      affected_meshes: [],
    };
    if (!impl || !impl.camera || !position || !target || !candidates.length) {
      cameraWallClearFrames = 0;
      return cameraWallOcclusionDebug = {
        ...base,
        reason: candidates.length ? "missing_scene_camera_or_focus" : "no_authored_room_walls",
      };
    }
    if (cameraMode !== "player_third_person") {
      cameraWallClearFrames = 0;
      return cameraWallOcclusionDebug = { ...base, reason: "camera_not_third_person" };
    }

    const origin = position.clone ? position.clone() : new THREE.Vector3(position.x, position.y, position.z);
    const focus = target.clone ? target.clone() : new THREE.Vector3(target.x, target.y, target.z);
    const segment = focus.clone().sub(origin);
    const segmentLength = segment.length();
    base.camera_position = roundedVec3(origin.toArray());
    base.focus_position = roundedVec3(focus.toArray());
    if (segmentLength <= 0.001) {
      cameraWallClearFrames = 0;
      return cameraWallOcclusionDebug = { ...base, reason: "degenerate_camera_focus_segment" };
    }

    if (!impl.cameraWallRaycaster) impl.cameraWallRaycaster = new THREE.Raycaster();
    const raycaster = impl.cameraWallRaycaster;
    raycaster.layers.mask = impl.camera.layers ? impl.camera.layers.mask : raycaster.layers.mask;
    raycaster.set(origin, segment.clone().normalize());
    raycaster.near = 0.001;
    raycaster.far = Math.max(0.001, segmentLength - 0.02);
    const eligible = candidates.filter((mesh) => mesh.visible !== false && mesh.layers.test(raycaster.layers));
    for (const mesh of eligible) mesh.updateMatrixWorld(true);
    const hits = raycaster.intersectObjects(eligible, false);
    const nearestHit = hits[0] || null;
    const hitObjects = new Set(hits.map((hit) => hit.object));
    let selectedHit = nearestHit;
    let reason = nearestHit ? "authored_wall_between_camera_and_focus" : "no_authored_wall_in_the_way";

    if (!nearestHit && previousActive && candidates.includes(previousActive) && previousOriginal?.visible !== false) {
      if (previousClearFrames < 1) {
        selectedHit = { object: previousActive, distance: null };
        reason = "one_frame_clear_hysteresis";
      }
    } else if (nearestHit && previousActive && hitObjects.has(previousActive)) {
      const previousHit = hits.find((hit) => hit.object === previousActive);
      if (previousHit && previousHit.distance <= nearestHit.distance + CAMERA_WALL_HYSTERESIS_M) selectedHit = previousHit;
    }

    base.hit_wall = nearestHit ? {
      identity: cameraWallIdentity(nearestHit.object),
      uuid: nearestHit.object.uuid || null,
      distance_m: Number(nearestHit.distance.toFixed(3)),
    } : null;
    base.candidates = candidates.map((mesh) => ({
      identity: cameraWallIdentity(mesh),
      uuid: mesh.uuid || null,
      visible: mesh.visible,
      blocking_hit: hitObjects.has(mesh),
      shared_material_count: candidates.filter((candidate) => candidate.material === mesh.material).length,
      materials: wallMaterialState(mesh),
    }));

    if (!selectedHit || !selectedHit.object) {
      cameraWallClearFrames = 0;
      return cameraWallOcclusionDebug = { ...base, reason };
    }

    const selected = selectedHit.object;
    const original = selected === previousActive && previousOriginal
      ? previousOriginal
      : {
          identity: cameraWallIdentity(selected),
          scene_id: sceneId || (impl && impl.scene ? impl.scene.uuid : null),
          world_id: worldId || null,
          visible: selected.visible,
          materials: wallMaterialState(selected),
        };
    cameraWallOriginals.set(selected, original);
    activeCameraWall = selected;
    cameraWallClearFrames = nearestHit ? 0 : previousClearFrames + 1;
    selected.visible = false;
    base.affected_meshes = [{
      identity: original.identity,
      uuid: selected.uuid || null,
      action: "visible_false",
      original_state: original,
      current_state: { visible: selected.visible, materials: wallMaterialState(selected) },
      hit_distance_m: selectedHit.distance == null ? null : Number(selectedHit.distance.toFixed(3)),
    }];
    return cameraWallOcclusionDebug = { ...base, active: true, reason };
  }

  function updatePortalOcclusion(
    position,
    target,
    cameraMode,
    { impl, candidates = [], wallCandidates = [], sceneId = null, worldId = null } = {},
  ) {
    updateCameraWallOcclusion(position, target, cameraMode, {
      impl,
      wallCandidates,
      sceneId,
      worldId,
    });
    const restore = () => {
      for (const mesh of candidates) mesh.visible = mesh.userData.portalSurfaceWanted !== false;
    };
    if (!impl || !impl.camera || !position || !target || !candidates.length) {
      restore();
      return portalOcclusionDebug = {
        active: false,
        reason: "missing_scene_camera_or_portal_surfaces",
        camera_mode: cameraMode || null,
        candidate_count: candidates.length,
        surfaces: [],
      };
    }
    if (cameraMode !== "player_third_person") {
      restore();
      return portalOcclusionDebug = {
        active: false,
        reason: "camera_not_detached_from_avatar",
        camera_mode: cameraMode || null,
        candidate_count: candidates.length,
        surfaces: [],
      };
    }
    const origin = position.clone ? position.clone() : new THREE.Vector3(position.x, position.y, position.z);
    const focus = target.clone ? target.clone() : new THREE.Vector3(target.x, target.y, target.z);
    const capabilities = runtime();
    const avatar = capabilities && capabilities.state ? capabilities.state.avatar : null;
    const avatarPoint = avatar && Array.isArray(avatar.position)
      ? new THREE.Vector3(Number(avatar.position[0]) || 0, Number(avatar.position[1]) || 0, Number(avatar.position[2]) || 0)
      : focus.clone();
    const segment = focus.clone().sub(origin);
    const segmentLength = segment.length();
    if (!impl.portalApertureRaycaster) impl.portalApertureRaycaster = new THREE.Raycaster();
    const raycaster = impl.portalApertureRaycaster;
    raycaster.layers.mask = impl.camera.layers ? impl.camera.layers.mask : raycaster.layers.mask;
    const normalMatrix = new THREE.Matrix3();
    const surfaces = [];
    let suppressedAny = false;
    for (const mesh of candidates) {
      const wanted = mesh.userData.portalSurfaceWanted !== false;
      mesh.visible = wanted;
      if (!wanted || segmentLength <= 0.001) {
        surfaces.push({ name: mesh.name || "unnamed", wanted, suppressed: false, reason: "not_wanted_or_degenerate_segment" });
        continue;
      }
      mesh.updateMatrixWorld(true);
      const planePoint = mesh.getWorldPosition(new THREE.Vector3());
      const normal = new THREE.Vector3(0, 0, 1).applyMatrix3(normalMatrix.getNormalMatrix(mesh.matrixWorld)).normalize();
      const cameraDistance = origin.clone().sub(planePoint).dot(normal);
      const avatarDistance = avatarPoint.clone().sub(planePoint).dot(normal);
      const cameraSide = Math.abs(cameraDistance) < PORTAL_APERTURE_PLANE_EPS_M ? 0 : Math.sign(cameraDistance);
      const avatarSide = Math.abs(avatarDistance) < PORTAL_APERTURE_PLANE_EPS_M ? -cameraSide : Math.sign(avatarDistance);
      const separates = cameraSide !== 0 && avatarSide !== 0 && cameraSide !== avatarSide;
      let suppressed = false;
      if (separates) {
        raycaster.set(origin, segment.clone().normalize());
        raycaster.far = segmentLength + PORTAL_APERTURE_SEGMENT_MARGIN_M;
        if (raycaster.intersectObject(mesh, false).length) {
          mesh.visible = false;
          suppressed = true;
          suppressedAny = true;
        }
      }
      surfaces.push({
        name: mesh.name || "unnamed",
        wanted,
        suppressed,
        camera_signed_distance_m: Number(cameraDistance.toFixed(3)),
        avatar_signed_distance_m: Number(avatarDistance.toFixed(3)),
        plane_separates_camera_from_player: separates,
      });
    }
    return portalOcclusionDebug = {
      active: suppressedAny,
      reason: suppressedAny ? "portal_surface_between_camera_and_player" : "no_portal_surface_in_the_way",
      camera_mode: cameraMode || null,
      candidate_count: candidates.length,
      camera_position: roundedVec3(origin.toArray()),
      focus_position: roundedVec3(focus.toArray()),
      avatar_position: roundedVec3(avatarPoint.toArray()),
      surfaces,
    };
  }

  return { updatePortalOcclusion, restoreCameraWallTreatment, portalState: () => portalOcclusionDebug, wallState: () => cameraWallOcclusionDebug };
}
