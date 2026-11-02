// actionforge-avatar.mjs: avatars on ActionForge's CC0 skeleton, animated by the avatar runtime (web/avatar/runtime/).
//
// Every character of the avatar collection shares one skeleton with the 84-clip pack, so the clips play on the
// character's own bones: no retargeting, no rest-pose bend, no per-frame foot correction. The runtime's AvatarMotion
// blends idle, walk and jog by speed, plays the three-part jump, and layers item stances; the named solvers
// (plant-feet, reach-hands, avoid-arms) run after it. The lab keeps where the avatar is (movement, ground, portals);
// the movement itself comes from the runtime's Locomotion (web/live-adapter.js), and its state reaches this file
// through the avatar's locomotion record, for this window's avatar and for other visitors alike.
//
// Public API
//   loadActionForgeAvatar(variant)   { vrm, model, library, instance, tuning }
//       vrm: the small facade the avatar layer expects (scene, humanoid with getRawBoneNode and getNormalizedBoneNode,
//       update). getNormalizedBoneNode returns a node on the real bone whose frame is the humanoid's normalized frame,
//       so an item's localTransform (written for normalized bones) sits right and follows the animation.
//   class ActionForgeMotionDriver(instance, library, tuning)
//       update(dt, avatarState)        one frame: motion state from avatarState.locomotion, solvers, mixer
//       weights()                      the effective clip weights (debug)
//       syncItems(labItems)            the lab's equipped records: the items the runtime knows (RUNTIME_ITEMS) are held or
//                                      worn by the runtime's Equipment, with their stance and grip; returns the rest
//   motionRecord(locomotion, nowS)   the motion fields one movement step publishes (live-adapter.js, presence)
//   RUNTIME_ITEMS                    lab item id -> the runtime's item id
import * as THREE from "../vendor/scene-core/vendor/three/three.module.js";
import { loadAvatarLibrary, createAvatarInstance } from "./runtime/clip-library.mjs";
import { AvatarMotion } from "./runtime/avatar-motion.mjs";
import { createTuning } from "./runtime/locomotion.mjs";
import { SolverStack } from "./runtime/fitting/solvers.mjs";
import { Equipment, loadItemLibrary } from "./runtime/equipment.mjs";
import { withBase } from "../base-path.mjs";
import "../gltf-webp-support.mjs"; // WebP textures on a host whose policy leaves data: out of img-src


// ActionForge's CC0 71-joint skeleton (Quaternius), used by the avatar collection: exact joint names, mapped to the humanoid
// (VRM) bone names the lab's equipment uses.
const ACTIONFORGE_FINGERS = { thumb: ["Metacarpal", "Proximal", "Distal"], index: ["Proximal", "Intermediate", "Distal"],
  middle: ["Proximal", "Intermediate", "Distal"], ring: ["Proximal", "Intermediate", "Distal"], pinky: ["Proximal", "Intermediate", "Distal"] };
export const ACTIONFORGE_TO_VRM = Object.freeze({
  pelvis: "hips", spine_01: "spine", spine_02: "chest", spine_03: "upperChest", neck_01: "neck", Head: "head",
  clavicle_l: "leftShoulder", upperarm_l: "leftUpperArm", lowerarm_l: "leftLowerArm", hand_l: "leftHand",
  clavicle_r: "rightShoulder", upperarm_r: "rightUpperArm", lowerarm_r: "rightLowerArm", hand_r: "rightHand",
  thigh_l: "leftUpperLeg", calf_l: "leftLowerLeg", foot_l: "leftFoot", ball_l: "leftToes",
  thigh_r: "rightUpperLeg", calf_r: "rightLowerLeg", foot_r: "rightFoot", ball_r: "rightToes",
  ...Object.fromEntries(Object.entries(ACTIONFORGE_FINGERS).flatMap(([finger, parts]) => ["l", "r"].flatMap((side) =>
    parts.map((part, i) => [`${finger}_0${i + 1}_${side}`,
      `${side === "l" ? "left" : "right"}${finger === "pinky" ? "Little" : finger[0].toUpperCase() + finger.slice(1)}${part}`])))),
});

