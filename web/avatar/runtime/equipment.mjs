// equipment.mjs: items in the hands and on the head, with the item's stance on the upper body and its grip on the
// holding hand. The item is a child of a bone; the stance and the grip are AnimationActions in the avatar's one
// AnimationMixer (web/avatar/avatar-motion.mjs blends them). Nothing here writes a bone; a two-handed item hands its
// contact points to the solver reach-hands (fitting/solvers.mjs). Every bone is reached through the body's roles, so
// any rig structure works. Item places come from the body's and the item's details (fitting/holds.mjs).
//
// Public API
//   GROUPS, groupOf(trackName, roles) track groups: lower (legs, hips, spine, chest, root), upper (upperChest, neck,
//                                     head, shoulders, upper and lower arms, hands), fingers_l, fingers_r. roles: the
//                                     body's role map (ActionForge's names when left out)
//   subClip(clip, groups, name, roles) the clip's tracks in those groups
//   splitClip(clip, roles)            { lower, upper, fingers_l, fingers_r } sub-clips
//   canEquip(library)                 true for an avatar with body details, prepared with the clip pack
//   canHold(library, itemId)          false for an item kind the avatar's prepared file lists under equipment.cannot_hold;
//                                     take() refuses it
//   refusalOf(library, item)          why this body cannot hold this item, or null (contract RB.10). take() and applyRecords()
//                                     refuse that one item, keep what is already held and worn, and set equipment.refusal
//                                     { item, reason } for the page; the next item taken clears it
//   loadItemLibrary({ readBytes, readJson, url, assetBase })
//                                     the catalog (assets/items/items.json) and every item's GLB, loaded once
//   holdingHandOf(library, clipName)  which hand a stance clip holds with, measured from the clip (see below)
//   gripPose(library, grip)           { bone: Quaternion } of the holding hand's finger keys at grip.time in grip.clip
//   heldPlacement(library, item)      { matrix (item root local to the hand bone, or to the anchor bone for a carried
//                                     item), centre (the hollow in the hand bone's units; null when carried), axes, pose }
//   itemRecord(library, items, item)  the portal record: { itemId, assetUri, mode, attachmentPoint, localTransform }
//   headVolume(library)               box around the head's mesh vertices, in the head bone's frame (proof check E5)
//   class Equipment(instance, library, items, motion)
//     take(itemId), drop(itemId?)     local visitor; a held item replaces the held one, a worn item the worn one
//     applyRecords(records)           another visitor: make the equipped items match a snapshot's records
//     records()                       the portal records of what is equipped (sent in every snapshot)
//     held, worn                      { item, node, record } or null
//
// Placement of a held item: its contact point goes to the hollow of the closed hand, measured from the hand's mesh in that
// item's grip pose (body.hands[side].hollows); its grip axis along the knuckle line (little finger to index) and its
// forward axis along the hand. A carried item (two hands) sits on its anchor bone, placed by body measures, and both
// hands are driven onto its contact points. A worn item is placed on its anchor by the body's measures and scales
// with the head (fitting/holds.mjs).
//
// Holding hand from the clip: the hand whose arm moves most from idle_loop (hand and elbow, in the pelvis frame), among
// the hands that stay closed (finger turn from rest at least half of idle_loop's fist). Both hands open: two-handed.

import * as THREE from '../../vendor/scene-core/vendor/three/three.module.js';
import { GLTFLoader } from '../../vendor-three-examples/loaders/GLTFLoader.js';
import { fitHold, fitWorn, fitCarried, fitContacts, carryFrame, carryAnchor, hollowInBone, gripKey, reachRefusal } from './fitting/holds.mjs';
import { ROLE_TABLES, SIDES, sideName, fingerRoles } from './fitting/roles.mjs';
import { STANCE_FADE_S } from './fitting/solvers.mjs';

export { STANCE_FADE_S };
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
  return item.hands === 2 ? reachRefusal(heldPlacement(library, item)) : null;
}

function near(base, file) {
  return decodeURIComponent(new URL(file, new URL(base, 'file:///')).pathname);
}

