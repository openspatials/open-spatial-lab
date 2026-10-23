import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evidenceRoot = path.join(
  root,
  "diagnostics",
);
const profilePath = path.join(evidenceRoot, "headed-worker-profile");
const evidencePath = path.join(evidenceRoot, "headed-diagnostics.json");
const ports = Object.freeze({ frontend: 18929, a: 18930, b: 18931, lobby: 18932, airport: 18933 });
const protectedPorts = Object.freeze([8143, 4101, 4102, 4103, 18151, 18152, 18153, 18154]);
const profiles = Object.freeze([
  { name: "desktop-1698", width: 1698, height: 900, minHit: 40, minGap: 7 },
  // The seven remaining Player actions retain the established narrow hit target.
  { name: "narrow-390", width: 390, height: 844, minHit: 30, minGap: 3 },
]);
const controls = Object.freeze([
  { key: "views", id: "btn-views-home", symbol: ".header-action-icon", name: "Open mission views", title: "Open mission views" },
  { key: "camera", id: "btn-camera-toggle", symbol: ".header-action-icon", name: "Toggle first/third-person camera", title: "Toggle first/third-person camera (C)" },
  { key: "avatar", id: "btn-switch-avatar", symbol: ".avatar-switch-label", name: "Switch avatar", title: "Switch avatar" },
  { key: "refresh", id: "btn-refresh-settings", symbol: ".refresh-icon", name: "Open refresh settings", title: "Refresh settings" },
  { key: "notifications", id: "btn-notifications", symbol: ":scope > span[aria-hidden='true']", name: "Open notifications", title: "Notifications" },
  { key: "lobby", id: "btn-return-lobby", symbol: ".lobby-return-label", name: "Return to lobby", title: "Return to lobby" },
  { key: "rail", id: "btn-rail-toggle", symbol: ".rail-icon", name: "Toggle inspector panel", title: "Toggle inspector panel" },
]);
const expectedOrder = controls.map(({ id }) => id);
const expectedSourceOrder = Object.freeze([
  "btn-views-home",
  "btn-camera-toggle",
  "btn-refresh-settings",
  "btn-notifications",
  "btn-rail-toggle",
]);
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

function rectangleOverlap(a, b, tolerance = 0.25) {
  return a.left < b.right - tolerance && a.right > b.left + tolerance
    && a.top < b.bottom - tolerance && a.bottom > b.top + tolerance;
}

function rectangleContains(outer, inner, tolerance = 0.25) {
  return inner.left >= outer.left - tolerance && inner.right <= outer.right + tolerance
    && inner.top >= outer.top - tolerance && inner.bottom <= outer.bottom + tolerance;
}

function assertSameRectangle(actual, expected, label, tolerance = 0.25) {
  for (const key of ["left", "top", "right", "bottom", "width", "height"]) {
    assert.ok(Math.abs(actual[key] - expected[key]) <= tolerance,
      `${label} ${key} moved ${actual[key]} vs ${expected[key]}`);
  }
}

