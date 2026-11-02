// map-clips.mjs: play a clip made for one rig on another, from the two rigs' roles and rest poses. No engine state:
// every key is computed from the two rest poses and the clip's own keys, so the same inputs give the same numbers.
//
// Method. A bone's change in the source, in the avatar frame, is D(t) = W_s(t) * inverse(R_s), with W_s its world
// rotation at t and R_s at rest. The target bone takes the same change, from the pose in which the target stands as
// the source does at rest: W_t(t) = D(t) * A_t. A_t ("aligned rest") is the target bone's rest rotation R_t turned by
// a correction C: the rest-pose difference (T-pose, A-pose, palms down).
//   torso, shoulders, feet, toes: C = identity. Every humanoid stands upright and flat-footed at rest, and where
//       their joint lines differ that is where the rigger put the joint, not a pose.
//   upper and lower limbs, fingers: the smallest turn that lays the bone's segment along the source's, carried down
//       the chain (the way a rigger poses a limb).
//   hand: the exact turn that matches the wrist-to-knuckle line and the knuckle line (palm direction included).
// Local rotation of the target bone with mapped parent p and any unmapped target bones between them at rest:
//   q_t(t) = inverse(Between) * inverse(A_t(p)) * R_s(p) * Path(t) * inverse(R_s) * A_t
// Path(t) is the product of the source's local rotations from below p down to this bone; a source bone the target lacks
// (for example upperChest) is folded into its child this way. When that source bone has a mapped parent, the parent also
// takes the share of its turn that keeps the bone's far end in place: Abs(t) = the turn from rest, scaled by L2 / (L1 + L2),
// with L1 and L2 the source's two segments (a chord through a bent two-link chain). Then
//   parent:  W_t(p, t) = W_s(p, t) * Abs(t) * inverse(R_s(p)) * A_t(p)
//   child:   q_t(t) = inverse(Between) * inverse(A_t(p)) * R_s(p) * inverse(Abs(t)) * Path(t) * inverse(R_s) * A_t
// Bone axes and units need nothing more: they are in R_s and R_t.
// A rig of the source's own structure with the source's local rest rotations (ActionForge characters) has C = identity
// and no other change: the clip's rotation keys pass through unchanged.
// Hips: the world movement from rest, times the ratio of the two hips heights (each measured standing as the source
// stands), written in the target hips' parent's units.
//
// Public API
//   buildRigMap(source, target, { fault })   source, target: rigs from rig.mjs describeRig or rigFromBody. Returns the
//       map: { source, target, entries, align (role -> { correction, aligned }), hips_ratio, source_hips_height_m,
//       target_hips_height_m, identity (same structure and local rest rotations) }. fault is for the planted faults of checks/rig-mapping.mjs only:
//       'ignore-rest' (C = identity everywhere), 'ignore-axes' (copy the source's local rotations),
//       'swap-sides' (left plays right), 'no-hips-scale' (ratio 1).
//   mapClip(clip, map, name)                 AnimationClip on the target's bone names; one quaternion track per mapped
//       bone (a constant one when the source has no keys, so the bone still leaves its own rest for the aligned pose)
//       and one position track on the hips. Give it a clip with the root's forward track and scale tracks removed
//       (mannequin/web/avatar/clip-library.mjs makeInPlace); do not scale its hips first.
//   mapPoseAt(clip, map, roles, time)        { boneName: Quaternion } of the named target roles at one time (finger grips)
//
// No DOM use: browser and Node.

import * as THREE from '../../../vendor/scene-core/vendor/three/three.module.js';
import { ROLE_ORDER, ROLE_AIM, ROLE_PARENT, SIDES, sideName } from './roles.mjs';

const Q = (a) => new THREE.Quaternion().fromArray(a);
const V = (a) => new THREE.Vector3().fromArray(a);
const IDENTITY = new THREE.Quaternion();

// Roles whose rest orientation every humanoid shares (see the header).
const STILL = /^(root|hips|spine|chest|upperChest|neck|head|headTip)$|Shoulder$|Foot$|Toes$|ToeTip$/;
const HAND = /^(left|right)Hand$/;
const MIN_SEGMENT = 1e-4; // metres: a shorter segment has no direction (Tavi's collapsed finger joints)

function nodeOf(rig, role) { const b = rig.roles[role]; return b ? rig.nodes[b] : null; }

function segment(rig, role) {
  const a = nodeOf(rig, role);
  const aim = ROLE_AIM[role] ? nodeOf(rig, ROLE_AIM[role]) : null;
  if (!a || !aim) return null;
  const d = V(aim.position_m).sub(V(a.position_m));
  return d.length() < MIN_SEGMENT ? null : d.normalize();
}

