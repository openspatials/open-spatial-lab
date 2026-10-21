// glb-humanoid.mjs.
//
// THE MISSING LAYER. web/assets/avatar-catalog.json has been telling us what was
// wrong, in its own words:
//
//   "GLB avatars are selectable as static GLTF scene avatars in this first pass.
//    They do not expose a VRM humanoid facade, so mocap retargeting and VRM
//    normalized-bone equipment attachment are unsupported UNTIL A READY PLAYER ME
//    OR GLTF HUMANOID MAPPING LAYER IS ADDED."
//
// This is that mapping layer. It is an ADAPTER, not a new avatar system: it takes
// a GLB whose skeleton uses Mixamo bone naming (which is what Ready Player Me and
// every Sketchfab/Mixamo export ships) and hands back the SAME `VRMHumanoid`
// surface the VRM avatars already expose. Everything downstream — the Xbot mocap
// retarget in retarget-mocap.js, the AnimationMixer locomotion FSM, and the
// normalized-bone equipment attachment in avatar-equipment-layer.js — then runs
// COMPLETELY UNCHANGED against a GLB. No locomotion code is rewritten; the GLB
// simply stops being a special case.
//
// Why a real `VRMHumanoid` and not a hand-rolled facade: three-vrm's VRMHumanoid
// internally builds a VRMHumanoidRig — a parallel "normalized" bone tree whose
// bones all have IDENTITY rest rotation. The mocap retarget emits world-space
// rotation deltas, and those can only be applied directly to a rig whose rest
// orientation is identity. VRMHumanoid.update() then copies normalized -> raw every
// frame. Reusing it means the GLB path is byte-for-byte the animation path the VRM
// avatars are already proven on.
//
// CORRECTION — the sentence that used to sit here was WRONG, and it is the
// bug the user reported. It claimed VRMHumanoidRig made a raw Mixamo skeleton safe
// to drive. It does not. It reconciles bind AXES; it does NOT reconcile the rest
// POSE. `q = identity` on a normalized bone reproduces THAT RIG'S OWN REST — and a
// Ready Player Me GLB rests in an A-POSE while every mocap clip is authored as a
// delta from a T-POSE. The 66° droop was therefore added to every arm rotation and
// the arms ended up behind the back. See normalizeRestPoseToTPose() below, which is
// the step that was missing.
//
// Ref: three-vrm VRMHumanoidLoaderPlugin does exactly one extra thing after
// constructing the humanoid — `gltf.scene.add(humanoid.normalizedHumanBonesRoot)`
// — and so do we (see attachment of the rig root below).

import * as THREE from "../vendor/scene-core/vendor/three/three.module.js";
import { VRMHumanoid } from "../vendor-vrm/three-vrm.module.js";
import { MIXAMO_TO_VRM, measureAnatomicalFrame } from "../procedural-animation.js";

/**
 * Mixamo BASE bone name (lowercased, no `mixamorig` prefix, no exporter suffix)
 * -> VRM humanoid bone name.
 *
 * Derived from retarget-mocap.js's MIXAMO_TO_VRM so there is exactly ONE bone-name
 * table in the codebase. The mocap source (Xbot.glb) names its joints
 * `mixamorig:Hips`, which three's GLTFLoader sanitizes to `mixamorigHips`; a
 * Sketchfab-exported Ready Player Me avatar names the SAME joint `Hips_64`. Strip
 * the prefix from one and the uniquifier suffix from the other and they meet.
 */
const BASE_TO_VRM_BONE = Object.freeze(
  Object.entries(MIXAMO_TO_VRM).reduce((map, [mixamoName, vrmBone]) => {
    map[mixamoName.replace(/^mixamorig/i, "").toLowerCase()] = vrmBone;
    return map;
  }, {})
);

/**
 * The VRM 1.0 REQUIRED humanoid bones. If a GLB is missing any of these it is not
 * a humanoid we can drive, and we say so out loud rather than half-rigging it.
 */
