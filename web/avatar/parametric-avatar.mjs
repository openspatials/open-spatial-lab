/**
 * parametric-avatar.mjs —: parametric avatar render engine.
 *
 * WHAT THIS IS
 *   A self-contained engine that generates a humanoid avatar AT RUNTIME from a
 *   parameter set (`AvatarParams`) instead of loading a pre-baked VRM/GLB:
 *
 *     1. H-Anim skeleton — a THREE.Bone hierarchy using ISO/IEC 19774 joint
 *        names and parentage (humanoid_root, sacroiliac, vl5…vt12…vt6…vt1,
 *        vc4, skullbase, l/r_sternoclavicular→shoulder→elbow→wrist, fingers,
 *        l/r_hip→knee→ankle→metatarsal). Reduced articulation follows H-Anim
 *        LOA practice: omitted intermediate joints (vl4–vl1, vt11–vt7, vt5–vt2,
 *        vc7–vc5, vc3–vc1, acromioclavicular, subtalar/midtarsal, *_0 finger
 *        metacarpals) collapse into their nearest included ancestor, so the
 *        parent-ordering of the 19774 hierarchy is preserved.
 *     2. Parametric body — an indexed, skinned BufferGeometry (torso/limb/
 *        hand/foot tubes + head ellipsoid) generated from the params: overall
 *        stature, segment-proportion multipliers, shoulder/hip width, girths,
 *        optional per-joint bone scales, and appearance colors. NOT a fixed
 *        mesh asset; every vertex is computed from the parameter set.
 *     3. Retarget compatibility — the rig is built so the demo's EXISTING
 *        mocap pipeline (web/retarget-mocap.js, the canonical three-vrm
 *        world-rest retarget of the Xbot mixamo clips) binds to it unchanged:
 *          - every joint has IDENTITY rest rotation (pure translation offsets),
 *            the same convention as the three-vrm NORMALIZED humanoid rig the
 *            pipeline normally targets;
 *          - the rest pose is a T-pose whose segment WORLD directions match
 *            the mocap source's rest directions (measured from Xbot.glb:
 *            facing +Z, left = +X, arms along ±X, legs -Y, feet ~+Z), which is
 *            the exact condition for `q_out = parentRestWorld · q · restWorld⁻¹`
 *            deltas to land correctly on a rig with identity rest rotations;
 *          - `meta.metaVersion` is NOT "0", so the VRM0 X/Z mirror stays off
 *            (this rig already faces the mocap-source direction; the variant
 *            entry uses rotation_y = 0 where the VRM0 avatars need PI).
 *     4. VRM-facade — createParametricAvatar() returns an object exposing the
 *        exact surface the demo consumes from three-vrm (`scene`, `meta`,
 *        `humanoid.getRawBoneNode/getNormalizedBoneNode/normalizedRestPose`,
 *        `update(dt)`), so avatar-equipment-layer.js, equipment attach,
 * visual grounding (Box3 sole + skeleton boneInverses), and the
 *        first-person head-bone camera all work without modification. On this
 *        rig raw === normalized (there is ONE skeleton; no proxy rig to
 *        propagate), so update() is a no-op and both bone getters return the
 *        same THREE.Bone.
 *
 * WHY (UM/RP1 program)
 *   The UM portaling target is "destination reads
 *   H-Anim skeleton reference + parametric body data and generates the mesh
 *   locally" — the avatar is a function of portable manifest data, not a
 *   shipped asset. This module is that local generator. The UM avatar facet
 *   (`metaverse.avatar` / `portableIdentity.avatar` pointers; the future
 *   avatarDefinition facet) does not yet have a normative parameter schema,
 *   so the engine consumes the PROVISIONAL `AvatarParams` interface below and
 *   leaves the manifest binding as the documented seam (see
 *   paramsFromAvatarFacet).
 *
 * HONESTY BOUNDARY
 *   - H-Anim claim: joint NAMES + hierarchy parentage follow ISO/IEC
 *     19774:2006 at a reduced (LOA-style) articulation. No 19774 conformance
 *     claim is made (no formal Humanoid object model, no site/displacer
 *     support, no LOA certification).
 *   - AvatarParams is provisional and versioned; it is NOT (yet) the UM
 *     avatar facet. The facet→params adapter is an unwired stub by design.
 *   - Finger joints exist and receive retargeted tracks, but the hand is
 *     rendered as a simplified mitten volume (subtle curl only).
 */

import * as THREE from "../vendor/scene-core/vendor/three/three.module.js";

export const PARAMETRIC_AVATAR_VERSION = "0.1.0-runtime";

/* ========================================================================== *
 *  1. AvatarParams — the PROVISIONAL parameter interface
 * ========================================================================== */

/**
 * @typedef {Object} AvatarParams
 *   The parameter set the engine consumes. All fields optional; unspecified
 *   fields take DEFAULT_AVATAR_PARAMS values, and every numeric field is
 *   clamped to the documented safe range by resolveAvatarParams().
 *
 * @property {string} id        Stable identifier for this parameter set.
 * @property {string} label     Human-readable display label.
 * @property {string} skeleton  Skeleton family. Fixed: "hanim:iso-iec-19774".
 * @property {number} heightM   Total stature, ground → top of head, meters.
 *                              Authoritative: proportion changes redistribute
 *                              WITHIN this height. Range [0.5, 3.0].
 *
 * @property {Object} proportions  Unitless segment multipliers, range [0.4, 2.5]:
 *   @property {number} proportions.legLength     thigh+shin length multiplier
 *   @property {number} proportions.armLength     upper+forearm length multiplier
 *   @property {number} proportions.torsoLength   pelvis→head spine-chain multiplier
 *   @property {number} proportions.shoulderWidth lateral shoulder offset multiplier
 *   @property {number} proportions.hipWidth      lateral hip-socket offset multiplier
 *
 * @property {Object} build  Volume/girth multipliers, range [0.4, 2.5]:
 *   @property {number} build.chestGirth  chest/upper-torso radii
 *   @property {number} build.waistGirth  waist radii
 *   @property {number} build.hipGirth    pelvis radii
 *   @property {number} build.armGirth    arm tube radii
 *   @property {number} build.legGirth    leg tube radii
 *   @property {number} build.headSize    head volume (participates in stature)
 *
 * @property {Object.<string, number>} boneScales
 *   Optional fine-grained control, keyed by H-Anim joint name: multiplies the
 *   joint's rest OFFSET from its parent (i.e. scales the bone segment that
 *   ENDS at that joint). Example: { l_knee: 1.2, r_knee: 1.2 } lengthens the
 *   thighs. Applied before stature renormalization. Range [0.4, 2.5].
 *
 * @property {Object} appearance  Hex color strings:
 *   @property {string} appearance.skinColor
 *   @property {string} appearance.topColor     torso + arms
 *   @property {string} appearance.bottomColor  legs
 *   @property {string} appearance.shoeColor    feet
 *   @property {string} appearance.eyeColor
 */

