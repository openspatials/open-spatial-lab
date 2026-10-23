#!/usr/bin/env node
/**
 * randomized-starting-avatar proof.
 *
 * Owner ask: "when you start a new user session ... randomly pick one every time you start"
 * instead of always booting DEFAULT_AVATAR_VARIANT. Requirements: (1) a genuinely new session
 * lands on a random pick from the selector's VISIBLE (GLB) set; (2) a returning session that
 * already has a pick — explicitly chosen, or assigned by an earlier random roll THIS SAME
 * session — keeps it, never re-rolled; (3) boot still commits AT MOST ONE avatar-variant
 * change (no eager roster fetch); (4) a saved pick that has since been removed
 * from the catalog (e.g. rpm-female-vrchat / rpm-male-vrchat deletion) must re-roll
 * safely instead of recalling a dead id — the same fail-safe proved in
 * src/lazy-avatar-selector-check.mjs.
 *
 * This drives the REAL web/avatar-selector-controller.mjs (createAvatarSelectorController)
 * against a fake DOM and a fake runtime that models live-adapter.js's actual seam:
 * setAvatarVariant(key) mutates avatar.avatar_variant and is the ONLY thing that counts as an
 * "avatar switch" commit (exactly mirroring the production seam — see
 * web/live-adapter.js#setAvatarVariant and the AvatarEquipmentLayer#setAvatar reconciliation
 * it drives). A FakeStorage class stands in for sessionStorage so "session" boundaries are
 * simulated by handing out a fresh instance (new tab) or reusing one across two controller
 * constructions (reload, same tab).
 *
 * The RED battery then re-imports the controller source with one guard sabotaged per case and
 * asserts the SAME oracle goes red — an oracle that cannot go red is not proving anything (the
 * OSL "evidence that lies about itself" lesson).
 *
 *   node src/randomize-starting-avatar-check.mjs
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { NO_EQUIPMENT_CHOICE, applyNoEquipmentChoice } from "../web/no-equipment-choice.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const CONTROLLER_PATH = path.join(ROOT, "web", "avatar-selector-controller.mjs");
const EVIDENCE_DIR = path.join(ROOT, ".dev", "ai", "diagnostics", "2026-07-17-17-07-29Z-runtime");
const controllerSource = fs.readFileSync(CONTROLLER_PATH, "utf8");
const { createAvatarSelectorController, AVATAR_STARTING_VARIANT_STORAGE_KEY } = await import(pathToFileURL(CONTROLLER_PATH));

/* ---------------------------------------------------------------- fake DOM */
// The same minimal fake DOM shape / each already carry (this project duplicates
// small test fixtures per-check rather than sharing a test-only module across changes).

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

/* --------------------------------------------------------- fake sessionStorage */

class FakeStorage {
  constructor(seed = {}) {
    this.map = new Map(Object.entries(seed));
  }
  getItem(key) {
    return this.map.has(key) ? this.map.get(key) : null;
  }
  setItem(key, value) {
    this.map.set(key, String(value));
  }
  removeItem(key) {
    this.map.delete(key);
  }
}

/* ------------------------------------------------------------- fake variants */
// The production roster shape (post-): 5 GLB characters (selector-visible, the random
// pool) plus VRM and the generated parametric avatar (hidden from the selector, still directly
// pickable). removed the two "VRChat/Game" GLBs (rpm-female-vrchat,
// rpm-male-vrchat) from the real catalog — they were authored in centimetre units and loaded at
// the wrong scale. The removed-id fail-safe (a stale saved pick re-rolls instead of breaking) is
// proven below without reintroducing either id to this fixture's roster.
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

/* ------------------------------------------------------------- fake equipment seam */

const item = (itemId, attachmentPoint, mode) => ({
  itemId,
  attachmentPoint,
  mode,
  assetUri: `http://example.test/${itemId}.glb`,
  localTransform: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
  label: itemId,
});
const valid = (items) => (Array.isArray(items) ? { ok: true, errors: [] } : { ok: false, errors: ["not array"] });

