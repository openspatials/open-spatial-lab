// avatars.mjs: the per-frame pipeline shared by the live page and the Node proof.
//
// Public API
//   loadClipData(readText, url)            parse a prepared avatar file (<id>.avatar.json)
//   class VisitorAvatar   (this window's own avatar)
//     constructor(library, tuning, spawn, { items, ... })  spawn: { x, z, yaw }; items: loadItemLibrary() result
//     step(dt, input)                      move (Locomotion), place the holder, then animate (AvatarMotion)
//     snapshot(t)                          state for other visitors, with the equipped items' portal records
//   class RemoteVisitor   (another visitor)
//     constructor(library, tuning, { items, delay, ... })
//     push(snapshot, localTime)
//     step(dt, localTime)                  the snapshot's equipped records are applied before the mixer runs
//   Each has: instance { holder, model, bones, skinnedMeshes }, motion (AvatarMotion), equipment (Equipment),
//   solvers (SolverStack, null for an avatar without body details), lastState.
//   options.solvers: passed to SolverStack ({ disable: [names] }).
//
// Frame order, the same everywhere: movement -> holder transform -> mixer.update(dt) -> named solvers (plant-feet,
// reach-hands, avoid-arms; fitting/solvers.mjs) -> draw. Nothing else runs between the mixer and the draw.

import { createAvatarInstance } from './clip-library.mjs';
import { AvatarMotion } from './avatar-motion.mjs';
import { Locomotion } from './locomotion.mjs';
import { RemoteAvatar } from './remote-avatar.mjs';
import { Equipment } from './equipment.mjs';
import { SolverStack } from './fitting/solvers.mjs';

export async function loadClipData(readText, url) {
  return JSON.parse(await readText(url));
}

export class VisitorAvatar {
  constructor(library, tuning, spawn = {}, options = {}) {
    this.instance = createAvatarInstance(library);
    this.locomotion = new Locomotion(tuning, spawn);
    this.motion = new AvatarMotion(this.instance, library, tuning, options);
    this.solvers = library.body ? new SolverStack(this.instance, library.body, options.solvers) : null;
    this.equipment = new Equipment(this.instance, library, options.items || null, this.motion, this.solvers);
    this.lastState = null;
    this._place();
  }

  _place() {
    const h = this.instance.holder;
    h.position.copy(this.locomotion.position);
    h.quaternion.copy(this.locomotion.quaternion);
    h.updateMatrixWorld(true);
  }

  step(dt, input) {
    this.locomotion.update(dt, input);
    this._place();
    this.lastState = this.locomotion.motionState();
    this.solvers?.restore();
    this.motion.update(dt, this.lastState);
    this.solvers?.run({ dt });
  }

  snapshot(t) {
    return { ...this.locomotion.snapshot(t), equipped: this.equipment.records() };
  }
}

export class RemoteVisitor {
  constructor(library, tuning, options = {}) {
    this.instance = createAvatarInstance(library);
    this.remote = new RemoteAvatar(tuning, options);
    this.motion = new AvatarMotion(this.instance, library, tuning, options);
    this.solvers = library.body ? new SolverStack(this.instance, library.body, options.solvers) : null;
    this.equipment = new Equipment(this.instance, library, options.items || null, this.motion, this.solvers);
    this.lastState = null;
    this.instance.holder.visible = false;
  }

  push(snapshot, localTime) {
    this.remote.push(snapshot, localTime);
  }

  step(dt, localTime) {
    const s = this.remote.sample(localTime, dt);
    if (!s) return;
    const h = this.instance.holder;
    h.visible = true;
    h.position.copy(s.position);
    h.quaternion.copy(s.quaternion);
    h.updateMatrixWorld(true);
    this.lastState = s;
    this.equipment.applyRecords(s.equipped);
    this.solvers?.restore();
    this.motion.update(dt, s);
    this.solvers?.run({ dt });
  }
}
