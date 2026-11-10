import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { canonicalDebugState } from "../web/application-debug-projection.mjs";
import { publishDebugDataset } from "../web/application-debug-dataset.mjs";
import { createDebugWriter } from "../web/application-debug-writer.mjs";
import { createApplicationMotionPanel } from "../web/application-motion-panel.mjs";
import { createApplicationWorldPanel } from "../web/application-world-panel.mjs";
import { createApplicationPrefetchPanel } from "../web/application-prefetch-panel.mjs";
import { STEPS } from "../tools/run-checks-lists.mjs";
import { nodeChecks } from "../tools/behavior/node-checks.mjs";
const { check, finish } = nodeChecks("application-debug");
function fakeDom() {
  const elements = new Map(), attributes = {};
  const make = id => { const classes = new Set(); return { id, hidden: false, textContent: "", html: "", children: [],
    classList: { remove(...names) { names.forEach(name => classes.delete(name)); }, toggle(name, on) { if (on) classes.add(name); else classes.delete(name); } },
    appendChild(child) { this.children.push(child); elements.set(child.id, child); }, classes }; };
  const lookup = id => { if (!elements.has(id)) elements.set(id, make(id)); return elements.get(id); };
  const body = { setAttribute(name, value) { attributes[name] = String(value); } };
  return { lookup, body, document: { body, getElementById: id => elements.get(id) || null, createElement: () => make("") },
    reconcile(host, html) { host.html = html; },
    snapshot: () => ({ attributes, elements: Object.fromEntries([...elements].map(([key,e]) => [key,{ text: e.textContent, hidden: e.hidden, html: e.html, classes: [...e.classes].sort() }])) }) };
}

function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); Object.values(value).forEach(freeze); }
  return value;
}
const cases = JSON.parse(readFileSync(new URL("./fixtures/application-debug.json", import.meta.url)));
const { HANDOFF_PHASES } = await import("data:text/javascript;base64," + Buffer.from(readFileSync(new URL("../runtime/scene-core/public/frontend-contract.js", import.meta.url))).toString("base64"));
let dom;
for (const { name, raw, facts, expected, reuseDom } of cases) await check(name, "Captured debug, dataset and panel output remains exact", () => {
  freeze(raw); freeze(facts);
  if (!reuseDom) dom = fakeDom();
  const writer = createDebugWriter(dom.lookup, dom.body), debug = canonicalDebugState(raw, {...facts, handoffPhases: HANDOFF_PHASES});
  assert.deepEqual(JSON.parse(JSON.stringify(debug)), expected.debug, "captured debug projection");
  createApplicationMotionPanel(writer).render(debug, { movement: facts.movement, camera: facts.camera, pressedKeys: facts.movement.keys });
  const world = createApplicationWorldPanel(writer); world.render(debug); world.renderGeoPose(debug);
  publishDebugDataset(dom.body, debug, facts.role);
  const notification = createApplicationPrefetchPanel(writer, dom.document, dom.reconcile).render(debug, facts);
  const notices = notification ? [["completion", notification.completion], ...notification.machines.map(value => ["prefetch", value])] : [];
  assert.deepEqual(JSON.parse(JSON.stringify(dom.snapshot())), expected.dom, "captured DOM publication");
  assert.deepEqual(notices, expected.notices, "existing notification inputs");
});
await check("phase-authority", "Projection consumes the supplied canonical phase authority", () => {
  const facts={...cases[0].facts,handoffPhases:{...HANDOFF_PHASES,DEPARTED:"contract-exit",ARRIVED:"contract-arrival"}};
  const exited=canonicalDebugState({phase:"contract-exit",handoff_id:"h"},facts);
  const arrived=canonicalDebugState({phase:"contract-arrival",handoff_id:"h"},facts);
  assert.equal(exited.transition.source_exit_accepted,true,"supplied exit phase");
  assert.equal(arrived.transition.target_arrival_accepted,true,"supplied arrival phase");
});
await check("registration", "New checks belong to normal, fast and client selections", () => {
  for (const file of ["src/application-debug-check.mjs", "src/live-viewport-check.mjs"]) {
    const selected = STEPS.filter(step => step.file === file);
    assert.equal(selected.length, 1, "required check registered once");
    assert(selected[0].groups.includes("client") && !selected[0].browser && !selected[0].lab, "required normal/fast/client registration");
  }
});
await finish({ checkFile: "src/application-debug-check.mjs", faults: [
  { statement: "phase-authority", name: "phase authority replaced by local values", expect: /supplied exit phase/, edits: [{ file: "web/application-debug-projection.mjs", find: "const HANDOFF_PHASES = facts.handoffPhases;", replace: 'const HANDOFF_PHASES = { DEPARTED: "departed", ARRIVED: "arrived" };' }] },
  { statement: "active-zero-false", name: "zero signed distance lost", expect: /captured debug projection/, edits: [{ file: "web/application-debug-projection.mjs", find: "controls.portal_signed_plane_distance_m ?? null", replace: "controls.portal_signed_plane_distance_m || null" }] },
  { statement: "active-zero-false", name: "equipment visibility falsely inferred", expect: /captured debug projection/, edits: [{ file: "web/application-debug-projection.mjs", find: "visual.has_held_item === true", replace: "true" }] },
  { statement: "active-zero-false", name: "false marker dropped", expect: /captured DOM publication/, edits: [{ file: "web/application-debug-dataset.mjs", find: 'typeof contextMarker.same_marker_after_crossing === "boolean"', replace: 'contextMarker.same_marker_after_crossing === true' }] },
  { statement: "multi-to-single", name: "retired portal list stays visible", expect: /captured DOM publication/, edits: [{ file: "web/application-prefetch-panel.mjs", find: 'if (host) host.hidden = true;', replace: 'if (host) host.hidden = false;' }] },
  { statement: "registration", name: "viewport check omitted", expect: /required check registered once/, edits: [{ file: "tools/run-checks-lists.mjs", find: '  "src/live-viewport-check.mjs",', replace: '' }] },
] });