// The rest direction pair of a hand: wrist to middle knuckle, little knuckle to index knuckle.
function handBasis(rig, side) {
  const n = sideName(side);
  const w = nodeOf(rig, `${n}Hand`), m = nodeOf(rig, `${n}MiddleProximal`), i = nodeOf(rig, `${n}IndexProximal`), l = nodeOf(rig, `${n}LittleProximal`);
  if (!w || !m || !i || !l) return null;
  const f = V(m.position_m).sub(V(w.position_m));
  const a = V(i.position_m).sub(V(l.position_m));
  if (f.length() < MIN_SEGMENT || a.length() < MIN_SEGMENT) return null;
  f.normalize();
  a.addScaledVector(f, -a.dot(f));
  if (a.length() < MIN_SEGMENT) return null;
  a.normalize();
  const m4 = new THREE.Matrix4().makeBasis(a, f, new THREE.Vector3().crossVectors(a, f));
  return new THREE.Quaternion().setFromRotationMatrix(m4);
}

function sameRest(source, target) {
  if (source.structure !== target.structure) return false;
  return Object.entries(target.roles).every(([role, name]) => {
    const srcName = source.roles[role];
    if (!srcName) return true;
    return Math.abs(Q(source.nodes[srcName].local_rotation).dot(Q(target.nodes[name].local_rotation))) > 1 - 1e-5;
  });
}

function computeAlign(source, target, fault, identity = false) {
  const acc = {};
  const out = {};
  for (const role of ROLE_ORDER) {
    const t = nodeOf(target, role);
    if (!t) continue;
    const parentAcc = () => {
      let p = ROLE_PARENT[role];
      while (p && !acc[p]) p = ROLE_PARENT[p];
      return p ? acc[p] : IDENTITY;
    };
    let c;
    if (identity || fault === 'ignore-rest' || STILL.test(role)) c = IDENTITY.clone();
    else if (HAND.test(role)) {
      const side = role.startsWith('left') ? 'l' : 'r';
      const bs = handBasis(source, side), bt = handBasis(target, side);
      c = bs && bt ? bs.clone().multiply(bt.clone().invert()) : parentAcc().clone();
    } else {
      c = parentAcc().clone();
      const ds = segment(source, role), dt = segment(target, role);
      if (ds && dt) c = new THREE.Quaternion().setFromUnitVectors(dt.applyQuaternion(c), ds).multiply(c);
    }
    acc[role] = c;
    out[role] = { correction: c, aligned: c.clone().multiply(Q(t.rotation)) };
  }
  return out;
}

// Hips height above the lower toe with the rig standing as the source does (segments turned by the corrections).
function standingHipsHeight(rig, align) {
  const pos = {};
  for (const role of ROLE_ORDER) {
    const n = nodeOf(rig, role);
    if (!n) continue;
    let p = ROLE_PARENT[role];
    while (p && !pos[p]) p = ROLE_PARENT[p];
    const here = V(n.position_m);
    if (!p) { pos[role] = here; continue; }
    const pn = nodeOf(rig, p);
    pos[role] = here.sub(V(pn.position_m)).applyQuaternion(align[p].correction).add(pos[p]);
  }
  const low = (s) => pos[`${sideName(s)}Toes`] || pos[`${sideName(s)}Foot`];
  return pos.hips.y - Math.min(...SIDES.map((s) => low(s).y));
}

// Bones from the one below ancestor down to node, top first, by name.
function pathBetween(rig, name, stopName) {
  const path = [];
  let cur = name;
  while (cur && cur !== stopName) { path.unshift(cur); cur = rig.nodes[cur].parent; }
  return path;
}

const staticParentRotation = (rig, topName) => {
  const pw = rig.nodes[topName].parent_world;
  return pw ? Q(pw.rotation) : IDENTITY.clone();
};

