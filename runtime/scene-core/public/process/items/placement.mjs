// placement.mjs: where a held, carried or worn item sits on a body, as a record the avatar runtime attaches. The item
// placement processor (docs/engine/PROCESSOR-CONTRACT-V0.md section 3): it reads the body's details (body.json), the item's
// details (items.json) and the avatar's rest mesh and clips through the library the runtime loaded, and returns plain data
// (matrices, records, refusal reasons). It draws nothing, loads nothing and drives no bone: loading (loadItemLibrary), the
// stance and grip overlays (overlaysFor) and the Equipment class stay in the avatar runtime (web/avatar/runtime/equipment.mjs),
// which re-exports every name here. The matrices come from holds.mjs.
//
// Public API
//   GROUPS, groupOf(trackName, roles) track groups: lower (legs, hips, spine, chest, root), upper (upperChest, neck,
//                                     head, shoulders, upper and lower arms, hands), fingers_l, fingers_r. roles: the
//                                     body's role map (ActionForge's names when left out)
//   subClip(clip, groups, name, roles) the clip's tracks in those groups
//   splitClip(clip, roles)            { lower, upper, fingers_l, fingers_r } sub-clips
//   canEquip(library)                 true for an avatar with body details, prepared with the clip pack
//   canHold(library, itemId)          false for an item kind the avatar's prepared file lists under equipment.cannot_hold
//   refusalOf(library, item)          why this body cannot hold or wear this item, or null (contract RB.10): 'not for this
//                                     avatar', 'no placement', 'no anchor bone', 'out of reach'; a face item also 'no eye
//                                     height' (the body has no face.eye_y_m) and 'face too wide' (faceFit's scale_x above
//                                     placement.face.max_scale_x)
//   attachmentDefinition(item)        the item's catalog attachment (osl-equipment-attachment/1), from its measured fit
//   gripPose(library, grip)           { bone: Quaternion } of the holding hand's finger keys at grip.time in grip.clip
//   resolveItem(library, item)        the item as this body wears it: a face item (placement.rule 'face') gets face_fit
//                                     from faceFit; any other item is returned as it is
//   faceFit(library, item)            a face item on this body: { eye_y_m, eye_source, origin_z_m, scale_x, arm_half_m,
//                                     under_meshes } from body.face and rays on the rest mesh (head joint frame, the
//                                     avatar's axes); eye_y_m null when the body has no eye height
//   heldPlacement(library, item)      { matrix (item root local to the hand bone, or to the anchor bone for a carried
//                                     item), centre (the hollow in the hand bone's units; null when carried), axes, pose }
//   SLOTS, slotOf(item)               'held', and one slot per worn place: 'worn' (head; the name the checks and the page
//                                     read), 'face', 'back' (holds.mjs wornSlot)
//   itemRecord(library, items, item)  the portal record: { itemId, assetUri, mode, attachmentPoint, localTransform }; a face
//                                     item must be resolved first (resolveItem)
//   headVolume(library)               box around the head's mesh vertices, in the head bone's frame (proof check E5)
//
// library: what the runtime's loadAvatarLibrary returns ({ body, data, clips, packClip, template, sourceBody }); items: what
// its loadItemLibrary returns. Results are cached per library.
//
// Placement of a held item: its contact point goes to the hollow of the closed hand, measured from the hand's mesh in that
// item's grip pose (body.hands[side].hollows); its grip axis along the knuckle line (little finger to index) and its
// forward axis along the hand. A carried item (two hands) sits on its anchor bone, placed by body measures, and both
// hands are driven onto its contact points. A worn item is placed on its anchor by the body's measures and scales
// with the head; a face item sits at the eye height in front of the face, a back item behind the back's skin (holds.mjs).
//
// No DOM use: browser and Node.

import * as THREE from 'three';
import { fitHold, fitWorn, fitCarried, fitContacts, carryFrame, carryAnchor, bodyOffset, hollowInBone, gripKey, reachRefusal, backAnchor, wornSlot } from './holds.mjs';
import { ROLE_TABLES, SIDES, sideName, fingerRoles, EQUIPMENT_SITES } from '../rig/roles.mjs';
import { trianglesOf, rayHits } from '../mesh/mesh-math.mjs';

