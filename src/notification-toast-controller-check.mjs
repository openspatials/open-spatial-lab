import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const CONTROLLER_PATH = path.join(ROOT, "web", "notification-toast-controller.mjs");
const APP_PATH = path.join(ROOT, "web", "app.js");
const INDEX_PATH = path.join(ROOT, "web", "index.html");
const controllerSource = fs.readFileSync(CONTROLLER_PATH, "utf8");
const appSource = fs.readFileSync(APP_PATH, "utf8");
const indexSource = fs.readFileSync(INDEX_PATH, "utf8");
const { createNotificationToastController } = await import(pathToFileURL(CONTROLLER_PATH));

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
  constructor(tagName) {
    super();
    this.tagName = String(tagName).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.dataset = {};
    this.className = "";
    this.hidden = false;
    this.id = "";
    this.title = "";
    this.type = "";
    this._textContent = "";
  }

  get classList() {
    return {
      add: (...names) => {
        const values = new Set(this.className.split(/\s+/).filter(Boolean));
        names.forEach((name) => values.add(name));
        this.className = [...values].join(" ");
      },
      remove: (...names) => {
        const removed = new Set(names);
        this.className = this.className.split(/\s+/).filter((name) => name && !removed.has(name)).join(" ");
      },
      contains: (name) => this.className.split(/\s+/).includes(name),
    };
  }

  get firstElementChild() {
    return this.children[0] || null;
  }

  get offsetWidth() {
    return 100;
  }

  get innerHTML() {
    return this.children.map((child) => child.textContent).join("");
  }

  set innerHTML(value) {
    this.children.forEach((child) => { child.parentNode = null; });
    this.children = [];
    this._textContent = String(value || "");
  }

  get textContent() {
    return this.children.length
      ? this.children.map((child) => child.textContent).join("")
      : this._textContent;
  }

  set textContent(value) {
    this.innerHTML = "";
    this._textContent = String(value ?? "");
  }

  append(...children) {
    children.forEach((child) => this.appendChild(child));
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    this._textContent = "";
    return child;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }
}

