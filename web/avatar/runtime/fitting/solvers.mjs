// solvers.mjs: the named solvers. They run after the animation mixer, in a fixed order, and they are the only code that
// may change a bone after it. The math is the viewer's (vendor/avatar-ik.mjs, see SOURCES.md); this file reads the body
// details, turns three.js bones into the plain records that math takes, and writes its answers back.
//
//   plant-feet    two-bone legs. A foot whose sole would go through the floor is lifted straight up until its lowest sole
//                 point is on the floor; the foot keeps the clip's turn. The foot's sideways place stays the clip's, so
//                 a clip played at the wrong rate still shows as sliding (proof check A2).
//   reach-hands   two-bone arms. A carried item's contact points are hand targets: the palm goes onto the point and the
//                 hand takes the contact's axes. A target beyond the arm's reach turns the shoulder toward it, up to
//                 SOLVER_LIMITS.shoulderAssistDeg. Fades with the stance (STANCE_FADE_S).
//   avoid-arms    arm avoidance. The forearm is pushed out of capsules filling the head's volume (and the torso's, when asked),
//                 the shoulder stays (the viewer's solveArmAvoid). The hand keeps its turn on the forearm, so an exact pass follows: the
//                 deepest forearm or hand point still inside a box moves the wrist out by that depth (two-bone arm). Both
//                 corrections shrink to nothing at contact, so they start without a jump. An arm under reach-hands is left alone.
//
// Order: plant-feet, reach-hands, avoid-arms. Each frame: restore() before the mixer, run() after it. three.js writes a bone only
// when the mixer's value changed, so a solver's answer left on a bone would stay there and be solved again; restore()
// puts back what the mixer last wrote.
//
// All solving is in the holder's frame (+Y up, +Z the avatar's forward, metres), so one floor height and one "forward"
// serve every rig. Local rotations come out in each bone's own axes: rig structure does not matter here.
//
// Public API
//   SOLVER_NAMES                        the allowed solvers, in order
//   SOLVER_LIMITS                       the numbers the solvers work to, with reasons
//   capsulesFromBox(min, max, cell)     capsules covering a box's shell, in the box's frame
//   class SolverStack
//     constructor(instance, body, { disable: [names], avoidTorso, fade })
//     restore()                         before mixer.update
//     run({ dt, floorY })               after mixer.update; floorY in world metres (default 0)
//     setCarry(carry)                   { item, node (the item's object: drawn only once the hands are on it), contacts (this body's, default item.contacts), anchor (bone), local (Matrix4:
//                                       item in the anchor's frame) } or null
//     report                            last frame: { changed: { name: Set(bone names) }, shortfall_m, push_m, residual_m, dip_m, weight }
//     handTargets(side)                 for checks: { palm (Vector3 world, where the palm is now), target (world) }
//     chains                            { leg: {l, r}, arm: {l, r} } or null when a chain's bones are not parent and child
//
// No DOM use: browser and Node.

import * as THREE from '../../../vendor/scene-core/vendor/three/three.module.js';
import { solveTwoBoneLeg, solveArmAvoid } from './vendor/avatar-ik.mjs';
import { SIDES, sideName } from './roles.mjs';
import { SHOULDER_ASSIST_DEG } from './holds.mjs';

export const SOLVER_NAMES = ['plant-feet', 'reach-hands', 'avoid-arms'];
export const STANCE_FADE_S = 0.25;

export const SOLVER_LIMITS = {
  // Arm avoidance (the viewer's iterations and margin): fixed count, so identical frames give identical answers; a 1.5 cm skin.
  avoidIterations: 4,
  avoidMarginM: 0.015,
  // A wrist is never pushed further than this share of the arm's length from the clip's pose (the viewer's 0.25 m on a
  // 0.5 m arm); beyond it the push scales back and the rest is reported as residual.
  avoidMaxPushShare: 0.5,
  // The most a shoulder (clavicle) may turn to help a hand reach. Above this a shoulder reads as dislocated on the test bodies.
  shoulderAssistDeg: SHOULDER_ASSIST_DEG,
  // A capsule's radius as a share of the box's smallest side.
  capsuleCellShare: 0.34,
  // The exact pass: at most this many corrections a frame, each leaving this skin between the arm and the box.
  clearIterations: 3,
  clearSkinM: 0.003,
  // The exact pass keeps the arm this far outside the volume. The volume's box is in the rest-aligned frame; a box round the same
  // vertices in the head bone's own frame (the proof's E5 and L3) differs by the bone's tilt: Tavi's 1.9 degrees reach 1.04 cm at the
  // box's far side, measured on the proof's timeline (a hand crossing the head while a stance fades in). The correction still starts from nothing.
  clearMarginM: 0.012,
};

