// skeleton.mjs: bone names of the one skeleton family the build carries, ActionForge's CC0 Default skeleton (the
// mannequin's 71 joints), shared by the page, the proof and the offline tools. The Mixamo family was archived by
// 
//
// Public API
//   FAMILIES                         per family: the bones it must have and the bones with a job (roles); one family,
//                                    'mannequin'
//   skeletonFamily(root)             the bones under root: { family, bones, duplicates }; names are used as they are
//   detectFamily(names)              'mannequin' or null
//   footVertexTest(family, side)     a test for bone names that move the foot's vertices
//   jobBones(roles)                  from a body's role map: { hips, toeL, toeR, footL, footR, upLegL, upLegR, head }, the
//                                    same names FAMILIES.mannequin.roles has, for any rig
//   footBoneTest(roles, side)        a test for bone names that move the foot's vertices, for any rig
//   VRM_TO_ACTIONFORGE               the lab's VRM attachment point names -> ActionForge (mannequin family) bone names
//   ACTIONFORGE_TO_VRM               the reverse
//
// No DOM use and no three.js import: plain names only.

export const FAMILIES = {
  mannequin: {
    required: ['pelvis', 'spine_01', 'Head', 'thigh_l', 'calf_l', 'foot_l', 'ball_l', 'thigh_r', 'calf_r', 'foot_r', 'ball_r'],
    roles: { hips: 'pelvis', toeL: 'ball_l', toeR: 'ball_r', footL: 'foot_l', footR: 'foot_r', upLegL: 'thigh_l', upLegR: 'thigh_r', head: 'Head' },
    footBones: { l: /^(foot|ball|ball_leaf)_l$/, r: /^(foot|ball|ball_leaf)_r$/ },
  },
};

export function detectFamily(names) {
  const has = new Set(names);
  for (const [family, f] of Object.entries(FAMILIES)) if (f.required.every((n) => has.has(n))) return family;
  return null;
}

export function skeletonFamily(root) {
  const names = [];
  root.traverse((o) => { if (o.isBone) names.push(o.name); });
  const dupes = names.filter((n, i) => names.indexOf(n) !== i);
  return { family: detectFamily(names), bones: names.length, duplicates: [...new Set(dupes)] };
}

export function footVertexTest(family, side) {
  return FAMILIES[family].footBones[side];
}

export function jobBones(roles) {
  return { hips: roles.hips, toeL: roles.leftToes, toeR: roles.rightToes, footL: roles.leftFoot, footR: roles.rightFoot, upLegL: roles.leftUpperLeg, upLegR: roles.rightUpperLeg, head: roles.head };
}

export function footBoneTest(roles, side) {
  const n = side === 'l' ? 'left' : 'right';
  const set = new Set(['Foot', 'Toes', 'ToeTip'].map((r) => roles[n + r]).filter(Boolean));
  return { test: (name) => set.has(name) };
}

// The lab's VRM attachment point names and ActionForge's bones live with the role tables of the fitting module.
export { VRM_TO_ACTIONFORGE, ACTIONFORGE_TO_VRM } from './fitting/roles.mjs';
