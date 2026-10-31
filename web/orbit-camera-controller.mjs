// A third-person orbit camera that only talks to a RenderAdapter.
//
// Nicholas Polys's fork npolys/open-spatial-lab (commit 99175b4b6) has a file of this name. It was
// not among the fetched files, so this one is written from what web/x3dom-movement-camera-controller.mjs
// (his) asks of it, under his names. The numbers come from PLAYER_CAMERA_DEFAULT in the lab's own
// movement-camera-controller.mjs, so the X3D renderers frame the player as three.js does.
export const ORBIT_CAMERA_DEFAULTS = Object.freeze({
  distance_m: 3.5,
  min_distance_m: 1.6,
  max_distance_m: 8,
  polar_rad: 0.22,
  min_polar_rad: -0.12,
  max_polar_rad: 1.25,
  look_target_height_m: 1.35,
  damping_per_s: 14,
});

export function createOrbitCameraController({ adapter, camera }) {
  const state = {
    azimuth: 0,
    targetAzimuth: 0,
    polar: ORBIT_CAMERA_DEFAULTS.polar_rad,
    targetPolar: ORBIT_CAMERA_DEFAULTS.polar_rad,
    distance: ORBIT_CAMERA_DEFAULTS.distance_m,
    targetDistance: ORBIT_CAMERA_DEFAULTS.distance_m,
    focus: [0, ORBIT_CAMERA_DEFAULTS.look_target_height_m, 0],
    focusInitialized: false,
  };
  let pose = null;

  function focusFor(position) {
    return [
      Number(position[0]) || 0,
      (Number(position[1]) || 0) + ORBIT_CAMERA_DEFAULTS.look_target_height_m,
      Number(position[2]) || 0,
    ];
  }

  function apply() {
    const cosPolar = Math.cos(state.polar);
    const position = [
      state.focus[0] + Math.sin(state.azimuth) * cosPolar * state.distance,
      state.focus[1] + Math.sin(state.polar) * state.distance,
      state.focus[2] + Math.cos(state.azimuth) * cosPolar * state.distance,
    ];
    const lookAt = state.focus.slice(0, 3);
    adapter.setCameraPose(camera, { position, lookAt });
    pose = { position, lookAt, lookYaw: state.azimuth + Math.PI };
  }

  function seed({ azimuth, polar, distance, focusPosition } = {}) {
    if (Number.isFinite(azimuth)) state.azimuth = state.targetAzimuth = azimuth;
    if (Number.isFinite(polar)) state.polar = state.targetPolar = polar;
    if (Number.isFinite(distance)) state.distance = state.targetDistance = distance;
    if (Array.isArray(focusPosition)) {
      state.focus = focusFor(focusPosition);
      state.focusInitialized = true;
    }
    apply();
  }

  function step(deltaSeconds, avatarPosition, motionReduced = false) {
    const gain = motionReduced ? 1 : 1 - Math.exp(-ORBIT_CAMERA_DEFAULTS.damping_per_s * Math.max(0, deltaSeconds));
    state.azimuth += (state.targetAzimuth - state.azimuth) * gain;
    state.polar += (state.targetPolar - state.polar) * gain;
    state.distance += (state.targetDistance - state.distance) * gain;
    if (Array.isArray(avatarPosition)) {
      const target = focusFor(avatarPosition);
      if (!state.focusInitialized) {
        state.focus = target;
        state.focusInitialized = true;
      } else {
        for (let axis = 0; axis < 3; axis += 1) state.focus[axis] += (target[axis] - state.focus[axis]) * gain;
      }
    }
    apply();
  }

  return { state, seed, step, apply, currentPose: () => pose };
}