export const GROUPS = ['lower', 'upper', 'fingers_l', 'fingers_r'];
const UPPER_ROLES = ['upperChest', 'neck', 'head', ...SIDES.flatMap((s) => ['Shoulder', 'UpperArm', 'LowerArm', 'Hand'].map((j) => sideName(s) + j))];

// Bone name -> group, once per role map.
const groupMaps = new WeakMap();
function groupMap(roles) {
  if (!groupMaps.has(roles)) {
    const m = new Map();
    for (const r of UPPER_ROLES) if (roles[r]) m.set(roles[r], 'upper');
    for (const s of SIDES) for (const r of fingerRoles(s)) if (roles[r]) m.set(roles[r], `fingers_${s}`);
    groupMaps.set(roles, m);
  }
  return groupMaps.get(roles);
}

export function groupOf(trackName, roles = ROLE_TABLES.actionforge) {
  return groupMap(roles).get(trackName.slice(0, trackName.lastIndexOf('.'))) || 'lower';
}

export function subClip(clip, groups, name = clip.name, roles = ROLE_TABLES.actionforge) {
  const keep = new Set(groups);
  return new THREE.AnimationClip(name, clip.duration, clip.tracks.filter((t) => keep.has(groupOf(t.name, roles))).map((t) => t.clone()));
}

export function splitClip(clip, roles = ROLE_TABLES.actionforge) {
  return Object.fromEntries(GROUPS.map((g) => [g, subClip(clip, [g], g === 'lower' ? clip.name : `${g}:${clip.name}`, roles)]));
}

export function canEquip(library) {
  return !!(library?.data?.clip_pack && library.body && typeof library.packClip === 'function');
}

export function canHold(library, itemId) {
  const no = library?.data?.equipment?.cannot_hold;
  return !(Array.isArray(no) && no.includes(itemId));
}

export function refusalOf(library, item) {
  if (!canHold(library, item.id)) return 'not for this avatar';
  if (item.hands === 2 && (!item.contacts || !item.placement)) return 'no placement';
  if (!library.body.roles[attachRole(library, item)]) return 'no anchor bone';
  if (item.placement?.rule === 'face') {
    const fit = resolveItem(library, item).face_fit;
    if (!Number.isFinite(fit.eye_y_m)) return 'no eye height';
    if (!(fit.scale_x <= (item.placement.face.max_scale_x ?? Infinity))) return 'face too wide';
  }
  return item.hands === 2 ? reachRefusal(heldPlacement(library, item)) : null;
}

// One attachment definition, derived from the existing measured fit. The catalog merge tool and loader use this
// same function; generated catalog data cannot silently replace the evaluator's grip or body-relative placement.
export function attachmentDefinition(item) {
  const role = item.mode === 'worn' ? item.placement?.anchor : `${sideName(item.hand)}Hand`;
  const site = EQUIPMENT_SITES[role];
  if (!site || !item.placement || (item.mode === 'held' &&
    (!['l', 'r'].includes(item.hand) || item.hands !== 1 || !item.contacts?.[item.hand] || !item.grip?.clip || !item.stance))) {
    throw new Error(`item ${item.id}: missing or incompatible attachment`);
  }
  const fields = ['mode', 'hands', 'hand', 'stance', 'grip', 'contacts', 'placement', 'scale', 'scale_m_per_unit'];
  return {
    schema: 'osl-equipment-attachment/1',
    glb: { role, bone_lookup: 'body.roles', reference_rig: 'actionforge', reference_bone: ROLE_TABLES.actionforge[role] },
    vrm: { humanoid_bone: role },
    hanim: { ...site, standard: 'ISO/IEC 19774-1:2019', project_defined_site: true,
      transform: 'inverse(parent_segment_in_avatar) * item_in_avatar', child_transform: 'identity' },
    fit: Object.fromEntries(fields.filter(k => item[k] !== undefined).map(k => [k, item[k]])),
    evaluated_pose: { frame: 'avatar-holder', units: 'metres', matrix: 'column-major-4x4', update: 'after existing avatar step' },
  };
}