function assertGeometry(profile, snapshot, baseline = null) {
  assert.equal(snapshot.viewport.width, profile.width);
  assert.equal(snapshot.viewport.height, profile.height);
  assert.equal(snapshot.document.scrollWidth <= snapshot.document.clientWidth, true,
    `${profile.name} header introduced horizontal overflow`);
  assert.deepEqual(snapshot.controls.map(({ id }) => id), expectedOrder,
    `${profile.name} state analysis omitted a hidden or visible control`);
  const visible = snapshot.controls.filter(({ visible }) => visible);
  assert.equal(visible.length, controls.length, `${profile.name} initial supported player state must show all seven controls`);
  assert.deepEqual(snapshot.ownerHiddenControls.map(({ id }) => id), [
    "btn-semantic-destinations",
    "btn-runtime-tweaks",
  ]);
  for (const hiddenControl of snapshot.ownerHiddenControls) {
    assert.equal(hiddenControl.visible, false, `${profile.name} ${hiddenControl.id} became visible`);
    assert.equal(hiddenControl.display, "none", `${profile.name} ${hiddenControl.id} retained layout space`);
    assert.equal(hiddenControl.ariaHidden, "true", `${profile.name} ${hiddenControl.id} entered the accessibility tree`);
    assert.equal(hiddenControl.tabIndex, -1, `${profile.name} ${hiddenControl.id} entered keyboard focus order`);
  }
  for (const entry of visible) {
    assert.ok(entry.hit.width >= profile.minHit - 0.25 && entry.hit.height >= profile.minHit - 0.25,
      `${profile.name} ${entry.key} hit target is smaller than ${profile.minHit}px`);
    assert.ok(entry.content.width > 0 && entry.content.height > 0, `${profile.name} ${entry.key} content is empty`);
    assert.ok(rectangleContains(entry.hit, entry.content), `${profile.name} ${entry.key} content escapes its hit target`);
    const containingTargets = visible.filter((candidate) => rectangleContains(candidate.hit, entry.content)).length;
    assert.equal(containingTargets, 1, `${profile.name} ${entry.key} symbol belongs to ${containingTargets} targets`);
  }
  for (let leftIndex = 0; leftIndex < visible.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < visible.length; rightIndex += 1) {
      const left = visible[leftIndex];
      const right = visible[rightIndex];
      assert.equal(rectangleOverlap(left.hit, right.hit), false,
        `${profile.name} ${left.key}/${right.key} hit rectangles overlap`);
      assert.equal(rectangleOverlap(left.content, right.content), false,
        `${profile.name} ${left.key}/${right.key} content rectangles overlap`);
    }
  }
  const ordered = [...visible].sort((a, b) => a.hit.left - b.hit.left);
  for (let index = 1; index < ordered.length; index += 1) {
    const gap = ordered[index].hit.left - ordered[index - 1].hit.right;
    assert.ok(gap >= profile.minGap - 0.25,
      `${profile.name} ${ordered[index - 1].key}/${ordered[index].key} gap ${gap}px is not deliberate`);
  }
  for (const identity of snapshot.identity.filter(({ visible: isVisible }) => isVisible)) {
    assert.equal(rectangleOverlap(snapshot.actions, identity.rect), false,
      `${profile.name} action cluster overlaps identity ${identity.id}`);
  }
  assert.equal(snapshot.text.views, "");
  assert.equal(snapshot.text.destinations, "");
  assert.equal(snapshot.text.lobby, "L");
  for (const value of Object.values(snapshot.pseudo)) {
    assert.doesNotMatch(value, /Views|Destinations|Go/i);
  }
  // the "Live Backend" pill must be visually sr-only in every
  // view/profile — a near-zero box, not a visible label — while staying a real,
  // updated aria-live="polite" role="status" region for screen readers.
  assert.equal(snapshot.connectionStatus.role, "status",
    `${profile.name} connection-status must keep its status role for screen readers`);
  assert.equal(snapshot.connectionStatus.ariaLive, "polite",
    `${profile.name} connection-status must stay aria-live polite`);
  assert.notEqual(snapshot.connectionStatus.text, "",
    `${profile.name} connection-status must keep real text for screen readers`);
  assert.ok(snapshot.connectionStatus.width <= 1.5 && snapshot.connectionStatus.height <= 1.5,
    `${profile.name} "Live Backend" pill must be visually sr-only (~1px), not a visible label (got ${snapshot.connectionStatus.width}x${snapshot.connectionStatus.height})`);
  if (baseline) {
    for (const entry of visible) {
      const expected = baseline.controls.find(({ id }) => id === entry.id);
      assert.ok(expected?.visible, `${profile.name} ${entry.key} missing from baseline`);
      assertSameRectangle(entry.hit, expected.hit, `${profile.name} ${entry.key} hit`);
      assertSameRectangle(entry.content, expected.content, `${profile.name} ${entry.key} content`);
    }
    assertSameRectangle(snapshot.actions, baseline.actions, `${profile.name} action cluster`);
  }
  return snapshot;
}

async function isBindable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

async function listenerState(port) {
  try {
    const { stdout } = await execFileAsync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"]);
    return stdout.split("\n").filter((line) => /^p\d+$/.test(line)).sort();
  } catch (error) {
    if (error.code === 1) return [];
    throw error;
  }
}

async function waitForPortsReleased(portList) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const states = await Promise.all(portList.map(isBindable));
    if (states.every(Boolean)) return true;
    await delay(100);
  }
  return false;
}

async function profileProcesses() {
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,command="], { maxBuffer: 4 * 1024 * 1024 });
  return stdout.split("\n").map((line) => line.trim()).filter((line) => line.includes(profilePath));
}

async function screenshotHash(page, name, options = {}) {
  const target = path.join(evidenceRoot, name);
  await page.screenshot({ path: target, ...options });
  const bytes = await readFile(target);
  return { file: target, sha256: sha256(bytes), bytes: bytes.length };
}

