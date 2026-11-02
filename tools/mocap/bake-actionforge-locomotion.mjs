// Bakes web/assets/mocap/locomotion-mocap.json from ActionForge's CC0 clip pack, in the same format
// bake-locomotion.mjs writes from 100STYLE, so web/mocap-locomotion.js reads it unchanged.
//
// Usage: node tools/mocap/bake-actionforge-locomotion.mjs <actionforge-clips.glb> [--idle idle_loop] [--walk walk_loop] [--run jog_fwd_loop] [--out <file>]
//
// Why: the 100STYLE "Rushed" walk and "BigSteps" run turn the hips up to 34 degrees and the head up to
// 49 degrees off the path, with the head bowed about 30 degrees, so lab avatars lean and walk sideways.
// ActionForge's clips (CC0, by Quaternius) keep the hips within 3 degrees in the walk and 6 in the jog.
//
// What it does: samples each clip at 30 frames a second on the pack's own 71-joint skeleton, keeps the
// 22 humanoid joints, and turns every joint's rotation into a change from its rest pose, so the written
// skeleton rests at identity like a BVH T-pose (left +X, forward +Z, Y up, centimetres). The last frame
// repeats the first. The clips are in place, so speed is measured from the planted foot sliding back.
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const PACK = resolve(args[0] || "");
const OUT = resolve(option("out", join(ROOT, "web", "assets", "mocap", "locomotion-mocap.json")));
const CLIP_NAMES = { idle: option("idle", "idle_loop"), walk: option("walk", "walk_loop"), run: option("run", "jog_fwd_loop") };
const FPS = 30;

const HUMANOID_MAP = {
  pelvis: "hips", spine_01: "spine", spine_02: "chest", spine_03: "upperChest", neck_01: "neck", Head: "head",
  clavicle_l: "leftShoulder", upperarm_l: "leftUpperArm", lowerarm_l: "leftLowerArm", hand_l: "leftHand",
  clavicle_r: "rightShoulder", upperarm_r: "rightUpperArm", lowerarm_r: "rightLowerArm", hand_r: "rightHand",
  thigh_l: "leftUpperLeg", calf_l: "leftLowerLeg", foot_l: "leftFoot", ball_l: "leftToes",
  thigh_r: "rightUpperLeg", calf_r: "rightLowerLeg", foot_r: "rightFoot", ball_r: "rightToes",
};

const qmul = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const qinv = (q) => [-q[0], -q[1], -q[2], q[3]];
const rotate = (q, v) => qmul(qmul(q, [v[0], v[1], v[2], 0]), qinv(q)).slice(0, 3);
function slerp(a, b, t) {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const s = d < 0 ? -1 : 1;
  d *= s;
  if (d > 0.9995) {
    const r = a.map((v, i) => v + (s * b[i] - v) * t);
    const n = Math.hypot(...r);
    return r.map((v) => v / n);
  }
  const th = Math.acos(d);
  const wa = Math.sin((1 - t) * th) / Math.sin(th);
  const wb = Math.sin(t * th) / Math.sin(th);
  return a.map((v, i) => wa * v + wb * s * b[i]);
}

function readGlb(path) {
  const bytes = readFileSync(path);
  const jsonLength = bytes.readUInt32LE(12);
  const gltf = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString());
  const bin = bytes.subarray(20 + jsonLength + 8);
  const accessor = (index) => {
    const a = gltf.accessors[index];
    const view = gltf.bufferViews[a.bufferView];
    const width = { SCALAR: 1, VEC3: 3, VEC4: 4 }[a.type];
    const offset = (view.byteOffset || 0) + (a.byteOffset || 0);
    const data = new Float32Array(bin.buffer.slice(bin.byteOffset + offset, bin.byteOffset + offset + a.count * width * 4));
    return Array.from({ length: a.count }, (_, i) => Array.from(data.subarray(i * width, (i + 1) * width)));
  };
  return { gltf, accessor };
}

