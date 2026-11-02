// holds.mjs: where an item sits on a body, from the body's details and the item's details. Plain matrices, no scene.
//
// A held item: its contact point goes to the hand's measured point, its grip axis along the hand's knuckle line (little
// finger to index) and its forward axis along the hand (wrist to knuckles). A worn item: placed in the anchor bone's
// rest-aligned frame by offsets scaled with the body's measures.
//
// Public API
//   gripFrameFromJoints(index, little, middle)   three Vector3 in the hand's frame -> { a, f }: the knuckle line and the
//                                                hand's forward direction, orthonormal
//   placeAtContact({ point, a, f, contact, scale })  Matrix4: the item's own frame into the hand's frame.
//       contact: { point, grip_axis, forward_axis } in the item file's units; scale: the item's scale
//   gripKey(grip)                                'clip@time', the key of a grip pose in body.hands[side].hollows
//   hollowOf(body, side, grip)                   the measured hollow for that grip pose ({ position_m, radius_m, ... })
//   fitHold(body, item, side)                    Matrix4 of the item in the hand bone's own local units; its contact
//                                                point sits at the hollow of that grip pose
//   bodyOffset(body, offset)                     offset { right, up, forward }, each { measure, factor, add_m }, -> Vector3 in
//                                                metres in the avatar's axes
//   fitWorn(body, reference, item)               Matrix4 of a worn item in the anchor bone's local units; the item
//                                                scales with the body's head width over the reference body's
//   carryAnchor(body, item), carryScale(body, item)  the anchor role a rig has, and the item's scale on this body
//   fitCarried(body, item, frame)                Matrix4 of a carried item (placement.contact_on_hand 'palm') in the anchor
//                                                bone's local units
//   poseFrame(body, boneName, localAt)           a bone's { p, q } in the avatar frame in a pose, from the details alone
//   carryFrame(body, item, poses)                the anchor's mean turn in a stance and the torso's front from the anchor
//   fitContacts(body, item, localAt, times, frame)  the contact points this body's arms can reach (see below)
//   hollowInBone(body, side, grip)               the hollow in the hand bone's own local units (Vector3)
//   contactFrameError(matrix, contact, target)   metres between the item's contact point and a point, for checks
//
// No DOM use: browser and Node.

import * as THREE from '../../../vendor/scene-core/vendor/three/three.module.js';
import { sideName, SIDES, ROLE_PARENT } from './roles.mjs';

// A carried item's contacts stay within this share of the arm's length, so the elbow keeps a bend in every stance frame.
export const CARRY_REACH_SHARE = 0.985;
export const SHOULDER_ASSIST_DEG = 30; // the most reach-hands turns a shoulder toward a target past the arm's reach (solvers.mjs)
// Contract rule RB.10. An item is out of reach only past the arm and the shoulder's turn together: Tavi's box is 0.106 m past
// his arm alone, and his palms are on it within 1 mm. enabled is switched off only by the proof's planted fault and to
// measure what a refused item would have done.
export const REFUSE = { enabled: true };
export const reachRefusal = (fit) => (REFUSE.enabled && fit.reach_beyond_m > 0 ? 'out of reach' : null);

const V = (a) => new THREE.Vector3().fromArray(a);

export function gripFrameFromJoints(index, little, middle) {
  const a = index.clone().sub(little).normalize();
  const f0 = middle.clone().normalize();
  const f = f0.sub(a.clone().multiplyScalar(f0.dot(a))).normalize();
  return { a, f };
}

export function placeAtContact({ point, a, f, contact, scale = 1 }) {
  const target = new THREE.Matrix4().makeBasis(a, f, new THREE.Vector3().crossVectors(a, f));
  const ia = V(contact.grip_axis).normalize();
  const if0 = V(contact.forward_axis).normalize();
  const ifw = if0.sub(ia.clone().multiplyScalar(if0.dot(ia))).normalize();
  const source = new THREE.Matrix4().makeBasis(ia, ifw, new THREE.Vector3().crossVectors(ia, ifw));
  const R = target.clone().multiply(source.clone().transpose());
  const c = V(contact.point);
  return new THREE.Matrix4().makeTranslation(point.x, point.y, point.z)
    .multiply(R)
    .multiply(new THREE.Matrix4().makeScale(scale, scale, scale))
    .multiply(new THREE.Matrix4().makeTranslation(-c.x, -c.y, -c.z));
}