/* ------------------------------------------------------------------ environment */
// Models ONLY the seam this feature actually drives: runtime.setAvatarVariant (the SAME method
// apply() commits through — see web/live-adapter.js#setAvatarVariant). No preview-layer/asset
// fake is needed here since mount's new
// correction never touches the preview layer at all.
function makeEnvironment(options = {}, factory = createAvatarSelectorController) {
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

  const avatar = {
    avatar_variant: options.initialVariant || DEFAULT_VARIANT,
    rotation_y: 0,
    equippedItems: [],
  };
  const calls = { apply: 0, variants: [] };
  const logs = [];
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
  const storage = "storage" in options ? options.storage : new FakeStorage();
  const controller = factory({
    isPlayer: options.isPlayer !== false,
    role: "player",
    variants,
    inventorySlots: () => [],
    equipmentCatalog: () => [],
    validateEquippedItems: valid,
    resolveEquipmentItems: async (items) => ({ items: items.map((entry) => entry.itemId) }),
    noEquipmentChoice: NO_EQUIPMENT_CHOICE,
    applyNoEquipmentChoice,
    createPreviewLayer: () => ({
      ready: Promise.resolve(),
      camera: { position: { set() {} }, lookAt() {}, updateProjectionMatrix() {} },
      setAvatar() {},
      resize() {},
      debugState: () => ({ avatar_variant: DEFAULT_VARIANT, current_animation_state: "idle", attached_item_count: 0, expected_item_count: 0 }),
      dispose() {},
    }),
    getRuntime: () => runtime,
    lookup: (id) => elements.get(id) || null,
    documentTarget,
    requestFrame: (callback) => {
      rafSeq += 1;
      rafs.set(rafSeq, callback);
      return rafSeq;
    },
    cancelFrame: (handle) => rafs.delete(handle),
    logger: (message) => logs.push(message),
    escapeHtml: (value) => String(value),
    writeDebugText: (id, text) => debugText.set(id, text),
    fixed3: (value) => Number(value).toFixed(3),
    yawQuaternion: (yaw) => [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)],
    isTypingTarget: (target) => ["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName),
    getSessionStorage: () => storage,
    randomFn: options.randomFn || Math.random,
    getLocationSearch: () => options.locationSearch || "",
  });
  return { avatar, calls, logs, controller, storage, variants };
}

/* -------------------------------------------------------------- positive run */

const checks = [];
async function check(label, callback) {
  await callback();
  checks.push(label);
  console.log(`PASS ${String(checks.length).padStart(2, "0")} ${label}`);
}

// A deterministic index sweep — feeds randomFn() outputs that map to 0, 1, 2, ... GLB_KEYS.length-1
// in turn, so the whole GLB roster is exercised WITHOUT relying on statistical luck. This catches
// an off-by-one in the `Math.floor(randomFn() * keys.length)` index math, not just "some
// variety happened".
function sweepRandomFn(count = GLB_KEYS.length) {
  let i = 0;
  return () => {
    const value = i / count;
    i += 1;
    return value;
  };
}

await check("a deterministic sweep across the whole GLB roster lands on every distinct GLB key exactly once, in order, on a fresh session", () => {
  const seen = [];
  for (let i = 0; i < GLB_KEYS.length; i += 1) {
    const sweep = sweepRandomFn(GLB_KEYS.length);
    for (let j = 0; j < i; j += 1) sweep(); // advance to the i-th slot deterministically
    const env = makeEnvironment({ randomFn: sweep });
    env.controller.mount();
    seen.push(env.avatar.avatar_variant);
  }
  assert.deepEqual(seen, GLB_KEYS, "each sweep index must resolve to the matching GLB roster entry");
});

await check("200 simulated fresh sessions land only inside the selector's visible (GLB) set, and touch more than one variant", () => {
  const distinct = new Set();
  for (let i = 0; i < 200; i += 1) {
    const env = makeEnvironment(); // real Math.random, a brand-new FakeStorage each trial
    env.controller.mount();
    distinct.add(env.avatar.avatar_variant);
  }
  for (const value of distinct) {
    assert.ok(GLB_KEYS.includes(value), `random pick '${value}' must be in the GLB roster`);
    assert.equal(VRM_KEYS.includes(value), false, `random pick must never be a hidden VRM (${value})`);
    assert.equal(PARAM_KEYS.includes(value), false, `random pick must never be the hidden parametric avatar (${value})`);
  }
  assert.ok(distinct.size > 1, `expected >1 distinct starting avatar across 200 sessions, saw ${distinct.size}`);
});