export function buildRigMap(source, target, { fault = null } = {}) {
  const identity = sameRest(source, target);
  const align = computeAlign(source, target, fault, identity);
  const swapped = (role) => {
    if (fault !== 'swap-sides') return role;
    if (role.startsWith('left')) return `right${role.slice(4)}`;
    if (role.startsWith('right')) return `left${role.slice(5)}`;
    return role;
  };
  const inBoth = (role) => source.roles[swapped(role)] && target.roles[role];
  const entries = [];
  for (const role of ROLE_ORDER) {
    if (!inBoth(role)) continue;
    const srcName = source.roles[swapped(role)], tgtName = target.roles[role];
    let p = ROLE_PARENT[role];
    while (p && !inBoth(p)) p = ROLE_PARENT[p];
    const srcStop = p ? source.roles[swapped(p)] : null;
    const tgtStop = p ? target.roles[p] : null;
    const srcPath = pathBetween(source, srcName, srcStop);
    const tgtBetween = pathBetween(target, tgtName, tgtStop).slice(0, -1);
    const between = tgtBetween.reduce((acc, n) => acc.multiply(Q(target.nodes[n].local_rotation)), new THREE.Quaternion());
    const R_s = Q(source.nodes[srcName].rotation);
    const srcAbove = p ? Q(source.nodes[srcStop].rotation) : staticParentRotation(source, srcPath[0]);
    const tgtTop = tgtBetween[0] || tgtName;
    const tgtAbove = p ? align[p].aligned.clone() : staticParentRotation(target, tgtTop);
    let pre, post;
    if (identity || fault === 'ignore-axes') { pre = IDENTITY.clone(); post = IDENTITY.clone(); } else {
      pre = between.clone().invert().multiply(tgtAbove.clone().invert()).multiply(srcAbove);
      post = R_s.clone().invert().multiply(align[role].aligned);
    }
    entries.push({ role, tgtName, srcName, srcPath, pre, post, parentRole: p || null, absorb: null, parentAbsorb: null });
  }
  // A source bone the target lacks: its mapped parent takes the chord's share of its turn (see the header).
  if (!fault) {
    for (const role of ROLE_ORDER) {
      if (!source.roles[role] || target.roles[role]) continue;
      const parent = ROLE_PARENT[role], aim = ROLE_AIM[role];
      if (!parent || !aim || !inBoth(parent) || !source.roles[aim]) continue;
      const at = (r) => V(source.nodes[source.roles[r]].position_m);
      const L1 = at(role).distanceTo(at(parent)), L2 = at(aim).distanceTo(at(role));
      if (!(L1 + L2 > 0)) continue;
      const absorb = { bone: source.roles[role], weight: L2 / (L1 + L2), rest: Q(source.nodes[source.roles[role]].local_rotation) };
      const e = entries.find((x) => x.role === parent);
      e.absorb = absorb;
      for (const child of entries) if (child.parentRole === parent) child.parentAbsorb = absorb;
    }
  }
  const srcHeight = standingHipsHeight(source, computeAlign(source, source, null, true));
  const tgtHeight = standingHipsHeight(target, align);
  const hips_ratio = fault === 'no-hips-scale' ? 1 : tgtHeight / srcHeight;
  return { source, target, entries, align, identity, hips_ratio, source_hips_height_m: srcHeight, target_hips_height_m: tgtHeight };
}

function trackIndex(clip) {
  const q = new Map(), p = new Map();
  for (const t of clip.tracks) {
    const dot = t.name.lastIndexOf('.');
    const bone = t.name.slice(0, dot), prop = t.name.slice(dot + 1);
    if (prop === 'quaternion') q.set(bone, t);
    if (prop === 'position') p.set(bone, t);
  }
  return { q, p };
}

function unionTimes(tracks) {
  if (!tracks.length) return [];
  const first = tracks[0].times;
  const same = tracks.every((t) => t.times === first || (t.times.length === first.length && t.times.every((x, i) => x === first[i])));
  if (same) return Array.from(first);
  return [...new Set(tracks.flatMap((t) => Array.from(t.times)))].sort((a, b) => a - b);
}

const sampler = (track) => {
  const it = track.createInterpolant();
  return (t, out) => { const v = it.evaluate(t); return out.set(v[0], v[1], v[2], v[3]).normalize(); };
};

function pathRotation(path, nodes, samplers, t, out) {
  out.identity();
  const q = new THREE.Quaternion();
  for (const n of path) {
    const s = samplers.get(n);
    if (s) s(t, q); else q.fromArray(nodes[n].local_rotation);
    out.multiply(q);
  }
  return out;
}

// The share of a folded bone's turn from rest at time t (Abs in the header), or null.
function absorbedAt(absorb, samplers, t) {
  if (!absorb) return null;
  const s = samplers.get(absorb.bone);
  if (!s) return null;
  const q = s(t, new THREE.Quaternion()).multiply(absorb.rest.clone().invert());
  return IDENTITY.clone().slerp(q, absorb.weight);
}

// q_t(t) of one entry.
function entryRotation(e, nodes, samplers, t, out) {
  const path = pathRotation(e.srcPath, nodes, samplers, t, new THREE.Quaternion());
  const mine = absorbedAt(e.absorb, samplers, t);
  const theirs = absorbedAt(e.parentAbsorb, samplers, t);
  out.copy(e.pre);
  if (theirs) out.multiply(theirs.invert());
  out.multiply(path);
  if (mine) out.multiply(mine);
  return out.multiply(e.post).normalize();
}

function makeSamplers(clip) {
  const { q, p } = trackIndex(clip);
  return { q, p, rot: new Map([...q].map(([n, tr]) => [n, sampler(tr)])) };
}

