#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { NO_EQUIPMENT_CHOICE, applyNoEquipmentChoice } from "../web/no-equipment-choice.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const CONTROLLER_PATH = path.join(ROOT, "web", "avatar-selector-controller.mjs");
const APP_PATH = path.join(ROOT, "web", "app.js");
const controllerSource = fs.readFileSync(CONTROLLER_PATH, "utf8");
const appSource = fs.readFileSync(APP_PATH, "utf8");
const { createAvatarSelectorController } = await import(pathToFileURL(CONTROLLER_PATH));

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

  listenerCount(type) {
    return this.listeners.get(type)?.size || 0;
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
    this.pointerCapture = null;
    this._innerHTML = "";
    this._classes = new Set();
  }

  set innerHTML(value) {
    this._innerHTML = String(value);
    this.children = [];
  }

  get innerHTML() {
    return this._innerHTML;
  }

  get classList() {
    return { toggle: (name, active) => active ? this._classes.add(name) : this._classes.delete(name) };
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

  setPointerCapture(pointerId) {
    this.pointerCapture = pointerId;
  }

  closest() {
    return null;
  }
}

class FakeDocument extends FakeEventTarget {
  constructor() {
    super();
    this.body = new FakeElement(this, "body");
    this.activeElement = this.body;
    this.previewMotionButtons = [];
  }

  createElement(tagName) {
    return new FakeElement(this, tagName);
  }

  querySelectorAll(selector) {
    return selector === "[data-preview-motion]" ? this.previewMotionButtons : [];
  }
}

const item = (itemId, attachmentPoint, mode) => ({
  itemId,
  attachmentPoint,
  mode,
  assetUri: `http://example.test/${itemId}.glb`,
  localTransform: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
  label: itemId,
});

const slots = () => [
  { slot: "head", label: "Head", options: [item("hat", "head", "worn"), item("crown", "head", "worn")] },
  { slot: "leftHand", label: "Left hand", options: [item("torch", "leftHand", "held"), item("shield", "leftHand", "held")] },
  { slot: "rightHand", label: "Right hand", options: [item("hammer", "rightHand", "held"), item("mug", "rightHand", "held")] },
];
const extras = () => [item("belt", "hips", "worn")];
const valid = (items) => {
  if (!Array.isArray(items)) return { ok: false, errors: ["not array"] };
  if (items.length === 0) return { ok: true, errors: [] };
  const modes = new Set(items.map((entry) => entry.mode));
  const errors = [];
  if (!modes.has("held")) errors.push("missing held item");
  if (!modes.has("worn")) errors.push("missing worn item");
  return { ok: errors.length === 0, errors };
};