export const DEFAULT_AVATAR_PARAMS = Object.freeze({
  id: "default",
  label: "Parametric humanoid (default)",
  skeleton: "hanim:iso-iec-19774",
  heightM: 1.7,
  proportions: Object.freeze({
    legLength: 1,
    armLength: 1,
    torsoLength: 1,
    shoulderWidth: 1,
    hipWidth: 1,
  }),
  build: Object.freeze({
    chestGirth: 1,
    waistGirth: 1,
    hipGirth: 1,
    armGirth: 1,
    legGirth: 1,
    headSize: 1,
  }),
  boneScales: Object.freeze({}),
  appearance: Object.freeze({
    skinColor: "#c9976b",
    topColor: "#4f7fc4",
    bottomColor: "#333c50",
    shoeColor: "#22262e",
    eyeColor: "#161b22",
  }),
});

const clamp = (v, lo, hi, dflt) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
};

/** Merge a partial AvatarParams onto the defaults and clamp to safe ranges. */
export function resolveAvatarParams(partial) {
  const p = partial && typeof partial === "object" ? partial : {};
  const d = DEFAULT_AVATAR_PARAMS;
  const mul = (v, dflt) => clamp(v, 0.4, 2.5, dflt);
  const group = (src, defaults) => {
    const out = {};
    for (const [k, dv] of Object.entries(defaults)) out[k] = mul(src && src[k], dv);
    return out;
  };
  const boneScales = {};
  if (p.boneScales && typeof p.boneScales === "object") {
    for (const [joint, v] of Object.entries(p.boneScales)) {
      if (HANIM_PARENT[joint] !== undefined) boneScales[joint] = mul(v, 1);
    }
  }
  const appearance = {};
  for (const [k, dv] of Object.entries(d.appearance)) {
    const v = p.appearance && typeof p.appearance[k] === "string" ? p.appearance[k] : dv;
    appearance[k] = /^#[0-9a-fA-F]{6}$/.test(v) ? v : dv;
  }
  return {
    id: typeof p.id === "string" && p.id ? p.id : d.id,
    label: typeof p.label === "string" && p.label ? p.label : d.label,
    skeleton: d.skeleton, // fixed — this engine only builds H-Anim rigs
    heightM: clamp(p.heightM, 0.5, 3.0, d.heightM),
    proportions: group(p.proportions, d.proportions),
    build: group(p.build, d.build),
    boneScales,
    appearance,
  };
}

/* ========================================================================== *
 * SEAM: UM avatar-facet → AvatarParams adapter (STUB — NOT WIRED)
 * ========================================================================== */

/**
 * SEAM: contract for the manifest-facet binding, published so
 * can target it. The v0.1 UM registry defines only pointer NAMES
 * (`metaverse.avatar`, `portableIdentity.avatar` — "canonical avatar asset or
 * descriptor reference"); the concrete avatarDefinition facet schema is a
 * v0.4-delta deliverable. Field names here are therefore
 * PROVISIONAL.
 */
export const feature_SEAM_CONTRACT = Object.freeze({
  seam: "runtime",
  status: "stub-not-wired",
  implement: "paramsFromAvatarFacet(facet) in web/avatar/parametric-avatar.mjs",
  input:
    "the manifest's avatar-definition facet (provisional pointers: metaverse.avatar / " +
    "portableIdentity.avatar; expected fields: skeleton reference (H-Anim), stature/height, " +
    "body proportion + shape parameters, appearance descriptors)",
  output:
    "AvatarParams (see typedef) — pass through resolveAvatarParams(); " +
    "createParametricAvatar(params) then renders the avatar locally",
  rule:
    "THIN mapping only: no rendering logic in the adapter, no facet parsing in the engine. " +
    "Unknown/missing facet fields fall back to DEFAULT_AVATAR_PARAMS via resolveAvatarParams().",
});

// SEAM: thin adapter from the UM manifest's avatar facet to AvatarParams.
// INTENTIONALLY UNWIRED (returns null): the avatarDefinition facet interface is
// defined against the v0.4 delta. When it lands, implement
// the field mapping here per feature_SEAM_CONTRACT and nothing else changes —
// callers already fall back to explicit params/presets when this returns null.
export function paramsFromAvatarFacet(_facet) {
  return null; // SEAM: not wired yet (do not guess at facet field names)
}

/* ========================================================================== *
 *  2. H-Anim (ISO/IEC 19774) skeleton
 * ========================================================================== */

/**
 * H-Anim joint → parent joint (ISO/IEC 19774:2006 naming + parent ordering,
 * reduced articulation; see module header). humanoid_root is the moving root
 * ("humanoid_root : sacrum") and carries the mocap pelvis tracks.
 */