const REQUIRED_VRM_BONES = Object.freeze([
  "hips",
  "spine",
  "head",
  "leftUpperArm",
  "leftLowerArm",
  "leftHand",
  "rightUpperArm",
  "rightLowerArm",
  "rightHand",
  "leftUpperLeg",
  "leftLowerLeg",
  "leftFoot",
  "rightUpperLeg",
  "rightLowerLeg",
  "rightFoot",
]);

/**
 * THE REST POSE, and why naming the bones was not enough.
 *
 * wired the GLB up believing `VRMHumanoidRig` normalised everything that
 * differs between two rigs. It does not. Read what it actually does
 * (three-vrm.module.js, VRMHumanoidRig.update):
 *
 *     rawLocal = parentRestWorld⁻¹ · q · parentRestWorld · restLocal
 *  => rawWorld = q · restWorld            <- the bone's OWN rest world rotation
 *
 * So a normalized bone's quaternion `q` is a world-space delta measured **from the
 * rig's own rest pose**. Feed it `q = identity` and you get that rig's rest back —
 * whatever pose that happens to be. It reconciles bind AXES. It does not reconcile
 * the rest POSE, and nothing else in the pipeline did either.
 *
 * Meanwhile `retarget-mocap.js` emits `q = parentRestWorld_src · q_src · restWorld_src⁻¹`
 * — a world delta measured from the **mocap source's** rest. Composing the two:
 *
 *     rawWorld_target(t) = W_source(t) · restWorld_source⁻¹ · restWorld_target
 *
 * The two rest terms cancel ONLY when the two rigs share a rest pose. Measured
 * (`baseBoneName` mapping, world rest direction of each bone, in the rig's own frame):
 *
 *     Xbot mocap source   upperArm  0.0°   lowerArm  0.0°   hand  0.0°   <- a perfect T-pose
 *     avatar-upgraded.vrm upperArm  2.7°   lowerArm  4.7°   hand  8.5°   <- a T-pose (VRM spec)
 *     Ready Player Me GLB upperArm 65.7°   lowerArm 68.9°   hand 90.8°   <- an A-POSE
 *
 * The VRM path works because the VRM *specification* mandates a T-pose rest, so the
 * terms cancel by luck of the standard. A Ready Player Me / Mixamo GLB ships an
 * A-pose, so every arm rotation in every clip was applied on top of a 66° droop —
 * and the user got arms wrenched backwards behind the back (measured: the idle hand
 * landed 0.369 m ACROSS the body and 0.130 m BEHIND the spine).
 *
 * This function reconciles the rest pose: it swings each arm bone into the VRM
 * normative T-pose so that `restWorld_target ≈ restWorld_source` and the terms
 * cancel for a GLB too.
 *
 * IT IS NOT A CORRECTION FOR ONE AVATAR. Every quantity is measured from the rig in
 * front of it:
 *   - the anatomical frame (up / left / forward) is measured from THIS rig's own
 *     hips->head and right-shoulder->left-shoulder axes, so it does not assume which
 *     way the model faces;
 *   - each bone's current rest direction is measured from THIS rig's bone positions;
 *   - the correction is the minimal-arc rotation between the two.
 * Run it on a rig that is already in a T-pose and every correction comes out ≈0° and
 * it does nothing — which is exactly what it does on the VRM, and is the control that
 * proves it is not a hardcoded quaternion.
 *
 * Minimal-arc (`setFromUnitVectors`) is a pure SWING: it carries the bone's own twist
 * along untouched rather than inventing a roll. An A-pose is authored as a swing of the
 * arm out of the T-pose, so swinging it back recovers the authored palm orientation
 * instead of overwriting it.
 *
 * Only the arm chain is normalised, because only the arm chain is where an A-pose and a
 * T-pose differ, and the VRM T-pose only pins the arms. Measured: the GLB's legs (6-9°)
 * and spine (1.5°) already sit inside the same band as the VRM control (4-5°, 7.6°) and
 * the mocap source itself (2.8-7°, 2.5°) — "correcting" them would ADD error, not remove
 * it, so they are left exactly as authored.
 */
