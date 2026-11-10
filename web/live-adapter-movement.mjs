import { clamp, clonePosition } from "./live-adapter-portal-geometry.mjs";
import { integrateAirportVerticalMotion } from "./airport-walkable-surface.mjs";
import { publishGroundSurface } from "./live-adapter-movement-ground.mjs";
export const MOVE_SPEED_MPS = 1.4;
const RUN_MOVE_SPEED_MPS = 4.5;
const RUN_MAX_CYCLE_SPEED = 1.6257644280216694;
const RUN_MIN_CYCLE_DISTANCE_M = 0.5;
const WORLD_LIMIT = 5.4;
const JUMP_SPEED_MPS = 4.25;
const GRAVITY_MPS2 = 10.5;

function directionFromInput(forward, strafe) {
  if (forward > 0 && strafe === 0) return "away_from_camera";
  if (forward < 0 && strafe === 0) return "toward_camera";
  if (forward === 0 && strafe > 0) return "right";
  if (forward === 0 && strafe < 0) return "left";
  if (forward || strafe) return "diagonal";
  return "none";
}
export function facingSemanticsFromDelta(dx, dz) {
  if (Math.abs(dx) < 1e-4 && Math.abs(dz) < 1e-4) return "still";
  if (dz > 1e-4) return "front_faces_camera";
  if (dz < -1e-4) return "back_faces_camera";
  return dx > 0 ? "front_faces_avatar_right" : "front_faces_avatar_left";
}
export function runCalibrationSnapshot(calibration) {
  const sourceSpeed = RUN_MOVE_SPEED_MPS;
  return {
    run_cycle_speed: calibration ? calibration.run_cycle_speed : null,
    run_cycle_distance: calibration ? calibration.run_cycle_distance : null,
    run_cadence_steps_per_min: calibration ? calibration.run_cycle_speed * 120 : null,
    effective_run_translation_speed_mps: calibration
      ? calibration.run_cycle_speed * calibration.run_cycle_distance
      : sourceSpeed,
    source_translation_speed_mps: sourceSpeed,
    calibrated: calibration !== null,
    persistence: "session-local-memory-only",
  };
}
export function runCalibration(input) {
  const runCycleSpeed = Number(input && input.run_cycle_speed);
  const runCycleDistance = Number(input && input.run_cycle_distance);
  if (!Number.isFinite(runCycleSpeed) || runCycleSpeed <= 0) {
    throw new RangeError("run_cycle_speed must be a positive finite cycles/s value");
  }
  if (runCycleSpeed > RUN_MAX_CYCLE_SPEED + 1e-12) {
    throw new RangeError("run_cycle_speed exceeds the measured 195.092 steps/min hard envelope");
  }
  if (!Number.isFinite(runCycleDistance) || runCycleDistance < RUN_MIN_CYCLE_DISTANCE_M) {
    throw new RangeError("run_cycle_distance must be a finite, non-near-zero metres/cycle value");
  }
  return Object.freeze({
    run_cycle_speed: runCycleSpeed,
    run_cycle_distance: runCycleDistance,
  });
}
export function applyRunCalibration(controls, avatar, calibration) {
  const { run_cycle_speed: runCycleSpeed, run_cycle_distance: runCycleDistance } = calibration;
  const snapshot = runCalibrationSnapshot(calibration);
  controls.run_cycle_speed = runCycleSpeed;
  controls.run_cycle_distance = runCycleDistance;
  controls.run_cadence_steps_per_min = runCycleSpeed * 120;
  controls.run_translation_speed_mps = snapshot.effective_run_translation_speed_mps;
  if (avatar) {
    const locomotion = {
      ...controls,
      ...(avatar.locomotion || {}),
      run_cycle_speed: runCycleSpeed,
      run_cycle_distance: runCycleDistance,
      run_cadence_steps_per_min: runCycleSpeed * 120,
      run_translation_speed_mps: snapshot.effective_run_translation_speed_mps,
    };
    if (locomotion.moving === true && locomotion.run_mode === true) {
      locomotion.speed_mps = snapshot.effective_run_translation_speed_mps;
      controls.speed_mps = snapshot.effective_run_translation_speed_mps;
    }
    avatar.locomotion = locomotion;
  }
  return snapshot;
}

export function movementFrame(avatar, stateControls, input, dt) {
  const controls = input || {};
  const forward = (controls.forward ? 1 : 0) - (controls.back ? 1 : 0);
  const strafe = (controls.right ? 1 : 0) - (controls.left ? 1 : 0);
  const hasPlanarInput = forward !== 0 || strafe !== 0;
  const p = clonePosition(avatar.position, [0, 0, 0]);
  return { avatar, stateControls, controls, dt, forward, strafe, hasPlanarInput,
    runMode: hasPlanarInput && controls.run === true, p, previousPosition: p.slice(),
    wasMoving: stateControls.moving === true,
    basisYaw: Number.isFinite(Number(controls.camera_yaw)) ? Number(controls.camera_yaw) : Math.PI };
}

export function boundedPosition(p, x, z, bounds) {
  p[0] = clamp(x, bounds ? bounds.minX : -WORLD_LIMIT, bounds ? bounds.maxX : WORLD_LIMIT);
  p[2] = clamp(z, bounds ? bounds.minZ : -WORLD_LIMIT, bounds ? bounds.maxZ : WORLD_LIMIT);
}

