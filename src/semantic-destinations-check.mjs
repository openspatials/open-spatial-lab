#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONTROLLER_PATH = join(ROOT, "web", "semantic-destinations-controller.mjs");
const APP_PATH = join(ROOT, "web", "app.js");
const HTML_PATH = join(ROOT, "web", "index.html");
const controllerSource = readFileSync(CONTROLLER_PATH, "utf8");
const appSource = readFileSync(APP_PATH, "utf8");
const htmlSource = readFileSync(HTML_PATH, "utf8");
const production = await import(pathToFileURL(CONTROLLER_PATH));

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
}

class FakeElement extends FakeEventTarget {
  constructor(tagName, documentTarget) {
    super();
    this.tagName = String(tagName).toUpperCase();
    this.ownerDocument = documentTarget;
    this.children = [];
    this.attributes = new Map();
    this.dataset = {};
    this.className = "";
    this.hidden = false;
    this.type = "";
    this.id = "";
    this._textContent = "";
  }

  get textContent() {
    return this.children.length
      ? this.children.map((child) => child.textContent).join("")
      : this._textContent;
  }

  set textContent(value) {
    this.children = [];
    this._textContent = String(value ?? "");
  }

  append(...children) {
    for (const child of children) this.appendChild(child);
  }

  appendChild(child) {
    this.children.push(child);
    this._textContent = "";
    return child;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  focus() {
    this.ownerDocument.activeElement = this;
  }
}

function portal({
  key,
  label,
  targetLocation = null,
  targetWorld = null,
  targetFixture = null,
  transition = null,
} = {}) {
  return {
    string_portal_id: key,
    label,
    target_location_id: targetLocation,
    target_world_id: targetWorld,
    target_fixture: targetFixture,
    traversal: { mode: "bidirectional", ...(transition ? { transition } : {}) },
  };
}

const WORLD_A = {
  location_id: "location-a",
  world_id: "demo-room-a",
  title: "Location A - Origin Gallery",
  portals: [portal({ key: "location-a-portal", label: "Portal to Location B", targetLocation: "location-b", targetWorld: "demo-room-b" })],
};
const WORLD_B = {
  location_id: "location-b",
  world_id: "demo-room-b",
  title: "Location B - Destination Atrium",
  portals: [portal({ key: "location-b-portal", label: "Portal to Location A", targetLocation: "location-a", targetWorld: "demo-room-a" })],
};
const WORLD_LOBBY = {
  location_id: "location-lobby",
  world_id: "demo-lobby",
  title: "Lobby - Pre-Location Gathering",
  portals: [
    portal({ key: "lobby-portal-a", label: "Portal to Location A", targetLocation: "location-a", targetWorld: "demo-room-a" }),
    portal({ key: "lobby-portal-b", label: "Portal to Location B", targetLocation: "location-b", targetWorld: "demo-room-b" }),
    portal({
      key: "lobby-portal-c",
      label: "Portal to Denver Skyport",
      targetFixture: { spatial_id: "world-airport-terminal", graph_endpoint: "/worlds/denver-skyport.json" },
      transition: "client_scene_load",
    }),
  ],
};

function debugFor(world, focusedKey = null, overrides = {}) {
  return {
    location_id: world.location_id,
    controls: {
      portal_focus_portal_id: focusedKey,
      portal_ready_blocker: null,
      portals: world.portals.map((entry) => ({
        portal_id: entry.string_portal_id,
        is_focus: entry.string_portal_id === focusedKey,
        entry_side_allowed: true,
      })),
      ...overrides,
    },
  };
}

function makeEnvironment(factory = production.createSemanticDestinationsController, initial = {}) {
  const documentTarget = { activeElement: null };
  const eventTarget = new FakeEventTarget();
  const elements = new Map();
  const register = (id, tag = "div") => {
    const element = new FakeElement(tag, documentTarget);
    element.id = id;
    elements.set(id, element);
    return element;
  };
  const toggle = register("btn-semantic-destinations", "button");
  const closeButton = register("btn-semantic-destinations-close", "button");
  const panel = register("semantic-destinations-panel", "nav");
  const current = register("semantic-current-world", "p");
  const list = register("semantic-destinations-list");
  const status = register("semantic-destinations-status", "p");
  let snapshot = {
    world: initial.world || WORLD_LOBBY,
    debug: initial.debug || debugFor(initial.world || WORLD_LOBBY, "lobby-portal-a"),
    connectionState: initial.connectionState || "live",
    isPlayer: initial.isPlayer ?? true,
  };
  let activationCount = 0;
  const controller = factory({
    lookup: (id) => elements.get(id) || null,
    createElement: (tagName) => new FakeElement(tagName, documentTarget),
    documentTarget,
    eventTarget,
    getSnapshot: () => snapshot,
    activateFocusedPortal: async () => { activationCount += 1; },
    isTypingTarget: (target) => ["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName),
    logger: () => {},
  });
  return {
    controller,
    documentTarget,
    eventTarget,
    toggle,
    closeButton,
    panel,
    current,
    list,
    status,
    setSnapshot(next) { snapshot = next; },
    activationCount: () => activationCount,
    button(key) { return list.children.find((child) => child.dataset.destinationKey === key) || null; },
  };
}

let checks = 0;
async function check(name, assertion) {
  await assertion();
  checks += 1;
  process.stdout.write(`PASS ${String(checks).padStart(2, "0")} ${name}\n`);
}

await check("production module exports the one focused semantic destination owner", () => {
  assert.equal(typeof production.createSemanticDestinationsController, "function");
  assert.equal(typeof production.deriveSemanticDestinations, "function");
  assert.equal((controllerSource.match(/export function createSemanticDestinationsController/g) || []).length, 1);
  assert.doesNotMatch(controllerSource, /address|fragment|history|cache|trust verification|re-root/i);
});

await check("A and B derive their opposite portal destinations from current descriptors", () => {
  const a = production.deriveSemanticDestinations({ world: WORLD_A, debug: debugFor(WORLD_A, "location-a-portal") });
  const b = production.deriveSemanticDestinations({ world: WORLD_B, debug: debugFor(WORLD_B, "location-b-portal") });
  assert.equal(a.currentWorld.identity, "location-a");
  assert.deepEqual(a.destinations.map(({ identity }) => identity), ["location-b"]);
  assert.equal(b.currentWorld.identity, "location-b");
  assert.deepEqual(b.destinations.map(({ identity }) => identity), ["location-a"]);
});

await check("lobby authored order covers A, B, and Airport Portal C", () => {
  const result = production.deriveSemanticDestinations({ world: WORLD_LOBBY, debug: debugFor(WORLD_LOBBY, "lobby-portal-b") });
  assert.deepEqual(result.destinations.map(({ key }) => key), ["lobby-portal-a", "lobby-portal-b", "lobby-portal-c"]);
  assert.deepEqual(result.destinations.map(({ identity }) => identity), ["location-a", "location-b", "world-airport-terminal"]);
  assert.equal(result.destinations[2].transition, "client_scene_load");
  assert.equal(result.destinations[1].isFocused, true);
});

await check("deterministic fallback ordering and empty state are non-vacuous", () => {
  const fallback = production.deriveSemanticDestinations({
    world: { ...WORLD_LOBBY, portals: { z: WORLD_LOBBY.portals[2], a: WORLD_LOBBY.portals[0], b: WORLD_LOBBY.portals[1] } },
    debug: { controls: { portals: [] } },
  });
  assert.deepEqual(fallback.destinations.map(({ key }) => key), ["lobby-portal-a", "lobby-portal-b", "lobby-portal-c"]);
  const empty = production.deriveSemanticDestinations({ world: { location_id: "empty", title: "Empty World", portals: [] } });
  assert.equal(empty.destinations.length, 0);
  assert.equal(empty.currentWorld.label, "Empty World");
});

await check("unavailable and refused states retain honest labels and actions", () => {
  const unavailable = production.deriveSemanticDestinations({
    world: WORLD_A,
    debug: debugFor(WORLD_A, "location-a-portal"),
    connectionState: "unavailable",
  }).destinations[0];
  assert.equal(unavailable.statusKind, "unavailable");
  assert.match(unavailable.status, /unavailable/);
  const refused = production.deriveSemanticDestinations({
    world: WORLD_A,
    debug: debugFor(WORLD_A, "location-a-portal", {
      portals: [{ portal_id: "location-a-portal", is_focus: true, entry_side_allowed: false }],
    }),
  }).destinations[0];
  assert.equal(refused.statusKind, "refused");
  assert.match(refused.actionLabel, /refused/);
});

await check("mount/open/close use one semantic live status and return focus predictably", () => {
  const env = makeEnvironment();
  assert.equal(env.controller.mount(), env.controller);
  env.controller.mount();
  assert.equal(env.toggle.listenerCount("click"), 1);
  assert.equal(env.eventTarget.listenerCount("keydown"), 1);
  env.controller.open();
  assert.equal(env.panel.hidden, false);
  assert.equal(env.toggle.getAttribute("aria-expanded"), "true");
  assert.equal(env.documentTarget.activeElement.dataset.destinationKey, "lobby-portal-a");
  assert.match(env.status.textContent, /Current world/);
  env.controller.close();
  assert.equal(env.panel.hidden, true);
  assert.equal(env.documentTarget.activeElement, env.toggle);
  assert.equal((htmlSource.match(/\sid="semantic-destinations-status"/g) || []).length, 1);
  assert.match(htmlSource, /\sid="semantic-destinations-status"[\s\S]*role="status" aria-live="polite"/);
});

await check("Enter and Space use the focused adapter seam without claiming crossing success", async () => {
  const env = makeEnvironment();
  env.controller.mount();
  env.controller.open();
  const focused = env.button("lobby-portal-a");
  let prevented = 0;
  focused.dispatchEvent({ type: "keydown", key: "Enter", preventDefault: () => { prevented += 1; } });
  await Promise.resolve();
  assert.equal(env.activationCount(), 1);
  focused.dispatchEvent({ type: "keydown", key: " ", preventDefault: () => { prevented += 1; } });
  await Promise.resolve();
  assert.equal(env.activationCount(), 2);
  assert.equal(prevented, 2);
  assert.match(env.status.textContent, /Crossing has not completed/);
  assert.doesNotMatch(env.status.textContent, /arrived|crossing complete/i);
});

await check("nonfocused action is honest wayfinding and never invokes traversal", async () => {
  const env = makeEnvironment();
  env.controller.mount();
  env.controller.open();
  const result = await env.controller.activate("lobby-portal-b");
  assert.deepEqual(result, { ok: true, kind: "wayfinding", crossing: false });
  assert.equal(env.activationCount(), 0);
  assert.match(env.status.textContent, /No crossing occurred/);
});

await check("refusal keeps destination focus stable", async () => {
  const refusedDebug = debugFor(WORLD_A, "location-a-portal", {
    portals: [{ portal_id: "location-a-portal", is_focus: true, entry_side_allowed: false }],
  });
  const env = makeEnvironment(undefined, { world: WORLD_A, debug: refusedDebug });
  env.controller.mount();
  env.controller.open();
  const button = env.button("location-a-portal");
  const result = await env.controller.activate("location-a-portal");
  assert.equal(result.kind, "refused");
  assert.equal(env.documentTarget.activeElement, button);
  assert.equal(env.activationCount(), 0);
  assert.match(env.status.textContent, /Focus remains/);
});

await check("arrival/return and state refresh preserve or relocate focus deterministically", () => {
  const env = makeEnvironment(undefined, { world: WORLD_A, debug: debugFor(WORLD_A, "location-a-portal") });
  env.controller.mount();
  env.controller.open();
  const before = env.button("location-a-portal");
  before.focus();
  env.controller.update();
  assert.equal(env.documentTarget.activeElement.dataset.destinationKey, "location-a-portal");
  env.setSnapshot({ world: WORLD_B, debug: debugFor(WORLD_B, "location-b-portal"), connectionState: "live", isPlayer: true });
  env.controller.update();
  assert.equal(env.documentTarget.activeElement.dataset.destinationKey, "location-b-portal");
  assert.match(env.status.textContent, /changed to Location B/);
  env.setSnapshot({ world: WORLD_A, debug: debugFor(WORLD_A, "location-a-portal"), connectionState: "live", isPlayer: true });
  env.controller.update();
  assert.equal(env.documentTarget.activeElement.dataset.destinationKey, "location-a-portal");
});

await check("production composition and markup are live exactly once", () => {
  assert.equal((appSource.match(/createSemanticDestinationsController\(\{/g) || []).length, 1);
  assert.equal((appSource.match(/semanticDestinationsController\.mount\(\)/g) || []).length, 1);
  assert.match(appSource, /semanticDestinationsController\.update\(\{/);
  assert.match(appSource, /semanticDestinationsController,/);
  for (const id of [
    "btn-semantic-destinations",
    "semantic-destinations-panel",
    "semantic-current-world",
    "semantic-destinations-list",
    "semantic-destinations-status",
  ]) assert.equal((htmlSource.match(new RegExp(`\\sid="${id}"`, "g")) || []).length, 1, id);
});

function replaceOnce(source, before, after) {
  assert.equal(source.split(before).length - 1, 1, `mutation anchor count: ${before}`);
  return source.replace(before, after);
}

async function importMutated(source, name) {
  const encoded = Buffer.from(source).toString("base64");
  return import(`data:text/javascript;base64,${encoded}#${name}`);
}

let caughtMutations = 0;
async function expectRed(name, before, after, probe) {
  const candidate = await importMutated(replaceOnce(controllerSource, before, after), name);
  let red = false;
  try {
    await probe(candidate);
  } catch {
    red = true;
  }
  assert.equal(red, true, `mutation ${name} must turn RED`);
  caughtMutations += 1;
  process.stdout.write(`RED_CAUGHT ${name}\n`);
}

await expectRed(
  "missing-label",
  "      label: portal.label || fallbackLabel(identity),",
  '      label: "",',
  (candidate) => {
    const result = candidate.deriveSemanticDestinations({ world: WORLD_LOBBY, debug: debugFor(WORLD_LOBBY) });
    assert.ok(result.destinations.every((entry) => entry.label.length > 0));
  },
);

await expectRed(
  "missing-status",
  "      status: readiness.status,",
  '      status: "",',
  (candidate) => {
    const result = candidate.deriveSemanticDestinations({ world: WORLD_LOBBY, debug: debugFor(WORLD_LOBBY) });
    assert.ok(result.destinations.every((entry) => entry.status.length > 0));
  },
);

await expectRed(
  "wrong-order",
  "    return world.portals.filter(Boolean);",
  "    return world.portals.slice().reverse().filter(Boolean);",
  (candidate) => {
    const result = candidate.deriveSemanticDestinations({ world: WORLD_LOBBY, debug: debugFor(WORLD_LOBBY) });
    assert.deepEqual(result.destinations.map(({ key }) => key), ["lobby-portal-a", "lobby-portal-b", "lobby-portal-c"]);
  },
);

await expectRed(
  "false-success",
  '      return { ok: true, kind: "portal_activation", crossing: false };',
  '      return { ok: true, kind: "portal_activation", crossing: true };',
  async (candidate) => {
    const env = makeEnvironment(candidate.createSemanticDestinationsController);
    env.controller.mount();
    const result = await env.controller.activate("lobby-portal-a");
    assert.equal(result.crossing, false);
  },
);

await expectRed(
  "lost-focus",
  "      ? focusedKey\n      : worldChanged",
  "      ? null\n      : worldChanged",
  (candidate) => {
    const env = makeEnvironment(candidate.createSemanticDestinationsController);
    env.controller.mount();
    env.controller.open();
    env.button("lobby-portal-b").focus();
    env.controller.update();
    assert.equal(env.documentTarget.activeElement.dataset.destinationKey, "lobby-portal-b");
  },
);

await expectRed(
  "missing-announcement",
  "    if (worldChanged || !lastAnnouncement) announce(currentWorldAnnouncement(worldChanged));",
  "    if (worldChanged || !lastAnnouncement) void currentWorldAnnouncement(worldChanged);",
  (candidate) => {
    const env = makeEnvironment(candidate.createSemanticDestinationsController);
    env.controller.mount();
    assert.match(env.status.textContent, /Current world/);
  },
);

await check("missing production composition mutation turns RED", () => {
  const mutated = replaceOnce(
    appSource,
    "  semanticDestinationsController.mount();",
    "  void semanticDestinationsController;",
  );
  assert.throws(() => assert.match(mutated, /semanticDestinationsController\.mount\(\)/));
  caughtMutations += 1;
  process.stdout.write("RED_CAUGHT missing-composition\n");
});

assert.equal(caughtMutations, 7);
process.stdout.write(`feature_SEMANTIC_DESTINATIONS PASS ${checks}/${checks} mutations=${caughtMutations}/7\n`);
