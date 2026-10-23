#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { mountAirportTerminalContent } from "../web/airport-terminal-scene.mjs";
import {
  AIRPORT_SHOPPING_SESSION_RULE,
  createAirportStorefrontCatalogContract,
  createAirportStorefrontInteractionController,
} from "../web/airport-storefront-interaction-controller.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_PATH = path.join(ROOT, "web/worlds/denver-skyport.json");
const CONTROLLER_PATH = path.join(ROOT, "web/airport-storefront-interaction-controller.mjs");
const APP_PATH = path.join(ROOT, "web/app.js");
const INDEX_PATH = path.join(ROOT, "web/index.html");
const MOVEMENT_PATH = path.join(ROOT, "web/movement-camera-controller.mjs");
const MUTATION = process.env.feature_MUTATION || "";

class FakeElement {
  constructor(tagName, documentTarget) {
    this.tagName = String(tagName).toUpperCase();
    this.ownerDocument = documentTarget;
    this.children = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.dataset = {};
    this.listeners = new Map();
    this.className = "";
    this.hidden = false;
    this.disabled = false;
    this.type = "";
    this.id = "";
    this._textContent = "";
    this.isConnected = true;
  }

  get textContent() {
    return this._textContent + this.children.map((child) => child.textContent).join("");
  }

  set textContent(value) {
    this._textContent = String(value ?? "");
    this.children = [];
  }

  get firstChild() {
    return this.children[0] || null;
  }

  setAttribute(name, value) {
    const text = String(value);
    this.attributes.set(name, text);
    if (name === "id") {
      this.id = text;
      this.ownerDocument.register(this);
    }
    if (name.startsWith("data-")) {
      const key = name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      this.dataset[key] = text;
    }
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  removeAttribute(name) {
    this.attributes.delete(name);
    if (name.startsWith("data-")) {
      const key = name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      delete this.dataset[key];
    }
  }

  appendChild(child) {
    child.parentNode = this;
    child.isConnected = true;
    this.children.push(child);
    if (child.id) this.ownerDocument.register(child);
    return child;
  }

  replaceChildren(...children) {
    for (const child of this.children) child.isConnected = false;
    this.children = [];
    this._textContent = "";
    for (const child of children) this.appendChild(child);
  }

  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    child.isConnected = false;
    child.parentNode = null;
    return child;
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(handler);
  }

  removeEventListener(type, handler) {
    this.listeners.get(type)?.delete(handler);
  }

  dispatch(type, input = {}) {
    const event = {
      type,
      target: this,
      repeat: false,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.propagationStopped = true; },
      ...input,
    };
    for (const handler of this.listeners.get(type) || []) handler(event);
    return event;
  }

  click() {
    this.dispatch("click");
  }

  focus() {
    this.ownerDocument.activeElement = this;
  }
}

class FakeDocument extends FakeElement {
  constructor() {
    super("document", null);
    this.ownerDocument = this;
    this.elements = new Map();
    this.body = new FakeElement("body", this);
    this.activeElement = this.body;
  }

  register(element) {
    if (element.id) this.elements.set(element.id, element);
  }

  createElement(tagName) {
    return new FakeElement(tagName, this);
  }

  getElementById(id) {
    return this.elements.get(id) || null;
  }

  element(id, tagName = "div") {
    const element = this.createElement(tagName);
    element.setAttribute("id", id);
    this.body.appendChild(element);
    return element;
  }
}

