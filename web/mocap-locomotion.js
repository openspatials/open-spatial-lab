// Motion-capture locomotion: idle, walk and run clips from a recorded human, retargeted onto
// the avatar's normalized humanoid rig. Jump has no recording, so it is authored here.
//
// THE SOURCE. /assets/mocap/locomotion-mocap.json is baked from the 100STYLE dataset
// (Ian Mason, Sebastian Starke, Taku Komura; CC BY 4.0) by tools/mocap/bake-locomotion.mjs:
// a neutral idle, a brisk ("Rushed") forward walk and a long-stride ("BigSteps") forward run,
// each cut to a single seamless cycle, so they match the lab's 2.35 m/s walk and 2.8 m/s run. The file carries its own attribution, the source skeleton (bone names,
// parents and rest offsets, all rest rotations identity) and a map from source bone names to
// humanoid bone names, so this module knows no source naming of its own.
//
// HOW THE RETARGET WORKS. Source and target are both measured in their own anatomical frame
// (left, up, forward; measureAnatomicalFrame). A source rotation, expressed against its world
// rest pose, is changed into the target's frame:
//
//     q_out = R · (parentRestWorld · q_src · restWorld⁻¹) · R⁻¹,   R = B_target · B_source⁻¹
//
// so the result does not depend on which way either rig faces or which axis it calls up. The
// normalized humanoid bones rest at identity, which is why the world-rest form applies. The
// hips keep their vertical bob, scaled to the avatar's hip height; horizontal hip motion is
// dropped, because the scene moves the avatar.

import * as THREE from "./vendor/scene-core/vendor/three/three.module.js";
import { measureAnatomicalFrame } from "./humanoid-rig.js";

const SOURCE_CACHE = new Map();

async function loadSource(url) {
  let pending = SOURCE_CACHE.get(url);
  if (!pending) {
    pending = fetch(url).then((response) => {
      if (!response.ok) throw new Error(`motion-capture clips: ${url} answered ${response.status}`);
      return response.json();
    });
    SOURCE_CACHE.set(url, pending);
    pending.catch(() => SOURCE_CACHE.delete(url));
  }
  return pending;
}

/** The source skeleton at rest, as Object3Ds, so world rest rotations and positions can be read. */
function buildSourceSkeleton(source) {
  const nodes = {};
  const root = new THREE.Object3D();
  for (const bone of source.bones) {
    const node = new THREE.Object3D();
    node.name = bone.name;
    node.position.fromArray(bone.offset);
    (bone.parent ? nodes[bone.parent] : root).add(node);
    nodes[bone.name] = node;
  }
  root.updateMatrixWorld(true);
  return nodes;
}

/**
 * A raw bone of the avatar, as seen in the avatar's own model space. Its world position would
 * also carry the way the avatar faces in the scene, and the normalized bones' rotations are in
 * model space, so the frame must be measured there.
 */
function modelSpaceBone(vrm, name) {
  const node = vrm.humanoid?.getRawBoneNode(name);
  if (!node) return null;
  const root = vrm.scene;
  return {
    getWorldPosition(target) {
      node.getWorldPosition(target);
      if (root) {
        root.updateMatrixWorld(true);
        root.worldToLocal(target);
      }
      return target;
    },
  };
}

function basisQuaternion(frame) {
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(frame.left, frame.up, frame.forward));
}

function retargetClip(name, clip, source, nodes, vrm, rotate, rotateInverse) {
  const humanoidOf = source.humanoid_map;
  const times = Array.from({ length: clip.frames }, (_, i) => i / source.fps);
  const tracks = [];
  const restWorldInverse = new THREE.Quaternion();
  const parentRestWorld = new THREE.Quaternion();
  const q = new THREE.Quaternion();
  for (const [sourceBone, rotations] of Object.entries(clip.rotations)) {
    const humanoidBone = humanoidOf[sourceBone];
    if (!humanoidBone) continue;
    const target = vrm.humanoid?.getNormalizedBoneNode(humanoidBone);
    const node = nodes[sourceBone];
    if (!target || !node || !node.parent) continue;
    node.getWorldQuaternion(restWorldInverse).invert();
    node.parent.getWorldQuaternion(parentRestWorld);
    const values = new Float32Array(rotations.length * 4);
    rotations.forEach((r, i) => {
      q.set(r[0], r[1], r[2], r[3]).premultiply(parentRestWorld).multiply(restWorldInverse);
      q.premultiply(rotate).multiply(rotateInverse);
      values.set([q.x, q.y, q.z, q.w], i * 4);
    });
    tracks.push(new THREE.QuaternionKeyframeTrack(`${target.name}.quaternion`, times, Array.from(values)));
  }

  // Hips: the vertical bob only, scaled from the source's hip height to the avatar's.
  const hips = vrm.humanoid?.getNormalizedBoneNode("hips");
  const sourceHipsBone = Object.keys(humanoidOf).find((bone) => humanoidOf[bone] === "hips");
  if (hips && clip.hips_height && sourceHipsBone) {
    const restHeight = vrm.humanoid?.normalizedRestPose?.hips?.position?.[1] ?? hips.position.y;
    const scale = restHeight / source.hips_rest_height;
    const mean = clip.hips_height.reduce((sum, h) => sum + h, 0) / clip.hips_height.length;
    const values = [];
    for (const h of clip.hips_height) values.push(0, restHeight + (h - mean) * scale, 0);
    tracks.push(new THREE.VectorKeyframeTrack(`${hips.name}.position`, times, values));
  }
  // The last frame repeats the first, so the clip lasts one frame less than it has frames.
  const result = new THREE.AnimationClip(name, clip.duration, tracks);
  // The recording's own pace, scaled to this avatar's size, so the caller can match the
  // playback rate to the speed the avatar really moves at.
  if (clip.natural_speed_mps && hips) {
    const restHeight = vrm.humanoid?.normalizedRestPose?.hips?.position?.[1] ?? hips.position.y;
    const size = restHeight / (source.hips_rest_height / 100);
    result.userData = {
      natural_speed_mps: clip.natural_speed_mps * size,
      cycle_distance_m: clip.cycle_distance_m * size,
      contact_windows_s: clip.contact_windows_s,
    };
  }
  return result;
}

