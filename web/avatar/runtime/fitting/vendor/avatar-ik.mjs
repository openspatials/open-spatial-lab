// avatar-ik.mjs — THE ONE SOLVER of the pose pipeline: stage P4 (SOLVE) of
// docs/avatar/ANIMATION-ARCHITECTURE.md §3, plus the S7 session façade that
// composes the injected foot PLANNER (stage G) with the solve — the
// "ik.solve(skeleton, gait, groundQuery)" façade shape §3.3 sanctions, with
// plan+solve as internal passes. .
//
// Contract: this file imports NOTHING (L1 zero-import core, registered in
// ZERO_IMPORT_CORES + the portability grep).
// Pure math over JointPose buffers and plain records. No engine, no clock
// (performance.now appears ONLY inside cost instrumentation that never feeds
// back into behaviour — the §9 carve-out), no DOM, no randomness: identical
// (records, dt) sequences produce bit-identical deltas.
//
// INV-A1 (§2, binding): this solver NEVER chooses a goal — goals arrive from
// the injected planner (avatar-foot-planner.mjs, injected by the adapter at
// session build; injection is not an import). It never writes a joint — it
// emits PoseDelta records; the ONE compositor applies them at channel weight
// (override-at-weight, §4.2) and the ONE write site touches the engine.
//
// SCENE SENSING: none. There is no raycast, AABB, or triangle here (§10.1) —
// the injected S12 `probe` seam is the only window to the world, and even that
// is only ever CALLED by the planner (stage G); P4 is a pure function of
// records, exactly as §3.3 orders the stages.
//
// THE SOLVE (two-bone analytic, the ozz-animation MIT family — PRIOR-ART §7):
// per foot goal, in the rig's own armature space (Y-up, glTF units):
//   1. clamp the target into the leg's reachable annulus (knee never locks);
//   2. place the knee on the authored bend plane (n = (A-H)×(K-H), the pose's
//      own plane — preserves the clip's style; degenerate poses fall back to
//      the character-forward plane);
//   3. express the fix as TWO world shortest-arc deltas (hip, knee) applied on
//      top of the authored pose, plus an ankle delta aligning the foot's
//      bind-up axis to the surface normal (clamped);
//   4. emit ABSOLUTE target local rotations (the §3.2 PoseDelta law) — never
//      additive corrections (§10.4).
// Pelvis: when a stance target sits beyond reach the pelvis drops by the
// shortfall (dt rate-limited, drop-only), lowered here into an ordinary
// hips-local translation entry before the delta reaches P5 — the compositor
// header's stated contract (avatar-pose-blend.mjs: pelvisOffsetM is lowered by
// the SOLVER, which owns the armature frame).

