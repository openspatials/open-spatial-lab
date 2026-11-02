// locomotion.mjs: the movement code. It moves the avatar's origin (at its feet) over the floor, turns it at a
// bounded rate, and runs the jump's physics. It never touches bones.
//
// Public API
//   createTuning(clipData)  all speeds and times, from the avatar's prepared file (<id>.avatar.json)
//   class Locomotion
//     constructor(tuning, { x, z, yaw })
//     update(dt, input)     input: { forward, right, jog, jump, cameraYaw } (forward/right in -1..1)
//     timeToContact()       seconds until the feet reach the floor, while in the air
//     motionState()         what AvatarMotion needs: { speed, phase, phaseTime, turnRate, timeToContact, landMoving, crouchTime }
//     snapshot(t)           the network state for other visitors
//   Fields: position (Vector3), quaternion (facing), yaw, speed, vy, grounded, phase, phaseTime
//
// Jump phases: none -> crouch (anticipation, the start clip held on its first frame) -> push (the start clip plays)
// -> air (from the clip's measured takeoff) -> land (from floor contact) -> none.

import * as THREE from '../../vendor/scene-core/vendor/three/three.module.js';

const DEG = Math.PI / 180;
const UP = new THREE.Vector3(0, 1, 0);

export function createTuning(clipData) {
  const c = clipData.clips;
  const walkRate = 1.2; // walk cadence 108 steps a minute; the movement speed follows, so the feet stay planted
  // Size: the character's hips height over the clip pack's (its prepared pelvis scale; 1 for the mannequin). Speed
  // changes scale with it, so a small character's walk and jog blends last as long as the mannequin's (the walk
  // weight follows speed / walk speed; Tavi, 0.40, would otherwise go from walk to idle in two or three frames).
  const size = clipData.clip_pack?.pelvis_position_scale ?? 1;
  const jogRate = 1.0;
  return {
    walkRate,
    jogRate,
    walkSpeed: c.walk.speed_mps * walkRate,
    jogSpeed: c.jog.speed_mps * jogRate,
    walkCycle: c.walk.duration_s,
    jogCycle: c.jog.duration_s,
    walkTouchdown: c.walk.left_touchdown_phase,
    jogTouchdown: c.jog.left_touchdown_phase,
    minRate: 0.8,
    maxRate: 1.25,
    accel: 8 * size, // m/s^2 on the mannequin; the jog is a fast run (about 6 m/s), so gait changes must not take seconds
    decel: 10 * size,
    turnGain: 10, // 1/s: smooth approach near the target heading
    turnRateInPlace: 270 * DEG,
    turnRateWalk: 400 * DEG,
    turnRateJog: 320 * DEG,
    turnRateAir: 120 * DEG,
    turnRateCap: 540 * DEG,
    inPlaceSpeed: 0.3,
    jumpApex: 0.75,
    gravity: 9.81,
    crouchStanding: 0.18, // standing jump: fade into the start clip's crouch, the anticipation
    runningJumpFade: 0.2, // moving jump: takes off at once; the stride blends into the air pose while airborne
    runningJumpSpeed: 0.5, // fraction of walk speed above which a jump takes off from the stride
    takeoffClipTime: c.jumpStart.takeoff_time_s,
    landLead: 0.2, // the legs reach for the floor this long before contact (a fixed fade)
    loopAfterTakeoff: 0.25, // the air loop takes over this long after takeoff, or at the top, whichever is first
    landSettle: c.jumpLand.settle_time_s,
    landDuration: c.jumpLand.duration_s,
    movingLandHold: 0.12, // a landing while moving shows the impact this long, then blends back into the stride
  };
}

const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

export class Locomotion {
  constructor(tuning, { x = 0, z = 0, yaw = 0 } = {}) {
    this.tuning = tuning;
    this.position = new THREE.Vector3(x, 0, z);
    this.quaternion = new THREE.Quaternion().setFromAxisAngle(UP, yaw);
    this.yaw = yaw;
    this.speed = 0;
    this.vy = 0;
    this.grounded = true;
    this.phase = 'none';
    this.phaseTime = 0;
    this.crouchTime = tuning.crouchStanding;
    this.jumpStyle = 'standing';
    this.landMoving = false;
    this.turnRate = 0;
    this._jumpHeld = false;
    this._targetQ = new THREE.Quaternion();
  }

  _setPhase(p) {
    this.phase = p;
    this.phaseTime = 0;
  }