const cfgLeg = { maxExtendRatio: 0.9995 };
const ENTRIES = [{ parentJoint: -1 }, { parentJoint: 0 }, { parentJoint: 1 }, { parentJoint: 2 }];
const CHAIN = { up: 1, lo: 2, foot: 3, hand: 3 };

const qArr = (q) => [q.x, q.y, q.z, q.w];
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _m = new THREE.Matrix4();

// Fills a box's shell with parallel capsules along its longest side: a grid of axes across the other two sides, outer
// cells only. The capsules stay inside the box and touch its faces; its corners are left to the exact pass in avoid-arms.
export function capsulesFromBox(min, max, share = SOLVER_LIMITS.capsuleCellShare) {
  const size = [0, 1, 2].map((i) => max[i] - min[i]);
  const long = size.indexOf(Math.max(...size));
  const [u, w] = [0, 1, 2].filter((i) => i !== long);
  const small = Math.min(size[u], size[w]);
  const r = small * share;
  const nU = Math.max(1, Math.ceil(size[u] / (2 * r)));
  const nW = Math.max(1, Math.ceil(size[w] / (2 * r)));
  const at = (lo, hi, n, i) => (n === 1 ? (lo + hi) / 2 : lo + r + ((hi - lo - 2 * r) * i) / (n - 1));
  const out = [];
  for (let i = 0; i < nU; i++) for (let j = 0; j < nW; j++) {
    if (i > 0 && i < nU - 1 && j > 0 && j < nW - 1) continue;
    const a = [0, 0, 0], b = [0, 0, 0];
    a[u] = b[u] = at(min[u], max[u], nU, i);
    a[w] = b[w] = at(min[w], max[w], nW, j);
    a[long] = min[long] + r;
    b[long] = max[long] - r;
    out.push({ a, b, r });
  }
  return out;
}

export class SolverStack {
  constructor(instance, body, { disable = [], avoidTorso = false, fade = STANCE_FADE_S } = {}) {
    this.instance = instance;
    this.body = body;
    this.disabled = new Set(disable);
    this.fade = fade;
    this.avoidTorso = avoidTorso;
    this.carry = null;
    this.carryWeight = 0;
    this.carryTarget = 0;
    this.report = { changed: Object.fromEntries(SOLVER_NAMES.map((n) => [n, new Set()])), shortfall_m: 0, push_m: 0, residual_m: 0, dip_m: 0, weight: 0 };
    const B = (role) => { const n = body.roles[role]; return n ? instance.bones[n] : null; };
    this.bone = B;
    const chain = (a, b, c) => {
      const up = B(a), lo = B(b), end = B(c);
      return up && lo && end && lo.parent === up && end.parent === lo ? { up, lo, end, parent: up.parent } : null;
    };
    this.chains = { leg: {}, arm: {} };
    for (const s of SIDES) {
      const n = sideName(s);
      this.chains.leg[s] = chain(`${n}UpperLeg`, `${n}LowerLeg`, `${n}Foot`);
      this.chains.arm[s] = chain(`${n}UpperArm`, `${n}LowerArm`, `${n}Hand`);
      const sh = B(`${n}Shoulder`);
      if (this.chains.arm[s] && sh && this.chains.arm[s].up.parent === sh && sh.parent) this.chains.arm[s].shoulder = sh;
    }
    // What the solvers may write, with room for the mixer's value of each.
    this.saved = new Map();
    for (const group of Object.values(this.chains)) for (const c of Object.values(group)) if (c) for (const b of [c.shoulder, c.up, c.lo, c.end].filter(Boolean)) this.saved.set(b, { q: new THREE.Quaternion(), held: false });
    // The volumes as capsules in their role's rest-aligned frame.
    const vol = (v) => (v && v.min_m ? { role: v.origin_role, rest: new THREE.Quaternion().fromArray(body.rest_pose[body.roles[v.origin_role]].rotation).invert(), caps: capsulesFromBox(v.min_m, v.max_m), min: v.min_m, max: v.max_m } : null);
    this.volumes = [vol(body.volumes?.head)].filter(Boolean);
    if (avoidTorso) for (const p of Object.values(body.volumes?.torso_parts || {})) { const x = vol(p); if (x) this.volumes.push(x); }
    this._holderInv = new THREE.Matrix4();
    this._targets = { l: null, r: null };
  }

