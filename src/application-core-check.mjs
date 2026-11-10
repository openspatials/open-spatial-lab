import assert from "node:assert/strict";
import { createApplicationCore } from "../web/application-core.mjs";

const phases = ["runtime", "input", "layers", "local", "peer", "view", "scene", "evaluate", "publish", "preview", "draw"];
for (const action of ["stop", "dispose", "restart"]) {
  for (const interrupted of phases) {
    const callbacks = new Map();
    const trace = [];
    let serial = 0;
    let armed = true;
    let core;
    const visit = phase => {
      trace.push(phase);
      if (armed && phase === interrupted) {
        armed = false;
        if (action === "dispose") core.dispose();
        else core.stop();
        if (action === "restart") core.start();
      }
    };
    core = createApplicationCore({
      readRuntime: () => { visit("runtime"); return {}; },
      stepInput: () => visit("input"),
      readLayers: () => { visit("layers"); return { local: { evaluateFrame: () => visit("local") }, peers: [{ evaluateFrame: () => visit("peer") }] }; },
      updateView: () => visit("view"),
      readScene: () => { visit("scene"); return { evaluateFrame: () => visit("evaluate"), renderFrame: () => visit("draw") }; },
      publishFrame: () => visit("publish"),
      drawPreviews: () => visit("preview"),
      requestFrame: callback => { callbacks.set(++serial, callback); return serial; },
      cancelFrame: id => callbacks.delete(id),
      now: () => 0,
    });
    core.start();
    const retired = callbacks.get(1);
    callbacks.delete(1);
    retired(16);
    assert.deepEqual(trace, phases.slice(0, phases.indexOf(interrupted) + 1), `${action} at ${interrupted} revokes later phases`);
    assert.equal(callbacks.size, action === "restart" ? 1 : 0, `${action} at ${interrupted} leaves only the current generation scheduled`);
    trace.length = 0;
    retired(32);
    assert.deepEqual(trace, [], "a delivered cancelled callback has no effects");
    if (action === "restart") {
      const current = [...callbacks.values()][0];
      callbacks.clear();
      current(48);
      assert.deepEqual(trace, phases, "the replacement generation completes normally");
      assert.equal(callbacks.size, 1, "one replacement frame remains");
    }
    core.dispose();
    assert.equal(callbacks.size, 0);
  }
}
console.log("application core: 33 phase/lifetime cases passed");
