#!/usr/bin/env node
/**
 * GLB-only lazy avatar selector proof.
 *
 * Drives the REAL web/avatar-selector-controller.mjs against a fake DOM and a fake preview
 * layer that models the production AvatarEquipmentLayer's asset seam honestly: an async
 * `switchAvatarVariant(key)` that loads ONE model, disposes the previously loaded one on adopt,
 * and (in manual mode) resolves only when the test says so. That fidelity is what lets these
 * checks distinguish a lazy, single-flight, stale-safe, bounded selector from a broken one.
 *
 * Positive checks assert the contract. The RED battery then re-imports the controller source
 * with one guard sabotaged per case and asserts the SAME oracle goes red — an oracle that
 * cannot go red is not proving anything (the OSL "evidence that lies about itself" lesson).
 *
 *   node src/lazy-avatar-selector-check.mjs
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { NO_EQUIPMENT_CHOICE, applyNoEquipmentChoice } from "../web/no-equipment-choice.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const CONTROLLER_PATH = path.join(ROOT, "web", "avatar-selector-controller.mjs");
const EVIDENCE_DIR = path.join(ROOT, ".dev", "ai", "diagnostics", "2026-07-17-04-16-59Z-runtime");
const controllerSource = fs.readFileSync(CONTROLLER_PATH, "utf8");
const { createAvatarSelectorController } = await import(pathToFileURL(CONTROLLER_PATH));

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/* ---------------------------------------------------------------- fake DOM */

class FakeEventTarget {
  constructor() {
    this.listeners = new Map();
  }
  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(handler);
  }
  removeEventListener(type, handler) {
    this.listeners.get(type)?.delete(handler);
  }
  dispatchEvent(event) {
    event.target ??= this;
    for (const handler of [...(this.listeners.get(event.type) || [])]) handler(event);
  }
  totalListeners() {
    return [...this.listeners.values()].reduce((total, handlers) => total + handlers.size, 0);
  }
}

class FakeElement extends FakeEventTarget {
  constructor(documentTarget, tagName = "div") {
    super();
    this.ownerDocument = documentTarget;
    this.tagName = tagName.toUpperCase();
    this.dataset = {};
    this.attributes = new Map();
    this.style = {};
    this.hidden = false;
    this.children = [];
    this.className = "";
    this.textContent = "";
    this.title = "";
    this._innerHTML = "";
  }
  set innerHTML(value) {
    this._innerHTML = String(value);
    this.children = [];
  }
  get innerHTML() {
    return this._innerHTML;
  }
  get classList() {
    return { toggle: () => {} };
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }
  removeAttribute(name) {
    this.attributes.delete(name);
  }
  appendChild(child) {
    this.children.push(child);
    return child;
  }
  querySelectorAll() {
    return [];
  }
  focus() {
    this.ownerDocument.activeElement = this;
  }
  setPointerCapture() {}
  closest() {
    return null;
  }
}

class FakeDocument extends FakeEventTarget {
  constructor() {
    super();
    this.body = new FakeElement(this, "body");
    this.activeElement = this.body;
  }
  createElement(tagName) {
    return new FakeElement(this, tagName);
  }
  querySelectorAll() {
    return [];
  }
}

/* ------------------------------------------------------- fake equipment seam */

const item = (itemId, attachmentPoint, mode) => ({
  itemId,
  attachmentPoint,
  mode,
  assetUri: `http://example.test/${itemId}.glb`,
  localTransform: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
  label: itemId,
});
const slots = () => [
  { slot: "head", label: "Head", options: [item("hat", "head", "worn")] },
  { slot: "rightHand", label: "Right hand", options: [item("hammer", "rightHand", "held")] },
];
const extras = () => [item("belt", "hips", "worn")];
const valid = (items) => {
  if (!Array.isArray(items)) return { ok: false, errors: ["not array"] };
  return { ok: true, errors: [] };
};

