// the crossing heading/basis reframe reuses the ONE
// canonical crossing-camera recipe (proper 180° portal rotation) — never a
// local transcription of it.
import {
  crossingYawDeltaRad,
  mapCameraAcrossCrossing,
  normalizeYawRad,
} from "./live-adapter-portal-geometry.mjs";

export { crossingYawDeltaRad, normalizeYawRad } from "./live-adapter-portal-geometry.mjs";

const CONTROL_KEY_MAP = Object.freeze({
  KeyW: "forward",
  KeyS: "back",
  KeyA: "left",
  KeyD: "right",
  Space: "jump",
});
const RUN_KEY_CODES = new Set(["ShiftLeft", "ShiftRight"]);

const PLAYER_CAMERA_DEFAULT = Object.freeze({
  mode: "orbit_follow",
  distance_m: 3.5,
  min_distance_m: 1.6,
  max_distance_m: 8,
  polar_rad: 0.22,
  min_polar_rad: -0.12,
  max_polar_rad: 1.25,
  look_target_height_m: 1.35,
  orbit_speed_rad_per_px: 0.0052,
  zoom_speed: 0.0022,
  damping_per_s: 14,
  responsiveness_ms: 200,
});

const FIRST_PERSON_CAMERA = Object.freeze({
  eye_up_m: 0.09,
  eye_forward_m: 0.12,
  min_polar_rad: -1.25,
  max_polar_rad: 1.25,
});

const SERVER_VIEW_CAMERA = Object.freeze({
  room_half_extent_m: 6,
  top_down_height_m: 14.5,
  third_person_position: Object.freeze([0, 8.6, 12.6]),
  follow_damping_per_s: 10,
  look_target_height_m: 1,
});

const GROUNDING_FOOT_BONES = Object.freeze(["leftFoot", "rightFoot", "leftToes", "rightToes"]);
const PORTAL_APERTURE_PLANE_EPS_M = 0.02;
const PORTAL_APERTURE_SEGMENT_MARGIN_M = 0.6;
const CAMERA_WALL_HYSTERESIS_M = 0.08;

/**
 * validate source-owned movement/camera continuity.
 * The traversal controller creates the mapping from the packet's traversed
 * edge. This historical seam recomputes expected values only to verify
 * them; it never replaces, synthesizes, or translates mapping values.
 */
export function reframeCrossingCameraMapping({
  detail,
  frameMapping,
  entryTransform,
  cameraTransform,
  lookTargetHeightM = PLAYER_CAMERA_DEFAULT.look_target_height_m,
} = {}) {
  const record = {
    kind: detail && detail.kind ? detail.kind : null,
    applied: false,
    changed: false,
    synthesized: false,
    validated: false,
    reason: null,
    crossing_yaw_delta_rad: null,
    source_portal_id: null,
    target_portal_id: null,
    pre_reframe_forward_yaw_rad: null,
    reframed_forward_yaw_rad: null,
    position_correction_m: null,
    focus_correction_m: null,
    forward_correction_deg: null,
    movement_basis_correction_deg: null,
    identity_match: false,
  };
  if (!detail || detail.kind !== "world_navigator_composition_crossing") {
    record.reason = "not_a_composition_crossing";
    return record;
  }
  const sourceFrame = frameMapping ? frameMapping.source_portal_frame : null;
  const targetFrame = frameMapping ? frameMapping.target_portal_frame : null;
  const deltaYaw = crossingYawDeltaRad(sourceFrame, targetFrame);
  if (deltaYaw === null) {
    record.reason = "traversed_edge_frames_unavailable";
    return record;
  }
  record.crossing_yaw_delta_rad = Number(deltaYaw.toFixed(6));
  record.source_portal_id = sourceFrame.portal_id || null;
  record.target_portal_id = targetFrame.portal_id || null;
  const exitPose = detail.exit_pose || null;
  const headingContinuity = detail.heading_continuity || null;
  if (
    !headingContinuity ||
    headingContinuity.source_portal_id !== record.source_portal_id ||
    headingContinuity.target_portal_id !== record.target_portal_id
  ) {
    record.reason = "source_heading_continuity_unavailable";
    return record;
  }
  const entryPosition = entryTransform && Array.isArray(entryTransform.position)
    ? entryTransform.position
    : null;
  const exitPosition = exitPose && Array.isArray(exitPose.position) ? exitPose.position : null;
  if (!entryPosition || !exitPosition) {
    record.reason = "entry_or_exit_pose_unavailable";
    return record;
  }
  const remapped = cameraTransform
    ? mapCameraAcrossCrossing({
        sourceFrame,
        targetFrame,
        cameraTransform,
        avatarEntryPosition: entryPosition,
        avatarEntryYaw: Number(entryTransform.rotation_y) || 0,
        avatarExitPosition: exitPosition,
        avatarExitYaw: Number(exitPose.rotation_y) || 0,
        lookTargetHeightM,
      })
    : null;
  if (!remapped) {
    record.reason = "no_entry_camera_transform";
    return record;
  }
  record.reframed_forward_yaw_rad = Number(
    Math.atan2(Number(remapped.forward[0]) || 0, Number(remapped.forward[2]) || 0).toFixed(6),
  );
  const mapping = detail.camera_mapping;
  if (
    !mapping ||
    !Array.isArray(mapping.position) ||
    !Array.isArray(mapping.focus) ||
    !Array.isArray(mapping.forward) ||
    !Array.isArray(mapping.movement_basis_forward)
  ) {
    record.reason = "source_camera_mapping_unavailable";
    return record;
  }
  record.pre_reframe_forward_yaw_rad = Number(
    Math.atan2(Number(mapping.forward[0]) || 0, Number(mapping.forward[2]) || 0).toFixed(6),
  );
  record.position_correction_m = Number(Math.hypot(
    Number(mapping.position[0]) - Number(remapped.position[0]),
    Number(mapping.position[1]) - Number(remapped.position[1]),
    Number(mapping.position[2]) - Number(remapped.position[2]),
  ).toFixed(6));
  record.focus_correction_m = Number(Math.hypot(
    Number(mapping.focus[0]) - Number(remapped.focus[0]),
    Number(mapping.focus[1]) - Number(remapped.focus[1]),
    Number(mapping.focus[2]) - Number(remapped.focus[2]),
  ).toFixed(6));
  const forwardLength = Math.max(1e-9, Math.hypot(...mapping.forward.slice(0, 3).map(Number)));
  const expectedForwardLength = Math.max(1e-9, Math.hypot(...remapped.forward.slice(0, 3).map(Number)));
  const forwardDot = mapping.forward.slice(0, 3).reduce(
    (sum, value, index) => sum + Number(value) * Number(remapped.forward[index]),
    0,
  ) / (forwardLength * expectedForwardLength);
  record.forward_correction_deg = Number(
    (Math.acos(Math.max(-1, Math.min(1, forwardDot))) * 180 / Math.PI).toFixed(6),
  );
  const basisLength = Math.max(1e-9, Math.hypot(...mapping.movement_basis_forward.slice(0, 3).map(Number)));
  const basisDot = mapping.movement_basis_forward.slice(0, 3).reduce(
    (sum, value, index) => sum + Number(value) * Number(remapped.forward[index]),
    0,
  ) / (basisLength * expectedForwardLength);
  record.movement_basis_correction_deg = Number(
    (Math.acos(Math.max(-1, Math.min(1, basisDot))) * 180 / Math.PI).toFixed(6),
  );
  record.identity_match =
    mapping.frame_source === "packet.avatar_context.portal_frame_transform" &&
    mapping.source_portal_id === record.source_portal_id &&
    mapping.target_portal_id === record.target_portal_id;
  record.changed =
    !record.identity_match ||
    record.position_correction_m > 0.05 ||
    record.focus_correction_m > 0.05 ||
    record.forward_correction_deg > 1 ||
    record.movement_basis_correction_deg > 1 ||
    Math.abs(normalizeYawRad(
      Number(headingContinuity.crossing_yaw_delta_rad) - Number(record.crossing_yaw_delta_rad),
    )) > Math.PI / 180;
  if (record.changed) {
    record.reason = "source_mapping_mismatch";
    return record;
  }
  record.validated = true;
  record.reason = "source_mapping_validated";
  return record;
}