function makeEnvironment(factory = createAvatarSelectorController) {
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
  const idleButton = element("preview-idle", "button");
  idleButton.dataset.previewMotion = "idle";
  const walkButton = element("preview-walk", "button");
  walkButton.dataset.previewMotion = "walk";
  documentTarget.previewMotionButtons.push(idleButton, walkButton);

  let rafSequence = 0;
  const rafs = new Map();
  const previewLayers = [];
  const createPreviewLayer = () => {
    const layer = {
      ready: Promise.resolve(),
      avatars: [],
      disposed: false,
      resized: 0,
      camera: {
        position: { set() {} },
        lookAt() {},
        updateProjectionMatrix() {},
      },
      setAvatar(avatar) { this.avatars.push(avatar); },
      resize() { this.resized += 1; },
      debugState() {
        const avatar = this.avatars.at(-1);
        return {
          current_animation_state: avatar?.locomotion?.moving ? "walk" : "idle",
          attached_item_count: avatar?.equippedItems?.length || 0,
          expected_item_count: avatar?.equippedItems?.length || 0,
        };
      },
      dispose() { this.disposed = true; },
    };
    previewLayers.push(layer);
    return layer;
  };

  const avatar = {
    avatar_variant: "upgraded",
    rotation_y: 0.25,
    equippedItems: [item("hat", "head", "worn"), item("torch", "leftHand", "held"), item("hammer", "rightHand", "held")],
  };
  const calls = { apply: 0, broadcast: 0, emit: 0, preferred: [], variants: [] };
  const runtime = {
    avatar,
    world: { location_id: "location-a" },
    setAvatarVariant(variant) {
      calls.variants.push(variant);
      avatar.avatar_variant = variant;
      calls.broadcast += 1;
      calls.emit += 1;
      return { ok: true, variant };
    },
    setPreferredHeight(height) {
      calls.preferred.push(height);
      return { ok: true, preferred_height_m: height };
    },
    async applyEquipment(items, resolveStatus) {
      calls.apply += 1;
      avatar.equippedItems = items;
      runtime.equipmentStatus = await resolveStatus(items);
      calls.broadcast += 1;
      calls.emit += 1;
      return { ok: true };
    },
  };
  const debugText = new Map();
  const logs = [];
  const variants = {
    upgraded: { key: "upgraded", label: "Upgraded", type: "vrm", load_mode: "vrm", mocap_retarget: "supported", equipment_attachment: "bones", structured_unsupported: [] },
    dwarf: { key: "dwarf", label: "Dwarf", type: "vrm", load_mode: "vrm", mocap_retarget: "supported", equipment_attachment: "bones", structured_unsupported: [] },
    parametric: { key: "parametric", label: "Parametric", type: "parametric", load_mode: "generated", mocap_retarget: "supported", equipment_attachment: "bones", structured_unsupported: [] },
  };
  const controller = factory({
    isPlayer: true,
    role: "player",
    variants,
    inventorySlots: slots,
    equipmentCatalog: extras,
    validateEquippedItems: valid,
    resolveEquipmentItems: async (items) => ({ validation: valid(items), items: items.map((entry) => entry.itemId) }),
    noEquipmentChoice: NO_EQUIPMENT_CHOICE,
    applyNoEquipmentChoice,
    createPreviewLayer,
    getRuntime: () => runtime,
    lookup: (id) => elements.get(id) || null,
    documentTarget,
    requestFrame: (callback) => {
      rafSequence += 1;
      rafs.set(rafSequence, callback);
      return rafSequence;
    },
    cancelFrame: (handle) => rafs.delete(handle),
    logger: (line) => logs.push(line),
    escapeHtml: (value) => String(value),
    writeDebugText: (id, text) => debugText.set(id, text),
    fixed3: (value) => Number(value).toFixed(3),
    yawQuaternion: (yaw) => [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)],
    isTypingTarget: (target) => ["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName),
  });
  return { avatar, calls, controller, debugText, documentTarget, elements, logs, previewLayers, rafs };
}

const checks = [];
async function check(label, callback) {
  await callback();
  checks.push(label);
  console.log(`PASS ${String(checks.length).padStart(2, "0")} ${label}`);
}

const env = makeEnvironment();
const controller = env.controller;
let originalFocus = null;

await check("mount is idempotent with one listener set", () => {
  assert.equal(controller.mount(), controller);
  const listeners = controller.debug().listener_count;
  controller.mount();
  assert.equal(controller.debug().listener_count, listeners);
  assert.equal(env.documentTarget.listenerCount("keydown"), 1);
  assert.equal(env.elements.get("btn-switch-avatar").listenerCount("click"), 1);
  assert.equal(env.elements.get("inventory-card").hidden, true);
});

await check("open stages a clone and owns one preview RAF", async () => {
  originalFocus = env.documentTarget.createElement("button");
  originalFocus.focus();
  await controller.open();
  assert.equal(controller.debug().open, true);
  assert.deepEqual(controller.debug().baseline_item_ids, ["hammer", "hat", "torch"]);
  assert.equal(env.rafs.size, 1);
  await controller.open();
  assert.equal(env.rafs.size, 1);
  assert.equal(env.previewLayers.length, 1);
});

await check("staged changes cancel without mutating the live avatar and restore focus", () => {
  const baselineVariant = env.avatar.avatar_variant;
  const baselineItems = JSON.stringify(env.avatar.equippedItems);
  controller.pickAvatar("dwarf");
  controller.pickSlotItem("head", "crown");
  controller.removeAllEquipment();
  const result = controller.cancel();
  assert.equal(result.ok, true);
  assert.equal(env.avatar.avatar_variant, baselineVariant);
  assert.equal(JSON.stringify(env.avatar.equippedItems), baselineItems);
  assert.equal(env.documentTarget.activeElement, originalFocus);
  assert.equal(env.rafs.size, 0);
});

await check("apply commits staged avatar and explicit no-equipment through the runtime facade", async () => {
  await controller.open();
  controller.pickAvatar("dwarf");
  controller.removeAllEquipment();
  const result = await controller.apply();
  assert.equal(result.ok, true);
  assert.equal(env.avatar.avatar_variant, "dwarf");
  assert.deepEqual(env.avatar.equippedItems, []);
  assert.equal(env.calls.apply, 1);
  assert.ok(env.calls.broadcast >= 2);
  assert.ok(env.calls.emit >= 2);
  assert.equal(controller.debug().open, false);
});

