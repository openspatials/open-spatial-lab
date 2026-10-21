import * as THREE from "./vendor/scene-core/vendor/three/three.module.js";
import { GLTFLoader } from "./vendor-three-examples/loaders/GLTFLoader.js";
import { clone as cloneSkeleton } from "./vendor-three-examples/utils/SkeletonUtils.js";
import { VRMLoaderPlugin } from "./vendor-vrm/three-vrm.module.js";
import { createRetargetedLocomotionClips } from "./procedural-animation.js";
import { fetchAndParseGltf } from "./gltf-fetch-loader.mjs";
// BEGIN (parametric avatar engine — H-Anim skeleton + params-generated body)
import { createParametricAvatar, DEFAULT_AVATAR_PARAMS } from "./avatar/parametric-avatar.mjs";
// END
// BEGIN (Ready Player Me / Mixamo GLB humanoid facade — the "glTF humanoid
// mapping layer" avatar-catalog.json said was missing. Turns a rigged GLB into the
// same VRMHumanoid surface the VRM avatars expose, so the mocap retarget, the
// locomotion mixer, and normalized-bone equipment attachment all work on GLBs with
// NO changes to any of those systems.)
// END
// every avatar/mocap asset URL below is a root-absolute same-origin path.
// Route each through the ONE base-path helper so it resolves beneath the public prefix in subpath
// mode; in root mode withBase() is the identity, so the frozen tables are byte-for-byte unchanged
// and avatar behaviour is untouched (only the URL string is made prefix-aware).
import { withBase } from "./base-path.mjs";

const ATTACHMENT_PRESETS = {
  head: { position: [0, 1.55, 0.12], label: "head" },
  chest: { position: [0, 1.08, 0.16], label: "chest" },
  upperChest: { position: [0, 1.22, 0.18], label: "upperChest" },
  rightHand: { position: [0.42, 0.82, 0.18], label: "rightHand" },
  leftHand: { position: [-0.42, 0.82, 0.18], label: "leftHand" },
  hips: { position: [0, 0.72, 0.08], label: "hips" },
};

// real blended mocap locomotion (grafted).
//
// MOCAP SOURCE — LICENCE, stated correctly.
// The comment that used to sit here called this asset "free/redistributable". That was
// FALSE and it was the second-worst kind of false: a licence claim nobody had checked.
// The clips are Adobe Mixamo's. Mixamo grants royalty-free use (commercial, non-commercial
// and non-profit) and requires NO credit — but its terms say, verbatim: "Really the only
// thing you can't do is distribute the raw character and animation files." OSL used to
// serve the raw `Xbot.glb` right here, putting the raw character one Network-tab click away.
// What is served now is a DERIVED bake: character mesh, skin and materials removed, only the
// idle/walk/run joint curves kept (see tools/mocap/bake-locomotion-source.mjs, which proves
// the derivation is value-identical to the source). The raw file is not in the repo and is
// not served.
const MOCAP_URLS = {};

// step 5: the runtime-switchable avatar set. A switch REPLACES the one
// avatar model inside the rig (never adds a second), re-retargets the mocap set onto the
// new humanoid rig, and re-attaches the current equipment to the new rig's bones. The
// adapter carries the active variant key in avatar.avatar_variant (broadcast to observers +
// carried through the crossing packet).
//
// TWO THINGS THE OLD COMMENT HERE GOT WRONG — both were licence claims, both are corrected
//
//   1. It called "upgraded" (AvatarSample_B) "VRoid CC0". THE BYTES DO NOT SAY CC0. They say
//      VRM.meta.licenseName = "Other" with an EMPTY otherLicenseUrl. Its licence is therefore
//      UNKNOWN — recorded as Unknown, not guessed into something friendlier. See the entry.
//   2. It called "upgraded" "the new default". It is NOT — DEFAULT_AVATAR_VARIANT below is
//      "readyplayerme-cyberpunk" (CC-BY-NC-SA-4.0), and has been.
//
// The "classic" variant (/runtime-assets/avatar.vrm, HYPERFY "HYPERROBO_TEMPLATE") IS GONE.
// Its own VRM.meta declares licenseName "Redistribution_Prohibited" and allowedUserName
// "OnlyAuthor" — only the author may use it, and it may not be redistributed at all. OSL was
// serving it over HTTP as a selectable variant. That is not a money clause, so the project's
// non-commercial posture did not rescue it: it was dropped, and the file was deleted.
// Attribution for what remains: THIRD_PARTY_NOTICES.md.
export const AVATAR_VARIANTS = Object.freeze({
  // No VRM model file ships. The format-neutral runtime machinery below (three-vrm's
  // VRMHumanoid facade, VRMLoaderPlugin, the MIXAMO_TO_VRM bone map, the `this.vrm` runtime
  // handle) is NOT VRM model support — it is the shared humanoid rig every avatar drives
  // through, so it stays.
  // BEGIN (parametric avatar variant)
  // Generated locally from AvatarParams (H-Anim skeleton + parametric body);
  // NO asset is fetched — the url is an honest pseudo-URI naming the generator.
  // rotation_y is 0 (not PI): the parametric rig natively faces the mocap
  // source's forward (+Z, no VRM0 mirror), which the VRM0 avatars only reach
  // after their PI flip. The UM avatar-facet binding is the seam inside
  // web/avatar/parametric-avatar.mjs (paramsFromAvatarFacet — stub, unwired).
  parametric: {
    key: "parametric",
    label: "Parametric H-Anim avatar (generated in browser)",
    type: "parametric",
    url: "parametric://hanim-19774/default",
    parametric: true,
    params: DEFAULT_AVATAR_PARAMS,
    scale: 1,
    rotation_y: 0,
    load_mode: "parametric-generated",
    mocap_retarget: "supported",
    equipment_attachment: "parametric-normalized-bones",
    structured_unsupported: [],
  },
  // END
  // The Ready Player Me characters below are Mixamo-topology rigs driven through the
  // gltf-humanoid-facade, so they share the locomotion retarget and the normalized-bone
  // equipment attachment with no per-avatar code. rotation_y stays 0: a Mixamo glTF rig
  // already faces the mocap source's forward. They dress the airport travelers; the player
  // selector offers only the generated avatar above (web/avatar-selector-controller.mjs).
  //
  // LICENCE (all three): CC-BY-NC-SA-4.0, author "Ready Player Me", via Sketchfab (read from
  // each file's own asset.extras). NON-COMMERCIAL + ShareAlike + ATTRIBUTION REQUIRED.
  // Attribution ships in THIRD_PARTY_NOTICES.md.
  "rpm-female-cyberpunk": {
    key: "rpm-female-cyberpunk",
    label: "Rose",
    type: "glb",
    url: withBase("/assets/avatars/glb/rpm_female_cyberpunk.glb"),
    scale: 1,
    rotation_y: 0,
    load_mode: "gltf-humanoid-facade",
    mocap_retarget: "supported",
    equipment_attachment: "glb-humanoid-normalized-bones",
    licence: "CC-BY-NC-SA-4.0",
    licence_holder: "Ready Player Me (via Sketchfab)",
    structured_unsupported: [],
  },
  "rpm-female-ninja": {
    key: "rpm-female-ninja",
    label: "Helium",
    type: "glb",
    url: withBase("/assets/avatars/glb/rpm_female_ninja.glb"),
    scale: 1,
    rotation_y: 0,
    load_mode: "gltf-humanoid-facade",
    mocap_retarget: "supported",
    equipment_attachment: "glb-humanoid-normalized-bones",
    licence: "CC-BY-NC-SA-4.0",
    licence_holder: "Ready Player Me (via Sketchfab)",
    structured_unsupported: [],
  },
  "rpm-female-character": {
    key: "rpm-female-character",
    label: "Nea",
    type: "glb",
    url: withBase("/assets/avatars/glb/rpm_female_character.glb"),
    scale: 1,
    rotation_y: 0,
    load_mode: "gltf-humanoid-facade",
    mocap_retarget: "supported",
    equipment_attachment: "glb-humanoid-normalized-bones",
    licence: "CC-BY-NC-SA-4.0",
    licence_holder: "Ready Player Me (via Sketchfab)",
    structured_unsupported: [],
  },
});
// The default and only player avatar is the generated one. It is built in the browser from
// AvatarParams, so it ships no model file and carries no third-party licence. The Ready Player
// Me variants above (CC-BY-NC-SA-4.0) dress the airport travelers only.
export const DEFAULT_AVATAR_VARIANT = "parametric";

/**
 * PREFERRED HEIGHT (the Universal Manifest shape, deliberately NOT UM-wired).
 *
 * The point to prove: a person carries a preferred body height in their
 * manifest, and it must be APPLIED CORRECTLY here — to whatever avatar they happen to be
 * wearing. That only works if the height is resolved against each rig's OWN anatomy, so
 * these are the bounds and the seam. `applyPreferredHeightM()` is the seam a UM avatar
 * facet would call; nothing about it presumes a particular asset.
 *
 * The honest boundary: this is the APPLICATION half. The UM read/binding half is not
 * wired ("we don't have to wire it up to the Universal Manifest now").
 */
export const PREFERRED_HEIGHT_BOUNDS_M = Object.freeze({ min: 0.6, max: 2.6 });

/**
 * how deep a worn head item settles onto the skull, as a fraction of the ITEM's
 * own height. 0 would rest the item's underside exactly on the crown of the head; a crown
 * or a hat wants to sit down into the hair rather than balance on it.
 *
 * Expressed as a fraction of the item, and applied against the rig's MEASURED head top, so
 * it is free of both avatar scale and item scale: the same numbers seat the same hat
 * correctly on a 1.1 m dwarf and a 2 m Ready Player Me avatar.
 *
 * This REPLACES the equipment catalog's authored absolute y-offsets for head items. Those
 * offsets were authored against one VRoid skull and they were simply wrong — the crown
 * floated above the head on the reference VRM too, not just on the Ready Player Me avatar.
 * Scaling a wrong offset proportionally would only have preserved the bug on every body.
 */
const HEAD_ITEM_SINK_FRACTION = Object.freeze({
  "equip-crown": 0.34,
  "equip-hat": 0.42,
  "equip-helmet": 0.55,
  _default: 0.35,
});
// World-speed playback match — THE treadmill fix from review:
// the locomotion clip's playback rate is scaled so foot speed matches the real
// world translation speed instead of playing at an arbitrary fixed rate.
// WORLD_MOVE_SPEED_MPS mirrors MOVE_SPEED_MPS in live-adapter.js (keep in sync).
// Walk playback retains its measured natural-speed calibration. Run playback is
// intentionally separate: one run loop is a measured two-step gait cycle whose
// distance is the fixed-sole/foot-derived source of truth Stage A.
const WORLD_MOVE_SPEED_MPS = 2.35;
const WALK_NATURAL_SPEED_MPS = 1.55;
const RUN_CYCLE_DISTANCE_M = 1.9375500814918891;
const RUN_CONTACT_WINDOWS_S = Object.freeze({
  left: Object.freeze({ start: 0.2139999963556017, end: 0.4494999923450606 }),
  right: Object.freeze({ start: 0.570999990275928, end: 0.7804999867081642 }),
});
const RUN_CONTACT_RELEASE_S = 0.11;
const LOCOMOTION_CROSSFADE_S = 0.22;
const JUMP_PLAYBACK_FAULT = "hidden-clock-repeat";

function jumpPlaybackStatus(fault) {
  const mutationActive = fault === JUMP_PLAYBACK_FAULT;
  return {
    policy: mutationActive ? "fault-hidden-clock-repeat" : "takeoff-reset-loop-once",
    mutation_active: mutationActive,
    fault: mutationActive ? fault : null,
    clip_duration_seconds: null,
    action_time_seconds: 0,
    normalized_time: 0,
    effective_weight: 0,
    effective_time_scale: 1,
    loop_mode: mutationActive ? "LoopRepeat" : "LoopOnce",
    repetitions: mutationActive ? "Infinity" : 1,
    clamp_when_finished: !mutationActive,
    paused: !mutationActive,
    running: false,
    finished: false,
    airborne: false,
    phase: "unloaded",
    cycle_count: 0,
    takeoff_reset_count: 0,
    landing_count: 0,
    midair_restart_count: 0,
    takeoff_action_time_seconds: null,
    takeoff_weight: null,
    landing_action_time_seconds: null,
  };
}

