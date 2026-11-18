// Extensions in a Web of Worlds world, in a web page: the test world (src/fixtures/extension-host/world/) is built with
// buildWowScene, drawn with Three.js, and mounted with mountWowExtensions, each extension in its own module Web Worker.
// One check per case, read from the page's console as each case ends.
//
// One Chrome for Testing (headless, puppeteer-core) and one in-process static server on 127.0.0.1. The server answers
// on OSL_UE_MOUNT_BROWSER_PORT (default 18351) and on a second, free port, the second origin of the cross-origin case.
// It serves the Lab page's routes (web/ at the root, /vendor/scene-core/, /vendor-three-examples/), the extension host
// at /vendor/extension-host/ and the fixtures at /fixtures/extension-host/. The browser and the server are always
// closed, including on failure.
//
// The Step 5a cases mount extension-world-5a.json five times with the page's localStorage (see the page script). Their
// network requests go to the check's test server (fixtures/extension-host/net-server.mjs) on another free port, with
// CORS headers for the page's origin; the server puts that origin in place of the world file's 127.0.0.1:18353.
//
// One case mounts a node that declares its extension through a signed carrier manifest
// (`webofworlds_extension.universal_extension_manifests`); the check signs the carrier (fixtures/extension-host/carrier.mjs)
// and serves it at /__ue-carrier/box-carrier.json.
//
// One case moves a node through the host's node list: no test module calls node-set-transform, so the check page
// gives the mount the node fields a node-set-transform leaves (position, rotation, scale) for the Box node.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { nodeChecks } from "../tools/behavior/node-checks.mjs";
import { findBrowser } from "../tools/find-browser.mjs";
import { startNetServer } from "./fixtures/extension-host/net-server.mjs";
import { sleep, startServers, stopBrowser, stopServer } from "./fixtures/extension-host/check-server.mjs";
import { carrierManifest, newCarrierKey } from "./fixtures/extension-host/carrier.mjs";

const { check, finish } = nodeChecks("wow-extension-mount-browser");
const PORT = Number(process.env.OSL_UE_MOUNT_BROWSER_PORT) || 18351;
const PAGE = "/__ue-mount-check.html";
const RESULT_MARK = "ue-mount-case ";
const DONE_MARK = "ue-mount-done";
const STALL_MS = 30000;
const TOTAL_MS = 150000;
// Headless screenshots of the consent dialog and the Extensions panel, when OSL_UE_MOUNT_SHOT_DIR names a folder.
const SHOT_DIR = process.env.OSL_UE_MOUNT_SHOT_DIR || "";
const oneLine = (error) => String((error && error.message) || error).replace(/\s+/g, " ").trim();

const PAGE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Extension mount check</title>
<script type="importmap">{"imports":{"three":"/vendor/scene-core/vendor/three/three.module.js","#scene-description":"/vendor/scene-core/scene-description.mjs"}}</script>
</head><body style="margin:0;background:#0b1020"><script type="module" src="/__ue-mount-check.mjs"></script></body></html>
`;

// The page. Workers are counted by wrapping Worker before the host is imported.
const PAGE_SCRIPT = `
const RESULT = ${JSON.stringify(RESULT_MARK)}, DONE = ${JSON.stringify(DONE_MARK)};
const results = [];
const oneLine = (error) => String((error && error.message) || error).replace(/\\s+/g, " ").trim();
const report = (id, ok, detail) => {
  const result = { id, ok, detail: String(detail || "") };
  results.push(result);
  console.log(RESULT + JSON.stringify(result));
};
const run = async (id, fn) => { try { await fn(); report(id, true, ""); } catch (error) { report(id, false, oneLine(error)); } };
const assert = (value, message) => { if (!value) throw new Error(message); };
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const live = new Set();
const NativeWorker = globalThis.Worker;
globalThis.Worker = class CountedWorker extends NativeWorker {
  constructor(url, options) { super(url, options); live.add(this); }
  terminate() { live.delete(this); return super.terminate(); }
};

const THREE = await import("three");
const { buildWowScene } = await import("/wow-scene.mjs");
const { mountWowExtensions } = await import("/wow-extension-mount.mjs");
const { loadExtension } = await import("/vendor/extension-host/extension-host.mjs");

const WORLD_PATH = "/fixtures/extension-host/world/extension-world.json";
const second = new URLSearchParams(location.search).get("second");
const worldUrl = new URL(WORLD_PATH, location.href).href;
const built = buildWowScene(await (await fetch(worldUrl)).json(), THREE, { source: "ue-mount-check", width: 480, height: 320 });

let frames = 0, drawing = true, renderer = null, rendererError = null, view = built;
try {
  renderer = new THREE.WebGLRenderer({ antialias: false });
  renderer.setSize(480, 320);
  document.body.append(renderer.domElement);
} catch (error) { rendererError = oneLine(error); }
const draw = () => {
  if (!drawing) return;
  if (renderer) { renderer.render(view.scene, view.camera); frames += 1; }
  requestAnimationFrame(draw);
};
requestAnimationFrame(draw);

