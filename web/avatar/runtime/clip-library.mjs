// clip-library.mjs: load a prepared avatar (its GLB, its clips and its measurements) and make the loops play in place.
//
// Public API
//   CLIP_SET                         slot name -> clip name
//   makeInPlace(clip)                copy of the clip without the root's forward track and the scale tracks
//   pelvisScaleOf(data)              hips height of the avatar over the clip pack's reference hips height (1 without a pack)
//   prepareClip(src, name, { hips, pelvisScale })  in place, hips position track scaled
//   loadAvatarLibrary({ readBytes, readJson, url })
//       url: the avatar's prepared file (<id>.avatar.json, written once by tools/prepare-avatar.mjs).
//       readBytes(url) -> Promise<ArrayBuffer>, readJson(url) -> Promise<object>; the page (fetch) and Node
//       (readFile) load the same way. Bone names are used as they are (one skeleton family, web/avatar/skeleton.mjs); the
//       avatar is turned and scaled as prepared; each slot's clip comes from the file the preparation names.
//       Returns { id, template, clips, clipSource, data, packClip(name), body, sourceBody, rigMap }. Throws if a slot has no
//       clip. body: the avatar's body details (<id>.body.json next to the prepared file), null when it has none (such an
//       avatar plays but cannot equip). sourceBody: the clip pack's body (assets/avatars/mannequin.body.json).
//       A rig of another structure (fitting/map-clips.mjs) has its pack clips mapped through roles and rest poses here,
//       at load; a rig on the pack's own structure plays the keys as they are.
//       Clips from the clip pack (data.clip_pack, assets/clips/actionforge-clips.glb) have their pelvis.position
//       scaled by pelvisScaleOf(data), so a character of other proportions on the same skeleton plays them as they are.
//       packClip(name): any pack clip, prepared the same way (stances for equipping); null without a pack.
//   createAvatarInstance(library)    { holder, model, bones, skinnedMeshes }: holder carries world position and yaw,
//                                    model is the skinned clone (its fixed floor offset is set once, here).
//
// No DOM use: the page and the Node proof load the same way. Clips are played as prepared (decision D11), except that a rig
// of another structure gets them mapped at load, which the level 2 receiver allows.

import * as THREE from '../../vendor/scene-core/vendor/three/three.module.js';
import { GLTFLoader } from '../../vendor-three-examples/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from '../../vendor-three-examples/utils/SkeletonUtils.js';
import { buildRigMap, mapClip } from './fitting/map-clips.mjs';
import { rigFromBody, settleToBindPose } from './fitting/rig.mjs';

export const CLIP_SET = {
  idle: 'idle_loop',
  walk: 'walk_loop',
  jog: 'jog_fwd_loop',
  sprint: 'sprint_loop',
  jumpStart: 'jump_start',
  jumpLoop: 'jump_loop',
  jumpLand: 'jump_land',
};

// The clips move the "root" bone straight forward; the movement code moves the avatar instead, so that track goes.
// Scale tracks hold 1 everywhere. The pelvis tracks (the clip's own hip motion, including vertical) stay.
export function makeInPlace(clip, name = clip.name) {
  const tracks = clip.tracks
    .filter((t) => t.name !== 'root.position' && !t.name.endsWith('.scale'))
    .map((t) => t.clone());
  return new THREE.AnimationClip(name, clip.duration, tracks);
}

// The pack's pelvis.position keys are the mannequin's (hips 0.9015 m above the lower toe). A character on the same
// skeleton with other proportions gets them scaled by its own hips height over that; the mannequin's factor is 1.
export function pelvisScaleOf(data) {
  const p = data?.clip_pack;
  if (!p) return 1;
  if (!(p.avatar_hips_height_m > 0) || !(p.reference_hips_height_m > 0)) throw new Error(`avatar ${data.id}: clip_pack has no hips heights`);
  return p.avatar_hips_height_m / p.reference_hips_height_m;
}

export function prepareClip(src, name, { hips = 'pelvis', pelvisScale = 1 } = {}) {
  const out = makeInPlace(src, name);
  if (pelvisScale !== 1) {
    for (const t of out.tracks) if (t.name === `${hips}.position`) for (let i = 0; i < t.values.length; i++) t.values[i] *= pelvisScale;
  }
  return out;
}