export const gripKey = (grip) => `${grip.clip}@${grip.time}`;

export function hollowOf(body, side, grip) {
  const h = body.hands[side];
  const got = h.hollows[gripKey(grip)];
  if (!got) throw new Error(`body ${body.id}: no hollow for ${gripKey(grip)} on hand ${side}`);
  return got;
}

function boneUnits(body, role) {
  const s = body.rest_pose[body.roles[role]].scale;
  return new THREE.Matrix4().makeScale(1 / s[0], 1 / s[1], 1 / s[2]);
}

export function fitHold(body, item, side) {
  const hand = body.hands[side];
  const contact = item.contacts?.[side];
  if (!contact) throw new Error(`item ${item.id}: no contact for hand ${side}`);
  const m = placeAtContact({
    point: V(hollowOf(body, side, item.grip).position_m),
    a: V(hand.grip_frame.knuckle_axis),
    f: V(hand.grip_frame.forward_axis),
    contact,
    scale: item.scale || 1,
  });
  return boneUnits(body, `${sideName(side)}Hand`).multiply(m);
}

export function bodyOffset(body, offset = {}) {
  const part = (o) => (o ? (o.measure ? body.measures[o.measure] * (o.factor ?? 1) : 0) + (o.add_m ?? 0) : 0);
  // The avatar's axes: +X its left, +Y up, +Z forward.
  return new THREE.Vector3(-part(offset.right), part(offset.up), part(offset.forward));
}

export function fitWorn(body, reference, item) {
  const place = item.placement;
  const node = body.rest_pose[body.roles[place.anchor]];
  const restQ = new THREE.Quaternion().fromArray(node.rotation);
  const measure = place.scale_with || 'head_width_m';
  const s = (item.scale_m_per_unit ?? 1) * (body.measures[measure] / reference.measures[measure]);
  const itemQ = new THREE.Quaternion().fromArray(place.rotation || [0, 0, 0, 1]);
  // The offset places the item's attach point (its bottom centre); the item's origin follows from that and its scale.
  const origin = bodyOffset(body, place.offset).sub(V(place.attach_point || [0, 0, 0]).multiplyScalar(s).applyQuaternion(itemQ));
  const p = origin.applyQuaternion(restQ.clone().invert());
  const q = restQ.clone().invert().multiply(itemQ);
  const m = new THREE.Matrix4().compose(p, q, new THREE.Vector3(s, s, s));
  return boneUnits(body, place.anchor).multiply(m);
}

// A carried item's anchor: the role it names, or that role's parent on a rig without it.
export function carryAnchor(body, item) {
  let role = item.placement.anchor;
  while (role && !body.roles[role]) role = ROLE_PARENT[role];
  return role;
}

export function carryScale(body, item) {
  const p = item.placement;
  return p.scale_with ? (item.scale || 1) * (body.measures[p.scale_with] / p.scale_reference_m) : (item.scale || 1);
}

// Where a bone stands in the avatar frame when the body stands in a pose: { p (metres), q }. pose: localAt(boneName) gives
// { q, p } of the bone's local rotation and position, or null for its rest values.
export function poseFrame(body, boneName, localAt) {
  const chain = [];
  for (let n = boneName; n; n = body.rest_pose[n].parent) chain.unshift(n);
  const top = body.rest_pose[chain[0]].parent_world;
  const m = top ? new THREE.Matrix4().compose(V(top.position_m), new THREE.Quaternion().fromArray(top.rotation), V(top.scale)) : new THREE.Matrix4();
  for (const n of chain) {
    const node = body.rest_pose[n];
    const got = localAt(n) || {};
    m.multiply(new THREE.Matrix4().compose(got.p || V(node.local_translation), got.q || new THREE.Quaternion().fromArray(node.local_rotation), V(node.local_scale)));
  }
  const p = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
  m.decompose(p, q, sc);
  return { p, q };
}