/**
 * A short jump (crouch, extend, tuck, land) authored in the rig's own anatomical frame, so a
 * knee bends the way a knee bends on any rig, whichever way it faces.
 */
function authorJumpClip(vrm) {
  const T = [0, 0.18, 0.42, 0.7];
  const node = (b) => vrm.humanoid?.getNormalizedBoneNode(b)?.name || null;
  const frame = measureAnatomicalFrame((b) => modelSpaceBone(vrm, b));
  const basis = frame ? basisQuaternion(frame) : new THREE.Quaternion();
  const basisInverse = basis.clone().invert();
  // flex about the rig's left axis, twist about its up axis, abduct about its forward axis.
  const pose = (flex, twist, abduct) => {
    const r = new THREE.Quaternion().setFromEuler(new THREE.Euler(flex, twist, abduct, "XYZ"));
    r.premultiply(basis).multiply(basisInverse);
    return [r.x, r.y, r.z, r.w];
  };
  const track = (bone, keys) => {
    const name = node(bone);
    return name ? new THREE.QuaternionKeyframeTrack(`${name}.quaternion`, T, keys.flat()) : null;
  };
  const tracks = [
    track("hips", [pose(0.25, 0, 0), pose(-0.12, 0, 0), pose(0.18, 0, 0), pose(0.25, 0, 0)]),
    track("spine", [pose(0.16, 0, 0), pose(-0.06, 0, 0), pose(0.12, 0, 0), pose(0.16, 0, 0)]),
    track("leftUpperLeg", [pose(1.0, 0, 0.05), pose(-0.15, 0, 0.05), pose(0.8, 0, 0.05), pose(1.0, 0, 0.05)]),
    track("leftLowerLeg", [pose(1.35, 0, 0), pose(0.2, 0, 0), pose(1.1, 0, 0), pose(1.35, 0, 0)]),
    track("rightUpperLeg", [pose(1.0, 0, -0.05), pose(-0.15, 0, -0.05), pose(0.8, 0, -0.05), pose(1.0, 0, -0.05)]),
    track("rightLowerLeg", [pose(1.35, 0, 0), pose(0.2, 0, 0), pose(1.1, 0, 0), pose(1.35, 0, 0)]),
    track("leftUpperArm", [pose(0, 0, -1.15), pose(-1.4, 0, -0.6), pose(-0.5, 0, -0.95), pose(0, 0, -1.15)]),
    track("rightUpperArm", [pose(0, 0, 1.15), pose(-1.4, 0, 0.6), pose(-0.5, 0, 0.95), pose(0, 0, 1.15)]),
  ].filter(Boolean);
  return new THREE.AnimationClip("jump", 0.7, tracks);
}

/**
 * The clip set { idle, walk, run, jump } bound to this avatar's normalized humanoid rig. The
 * caller owns the mixer, rooted at vrm.scene so the normalized bone names resolve.
 *
 * @param {object} vrm   the avatar (a VRM, a generated avatar or a GLB humanoid facade)
 * @param {{locomotion: string}} urls   where the baked motion-capture file is served
 */
export async function createRetargetedLocomotionClips(vrm, urls) {
  const source = await loadSource(urls.locomotion);
  const nodes = buildSourceSkeleton(source);
  const sourceFrame = measureAnatomicalFrame((bone) => {
    const name = Object.keys(source.humanoid_map).find((key) => source.humanoid_map[key] === bone);
    return name ? nodes[name] : null;
  });
  const targetFrame = measureAnatomicalFrame((bone) => modelSpaceBone(vrm, bone));
  if (!sourceFrame || !targetFrame) throw new Error("motion-capture clips: could not measure the source or the avatar skeleton");
  const rotate = basisQuaternion(targetFrame).multiply(basisQuaternion(sourceFrame).invert());
  const rotateInverse = rotate.clone().invert();

  const clips = {};
  for (const name of ["idle", "walk", "run"]) {
    if (source.clips[name]) clips[name] = retargetClip(name, source.clips[name], source, nodes, vrm, rotate, rotateInverse);
  }
  clips.jump = authorJumpClip(vrm);
  return clips;
}