const { gltf, accessor } = readGlb(PACK);
const nodes = gltf.nodes;
const parentOf = new Map();
nodes.forEach((n, i) => (n.children || []).forEach((c) => parentOf.set(c, i)));
const indexOf = Object.fromEntries(nodes.map((n, i) => [n.name, i]));
for (const name of Object.keys(HUMANOID_MAP)) if (!(name in indexOf)) throw new Error(`clip pack has no joint ${name}`);

/** A sampler for one clip: local rotation and translation of every node at time t. */
function clipSampler(clipName) {
  const animation = gltf.animations.find((a) => a.name === clipName);
  if (!animation) throw new Error(`clip pack has no clip ${clipName}`);
  const tracks = new Map();
  let duration = 0;
  for (const channel of animation.channels) {
    const sampler = animation.samplers[channel.sampler];
    const times = accessor(sampler.input).map((v) => v[0]);
    duration = Math.max(duration, times[times.length - 1]);
    tracks.set(`${channel.target.node}.${channel.target.path}`, { times, values: accessor(sampler.output), step: sampler.interpolation === "STEP" });
  }
  const at = (track, t, isRotation) => {
    const { times, values, step } = track;
    if (t <= times[0]) return values[0];
    if (t >= times[times.length - 1]) return values[values.length - 1];
    let k = times.findIndex((x) => x > t) - 1;
    if (step) return values[k];
    const f = (t - times[k]) / (times[k + 1] - times[k]);
    return isRotation ? slerp(values[k], values[k + 1], f) : values[k].map((v, i) => v + (values[k + 1][i] - v) * f);
  };
  return {
    duration,
    local(index, t) {
      const n = nodes[index];
      const r = tracks.get(`${index}.rotation`);
      const p = tracks.get(`${index}.translation`);
      return { rotation: r ? at(r, t, true) : n.rotation || [0, 0, 0, 1], translation: p ? at(p, t, false) : n.translation || [0, 0, 0] };
    },
  };
}

/** World rotation and position (metres) of a node, through its whole parent chain. */
function world(index, local) {
  const chain = [];
  for (let i = index; i !== undefined; i = parentOf.get(i)) chain.unshift(i);
  let rotation = [0, 0, 0, 1];
  let position = [0, 0, 0];
  for (const i of chain) {
    const l = local(i);
    position = position.map((v, k) => v + rotate(rotation, l.translation)[k]);
    rotation = qmul(rotation, l.rotation);
  }
  return { rotation, position };
}

const rest = (i) => ({ rotation: nodes[i].rotation || [0, 0, 0, 1], translation: nodes[i].translation || [0, 0, 0] });
const restWorld = Object.fromEntries(Object.keys(HUMANOID_MAP).map((name) => [name, world(indexOf[name], rest)]));
const outputParent = (name) => {
  for (let i = parentOf.get(indexOf[name]); i !== undefined; i = parentOf.get(i)) if (nodes[i].name in HUMANOID_MAP) return nodes[i].name;
  return null;
};
const cm = (v) => Math.round(v * 1e5) / 1e3;
const bones = Object.keys(HUMANOID_MAP).map((name) => {
  const parent = outputParent(name);
  const here = restWorld[name].position;
  const offset = parent ? here.map((v, k) => v - restWorld[parent].position[k]) : [0, 0, 0];
  return { name, parent, offset: offset.map(cm) };
});