function countMeshes(root) {
  let count = 0;
  root.traverse((node) => {
    if (node.isMesh || node.isSkinnedMesh) count += 1;
  });
  return count;
}

function countNonIdentityQuaternionSamples(clip) {
  let count = 0;
  for (const track of clip.tracks) {
    if (track.ValueTypeName !== "quaternion") continue;
    for (let i = 0; i < track.values.length; i += 4) {
      const x = track.values[i] || 0;
      const y = track.values[i + 1] || 0;
      const z = track.values[i + 2] || 0;
      const w = track.values[i + 3] || 1;
      if (Math.abs(x) + Math.abs(y) + Math.abs(z) > 1e-5 || Math.abs(w - 1) > 1e-5) count += 1;
    }
  }
  return count;
}

function applyLocalTransform(object, item) {
  const t = item.localTransform || {};
  const q = t.quaternion || t.rotation || [0, 0, 0, 1];
  const p = t.position || [0, 0, 0];
  const s = t.scale || [1, 1, 1];
  object.position.set(p[0], p[1], p[2]);
  object.quaternion.set(q[0], q[1], q[2], q[3]);
  object.scale.set(s[0], s[1], s[2]);
}

/**
 * measure a freshly-loaded rig, in MODEL-LOCAL units, before any variant scale
 * or preferred height is applied. Everything downstream that has to adapt to "whatever
 * body this person is wearing" resolves against these numbers instead of assuming a
 * physique.
 *
 *   natural_height_m   the rig's own standing height at scale 1 — the denominator that
 *                      turns a REQUESTED height into a scale factor for THIS body.
 *   head_bone_y_m      head bone height above the model root (the feet).
 *   head_top_offset_m  head bone -> crown of the skull. This is the number that differs
 *                      most between rigs (a Ready Player Me head bone sits at a different
 *                      depth than a VRoid one) and it is why worn items need re-seating.
 *   sole_y_m           lowest rendered point. ~0 means the model's origin is at its feet,
 *                      so uniform scaling keeps the soles on the ground for free.
 */
function withRigMetrics(vrm, model) {
  return { vrm, model, metrics: measureRigMetrics(model, vrm) };
}

/**
 * bounds of the avatar's BODY, excluding anything equipped to it.
 *
 * `Box3.setFromObject(model)` cannot be used for this: equipment is parented to bones
 * INSIDE the model, so a crown sitting on the head silently inflates the model's bounding
 * box. That is not a cosmetic detail — it made a requested 1.75 m body render at 1.845 m,
 * because the height fit was dividing by a natural height that had no hat in it and then
 * measuring a rendered height that did. How tall a person is does not depend on their hat.
 *
 * Skinned bounds are taken from the BIND-POSE geometry box transformed by the mesh's world
 * matrix — the same thing setFromObject did — so the measurement is stable across animation
 * frames rather than flickering with the walk cycle.
 */
function avatarBodyBounds(model, detail = null) {
  const box = new THREE.Box3().makeEmpty();
  const isEquipment = (node) => {
    for (let p = node; p && p !== model; p = p.parent) {
      if (p.name && p.name.startsWith("attached-equipment-")) return true;
    }
    return false;
  };
  model.updateWorldMatrix(true, true);
  let topMesh = null;
  let topY = -Infinity;
  model.traverse((node) => {
    if (!node.isMesh && !node.isSkinnedMesh) return;
    if (!node.geometry || isEquipment(node)) return;
    // An INVISIBLE mesh must not define how tall someone is. VRM avatars ship first-person
    // / LOD variants that are hidden in the third-person view; letting one of those set the
    // top of the head would seat every hat against a body nobody can see.
    if (node.visible === false) return;
    if (!node.geometry.boundingBox) node.geometry.computeBoundingBox();
    if (!node.geometry.boundingBox) return;
    const b = node.geometry.boundingBox.clone().applyMatrix4(node.matrixWorld);
    if (b.max.y > topY) {
      topY = b.max.y;
      topMesh = node.name || "(unnamed)";
    }
    box.union(b);
  });
  if (detail) {
    detail.top_mesh = topMesh;
    detail.top_y = Number.isFinite(topY) ? Number(topY.toFixed(4)) : null;
  }
  return box.isEmpty() ? null : box;
}

/**
 * a hat has to sit on the SKULL, not on the hair.
 *
 * seated every worn head item on `bounds.max.y` — the top of the avatar's whole
 * SILHOUETTE. On both shipped rigs that is hair, and the screenshot is the
 * result: the hat hovering in mid-air above a mohawk.
 *
 *   Ready Player Me: head bone -> silhouette top = 0.264 m. The top 8 cm of it is a
 *                    MOHAWK FIN — measured 0.013-0.036 m wide in x while 0.067-0.155 m
 *                    long in z. A silhouette max cannot tell a fin from a head.
 *   avatar-upgraded: head bone -> silhouette top = 0.262 m, but the head bone's OWN
 *                    vertices stop at 0.204 m — the rest is hair hung off spring bones.
 *                    So the crown was seated ~6 cm high on the reference VRM too. This
 *                    was never a Ready-Player-Me-only bug; called it "resting in
 *                    the hair" and moved on.
 *
 * A hat rests on a SUPPORT, and a support has to be wide in BOTH horizontal directions.
 * A mohawk, a topknot, a spike, an antenna or a hair strand is not. So: take the vertices
 * the head bone actually owns, slice them into horizontal slabs, and walk down from the
 * top until the slab is still at least half as wide as the widest slice of the head — in
 * its NARROWER horizontal dimension. That is the crown of the skull.
 *
 * Everything is measured off the rig in front of it. No mesh names (naming the RPM hair
 * mesh would be a per-asset hack that dies on the next avatar), no magic metres. The one
 * shape parameter says what "wide enough to hold a hat" means, and it means the same
 * thing on every body.
 *
 * Both rigs independently land on ~0.19 m of head-bone-to-skull-top — from a 0.264 m
 * silhouette on one and a 0.204 m one on the other. That convergence is the evidence
 * that this is measuring a skull rather than a coincidence.
 */
const HEAD_SUPPORT_WIDTH_FRACTION = 0.5;
const SKULL_SLAB_M = 0.01;

function measureSkullTopY(model, headBone) {
  if (!headBone) return null;
  const headY = headBone.getWorldPosition(new THREE.Vector3()).y;
  const boneIndexBySkeleton = new Map();
  const slabs = new Map();
  const v = new THREE.Vector3();
  let found = 0;

  model.traverse((mesh) => {
    if (!mesh.isSkinnedMesh || mesh.visible === false || !mesh.geometry || !mesh.skeleton) return;
    let boneIndex = boneIndexBySkeleton.get(mesh.skeleton);
    if (boneIndex === undefined) {
      boneIndex = mesh.skeleton.bones.indexOf(headBone);
      boneIndexBySkeleton.set(mesh.skeleton, boneIndex);
    }
    if (boneIndex < 0) return;
    const position = mesh.geometry.attributes.position;
    const skinIndex = mesh.geometry.attributes.skinIndex;
    const skinWeight = mesh.geometry.attributes.skinWeight;
    if (!position || !skinIndex || !skinWeight) return;

    for (let i = 0; i < position.count; i += 1) {
      let weight = 0;
      for (let k = 0; k < 4; k += 1) {
        if (skinIndex.getComponent(i, k) === boneIndex) weight += skinWeight.getComponent(i, k);
      }
      if (weight < 0.5) continue; // the head bone must be the DOMINANT influence
      v.fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld);
      found += 1;
      const key = Math.floor((v.y - headY) / SKULL_SLAB_M);
      let slab = slabs.get(key);
      if (!slab) slabs.set(key, (slab = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity }));
      if (v.x < slab.minX) slab.minX = v.x;
      if (v.x > slab.maxX) slab.maxX = v.x;
      if (v.z < slab.minZ) slab.minZ = v.z;
      if (v.z > slab.maxZ) slab.maxZ = v.z;
    }
  });
  if (!found || !slabs.size) return null;

  // A slab's support = its NARROWER horizontal dimension. A fin is long in one axis and
  // paper-thin in the other; taking the min is what refuses to stand a hat on it.
  let widest = 0;
  const support = new Map();
  for (const [key, s] of slabs) {
    const width = Math.min(s.maxX - s.minX, s.maxZ - s.minZ);
    support.set(key, width);
    if (width > widest) widest = width;
  }
  if (!(widest > 0)) return null;

  const minSupport = widest * HEAD_SUPPORT_WIDTH_FRACTION;
  let topKey = null;
  for (const [key, width] of support) {
    if (width >= minSupport && (topKey === null || key > topKey)) topKey = key;
  }
  if (topKey === null) return null;

  return {
    skull_top_y: headY + (topKey + 1) * SKULL_SLAB_M, // the slab's upper edge
    head_widest_support_m: Number(widest.toFixed(4)),
    head_vertices: found,
  };
}

/**
 * seat a worn head item ON THIS RIG'S ACTUAL HEAD.
 *
 *     y = headTop - itemUnderside - sink x itemHeight
 *
 * so the item's underside lands on the measured crown of the head and then settles into it
 * by a fraction of its OWN size. Every term is measured, so this is correct at any avatar
 * height and any item scale, and the authored x/z nudge is preserved.
 *
 * extracted from AvatarEquipmentLayer#_seatOnHeadTop, byte-for-byte, so the
 * proof can drive THE REAL SEATING MATH headlessly instead of re-implementing it (a
 * re-implementation would be free to be right while the shipped code is wrong). The class
 * method is now a one-line call to this. `headTop` is the rig's MEASURED SKULL top — see
 * measureSkullTopY; feeding it the silhouette instead is what floated the hat, and that is
 * exactly the substitution the proof's --negative mode makes.
 *
 * @returns {object|null} seating evidence, or null when the rig could not be measured
 */
export function seatHeadItem(object, item, headTop) {
  if (!Number.isFinite(headTop) || headTop <= 0.001) return null;
  // Bounds while still DETACHED, so they come out in the bone's local frame with the
  // item's own scale already folded in.
  const savedY = object.position.y;
  object.position.y = 0;
  object.updateMatrixWorld(true);
  // Seat against the ITEM'S OWN GEOMETRY, not the whole visualRoot. The visualRoot also
  // carries the equipment system's debug marker stud (makeVisualMarker), a small sphere at
  // the item's origin. Including it drags the measured underside below the real crown and
  // inflates the item's height, which shifts the seat — a hat placed relative to a debug
  // prop instead of relative to the hat.
  const asset = object.children.find((c) => c.name && c.name.startsWith("asset-"));
  const box = new THREE.Box3().setFromObject(asset || object);
  if (box.isEmpty()) {
    object.position.y = savedY;
    return null;
  }
  const itemHeight = box.max.y - box.min.y;
  const sink =
    HEAD_ITEM_SINK_FRACTION[item.itemId] !== undefined
      ? HEAD_ITEM_SINK_FRACTION[item.itemId]
      : HEAD_ITEM_SINK_FRACTION._default;
  object.position.y = headTop - box.min.y - itemHeight * sink;
  return {
    head_top_offset_m: Number(headTop.toFixed(4)),
    item_height_m: Number(itemHeight.toFixed(4)),
    item_underside_m: Number(box.min.y.toFixed(4)),
    sink_fraction: sink,
    authored_y_m: savedY,
    seated_y_m: Number(object.position.y.toFixed(4)),
  };
}

