import * as THREE from "./vendor/scene-core/vendor/three/three.module.js";
import { GLTFLoader } from "./vendor-three-examples/loaders/GLTFLoader.js";
import { clone as cloneSkeleton } from "./vendor-three-examples/utils/SkeletonUtils.js";
import { loadActionForgeAvatar, ActionForgeMotionDriver } from "./avatar/actionforge-avatar.mjs";
import "./gltf-webp-support.mjs"; // WebP textures on a host whose policy leaves data: out of img-src
// every avatar/mocap asset URL below is a root-absolute same-origin path.
// Route each through the ONE base-path helper so it resolves beneath the public prefix in subpath
// mode; in root mode withBase() is the identity,
// so avatar behaviour is untouched (only the URL string is made prefix-aware).
import { withBase } from "./base-path.mjs";

const ATTACHMENT_PRESETS = {
  head: { position: [0, 1.55, 0.12], label: "head" },
  chest: { position: [0, 1.08, 0.16], label: "chest" },
  upperChest: { position: [0, 1.22, 0.18], label: "upperChest" },
  rightHand: { position: [0.42, 0.82, 0.18], label: "rightHand" },
  leftHand: { position: [-0.42, 0.82, 0.18], label: "leftHand" },
  hips: { position: [0, 0.72, 0.08], label: "hips" },
};