export const HANIM_PARENT = Object.freeze({
  humanoid_root: null,
  sacroiliac: "humanoid_root",
  l_hip: "sacroiliac",
  l_knee: "l_hip",
  l_ankle: "l_knee",
  l_metatarsal: "l_ankle",
  r_hip: "sacroiliac",
  r_knee: "r_hip",
  r_ankle: "r_knee",
  r_metatarsal: "r_ankle",
  vl5: "humanoid_root",
  vt12: "vl5",
  vt6: "vt12",
  vt1: "vt6",
  vc4: "vt1",
  skullbase: "vc4",
  l_sternoclavicular: "vt1",
  l_shoulder: "l_sternoclavicular",
  l_elbow: "l_shoulder",
  l_wrist: "l_elbow",
  l_thumb1: "l_wrist",
  l_thumb2: "l_thumb1",
  l_thumb3: "l_thumb2",
  l_index1: "l_wrist",
  l_index2: "l_index1",
  l_index3: "l_index2",
  l_middle1: "l_wrist",
  l_middle2: "l_middle1",
  l_middle3: "l_middle2",
  l_ring1: "l_wrist",
  l_ring2: "l_ring1",
  l_ring3: "l_ring2",
  l_pinky1: "l_wrist",
  l_pinky2: "l_pinky1",
  l_pinky3: "l_pinky2",
  r_sternoclavicular: "vt1",
  r_shoulder: "r_sternoclavicular",
  r_elbow: "r_shoulder",
  r_wrist: "r_elbow",
  r_thumb1: "r_wrist",
  r_thumb2: "r_thumb1",
  r_thumb3: "r_thumb2",
  r_index1: "r_wrist",
  r_index2: "r_index1",
  r_index3: "r_index2",
  r_middle1: "r_wrist",
  r_middle2: "r_middle1",
  r_middle3: "r_middle2",
  r_ring1: "r_wrist",
  r_ring2: "r_ring1",
  r_ring3: "r_ring2",
  r_pinky1: "r_wrist",
  r_pinky2: "r_pinky1",
  r_pinky3: "r_pinky2",
});

export const HANIM_JOINT_NAMES = Object.freeze(Object.keys(HANIM_PARENT));

/**
 * VRM-humanoid bone name → H-Anim joint. This is the demo's retarget surface:
 * retarget-mocap.js resolves these VRM names via humanoid.getNormalizedBoneNode
 * and binds the mocap tracks to the returned nodes.
 * NOTE `hips → humanoid_root`: in H-Anim the spine (vl5) and pelvis
 * (sacroiliac) are SIBLINGS under humanoid_root, so the mocap pelvis tracks
 * must land on humanoid_root for the whole body to inherit them (in VRM/mixamo
 * rigs "hips" parents both chains; humanoid_root plays that role here).
 */
export const VRM_TO_HANIM = Object.freeze({
  hips: "humanoid_root",
  spine: "vl5",
  chest: "vt12",
  upperChest: "vt6",
  neck: "vc4",
  head: "skullbase",
  leftShoulder: "l_sternoclavicular",
  leftUpperArm: "l_shoulder",
  leftLowerArm: "l_elbow",
  leftHand: "l_wrist",
  leftThumbMetacarpal: "l_thumb1",
  leftThumbProximal: "l_thumb2",
  leftThumbDistal: "l_thumb3",
  leftIndexProximal: "l_index1",
  leftIndexIntermediate: "l_index2",
  leftIndexDistal: "l_index3",
  leftMiddleProximal: "l_middle1",
  leftMiddleIntermediate: "l_middle2",
  leftMiddleDistal: "l_middle3",
  leftRingProximal: "l_ring1",
  leftRingIntermediate: "l_ring2",
  leftRingDistal: "l_ring3",
  leftLittleProximal: "l_pinky1",
  leftLittleIntermediate: "l_pinky2",
  leftLittleDistal: "l_pinky3",
  rightShoulder: "r_sternoclavicular",
  rightUpperArm: "r_shoulder",
  rightLowerArm: "r_elbow",
  rightHand: "r_wrist",
  rightThumbMetacarpal: "r_thumb1",
  rightThumbProximal: "r_thumb2",
  rightThumbDistal: "r_thumb3",
  rightIndexProximal: "r_index1",
  rightIndexIntermediate: "r_index2",
  rightIndexDistal: "r_index3",
  rightMiddleProximal: "r_middle1",
  rightMiddleIntermediate: "r_middle2",
  rightMiddleDistal: "r_middle3",
  rightRingProximal: "r_ring1",
  rightRingIntermediate: "r_ring2",
  rightRingDistal: "r_ring3",
  rightLittleProximal: "r_pinky1",
  rightLittleIntermediate: "r_pinky2",
  rightLittleDistal: "r_pinky3",
  leftUpperLeg: "l_hip",
  leftLowerLeg: "l_knee",
  leftFoot: "l_ankle",
  leftToes: "l_metatarsal",
  rightUpperLeg: "r_hip",
  rightLowerLeg: "r_knee",
  rightFoot: "r_ankle",
  rightToes: "r_metatarsal",
});

/**
 * Rest-pose anchor table: joint world positions as FRACTIONS of stature,
 * measured from the demo's actual mocap source rig (Xbot.glb, 1.775 m,
 * T-pose facing +Z, left = +X). Matching the SOURCE's rest segment
 * directions is what makes the world-rest retarget land correctly on this
 * identity-rest rig — so these fractions are calibration data, not style.
 * Only LEFT-side entries are stored; right side mirrors x.
 */