const QID = [0, 0, 0, 1];
const vSub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const vAdd = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const vScale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const vLen = (a) => Math.hypot(a[0], a[1], a[2]);
const vNorm = (a) => { const l = vLen(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const vCross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const vDot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const qMul = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const qInv = (q) => [-q[0], -q[1], -q[2], q[3]];
const qNorm = (q) => { const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1; return [q[0] / l, q[1] / l, q[2] / l, q[3] / l]; };
const qRotate = (q, v) => {
  const x = q[0], y = q[1], z = q[2], w = q[3];
  const tx = 2 * (y * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
};
/** shortest-arc quaternion rotating unit vector a onto unit vector b */
const qFromUnitVectors = (a, b) => {
  const d = vDot(a, b);
  if (d > 0.999999) return QID.slice();
  if (d < -0.999999) {
    let ax = [1, 0, 0];
    if (Math.abs(a[0]) > 0.9) ax = [0, 1, 0];
    const c = vNorm(vCross(a, ax));
    return [c[0], c[1], c[2], 0];
  }
  const c = vCross(a, b);
  return qNorm([c[0], c[1], c[2], 1 + d]);
};
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const POSE_STRIDE = 7; // the shared JointPose contract (§3.2)

/** FK over a JointPose buffer in armature space (parents-first `order`):
 *  fills wr (world rotations) and wp (world positions), both arrays of len J.
 *  The exact composition rule the write site's matrices realise. */
export function fkPose(entries, order, pose, wr, wp) {
  for (const j of order) {
    const e = entries[j];
    const o = j * POSE_STRIDE;
    const lq = [pose[o], pose[o + 1], pose[o + 2], pose[o + 3]];
    const lt = [pose[o + 4], pose[o + 5], pose[o + 6]];
    if (e.parentJoint < 0) { wr[j] = qNorm(lq); wp[j] = lt.slice(); continue; }
    const pr = wr[e.parentJoint], pp = wp[e.parentJoint];
    wp[j] = vAdd(pp, qRotate(pr, lt));
    wr[j] = qNorm(qMul(pr, lq));
  }
}

/** Resolve the two leg chains from retarget-map entries by Mixamo base name.
 *  Returns null when either leg is incomplete (honest absence — foot IK
 *  refuses rather than solving half a body). */
export function resolveLegChains(entries) {
  const byBase = new Map();
  for (const e of entries) if (e && !byBase.has(e.base)) byBase.set(e.base, e);
  const side = (P) => {
    const up = byBase.get(`${P}UpLeg`), lo = byBase.get(`${P}Leg`);
    const foot = byBase.get(`${P}Foot`), toe = byBase.get(`${P}ToeBase`);
    if (!up || !lo || !foot) return null;
    return {
      up: up.jointIndex, lo: lo.jointIndex, foot: foot.jointIndex,
      toe: toe ? toe.jointIndex : -1,
      // the foot-local axis that points WORLD-UP at skinning bind: at bind the
      // soles are flat, so W_bind_foot maps this axis onto +Y for ANY rig,
      // independent of the node-rest/bind gap.
      footUpLocal: vNorm(qRotate(qInv(foot.wDstBindR), [0, 1, 0])),
      ankleBindY: foot.wDstBindP[1],
    };
  };
  const hips = byBase.get("Hips");
  const L = side("Left"), R = side("Right");
  if (!L || !R || !hips) return null;
  return { L, R, hips: hips.jointIndex };
}

/** Resolve the two ARM chains from retarget-map
 *  entries by Mixamo base name — the resolveLegChains pattern, trivially
 *  extended exactly as left it. Null when either arm is incomplete. */
export function resolveArmChains(entries) {
  const byBase = new Map();
  for (const e of entries) if (e && !byBase.has(e.base)) byBase.set(e.base, e);
  const side = (P) => {
    const up = byBase.get(`${P}Arm`), lo = byBase.get(`${P}ForeArm`), hand = byBase.get(`${P}Hand`);
    if (!up || !lo || !hand) return null;
    return { up: up.jointIndex, lo: lo.jointIndex, hand: hand.jointIndex };
  };
  const L = side("Left"), R = side("Right");
  return L && R ? { L, R } : null;
}

/** Closest points between segments p1->q1 and p2->q2 (Ericson RTCD §5.1.9,
 *  re-derived). Returns { d, t (param on seg 1), c1, c2 }. */
export function segSegClosest(p1, q1, p2, q2) {
  const d1 = vSub(q1, p1), d2 = vSub(q2, p2), r = vSub(p1, p2);
  const a = vDot(d1, d1), e = vDot(d2, d2), f = vDot(d2, r);
  let s, t2;
  if (a <= 1e-12 && e <= 1e-12) { s = 0; t2 = 0; }
  else if (a <= 1e-12) { s = 0; t2 = clamp(f / e, 0, 1); }
  else {
    const c = vDot(d1, r);
    if (e <= 1e-12) { t2 = 0; s = clamp(-c / a, 0, 1); }
    else {
      const b = vDot(d1, d2), den = a * e - b * b;
      s = den > 1e-12 ? clamp((b * f - c * e) / den, 0, 1) : 0;
      t2 = (b * s + f) / e;
      if (t2 < 0) { t2 = 0; s = clamp(-c / a, 0, 1); }
      else if (t2 > 1) { t2 = 1; s = clamp((b - c) / a, 0, 1); }
    }
  }
  const c1 = vAdd(p1, vScale(d1, s)), c2 = vAdd(p2, vScale(d2, t2));
  return { d: vLen(vSub(c1, c2)), t: s, c1, c2 };
}

/**
 * Arm avoidance resolution. PBD-style: elbow/wrist particles pushed out of the
 * world-space garment capsules (shoulder pinned), bone lengths re-projected,
 * FIXED iteration count (deterministic, §9). Emits ABSOLUTE local rotations
 * for Arm+ForeArm; the hand keeps its authored LOCAL rotation and follows the
 * forearm naturally. Correction magnitude is continuous in the pose (depth ->
 * 0 at contact), so engagement is pop-free without any per-frame gating.
 *
 * CONSTRAINT SET (measured, first-cut corrected): ONE extended-forearm
 * segment per arm — elbow -> wrist + palm extension (arm.handR along the
 * forearm direction), clearance = capsule radius + arm.foreR + margin.
 * The UPPER arm is deliberately NOT constrained: the sleeve legitimately
 * meets the garment at the shoulder/armpit, so an upper-arm clearance is
 * unsatisfiable there — the first implementation demanded it and pushed
 * every frame into the clamp on all five avatars (measured 2026-07-27:
 * maxPush 0.30-0.35 m, residual up to 0.22 m, two avatars WORSE than
 * authored). The visible artefact class is the forearm/hand sweep.
 *
 * caps: [{ a, b, r }] world-armature capsules; arm: { foreR, handR }
 * (armature units). Returns null when nothing violates; else
 * { joints, pushM: wrist displacement (armature units), residual }.
 */
export function solveArmAvoid(entries, chain, wr, wp, caps, arm, cfg) {
  const S = wp[chain.up], E0 = wp[chain.lo], W0 = wp[chain.hand];
  const L1 = vLen(vSub(E0, S)), L2 = vLen(vSub(W0, E0));
  if (!(L1 > 1e-6) || !(L2 > 1e-6) || !caps.length) return null;
  const clear = (r) => r + arm.foreR + cfg.avoidMarginArm;
  const ext = arm.handR; // palm modelled as the forearm's continuation
  let e = E0.slice(), w = W0.slice();
  let touched = false;
  const pushOut = (from, to) => { // unit push direction, degenerate-safe
    const d = vSub(from, to);
    const l = vLen(d);
    return l > 1e-9 ? vScale(d, 1 / l) : [0, 0, 1];
  };
  const project = () => { // bone lengths, shoulder pinned
    e = vAdd(S, vScale(vNorm(vSub(e, S)), L1));
    w = vAdd(e, vScale(vNorm(vSub(w, e)), L2));
  };
  for (let it = 0; it < cfg.avoidIterations; it++) {
    for (const cap of caps) {
      const fHat = vNorm(vSub(w, e));
      const tip = vAdd(w, vScale(fHat, ext));
      const g = segSegClosest(e, tip, cap.a, cap.b);
      const need = clear(cap.r);
      if (g.d < need) {
        touched = true;
        const n = vScale(pushOut(g.c1, g.c2), need - g.d);
        // contact beyond the wrist (the palm zone) pushes the wrist fully
        const tw = Math.min(1, g.t * (L2 + ext) / L2);
        e = vAdd(e, vScale(n, 1 - tw));
        w = vAdd(w, vScale(n, tw));
      }
    }
    project();
  }
  if (!touched) return null;
  // stated safety bound: never push the wrist further than avoidMaxPush —
  // scale the correction back (twice: length re-projection can re-grow it)
  // and let the residual show (reported, never hidden; reach preservation
  // outranks a perfect clear at extremes)
  for (let pass = 0; pass < 2; pass++) {
    const p = vLen(vSub(w, W0));
    if (p <= cfg.avoidMaxPush) break;
    const k = cfg.avoidMaxPush / p;
    e = vAdd(E0, vScale(vSub(e, E0), k));
    w = vAdd(W0, vScale(vSub(w, W0), k));
    project();
  }
  const push = vLen(vSub(w, W0));
  let residual = 0;
  {
    const fHat = vNorm(vSub(w, e));
    const tip = vAdd(w, vScale(fHat, ext));
    for (const cap of caps) {
      residual = Math.max(residual, clear(cap.r) - segSegClosest(e, tip, cap.a, cap.b).d);
    }
  }
  // absolute local rotations from the solved directions (the solveTwoBoneLeg
  // delta-construction shape: world shortest arcs layered hip -> knee)
  const qUp = qFromUnitVectors(vNorm(vSub(E0, S)), vNorm(vSub(e, S)));
  const qLo = qFromUnitVectors(vNorm(qRotate(qUp, vSub(W0, E0))), vNorm(vSub(w, e)));
  const rotUpW = qNorm(qMul(qUp, wr[chain.up]));
  const rotLoW = qNorm(qMul(qLo, qMul(qUp, wr[chain.lo])));
  const parentUp = entries[chain.up].parentJoint;
  const rotUpParentW = parentUp >= 0 ? wr[parentUp] : QID;
  return {
    pushM: push,
    residual: Math.max(0, residual),
    joints: [
      { index: chain.up, rotation: qNorm(qMul(qInv(rotUpParentW), rotUpW)) },
      { index: chain.lo, rotation: qNorm(qMul(qInv(rotUpW), rotLoW)) },
    ],
  };
}

/**
 * Two-bone analytic solve for one leg, in armature space, as ABSOLUTE local
 * rotations layered on the authored pose. Pure function.
 *
 * chain: resolveLegChains side record; wr/wp: FK of the authored pose
 * (already pelvis-offset if a pelvis drop is active); target: ankle goal
 * (armature); normal: surface normal (armature ~ core axes: heading-rotated
 * — pass null to skip ankle alignment).
 * Returns { joints: [{index, rotation}...], shortfall } — shortfall > 0 means
 * the clamped solve could not reach (pelvis's business, reported not hidden).
 */
export function solveTwoBoneLeg(entries, chain, wr, wp, target, normal, cfg) {
  const H = wp[chain.up], K = wp[chain.lo], A = wp[chain.foot];
  const L1 = vLen(vSub(K, H)), L2 = vLen(vSub(A, K));
  if (!(L1 > 1e-6) || !(L2 > 1e-6)) return null;
  const toT = vSub(target, H);
  const dRaw = vLen(toT);
  const dMax = (L1 + L2) * (cfg.maxExtendRatio || 0.9995);
  const dMin = Math.abs(L1 - L2) * 1.001 + 1e-6;
  const d = clamp(dRaw, dMin, dMax);
  const shortfall = Math.max(0, dRaw - dMax);
  const tHat = dRaw > 1e-9 ? vScale(toT, 1 / dRaw) : [0, -1, 0];
  // bend plane from the AUTHORED pose (style preservation); degenerate ->
  // character-forward plane (+Z in armature space)
  let n = vCross(vSub(A, H), vSub(K, H));
  if (vLen(n) < 1e-6) n = vCross(tHat, [0, 0, 1]);
  if (vLen(n) < 1e-6) n = [1, 0, 0];
  n = vNorm(n);
  const pHat = vNorm(vCross(n, tHat)); // in-plane perpendicular, knee side
  const cosA = clamp((L1 * L1 + d * d - L2 * L2) / (2 * L1 * d), -1, 1);
  const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
  const Knew = vAdd(H, vAdd(vScale(tHat, L1 * cosA), vScale(pHat, L1 * sinA)));
  const Tnew = vAdd(H, vScale(tHat, d));
  // world deltas from positions (shortest arcs), layered hip -> knee -> ankle
  const qHip = qFromUnitVectors(vNorm(vSub(K, H)), vNorm(vSub(Knew, H)));
  const Amid = vAdd(H, qRotate(qHip, vSub(A, H)));
  const qKnee = qFromUnitVectors(vNorm(vSub(Amid, Knew)), vNorm(vSub(Tnew, Knew)));
  const rotHipW = qNorm(qMul(qHip, wr[chain.up]));
  const rotKneeW = qNorm(qMul(qKnee, qMul(qHip, wr[chain.lo])));
  let rotFootW = qNorm(qMul(qKnee, qMul(qHip, wr[chain.foot])));
  if (normal) {
    // align the foot's bind-up axis to the surface normal, clamped so a bad
    // normal can tilt a foot only so far (maxFootTiltRad, derived below)
    const upW = qRotate(rotFootW, chain.footUpLocal);
    const nHat = vNorm(normal);
    const ang = Math.acos(clamp(vDot(upW, nHat), -1, 1));
    const maxTilt = cfg.maxFootTiltRad || 0.6;
    let qF = qFromUnitVectors(upW, nHat);
    if (ang > maxTilt) { // partial arc: slerp-free scale via axis-angle
      const ax = vNorm(vCross(upW, nHat));
      const h = maxTilt / 2;
      qF = [ax[0] * Math.sin(h), ax[1] * Math.sin(h), ax[2] * Math.sin(h), Math.cos(h)];
    }
    rotFootW = qNorm(qMul(qF, rotFootW));
  }
  // absolute target LOCAL rotations (PoseDelta law §3.2)
  const parentUp = entries[chain.up].parentJoint;
  const rotHipParentW = parentUp >= 0 ? wr[parentUp] : QID;
  return {
    shortfall,
    solvedTarget: Tnew,
    joints: [
      { index: chain.up, rotation: qNorm(qMul(qInv(rotHipParentW), rotHipW)) },
      { index: chain.lo, rotation: qNorm(qMul(qInv(rotHipW), rotKneeW)) },
      { index: chain.foot, rotation: qNorm(qMul(qInv(rotKneeW), rotFootW)) },
    ],
  };
}

/** Sample a gait clip across its cycle and measure per-foot facts: stance
 *  phase window, stance ankle height, stance XZ offset from the hips, and the
 *  vertical swing amplitude. Session-build data derivation (the MaskDef
 *  precedent, §3.2) — the sampler closure is INJECTED; nothing here samples a
 *  clip at runtime. Stance = the lowest band of the foot's own height curve:
 *  height <= min + stanceBandFrac * amplitude — a RELATIVE discriminator
 *  against the clip's own amplitude (§9; no absolute metre floor).
 */
export function calibrateGait({ sampleClip, clipIndex, durS, entries, order, chains, samples = 96, stanceBandFrac = 0.3 }) {
  if (!(durS > 0) || typeof sampleClip !== "function") return null;
  const J = entries.length;
  const buf = new Float32Array(J * POSE_STRIDE);
  const wr = new Array(J), wp = new Array(J);
  const feet = { L: [], R: [] };
  const hipsXZ = [];
  for (let i = 0; i < samples; i++) {
    const t = (i / samples) * durS;
    if (!sampleClip(clipIndex, t, buf)) return null;
    fkPose(entries, order, buf, wr, wp);
    feet.L.push(wp[chains.L.foot].slice());
    feet.R.push(wp[chains.R.foot].slice());
    hipsXZ.push([wp[chains.hips][0], wp[chains.hips][2]]);
  }
  const sideCal = (pos) => {
    const hs = pos.map((p) => p[1]);
    const hMin = Math.min(...hs), hMax = Math.max(...hs);
    const amp = hMax - hMin;
    const inStance = hs.map((h) => h <= hMin + stanceBandFrac * amp);
    // longest circular run of stance samples
    let bestStart = 0, bestLen = 0;
    for (let s = 0; s < samples; s++) {
      if (!inStance[s] || inStance[(s - 1 + samples) % samples]) continue;
      let len = 0;
      while (len < samples && inStance[(s + len) % samples]) len++;
      if (len > bestLen) { bestLen = len; bestStart = s; }
    }
    if (!(amp > 1e-6) || bestLen === 0 || bestLen === samples) return null; // flat curve: no gait
    let oy = 0;
    for (let k = 0; k < bestLen; k++) oy += pos[(bestStart + k) % samples][1];
    let touchdownIndex = bestStart;
    for (let k = 1; k < bestLen; k++) {
      const index = (bestStart + k) % samples;
      if (pos[index][1] < pos[touchdownIndex][1]) touchdownIndex = index;
    }
    // landing offset is the foot's hips-relative position AT STANCE ENTRY —
    // averaging over the whole stance centres it under the body and was
    // measured to cost ~0.18 m of prediction error on flat ground (the foot
    // lands AHEAD of the root, exactly what the entry sample captures)
    return {
      stanceStart01: bestStart / samples,
      stanceEnd01: ((bestStart + bestLen) % samples) / samples,
      stanceFrac: bestLen / samples,
      stanceY: oy / bestLen,             // armature units — the clip's own planted ankle height
      offsetXZ: [pos[bestStart][0] - hipsXZ[bestStart][0], pos[bestStart][2] - hipsXZ[bestStart][1]],
      touchdown01: touchdownIndex / samples,
      touchdownY: pos[touchdownIndex][1],
      // The planner predicts from the core root transform. armToCore likewise
      // places these armature-space ankle coordinates directly under that
      // root; subtracting the animated hips would introduce its clip motion a
      // second time and commit beyond the authored touchdown.
      touchdownOffsetXZ: [pos[touchdownIndex][0], pos[touchdownIndex][2]],
      ampY: amp,
    };
  };
  const L = sideCal(feet.L), R = sideCal(feet.R);
  return L && R ? { durS, L, R } : null;
}

/**
 * createFootIkSession — the S7 façade the adapter wires (§3.3's sanctioned
 * plan+solve composition; bounded wiring stays in the adapter, logic here).
 *
 *   map        retarget map (entries/order — plain records; SkeletonSample)
 *   roster     the adapter's unified clip roster [{ name, durationS, kind }]
 *   roles      resolveClipRoles output (walk/run/idle indices)
 *   planner    INJECTED stage-G planner (avatar-foot-planner.mjs record shape)
 *   probe      INJECTED S12 surface query (xM, zM, yM) -> {ok, heightM, normal}
 *   sampleClip (rosterIndex, tS, outBuf) -> bool — session-BUILD calibration only
 *   scaleArm   glTF armature unit -> metres (norm.scale)
 *   footOffsetGltf  -minY of the model (glTF units): armature -> core Y seam
 *
 * Per frame the adapter passes this façade's `deltasProvider(loco, drive, dt)`
 * closure to the compositor: the compositor calls it with the P3 base pose
 * (the P4 seam), and it returns PoseDelta[]. channelTarget() feeds
 * fsm.setOverrideTarget BETWEEN steps (the boundary discipline).
 */
export function createFootIkSession({
  map, roster = [], roles = {}, planner, probe, sampleClip,
  scaleArm = 1, footOffsetGltf = 0, proxies = null, jumpPlanner = null, config = {},
} = {}) {
  if (!map || !Array.isArray(map.entries) || !planner || typeof probe !== "function") return null;
  const entries = map.entries, order = map.order;
  const chains = resolveLegChains(entries);
  if (!chains) return null;
  // bind leg lengths in metres (thigh + shank) — the jump planner's
  // scale reference so its tuck/reach fractions ride the rig's own geometry
  const legLenM = {};
  for (const s of ["L", "R"]) {
    const c = chains[s];
    const bp = (j) => entries[j].wDstBindP;
    legLenM[s] = (vLen(vSub(bp(c.lo), bp(c.up))) + vLen(vSub(bp(c.foot), bp(c.lo)))) * scaleArm;
  }
  const cfg = {
    maxExtendRatio: 0.9995,
    maxFootTiltRad: 0.6,   // ~34°: steeper "surface" reads as a bad normal, not a stance
    pelvisMaxDropM: 0.32,  // just above one showcase riser (0.30): a whole-step
                           // reach deficit is absorbable; more is a gait problem
    pelvisRateMps: 1.2,    // drop/recover speed; dt-integrated (§9 lawful form)
    // avoid constraints (armature-unit forms derived below):
    avoidIterations: 4,    // fixed count — deterministic (§9); measured residual
                           // after 4 is sub-margin on all five shipped avatars
    avoidMarginM: 0.015,   // 1.5 cm engage-early skin: covers the p80/p90
                           // percentile tail band of the proxy fit
    avoidMaxPushM: 0.25,   // reach-preservation bound: a wrist is never pushed
                           // further than this from the authored pose — beyond
                           // it the correction scales back and the residual is
                           // REPORTED (a drape-sized proxy must not fling arms)
    avoidMinLever: 0.35,   // upper-arm contact lever floor: contact param t
                           // below this resolves as if at t=0.35 so a near-
                           // shoulder graze cannot demand an unbounded elbow push
    ...config,
  };
  const J = entries.length;
  const wr = new Array(J), wp = new Array(J);
  // session-build gait calibration for every calibratable gait role clip
  const calib = new Map(); // roster index -> calibrateGait record
  for (const role of ["walk", "run"]) {
    const i = roles[role];
    if (i == null || !roster[i] || calib.has(i)) continue;
    const c = calibrateGait({ sampleClip, clipIndex: i, durS: roster[i].durationS, entries, order, chains });
    if (c) calib.set(i, c);
  }
  // reactive (idle / uncalibrated) ankle clearance: bind ankle height — at
  // bind the soles sit on the model's own ground plane (minY), so clearance =
  // (ankleBindY - minY) * scale, exactly the planted-foot height over ANY
  // surface. Gait clearance instead uses the clip's own measured stanceY.
  const clearReact = {
    L: (chains.L.ankleBindY + footOffsetGltf) * scaleArm,
    R: (chains.R.ankleBindY + footOffsetGltf) * scaleArm,
  };
  // the avoid-constraint stage — BodyProxySet lowered ONCE to
  // armature units (records are metres per §3.2; the solve runs in armature)
  const armChains = proxies && proxies.ok ? resolveArmChains(entries) : null;
  const avoidCaps = armChains ? proxies.proxies.map((p) => ({
    joint: p.joint,
    aL: vScale(p.localOffsetM, 1 / scaleArm),
    axisL: vScale(p.dimsM.axisM, 1 / scaleArm),
    r: p.dimsM.radiusM / scaleArm,
  })) : [];
  const avoidArm = armChains ? {
    L: { upperR: proxies.arm.L.upperRM / scaleArm, foreR: proxies.arm.L.foreRM / scaleArm, handR: proxies.arm.L.handRM / scaleArm },
    R: { upperR: proxies.arm.R.upperRM / scaleArm, foreR: proxies.arm.R.foreRM / scaleArm, handR: proxies.arm.R.handRM / scaleArm },
  } : null;
  const avoidActive = !!(armChains && avoidCaps.length);
  cfg.avoidMarginArm = cfg.avoidMarginM / scaleArm;
  cfg.avoidMaxPush = cfg.avoidMaxPushM / scaleArm;
  const avoidStat = { solves: 0, pushedFrames: 0, lastPushM: { L: 0, R: 0 }, maxPushM: 0, lastResidualM: 0, maxResidualM: 0 };
  const capsWorld = avoidCaps.map(() => ({ a: [0, 0, 0], b: [0, 0, 0], r: 0 }));

  let pelvisDropM = 0;
  let lastDeltas = [];
  let lastPlanOut = null;
  let lastJumpOut = null; // 
  let chanTarget = 0;
  let lastSolveDt = 0;
  const cost = { emaMs: 0, maxMs: 0 };
  const stat = { frames: 0, solves: 0, shortfalls: 0, lastShortfallM: 0 };
  const renderedWr = new Array(J), renderedWp = new Array(J);
  const renderedPlant = { L: null, R: null };
  const renderedPrevious = { L: null, R: null };
  const renderedPreviousVelocity = { L: null, R: null };
  const renderedPreviousDisplacement = { L: null, R: null };

  // armature <-> core seams (the adapter root transform, inverted here once):
  // core = rootPos + [0, footOffsetM, 0] + Ry(heading) * (p_arm * scaleArm)
  const footOffM = footOffsetGltf * scaleArm;
  const armToCore = (p, rootPos, heading) => {
    const s = Math.sin(heading), c = Math.cos(heading);
    const x = p[0] * scaleArm, y = p[1] * scaleArm, z = p[2] * scaleArm;
    return [rootPos[0] + c * x + s * z, rootPos[1] + footOffM + y, rootPos[2] - s * x + c * z];
  };
  const coreToArm = (p, rootPos, heading) => {
    const s = Math.sin(heading), c = Math.cos(heading);
    const dx = p[0] - rootPos[0], dy = p[1] - rootPos[1] - footOffM, dz = p[2] - rootPos[2];
    return [(c * dx - s * dz) / scaleArm, dy / scaleArm, (s * dx + c * dz) / scaleArm];
  };
  const coreDirToArm = (v, heading) => {
    const s = Math.sin(heading), c = Math.cos(heading);
    return [c * v[0] - s * v[2], v[1], s * v[0] + c * v[2]];
  };

  /** the P4 seam body: called by the compositor with the P3 base pose. */
  const solveFrame = (basePose, loco, drive, dtS) => {
    const t0 = (globalThis.performance || Date).now();
    const dt = Math.max(0, Number(dtS) || 0);
    lastSolveDt = dt;
    stat.frames += 1;
    fkPose(entries, order, basePose, wr, wp);
    const rootPos = loco.position, heading = loco.headingRad;
    // gait context from the brain's own record (dominant source = the active
    // clip; §3.2 sources are ordered dominant-first)
    const gi = drive && drive.active ? drive.active.index : null;
    const cal = gi != null ? calib.get(gi) : null;
    const gait = cal ? {
      phase01: (((drive.active.timeS % cal.durS) + cal.durS) % cal.durS) / cal.durS,
      durS: cal.durS, rate: Math.max(0.05, Number(drive.active.rate) || 1), calib: cal,
    } : null;
    const clearM = gait
      ? { L: ((cal.L.touchdownY ?? cal.L.stanceY) + footOffsetGltf) * scaleArm,
        R: ((cal.R.touchdownY ?? cal.R.stanceY) + footOffsetGltf) * scaleArm }
      : clearReact;
    // The legacy mean-stance floor proxy belongs only to landing
    // conformance window. Applying it to an ordinary gait would classify the
    // clip's authored touchdown minimum as penetration and inject a second,
    // roughly 22 mm command into approach. The explicit transition
    // provenance lets the safety clamp retain its land->gait sink protection
    // without changing the touchdown plane used by normal committed steps.
    const landingBlendActive = drive?.stateName === "land"
      || (drive?.fade && roles.land != null && drive.fade.fromIndex === roles.land);
    const floorClearM = gait
      ? { L: (cal.L.stanceY + footOffsetGltf) * scaleArm,
        R: (cal.R.stanceY + footOffsetGltf) * scaleArm }
      : clearReact;
    const ampM = gait ? { L: cal.L.ampY * scaleArm, R: cal.R.ampY * scaleArm } : null;
    const feetAuth = {
      L: armToCore(wp[chains.L.foot], rootPos, heading),
      R: armToCore(wp[chains.R.foot], rootPos, heading),
    };
    const kinematics = {};
    for (const side of ["L", "R"]) {
      const c = chains[side];
      const previousExecution = lastPlanOut?.execution?.feet?.[side] || null;
      const hipM = armToCore(wp[c.up], rootPos, heading);
      const kneeM = armToCore(wp[c.lo], rootPos, heading);
      const ankleM = feetAuth[side];
      const toeM = c.toe >= 0 ? armToCore(wp[c.toe], rootPos, heading) : null;
      const thighM = vLen(vSub(kneeM, hipM));
      const shankM = vLen(vSub(ankleM, kneeM));
      const legLengthM = thighM + shankM;
      const footLengthM = toeM ? vLen(vSub(toeM, ankleM)) : shankM * 0.25;
      const kh = vNorm(vSub(hipM, kneeM)), ka = vNorm(vSub(ankleM, kneeM));
      const kneeFlexRad = Math.PI - Math.acos(clamp(vDot(kh, ka), -1, 1));
      kinematics[side] = {
        hipM, kneeM, ankleM: ankleM.slice(), toeM,
        renderedAnkleM: renderedPrevious[side]
          ? renderedPrevious[side].slice() : null,
        renderedVelocityMps: Array.isArray(previousExecution?.velocityMps)
          ? previousExecution.velocityMps.slice() : null,
        thighM, shankM, legLengthM, footLengthM, kneeFlexRad,
        minReachM: Math.abs(thighM - shankM) * 1.001 + legLengthM * 1e-6,
        maxReachM: legLengthM * cfg.maxExtendRatio,
        pelvisReachM: cfg.pelvisMaxDropM,
        floorClearanceM: landingBlendActive
          ? Math.max(clearM[side], floorClearM[side]) : clearM[side],
      };
    }
    const offXZ = gait ? {
      L: vScale([(cal.L.touchdownOffsetXZ || cal.L.offsetXZ)[0], 0,
        (cal.L.touchdownOffsetXZ || cal.L.offsetXZ)[1]], scaleArm),
      R: vScale([(cal.R.touchdownOffsetXZ || cal.R.offsetXZ)[0], 0,
        (cal.R.touchdownOffsetXZ || cal.R.offsetXZ)[1]], scaleArm),
    } : null;
    const planOut = planner.plan({
      dt, grounded: loco.grounded === true, moving: loco.moving === true,
      rootPos, heading, speedMps: Number(loco.speedMps) || 0,
      gait, feetAuth, clearM, ampM, offsetXZ: offXZ, kinematics, probe,
    });
    planOut.execution = {
      root: { positionM: rootPos.slice(), headingRad: heading,
        speedMps: Number(loco.speedMps) || 0,
        verticalVelocityMps: Number(loco.verticalVelocity) || 0,
        grounded: loco.grounded === true },
      feet: {
        L: { authoredM: feetAuth.L.slice(), commandedM: planOut.goals.L
          ? planOut.goals.L.targetM.slice() : null },
        R: { authoredM: feetAuth.R.slice(), commandedM: planOut.goals.R
          ? planOut.goals.R.targetM.slice() : null },
      },
    };
    lastPlanOut = planOut;
    chanTarget = planOut.channelTarget;
    // the jump planner (stage G) — in-air goals, landing absorb, and
    // the pre-land flag. Gated on injection: a session built without one is
    // bit-identical to the earlier session (the certification stands
    // on exactly that path).
    let jumpOut = null;
    if (jumpPlanner) {
      jumpOut = jumpPlanner.plan({
        dt, grounded: loco.grounded === true,
        justJumped: loco.justJumped === true, justLanded: loco.justLanded === true,
        verticalVelocity: Number(loco.verticalVelocity) || 0,
        airborneS: Number(loco.airborneS) || 0, fallS: Number(loco.fallS) || 0,
        rootPos, heading, speedMps: Number(loco.speedMps) || 0,
        gait, feetAuth, legLenM, probe,
      });
      lastJumpOut = jumpOut;
      // pre-engage the footIK channel inside its ramp of the PREDICTED
      // touchdown, so landing conformance has full authority ON the landing
      // frame instead of ramping in through the measured 8-frame sink window.
      // Harmless while airborne: the foot planner emits no goals in the air.
      if (jumpOut.preLand) chanTarget = 1; // arm target: preland-arm
    }
    const deltas = [];
    // pelvis first: required drop = the worst stance-goal reach shortfall,
    // measured against the UNDROPPED hips, then dt rate-limited; the leg solve
    // below runs against the DROPPED skeleton so at weight 1 the composed
    // result is self-consistent.
    let wantDrop = 0;
    for (const side of ["L", "R"]) {
      const g = planOut.goals[side];
      if (!g || !(g.weight > 0)) continue;
      const T = coreToArm(g.targetM, rootPos, heading);
      const H = wp[chains[side].up];
      const reach = (vLen(vSub(wp[chains[side].lo], H)) + vLen(vSub(wp[chains[side].foot], wp[chains[side].lo]))) * cfg.maxExtendRatio;
      wantDrop = Math.max(wantDrop, (vLen(vSub(T, H)) - reach) * g.weight);
    }
    // the landing absorb joins the SAME pelvis mechanism — max, not
    // sum (a reach shortfall and an impact dip both want the pelvis down; the
    // deeper need wins), rate-limited by the SAME pelvisRateMps below.
    wantDrop = clamp(Math.max(wantDrop * scaleArm, jumpOut ? jumpOut.absorbDropM : 0), 0, cfg.pelvisMaxDropM);
    const step = cfg.pelvisRateMps * dt;
    pelvisDropM = clamp(wantDrop, pelvisDropM - step, pelvisDropM + step);
    const dropArm = pelvisDropM / scaleArm;
    if (dropArm > 1e-9) {
      // offset the whole FK rigidly (what the hips translation does at w=1)
      for (let j = 0; j < J; j++) wp[j] = [wp[j][0], wp[j][1] - dropArm, wp[j][2]];
      const hips = chains.hips;
      const o = hips * POSE_STRIDE;
      const pr = entries[hips].parentJoint >= 0 ? wr[entries[hips].parentJoint] : QID;
      const dLocal = qRotate(qInv(pr), [0, -dropArm, 0]);
      deltas.push({
        channel: "footIK", weight: 1,
        joints: [{ index: hips, translation: [basePose[o + 4] + dLocal[0], basePose[o + 5] + dLocal[1], basePose[o + 6] + dLocal[2]] }],
      });
    }
    for (const side of ["L", "R"]) {
      const g = planOut.goals[side];
      if (!g || !(g.weight > 0)) continue;
      const T = coreToArm(g.targetM, rootPos, heading);
      const nArm = g.normal ? coreDirToArm(g.normal, heading) : null;
      const s = solveTwoBoneLeg(entries, chains[side], wr, wp, T, nArm, cfg);
      if (!s) continue;
      stat.solves += 1;
      if (s.shortfall > 1e-6) { stat.shortfalls += 1; stat.lastShortfallM = s.shortfall * scaleArm; }
      const solvedM = armToCore(s.solvedTarget, rootPos, heading);
      planOut.execution.feet[side] = {
        ...planOut.execution.feet[side], solverEndpointM: solvedM,
        solverTargetErrorM: vLen(vSub(solvedM, g.targetM)),
        shortfallM: s.shortfall * scaleArm, goalWeight: g.weight,
      };
      deltas.push({ channel: "footIK", weight: g.weight, joints: s.joints }); // arm target: solve-apply
    }
    // ---- jump air goals (same solver, own channel) -----------------
    // The jump planner's ankle targets go through the SAME two-bone solve as
    // foot goals; the deltas ride the jumpAir channel, which the brain ramps
    // in while airborne and out on the ground (§4.2 override-at-weight — the
    // authored jump/fall poses stay the base the takeover modulates).
    if (jumpOut) {
      for (const side of ["L", "R"]) {
        const g = jumpOut.goals[side];
        if (!g || !(g.weight > 0)) continue;
        const T = coreToArm(g.targetM, rootPos, heading);
        const s = solveTwoBoneLeg(entries, chains[side], wr, wp, T, null, cfg);
        if (!s) continue;
        stat.solves += 1;
        deltas.push({ channel: "jumpAir", weight: g.weight, joints: s.joints });
      }
    }
    // ---- avoid constraints (P4 avoidance resolution, §3.3) ---------
    // Runs on the SAME (possibly pelvis-dropped) FK the leg solve used; the
    // capsules ride their torso joints, so they drop with the body rigidly.
    if (avoidActive) {
      for (let i = 0; i < avoidCaps.length; i++) {
        const c = avoidCaps[i], o = capsWorld[i];
        o.a = vAdd(wp[c.joint], qRotate(wr[c.joint], c.aL));
        o.b = vAdd(o.a, qRotate(wr[c.joint], c.axisL));
        o.r = c.r;
      }
      avoidStat.lastPushM.L = 0; avoidStat.lastPushM.R = 0;
      let pushed = false;
      for (const side of ["L", "R"]) {
        const s = solveArmAvoid(entries, armChains[side], wr, wp, capsWorld, avoidArm[side], cfg);
        if (!s) continue;
        avoidStat.solves += 1;
        pushed = true;
        avoidStat.lastPushM[side] = +(s.pushM * scaleArm).toFixed(4);
        if (s.pushM * scaleArm > avoidStat.maxPushM) avoidStat.maxPushM = +(s.pushM * scaleArm).toFixed(4);
        avoidStat.lastResidualM = +(s.residual * scaleArm).toFixed(4);
        if (avoidStat.lastResidualM > avoidStat.maxResidualM) avoidStat.maxResidualM = avoidStat.lastResidualM;
        deltas.push({ channel: "armAvoid", weight: 1, joints: s.joints }); // arm target: arm-avoid-apply
      }
      if (pushed) avoidStat.pushedFrames += 1;
    }
    lastDeltas = deltas;
    const ms = (globalThis.performance || Date).now() - t0;
    cost.emaMs += (ms - cost.emaMs) * 0.05;
    if (ms > cost.maxMs) cost.maxMs = ms;
    return deltas;
  };

  /** Record the compositor's final P5 pose before the adapter's P6 write.
   *  This is the actual pose the renderer receives, not the authored input or
   *  the analytic solver endpoint. It keeps the diagnostic target/contact/
   *  plant ledger honest without adding a second writer or world query. */
  const recordComposedPose = (pose, loco = {}) => {
    if (!pose || !lastPlanOut || !lastPlanOut.execution) return null;
    fkPose(entries, order, pose, renderedWr, renderedWp);
    const rootPos = Array.isArray(loco.position)
      ? loco.position : lastPlanOut.execution.root.positionM;
    const heading = Number.isFinite(Number(loco.headingRad))
      ? Number(loco.headingRad) : lastPlanOut.execution.root.headingRad;
    for (const side of ["L", "R"]) {
      const actualM = armToCore(renderedWp[chains[side].foot], rootPos, heading);
      const previousM = renderedPrevious[side];
      const displacementM = previousM ? vSub(actualM, previousM) : [0, 0, 0];
      const velocityMps = previousM && lastSolveDt > 1e-6
        ? displacementM.map((value) => value / lastSolveDt)
        : [0, 0, 0];
      const previousVelocityMps = renderedPreviousVelocity[side];
      const accelerationMps2 = previousVelocityMps && lastSolveDt > 1e-6
        ? velocityMps.map((value, index) => (
          (value - previousVelocityMps[index]) / lastSolveDt))
        : [0, 0, 0];
      const previousDisplacementM = renderedPreviousDisplacement[side];
      const successiveDisplacementChangeM = previousDisplacementM
        ? displacementM.map((value, index) => value - previousDisplacementM[index])
        : [0, 0, 0];
      renderedPrevious[side] = actualM.slice();
      renderedPreviousVelocity[side] = velocityMps.slice();
      renderedPreviousDisplacement[side] = displacementM.slice();
      const contact = lastPlanOut.contacts && lastPlanOut.contacts.feet[side];
      const targetM = contact && contact.commandedM;
      const key = contact && contact.lifecycle === "planted" && contact.lockM
        ? (contact.planId != null ? `plan:${contact.planId}`
          : `lock:${contact.lockM.map((v) => v.toFixed(6)).join(",")}`)
        : null;
      if (!key) renderedPlant[side] = null;
      else if (!renderedPlant[side] || renderedPlant[side].key !== key) {
        renderedPlant[side] = { key, touchdownM: actualM.slice(), maxSlideM: 0,
          touchdownErrorM: targetM ? vLen(vSub(actualM, targetM)) : null };
      } else {
        renderedPlant[side].maxSlideM = Math.max(renderedPlant[side].maxSlideM,
          vLen(vSub(actualM, renderedPlant[side].touchdownM)));
      }
      const plant = renderedPlant[side];
      const rendered = {
        actualM: actualM.slice(), displacementM, velocityMps,
        accelerationMps2, successiveDisplacementChangeM,
        sampleIntervalS: lastSolveDt,
        verticalVelocityMps: velocityMps[1],
        targetErrorM: targetM ? vLen(vSub(actualM, targetM)) : null,
        touchdownM: plant ? plant.touchdownM.slice() : null,
        touchdownErrorM: plant ? plant.touchdownErrorM : null,
        plantedSlideM: plant ? plant.maxSlideM : null,
      };
      lastPlanOut.execution.feet[side] = {
        ...lastPlanOut.execution.feet[side], ...rendered,
      };
      const planFoot = lastPlanOut.plan.feet.find((foot) => foot.side === side);
      if (planFoot) Object.assign(planFoot, rendered);
    }
    return lastPlanOut.execution;
  };

  return {
    /** compositor P4-seam closure factory: capture the frame context the
     *  adapter already has in hand, return the deltas provider. */
    deltasProvider: (loco, drive, dtS) => (basePose) => solveFrame(basePose, loco, drive, dtS),
    recordComposedPose,
    channelTarget: () => chanTarget,
    /** the armAvoid channel target — 1 whenever the constraint stage
     *  is live (correction magnitude is pose-continuous, so a constant-on
     *  channel is pop-free; the §8 ladder's R1 drops it to 0 by config). */
    armAvoidTarget: () => (avoidActive ? 1 : 0),
    /** the jumpAir channel target — 1 airborne, 0 grounded; the FSM's
     *  dt-ramps shape engage/release, the planner's envelope shapes the pose. */
    jumpAirTarget: () => (lastJumpOut ? lastJumpOut.channelTarget : 0),
    /** ContactFacts + FootPlan + costs — read-only session truth. FootPlan is
     *  the §3.2 record the HOST page draws (the pipeline never draws). */
    status: () => ({
      active: true,
      plan: lastPlanOut ? lastPlanOut.plan : { feet: [] },
      contacts: lastPlanOut ? lastPlanOut.contacts : null,
      prediction: lastPlanOut ? lastPlanOut.prediction : null,
      execution: lastPlanOut ? lastPlanOut.execution : null,
      pelvisDropM: +pelvisDropM.toFixed(4),
      calibrated: [...calib.keys()],
      clearM: clearReact,
      deltasLast: lastDeltas.length,
      costMs: { ema: +cost.emaMs.toFixed(4), max: +cost.maxMs.toFixed(4) },
      counters: { ...stat },
      // avoid-constraint truth (proxy census + push/residual ledger)
      armAvoid: avoidActive
        ? { active: true, capsules: avoidCaps.length, report: proxies.report || null,
          ...avoidStat, lastPushM: { ...avoidStat.lastPushM } }
        : { active: false },
      // jump/landing truth (planner facts, read-only)
      jump: jumpPlanner
        ? { active: true, ...(lastJumpOut ? lastJumpOut.facts : {}), legLenM }
        : { active: false },
    }),
  };
}

export default {
  fkPose, resolveLegChains, resolveArmChains, segSegClosest, solveArmAvoid,
  solveTwoBoneLeg, calibrateGait, createFootIkSession,
  POSE_STRIDE,
};
