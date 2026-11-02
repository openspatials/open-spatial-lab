// roles.mjs: which bone does which job. One role name per job (VRM 1.0 humanoid names, plus root and the tip roles VRM
// does not name), one table per rig structure, and the detection of a rig's structure from its bone names.
// Plain names only: no three.js, no DOM.
//
// Public API
//   ROLE_PARENT                       role -> the role above it in a humanoid
//   ROLE_AIM                          role -> the role its bone points at (its segment's far end)
//   ROLE_ORDER                        every role, parents first
//   REQUIRED_ROLES                    a rig without these is refused
//   ROLE_TABLES                       { actionforge, mixamo, unreal, vrm }: role -> bone name
//   sanitizeBoneName(name)            the name three.js gives a node (GLTFLoader removes : . / [ ] and turns spaces into _)
//   rolesFromVrmExtension(gltfJson)   role -> node name from a VRM file's own humanoid record (VRM 1.0 or 0.x), or null
//   detectRig(names, { gltfJson, roleMap })
//       names: the rig's bone names. Returns { structure, roles (role -> bone name as given), missing (optional roles
//       the rig lacks), source ('role map', 'vrm extension' or 'table:<structure>') } or null when no table covers
//       REQUIRED_ROLES. A role map given by the caller wins over everything.
//   VRM_TO_ACTIONFORGE, ACTIONFORGE_TO_VRM
//       the lab's twenty VRM attachment point names (code/src/equipment-foundation.js) and ActionForge's bones
//   TORSO_ROLES, HAND_SET(side), FOOT_SET(side), SIDES, sideName(side), fingerRoles(side)

export const SIDES = ['l', 'r'];
export const sideName = (s) => (s === 'l' ? 'left' : 'right');
const FINGER_JOINTS = {
  Thumb: ['Metacarpal', 'Proximal', 'Distal', 'Tip'],
  Index: ['Proximal', 'Intermediate', 'Distal', 'Tip'],
  Middle: ['Proximal', 'Intermediate', 'Distal', 'Tip'],
  Ring: ['Proximal', 'Intermediate', 'Distal', 'Tip'],
  Little: ['Proximal', 'Intermediate', 'Distal', 'Tip'],
};

export const ROLE_PARENT = { hips: 'root', spine: 'hips', chest: 'spine', upperChest: 'chest', neck: 'upperChest', head: 'neck', headTip: 'head' };
export const ROLE_AIM = { spine: 'chest', chest: 'upperChest', upperChest: 'neck', neck: 'head', head: 'headTip' };
for (const s of SIDES) {
  const n = sideName(s);
  const chain = (list, top) => list.forEach((r, i) => {
    ROLE_PARENT[n + r] = i ? n + list[i - 1] : top;
    if (i + 1 < list.length) ROLE_AIM[n + r] = n + list[i + 1];
  });
  chain(['Shoulder', 'UpperArm', 'LowerArm', 'Hand'], 'upperChest');
  chain(['UpperLeg', 'LowerLeg', 'Foot', 'Toes', 'ToeTip'], 'hips');
  for (const [f, joints] of Object.entries(FINGER_JOINTS)) chain(joints.map((j) => f + j), `${n}Hand`);
  ROLE_AIM[`${n}Hand`] = `${n}MiddleProximal`;
}

// Parents before children.
export const ROLE_ORDER = (() => {
  const out = ['root'];
  const left = new Set(Object.keys(ROLE_PARENT));
  while (left.size) for (const r of [...left]) if (out.includes(ROLE_PARENT[r])) { out.push(r); left.delete(r); }
  return out;
})();

export const REQUIRED_ROLES = ['hips', 'spine', 'head', ...SIDES.flatMap((s) => ['UpperArm', 'LowerArm', 'Hand', 'UpperLeg', 'LowerLeg', 'Foot'].map((r) => sideName(s) + r))];
export const TORSO_ROLES = ['hips', 'spine', 'chest', 'upperChest'];
export const fingerRoles = (side) => Object.entries(FINGER_JOINTS).flatMap(([f, joints]) => joints.map((j) => `${sideName(side)}${f}${j}`));
export const HAND_SET = (side) => [`${sideName(side)}Hand`, ...fingerRoles(side)];
export const FOOT_SET = (side) => ['Foot', 'Toes', 'ToeTip'].map((r) => sideName(side) + r);

// ActionForge's Default skeleton and Unreal's skeleton share a plan: lower-case joints with _l and _r.
function ueStyle({ head, toeTip, fingerTip }) {
  const t = { root: 'root', hips: 'pelvis', spine: 'spine_01', chest: 'spine_02', upperChest: 'spine_03', neck: 'neck_01', head };
  for (const s of SIDES) {
    const n = sideName(s);
    Object.assign(t, {
      [`${n}Shoulder`]: `clavicle_${s}`, [`${n}UpperArm`]: `upperarm_${s}`, [`${n}LowerArm`]: `lowerarm_${s}`, [`${n}Hand`]: `hand_${s}`,
      [`${n}UpperLeg`]: `thigh_${s}`, [`${n}LowerLeg`]: `calf_${s}`, [`${n}Foot`]: `foot_${s}`, [`${n}Toes`]: `ball_${s}`,
    });
    if (toeTip) t[`${n}ToeTip`] = `ball_leaf_${s}`;
    for (const [f, ue] of [['Thumb', 'thumb'], ['Index', 'index'], ['Middle', 'middle'], ['Ring', 'ring'], ['Little', 'pinky']]) {
      const [a, b, c, tip] = FINGER_JOINTS[f];
      t[n + f + a] = `${ue}_01_${s}`; t[n + f + b] = `${ue}_02_${s}`; t[n + f + c] = `${ue}_03_${s}`;
      if (fingerTip) t[n + f + tip] = `${ue}_04_leaf_${s}`;
    }
  }
  return t;
}