  has(name) { return !this.disabled.has(name); }

  setCarry(carry) {
    if (carry) {
      this.carry = carry;
      this.carryTarget = 1;
    } else this.carryTarget = 0;
  }

  // ---------- frame ----------
  restore() {
    for (const [b, s] of this.saved) if (s.held) { b.quaternion.copy(s.q); s.held = false; }
  }

  _write(name, bone, q) {
    const s = this.saved.get(bone);
    if (!s.held) { s.q.copy(bone.quaternion); s.held = true; }
    bone.quaternion.fromArray(q);
    this.report.changed[name].add(bone.name);
  }

  // A bone's rotation and joint position in the holder's frame.
  _frame(bone) {
    _m.multiplyMatrices(this._holderInv, bone.matrixWorld).decompose(_p, _q, _s);
    return { p: _p.toArray(), q: qArr(_q) };
  }

  _chainRecords(c) {
    const fs = [c.parent, c.up, c.lo, c.end].map((b) => this._frame(b));
    return { wp: fs.map((f) => f.p), wr: fs.map((f) => f.q) };
  }

  run({ dt = 0, floorY = 0 } = {}) {
    const rep = this.report;
    for (const n of SOLVER_NAMES) rep.changed[n].clear();
    rep.shortfall_m = rep.push_m = rep.residual_m = rep.dip_m = 0;
    const holder = this.instance.holder;
    holder.updateMatrixWorld(true);
    this._holderInv.copy(holder.matrixWorld).invert();
    if (this.has('plant-feet')) this._plantFeet(floorY - holder.position.y);
    this._updateCarryWeight(dt);
    if (this.carry?.node) this.carry.node.visible = this.carryWeight >= 1; // a carried item appears when the hands arrive
    if (this.has('reach-hands')) this._reachHands();
    if (this.has('avoid-arms')) this._avoidArms();
    rep.weight = this.carryWeight;
  }

  // ---------- plant-feet ----------
  _solePoints(side) {
    return this.body.feet?.[side]?.sole_points_m || null;
  }

  // Lowest point of a foot's sole, holder frame.
  _lowest(side) {
    const n = sideName(side);
    const pts = this._solePoints(side);
    let low = Infinity;
    const scan = (bone, list) => {
      if (!bone || !list?.length) return;
      _m.multiplyMatrices(this._holderInv, bone.matrixWorld).decompose(_p, _q, _s);
      const m = _m.elements;
      // A point in metres in the bone's axes: joint + rotation * point. y row of the rotation only.
      const r10 = m[1] / _s.x, r11 = m[5] / _s.y, r12 = m[9] / _s.z;
      for (const v of list) { const y = _p.y + r10 * v[0] + r11 * v[1] + r12 * v[2]; if (y < low) low = y; }
    };
    scan(this.bone(`${n}Foot`), pts.foot);
    scan(this.bone(`${n}Toes`), pts.toes);
    return low;
  }