// ---------- Measurements on the avatar's own rest skeleton (library.template is never animated) ----------
function templateBones(library) {
  if (!library._bones) {
    const b = {};
    library.template.traverse((o) => { if (o.name && (!b[o.name] || (o.isBone && !b[o.name].isBone))) b[o.name] = o; });
    library.template.updateMatrixWorld(true);
    library._bones = b;
  }
  return library._bones;
}

export function gripPose(library, grip) {
  const clip = library.packClip(grip.clip);
  if (!clip) throw new Error(`grip clip ${grip.clip} not in the clip pack`);
  const out = {};
  for (const tr of clip.tracks) {
    const bone = tr.name.slice(0, tr.name.lastIndexOf('.'));
    if (groupOf(tr.name, library.body.roles) !== `fingers_${grip.hand}` || !tr.name.endsWith('.quaternion')) continue;
    const v = tr.createInterpolant().evaluate(grip.time);
    out[bone] = new THREE.Quaternion(v[0], v[1], v[2], v[3]).normalize();
  }
  return out;
}

// A face item (placement.rule 'face') as this body wears it: the item with face_fit from faceFit, once per library. Every
// other item is returned as it is.
const resolved = new WeakMap();
export function resolveItem(library, item) {
  if (item?.placement?.rule === 'face' && !item.face_fit) {
    if (!resolved.has(library)) resolved.set(library, new Map());
    const cache = resolved.get(library);
    if (!cache.has(item)) cache.set(item, { ...item, face_fit: faceFit(library, item) });
    return cache.get(item);
  }
  return item;
}

// Every skinned triangle of the rest mesh, in the avatar frame (the template's world frame is the body's).
// Also per skinned mesh (meshes: [{ name, tris }]).
function restTriangles(library) {
  if (!library._restTris) {
    library.template.updateMatrixWorld(true);
    const sets = [];
    library.template.traverse((o) => { if (o.isSkinnedMesh) sets.push({ mesh: o, keep: new Uint8Array(o.geometry.attributes.position.count).fill(1) }); });
    library._restTris = trianglesOf(sets, new THREE.Matrix4());
    library._restMeshTris = sets.map((set) => ({ name: set.mesh.name, tris: trianglesOf([set], new THREE.Matrix4()) }));
  }
  return library._restTris;
}