/**
 * Owns the browser movement/input loop and all player/server camera policy.
 * Scene, adapter, avatar, session, and panel state remain in their injected
 * canonical owners; this controller only consumes their narrow capabilities.
 */
export function createMovementCameraController({
  THREE,
  isPlayer,
  role,
  windowTarget,
  documentTarget,
  lookup,
  requestFrame,
  cancelFrame,
  now,
  getRuntime,
  sceneRuntime,
  getAvatarLayers,
  resolveClientSceneLoadTraversal,
  persistPlayerSession,
  refreshViewMatch,
  renderOrientation,
  refreshDebugProjection,
  updateMovementProjection,
  applyPortalOcclusion,
  logLine,
  showToast,
  isTypingTarget,
  motionPreference = null,
}) {
  const controlState = { forward: false, back: false, left: false, right: false, jump: false };
  const runModifierKeys = new Set();
  const crossingSuppressedKeyCodes = new Set();
  const movementDebug = {
    previousAvatarKey: null,
    previousPosition: null,
    lastDelta: [0, 0, 0],
    lastKeyEvent: "none",
  };
  const orbitCamera = {
    azimuth: 0,
    polar: PLAYER_CAMERA_DEFAULT.polar_rad,
    distance: PLAYER_CAMERA_DEFAULT.distance_m,
    targetAzimuth: 0,
    targetPolar: PLAYER_CAMERA_DEFAULT.polar_rad,
    targetDistance: PLAYER_CAMERA_DEFAULT.distance_m,
    dragging: false,
    lastX: 0,
    lastY: 0,
    focus: null,
    focusInitialized: false,
  };
  const playerCameraMode = { mode: "third_person" };
  const serverViewCamera = { mode: "third_person", focus: null, focusInitialized: false };
  const groundingCalibrationByModel = new Map();
  const groundingProbe = new THREE.Vector3();
  const groundingMatrix = new THREE.Matrix4();
  let groundingDebug = { active: false, mode: "none", model_offset_y_m: 0, residual_m: null };
  let playerCameraDebug = null;
  let portalOcclusionDebug = null;
  let cameraWallOcclusionDebug = null;
  let activeCameraWall = null;
  let cameraWallClearFrames = 0;
  let lastCameraWallRestoration = [];
  const cameraWallOriginals = new Map();
  let playerGroundedLastTick = null;
  let pendingRestoredCameraSeed = null;
  let pendingFirstPersonCrossingMapping = null;
  let firstPersonCrossingCorrectionLocal = null;
  let firstPersonCrossingCorrectionWorld = null;
  let autoHandoffStarted = false;
  let frameHandle = null;
  let lastControlAt = 0;
  let started = false;
  let disposed = false;
  let cameraModeButton = null;
  let serverViewModeButton = null;
  let sceneMount = null;
  const globalListeners = [];
  const mountListeners = [];

  const runtime = () => (typeof getRuntime === "function" ? getRuntime() : null);
  const avatarLayers = () => {
    const value = typeof getAvatarLayers === "function" ? getAvatarLayers() : null;
    return {
      local: value && value.local ? value.local : null,
      peers: value && value.peers ? Array.from(value.peers) : [],
    };
  };
  const addListener = (target, type, listener, options, collection = globalListeners) => {
    if (!target || typeof target.addEventListener !== "function") return;
    target.addEventListener(type, listener, options);
    collection.push({ target, type, listener, options });
  };
  const removeListeners = (collection) => {
    for (const entry of collection.splice(0)) {
      entry.target.removeEventListener(entry.type, entry.listener, entry.options);
    }
  };
  const cameraMotionGain = (deltaSeconds, dampingPerSecond) =>
    motionPreference?.isReduced?.() === true
      ? 1
      : Math.min(1, Math.max(0, (Number(deltaSeconds) || 0) * dampingPerSecond));
  const roundedVec3 = (value) => Array.isArray(value)
    ? value.slice(0, 3).map((entry) => Number((Number(entry) || 0).toFixed(3)))
    : [0, 0, 0];

  function cameraPolarBounds() {
    return playerCameraMode.mode === "first_person"
      ? { min: FIRST_PERSON_CAMERA.min_polar_rad, max: FIRST_PERSON_CAMERA.max_polar_rad }
      : { min: PLAYER_CAMERA_DEFAULT.min_polar_rad, max: PLAYER_CAMERA_DEFAULT.max_polar_rad };
  }

  function movementBasisYaw() {
    let yaw = orbitCamera.azimuth + Math.PI;
    while (yaw > Math.PI) yaw -= Math.PI * 2;
    while (yaw < -Math.PI) yaw += Math.PI * 2;
    return yaw;
  }

  function resetControlState() {
    for (const key of Object.keys(controlState)) controlState[key] = false;
    runModifierKeys.clear();
    crossingSuppressedKeyCodes.clear();
  }

  function resetMovementDebug() {
    movementDebug.previousAvatarKey = null;
    movementDebug.previousPosition = null;
    movementDebug.lastDelta = [0, 0, 0];
  }

  function controlLabels() {
    const labels = Object.entries(controlState).filter(([, pressed]) => pressed).map(([name]) => name);
    if (runModifierKeys.size > 0) labels.push("run");
    return labels.join(" ") || "none";
  }

  function movementSnapshot() {
    return {
      last_delta: movementDebug.lastDelta.slice(),
      last_key_event: movementDebug.lastKeyEvent,
      previous_position: movementDebug.previousPosition ? movementDebug.previousPosition.slice() : null,
      keys: controlLabels(),
      run_mode: runModifierKeys.size > 0,
    };
  }

  function updateMovementDebugState(debug) {
    const avatar = debug && debug.avatar;
    const position = avatar && Array.isArray(avatar.position) ? avatar.position : null;
    if (!position) {
      resetMovementDebug();
      return movementSnapshot();
    }
    const avatarKey = `${role}:${avatar.avatar_id || "avatar"}`;
    movementDebug.lastDelta = movementDebug.previousAvatarKey === avatarKey && movementDebug.previousPosition
      ? position.slice(0, 3).map((value, index) => Number(value || 0) - Number(movementDebug.previousPosition[index] || 0))
      : [0, 0, 0];
    movementDebug.previousAvatarKey = avatarKey;
    movementDebug.previousPosition = position.slice(0, 3);
    return movementSnapshot();
  }

  function setControlKey(event, pressed) {
    const control = CONTROL_KEY_MAP[event.code];
    const isRunKey = RUN_KEY_CODES.has(event.code);
    const hasShortcutModifier = event.metaKey || event.ctrlKey || event.altKey;
    const typingTarget = typeof isTypingTarget === "function" && isTypingTarget(event.target);
    if ((!control && !isRunKey) || (pressed && hasShortcutModifier)) return;
    if (pressed && typingTarget) return;
    if (!hasShortcutModifier && !typingTarget) event.preventDefault();
    movementDebug.lastKeyEvent = `${event.code}:${pressed ? "down" : "up"}`;
    if (crossingSuppressedKeyCodes.has(event.code)) {
      if (!pressed) crossingSuppressedKeyCodes.delete(event.code);
      movementDebug.lastKeyEvent += pressed ? ":crossing_latched" : ":crossing_released";
    } else if (isRunKey) {
      if (pressed) runModifierKeys.add(event.code);
      else runModifierKeys.delete(event.code);
    } else if (control === "jump") {
      if (pressed && !event.repeat) controlState.jump = true;
    } else {
      controlState[control] = pressed;
    }
    const capabilities = runtime();
    if (capabilities && typeof updateMovementProjection === "function") {
      const debug = capabilities.debugState();
      updateMovementProjection(debug, updateMovementDebugState(debug));
    }
  }

  function sessionCameraSnapshot() {
    return {
      orbitAzimuthRad: orbitCamera.azimuth,
      orbitPolarRad: orbitCamera.polar,
      orbitDistanceM: orbitCamera.distance,
      cameraMode: playerCameraMode.mode,
    };
  }

  function persistSession(force = false) {
    if (isPlayer && typeof persistPlayerSession === "function") {
      persistPlayerSession(force, sessionCameraSnapshot());
    }
  }

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

  function syncFirstPersonAvatarVisibility() {
    const layer = avatarLayers().local;
    if (!isPlayer || !layer || !layer._avatarModel) return;
    const visible = playerCameraMode.mode !== "first_person";
    if (layer._avatarModel.visible !== visible) layer._avatarModel.visible = visible;
  }

  function applyPlayerCamera(avatarPositionOverride) {
    if (!isPlayer) return null;
    if (!orbitCamera.focus) orbitCamera.focus = new THREE.Vector3(0, PLAYER_CAMERA_DEFAULT.look_target_height_m, 0);
    const capabilities = runtime();
    const avatar = capabilities && capabilities.state ? capabilities.state.avatar : null;
    const positionSource = avatarPositionOverride || (avatar && Array.isArray(avatar.position) ? avatar.position : null);
    if (positionSource && !orbitCamera.focusInitialized) {
      orbitCamera.focus.set(
        Number(positionSource[0]) || 0,
        (Number(positionSource[1]) || 0) + PLAYER_CAMERA_DEFAULT.look_target_height_m,
        Number(positionSource[2]) || 0,
      );
      orbitCamera.focusInitialized = true;
    }
    const layers = avatarLayers();
    const host = sceneRuntime && typeof sceneRuntime.avatarHost === "function" ? sceneRuntime.avatarHost() : null;
    if (playerCameraMode.mode === "first_person") {
      const head = avatarHeadWorldPosition();
      if (!head) return null;
      const lookYaw = movementBasisYaw();
      const pitch = -orbitCamera.polar;
      const cosPitch = Math.cos(pitch);
      const direction = new THREE.Vector3(
        Math.sin(lookYaw) * cosPitch,
        Math.sin(pitch),
        Math.cos(lookYaw) * cosPitch,
      );
      const position = head.clone();
      position.y += FIRST_PERSON_CAMERA.eye_up_m;
      position.addScaledVector(direction, FIRST_PERSON_CAMERA.eye_forward_m);
      const target = position.clone().add(direction);
      const rigHostedInActiveScene = !host?.scene || !layers.local?.avatarRig ||
        layers.local.avatarRig.parent === host.scene;
      if (
        pendingFirstPersonCrossingMapping &&
        host?.scene &&
        rigHostedInActiveScene &&
        host?.scene !== pendingFirstPersonCrossingMapping.source_scene
      ) {
        const expected = pendingFirstPersonCrossingMapping.position;
        const deltaX = expected[0] - position.x;
        const deltaY = expected[1] - position.y;
        const deltaZ = expected[2] - position.z;
        const sinYaw = Math.sin(lookYaw);
        const cosYaw = Math.cos(lookYaw);
        firstPersonCrossingCorrectionLocal = new THREE.Vector3(
          deltaX * cosYaw - deltaZ * sinYaw,
          deltaY,
          deltaX * sinYaw + deltaZ * cosYaw,
        );
        pendingFirstPersonCrossingMapping = null;
      }
      if (firstPersonCrossingCorrectionLocal) {
        const sinYaw = Math.sin(lookYaw);
        const cosYaw = Math.cos(lookYaw);
        firstPersonCrossingCorrectionWorld = new THREE.Vector3(
          firstPersonCrossingCorrectionLocal.x * cosYaw + firstPersonCrossingCorrectionLocal.z * sinYaw,
          firstPersonCrossingCorrectionLocal.y,
          -firstPersonCrossingCorrectionLocal.x * sinYaw + firstPersonCrossingCorrectionLocal.z * cosYaw,
        );
        position.add(firstPersonCrossingCorrectionWorld);
        target.add(firstPersonCrossingCorrectionWorld);
      } else {
        firstPersonCrossingCorrectionWorld = null;
      }
      const quaternions = [];
      if (layers.local && layers.local.camera) {
        const value = setCameraTransform(layers.local.camera, position, target);
        if (value) quaternions.push(value);
      }
      if (host && host.camera) {
        const value = setCameraTransform(host.camera, position, target);
        if (value) quaternions.push(value);
      }
      syncPeerLayerCameras(position, target);
      portalOcclusionDebug = typeof applyPortalOcclusion === "function"
        ? applyPortalOcclusion(position, target, "player_first_person")
        : null;
      return { position, target, quaternions, lookYaw };
    }
    const target = orbitCamera.focus.clone();
    const cosPolar = Math.cos(orbitCamera.polar);
    const offset = new THREE.Vector3(
      Math.sin(orbitCamera.azimuth) * cosPolar,
      Math.sin(orbitCamera.polar),
      Math.cos(orbitCamera.azimuth) * cosPolar,
    ).multiplyScalar(orbitCamera.distance);
    const position = target.clone().add(offset);
    const quaternions = [];
    if (layers.local && layers.local.camera) {
      const value = setCameraTransform(layers.local.camera, position, target);
      if (value) quaternions.push(value);
    }
    if (host && host.camera) {
      const value = setCameraTransform(host.camera, position, target);
      if (value) quaternions.push(value);
    }
    syncPeerLayerCameras(position, target);
    portalOcclusionDebug = typeof applyPortalOcclusion === "function"
      ? applyPortalOcclusion(position, target, "player_third_person")
      : null;
    const lookDirection = target.clone().sub(position);
    return { position, target, quaternions, lookYaw: Math.atan2(lookDirection.x, lookDirection.z) };
  }

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
    { impl, wallCandidates = [], sceneId = null, worldId = null, faultArm = null } = {},
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
      fault_arm: faultArm || null,
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

    if (faultArm === "disabled" || faultArm === "avatar_xray") {
      selectedHit = null;
      reason = faultArm === "avatar_xray" ? "fault_avatar_xray_instead_of_wall_treatment" : "fault_treatment_disabled";
    } else if (faultArm === "wrong_wall" && nearestHit) {
      const wrong = eligible.find((mesh) => !hitObjects.has(mesh)) || null;
      selectedHit = wrong ? { object: wrong, distance: null } : null;
      reason = "fault_wrong_nonblocking_wall_selected";
    } else if (!nearestHit && previousActive && candidates.includes(previousActive) && previousOriginal?.visible !== false) {
      if (faultArm === "non_restoration") {
        selectedHit = { object: previousActive, distance: null };
        reason = "fault_blocking_wall_not_restored";
      } else if (previousClearFrames < 1) {
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
    { impl, candidates = [], wallCandidates = [], sceneId = null, worldId = null, faultArm = null } = {},
  ) {
    updateCameraWallOcclusion(position, target, cameraMode, {
      impl,
      wallCandidates,
      sceneId,
      worldId,
      faultArm,
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

  function stepOrbitCamera(deltaSeconds) {
    const gain = cameraMotionGain(deltaSeconds, PLAYER_CAMERA_DEFAULT.damping_per_s);
    orbitCamera.azimuth += (orbitCamera.targetAzimuth - orbitCamera.azimuth) * gain;
    orbitCamera.polar += (orbitCamera.targetPolar - orbitCamera.polar) * gain;
    orbitCamera.distance += (orbitCamera.targetDistance - orbitCamera.distance) * gain;
    const capabilities = runtime();
    const avatar = capabilities && capabilities.state ? capabilities.state.avatar : null;
    const position = avatar && Array.isArray(avatar.position) ? avatar.position : null;
    if (!position || !orbitCamera.focus) return;
    const x = Number(position[0]) || 0;
    const y = (Number(position[1]) || 0) + PLAYER_CAMERA_DEFAULT.look_target_height_m;
    const z = Number(position[2]) || 0;
    if (!orbitCamera.focusInitialized) {
      orbitCamera.focus.set(x, y, z);
      orbitCamera.focusInitialized = true;
    } else {
      orbitCamera.focus.x += (x - orbitCamera.focus.x) * gain;
      orbitCamera.focus.y += (y - orbitCamera.focus.y) * gain;
      orbitCamera.focus.z += (z - orbitCamera.focus.z) * gain;
    }
  }

  function seedOrbitCamera({ azimuth, polar, distance, focus, avatarPosition } = {}) {
    if (Number.isFinite(azimuth)) orbitCamera.azimuth = orbitCamera.targetAzimuth = azimuth;
    if (Number.isFinite(polar)) {
      const value = Math.min(PLAYER_CAMERA_DEFAULT.max_polar_rad, Math.max(PLAYER_CAMERA_DEFAULT.min_polar_rad, polar));
      orbitCamera.polar = orbitCamera.targetPolar = value;
    }
    if (Number.isFinite(distance)) {
      const value = Math.min(PLAYER_CAMERA_DEFAULT.max_distance_m, Math.max(PLAYER_CAMERA_DEFAULT.min_distance_m, distance));
      orbitCamera.distance = orbitCamera.targetDistance = value;
    }
    const seededFocus = Array.isArray(avatarPosition)
      ? [
          Number(avatarPosition[0]) || 0,
          (Number(avatarPosition[1]) || 0) + PLAYER_CAMERA_DEFAULT.look_target_height_m,
          Number(avatarPosition[2]) || 0,
        ]
      : focus;
    if (seededFocus && orbitCamera.focus) {
      orbitCamera.focus.set(seededFocus[0], seededFocus[1], seededFocus[2]);
      orbitCamera.focusInitialized = true;
    }
  }

  // a composition crossing that carries NO usable camera
  // mapping previously left the orbit azimuth — and therefore
  // movementBasisYaw() — STALE, pointing the pre-crossing world direction
  // until the player dragged the mouse: on a 180°-related edge held-forward
  // walked the avatar straight back through the portal, on a 90°-related edge
  // into its side. Rotate the CURRENT azimuth by the traversed edge's rigid
  // yaw delta instead. seedOrbitCamera writes azimuth AND targetAzimuth in the
  // same call, and movementBasisYaw() derives from that azimuth, so the
  // emergence camera heading and the held-key movement basis rotate in ONE
  // atomic step — there is no stale-basis frame in between.
  function applyCrossingHeadingDelta(detail) {
    const continuity = detail && detail.heading_continuity ? detail.heading_continuity : null;
    const deltaYaw = continuity ? Number(continuity.crossing_yaw_delta_rad) : NaN;
    if (!Number.isFinite(deltaYaw)) return false;
    pendingFirstPersonCrossingMapping = null;
    firstPersonCrossingCorrectionLocal = null;
    firstPersonCrossingCorrectionWorld = null;
    seedOrbitCamera({ azimuth: normalizeYawRad(orbitCamera.azimuth + deltaYaw) });
    orbitCamera.focusInitialized = false; // snap the focus to the exit avatar in this same step
    applyPlayerCamera();
    return "heading_delta";
  }

  function applyCrossingCameraMapping(detail) {
    if (!isPlayer || !detail) return false;
    const mapping = detail.camera_mapping || null;
    const camera = mapping && Array.isArray(mapping.position) ? mapping.position : null;
    const focus = mapping && Array.isArray(mapping.focus) ? mapping.focus : null;
    if (!camera || !focus) return applyCrossingHeadingDelta(detail);
    if (playerCameraMode.mode === "first_person" && Array.isArray(mapping.forward)) {
      const mappedYaw = Math.atan2(Number(mapping.forward[0]) || 0, Number(mapping.forward[2]) || 0);
      let azimuth = mappedYaw - Math.PI;
      while (azimuth > Math.PI) azimuth -= Math.PI * 2;
      while (azimuth < -Math.PI) azimuth += Math.PI * 2;
      seedOrbitCamera({ azimuth, focus });
      pendingFirstPersonCrossingMapping = {
        position: camera.slice(0, 3).map((value) => Number(value) || 0),
        source_scene: sceneRuntime?.avatarHost?.()?.scene || null,
      };
      firstPersonCrossingCorrectionLocal = null;
      firstPersonCrossingCorrectionWorld = null;
      applyPlayerCamera();
      return true;
    }
    pendingFirstPersonCrossingMapping = null;
    firstPersonCrossingCorrectionLocal = null;
    firstPersonCrossingCorrectionWorld = null;
    const dx = camera[0] - focus[0];
    const dy = camera[1] - focus[1];
    const dz = camera[2] - focus[2];
    seedOrbitCamera({
      azimuth: Math.atan2(dx, dz),
      polar: Math.atan2(dy, Math.max(1e-6, Math.hypot(dx, dz))),
      distance: Math.hypot(dx, dy, dz),
      focus,
    });
    applyPlayerCamera();
    return true;
  }

  function cameraModeLabel() {
    return playerCameraMode.mode === "first_person" ? "first_person_head" : PLAYER_CAMERA_DEFAULT.mode;
  }

  function updatePlayerCamera(debug) {
    if (!isPlayer) return null;
    const avatar = debug && debug.avatar;
    const source = avatar && Array.isArray(avatar.position) ? avatar.position : null;
    if (!source) {
      playerCameraDebug = {
        mode: cameraModeLabel(),
        view_mode: playerCameraMode.mode,
        position: null,
        target: null,
        rotation_y: playerCameraDebug ? playerCameraDebug.rotation_y : Math.PI,
        orientation: [0, 0, 0, 1],
        orbit: {
          azimuth_rad: Number(orbitCamera.azimuth.toFixed(6)),
          polar_rad: Number(orbitCamera.polar.toFixed(6)),
          distance_m: Number(orbitCamera.distance.toFixed(3)),
        },
        follow_distance_m: Number(orbitCamera.distance.toFixed(3)),
        follow_height_m: Number((Math.sin(orbitCamera.polar) * orbitCamera.distance).toFixed(3)),
        responsiveness_ms: PLAYER_CAMERA_DEFAULT.responsiveness_ms,
        avatar_visible: false,
        equipment_visible: false,
        equipment_visibility_mode: "hidden",
      };
      return playerCameraDebug;
    }
    const applied = applyPlayerCamera(source);
    if (!applied) return playerCameraDebug;
    const layer = avatarLayers().local;
    const equipment = layer && typeof layer.debugState === "function" ? layer.debugState() : null;
    const equipmentVisible = !!equipment && (
      equipment.visible_on_avatar === true ||
      (equipment.has_held_item === true && equipment.has_worn_item === true)
    );
    playerCameraDebug = {
      mode: cameraModeLabel(),
      view_mode: playerCameraMode.mode,
      head_attached: playerCameraMode.mode === "first_person",
      position: roundedVec3(applied.position.toArray()),
      target: roundedVec3(applied.target.toArray()),
      rotation_y: Number(applied.lookYaw.toFixed(6)),
      orientation: applied.quaternions[0] || [0, 0, 0, 1],
      orbit: {
        azimuth_rad: Number(orbitCamera.azimuth.toFixed(6)),
        polar_rad: Number(orbitCamera.polar.toFixed(6)),
        distance_m: Number(orbitCamera.distance.toFixed(3)),
      },
      pitch_deg: Number((-orbitCamera.polar * (180 / Math.PI)).toFixed(2)),
      follow_distance_m: Number(orbitCamera.distance.toFixed(3)),
      follow_height_m: Number((Math.sin(orbitCamera.polar) * orbitCamera.distance).toFixed(3)),
      responsiveness_ms: PLAYER_CAMERA_DEFAULT.responsiveness_ms,
      avatar_visible: true,
      equipment_visible: equipmentVisible,
      equipment_visibility_mode: equipmentVisible ? "direct" : "hidden",
      portal_crossing_camera_correction: firstPersonCrossingCorrectionWorld
        ? roundedVec3(firstPersonCrossingCorrectionWorld.toArray())
        : null,
    };
    return playerCameraDebug;
  }

  function updateCameraModeButton() {
    if (!cameraModeButton) return;
    cameraModeButton.textContent = playerCameraMode.mode === "first_person"
      ? "Camera: 1st person (C)"
      : "Camera: 3rd person (C)";
    cameraModeButton.setAttribute("data-camera-view-mode", playerCameraMode.mode);
  }

  function setPlayerCameraMode(mode) {
    if (!isPlayer) return playerCameraMode.mode;
    const next = mode === "first_person" ? "first_person" : "third_person";
    if (playerCameraMode.mode === next) return next;
    playerCameraMode.mode = next;
    if (next === "third_person") {
      pendingFirstPersonCrossingMapping = null;
      firstPersonCrossingCorrectionLocal = null;
      firstPersonCrossingCorrectionWorld = null;
      const bounds = cameraPolarBounds();
      orbitCamera.targetPolar = Math.min(bounds.max, Math.max(bounds.min, orbitCamera.targetPolar));
      orbitCamera.polar = Math.min(bounds.max, Math.max(bounds.min, orbitCamera.polar));
    }
    syncFirstPersonAvatarVisibility();
    updateCameraModeButton();
    applyPlayerCamera();
    logLine(next === "first_person"
      ? "camera: FIRST person — attached to the avatar head bone (C or the viewport button toggles back)"
      : "camera: THIRD person — runtime orbit-behind rig (C or the viewport button toggles)");
    if (typeof refreshDebugProjection === "function") refreshDebugProjection();
    return next;
  }

  function togglePlayerCameraMode() {
    return setPlayerCameraMode(playerCameraMode.mode === "first_person" ? "third_person" : "first_person");
  }

  function serverTopDownFraming() {
    return {
      position: [0, SERVER_VIEW_CAMERA.top_down_height_m, 0],
      target: [0, 0, 0],
      up: [0, 0, -1],
      room_half_extent_m: SERVER_VIEW_CAMERA.room_half_extent_m,
    };
  }

  function stepServerViewCamera(deltaSeconds) {
    if (isPlayer) return;
    if (!serverViewCamera.focus) serverViewCamera.focus = new THREE.Vector3(0, SERVER_VIEW_CAMERA.look_target_height_m, 0);
    const capabilities = runtime();
    const avatar = capabilities && capabilities.state ? capabilities.state.avatar : null;
    const source = avatar && Array.isArray(avatar.position) ? avatar.position : null;
    const x = source ? Number(source[0]) || 0 : 0;
    const y = (source ? Number(source[1]) || 0 : 0) + SERVER_VIEW_CAMERA.look_target_height_m;
    const z = source ? Number(source[2]) || 0 : 0;
    if (!serverViewCamera.focusInitialized) {
      serverViewCamera.focus.set(x, y, z);
      serverViewCamera.focusInitialized = true;
      return;
    }
    const gain = cameraMotionGain(deltaSeconds, SERVER_VIEW_CAMERA.follow_damping_per_s);
    serverViewCamera.focus.x += (x - serverViewCamera.focus.x) * gain;
    serverViewCamera.focus.y += (y - serverViewCamera.focus.y) * gain;
    serverViewCamera.focus.z += (z - serverViewCamera.focus.z) * gain;
  }

  function applyServerViewCamera() {
    if (isPlayer) return null;
    if (!serverViewCamera.focus) serverViewCamera.focus = new THREE.Vector3(0, SERVER_VIEW_CAMERA.look_target_height_m, 0);
    let position;
    let target;
    let up;
    if (serverViewCamera.mode === "top_down") {
      const framing = serverTopDownFraming();
      position = new THREE.Vector3(...framing.position);
      target = new THREE.Vector3(...framing.target);
      up = new THREE.Vector3(...framing.up);
    } else {
      position = new THREE.Vector3(...SERVER_VIEW_CAMERA.third_person_position);
      target = serverViewCamera.focus.clone();
      up = new THREE.Vector3(0, 1, 0);
    }
    const layers = avatarLayers();
    const host = sceneRuntime && typeof sceneRuntime.avatarHost === "function" ? sceneRuntime.avatarHost() : null;
    const cameras = [layers.local && layers.local.camera, host && host.camera];
    let applied = 0;
    for (const camera of cameras) {
      if (!camera || !camera.position || typeof camera.lookAt !== "function") continue;
      if (camera.up) camera.up.copy(up);
      setCameraTransform(camera, position, target);
      applied += 1;
    }
    syncPeerLayerCameras(position, target, up);
    return { mode: serverViewCamera.mode, cameras_applied: applied, position: roundedVec3(position.toArray()), target: roundedVec3(target.toArray()) };
  }

  function updateServerViewModeButton() {
    if (!serverViewModeButton) return;
    const actionLabel = serverViewCamera.mode === "top_down"
      ? "Switch server view to third-person camera"
      : "Switch server view to top-down camera";
    serverViewModeButton.setAttribute("data-server-view-mode", serverViewCamera.mode);
    serverViewModeButton.setAttribute("aria-label", actionLabel);
    serverViewModeButton.setAttribute("aria-pressed", String(serverViewCamera.mode === "top_down"));
    serverViewModeButton.title = actionLabel;
  }

  function setServerViewMode(mode) {
    if (isPlayer) return null;
    const next = mode === "top_down" ? "top_down" : "third_person";
    const changed = next !== serverViewCamera.mode;
    serverViewCamera.mode = next;
    updateServerViewModeButton();
    documentTarget.body.setAttribute("data-server-view-mode", next);
    applyServerViewCamera();
    if (changed) logLine(next === "top_down"
      ? "server view: TOP-DOWN overhead camera (room-fixed full-floor framing)"
      : "server view: THIRD-PERSON camera (full room framed; look target follows the avatar)");
    return next;
  }

  function toggleServerViewMode() {
    return isPlayer ? null : setServerViewMode(serverViewCamera.mode === "top_down" ? "third_person" : "top_down");
  }

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

  function maybeTriggerAutoHandoff() {
    const capabilities = runtime();
    if (!capabilities || autoHandoffStarted) return;
    const target = resolveClientSceneLoadTraversal(capabilities.world, capabilities.state.controls);
    if (target) {
      autoHandoffStarted = true;
      logLine(`auto: portal plane crossed → client scene load ${target.spatial_id} (same player/context; not an application handoff)`);
      void sceneRuntime.mountClientSceneLoad(target).then(() => {
        refreshSceneHost();
        applyPlayerCamera();
      }).catch((error) => {
        autoHandoffStarted = false;
        logLine(`client scene load failed: ${(error && error.message) || String(error)}`);
        showToast("Airport load failed", (error && error.message) || String(error), "failed");
      });
      return;
    }
    if (!capabilities.shouldAutoHandoff()) return;
    autoHandoffStarted = true;
    const debug = capabilities.debugState();
    const distance = debug.controls && debug.controls.portal_distance_m;
    const phase = debug.controls && debug.controls.portal_transition_phase;
    logLine(`auto: portal plane crossed (plane distance ${distance}m) → ${phase}`);
    capabilities.markAutoHandoffObserved();
  }

  function scheduleNextFrame() {
    if (started && frameHandle === null) frameHandle = requestFrame(tick);
  }

  function tick(timestamp) {
    frameHandle = null;
    if (!started) return;
    const deltaSeconds = Math.min(0.05, Math.max(0, (timestamp - lastControlAt) / 1000));
    lastControlAt = timestamp;
    const capabilities = runtime();
    if (capabilities && typeof capabilities.stepAvatar === "function") {
      const input = isPlayer
        ? { ...controlState, run: runModifierKeys.size > 0, camera_yaw: movementBasisYaw() }
        : { ...controlState, run: runModifierKeys.size > 0 };
      capabilities.stepAvatar(input, deltaSeconds);
      controlState.jump = false;
      maybeTriggerAutoHandoff();
      if (isPlayer) {
        const controls = capabilities.state ? capabilities.state.controls : null;
        const grounded = !controls || controls.grounded !== false;
        if (playerGroundedLastTick !== null && grounded !== playerGroundedLastTick) {
          capabilities.broadcastPlayerPose({ force: true });
        }
        playerGroundedLastTick = grounded;
      }
    }
    if (isPlayer) {
      stepOrbitCamera(deltaSeconds);
      syncFirstPersonAvatarVisibility();
      applyPlayerCamera();
      persistSession(false);
    } else {
      stepServerViewCamera(deltaSeconds);
      applyServerViewCamera();
    }
    groundAvatarVisualFeet(deltaSeconds);
    if (isPlayer) sceneRuntime.renderChildFabricPreview(capabilities && capabilities.state ? capabilities.state.preview : null);
    if (isPlayer) sceneRuntime.renderPortalPreviews();
    if (isPlayer && typeof refreshViewMatch === "function") refreshViewMatch(timestamp);
    scheduleNextFrame();
  }

  function cameraButtonStyle() {
    return [
      "position:absolute", "top:calc(var(--osl-shell-header-height, 44px) + 10px)",
      "right:var(--osl-camera-control-right, 10px)", "z-index:40", "padding:6px 10px",
      "background:rgba(8,12,26,0.82)", "color:#dbe8ff", "border:1px solid rgba(43,212,255,0.4)",
      "border-radius:8px", "font:600 11px ui-monospace,Menlo,monospace", "letter-spacing:0.02em", "cursor:pointer",
    ].join(";");
  }

  function ensureCameraButton() {
    if (!sceneMount) return;
    if (isPlayer) {
      if (!cameraModeButton || cameraModeButton.parentNode !== sceneMount) {
        cameraModeButton = documentTarget.createElement("button");
        cameraModeButton.id = "btn-camera-mode";
        cameraModeButton.type = "button";
        cameraModeButton.setAttribute("data-testid", "camera-mode-toggle");
        cameraModeButton.title = "Toggle first/third-person camera (C)";
        cameraModeButton.style.cssText = cameraButtonStyle();
        addListener(cameraModeButton, "mousedown", (event) => event.stopPropagation(), undefined, mountListeners);
        addListener(cameraModeButton, "click", (event) => { event.stopPropagation(); togglePlayerCameraMode(); }, undefined, mountListeners);
        sceneMount.appendChild(cameraModeButton);
      }
      updateCameraModeButton();
    } else {
      const sharedToggle = lookup("btn-camera-toggle");
      if (sharedToggle && serverViewModeButton !== sharedToggle) {
        serverViewModeButton = sharedToggle;
        addListener(serverViewModeButton, "click", (event) => { event.stopPropagation(); toggleServerViewMode(); }, undefined, mountListeners);
      }
      if (serverViewModeButton) serverViewModeButton.hidden = false;
      documentTarget.body.setAttribute("data-server-view-mode", serverViewCamera.mode);
      updateServerViewModeButton();
    }
  }

  function refreshSceneHost() {
    const nextMount = lookup("scene-mount");
    if (nextMount !== sceneMount) {
      removeListeners(mountListeners);
      sceneMount = nextMount;
      cameraModeButton = null;
      serverViewModeButton = null;
      if (sceneMount && isPlayer) {
        sceneMount.style.cursor = "grab";
        addListener(sceneMount, "mousedown", (event) => {
          if (event.button !== 0 || (typeof isTypingTarget === "function" && isTypingTarget(event.target))) return;
          orbitCamera.dragging = true;
          orbitCamera.lastX = event.clientX;
          orbitCamera.lastY = event.clientY;
          sceneMount.style.cursor = "grabbing";
          event.preventDefault();
        }, undefined, mountListeners);
        addListener(sceneMount, "wheel", (event) => {
          event.preventDefault();
          const factor = Math.exp(event.deltaY * PLAYER_CAMERA_DEFAULT.zoom_speed);
          orbitCamera.targetDistance = Math.min(
            PLAYER_CAMERA_DEFAULT.max_distance_m,
            Math.max(PLAYER_CAMERA_DEFAULT.min_distance_m, orbitCamera.targetDistance * factor),
          );
        }, { passive: false }, mountListeners);
        addListener(sceneMount, "touchstart", (event) => {
          if (event.touches.length !== 1) return;
          orbitCamera.dragging = true;
          orbitCamera.lastX = event.touches[0].clientX;
          orbitCamera.lastY = event.touches[0].clientY;
        }, { passive: true }, mountListeners);
        addListener(sceneMount, "touchmove", (event) => {
          if (!orbitCamera.dragging || event.touches.length !== 1) return;
          const dx = event.touches[0].clientX - orbitCamera.lastX;
          const dy = event.touches[0].clientY - orbitCamera.lastY;
          orbitCamera.lastX = event.touches[0].clientX;
          orbitCamera.lastY = event.touches[0].clientY;
          orbitCamera.targetAzimuth -= dx * PLAYER_CAMERA_DEFAULT.orbit_speed_rad_per_px;
          const bounds = cameraPolarBounds();
          orbitCamera.targetPolar = Math.min(bounds.max, Math.max(bounds.min, orbitCamera.targetPolar + dy * PLAYER_CAMERA_DEFAULT.orbit_speed_rad_per_px));
        }, { passive: true }, mountListeners);
      }
    }
    ensureCameraButton();
    return sceneMount;
  }

  function onMouseMove(event) {
    if (!orbitCamera.dragging) return;
    const dx = event.clientX - orbitCamera.lastX;
    const dy = event.clientY - orbitCamera.lastY;
    orbitCamera.lastX = event.clientX;
    orbitCamera.lastY = event.clientY;
    orbitCamera.targetAzimuth -= dx * PLAYER_CAMERA_DEFAULT.orbit_speed_rad_per_px;
    const bounds = cameraPolarBounds();
    orbitCamera.targetPolar = Math.min(bounds.max, Math.max(bounds.min, orbitCamera.targetPolar + dy * PLAYER_CAMERA_DEFAULT.orbit_speed_rad_per_px));
  }

  function start() {
    if (disposed) throw new Error("movement/camera controller disposed");
    if (started) return false;
    started = true;
    refreshSceneHost();
    addListener(windowTarget, "keydown", (event) => {
      if (
        isPlayer &&
        (CONTROL_KEY_MAP[event.code] || event.key === "Escape") &&
        typeof renderOrientation === "function"
      ) renderOrientation();
      setControlKey(event, true);
    });
    addListener(windowTarget, "keyup", (event) => setControlKey(event, false));
    addListener(windowTarget, "blur", resetControlState);
    addListener(documentTarget, "visibilitychange", () => {
      if (documentTarget.hidden === true || documentTarget.visibilityState === "hidden") resetControlState();
    });
    addListener(windowTarget, "pagehide", () => {
      resetControlState();
      persistSession(true);
    });
    if (isPlayer) {
      addListener(windowTarget, "mousemove", onMouseMove);
      addListener(windowTarget, "mouseup", () => {
        if (!orbitCamera.dragging) return;
        orbitCamera.dragging = false;
        if (sceneMount) sceneMount.style.cursor = "grab";
      });
      addListener(windowTarget, "touchend", () => { orbitCamera.dragging = false; });
      addListener(windowTarget, "keydown", (event) => {
        if (event.code !== "KeyC" || event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
        if (typeof isTypingTarget === "function" && isTypingTarget(event.target)) return;
        event.preventDefault();
        togglePlayerCameraMode();
      });
      addListener(windowTarget, "beforeunload", () => persistSession(true));
    }
    if (pendingRestoredCameraSeed) {
      seedOrbitCamera(pendingRestoredCameraSeed);
      pendingRestoredCameraSeed = null;
    }
    if (isPlayer) applyPlayerCamera();
    else applyServerViewCamera();
    lastControlAt = now();
    scheduleNextFrame();
    persistSession(true);
    return true;
  }

  function stop() {
    if (!started) return false;
    started = false;
    if (frameHandle !== null) cancelFrame(frameHandle);
    frameHandle = null;
    removeListeners(globalListeners);
    removeListeners(mountListeners);
    if (cameraModeButton && cameraModeButton.parentNode) cameraModeButton.parentNode.removeChild(cameraModeButton);
    if (serverViewModeButton) {
      serverViewModeButton.hidden = true;
      serverViewModeButton.removeAttribute("aria-pressed");
      serverViewModeButton.removeAttribute("data-server-view-mode");
    }
    cameraModeButton = null;
    serverViewModeButton = null;
    sceneMount = null;
    orbitCamera.dragging = false;
    pendingFirstPersonCrossingMapping = null;
    firstPersonCrossingCorrectionLocal = null;
    firstPersonCrossingCorrectionWorld = null;
    resetControlState();
    restoreCameraWallTreatment("controller_stopped");
    return true;
  }

  function handleCrossing(detail = {}) {
    autoHandoffStarted = false;
    for (const [code, control] of Object.entries(CONTROL_KEY_MAP)) {
      if (control !== "jump" && controlState[control]) crossingSuppressedKeyCodes.add(code);
    }
    for (const code of runModifierKeys) crossingSuppressedKeyCodes.add(code);
    for (const control of Object.values(CONTROL_KEY_MAP)) {
      if (control !== "jump") controlState[control] = false;
    }
    runModifierKeys.clear();
    groundingCalibrationByModel.clear();
    groundingDebug = { active: false, mode: "scene_rebind", model_offset_y_m: 0, residual_m: null };
    refreshSceneHost();
    let remapped = null;
    if (detail.kind !== "reset_demotion" && detail.kind !== "return_to_lobby") {
      remapped = applyCrossingCameraMapping(detail);
    } else if (detail.kind === "return_to_lobby") {
      pendingFirstPersonCrossingMapping = null;
      firstPersonCrossingCorrectionLocal = null;
      firstPersonCrossingCorrectionWorld = null;
      seedOrbitCamera({ azimuth: 0 });
      orbitCamera.focusInitialized = false;
      applyPlayerCamera();
    } else {
      pendingFirstPersonCrossingMapping = null;
      firstPersonCrossingCorrectionLocal = null;
      firstPersonCrossingCorrectionWorld = null;
      orbitCamera.focusInitialized = false;
    }
    return remapped;
  }

  function observeState(phase) {
    if (phase === "idle" || phase === "waiting" || phase === "arrived") autoHandoffStarted = false;
  }

  function reset() {
    autoHandoffStarted = false;
    groundingCalibrationByModel.clear();
    groundingDebug = { active: false, mode: "reset_rebind", model_offset_y_m: 0, residual_m: null };
    resetControlState();
    resetMovementDebug();
    orbitCamera.focusInitialized = false;
    pendingFirstPersonCrossingMapping = null;
    firstPersonCrossingCorrectionLocal = null;
    firstPersonCrossingCorrectionWorld = null;
    setPlayerCameraMode("third_person");
  }

  function orbitBy(deltaAzimuth = 0, deltaPolar = 0, deltaDistance = 0) {
    const bounds = cameraPolarBounds();
    orbitCamera.targetAzimuth += Number(deltaAzimuth) || 0;
    orbitCamera.targetPolar = Math.min(bounds.max, Math.max(bounds.min, orbitCamera.targetPolar + (Number(deltaPolar) || 0)));
    orbitCamera.targetDistance = Math.min(
      PLAYER_CAMERA_DEFAULT.max_distance_m,
      Math.max(PLAYER_CAMERA_DEFAULT.min_distance_m, orbitCamera.targetDistance + (Number(deltaDistance) || 0)),
    );
    return { azimuth: orbitCamera.targetAzimuth, polar: orbitCamera.targetPolar, distance: orbitCamera.targetDistance };
  }

  function serverViewCameraState() {
    if (isPlayer) return null;
    const layers = avatarLayers();
    const host = sceneRuntime && typeof sceneRuntime.avatarHost === "function" ? sceneRuntime.avatarHost() : null;
    return {
      mode: serverViewCamera.mode,
      top_down_framing: serverTopDownFraming(),
      scene_camera_position: host && host.camera && host.camera.position ? roundedVec3(host.camera.position.toArray()) : null,
      avatar_layer_camera_position: layers.local && layers.local.camera ? roundedVec3(layers.local.camera.position.toArray()) : null,
      focus: serverViewCamera.focus ? roundedVec3(serverViewCamera.focus.toArray()) : null,
    };
  }

  function debug() {
    return {
      started,
      disposed,
      raf_active: frameHandle !== null,
      auto_handoff_started: autoHandoffStarted,
      player_grounded_last_tick: playerGroundedLastTick,
      camera: playerCameraDebug,
      camera_mode: playerCameraMode.mode,
      orbit: { azimuth: orbitCamera.azimuth, polar: orbitCamera.polar, distance: orbitCamera.distance },
      movement: movementSnapshot(),
      grounding: { ...groundingDebug },
      portal_aperture_occlusion: portalOcclusionDebug,
      camera_wall_occlusion: cameraWallOcclusionDebug,
      server_view: serverViewCameraState(),
    };
  }

  function dispose() {
    if (disposed) return;
    stop();
    restoreCameraWallTreatment("controller_disposed");
    disposed = true;
    groundingCalibrationByModel.clear();
  }

  return Object.freeze({
    start,
    stop,
    dispose,
    refreshSceneHost,
    handleCrossing,
    observeState,
    reset,
    setRestoredCameraSeed: (seed) => { pendingRestoredCameraSeed = seed ? { ...seed } : null; },
    seedOrbitCamera,
    applyPlayerCamera,
    updatePlayerCamera,
    setPlayerCameraMode,
    togglePlayerCameraMode,
    playerCameraMode: () => playerCameraMode.mode,
    playerCameraDebug: () => playerCameraDebug,
    movementBasisYaw,
    sessionCameraSnapshot,
    releaseControls: resetControlState,
    controlState: () => controlState,
    movementDebug: movementSnapshot,
    updateMovementDebug: updateMovementDebugState,
    orbitBy,
    orbitState: () => ({ azimuth: orbitCamera.azimuth, polar: orbitCamera.polar, distance: orbitCamera.distance, camera: playerCameraDebug }),
    setServerViewMode,
    toggleServerViewMode,
    serverViewMode: () => isPlayer ? null : serverViewCamera.mode,
    serverViewCameraState,
    groundingState: () => ({ ...groundingDebug }),
    portalOcclusionState: () => portalOcclusionDebug,
    cameraWallOcclusionState: () => cameraWallOcclusionDebug,
    updatePortalOcclusion,
    persistSession,
    debug,
  });
}
