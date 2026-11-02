// avatar-motion.mjs: one AnimationMixer per avatar, driven by the movement state. The standard three.js pattern of
// the "Skeletal Animation Blending" example: every clip is an AnimationAction; weights and time scales blend them.
//
// Public API
//   class AvatarMotion
//     constructor(instance, library, tuning, { turnStep = true })
//     update(dt, state)   state from Locomotion.motionState() or RemoteAvatar.sample(); ends with mixer.update(dt)
//     weights()           { idle, walk, jog, jumpStart, jumpLoop, jumpLand, <overlay keys> } effective weights
//     rates()             { walk, jog } effective time scales
//     setOverlays(list)   the overlays that should be on: [{ key, clip, covers: [groups] }] (an item's stance and
//                         grip, from web/avatar/equipment.mjs); others fade out. Fade: STANCE_FADE_S (0.25 s).
//     actionList()        [{ key, action, once }] every action in the mixer (the proof replays them)
//   After update(), only the named solvers change a bone (fitting/solvers.mjs, run by web/avatar/avatars.mjs).
//
// Layers (avatars that can equip: ActionForge's skeleton with the clip pack). Each locomotion and jump clip is split
// by track into four parts: lower (root, pelvis, spine_01, spine_02, legs), upper (spine_03, neck_01, Head, clavicles,
// arms, hands), fingers_l and fingers_r. The lower part is the lead action, driven as before; the other parts follow
// it with the same time, time scale and loop state, copied right before mixer.update. An overlay (stance or grip)
// covers some parts; each part's locomotion weight is multiplied by 1 minus its cover, so every property's weights
// still sum to 1 (three.js fills a shortfall from the rest pose). Overlays are untouched by the jump: the arms keep
// the item's stance through every jump.
//
// Locomotion is a blend by speed: idle and walk below walk speed, walk and jog between walk and jog speeds. Walk and
// jog stay in step: their normalized phases advance at the same rate and are aligned at the left foot's touchdown.
// The jump layer fades the locomotion layer out and plays start, loop and land with timed cross-fades.

import * as THREE from '../../vendor/scene-core/vendor/three/three.module.js';
import { canEquip, splitClip, GROUPS, STANCE_FADE_S } from './equipment.mjs';

const approach = (cur, target, maxStep) => (cur < target ? Math.min(target, cur + maxStep) : Math.max(target, cur - maxStep));
const frac = (x) => x - Math.floor(x);

export class AvatarMotion {
  constructor(instance, library, tuning, { turnStep = true } = {}) {
    this.tuning = tuning;
    this.turnStep = turnStep;
    this.mixer = new THREE.AnimationMixer(instance.model);
    this.layered = canEquip(library);
    this.parts = this.layered ? GROUPS.filter((g) => g !== 'lower') : [];
    this.followers = Object.fromEntries(this.parts.map((g) => [g, {}]));
    this.once = {};
    const split = (slot) => {
      const c = library.clips[slot];
      return this.layered ? splitClip(c, library.body.roles) : { lower: c };
    };
    const start = (clip, once) => {
      const a = this.mixer.clipAction(clip);
      if (once) {
        a.setLoop(THREE.LoopOnce, 1);
        a.clampWhenFinished = true;
      }
      a.enabled = true;
      a.setEffectiveWeight(0);
      a.play();
      return a;
    };
    const make = (slot, once) => {
      const parts = split(slot);
      this.once[slot] = !!once;
      for (const g of this.parts) this.followers[g][slot] = start(parts[g], once);
      return start(parts.lower, once);
    };
    this.overlays = new Map(); // key -> { action, target, w, covers }
    this.actions = {
      idle: make('idle'),
      walk: make('walk'),
      jog: make('jog'),
      jumpStart: make('jumpStart', true),
      jumpLoop: make('jumpLoop'),
      jumpLand: make('jumpLand', true),
    };
    this.actions.idle.setEffectiveWeight(1);
    // Jump layer weights (0..1) and their fade times; locomotion layer = 1 - sum of these.
    this.jw = { jumpStart: 0, jumpLoop: 0, jumpLand: 0 };
    this.jt = { jumpStart: 0, jumpLoop: 0, jumpLand: 0 };
    this.fade = { jumpStart: 0.1, jumpLoop: 0.25, jumpLand: 0.1 };
    this.lastPhase = 'none';
    this.landStarted = false;
    this.loopStarted = false;
    this.locoWeights = { idle: 1, walk: 0, jog: 0 };
    this.locoRates = { walk: tuning.walkRate, jog: tuning.jogRate };
  }

  // Normalized locomotion phase, 0 at the left foot's touchdown.
  _phaseOf(slot) {
    const T = this.tuning;
    const a = this.actions[slot];
    const td = slot === 'walk' ? T.walkTouchdown : T.jogTouchdown;
    return frac(a.time / a.getClip().duration - td);
  }