const REST_FRACTIONS = {
  humanoid_root: [0, 0.5859, 0.0117],
  sacroiliac: [0, 0.5757, 0.0117],
  l_hip: [0.0462, 0.5476, 0.0028],
  l_knee: [0.0462, 0.298, 0.0045],
  l_ankle: [0.0462, 0.0473, -0.0124],
  l_metatarsal: [0.0462, -0.0015, 0.0479],
  vl5: [0, 0.6434, 0.0124],
  vt12: [0, 0.7003, 0.0068],
  vt6: [0, 0.7515, -0.0011],
  vt1: [0, 0.8028, -0.0146],
  vc4: [0, 0.8451, -0.0152],
  skullbase: [0, 0.8992, -0.0056],
  l_sternoclavicular: [0.0259, 0.8129, -0.0158],
  l_shoulder: [0.0856, 0.8101, -0.0282],
  l_elbow: [0.2425, 0.8101, -0.0282],
  l_wrist: [0.4021, 0.8101, -0.0282],
};
// finger anchors RELATIVE TO the wrist (fractions of stature; +X = distal)
const FINGER_BASE_LOCAL = {
  thumb1: [0.0141, -0.009, 0.0152],
  index1: [0.0513, -0.0028, 0.0124],
  middle1: [0.0541, 0.0, 0.0],
  ring1: [0.0513, -0.0011, -0.0124],
  pinky1: [0.045, -0.0028, -0.0236],
};
const THUMB_DIR = [0.775, -0.447, 0.447]; // Xbot thumb chain direction (left)
const FINGER_SEGMENTS = {
  thumb: [0.0235, 0.0193],
  index: [0.0207, 0.0173],
  middle: [0.0208, 0.0175],
  ring: [0.019, 0.016],
  pinky: [0.0155, 0.013],
};
const HEAD_TOP_FRACTION = 1.0; // skullbase→crown span completes the stature
const HEAD_HEIGHT_FRACTION = HEAD_TOP_FRACTION - REST_FRACTIONS.skullbase[1]; // 0.1008

/**
 * Compute the rest layout: Map<joint, THREE.Vector3 world position (meters)>
 * plus derived anchors, applying the parameter set:
 *   1. base fractions (Xbot-calibrated T-pose),
 *   2. proportion multipliers (leg/arm/torso lengths, shoulder/hip widths),
 *   3. per-joint boneScales on parent-relative offsets,
 *   4. stature renormalization so crown height == heightM exactly.
 */
export function computeSkeletonLayout(params) {
  const P = params.proportions;
  const f = {};
  for (const [name, v] of Object.entries(REST_FRACTIONS)) f[name] = v.slice();

  // --- proportions on the unit-fraction table (world-anchored, then rebuilt) ---
  // legs: scale thigh+shin about the fixed ankle height; pelvis + torso ride up/down.
  const ankleY = f.l_ankle[1];
  const shin = (f.l_knee[1] - f.l_ankle[1]) * P.legLength;
  const thigh = (f.l_hip[1] - f.l_knee[1]) * P.legLength;
  const newHipY = ankleY + shin + thigh;
  const pelvisLift = newHipY - f.l_hip[1];
  f.l_knee[1] = ankleY + shin;
  f.l_hip[1] = newHipY;
  for (const name of ["humanoid_root", "sacroiliac", "vl5", "vt12", "vt6", "vt1", "vc4", "skullbase", "l_sternoclavicular", "l_shoulder", "l_elbow", "l_wrist"]) {
    f[name][1] += pelvisLift;
  }
  // torso: scale the spine deltas above the root; everything anchored to vt1 rides.
  const spineChain = ["vl5", "vt12", "vt6", "vt1", "vc4", "skullbase"];
  let prevY = f.humanoid_root[1];
  let acc = f.humanoid_root[1];
  for (const name of spineChain) {
    const delta = (f[name][1] - prevY) * P.torsoLength;
    prevY = f[name][1];
    acc += delta;
    f[name][1] = acc;
  }
  // shoulders track vt1 (clavicle anchors stay a fixed drop below vt1's new y)
  const shoulderDropSC = 0.8028 - 0.8129; // vt1.y - sternoclavicular.y at base
  const shoulderDropSH = 0.8028 - 0.8101;
  f.l_sternoclavicular[1] = f.vt1[1] - shoulderDropSC;
  f.l_shoulder[1] = f.vt1[1] - shoulderDropSH;
  f.l_elbow[1] = f.l_shoulder[1];
  f.l_wrist[1] = f.l_shoulder[1];
  // widths
  f.l_hip[0] *= P.hipWidth;
  f.l_sternoclavicular[0] *= P.shoulderWidth;
  f.l_shoulder[0] = 0.0856 * P.shoulderWidth;
  // arms: scale segment lengths outward from the (possibly shifted) shoulder.
  const upperArm = (0.2425 - 0.0856) * P.armLength;
  const foreArm = (0.4021 - 0.2425) * P.armLength;
  f.l_elbow[0] = f.l_shoulder[0] + upperArm;
  f.l_wrist[0] = f.l_elbow[0] + foreArm;
  // legs keep knee/ankle/toes under the (possibly widened) hip socket
  f.l_knee[0] = f.l_hip[0];
  f.l_ankle[0] = f.l_hip[0];
  f.l_metatarsal[0] = f.l_hip[0];

  // --- assemble full joint world table (fractions), fingers off the wrist ---
  const world = new Map();
  const setV = (name, arr) => world.set(name, new THREE.Vector3(arr[0], arr[1], arr[2]));
  for (const [name, v] of Object.entries(f)) setV(name, v);
  const armLenMul = P.armLength;
  const addFingers = (side, sign) => {
    const wrist = world.get(`${side}_wrist`);
    for (const finger of ["thumb", "index", "middle", "ring", "pinky"]) {
      const base = FINGER_BASE_LOCAL[`${finger}1`];
      const b = new THREE.Vector3(sign * base[0] * armLenMul, base[1], base[2]).add(wrist);
      world.set(`${side}_${finger}1`, b);
      const segs = FINGER_SEGMENTS[finger];
      const dir =
        finger === "thumb"
          ? new THREE.Vector3(sign * THUMB_DIR[0], THUMB_DIR[1], THUMB_DIR[2]).normalize()
          : new THREE.Vector3(sign, 0, 0);
      const j2 = b.clone().addScaledVector(dir, segs[0] * armLenMul);
      const j3 = j2.clone().addScaledVector(dir, segs[1] * armLenMul);
      world.set(`${side}_${finger}2`, j2);
      world.set(`${side}_${finger}3`, j3);
    }
  };
  addFingers("l", 1);
  // right side mirrors left (x → -x) for every l_* joint incl. fingers
  for (const name of HANIM_JOINT_NAMES) {
    if (!name.startsWith("r_")) continue;
    const leftName = `l_${name.slice(2)}`;
    if (world.has(leftName)) {
      const lv = world.get(leftName);
      world.set(name, new THREE.Vector3(-lv.x, lv.y, lv.z));
    }
  }
  addFingers("r", -1); // exact finger anchors for the right hand (overwrites mirror)

  // --- boneScales: scale each joint's offset from its parent, then re-derive
  //     descendants (children keep their own parent-relative offsets) ---
  const scaleEntries = Object.entries(params.boneScales || {});
  if (scaleEntries.length) {
    const locals = new Map();
    for (const name of HANIM_JOINT_NAMES) {
      const parent = HANIM_PARENT[name];
      const w = world.get(name);
      locals.set(name, parent ? w.clone().sub(world.get(parent)) : w.clone());
    }
    for (const [joint, s] of scaleEntries) {
      if (locals.has(joint) && HANIM_PARENT[joint]) locals.get(joint).multiplyScalar(s);
    }
    for (const name of HANIM_JOINT_NAMES) {
      const parent = HANIM_PARENT[name];
      const w = parent ? world.get(parent).clone().add(locals.get(name)) : locals.get(name).clone();
      world.set(name, w);
    }
  }

  // --- stature renormalization: crown == heightM exactly ---
  const headH = HEAD_HEIGHT_FRACTION * params.build.headSize;
  const crown = world.get("skullbase").y + headH;
  const s = params.heightM / crown;
  for (const v of world.values()) v.multiplyScalar(s);

  return {
    world, // Map<jointName, Vector3> (meters)
    scale: s,
    heightM: params.heightM,
    headHeightM: headH * s,
    crownY: params.heightM,
    hipsY: world.get("humanoid_root").y,
    toeTipZ: world.get("l_metatarsal").z + 0.0523 * s, // toe-end mesh extent
  };
}