/* ------------------------------------------------------------- fake variants */
// The production roster shape: several GLB characters (selector-visible) plus VRM and the
// generated parametric avatar (both hidden from the selector, preserved at runtime).
// Post-: the two "VRChat/Game" GLBs (rpm-female-vrchat, rpm-male-vrchat)
// were removed, so the selector-visible GLB roster is these five (Joe/Jane/Rose/Helium/Nea).
const GLB_KEYS = [
  "readyplayerme-cyberpunk",
  "cyberpunk-female-full-body",
  "rpm-female-cyberpunk",
  "rpm-female-ninja",
  "rpm-female-character",
];
const VRM_KEYS = ["cute-moth", "bad-bot"];
const PARAM_KEYS = ["parametric"];
const DEFAULT_VARIANT = "readyplayerme-cyberpunk";

function makeVariants() {
  const variants = {};
  for (const key of GLB_KEYS) {
    variants[key] = { key, label: key, type: "glb", load_mode: "gltf-humanoid-facade", mocap_retarget: "supported", equipment_attachment: "glb-humanoid-normalized-bones", structured_unsupported: [] };
  }
  for (const key of VRM_KEYS) {
    variants[key] = { key, label: key, type: "vrm", load_mode: "vrm-humanoid", mocap_retarget: "supported", equipment_attachment: "vrm-normalized-bones", structured_unsupported: [] };
  }
  for (const key of PARAM_KEYS) {
    variants[key] = { key, label: key, type: "parametric", load_mode: "parametric-generated", mocap_retarget: "supported", equipment_attachment: "parametric-normalized-bones", structured_unsupported: [] };
  }
  return variants;
}

