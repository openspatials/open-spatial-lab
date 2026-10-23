// Bakes web/assets/mocap/locomotion-mocap.json from the 100STYLE motion-capture dataset.
//
// Usage: node tools/mocap/bake-locomotion.mjs <folder holding Neutral_ID.bvh, Rushed_FW.bvh, BigSteps_FR.bvh>
//
// 100STYLE (Ian Mason, Sebastian Starke, Taku Komura, 2022) is licensed CC BY 4.0:
// https://zenodo.org/records/8127870. Download 100STYLE.zip from there and put the three files in
// one folder. The output keeps one seamless cycle each of the "Neutral" idle, the "Rushed" forward
// walk and the "BigSteps" forward run, at 30 frames a second, with the dataset's credit inside the
// file. The lab moves a walker at 2.35 m/s and a runner at 2.8 m/s. The neutral walk tops out at
// 1 m/s and would play 2.7 times too fast; the rushed walk reaches 1.96 m/s. The run needs a long
// stride: at 2.8 m/s the lab allows at most 195 steps a minute, and the BigSteps run's 2.08 m
// stride gives 162.
//
// What it does to the recording, and nothing else:
//   - reads the BVH skeleton (a T-pose: left is +X, forward is +Z, Y is up, centimetres);
//   - folds Chest4 into Chest3, because a humanoid rig has one upper-chest bone;
//   - keeps every second frame (60 to 30 frames a second);
//   - finds one gait cycle for walk and run (a few seconds for idle) whose last frame matches its
//     first, and closes the loop on it; the walk comes from the fastest quarter of its recording
//     and the run from the fastest tenth, where the performer moves at a steady brisk pace;
//   - turns the cycle to face +Z, by its average heading, so the avatar walks where it faces.
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const OUT = join(ROOT, "web", "assets", "mocap", "locomotion-mocap.json");
const FOLDER = resolve(process.argv[2] || ".");

const HUMANOID_MAP = {
  Hips: "hips", Chest: "spine", Chest2: "chest", Chest3: "upperChest", Neck: "neck", Head: "head",
  LeftCollar: "leftShoulder", LeftShoulder: "leftUpperArm", LeftElbow: "leftLowerArm", LeftWrist: "leftHand",
  RightCollar: "rightShoulder", RightShoulder: "rightUpperArm", RightElbow: "rightLowerArm", RightWrist: "rightHand",
  LeftHip: "leftUpperLeg", LeftKnee: "leftLowerLeg", LeftAnkle: "leftFoot", LeftToe: "leftToes",
  RightHip: "rightUpperLeg", RightKnee: "rightLowerLeg", RightAnkle: "rightFoot", RightToe: "rightToes",
};

// ---- quaternions as [x, y, z, w] ----
const qmul = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const axisAngle = (axis, degrees) => {
  const h = (degrees * Math.PI) / 360;
  const s = Math.sin(h);
  return [axis === "X" ? s : 0, axis === "Y" ? s : 0, axis === "Z" ? s : 0, Math.cos(h)];
};
const rotateVector = (q, v) => {
  const p = qmul(qmul(q, [v[0], v[1], v[2], 0]), [-q[0], -q[1], -q[2], q[3]]);
  return [p[0], p[1], p[2]];
};

function parseBvh(text) {
  const tokens = text.split(/\s+/).filter(Boolean);
  const joints = [];
  const stack = [];
  let i = 0;
  let channelCount = 0;
  while (tokens[i] !== "MOTION") {
    const t = tokens[i];
    if (t === "ROOT" || t === "JOINT") {
      joints.push({ name: tokens[i + 1], parent: stack.length ? stack[stack.length - 1].name : null, offset: null, channels: [] });
      i += 2;
    } else if (t === "End") {
      // An end site carries an offset only; skip its block.
      i += 2;
      let depth = 0;
      do {
        if (tokens[i] === "{") depth += 1;
        if (tokens[i] === "}") depth -= 1;
        i += 1;
      } while (depth > 0);
    } else if (t === "{") {
      stack.push(joints[joints.length - 1]);
      i += 1;
    } else if (t === "}") {
      stack.pop();
      i += 1;
    } else if (t === "OFFSET") {
      stack[stack.length - 1].offset = tokens.slice(i + 1, i + 4).map(Number);
      i += 4;
    } else if (t === "CHANNELS") {
      const n = Number(tokens[i + 1]);
      const joint = stack[stack.length - 1];
      joint.channels = tokens.slice(i + 2, i + 2 + n).map((c) => ({ name: c, index: channelCount++ }));
      i += 2 + n;
    } else {
      i += 1;
    }
  }
  const frameCount = Number(tokens[i + 2]);
  const frameTime = Number(tokens[i + 5]);
  const values = tokens.slice(i + 6).map(Number);
  const frames = [];
  for (let f = 0; f < frameCount; f += 1) frames.push(values.slice(f * channelCount, (f + 1) * channelCount));
  return { joints, frames, frameTime };
}