const ARM_CHAIN = Object.freeze([
  // [bone, the humanoid child that defines its direction, side] — PARENTS FIRST: each
  // link is measured after its parent has already been swung into place.
  ["leftShoulder", "leftUpperArm", "left"],
  ["leftUpperArm", "leftLowerArm", "left"],
  ["leftLowerArm", "leftHand", "left"],
  ["leftHand", "leftMiddleProximal", "left"],
  ["rightShoulder", "rightUpperArm", "right"],
  ["rightUpperArm", "rightLowerArm", "right"],
  ["rightLowerArm", "rightHand", "right"],
  ["rightHand", "rightMiddleProximal", "right"],
]);

/**
 * Swing the arm chain into the VRM normative T-pose, IN PLACE, before the humanoid
 * snapshots its rest. Returns per-bone evidence (the angle each bone was off by), so a
 * proof can assert on it and a reviewer can see that a T-posed rig is a no-op.
 *
 * The anatomical frame it measures against is `measureAnatomicalFrame()` in retarget-mocap.js
 * ONE implementation, shared with the jump-authoring basis, so the rig's "left" can
 * never come to mean two different things in two different files. (It is called here with a
 * plain bone-map lookup because this runs BEFORE the VRMHumanoid exists — see the ordering
 * note in buildGlbHumanoid.)
 */
export function normalizeRestPoseToTPose(scene, bones) {
  const frame = measureAnatomicalFrame((name) => (bones[name] ? bones[name].node : null));
  if (!frame) {
    // Same shape as a successful run, so a consumer never has to guess. A rig we could not
    // measure is reported, not silently half-normalised.
    return {
      applied: false,
      reason: "could not measure an anatomical frame (missing hips/head/upper-arm bones)",
      corrections: {},
      residuals: {},
      skipped: [],
      max_correction_deg: 0,
      max_residual_deg: 0,
    };
  }
  scene.updateMatrixWorld(true);

  const corrections = {};
  const residuals = {};
  const skipped = [];
  const boneWorld = new THREE.Vector3();
  const childWorld = new THREE.Vector3();
  const boneQuat = new THREE.Quaternion();
  const parentQuat = new THREE.Quaternion();
  const swing = new THREE.Quaternion();

  for (const [boneName, childName, side] of ARM_CHAIN) {
    const bone = bones[boneName] && bones[boneName].node;
    const child = bones[childName] && bones[childName].node;
    if (!bone || !child) {
      // e.g. a rig with no finger bones has no leftMiddleProximal: the hand keeps its
      // authored rest and simply rides the corrected forearm. Said out loud, not hidden.
      skipped.push(`${boneName} (no ${childName} to measure its direction)`);
      continue;
    }
    bone.getWorldPosition(boneWorld);
    child.getWorldPosition(childWorld);
    const direction = childWorld.clone().sub(boneWorld);
    if (direction.lengthSq() < 1e-10) {
      skipped.push(`${boneName} (zero-length bone)`);
      continue;
    }
    direction.normalize();

    // The VRM T-pose: arms extend laterally. Measured `left`, not a hardcoded +X.
    const target = side === "left" ? frame.left : frame.left.clone().negate();
    const offBy = (Math.acos(Math.max(-1, Math.min(1, direction.dot(target)))) * 180) / Math.PI;

    // Minimal-arc world swing that carries this bone's measured direction onto the
    // normative one, then re-express it in the parent's frame.
    swing.setFromUnitVectors(direction, target);
    bone.getWorldQuaternion(boneQuat);
    if (bone.parent) bone.parent.getWorldQuaternion(parentQuat);
    else parentQuat.identity();
    bone.quaternion.copy(parentQuat.invert()).multiply(swing).multiply(boneQuat);
    // The child's world position must reflect this swing before the next link measures it.
    bone.updateMatrixWorld(true);

    // Chain-relative: measured AFTER this bone's parent was already swung into place, so
    // e.g. the RPM upper arm reads 30.7° here even though its authored rest is 65.7° off
    // the T-pose — its shoulder had already carried it 35° of the way.
    corrections[boneName] = Number(offBy.toFixed(2));

    // Self-check: re-measure the bone AFTER the swing. If the rest pose is now really a
    // T-pose this is ~0, and a proof can assert that instead of trusting the arithmetic.
    bone.getWorldPosition(boneWorld);
    child.getWorldPosition(childWorld);
    const after = childWorld.clone().sub(boneWorld).normalize();
    residuals[boneName] = Number(
      ((Math.acos(Math.max(-1, Math.min(1, after.dot(target)))) * 180) / Math.PI).toFixed(3)
    );
  }

  return {
    applied: Object.keys(corrections).length > 0,
    corrections,
    residuals,
    skipped,
    max_correction_deg: Object.values(corrections).reduce((m, d) => Math.max(m, d), 0),
    max_residual_deg: Object.values(residuals).reduce((m, d) => Math.max(m, d), 0),
    reason: null,
  };
}

