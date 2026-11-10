import {inspectExitPose,inspectCrossingHeading} from "./crossing-presentation.mjs";
import { normalizeYawRad, addScaled3, vectorFromYaw } from "./live-adapter-portal-geometry.mjs";
import { validateCrossingCameraMapping } from "./crossing-camera-validation.mjs";
import { createApplicationCore } from "./application-core.mjs";

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

const FRAME_FAULT_NOTICE_AFTER_MS = 2000;
const FRAME_FAULT_NOTICE_EVERY_MS = 15000;
const FRAME_FAULT_OVER_AFTER_MS = 2000;
const FRAME_FAULT_DISTINCT_LIMIT = 20;

/**
 * What the movement loop does with a frame that threw: each distinct message goes to the console once, and a person is
 * told in plain words only when the failures keep coming. A fault is over after a stretch of clean frames.
 */
function createFrameFaults({ windowTarget, showToast }) {
  const reported = new Set();
  let faultStartedAt = null;
  let lastFaultAt = null;
  let lastNoticeAt = null;
  return {
    clean(timestamp) {
      if (faultStartedAt !== null && timestamp - lastFaultAt >= FRAME_FAULT_OVER_AFTER_MS) {
        faultStartedAt = null;
        lastNoticeAt = null;
      }
    },
    failed(error, timestamp) {
      const message = (error && error.message) || String(error);
      if (faultStartedAt === null) faultStartedAt = timestamp;
      lastFaultAt = timestamp;
      const lasted = timestamp - faultStartedAt >= FRAME_FAULT_NOTICE_AFTER_MS;
      if (lasted && (lastNoticeAt === null || timestamp - lastNoticeAt >= FRAME_FAULT_NOTICE_EVERY_MS)) {
        lastNoticeAt = timestamp;
        showToast("Movement is not working", "Try reloading the page.", "failed");
      }
      if (!reported.has(message) && reported.size < FRAME_FAULT_DISTINCT_LIMIT) {
        reported.add(message);
        // A window that cannot report gets the throw itself: uncaught, it reports the same way, and the frame is still queued.
        if (typeof windowTarget.reportError !== "function") throw error;
        windowTarget.reportError(error);
      }
    },
  };
}

export function reframeCrossingCameraMapping({
  detail,
  frameMapping,
  entryTransform,
  cameraTransform,
  lookTargetHeightM = PLAYER_CAMERA_DEFAULT.look_target_height_m,
} = {}) {
  return validateCrossingCameraMapping({ detail, frameMapping, entryTransform, cameraTransform, lookTargetHeightM });
}

/**
 * Owns the browser movement/input loop and all player/server camera policy.
 * Scene, adapter, avatar, session, and panel state remain in their injected
 * canonical owners; this controller only consumes their narrow capabilities.
 */
