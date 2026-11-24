// node-context.mjs: Node helpers for the tools: load a GLB, and read a clip pack, the rig its clips were made on and an
// item catalog, each named by the caller (--source-rig, --pack, --items). Offline tools only; the page loads these its own way.

import { readFileSync } from 'node:fs';
import path from 'node:path';
globalThis.self ??= globalThis; // GLTFLoader in Node: textures cannot load and are not needed here
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { detectRig } from '../public/process/rig/roles.mjs';
import { wrapFit, describeRig } from '../public/process/rig/rig.mjs';
import { makeInPlace } from './in-place.mjs';

const warn = console.warn;
console.warn = (...a) => { if (!String(a[0]).includes("Couldn't load texture")) warn(...a); };

export function readGlbJson(bytes) {
  return JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString());
}

export async function loadGlbScene(file) {
  const bytes = readFileSync(file);
  const g = await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
  return { scene: g.scene, animations: g.animations, json: readGlbJson(bytes), bytes };
}

export async function sourceRigFrom(file) {
  const { scene, json } = await loadGlbScene(file);
  const names = [];
  scene.traverse((o) => { if (o.isBone) names.push(o.name); });
  const rig = detectRig(names, { gltfJson: json });
  const { fit } = wrapFit(scene, rig.roles);
  return { rig: describeRig(fit, rig.roles, { structure: rig.structure }), fit };
}

export function catalogGrips(catalog) {
  const seen = new Map();
  const add = (clip, time, hand, stance = null) => {
    const key = `${clip}@${time}/${hand}`, grip = seen.get(key) ?? { clip, time, hand, stances: [] };
    if (stance && !grip.stances.includes(stance)) grip.stances.push(stance);
    seen.set(key, grip);
  };
  for (const it of catalog.items) {
    // Hollows are for items held in the fist; an item held against the palm (the box) has no use for one.
    if (it.mode !== 'held' || it.placement?.contact_on_hand === 'palm') continue;
    if (it.hand) add(it.grip.clip, it.grip.time, it.hand, it.stance);
    for (const side of Object.keys(it.contacts || {})) add(it.grip.clip, it.grip.time, side, it.stance);
  }
  add('sword_idle', 0, 'r');
  add('idle_shield_loop', 0, 'l');
  return [...seen.values()];
}

// sourceRig: the GLB of the rig the clips were made on; pack: the clip pack GLB; items: the item catalog (items.json).
export async function packContext({ sourceRig: sourceRigFile, pack, items }) {
  for (const [k, v] of Object.entries({ 'source-rig': sourceRigFile, pack, items })) if (!v) throw new Error(`--${k} <file> is needed`);
  const { rig: sourceRig, fit: sourceFit } = await sourceRigFrom(path.resolve(sourceRigFile));
  const { animations, json } = await loadGlbScene(path.resolve(pack));
  const packClips = Object.fromEntries(animations.map((a) => [a.name, makeInPlace(a)]));
  const catalog = JSON.parse(readFileSync(path.resolve(items), 'utf8'));
  return { sourceRig, sourceFit, packClips, catalog, grips: catalogGrips(catalog), packExtras: json.asset?.extras };
}