/** Build the THREE.Bone hierarchy (identity rest rotations, name = H-Anim joint). */
export function buildHAnimSkeleton(layout) {
  const bones = [];
  const byName = new Map();
  for (const name of HANIM_JOINT_NAMES) {
    const bone = new THREE.Bone();
    bone.name = name;
    const parentName = HANIM_PARENT[name];
    const w = layout.world.get(name);
    if (parentName) {
      const pw = layout.world.get(parentName);
      bone.position.set(w.x - pw.x, w.y - pw.y, w.z - pw.z);
      byName.get(parentName).add(bone);
    } else {
      bone.position.copy(w);
    }
    bones.push(bone);
    byName.set(name, bone);
  }
  return { root: byName.get("humanoid_root"), bones, byName };
}

/* ========================================================================== *
 *  3. Parametric body mesh (skinned, generated — no asset)
 * ========================================================================== */

class GeometryAccumulator {
  constructor() {
    this.positions = [];
    this.colors = [];
    this.skinIndices = [];
    this.skinWeights = [];
    this.indices = [];
  }
  /**
   * Push one vertex. skin = array of up to 4 [boneIndex, weight] pairs
   * (normalized here so weights always sum to 1).
   */
  vertex(p, color, skin) {
    this.positions.push(p.x, p.y, p.z);
    this.colors.push(color.r, color.g, color.b);
    let total = 0;
    for (const [, w] of skin) total += w;
    const inv = total > 0 ? 1 / total : 0;
    for (let i = 0; i < 4; i++) {
      const pair = skin[i];
      this.skinIndices.push(pair ? pair[0] : 0);
      this.skinWeights.push(pair ? pair[1] * inv : 0);
    }
    return this.positions.length / 3 - 1;
  }
  /**
   * Tube through the given rings. Each ring: { center:Vector3, u:Vector3,
   * v:Vector3, ru, rv, color:THREE.Color, skin }. Adds side quads + optional
   * end caps (triangle fans to the ring centers). Cap winding is derived from
   * the tube's actual travel direction vs the ring frame's u×v, so caps face
   * OUTWARD regardless of how the caller orients u/v.
   */
  addTube(rings, radial = 10, capStart = true, capEnd = true) {
    const ringStart = [];
    for (const ring of rings) {
      const start = this.positions.length / 3;
      ringStart.push(start);
      for (let i = 0; i < radial; i++) {
        const a = (i / radial) * Math.PI * 2;
        const p = ring.center
          .clone()
          .addScaledVector(ring.u, Math.cos(a) * ring.ru)
          .addScaledVector(ring.v, Math.sin(a) * ring.rv);
        this.vertex(p, ring.color, ring.skin);
      }
    }
    // does the ring winding (u→v) advance right-handed along the travel axis?
    const travel = rings[rings.length - 1].center.clone().sub(rings[0].center);
    const uxv = new THREE.Vector3().crossVectors(rings[0].u, rings[0].v);
    const rightHanded = uxv.dot(travel) >= 0;
    for (let r = 0; r < rings.length - 1; r++) {
      const a0 = ringStart[r];
      const b0 = ringStart[r + 1];
      for (let i = 0; i < radial; i++) {
        const i1 = (i + 1) % radial;
        if (rightHanded) this.indices.push(a0 + i, b0 + i, b0 + i1, a0 + i, b0 + i1, a0 + i1);
        else this.indices.push(a0 + i, b0 + i1, b0 + i, a0 + i, a0 + i1, b0 + i1);
      }
    }
    if (capStart) {
      const ring = rings[0];
      const c = this.vertex(ring.center, ring.color, ring.skin);
      const s0 = ringStart[0];
      for (let i = 0; i < radial; i++) {
        const i1 = (i + 1) % radial;
        if (rightHanded) this.indices.push(c, s0 + i1, s0 + i);
        else this.indices.push(c, s0 + i, s0 + i1);
      }
    }
    if (capEnd) {
      const ring = rings[rings.length - 1];
      const c = this.vertex(ring.center, ring.color, ring.skin);
      const sN = ringStart[ringStart.length - 1];
      for (let i = 0; i < radial; i++) {
        const i1 = (i + 1) % radial;
        if (rightHanded) this.indices.push(c, sN + i, sN + i1);
        else this.indices.push(c, sN + i1, sN + i);
      }
    }
  }
  /** Merge a plain (non-indexed-agnostic) BufferGeometry with uniform skin+color. */
  mergeGeometry(geometry, color, skin) {
    const pos = geometry.getAttribute("position");
    const index = geometry.getIndex();
    const offset = this.positions.length / 3;
    const p = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      p.set(pos.getX(i), pos.getY(i), pos.getZ(i));
      this.vertex(p, color, skin);
    }
    if (index) {
      for (let i = 0; i < index.count; i++) this.indices.push(offset + index.getX(i));
    } else {
      for (let i = 0; i < pos.count; i++) this.indices.push(offset + i);
    }
  }
  build() {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(this.positions, 3));
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(this.colors, 3));
    geometry.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(this.skinIndices, 4));
    geometry.setAttribute("skinWeight", new THREE.Float32BufferAttribute(this.skinWeights, 4));
    geometry.setIndex(this.indices);
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    return geometry;
  }
}