  _plantFeet(floor) {
    for (const s of SIDES) {
      const c = this.chains.leg[s];
      if (!c || !this._solePoints(s)) continue;
      const low = this._lowest(s);
      const dip = floor - low;
      if (!(dip > 0)) continue;
      const { wp, wr } = this._chainRecords(c);
      const target = [wp[3][0], wp[3][1] + dip, wp[3][2]];
      const out = solveTwoBoneLeg(ENTRIES, CHAIN, wr, wp, target, null, cfgLeg);
      if (!out) continue;
      this.report.dip_m = Math.max(this.report.dip_m, dip);
      this.report.shortfall_m = Math.max(this.report.shortfall_m, out.shortfall);
      const [up, lo] = out.joints;
      // The foot keeps the clip's turn in the world.
      const pw = new THREE.Quaternion().fromArray(wr[0]);
      const upW = pw.clone().multiply(new THREE.Quaternion().fromArray(up.rotation));
      const loW = upW.clone().multiply(new THREE.Quaternion().fromArray(lo.rotation));
      const foot = loW.invert().multiply(new THREE.Quaternion().fromArray(wr[3]));
      this._write('plant-feet', c.up, up.rotation);
      this._write('plant-feet', c.lo, lo.rotation);
      this._write('plant-feet', c.end, qArr(foot));
      c.up.updateWorldMatrix(false, true);
    }
  }

  // ---------- reach-hands ----------
  _updateCarryWeight(dt) {
    const step = this.fade > 0 ? dt / this.fade : 1;
    this.carryWeight = this.carryWeight < this.carryTarget ? Math.min(this.carryTarget, this.carryWeight + step) : Math.max(this.carryTarget, this.carryWeight - step);
    if (this.carryWeight === 0 && this.carryTarget === 0) this.carry = null;
  }

  // The hand's wanted rotation and wrist place in the holder's frame, from the contact on the carried item.
  _handGoal(side) {
    const { item, contacts, anchor, local } = this.carry;
    const contact = (contacts || item.contacts)?.[side];
    const hand = this.body.hands?.[side];
    if (!contact || !hand) return null;
    const box = new THREE.Matrix4().multiplyMatrices(this._holderInv, anchor.matrixWorld).multiply(local);
    const point = new THREE.Vector3().fromArray(contact.point).applyMatrix4(box);
    box.decompose(_p, _q, _s);
    const boxQ = _q.clone();
    const basis = (a0, f0) => {
      const a = a0.clone().normalize();
      const f = f0.clone().addScaledVector(a, -f0.dot(a)).normalize();
      return new THREE.Matrix4().makeBasis(a, f, new THREE.Vector3().crossVectors(a, f));
    };
    const want = basis(new THREE.Vector3().fromArray(contact.grip_axis).applyQuaternion(boxQ), new THREE.Vector3().fromArray(contact.forward_axis).applyQuaternion(boxQ));
    const has = basis(new THREE.Vector3().fromArray(hand.grip_frame.knuckle_axis), new THREE.Vector3().fromArray(hand.grip_frame.forward_axis));
    const rot = new THREE.Quaternion().setFromRotationMatrix(want.multiply(has.transpose()));
    const wrist = point.clone().sub(new THREE.Vector3().fromArray(hand.palm_m).applyQuaternion(rot));
    return { point, rot, wrist };
  }

  _reachHands() {
    if (!this.carry || this.carryWeight <= 0) return;
    const w = this.carryWeight;
    const blend = (bone, q) => (w >= 1 ? q : qArr(bone.quaternion.clone().slerp(new THREE.Quaternion().fromArray(q), w)));
    for (const s of SIDES) {
      const c = this.chains.arm[s];
      if (!c) continue;
      const goal = this._handGoal(s);
      if (!goal) continue;
      this._assistShoulder(c, goal, blend);
      const { wp, wr } = this._chainRecords(c);
      const out = solveTwoBoneLeg(ENTRIES, CHAIN, wr, wp, goal.wrist.toArray(), null, cfgLeg);
      if (!out) continue;
      this.report.shortfall_m = Math.max(this.report.shortfall_m, out.shortfall);
      const [up, lo] = out.joints;
      const pw = new THREE.Quaternion().fromArray(wr[0]);
      const upW = pw.clone().multiply(new THREE.Quaternion().fromArray(up.rotation));
      const loW = upW.clone().multiply(new THREE.Quaternion().fromArray(lo.rotation));
      const hand = loW.invert().multiply(goal.rot);
      this._write('reach-hands', c.up, blend(c.up, up.rotation));
      this._write('reach-hands', c.lo, blend(c.lo, lo.rotation));
      this._write('reach-hands', c.end, blend(c.end, qArr(hand)));
      c.up.updateWorldMatrix(false, true);
    }
  }