export function measureRigMetrics(model, vrm) {
  const metrics = {
    natural_height_m: null,
    head_bone_y_m: null,
    head_top_offset_m: null,
    head_silhouette_offset_m: null,
    head_top_source: null,
    sole_y_m: null,
  };
  try {
    model.updateWorldMatrix(true, true);
    const bounds = avatarBodyBounds(model);
    if (!bounds) return metrics;
    const rootY = new THREE.Vector3();
    model.getWorldPosition(rootY);
    metrics.natural_height_m = Number((bounds.max.y - bounds.min.y).toFixed(4));
    metrics.sole_y_m = Number((bounds.min.y - rootY.y).toFixed(4));

    const head =
      vrm && vrm.humanoid && typeof vrm.humanoid.getRawBoneNode === "function"
        ? vrm.humanoid.getRawBoneNode("head")
        : null;
    if (head) {
      const headWorld = new THREE.Vector3();
      head.getWorldPosition(headWorld);
      metrics.head_bone_y_m = Number((headWorld.y - rootY.y).toFixed(4));
      // number, KEPT and published — it is what a hat used to be seated on, and
      // the proof asserts the new seat is strictly below it.
      metrics.head_silhouette_offset_m = Number((bounds.max.y - headWorld.y).toFixed(4));

      // seat worn items on the measured SKULL. Falls back to the silhouette — and
      // SAYS so, in `head_top_source` — for a rig with no head-weighted vertices to measure.
      // (All four shipped rigs, the parametric one included, do have them: the bald
      // parametric head measures a skull that IS its silhouette, to within 1.1 cm.)
      const skull = measureSkullTopY(model, head);
      if (skull) {
        metrics.head_top_offset_m = Number((skull.skull_top_y - headWorld.y).toFixed(4));
        metrics.head_top_source = "measured-skull";
        metrics.head_widest_support_m = skull.head_widest_support_m;
        metrics.head_vertices_measured = skull.head_vertices;
      } else {
        metrics.head_top_offset_m = metrics.head_silhouette_offset_m;
        metrics.head_top_source = "silhouette-fallback (no head-weighted vertices to measure)";
      }
    }
  } catch (err) {
    /* leave nulls — the caller reports them honestly rather than inventing a body */
  }
  return metrics;
}

function variantSupportStatus(variant) {
  return {
    avatar_asset_type: variant.type || (variant.parametric ? "parametric" : "vrm"),
    avatar_load_mode: variant.load_mode || (variant.parametric ? "parametric-generated" : "vrm-humanoid"),
    avatar_mocap_retarget: variant.mocap_retarget || "supported",
    avatar_equipment_attachment: variant.equipment_attachment || "vrm-normalized-bones",
    avatar_structured_unsupported: Array.isArray(variant.structured_unsupported) ? variant.structured_unsupported : [],
  };
}

function makeVisualMarker(item) {
  // the old "worn" marker was a 0.72 m-wide cyan
  // visor box (0x22d3ee) rendered straight through the avatar's head — THE
  // reported "blue bar going through the avatar's head". The held marker
  // was similarly a 0.42 m handle + glow ball that clashed with the real
  // hand items. The equipment visual-marker SYSTEM stays fully intact (a real
  // mesh is still attached under `visible-equipment-marker-<itemId>` and
  // equipmentProof.visualMarkerAttached stays true — the e2e's
  // visual_marker_attached assertion is unchanged); only the marker GEOMETRY
  // shrinks to a small emissive proof stud that tucks against the real item
  // instead of impaling the avatar. This is intentionally NOT the logical
  // session marker (player_context_marker in live-adapter.js), which is
  // untouched.
  const group = new THREE.Group();
  group.name = `visible-marker-${item.itemId}`;
  const stud = new THREE.Mesh(
    new THREE.SphereGeometry(0.032, 12, 12),
    new THREE.MeshStandardMaterial({
      color: item.mode === "held" ? 0xffd166 : 0xe8eefc,
      emissive: item.mode === "held" ? 0xffaa22 : 0x8fa3bf,
      emissiveIntensity: 0.55,
      roughness: 0.35,
    })
  );
  group.add(stud);
  return group;
}

/**
 * REUSE the avatar glTF loader stack for WoW scene assets.
 *
 * Loads a glTF/GLB from `url` with the SAME `GLTFLoader` this module already uses
 * for avatars/equipment (same vendored three-examples loader, same `three`) and
 * returns the loaded scene Object3D — so WoW `spatialAssetURI` ingest does NOT
 * stand up a second loader stack. Rejects on failure; the caller
 * (web/wow-scene.mjs#mountWowSceneAssets) then renders the labeled fallback.
 *
 * @param {string} url  resolved (absolute) glTF/GLB URL
 * @returns {Promise<import("three").Object3D>} the loaded glТF scene root
 */
export async function loadGltfSceneAsset(url) {
  const loader = new GLTFLoader();
  const gltf = await loader.loadAsync(url);
  return (gltf && (gltf.scene || (gltf.scenes && gltf.scenes[0]))) || null;
}

/** Clone a glTF scene while rebinding every SkinnedMesh to bones in the clone. */
export function cloneGltfSceneAsset(scene) {
  return cloneSkeleton(scene);
}

/**
 * ONE SCENE, ONE DEPTH BUFFER.
 *
 * Until this change, EVERY AvatarEquipmentLayer built its own WebGLRenderer, its own
 * <canvas> and its own THREE.Scene — so every avatar carried its own private depth
 * buffer, and the browser alpha-composited the stacked canvases in DOM order
 * (web/index.html gives them all the same z-index). Alpha compositing is a 2-D
 * operation: it carries NO depth information, so a peer avatar was painted over the
 * local player's avatar unconditionally, at ANY distance — proved it in
 * pixels (the FURTHER box wins 98.25% of the overlap, and the SAME box wins again
 * when the near/far relationship is reversed: depth was never consulted at all).
 *
 * The fix is a MODE, not a rewrite. When the constructor is given a HOST
 * (`{scene, camera, renderer}` — the live world's own internals), the layer:
 *   - creates NO renderer, NO canvas, NO scene, NO camera, NO lights;
 *   - parents its avatarRig into the HOST scene, so every avatar and all world
 *     geometry share the world's ONE depth buffer and occlusion is decided by
 *     rasterised depth, exactly like everything else in the scene;
 *   - keeps its rAF loop for the mixer/locomotion/vrm updates (rigs
 *     depend on it) but never calls render() — the world's own loop draws.
 *
 * LIGHTING RECONCILIATION: the standalone layer lit its private scene with
 * Ambient(0xffffff, 0.7) + Directional(0xffffff, 0.8 @ 3,6,4). The world scene
 * (vendor/scene-core scene.js) carries the same design lineage a notch brighter:
 * Ambient(0xffffff, 0.75) + Directional(0xffffff, 0.9 @ 4,8,6). In shared mode the
 * layer adds NO lights and the avatar adopts the WORLD's — that is the point:
 * an avatar standing in a world should be lit by that world, and N avatars must
 * not stack N extra light rigs onto it. The visible delta is a few percent of
 * brightness and a slightly different key direction, verified against the
 * composite screenshots in evidence/ (*).
 *
 * WITHOUT a host the layer behaves exactly as before — its own canvas overlay.
 * The avatar-selector preview (web/app.js avatarSelectorEnsurePreviewLayer) NEEDS
 * that: an isolated widget canvas is the job this class was originally built for.
 */
export class AvatarEquipmentLayer {
  constructor(mount, role, world, options = null) {
    this.mount = mount;
    this.role = role;
    this.world = world;
    // shared-scene mode — adopt the host world's scene/camera/renderer
    // instead of owning a private canvas + depth buffer.
    this.host = options && options.host && options.host.scene ? options.host : null;
    this.motionPreference = options && options.motionPreference ? options.motionPreference : null;
    this.sharedScene = !!this.host;
    this.avatar = null;
    this.vrm = null;
    this.loadedItemObjects = new Map();
    this.attachedObjects = [];
    this.anchors = {};
    this._equipmentSignature = "";
    // blended-mocap locomotion FSM state (idle/walk/jump).
    this.mixer = null;
    this.actions = null;
    this._animState = "idle";
    const jumpPlaybackFault =
      typeof window !== "undefined"
        ? new URLSearchParams(window.location.search).get("jump_playback_fault")
        : null;
    this._jumpPlaybackFault = jumpPlaybackFault === JUMP_PLAYBACK_FAULT ? jumpPlaybackFault : null;
    this._lastJumpActionTime = null;
    this._runCalibrationTelemetry = {
      active_wall_seconds: 0,
      active_clip_seconds: 0,
      completed_cycles: 0,
    };
    this._runFootContactLock = null;
    // step 5: runtime avatar switching bookkeeping.
    this._avatarModel = null; // the ONE VRM scene currently inside avatarRig
    this._switchInFlight = false;
    this._pendingVariant = null;
    const defaultSupport = variantSupportStatus(AVATAR_VARIANTS[DEFAULT_AVATAR_VARIANT]);
    this.status = {
      renderer: "initializing",
      // which compositing architecture this layer is running under.
      // "shared-scene-one-depth-buffer" = the avatar rig lives in the host
      // world's scene and is depth-tested against everything in it.
      // "own-canvas-overlay" = the pre-060 standalone widget mode (the
      // avatar-selector preview, and the explicit ?avatar_compositing=stacked
      // negative-proof arm).
      compositing: this.sharedScene ? "shared-scene-one-depth-buffer" : "own-canvas-overlay",
      real_vrm_attempted: true,
      real_vrm_loaded: false,
      avatar_static_glb_loaded: false,
      avatar_variant: DEFAULT_AVATAR_VARIANT,
      avatar_variant_label: AVATAR_VARIANTS[DEFAULT_AVATAR_VARIANT].label,
      avatar_switch_count: 0,
      avatar_switch_in_flight: false,
      avatar_asset_uri: AVATAR_VARIANTS[DEFAULT_AVATAR_VARIANT].url,
      ...defaultSupport,
      walk_animation_asset_uri: MOCAP_URLS.locomotion,
      run_animation_asset_uri: MOCAP_URLS.locomotion,
      retargeter:
        "self-authored procedural animation on the normalized humanoid rig",
      retargeted_walk_loaded: false,
      retargeted_run_loaded: false,
      retargeted_track_count: 0,
      retargeted_non_identity_quaternion_samples: 0,
      locomotion_clips: [],
      current_animation_state: "idle",
      walk_playback_rate: Number((WORLD_MOVE_SPEED_MPS / WALK_NATURAL_SPEED_MPS).toFixed(3)),
      locomotion_playback_rate: Number((WORLD_MOVE_SPEED_MPS / WALK_NATURAL_SPEED_MPS).toFixed(3)),
      anim_speed_match: {
        world_move_speed_mps: WORLD_MOVE_SPEED_MPS,
        walk_clip_natural_speed_mps: WALK_NATURAL_SPEED_MPS,
        run_cycle_distance_m: RUN_CYCLE_DISTANCE_M,
        note: "walk uses its calibrated natural speed; run cycles/s = run translation m/s / measured run metres/cycle",
      },
      animation_mixer_active: false,
      animation_time_seconds: 0,
      procedural_pose_active: false,
      fallback_rig_visible: false,
      locomotion_moving: false,
      locomotion_movement_mode: "idle",
      locomotion_run_mode: false,
      locomotion_speed_mps: 0,
      run_calibration: {
        supported: false,
        source_derived: false,
        run_clip_duration_seconds: null,
        run_playback_rate: null,
        run_cycle_speed: null,
        run_cycle_distance: null,
        effective_run_translation_speed_mps: null,
        active_wall_seconds: 0,
        active_clip_seconds: 0,
        completed_cycles: 0,
      },
      run_contact_lock: {
        owner: "AvatarEquipmentLayer._loop",
        enabled: true,
        active: false,
        active_side: null,
        phase_seconds: null,
        plant_window: null,
        anchor_world_xz: null,
        horizontal_error_mm: 0,
        max_horizontal_error_mm: 0,
        release_active: false,
        simultaneous_overconstraint_count: 0,
        phase_discontinuity_release_count: 0,
        state_transition_release_count: 0,
        lifecycle_release_count: 0,
        outside_run_release_count: 0,
      },
      avatar_grounded: true,
      avatar_jump_height_m: 0,
      jump_playback: jumpPlaybackStatus(this._jumpPlaybackFault),
      avatar_visual_scale: 1,
      avatar_model_height_m: null,
      avatar_head_height_m: null,
      // preferred height (Universal-Manifest-shaped; UM read half not wired).
      avatar_preferred_height_m: null,
      avatar_natural_height_m: null,
      avatar_height_applied: false,
      avatar_height_scale: null,
      rig_metrics: null,
      avatar_visual_visible: false,
      visual_layer_ready: false,
      settled: false,
      attachedItems: [],
      errors: [],
    };

    this.ready = this._init().catch((err) => {
      this.status.renderer = "failed";
      this.status.errors.push(`layer init failed: ${err.message}`);
      this.status.settled = true;
      return this;
    });
  }