export async function loadItemLibrary({ readBytes, readJson, url, assetBase }) {
  const catalog = await readJson(url);
  const loader = new GLTFLoader();
  const templates = new Map();
  for (const it of catalog.items) {
    const g = await loader.parseAsync(await readBytes(near(url, it.file)), '');
    const root = g.scene;
    root.name = `item:${it.id}`;
    root.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    templates.set(it.id, root);
  }
  const base = assetBase || 'http://127.0.0.1:30000/assets/items/';
  return { catalog, items: new Map(catalog.items.map((i) => [i.id, i])), keys: catalog.keys || [], templates, url, assetUri: (it) => new URL(it.file, base).href };
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
    const localAt = (bone, t) => {
      const q = read(upper, `${bone}.quaternion`, t) || read(lower, `${bone}.quaternion`, 0);
      const p = read(lower, `${bone}.position`, 0);
      return { q: q && new THREE.Quaternion().fromArray(q).normalize(), p: p && new THREE.Vector3().fromArray(p) };
    };
    const times = Array.from({ length: 24 }, (_, i) => (i / 24) * stance.duration);
    const frame = carryFrame(body, item, times.map((t) => (bone) => localAt(bone, t)));
    const fit = fitContacts(body, item, (bone, t) => localAt(bone, t).q, times, frame);
    out = { matrix: fitCarried(body, item, frame), centre: null, axes: null, pose, ...fit };
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
const attachRole = (library, item) => (item.mode === 'worn' ? item.placement.anchor : item.hands === 2 ? carryAnchor(library.body, item) : `${sideName(item.hand)}Hand`);

export function itemRecord(library, items, item) {
  const m = item.mode === 'worn' ? fitWorn(library.body, library.sourceBody || library.body, item) : heldPlacement(library, item).matrix;
  return { itemId: item.id, assetUri: items.assetUri(item), mode: item.mode, attachmentPoint: attachRole(library, item), localTransform: decompose(m) };
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

// ---------- Holding hand, measured from the clip ----------
export function holdingHandOf(library, clipName, createInstance) {
  const inst = createInstance(library);
  const mixer = new THREE.AnimationMixer(inst.model);
  const B = inst.bones;
  const roles = library.body.roles;
  const rest = Object.fromEntries(Object.entries(B).map(([k, b]) => [k, b.quaternion.clone()]));
  const fingersOf = (side) => fingerRoles(side).filter((r) => roles[r] && !r.endsWith('Tip')).map((r) => roles[r]);
  const sample = (clip) => {
    const a = mixer.clipAction(clip);
    a.play();
    const out = [];
    for (let i = 0; i < 10; i++) {
      a.time = (i / 10) * clip.duration;
      mixer.update(0);
      inst.holder.updateMatrixWorld(true);
      const s = {};
      for (const side of ['l', 'r']) {
        const loc = (n) => B[roles.hips].worldToLocal(B[n].getWorldPosition(new THREE.Vector3()));
        const N = sideName(side);
        s[side] = { hand: loc(roles[`${N}Hand`]), elbow: loc(roles[`${N}LowerArm`]), curl: fingersOf(side).reduce((acc, n) => acc + B[n].quaternion.angleTo(rest[n]), 0) };
      }
      out.push(s);
    }
    a.stop();
    mixer.uncacheAction(clip);
    return out;
  };
  const idle = sample(library.packClip('idle_loop'));
  const st = sample(library.packClip(clipName));
  const res = {};
  for (const side of ['l', 'r']) {
    res[side] = {
      arm_change_m: st.reduce((acc, x, i) => acc + x[side].hand.distanceTo(idle[i][side].hand) + x[side].elbow.distanceTo(idle[i][side].elbow), 0) / st.length,
      curl_ratio: st.reduce((acc, x) => acc + x[side].curl, 0) / idle.reduce((acc, x) => acc + x[side].curl, 0),
    };
  }
  const closed = ['l', 'r'].filter((s) => res[s].curl_ratio >= 0.5);
  const hand = closed.length === 0 ? 'both' : closed.length === 1 ? closed[0] : (res.l.arm_change_m > res.r.arm_change_m ? 'l' : 'r');
  return { hand, ...res };
}

// ---------- Overlay clips for the motion: the item's stance and its grip ----------
const overlayCache = new WeakMap();
export function overlaysFor(library, item) {
  if (item.mode !== 'held') return [];
  if (!overlayCache.has(library)) overlayCache.set(library, new Map());
  const cache = overlayCache.get(library);
  if (cache.has(item.id)) return cache.get(item.id);
  const free = item.hand === 'r' ? 'l' : 'r';
  const out = [];
  if (item.stance) {
    const clip = library.packClip(item.stance);
    if (!clip) throw new Error(`stance clip ${item.stance} not in the clip pack`);
    out.push({ key: `stance:${item.id}`, kind: 'stance', clip: subClip(clip, ['upper', `fingers_${free}`], `stance:${item.id}`, library.body.roles), covers: ['upper', `fingers_${free}`] });
  }
  const pose = heldPlacement(library, item).pose;
  const tracks = Object.entries(pose).map(([bone, q]) => new THREE.QuaternionKeyframeTrack(`${bone}.quaternion`, [0, 1], [...q.toArray(), ...q.toArray()]));
  out.push({ key: `grip:${item.id}`, kind: 'grip', clip: new THREE.AnimationClip(`grip:${item.id}`, 1, tracks), covers: [`fingers_${item.hand}`] });
  cache.set(item.id, out);
  return out;
}

// ---------- Equipment on one avatar ----------
export class Equipment {
  constructor(instance, library, items, motion, solvers = null) {
    this.instance = instance;
    this.library = library;
    this.items = items;
    this.motion = motion;
    this.solvers = solvers;
    this.enabled = !!items && canEquip(library);
    this.held = null;
    this.worn = null;
    this.refusal = null;
  }

  _refused(item) {
    const reason = refusalOf(this.library, item);
    this.refusal = reason ? { item, reason } : null;
    return !!reason;
  }

  _attach(item, record) {
    const bone = this.instance.bones[this.library.body.roles[record.attachmentPoint]];
    if (!bone) throw new Error(`no bone for ${record.attachmentPoint}`);
    const node = this.items.templates.get(item.id).clone(true);
    const t = record.localTransform;
    node.position.fromArray(t.position);
    node.quaternion.fromArray(t.quaternion);
    node.scale.fromArray(t.scale);
    bone.add(node);
    node.updateMatrixWorld(true);
    return { item, node, bone, record };
  }

  _detach(slot) {
    const cur = this[slot];
    if (!cur) return;
    cur.node.removeFromParent();
    this[slot] = null;
  }

  _setOverlays() {
    this.motion?.setOverlays(this.held ? overlaysFor(this.library, this.held.item) : []);
    const h = this.held;
    this.solvers?.setCarry(h && h.item.hands === 2 ? { item: h.item, node: h.node, contacts: heldPlacement(this.library, h.item).contacts, anchor: h.bone, local: h.node.matrix.clone() } : null);
  }

  _put(item, record) {
    const slot = item.mode === 'worn' ? 'worn' : 'held';
    if (this[slot]?.item.id === item.id) return;
    this._detach(slot);
    this[slot] = this._attach(item, record);
    if (slot === 'held') this._setOverlays();
  }

  take(itemId) {
    if (!this.enabled) return false;
    const item = this.items.items.get(itemId);
    if (!item || this._refused(item)) return false;
    this._put(item, itemRecord(this.library, this.items, item));
    return true;
  }

  drop(itemId = null) {
    for (const slot of ['held', 'worn']) {
      if (this[slot] && (!itemId || this[slot].item.id === itemId)) {
        this._detach(slot);
        if (slot === 'held') this._setOverlays();
      }
    }
  }

  records() {
    return [this.held, this.worn].filter(Boolean).map((x) => x.record);
  }

  // Another visitor's snapshot: every snapshot carries the whole equipped list, so a lost snapshot only delays a
  // change until the next one arrives. A snapshot without the field (an older sender) changes nothing.
  applyRecords(records) {
    if (!this.enabled || !Array.isArray(records)) return;
    for (const slot of ['held', 'worn']) {
      const want = records.find((r) => r.mode === slot);
      if (!want) { if (this[slot]) { this._detach(slot); if (slot === 'held') this._setOverlays(); } continue; }
      const item = this.items.items.get(want.itemId);
      if (!item || this._refused(item)) continue; // an item this page does not know, or this body cannot hold, is skipped
      if (this[slot]?.item.id === item.id) continue;
      this._put(item, want);
    }
  }
}