await check("typing guard, arrow keys, Escape, pointer capture, and turntable remain live", async () => {
  await controller.open();
  const beforeVariant = controller.debug().pending_variant;
  env.documentTarget.dispatchEvent({ type: "keydown", key: "ArrowRight", target: env.documentTarget.createElement("input"), preventDefault() {} });
  assert.equal(controller.debug().pending_variant, beforeVariant);
  env.documentTarget.dispatchEvent({ type: "keydown", key: "ArrowRight", target: env.elements.get("avatar-selector-preview"), preventDefault() {} });
  assert.notEqual(controller.debug().pending_variant, beforeVariant);
  const preview = env.elements.get("avatar-selector-preview");
  const beforeRotation = controller.debug().preview_rotation_y;
  preview.dispatchEvent({ type: "pointerdown", pointerId: 7, clientX: 10, target: preview });
  preview.dispatchEvent({ type: "pointermove", pointerId: 7, clientX: 30, target: preview });
  preview.dispatchEvent({ type: "pointerup", pointerId: 7, clientX: 30, target: preview });
  assert.equal(preview.pointerCapture, 7);
  assert.notEqual(controller.debug().preview_rotation_y, beforeRotation);
  env.documentTarget.dispatchEvent({ type: "keydown", key: "Escape", target: preview, preventDefault() {} });
  assert.equal(controller.debug().open, false);
});

await check("legacy selector and inventory drivers preserve names, shapes, and immediate slot behavior", async () => {
  assert.deepEqual(Object.keys(controller.selectorDriver()), [
    "open", "cancel", "apply", "next", "previous", "pickAvatar", "pickSlotItem",
    "toggleExtraItem", "removeAllEquipment", "setMotion", "state",
  ]);
  assert.deepEqual(Object.keys(controller.inventoryDriver()), [
    "slots", "setSlotItem", "pickAvatar", "avatarVariants", "setPreferredHeight",
  ]);
  env.avatar.equippedItems = [item("hat", "head", "worn"), item("torch", "leftHand", "held"), item("hammer", "rightHand", "held")];
  const swap = await controller.inventoryDriver().setSlotItem("rightHand", "mug");
  assert.equal(swap.ok, true);
  assert.equal(env.avatar.equippedItems.some((entry) => entry.itemId === "mug"), true);
  assert.equal(env.avatar.equippedItems.some((entry) => entry.itemId === "hammer"), false);
  assert.equal(controller.inventoryDriver().pickAvatar("parametric").ok, true);
  assert.equal(controller.inventoryDriver().setPreferredHeight(1.8).ok, true);
});

await check("dispose is idempotent and remount restores exactly one lifecycle", async () => {
  await controller.open();
  const previewLayer = env.previewLayers[0];
  controller.dispose();
  controller.dispose();
  assert.equal(env.rafs.size, 0);
  assert.equal(env.documentTarget.totalListeners(), 0);
  assert.equal(env.elements.get("btn-switch-avatar").totalListeners(), 0);
  assert.equal(previewLayer.disposed, true);
  assert.equal(env.documentTarget.body.getAttribute("data-avatar-selector-open"), null);
  controller.mount();
  controller.mount();
  assert.equal(env.documentTarget.listenerCount("keydown"), 1);
  await controller.open();
  assert.equal(env.rafs.size, 1);
  assert.equal(env.previewLayers.length, 2);
});