  async _init() {
    const w = this.mount.clientWidth || 640;
    const h = this.mount.clientHeight || 420;
    if (this.sharedScene) {
      // adopt the HOST world's renderer/scene/camera. No second canvas,
      // no second depth buffer, no layer lights (the world's lights light the
      // avatar — see the lighting-reconciliation note on the class doc). The
      // references are the host's real objects, so identity probes
      // (__depthProbeLayers same_renderer/same_scene) are genuinely true.
      this.renderer = this.host.renderer || null;
      this.scene = this.host.scene;
      this.camera = this.host.camera || null;
    } else {
      this.renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: true,
        preserveDrawingBuffer: true,
        failIfMajorPerformanceCaveat: false,
      });
      if (!this.renderer.getContext()) throw new Error("equipment layer WebGL context unavailable");
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      this.renderer.setSize(w, h);
      this.renderer.setClearColor(0x000000, 0);
      this.renderer.domElement.className = "avatar-equipment-layer";
      this.renderer.domElement.setAttribute("aria-hidden", "true");
      this.mount.appendChild(this.renderer.domElement);

      this.scene = new THREE.Scene();
      this.camera = new THREE.PerspectiveCamera(50, w / h, 0.1, 100);
      this.camera.position.set(0, 6.2, 8.4);
      this.camera.lookAt(0, 0, 0);
      this.scene.add(new THREE.AmbientLight(0xffffff, 0.7));
      const key = new THREE.DirectionalLight(0xffffff, 0.8);
      key.position.set(3, 6, 4);
      this.scene.add(key);
    }

    this.avatarRig = new THREE.Group();
    this.avatarRig.name = "avatar-equipment-rig";
    this.avatarRig.visible = false;
    this.scene.add(this.avatarRig);
    this.fallbackRig = this._buildFallbackRig();
    this.fallbackRig.visible = false;
    this.avatarRig.add(this.fallbackRig);
    this.clock = new THREE.Clock();

    this.status.renderer = "webgl";
    await this._loadVrm();
    await this._loadLocomotionClips();
    this._syncAvatarTransform();
    this._loop = this._loop.bind(this);
    this._raf = requestAnimationFrame(this._loop);
    if (!this.sharedScene) {
      // shared mode has no canvas of its own to refit — the host world's
      // renderer owns sizing, so a resize listener would have nothing to do.
      this._onResize = () => this.resize();
      window.addEventListener("resize", this._onResize);
    }
    this.status.visual_layer_ready = true;
    this.status.settled = true;
    return this;
  }

  _buildFallbackRig() {
    const group = new THREE.Group();
    const bodyMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.16,
      roughness: 0.6,
    });
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.28, 0.75, 6, 14), bodyMat);
    body.name = "fallback-visual-body";
    body.position.y = 0.82;
    group.add(body);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.23, 16, 16), bodyMat);
    head.name = "fallback-visual-head";
    head.position.y = 1.47;
    group.add(head);
    for (const [name, preset] of Object.entries(ATTACHMENT_PRESETS)) {
      const anchor = new THREE.Group();
      anchor.name = `fallback-anchor-${name}`;
      anchor.position.set(preset.position[0], preset.position[1], preset.position[2]);
      group.add(anchor);
      this.anchors[name] = anchor;
    }
    return group;
  }

  _setFallbackRigMeshVisible(visible) {
    if (!this.fallbackRig) return;
    this.fallbackRig.traverse((node) => {
      if ((node.isMesh || node.isSkinnedMesh) && node.name && node.name.startsWith("fallback-visual-")) {
        node.visible = visible;
      }
    });
  }

  async _loadVrm(variantKey = this.status.avatar_variant || DEFAULT_AVATAR_VARIANT) {
    const variant = AVATAR_VARIANTS[variantKey] || AVATAR_VARIANTS[DEFAULT_AVATAR_VARIANT];
    try {
      const { vrm, model, metrics } = await this._loadVrmModel(variant);
      this._adoptVrmModel(variant, vrm, model, metrics);
    } catch (err) {
      this.status.errors.push(`avatar model load failed; fallback avatar hidden: ${err.message}`);
      this.status.real_vrm_loaded = false;
      this.status.avatar_static_glb_loaded = false;
      this.fallbackRig.visible = false;
      this.status.fallback_rig_visible = false;
    }
  }

  async _loadVrmModel(variant) {
    // BEGIN (parametric variant: generate the avatar locally from
    // AvatarParams — no GLB/VRM fetch. The returned engine facade exposes the
    // same surface the demo consumes from three-vrm, so retarget/equipment/
    // grounding paths below run unchanged.)
    if (variant.parametric) {
      const parametric = createParametricAvatar(variant.params || DEFAULT_AVATAR_PARAMS);
      return withRigMetrics(parametric, parametric.scene);
    }
    // END
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));
    const gltf = await fetchAndParseGltf(loader, variant.url);
    const vrm = gltf.userData && gltf.userData.vrm ? gltf.userData.vrm : null;
    const model = (vrm && vrm.scene) || gltf.scene;
    // BEGIN — THE FIX.
    // A rigged GLB (Ready Player Me / Mixamo / Sketchfab) carries a real SkinnedMesh
    // and a real skeleton, but NO `gltf.userData.vrm`. The old code therefore left
    // `vrm` null, which made `real_vrm_loaded` false, which made _loadLocomotionClips()
    // bail before ever constructing an AnimationMixer, which is why these avatars stood
    // frozen — and made _attachmentTarget() fall through to the static fallback anchors,
    // which is why their equipment floated instead of riding the hand.
    //
    // Wrapping the GLB's Mixamo skeleton in a real three-vrm VRMHumanoid gives it the
    // humanoid facade it was missing, and every downstream system then treats it exactly
    // like a VRM. Nothing below this line needed to change.
    return withRigMetrics(vrm, model);
  }

  /**
   * Adopt a loaded VRM as THE avatar model — REPLACES any existing model in
   * the rig (the one-avatar invariant holds by construction: the old model is
   * removed and disposed before the new one is added; never two).
   */
  _adoptVrmModel(variant, vrm, model, metrics = null) {
    this._resetRunFootContactLock("avatar-switch");
    const support = variantSupportStatus(variant);
    this._rigMetrics = metrics || measureRigMetrics(model, vrm);
    const isStaticGlb = support.avatar_asset_type === "glb" && !vrm;
    if (this._avatarModel) {
      this.avatarRig.remove(this._avatarModel);
      this._disposeModel(this._avatarModel);
      this._avatarModel = null;
    }
    if (this.mixer) {
      this.mixer.stopAllAction();
      this.mixer = null;
    }
    this.actions = null;
    this.status.animation_mixer_active = false;
    this.vrm = vrm;
    this.status.real_vrm_loaded = !!vrm;
    this.status.avatar_static_glb_loaded = isStaticGlb;
    // BEGIN (honest render-source label: parametric avatars are
    // GENERATED, not loaded assets — real_vrm_loaded keeps its layer meaning
    // of "a real avatar model is active", this field disambiguates the source)
    // a rigged GLB driven through the humanoid facade is neither a "vrm-asset"
    // nor a "glb-static-asset" — label it for what it is, or the debug state lies.
    this.status.avatar_render_source =
      vrm && vrm.isParametric
        ? "parametric-generated-mesh"
        : vrm && vrm.isGlbHumanoid
          ? "glb-humanoid-rig"
          : isStaticGlb
            ? "glb-static-asset"
            : "vrm-asset";
    // END
    this.status.avatar_variant = variant.key;
    this.status.avatar_variant_label = variant.label;
    this.status.avatar_asset_uri = variant.url;
    Object.assign(this.status, support);
    this.status.avatar_scene_mesh_count = countMeshes(model);
    model.name = isStaticGlb ? "static-glb-avatar" : "real-vrm-avatar";
    // a requested (Universal-Manifest-shaped) preferred height WINS over the
    // variant's authored scale — resolved against THIS rig's measured natural height, so
    // the same request lands the same height on any body. Absent a request, nothing
    // changes: the variant's authored scale is used exactly as before.
    model.scale.setScalar(this._resolveModelScale(variant));
    model.rotation.y = variant.rotation_y;
    this.avatarRig.add(model);
    this._avatarModel = model;
    this.fallbackRig.visible = isStaticGlb;
    this._setFallbackRigMeshVisible(!isStaticGlb);
    this.status.fallback_rig_visible = isStaticGlb;
    this.status.fallback_anchor_rig_visible = isStaticGlb;
    if (isStaticGlb) {
      this.status.retargeted_walk_loaded = false;
      this.status.retargeted_run_loaded = false;
      this.status.animation_mixer_active = false;
      this.status.current_animation_state = "static-glb";
      this.status.locomotion_clips = [];
    }
    // (#9) +: height-tracking evidence — the RENDERED
    // (post-scale) model height and head-bone height, so the dwarf's short/wide physique
    // stays measurable next to the VRoid avatars AND a requested preferred height can be
    // checked against what actually got drawn.
    this._measureRenderedHeight(model);
    // the rig's own anatomy, reported honestly. `head_top_offset_m` is what worn
    // equipment is re-seated against, and `natural_height_m` is what a requested preferred
    // height is resolved against — publish both so the proof can assert on them rather
    // than take the layer's word for it.
    this.status.rig_metrics = this._rigMetrics;
  }

  /**
   * turn a REQUESTED height into a scale factor for THIS rig.
   *
   * This is the whole point of the preferred-height feature: the number a person carries
   * ("I am 1.9 m") is meaningless until it is resolved against the body they are wearing.
   * A Ready Player Me avatar and a VRoid VRM have different natural heights, so the same
   * request must produce DIFFERENT scale factors to land on the SAME height. Falling back
   * to the variant's authored scale when no height is requested keeps every existing
   * avatar pixel-identical.
   */
  _resolveModelScale(variant) {
    const requested = this.status.avatar_preferred_height_m;
    const natural = this._rigMetrics && this._rigMetrics.natural_height_m;
    if (!Number.isFinite(requested) || !Number.isFinite(natural) || natural <= 0.01) {
      this.status.avatar_height_applied = false;
      this.status.avatar_natural_height_m = Number.isFinite(natural) ? natural : null;
      return variant.scale;
    }
    const scale = requested / natural;
    this.status.avatar_height_applied = true;
    this.status.avatar_natural_height_m = natural;
    this.status.avatar_height_scale = Number(scale.toFixed(4));
    return scale;
  }

  /**
   * THE SEAM a Universal Manifest avatar facet would call.
   *
   * Set the person's preferred body height in metres (or null to fall back to the
   * variant's authored scale) and re-fit the CURRENT avatar to it immediately. Equipment
   * is re-attached afterwards so worn/held items re-seat against the resized skeleton.
   *
   * Deliberately NOT wired to a UM read here ("we don't have to wire it up to the
   * Universal Manifest now") — but the application half is real, measured, and proven, so
   * wiring it later is a call to this method and nothing else.
   */
  async applyPreferredHeightM(heightM) {
    if (heightM === null || heightM === undefined || heightM === "") {
      this.status.avatar_preferred_height_m = null;
    } else {
      const h = Number(heightM);
      if (!Number.isFinite(h)) return { ok: false, error: `preferred height '${heightM}' is not a number` };
      if (h < PREFERRED_HEIGHT_BOUNDS_M.min || h > PREFERRED_HEIGHT_BOUNDS_M.max) {
        return {
          ok: false,
          error: `preferred height ${h} m is outside the supported bounds ` +
            `${PREFERRED_HEIGHT_BOUNDS_M.min}-${PREFERRED_HEIGHT_BOUNDS_M.max} m`,
        };
      }
      this.status.avatar_preferred_height_m = h;
    }

    const model = this._avatarModel;
    const variant = AVATAR_VARIANTS[this.status.avatar_variant] || AVATAR_VARIANTS[DEFAULT_AVATAR_VARIANT];
    if (!model) return { ok: true, deferred_until_avatar_loaded: true, preferred_height_m: this.status.avatar_preferred_height_m };

    model.scale.setScalar(this._resolveModelScale(variant));
    this._measureRenderedHeight(model);
    await this._syncEquipment(); // items re-seat against the resized skeleton
    return {
      ok: true,
      preferred_height_m: this.status.avatar_preferred_height_m,
      natural_height_m: this.status.avatar_natural_height_m,
      rendered_height_m: this.status.avatar_model_height_m,
      applied: this.status.avatar_height_applied === true,
    };
  }

  /** Rendered (post-scale) height + head height — the numbers the height proof asserts on. */
  _measureRenderedHeight(model) {
    try {
      // BODY bounds, not model bounds — see avatarBodyBounds. Including the crown here is
      // what made a requested 1.75 m avatar render at 1.845 m.
      const bounds = avatarBodyBounds(model);
      this.status.avatar_model_height_m = bounds ? Number((bounds.max.y - bounds.min.y).toFixed(3)) : null;
    } catch (err) {
      this.status.avatar_model_height_m = null;
    }
    try {
      const head =
        this.vrm && this.vrm.humanoid && typeof this.vrm.humanoid.getRawBoneNode === "function"
          ? this.vrm.humanoid.getRawBoneNode("head")
          : null;
      if (head) {
        model.updateWorldMatrix(true, true);
        const headWorld = new THREE.Vector3();
        head.getWorldPosition(headWorld);
        const rootWorld = new THREE.Vector3();
        model.getWorldPosition(rootWorld);
        this.status.avatar_head_height_m = Number((headWorld.y - rootWorld.y).toFixed(3));
      } else {
        this.status.avatar_head_height_m = null;
      }
    } catch (err) {
      this.status.avatar_head_height_m = null;
    }
  }

  /**
   * seat a worn head item ON THIS RIG'S ACTUAL HEAD.
   *
   * The catalog's authored y-offsets are absolute metres measured against one VRoid skull,
   * and they left the crown hovering above the hair on BOTH the Ready Player Me avatar and
   * the reference VRM. Rather than hand-tune a number per avatar (which does not generalise,
   * and which the user explicitly wants to avoid — a preferred HEIGHT has to work on any
   * body), the item is placed from the rig's own anatomy:
   *
   *     y = headTop - itemUnderside - sink x itemHeight
   *
   * so the item's underside lands on the measured crown of the head and then settles into it
   * by a fraction of its own size. Every term is measured, so this is correct at any avatar
   * height and any item scale. The authored x/z nudge is preserved.
   *
   * @returns {object|null} seating evidence, or null when the rig could not be measured
   */
  _seatOnHeadTop(object, item) {
    return seatHeadItem(object, item, this._rigMetrics && this._rigMetrics.head_top_offset_m);
  }

  _disposeModel(root) {
    root.traverse((node) => {
      if (node.geometry && typeof node.geometry.dispose === "function") node.geometry.dispose();
      const materials = Array.isArray(node.material) ? node.material : node.material ? [node.material] : [];
      for (const material of materials) {
        for (const value of Object.values(material)) {
          if (value && value.isTexture && typeof value.dispose === "function") value.dispose();
        }
        if (typeof material.dispose === "function") material.dispose();
      }
    });
  }

  /**
   * step 5: switch the avatar to a different VRM at runtime.
   * REPLACES the one avatar model (never adds a second), re-retargets the
   * mocap locomotion set onto the new humanoid rig, and re-attaches the
   * CURRENT equipment to the new VRM's bones. The new model is fully loaded
   * BEFORE the old one is touched, so a failed load never leaves the rig
   * empty. Concurrent requests are queued last-write-wins.
   */
  async switchAvatarVariant(variantKey) {
    const variant = AVATAR_VARIANTS[variantKey];
    if (!variant) return { ok: false, error: `unknown avatar variant '${variantKey}'` };
    if (
      variant.key === this.status.avatar_variant &&
      (this.status.real_vrm_loaded || this.status.avatar_static_glb_loaded)
    ) {
      return { ok: true, unchanged: true, variant: variant.key };
    }
    if (this._switchInFlight) {
      this._pendingVariant = variant.key;
      return { ok: true, queued: true, variant: variant.key };
    }
    this._switchInFlight = true;
    this.status.avatar_switch_in_flight = true;
    this.status.settled = false;
    try {
      const { vrm, model, metrics } = await this._loadVrmModel(variant);
      if (!vrm && variant.type !== "glb") throw new Error(`${variant.url} is not a VRM`);
      this._adoptVrmModel(variant, vrm, model, metrics);
      await this._loadLocomotionClips(); // re-retarget the mocap set onto the new rig
      await this._syncEquipment(); // re-attach current equipment to the new VRM's bones
      this.status.avatar_switch_count += 1;
      return { ok: true, variant: variant.key, support_status: variantSupportStatus(variant) };
    } catch (err) {
      this.status.errors.push(`avatar switch to '${variantKey}' failed: ${err.message}`);
      return { ok: false, error: err.message };
    } finally {
      this._switchInFlight = false;
      this.status.avatar_switch_in_flight = false;
      this.status.settled = true;
      const pending = this._pendingVariant;
      this._pendingVariant = null;
      if (pending && pending !== this.status.avatar_variant) this.switchAvatarVariant(pending);
    }
  }

  /**
   * build the blended locomotion clip set (idle/walk/run +
   * authored jump) by retargeting the real Xbot mocap cycles onto THIS VRM's
   * normalized humanoid rig (retarget-mocap.js — the quality-pass
   * pipeline). The mixer is rooted at vrm.scene so track names resolve to the
   * normalized bone nodes; vrm.update() then propagates normalized -> raw.
   * Replaces the old single ~12fps SkeletonUtils walk + per-frame procedural
   * arm/leg override (which fought the mixer and read as a T-pose shuffle).
   */
  async _loadLocomotionClips() {
    this._resetRunFootContactLock("locomotion-reload");
    if (!this.status.real_vrm_loaded) {
      this.status.retargeted_walk_loaded = false;
      this.status.retargeted_track_count = 0;
      this.status.retargeted_non_identity_quaternion_samples = 0;
      this.status.locomotion_clips = [];
      this.status.animation_mixer_active = false;
      if (this.status.avatar_static_glb_loaded) this.status.current_animation_state = "static-glb";
      return;
    }
    try {
      const clips = await createRetargetedLocomotionClips(this.vrm, MOCAP_URLS);
      if (!clips.walk || !clips.walk.tracks.length) throw new Error("retargeted walk produced no tracks");

      this.mixer = new THREE.AnimationMixer(this.vrm.scene);
      this.actions = {};
      this._runCalibrationTelemetry = {
        active_wall_seconds: 0,
        active_clip_seconds: 0,
        completed_cycles: 0,
      };
      this.status.jump_playback = jumpPlaybackStatus(this._jumpPlaybackFault);
      this._lastJumpActionTime = null;
      for (const [state, clip] of Object.entries(clips)) {
        const action = this.mixer.clipAction(clip);
        action.enabled = true;
        const isJump = state === "jump";
        const useFault = isJump && this._jumpPlaybackFault === JUMP_PLAYBACK_FAULT;
        action.setLoop(isJump && !useFault ? THREE.LoopOnce : THREE.LoopRepeat, isJump && !useFault ? 1 : Infinity);
        action.clampWhenFinished = isJump && !useFault;
        action.setEffectiveWeight(state === "idle" ? 1 : 0);
        action.play();
        // The jump must not accumulate an invisible clock while its weight is
        // zero. It is unpaused and reset only on the airborne edge below.
        if (isJump && !useFault) action.paused = true;
        this.actions[state] = action;
      }
      // World-speed playback match (treadmill fix): scale the walk cycle so its
      // stride speed equals the adapter's real world translation speed.
      this.actions.walk.setEffectiveTimeScale(WORLD_MOVE_SPEED_MPS / WALK_NATURAL_SPEED_MPS);
      this._animState = "idle";

      this.status.retargeted_walk_loaded = true;
      this.status.retargeted_run_loaded = Boolean(clips.run && clips.run.tracks.length);
      this.status.retarget_source_animation =
        "self-authored procedural idle, walk, run, and jump clips";
      this.status.retargeted_track_count = clips.walk.tracks.length;
      this.status.retargeted_track_names = clips.walk.tracks.map((track) => track.name).slice(0, 40);
      this.status.retargeted_non_identity_quaternion_samples = countNonIdentityQuaternionSamples(clips.walk);
      this.status.locomotion_clips = Object.values(clips).map(
        (clip) => `${clip.name}(${clip.duration.toFixed(2)}s,${clip.tracks.length}t)`
      );
      this.status.animation_mixer_active = true;
      this.status.mapped_bone_count = clips.walk.tracks.filter((t) => t.name.endsWith(".quaternion")).length;
      this._syncJumpPlaybackTelemetry();
    } catch (err) {
      this.status.errors.push(`locomotion clip load failed: ${err.message}`);
      this.status.retargeted_walk_loaded = false;
      this.status.retargeted_run_loaded = false;
      this.status.animation_mixer_active = false;
    }
  }

  /**
   * characterize the selected run action without changing it. Every
   * supported GLB, VRM, and parametric facade reaches this same action map.
   */
  characterizeRunCalibration(translationSpeedMps) {
    const action = this.actions && this.actions.run;
    const clipDuration = Number(action && action.getClip().duration);
    const translationSpeed = Number(translationSpeedMps);
    if (!action || !Number.isFinite(clipDuration) || clipDuration <= 0) {
      throw new Error("selected run clip is unavailable for runtime calibration");
    }
    if (!Number.isFinite(translationSpeed) || translationSpeed <= 0) {
      throw new RangeError("run translation speed must be a positive finite value");
    }
    const runCycleDistance = RUN_CYCLE_DISTANCE_M;
    const runCycleSpeed = translationSpeed / runCycleDistance;
    const playbackRate = runCycleSpeed * clipDuration;
    this.status.run_calibration = {
      ...this.status.run_calibration,
      supported: true,
      source_derived: true,
      rig_path: this.status.avatar_render_source || this.status.avatar_variant,
      run_clip_duration_seconds: clipDuration,
      run_playback_rate: playbackRate,
      run_cycle_speed: runCycleSpeed,
      run_cycle_distance: runCycleDistance,
      effective_run_translation_speed_mps: translationSpeed,
      cadence_steps_per_min: runCycleSpeed * 120,
      gait_cycle_mapping: "one run loop = one same-foot-to-same-foot two-step cycle",
      calibration_source: "runtime fixed-foot/sole-derived measured run-cycle distance",
      formula: "cycles_per_second=translation_mps/measured_run_metres_per_cycle; animation_time_scale=cycles_per_second*clip_duration_s",
    };
    return { ...this.status.run_calibration };
  }

  /**
   * Locomotion FSM: pick the desired state from the mirrored adapter
   * locomotion flags and crossfade action weights toward it. Runs for the
   * player AND both observer mirrors (same layer code).
   */
  _updateLocomotionState(delta) {
    if (!this.actions) return;
    const airborne = this.status.avatar_grounded === false || (this.status.avatar_jump_height_m || 0) > 0.02;
    const desired = airborne && this.actions.jump
      ? "jump"
      : this.status.locomotion_moving &&
          this.status.locomotion_run_mode &&
          this.status.locomotion_movement_mode === "run" &&
          this.actions.run
        ? "run"
        : this.status.locomotion_moving
          ? "walk"
          : "idle";
    const previous = this._animState;
    if (desired !== previous) {
      const jump = this.actions.jump;
      const playback = this.status.jump_playback;
      if (desired === "jump" && jump) {
        playback.cycle_count += 1;
        if (this._jumpPlaybackFault !== JUMP_PLAYBACK_FAULT) {
          jump.reset();
          jump.setLoop(THREE.LoopOnce, 1);
          jump.clampWhenFinished = true;
          jump.setEffectiveTimeScale(1);
          jump.play();
          playback.takeoff_reset_count += 1;
        }
        playback.takeoff_action_time_seconds = Number(jump.time.toFixed(4));
        playback.takeoff_weight = Number(jump.getEffectiveWeight().toFixed(4));
        this._lastJumpActionTime = jump.time;
      } else if (previous === "jump" && jump) {
        playback.landing_count += 1;
        playback.landing_action_time_seconds = Number(jump.time.toFixed(4));
        this._lastJumpActionTime = null;
      }
      if (desired === "run") {
        this._runCalibrationTelemetry = {
          active_wall_seconds: 0,
          active_clip_seconds: 0,
          completed_cycles: 0,
        };
      }
      this._animState = desired;
    }
    this.status.current_animation_state = this._animState;
    if ((desired === "walk" || desired === "run") && this.actions[desired]) {
      const speedMps = Number(this.status.locomotion_speed_mps) || WORLD_MOVE_SPEED_MPS;
      const runCycleSpeed = Number(this.avatar?.locomotion?.run_cycle_speed);
      const clipDuration = Number(this.actions[desired].getClip().duration) || 0;
      const playbackRate = desired === "run" && Number.isFinite(runCycleSpeed) && runCycleSpeed > 0
        ? runCycleSpeed * clipDuration
        : speedMps / WALK_NATURAL_SPEED_MPS;
      this.actions[desired].setEffectiveTimeScale(playbackRate);
      this.status.locomotion_playback_rate = Number(playbackRate.toFixed(3));
    }
    const step = LOCOMOTION_CROSSFADE_S > 0 ? delta / LOCOMOTION_CROSSFADE_S : 1;
    for (const [state, action] of Object.entries(this.actions)) {
      const target = state === this._animState ? 1 : 0;
      const weight = action.getEffectiveWeight();
      const next = target > weight ? Math.min(target, weight + step) : Math.max(target, weight - step);
      action.setEffectiveWeight(next);
    }
  }

  _syncRunCalibrationTelemetry(delta) {
    const action = this.actions && this.actions.run;
    if (!action) return;
    const duration = Number(action.getClip().duration) || 0;
    const locomotion = this.avatar && this.avatar.locomotion ? this.avatar.locomotion : {};
    const configuredCycleSpeed = Number(locomotion.run_cycle_speed);
    // Outside the run state the action can retain its loader-time scale of 1.
    // Report the installed calibration, not that inactive implementation detail.
    const playbackRate = this._animState === "run"
      ? Number(action.getEffectiveTimeScale()) || 0
      : Number.isFinite(configuredCycleSpeed) && configuredCycleSpeed > 0
        ? configuredCycleSpeed * duration
        : Number(action.getEffectiveTimeScale()) || 0;
    if (duration <= 0 || playbackRate <= 0) return;
    if (this._animState === "run") {
      this._runCalibrationTelemetry.active_wall_seconds += delta;
      this._runCalibrationTelemetry.active_clip_seconds += delta * playbackRate;
      this._runCalibrationTelemetry.completed_cycles = Math.floor(
        (this._runCalibrationTelemetry.active_clip_seconds + 1e-9) / duration
      );
    }
    const runCycleSpeed = playbackRate / duration;
    const translationSpeed = Number(locomotion.run_translation_speed_mps) || Number(locomotion.speed_mps) || 0;
    const runCycleDistance = Number(locomotion.run_cycle_distance) || RUN_CYCLE_DISTANCE_M;
    this.status.run_calibration = {
      ...this.status.run_calibration,
      supported: true,
      rig_path: this.status.avatar_render_source || this.status.avatar_variant,
      run_clip_duration_seconds: duration,
      run_playback_rate: playbackRate,
      run_cycle_speed: runCycleSpeed,
      run_cycle_distance: runCycleDistance,
      effective_run_translation_speed_mps: runCycleDistance ? runCycleSpeed * runCycleDistance : translationSpeed,
      cadence_steps_per_min: runCycleSpeed * 120,
      action_time_seconds: Number(action.time.toFixed(6)),
      active_wall_seconds: Number(this._runCalibrationTelemetry.active_wall_seconds.toFixed(6)),
      active_clip_seconds: Number(this._runCalibrationTelemetry.active_clip_seconds.toFixed(6)),
      completed_cycles: this._runCalibrationTelemetry.completed_cycles,
    };
  }

  _resetRunFootContactLock(reason = "state-transition") {
    const lock = this._runFootContactLock;
    const status = this.status && this.status.run_contact_lock;
    const hadCorrection = Boolean(lock && (lock.activeSide || lock.release));
    if (status && hadCorrection) {
      if (reason === "dispose" || reason === "avatar-switch" || reason === "locomotion-reload") {
        status.lifecycle_release_count += 1;
      } else if (reason === "phase-discontinuity") {
        status.phase_discontinuity_release_count += 1;
      } else {
        status.state_transition_release_count += 1;
      }
    }
    this._runFootContactLock = null;
    if (!status) return;
    status.active = false;
    status.active_side = null;
    status.phase_seconds = null;
    status.plant_window = null;
    status.anchor_world_xz = null;
    status.horizontal_error_mm = 0;
    status.release_active = false;
  }

  _runFootContactPoint(side) {
    const lock = this._runFootContactLock;
    const fixedMarker = lock && lock.markers && lock.markers[side];
    if (fixedMarker && fixedMarker.mesh && typeof fixedMarker.mesh.getVertexPosition === "function") {
      const point = new THREE.Vector3();
      fixedMarker.mesh.getVertexPosition(fixedMarker.vertex, point);
      fixedMarker.mesh.localToWorld(point);
      return point;
    }
    const raw = this.vrm?.humanoid?.getRawBoneNode?.(`${side}Foot`);
    return raw ? raw.getWorldPosition(new THREE.Vector3()) : null;
  }

  _applyRunFootContactLock(delta) {
    const action = this.actions && this.actions.run;
    const duration = Number(action && action.getClip().duration);
    const status = this.status.run_contact_lock;
    const inRun = this._animState === "run" && this.status.locomotion_movement_mode === "run";
    if (!action || !this.vrm || !this._avatarModel || !Number.isFinite(duration) || duration <= 0 || !inRun) {
      if (this._runFootContactLock && (this._runFootContactLock.activeSide || this._runFootContactLock.release)) {
        status.outside_run_release_count += 1;
      }
      this._resetRunFootContactLock("state-transition");
      return;
    }

    if (!this._runFootContactLock || this._runFootContactLock.model !== this._avatarModel) {
      const defaultSole = this.status.avatar_variant === DEFAULT_AVATAR_VARIANT
        ? this._avatarModel.getObjectByName("Object_21")
        : null;
      this._runFootContactLock = {
        model: this._avatarModel,
        activeSide: null,
        anchor: null,
        corrected: null,
        previousPhase: null,
        release: null,
        markers: {
          left: defaultSole && defaultSole.isSkinnedMesh ? { mesh: defaultSole, vertex: 289 } : null,
          right: defaultSole && defaultSole.isSkinnedMesh ? { mesh: defaultSole, vertex: 777 } : null,
        },
      };
    }
    const lock = this._runFootContactLock;
    const phase = ((Number(action.time) % duration) + duration) % duration;
    const expectedAdvance = Math.max(0, Number(delta) || 0) * Math.max(0, Number(action.getEffectiveTimeScale()) || 0);
    if (lock.previousPhase !== null) {
      const actualAdvance = (phase - lock.previousPhase + duration) % duration;
      if (actualAdvance > Math.max(0.08, expectedAdvance * 3 + 0.01)) {
        this._resetRunFootContactLock("phase-discontinuity");
        return;
      }
    }
    lock.previousPhase = phase;

    const activeSides = Object.entries(RUN_CONTACT_WINDOWS_S)
      .filter(([, window]) => window.end <= duration
        ? phase >= window.start && phase <= window.end
        : phase >= window.start || phase <= window.end - duration)
      .map(([side]) => side);
    if (activeSides.length > 1) {
      status.simultaneous_overconstraint_count += 1;
      this._resetRunFootContactLock("simultaneous-overconstraint");
      return;
    }
    const side = activeSides[0] || null;
    const humanoid = this.vrm.humanoid;
    const upper = side ? humanoid?.getNormalizedBoneNode?.(`${side}UpperLeg`) : null;
    const lower = side ? humanoid?.getNormalizedBoneNode?.(`${side}LowerLeg`) : null;
    const foot = side ? humanoid?.getNormalizedBoneNode?.(`${side}Foot`) : null;

    if (lock.activeSide && lock.activeSide !== side) {
      const releaseUpper = humanoid?.getNormalizedBoneNode?.(`${lock.activeSide}UpperLeg`);
      const releaseLower = humanoid?.getNormalizedBoneNode?.(`${lock.activeSide}LowerLeg`);
      lock.release = releaseUpper && releaseLower
        ? {
            side: lock.activeSide,
            elapsed: 0,
            upper: lock.corrected?.side === lock.activeSide
              ? lock.corrected.upper.clone()
              : releaseUpper.quaternion.clone(),
            lower: lock.corrected?.side === lock.activeSide
              ? lock.corrected.lower.clone()
              : releaseLower.quaternion.clone(),
          }
        : null;
      lock.activeSide = null;
      lock.anchor = null;
      lock.corrected = null;
    }

    if (side && upper && lower && foot) {
      lock.release = null;
      this.vrm.update(0);
      this._avatarModel.updateMatrixWorld(true);
      const current = this._runFootContactPoint(side);
      if (!current) {
        this._resetRunFootContactLock("missing-foot");
        return;
      }
      if (lock.activeSide !== side || !lock.anchor) {
        lock.activeSide = side;
        lock.anchor = current.clone();
      }

      const identity = new THREE.Quaternion();
      const worldDelta = new THREE.Quaternion();
      const parentWorld = new THREE.Quaternion();
      const localDelta = new THREE.Quaternion();
      const boneWorld = new THREE.Vector3();
      const endWorld = new THREE.Vector3();
      const targetWorld = new THREE.Vector3();
      const toEnd = new THREE.Vector3();
      const toTarget = new THREE.Vector3();
      let horizontalError = 0;
      for (let iteration = 0; iteration < 4; iteration += 1) {
        this.vrm.update(0);
        this._avatarModel.updateMatrixWorld(true);
        const marker = this._runFootContactPoint(side);
        if (!marker) break;
        const errorX = lock.anchor.x - marker.x;
        const errorZ = lock.anchor.z - marker.z;
        horizontalError = Math.hypot(errorX, errorZ);
        if (horizontalError <= 0.0005) break;
        foot.getWorldPosition(endWorld);
        targetWorld.copy(endWorld).set(endWorld.x + errorX, endWorld.y, endWorld.z + errorZ);
        for (const bone of [lower, upper]) {
          bone.updateWorldMatrix(true, true);
          foot.getWorldPosition(endWorld);
          bone.getWorldPosition(boneWorld);
          toEnd.copy(endWorld).sub(boneWorld);
          toTarget.copy(targetWorld).sub(boneWorld);
          if (toEnd.lengthSq() <= 1e-10 || toTarget.lengthSq() <= 1e-10) continue;
          worldDelta.setFromUnitVectors(toEnd.normalize(), toTarget.normalize());
          const angle = identity.angleTo(worldDelta);
          if (angle > 0.35) worldDelta.slerp(identity, 1 - 0.35 / angle);
          bone.parent.getWorldQuaternion(parentWorld);
          localDelta.copy(parentWorld).invert().multiply(worldDelta).multiply(parentWorld);
          bone.quaternion.premultiply(localDelta).normalize();
        }
      }
      this.vrm.update(0);
      this._avatarModel.updateMatrixWorld(true);
      const corrected = this._runFootContactPoint(side);
      horizontalError = corrected ? Math.hypot(lock.anchor.x - corrected.x, lock.anchor.z - corrected.z) : horizontalError;
      lock.corrected = {
        side,
        upper: upper.quaternion.clone(),
        lower: lower.quaternion.clone(),
      };
      status.active = true;
      status.active_side = side;
      status.phase_seconds = Number(phase.toFixed(6));
      status.plant_window = { ...RUN_CONTACT_WINDOWS_S[side] };
      status.anchor_world_xz = [Number(lock.anchor.x.toFixed(6)), Number(lock.anchor.z.toFixed(6))];
      status.horizontal_error_mm = Number((horizontalError * 1000).toFixed(3));
      status.max_horizontal_error_mm = Math.max(status.max_horizontal_error_mm, status.horizontal_error_mm);
      status.release_active = false;
      return;
    }

    status.active = false;
    status.active_side = null;
    status.phase_seconds = Number(phase.toFixed(6));
    status.plant_window = null;
    status.anchor_world_xz = null;
    status.horizontal_error_mm = 0;
    if (lock.release) {
      const releaseUpper = humanoid?.getNormalizedBoneNode?.(`${lock.release.side}UpperLeg`);
      const releaseLower = humanoid?.getNormalizedBoneNode?.(`${lock.release.side}LowerLeg`);
      if (!releaseUpper || !releaseLower) {
        lock.release = null;
      } else {
        lock.release.elapsed += Math.max(0, Number(delta) || 0);
        const linear = Math.min(1, lock.release.elapsed / RUN_CONTACT_RELEASE_S);
        const blend = linear * linear * (3 - 2 * linear);
        const nativeUpper = releaseUpper.quaternion.clone();
        const nativeLower = releaseLower.quaternion.clone();
        releaseUpper.quaternion.copy(lock.release.upper).slerp(nativeUpper, blend);
        releaseLower.quaternion.copy(lock.release.lower).slerp(nativeLower, blend);
        status.release_active = blend < 1;
        if (blend >= 1) lock.release = null;
      }
    } else {
      status.release_active = false;
    }
  }

  _syncJumpPlaybackTelemetry() {
    const action = this.actions && this.actions.jump;
    const playback = this.status.jump_playback;
    if (!action || !playback) return;
    const duration = Number(action.getClip().duration) || 0;
    const time = Number(action.time) || 0;
    const airborne = this.status.avatar_grounded === false || (this.status.avatar_jump_height_m || 0) > 0.02;
    if (
      airborne &&
      this._lastJumpActionTime !== null &&
      time + 0.05 < this._lastJumpActionTime
    ) {
      playback.midair_restart_count += 1;
    }
    this._lastJumpActionTime = airborne ? time : null;
    playback.clip_duration_seconds = Number(duration.toFixed(4));
    playback.action_time_seconds = Number(time.toFixed(4));
    playback.normalized_time = duration > 0 ? Number((time / duration).toFixed(4)) : 0;
    playback.effective_weight = Number(action.getEffectiveWeight().toFixed(4));
    playback.effective_time_scale = Number(action.getEffectiveTimeScale().toFixed(4));
    playback.loop_mode = action.loop === THREE.LoopOnce
      ? "LoopOnce"
      : action.loop === THREE.LoopPingPong
        ? "LoopPingPong"
        : "LoopRepeat";
    playback.repetitions = Number.isFinite(action.repetitions) ? action.repetitions : "Infinity";
    playback.clamp_when_finished = action.clampWhenFinished === true;
    playback.paused = action.paused === true;
    playback.running = action.isRunning();
    playback.finished = action.paused === true && duration > 0 && time >= duration - 0.0001;
    playback.airborne = airborne;
    playback.phase = !airborne
      ? "grounded"
      : time < 0.18
        ? "crouch-launch"
        : time < 0.42
          ? "airborne-tuck"
          : time < duration - 0.0001
            ? "descent-landing"
            : "landing-hold";
  }

  async _loadItem(item) {
    if (this.loadedItemObjects.has(item.itemId)) {
      return this.loadedItemObjects.get(item.itemId).clone(true);
    }
    const loader = new GLTFLoader();
    let assetRoot = null;
    let assetLoaded = false;
    let assetMeshCount = 0;
    try {
      const gltf = await loader.loadAsync(item.assetUri);
      assetRoot = gltf.scene || new THREE.Group();
      assetMeshCount = countMeshes(assetRoot);
      assetLoaded = true;
    } catch (err) {
      this.status.errors.push(`${item.itemId} asset load failed: ${err.message}`);
    }
    const visualRoot = new THREE.Group();
    visualRoot.name = `attached-equipment-${item.itemId}`;
    if (assetRoot) {
      assetRoot.name = `asset-${item.itemId}`;
      assetRoot.scale.setScalar(0.2);
      visualRoot.add(assetRoot);
    }
    const marker = makeVisualMarker(item);
    marker.name = `visible-equipment-marker-${item.itemId}`;
    visualRoot.add(marker);
    visualRoot.userData.equipmentProof = {
      itemId: item.itemId,
      assetLoaded,
      assetMeshCount,
      visualMarkerAttached: true,
    };
    this.loadedItemObjects.set(item.itemId, visualRoot.clone(true));
    return visualRoot;
  }

  _attachmentTarget(item) {
    const point = item.attachmentPoint;
    if (this.vrm && this.vrm.humanoid && typeof this.vrm.humanoid.getNormalizedBoneNode === "function") {
      const bone = this.vrm.humanoid.getNormalizedBoneNode(point);
      if (bone) return { node: bone, type: "vrm-normalized-bone" };
    }
    return { node: this.anchors[point] || this.avatarRig, type: "fallback-anchor" };
  }

  /**
   * Serialized equipment sync — a switch-triggered re-attach and a
   * signature-triggered resync can otherwise interleave their awaits and
   * attach items twice. The chain guarantees one _syncEquipmentNow at a time.
   */
  _syncEquipment() {
    this._equipmentSyncChain = (this._equipmentSyncChain || Promise.resolve())
      .then(() => this._syncEquipmentNow())
      .catch((err) => {
        this.status.errors.push(`equipment sync failed: ${err.message}`);
        this.status.settled = true;
      });
    return this._equipmentSyncChain;
  }

  async _syncEquipmentNow() {
    const items = this.avatar && Array.isArray(this.avatar.equippedItems) ? this.avatar.equippedItems : [];
    for (const object of this.attachedObjects) {
      if (object.parent) object.parent.remove(object);
    }
    this.attachedObjects = [];
    this.status.attachedItems = [];
    if (!items.length) {
      this.status.settled = true;
      return;
    }
    this.status.settled = false;
    for (const item of items) {
      const target = this._attachmentTarget(item);
      const object = await this._loadItem(item);
      applyLocalTransform(object, item);
      // worn HEAD items are re-seated onto THIS rig's measured skull instead of
      // trusting the catalog's absolute offset (which floated the crown on every avatar).
      // Held items keep their authored grip offset — the measured ~4 cm hand grips were
      // already landing correctly, and hands vary little between rigs.
      const seating =
        item.mode === "worn" && item.attachmentPoint === "head" && target.type !== "fallback-anchor"
          ? this._seatOnHeadTop(object, item)
          : null;
      target.node.add(object);
      this.attachedObjects.push(object);
      const validation = object.userData.equipmentProof || {};
      this.status.attachedItems.push({
        itemId: item.itemId,
        mode: item.mode,
        attachmentPoint: item.attachmentPoint,
        assetUri: item.assetUri,
        target: target.type,
        asset_loaded: validation.assetLoaded === true,
        asset_mesh_count: validation.assetMeshCount || 0,
        visual_marker_attached: validation.visualMarkerAttached === true,
        seating,
      });
    }
    this.status.settled = true;
  }

  setAvatar(avatar) {
    const previousSignature = this._equipmentSignature;
    this.avatar = avatar || null;
    this._syncAvatarTransform();
    // step 5: a runtime avatar switch flows through the
    // avatar state (player UI sets it on the adapter; observers receive it via
    // the pose/arrival mirrors) — the layer reacts here for all three views.
    const requestedVariant = this.avatar && this.avatar.avatar_variant;
    if (
      requestedVariant &&
      AVATAR_VARIANTS[requestedVariant] &&
      requestedVariant !== this.status.avatar_variant
    ) {
      this.switchAvatarVariant(requestedVariant);
    }
    // preferred height rides the SAME avatar-state channel as the variant, so
    // observers and remote peers re-fit the body exactly as the player sees it — no new
    // presence plumbing. `null` means "no preference", which restores the variant scale.
    const requestedHeight = this.avatar ? this.avatar.preferred_height_m : null;
    const currentHeight = this.status.avatar_preferred_height_m;
    // NORMALIZE NULL BEFORE COERCING. `Number(null)` is 0 and `Number.isFinite(0)` is true,
    // so the obvious one-liner turns "no preference" into "0 m tall" — which then fails the
    // minimum-height bounds check and silently leaves the avatar at its previous size. This
    // is the project's known null-coercion trap (see the readNumber lesson); it bit here
    // too, and the height proof caught it.
    const normalized =
      requestedHeight === null || requestedHeight === undefined || requestedHeight === ""
        ? null
        : Number.isFinite(Number(requestedHeight))
          ? Number(requestedHeight)
          : null;
    if (normalized !== currentHeight) this.applyPreferredHeightM(normalized);
    const items = this.avatar && Array.isArray(this.avatar.equippedItems) ? this.avatar.equippedItems : [];
    this._equipmentSignature = JSON.stringify(
      items.map((item) => [
        item.itemId,
        item.mode,
        item.attachmentPoint,
        item.assetUri,
        item.localTransform,
      ])
    );
    if (this._equipmentSignature !== previousSignature) this._syncEquipment();
  }

  _syncAvatarTransform() {
    if (!this.avatarRig) return;
    if (!this.avatar) {
      this.avatarRig.visible = false;
      this.status.avatar_visual_visible = false;
      return;
    }
    const visual = this.avatar.transition_visual || {};
    const reducedMotion = this.motionPreference?.isReduced?.() === true;
    const visualScale = reducedMotion
      ? 1
      : Number.isFinite(Number(visual.scale)) ? Number(visual.scale) : 1;
    this.avatarRig.visible = reducedMotion || visual.visible !== false;
    this.status.avatar_visual_visible = this.avatarRig.visible;
    this.status.avatar_visual_scale = Number(visualScale.toFixed(3));
    const p = this.avatar.position || [0, 0, 0];
    this.avatarRig.position.set(p[0], p[1] || 0, p[2]);
    this.avatarRig.rotation.y = (this.avatar.rotation_y || 0) + (reducedMotion ? 0 : Number(visual.spin_y) || 0);
    this.avatarRig.scale.setScalar(Math.max(0.001, visualScale));
    const locomotion = this.avatar.locomotion || {};
    this.status.locomotion_moving = locomotion.moving === true;
    this.status.locomotion_movement_mode = locomotion.movement_mode || (locomotion.moving ? "walk" : "idle");
    this.status.locomotion_run_mode = locomotion.run_mode === true;
    this.status.locomotion_speed_mps = Number(locomotion.speed_mps) || 0;
    this.status.avatar_grounded = locomotion.grounded !== false;
    this.status.avatar_jump_height_m = Number.isFinite(Number(locomotion.jump_height_m))
      ? Number(locomotion.jump_height_m)
      : Math.max(0, Number(p[1]) || 0);
  }

  isSettled() {
    return this.status.settled === true;
  }

  debugState() {
    const items = this.avatar && Array.isArray(this.avatar.equippedItems) ? this.avatar.equippedItems : [];
    const hasHeld = this.status.attachedItems.some((item) => item.mode === "held");
    const hasWorn = this.status.attachedItems.some((item) => item.mode === "worn");
    return {
      ...this.status,
      locomotion_action_weights: Object.fromEntries(
        Object.entries(this.actions || {}).map(([state, action]) => [
          state,
          Number(action.getEffectiveWeight().toFixed(4)),
        ]),
      ),
      expected_item_count: items.length,
      attached_item_count: this.status.attachedItems.length,
      has_held_item: hasHeld,
      has_worn_item: hasWorn,
      visible_on_avatar:
        !!this.avatar &&
        items.length > 0 &&
        this.status.attachedItems.length === items.length &&
        this.status.attachedItems.every((item) => item.visual_marker_attached),
    };
  }

  /**
   * the MOTION + ATTACHMENT probe. This is the surface the proof asserts on,
   * and it is built so that a broken rig CANNOT pass.
   *
   * Two deliberate design choices, both of them the difference between a proof and a
   * rubber stamp:
   *
   *  1. Bones are reported in AVATAR-LOCAL space as well as world space. Sampling bone
   *     WORLD positions while the avatar walks across the map would show huge "motion"
   *     even if the skeleton were frozen solid — the bones would just be riding the
   *     avatar's translation. Avatar-local space subtracts the rig transform, so a
   *     frozen skeleton reads as a CONSTANT no matter how far the avatar travels, and
   *     only genuine articulation registers.
   *
   *  2. Each equipped item's distance is measured to the RAW bone — the actual bone
   *     that skins the visible mesh — and NOT to the normalized node the item is
   *     parented to. Distance to your own parent is trivially constant; asserting on it
   *     would be a tautology that passes even when the item is welded to the avatar's
   *     root. Measuring against the raw bone means a floating item and an attached item
   *     are genuinely distinguishable: while the arm swings, a bone-attached hammer
   *     holds a near-constant distance, and a root-anchored one does not.
   */
  rigProbe() {
    if (!this.avatarRig || !this.scene) return { ok: false, reason: "layer not initialised" };
    const humanoid = this.vrm && this.vrm.humanoid;
    const rawBone = (name) =>
      name && humanoid && typeof humanoid.getRawBoneNode === "function"
        ? humanoid.getRawBoneNode(name)
        : null;

    this.scene.updateMatrixWorld(true);
    const _w = new THREE.Vector3();

    const bones = {};
    for (const name of ["hips", "head", "leftHand", "rightHand", "leftUpperLeg", "rightUpperLeg", "leftLowerLeg", "rightLowerLeg", "leftFoot", "rightFoot"]) {
      const node = rawBone(name);
      if (!node) {
        bones[name] = null;
        continue;
      }
      node.getWorldPosition(_w);
      const local = this.avatarRig.worldToLocal(_w.clone());
      bones[name] = {
        node_name: node.name,
        world: [_w.x, _w.y, _w.z],
        local: [local.x, local.y, local.z],
      };
    }

    // the top of the avatar's HEAD in world space (body bounds exclude equipment,
    // so a floating crown cannot define the top of the head and thereby excuse itself).
    // The worn-item seating assertion measures each head item's underside against this.
    const bodyDetail = {};
    const bodyBounds = this._avatarModel ? avatarBodyBounds(this._avatarModel, bodyDetail) : null;
    const bodyTopWorldY = bodyBounds ? Number(bodyBounds.max.y.toFixed(4)) : null;
    const bodyBottomWorldY = bodyBounds ? Number(bodyBounds.min.y.toFixed(4)) : null;

    // THE SEATING REFERENCE IS THE SKULL, NOT THE SILHOUETTE.
    //
    // `bodyTopWorldY` above is the top of the whole body, and on both shipped rigs that is
    // HAIR: a mohawk fin on the Ready Player Me avatar, spring-bone hair on the VRM.
    // measured every worn item's seat against it, which is why the hat ended up hovering in
    // the screenshot — and why own crown assertion passed while it did.
    // The seat is now referenced to the rig's MEASURED SKULL (see measureSkullTopY), so the
    // assertion measures the same surface the seating maths places the item on, and goes RED
    // against a floating hat instead of blessing it. The silhouette figure is kept beside it
    // rather than deleted, because it is the number that used to lie.
    let skullTopWorldY = null;
    const headBoneNode = rawBone("head");
    const headTopOffset = this._rigMetrics && this._rigMetrics.head_top_offset_m;
    if (headBoneNode && this._avatarModel && Number.isFinite(headTopOffset)) {
      const scale = this._avatarModel.getWorldScale(new THREE.Vector3()).y || 1;
      headBoneNode.getWorldPosition(_w);
      skullTopWorldY = Number((_w.y + headTopOffset * scale).toFixed(4));
    }

    const items = [];
    for (let i = 0; i < this.attachedObjects.length; i += 1) {
      const object = this.attachedObjects[i];
      const meta = this.status.attachedItems[i] || {};
      object.getWorldPosition(_w);
      const itemWorld = new THREE.Vector3().copy(_w);
      // The item's ASSET bounds — excluding the debug marker stud, which would otherwise put
      // the measured underside of a crown below the crown.
      const itemAsset = object.children.find((c) => c.name && c.name.startsWith("asset-"));
      const itemBox = new THREE.Box3().setFromObject(itemAsset || object);
      const itemBottomWorldY = itemBox.isEmpty() ? null : Number(itemBox.min.y.toFixed(4));
      const itemTopWorldY = itemBox.isEmpty() ? null : Number(itemBox.max.y.toFixed(4));
      const boneNode = rawBone(meta.attachmentPoint);
      let boneWorld = null;
      let distance = null;
      if (boneNode) {
        const bw = new THREE.Vector3();
        boneNode.getWorldPosition(bw);
        boneWorld = [bw.x, bw.y, bw.z];
        distance = Number(bw.distanceTo(itemWorld).toFixed(5));
      }
      items.push({
        itemId: meta.itemId || null,
        mode: meta.mode || null,
        attachmentPoint: meta.attachmentPoint || null,
        target: meta.target || null,
        parent_name: object.parent ? object.parent.name : null,
        item_world: [itemWorld.x, itemWorld.y, itemWorld.z],
        raw_bone_world: boneWorld,
        distance_to_raw_bone_m: distance,
        item_bottom_world_y: itemBottomWorldY,
        item_top_world_y: itemTopWorldY,
        // For a worn head item: how far its underside sits ABOVE the crown of the SKULL.
        // Negative = settled onto the head (correct). Positive = hovering (the bug).
        head_seat_gap_m:
          meta.attachmentPoint === "head" && itemBottomWorldY !== null && skullTopWorldY !== null
            ? Number((itemBottomWorldY - skullTopWorldY).toFixed(4))
            : null,
        // the same gap measured against the SILHOUETTE — i.e. against the hair. This
        // is the reference asserted on. Published, not asserted on, so the difference
        // between "on the head" and "on the hair" stays visible in the evidence.
        head_seat_gap_vs_silhouette_m:
          meta.attachmentPoint === "head" && itemBottomWorldY !== null && bodyTopWorldY !== null
            ? Number((itemBottomWorldY - bodyTopWorldY).toFixed(4))
            : null,
      });
    }

    const modelWorld = this._avatarModel
      ? this._avatarModel.getWorldPosition(new THREE.Vector3())
      : null;
    return {
      ok: true,
      animation_time_seconds: Number((this.status.animation_time_seconds || 0).toFixed(3)),
      avatar_variant: this.status.avatar_variant,
      render_source: this.status.avatar_render_source || null,
      animation_state: this.status.current_animation_state,
      mixer_active: this.status.animation_mixer_active === true,
      locomotion_moving: this.status.locomotion_moving === true,
      run_contact_lock: { ...this.status.run_contact_lock },
      avatar_rig_world: [this.avatarRig.position.x, this.avatarRig.position.y, this.avatarRig.position.z],
      avatar_model_local_y: this._avatarModel ? Number(this._avatarModel.position.y.toFixed(4)) : null,
      avatar_model_world_y: modelWorld ? Number(modelWorld.y.toFixed(4)) : null,
      body_bottom_world_y: bodyBottomWorldY,
      body_top_world_y: bodyTopWorldY,
      // the crown of the measured SKULL — what worn items are actually seated on.
      // `body_top_world_y` is the top of the HAIR; the difference between them is the gap
      // the user saw under the hat.
      skull_top_world_y: skullTopWorldY,
      rig_metrics: this._rigMetrics || null,
      // WHICH mesh defines the top of the head. Worth publishing: if a hat seats wrong, this
      // is the first thing to look at — "top of the head" is only as good as the mesh that
      // defines it.
      body_top_mesh: bodyDetail.top_mesh || null,
      head_bone_world_y: bones.head ? Number(bones.head.world[1].toFixed(4)) : null,
      bones,
      items,
    };
  }

  _loop() {
    const delta = this.clock ? this.clock.getDelta() : 0;
    if (this.mixer && this.avatarRig.visible) {
      // blended mocap FSM replaces the fixed-rate single
      // clip + procedural arm/leg override. Walk playback rate stays matched
      // to the world translation speed (no treadmill / foot-slide).
      this._updateLocomotionState(delta);
      this.mixer.update(delta);
      this._applyRunFootContactLock(delta);
      this._syncRunCalibrationTelemetry(delta);
      this._syncJumpPlaybackTelemetry();
      this.status.animation_time_seconds = Number((this.status.animation_time_seconds + delta).toFixed(3));
    } else if (this._runFootContactLock) this._resetRunFootContactLock("state-transition");
    if (this.vrm && typeof this.vrm.update === "function") this.vrm.update(delta);
    // in shared-scene mode the HOST world's own render loop draws the one
    // scene (avatars included) — a second render() here would double-draw every
    // frame. The rAF above still runs so the mixer/locomotion/vrm updates keep
    // their behaviour in both modes.
    if (!this.sharedScene) this.renderer.render(this.scene, this.camera);
    this._raf = requestAnimationFrame(this._loop);
  }

  resize() {
    // no own canvas in shared mode — the host renderer owns sizing.
    if (this.sharedScene) return;
    if (!this.renderer || !this.camera) return;
    const w = this.mount.clientWidth || 640;
    const h = this.mount.clientHeight || 420;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  /**
   * move this layer's avatar into a NEW host world (recompose seam).
   *
   * A portal crossing disposes the vendor Scene and creates a fresh one
   * (web/app.js recomposeActiveWorldScene) while avatar layers are deliberately
   * NEVER torn down — so a shared-mode rig must be re-parented into the new
   * world's scene or it would stay in the disposed one and simply vanish.
   * `scene.add()` re-parents in three.js, so this is one call, not a teardown.
   */
  setHost(host) {
    if (!this.sharedScene || !host || !host.scene) return false;
    this.host = host;
    this.renderer = host.renderer || null;
    this.scene = host.scene;
    this.camera = host.camera || null;
    if (this.avatarRig) this.scene.add(this.avatarRig);
    return true;
  }

  dispose() {
    this._resetRunFootContactLock("dispose");
    if (this._raf) cancelAnimationFrame(this._raf);
    if (this._onResize) window.removeEventListener("resize", this._onResize);
    if (this.sharedScene) {
      // the renderer/canvas belong to the HOST world — never dispose or
      // detach them here. Remove this layer's rig from the shared scene and free
      // ITS OWN GPU resources (each layer loads its own model instance, so this
      // cannot touch another layer's geometry/textures).
      if (this.avatarRig) {
        if (this.avatarRig.parent) this.avatarRig.parent.remove(this.avatarRig);
        this._disposeModel(this.avatarRig);
      }
      return;
    }
    if (this.renderer) {
      this.renderer.dispose();
      if (this.renderer.domElement.parentNode) this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
    }
  }
}