async function installProbe(page) {
  await page.evaluate((definitions) => {
    const rect = (element) => {
      const value = element.getBoundingClientRect();
      return {
        left: value.left, top: value.top, right: value.right, bottom: value.bottom,
        width: value.width, height: value.height,
      };
    };
    const visible = (element) => {
      if (!element || element.hidden) return false;
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && box.width > 0 && box.height > 0;
    };
    const probe = {
      clicks: Object.fromEntries(definitions.map(({ key }) => [key, 0])),
      trustedClicks: Object.fromEntries(definitions.map(({ key }) => [key, []])),
      destinationsTransitions: [],
      launcherTransitions: [],
      disabledLobbySnapshots: [],
      pageToken: {},
    };
    const state = { panelOpen: null, launcherOpen: null };
    const panel = document.getElementById("semantic-destinations-panel");
    const app = document.getElementById("app");
    const launcher = document.getElementById("demo-launcher-mount");
    const readTransitions = () => {
      const panelOpen = panel.hidden === false
        && document.getElementById("btn-semantic-destinations").getAttribute("aria-expanded") === "true";
      if (panelOpen !== state.panelOpen) {
        state.panelOpen = panelOpen;
        probe.destinationsTransitions.push(panelOpen ? "open" : "closed");
      }
      const launcherOpen = launcher.hidden === false && app.hidden === true;
      if (launcherOpen !== state.launcherOpen) {
        state.launcherOpen = launcherOpen;
        probe.launcherTransitions.push(launcherOpen ? "open" : "closed");
      }
    };
    window.__wo229Capture = () => {
      const entries = definitions.map((definition) => {
        const button = document.getElementById(definition.id);
        const symbol = button?.querySelector(definition.symbol) || null;
        return {
          ...definition,
          hiddenAttribute: button?.hidden === true,
          disabled: button?.disabled === true,
          visible: visible(button),
          hit: visible(button) ? rect(button) : null,
          content: visible(button) && visible(symbol) ? rect(symbol) : null,
          active: button?.matches(":active") === true,
          focusVisible: button?.matches(":focus-visible") === true,
        };
      });
      const actions = document.querySelector(".header-actions");
      return {
        viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
        document: { scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth },
        actions: rect(actions),
        controls: entries,
        ownerHiddenControls: ["btn-semantic-destinations", "btn-runtime-tweaks"].map((id) => {
          const element = document.getElementById(id);
          return {
            id,
            visible: visible(element),
            display: getComputedStyle(element).display,
            ariaHidden: element.getAttribute("aria-hidden"),
            tabIndex: element.tabIndex,
          };
        }),
        identity: ["role-chip", "loc-title", "connection-status"].map((id) => {
          const element = document.getElementById(id);
          return { id, visible: visible(element), rect: visible(element) ? rect(element) : null };
        }),
        // the "Live Backend" pill (#connection-status) is
        // visually sr-only in every view now (still a real, updated
        // aria-live="polite" role="status" region so screen readers keep hearing
        // connection-state changes). Capture its precise box + wiring so
        // assertGeometry can assert the new state directly instead of assuming
        // the old visible pill.
        connectionStatus: (() => {
          const element = document.getElementById("connection-status");
          const box = element.getBoundingClientRect();
          return {
            role: element.getAttribute("role"),
            ariaLive: element.getAttribute("aria-live"),
            text: element.textContent.trim(),
            width: box.width,
            height: box.height,
          };
        })(),
        text: {
          views: document.getElementById("btn-views-home").innerText.trim(),
          destinations: document.getElementById("btn-semantic-destinations").innerText.trim(),
          lobby: document.getElementById("btn-return-lobby").innerText.trim(),
        },
        pseudo: {
          viewsBefore: getComputedStyle(document.getElementById("btn-views-home"), "::before").content,
          viewsAfter: getComputedStyle(document.getElementById("btn-views-home"), "::after").content,
          destinationsBefore: getComputedStyle(document.getElementById("btn-semantic-destinations"), "::before").content,
          destinationsAfter: getComputedStyle(document.getElementById("btn-semantic-destinations"), "::after").content,
        },
      };
    };
    for (const definition of definitions) {
      const button = document.getElementById(definition.id);
      button.addEventListener("click", (event) => {
        probe.clicks[definition.key] += 1;
        probe.trustedClicks[definition.key].push(event.isTrusted);
        if (definition.key === "lobby") {
          queueMicrotask(() => {
            if (button.disabled && !button.hidden) probe.disabledLobbySnapshots.push(window.__wo229Capture());
          });
        }
      });
    }
    const observer = new MutationObserver(readTransitions);
    observer.observe(panel, { attributes: true, attributeFilter: ["hidden"] });
    observer.observe(document.getElementById("btn-semantic-destinations"), { attributes: true, attributeFilter: ["aria-expanded"] });
    observer.observe(app, { attributes: true, attributeFilter: ["hidden"] });
    observer.observe(launcher, { attributes: true, attributeFilter: ["hidden"] });
    readTransitions();
    window.__wo229Probe = probe;
  }, controls);
}