/**
 * THE LEG BIND SPLAY, and why the arm fix left it behind.
 *
 * measured, on the SHIPPED rigs, that the Ready Player Me GLBs (the default avatar and
 * the whole selector roster) bind with the feet already SPLAYED — 1.43–1.62× hip width
 * at rest (an A-stance authored INTO the rig). `normalizeRestPoseToTPose` above deliberately
 * corrects only the ARM chain (the VRM T-pose only pins the arms) and leaves the legs exactly
 * as authored — so that bind splay survives into every retargeted clip and STACKS on top of the
 * Mixamo source idle's own ~8.7° abduction, giving the widest idle stances on the roster
 * (foot/hip 2.44–2.90 vs the VRM band of ~1.8–2.1). This function removes THAT component — the
 * rig-authored bind splay — and nothing else.
 *
 * IT IS STRICTLY CORONAL. A leg has two independent bind DOFs in the body's own anatomy:
 *   - CORONAL / abduction  — the left↔right splay, a rotation about the rig's FORWARD axis;
 *   - SAGITTAL / flexion    — the fore↔aft lean (which way, and how far, the knee is bent), a
 *                             rotation about the rig's LEFT axis.
 * pinned the SAGITTAL plane (a knee is a hinge with ONE legal bend direction and must
 * never hyperextend). This function must not disturb it. So it corrects ONLY the coronal DOF:
 * it swings each UPPER LEG about the rig's own measured FORWARD axis until the leg line
 * (hip→foot) has ZERO lateral offset — the foot directly under the hip — while the leg's
 * fore/aft (sagittal) component is preserved EXACTLY, because a rotation about the forward axis
 * cannot change any vector's forward component. The whole leg subtree (knee, foot) rotates
 * rigidly, so the knee's own flexion angle and its anterior/posterior orientation are carried
 * along untouched. `sagittal_before` / `sagittal_after` are returned so a proof can assert the
 * fore/aft lean did not move — the evidence that this is coronal-only, not a general leg
 * re-orientation.
 *
 * IT IS MEASURED PER RIG, LIKE THE ARM SWING. Every quantity is read off the rig in front of
 * it: the anatomical frame (`measureAnatomicalFrame`, the SAME basis the arm fix and the
 * jump author use), the leg's own hip→foot direction, and the minimal coronal arc between that
 * and vertical. On a rig already bound with the feet under the hips (the VRM-native avatars, and
 * the two vrchat GLBs) the coronal offset is ~0 and every correction comes out ≈0° — a true
 * no-op, exactly as the arm swing is a no-op on an already-T-posed rig. Nothing here is a
 * hardcoded angle; a hardcoded rotation could not be ~0 on a vertical rig and ~3.7° on a splayed
 * one from the same code.
 *
 * Only the UPPER LEG is swung (one bone per side), not the whole chain: the goal is to move the
 * foot under the hip while keeping the leg's authored internal shape, and a single rigid rotation
 * of the thigh does exactly that. Swinging the lower leg or foot as well would start editing the
 * knee/ankle — the sagittal anatomy this function is forbidden to touch.
 */