/** Local rotation and root position of every joint in every frame (channel order is the rotation order). */
function poses(bvh) {
  return bvh.frames.map((frame) => {
    const rotations = {};
    let position = null;
    for (const joint of bvh.joints) {
      let q = [0, 0, 0, 1];
      for (const channel of joint.channels) {
        if (channel.name.endsWith("rotation")) q = qmul(q, axisAngle(channel.name[0], frame[channel.index]));
      }
      rotations[joint.name] = q;
      if (!joint.parent) position = joint.channels.filter((c) => c.name.endsWith("position")).map((c) => frame[c.index]);
    }
    // Fold Chest4 into Chest3: one upper-chest bone on a humanoid rig.
    rotations.Chest3 = qmul(rotations.Chest3, rotations.Chest4);
    delete rotations.Chest4;
    return { rotations, position };
  });
}

function skeleton(bvh) {
  const chest4 = bvh.joints.find((j) => j.name === "Chest4");
  return bvh.joints.filter((j) => j.name !== "Chest4").map((j) => ({
    name: j.name,
    parent: j.parent === "Chest4" ? "Chest3" : j.parent,
    offset: j.parent === "Chest4" ? j.offset.map((v, k) => v + chest4.offset[k]) : j.offset,
  }));
}

const distance = (a, b) => {
  let sum = 0;
  for (const bone of Object.keys(a.rotations)) {
    if (bone === "Hips") continue;
    const p = a.rotations[bone];
    const q = b.rotations[bone];
    sum += 1 - Math.abs(p[0] * q[0] + p[1] * q[1] + p[2] * q[2] + p[3] * q[3]);
  }
  return sum;
};

/**
 * One loop. First the period: the length at which frames are, on average, most like the frame
 * that many frames before (the gait cycle), searched within [minPeriod, maxPeriod]. Matching a
 * single best pair instead would always favour the shortest length, because neighbouring frames
 * are alike. Then the start: within two frames of that period, the stretch whose two ends, and
 * their neighbours, match best.
 */
function bestLoop(frames, minPeriod, maxPeriod, margin, fast = null) {
  let period = minPeriod;
  let lowest = Infinity;
  for (let p = minPeriod; p <= maxPeriod; p += 1) {
    let sum = 0;
    let n = 0;
    for (let s = margin; s + p < frames.length - margin; s += 2) {
      sum += distance(frames[s], frames[s + p]);
      n += 1;
    }
    if (n && sum / n < lowest) {
      lowest = sum / n;
      period = p;
    }
  }
  let best = null;
  for (let s = margin; s + period + 3 < frames.length - margin; s += 1) {
    if (fast && !(fast(s) && fast(s + period))) continue;
    for (let p = Math.max(minPeriod, period - 2); p <= Math.min(maxPeriod, period + 2); p += 1) {
      const cost = distance(frames[s], frames[s + p]) + distance(frames[s + 1], frames[s + p + 1]);
      if (!best || cost < best.cost) best = { start: s, period: p, cost };
    }
  }
  return best;
}

const heading = (q) => {
  const f = rotateVector(q, [0, 0, 1]);
  return Math.atan2(f[0], f[2]);
};

/** World position of a joint in one frame, by forward kinematics over the BVH skeleton. */
function jointPosition(joints, frame, name) {
  const chain = [];
  for (let j = joints.find((x) => x.name === name); j; j = joints.find((x) => x.name === j.parent)) chain.unshift(j);
  let position = frame.position.slice();
  let rotation = [0, 0, 0, 1];
  chain.forEach((joint, k) => {
    if (k > 0) position = position.map((v, i) => v + rotateVector(rotation, joint.offset)[i]);
    // Chest4 is folded into Chest3 in the poses, so it adds its offset but no rotation of its own.
    if (joint.name !== "Chest4") rotation = qmul(rotation, frame.rotations[joint.name]);
  });
  return position;
}

/**
 * How fast the cycle travels (hips, in metres a second), how far one cycle goes, and when
 * each foot is planted: the stretch of the cycle when its ankle is within 3 cm of its lowest.
 */
function gait(joints, cycle, period, fps) {
  const first = cycle[0].position;
  const last = cycle[period].position;
  const distance = Math.hypot(last[0] - first[0], last[2] - first[2]) / 100;
  const duration = period / fps;
  const round = (v) => Math.round(v * 1e4) / 1e4;
  const windows = {};
  for (const [side, ankle] of [["left", "LeftAnkle"], ["right", "RightAnkle"]]) {
    const heights = cycle.slice(0, period).map((f) => jointPosition(joints, f, ankle)[1]);
    const low = Math.min(...heights) + 3;
    const planted = heights.map((h) => h <= low);
    // The window starts where planting begins after a lift, and may run past the cycle's end.
    let start = planted.findIndex((p, i) => p && !planted[(i - 1 + period) % period]);
    if (start < 0) start = 0;
    let length = 0;
    while (length < period && planted[(start + length) % period]) length += 1;
    windows[side] = { start: round(start / fps), end: round((start + length - 1) / fps) };
  }
  return { natural_speed_mps: round(distance / duration), cycle_distance_m: round(distance), contact_windows_s: windows };
}