/* --------------------------------------------------------- fake preview layer */
// Models the AvatarEquipmentLayer asset seam: a freshly-built layer has already loaded its own
// default avatar; switchAvatarVariant loads exactly one model, disposes the previous one on
// adopt (so retained === 1), and returns {unchanged} for a no-op. In manual mode the load stays
// pending until the test calls resolveNext(), letting us reproduce rapid stepping and stale
// completions deterministically.
function makeEnvironment(factory = createAvatarSelectorController, opts = {}) {
  const manual = !!opts.manual;
  const brokenKeys = new Set(opts.brokenKeys || []);
  const documentTarget = new FakeDocument();
  const elements = new Map();
  const element = (id, tag = "div") => {
    if (!elements.has(id)) elements.set(id, new FakeElement(documentTarget, tag));
    return elements.get(id);
  };
  for (const id of [
    "avatar-selector-modal", "avatar-selector-status", "avatar-runtime-status",
    "avatar-selector-support", "avatar-selector-avatar-list", "avatar-selector-equipment-groups",
    "avatar-selector-extra-items", "avatar-selector-preview-mount", "avatar-selector-preview",
    "avatar-selector-avatar-type", "btn-avatar-selector-prev", "btn-avatar-selector-next",
    "btn-avatar-selector-close", "btn-avatar-selector-cancel", "btn-avatar-selector-apply",
    "btn-switch-avatar", "btn-equip-item", "inventory-card",
  ]) element(id, id.startsWith("btn-") ? "button" : "div");
  element("avatar-selector-modal").hidden = true;

  const previewLayers = [];
  const createPreviewLayer = () => {
    const layer = {
      ready: Promise.resolve(),
      loadedVariant: DEFAULT_VARIANT, // the layer boots showing its own default
      loadLog: [], // every asset load actually issued (network requests)
      committed: [], // avatars handed to setAvatar (the preview UI actually shows these)
      retainedModels: 1, // exactly one model retained at a time
      disposedModels: 0,
      disposed: false,
      pending: [],
      camera: { position: { set() {} }, lookAt() {}, updateProjectionMatrix() {} },
      setAvatar(avatar) {
        this.committed.push(avatar);
      },
      resize() {},
      debugState() {
        return {
          avatar_variant: this.loadedVariant,
          current_animation_state: "idle",
          attached_item_count: 0,
          expected_item_count: 0,
        };
      },
      _adopt(key) {
        // Adopt-then-dispose: the previous model is released, one model retained.
        this.disposedModels += 1;
        this.loadedVariant = key;
        this.retainedModels = 1;
      },
      switchAvatarVariant(key) {
        if (key === this.loadedVariant) return Promise.resolve({ ok: true, unchanged: true, variant: key });
        this.loadLog.push(key);
        if (manual) {
          return new Promise((resolve) => {
            this.pending.push(() => {
              if (brokenKeys.has(key)) return resolve({ ok: false, error: `asset ${key} failed` });
              this._adopt(key);
              return resolve({ ok: true, variant: key });
            });
          });
        }
        if (brokenKeys.has(key)) return Promise.resolve({ ok: false, error: `asset ${key} failed` });
        this._adopt(key);
        return Promise.resolve({ ok: true, variant: key });
      },
      resolveNext() {
        const next = this.pending.shift();
        if (next) next();
        return !!next;
      },
      dispose() {
        this.disposed = true;
        this.disposedModels += this.retainedModels;
        this.retainedModels = 0;
      },
    };
    previewLayers.push(layer);
    return layer;
  };

  const avatar = {
    avatar_variant: DEFAULT_VARIANT,
    rotation_y: 0,
    equippedItems: [item("hat", "head", "worn"), item("hammer", "rightHand", "held")],
  };
  const calls = { apply: 0, variants: [] };
  const runtime = {
    avatar,
    world: { location_id: "location-a" },
    setAvatarVariant(variant) {
      calls.variants.push(variant);
      avatar.avatar_variant = variant;
      return { ok: true, variant };
    },
    setPreferredHeight(height) {
      return { ok: true, preferred_height_m: height };
    },
    async applyEquipment(items) {
      calls.apply += 1;
      avatar.equippedItems = items;
      return { ok: true };
    },
  };

  const debugText = new Map();
  const variants = makeVariants();
  let rafSeq = 0;
  const rafs = new Map();
  const controller = factory({
    isPlayer: true,
    role: "player",
    variants,
    inventorySlots: slots,
    equipmentCatalog: extras,
    validateEquippedItems: valid,
    resolveEquipmentItems: async (items) => ({ items: items.map((entry) => entry.itemId) }),
    noEquipmentChoice: NO_EQUIPMENT_CHOICE,
    applyNoEquipmentChoice,
    createPreviewLayer,
    getRuntime: () => runtime,
    lookup: (id) => elements.get(id) || null,
    documentTarget,
    requestFrame: (callback) => {
      rafSeq += 1;
      rafs.set(rafSeq, callback);
      return rafSeq;
    },
    cancelFrame: (handle) => rafs.delete(handle),
    logger: () => {},
    escapeHtml: (value) => String(value),
    writeDebugText: (id, text) => debugText.set(id, text),
    fixed3: (value) => Number(value).toFixed(3),
    yawQuaternion: (yaw) => [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)],
    isTypingTarget: (target) => ["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName),
  });

  const enumerableKeys = GLB_KEYS.slice();
  const totalRetained = () =>
    previewLayers.filter((layer) => !layer.disposed).reduce((sum, layer) => sum + layer.retainedModels, 0);
  const chipKeys = () => (elements.get("avatar-selector-avatar-list").children || []).map((child) => child.dataset.avatarVariant);
  const runPreviewFrame = (now = 16) => {
    const callback = [...rafs.values()].at(-1);
    if (callback) callback(now);
  };
  return { avatar, calls, controller, documentTarget, elements, debugText, previewLayers, enumerableKeys, totalRetained, chipKeys, runPreviewFrame };
}

/* -------------------------------------------------------------- positive run */

const checks = [];
async function check(label, callback) {
  await callback();
  checks.push(label);
  console.log(`PASS ${String(checks.length).padStart(2, "0")} ${label}`);
}