  update(dt, input) {
    const T = this.tuning;
    const fwd = input.forward || 0;
    const right = input.right || 0;
    const moving = Math.hypot(fwd, right) > 0.1;
    const cy = input.cameraYaw || 0;
    // Camera looks along (sin cy, cos cy) on the floor; its right is (-cos cy, sin cy).
    const dx = Math.sin(cy) * fwd - Math.cos(cy) * right;
    const dz = Math.cos(cy) * fwd + Math.sin(cy) * right;
    const desiredYaw = moving ? Math.atan2(dx, dz) : this.yaw;
    const err = wrapAngle(desiredYaw - this.yaw);

    this.phaseTime += dt;
    const jumpPressed = !!input.jump && !this._jumpHeld;
    this._jumpHeld = !!input.jump;

    // Jump state machine.
    if (this.phase === 'none' && jumpPressed && this.grounded) {
      this.jumpStyle = this.speed > T.runningJumpSpeed * T.walkSpeed ? 'running' : 'standing';
      if (this.jumpStyle === 'running') {
        // A moving jump leaves the floor from the stride, at once.
        this.crouchTime = 0;
        this.vy = Math.sqrt(2 * T.gravity * T.jumpApex);
        this.grounded = false;
        this._setPhase('air');
      } else {
        this.crouchTime = T.crouchStanding;
        this._setPhase('crouch');
      }
    } else if (this.phase === 'crouch' && this.phaseTime >= this.crouchTime) {
      this._setPhase('push');
    } else if (this.phase === 'push' && this.phaseTime >= T.takeoffClipTime) {
      this.vy = Math.sqrt(2 * T.gravity * T.jumpApex);
      this.grounded = false;
      this._setPhase('air');
    } else if (this.phase === 'land') {
      const hold = this.landMoving ? T.movingLandHold : (moving ? T.landSettle : T.landDuration);
      if (this.phaseTime >= hold) this._setPhase('none');
    }

    // Horizontal speed.
    let target = this.speed;
    let accel = T.accel;
    if (this.phase === 'none') {
      const base = input.jog ? T.jogSpeed : T.walkSpeed;
      if (!moving) target = 0;
      else if (this.speed < T.inPlaceSpeed && Math.abs(err) > 60 * DEG) target = 0; // turn on the spot first
      else target = Math.abs(err) > 120 * DEG ? base * 0.3 : base;
      accel = target < this.speed ? T.decel : T.accel;
    } else if (this.phase === 'land' && !this.landMoving) {
      target = 0;
      accel = T.decel;
    }
    const dv = target - this.speed;
    this.speed += Math.sign(dv) * Math.min(Math.abs(dv), accel * dt);

    // Facing: Quaternion.rotateTowards at a bounded rate, with a smooth approach near the target.
    let cap;
    if (!this.grounded) cap = T.turnRateAir;
    else if (this.phase === 'land' && !this.landMoving) cap = 0;
    else if (this.speed < T.inPlaceSpeed) cap = T.turnRateInPlace;
    else if (this.speed <= T.walkSpeed) cap = T.turnRateWalk;
    else cap = T.turnRateJog;
    cap = Math.min(cap, T.turnRateCap);
    const rate = Math.min(cap, T.turnGain * Math.abs(err));
    const before = this.yaw;
    if (moving && rate > 0) {
      this._targetQ.setFromAxisAngle(UP, desiredYaw);
      this.quaternion.rotateTowards(this._targetQ, rate * dt);
      const e = new THREE.Euler().setFromQuaternion(this.quaternion, 'YXZ');
      this.yaw = e.y;
    }
    this.turnRate = dt > 0 ? wrapAngle(this.yaw - before) / dt : 0;

    // Move along the facing direction.
    this.position.x += Math.sin(this.yaw) * this.speed * dt;
    this.position.z += Math.cos(this.yaw) * this.speed * dt;

    // Vertical.
    if (!this.grounded) {
      this.position.y += this.vy * dt - 0.5 * T.gravity * dt * dt;
      this.vy -= T.gravity * dt;
      if (this.position.y <= 0) {
        this.position.y = 0;
        this.vy = 0;
        this.grounded = true;
        this.landMoving = this.speed > 0.5 * T.walkSpeed;
        this._setPhase('land');
      }
    }
  }

  timeToContact() {
    if (this.grounded) return 0;
    const g = this.tuning.gravity;
    const y = this.position.y;
    const v = this.vy;
    return (v + Math.sqrt(v * v + 2 * g * y)) / g;
  }

  motionState() {
    return {
      speed: this.speed,
      phase: this.phase,
      phaseTime: this.phaseTime,
      turnRate: this.turnRate,
      vy: this.vy,
      timeToContact: this.timeToContact(),
      landMoving: this.landMoving,
      crouchTime: this.crouchTime,
      jumpStyle: this.jumpStyle,
    };
  }

  snapshot(t) {
    return {
      t,
      x: this.position.x,
      y: this.position.y,
      z: this.position.z,
      yaw: this.yaw,
      speed: this.speed,
      vy: this.vy,
      phase: this.phase,
      phaseStart: t - this.phaseTime,
      landMoving: this.landMoving,
      crouchTime: this.crouchTime,
      jumpStyle: this.jumpStyle,
    };
  }
}