function cutClip(frames, loop, fps, joints) {
  const cycle = frames.slice(loop.start, loop.start + loop.period + 1);
  // Average heading over the cycle (circular mean), then turn the whole cycle to face +Z.
  const yaws = cycle.map((f) => heading(f.rotations.Hips));
  const mean = Math.atan2(yaws.reduce((s, y) => s + Math.sin(y), 0), yaws.reduce((s, y) => s + Math.cos(y), 0));
  const unturn = [0, Math.sin(-mean / 2), 0, Math.cos(-mean / 2)];
  const round = (v) => Math.round(v * 1e5) / 1e5;
  const rotations = {};
  for (const bone of Object.keys(cycle[0].rotations)) {
    rotations[bone] = cycle.map((f, i) => {
      // The last frame repeats the first, so the loop closes without a seam.
      const source = i === cycle.length - 1 ? cycle[0] : f;
      const q = bone === "Hips" ? qmul(unturn, source.rotations[bone]) : source.rotations[bone];
      return q.map(round);
    });
  }
  const hipsHeight = cycle.map((f, i) => round((i === cycle.length - 1 ? cycle[0] : f).position[1]));
  const measured = joints ? gait(joints, cycle, loop.period, fps) : {};
  return { frames: cycle.length, duration: round(loop.period / fps), match_cost: round(loop.cost), ...measured, rotations, hips_height: hipsHeight };
}

function load(name) {
  const bvh = parseBvh(readFileSync(join(FOLDER, name), "utf8"));
  const all = poses(bvh);
  const step = Math.max(1, Math.round(1 / 30 / bvh.frameTime));
  return { bvh, frames: all.filter((_, i) => i % step === 0), fps: 1 / (bvh.frameTime * step) };
}

/** A test for "this frame is in the fastest share of the recording", by hips speed over one second. */
function fastShare(frames, fps, share) {
  const w = Math.round(fps);
  const speed = frames.map((f, i) => {
    const a = frames[Math.max(0, i - (w >> 1))].position;
    const b = frames[Math.min(frames.length - 1, i + (w >> 1))].position;
    return Math.hypot(b[0] - a[0], b[2] - a[2]);
  });
  const threshold = speed.slice().sort((x, y) => x - y)[Math.floor(speed.length * (1 - share))];
  return (i) => speed[i] >= threshold;
}

const idle = load("Neutral_ID.bvh");
const walk = load("Rushed_FW.bvh");
const run = load("BigSteps_FR.bvh");
const fps = walk.fps;
const margin = Math.round(2 * fps);
const clips = {
  idle: cutClip(idle.frames, bestLoop(idle.frames, Math.round(3 * fps), Math.round(5 * fps), margin), fps),
  walk: cutClip(walk.frames, bestLoop(walk.frames, Math.round(0.8 * fps), Math.round(1.6 * fps), margin, fastShare(walk.frames, fps, 0.25)), fps, walk.bvh.joints),
  run: cutClip(run.frames, bestLoop(run.frames, Math.round(0.6 * fps), Math.round(1.2 * fps), margin, fastShare(run.frames, fps, 0.1)), fps, run.bvh.joints),
};
const idleHeights = clips.idle.hips_height;
const output = {
  schema_version: 1,
  source: {
    dataset: "100STYLE",
    authors: "Ian Mason, Sebastian Starke, Taku Komura",
    url: "https://zenodo.org/records/8127870",
    license: "CC-BY-4.0",
    license_url: "https://creativecommons.org/licenses/by/4.0/",
    files: ["Neutral/Neutral_ID.bvh", "Rushed/Rushed_FW.bvh", "BigSteps/BigSteps_FR.bvh"],
    changes: "One cycle of each recording, at 30 frames a second, turned to face +Z; Chest4 folded into Chest3.",
  },
  fps,
  units: "centimetres",
  hips_rest_height: Math.round((idleHeights.reduce((s, h) => s + h, 0) / idleHeights.length) * 1e3) / 1e3,
  humanoid_map: HUMANOID_MAP,
  bones: skeleton(walk.bvh),
  clips,
};
writeFileSync(OUT, `${JSON.stringify(output)}\n`);
console.log(`wrote ${OUT}`);
for (const [name, clip] of Object.entries(clips)) console.log(`${name}: ${clip.frames} frames, ${clip.duration} s, end match ${clip.match_cost}`, clip.natural_speed_mps ? JSON.stringify({ speed: clip.natural_speed_mps, distance: clip.cycle_distance_m, contacts: clip.contact_windows_s }) : "");