await check("a fresh session commits at most one avatar-switch (no eager roster fetch); a pick matching the live default commits nothing", () => {
  for (let i = 0; i < 50; i += 1) {
    const env = makeEnvironment();
    env.controller.mount();
    assert.ok(env.calls.variants.length <= 1, `expected at most one commit, saw ${env.calls.variants.length}`);
  }
  // Force the sweep onto index 0 (readyplayerme-cyberpunk === the live default already) —
  // the resolved pick equals what's already live, so the no-op guard must skip the commit.
  const env = makeEnvironment({ randomFn: () => 0 });
  env.controller.mount();
  assert.deepEqual(env.calls.variants, [], "a resolved pick matching the live default must commit nothing");
  assert.equal(env.avatar.avatar_variant, DEFAULT_VARIANT);
});

await check("a returning session (an already-saved pick) is preserved verbatim and never re-rolled", () => {
  for (const savedKey of ["rpm-female-cyberpunk", "rpm-female-ninja", "cute-moth" /* a hidden VRM, still honoured */]) {
    const storage = new FakeStorage({ [AVATAR_STARTING_VARIANT_STORAGE_KEY]: savedKey });
    // randomFn THROWS if called at all — a returning session must never even consult it.
    const env = makeEnvironment({ storage, randomFn: () => { throw new Error("must not randomize a returning session"); } });
    env.controller.mount();
    assert.equal(env.avatar.avatar_variant, savedKey, `saved pick '${savedKey}' must be recalled verbatim`);
    assert.deepEqual(env.calls.variants, [savedKey], "exactly one corrective commit, to the saved value");
    assert.equal(storage.getItem(AVATAR_STARTING_VARIANT_STORAGE_KEY), savedKey, "the saved record itself must be untouched");
  }
});

await check("a saved session pointing at a NOW-REMOVED id (e.g. a runtime catalog deletion) re-rolls to a valid enumerable GLB instead of breaking", () => {
  // deleted rpm-female-vrchat / rpm-male-vrchat from the real catalog. A
  // session that saved one of those ids before the removal must NOT be recalled verbatim — that
  // id no longer resolves to anything loadable. readSavedStartingVariant's own `variants[key]`
  // guard makes it fall through to a fresh random pick instead, exactly like a brand-new session
  // (mirrors the fail-safe proof added to src/lazy-avatar-selector-check.mjs).
  // Real oracle: if that guard were dropped, the removed id would be recalled verbatim and the
  // assertions below would fail.
  const storage = new FakeStorage({ [AVATAR_STARTING_VARIANT_STORAGE_KEY]: "rpm-female-vrchat" });
  const env = makeEnvironment({ storage, randomFn: () => 0.5 }); // must be consulted: the stale id is not honoured
  env.controller.mount();
  assert.notEqual(env.avatar.avatar_variant, "rpm-female-vrchat", "the removed id must never be recalled or staged");
  assert.ok(GLB_KEYS.includes(env.avatar.avatar_variant), `the re-roll must land on a valid enumerable GLB, saw '${env.avatar.avatar_variant}'`);
  assert.deepEqual(env.calls.variants, [env.avatar.avatar_variant], "exactly one corrective commit, to the re-rolled pick");
  assert.equal(storage.getItem(AVATAR_STARTING_VARIANT_STORAGE_KEY), env.avatar.avatar_variant, "the stale saved record must be overwritten with the fresh valid pick, not left dangling");
});