// Rule "face" of the airport items review (2026-11-17), measured on the rest mesh in the head joint's frame (the avatar's
// axes). placement.face: { clearance_m, frame: [[x_from, x_to, y_low, y_high, rear_z], ...] (the frame's rear surface in
// bands across half its width, item units, from the GLB), arm: { inner_half_m, y: [low, high], z: [front, back] },
// max_scale_x }. The origin goes to body.face.eye_y_m; it moves forward until every band's rear surface is clearance_m ahead
// of the most forward skin behind it (any mesh); the item is scaled across (x) until its temple arms' inner faces are
// clearance_m outside the head's sides all along the arms' path (scale_x at least 1). Both depend on each other, so they are
// found together. The sides are every mesh's; when that needs more than max_scale_x, only the face's own mesh's (the mesh in
// front at the lens centres): a separate hair mesh (Elizabeth's) then lies over the arms, and under_meshes names it.
export function faceFit(library, item) {
  const { body } = library, face = item.placement.face, eye = body.face?.eye_y_m;
  if (!Number.isFinite(eye)) return { eye_y_m: null, origin_z_m: null, scale_x: null, eye_source: null };
  const tris = restTriangles(library);
  const hp = body.rest_pose[body.roles[item.placement.anchor]].position_m;
  const frontOf = (t, x, y) => { const h = rayHits([hp[0] + x, hp[1] + y, hp[2] + 2], [0, 0, -1], t); return Number.isFinite(h.nearest) ? 2 - h.nearest : -Infinity; };
  const STEP = 0.0025, SIDE_STEP = 0.0015;
  const solve = (sideTris) => {
    const side = (y, z, s) => { const h = rayHits([hp[0] + s * 2, hp[1] + y, hp[2] + z], [-s, 0, 0], sideTris); return Number.isFinite(h.nearest) ? 2 - h.nearest : 0; };
    let sx = 1, origin = 0, half = 0;
    for (let it = 0; it < 6; it++) {
      origin = -Infinity;
      for (const [x0, x1, y0, y1, rear] of face.frame) {
        for (let x = x0 * sx; x <= x1 * sx + 1e-9; x += STEP) for (let y = eye + y0; y <= eye + y1 + 1e-9; y += STEP) {
          for (const k of [1, -1]) origin = Math.max(origin, frontOf(tris, k * x, y) + face.clearance_m - rear);
        }
      }
      half = 0;
      for (let y = eye + face.arm.y[0]; y <= eye + face.arm.y[1] + 1e-9; y += SIDE_STEP) {
        for (let z = origin + face.arm.z[0]; z >= origin + face.arm.z[1] - 1e-9; z -= SIDE_STEP) half = Math.max(half, side(y, z, 1), side(y, z, -1));
      }
      const next = Math.max(1, (half + face.clearance_m) / face.arm.inner_half_m);
      if (Math.abs(next - sx) < 1e-4) { sx = next; break; }
      sx = next;
    }
    return { sx, origin, half };
  };
  let got = solve(tris), under = [];
  if (got.sx > (face.max_scale_x ?? Infinity)) {
    const own = new Set([0.033, -0.033].map((x) => library._restMeshTris.reduce((a, m) => (frontOf(m.tris, x, eye) > frontOf(a.tris, x, eye) ? m : a))));
    got = solve([...own].flatMap((m) => m.tris));
    under = library._restMeshTris.filter((m) => !own.has(m)).map((m) => m.name);
  }
  const r4 = (v) => Math.round(v * 1e4) / 1e4;
  return { eye_y_m: eye, eye_source: body.face.eye_source, origin_z_m: r4(got.origin), scale_x: r4(got.sx), arm_half_m: r4(got.half), under_meshes: under };
}

const placements = new WeakMap();
export function heldPlacement(library, item) {
  if (!placements.has(library)) placements.set(library, new Map());
  const cache = placements.get(library);
  if (cache.has(item.id)) return cache.get(item.id);
  const { body } = library;
  const side = item.hand;
  const pose = gripPose(library, { ...item.grip, hand: side });
  let out;
  if (item.hands === 2) {
    // The upper body follows the stance alone; the lower body follows locomotion, standing as the idle clip does. The item's
    // place and the contact points this body's arms can reach come from those poses.
    const stance = library.packClip(item.stance);
    const sampler = (clip) => new Map(clip.tracks.filter((t) => !t.name.endsWith('.scale')).map((t) => [t.name, t.createInterpolant()]));
    const upper = sampler(subClip(stance, ['upper'], 'upper', body.roles));
    const lower = sampler(library.clips.idle);
    const read = (map, name, t) => { const f = map.get(name); return f ? Array.from(f.evaluate(t)) : null; };
    const localAt = (bone, t, lowerPose = lower, lowerTime = 0) => {
      const q = read(upper, `${bone}.quaternion`, t) || read(lowerPose, `${bone}.quaternion`, lowerTime);
      const p = read(lowerPose, `${bone}.position`, lowerTime);
      return { q: q && new THREE.Quaternion().fromArray(q).normalize(), p: p && new THREE.Vector3().fromArray(p) };
    };
    const times = Array.from({ length: 24 }, (_, i) => (i / 24) * stance.duration);
    let frame = carryFrame(body, item, times.map((t) => (bone) => localAt(bone, t)));
    // The lower spine keeps locomotion, including jump bends. Check contact clearance across those poses as well as
    // the item's stance; an idle-only fit can put a wrist through the hips-aligned torso union in the air.
    const clearancePoses = Object.values(library.clips).flatMap((clip) => {
      const lowerPose = sampler(clip);
      return times.flatMap((t) => Array.from({ length: 24 }, (_, i) => (bone) => localAt(bone, t, lowerPose, i * clip.duration / 24)));
    });
    let fit = fitContacts(body, item, (bone, t) => localAt(bone, t).q, times, frame, clearancePoses);
    // A low carrying height can make a wide torso unreachable even when the same box fits higher. Before refusing,
    // try heights up to the named anchor, keeping the box's size, forward clearance, contact and reach constraints.
    if (fit.reach_beyond_m > 0) {
      const maxRise = Math.max(0, -bodyOffset(body, item.placement.offset).y);
      for (let i = 1; i <= 12 && maxRise > 0; i++) {
        const raised = { ...frame, rise_m: maxRise * i / 12 };
        const candidate = fitContacts(body, item, (bone, t) => localAt(bone, t).q, times, raised, clearancePoses);
        if (candidate.reach_beyond_m <= 0 && candidate.wrists_clear) { frame = raised; fit = candidate; break; }
      }
    }
    out = { matrix: fitCarried(body, item, frame), centre: null, axes: null, pose, rise_m: frame.rise_m ?? 0, ...fit };
  } else {
    // An item whose grip pose has no measured hollow (a new item, before the bodies are measured again) sits in the hand's
    // default fist; the proof's hollow check refuses it.
    const known = !!body.hands[side].hollows[gripKey(item.grip)];
    const grip = known ? item.grip : { clip: body.hands[side].hollow.grip.split('@')[0], time: Number(body.hands[side].hollow.grip.split('@')[1]) };
    const held = { ...item, grip };
    const hand = body.hands[side].grip_frame;
    out = {
      matrix: fitHold(body, held, side),
      centre: hollowInBone(body, side, grip),
      axes: { a: new THREE.Vector3().fromArray(hand.knuckle_axis), f: new THREE.Vector3().fromArray(hand.forward_axis) },
      pose,
    };
  }
  cache.set(item.id, out);
  return out;
}