export function createMovementCameraController({
  cameraBridge,
  expectedPortalEdgeId,
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
  documentViewer = null,
}) {
  const frameFaults = createFrameFaults({ windowTarget, showToast });
  const controlState = { forward: false, back: false, left: false, right: false, jump: false };
  if (documentViewer?.softBody) Object.assign(controlState, { armUp: false, armDown: false, armMovement: 0 });
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
  let playerCameraDebug = null;
  let portalOcclusionDebug = null;
  let playerGroundedLastTick = null;
  let pendingRestoredCameraSeed = null;
  let pendingFirstPersonCrossingMapping = null;
  let firstPersonCrossingCorrectionLocal = null;
  let firstPersonCrossingCorrectionWorld = null;
  let autoHandoffStarted = false;
  let started = false;
  let viewOnly = false;
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
    const control = documentViewer
      ? ({ KeyW: "forward", KeyS: "back", KeyD: "right", [documentViewer.softBody ? "ArrowLeft" : "KeyA"]: "left",
          ...(documentViewer.softBody ? { KeyQ: "armUp", KeyA: "armDown" } : {}) })[event.code]
      : CONTROL_KEY_MAP[event.code];
    const isRunKey = RUN_KEY_CODES.has(event.code);
    const hasShortcutModifier = event.metaKey || event.ctrlKey || event.altKey;
    const typingTarget = typeof isTypingTarget === "function" && isTypingTarget(event.target);
    if ((!control && !isRunKey) || (pressed && hasShortcutModifier)) return;
    if (pressed && typingTarget) return;
    if (!hasShortcutModifier && !typingTarget) event.preventDefault();
    movementDebug.lastKeyEvent = `${event.code}:${pressed ? "down" : "up"}`;
    if (documentViewer?.softBody && (control === "armUp" || control === "armDown"))
      controlState.armMovement = pressed ? (control === "armUp" ? 1 : -1) : 0;
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
    if (documentViewer) return;
    if (isPlayer && typeof persistPlayerSession === "function") {
      persistPlayerSession(force, sessionCameraSnapshot());
    }
  }

  function applyPlayerCamera(avatarPositionOverride) {
    if (documentViewer) return null;
    if (!isPlayer) return null;
    if (!orbitCamera.focus) orbitCamera.focus = [0, PLAYER_CAMERA_DEFAULT.look_target_height_m, 0];
    const source = avatarPositionOverride || runtime()?.state?.avatar?.position;
    if (source && !orbitCamera.focusInitialized) {
      orbitCamera.focus = [Number(source[0]) || 0, (Number(source[1]) || 0) + PLAYER_CAMERA_DEFAULT.look_target_height_m, Number(source[2]) || 0];
      orbitCamera.focusInitialized = true;
    }
    const measured = cameraBridge.measure();
    let position, target, lookYaw;
    if (playerCameraMode.mode === "first_person") {
      if (!measured.head) return null;
      lookYaw = movementBasisYaw();
      const pitch = -orbitCamera.polar;
      const direction = [Math.sin(lookYaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(lookYaw) * Math.cos(pitch)];
      position = measured.head.map((value, i) => value + (i === 1 ? FIRST_PERSON_CAMERA.eye_up_m : 0) + direction[i] * FIRST_PERSON_CAMERA.eye_forward_m);
      target = position.map((value, i) => value + direction[i]);
      if (pendingFirstPersonCrossingMapping && measured.rigHosted && measured.mountToken !== pendingFirstPersonCrossingMapping.source_mount) {
        const delta = pendingFirstPersonCrossingMapping.position.map((value, i) => value - position[i]);
        const cos = Math.cos(lookYaw), sin = Math.sin(lookYaw);
        firstPersonCrossingCorrectionLocal = [cos * delta[0] - sin * delta[2], delta[1], sin * delta[0] + cos * delta[2]];
        pendingFirstPersonCrossingMapping = null;
      }
      if (firstPersonCrossingCorrectionLocal) {
        const [x, y, z] = firstPersonCrossingCorrectionLocal;
        const cos = Math.cos(lookYaw), sin = Math.sin(lookYaw);
        firstPersonCrossingCorrectionWorld = [cos * x + sin * z, y, -sin * x + cos * z];
        position = position.map((value, i) => value + firstPersonCrossingCorrectionWorld[i]);
        target = target.map((value, i) => value + firstPersonCrossingCorrectionWorld[i]);
      }
    } else {
      target = orbitCamera.focus.slice();
      const horizontal = Math.cos(orbitCamera.polar) * orbitCamera.distance;
      position = [target[0] + Math.sin(orbitCamera.azimuth) * horizontal, target[1] + Math.sin(orbitCamera.polar) * orbitCamera.distance, target[2] + Math.cos(orbitCamera.azimuth) * horizontal];
      lookYaw = Math.atan2(target[0] - position[0], target[2] - position[2]);
    }
    const quaternions = cameraBridge.apply({ position, target });
    portalOcclusionDebug = applyPortalOcclusion?.(position, target, playerCameraMode.mode === "first_person" ? "player_first_person" : "player_third_person") || null;
    return { position, target, quaternions, lookYaw };
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
      orbitCamera.focus = [x, y, z];
      orbitCamera.focusInitialized = true;
    } else {
      orbitCamera.focus[0] += (x - orbitCamera.focus[0]) * gain;
      orbitCamera.focus[1] += (y - orbitCamera.focus[1]) * gain;
      orbitCamera.focus[2] += (z - orbitCamera.focus[2]) * gain;
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
      orbitCamera.focus = seededFocus.slice(0, 3);
      orbitCamera.focusInitialized = true;
    }
  }

  // Without a usable mapping, rotate orbit and movement basis together by the edge yaw.
  // Seeding both current and target azimuth avoids a stale-basis frame.
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
        source_mount: cameraBridge.measure().mountToken,
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
    const equipment = cameraBridge.measure().equipment;
    const equipmentVisible = !!equipment && (
      equipment.visible_on_avatar === true ||
      (equipment.has_held_item === true && equipment.has_worn_item === true)
    );
    playerCameraDebug = {
      mode: cameraModeLabel(),
      view_mode: playerCameraMode.mode,
      head_attached: playerCameraMode.mode === "first_person",
      position: roundedVec3(applied.position),
      target: roundedVec3(applied.target),
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
        ? roundedVec3(firstPersonCrossingCorrectionWorld)
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
    cameraBridge.setAvatarVisibility(playerCameraMode.mode);
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
    if (!serverViewCamera.focus) serverViewCamera.focus = [0, SERVER_VIEW_CAMERA.look_target_height_m, 0];
    const capabilities = runtime();
    const avatar = capabilities && capabilities.state ? capabilities.state.avatar : null;
    const source = avatar && Array.isArray(avatar.position) ? avatar.position : null;
    const x = source ? Number(source[0]) || 0 : 0;
    const y = (source ? Number(source[1]) || 0 : 0) + SERVER_VIEW_CAMERA.look_target_height_m;
    const z = source ? Number(source[2]) || 0 : 0;
    if (!serverViewCamera.focusInitialized) {
      serverViewCamera.focus = [x, y, z];
      serverViewCamera.focusInitialized = true;
      return;
    }
    const gain = cameraMotionGain(deltaSeconds, SERVER_VIEW_CAMERA.follow_damping_per_s);
    serverViewCamera.focus[0] += (x - serverViewCamera.focus[0]) * gain;
    serverViewCamera.focus[1] += (y - serverViewCamera.focus[1]) * gain;
    serverViewCamera.focus[2] += (z - serverViewCamera.focus[2]) * gain;
  }

  function applyServerViewCamera() {
    if (isPlayer) return null;
    if (!serverViewCamera.focus) serverViewCamera.focus = [0, SERVER_VIEW_CAMERA.look_target_height_m, 0];
    const framing = serverViewCamera.mode === "top_down" ? serverTopDownFraming() : {
      position: SERVER_VIEW_CAMERA.third_person_position.slice(), target: serverViewCamera.focus.slice(), up: [0, 1, 0],
    };
    const quaternions = cameraBridge.apply(framing);
    return { mode: serverViewCamera.mode, cameras_applied: quaternions.length, position: roundedVec3(framing.position), target: roundedVec3(framing.target) };
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

  function stepFrame(capabilities, deltaSeconds) {
    if (viewOnly) return;
    if (documentViewer) {
      const entry = documentViewer.entry(), position = cameraBridge.measure().sceneCameraPosition;
      if (!entry || !position || documentTarget.hidden) return;
      const yaw = (entry.orientation?.[1] ?? 0) * (entry.orientation?.[3] ?? 0);
      const ahead = (controlState.back ? 1 : 0) - (controlState.forward ? 1 : 0);
      const side = (controlState.right ? 1 : 0) - (controlState.left ? 1 : 0);
      const distance = 2.4 * deltaSeconds;
      cameraBridge.applyDocumentPosition(addScaled3(addScaled3(position, vectorFromYaw(yaw), ahead * distance), vectorFromYaw(yaw + Math.PI / 2), side * distance));
      return;
    }
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
  }

  function updateFrameView(capabilities, deltaSeconds) {
    if (viewOnly || documentViewer) return;
    if (isPlayer) {
      stepOrbitCamera(deltaSeconds);
      cameraBridge.setAvatarVisibility(playerCameraMode.mode);
      applyPlayerCamera();
      persistSession(false);
    } else {
      stepServerViewCamera(deltaSeconds);
      applyServerViewCamera();
    }
    cameraBridge.ground(deltaSeconds);
  }

  function drawFramePreviews(capabilities, timestamp, deltaSeconds) {
    if (documentViewer) { sceneRuntime.renderPortalPreviews(deltaSeconds); frameFaults.clean(timestamp); return; }
    if (isPlayer) sceneRuntime.renderChildFabricPreview(capabilities && capabilities.state ? capabilities.state.preview : null);
    if (isPlayer) sceneRuntime.renderPortalPreviews(deltaSeconds);
    if (isPlayer && typeof refreshViewMatch === "function") refreshViewMatch(timestamp);
    frameFaults.clean(timestamp);
  }
  const core = createApplicationCore({
    readRuntime: runtime, readLayers: avatarLayers, readScene: () => sceneRuntime.scene?.(),
    stepInput: stepFrame, updateView: updateFrameView, drawPreviews: drawFramePreviews,
    publishFrame: (_runtime, layers) => sceneRuntime.publishEvaluatedPoses?.(layers),
    requestFrame, cancelFrame, now, onError: (error, timestamp) => frameFaults.failed(error, timestamp),
  });

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
      if (sceneMount && documentViewer) {
        addListener(sceneMount, "click", event => documentViewer.activate(event), undefined, mountListeners);
        return sceneMount;
      }
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
    if (!viewOnly && !documentViewer) ensureCameraButton();
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
    if (isPlayer && !documentViewer) {
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
    core.start();
    persistSession(true);
    return true;
  }

  // Frames only, for non-player ?wow= viewers: wow-view-controls owns camera and input.
  function startViewOnly() {
    if (disposed) throw new Error("movement/camera controller disposed");
    if (started) return false;
    started = true;
    viewOnly = true;
    refreshSceneHost();
    core.start();
    return true;
  }

  function stop() {
    if (!started) return false;
    started = false;
    viewOnly = false;
    core.stop();
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
    cameraBridge.restoreCameraWallTreatment("controller_stopped");
    return true;
  }

  let lastExitPoseParity=null, lastCrossingHeadingContinuity=null;
  function inspectCrossing(detail) {
    const failures=[];
    const capture=(name,read)=>{try {const value=read();if(value?.guard_failure)failures.push(value.guard_failure);return value;}catch(error){failures.push(`${name} broke: ${error.message}`);return null;}};
    const debug=capture("crossingDiagnosticInput",()=>runtime()?.rawDebugState?.() || runtime()?.debugState?.());
    const heading=capture("reframeAdapterCrossingHeading",()=>inspectCrossingHeading(debug,detail,reframeCrossingCameraMapping));
    const exit=capture("applyExitPoseParity",()=>inspectExitPose(debug,detail,expectedPortalEdgeId));
    if(heading)lastCrossingHeadingContinuity=heading;
    if(exit)lastExitPoseParity=exit;
    return {heading,exit,failures};
  }
  function recordCrossingView(detail,remapped,heading) {
    if (!isPlayer || detail.kind!=="world_navigator_composition_crossing") return;
    const basisYaw=movementBasisYaw(), camera=updatePlayerCamera(runtime()?.debugState());
    const cameraYaw=camera && Number.isFinite(Number(camera.rotation_y))?Number(camera.rotation_y):null;
    if(heading)Object.assign(heading,{applied_remap:remapped===true?"camera_mapping":remapped||"none",basis_yaw_after:Number.isFinite(basisYaw)?Number(basisYaw.toFixed(6)):null,camera_yaw_after:cameraYaw===null?null:Number(cameraYaw.toFixed(6))});
    const body=documentTarget.body;
    body.setAttribute("data-crossing-camera-remap",remapped===true?"camera_mapping":String(remapped||"none"));
    body.setAttribute("data-crossing-heading-delta-rad",detail.heading_continuity && Number.isFinite(Number(detail.heading_continuity.crossing_yaw_delta_rad))?String(detail.heading_continuity.crossing_yaw_delta_rad):"");
    body.setAttribute("data-crossing-basis-yaw-rad",Number.isFinite(basisYaw)?basisYaw.toFixed(6):"");
    body.setAttribute("data-crossing-camera-yaw-rad",cameraYaw===null?"":cameraYaw.toFixed(6));
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
    cameraBridge.resetGrounding("scene_rebind");
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
    cameraBridge.resetGrounding("reset_rebind");
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
    const measured = cameraBridge.measure();
    return { mode: serverViewCamera.mode, top_down_framing: serverTopDownFraming(),
      scene_camera_position: measured.sceneCameraPosition ? roundedVec3(measured.sceneCameraPosition) : null,
      avatar_layer_camera_position: measured.avatarCameraPosition ? roundedVec3(measured.avatarCameraPosition) : null,
      focus: serverViewCamera.focus ? roundedVec3(serverViewCamera.focus) : null };
  }

  function debug() {
    return {
      started,
      disposed,
      raf_active: core.snapshot().scheduledFrames > 0,
      core: core.snapshot(),
      auto_handoff_started: autoHandoffStarted,
      player_grounded_last_tick: playerGroundedLastTick,
      camera: playerCameraDebug,
      camera_mode: playerCameraMode.mode,
      orbit: { azimuth: orbitCamera.azimuth, polar: orbitCamera.polar, distance: orbitCamera.distance },
      movement: movementSnapshot(),
      grounding: cameraBridge.groundingState(),
      portal_aperture_occlusion: portalOcclusionDebug,
      camera_wall_occlusion: cameraBridge.cameraWallOcclusionState(),
      server_view: serverViewCameraState(),
    };
  }

  function dispose() {
    if (disposed) return;
    stop();
    cameraBridge.dispose();
    disposed = true;
    core.dispose();
  }

  return Object.freeze({
    start,
    startViewOnly,
    stop,
    dispose,
    refreshSceneHost,
    handleCrossing,
    inspectCrossing,recordCrossingView,
    exitPoseParity:()=>lastExitPoseParity,
    crossingHeadingContinuity:()=>lastCrossingHeadingContinuity,
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
    documentActions: () => ({ armMovement: Number(controlState.armMovement) || 0, paused: documentTarget.hidden === true }),
    movementDebug: movementSnapshot,
    updateMovementDebug: updateMovementDebugState,
    orbitBy,
    orbitState: () => ({ azimuth: orbitCamera.azimuth, polar: orbitCamera.polar, distance: orbitCamera.distance, camera: playerCameraDebug }),
    setServerViewMode,
    toggleServerViewMode,
    serverViewMode: () => isPlayer ? null : serverViewCamera.mode,
    serverViewCameraState,
    groundingState: () => (cameraBridge.groundingState()),
    portalOcclusionState: () => portalOcclusionDebug,
    cameraWallOcclusionState: cameraBridge.cameraWallOcclusionState,
    updatePortalOcclusion: cameraBridge.updatePortalOcclusion,
    persistSession,
    debug,
  });
}