  // Turn the shoulder toward a wrist target beyond the arm's reach, by the least that brings it in reach.
  _assistShoulder(c, goal, blend) {
    if (!c.shoulder) return;
    const F = (b) => { const f = this._frame(b); return { p: new THREE.Vector3().fromArray(f.p), q: new THREE.Quaternion().fromArray(f.q) }; };
    const sh = F(c.shoulder), up = F(c.up), lo = F(c.lo), end = F(c.end);
    const reach = (up.p.distanceTo(lo.p) + lo.p.distanceTo(end.p)) * cfgLeg.maxExtendRatio * 0.995;
    if (up.p.distanceTo(goal.wrist) <= reach) return;
    const a0 = up.p.clone().sub(sh.p);
    const axis = new THREE.Vector3().crossVectors(a0, goal.wrist.clone().sub(sh.p));
    if (axis.length() < 1e-9) return;
    axis.normalize();
    const limit = (SOLVER_LIMITS.shoulderAssistDeg * Math.PI) / 180;
    const turn = new THREE.Quaternion();
    const gap = (ang) => turn.setFromAxisAngle(axis, ang) && a0.clone().applyQuaternion(turn).add(sh.p).distanceTo(goal.wrist) - reach;
    let lo2 = 0, hi2 = limit;
    if (gap(hi2) > 0) lo2 = hi2;
    else for (let i = 0; i < 12; i++) { const m = (lo2 + hi2) / 2; if (gap(m) > 0) lo2 = m; else hi2 = m; }
    const ang = gap(hi2) > 0 ? limit : hi2;
    turn.setFromAxisAngle(axis, ang);
    const parentQ = F(c.shoulder.parent).q;
    const local = parentQ.clone().invert().multiply(turn).multiply(sh.q);
    this._write('reach-hands', c.shoulder, blend(c.shoulder, qArr(local)));
    c.shoulder.updateWorldMatrix(false, true);
  }

  // Where the palm is and where it should be, world metres (checks).
  handTargets(side) {
    if (!this.carry) return null;
    this._holderInv.copy(this.instance.holder.matrixWorld).invert();
    const goal = this._handGoal(side);
    if (!goal) return null;
    const c = this.chains.arm[side];
    const hand = this.body.hands[side];
    c.end.matrixWorld.decompose(_p, _q, _s);
    const palm = new THREE.Vector3().fromArray(hand.palm_m).applyQuaternion(_q).add(_p);
    return { palm, target: goal.point.clone().applyMatrix4(this.instance.holder.matrixWorld) };
  }

  // ---------- avoid-arms ----------
  _avoidCapsules() {
    const out = [];
    for (const v of this.volumes) {
      const bone = this.bone(v.role);
      if (!bone) continue;
      const f = this._frame(bone);
      const R = new THREE.Quaternion().fromArray(f.q).multiply(v.rest);
      const J = new THREE.Vector3().fromArray(f.p);
      const toWorld = (a) => new THREE.Vector3().fromArray(a).applyQuaternion(R).add(J).toArray();
      for (const c of v.caps) out.push({ a: toWorld(c.a), b: toWorld(c.b), r: c.r });
    }
    return out;
  }

  _avoidArms() {
    if (!this.volumes.length) return;
    const fore = this.body.measures?.forearm_radius_m ?? 0;
    const armLen = this.body.measures?.arm_length_m ?? 0.5;
    const cfg = { avoidIterations: SOLVER_LIMITS.avoidIterations, avoidMarginArm: SOLVER_LIMITS.avoidMarginM, avoidMaxPush: SOLVER_LIMITS.avoidMaxPushShare * armLen };
    let caps = null;
    for (const s of SIDES) {
      const c = this.chains.arm[s];
      if (!c) continue;
      if (this.carry && this.carryWeight > 0 && this.has('reach-hands')) continue;
      const hand = this.body.hands?.[s];
      if (!caps) caps = this._avoidCapsules();
      const { wp, wr } = this._chainRecords(c);
      const out = solveArmAvoid(ENTRIES, CHAIN, wr, wp, caps, { foreR: fore, handR: hand?.hand_length_m ? hand.hand_length_m * 0.55 : 0 }, cfg);
      if (!out) continue;
      this.report.push_m = Math.max(this.report.push_m, out.pushM);
      this.report.residual_m = Math.max(this.report.residual_m, out.residual);
      this._write('avoid-arms', c.up, out.joints[0].rotation);
      this._write('avoid-arms', c.lo, out.joints[1].rotation);
      c.up.updateWorldMatrix(false, true);
    }
    for (const s of SIDES) {
      const c = this.chains.arm[s];
      if (c && !(this.carry && this.carryWeight > 0 && this.has('reach-hands'))) this._clearBoxes(s, c);
    }
  }