await check("boot is lazy: constructing and mounting fetches nothing and builds no preview layer", () => {
  const env = makeEnvironment();
  env.controller.mount();
  assert.equal(env.previewLayers.length, 0);
});

await check("opening loads only the current candidate (the pre-loaded default), never the roster", async () => {
  const env = makeEnvironment();
  env.controller.mount();
  await env.controller.open();
  assert.equal(env.previewLayers.length, 1);
  // Baseline is the default the layer already booted with, so opening issues zero extra loads.
  assert.deepEqual(env.previewLayers[0].loadLog, []);
  assert.equal(env.controller.debug().preview_shown_variant, DEFAULT_VARIANT);
});

await check("selector enumerates GLB choices only; VRM and parametric are hidden, not deleted", async () => {
  const env = makeEnvironment();
  env.controller.mount();
  await env.controller.open();
  const chips = env.chipKeys();
  assert.deepEqual(chips, GLB_KEYS, "chip list must be exactly the GLB roster in order");
  for (const hidden of [...VRM_KEYS, ...PARAM_KEYS]) {
    assert.equal(chips.includes(hidden), false, `${hidden} must not appear as a selector chip`);
  }
  const debug = env.controller.debug();
  assert.deepEqual(debug.selectable_variant_keys, GLB_KEYS);
  assert.equal(debug.hidden_variant_count, VRM_KEYS.length + PARAM_KEYS.length);
});

await check("a hidden VRM is still pickable via the direct path (hidden, not deleted)", async () => {
  const env = makeEnvironment();
  env.controller.mount();
  await env.controller.open();
  env.controller.pickAvatar("cute-moth"); // direct/programmatic pick of a hidden variant
  assert.equal(env.controller.debug().pending_variant, "cute-moth");
});

await check("a live avatar variant no longer in the roster (a removed id) fails safe: the selector stages a valid enumerable GLB, never the missing id", async () => {
  // deleted rpm-female-vrchat / rpm-male-vrchat. A saved session or a
  // still-live avatar that referenced one of them now points at an id absent from the table;
  // opening the selector must fall back to a valid enumerable GLB rather than stage the ghost.
  // This is a real oracle: if currentVariantKey() or defaultPendingVariant() dropped their
  // `variants[key]` guard, the missing id would leak straight through and these assertions fail.
  const env = makeEnvironment();
  env.controller.mount();
  env.avatar.avatar_variant = "rpm-female-vrchat"; // an id that was a GLB but has since been removed
  await env.controller.open();
  const debug = env.controller.debug();
  assert.equal(debug.baseline_variant, DEFAULT_VARIANT, "an unknown live variant resolves the baseline to a valid key, never the missing id");
  assert.equal(env.enumerableKeys.includes(debug.pending_variant), true, "the staged pending variant must be a valid enumerable GLB");
  assert.notEqual(debug.pending_variant, "rpm-female-vrchat", "the removed id must never be staged");
});

await check("each navigation loads exactly one candidate", async () => {
  const env = makeEnvironment();
  env.controller.mount();
  await env.controller.open();
  env.controller.pickAvatar("rpm-female-ninja");
  await flush();
  assert.deepEqual(env.previewLayers[0].loadLog, ["rpm-female-ninja"]);
  env.controller.pickAvatar("rpm-female-character");
  await flush();
  assert.deepEqual(env.previewLayers[0].loadLog, ["rpm-female-ninja", "rpm-female-character"]);
});