async function captureFrames(page, count = 5) {
  return page.evaluate((frameCount) => new Promise((resolve) => {
    const frames = [];
    const next = () => {
      frames.push(window.__wo229Capture());
      if (frames.length >= frameCount) resolve(frames);
      else requestAnimationFrame(next);
    };
    requestAnimationFrame(next);
  }), count);
}

async function focusOrder(page, profile, baseline, screenshots) {
  await page.evaluate(() => document.activeElement?.blur?.());
  await page.keyboard.press("Tab");
  await page.focus("#btn-views-home");
  const order = [];
  const styles = [];
  for (let index = 0; index < expectedOrder.length; index += 1) {
    if (index > 0) await page.keyboard.press("Tab");
    const focused = await page.evaluate(() => {
      const element = document.activeElement;
      const style = getComputedStyle(element);
      return {
        id: element?.id || null,
        focusVisible: element?.matches?.(":focus-visible") === true,
        outlineStyle: style.outlineStyle,
        outlineWidth: style.outlineWidth,
        outlineColor: style.outlineColor,
        geometry: window.__wo229Capture(),
      };
    });
    order.push(focused.id);
    styles.push(focused);
    assert.equal(focused.focusVisible, true, `${profile.name} ${focused.id} is not :focus-visible`);
    assert.notEqual(focused.outlineStyle, "none", `${profile.name} ${focused.id} has no focus outline`);
    assert.ok(Number.parseFloat(focused.outlineWidth) >= 2, `${profile.name} ${focused.id} focus outline is too thin`);
    assertGeometry(profile, focused.geometry, baseline);
  }
  assert.deepEqual(order, expectedOrder, `${profile.name} keyboard order is not logical DOM order`);
  await page.focus("#btn-views-home");
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 120)));
  const focusCapture = await page.evaluate(() => ({
    focusVisible: document.activeElement?.matches?.(":focus-visible") === true,
    geometry: window.__wo229Capture(),
  }));
  assert.equal(focusCapture.focusVisible, true, `${profile.name} focus diagnostics is not :focus-visible`);
  assertGeometry(profile, focusCapture.geometry, baseline);
  screenshots.focus = await screenshotHash(page, `${profile.name}-keyboard-focus.png`, {
    clip: { x: 0, y: 0, width: profile.width, height: 90 },
  });
  return { order, styles };
}

async function accessibilityFacts(page) {
  const facts = {};
  for (const definition of controls) {
    const handle = await page.$(`#${definition.id}`);
    assert.ok(handle, `missing ${definition.id}`);
    const ax = await page.accessibility.snapshot({ root: handle, interestingOnly: false });
    const dom = await page.$eval(`#${definition.id}`, (element) => ({
      id: element.id,
      title: element.getAttribute("title"),
      ariaLabel: element.getAttribute("aria-label"),
      ariaControls: element.getAttribute("aria-controls"),
      decorative: [...element.querySelectorAll("svg, .avatar-switch-label, .lobby-return-label")].map((child) => ({
        node: child.tagName.toLowerCase(), ariaHidden: child.getAttribute("aria-hidden"), focusable: child.getAttribute("focusable"),
      })),
    }));
    assert.equal(ax?.role, "button", `${definition.key} accessibility role changed`);
    assert.equal(ax?.name, definition.name, `${definition.key} accessibility name changed`);
    assert.equal(dom.ariaLabel, definition.name);
    assert.equal(dom.title, definition.title);
    for (const decorative of dom.decorative) assert.equal(decorative.ariaHidden, "true");
    facts[definition.key] = { ax, dom };
  }
  for (const id of ["btn-semantic-destinations", "btn-runtime-tweaks"]) {
    const handle = await page.$(`#${id}`);
    assert.ok(handle, `missing compatibility control ${id}`);
    assert.equal(await page.accessibility.snapshot({ root: handle, interestingOnly: false }), null,
      `${id} must be absent from the accessibility tree`);
  }
  return facts;
}

async function activateByKeyboard(page, id, key = "Enter") {
  await page.focus(`#${id}`);
  await page.keyboard.press(key);
}