export function normalizeLegBindCoronal(scene, bones) {
  const frame = measureAnatomicalFrame((name) => (bones[name] ? bones[name].node : null));
  if (!frame) {
    return {
      applied: false,
      reason: "could not measure an anatomical frame (missing hips/head/upper-arm bones)",
      corrections: {},
      residuals: {},
      sagittal_before: {},
      sagittal_after: {},
      skipped: [],
      max_correction_deg: 0,
      max_residual_deg: 0,
      max_sagittal_drift_deg: 0,
    };
  }
  scene.updateMatrixWorld(true);

  const clampUnit = (x) => Math.max(-1, Math.min(1, x));
  const toDeg = (r) => (r * 180) / Math.PI;

  const corrections = {};
  const residuals = {};
  const sagittalBefore = {};
  const sagittalAfter = {};
  const skipped = [];
  const hipWorld = new THREE.Vector3();
  const footWorld = new THREE.Vector3();
  const boneQuat = new THREE.Quaternion();
  const parentQuat = new THREE.Quaternion();
  const swing = new THREE.Quaternion();

  for (const side of ["left", "right"]) {
    const upperLegName = `${side}UpperLeg`;
    const footName = `${side}Foot`;
    const upperLeg = bones[upperLegName] && bones[upperLegName].node;
    const foot = bones[footName] && bones[footName].node;
    if (!upperLeg || !foot) {
      skipped.push(`${upperLegName} (no ${footName} to measure the leg line)`);
      continue;
    }
    upperLeg.getWorldPosition(hipWorld);
    foot.getWorldPosition(footWorld);
    const leg = footWorld.clone().sub(hipWorld);
    if (leg.lengthSq() < 1e-10) {
      skipped.push(`${upperLegName} (zero-length leg line)`);
      continue;
    }
    leg.normalize();

    // Decompose the leg line in the rig's OWN anatomy. The forward (sagittal) component is the
    // fore/aft lean; we PRESERVE it exactly. Everything we touch lives in the coronal plane.
    const sagittal = leg.dot(frame.forward);
    sagittalBefore[side] = Number(toDeg(Math.asin(clampUnit(sagittal))).toFixed(3));

    // The leg line projected into the coronal plane (forward component dropped). Both this and
    // the target lie in the (left, up) plane, so the swing between them is a PURE rotation about
    // the forward axis — it is arithmetically incapable of tilting the leg fore or aft.
    const coronal = leg.clone().addScaledVector(frame.forward, -sagittal);
    if (coronal.lengthSq() < 1e-8) {
      // A leg lying along the sagittal axis has no coronal splay to correct.
      skipped.push(`${upperLegName} (leg lies on the sagittal axis; no coronal DOF)`);
      sagittalAfter[side] = sagittalBefore[side];
      continue;
    }
    coronal.normalize();
    // A leg points DOWN, so its coronal projection leans toward -up; the abduction-free target
    // is straight down (same vertical sign, lateral component nulled): the foot under the hip.
    const verticalSign = Math.sign(coronal.dot(frame.up)) || -1;
    const target = frame.up.clone().multiplyScalar(verticalSign);

    corrections[side] = Number(toDeg(Math.acos(clampUnit(coronal.dot(target)))).toFixed(3));

    swing.setFromUnitVectors(coronal, target);
    upperLeg.getWorldQuaternion(boneQuat);
    if (upperLeg.parent) upperLeg.parent.getWorldQuaternion(parentQuat);
    else parentQuat.identity();
    upperLeg.quaternion.copy(parentQuat.invert()).multiply(swing).multiply(boneQuat);
    upperLeg.updateMatrixWorld(true);

    // Re-measure AFTER the swing. The lateral splay must now read ~0 (residual), and the fore/aft
    // lean must be UNCHANGED — the two numbers a proof asserts to see this was coronal-only.
    upperLeg.getWorldPosition(hipWorld);
    foot.getWorldPosition(footWorld);
    const after = footWorld.clone().sub(hipWorld).normalize();
    const sagittalAfterVal = after.dot(frame.forward);
    sagittalAfter[side] = Number(toDeg(Math.asin(clampUnit(sagittalAfterVal))).toFixed(3));
    const afterCoronal = after.clone().addScaledVector(frame.forward, -sagittalAfterVal);
    residuals[side] =
      afterCoronal.lengthSq() < 1e-8
        ? 0
        : Number(toDeg(Math.acos(clampUnit(afterCoronal.normalize().dot(target)))).toFixed(3));
  }

  const sides = Object.keys(corrections);
  return {
    applied: sides.length > 0,
    corrections,
    residuals,
    sagittal_before: sagittalBefore,
    sagittal_after: sagittalAfter,
    skipped,
    max_correction_deg: Object.values(corrections).reduce((m, d) => Math.max(m, d), 0),
    max_residual_deg: Object.values(residuals).reduce((m, d) => Math.max(m, d), 0),
    max_sagittal_drift_deg: sides.reduce(
      (m, s) => Math.max(m, Math.abs(sagittalAfter[s] - sagittalBefore[s])),
      0
    ),
    reason: null,
  };
}

