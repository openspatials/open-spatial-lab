// remote-avatar.mjs: another visitor, drawn from network snapshots (about 15 a second).
//
// Public API
//   class RemoteAvatar
//     constructor(tuning, { delay = 0.1 })
//     push(snapshot, localTime)   snapshot from Locomotion.snapshot(t) on the sender
//     sample(localTime, dt)       { position, yaw, ...motion state } drawn `delay` seconds behind the newest snapshot
//
// Positions interpolate linearly on the floor. In the air, height follows the same ballistic arc the sender uses,
// from the sender's takeoff time, so the arc is exact and the landing time is known ahead. Heading interpolates by the shortest arc and then turns at a bounded rate. The speed fed
// to the animation is the sender's own, interpolated, so walk and jog stay matched to the drawn motion.

import * as THREE from '../../vendor/scene-core/vendor/three/three.module.js';

const UP = new THREE.Vector3(0, 1, 0);
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

export class RemoteAvatar {
  constructor(tuning, { delay = 0.1 } = {}) {
    this.tuning = tuning;
    this.delay = delay;
    this.buffer = [];
    this.offsets = [];
    this.offset = null;
    this.position = new THREE.Vector3();
    this.quaternion = new THREE.Quaternion();
    this.yaw = 0;
    this._q = new THREE.Quaternion();
    this._started = false;
  }

  push(snap, localTime) {
    if (this.buffer.length && snap.t <= this.buffer[this.buffer.length - 1].t) return;
    this.buffer.push(snap);
    while (this.buffer.length > 64) this.buffer.shift();
    // Sender clock minus local clock; the least-delayed message gives the largest value.
    this.offsets.push({ v: snap.t - localTime, at: localTime });
    while (this.offsets.length && this.offsets[0].at < localTime - 2) this.offsets.shift();
    this.offset = Math.max(...this.offsets.map((o) => o.v));
  }

  sample(localTime, dt) {
    const B = this.buffer;
    if (!B.length) return null;
    const rt = localTime + this.offset - this.delay;
    let a = B[0];
    let b = B[0];
    if (rt <= B[0].t) {
      a = b = B[0];
    } else if (rt >= B[B.length - 1].t) {
      a = b = B[B.length - 1];
    } else {
      for (let i = 0; i < B.length - 1; i++) {
        if (B[i].t <= rt && rt <= B[i + 1].t) { a = B[i]; b = B[i + 1]; break; }
      }
    }
    const span = b.t - a.t;
    const u = span > 0 ? (rt - a.t) / span : 0;
    const x = a.x + (b.x - a.x) * u;
    const z = a.z + (b.z - a.z) * u;
    let y = 0;
    let vy = 0;
    let ttc = 0;
    const g = this.tuning.gravity;
    const cur = rt >= b.phaseStart && b.phase !== a.phase ? b : a;
    if (cur.phase === 'air') {
      const v0 = Math.sqrt(2 * g * this.tuning.jumpApex);
      const tau = Math.max(0, rt - cur.phaseStart);
      const landing = B.find((s) => s.t > cur.t && s.phase !== 'air');
      const contactAt = landing ? landing.phaseStart : cur.phaseStart + (2 * v0) / g;
      y = Math.max(0, v0 * tau - 0.5 * g * tau * tau);
      vy = v0 - g * tau;
      ttc = Math.max(0, contactAt - rt);
    }
    const yawTarget = a.yaw + wrapAngle(b.yaw - a.yaw) * u;
    const speed = a.speed + (b.speed - a.speed) * u;

    this.position.set(x, y, z);
    const before = this.yaw;
    this._q.setFromAxisAngle(UP, yawTarget);
    if (!this._started) {
      this.quaternion.copy(this._q);
      this._started = true;
    } else {
      this.quaternion.rotateTowards(this._q, this.tuning.turnRateCap * dt);
    }
    this.yaw = new THREE.Euler().setFromQuaternion(this.quaternion, 'YXZ').y;
    const grounded = cur.phase !== 'air';
    return {
      position: this.position,
      quaternion: this.quaternion,
      yaw: this.yaw,
      speed,
      phase: cur.phase,
      phaseTime: Math.max(0, rt - cur.phaseStart),
      turnRate: dt > 0 ? wrapAngle(this.yaw - before) / dt : 0,
      vy,
      timeToContact: grounded ? 0 : ttc,
      landMoving: cur.landMoving,
      crouchTime: cur.crouchTime,
      jumpStyle: cur.jumpStyle,
      renderTime: rt,
      equipped: (rt >= b.t ? b : a).equipped,
    };
  }
}