await check("an explicit Apply persists the choice; a later boot on the SAME session storage recalls it instead of re-rolling", async () => {
  const storage = new FakeStorage();
  const first = makeEnvironment({ storage });
  first.controller.mount();
  first.controller.pickAvatar("rpm-female-ninja");
  const applied = await first.controller.apply();
  assert.equal(applied.ok, true);
  assert.equal(storage.getItem(AVATAR_STARTING_VARIANT_STORAGE_KEY), "rpm-female-ninja", "Apply must persist the explicit choice");

  // Simulate a reload: a FRESH controller/runtime construction (new module-scope state, exactly
  // what a real page reload produces), reusing the SAME (tab-scoped) storage instance.
  const second = makeEnvironment({ storage, randomFn: () => { throw new Error("must not randomize after an explicit choice was saved"); } });
  second.controller.mount();
  assert.equal(second.avatar.avatar_variant, "rpm-female-ninja", "the reloaded session must recall the explicitly-applied avatar");
  assert.deepEqual(second.calls.variants, ["rpm-female-ninja"]);
});

await check("?avatar_variant=<key> pins a specific starting avatar, overriding both a saved choice and randomization", () => {
  const storage = new FakeStorage({ [AVATAR_STARTING_VARIANT_STORAGE_KEY]: "rpm-female-cyberpunk" });
  const env = makeEnvironment({
    storage,
    locationSearch: "?role=player&avatar_variant=rpm-female-character",
    randomFn: () => { throw new Error("must not randomize when a pin is present"); },
  });
  env.controller.mount();
  assert.equal(env.avatar.avatar_variant, "rpm-female-character", "the URL pin must win over the saved choice");
  assert.equal(storage.getItem(AVATAR_STARTING_VARIANT_STORAGE_KEY), "rpm-female-character", "the pin also becomes this session's saved record");
});

await check("no usable session storage (plain Node import, no injection) leaves the deterministic boot default untouched", () => {
  const env = makeEnvironment({ storage: null, randomFn: () => { throw new Error("must not randomize with no storage"); } });
  env.controller.mount();
  assert.deepEqual(env.calls.variants, [], "no storage means no correction is attempted at all");
  assert.equal(env.avatar.avatar_variant, DEFAULT_VARIANT);
});