const REQUIRED_IDS = Object.freeze([
  ["scene-mount", "div"],
  ["storefront-shopping-affordance", "button"],
  ["storefront-shopping-panel", "section"],
  ["storefront-shopping-title", "h2"],
  ["storefront-shopping-meta", "div"],
  ["btn-storefront-shopping-close", "button"],
  ["storefront-shopping-catalog", "div"],
  ["storefront-shopping-detail", "section"],
  ["storefront-shopping-basket-count", "span"],
  ["storefront-shopping-basket", "div"],
  ["storefront-shopping-status", "p"],
]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function fixtureSummary() {
  const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8"));
  const stores = fixture.nodes.filter((node) => node.webofworlds_extension?.role === "storefront");
  if (MUTATION === "duplicate_item_id") {
    stores[0].webofworlds_extension.shopping.catalog[1].item_id =
      stores[0].webofworlds_extension.shopping.catalog[0].item_id;
  } else if (MUTATION === "missing_catalog") {
    delete stores.find((node) => node.webofworlds_extension.category === "food")
      .webofworlds_extension.shopping.catalog;
  } else if (MUTATION === "radius_zero") {
    stores[0].webofworlds_extension.shopping.interaction_radius_m = 0;
  }
  const built = {
    root: new THREE.Group(),
    render_summary: { rendered: { rendered_nodes: fixture.nodes.length } },
  };
  return mountAirportTerminalContent(fixture, built, THREE, {});
}

function environment() {
  const documentTarget = new FakeDocument();
  for (const [id, tag] of REQUIRED_IDS) documentTarget.element(id, tag);
  documentTarget.getElementById("storefront-shopping-panel").hidden = true;
  documentTarget.getElementById("storefront-shopping-affordance").hidden = true;
  let releaseCount = 0;
  const toasts = [];
  const controller = createAirportStorefrontInteractionController({
    isPlayer: true,
    documentTarget,
    lookup: (id) => documentTarget.getElementById(id),
    createElement: (tagName) => documentTarget.createElement(tagName),
    releaseMovement: () => { releaseCount += 1; },
    focusFallback: () => documentTarget.getElementById("scene-mount"),
    showToast: (...args) => toasts.push(args),
    logger: () => {},
    isTypingTarget: (target) => ["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName),
  });
  return {
    controller,
    documentTarget,
    toasts,
    releaseCount: () => releaseCount,
  };
}

function store(summary, category) {
  return summary.storefronts.find((entry) => entry.category === category);
}

const summary = fixtureSummary();
const contract = createAirportStorefrontCatalogContract(summary);
assert.equal(summary.storefront_count, 4);
assert.equal(contract.ok, true);
assert.equal(contract.ready_count, 3, "three distinct available catalogs must remain ready");
assert.deepEqual(
  contract.stores.map((entry) => entry.category).sort(),
  ["coffee", "duty-free", "food", "news"],
);
assert.equal(new Set(contract.stores.flatMap((entry) => entry.items.map((item) => item.item_id))).size, 10);
assert.equal(contract.stores.find((entry) => entry.category === "duty-free").catalog_state, "unavailable");
assert.equal(AIRPORT_SHOPPING_SESSION_RULE.airport_reentry, "start with an empty local-demo pickup list");

const env = environment();
const { controller, documentTarget } = env;
controller.mount();
const listenerCount = controller.debug().listener_count;
controller.mount();
assert.equal(controller.debug().listener_count, listenerCount, "repeated mount must not duplicate listeners");

const coffee = store(summary, "coffee");
controller.observe({
  locationId: "location-airport",
  avatarPosition: [-4.5, 0.07, coffee.position_m[2]],
  airportTerminal: summary,
});
assert.equal(controller.debug().nearest_store_id, coffee.node_id);
assert.equal(documentTarget.getElementById("storefront-shopping-affordance").hidden, false);

documentTarget.getElementById("storefront-shopping-affordance").focus();
documentTarget.dispatch("keydown", { code: "KeyE", key: "e", target: documentTarget.body });
assert.equal(controller.debug().open_store_id, coffee.node_id, "keyboard E opens nearest storefront");
assert.equal(documentTarget.activeElement, documentTarget.getElementById("btn-storefront-shopping-close"));
assert.ok(env.releaseCount() >= 1, "opening releases any held movement controls");

const secondCoffeeItem = coffee.catalog[1].item_id;
controller.inspect(secondCoffeeItem);
const firstAdd = controller.addSelected();
const repeatedAdd = controller.addSelected();
assert.equal(firstAdd.ok, true);
assert.equal(firstAdd.unchanged, false);
assert.equal(repeatedAdd.unchanged, true);
assert.equal(controller.debug().basket_count, 1, "same selected item appears exactly once");
assert.match(firstAdd.state.status, /No order or purchase occurred/);
assert.equal(env.toasts.length, 1, "duplicate add does not duplicate toast or pickup entry");

const key = controller.debug().basket[0].key;
const removed = controller.removeItem(key);
assert.equal(removed.unchanged, false);
assert.equal(controller.debug().basket_count, 0);

controller.close("button");
assert.equal(documentTarget.activeElement, documentTarget.getElementById("storefront-shopping-affordance"));
assert.equal(controller.debug().open_store_id, null);
controller.openNearest("pointer");
controller.close("button");
controller.openNearest("pointer");
assert.equal(controller.debug().listener_count, listenerCount, "repeated open/close keeps one listener set");

controller.observe({
  locationId: "location-airport",
  avatarPosition: [0, 0.07, 0],
  airportTerminal: summary,
});
assert.equal(controller.debug().last_close_reason, "left_range");
assert.equal(documentTarget.activeElement, documentTarget.getElementById("scene-mount"));

const news = store(summary, "news");
controller.observe({
  locationId: "location-airport",
  avatarPosition: [4.5, 0.07, news.position_m[2]],
  airportTerminal: summary,
});
controller.openNearest("pointer");
controller.addSelected();
assert.equal(controller.debug().basket_count, 1, "pickup state persists while remaining in airport");
controller.observe({ locationId: "location-lobby", avatarPosition: [0, 0, 0], airportTerminal: null });
assert.equal(controller.debug().basket_count, 0, "airport exit clears pickup state");
assert.equal(controller.debug().open_store_id, null);
controller.observe({
  locationId: "location-airport",
  avatarPosition: [4.5, 0.07, news.position_m[2]],
  airportTerminal: summary,
});
assert.equal(controller.debug().basket_count, 0, "airport re-entry deterministically starts empty");

const dutyFree = store(summary, "duty-free");
controller.observe({
  locationId: "location-airport",
  avatarPosition: [-4.5, 0.07, dutyFree.position_m[2]],
  airportTerminal: summary,
});
controller.openNearest("pointer");
assert.equal(controller.debug().storefronts.find((entry) => entry.category === "duty-free").catalog_state, "unavailable");
assert.equal(controller.debug().selected_item_id, null);
controller.close("button");

const emptySummary = clone(summary);
emptySummary.storefronts.find((entry) => entry.category === "food").catalog = [];
const food = store(emptySummary, "food");
controller.observe({ locationId: "location-airport", avatarPosition: [4.5, 0.07, food.position_m[2]], airportTerminal: emptySummary });
controller.openNearest("pointer");
assert.equal(controller.debug().storefronts.find((entry) => entry.category === "food").catalog_state, "empty");
controller.close("button");

const malformedSummary = clone(summary);
delete malformedSummary.storefronts.find((entry) => entry.category === "coffee").catalog[0].name;
const malformedCoffee = store(malformedSummary, "coffee");
controller.observe({
  locationId: "location-airport",
  avatarPosition: [-4.5, 0.07, malformedCoffee.position_m[2]],
  airportTerminal: malformedSummary,
});
controller.openNearest("pointer");
const malformedState = controller.debug().storefronts.find((entry) => entry.category === "coffee");
assert.equal(malformedState.catalog_state, "malformed");
assert.match(malformedState.catalog_errors.join("; "), /missing name/);
assert.equal(controller.addSelected().ok, false, "malformed catalog cannot add an item");

const movementKey = documentTarget.dispatch("keydown", {
  code: "KeyW",
  key: "w",
  target: documentTarget.getElementById("btn-storefront-shopping-close"),
});
assert.equal(movementKey.defaultPrevented, true);
assert.equal(movementKey.propagationStopped, true);

controller.dispose();
assert.equal(controller.debug().mounted, false);
assert.equal(controller.debug().listener_count, 0);

const controllerSource = fs.readFileSync(CONTROLLER_PATH, "utf8");
const appSource = fs.readFileSync(APP_PATH, "utf8");
const indexSource = fs.readFileSync(INDEX_PATH, "utf8");
const movementSource = fs.readFileSync(MOVEMENT_PATH, "utf8");
assert.equal((controllerSource.match(/export function createAirportStorefrontInteractionController/g) || []).length, 1);
assert.match(appSource, /createAirportStorefrontInteractionController\(\{/);
assert.match(appSource, /storefrontShoppingController\.observe\(\{/);
assert.match(appSource, /storefrontShopping: storefrontShoppingController\.driver\(\)/);
assert.match(indexSource, /Session-local selection only\. No order, payment,/);
assert.match(indexSource, /role="dialog" aria-modal="false"/);
assert.match(movementSource, /releaseControls: resetControlState/);
assert.doesNotMatch(indexSource, /Pay now|Checkout|Purchase complete/i);

if (!MUTATION) {
  for (const arm of ["duplicate_item_id", "missing_catalog", "radius_zero"]) {
    const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
      cwd: ROOT,
      env: { ...process.env, feature_MUTATION: arm },
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0, `controlled mutation ${arm} must make the focused check RED`);
  }
  console.log(`feature_AIRPORT_SHOPPING_CHECK PASS stores=4 ready=3 mutations=3 listeners=${listenerCount}`);
}