async function runProfile(browser, profile, health) {
  const page = await browser.newPage();
  let proofActive = true;
  const record = { profile, screenshots: {}, geometry: {}, behavior: {}, accessibility: null, keyboard: null };
  page.on("console", (message) => {
    const fact = { profile: profile.name, type: message.type(), text: message.text() };
    health.console.push(fact);
    if (["warn", "warning", "error"].includes(message.type())) health.relatedConsoleProblems.push(fact);
  });
  page.on("pageerror", (error) => health.pageErrors.push({ profile: profile.name, message: error.message }));
  page.on("requestfailed", (request) => {
    const fact = { profile: profile.name, url: request.url(), error: request.failure()?.errorText || "request failed" };
    if (proofActive && fact.error === "net::ERR_ABORTED"
      && /^http:\/\/127\.0\.0\.1:\d+\/assets\/(?:avatars\/|mocap\/)/.test(fact.url)) {
      health.expectedLocalAssetCancellations.push(fact);
    } else {
      (proofActive ? health.requestFailures : health.teardownRequestAborts).push(fact);
    }
  });
  page.on("response", (response) => {
    if (response.status() >= 400) health.httpErrors.push({ profile: profile.name, url: response.url(), status: response.status() });
  });
  try {
    await page.setViewport({ width: profile.width, height: profile.height, deviceScaleFactor: 1 });
    await page.evaluateOnNewDocument(() => { localStorage.clear(); sessionStorage.clear(); });
    await page.goto(`http://127.0.0.1:${ports.frontend}/index.html?role=player&active=source&intro=0&avatar_variant=readyplayerme-cyberpunk`, {
      waitUntil: "domcontentloaded", timeout: 60000,
    });
    await page.waitForFunction(() => document.body.dataset.assemblyReady === "1" && window.__assembly?.ready === true,
      { timeout: 60000 });
    await page.waitForFunction(() => window.__assembly?.equipmentReady?.() === true, { timeout: 60000 });
    await page.waitForFunction(() => {
      const runtime = document.getElementById("btn-runtime-tweaks");
      const lobby = document.getElementById("btn-return-lobby");
      return runtime && !runtime.hidden && lobby && !lobby.hidden
        && window.__assembly.debugState().location_id === "location-a";
    }, { timeout: 30000 });
    await page.$eval('button[data-testid="start-exploring"]', (button) => button.click());
    await page.waitForFunction(() => !document.querySelector('[data-testid="player-first-frame"]'));
    await page.waitForFunction(() => {
      const visual = window.__assembly?.avatarVisualState?.();
      return window.__assembly?.equipmentReady?.() === true && visual?.avatar_switch_in_flight === false;
    }, { timeout: 60000, polling: 200 });
    await delay(400);
    await installProbe(page);

    const baseline = await page.evaluate(() => window.__wo229Capture());
    assertGeometry(profile, baseline);
    record.geometry.initial = baseline;
    const homeRest = await page.$eval("#btn-views-home", (element) => {
      const style = getComputedStyle(element);
      return {
        backgroundColor: style.backgroundColor,
        borderTopColor: style.borderTopColor,
        borderRadius: style.borderRadius,
        boxShadow: style.boxShadow,
      };
    });
    assert.equal(homeRest.backgroundColor, "rgba(0, 0, 0, 0)");
    assert.match(homeRest.borderTopColor, /rgba\([^)]*, 0\)$/);
    assert.equal(homeRest.borderRadius, "0px");
    assert.equal(homeRest.boxShadow, "none");
    record.geometry.homeRest = homeRest;
    record.screenshots.initial = await screenshotHash(page, `${profile.name}-header.png`, {
      clip: { x: 0, y: 0, width: profile.width, height: 90 },
    });

    await page.hover("#btn-views-home");
    const hoverFrames = await captureFrames(page);
    hoverFrames.forEach((frame) => assertGeometry(profile, frame, baseline));
    record.geometry.hoverTransition = hoverFrames;

    const home = baseline.controls.find(({ key }) => key === "views").hit;
    await page.mouse.move(home.left + home.width / 2, home.top + home.height / 2);
    await page.mouse.down();
    const active = await page.evaluate(() => window.__wo229Capture());
    assert.equal(active.controls.find(({ key }) => key === "views").active, true);
    assertGeometry(profile, active, baseline);
    record.geometry.active = active;
    await page.$eval("#btn-views-home", (button) => { button.disabled = true; });
    await page.mouse.up();
    await page.$eval("#btn-views-home", (button) => { button.disabled = false; });
    await page.mouse.move(0, profile.height - 1);
    assert.equal(await page.evaluate(() => window.__wo229Probe.clicks.views), 0,
      `${profile.name} active-state probe accidentally activated Views`);

    record.keyboard = await focusOrder(page, profile, baseline, record.screenshots);
    record.accessibility = await accessibilityFacts(page);

    record.behavior.ownerHiddenControls = baseline.ownerHiddenControls;

    await activateByKeyboard(page, "btn-views-home");
    await page.waitForFunction(() => !document.getElementById("demo-launcher-mount").hidden
      && document.getElementById("app").hidden
      && document.getElementById("btn-views-home").getAttribute("aria-expanded") === "true");
    await page.$eval(".demo-launcher-card:not(:disabled)", (button) => button.focus());
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.getElementById("demo-launcher-mount").hidden
      && !document.getElementById("app").hidden
      && document.getElementById("btn-views-home").getAttribute("aria-expanded") === "false");
    const viewsBehavior = await page.evaluate(() => ({
      clicks: window.__wo229Probe.clicks.views,
      trusted: window.__wo229Probe.trustedClicks.views,
      transitions: window.__wo229Probe.launcherTransitions,
      expanded: document.getElementById("btn-views-home").getAttribute("aria-expanded"),
      appHidden: document.getElementById("app").hidden,
    }));
    assert.equal(viewsBehavior.clicks, 1);
    assert.deepEqual(viewsBehavior.trusted, [true]);
    assert.deepEqual(viewsBehavior.transitions, ["closed", "open", "closed"]);
    record.behavior.views = viewsBehavior;
    assertGeometry(profile, await page.evaluate(() => window.__wo229Capture()), baseline);

    const beforeLobby = await page.evaluate(() => ({
      notifications: window.__assembly.notifications.list().filter((entry) => entry.event_type === "return_to_lobby").length,
      navigations: performance.getEntriesByType("navigation").length,
      tokenStored: (window.__wo229Probe.beforeLobbyToken = window.__wo229Probe.pageToken) === window.__wo229Probe.pageToken,
    }));
    assert.equal(beforeLobby.tokenStored, true);
    await activateByKeyboard(page, "btn-return-lobby", "Enter");
    await page.waitForFunction(() => window.__assembly.debugState().location_id === "location-lobby"
      && document.getElementById("btn-return-lobby").hidden, { timeout: 30000 });
    await page.waitForFunction(() => {
      const visual = window.__assembly?.avatarVisualState?.();
      return window.__assembly?.equipmentReady?.() === true && visual?.avatar_switch_in_flight === false;
    }, { timeout: 60000, polling: 200 });
    await delay(400);
    const lobbyBehavior = await page.evaluate((prior) => ({
      clicks: window.__wo229Probe.clicks.lobby,
      trusted: window.__wo229Probe.trustedClicks.lobby,
      disabledSnapshots: window.__wo229Probe.disabledLobbySnapshots,
      location: window.__assembly.debugState().location_id,
      hidden: document.getElementById("btn-return-lobby").hidden,
      notificationsAdded: window.__assembly.notifications.list().filter((entry) => entry.event_type === "return_to_lobby").length - prior.notifications,
      navigationEntries: performance.getEntriesByType("navigation").length,
      samePageToken: window.__wo229Probe.pageToken === window.__wo229Probe.beforeLobbyToken,
      postGeometry: window.__wo229Capture(),
    }), beforeLobby);
    assert.equal(lobbyBehavior.clicks, 1);
    assert.deepEqual(lobbyBehavior.trusted, [true]);
    assert.equal(lobbyBehavior.disabledSnapshots.length >= 1, true, `${profile.name} did not observe the real in-flight disabled state`);
    for (const disabled of lobbyBehavior.disabledSnapshots) assertGeometry(profile, disabled, baseline);
    assert.equal(lobbyBehavior.location, "location-lobby");
    assert.equal(lobbyBehavior.hidden, true);
    assert.equal(lobbyBehavior.notificationsAdded, 1);
    assert.equal(lobbyBehavior.navigationEntries, beforeLobby.navigations);
    assert.equal(lobbyBehavior.samePageToken, true);
    assert.equal(lobbyBehavior.postGeometry.controls.find(({ key }) => key === "lobby").visible, false);
    assert.equal(lobbyBehavior.postGeometry.ownerHiddenControls.every(({ visible }) => !visible), true);
    record.behavior.lobby = lobbyBehavior;

    record.behavior.finalClicks = await page.evaluate(() => window.__wo229Probe.clicks);
    assert.deepEqual(record.behavior.finalClicks, {
      views: 1, camera: 0, avatar: 0, refresh: 0, notifications: 0, lobby: 1, rail: 0,
    });

    proofActive = false;
    await page.goto(`http://127.0.0.1:${ports.frontend}/index.html?role=source&active=source&intro=0`, {
      waitUntil: "domcontentloaded", timeout: 60000,
    });
    proofActive = true;
    await page.waitForFunction(() => document.body.dataset.assemblyReady === "1" && window.__assembly?.ready === true,
      { timeout: 60000 });
    const sourceStart = await page.$('button[data-testid="start-exploring"]');
    if (sourceStart) await sourceStart.click();
    await page.waitForFunction(() => !document.querySelector('[data-testid="player-first-frame"]'));
    const sourceVisibleOrder = await page.evaluate(() => [...document.querySelectorAll(".header-actions > button")]
      .filter((button) => {
        const rect = button.getBoundingClientRect();
        const style = getComputedStyle(button);
        return !button.hidden && style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      })
      .map((button) => button.id));
    assert.deepEqual(sourceVisibleOrder, expectedSourceOrder,
      `${profile.name} source/server header visibility does not match the supported control sequence`);
    await page.focus(`#${expectedSourceOrder[0]}`);
    const sourceFocusOrder = [];
    for (let index = 0; index < expectedSourceOrder.length; index += 1) {
      if (index > 0) await page.keyboard.press("Tab");
      sourceFocusOrder.push(await page.evaluate(() => document.activeElement?.id || null));
    }
    assert.deepEqual(sourceFocusOrder, expectedSourceOrder,
      `${profile.name} source/server keyboard order omitted or repeated a supported visible header control`);
    assert.equal(new Set(sourceFocusOrder).size, expectedSourceOrder.length,
      `${profile.name} source/server keyboard order reached a visible header control more than once`);
    record.behavior.sourceHeader = { visibleOrder: sourceVisibleOrder, focusOrder: sourceFocusOrder };
    return record;
  } finally {
    proofActive = false;
    await page.close();
  }
}