await check("a non-player role never triggers the starting-avatar correction", () => {
  const env = makeEnvironment({ isPlayer: false, initialVariant: "cute-moth" });
  env.controller.mount();
  assert.deepEqual(env.calls.variants, [], "an observer/non-player role must not get a starting-avatar correction");
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
    // no-storage-guard removed: a plain Node import (no injected/global storage) must NOT
    // randomize. Without the early bail-out, resolveStartingAvatarVariant would still roll a
    // random pick even with storage === null (writeSavedStartingVariant's own null-guard would
    // silently swallow the persistence, hiding the bug from a casual read). Anchored on the
    // 2-line sequence (not the bare guard line alone) because `if (!storage) return null;`
    // ALSO appears, verbatim, as readSavedStartingVariant's own unrelated guard earlier in the
    // file — a single-line anchor would silently mutate the wrong occurrence.
    "no-storage-guard",
    "if (!storage) return null;\n    const saved = readSavedStartingVariant(storage);",
    "if (false) return null;\n    const saved = readSavedStartingVariant(storage);",
    async (factory) => {
      // randomFn is fixed (not Math.random): index 0 maps to "readyplayerme-cyberpunk", which
      // already equals the live default, and would coincidentally mask the mutation's effect
      // (the no-op guard would still block the commit) on the ~1/7 of runs where an unseeded
      // Math.random() lands there. 0.5 maps solidly into the middle of the roster, away from
      // the default, so the assertion below is deterministic every run.
      const env = makeEnvironment({ storage: null, randomFn: () => 0.5 }, factory);
      env.controller.mount();
      assert.deepEqual(env.calls.variants, []);
    },
  ],
  [
    // saved-priority removed: a returning session must keep its saved pick, not re-roll.
    "saved-priority-dropped",
    "if (saved) return { variant: saved, source: \"saved\" };",
    "if (false) return { variant: saved, source: \"saved\" };",
    async (factory) => {
      const storage = new FakeStorage({ [AVATAR_STARTING_VARIANT_STORAGE_KEY]: "rpm-female-cyberpunk" });
      const env = makeEnvironment({ storage, randomFn: () => 0.99 }, factory); // -> last GLB key if it re-rolls
      env.controller.mount();
      assert.equal(env.avatar.avatar_variant, "rpm-female-cyberpunk", "saved pick must have been preserved");
    },
  ],
  [
    // enumerable-set restriction dropped: the random pool must never include hidden VRM/
    // parametric variants. A deterministic sweep across the FULL (mutated) key list proves a
    // hidden key leaks in, rather than hoping statistics catch it.
    "random-pool-includes-hidden",
    "const keys = enumerableVariantKeys();",
    "const keys = Object.keys(variants);",
    async (factory) => {
      // Assert the CORRECT invariant (true for the real code, false under the mutation) —
      // asserting "a hidden key leaked" instead would PASS under the mutation and stay
      // silently GREEN, proving nothing.
      const allKeys = [...GLB_KEYS, ...VRM_KEYS, ...PARAM_KEYS];
      for (let i = 0; i < allKeys.length; i += 1) {
        const sweep = sweepRandomFn(allKeys.length);
        for (let j = 0; j < i; j += 1) sweep();
        const env = makeEnvironment({ randomFn: sweep }, factory);
        env.controller.mount();
        assert.equal(
          VRM_KEYS.includes(env.avatar.avatar_variant) || PARAM_KEYS.includes(env.avatar.avatar_variant),
          false,
          `hidden variant '${env.avatar.avatar_variant}' must never be a random pick (sweep index ${i})`
        );
      }
    },
  ],
  [
    // no-op guard removed: a resolved pick matching the live default must commit nothing.
    // Without the guard, mount() would call setAvatarVariant even when unchanged.
    "redundant-commit-on-match",
    "avatar.avatar_variant !== resolved.variant",
    "true",
    async (factory) => {
      // Assert the CORRECT invariant (no commit when the resolved pick already matches the
      // live default) — this holds for the real code and is violated by the mutation.
      const env = makeEnvironment({ randomFn: () => 0 }, factory); // resolves to the live default
      env.controller.mount();
      assert.deepEqual(env.calls.variants, [], "expected no commit when the resolved pick already matches the live default");
    },
  ],
  [
    // apply() no longer persists: an explicit choice would be lost on the next boot.
    "apply-does-not-persist",
    'writeSavedStartingVariant(currentSessionStorage(), variant);',
    "/* persistence removed */;",
    async (factory) => {
      // Assert the CORRECT invariant (Apply DOES persist) — true for the real code, violated
      // by the mutation (which would leave the storage record null/stale). randomFn is pinned
      // to mount()'s own no-op pick (index 0 -> the live default, "readyplayerme-cyberpunk"):
      // otherwise mount()'s UNMUTATED random-branch write could coincidentally land on
      // "rpm-female-ninja" too (~1/5 of runs with a real Math.random()) and mask the mutation.
      const storage = new FakeStorage();
      const first = makeEnvironment({ storage, randomFn: () => 0 }, factory);
      first.controller.mount();
      first.controller.pickAvatar("rpm-female-ninja");
      await first.controller.apply();
      assert.equal(storage.getItem(AVATAR_STARTING_VARIANT_STORAGE_KEY), "rpm-female-ninja", "expected the explicit choice to have been persisted");
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

await check("every no-storage, saved-priority, random-pool, no-op-guard and persistence mutation turns RED", () => {
  assert.equal(mutationsCaught, mutations.length);
});

fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
fs.writeFileSync(
  path.join(EVIDENCE_DIR, "runtime-randomize-starting-avatar-check.json"),
  JSON.stringify(
    {
      generated_at: new Date().toISOString(),
      controller: path.relative(ROOT, CONTROLLER_PATH),
      storage_key: AVATAR_STARTING_VARIANT_STORAGE_KEY,
      glb_random_pool: GLB_KEYS,
      hidden_from_random_pool: [...VRM_KEYS, ...PARAM_KEYS],
      default_variant: DEFAULT_VARIANT,
      positive_checks: checks,
      red_mutations_caught: mutationLabels,
      result: "ALL CHECKS PASS",
    },
    null,
    2
  )
);

console.log(`feature_RANDOMIZE_STARTING_AVATAR PASS ${checks.length}/${checks.length} mutations=${mutationsCaught}/${mutations.length}`);