// The frame a carried item is placed in: the anchor's turn in the stance (mean over the sample poses), so the item stands level
// whatever the clip does to the spine, and the torso's front measured from the anchor in that pose. poses: list of localAt.
export function carryFrame(body, item, poses) {
  const role = carryAnchor(body, item);
  const anchorName = body.roles[role];
  const parts = Object.values(body.volumes.torso_parts).filter((v) => v.max_m);
  const sum = [0, 0, 0, 0];
  let first = null, front = 0;
  for (const pose of poses) {
    const a = poseFrame(body, anchorName, pose);
    if (!first) first = a.q.clone();
    const k = a.q.dot(first) < 0 ? -1 : 1;
    sum[0] += k * a.q.x; sum[1] += k * a.q.y; sum[2] += k * a.q.z; sum[3] += k * a.q.w;
    front = Math.max(front, ...parts.map((v) => poseFrame(body, body.roles[v.origin_role], pose).p.z + v.max_m[2] - a.p.z));
  }
  return { q: new THREE.Quaternion(sum[0], sum[1], sum[2], sum[3]).normalize(), front_m: front };
}

// The carried item's place in metres in the anchor's frame: centred across the body, its back clear of the torso's front
// by placement.clear_of_torso_m, at a height set by the torso's. frame: carryFrame(), or the rest pose when left out.
function restFrame(body, item) {
  const role = carryAnchor(body, item);
  const anchor = body.rest_pose[body.roles[role]];
  const parts = Object.values(body.volumes.torso_parts).filter((v) => v.max_m);
  const front = Math.max(...parts.map((v) => body.rest_pose[body.roles[v.origin_role]].position_m[2] + v.max_m[2])) - anchor.position_m[2];
  return { q: new THREE.Quaternion().fromArray(anchor.rotation), front_m: front };
}

export function fitCarried(body, item, frame = restFrame(body, item)) {
  const place = item.placement;
  const role = carryAnchor(body, item);
  const s = carryScale(body, item);
  const inv = frame.q.clone().invert();
  const forward = frame.front_m + (item.size_m[2] * s) / (item.scale || 1) / 2 + (place.clear_of_torso_m ?? 0);
  // A rig without the named anchor uses its parent; the named joint would sit about halfway from there to the next one up.
  const standIn = role !== place.anchor && body.roles.neck ? (body.rest_pose[body.roles.neck].position_m[1] - body.rest_pose[body.roles[role]].position_m[1]) / 2 : 0;
  const p = new THREE.Vector3(0, bodyOffset(body, place.offset).y + standIn, forward).applyQuaternion(inv);
  const q = inv.clone().multiply(new THREE.Quaternion().fromArray(place.rotation || [0, 0, 0, 1]));
  return boneUnits(body, role).multiply(new THREE.Matrix4().compose(p, q, new THREE.Vector3(s, s, s)));
}