/**
 * Reduce an exporter-mangled joint name to the bare Mixamo bone name.
 *
 *   "mixamorig:Hips" (sanitized by GLTFLoader to "mixamorigHips") -> "hips"
 *   "Hips_64"        (Sketchfab uniquifier)                       -> "hips"
 *   "Spine1_52"                                                   -> "spine1"
 *   "HeadTop_End_0"                                               -> "headtop_end"  (unmapped, correctly)
 *
 * The `_\d+$` guard is load-bearing: it must strip the trailing `_52` from
 * `Spine1_52` WITHOUT eating the meaningful `1` in `Spine1`.
 */
export function baseBoneName(name) {
  return String(name || "")
    .replace(/^mixamorig[:_]?/i, "")
    .replace(/_\d+$/, "")
    .toLowerCase();
}

/**
 * Build a three-vrm `VRMHumanoid` over a Mixamo-named GLB skeleton.
 *
 * @param {import("three").Object3D} scene  the loaded glTF scene root
 * @returns {{
 *   ok: boolean,
 *   humanoid: import("@pixiv/three-vrm").VRMHumanoid | null,
 *   mappedBoneCount: number,
 *   mappedBones: Record<string,string>,
 *   missingRequiredBones: string[],
 *   skinnedMeshCount: number,
 *   reason: string | null,
 * }}
 */