async function main() {
  await mkdir(evidenceRoot, { recursive: true });
  await rm(profilePath, { recursive: true, force: true });
  const preProtected = Object.fromEntries(await Promise.all(protectedPorts.map(async (port) => [port, await listenerState(port)])));
  for (const port of Object.values(ports)) assert.equal(await isBindable(port), true, `worker port ${port} is already occupied`);
  const diagnostics = {
    schema_version: 1,
    work_order: "runtime",
    outcome: "RUNNING",
    started_at: new Date().toISOString(),
    headed: true,
    browser_session_owner: `/root/feature_orchestrator/feature_header_impl:${process.pid}`,
    worker_pid: process.pid,
    ports,
    protected_ports: { before: preProtected, after: null, unchanged: false },
    profile: { path: profilePath, disposable: true, removed: false, processes_at_launch: [], processes_after_close: [] },
    browser: { executable: null, pid: null },
    profiles: [],
    health: {
      console: [], relatedConsoleProblems: [], pageErrors: [], requestFailures: [],
      expectedLocalAssetCancellations: [], teardownRequestAborts: [], httpErrors: [],
    },
    cleanup: {
      browser: false,
      frontend: false,
      backends: false,
      portsReleased: false,
      browserProcessesReleased: false,
      parentTcpSockets: [],
      parentTcpSocketsReleased: false,
    },
  };
  let backends = null;
  let frontend = null;
  let browser = null;
  let failure = null;
  try {
    const { startBackends, assertNotLiveDemoPorts } = require("./orchestrator.js");
    const { createFrontendServer } = require("./serve.js");
    assertNotLiveDemoPorts({ a: ports.a, b: ports.b, lobby: ports.lobby, airport: ports.airport });
    backends = await startBackends({
      backendPorts: { a: ports.a, b: ports.b, lobby: ports.lobby, airport: ports.airport },
      includeAirport: true,
      log: () => {},
    });
    frontend = await createFrontendServer(ports.frontend, {
      backendPorts: { a: ports.a, b: ports.b, lobby: ports.lobby, airport: ports.airport },
      includeAirport: true,
      host: "127.0.0.1",
    });
    const { findBrowser } = await import(path.join(root, "tools/find-browser.mjs"));
    const executablePath = findBrowser();
    assert.ok(executablePath, "headed validation requires a local Chrome/Chromium executable");
    diagnostics.browser.executable = executablePath;
    const puppeteer = require("puppeteer-core");
    browser = await puppeteer.launch({
      executablePath,
      headless: false,
      userDataDir: profilePath,
      defaultViewport: null,
      args: [
        "--no-sandbox", "--enable-webgl", "--ignore-gpu-blocklist", "--window-size=1698,900",
      ],
    });
    diagnostics.browser.pid = browser.process()?.pid || null;
    diagnostics.profile.processes_at_launch = await profileProcesses();
    assert.ok(diagnostics.browser.pid, "headed browser PID was not observable");
    assert.ok(diagnostics.profile.processes_at_launch.length > 0, "worker-owned browser profile has no observable process");
    for (const profile of profiles) diagnostics.profiles.push(await runProfile(browser, profile, diagnostics.health));
    assert.equal(diagnostics.health.relatedConsoleProblems.length, 0, "headed page emitted console warnings/errors");
    assert.equal(diagnostics.health.pageErrors.length, 0, "headed page emitted page errors");
    assert.equal(diagnostics.health.requestFailures.length, 0, "headed page had request failures");
    assert.equal(diagnostics.health.httpErrors.length, 0, "headed page had HTTP errors");
    diagnostics.outcome = "PASS";
  } catch (error) {
    failure = error;
    diagnostics.outcome = "RED";
    diagnostics.error = { name: error.name, message: error.message, stack: error.stack };
  } finally {
    const cleanupErrors = [];
    if (browser) {
      try { await browser.close(); diagnostics.cleanup.browser = true; }
      catch (error) { cleanupErrors.push(`browser: ${error.message}`); }
    } else diagnostics.cleanup.browser = true;
    if (frontend) {
      try { await frontend.closeAll(); diagnostics.cleanup.frontend = true; }
      catch (error) { cleanupErrors.push(`frontend: ${error.message}`); }
    } else diagnostics.cleanup.frontend = true;
    if (backends) {
      try { await backends.stop(); diagnostics.cleanup.backends = true; }
      catch (error) { cleanupErrors.push(`backends: ${error.message}`); }
    } else diagnostics.cleanup.backends = true;
    diagnostics.cleanup.portsReleased = await waitForPortsReleased(Object.values(ports));
    if (!diagnostics.cleanup.portsReleased) cleanupErrors.push("worker ports did not release");
    diagnostics.profile.processes_after_close = await profileProcesses();
    diagnostics.cleanup.browserProcessesReleased = diagnostics.profile.processes_after_close.length === 0;
    if (!diagnostics.cleanup.browserProcessesReleased) cleanupErrors.push("worker profile browser processes remain");
    await rm(profilePath, { recursive: true, force: true });
    diagnostics.profile.removed = await stat(profilePath).then(() => false).catch(() => true);
    if (!diagnostics.profile.removed) cleanupErrors.push("worker browser profile was not removed");
    diagnostics.protected_ports.after = Object.fromEntries(await Promise.all(protectedPorts.map(async (port) => [port, await listenerState(port)])));
    diagnostics.protected_ports.unchanged = JSON.stringify(diagnostics.protected_ports.before) === JSON.stringify(diagnostics.protected_ports.after);
    if (!diagnostics.protected_ports.unchanged) cleanupErrors.push("protected port listener state changed");
    let parentTcpOutput = "";
    try {
      ({ stdout: parentTcpOutput } = await execFileAsync(
        "lsof", ["-nP", "-a", "-p", String(process.pid), "-iTCP"], { maxBuffer: 4 * 1024 * 1024 },
      ));
    } catch (error) {
      if (error.code !== 1) cleanupErrors.push(`parent TCP socket inspection: ${error.message}`);
      parentTcpOutput = error.stdout || "";
    }
    diagnostics.cleanup.parentTcpSockets = parentTcpOutput.split("\n").slice(1).map((line) => line.trim()).filter(Boolean);
    diagnostics.cleanup.parentTcpSocketsReleased = diagnostics.cleanup.parentTcpSockets.length === 0;
    if (!diagnostics.cleanup.parentTcpSocketsReleased) cleanupErrors.push("worker parent still owns TCP sockets after cleanup");
    if (cleanupErrors.length) {
      diagnostics.cleanup_errors = cleanupErrors;
      diagnostics.outcome = "RED";
      failure ||= new Error(cleanupErrors.join("; "));
    }
    diagnostics.completed_at = new Date().toISOString();
    await writeFile(evidencePath, `${JSON.stringify(diagnostics, null, 2)}\n`, "utf8");
  }
  process.stdout.write(`runtime headed header navigation: ${diagnostics.outcome} profiles=${diagnostics.profiles.length}/2 diagnostics=${evidencePath}\n`);
  if (failure) throw failure;
}

async function terminateAfterFlush(code, error = null) {
  if (error) {
    await new Promise((resolve) => process.stderr.write(`${error.stack || error.message}\n`, resolve));
  }
  await new Promise((resolve) => process.stdout.write("", resolve));
  process.exit(code);
}

main().then(
  () => terminateAfterFlush(0),
  (error) => terminateAfterFlush(error.exitCode || 1, error),
);