/** Orthonormal frame perpendicular to dir. */
function frameFor(dir) {
  const d = dir.clone().normalize();
  const ref = Math.abs(d.y) > 0.94 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
  const u = new THREE.Vector3().crossVectors(ref, d).normalize();
  const v = new THREE.Vector3().crossVectors(d, u).normalize();
  return { u, v };
}

/**
 * Capsule-ish limb segment from joint A to joint B, driven by bone A with
 * smooth blends into A's parent at the proximal end and into B (if given)
 * at the distal end.
 */
function addLimb(acc, opts) {
  const { from, to, r0, r1, color, boneIdx, parentIdx = null, childIdx = null, radial = 10, steps = 6 } = opts;
  const axis = to.clone().sub(from);
  const { u, v } = frameFor(axis);
  const rings = [];
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const r = r0 + (r1 - r0) * t;
    let skin;
    if (t < 0.22 && parentIdx !== null) {
      const w = 0.5 + (t / 0.22) * 0.5;
      skin = [[boneIdx, w], [parentIdx, 1 - w]];
    } else if (t > 0.82 && childIdx !== null) {
      const w = ((t - 0.82) / 0.18) * 0.42;
      skin = [[boneIdx, 1 - w], [childIdx, w]];
    } else {
      skin = [[boneIdx, 1]];
    }
    rings.push({ center: from.clone().addScaledVector(axis, t), u, v, ru: r, rv: r, color, skin });
  }
  acc.addTube(rings, radial, true, true);
}