// The avatars: the avatar collection, Mixamo characters converted onto ActionForge's CC0 71-joint skeleton (Quaternius),
// each at its real height, facing +Z, with 1024-pixel WebP textures and its prepared file (clips, measurements) and body
// details. The avatar runtime animates them (avatar/actionforge-avatar.mjs): the 84-clip pack plays on their own bones,
// with no retargeting. A switch REPLACES the one avatar model inside the rig (never adds a second) and re-attaches the
// current equipment. The adapter carries the active variant key in avatar.avatar_variant (broadcast to observers and
// carried through the crossing packet). Credits: THIRD_PARTY_NOTICES.md.
export const AVATAR_VARIANTS = Object.freeze({
  "collection-adam": {
    key: "collection-adam",
    label: "Adam",
    type: "glb",
    url: withBase("/assets/actionforge/characters/adam/adam.glb"),
    prepared: "/assets/actionforge/characters/adam/adam.avatar.json",
    runtime: "actionforge",
    scale: 1,
    rotation_y: 0,
    load_mode: "actionforge-runtime",
    mocap_retarget: "none: the clip pack plays on the character's own skeleton",
    equipment_attachment: "actionforge-bone-frames",
    licence: "Adobe Mixamo character",
    licence_holder: "Adobe Mixamo",
    starting_pool: true,
    structured_unsupported: [],
  },
  "collection-megan": {
    key: "collection-megan",
    label: "Megan",
    type: "glb",
    url: withBase("/assets/actionforge/characters/megan/megan.glb"),
    prepared: "/assets/actionforge/characters/megan/megan.avatar.json",
    runtime: "actionforge",
    scale: 1,
    rotation_y: 0,
    load_mode: "actionforge-runtime",
    mocap_retarget: "none: the clip pack plays on the character's own skeleton",
    equipment_attachment: "actionforge-bone-frames",
    licence: "Adobe Mixamo character",
    licence_holder: "Adobe Mixamo",
    starting_pool: true,
    structured_unsupported: [],
  },
  "collection-elizabeth": {
    key: "collection-elizabeth",
    label: "Elizabeth",
    type: "glb",
    url: withBase("/assets/actionforge/characters/elizabeth/elizabeth.glb"),
    prepared: "/assets/actionforge/characters/elizabeth/elizabeth.avatar.json",
    runtime: "actionforge",
    scale: 1,
    rotation_y: 0,
    load_mode: "actionforge-runtime",
    mocap_retarget: "none: the clip pack plays on the character's own skeleton",
    equipment_attachment: "actionforge-bone-frames",
    licence: "Adobe Mixamo character",
    licence_holder: "Adobe Mixamo",
    starting_pool: true,
    structured_unsupported: [],
  },
  "collection-sophie": {
    key: "collection-sophie",
    label: "Sophie",
    type: "glb",
    url: withBase("/assets/actionforge/characters/sophie/sophie.glb"),
    prepared: "/assets/actionforge/characters/sophie/sophie.avatar.json",
    runtime: "actionforge",
    scale: 1,
    rotation_y: 0,
    load_mode: "actionforge-runtime",
    mocap_retarget: "none: the clip pack plays on the character's own skeleton",
    equipment_attachment: "actionforge-bone-frames",
    licence: "Adobe Mixamo character",
    licence_holder: "Adobe Mixamo",
    starting_pool: true,
    structured_unsupported: [],
  },
});
// The default player avatar. A new session starts as one of the collection (starting_pool) at random; this is the one
// used when no pick exists.
export const DEFAULT_AVATAR_VARIANT = "collection-adam";

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
function countMeshes(root) {
  let count = 0;
  root.traverse((node) => {
    if (node.isMesh || node.isSkinnedMesh) count += 1;
  });
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
 * A root-absolute `url` ("/assets/…", as a listed world's data names the lab's own models) is this
 * frontend's file, so it resolves beneath the base path like every other "/assets/…" here.
 *
 * @param {string} url  resolved (absolute) glTF/GLB URL, or a root-absolute path of this frontend
 * @returns {Promise<import("three").Object3D>} the loaded glТF scene root
 */
export async function loadGltfSceneAsset(url) {
  const loader = new GLTFLoader();
  const gltf = await loader.loadAsync(withBase(url));
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
    // The avatar runtime that animates the model (avatar/actionforge-avatar.mjs).
    this._motionDriver = null;
    this._actionForge = null;
    // Runtime avatar switching bookkeeping.
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
      animation_runtime: "actionforge",
      clip_pack_uri: withBase("/assets/actionforge/clips/actionforge-clips.glb"),
      locomotion_clips: [],
      current_animation_state: "idle",
      animation_mixer_active: false,
      animation_time_seconds: 0,
      procedural_pose_active: false,
      fallback_rig_visible: false,
      locomotion_moving: false,
      locomotion_movement_mode: "idle",
      locomotion_run_mode: false,
      locomotion_speed_mps: 0,
      avatar_grounded: true,
      avatar_jump_height_m: 0,
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
      const message = `avatar model load failed; fallback avatar hidden: ${err.message}`;
      this.status.errors.push(message);
      console.warn(`[avatar ${variant.key}] ${message}`);
      this.status.real_vrm_loaded = false;
      this.status.avatar_static_glb_loaded = false;
      this.fallbackRig.visible = false;
      this.status.fallback_rig_visible = false;
    }
  }

  async _loadVrmModel(variant) {
    // Every avatar is a character of the avatar collection on ActionForge's skeleton; the avatar runtime loads its
    // prepared file (model, clips, measurements, body details) and animates it (avatar/actionforge-avatar.mjs).
    if (variant.runtime !== "actionforge") throw new Error(`avatar ${variant.key} is not on the avatar runtime`);
    const loaded = await loadActionForgeAvatar(variant);
    this._actionForge = loaded;
    return withRigMetrics(loaded.vrm, loaded.model);
  }

  /**
   * Adopt a loaded VRM as THE avatar model — REPLACES any existing model in
   * the rig (the one-avatar invariant holds by construction: the old model is
   * removed and disposed before the new one is added; never two).
   */
  _adoptVrmModel(variant, vrm, model, metrics = null) {
    const support = variantSupportStatus(variant);
    this._rigMetrics = metrics || measureRigMetrics(model, vrm);
    const isStaticGlb = support.avatar_asset_type === "glb" && !vrm;
    if (this._avatarModel) {
      this.avatarRig.remove(this._avatarModel);
      this._disposeModel(this._avatarModel);
      this._avatarModel = null;
    }
    this._motionDriver = null;
    this.status.animation_mixer_active = false;
    this.vrm = vrm;
    this.status.real_vrm_loaded = !!vrm;
    this.status.avatar_static_glb_loaded = isStaticGlb;
    // What draws the avatar: real_vrm_loaded keeps its layer meaning of "a real avatar model is active"; this field
    // names the source, so the debug state does not call a runtime avatar a VRM.
    this.status.avatar_render_source =
      vrm && vrm.isActionForge
        ? "actionforge-runtime"
        : isStaticGlb
          ? "glb-static-asset"
          : "vrm-asset";
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
   * Switch the avatar to a different VRM at runtime.
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
    this._motionDriver = null;
    if (!this.vrm || !this.vrm.isActionForge || !this._actionForge) {
      this.status.locomotion_clips = [];
      this.status.animation_mixer_active = false;
      return;
    }
    try {
      const { instance, library, tuning } = this._actionForge;
      this._motionDriver = new ActionForgeMotionDriver(instance, library, tuning, this._actionForge.items);
      this.status.locomotion_clips = Object.entries(library.clips).map(([slot, clip]) => `${slot}(${clip.duration.toFixed(2)}s,${clip.tracks.length}t)`);
      this.status.animation_mixer_active = true;
      this.status.animation_runtime = "actionforge";
      this.status.locomotion_tuning = {
        walk_speed_mps: Number(tuning.walkSpeed.toFixed(4)),
        jog_speed_mps: Number(tuning.jogSpeed.toFixed(4)),
      };
      this.status.current_animation_state = "idle";
      if (typeof this._onLocomotionTuning === "function") this._onLocomotionTuning(tuning);
    } catch (err) {
      this.status.errors.push(`avatar runtime failed: ${err.message}`);
      console.warn(`[avatar ${this.status.avatar_variant}] avatar runtime failed: ${err.message}`);
      this.status.animation_mixer_active = false;
    }
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
    let items = this.avatar && Array.isArray(this.avatar.equippedItems) ? this.avatar.equippedItems : [];
    // On the avatar runtime, the items it knows are held and worn by its Equipment (stance on the arms, finger grip,
    // contact point in the hollow of the hand); only the others take the plain attach below.
    let runtimeItems = [];
    if (this._motionDriver) {
      const split = this._motionDriver.syncItems(items);
      items = split.rest;
      runtimeItems = split.runtime;
    }
    for (const object of this.attachedObjects) {
      if (object.parent) object.parent.remove(object);
    }
    this.attachedObjects = [];
    this.status.attachedItems = runtimeItems.map((entry) => ({
      itemId: entry.itemId, runtime_item: entry.runtimeId, target: "avatar-runtime-equipment", asset_loaded: true,
    }));
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

  /**
   * The movement tuning of the avatar the runtime animates (walk and jog speeds, turn rates, jump), for the movement
   * step (live-adapter.js). Called now if an avatar is loaded, and again after every avatar switch.
   */
  /** The avatar runtime's effective clip weights (idle, walk, jog, jump parts, stances), or null on the lab's own path. */
  motionWeights() {
    if (!this._motionDriver) return null;
    return Object.fromEntries(Object.entries(this._motionDriver.weights()).map(([k, v]) => [k, Number(v.toFixed(3))]));
  }

  setLocomotionTuningListener(listener) {
    this._onLocomotionTuning = typeof listener === "function" ? listener : null;
    if (this._onLocomotionTuning && this._motionDriver) this._onLocomotionTuning(this._actionForge.tuning);
  }

  setAvatar(avatar) {
    const previousSignature = this._equipmentSignature;
    this.avatar = avatar || null;
    this._syncAvatarTransform();
    // A runtime avatar switch flows through the
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
      locomotion_action_weights: this.motionWeights() || {},
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
    // rather than deleted, because it is the number that misled.
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
        // Negative = settled onto the head (correct). Positive = hovering.
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
    if (this._motionDriver && this.avatarRig.visible) {
      this._motionDriver.update(Math.min(delta, 0.1), this.avatar);
      const s = this._motionDriver.lastState;
      this.status.current_animation_state = s.phase !== "none" ? `jump-${s.phase}` : s.speed > 0.05 ? (s.speed > this._actionForge.tuning.walkSpeed + 0.05 ? "jog" : "walk") : "idle";
      this.status.animation_time_seconds = Number((this.status.animation_time_seconds + delta).toFixed(3));
    }
    // in shared-scene mode the HOST world's own render loop draws the one
    // scene (avatars included) — a second render() here would double-draw every
    // frame. The rAF above still runs so the avatar runtime keeps animating in both modes.
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