export function buildGlbHumanoid(scene, { normalizeRestPose = true, normalizeLegBind = true } = {}) {
  const mappedBones = {};
  const humanBones = {};
  let skinnedMeshCount = 0;

  // Bind poses must be current before VRMHumanoidRig snapshots the rest pose from
  // the bones' world matrices — it reads matrixWorld, not the local transforms.
  scene.updateMatrixWorld(true);

  // Depth-first pre-order, so an ancestor always wins a name collision over a
  // descendant. Only real THREE.Bone nodes (i.e. actual skin joints) are eligible:
  // a stray mesh called "Head" must never be mistaken for the head bone.
  scene.traverse((node) => {
    if (node.isSkinnedMesh) skinnedMeshCount += 1;
    if (!node.isBone) return;
    const vrmBone = BASE_TO_VRM_BONE[baseBoneName(node.name)];
    if (!vrmBone || humanBones[vrmBone]) return;
    humanBones[vrmBone] = { node };
    mappedBones[vrmBone] = node.name;
  });

  const missingRequiredBones = REQUIRED_VRM_BONES.filter((bone) => !humanBones[bone]);
  const mappedBoneCount = Object.keys(humanBones).length;

  if (skinnedMeshCount === 0) {
    return {
      ok: false,
      humanoid: null,
      mappedBoneCount,
      mappedBones,
      missingRequiredBones,
      skinnedMeshCount,
      reason: "GLB has no SkinnedMesh — there is no skeleton to drive",
    };
  }
  if (missingRequiredBones.length) {
    return {
      ok: false,
      humanoid: null,
      mappedBoneCount,
      mappedBones,
      missingRequiredBones,
      skinnedMeshCount,
      reason: `GLB skeleton is missing required humanoid bones: ${missingRequiredBones.join(", ")}`,
    };
  }

  // RECONCILE THE REST POSE BEFORE THE HUMANOID SNAPSHOTS IT.
  //
  // ORDER IS LOAD-BEARING. VRMHumanoidRig captures each bone's rest (its local
  // quaternion and its parent's world rotation) inside the VRMHumanoid constructor,
  // from the bones' CURRENT world matrices. Normalising after construction would
  // change the skeleton the rig no longer reads. It must happen here, one line early.
  //
  // `normalizeRestPose: false` reproduces the exact pre- (broken) build. It exists
  // so the proof's --negative mode can turn THE REAL FIX off and show the assertions go
  // red, rather than approximating the bug. Production never passes it.
  const restPoseNormalization = normalizeRestPose
    ? normalizeRestPoseToTPose(scene, humanBones)
    : { applied: false, corrections: {}, skipped: [], max_correction_deg: 0, reason: "DISABLED (--negative falsification mode)" };
  scene.updateMatrixWorld(true);

  // RECONCILE THE LEG BIND SPLAY (CORONAL ONLY), same ordering rule as the arms:
  // it must run BEFORE VRMHumanoid snapshots the rest, and after the arm swing has settled the
  // frame. It is strictly the coronal/abduction DOF, so the sagittal knee anatomy pinned
  // is untouched; a leg already bound vertical is a measured no-op. `normalizeLegBind: false`
  // isolates this fix for the before/after proof — production never passes it.
  const legBindNormalization = normalizeLegBind
    ? normalizeLegBindCoronal(scene, humanBones)
    : {
        applied: false,
        corrections: {},
        residuals: {},
        sagittal_before: {},
        sagittal_after: {},
        skipped: [],
        max_correction_deg: 0,
        max_residual_deg: 0,
        max_sagittal_drift_deg: 0,
        reason: "DISABLED (runtime isolation/measurement mode)",
      };
  scene.updateMatrixWorld(true);

  const humanoid = new VRMHumanoid(humanBones);
  // The one wiring step VRMHumanoidLoaderPlugin performs: the normalized rig must
  // live INSIDE the model, so it inherits the model's variant scale/rotation and
  // its bones' world transforms coincide with the raw bones they drive.
  scene.add(humanoid.normalizedHumanBonesRoot);

  return {
    ok: true,
    humanoid,
    mappedBoneCount,
    mappedBones,
    missingRequiredBones: [],
    skinnedMeshCount,
    restPoseNormalization,
    legBindNormalization,
    reason: null,
  };
}

/**
 * Wrap a Mixamo-named GLB as a VRM-shaped avatar object.
 *
 * The returned facade exposes exactly the surface `avatar-equipment-layer.js` and
 * `retarget-mocap.js` consume from a real three-vrm `VRM`:
 *
 *   .scene      — the model root the AnimationMixer is rooted at
 *   .humanoid   — getNormalizedBoneNode / getRawBoneNode / normalizedRestPose
 *   .meta       — metaVersion "1": a glTF/Mixamo rig shares the mocap source's
 *                 handedness, so the VRM0 X/Z mirror in retargetOne() must NOT fire
 *   .update(dt) — copies the animated normalized pose onto the raw skeleton
 *
 * @returns {object|null} the facade, or null if the GLB is not a drivable humanoid
 *                        (the caller then falls back to the static-GLB path and
 *                        reports honestly WHY, via `.glbHumanoidReport`).
 */
export function createGlbHumanoidAvatar(scene, options = {}) {
  const report = buildGlbHumanoid(scene, options);
  if (!report.ok) return { avatar: null, report };

  const avatar = {
    scene,
    humanoid: report.humanoid,
    // A Mixamo-topology glTF rig has the same axis convention as the Xbot mocap
    // source, so it is NOT a VRM0-style mirrored rig. Declaring "1" here is what
    // keeps retargetOne() from negating quaternion x/z and inverting the walk.
    meta: { metaVersion: "1", metaSource: "glb-mixamo-humanoid-facade" },
    isGlbHumanoid: true,
    glbHumanoidReport: report,
    update() {
      report.humanoid.update();
    },
  };
  return { avatar, report };
}

export { BASE_TO_VRM_BONE, REQUIRED_VRM_BONES };