const VRM_TO_ACTIONFORGE = Object.freeze(Object.fromEntries(Object.entries(ACTIONFORGE_TO_VRM).map(([a, v]) => [v, a])));
const LIBRARIES = new Map();
const LAB_JOG_RATE = 0.8;
const ITEMS_URL = "/assets/actionforge/items/items.json";
let itemLibrary = null;
export const RUNTIME_ITEMS = Object.freeze({
  "equip-hammer": "hammer", "equip-torch": "torch", "equip-shield": "shield", "equip-mug": "mug",
  "equip-helmet": "helmet", "equip-crown": "crown",
});
const readBytes = async (url) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response.arrayBuffer();
};
const readJson = async (url) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response.json();
};

/** One library per prepared file: the GLB, the clips and the body details are parsed once and shared by clones. */
function libraryFor(url) {
  if (!LIBRARIES.has(url)) {
    const pending = loadAvatarLibrary({ readBytes, readJson, url });
    pending.catch(() => LIBRARIES.delete(url));
    LIBRARIES.set(url, pending);
  }
  return LIBRARIES.get(url);
}

// Made once per instance, at rest (before anything animates): for every humanoid bone, a child of the real bone turned
// so its frame matches the avatar's own frame (the normalized frame). An item placed in it follows the bone.
function humanoidFacade(instance) {
  const frames = new Map();
  const raw = (vrmName) => instance.bones[VRM_TO_ACTIONFORGE[vrmName]] || null;
  instance.holder.updateMatrixWorld(true);
  const holderQ = instance.holder.getWorldQuaternion(new THREE.Quaternion());
  const h = instance.holder.getWorldScale(new THREE.Vector3());
  for (const vrmName of Object.keys(VRM_TO_ACTIONFORGE)) {
    const bone = raw(vrmName);
    if (!bone) continue;
    const node = new THREE.Object3D();
    node.name = `${bone.name}-normalized-frame`;
    node.quaternion.copy(bone.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(holderQ));
    const s = bone.getWorldScale(new THREE.Vector3());
    node.scale.set(h.x / s.x, h.y / s.y, h.z / s.z);
    frames.set(vrmName, node);
  }
  for (const [vrmName, node] of frames) raw(vrmName).add(node);
  return {
    getRawBoneNode: raw,
    getNormalizedBoneNode: (vrmName) => frames.get(vrmName) || null,
  };
}

function itemsFor() {
  if (!itemLibrary) {
    itemLibrary = loadItemLibrary({ readBytes, readJson, url: withBase(ITEMS_URL), assetBase: new URL(withBase("/assets/"), location.href).href });
    itemLibrary.catch(() => { itemLibrary = null; });
  }
  return itemLibrary;
}

/** The character's parsed glTF scene from the shared library: a scene loader can mount it without fetching the GLB again. */
export async function actionForgeAvatarScene(variant) {
  const library = await libraryFor(withBase(variant.prepared));
  return library.template.children[0];
}

export async function loadActionForgeAvatar(variant) {
  const [library, items] = await Promise.all([libraryFor(withBase(variant.prepared)), itemsFor().catch(() => null)]);
  const instance = createAvatarInstance(library);
  const tuning = createTuning(library.data);
  // The lab's rooms are a few metres across: the jog plays at 0.8 of its own pace (the runtime's lowest rate), about
  // 4.9 m/s on Adam instead of 6.2, with the feet still matched to the ground.
  tuning.jogRate = LAB_JOG_RATE;
  tuning.jogSpeed = library.data.clips.jog.speed_mps * LAB_JOG_RATE;
  const vrm = {
    scene: instance.holder,
    humanoid: humanoidFacade(instance),
    isActionForge: true,
    update() {}, // the runtime writes the bones; nothing copies a normalized pose over them
  };
  return { vrm, model: instance.holder, library, instance, tuning, items };
}

/** The motion fields one movement step publishes, from the runtime's Locomotion (see live-adapter.js). */
export function motionRecord(locomotion, nowS) {
  return {
    runtime: "actionforge",
    speed_mps: Number(locomotion.speed.toFixed(4)),
    phase: locomotion.phase,
    phase_started_s: Number((nowS - locomotion.phaseTime).toFixed(4)),
    crouch_time_s: locomotion.crouchTime,
    jump_style: locomotion.jumpStyle,
    land_moving: locomotion.landMoving === true,
    vy_mps: Number(locomotion.vy.toFixed(4)),
    turn_rate: Number(locomotion.turnRate.toFixed(4)),
    at_s: Number(nowS.toFixed(4)),
  };
}

