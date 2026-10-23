#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { mountAirportTerminalContent } from "../web/airport-terminal-scene.mjs";
import {
  AIRPORT_BOARDING_SESSION_RULE,
  classifyAirportBoardingCredential,
  createAirportBoardingContract,
  createAirportBoardingJourneyController,
} from "../web/airport-boarding-journey-controller.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_PATH = path.join(ROOT, "web/worlds/denver-skyport.json");
const CONTROLLER_PATH = path.join(ROOT, "web/airport-boarding-journey-controller.mjs");
const APP_PATH = path.join(ROOT, "web/app.js");
const INDEX_PATH = path.join(ROOT, "web/index.html");
const MUTATION = process.env.feature_MUTATION || "";

class FakeElement {
  constructor(tagName, documentTarget) {
    this.tagName = String(tagName).toUpperCase();
    this.ownerDocument = documentTarget;
    this.listeners = new Map();
    this.attributes = new Map();
    this.dataset = {};
    this.hidden = false;
    this.disabled = false;
    this.id = "";
    this.value = "";
    this.textContent = "";
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

  getElementById(id) {
    return this.elements.get(id) || null;
  }

  element(id, tagName = "div") {
    const element = new FakeElement(tagName, this);
    element.setAttribute("id", id);
    return element;
  }
}

const REQUIRED_IDS = Object.freeze([
  ["scene-mount", "div"],
  ["boarding-journey-affordance", "button"],
  ["boarding-journey-panel", "section"],
  ["boarding-journey-title", "h2"],
  ["boarding-journey-meta", "div"],
  ["btn-boarding-close", "button"],
  ["boarding-progress-ready", "li"],
  ["boarding-progress-admitted", "li"],
  ["boarding-progress-boarding", "li"],
  ["boarding-progress-completed", "li"],
  ["boarding-credential-input", "input"],
  ["boarding-credential-hint", "div"],
  ["btn-boarding-validate", "button"],
  ["btn-boarding-cancel", "button"],
  ["boarding-journey-status", "p"],
]);

function fixtureSummary() {
  const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8"));
  const gate = fixture.nodes.find((node) => node.webofworlds_extension?.role === "flight-gate");
  if (MUTATION === "wrong_flight_binding") gate.webofworlds_extension.boarding.flight_number = "DS 999";
  if (MUTATION === "threshold_wrong_direction") gate.webofworlds_extension.boarding.threshold.crossing_direction = "-z";
  if (MUTATION === "credential_acceptance") gate.webofworlds_extension.boarding.credential.accepted_value = "OSL-DEMO-DS482-A13";
  const built = {
    root: new THREE.Group(),
    render_summary: { rendered: { rendered_nodes: fixture.nodes.length } },
  };
  const summary = mountAirportTerminalContent(fixture, built, THREE, {});
  return { fixture, built, summary };
}

function environment() {
  const documentTarget = new FakeDocument();
  for (const [id, tag] of REQUIRED_IDS) documentTarget.element(id, tag);
  documentTarget.getElementById("boarding-journey-panel").hidden = true;
  documentTarget.getElementById("boarding-journey-affordance").hidden = true;
  let releases = 0;
  const toasts = [];
  const notifications = [];
  const activities = [];
  let tick = 0;
  const controller = createAirportBoardingJourneyController({
    isPlayer: true,
    documentTarget,
    lookup: (id) => documentTarget.getElementById(id),
    releaseMovement: () => { releases += 1; },
    focusFallback: () => documentTarget.getElementById("scene-mount"),
    showToast: (...args) => toasts.push(args),
    publishNotification: (record) => notifications.push(JSON.parse(JSON.stringify(record))),
    logger: (message) => activities.push(message),
    isTypingTarget: (target) => ["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName),
    nowIso: () => `2026-07-16T23:20:${String(tick++).padStart(2, "0")}Z`,
  });
  return { controller, documentTarget, toasts, notifications, activities, releases: () => releases };
}

function observe(controller, summary, position, locationId = "location-airport") {
  return controller.observe({
    locationId,
    avatarPosition: position,
    airportTerminal: locationId === "location-airport" ? summary : null,
  });
}

const { built, summary } = fixtureSummary();
const contract = createAirportBoardingContract(summary);
assert.equal(contract.ok, true, contract.errors.join("; "));
assert.equal(contract.source, "airport_terminal.gate.boarding");
assert.equal(contract.flight_id, "osl-demo-ds482");
assert.equal(contract.flight_number, "DS 482");
assert.equal(contract.gate_id, "A12");
assert.equal(contract.destination_label, "Seattle");
assert.equal(contract.credential.accepted_value, "OSL-DEMO-DS482-A12");
assert.equal(contract.threshold.crossing_direction, "+z");
assert.ok(contract.threshold.center_m[2] > contract.components.entry_z_m);
assert.match(contract.provenance, /OSL-authored local-demo/);
assert.match(contract.claim_boundary, /not a ticket/);
assert.equal(AIRPORT_BOARDING_SESSION_RULE.airport_exit, "clear the journey and completion count; re-entry starts unstarted");
assert.equal(classifyAirportBoardingCredential("", contract).state, "missing");
assert.equal(classifyAirportBoardingCredential("not-a-credential", contract).state, "invalid");
assert.equal(classifyAirportBoardingCredential("OSL-DEMO-DS999-A12", contract).state, "wrong_flight");
assert.equal(classifyAirportBoardingCredential("OSL-DEMO-DS482-A12", contract).state, "valid");
const farFromGate = [0, 0.07, contract.approach.position_m[2] - contract.approach.interaction_radius_m - 1];
const nearGate = [0, 0.07, contract.approach.position_m[2]];
const boardingLane = [0, 0.07, contract.components.entry_z_m + 0.2];
const crossedThreshold = [0, 0.07, contract.threshold.center_m[2] + 0.2];
const beyondThreshold = [0, 0.07, contract.threshold.center_m[2] + 0.6];

const sceneObjects = [];
built.root.traverse((object) => sceneObjects.push(object.name));
assert.equal(sceneObjects.filter((name) => name === "gate-a12-boarding-components").length, 1);
assert.equal(sceneObjects.filter((name) => name === "gate-a12-boarding-threshold").length, 1);

const env = environment();
const { controller, documentTarget } = env;
controller.mount();
const listenerCount = controller.debug().listener_count;
controller.mount();
assert.equal(controller.debug().listener_count, listenerCount, "repeated mount must not duplicate listeners");

observe(controller, summary, farFromGate);
assert.equal(controller.debug().phase, "idle");
assert.equal(documentTarget.getElementById("boarding-journey-affordance").hidden, true);
observe(controller, summary, nearGate);
assert.equal(controller.debug().phase, "ready");
assert.equal(controller.debug().near_gate, true);
assert.equal(documentTarget.getElementById("boarding-journey-affordance").hidden, false);
assert.equal(env.notifications.filter((record) => record.event_type === "ready").length, 1);

documentTarget.getElementById("boarding-journey-affordance").focus();
documentTarget.dispatch("keydown", { code: "KeyE", key: "e", target: documentTarget.body });
assert.equal(controller.debug().panel_open, true);
assert.equal(documentTarget.activeElement, documentTarget.getElementById("boarding-credential-input"));
assert.ok(env.releases() >= 1, "opening clears held movement controls");

let result = controller.validate();
assert.equal(result.ok, false);
assert.equal(controller.debug().credential_state, "missing");
assert.equal(controller.debug().phase, "rejected");
assert.equal(controller.debug().panel_open, true);
assert.match(documentTarget.getElementById("boarding-journey-status").textContent, /Correct the value and retry/);

const focusedCredential = documentTarget.getElementById("boarding-credential-input");
focusedCredential.value = "not-a-credential";
observe(controller, summary, nearGate);
assert.equal(focusedCredential.value, "not-a-credential", "live renders preserve a focused edit before its input event");
focusedCredential.dispatch("input");
result = controller.validate();
assert.equal(result.credential_state, "invalid");
controller.setCredential("OSL-DEMO-DS999-A12");
result = controller.validate();
assert.equal(result.credential_state, "wrong_flight");
assert.equal(documentTarget.activeElement, documentTarget.getElementById("boarding-credential-input"));

controller.setCredential("OSL-DEMO-DS482-A12");
result = controller.validate();
assert.equal(result.ok, true);
assert.equal(controller.debug().phase, "admitted");
assert.equal(controller.debug().panel_open, false);
assert.equal(controller.debug().completion_count, 0, "credential submission cannot complete remotely");
assert.equal(documentTarget.activeElement, documentTarget.getElementById("scene-mount"));
assert.equal(env.notifications.filter((record) => record.event_type === "admitted").length, 1);

observe(controller, summary, boardingLane);
assert.equal(controller.debug().phase, "boarding");
assert.equal(controller.debug().completion_count, 0);
observe(controller, summary, crossedThreshold);
assert.equal(controller.debug().phase, "completed");
assert.equal(controller.debug().completion_count, 1);
observe(controller, summary, beyondThreshold);
observe(controller, summary, crossedThreshold);
assert.equal(controller.debug().completion_count, 1, "completion stays exactly once");
assert.equal(env.notifications.filter((record) => record.event_type === "completed").length, 1);
assert.match(controller.debug().status, /completed once after physical threshold crossing/);

observe(controller, null, [0, 0, 0], "location-lobby");
assert.equal(controller.debug().phase, "idle");
assert.equal(controller.debug().completion_count, 0);
assert.equal(controller.debug().admitted, false);
assert.equal(controller.debug().last_reset_reason, "airport_exit");
observe(controller, summary, farFromGate);
assert.equal(controller.debug().phase, "idle");
observe(controller, summary, nearGate);
assert.equal(controller.debug().phase, "ready", "airport re-entry starts unstarted and becomes ready only on approach");

controller.open("pointer");
controller.setCredential("OSL-DEMO-DS482-A12");
controller.validate();
observe(controller, summary, farFromGate);
assert.equal(controller.debug().phase, "admitted", "same-airport walk-away preserves admission for deterministic resume");
observe(controller, summary, boardingLane);
assert.equal(controller.debug().phase, "boarding");
controller.cancel("cancelled");
assert.equal(controller.debug().phase, "ready");
assert.equal(controller.debug().admitted, false);
observe(controller, summary, crossedThreshold);
assert.equal(controller.debug().completion_count, 0, "cancelled admission cannot ghost-complete");

observe(controller, summary, nearGate);
controller.open("pointer");
controller.setCredential("OSL-DEMO-DS482-A12");
controller.validate();
observe(controller, summary, boardingLane);
observe(controller, summary, crossedThreshold);
assert.equal(controller.debug().completion_count, 1);
controller.reset("new_session");
assert.equal(controller.debug().phase, "idle");
assert.equal(controller.debug().completion_count, 0);
assert.equal(controller.debug().credential_state, "unvalidated");
observe(controller, summary, nearGate);
assert.equal(controller.debug().phase, "ready");

controller.open("pointer");
const movementEvent = documentTarget.dispatch("keydown", {
  code: "KeyW",
  key: "w",
  target: documentTarget.getElementById("boarding-credential-input"),
});
assert.notEqual(movementEvent.defaultPrevented, true, "typing keeps native key input while avatar movement remains suppressed");
assert.equal(movementEvent.propagationStopped, true);
documentTarget.dispatch("keydown", { code: "Escape", key: "Escape", target: documentTarget.getElementById("boarding-credential-input") });
assert.equal(controller.debug().panel_open, false);
assert.ok(
  [documentTarget.getElementById("boarding-journey-affordance"), documentTarget.getElementById("scene-mount")]
    .includes(documentTarget.activeElement),
  "closing restores a safe world or interaction focus target",
);

assert.ok(env.notifications.length >= 10);
assert.ok(env.activities.some((message) => /credential_rejected_missing/.test(message)));
assert.ok(env.activities.some((message) => /physical threshold/.test(message)));
assert.ok(env.toasts.some((toast) => toast[0] === "Credential rejected"));
assert.ok(env.toasts.some((toast) => toast[0] === "Local-demo boarding complete"));
assert.ok(env.notifications.every((record) => /not a ticket/.test(record.claim_boundary)));

controller.dispose();
assert.equal(controller.debug().mounted, false);
assert.equal(controller.debug().listener_count, 0);
assert.equal(documentTarget.body.getAttribute("data-airport-boarding-phase"), null);

const controllerSource = fs.readFileSync(CONTROLLER_PATH, "utf8");
const appSource = fs.readFileSync(APP_PATH, "utf8");
const indexSource = fs.readFileSync(INDEX_PATH, "utf8");
assert.equal((controllerSource.match(/export function createAirportBoardingJourneyController/g) || []).length, 1);
assert.match(appSource, /createAirportBoardingJourneyController\(\{/);
assert.match(appSource, /boardingJourneyController\.observe\(\{/);
assert.match(appSource, /airportBoarding: boardingJourneyController\.driver\(\)/);
assert.match(appSource, /publishNotification: publishNotificationRecord/);
assert.match(appSource, /logger: logLine/);
assert.equal((indexSource.match(/data-testid="boarding-journey-affordance"/g) || []).length, 1);
assert.equal((indexSource.match(/data-testid="boarding-journey-panel"/g) || []).length, 1);
assert.match(indexSource, /role="dialog" aria-modal="false"/);
assert.match(indexSource, /This is not a ticket, airline connection,/);
assert.doesNotMatch(controllerSource, /airline API|identity verified|security cleared|authorized to travel/i);

if (!MUTATION) {
  for (const arm of ["wrong_flight_binding", "threshold_wrong_direction", "credential_acceptance"]) {
    const mutation = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
      cwd: ROOT,
      env: { ...process.env, feature_MUTATION: arm },
      encoding: "utf8",
    });
    assert.notEqual(mutation.status, 0, `controlled mutation ${arm} must make the focused check RED`);
  }
  console.log(`feature_AIRPORT_BOARDING_CHECK PASS phase=${controller.debug().phase} mutations=3 listeners=${listenerCount} notifications=${env.notifications.length}`);
}