export function publishMovementGround(controls, localGround, rejectedGroundQuery) {
  publishGroundSurface(controls, localGround);
  if (rejectedGroundQuery) {
    controls.ground_query_ok = false;
    controls.ground_query_reason = "outside_classified_walkable_surface_planar_move_rejected";
    controls.ground_query_rejected_xz_m = [Number(rejectedGroundQuery.query_x_m.toFixed(4)), Number(rejectedGroundQuery.query_z_m.toFixed(4))];
  } else controls.ground_query_rejected_xz_m = null;
}

export function publishMovementDirection(frame, dx, dz) {
  const { stateControls: target, controls, basisYaw, forward, strafe } = frame;
  target.movement_basis_yaw = Number(basisYaw.toFixed(6));
  target.movement_basis_source = Number.isFinite(Number(controls.camera_yaw)) ? "camera_relative" : "world_fixed_legacy";
  target.movement_direction = directionFromInput(forward, strafe);
  target.last_planar_delta = [Number(dx.toFixed(4)), 0, Number(dz.toFixed(4))];
  target.facing_semantics = facingSemanticsFromDelta(dx, dz);
}

function legacyPlanar(frame, speed, bounds) {
  const { forward, strafe, basisYaw, dt, p } = frame;
  if (!frame.hasPlanarInput) return { dx: 0, dz: 0 };
  const len = Math.hypot(forward, strafe) || 1;
  const f = forward / len, s = strafe / len;
  const sinB = Math.sin(basisYaw), cosB = Math.cos(basisYaw);
  const dx = (f * sinB - s * cosB) * speed * dt;
  const dz = (f * cosB + s * sinB) * speed * dt;
  // Preserve the requested diagnostic delta even when the world bounds shorten the actual step.
  boundedPosition(p, p[0] + dx, p[2] + dz, bounds);
  return { dx, dz };
}

function legacyVertical(frame, ground, velocity) {
  const wasGrounded = frame.stateControls.grounded !== false;
  const vertical = integrateAirportVerticalMotion({ position_y_m: frame.p[1], ground_y_m: ground.surface_y_m,
    velocity_y_mps: velocity, grounded: wasGrounded, jump_requested: frame.controls.jump === true,
    delta_seconds: frame.dt, jump_speed_mps: JUMP_SPEED_MPS, gravity_mps2: GRAVITY_MPS2 });
  frame.p[1] = vertical.position_y_m;
  frame.stateControls.grounded = vertical.grounded;
  return { ...vertical, changed: frame.controls.jump === true || !wasGrounded || !vertical.grounded || Math.abs(frame.p[1] - frame.previousPosition[1]) > 1e-9 };
}

function publishLegacyStep(frame, step, calibration) {
  const { avatar, stateControls: controls, p, hasPlanarInput, runMode } = frame;
  avatar.position = p;
  controls.enabled = true;
  controls.moving = hasPlanarInput && !step.blocked;
  controls.movement_mode = step.blocked ? "idle" : hasPlanarInput ? (runMode ? "run" : "walk") : "idle";
  controls.run_mode = !step.blocked && runMode;
  controls.speed_mps = step.blocked ? 0 : step.speed;
  controls.run_cycle_speed = calibration.run_cycle_speed;
  controls.run_cycle_distance = calibration.run_cycle_distance;
  controls.run_cadence_steps_per_min = calibration.run_cadence_steps_per_min;
  controls.run_translation_speed_mps = calibration.effective_run_translation_speed_mps;
  publishMovementDirection(frame, step.dx, step.dz);
  controls.jump_height_m = Number(step.vertical.jump_height_m.toFixed(3));
  avatar.locomotion = { ...controls };
}

export function stepLegacyMovement(frame, options, resolveGround) {
  const { calibration, bounds, velocity } = options;
  const speed = frame.hasPlanarInput ? frame.runMode ? calibration.effective_run_translation_speed_mps : MOVE_SPEED_MPS : 0;
  let { dx, dz } = legacyPlanar(frame, speed, bounds);
  let localGround = resolveGround(frame.p[0], frame.p[2]);
  const rejected = localGround.ok ? null : localGround;
  if (!localGround.ok) {
    frame.p[0] = frame.previousPosition[0]; frame.p[2] = frame.previousPosition[2];
    dx = 0; dz = 0; localGround = frame.currentGround;
  }
  if (frame.hasPlanarInput && !rejected) frame.avatar.rotation_y = Math.atan2(dx, dz);
  const vertical = legacyVertical(frame, localGround, velocity);
  publishMovementGround(frame.stateControls, localGround, rejected);
  const active = frame.hasPlanarInput || frame.controls.jump || vertical.changed || !frame.stateControls.grounded || frame.wasMoving;
  if (active) publishLegacyStep(frame, { speed, dx, dz, blocked: !!rejected, vertical }, calibration);
  return { active: !!active, moving: frame.hasPlanarInput && !rejected, velocity: vertical.velocity_y_mps, forward: frame.forward, strafe: frame.strafe };
}