function hipsTrack(clip, map, idx) {
  const { source, target } = map;
  const srcHips = source.roles.hips, tgtHips = target.roles.hips;
  const tr = idx.p.get(srcHips);
  if (!tr) return null;
  const pos = tr.createInterpolant();
  const srcRest = V(source.nodes[srcHips].position_m);
  const tgtRest = V(target.nodes[tgtHips].position_m);
  // World matrix of the source hips' parent at time t: its chain from the static top, with this clip's rotations.
  const srcChain = pathBetween(source, source.nodes[srcHips].parent, null);
  const staticTop = (rig, top) => {
    const pw = rig.nodes[top]?.parent_world;
    return pw ? new THREE.Matrix4().compose(V(pw.position_m), Q(pw.rotation), V(pw.scale)) : new THREE.Matrix4();
  };
  const srcTopM = srcChain.length ? staticTop(source, srcChain[0]) : staticTop(source, srcHips);
  // The target hips' parent: a mapped role (root) turns with the clip, anything else stands still.
  const tgtParentName = target.nodes[tgtHips].parent;
  const tgtParentRole = tgtParentName ? target.role_of[tgtParentName] : null;
  const parentEntry = tgtParentRole ? map.entries.find((e) => e.role === tgtParentRole) : null;
  const tgtStaticM = tgtParentName
    ? new THREE.Matrix4().compose(V(target.nodes[tgtParentName].position_m), Q(target.nodes[tgtParentName].rotation), V(target.nodes[tgtParentName].scale))
    : staticTop(target, tgtHips);
  const times = Array.from(tr.times);
  const out = new Float32Array(times.length * 3);
  const m = new THREE.Matrix4(), lm = new THREE.Matrix4(), q = new THREE.Quaternion(), v = new THREE.Vector3();
  const invStatic = tgtStaticM.clone().invert();
  times.forEach((t, i) => {
    m.copy(srcTopM);
    for (const n of srcChain) {
      const samp = idx.rot.get(n);
      if (samp) samp(t, q); else q.fromArray(source.nodes[n].local_rotation);
      lm.compose(V(source.nodes[n].local_translation), q, V(source.nodes[n].local_scale || [1, 1, 1]));
      m.multiply(lm);
    }
    const raw = pos.evaluate(t);
    const world = v.set(raw[0], raw[1], raw[2]).applyMatrix4(m);
    const target_world = world.sub(srcRest).multiplyScalar(map.hips_ratio).add(tgtRest);
    let inv = invStatic;
    if (parentEntry) {
      // The parent's rotation at t, from the same change the source's bone went through.
      const srcP = source.roles[tgtParentRole];
      const change = pathRotation(pathBetween(source, srcP, null), source.nodes, idx.rot, t, new THREE.Quaternion());
      const above = staticParentRotation(source, pathBetween(source, srcP, null)[0]);
      const world_q = above.multiply(change).multiply(Q(source.nodes[srcP].rotation).invert()).multiply(map.align[tgtParentRole].aligned);
      inv = new THREE.Matrix4().compose(V(target.nodes[tgtParentName].position_m), world_q, V(target.nodes[tgtParentName].scale)).invert();
    }
    target_world.applyMatrix4(inv);
    out.set([target_world.x, target_world.y, target_world.z], i * 3);
  });
  return new THREE.VectorKeyframeTrack(`${tgtHips}.position`, times, out);
}

export function mapClip(clip, map, name = clip.name) {
  const idx = makeSamplers(clip);
  const tracks = [];
  const q = new THREE.Quaternion();
  const prev = new THREE.Quaternion();
  for (const e of map.entries) {
    const keyed = [...e.srcPath, e.absorb?.bone].filter(Boolean).map((n) => idx.q.get(n)).filter(Boolean);
    const times = keyed.length ? unionTimes(keyed) : [0];
    const values = new Float32Array(times.length * 4);
    times.forEach((t, i) => {
      entryRotation(e, map.source.nodes, idx.rot, t, q);
      if (i && prev.dot(q) < 0) q.set(-q.x, -q.y, -q.z, -q.w);
      prev.copy(q);
      values.set([q.x, q.y, q.z, q.w], i * 4);
    });
    tracks.push(new THREE.QuaternionKeyframeTrack(`${e.tgtName}.quaternion`, times, values));
  }
  const h = hipsTrack(clip, map, idx);
  if (h) tracks.push(h);
  return new THREE.AnimationClip(name, clip.duration, tracks);
}

export function mapPoseAt(clip, map, roles, time) {
  const idx = makeSamplers(clip);
  const want = new Set(roles);
  const out = {};
  for (const e of map.entries) {
    if (!want.has(e.role)) continue;
    out[e.tgtName] = entryRotation(e, map.source.nodes, idx.rot, time, new THREE.Quaternion());
  }
  return out;
}