await check("app is composition-only and preserves both compatibility publications", () => {
  assert.match(appSource, /import \{ createAvatarSelectorController \} from "\.\/avatar-selector-controller\.mjs";/);
  assert.match(appSource, /avatarSelectorController = createAvatarSelectorController\(\{/);
  assert.match(appSource, /getRuntime: \(\) => adapter[\s\S]*applyEquipment:[\s\S]*_maybeBroadcastPlayerPose[\s\S]*_emit/);
  assert.match(appSource, /avatarSelectorController\.mount\(\);/);
  assert.match(appSource, /avatarSelectorRemoveAllEquipment = \(\) => avatarSelectorController\.removeAllEquipment\(\)/);
  assert.match(appSource, /\.\.\.avatarSelectorController\.selectorDriver\(\)/);
  assert.match(appSource, /inventory: avatarSelectorController\.inventoryDriver\(\)/);
  for (const duplicate of [
    "const avatarSelectorState", "function avatarSelectorRender", "function openAvatarSelectorModal",
    "function setInventorySlotItem", "function wireInventoryPanel",
  ]) assert.equal(appSource.includes(duplicate), false, `duplicate app owner ${duplicate}`);
  assert.equal((controllerSource.match(/export function createAvatarSelectorController/g) || []).length, 1);
  for (const forbidden of ["from \"./app.js\"", "LiveAdapter", "import { AvatarEquipmentLayer", "fetch("]) {
    assert.equal(controllerSource.includes(forbidden), false, `forbidden dependency ${forbidden}`);
  }
});

async function mutatedFactory(label, originalText, replacementText) {
  assert.ok(controllerSource.includes(originalText), `${label} mutation target missing`);
  const mutated = controllerSource.replace(originalText, replacementText);
  const url = `data:text/javascript;base64,${Buffer.from(mutated).toString("base64")}#${label}`;
  return (await import(url)).createAvatarSelectorController;
}

const mutations = [
  [
    "preview-raf-singleton",
    "if (state.previewRaf) cancelFrame(state.previewRaf);",
    "if (false && state.previewRaf) cancelFrame(state.previewRaf);",
    async (factory) => {
      const candidate = makeEnvironment(factory);
      candidate.controller.mount();
      await candidate.controller.open();
      await candidate.controller.open();
      assert.equal(candidate.rafs.size, 1);
    },
  ],
  [
    "listener-disposal",
    "for (const [target, type, handler] of listeners.splice(0)) target.removeEventListener(type, handler);",
    "for (const [target, type, handler] of listeners.splice(0)) { void target; void type; void handler; }",
    (factory) => {
      const candidate = makeEnvironment(factory);
      candidate.controller.mount();
      candidate.controller.dispose();
      assert.equal(candidate.documentTarget.totalListeners(), 0);
      assert.equal(candidate.elements.get("btn-switch-avatar").totalListeners(), 0);
    },
  ],
  [
    "apply-runtime-path",
    "await host.applyEquipment(nextItems, resolveEquipmentItems);",
    "void resolveEquipmentItems;",
    async (factory) => {
      const candidate = makeEnvironment(factory);
      candidate.controller.mount();
      await candidate.controller.open();
      candidate.controller.removeAllEquipment();
      await candidate.controller.apply();
      assert.deepEqual(candidate.avatar.equippedItems, []);
    },
  ],
  [
    "explicit-none-choice",
    "state.pendingItems = applyNoEquipmentChoice(state.pendingItems);",
    "state.pendingItems = state.pendingItems;",
    async (factory) => {
      const candidate = makeEnvironment(factory);
      candidate.controller.mount();
      await candidate.controller.open();
      candidate.controller.removeAllEquipment();
      assert.deepEqual(candidate.controller.debug().pending_item_ids, []);
    },
  ],
  [
    "typing-guard",
    "if (!state.open || isTypingTarget(event.target)) return;",
    "if (!state.open) return;",
    async (factory) => {
      const candidate = makeEnvironment(factory);
      candidate.controller.mount();
      await candidate.controller.open();
      const before = candidate.controller.debug().pending_variant;
      candidate.documentTarget.dispatchEvent({ type: "keydown", key: "ArrowRight", target: candidate.documentTarget.createElement("input"), preventDefault() {} });
      assert.equal(candidate.controller.debug().pending_variant, before);
    },
  ],
  [
    "focus-restore",
    "if (state.previousFocus && typeof state.previousFocus.focus === \"function\") state.previousFocus.focus();",
    "void state.previousFocus;",
    async (factory) => {
      const candidate = makeEnvironment(factory);
      candidate.controller.mount();
      const origin = candidate.documentTarget.createElement("button");
      origin.focus();
      await candidate.controller.open();
      candidate.controller.cancel();
      assert.equal(candidate.documentTarget.activeElement, origin);
    },
  ],
];

let mutationsCaught = 0;
for (const [label, originalText, replacementText, contract] of mutations) {
  const factory = await mutatedFactory(label, originalText, replacementText);
  try {
    await contract(factory);
    throw new Error(`${label} mutation stayed GREEN`);
  } catch (error) {
    if (error.message === `${label} mutation stayed GREEN`) throw error;
    mutationsCaught += 1;
    console.log(`RED_CAUGHT ${label}`);
  }
}

await check("all lifecycle, staging, accessibility, and compatibility mutations turn RED", () => {
  assert.equal(mutationsCaught, mutations.length);
});

controller.dispose();
console.log(`feature_AVATAR_SELECTOR_CONTROLLER PASS ${checks.length}/${checks.length} mutations=${mutationsCaught}/${mutations.length}`);