const decompose = (m) => {
  const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  m.decompose(p, q, s);
  const r = (x) => Math.round(x * 1e6) / 1e6;
  return { position: p.toArray().map(r), quaternion: q.toArray().map(r), scale: s.toArray().map(r) };
};

// The role an item hangs from: the lab's attachment point names are the same VRM names.
const attachRole = (library, item) => (item.mode === 'worn' ? (item.placement.anchor === 'back' ? backAnchor(library.body) : item.placement.anchor)
  : item.hands === 2 ? carryAnchor(library.body, item) : `${sideName(item.hand)}Hand`);

// Slots: one held item, and one worn item per worn place (the head slot keeps its old name 'worn').
export const SLOTS = ['held', 'worn', 'face', 'back'];
export const slotOf = (item) => (item.mode !== 'worn' ? 'held' : { head: 'worn', face: 'face', back: 'back' }[wornSlot(item)]);
export function itemRecord(library, items, item) {
  const m = item.mode === 'worn' ? fitWorn(library.body, library.sourceBody || library.body, item) : heldPlacement(library, item).matrix;
  return { itemId: item.id, assetUri: items.assetUri(item), mode: item.mode, attachmentPoint: attachRole(library, item), localTransform: decompose(m),
    ...(item.catalog ? { catalogKey: item.catalog.key } : {}) };
}

// Box around the vertices whose strongest skin weight is on the head bone, in that bone's rest frame.
export function headVolume(library) {
  const B = templateBones(library);
  const headName = library.body.roles.head;
  const head = B[headName];
  const inv = new THREE.Matrix4().copy(head.matrixWorld).invert();
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  let n = 0;
  library.template.traverse((o) => {
    if (!o.isSkinnedMesh) return;
    const idx = o.geometry.attributes.skinIndex, wt = o.geometry.attributes.skinWeight;
    const names = o.skeleton.bones.map((b) => b.name);
    for (let i = 0; i < idx.count; i++) {
      let best = 0, bone = -1;
      for (let k = 0; k < 4; k++) { const w = wt.getComponent(i, k); if (w > best) { best = w; bone = idx.getComponent(i, k); } }
      if (names[bone] !== headName) continue;
      o.getVertexPosition(i, v);
      box.expandByPoint(v.applyMatrix4(o.matrixWorld).applyMatrix4(inv));
      n++;
    }
  });
  return { box, vertices: n };
}
