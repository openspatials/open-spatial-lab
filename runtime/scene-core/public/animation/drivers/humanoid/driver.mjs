// driver.mjs: the humanoid motion driver in the shape of the motion driver contract (docs/engine/MOVER-CONTRACTS-V0.md,
// section 1). A thin wrapper: AvatarMotion picks and blends the clips, then SolverStack runs the fix-ups (plant-feet,
// reach-hands, avoid-arms). The driver never moves the body over the floor; the movement model
// (navigation/humanoid/locomotion.mjs) does that, and its state comes in as `moverState`.
//
// Public API
//   bind(body, clipSet, tuning, style = null, { readPose } = {})  -> driver
//       body      the avatar instance (the runtime's createAvatarInstance: model, holder, bones)
//       clipSet   its library (the runtime's loadAvatarLibrary: clips, prepared data, body record `body`)
//       tuning    the runtime's createTuning(prepared data), as the movement model uses
//       style     reserved for motion personality (contract section 6); not read yet
//       readPose  the application's pose reader, a function; step() calls it with `body` and returns its result.
//                 The driver imports nothing of the application.
//   driver.step(dt, moverState, actions)   one frame; returns readPose(body), or null when no reader was given
//       moverState  the movement model's motionState() ({ speed, phase, phaseTime, turnRate, vy, timeToContact,
//                   landMoving, crouchTime, jumpStyle }), plus floorY (world metres, default 0) for plant-feet
//       actions     null or undefined: leave the item overlays as they are (the runtime's Equipment sets them);
//                   an array: the overlays now wanted, [{ key, clip, covers }], handed to AvatarMotion.setOverlays
//   driver.capabilities()  { kind: "humanoid", actions, gaits, speedRange_mps } from the tuning
//   driver.dispose()       stops every clip and lets go of the clip player, the fix-ups and the reader
//   driver.motion, driver.solvers   the two parts (the Lab's item code hands them to Equipment)
//
// One frame, in the order the Lab's ActionForgeMotionDriver.update uses: the holder's matrices, solvers.restore(), the
// clips (AvatarMotion.update, which ends with the mixer), solvers.run({ dt, floorY }). Like the Lab, it passes no gait to
// plant-feet.

import { AvatarMotion } from './avatar-motion.mjs';
import { SolverStack } from './solvers.mjs';

const JUMP_SLOTS = ['jumpStart', 'jumpLoop', 'jumpLand'];

export function bind(body, clipSet, tuning, style = null, { readPose = null } = {}) {
  if (readPose !== null && typeof readPose !== 'function') throw new TypeError('readPose must be a function');
  let motion = new AvatarMotion(body, clipSet, tuning);
  let solvers = clipSet.body ? new SolverStack(body, clipSet.body) : null;
  let reader = readPose;
  const driver = {
    style,
    get motion() { return motion; },
    get solvers() { return solvers; },

    step(dt, moverState, actions) {
      if (!motion) throw new Error('the driver was disposed');
      if (Array.isArray(actions)) motion.setOverlays(actions);
      body.holder.updateMatrixWorld(true);
      solvers?.restore();
      motion.update(dt, moverState);
      solvers?.run({ dt, floorY: Number(moverState?.floorY) || 0 });
      if (!reader) return null;
      body.holder.updateMatrixWorld(true);
      return reader(body);
    },

    capabilities() {
      const T = tuning;
      return {
        kind: 'humanoid',
        actions: JUMP_SLOTS.every((s) => clipSet.clips?.[s]) ? ['jump'] : [],
        gaits: ['walk', 'jog'],
        // Up to the speed where the jog clip reaches its fastest rate (AvatarMotion: jogRate * speed / jogSpeed, at most maxRate).
        speedRange_mps: [0, (T.jogSpeed * T.maxRate) / T.jogRate],
      };
    },

    dispose() {
      if (!motion) return;
      motion.mixer.stopAllAction();
      motion.mixer.uncacheRoot(motion.mixer.getRoot());
      solvers?.setCarry(null);
      motion = null;
      solvers = null;
      reader = null;
    },
  };
  return driver;
}