// One pack clip for a body: mapped through roles on a rig of another structure, as it is otherwise.
export function packClipPreparer({ map, hips, pelvisScale }) {
  const mapped = map && !map.identity;
  return (src, name) => (mapped ? mapClip(makeInPlace(src), map, name) : prepareClip(src, name, { hips, pelvisScale }));
}

export function rigMapFor(body, sourceBody) {
  return body && sourceBody ? buildRigMap(rigFromBody(sourceBody), rigFromBody(body)) : null;
}

// A path next to the prepared file. Works for page addresses and for Node file paths.
function near(base, file) {
  return decodeURIComponent(new URL(file, new URL(base, 'file:///')).pathname);
}

export async function loadAvatarLibrary({ readBytes, readJson, url }) {
  const data = await readJson(url);
  const loader = new GLTFLoader();
  const files = new Map();
  const parse = (file) => {
    const full = near(url, file);
    if (!files.has(full)) files.set(full, readBytes(full).then((b) => loader.parseAsync(b, '')));
    return files.get(full);
  };
  const avatarGltf = await parse(data.avatar.file);
  const fit = new THREE.Group();
  fit.name = 'avatar-fit';
  settleToBindPose(avatarGltf.scene); // one rest pose (contract RB.3)
  fit.add(avatarGltf.scene);
  fit.rotation.y = data.avatar.facing_yaw_rad || 0;
  fit.scale.setScalar(data.avatar.scale || 1);
  const pack = data.clip_pack ? await parse(data.clip_pack.file) : null;
  const pelvisScale = pelvisScaleOf(data);
  const hips = data.avatar.hips_bone || 'pelvis';
  const optionalJson = async (full) => { try { return await readJson(full); } catch { return null; } };
  const body = await optionalJson(near(url, `${data.id}.body.json`));
  const sourceBody = data.clip_pack ? await optionalJson(near(near(url, data.clip_pack.file), '../avatars/mannequin.body.json')) : null;
  const rigMap = rigMapFor(body, sourceBody);
  const fromPackClip = packClipPreparer({ map: rigMap, hips, pelvisScale });
  const clips = {};
  for (const slot of Object.keys(CLIP_SET)) {
    const s = data.slots?.[slot];
    if (!s) throw new Error(`avatar ${data.id}: no clip for ${slot}`);
    const g = await parse(s.file);
    const src = g.animations.find((a) => a.name === s.clip);
    if (!src) throw new Error(`avatar ${data.id}: ${s.file} has no clip ${s.clip}`);
    const fromPack = pack && near(url, s.file) === near(url, data.clip_pack.file);
    clips[slot] = fromPack ? fromPackClip(src, slot) : prepareClip(src, slot, { hips, pelvisScale: 1 });
  }
  const packCache = new Map();
  const packClip = (name) => {
    if (!pack) return null;
    if (!packCache.has(name)) {
      const src = pack.animations.find((a) => a.name === name);
      packCache.set(name, src ? fromPackClip(src, name) : null);
    }
    return packCache.get(name);
  };
  return { id: data.id, template: fit, clips, clipSource: data.clip_source, data, pelvisScale, packClip, packClipNames: pack ? pack.animations.map((a) => a.name) : [], body, sourceBody, rigMap };
}

export function createAvatarInstance(library) {
  const model = cloneSkinned(library.template);
  const bones = {};
  const skinnedMeshes = [];
  model.traverse((o) => {
    if (o.isBone) bones[o.name] = o;
    if (o.isSkinnedMesh) {
      skinnedMeshes.push(o);
      o.castShadow = true;
      o.receiveShadow = true;
      o.frustumCulled = false;
    }
  });
  const offset = library.data?.model?.floor_offset_m ?? 0;
  model.position.y = offset;
  const holder = new THREE.Group();
  holder.name = 'avatar';
  holder.add(model);
  return { holder, model, bones, skinnedMeshes };
}

// Node helpers: readBytes and readJson for files on disk.
export function nodeReadBytes(readFileSync) {
  return async (path) => {
    const b = readFileSync(path);
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  };
}

export function nodeReadJson(readFileSync) {
  return async (path) => JSON.parse(readFileSync(path, 'utf8'));
}