await check("rapid next across the whole GLB roster collapses to first+last; intermediates never load; stale is non-committing", async () => {
  const env = makeEnvironment(createAvatarSelectorController, { manual: true });
  env.controller.mount();
  await env.controller.open();
  const layer = env.previewLayers[0];
  const seq = GLB_KEYS.filter((k) => k !== DEFAULT_VARIANT); // every non-default GLB choice, in order
  assert.ok(seq.length >= 3, `need >=3 non-default GLB choices to prove the collapse skips intermediates, saw ${seq.length}`);
  const last = seq.at(-1);
  for (const key of seq) env.controller.pickAvatar(key); // rapid, synchronous
  // Single-flight: only the first selection is actually in flight; the rest are gated.
  assert.deepEqual(layer.loadLog, [seq[0]]);
  layer.resolveNext(); // the in-flight first resolves — but the selection has moved to the last
  await flush();
  // It collapses straight to the newest desired, skipping every intermediate entirely.
  assert.deepEqual(layer.loadLog, [seq[0], last]);
  layer.resolveNext();
  await flush();
  assert.equal(env.controller.debug().preview_shown_variant, last);
  // The superseded selections (every one but the last) never became the shown preview. Only the
  // default (from open) and the final choice were ever committed.
  const committedVariants = layer.committed.map((a) => a && a.avatar_variant);
  for (const stale of seq.slice(0, -1)) {
    assert.equal(committedVariants.includes(stale), false, `${stale} must never be committed to the preview`);
  }
  assert.equal(committedVariants.includes(last), true);
  // Bounded even through the stale load: the layer never retained more than one model.
  assert.equal(layer.retainedModels, 1);
  assert.equal(env.totalRetained(), 1);
});

await check("bounded cache: one preview layer is reused across close/reopen and retains one model", async () => {
  const env = makeEnvironment();
  env.controller.mount();
  await env.controller.open();
  env.controller.pickAvatar("rpm-female-ninja");
  await flush();
  env.controller.cancel();
  await env.controller.open();
  env.controller.pickAvatar("rpm-female-character");
  await flush();
  assert.equal(env.previewLayers.length, 1, "the preview layer must be reused, not rebuilt");
  assert.equal(env.totalRetained(), 1, "at most one avatar model retained across open/close/reopen");
});

await check("apply commits exactly the selected GLB once through a single owner", async () => {
  const env = makeEnvironment();
  env.controller.mount();
  await env.controller.open();
  env.controller.pickAvatar("rpm-female-ninja");
  await flush();
  const result = await env.controller.apply();
  assert.equal(result.ok, true);
  assert.equal(env.avatar.avatar_variant, "rpm-female-ninja");
  assert.deepEqual(env.calls.variants, ["rpm-female-ninja"], "exactly one avatar-switch owner, one commit");
});

await check("cancel leaves the live avatar and equipment unchanged", async () => {
  const env = makeEnvironment();
  env.controller.mount();
  const baselineVariant = env.avatar.avatar_variant;
  const baselineItems = JSON.stringify(env.avatar.equippedItems);
  await env.controller.open();
  env.controller.pickAvatar("rpm-female-character");
  env.controller.removeAllEquipment();
  await flush();
  env.controller.cancel();
  assert.equal(env.avatar.avatar_variant, baselineVariant);
  assert.equal(JSON.stringify(env.avatar.equippedItems), baselineItems);
  assert.deepEqual(env.calls.variants, [], "cancel must not commit any avatar switch");
});

await check("the preview render loop mirrors the layer's live variant (no switch bounce mid-load)", async () => {
  const env = makeEnvironment(createAvatarSelectorController, { manual: true });
  env.controller.mount();
  await env.controller.open(); // startPreviewLoop scheduled a preview frame
  const layer = env.previewLayers[0];
  env.controller.pickAvatar("rpm-female-ninja"); // starts an in-flight load
  // Simulate the layer's switch reaching its post-adopt tail: the model is already the new one
  // while the controller has not yet committed previewShownVariant. A render tick now must show
  // what the layer actually has — otherwise, on the real layer, setAvatar would re-trigger a
  // switch and bounce the preview.
  layer.loadedVariant = "rpm-female-ninja";
  const loadsBefore = layer.loadLog.length;
  env.runPreviewFrame(32);
  assert.equal(layer.committed.at(-1).avatar_variant, "rpm-female-ninja", "render must mirror the live variant");
  assert.equal(layer.loadLog.length, loadsBefore, "a render tick must not issue another load");
});