function mixamoTable() {
  const t = { hips: 'Hips', spine: 'Spine', chest: 'Spine1', upperChest: 'Spine2', neck: 'Neck', head: 'Head', headTip: 'HeadTop_End' };
  for (const s of SIDES) {
    const n = sideName(s), M = s === 'l' ? 'Left' : 'Right';
    Object.assign(t, {
      [`${n}Shoulder`]: `${M}Shoulder`, [`${n}UpperArm`]: `${M}Arm`, [`${n}LowerArm`]: `${M}ForeArm`, [`${n}Hand`]: `${M}Hand`,
      [`${n}UpperLeg`]: `${M}UpLeg`, [`${n}LowerLeg`]: `${M}Leg`, [`${n}Foot`]: `${M}Foot`, [`${n}Toes`]: `${M}ToeBase`, [`${n}ToeTip`]: `${M}Toe_End`,
    });
    for (const [f, mx] of [['Thumb', 'Thumb'], ['Index', 'Index'], ['Middle', 'Middle'], ['Ring', 'Ring'], ['Little', 'Pinky']]) {
      FINGER_JOINTS[f].forEach((j, i) => { t[n + f + j] = `${M}Hand${mx}${i + 1}`; });
    }
  }
  return t;
}

function vrmTable() {
  const t = {};
  for (const r of ROLE_ORDER) if (!/^root$|Tip$/.test(r)) t[r] = r;
  return t;
}

export const ROLE_TABLES = {
  actionforge: ueStyle({ head: 'Head', toeTip: true, fingerTip: true }),
  mixamo: mixamoTable(),
  unreal: ueStyle({ head: 'head', toeTip: false, fingerTip: false }),
  vrm: vrmTable(),
};

// Prefixes Mixamo exports carry, before or after three.js removes the colon.
const MIXAMO_PREFIX = /^mixamorig\d*[:_]?/;

export function sanitizeBoneName(name) {
  return name.replace(/\s/g, '_').replace(/[[\].:/]/g, '');
}

export function rolesFromVrmExtension(gltfJson) {
  const nodes = gltfJson?.nodes;
  const v1 = gltfJson?.extensions?.VRMC_vrm?.humanoid?.humanBones;
  if (nodes && v1) return Object.fromEntries(Object.entries(v1).map(([role, b]) => [role, nodes[b.node]?.name]).filter(([, n]) => n));
  const v0 = gltfJson?.extensions?.VRM?.humanoid?.humanBones;
  if (nodes && Array.isArray(v0)) return Object.fromEntries(v0.map((b) => [b.bone, nodes[b.node]?.name]).filter(([, n]) => n));
  return null;
}

function finish(structure, roles, source) {
  return { structure, roles, missing: ROLE_ORDER.filter((r) => !roles[r]), source };
}

export function detectRig(names, { gltfJson = null, roleMap = null } = {}) {
  const have = new Set(names);
  const bySanitized = new Map(names.map((n) => [sanitizeBoneName(n), n]));
  const given = (raw) => (have.has(raw) ? raw : bySanitized.get(sanitizeBoneName(raw)) || null);
  const covers = (roles) => REQUIRED_ROLES.every((r) => roles[r]);
  if (roleMap) {
    const roles = Object.fromEntries(Object.entries(roleMap).map(([r, n]) => [r, given(n)]).filter(([, n]) => n));
    return covers(roles) ? finish('role map', roles, 'role map') : null;
  }
  const ext = rolesFromVrmExtension(gltfJson);
  if (ext) {
    const roles = Object.fromEntries(Object.entries(ext).map(([r, n]) => [r, given(n)]).filter(([, n]) => n));
    if (covers(roles)) return finish('vrm', roles, 'vrm extension');
  }
  const stripped = new Map(names.map((n) => [n.replace(MIXAMO_PREFIX, ''), n]));
  let best = null;
  for (const [structure, table] of Object.entries(ROLE_TABLES)) {
    const look = structure === 'mixamo' ? (n) => stripped.get(n) || null : (n) => (have.has(n) ? n : null);
    const roles = {};
    for (const [role, bone] of Object.entries(table)) { const b = look(bone); if (b) roles[role] = b; }
    if (!covers(roles)) continue;
    const score = Object.keys(roles).length;
    if (!best || score > best.score) best = { score, structure, roles };
  }
  return best ? finish(best.structure, best.roles, `table:${best.structure}`) : null;
}

// The lab's equipment record names attachment points with VRM's normalized humanoid bone names
// (code/src/equipment-foundation.js, VRM_ATTACHMENT_POINTS). All twenty exist on ActionForge's skeleton.
export const VRM_TO_ACTIONFORGE = {
  hips: 'pelvis', spine: 'spine_01', chest: 'spine_02', upperChest: 'spine_03', neck: 'neck_01', head: 'Head',
  leftShoulder: 'clavicle_l', leftUpperArm: 'upperarm_l', leftLowerArm: 'lowerarm_l', leftHand: 'hand_l',
  rightShoulder: 'clavicle_r', rightUpperArm: 'upperarm_r', rightLowerArm: 'lowerarm_r', rightHand: 'hand_r',
  leftUpperLeg: 'thigh_l', leftLowerLeg: 'calf_l', leftFoot: 'foot_l',
  rightUpperLeg: 'thigh_r', rightLowerLeg: 'calf_r', rightFoot: 'foot_r',
};
export const ACTIONFORGE_TO_VRM = Object.fromEntries(Object.entries(VRM_TO_ACTIONFORGE).map(([v, a]) => [a, v]));
