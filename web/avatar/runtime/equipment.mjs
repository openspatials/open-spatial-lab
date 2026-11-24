// equipment.mjs: items in the hands, on the head, the face and the back, with the item's stance on the upper body and its
// grip on the holding hand. The item is a child of a bone; the stance and the grip are AnimationActions in the avatar's one
// AnimationMixer (web/avatar/avatar-motion.mjs blends them). Nothing here writes a bone; a two-handed item hands its
// contact points to the solver reach-hands (fitting/solvers.mjs). Every bone is reached through the body's roles, so
// any rig structure works. Where an item sits comes from the engine's item placement processor
// (runtime/scene-core/public/process/items/placement.mjs and holds.mjs), found beside the Scene Manager through
// import.meta.resolve("#scene-manager"); this file loads the items and drives the motion, and re-exports every placement name.
//
// Public API
//   GROUPS, groupOf, subClip, splitClip, canEquip, canHold, refusalOf, attachmentDefinition, gripPose, resolveItem, faceFit,
//   heldPlacement, SLOTS, slotOf, itemRecord, headVolume
//                                     item placement, re-exported from process/items/placement.mjs (its header says what
//                                     each does)
//   STANCE_FADE_S                     re-exported from fitting/solvers.mjs
//   loadItemLibrary({ readBytes, readJson, url, assetBase })
//                                     the catalog (assets/items/items.json) and every item's GLB, loaded once
//   holdingHandOf(library, clipName)  which hand a stance clip holds with, measured from the clip (see below)
//   overlaysFor(library, item)        the stance and grip overlay clips of a held item
//   class Equipment(instance, library, items, motion)
//     take(itemId), drop(itemId?)     local visitor; an item replaces the one in its own slot only, so a head item, glasses
//                                     and a backpack are worn together with a held item. take() and applyRecords() refuse
//                                     an item refusalOf() names a reason for, keep what is already held and worn, and set
//                                     equipment.refusal { item, reason } for the page; the next item taken clears it
//     applyRecords(records)           another visitor: make the equipped items match a snapshot's records
//     records()                       the portal records of what is equipped (sent in every snapshot)
//     held, worn, face, back          { item, node, record } or null (worn: the head slot)
//     wearing                         the worn slots' entries in use, head first
//
// Holding hand from the clip: the hand whose arm moves most from idle_loop (hand and elbow, in the pelvis frame), among
// the hands that stay closed (finger turn from rest at least half of idle_loop's fist). Both hands open: two-handed.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { sideName, fingerRoles, EQUIPMENT_SITES } from './fitting/roles.mjs';
import { STANCE_FADE_S } from './fitting/solvers.mjs';

const placementFile = "../process/items/placement.mjs";
export const { GROUPS, groupOf, subClip, splitClip, canEquip, canHold, refusalOf, attachmentDefinition, gripPose, resolveItem, faceFit, heldPlacement, SLOTS, slotOf, itemRecord, headVolume } = await import(new URL(placementFile, import.meta.resolve("#scene-manager")).href);
const WORN_KEYS = SLOTS.slice(1);

export { STANCE_FADE_S };

function near(base, file) {
  return decodeURIComponent(new URL(file, new URL(base, 'file:///')).pathname);
}

export async function loadItemLibrary({ readBytes, readJson, url, assetBase }) {
  const catalog = await readJson(url);
  const derived = await readJson(near(url, 'catalog-attachments.json'));
  const production = derived.entries.map((entry) => {
    const item = catalog.items.find((it) => it.file === entry.file);
    if (!item || JSON.stringify(entry.attachment) !== JSON.stringify(attachmentDefinition(item))) {
      throw new Error(`catalog attachment missing or stale: ${entry.key}`);
    }
    item.catalog = { key: entry.key, url: entry.url, sha256: entry.asset_sha256 };
    return item.id;
  });
  if (new Set(production).size !== production.length) throw new Error('duplicate catalog equipment');
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
  const keys = production.map((id, i) => ({ key: String(i + 1), items: [id] }));
  keys.push({ key: '0', items: [], note: 'drops everything' });
  return { catalog, production, source: derived.source, items: new Map(catalog.items.map((i) => [i.id, i])), keys, templates, url, assetUri: (it) => new URL(it.file, base).href };
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
    for (const slot of WORN_KEYS) this[slot] = null; // worn (the head), face, back
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

  // The worn slots' entries in use, head first.
  get wearing() {
    return WORN_KEYS.map((slot) => this[slot]).filter(Boolean);
  }

  _put(item, record) {
    const slot = slotOf(item);
    if (this[slot]?.item.id === item.id) return;
    this._detach(slot);
    this[slot] = this._attach(item, record);
    if (slot === 'held') this._setOverlays();
  }

  take(itemId) {
    if (!this.enabled) return false;
    const item = resolveItem(this.library, this.items.items.get(itemId));
    if (!item || this._refused(item)) return false;
    this._put(item, itemRecord(this.library, this.items, item));
    return true;
  }

  drop(itemId = null) {
    for (const slot of SLOTS) {
      if (this[slot] && (!itemId || this[slot].item.id === itemId)) {
        this._detach(slot);
        if (slot === 'held') this._setOverlays();
      }
    }
  }

  records() {
    return SLOTS.map((slot) => this[slot]).filter(Boolean).map((x) => x.record);
  }

  // Read only after VisitorAvatar.step/RemoteVisitor.step. Plain evaluated data for the Lab-owned pose bridge;
  // no animation advance, renderer object, rest-pose offset, or format-specific second fit escapes this boundary.
  attachmentPoses() {
    const inverse = this.instance.holder.matrixWorld.clone().invert();
    return SLOTS.map((slot) => this[slot]).filter(Boolean).map(({ item, node, bone, record }) => ({
      itemId: item.id, catalogKey: item.catalog?.key ?? null, assetUri: record.assetUri,
      role: record.attachmentPoint, bone: bone.name,
      frame: 'avatar-holder', units: 'metres', matrixOrder: 'column-major',
      itemMatrix: inverse.clone().multiply(node.matrixWorld).toArray(),
      parentMatrix: inverse.clone().multiply(bone.matrixWorld).toArray(),
      hanimSite: item.catalog ? { ...EQUIPMENT_SITES[record.attachmentPoint] } : null,
    }));
  }

  // Another visitor's snapshot: every snapshot carries the whole equipped list, so a lost snapshot only delays a
  // change until the next one arrives. A snapshot without the field (an older sender) changes nothing.
  applyRecords(records) {
    if (!this.enabled || !Array.isArray(records)) return;
    // A record's slot comes from its item; a worn record of an item this catalog does not have counts as the head slot's
    // (kept as it was, as before the face and back slots).
    const slotOfRecord = (r) => { const it = this.items.items.get(r.itemId); return it ? slotOf(it) : r.mode === 'worn' ? 'worn' : 'held'; };
    for (const slot of SLOTS) {
      const want = records.find((r) => slotOfRecord(r) === slot);
      if (!want) { if (this[slot]) { this._detach(slot); if (slot === 'held') this._setOverlays(); } continue; }
      const item = resolveItem(this.library, this.items.items.get(want.itemId));
      if (!item || this._refused(item)) continue; // an item this page does not know, or this body cannot hold, is skipped
      if (this[slot]?.item.id === item.id) continue;
      this._put(item, want);
    }
  }
}