await check("failed asset shows an accessible error and leaves the active avatar valid", async () => {
  const env = makeEnvironment(createAvatarSelectorController, { brokenKeys: ["rpm-female-ninja"] });
  env.controller.mount();
  await env.controller.open();
  env.controller.pickAvatar("rpm-female-ninja");
  await flush();
  const debug = env.controller.debug();
  assert.ok(debug.preview_load_error, "a failed preview load must record an error");
  assert.equal(debug.preview_load_error.variant, "rpm-female-ninja");
  assert.equal(debug.preview_shown_variant, DEFAULT_VARIANT, "the last good preview stays on screen");
  assert.equal(env.avatar.avatar_variant, DEFAULT_VARIANT, "the live avatar is untouched by a failed preview");
  const status = env.elements.get("avatar-selector-status");
  assert.match(status.textContent, /failed to load/i);
  assert.equal(env.elements.get("avatar-selector-preview").getAttribute("aria-busy"), "false");
});

/* ------------------------------------------------------------------ RED battery */

async function mutatedFactory(label, originalText, replacementText) {
  assert.ok(controllerSource.includes(originalText), `${label} mutation anchor missing: ${originalText}`);
  const mutated = controllerSource.replace(originalText, replacementText);
  const url = `data:text/javascript;base64,${Buffer.from(mutated).toString("base64")}#${label}`;
  return (await import(url)).createAvatarSelectorController;
}

