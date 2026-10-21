import * as THREE from "./vendor/scene-core/vendor/three/three.module.js";

export const MIXAMO_TO_VRM = Object.freeze({
  mixamorigHips: "hips",
  mixamorigSpine: "spine",
  mixamorigSpine1: "chest",
  mixamorigSpine2: "upperChest",
  mixamorigNeck: "neck",
  mixamorigHead: "head",
  mixamorigLeftShoulder: "leftShoulder",
  mixamorigLeftArm: "leftUpperArm",
  mixamorigLeftForeArm: "leftLowerArm",
  mixamorigLeftHand: "leftHand",
  mixamorigLeftHandThumb1: "leftThumbMetacarpal",
  mixamorigLeftHandThumb2: "leftThumbProximal",
  mixamorigLeftHandThumb3: "leftThumbDistal",
  mixamorigLeftHandIndex1: "leftIndexProximal",
  mixamorigLeftHandIndex2: "leftIndexIntermediate",
  mixamorigLeftHandIndex3: "leftIndexDistal",
  mixamorigLeftHandMiddle1: "leftMiddleProximal",
  mixamorigLeftHandMiddle2: "leftMiddleIntermediate",
  mixamorigLeftHandMiddle3: "leftMiddleDistal",
  mixamorigLeftHandRing1: "leftRingProximal",
  mixamorigLeftHandRing2: "leftRingIntermediate",
  mixamorigLeftHandRing3: "leftRingDistal",
  mixamorigLeftHandPinky1: "leftLittleProximal",
  mixamorigLeftHandPinky2: "leftLittleIntermediate",
  mixamorigLeftHandPinky3: "leftLittleDistal",
  mixamorigRightShoulder: "rightShoulder",
  mixamorigRightArm: "rightUpperArm",
  mixamorigRightForeArm: "rightLowerArm",
  mixamorigRightHand: "rightHand",
  mixamorigRightHandThumb1: "rightThumbMetacarpal",
  mixamorigRightHandThumb2: "rightThumbProximal",
  mixamorigRightHandThumb3: "rightThumbDistal",
  mixamorigRightHandIndex1: "rightIndexProximal",
  mixamorigRightHandIndex2: "rightIndexIntermediate",
  mixamorigRightHandIndex3: "rightIndexDistal",
  mixamorigRightHandMiddle1: "rightMiddleProximal",
  mixamorigRightHandMiddle2: "rightMiddleIntermediate",
  mixamorigRightHandMiddle3: "rightMiddleDistal",
  mixamorigRightHandRing1: "rightRingProximal",
  mixamorigRightHandRing2: "rightRingIntermediate",
  mixamorigRightHandRing3: "rightRingDistal",
  mixamorigRightHandPinky1: "rightLittleProximal",
  mixamorigRightHandPinky2: "rightLittleIntermediate",
  mixamorigRightHandPinky3: "rightLittleDistal",
  mixamorigLeftUpLeg: "leftUpperLeg",
  mixamorigLeftLeg: "leftLowerLeg",
  mixamorigLeftFoot: "leftFoot",
  mixamorigLeftToeBase: "leftToes",
  mixamorigRightUpLeg: "rightUpperLeg",
  mixamorigRightLeg: "rightLowerLeg",
  mixamorigRightFoot: "rightFoot",
  mixamorigRightToeBase: "rightToes",
});

export function measureAnatomicalFrame(getBoneNode) {
  const world = (name) => {
    const node = getBoneNode(name);
    return node ? node.getWorldPosition(new THREE.Vector3()) : null;
  };
  const hips = world("hips");
  const head = world("head") || world("neck");
  const leftArm = world("leftUpperArm");
  const rightArm = world("rightUpperArm");
  if (!hips || !head || !leftArm || !rightArm) return null;
  const up = head.clone().sub(hips);
  if (up.lengthSq() < 1e-8) return null;
  up.normalize();
  const left = leftArm.clone().sub(rightArm);
  if (left.lengthSq() < 1e-8) return null;
  left.addScaledVector(up, -left.dot(up));
  if (left.lengthSq() < 1e-8) return null;
  left.normalize();
  const forward = new THREE.Vector3().crossVectors(left, up).normalize();
  return { up, left, forward };
}

function clipFor(vrm, name, duration, amplitude, speed = 1) {
  const times = [0, duration * 0.25, duration * 0.5, duration * 0.75, duration];
  const tracks = [];
  const definitions = [
    ["leftUpperLeg", 1], ["rightUpperLeg", -1],
    ["leftLowerLeg", -0.55], ["rightLowerLeg", 0.55],
    ["leftUpperArm", -0.8], ["rightUpperArm", 0.8],
    ["spine", 0.12],
  ];
  for (const [boneName, direction] of definitions) {
    const bone = vrm.humanoid?.getNormalizedBoneNode(boneName);
    if (!bone) continue;
    const values = [];
    for (let index = 0; index < times.length; index += 1) {
      const phase = Math.sin((index / (times.length - 1)) * Math.PI * 2 * speed);
      const delta = new THREE.Quaternion().setFromEuler(new THREE.Euler(amplitude * direction * phase, 0, 0));
      const pose = bone.quaternion.clone().multiply(delta);
      values.push(pose.x, pose.y, pose.z, pose.w);
    }
    tracks.push(new THREE.QuaternionKeyframeTrack(`${bone.name}.quaternion`, times, values));
  }
  return new THREE.AnimationClip(name, duration, tracks);
}

export async function createRetargetedLocomotionClips(vrm) {
  return {
    idle: clipFor(vrm, "idle", 2.4, 0.025),
    walk: clipFor(vrm, "walk", 1.05, 0.42),
    run: clipFor(vrm, "run", 0.68, 0.7),
    jump: clipFor(vrm, "jump", 0.7, 0.5, 0.5),
  };
}