function makeEnvironment(factory = createNotificationToastController) {
  const elements = new Map();
  const register = (id, tag = "div") => {
    const element = new FakeElement(tag);
    element.id = id;
    elements.set(id, element);
    return element;
  };
  const body = register("body", "body");
  const eventTarget = new FakeEventTarget();
  const sceneMount = register("scene-mount");
  const toggle = register("btn-notifications", "button");
  const closeButton = register("btn-notifications-close", "button");
  const center = register("notification-center", "section");
  const list = register("notification-list");
  const detail = register("notification-detail");
  const centerSummary = register("notification-summary");
  const badge = register("notification-count-badge");
  let timerId = 0;
  const timers = new Map();
  const lookup = (id) => {
    if (elements.has(id)) return elements.get(id);
    const stack = sceneMount.children.find((child) => child.id === id) || null;
    if (stack) elements.set(id, stack);
    return stack;
  };
  const environment = {
    elements,
    body,
    eventTarget,
    sceneMount,
    toggle,
    closeButton,
    center,
    list,
    detail,
    centerSummary,
    badge,
    timers,
    runTimer(delay) {
      const match = [...timers.entries()].find(([, timer]) => timer.delay === delay);
      assert.ok(match, `missing ${delay} ms timer`);
      timers.delete(match[0]);
      match[1].callback();
    },
  };
  environment.controller = factory({
    lookup,
    createElement: (tagName) => new FakeElement(tagName),
    body,
    eventTarget,
    nowMs: () => 1700000000000,
    nowIso: () => "2026-07-14T13:15:00.000Z",
    formatTime: (raw) => `time:${raw}`,
    setTimer: (callback, delay) => {
      timerId += 1;
      timers.set(timerId, { callback, delay });
      return timerId;
    },
    clearTimer: (id) => timers.delete(id),
    escapeHtml: (value) => String(value == null ? "" : value).replace(/[&<>"']/g, (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[character])),
    isTypingTarget: (target) => ["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName) || target?.isContentEditable === true,
    logger: () => {},
  });
  return environment;
}

const checks = [];
function check(label, callback) {
  callback();
  checks.push(label);
  console.log(`PASS ${String(checks.length).padStart(2, "0")} ${label}`);
}

const env = makeEnvironment();
const controller = env.controller;

check("mount is idempotent and renders the empty compatibility chrome", () => {
  assert.equal(controller.mount(), controller);
  controller.mount();
  assert.equal(env.toggle.listenerCount("click"), 1);
  assert.equal(env.closeButton.listenerCount("click"), 1);
  assert.equal(env.eventTarget.listenerCount("keydown"), 1);
  assert.equal(env.body.getAttribute("data-notification-count"), "0");
  assert.equal(env.badge.textContent, "0");
  assert.equal(env.toggle.getAttribute("aria-expanded"), "false");
  assert.equal(env.list.firstElementChild?.textContent, "No records");
  assert.equal(env.detail.textContent, "—");
});

const original = { kind: "portal_through_loading", title: "Arrival <safe>", status: "warm" };
check("publish assigns deterministic identity/time and snapshots are stable copies", () => {
  controller.publish(original);
  assert.equal(original.id, "notification-1700000000000-1");
  assert.equal(original.created_at, "2026-07-14T13:15:00.000Z");
  const copy = controller.snapshot();
  copy[0].title = "mutated copy";
  assert.equal(controller.snapshot()[0].title, "Arrival <safe>");
  assert.equal(controller.count(), 1);
  assert.equal(controller.latestByKind("portal_through_loading"), original.id);
});

check("replacement by id preserves count and installs the replacement reference", () => {
  controller.publish({ id: original.id, kind: "portal_through_loading", title: "Replaced", status: "complete" });
  assert.equal(controller.count(), 1);
  assert.equal(controller.snapshot()[0].title, "Replaced");
});

check("record limit is 50 and selection falls back to the newest retained record", () => {
  controller.open(original.id);
  for (let index = 0; index < 55; index += 1) {
    controller.publish({ id: `bounded-${index}`, kind: "bounded", title: `Bounded ${index}` });
  }
  assert.equal(controller.count(), 50);
  assert.equal(controller.snapshot()[0].id, "bounded-5");
  assert.equal(controller.selected(), "bounded-49");
  assert.equal(env.body.getAttribute("data-notification-count"), "50");
  assert.equal(env.list.children[0].dataset.notificationId, "bounded-54");
});

const rich = {
  id: "rich-record",
  kind: "fabric_prefetch_event",
  event_type: "destination_ready",
  status: "warm",
  summary: "World B ready",
  completed_at: "2026-07-14T13:16:00.000Z",
  source: { location_id: "world-a", world_id: "a" },
  destination: { location_id: "world-b", world_title: "World B" },
  crossing: { handoff_id: "handoff-1" },
  transfer: { controls_resume_ms: 42 },
  prefetch: { status: "warm", address: { location_id: "world-b" } },
  region: { totals: { region_entities: 3, fabric_entities: 7 } },
  occupancy: { avatars: [{ id: "p1" }], arrival_count: 2 },
  honesty: { demonstration_only: true, standards_conformance: false },
  steps: [{ id: "load", label: "Load", done: true, done_at: "now" }],
};
check("reverse-chronology list and detail rendering preserve rows, steps, and textContent safety", () => {
  controller.publish(rich);
  controller.open(rich.id);
  assert.equal(env.list.children[0].dataset.notificationId, rich.id);
  assert.equal(env.list.children[0].getAttribute("data-testid"), "notification-row-fabric_prefetch_event");
  assert.match(env.detail.textContent, /destination_ready/);
  assert.match(env.detail.textContent, /world-a/);
  assert.match(env.detail.textContent, /world-b/);
  assert.match(env.detail.textContent, /handoff-1/);
  assert.match(env.detail.textContent, /42 ms/);
  assert.match(env.detail.textContent, /3\/7 entities/);
  assert.match(env.detail.textContent, /done · Load · now/);
  assert.equal(env.detail.children[0].textContent, "destination_ready");
});

check("toggle, close, Escape, and typing guards preserve open-state behavior", () => {
  controller.close();
  env.toggle.dispatchEvent({ type: "click" });
  assert.equal(controller.isOpen(), true);
  assert.equal(env.toggle.getAttribute("aria-expanded"), "true");
  env.eventTarget.dispatchEvent({ type: "keydown", key: "Escape", target: { tagName: "INPUT" } });
  assert.equal(controller.isOpen(), true);
  env.eventTarget.dispatchEvent({ type: "keydown", key: "Escape", target: { tagName: "DIV" } });
  assert.equal(controller.isOpen(), false);
  controller.open();
  env.closeButton.dispatchEvent({ type: "click" });
  assert.equal(controller.isOpen(), false);
});

check("notification row clicks select and open the requested record", () => {
  controller.open();
  const targetRow = env.list.children.find((row) => row.dataset.notificationId === "bounded-53");
  targetRow.dispatchEvent({ type: "click" });
  assert.equal(controller.selected(), "bounded-53");
  assert.equal(controller.isOpen(), true);
});

check("toast creation preserves class/text safety and click-through to detail", () => {
  controller.show("<b>Arrival</b>", "Destination & ready", 'toast-arrived" unsafe', { notificationId: rich.id });
  const stack = env.sceneMount.firstElementChild;
  const toast = stack.firstElementChild;
  assert.equal(stack.id, "toast-stack");
  assert.equal(stack.getAttribute("aria-live"), "polite");
  assert.equal(toast.children[0].textContent, "<b>Arrival</b>");
  assert.equal(toast.children[1].textContent, "Destination & ready");
  assert.match(toast.className, /toast-visible/);
  assert.match(toast.className, /&quot;/);
  controller.close();
  toast.dispatchEvent({ type: "click" });
  assert.equal(controller.isOpen(), true);
  assert.equal(controller.selected(), rich.id);
});

check("every toast kind shares the canonical below-header shell boundary", () => {
  const toastRule = indexSource.match(/\.toast-stack\s*\{[^}]*\}/)?.[0] || "";
  assert.match(indexSource, /--osl-panel-top:\s*calc\(var\(--osl-glass-edge\) \+ var\(--osl-shell-header-height\) \+ var\(--osl-glass-gap\)\);/);
  assert.match(toastRule, /top:\s*var\(--osl-panel-top\);/);
  assert.doesNotMatch(toastRule, /top:\s*14px;/);
});

check("toast replacement clears the prior timer and dismissal honors 3500 plus 220 ms", () => {
  const firstToast = env.sceneMount.firstElementChild.firstElementChild;
  controller.show("Replacement", "Second", "toast-departed", { notificationId: "bounded-54" });
  const stack = env.sceneMount.firstElementChild;
  const replacement = stack.firstElementChild;
  assert.notEqual(replacement, firstToast);
  assert.equal(env.timers.size, 1);
  assert.equal(firstToast.listenerCount("click"), 0);
  env.runTimer(3500);
  assert.equal(replacement.classList.contains("toast-visible"), false);
  assert.equal(stack.firstElementChild, replacement);
  env.runTimer(220);
  assert.equal(stack.firstElementChild, null);
  assert.equal(env.timers.size, 0);
});

check("dispose is idempotent and clears every mounted listener, row listener, and toast timer", () => {
  controller.open();
  const row = env.list.children[0];
  controller.show("Disposable", "Timer", "toast-arrived", { notificationId: rich.id });
  assert.equal(env.timers.size, 1);
  controller.dispose();
  controller.dispose();
  assert.equal(env.toggle.listenerCount("click"), 0);
  assert.equal(env.closeButton.listenerCount("click"), 0);
  assert.equal(env.eventTarget.listenerCount("keydown"), 0);
  assert.equal(row.listenerCount("click"), 0);
  assert.equal(env.timers.size, 0);
  assert.equal(env.sceneMount.firstElementChild.firstElementChild, null);
});

check("remount restores exactly one listener set without losing bounded state", () => {
  controller.mount();
  controller.mount();
  assert.equal(env.toggle.listenerCount("click"), 1);
  assert.equal(env.closeButton.listenerCount("click"), 1);
  assert.equal(env.eventTarget.listenerCount("keydown"), 1);
  assert.equal(controller.count(), 50);
  controller.close();
  env.toggle.dispatchEvent({ type: "click" });
  assert.equal(controller.isOpen(), true);
});

check("app publishes the unchanged notifications compatibility API through controller delegates", () => {
  assert.match(appSource, /import \{ createNotificationToastController \} from "\.\/notification-toast-controller\.mjs";/);
  assert.match(appSource, /window\.__assembly\.notifications = \{[\s\S]*list: \(\) => notificationToastController\.snapshot\(\),[\s\S]*count: \(\) => notificationToastController\.count\(\),[\s\S]*open: \(id\) => openNotificationCenter\(id\),[\s\S]*close: \(\) => closeNotificationCenter\(\),[\s\S]*selected: \(\) => notificationToastController\.selected\(\),[\s\S]*isOpen: \(\) => notificationToastController\.isOpen\(\),[\s\S]*\};/);
  assert.match(appSource, /function showToast\(big, sub, cls, opts = \{\}\) \{\s*notificationToastController\.show\(big, sub, cls, opts\);\s*\}/);
  assert.match(appSource, /function publishNotificationRecord\(record\) \{\s*notificationToastController\.publish\(record\);\s*\}/);
  assert.match(appSource, /function latestNotificationIdByKind\(kind\) \{\s*return notificationToastController\.latestByKind\(kind\);\s*\}/);
});

check("dependency direction and canonical ownership exclude app, adapter, scene, network, and duplicate stores", () => {
  assert.doesNotMatch(controllerSource, /^\s*import\s/m);
  for (const forbidden of ["LiveAdapter", "THREE", "player-session", "fetch(", "WebSocket", "BroadcastChannel", "XMLHttpRequest"]) {
    assert.equal(controllerSource.includes(forbidden), false, `forbidden controller dependency ${forbidden}`);
  }
  for (const formerOwner of ["notificationRecords", "notificationCenterOpen", "selectedNotificationId", "toastDismissTimer", "NOTIFICATION_RECORD_LIMIT"]) {
    assert.equal(appSource.includes(formerOwner), false, `duplicate app owner ${formerOwner}`);
  }
  assert.equal((controllerSource.match(/const NOTIFICATION_RECORD_LIMIT = 50;/g) || []).length, 1);
  assert.equal((controllerSource.match(/export function createNotificationToastController/g) || []).length, 1);
});

async function mutatedFactory(label, originalText, replacementText) {
  assert.ok(controllerSource.includes(originalText), `${label} mutation target missing`);
  const mutated = controllerSource.replace(originalText, replacementText);
  assert.notEqual(mutated, controllerSource);
  const url = `data:text/javascript;base64,${Buffer.from(mutated).toString("base64")}#${label}`;
  return (await import(url)).createNotificationToastController;
}

const mutationContracts = [
  [
    "listener-disposal",
    "for (const [target, type, handler] of mountedListeners.splice(0)) {\n      target.removeEventListener(type, handler);\n    }",
    "for (const [target, type, handler] of mountedListeners.splice(0)) {\n      void target; void type; void handler;\n    }",
    (candidate) => {
      const candidateEnv = makeEnvironment(candidate);
      candidateEnv.controller.mount();
      candidateEnv.controller.dispose();
      candidateEnv.toggle.dispatchEvent({ type: "click" });
      assert.equal(candidateEnv.controller.isOpen(), false);
    },
  ],
  [
    "toast-timer-cleanup",
    "if (toastDismissTimer) clearTimer(toastDismissTimer);",
    "if (false && toastDismissTimer) clearTimer(toastDismissTimer);",
    (candidate) => {
      const candidateEnv = makeEnvironment(candidate);
      candidateEnv.controller.show("first", "", "toast-arrived");
      candidateEnv.controller.show("second", "", "toast-arrived");
      assert.equal(candidateEnv.timers.size, 1);
    },
  ],
  [
    "record-bound-selection",
    "if (records.length > NOTIFICATION_RECORD_LIMIT) {",
    "if (false && records.length > NOTIFICATION_RECORD_LIMIT) {",
    (candidate) => {
      const candidateEnv = makeEnvironment(candidate);
      for (let index = 0; index < 51; index += 1) candidateEnv.controller.publish({ id: `record-${index}` });
      assert.equal(candidateEnv.controller.count(), 50);
      assert.equal(candidateEnv.controller.selected(), "record-50");
    },
  ],
];

let mutationsCaught = 0;
for (const [label, originalText, replacementText, contract] of mutationContracts) {
  const factory = await mutatedFactory(label, originalText, replacementText);
  try {
    contract(factory);
    throw new Error(`${label} mutation stayed GREEN`);
  } catch (error) {
    if (error.message === `${label} mutation stayed GREEN`) throw error;
    mutationsCaught += 1;
    console.log(`RED_CAUGHT ${label}`);
  }
}

check("material listener, toast-timer, and record-bound mutations all turn RED", () => {
  assert.equal(mutationsCaught, 3);
});

let toastGeometryMutationCaught = false;
const mutatedIndexSource = indexSource.replace("top: var(--osl-panel-top);", "top: 14px;");
assert.notEqual(mutatedIndexSource, indexSource, "toast geometry mutation target missing");
try {
  const toastRule = mutatedIndexSource.match(/\.toast-stack\s*\{[^}]*\}/)?.[0] || "";
  assert.match(toastRule, /top:\s*var\(--osl-panel-top\);/);
  throw new Error("toast-geometry mutation stayed GREEN");
} catch (error) {
  if (error.message === "toast-geometry mutation stayed GREEN") throw error;
  toastGeometryMutationCaught = true;
  console.log("RED_CAUGHT toast-geometry-top-14px");
}

check("restoring the regressed top 14px geometry turns RED", () => {
  assert.equal(toastGeometryMutationCaught, true);
});

console.log(`feature_NOTIFICATION_TOAST_CONTROLLER PASS ${checks.length}/${checks.length} mutations=${mutationsCaught + Number(toastGeometryMutationCaught)}/${mutationContracts.length + 1}`);
