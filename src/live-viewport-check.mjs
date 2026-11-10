import assert from "node:assert/strict";
import { createLiveViewportController } from "../web/live-viewport-controller.mjs";
import { FakeTarget } from "../tools/behavior/controller-harness.mjs";
import { nodeChecks } from "../tools/behavior/node-checks.mjs";
const { check, finish } = nodeChecks("live-viewport");

function fixture({ visual = true, legacy = false } = {}) {
  const windowTarget = new FakeTarget(), root = new FakeTarget(), body = new FakeTarget(), app = new FakeTarget(), sceneMount = new FakeTarget();
  const styles = {}, frames = new Map(), queries = [], resizes = [];
  let next = 0, relatedResizes = 0;
  for (const element of [root, body, app, sceneMount]) element.getBoundingClientRect = () => ({ left: 1.23456, top: 2.34567, width: 800.12345, height: 600.23456 });
  root.style.setProperty = (key, value) => { styles[key] = value; };
  root.clientWidth = 640; root.clientHeight = 480; root.scrollWidth = 900; root.scrollHeight = 700;
  windowTarget.document = { documentElement: root, body, getElementById: id => id === "scene-mount" ? sceneMount : null };
  Object.assign(windowTarget, { innerWidth: 800, innerHeight: 600, devicePixelRatio: 1 });
  if (visual) windowTarget.visualViewport = Object.assign(new FakeTarget(), { width: 700.5, height: 500.25, offsetLeft: 2, offsetTop: 3 });
  windowTarget.matchMedia = query => {
    const target = new FakeTarget(); target.query = query;
    if (legacy) {
      target.addListener = listener => FakeTarget.prototype.addEventListener.call(target, "change", listener);
      target.removeListener = listener => FakeTarget.prototype.removeEventListener.call(target, "change", listener);
      target.addEventListener = undefined; target.removeEventListener = undefined;
    }
    queries.push(target); return target;
  };
  const options = { windowTarget, mount: app, sceneRuntime: { resize: value => resizes.push(value), viewportDebug: () => ({ fixture: true }) },
    requestFrame: callback => { const id = next++; frames.set(id, callback); return id; }, cancelFrame: id => frames.delete(id), onResize: () => relatedResizes++ };
  const controller = createLiveViewportController(options);
  return { controller, options, windowTarget, root, body, app, sceneMount, styles, frames, queries, resizes,
    relatedResizes: () => relatedResizes, run() { const [id, callback] = frames.entries().next().value; frames.delete(id); callback(); } };
}

await check("snapshot-coalescing", "Viewport snapshots retain dimensions, rounding, epoch and one pending frame", () => {
  const h = fixture(); assert.equal(h.controller.mount(), true); assert.equal(h.controller.mount(), false);
  const rectangle = { left: 1.235, top: 2.346, width: 800.123, height: 600.235 };
  assert.deepEqual(h.controller.snapshot(), { width: 700.5, height: 500.25, offsetLeft: 2, offsetTop: 3, pixelRatio: 1, epoch: 1, listenerCount: 5,
    root: rectangle, body: rectangle, app: rectangle, scene_mount: rectangle, page_scroll_width: 900, page_scroll_height: 700, scene: { fixture: true } });
  h.windowTarget.visualViewport.width = 720;
  for (let i = 0; i < 4; i++) { h.windowTarget.dispatch("resize"); h.windowTarget.visualViewport.dispatch("scroll"); }
  assert.equal(h.frames.size, 1, "resize events share one pending frame, including handle zero"); h.run();
  assert.equal(h.resizes.length, 2); assert.equal(h.relatedResizes(), 2); assert.equal(h.frames.size, 0, "resize does not animate");
  assert.equal(h.styles["--osl-viewport-width"], "720px"); assert.equal(h.body.getAttribute("data-live-viewport-epoch"), "2");
  h.controller.resize(); assert.equal(h.resizes.length, 2); h.controller.resize({ force: true }); assert.equal(h.resizes.length, 3);
  h.controller.dispose();
});

for (const legacy of [false, true]) await check(legacy ? "legacy-dpr" : "dpr-rearm", "Pixel-ratio changes rearm one listener and dispose pending work", () => {
  const h = fixture({ legacy }); h.controller.mount(); const old = h.queries[0];
  h.windowTarget.devicePixelRatio = 1.5; old.dispatch("change");
  assert.equal(old.listenerCount("change"), 0, "old DPR listener removed");
  assert.equal(h.queries.length, 2, "DPR observer rearmed for the new ratio");
  assert.equal(h.queries[1].query, "(resolution: 1.5dppx)"); h.run();
  assert.equal(h.controller.snapshot().pixelRatio, 1.5);
  h.windowTarget.dispatch("resize"); const late = [...h.frames.values()][0]; h.controller.dispose(); h.controller.dispose();
  assert.equal(h.frames.size, 0, "dispose cancels resize frame");
  assert.equal(h.queries[1].listenerCount("change"), 0, "dispose removes current DPR listener");
  assert.equal(h.windowTarget.listenerCount("resize"), 0); assert.equal(h.windowTarget.visualViewport.listenerCount("scroll"), 0);
  const count = h.resizes.length; late(); h.controller.schedule(); h.controller.resize({ force: true });
  assert.equal(h.resizes.length, count, "retired callback cannot resize"); assert.equal(h.controller.mount(), false);
  assert.equal(h.controller.snapshot().listenerCount, 0);
});

await check("fallback-dimensions", "Missing visual viewport and zero window dimensions retain root fallback", () => {
  const h = fixture({ visual: false }); h.windowTarget.innerWidth = 0; h.windowTarget.innerHeight = 0; h.windowTarget.matchMedia = undefined;
  h.controller.mount(); assert.equal(h.controller.snapshot().width, 640); assert.equal(h.controller.snapshot().height, 480);
  assert.equal(h.controller.snapshot().listenerCount, 2); h.controller.dispose();
});

const file = "web/live-viewport-controller.mjs";
await finish({ checkFile: "src/live-viewport-check.mjs", faults: [
  { statement: "snapshot-coalescing", name: "pending frame guard removed", expect: /one pending frame/, edits: [{ file, find: 'if (disposed || frame !== null) return;', replace: 'if (disposed) return;' }] },
  { statement: "dpr-rearm", name: "DPR rearm removed", expect: /DPR listener removed/, edits: [{ file, find: 'armPixelRatio(); schedule();', replace: 'schedule();' }] },
  { statement: "dpr-rearm", name: "pending resize not cancelled", expect: /dispose cancels resize frame/, edits: [{ file, find: 'if (frame !== null) cancelFrame(frame);', replace: 'void frame;' }] },
] });