const mutations = [
  [
    // eager-fetch-all: remove the single-flight gate → every rapid selection loads concurrently
    // (a full-catalog waterfall) instead of collapsing to first+last.
    "eager-fetch-all",
    "if (state.previewLoading) return; // a load is already running; it re-pumps to the newest desired",
    "if (false && state.previewLoading) return;",
    async (factory) => {
      const env = makeEnvironment(factory, { manual: true });
      env.controller.mount();
      await env.controller.open();
      const seq = GLB_KEYS.filter((k) => k !== DEFAULT_VARIANT);
      for (const key of seq) env.controller.pickAvatar(key);
      await flush();
      assert.ok(env.previewLayers[0].loadLog.length <= 2, `expected collapse, saw ${env.previewLayers[0].loadLog.length} loads`);
    },
  ],
  [
    // hidden-VRM filter fail: drop the type==='glb' predicate → VRM/parametric leak into the
    // enumerated selector chips.
    "hidden-vrm-filter",
    'variants[key] && variants[key].type === "glb"',
    "variants[key]",
    async (factory) => {
      const env = makeEnvironment(factory);
      env.controller.mount();
      await env.controller.open();
      const chips = env.chipKeys();
      for (const hidden of [...VRM_KEYS, ...PARAM_KEYS]) {
        assert.equal(chips.includes(hidden), false, `${hidden} leaked into the selector`);
      }
    },
  ],
  [
    // stale-async-commit: bypass the supersede token → a superseded in-flight load commits its
    // stale variant to the preview.
    "stale-async-commit",
    "if (token !== state.previewLoadToken) continue; // superseded — NON-COMMITTING; load the newest",
    "if (false) continue;",
    async (factory) => {
      const env = makeEnvironment(factory, { manual: true });
      env.controller.mount();
      await env.controller.open();
      const layer = env.previewLayers[0];
      const seq = GLB_KEYS.filter((k) => k !== DEFAULT_VARIANT).slice(0, 6);
      for (const key of seq) env.controller.pickAvatar(key);
      layer.resolveNext(); // stale first selection resolves
      await flush();
      layer.resolveNext(); // final selection resolves
      await flush();
      const committed = layer.committed.map((a) => a && a.avatar_variant);
      assert.equal(committed.includes(seq[0]), false, "the superseded selection must never be committed");
    },
  ],
  [
    // unbounded-cache: rebuild the preview layer on every open → orphaned layers/models pile up
    // across close/reopen instead of one reused layer.
    "unbounded-cache",
    "if (!state.previewLayer) {",
    "if (true) {",
    async (factory) => {
      const env = makeEnvironment(factory);
      env.controller.mount();
      await env.controller.open();
      env.controller.cancel();
      await env.controller.open();
      assert.equal(env.previewLayers.length, 1, `expected one reused layer, saw ${env.previewLayers.length}`);
      assert.equal(env.totalRetained(), 1);
    },
  ],
  [
    // apply-commits-selected: apply the baseline instead of the staged selection → Apply stops
    // committing the avatar the user actually chose.
    "apply-commits-selected",
    "const variant = state.pendingVariant;",
    "const variant = state.baselineVariant;",
    async (factory) => {
      const env = makeEnvironment(factory);
      env.controller.mount();
      await env.controller.open();
      env.controller.pickAvatar("rpm-female-ninja");
      await flush();
      await env.controller.apply();
      assert.equal(env.avatar.avatar_variant, "rpm-female-ninja");
    },
  ],
  [
    // render-mirrors-live-variant: blind the render loop to the layer's live variant → a render
    // tick during a load renders the stale committed variant, which on the real layer re-triggers
    // a switch and bounces the preview.
    "render-mirrors-live-variant",
    "const live = previewLayerLiveVariant();",
    "const live = null;",
    async (factory) => {
      const env = makeEnvironment(factory, { manual: true });
      env.controller.mount();
      await env.controller.open();
      const layer = env.previewLayers[0];
      env.controller.pickAvatar("rpm-female-ninja");
      layer.loadedVariant = "rpm-female-ninja";
      env.runPreviewFrame(32);
      assert.equal(layer.committed.at(-1).avatar_variant, "rpm-female-ninja");
    },
  ],
  [
    // duplicate-selector-owner: commit the avatar switch twice → two owners drive the one switch.
    "duplicate-selector-owner",
    "avatarResult = host.setAvatarVariant(variant);",
    "avatarResult = host.setAvatarVariant(variant); host.setAvatarVariant(variant);",
    async (factory) => {
      const env = makeEnvironment(factory);
      env.controller.mount();
      await env.controller.open();
      env.controller.pickAvatar("rpm-female-ninja");
      await flush();
      await env.controller.apply();
      assert.deepEqual(env.calls.variants, ["rpm-female-ninja"], "exactly one commit per apply");
    },
  ],
];

let mutationsCaught = 0;
const mutationLabels = [];
for (const [label, originalText, replacementText, contract] of mutations) {
  const factory = await mutatedFactory(label, originalText, replacementText);
  try {
    await contract(factory);
    throw new Error(`${label} mutation stayed GREEN`);
  } catch (error) {
    if (error.message === `${label} mutation stayed GREEN`) throw error;
    mutationsCaught += 1;
    mutationLabels.push(label);
    console.log(`RED_CAUGHT ${label}`);
  }
}

await check("every lazy-load, hidden-VRM, staleness, cache and apply/owner mutation turns RED", () => {
  assert.equal(mutationsCaught, mutations.length);
});

fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
fs.writeFileSync(
  path.join(EVIDENCE_DIR, "runtime-lazy-selector-check.json"),
  JSON.stringify(
    {
      generated_at: new Date().toISOString(),
      controller: path.relative(ROOT, CONTROLLER_PATH),
      glb_selector_choices: GLB_KEYS,
      hidden_from_selector: [...VRM_KEYS, ...PARAM_KEYS],
      default_variant: DEFAULT_VARIANT,
      positive_checks: checks,
      red_mutations_caught: mutationLabels,
      result: "ALL CHECKS PASS",
    },
    null,
    2
  )
);

console.log(`feature_LAZY_AVATAR_SELECTOR PASS ${checks.length}/${checks.length} mutations=${mutationsCaught}/${mutations.length}`);
