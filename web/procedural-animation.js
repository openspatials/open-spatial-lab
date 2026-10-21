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

// The standing pose of a rig whose arms rest level: each upper arm hangs 80 degrees below
// level (10 degrees out from the side) and tilts 5 degrees forward, and each elbow bends 12
// degrees forward. An arm within LEVEL_ARM_LIMIT of the horizontal counts as level.
const ARM_HANG_DEGREES = 80;
const ARM_FORWARD_DEGREES = 5;
const ELBOW_BEND_DEGREES = 12;
const LEVEL_ARM_LIMIT = 0.5;

// An upper arm that rests level (a T-pose rig: the generated avatar, the GLB facade) would
// idle with the arm straight out, so its clips start from the standing pose above and swing
// the upper arm about the body's left axis. An arm that already hangs (an A-pose rig) keeps
// its rest.
function relaxedArmPoses(vrm) {
  const getBone = (name) => vrm.humanoid?.getNormalizedBoneNode(name) || null;
  (vrm.scene || getBone("hips"))?.updateMatrixWorld(true);
  const frame = measureAnatomicalFrame(getBone);
  if (!frame) return {};
  const poses = {};
  for (const [side, lateral] of [["left", frame.left], ["right", frame.left.clone().negate()]]) {
    const upper = getBone(`${side}UpperArm`);
    const lower = getBone(`${side}LowerArm`);
    if (!upper?.parent || !lower) continue;
    const start = upper.getWorldPosition(new THREE.Vector3());
    const direction = lower.getWorldPosition(new THREE.Vector3()).sub(start);
    if (direction.lengthSq() < 1e-10) continue;
    direction.normalize();
    if (Math.abs(direction.dot(frame.up)) > LEVEL_ARM_LIMIT) continue;
    const hang = THREE.MathUtils.degToRad(ARM_HANG_DEGREES);
    const tilt = THREE.MathUtils.degToRad(ARM_FORWARD_DEGREES);
    const target = lateral.clone().multiplyScalar(Math.cos(hang))
      .addScaledVector(frame.up, -Math.sin(hang))
      .addScaledVector(frame.forward, Math.sin(tilt))
      .normalize();
    const parentWorld = upper.parent.getWorldQuaternion(new THREE.Quaternion());
    const parentInverse = parentWorld.clone().invert();
    const swing = parentInverse.clone()
      .multiply(new THREE.Quaternion().setFromUnitVectors(direction, target))
      .multiply(parentWorld);
    const upperBase = swing.multiply(upper.quaternion.clone());
    poses[`${side}UpperArm`] = {
      base: upperBase,
      axis: frame.left.clone().applyQuaternion(parentInverse).normalize(),
    };
    if (lower.parent !== upper) continue;
    // The elbow flexes about the body's left axis, seen from the posed upper arm. A forward
    // bend of a hanging arm is a negative turn about that axis.
    const elbowAxis = frame.left.clone().applyQuaternion(parentWorld.clone().multiply(upperBase).invert()).normalize();
    poses[`${side}LowerArm`] = {
      base: new THREE.Quaternion()
        .setFromAxisAngle(elbowAxis, -THREE.MathUtils.degToRad(ELBOW_BEND_DEGREES))
        .multiply(lower.quaternion),
      axis: elbowAxis,
    };
  }
  return poses;
}

function clipFor(vrm, name, duration, amplitude, speed = 1, armPoses = {}) {
  const times = [0, duration * 0.25, duration * 0.5, duration * 0.75, duration];
  const tracks = [];
  const definitions = [
    ["leftUpperLeg", 1], ["rightUpperLeg", -1],
    ["leftLowerLeg", -0.55], ["rightLowerLeg", 0.55],
    ["leftUpperArm", -0.8], ["rightUpperArm", 0.8],
    ["leftLowerArm", 0], ["rightLowerArm", 0],
    ["spine", 0.12],
  ];
  for (const [boneName, direction] of definitions) {
    const bone = vrm.humanoid?.getNormalizedBoneNode(boneName);
    if (!bone) continue;
    const hang = armPoses[boneName];
    // A forearm only gets a track when it has an elbow bend to hold.
    if (direction === 0 && !hang) continue;
    const values = [];
    for (let index = 0; index < times.length; index += 1) {
      const phase = Math.sin((index / (times.length - 1)) * Math.PI * 2 * speed);
      const angle = amplitude * direction * phase;
      const pose = hang
        ? new THREE.Quaternion().setFromAxisAngle(hang.axis, angle).multiply(hang.base)
        : bone.quaternion.clone().multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(angle, 0, 0)));
      values.push(pose.x, pose.y, pose.z, pose.w);
    }
    tracks.push(new THREE.QuaternionKeyframeTrack(`${bone.name}.quaternion`, times, values));
  }
  return new THREE.AnimationClip(name, duration, tracks);
}

export async function createRetargetedLocomotionClips(vrm) {
  const armPoses = relaxedArmPoses(vrm);
  return {
    idle: clipFor(vrm, "idle", 2.4, 0.025, 1, armPoses),
    walk: clipFor(vrm, "walk", 1.05, 0.42, 1, armPoses),
    run: clipFor(vrm, "run", 0.68, 0.7, 1, armPoses),
    jump: clipFor(vrm, "jump", 0.7, 0.5, 0.5, armPoses),
  };
}
