// measure-body.mjs: write a rigged GLB's body details.
//   node runtime/scene-core/tools/measure-body.mjs --glb <file.glb> --id <name> --out <file.body.json>
//        --source-rig <rig.glb> --pack <clips.glb> --items <items.json> [--height <m>] [--roles <map.json>]
//        [--scale <n>] [--facing-yaw <rad>] [--eye-y <m> --eye-source <text>]
//   The avatars build's --update mode is not here: it reads the avatar runtime's clip-library.mjs, which a tool beside the
//   engine does not import.
// --eye-y declares face.eye_y_m (metres above the head joint) for a body whose mesh has no eyeball pair to measure; the
// declaration and its source are recorded in face.eye_source. A measured eye height is kept unless --eye-y is given.
// The clips come from --pack, the grip poses from the item catalog --items, the clips' own rig from --source-rig.
// A file's bytes are only read.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { loadGlbScene, packContext } from './node-context.mjs';
import { measureBody } from '../public/process/body/body-details.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const declaredEye = (face) => {
  if (arg('eye-y') === undefined) return face;
  const eye_y_m = Number(arg('eye-y'));
  if (!Number.isFinite(eye_y_m)) throw new Error('--eye-y needs metres');
  return { eye_y_m, eye_source: `declared: ${arg('eye-source', 'no source given')}`, ...(face ? { measured_eye_y_m: face.eye_y_m } : {}) };
};

const glb = path.resolve(arg('glb'));
const id = arg('id');
const out = path.resolve(arg('out'));
const roleMap = arg('roles') ? JSON.parse(readFileSync(path.resolve(arg('roles')), 'utf8')) : null;
const { sourceRig, packClips, grips } = await packContext({ sourceRig: arg('source-rig'), pack: arg('pack'), items: arg('items') });
const { scene, json, bytes } = await loadGlbScene(glb);
const t0 = Date.now();
const body = measureBody({
  id, scene, gltfJson: json, roleMap, height: Number(arg('height', '1.75')),
  sourceRig, packClips, grips,
  scale: arg('scale') ? Number(arg('scale')) : null,
  facingYaw: arg('facing-yaw') ? Number(arg('facing-yaw')) : null,
});
body.face = declaredEye(body.face);
body.source = { file: path.basename(glb), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
body.measured_at = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
body.generator = 'fitting/tools/measure-body.mjs';
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(body, null, 1) + '\n');
const m = body.measures;
console.log(`${id}: ${body.rig.structure} (${body.rig.role_source}), ${body.rig.bones} bones, rest ${body.rig.rest_pose_kind}, height ${m.height_m} m, hips ${m.hips_height_m} m, ${Date.now() - t0} ms`);
for (const s of ['l', 'r']) {
  const h = body.hands[s];
  console.log(`  hand ${s}: ${h.triangles} triangles, ` + Object.entries(h.hollows).map(([k, v]) => `${k} r=${v.radius_m} enc=${v.enclosure} ${v.method}`).join('; '));
}
console.log(`wrote ${out}`);
