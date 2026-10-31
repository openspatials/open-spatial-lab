// What the controller does with keys, as the movement loop is given them: the Shift run key, and the keys held at a crossing.
import assert from "node:assert/strict";
import { FakeTarget, createHarness } from "./controller-harness.mjs";

const key = (code, init = {}) => ({ code, repeat: false, ...init });
const lastInput = (harness) => harness.stepped.at(-1).input;

function runHeldWhileWalking(harness) {
  const { windowTarget } = harness;
  windowTarget.dispatch("keydown", key("KeyW"));
  windowTarget.dispatch("keydown", key("ShiftLeft"));
  windowTarget.dispatch("keydown", key("ShiftLeft", { repeat: true }));
  harness.runNextFrame(50);
  assert.equal(lastInput(harness).forward, true, "W held");
  assert.equal(lastInput(harness).run, true, "Shift makes it run");
  windowTarget.dispatch("keydown", key("ShiftRight"));
  windowTarget.dispatch("keyup", key("ShiftLeft"));
  harness.runNextFrame(100);
  assert.equal(lastInput(harness).run, true, "releasing one Shift of two still runs");
  windowTarget.dispatch("keyup", key("ShiftRight"));
  harness.runNextFrame(150);
  assert.equal(lastInput(harness).forward, true, "W still held after both Shifts are released");
  assert.equal(lastInput(harness).run, false, "releasing both Shifts stops the run");
}

function runReleasedWhereTheKeyboardMoved(harness, editable) {
  const { windowTarget } = harness;
  windowTarget.dispatch("keydown", key("ShiftLeft"));
  windowTarget.dispatch("keyup", key("ShiftLeft", { target: editable }));
  harness.runNextFrame(175);
  assert.equal(lastInput(harness).run, false, "editable-target release clears a Shift held before focus changed");
  windowTarget.dispatch("keydown", key("ShiftRight"));
  windowTarget.dispatch("keyup", key("ShiftRight", { metaKey: true }));
  harness.runNextFrame(180);
  assert.equal(lastInput(harness).run, false, "shortcut-modified release clears the final held Shift");
  windowTarget.dispatch("keyup", key("KeyW"));
  windowTarget.dispatch("keydown", key("ShiftLeft", { metaKey: true }));
  windowTarget.dispatch("keydown", key("KeyW", { ctrlKey: true }));
  windowTarget.dispatch("keydown", key("ShiftRight", { target: editable }));
  harness.runNextFrame(200);
  assert.equal(lastInput(harness).forward, false, "a shortcut or a text field does not walk");
  assert.equal(lastInput(harness).run, false, "a shortcut or a text field does not run");
}

function runClearedWhenThePageLeaves(harness) {
  const { windowTarget, documentTarget } = harness;
  windowTarget.dispatch("keydown", key("ShiftLeft"));
  windowTarget.dispatch("blur");
  harness.runNextFrame(250);
  assert.equal(lastInput(harness).run, false, "a window blur clears the run");
  windowTarget.dispatch("keydown", key("ShiftRight"));
  documentTarget.hidden = true;
  documentTarget.dispatch("visibilitychange");
  harness.runNextFrame(300);
  assert.equal(lastInput(harness).run, false, "a hidden page clears the run");
  documentTarget.hidden = false;
  windowTarget.dispatch("keydown", key("ShiftLeft"));
  windowTarget.dispatch("pagehide");
  harness.runNextFrame(350);
  assert.equal(lastInput(harness).run, false, "a page hide clears the run");
  windowTarget.dispatch("keydown", key("ShiftLeft"));
  assert.equal(harness.controller.movementDebug().run_mode, true, "run mode shows while Shift is held");
  harness.controller.stop();
  assert.equal(harness.controller.movementDebug().run_mode, false, "stopping clears the run mode");
}

/** Shift runs only while held; two Shifts overlap; shortcuts, text fields, a blur, a hidden page and a page hide never leave it on. */
export function shiftRunInput() {
  const harness = createHarness({ isTypingTarget: (target) => target?.editable === true });
  const editable = new FakeTarget("editable");
  editable.editable = true;
  harness.controller.start();
  runHeldWhileWalking(harness);
  runReleasedWhereTheKeyboardMoved(harness, editable);
  runClearedWhenThePageLeaves(harness);
  harness.controller.dispose();
}

/** Keys held through a crossing stay off until they are released and pressed again. */
export function crossingHeldKeys() {
  const harness = createHarness();
  const { windowTarget } = harness;
  harness.controller.start();
  windowTarget.dispatch("keydown", key("KeyW"));
  windowTarget.dispatch("keydown", key("ShiftLeft"));
  assert.equal(harness.controller.movementDebug().keys, "forward run");
  assert.equal(harness.controller.handleCrossing({ kind: "world_crossing" }), false);
  assert.equal(harness.controller.movementDebug().keys, "none", "a crossing clears the held keys");
  assert.equal(harness.controller.movementDebug().run_mode, false, "a crossing clears the run");
  windowTarget.dispatch("keydown", key("KeyW", { repeat: true }));
  windowTarget.dispatch("keydown", key("ShiftLeft", { repeat: true }));
  harness.runNextFrame(50);
  assert.equal(lastInput(harness).forward, false, "key repeat does not walk again after a crossing");
  assert.equal(lastInput(harness).run, false, "key repeat does not run again after a crossing");
  assert.equal(harness.controller.movementDebug().keys, "none");
  windowTarget.dispatch("keyup", key("KeyW"));
  windowTarget.dispatch("keyup", key("ShiftLeft"));
  windowTarget.dispatch("keydown", key("KeyW"));
  harness.runNextFrame(100);
  assert.equal(lastInput(harness).forward, true, "a fresh press walks");
  assert.equal(lastInput(harness).run, false, "a fresh W press does not bring the old Shift back");
  windowTarget.dispatch("keydown", key("ShiftLeft"));
  harness.runNextFrame(150);
  assert.equal(lastInput(harness).run, true, "a fresh Shift press runs");
  harness.controller.dispose();
}