// The contact points this body uses. A contact may slide back along its forward axis (slide_m, the item's units): a short
// arm holds the item nearer its back. localAt(boneName, time) gives a bone's local rotation in the stance (a Quaternion or null),
// times the sample times. Returns { contacts: { l, r }, slide, reach_short_m, reach_beyond_m } with slide in the item's units;
// reach_short_m is past the arm alone, reach_beyond_m past the arm and the shoulder's turn (above 0: reachRefusal).
export function fitContacts(body, item, localAt, times, frame) {
  const role = carryAnchor(body, item);
  const anchorName = body.roles[role];
  const scale = body.rest_pose[anchorName].scale[0];
  const mm = new THREE.Matrix4().makeScale(scale, scale, scale).multiply(fitCarried(body, item, frame));
  const itemQ = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().extractRotation(mm));
  const armReach = (side) => {
    const n = sideName(side);
    return body.bone_lengths_m[`${n}UpperArm`] + body.bone_lengths_m[`${n}LowerArm`];
  };
  // The upper arm's joint in the anchor bone's axes, in metres, per sample.
  const shoulderAt = (side, t) => {
    const chain = [];
    let name = body.roles[`${sideName(side)}UpperArm`];
    while (name && name !== anchorName) { chain.push(name); name = body.rest_pose[name].parent; }
    const m = new THREE.Vector3();
    for (const b of chain) {
      const n = body.rest_pose[b];
      m.multiplyScalar(n.local_scale[0]).applyQuaternion(b === chain[0] ? new THREE.Quaternion() : (localAt(b, t) || new THREE.Quaternion().fromArray(n.local_rotation))).add(new THREE.Vector3().fromArray(n.local_translation));
    }
    return m.multiplyScalar(scale);
  };
  const wristFor = (side, slide) => {
    const c = item.contacts[side];
    const hand = body.hands[side];
    const axis = new THREE.Vector3().fromArray(c.forward_axis).normalize();
    const point = new THREE.Vector3().fromArray(c.point).addScaledVector(axis, -slide).applyMatrix4(mm);
    const basis = (a0, f0) => {
      const a = a0.clone().normalize();
      const f = f0.clone().addScaledVector(a, -f0.dot(a)).normalize();
      return new THREE.Matrix4().makeBasis(a, f, new THREE.Vector3().crossVectors(a, f));
    };
    const want = basis(new THREE.Vector3().fromArray(c.grip_axis).applyQuaternion(itemQ), new THREE.Vector3().fromArray(c.forward_axis).applyQuaternion(itemQ));
    const has = basis(new THREE.Vector3().fromArray(hand.grip_frame.knuckle_axis), new THREE.Vector3().fromArray(hand.grip_frame.forward_axis));
    const rot = new THREE.Quaternion().setFromRotationMatrix(want.multiply(has.transpose()));
    return point.clone().sub(new THREE.Vector3().fromArray(hand.palm_m).applyQuaternion(rot));
  };
  const shoulders = { l: times.map((t) => shoulderAt('l', t)), r: times.map((t) => shoulderAt('r', t)) };
  const short = (slide) => Math.max(...SIDES.map((side) => {
    if (!item.contacts[side]) return -Infinity;
    const w = wristFor(side, slide);
    return Math.max(...shoulders[side].map((p) => p.distanceTo(w))) - armReach(side) * CARRY_REACH_SHARE;
  }));
  const limit = Math.max(...SIDES.map((side) => item.contacts[side]?.slide_m ?? 0));
  let slide = 0;
  const STEP = 0.0025;
  while (slide < limit && short(slide) > 0) slide = Math.min(limit, slide + STEP);
  const contacts = {};
  for (const side of SIDES) {
    const c = item.contacts[side];
    if (!c) continue;
    const axis = new THREE.Vector3().fromArray(c.forward_axis).normalize();
    contacts[side] = { ...c, point: new THREE.Vector3().fromArray(c.point).addScaledVector(axis, -slide).toArray() };
  }
  const assist = (side) => 2 * (body.bone_lengths_m[`${sideName(side)}Shoulder`] ?? 0) * Math.sin((SHOULDER_ASSIST_DEG * Math.PI) / 360);
  const beyond = Math.max(...SIDES.map((side) => {
    if (!item.contacts[side]) return -Infinity;
    const w = wristFor(side, slide);
    return Math.max(...shoulders[side].map((p) => p.distanceTo(w))) - armReach(side) * CARRY_REACH_SHARE - assist(side);
  }));
  return { contacts, slide, reach_short_m: Math.max(0, short(slide)), reach_beyond_m: Math.max(0, beyond) };
}

export function hollowInBone(body, side, grip) {
  return V(hollowOf(body, side, grip).position_m).applyMatrix4(boneUnits(body, `${sideName(side)}Hand`));
}

export function contactFrameError(matrix, contact, target) {
  return V(contact.point).applyMatrix4(matrix).distanceTo(target);
}