export class ActionForgeMotionDriver {
  constructor(instance, library, tuning, items = null) {
    this.instance = instance;
    this.library = library;
    this.tuning = tuning;
    this.motion = new AvatarMotion(instance, library, tuning);
    this.solvers = library.body ? new SolverStack(instance, library.body) : null;
    this.equipment = items ? new Equipment(instance, library, items, this.motion, this.solvers) : null;
    this._clock = 0;
    this._record = null;
    this._recordAt = 0;
  }

  /** The motion state AvatarMotion needs, from the newest published record; times advance locally between records. */
  _state(locomotion) {
    const record = locomotion && locomotion.motion && locomotion.motion.runtime === "actionforge" ? locomotion.motion : null;
    if (record && record !== this._record) {
      this._record = record;
      this._recordAt = this._clock;
    }
    const r = this._record;
    const T = this.tuning;
    if (!r) {
      // A pose without the runtime's record (an older sender): the plain speed, and the air while off the ground.
      const grounded = !locomotion || locomotion.grounded !== false;
      return {
        speed: Number(locomotion?.speed_mps) || 0,
        phase: grounded ? "none" : "air",
        phaseTime: 0,
        turnRate: 0,
        vy: 0,
        timeToContact: grounded ? 0 : Math.sqrt((2 * Math.max(0, Number(locomotion?.jump_height_m) || 0)) / T.gravity),
        landMoving: false,
        crouchTime: T.crouchStanding,
        jumpStyle: "standing",
      };
    }
    const since = this._clock - this._recordAt;
    const phaseTime = Math.max(0, r.at_s - r.phase_started_s) + since;
    // In the air the height follows the same ballistic arc the sender uses, so the landing time is known ahead.
    const height = Math.max(0, Number(locomotion.jump_height_m) || 0);
    const vy = r.phase === "air" ? r.vy_mps - T.gravity * since : 0;
    const timeToContact = r.phase === "air" ? (vy + Math.sqrt(Math.max(0, vy * vy + 2 * T.gravity * height))) / T.gravity : 0;
    return {
      speed: r.speed_mps,
      phase: r.phase,
      phaseTime,
      turnRate: r.turn_rate,
      vy,
      timeToContact,
      landMoving: r.land_moving,
      crouchTime: r.crouch_time_s,
      jumpStyle: r.jump_style,
    };
  }

  update(dt, avatarState) {
    this._clock += dt;
    const locomotion = (avatarState && avatarState.locomotion) || null;
    const state = this._state(locomotion);
    this.instance.holder.updateMatrixWorld(true);
    this.solvers?.restore();
    this.motion.update(dt, state);
    // The floor in the holder's frame: the avatar's origin is at ground height plus the jump's height (the holder may be
    // scaled to a preferred height). plant-feet reads floorY - holder.position.y.
    const holder = this.instance.holder;
    const floorLocal = -(Number(locomotion?.jump_height_m) || 0) / (holder.scale.y || 1);
    this.solvers?.run({ dt, floorY: floorLocal + holder.position.y });
    this.lastState = state;
  }

  weights() {
    return this.motion.weights();
  }

  /** One held and one worn item go to the runtime's Equipment (stance, grip, hold point); the rest are returned. */
  syncItems(labItems) {
    const rest = [];
    const want = { held: null, worn: null };
    for (const item of labItems || []) {
      const id = RUNTIME_ITEMS[item.itemId];
      const known = this.equipment && id && this.equipment.items?.items?.get(id);
      const slot = known ? (known.mode === "worn" ? "worn" : "held") : null;
      if (slot && !want[slot]) want[slot] = { id, item };
      else rest.push(item);
    }
    if (this.equipment) {
      for (const slot of ["held", "worn"]) {
        const current = this.equipment[slot]?.item.id || null;
        const wanted = want[slot]?.id || null;
        if (wanted && wanted !== current && !this.equipment.take(wanted)) rest.push(want[slot].item);
        else if (!wanted && current) this.equipment.drop(current);
      }
    }
    return { rest, runtime: Object.values(want).filter(Boolean).map((w) => ({ itemId: w.item.itemId, runtimeId: w.id })) };
  }
}