/** Build the whole parametric body geometry in model space (bind pose). */
export function buildParametricBodyGeometry(layout, params, boneIndexOf) {
  const H = params.heightM;
  const B = params.build;
  const A = params.appearance;
  const acc = new GeometryAccumulator();
  const col = (hex) => new THREE.Color(hex);
  const skinC = col(A.skinColor);
  const topC = col(A.topColor);
  const bottomC = col(A.bottomColor);
  const shoeC = col(A.shoeColor);
  const J = (name) => layout.world.get(name);
  const bi = (name) => boneIndexOf(name);

  // ---- torso: horizontal elliptical rings up the spine (hips → shoulders) ----
  const X = new THREE.Vector3(1, 0, 0);
  const Z = new THREE.Vector3(0, 0, 1);
  const hipHalfX = Math.max(J("l_hip").x + 0.036 * H * B.hipGirth, 0.07 * H * B.hipGirth);
  const shoulderY = J("l_shoulder").y;
  const torsoLevels = [
    { y: J("l_hip").y - 0.030 * H, rx: hipHalfX * 0.92, rz: 0.050 * H * B.hipGirth, c: bottomC, skin: [[bi("sacroiliac"), 1]] },
    { y: J("sacroiliac").y, rx: hipHalfX, rz: 0.055 * H * B.hipGirth, c: bottomC, skin: [[bi("sacroiliac"), 1]] },
    { y: J("vl5").y, rx: 0.072 * H * B.waistGirth, rz: 0.048 * H * B.waistGirth, c: topC, skin: [[bi("sacroiliac"), 0.35], [bi("vl5"), 0.65]] },
    { y: J("vt12").y, rx: 0.082 * H * ((B.waistGirth + B.chestGirth) / 2), rz: 0.054 * H * B.chestGirth, c: topC, skin: [[bi("vt12"), 1]] },
    { y: J("vt6").y, rx: 0.090 * H * B.chestGirth, rz: 0.058 * H * B.chestGirth, c: topC, skin: [[bi("vt6"), 0.8], [bi("vt12"), 0.2]] },
    { y: J("vt1").y, rx: 0.088 * H * B.chestGirth, rz: 0.054 * H * B.chestGirth, c: topC, skin: [[bi("vt1"), 1]] },
    { y: shoulderY + 0.024 * H, rx: 0.070 * H * B.chestGirth, rz: 0.046 * H * B.chestGirth, c: topC, skin: [[bi("vt1"), 1]] },
  ];
  const spineZ = (y) => {
    // follow the spine's slight z-curve so the torso tube tracks the joints
    const chain = ["humanoid_root", "vl5", "vt12", "vt6", "vt1"].map((n) => J(n));
    let lo = chain[0];
    let hi = chain[chain.length - 1];
    for (let i = 0; i < chain.length - 1; i++) {
      if (y >= chain[i].y && y <= chain[i + 1].y) {
        lo = chain[i];
        hi = chain[i + 1];
        break;
      }
    }
    const t = hi.y === lo.y ? 0 : (y - lo.y) / (hi.y - lo.y);
    return lo.z + (hi.z - lo.z) * Math.min(1, Math.max(0, t));
  };
  acc.addTube(
    torsoLevels.map((lv) => ({
      center: new THREE.Vector3(0, lv.y, spineZ(lv.y)),
      u: X,
      v: Z,
      ru: lv.rx,
      rv: lv.rz,
      color: lv.c,
      skin: lv.skin,
    })),
    14,
    true,
    true
  );

  // ---- neck ----
  addLimb(acc, {
    from: J("vc4").clone(),
    to: J("skullbase").clone().add(new THREE.Vector3(0, 0.012 * H, 0)),
    r0: 0.022 * H,
    r1: 0.020 * H,
    color: skinC,
    boneIdx: bi("vc4"),
    parentIdx: bi("vt1"),
    childIdx: bi("skullbase"),
    radial: 8,
    steps: 3,
  });

  // ---- head: ellipsoid sized so its crown hits exactly heightM ----
  const headH = layout.headHeightM; // skullbase → crown
  const headCenter = J("skullbase").clone().add(new THREE.Vector3(0, headH * 0.52, 0.006 * H));
  const headGeo = new THREE.SphereGeometry(1, 18, 14);
  headGeo.scale(0.045 * H * B.headSize, headH * 0.48, 0.0505 * H * B.headSize);
  headGeo.translate(headCenter.x, headCenter.y, headCenter.z);
  acc.mergeGeometry(headGeo, skinC, [[bi("skullbase"), 1]]);
  headGeo.dispose();

  // ---- arms ----
  for (const side of ["l", "r"]) {
    addLimb(acc, {
      from: J(`${side}_shoulder`).clone(),
      to: J(`${side}_elbow`).clone(),
      r0: 0.030 * H * B.armGirth,
      r1: 0.023 * H * B.armGirth,
      color: topC,
      boneIdx: bi(`${side}_shoulder`),
      parentIdx: bi(`${side}_sternoclavicular`),
      childIdx: bi(`${side}_elbow`),
    });
    addLimb(acc, {
      from: J(`${side}_elbow`).clone(),
      to: J(`${side}_wrist`).clone(),
      r0: 0.022 * H * B.armGirth,
      r1: 0.015 * H * B.armGirth,
      color: topC,
      boneIdx: bi(`${side}_elbow`),
      parentIdx: bi(`${side}_shoulder`),
      childIdx: bi(`${side}_wrist`),
    });
    // hand: mitten volume along the finger axis; the tip blends into the
    // middle-finger chain so the retargeted finger curl reads subtly.
    const sign = side === "l" ? 1 : -1;
    const wrist = J(`${side}_wrist`);
    const handLen = (0.0541 + 0.0208 + 0.0175 + 0.014) * H * params.proportions.armLength;
    const handEnd = wrist.clone().add(new THREE.Vector3(sign * handLen, -0.004 * H, 0));
    const axis = handEnd.clone().sub(wrist);
    const rings = [];
    const handSteps = 5;
    for (let s = 0; s <= handSteps; s++) {
      const t = s / handSteps;
      const width = (0.016 + 0.010 * Math.sin(Math.PI * Math.min(1, t * 1.25))) * H;
      const thick = (0.0085 + 0.0025 * Math.sin(Math.PI * t)) * H;
      let skin;
      if (t < 0.25) skin = [[bi(`${side}_wrist`), 0.72], [bi(`${side}_elbow`), 0.28]];
      else if (t < 0.55) skin = [[bi(`${side}_wrist`), 1]];
      else if (t < 0.8) skin = [[bi(`${side}_wrist`), 0.55], [bi(`${side}_middle1`), 0.45]];
      else skin = [[bi(`${side}_middle1`), 0.6], [bi(`${side}_middle2`), 0.4]];
      rings.push({
        center: wrist.clone().addScaledVector(axis, t),
        u: Z, // hand is wide fore-aft (fingers side by side along z), thin vertically
        v: new THREE.Vector3(0, 1, 0),
        ru: width,
        rv: thick,
        color: skinC,
        skin,
      });
    }
    acc.addTube(rings, 10, true, true);
  }

  // ---- legs + feet ----
  for (const side of ["l", "r"]) {
    addLimb(acc, {
      from: J(`${side}_hip`).clone(),
      to: J(`${side}_knee`).clone(),
      r0: 0.052 * H * B.legGirth,
      r1: 0.033 * H * B.legGirth,
      color: bottomC,
      boneIdx: bi(`${side}_hip`),
      parentIdx: bi("sacroiliac"),
      childIdx: bi(`${side}_knee`),
    });
    addLimb(acc, {
      from: J(`${side}_knee`).clone(),
      to: J(`${side}_ankle`).clone(),
      r0: 0.032 * H * B.legGirth,
      r1: 0.018 * H * B.legGirth,
      color: bottomC,
      boneIdx: bi(`${side}_knee`),
      parentIdx: bi(`${side}_hip`),
      childIdx: bi(`${side}_ankle`),
    });
    // foot: horizontal wedge from heel to toe tip (rings along +Z)
    const ankle = J(`${side}_ankle`);
    const toes = J(`${side}_metatarsal`);
    const toeTipZ = toes.z + 0.0523 * layout.scale;
    const soleY = 0.012 * H;
    const footRings = [];
    const zs = [ankle.z - 0.035 * H, ankle.z, toes.z, toeTipZ];
    const heights = [0.030 * H, 0.034 * H, 0.020 * H, 0.011 * H];
    const widths = [0.024 * H, 0.027 * H, 0.030 * H, 0.026 * H];
    for (let i = 0; i < zs.length; i++) {
      const blend = i < 2 ? [[bi(`${side}_ankle`), 1]] : i === 2 ? [[bi(`${side}_ankle`), 0.45], [bi(`${side}_metatarsal`), 0.55]] : [[bi(`${side}_metatarsal`), 1]];
      footRings.push({
        center: new THREE.Vector3(ankle.x, soleY + heights[i] * 0.5, zs[i]),
        u: X,
        v: new THREE.Vector3(0, 1, 0),
        ru: widths[i],
        rv: heights[i] * 0.5,
        color: shoeC,
        skin: blend,
      });
    }
    acc.addTube(footRings, 10, true, true);
  }

  return acc.build();
}

