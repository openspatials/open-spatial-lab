// rig.mjs: a rig's rest pose as plain data, and the avatar frame every measure uses.
//
// The avatar frame: origin under the model, +Y up, +Z the way the avatar faces, +X the avatar's left, metres. A rig
// that faces -Z is turned half a circle and a body outside 1.2 to 2.2 m is scaled to a given height, exactly as
// the build's preparation has always done it (mannequin/tools/prepare-avatar.mjs); nothing is changed in the file.
//
// Public API
//   settleToBindPose(root)            one rest pose (contract rule RB.3): where a skinned bone's node pose differs from its
//       inverse bind matrix, moves the bones to the bind pose. A rig whose two poses agree (within REST_TOLERANCE) is not
//       written, so its numbers stay exact. Returns { settled, max_deg, max_m }.
//   wrapFit(scene, roles, { height, facingYaw, scale, settle })
//       settles the scene, then puts it under a group 'avatar-fit' with the facing turn and the scale.
//       Returns { fit, facing_yaw_rad, scale, natural_height_m, height_m }.
//   skinnedBox(root)                  world box of the skinned vertices in the current pose
//   describeRig(fit, roles, { structure })
//       plain data, the same shape the body details carry as rest_pose:
//       { structure, roles, nodes: { boneName: { parent, local_translation, local_rotation, local_scale, position_m,
//       rotation, scale } }, role_of: { boneName: role } }. position_m, rotation and scale are in the avatar frame.
//   rigFromBody(body)                 the same data, read from a body details file (no glTF needed)
//   boneIndex(root)                   name -> object (bones win over other nodes of the same name)
//
// No DOM use: browser and Node.

import * as THREE from '../../../vendor/scene-core/vendor/three/three.module.js';

export function boneIndex(root) {
  const m = new Map();
  root.traverse((o) => { if (o.name && (!m.has(o.name) || (o.isBone && !m.get(o.name).isBone))) m.set(o.name, o); });
  return m;
}

export function skinnedBox(root) {
  const box = new THREE.Box3(), v = new THREE.Vector3();
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    if (!o.isSkinnedMesh) return;
    const n = o.geometry.attributes.position.count;
    for (let i = 0; i < n; i++) { o.getVertexPosition(i, v); box.expandByPoint(v.applyMatrix4(o.matrixWorld)); }
  });
  return box;
}

// A rig with a bind and a node pose that differ bends every clip read against the wrong one (the Spatial Fabric Viewer
// measured 46.2 degrees on one rig, avatar-retarget.mjs). Below these, the difference is float32 rounding in the file:
// up to 0.27 degrees measured on the test rigs, whose matrices carry a 0.01 armature scale (checks/rest-pose.mjs).
export const REST_TOLERANCE = { deg: 0.5, m: 1e-4 };

export function settleToBindPose(root) {
  root.updateMatrixWorld(true);
  const bind = new Map();
  root.traverse((o) => {
    if (!o.isSkinnedMesh || !o.skeleton) return;
    o.skeleton.bones.forEach((b, i) => { if (!bind.has(b)) bind.set(b, new THREE.Matrix4().multiplyMatrices(root.matrixWorld, new THREE.Matrix4().copy(o.skeleton.boneInverses[i]).invert())); });
  });
  const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3(), bp = new THREE.Vector3(), bq = new THREE.Quaternion();
  let maxDeg = 0, maxM = 0;
  for (const [b, m] of bind) {
    b.matrixWorld.decompose(p, q, s);
    m.decompose(bp, bq, s);
    maxDeg = Math.max(maxDeg, q.angleTo(bq) * 180 / Math.PI);
    maxM = Math.max(maxM, p.distanceTo(bp));
  }
  if (maxDeg <= REST_TOLERANCE.deg && maxM <= REST_TOLERANCE.m) return { settled: false, max_deg: maxDeg, max_m: maxM };
  const world = new Map();
  root.traverse((o) => {
    if (!o.isBone) return;
    const parent = world.get(o.parent) ?? o.parent.matrixWorld;
    const w = bind.get(o) ?? new THREE.Matrix4().multiplyMatrices(parent, o.matrix);
    world.set(o, w);
    new THREE.Matrix4().copy(parent).invert().multiply(w).decompose(o.position, o.quaternion, o.scale);
  });
  root.updateMatrixWorld(true);
  return { settled: true, max_deg: maxDeg, max_m: maxM };
}

export function wrapFit(scene, roles, { height = 1.75, facingYaw = null, scale = null, settle = true } = {}) {
  if (settle) settleToBindPose(scene);
  const fit = new THREE.Group();
  fit.name = 'avatar-fit';
  fit.add(scene);
  fit.updateMatrixWorld(true);
  const idx = boneIndex(scene);
  const wp = (r) => idx.get(roles[r]).getWorldPosition(new THREE.Vector3());
  const toe = roles.leftToes ? wp('leftToes') : wp('leftFoot').add(new THREE.Vector3(0, 0, 0));
  const toeDir = toe.sub(wp('leftFoot'));
  const yaw = facingYaw ?? (toeDir.z < 0 ? Math.PI : 0);
  fit.rotation.y = yaw;
  fit.updateMatrixWorld(true);
  const box = skinnedBox(fit);
  const natural = box.max.y - box.min.y;
  const s = scale ?? (natural >= 1.2 && natural <= 2.2 ? 1 : height / natural);
  fit.scale.setScalar(s);
  fit.updateMatrixWorld(true);
  return { fit, facing_yaw_rad: yaw, scale: s, natural_height_m: natural, height_m: natural * s };
}

const round = (a, k = 1e7) => a.map((x) => Math.round(x * k) / k);

export function describeRig(fit, roles, { structure = 'unknown' } = {}) {
  fit.updateMatrixWorld(true);
  const nodes = {};
  const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  fit.traverse((o) => {
    if (o === fit || !o.isBone) return;
    o.matrixWorld.decompose(p, q, s);
    nodes[o.name] = {
      parent: o.parent?.isBone ? o.parent.name : null,
      local_translation: round(o.position.toArray()),
      local_rotation: round(o.quaternion.toArray()),
      local_scale: round(o.scale.toArray()),
      position_m: round(p.toArray()),
      rotation: round(q.toArray()),
      scale: round(s.toArray()),
    };
  });
  // The static world transform above each top bone (armature node, facing turn, unit and body scale).
  for (const n of Object.values(nodes)) n.parent_world = null;
  fit.traverse((o) => {
    if (o === fit || !o.isBone || o.parent?.isBone) return;
    o.parent.matrixWorld.decompose(p, q, s);
    nodes[o.name].parent_world = { position_m: round(p.toArray()), rotation: round(q.toArray()), scale: round(s.toArray()) };
  });
  const role_of = Object.fromEntries(Object.entries(roles).map(([r, b]) => [b, r]));
  return { structure, roles, nodes, role_of };
}

export function rigFromBody(body) {
  const roles = body.roles;
  return { structure: body.rig.structure, roles, nodes: body.rest_pose, role_of: Object.fromEntries(Object.entries(roles).map(([r, b]) => [b, r])) };
}