  // The volumes as boxes now: to go from a holder-frame point into a box, and back.
  _volumeFrames() {
    return this.volumes.map((v) => {
      const f = this._frame(this.bone(v.role));
      const R = new THREE.Quaternion().fromArray(f.q).multiply(v.rest);
      return { v, J: new THREE.Vector3().fromArray(f.p), R, Rinv: R.clone().invert() };
    });
  }

  // Forearm samples and hand points of one arm, holder frame, each with its share of the wrist's movement.
  _armPoints(side, c) {
    const n = sideName(side);
    const P = (b) => new THREE.Vector3().fromArray(this._frame(b).p);
    const e = P(c.lo), w = P(c.end);
    const out = [0.25, 0.5, 0.75, 1].map((t) => ({ p: e.clone().lerp(w, t), lever: t }));
    const hand = this._frame(c.end);
    const q = new THREE.Quaternion().fromArray(hand.q);
    const palm = this.body.hands?.[side]?.palm_m;
    if (palm) out.push({ p: new THREE.Vector3().fromArray(palm).applyQuaternion(q).add(w), lever: 1 });
    for (const r of [`${n}MiddleProximal`, `${n}MiddleIntermediate`, `${n}MiddleDistal`]) {
      const b = this.bone(r);
      if (b) out.push({ p: P(b), lever: 1 });
    }
    return out;
  }

  _clearBoxes(side, c) {
    for (let it = 0; it < SOLVER_LIMITS.clearIterations; it++) {
      const frames = this._volumeFrames();
      let worst = null;
      for (const { p, lever } of this._armPoints(side, c)) {
        for (const { v, J, R, Rinv } of frames) {
          const q = p.clone().sub(J).applyQuaternion(Rinv);
          const faces = [q.x - v.min[0], v.max[0] - q.x, q.y - v.min[1], v.max[1] - q.y, q.z - v.min[2], v.max[2] - q.z].map((x) => x + SOLVER_LIMITS.clearMarginM);
          const depth = Math.min(...faces);
          if (depth <= 0) continue;
          const need = (depth + SOLVER_LIMITS.clearSkinM) / lever;
          if (!worst || need > worst.need) {
            const k = faces.indexOf(depth);
            const n = new THREE.Vector3(k === 0 ? -1 : k === 1 ? 1 : 0, k === 2 ? -1 : k === 3 ? 1 : 0, k === 4 ? -1 : k === 5 ? 1 : 0).applyQuaternion(R);
            worst = { need, n };
          }
        }
      }
      if (!worst) return;
      const { wp, wr } = this._chainRecords(c);
      const target = new THREE.Vector3().fromArray(wp[3]).addScaledVector(worst.n, worst.need).toArray();
      const out = solveTwoBoneLeg(ENTRIES, CHAIN, wr, wp, target, null, cfgLeg);
      if (!out) return;
      this.report.push_m = Math.max(this.report.push_m, worst.need);
      const [up, lo] = out.joints;
      const pw = new THREE.Quaternion().fromArray(wr[0]);
      const upW = pw.clone().multiply(new THREE.Quaternion().fromArray(up.rotation));
      const loW = upW.clone().multiply(new THREE.Quaternion().fromArray(lo.rotation));
      // The hand keeps its local turn on the forearm.
      const handLocal = loW.clone().invert().multiply(new THREE.Quaternion().fromArray(wr[3]));
      this._write('avoid-arms', c.up, up.rotation);
      this._write('avoid-arms', c.lo, lo.rotation);
      this._write('avoid-arms', c.end, qArr(handLocal));
      c.up.updateWorldMatrix(false, true);
    }
  }
}