function bake(clipName, measureGait) {
  const sampler = clipSampler(clipName);
  const period = Math.round(sampler.duration * FPS);
  const rotations = Object.fromEntries(Object.keys(HUMANOID_MAP).map((n) => [n, []]));
  const hipsHeight = [];
  const feet = { left: [], right: [] };
  for (let f = 0; f <= period; f += 1) {
    const t = (f === period ? 0 : f) / FPS;
    const local = (i) => sampler.local(i, t);
    const change = {};
    for (const name of Object.keys(HUMANOID_MAP)) {
      const w = world(indexOf[name], local);
      change[name] = qmul(w.rotation, qinv(restWorld[name].rotation));
      if (name === "pelvis") hipsHeight.push(cm(w.position[1]));
      if (name === "foot_l") feet.left.push(w.position);
      if (name === "foot_r") feet.right.push(w.position);
    }
    for (const name of Object.keys(HUMANOID_MAP)) {
      const parent = outputParent(name);
      const q = parent ? qmul(qinv(change[parent]), change[name]) : change[name];
      rotations[name].push(q.map((v) => Math.round(v * 1e5) / 1e5));
    }
  }
  const clip = { frames: period + 1, duration: Math.round((period / FPS) * 1e5) / 1e5, source_clip: clipName };
  if (measureGait) {
    // A planted foot slides back at the body's speed in an in-place clip: its ankle within 3 cm of its lowest.
    const windows = {};
    const slides = [];
    for (const side of ["left", "right"]) {
      const track = feet[side].slice(0, period);
      const low = Math.min(...track.map((p) => p[1])) + 0.03;
      const planted = track.map((p) => p[1] <= low);
      for (let i = 0; i < period; i += 1) {
        const j = (i + 1) % period;
        // Forward is +Z: a planted foot moves backward; a foot moving forward near the ground is swinging.
        const back = (track[i][2] - track[j][2]) * FPS;
        if (planted[i] && planted[j] && back > 0) slides.push(back);
      }
      let start = planted.findIndex((p, i) => p && !planted[(i - 1 + period) % period]);
      if (start < 0) start = 0;
      let length = 0;
      while (length < period && planted[(start + length) % period]) length += 1;
      windows[side] = { start: Math.round((start / FPS) * 1e4) / 1e4, end: Math.round(((start + length - 1) / FPS) * 1e4) / 1e4 };
    }
    slides.sort((a, b) => a - b);
    const speed = slides[Math.floor(slides.length / 2)];
    Object.assign(clip, {
      natural_speed_mps: Math.round(speed * 1e4) / 1e4,
      cycle_distance_m: Math.round(speed * (period / FPS) * 1e4) / 1e4,
      contact_windows_s: windows,
    });
  }
  return { ...clip, rotations, hips_height: hipsHeight };
}

const clips = { idle: bake(CLIP_NAMES.idle, false), walk: bake(CLIP_NAMES.walk, true), run: bake(CLIP_NAMES.run, true) };
const idleHeights = clips.idle.hips_height;
const output = {
  schema_version: 1,
  source: {
    dataset: "ActionForge animation library",
    authors: "Quaternius (ActionForge)",
    url: "https://actionforge.app",
    license: "CC0-1.0",
    license_url: "https://creativecommons.org/publicdomain/zero/1.0/",
    files: Object.values(CLIP_NAMES).map((n) => `actionforge-clips.glb#${n}`),
    pack: "actionforge-clips.glb: ActionForge's CC0 clips on its 71-joint skeleton, in place",
    changes: "Sampled at 30 frames a second on the pack's skeleton, 22 humanoid joints kept, rotations rebased to an identity rest pose; in place.",
  },
  fps: FPS,
  units: "centimetres",
  hips_rest_height: Math.round((idleHeights.reduce((s, h) => s + h, 0) / idleHeights.length) * 1e3) / 1e3,
  humanoid_map: HUMANOID_MAP,
  bones,
  clips,
};
writeFileSync(OUT, `${JSON.stringify(output)}\n`);
console.log(`wrote ${OUT}`);
for (const [name, clip] of Object.entries(clips)) {
  console.log(`${name}: ${clip.source_clip}, ${clip.frames} frames, ${clip.duration} s`, clip.natural_speed_mps ? JSON.stringify({ speed: clip.natural_speed_mps, cycle: clip.cycle_distance_m, contact: clip.contact_windows_s }) : "");
}