/* ========================================================================== *
 *  4. createParametricAvatar — assemble rig + mesh, return the VRM-facade
 * ========================================================================== */

/**
 * Build a parametric avatar from an AvatarParams set (see typedef).
 *
 * @param {Partial<AvatarParams>} [paramsIn]
 * @returns {{
 *   scene: THREE.Group,
 *   meta: { metaVersion: string, name: string },
 *   humanoid: {
 *     getNormalizedBoneNode: (vrmBoneName: string) => THREE.Bone|null,
 *     getRawBoneNode: (vrmBoneName: string) => THREE.Bone|null,
 *     normalizedRestPose: Object,
 *   },
 *   update: (dt: number) => void,
 *   isParametric: true,
 *   params: AvatarParams,
 *   hanim: { jointNames: string[], vrmToHanim: Object, version: string },
 *   debugSummary: () => Object,
 * }}
 *   The facade mirrors the exact three-vrm surface the demo consumes, so the
 *   existing retarget/equipment/grounding/camera code paths work unchanged.
 *   raw === normalized here: there is one real skeleton and no proxy rig.
 */
export function createParametricAvatar(paramsIn) {
  const params = resolveAvatarParams(paramsIn);
  const layout = computeSkeletonLayout(params);
  const { bones, byName } = buildHAnimSkeleton(layout);

  const boneIndexByName = new Map(bones.map((bone, index) => [bone.name, index]));
  const boneIndexOf = (name) => {
    const index = boneIndexByName.get(name);
    if (index === undefined) throw new Error(`parametric-avatar: unknown H-Anim joint '${name}'`);
    return index;
  };

  const geometry = buildParametricBodyGeometry(layout, params, boneIndexOf);
  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.82,
    metalness: 0.04,
  });
  const mesh = new THREE.SkinnedMesh(geometry, material);
  mesh.name = "parametric-avatar-body";
  mesh.frustumCulled = false; // skinned bounds are bind-pose; never cull the animated body

  const scene = new THREE.Group();
  scene.name = "parametric-avatar";
  scene.add(mesh);
  mesh.add(byName.get("humanoid_root"));

  // eyes: simple non-skinned meshes riding the skullbase bone (facing +Z)
  const H = params.heightM;
  const skullbase = byName.get("skullbase");
  const eyeGeo = new THREE.SphereGeometry(0.0095 * H, 10, 8);
  const eyeMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(params.appearance.eyeColor), roughness: 0.35 });
  for (const sign of [1, -1]) {
    const eye = new THREE.Mesh(eyeGeo, eyeMat);
    eye.name = sign === 1 ? "parametric-avatar-eye-l" : "parametric-avatar-eye-r";
    eye.position.set(sign * 0.019 * H, layout.headHeightM * 0.55, 0.045 * H * params.build.headSize);
    skullbase.add(eye);
  }

  // bind AFTER world matrices are current so boneInverses capture the rest pose
  scene.updateMatrixWorld(true);
  mesh.bind(new THREE.Skeleton(bones), mesh.matrixWorld.clone());

  // normalizedRestPose: local rest translations per VRM bone name (the shape
  // retarget-mocap.js reads: normalizedRestPose.hips.position[1] = hips height)
  const normalizedRestPose = {};
  for (const [vrmName, hanimName] of Object.entries(VRM_TO_HANIM)) {
    const bone = byName.get(hanimName);
    normalizedRestPose[vrmName] = { position: [bone.position.x, bone.position.y, bone.position.z] };
  }

  const lookup = (vrmBoneName) => byName.get(VRM_TO_HANIM[vrmBoneName]) || null;

  return {
    scene,
    meta: { metaVersion: `x-parametric-hanim-${PARAMETRIC_AVATAR_VERSION}`, name: params.label },
    humanoid: {
      getNormalizedBoneNode: lookup,
      getRawBoneNode: lookup, // one real skeleton: raw === normalized
      normalizedRestPose,
    },
    update: (_dt) => {
      /* no proxy rig to propagate; the layer's AnimationMixer drives the bones directly */
    },
    isParametric: true,
    params,
    hanim: {
      jointNames: HANIM_JOINT_NAMES.slice(),
      vrmToHanim: { ...VRM_TO_HANIM },
      version: "ISO/IEC 19774:2006 naming + parent ordering (reduced articulation; no conformance claim)",
    },
    debugSummary: () => ({
      engine: "parametric-avatar",
      version: PARAMETRIC_AVATAR_VERSION,
      params_id: params.id,
      height_m: params.heightM,
      hips_rest_y_m: Number(layout.hipsY.toFixed(4)),
      joint_count: bones.length,
      vertex_count: geometry.getAttribute("position").count,
      triangle_count: geometry.getIndex().count / 3,
      hanim_joints: HANIM_JOINT_NAMES.length,
    }),
  };
}
