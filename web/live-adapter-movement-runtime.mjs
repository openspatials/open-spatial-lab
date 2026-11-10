import { Locomotion } from "./avatar/runtime/locomotion.mjs";
import { motionRecord } from "./avatar/actionforge-avatar.mjs";
import { clonePosition } from "./live-adapter-portal-geometry.mjs";
import { boundedPosition, publishMovementGround, publishMovementDirection } from "./live-adapter-movement.mjs";

export function runtimeLocomotion(previous, tuning, avatar, groundY) {
  if (!tuning) return null;
  const p = clonePosition(avatar.position, [0, 0, 0]);
  let loco = previous;
  const moved = loco && Math.hypot(loco.position.x - p[0], loco.position.z - p[2]) > 1e-4;
  if (!loco || moved) {
    const yaw = Number(avatar.rotation_y) || 0;
    if (!loco) loco = new Locomotion(tuning, { x: p[0], z: p[2], yaw });
    else {
      loco.position.set(p[0], 0, p[2]);
      loco.quaternion.setFromAxisAngle({ x: 0, y: 1, z: 0 }, yaw);
      loco.yaw = yaw;
      loco.speed = 0;
      loco.vy = 0;
      loco.grounded = true;
      loco._setPhase("none");
    }
    loco.position.y = Math.max(0, (Number(p[1]) || 0) - groundY);
  }
  return loco;
}
export function publishRuntimeGroundMotion(avatar, controls, tuning, dt) {
  if (!tuning || !avatar) return;
  const d = (dt > 0 && controls.moving && controls.last_planar_delta) || [0, 0, 0];
  const speed = dt > 0 ? Math.hypot(d[0], d[2]) / dt : 0;
  const nowS = (typeof performance !== "undefined" ? performance.now() : Date.now()) / 1000;
  controls.speed_mps = Number(speed.toFixed(4));
  controls.jump_height_m = 0;
  controls.grounded = true;
  controls.motion = {
    runtime: "actionforge", speed_mps: Number(speed.toFixed(4)), phase: "none", phase_started_s: nowS,
    crouch_time_s: tuning.crouchStanding, jump_style: "standing", land_moving: false, vy_mps: 0, turn_rate: 0, at_s: nowS,
  };
  avatar.locomotion = { ...controls };
  return true;
}

function runtimePlanar(frame, bounds, loco, resolveGround) {
  const { forward, strafe, runMode, controls, basisYaw, dt, p, previousPosition } = frame;
  const start = { x: loco.position.x, z: loco.position.z };
  loco.update(dt, { forward, right: strafe, jog: runMode, jump: controls.jump === true, cameraYaw: basisYaw });
  const wantX = previousPosition[0] + (loco.position.x - start.x);
  const wantZ = previousPosition[2] + (loco.position.z - start.z);
  boundedPosition(p, wantX, wantZ, bounds);
  let ground = resolveGround(p[0], p[2]);
  const rejected = ground.ok ? null : ground;
  if (rejected) {
    p[0] = previousPosition[0]; p[2] = previousPosition[2]; ground = frame.currentGround; loco.speed = 0;
  } else if (p[0] !== wantX || p[2] !== wantZ) {
    loco.speed = Math.min(loco.speed, Math.hypot(p[0] - previousPosition[0], p[2] - previousPosition[2]) / dt);
  }
  loco.position.x = p[0]; loco.position.z = p[2];
  return { ground, rejected, dx: p[0] - previousPosition[0], dz: p[2] - previousPosition[2] };
}

function publishRuntimeStep(frame, step, loco, tuning) {
  const { avatar, stateControls: controls, p, runMode } = frame;
  avatar.position = p;
  const moving = loco.speed > 0.01 && !step.rejected;
  controls.enabled = true; controls.moving = moving;
  controls.movement_mode = moving ? (loco.speed > tuning.walkSpeed + 0.05 ? "run" : "walk") : "idle";
  controls.run_mode = moving && runMode;
  controls.speed_mps = Number(loco.speed.toFixed(4));
  publishMovementDirection(frame, step.dx, step.dz);
  controls.jump_height_m = Number(loco.position.y.toFixed(3));
  controls.motion = motionRecord(loco, (typeof performance !== "undefined" ? performance.now() : Date.now()) / 1000);
  avatar.locomotion = { ...controls };
  return moving;
}

export function stepRuntimeMovement(frame, options, loco, resolveGround) {
  const step = runtimePlanar(frame, options.bounds, loco, resolveGround);
  frame.p[1] = step.ground.surface_y_m + loco.position.y;
  frame.avatar.rotation_y = loco.yaw;
  frame.stateControls.grounded = loco.grounded;
  publishMovementGround(frame.stateControls, step.ground, step.rejected);
  const active = frame.hasPlanarInput || frame.controls.jump === true || loco.speed > 0 || loco.phase !== "none" ||
    !loco.grounded || Math.abs(loco.turnRate) > 1e-6 || Math.abs(frame.p[1] - frame.previousPosition[1]) > 1e-9 || frame.wasMoving;
  const moving = active && publishRuntimeStep(frame, step, loco, options.tuning);
  return { active, moving, velocity: loco.vy, forward: frame.forward, strafe: frame.strafe };
}
