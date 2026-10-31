// The server view's camera button is the header's own icon button: it shows, names its action, reports its state, carries
// no words, and switches the view when pressed.
import assert from "node:assert/strict";
import { FakeTarget, createHarness } from "./controller-harness.mjs";

const TOP_DOWN = "Switch server view to top-down camera";
const THIRD_PERSON = "Switch server view to third-person camera";

function stateOf(toggle) {
  return { label: toggle.getAttribute("aria-label"), title: toggle.title, pressed: toggle.getAttribute("aria-pressed"), mode: toggle.getAttribute("data-server-view-mode") };
}

export function serverViewToggle() {
  const toggle = new FakeTarget("btn-camera-toggle");
  toggle.hidden = true;
  const harness = createHarness({ isPlayer: false, elements: { "btn-camera-toggle": toggle } });
  const made = [];
  const create = harness.documentTarget.createElement;
  harness.documentTarget.createElement = (tag) => { made.push(tag); return create(tag); };
  harness.controller.start();
  assert.equal(toggle.hidden, false, "the shared header button is not shown in the server view");
  assert.deepEqual(made, [], "the server view built a button of its own");
  assert.equal(toggle.getAttribute("aria-label"), TOP_DOWN, "the button's aria-label does not name its action");
  assert.equal(toggle.title, TOP_DOWN, "the button's title does not name its action");
  assert.equal(toggle.getAttribute("aria-pressed"), "false", "the button reports aria-pressed false in third person");
  assert.ok(!toggle.textContent, `the button carries visible text: ${toggle.textContent}`);
  toggle.dispatch("click");
  assert.deepEqual(stateOf(toggle), { label: THIRD_PERSON, title: THIRD_PERSON, pressed: "true", mode: "top_down" }, "a press does not switch to top-down");
  assert.equal(harness.controller.serverViewCameraState().mode, "top_down");
  assert.ok(!toggle.textContent, "the button gained visible text after a press");
  toggle.dispatch("click");
  assert.deepEqual(stateOf(toggle), { label: TOP_DOWN, title: TOP_DOWN, pressed: "false", mode: "third_person" }, "a second press does not switch back");
  harness.controller.stop();
  assert.equal(toggle.hidden, true, "stopping leaves the button shown");
  assert.equal(toggle.getAttribute("aria-pressed"), null, "stopping leaves aria-pressed on the button");
}