// Each load is recorded with its node's label, the grant it was given and the extension it gave back.
const labels = new WeakMap();
const learn = (scene) => { for (const node of scene.extension_nodes) for (const v of node.validations) if (v.ok) labels.set(v.effective, node.label); };
learn(built);
const calls = [];
const moved = new Map();
const wrapped = async (args) => {
  const extension = await loadExtension(args);
  const label = labels.get(args.declaration) || "?";
  calls.push({ label, grant: [...(args.grant || [])], extension });
  if (label !== "ue-box") return extension;
  return new Proxy(extension, {
    get(target, key) {
      if (key === "nodes") return target.nodes.map((node) => (moved.has(node.composed) ? { ...node, ...moved.get(node.composed) } : node));
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
};
const fetched = [];
const countingFetch = (url, init) => { fetched.push(String(url)); return fetch(url, init); };
const loadGltf = async (url) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error("HTTP " + response.status + " for " + url);
  throw new Error("the check page loads no glTF");
};

const groupOf = (scene, label) => scene.extension_nodes.find((node) => node.label === label).group;
const findUnder = (root, test) => { let hit = null; root.traverse((object) => { if (!hit && test(object)) hit = object; }); return hit; };
const countUnder = (root, test) => { let n = 0; root.traverse((object) => { if (test(object)) n += 1; }); return n; };
const round = (values) => values.map((v) => Math.round(v * 1e4) / 1e4);
const worldPos = (object) => { object.updateWorldMatrix(true, false); return round(object.getWorldPosition(new THREE.Vector3()).toArray()); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

let mounted = null, mountError = null;
try {
  mounted = await mountWowExtensions(built.extension_nodes, THREE, { loadExtension: wrapped, worldUrl, pageOrigin: location.origin, loadGltf, fetch: countingFetch });
} catch (error) { mountError = oneLine(error); }
const mustMount = () => assert(mounted, "the mount pass threw: " + mountError);
const recordOf = (label) => mounted.records.find((record) => record.label === label);

await run("ext-mount-rp1", async () => {
  mustMount();
  const stool = findUnder(groupOf(built, "rp1-stool"), (o) => o.name === "ue-node:Stool");
  assert(stool, "no ue-node:Stool under the rp1-stool node group (" + JSON.stringify(recordOf("rp1-stool") && { status: recordOf("rp1-stool").status, stage: recordOf("rp1-stool").stage, error: recordOf("rp1-stool").error }) + ")");
  assert(stool.userData.reference === "assets/Stool.glb", "the Stool's reference is " + stool.userData.reference);
});

await run("ext-mount-ue-core", async () => {
  mustMount();
  const group = groupOf(built, "ue-box");
  const box = findUnder(group, (o) => o.name === "ue-node:Box");
  assert(box, "no ue-node:Box under the ue-box node group");
  const at = worldPos(box), node = worldPos(group);
  assert(same(at, node), "the Box is at " + JSON.stringify(at) + ", the ue-box node at " + JSON.stringify(node));
  assert(same(node, [-1.5, 0.5, -1]), "the ue-box node is not at its composed position: " + JSON.stringify(node));
});

await run("ext-integrity-visible", async () => {
  mustMount();
  const record = recordOf("bad-hash");
  assert(record && record.status === "refused" && record.stage === "integrity", "bad-hash was not refused at integrity: " + JSON.stringify(record && { status: record.status, stage: record.stage }));
  const call = calls.find((item) => item.label === "bad-hash");
  assert(call && call.extension.sandbox === null, "bad-hash started a worker");
  const marker = findUnder(groupOf(built, "bad-hash"), (o) => o.userData && o.userData.ueStage === "integrity");
  assert(marker && /^ue-refused:integrity:bad-hash/.test(marker.name), "no marker labeled integrity under bad-hash: " + (marker && marker.name));
});

await run("ext-consent-pending", async () => {
  mustMount();
  const record = recordOf("wants-panel");
  assert(record && record.status === "mounted", "wants-panel did not run: " + JSON.stringify(record && { status: record.status, stage: record.stage, error: record.error }));
  assert(findUnder(groupOf(built, "wants-panel"), (o) => o.name === "ue-node:Box"), "wants-panel made no box");
  const call = calls.find((item) => item.label === "wants-panel");
  assert(!call.grant.includes("ue.ui.panel"), "ue.ui.panel was granted: " + JSON.stringify(call.grant));
  const pending = mounted.needs_consent.find((item) => item.label === "wants-panel");
  assert(pending && pending.tokens.includes("ue.ui.panel"), "the mount summary does not list wants-panel as needing consent");
  const listed = built.render_summary.extensions.needs_consent.find((item) => item.label === "wants-panel");
  assert(listed && listed.tokens.includes("ue.ui.panel") && /needs consent/.test(listed.note), "render_summary.extensions does not list wants-panel as needing consent");
});

await run("ext-transform-follows", async () => {
  mustMount();
  const box = findUnder(groupOf(built, "ue-box"), (o) => o.name === "ue-node:Box");
  assert(box, "no ue-node:Box under the ue-box node group");
  moved.set(box.userData.composed, { position: [0.25, 1.75, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
  await sleep(500);
  assert(same(round(box.position.toArray()), [0.25, 1.75, 0]), "the object did not move after node-set-transform: it is at " + JSON.stringify(round(box.position.toArray())));
});

await run("ext-world-survives", async () => {
  mustMount();
  const record = recordOf("runaway");
  assert(record && record.status === "failed" && record.stage === "init", "runaway was not shown as failed at init: " + JSON.stringify(record && { status: record.status, stage: record.stage }));
  assert(findUnder(groupOf(built, "runaway"), (o) => o.userData && o.userData.ueStage === "init"), "no marker labeled init under runaway");
  assert(findUnder(built.scene, (o) => o.name === "ue-node:Stool") && findUnder(built.scene, (o) => o.name === "ue-node:Box"), "the other nodes do not render");
  assert(renderer, "no WebGL renderer: " + rendererError);
  const before = frames;
  await sleep(700);
  assert(frames - before >= 5, "the page drew " + (frames - before) + " frames in 700 ms");
});

await run("ext-unmount-clean", async () => {
  mustMount();
  assert(live.size > 0, "no extension worker was alive before unmount()");
  await mounted.unmount();
  await sleep(300);
  assert(live.size === 0, live.size + " extension workers are still alive after unmount()");
  const left = countUnder(built.scene, (o) => /^ue-node:/.test(o.name));
  assert(left === 0, left + " ue-node: objects remain after unmount()");
});

await run("ext-cross-origin-refused", async () => {
  assert(second, "no second origin");
  const otherUrl = "http://127.0.0.1:" + second + WORLD_PATH;
  const other = buildWowScene(await (await fetch(otherUrl)).json(), THREE, { source: "ue-mount-check-other" });
  learn(other);
  await fetch("/__ue-requests?reset=1");
  fetched.length = 0;
  const result = await mountWowExtensions(other.extension_nodes, THREE, { loadExtension: wrapped, worldUrl: otherUrl, pageOrigin: location.origin, loadGltf, fetch: countingFetch });
  const atOrigin = result.refused.filter((record) => record.stage === "origin").length;
  const served = await (await fetch("/__ue-requests")).json();
  const marker = findUnder(groupOf(other, "ue-box"), (o) => o.userData && o.userData.ueStage === "origin");
  await result.unmount();
  assert(atOrigin === 5 && result.mounted.length === 0 && result.failed.length === 0,
    "refused at stage origin: " + atOrigin + " of 5 (mounted " + result.mounted.length + ", failed " + result.failed.length + "); fetched " + fetched.length + " module(s)");
  assert(fetched.length === 0 && served.modules === 0, "fetched " + fetched.length + " module(s); the server answered " + served.modules + " module request(s)");
  assert(marker && /^ue-refused:origin:ue-box/.test(marker.name), "no marker labeled origin under ue-box");
});


// ---- An extension declared by a signed carrier manifest ----
await run("manifest-extension-runs", async () => {
  const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const carrierWorld = { spatialID: "ue-carrier-check", root: 0, nodes: [
    { id: 0, label: "root", children: [1], localTransform: I },
    { id: 1, label: "carried-box", parent: 0, localTransform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 2, 0, 1, 1],
      webofworlds_extension: { universal_extension_manifests: [{ url: "box-carrier.json" }] } },
  ] };
  const carrierWorldUrl = new URL("/__ue-carrier/world.json", location.href).href;
  const scene = buildWowScene(carrierWorld, THREE, { source: "ue-mount-check-carrier" });
  const result = await mountWowExtensions(scene.extension_nodes, THREE, { loadExtension: wrapped, worldUrl: carrierWorldUrl, pageOrigin: location.origin, loadGltf, fetch: countingFetch });
  const found = result.records.find((item) => item.label === "carried-box");
  const record = found ? { status: found.status, stage: found.stage, error: found.error } : null;
  const group = groupOf(scene, "carried-box");
  const box = findUnder(group, (o) => o.name === "ue-node:Box");
  const at = box ? worldPos(box) : null, node = worldPos(group);
  await result.unmount();
  assert(record && record.status === "mounted", "the carrier's extension did not run: " + JSON.stringify(record || "no record"));
  assert(box, "no ue-node:Box under the carried-box node group");
  assert(same(at, node) && same(node, [2, 0, 1]), "the Box is at " + JSON.stringify(at) + ", the carried-box node at " + JSON.stringify(node));
});


// ---- Step 5a: the consent prompt, network fetch, storage and pointer input, with the 5a test world ----
//
// Five mount passes of extension-world-5a.json, each a fresh mountWowExtensions with this page's localStorage, as a
// reload would be: A answers every dialog with Deny, B allows with "Remember" on the fetcher, C is a reload, D is a
// reload with another module.integrity for the fetcher, E withdraws the fetcher in the Extensions panel. The facts of
// each pass are kept and the cases read them.
const { renderExtensionsPanel, GRANT_PREFIX } = await import("/wow-extension-consent.mjs");
const { attachExtensionPointer } = await import("/wow-extension-pointer.mjs");
const WORLD_5A = "/fixtures/extension-host/world/extension-world-5a.json";
const net = new URLSearchParams(location.search).get("net");
const shots = new URLSearchParams(location.search).get("shots") === "1";
const FETCH_TOKEN = "ue.network.fetch:" + net;
const netSeen = async () => (await fetch(net + "/__seen", { cache: "no-store" })).json();
const netReset = () => fetch(net + "/__reset", { cache: "no-store" });
const waitFor = async (test, ms) => { const end = performance.now() + (ms || 4000); for (;;) { const value = await test(); if (value || performance.now() > end) return value; await sleep(50); } };
const shot = async (name) => {
  if (!shots) return;
  window.__ueShotTaken = false;
  console.log("ue-mount-shot " + name);
  await waitFor(() => window.__ueShotTaken, 10000);
};
for (const key of Object.keys(localStorage)) if (key.startsWith("ue-grants:") || key.startsWith("ue-storage:")) localStorage.removeItem(key);
const world5a = await (await fetch(WORLD_5A, { cache: "no-store" })).json();
const world5aUrl = new URL(WORLD_5A, location.href).href;
const facts = {};
const failures = {};
const note = (id, error) => { if (!failures[id]) failures[id] = oneLine(error); };

async function mountPass(world) {
  const scene = buildWowScene(world, THREE, { source: "ue-mount-check-5a", width: 480, height: 320 });
  learn(scene);
  view = scene;
  const result = await mountWowExtensions(scene.extension_nodes, THREE, { loadExtension: wrapped, worldUrl: world5aUrl, pageOrigin: location.origin, loadGltf, fetch: countingFetch, document, storage: localStorage });
  const pointer = renderer ? attachExtensionPointer({ THREE, camera: scene.camera, scene: scene.scene, canvas: renderer.domElement, mounted: result }) : null;
  return {
    scene, mounted: result, pointer,
    extension: (label) => { const record = result.records.find((item) => item.label === label); return record && record.extension; },
    record: (label) => result.records.find((item) => item.label === label),
    async end() { if (pointer) pointer.dispose(); await result.unmount(); },
  };
}
const dialogs = () => [...document.querySelectorAll('[data-testid="ue-consent-dialog"]')];
const labelOf = (dialog) => String(dialog.getAttribute("data-ue-extension") || "").replace(/#\\d+$/, "");
const inspect = (dialog) => ({
  rows: [...dialog.querySelectorAll("[data-ue-token]")].map((row) => ({
    token: row.getAttribute("data-ue-token"),
    tokenText: (row.querySelector(".ue-consent-token") || {}).textContent,
    purpose: (row.querySelector(".ue-consent-purpose") || {}).textContent,
  })),
  elements: dialog.querySelectorAll("img, script, iframe, svg").length,
  text: dialog.textContent,
});
// Answers the dialogs as they come, one at a time, until each label in plan was seen or none shows for quietMs.
// plan[label](dialog) returns "allow", "allow-remember", "deny" or "close".
async function answerDialogs(plan, quietMs) {
  const seen = {};
  const wanted = Object.keys(plan);
  for (;;) {
    const dialog = await waitFor(() => dialogs().find((item) => !item.__ueAnswered), quietMs || 4000);
    if (!dialog) break;
    dialog.__ueAnswered = true;
    const label = labelOf(dialog);
    seen[label] = inspect(dialog);
    const choose = plan[label] || (() => "deny");
    const action = await choose(dialog);
    if (action === "allow-remember") dialog.querySelector("[data-ue-remember]").checked = true;
    dialog.querySelector('[data-ue-action="' + (action === "allow-remember" ? "allow" : action) + '"]').click();
    if (wanted.every((name) => seen[name])) { await sleep(150); if (!dialogs().some((item) => !item.__ueAnswered)) break; }
  }
  return seen;
}
const logOf = (extension) => (extension ? [...extension.log] : []);
const fetchLines = (extension) => logOf(extension).filter((line) => line.startsWith("fetch "));
const fetchResults = (extension) => (extension ? extension.events.filter((item) => item.event && item.event.type === "fetch") : []);
const pointerEvents = (extension) => (extension ? extension.events.filter((item) => item.event && item.event.type === "pointer") : []);
async function clickNode(pass, label) {
  const group = groupOf(pass.scene, label);
  const node = await waitFor(() => { const hit = findUnder(group, (o) => /^ue-node:/.test(o.name)); return hit && hit.children.some((child) => child.userData && child.userData.ueResource) ? hit : null; }, 4000);
  assert(node, "no ue-node: object with its model under " + label);
  const center = new THREE.Box3().setFromObject(node).getCenter(new THREE.Vector3());
  const ndc = center.clone().project(pass.scene.camera);
  const canvas = renderer.domElement, rect = canvas.getBoundingClientRect();
  const x = rect.left + ((ndc.x + 1) / 2) * rect.width, y = rect.top + ((1 - ndc.y) / 2) * rect.height;
  const init = { clientX: x, clientY: y, bubbles: true, pointerId: 1, pointerType: "mouse", isPrimary: true, button: 0 };
  canvas.dispatchEvent(new PointerEvent("pointermove", init));
  canvas.dispatchEvent(new PointerEvent("pointerdown", init));
  canvas.dispatchEvent(new PointerEvent("pointerup", init));
  canvas.dispatchEvent(new MouseEvent("click", init));
  await sleep(500);
  return [x, y];
}
const otherPointerEvents = (pass) => ["fetcher", "storage-user"].flatMap((label) => pointerEvents(pass.extension(label)).map(() => label));

// Pass A: every dialog is answered with Deny (the storage user's with the close button).
try {
  await netReset();
  const A = await mountPass(world5a);
  facts.A = { mounted: A.mounted.mounted.map((record) => record.label) };
  const seen = await answerDialogs({
    fetcher: async () => {
      await waitFor(() => fetchLines(A.extension("fetcher")).includes("fetch -2"), 3000);
      facts.A.fetchWhileOpen = fetchLines(A.extension("fetcher"));
      await shot("consent-dialog-fetcher");
      return "deny";
    },
    "storage-user": () => "close",
    "pointer-listener": () => "deny",
  });
  facts.A.seen = seen;
  await sleep(1500);
  facts.A.fetchAfterDeny = fetchLines(A.extension("fetcher"));
  facts.A.resultsAfterDeny = fetchResults(A.extension("fetcher")).length;
  facts.A.netAfterDeny = (await netSeen()).length;
  facts.A.scriptRan = globalThis.__ueConsentScriptRan;
  try {
    facts.A.clickedAt = await clickNode(A, "pointer-listener");
    facts.A.pointerWithoutGrant = pointerEvents(A.extension("pointer-listener")).map((item) => item.event.event);
  } catch (error) { note("ext-pointer-events", error); }
  await A.end();
} catch (error) { for (const id of ["ext-consent-prompt", "ext-consent-text-safe", "ext-pointer-events"]) note(id, error); }

// Pass B: the fetcher is allowed with "Remember", the other two for this page session.
try {
  await netReset();
  const B = await mountPass(world5a);
  facts.B = {};
  facts.B.seen = await answerDialogs({ fetcher: () => "allow-remember", "storage-user": () => "allow", "pointer-listener": () => "allow" });
  const fetcher = B.extension("fetcher");
  facts.B.okResult = await waitFor(() => fetchResults(fetcher).find((item) => item.event.status === 200 && !item.event.error), 6000);
  facts.B.okResult = facts.B.okResult ? facts.B.okResult.event : null;
  facts.B.fetchLines = fetchLines(fetcher);
  try {
    await clickNode(B, "pointer-listener");
    facts.B.pointer = pointerEvents(B.extension("pointer-listener")).map((item) => ({ attachment: item.attachment, event: item.event.event, node: item.event.node, point: item.event.point }));
    facts.B.pointerAttachment = B.record("pointer-listener").attachment.index;
    facts.B.others = otherPointerEvents(B);
  } catch (error) { note("ext-pointer-events", error); }
  facts.B.record = localStorage.getItem(GRANT_PREFIX + B.record("fetcher").placement_key);
  await B.end();
} catch (error) { for (const id of ["ext-consent-prompt", "ext-consent-remembered", "ext-pointer-events"]) note(id, error); }

// Pass C: a reload. The fetcher's grant was remembered: no dialog, and its fetch goes through.
try {
  await netReset();
  const C = await mountPass(world5a);
  facts.C = { seen: await answerDialogs({ "storage-user": () => "deny", "pointer-listener": () => "deny" }, 2500) };
  const result = await waitFor(() => fetchResults(C.extension("fetcher")).find((item) => item.event.status === 200 && !item.event.error), 6000);
  facts.C.ok = !!result;
  facts.C.fetchLines = fetchLines(C.extension("fetcher"));
  await C.end();
} catch (error) { note("ext-consent-remembered", error); }

// Pass D: a reload with another module.integrity for the fetcher (the same module with one custom section added).
try {
  const original = new Uint8Array(await (await fetch("/fixtures/extension-host/world/fetcher.wasm")).arrayBuffer());
  const extra = [0x00, 0x03, 0x02, 0x76, 0x32];
  const changed = new Uint8Array(original.length + extra.length);
  changed.set(original); changed.set(extra, original.length);
  let binary = ""; for (const byte of changed) binary += String.fromCharCode(byte);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", changed));
  let hash = ""; for (const byte of digest) hash += String.fromCharCode(byte);
  const world = JSON.parse(JSON.stringify(world5a));
  const declaration = world.nodes.find((node) => node.label === "fetcher").webofworlds_extension.universal_extensions[0];
  declaration.module.url = "data:application/wasm;base64," + btoa(binary);
  declaration.module.integrity = "sha256-" + btoa(hash);
  const D = await mountPass(world);
  facts.D = { status: D.record("fetcher").status, seen: await answerDialogs({ fetcher: () => "deny" }, 4000) };
  await D.end();
} catch (error) { note("ext-consent-remembered", error); }

// Pass E: a reload; the fetcher runs with its remembered grant, and Withdraw in the Extensions panel takes it back.
try {
  await netReset();
  const E = await mountPass(world5a);
  facts.E = { seen: await answerDialogs({ "storage-user": () => "deny", "pointer-listener": () => "deny" }, 2500) };
  const fetcher = E.extension("fetcher");
  const inFlight = await waitFor(async () => (await netSeen()).some((record) => record.path === "/slow" && !record.completed && !record.aborted), 4000);
  facts.E.inFlight = !!inFlight;
  const panel = renderExtensionsPanel({ document, mounted: E.mounted });
  document.body.append(panel.element);
  await sleep(100);
  facts.E.panelRows = [...panel.element.querySelectorAll("[data-ue-extension]")].map((row) => ({
    extension: row.getAttribute("data-ue-extension"), state: (row.querySelector("[data-ue-state]") || {}).textContent,
    tokens: (row.querySelector(".ue-extension-tokens") || {}).textContent,
  }));
  await shot("extensions-panel");
  const row = panel.element.querySelector('[data-ue-extension^="fetcher#"]');
  const button = row && row.querySelector("[data-ue-withdraw]");
  assert(button, "the Extensions panel has no Withdraw button for the fetcher");
  const before = fetchLines(fetcher).length;
  button.click();
  await sleep(50);
  const resultsAt = fetchResults(fetcher).length;
  await sleep(1900);
  facts.E.after = fetchLines(fetcher).slice(before);
  facts.E.resultsAfter = fetchResults(fetcher).length - resultsAt;
  facts.E.slow = (await netSeen()).filter((record) => record.path === "/slow");
  const stored = localStorage.getItem(GRANT_PREFIX + E.record("fetcher").placement_key);
  facts.E.record = stored ? JSON.parse(stored) : null;
  panel.close();
  await E.end();
} catch (error) { note("ext-consent-withdraw", error); }

const mustFacts = (id, ...names) => { if (failures[id]) throw new Error(failures[id]); for (const name of names) assert(facts[name], "pass " + name + " did not run"); };
const rowOf = (seen, token) => seen && seen.rows.find((row) => row.token === token);

await run("ext-consent-prompt", async () => {
  mustFacts("ext-consent-prompt", "A", "B");
  const dialog = facts.A.seen && facts.A.seen.fetcher;
  assert(dialog, "no consent dialog was shown for the fetcher (" + JSON.stringify(Object.keys(facts.A.seen || {})) + ")");
  const row = rowOf(dialog, FETCH_TOKEN);
  const purpose = world5a.nodes.find((node) => node.label === "fetcher").webofworlds_extension.universal_extensions[0].purposes[FETCH_TOKEN];
  assert(row && row.tokenText === FETCH_TOKEN, "the fetcher's dialog does not list " + FETCH_TOKEN + ": " + JSON.stringify(dialog.rows));
  assert(row.purpose === purpose, "the fetcher's dialog shows the purpose " + JSON.stringify(row.purpose));
  assert((facts.A.fetchWhileOpen || []).includes("fetch -2"), "while the dialog was open the fetch returned " + JSON.stringify(facts.A.fetchWhileOpen));
  assert(facts.A.fetchAfterDeny.length > 0 && facts.A.fetchAfterDeny.every((line) => line === "fetch -2"), "after Deny the fetches returned " + JSON.stringify(facts.A.fetchAfterDeny));
  assert(facts.A.resultsAfterDeny === 0 && facts.A.netAfterDeny === 0, "after Deny " + facts.A.resultsAfterDeny + " fetch results arrived and the test server saw " + facts.A.netAfterDeny + " requests");
  assert(facts.B.seen && facts.B.seen.fetcher, "no consent dialog was shown for the fetcher in pass B");
  assert(facts.B.okResult && facts.B.okResult.status === 200 && facts.B.okResult.body === "slow", "after Allow the fetch did not succeed: " + JSON.stringify(facts.B.okResult) + " " + JSON.stringify(facts.B.fetchLines));
});

await run("ext-consent-text-safe", async () => {
  mustFacts("ext-consent-text-safe", "A");
  const dialog = facts.A.seen && facts.A.seen["storage-user"];
  assert(dialog, "no consent dialog was shown for the storage user");
  const declared = world5a.nodes.find((node) => node.label === "storage-user").webofworlds_extension.universal_extensions[0].purposes["ue.storage.local"];
  const row = rowOf(dialog, "ue.storage.local");
  assert(row && row.purpose === declared, "the purpose does not show as its text: " + JSON.stringify(row && row.purpose));
  assert(dialog.elements === 0, "the purpose made " + dialog.elements + " element(s) in the dialog");
  assert(facts.A.scriptRan === undefined, "the purpose's markup ran a script");
});

await run("ext-consent-remembered", async () => {
  mustFacts("ext-consent-remembered", "B", "C", "D");
  const record = facts.B.record ? JSON.parse(facts.B.record) : null;
  assert(record && record.tokens.includes(FETCH_TOKEN) && record.expiresAt - record.grantedAt === 30 * 24 * 3600 * 1000, "the remembered grant record is " + facts.B.record);
  assert(!(facts.C.seen && facts.C.seen.fetcher), "the reload showed the fetcher's dialog again");
  assert(facts.C.ok, "after the reload the fetch did not go through: " + JSON.stringify(facts.C.fetchLines));
  assert(facts.D.status === "mounted", "the fetcher with the changed module.integrity did not run: " + facts.D.status);
  assert(facts.D.seen && facts.D.seen.fetcher && rowOf(facts.D.seen.fetcher, FETCH_TOKEN), "a changed module.integrity did not show the dialog again");
});

await run("ext-consent-withdraw", async () => {
  mustFacts("ext-consent-withdraw", "E");
  assert(!(facts.E.seen && facts.E.seen.fetcher), "pass E showed the fetcher's dialog; its grant was not remembered");
  assert(facts.E.inFlight, "no request of the fetcher was in flight before Withdraw");
  assert(facts.E.panelRows.length === 3, "the Extensions panel lists " + facts.E.panelRows.length + " extensions");
  assert(facts.E.after.length > 0 && facts.E.after.every((line) => line === "fetch -2"), "after Withdraw the fetches returned " + JSON.stringify(facts.E.after) + "; Withdraw took effect only on reload");
  assert(facts.E.slow.some((record) => record.aborted), "Withdraw did not abort the request in flight: " + JSON.stringify(facts.E.slow));
  assert(facts.E.resultsAfter === 0, facts.E.resultsAfter + " fetch results reached the fetcher after Withdraw");
  assert(facts.E.record && typeof facts.E.record.withdrawnAt === "number", "the grant record has no withdrawnAt: " + JSON.stringify(facts.E.record));
});

await run("ext-pointer-events", async () => {
  mustFacts("ext-pointer-events", "A", "B");
  assert(facts.A.seen && facts.A.seen["pointer-listener"], "no consent dialog was shown for the pointer listener");
  assert(Array.isArray(facts.A.pointerWithoutGrant) && facts.A.pointerWithoutGrant.length === 0, "without ue.input.pointer the listener got pointer events: " + JSON.stringify(facts.A.pointerWithoutGrant));
  const clicks = (facts.B.pointer || []).filter((item) => item.event === "click");
  assert(clicks.length === 1, "the click on the listener's node reached it " + clicks.length + " time(s): " + JSON.stringify(facts.B.pointer));
  assert(clicks[0].attachment === facts.B.pointerAttachment && typeof clicks[0].node === "number" && Array.isArray(clicks[0].point) && clicks[0].point.length === 3, "the click event is " + JSON.stringify(clicks[0]));
  assert(facts.B.others.length === 0, "pointer events reached other extensions: " + JSON.stringify(facts.B.others));
});

drawing = false;
window.__ueMountResults = results;
console.log(DONE);
`;

// The carrier of manifest-extension-runs: box-maker.wasm anchored to node 1, signed with a key made for this run.
const BOX_CARRIER = carrierManifest({
  key: newCarrierKey(), subject: "urn:osl:check:world-node:carried-box",
  module: { url: "/fixtures/extension-host/world/box-maker.wasm", integrity: "sha256-J+MEtqq8G4EwEbY5a6uiiQeUFTAXd9T4aSX6AiMsHqk=", binding: "ue-core/0" },
  attach: { kind: "world-node", anchor: "1" },
  requests: [{ capability: "ue.console.log", purpose: "log what it draws" }, { capability: "ue.scene.nodes", purpose: "draw the box" }],
});

/** The static server (fixtures/extension-host/check-server.mjs), with this check's page. */
const startCheckServers = (netOrigin) => startServers({ port: PORT, netOrigin, pages: {
  [PAGE]: { type: ".html", body: PAGE_HTML },
  "/__ue-mount-check.mjs": { type: ".mjs", body: PAGE_SCRIPT },
  "/__ue-carrier/box-carrier.json": { type: ".json", body: JSON.stringify(BOX_CARRIER) },
} });

/** Runs the page once. Resolves { results: Map(id -> { id, ok, detail }), problem }, never rejects. */
async function runPage() {
  const results = new Map();
  const pageErrors = [];
  let servers = [], netServer = null, browser = null, problem = null;
  try {
    netServer = await startNetServer({ allowOrigin: `http://127.0.0.1:${PORT}` });
    servers = await startCheckServers(netServer.origin);
    const second = servers[1].address().port;
    const { default: puppeteer } = await import("puppeteer-core");
    browser = await puppeteer.launch({ executablePath: findBrowser(), headless: true, args: ["--no-first-run", "--no-default-browser-check"] });
    if (SHOT_DIR) mkdirSync(SHOT_DIR, { recursive: true });
    const page = await browser.newPage();
    await page.setViewport({ width: 1000, height: 700 });
    let done = false;
    let lastAt = Date.now();
    page.on("console", (message) => {
      const text = message.text();
      if (text.startsWith(RESULT_MARK)) {
        const result = JSON.parse(text.slice(RESULT_MARK.length));
        results.set(result.id, result);
        lastAt = Date.now();
      } else if (text === DONE_MARK) done = true;
      else if (text.startsWith("ue-mount-shot ")) {
        const name = text.slice("ue-mount-shot ".length).replace(/[^a-z0-9-]/g, "");
        lastAt = Date.now();
        page.screenshot({ path: join(SHOT_DIR, `ue-step5a-${name}.png`) })
          .catch((error) => pageErrors.push(`screenshot ${name}: ${oneLine(error)}`))
          .finally(() => page.evaluate(() => { window.__ueShotTaken = true; }).catch(() => {}));
      }
    });
    page.on("pageerror", (error) => pageErrors.push(oneLine(error)));
    const query = `second=${second}&net=${encodeURIComponent(netServer.origin)}${SHOT_DIR ? "&shots=1" : ""}`;
    const response = await page.goto(`http://127.0.0.1:${PORT}${PAGE}?${query}`, { waitUntil: "load", timeout: 30000 });
    if (!response || !response.ok()) throw new Error(`the page answered HTTP ${response && response.status()}`);
    const started = Date.now();
    while (!done && Date.now() - lastAt < STALL_MS && Date.now() - started < TOTAL_MS) await sleep(100);
    if (done) {
      const final = await Promise.race([page.evaluate(() => window.__ueMountResults || null), sleep(5000).then(() => null)]);
      if (Array.isArray(final)) for (const result of final) results.set(result.id, result);
    } else {
      problem = `the page did not finish: no case result for ${Math.round((Date.now() - lastAt) / 1000)} s`;
    }
  } catch (error) {
    problem = oneLine(error);
  } finally {
    await stopBrowser(browser);
    for (const server of servers) await stopServer(server);
    if (netServer) await netServer.close();
  }
  if (pageErrors.length) problem = `${problem ? `${problem}; ` : ""}page errors: ${pageErrors.slice(0, 3).join(" | ")}`;
  return { results, problem };
}

const CASES = [
  ["ext-mount-rp1", "An object ue-node:Stool exists under the rp1-stool node group with reference assets/Stool.glb"],
  ["ext-mount-ue-core", "An object ue-node:Box exists under the ue-box node group at the node's composed position"],
  ["ext-integrity-visible", "bad-hash starts no worker, and its marker is labeled integrity"],
  ["ext-cross-origin-refused", "The world loaded from a second origin refuses every extension at stage origin and fetches no module"],
  ["manifest-extension-runs", "A node that points to a valid signed carrier runs its extension, and ue-node:Box appears under the carrying node"],
  ["ext-consent-pending", "wants-panel runs and makes its box, ue.ui.panel is not granted, and the summary lists it as needing consent"],
  ["ext-transform-follows", "A node-set-transform from an extension moves its object"],
  ["ext-world-survives", "runaway is ended by the watchdog and shown as failed at init; the other nodes render and the page draws frames"],
  ["ext-unmount-clean", "After unmount() no extension worker is alive and no ue-node: object remains"],
  ["ext-consent-prompt", "The fetcher's dialog lists ue.network.fetch:<test origin> with its purpose; Deny leaves its fetch at -2, Allow lets it succeed"],
  ["ext-consent-text-safe", "A purpose holding <img src=x onerror=...> shows as text: no element is made and nothing runs"],
  ["ext-consent-remembered", "With Remember checked a reload grants without a dialog; a changed module.integrity shows the dialog again"],
  ["ext-consent-withdraw", "Withdraw in the Extensions panel makes the next fetch return -2, aborts the request in flight and writes withdrawnAt"],
  ["ext-pointer-events", "Clicking the pointer listener's node sends click to that extension only; without ue.input.pointer no event arrives"],
];

const { results, problem } = await runPage();
for (const [id, says] of CASES) {
  await check(id, says, () => {
    const result = results.get(id);
    if (!result) throw new Error(`the page reported no result${problem ? ` (${problem})` : ""}`);
    if (!result.ok) throw new Error(result.detail);
  });
}

const MOUNT = "web/wow-extension-mount.mjs";
const HOST = "runtime/extension-host/extension-host.mjs";
const CONSENT = "web/wow-extension-consent.mjs";
await finish({ checkFile: "src/wow-extension-mount-browser-check.mjs", faults: [
  { statement: "ext-mount-rp1", name: "skip the RP1 binding entry in the mount", expect: /no ue-node:Stool/,
    edits: [{ file: MOUNT, find: "  \"rp1-sneeze-call\": RP1_NODES,\n", replace: "" }] },
  { statement: "ext-mount-ue-core", name: "add nodes to the scene root instead of the carrying group", expect: /no ue-node:Box under the ue-box node group/,
    edits: [{ file: MOUNT, find: "    record.group.add(container);", replace: "    let top = record.group;\n    while (top.parent) top = top.parent;\n    top.add(container);" }] },
  { statement: "ext-integrity-visible", name: "skip the hash check", expect: /bad-hash/,
    edits: [{ file: HOST, find: "if (digest !== declaration.module.integrity)", replace: "if (false)" }] },
  { statement: "ext-cross-origin-refused", name: "drop the origin rule", expect: /refused at stage origin: 0 of 5/,
    edits: [{ file: MOUNT, find: "    if (worldOrigin !== pageOrigin) return refuse(record, \"origin\",", replace: "    if (false) return refuse(record, \"origin\"," }] },
  { statement: "manifest-extension-runs", name: "the mount ignores universal_extension_manifests", expect: /the carrier's extension did not run/,
    edits: [{ file: MOUNT, find: "const carrierRefs = (node) => (Array.isArray(node.manifest_refs) ? node.manifest_refs : []);", replace: "const carrierRefs = (node) => [];" }] },
  { statement: "ext-consent-pending", name: "grant every requested token", expect: /ue\.ui\.panel was granted/,
    edits: [{ file: MOUNT, find: "const grant = requested.filter((token) => granted.has(token));", replace: "const grant = requested;" }] },
  { statement: "ext-transform-follows", name: "ignore node updates", expect: /did not move/,
    edits: [{ file: MOUNT, find: "      else if (changed(object, node)) placeNode(object, node);", replace: "      else if (false) placeNode(object, node);" }] },
  { statement: "ext-world-survives", name: "let a failure throw out of the mount pass", expect: /the mount pass threw/,
    edits: [
      { file: MOUNT, find: "    if (!extension || !extension.ok) return failure(record, extension);", replace: "    if (!extension || !extension.ok) throw new Error(`${record.label}: ${extension && extension.error}`);" },
      { file: MOUNT, find: "  await Promise.all(records.map((record) => mountOne(record).catch((error) => fail(record, \"worker\", oneLine(error)))));",
        replace: "  await Promise.all(records.map((record) => mountOne(record)));" },
    ] },
  { statement: "ext-unmount-clean", name: "skip shutdown() in unmount()", expect: /still alive after unmount/,
    edits: [{ file: MOUNT, find: "      try { await record.extension.shutdown(); } catch {}", replace: "" }] },
  { statement: "ext-consent-prompt", name: "auto-allow every prompted token", expect: /no consent dialog was shown for the fetcher/,
    edits: [{ file: MOUNT, find: "    const answer = await consent.ask({", replace: "    const answer = { allowed: asked, remember: false } || await consent.ask({" }] },
  { statement: "ext-consent-text-safe", name: "insert the purpose with innerHTML", expect: /does not show as its text/,
    edits: [{ file: CONSENT, find: "        el(doc, \"span\", { style: purpose ? \"\" : STYLE.dim, text: purpose || \"No purpose given.\", attrs: { class: \"ue-consent-purpose\" } }),",
      replace: "        (() => { const span = el(doc, \"span\", { attrs: { class: \"ue-consent-purpose\" } }); span.innerHTML = purpose; return span; })()," }] },
  { statement: "ext-consent-remembered", name: "key grants without the module hash", expect: /did not show the dialog again/,
    edits: [{ file: MOUNT, find: "integrity: effective.module.integrity, attach: effective.attach });", replace: "integrity: \"\", attach: effective.attach });" }] },
  { statement: "ext-consent-withdraw", name: "withdraw only on reload", expect: /Withdraw took effect only on reload/,
    edits: [{ file: MOUNT, find: "    void applyGrant(record, [...record.host_grant]);\n", replace: "" }] },
  { statement: "ext-pointer-events", name: "send pointer events without the grant", expect: /without ue\.input\.pointer the listener got pointer events/,
    edits: [{ file: MOUNT, find: "    if (!record.grant.includes(POINTER_TOKEN)) return false;\n", replace: "" }] },
] });
