// measures.mjs: how far a fitted item is from where its body's details say it belongs, on a live avatar. The page's status
// line and the checks (checks/level2.mjs, the build's proof) read the same numbers. No DOM use: browser and Node.
//
// Public API (each given a VisitorAvatar or RemoteVisitor after its step)
//   gripError(av)               metres: held item's contact point to the hand's measured hollow; null unless one-handed held;
//                               Infinity when the body has no measured hollow for this grip pose
//   carryErrors(av, placement)  { l, r }: metres, palm to contact point on the item; null unless carrying. placement is
//                               equipment.mjs heldPlacement's result for the carried item

import * as THREE from '../../../vendor/scene-core/vendor/three/three.module.js';
import { sideName, SIDES } from './roles.mjs';
import { gripKey } from './holds.mjs';

const _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3();
export const frameOf = (bone) => { bone.matrixWorld.decompose(_p, _q, _s); return { p: _p.clone(), q: _q.clone() }; };
export const inHand = (hand, a) => new THREE.Vector3().fromArray(a).applyQuaternion(hand.q).add(hand.p);

export function gripError(av) {
  const held = av.equipment.held;
  if (!held || held.item.hands === 2) return null;
  const { item, node } = held;
  const body = av.solvers.body;
  const hollow = body.hands[item.hand].hollows[gripKey(item.grip)];
  if (!hollow) return Infinity;
  const hand = frameOf(av.instance.bones[body.roles[`${sideName(item.hand)}Hand`]]);
  const grip = node.localToWorld(new THREE.Vector3().fromArray(item.contacts[item.hand].point));
  return grip.distanceTo(inHand(hand, hollow.position_m));
}

export function carryErrors(av, placement) {
  const held = av.equipment.held;
  if (!held || held.item.hands !== 2) return null;
  const body = av.solvers.body;
  const out = {};
  for (const s of SIDES) {
    // The contact point is read from the item's node, not from the solver's own record of it.
    const hand = frameOf(av.instance.bones[body.roles[`${sideName(s)}Hand`]]);
    const palm = inHand(hand, body.hands[s].palm_m);
    out[s] = palm.distanceTo(held.node.localToWorld(new THREE.Vector3().fromArray(placement.contacts[s].point)));
  }
  return out;
}