  _setPhaseOf(slot, phase) {
    const T = this.tuning;
    const a = this.actions[slot];
    const td = slot === 'walk' ? T.walkTouchdown : T.jogTouchdown;
    a.time = frac(phase + td) * a.getClip().duration;
  }

  _locomotion(dt, s) {
    const T = this.tuning;
    const v = s.speed;
    let wIdle = 0;
    let wWalk = 0;
    let wJog = 0;
    let rWalk = T.walkRate;
    let rJog = T.jogRate;
    if (v <= T.walkSpeed) {
      const a = v / T.walkSpeed;
      wWalk = a;
      wIdle = 1 - a;
      rWalk = Math.max(T.minRate, T.walkRate * a);
    } else if (v <= T.jogSpeed) {
      const b = (v - T.walkSpeed) / (T.jogSpeed - T.walkSpeed);
      wWalk = 1 - b;
      wJog = b;
      const cycle = (T.walkCycle / T.walkRate) * (1 - b) + (T.jogCycle / T.jogRate) * b;
      rWalk = T.walkCycle / cycle;
      rJog = T.jogCycle / cycle;
    } else {
      wJog = 1;
      rJog = Math.min(T.maxRate, T.jogRate * (v / T.jogSpeed));
    }
    // Turning on the spot: no turn clip exists for this rig, so a short walk step is blended in while the turn is large.
    if (this.turnStep && v < T.inPlaceSpeed && s.phase === 'none') {
      const step = 0.45 * Math.min(1, Math.abs(s.turnRate || 0) / T.turnRateInPlace);
      if (step > wWalk) {
        wWalk = step;
        wIdle = 1 - step;
        rWalk = T.walkRate;
      }
    }
    // Keep walk and jog in step: when one joins with weight 0 it takes the other's phase.
    const prev = this.locoWeights;
    if (wJog > 0 && prev.jog === 0 && prev.walk > 0) this._setPhaseOf('jog', this._phaseOf('walk'));
    if (wWalk > 0 && prev.walk === 0 && prev.jog > 0) this._setPhaseOf('walk', this._phaseOf('jog'));
    if (wWalk > 0 && prev.walk === 0 && prev.jog === 0) this._setPhaseOf('walk', 0.5);
    this.locoWeights = { idle: wIdle, walk: wWalk, jog: wJog };
    this.locoRates = { walk: rWalk, jog: rJog };
  }

  _jump(dt, s) {
    const T = this.tuning;
    const A = this.actions;
    const enter = s.phase !== this.lastPhase;
    const target = { ...this.jt };
    if (enter) {
      if (s.phase === 'crouch') {
        A.jumpStart.reset();
        // Standing jump: hold the clip's first frame (a deep crouch); the fade into it is the anticipation.
        A.jumpStart.time = 0;
        A.jumpStart.setEffectiveTimeScale(0);
        this.loopStarted = false;
        this.landStarted = false;
        this.fade.jumpStart = Math.max(0.03, s.crouchTime);
        target.jumpStart = 1;
        target.jumpLoop = 0;
        target.jumpLand = 0;
        this.fade.jumpLand = 0.1;
      } else if (s.phase === 'air' && this.lastPhase === 'none') {
        // Moving jump: airborne at once; the start clip plays from its takeoff frame and the stride fades into it.
        A.jumpStart.reset();
        A.jumpStart.time = T.takeoffClipTime;
        A.jumpStart.setEffectiveTimeScale(1);
        this.loopStarted = false;
        this.landStarted = false;
        this.fade.jumpStart = T.runningJumpFade;
        target.jumpStart = 1;
        target.jumpLoop = 0;
        target.jumpLand = 0;
      } else if (s.phase === 'push') {
        A.jumpStart.setEffectiveTimeScale(1);
        target.jumpStart = 1;
      } else if (s.phase === 'land') {
        if (!this.landStarted) {
          A.jumpLand.reset();
          A.jumpLand.time = 0;
          this.fade.jumpLand = 0.05;
          this.landStarted = true;
        }
        A.jumpLand.setEffectiveTimeScale(1);
        target.jumpLand = 1;
        target.jumpStart = 0;
        target.jumpLoop = 0;
        this.fade.jumpStart = this.fade.jumpLoop = this.fade.jumpLand;
      } else if (s.phase === 'none') {
        target.jumpStart = 0;
        target.jumpLoop = 0;
        target.jumpLand = 0;
        this.fade.jumpLand = 0.25;
        this.fade.jumpStart = this.fade.jumpLoop = this.fade.jumpLand;
      }
    }
    if (s.phase === 'air') {
      const startDone = A.jumpStart.time >= A.jumpStart.getClip().duration - 1e-3;
      const pastTuck = A.jumpStart.time >= T.takeoffClipTime + T.loopAfterTakeoff;
      if (!this.loopStarted && (s.vy <= 0 || startDone || pastTuck)) {
        A.jumpLoop.reset();
        A.jumpLoop.time = 0;
        this.loopStarted = true;
        this.fade.jumpLoop = 0.25;
        this.fade.jumpStart = 0.25;
        target.jumpLoop = 1;
        target.jumpStart = 0;
      }
      if (!this.landStarted && s.timeToContact <= T.landLead) {
        A.jumpLand.reset();
        A.jumpLand.time = 0;
        A.jumpLand.setEffectiveTimeScale(0); // reach for the floor: hold the landing's first frame until contact
        this.landStarted = true;
        this.fade.jumpLand = this.fade.jumpLoop = this.fade.jumpStart = T.landLead;
        target.jumpLand = 1;
        target.jumpLoop = 0;
        target.jumpStart = 0;
      }
    }
    this.jt = target;
    for (const k of ['jumpStart', 'jumpLoop', 'jumpLand']) {
      this.jw[k] = approach(this.jw[k], target[k], dt / Math.max(1e-3, this.fade[k]));
    }
    this.lastPhase = s.phase;
  }

  update(dt, state) {
    this._locomotion(dt, state);
    this._jump(dt, state);
    const jumpSum = Math.min(1, this.jw.jumpStart + this.jw.jumpLoop + this.jw.jumpLand);
    const loco = 1 - jumpSum;
    const A = this.actions;
    A.idle.setEffectiveWeight(this.locoWeights.idle * loco);
    A.walk.setEffectiveWeight(this.locoWeights.walk * loco);
    A.jog.setEffectiveWeight(this.locoWeights.jog * loco);
    A.walk.setEffectiveTimeScale(this.locoRates.walk);
    A.jog.setEffectiveTimeScale(this.locoRates.jog);
    for (const k of ['jumpStart', 'jumpLoop', 'jumpLand']) A[k].setEffectiveWeight(this.jw[k]);
    if (this.layered) this._layers(dt);
    this.mixer.update(dt);
  }

  setOverlays(list) {
    const on = new Set(list.map((o) => o.key));
    for (const o of list) {
      let cur = this.overlays.get(o.key);
      if (!cur) {
        const action = this.mixer.clipAction(o.clip);
        action.enabled = true;
        action.setEffectiveWeight(0);
        cur = { action, target: 0, w: 0, covers: o.covers };
        this.overlays.set(o.key, cur);
      }
      if (cur.target !== 1) {
        if (cur.w === 0) { cur.action.reset(); cur.action.play(); }
        cur.target = 1;
      }
    }
    for (const [k, cur] of this.overlays) if (!on.has(k)) cur.target = 0;
  }

  // Overlay weights fade toward their targets; each part's cover is the sum of the overlays on it (at most 1); the
  // followers take the lead's state and the lead's weight times (1 - cover).
  _layers(dt) {
    const cover = Object.fromEntries(GROUPS.map((g) => [g, 0]));
    for (const cur of this.overlays.values()) {
      cur.w = approach(cur.w, cur.target, dt / STANCE_FADE_S);
      for (const g of cur.covers) cover[g] += cur.w;
    }
    for (const cur of this.overlays.values()) {
      const over = Math.max(1, ...cur.covers.map((g) => cover[g]));
      cur.action.setEffectiveWeight(cur.w / over);
      if (cur.w === 0 && cur.target === 0 && cur.action.isRunning()) cur.action.stop();
    }
    for (const g of this.parts) {
      const keep = 1 - Math.min(1, cover[g]);
      for (const [slot, lead] of Object.entries(this.actions)) {
        const f = this.followers[g][slot];
        f.enabled = lead.enabled;
        f.paused = lead.paused;
        f.time = lead.time;
        f.timeScale = lead.timeScale;
        f._loopCount = lead._loopCount;
        f.weight = lead.weight * keep;
      }
    }
  }

  actionList() {
    const out = Object.entries(this.actions).map(([k, action]) => ({ key: k, action, once: this.once[k] }));
    for (const g of this.parts) for (const [k, action] of Object.entries(this.followers[g])) out.push({ key: `${g}:${k}`, action, once: this.once[k] });
    for (const [k, cur] of this.overlays) out.push({ key: k, action: cur.action, once: false });
    return out;
  }

  weights() {
    const A = this.actions;
    const o = {};
    for (const k of Object.keys(A)) o[k] = A[k].getEffectiveWeight();
    for (const [k, cur] of this.overlays) o[k] = cur.action.isRunning() ? cur.action.getEffectiveWeight() : 0;
    return o;
  }

  rates() {
    return { walk: this.actions.walk.getEffectiveTimeScale(), jog: this.actions.jog.getEffectiveTimeScale() };
  }
}
