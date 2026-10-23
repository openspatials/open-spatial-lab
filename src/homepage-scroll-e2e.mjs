import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createDemoLauncherCatalog,
  DEMO_TECHNOLOGIES,
} from "../web/demo-launcher-catalog.mjs";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evidenceRoot = process.env.feature_EVIDENCE_ROOT
  ? path.resolve(process.env.feature_EVIDENCE_ROOT)
  : path.join(root, "diagnostics");
const screenshotRoot = path.join(evidenceRoot, "after");
const evidencePath = path.join(evidenceRoot, "runtime/headed-diagnostics.json");
const chromeLogPath = path.join(evidenceRoot, "runtime/chrome-process.json");
const profilePath = process.env.feature_PROFILE_PATH || "/tmp/homepage-scroll-profile";
const chromePath = process.env.feature_BROWSER_EXECUTABLE
  ? path.resolve(process.env.feature_BROWSER_EXECUTABLE)
  : "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const homepagePhase = process.env.feature_HOMEPAGE_PHASE || "step3";
const ports = Object.freeze({ frontend: 19824, a: 19825, b: 19826, lobby: 19827, reserved: 19828, cdp: 20824 });
const profiles = Object.freeze([
  { name: "desktop-1440x1000", width: 1440, height: 1000, mobile: false, capture: true },
  { name: "desktop-1280x720", width: 1280, height: 720, mobile: false, capture: false },
  { name: "mobile-390x844", width: 390, height: 844, mobile: true, capture: true },
  { name: "mobile-430x932", width: 430, height: 932, mobile: true, capture: false },
]);
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export const feature_HOMEPAGE_PHASE_ORDERS = Object.freeze({
  step2: Object.freeze(["canvas", "decorative-orbit", "header", "missions", "technologies", "live-region"]),
  step3: Object.freeze(["terrain", "decorative-orbit", "header", "missions", "technologies", "live-region"]),
});

export function assertHomepagePhaseOrder(actualOrder, phase) {
  assert.equal(
    Object.hasOwn(feature_HOMEPAGE_PHASE_ORDERS, phase),
    true,
    `runtime homepage phase must be step2 or step3; received ${String(phase)}`,
  );
  const expectedOrder = feature_HOMEPAGE_PHASE_ORDERS[phase];
  assert.deepEqual(actualOrder, expectedOrder, `${phase} homepage direct-child order drifted`);
  return expectedOrder;
}

async function isBindable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

async function waitForPortsReleased() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const states = await Promise.all(Object.values(ports).map(isBindable));
    if (states.every(Boolean)) return true;
    await delay(100);
  }
  return false;
}

async function waitForCdp() {
  let lastError = null;
  for (let attempt = 0; attempt < 300; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${ports.cdp}/json/version`);
      if (response.ok) return response.json();
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw lastError || new Error("Chrome CDP endpoint did not become ready");
}

async function screenshot(page, name) {
  const target = path.join(screenshotRoot, name);
  await page.screenshot({ path: target });
  const bytes = await readFile(target);
  return { path: target, sha256: sha256(bytes), bytes: bytes.length };
}

function bindHealth(page, label, health) {
  let active = true;
  let assetRequestSequence = 0;
  const assetRequestIds = new WeakMap();
  const recordAsset = (request, event, detail = {}) => {
    if (!request.url().includes("/assets/avatars/")) return;
    if (!assetRequestIds.has(request)) assetRequestIds.set(request, ++assetRequestSequence);
    health.avatarAssetRequests.push({
      label,
      requestId: assetRequestIds.get(request),
      event,
      url: request.url(),
      ...detail,
    });
  };
  page.on("request", (request) => recordAsset(request, "request"));
  page.on("console", (message) => {
    const fact = { label, type: message.type(), text: message.text() };
    health.console.push(fact);
    if (active && ["warn", "warning", "error"].includes(message.type())) health.consoleProblems.push(fact);
  });
  page.on("pageerror", (error) => {
    if (active) health.pageErrors.push({ label, message: error.message, stack: error.stack });
  });
  page.on("requestfailed", (request) => {
    const fact = { label, url: request.url(), error: request.failure()?.errorText || "request failed" };
    recordAsset(request, "failed", { error: fact.error });
    (active ? health.requestFailures : health.teardownAborts).push(fact);
  });
  page.on("requestfinished", (request) => recordAsset(request, "finished"));
  page.on("response", (response) => {
    recordAsset(response.request(), "response", { status: response.status() });
    if (active && response.status() >= 400) health.httpErrors.push({ label, url: response.url(), status: response.status() });
  });
  return () => { active = false; };
}

async function configureViewport(page, profile) {
  await page.setViewport({
    width: profile.width,
    height: profile.height,
    deviceScaleFactor: 1,
    isMobile: profile.mobile,
    hasTouch: profile.mobile,
  });
}

async function settle(page, milliseconds = 320) {
  await delay(milliseconds);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function scrollFacts(page, surface) {
  return page.evaluate((kind) => {
    const owner = kind === "integrated"
      ? document.getElementById("demo-launcher-mount")
      : document.scrollingElement;
    const lastMission = [...document.querySelectorAll("[data-mission-id]:not(:disabled)")].at(-1);
    const lastTechnologyLink = [...document.querySelectorAll(".demo-launcher-technology-card a")].at(-1);
    const missionRect = lastMission.getBoundingClientRect();
    const technologyRect = lastTechnologyLink.getBoundingClientRect();
    const style = getComputedStyle(owner);
    const candidates = [document.documentElement, document.body, ...document.querySelectorAll("body *")];
    const verticalOwners = candidates.filter((element) => {
      const computed = getComputedStyle(element);
      return element.scrollHeight > element.clientHeight + 2 && ["auto", "scroll"].includes(computed.overflowY);
    }).map((element) => element.id || element.className || element.tagName);
    return {
      viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
      owner: {
        id: owner.id || "document",
        clientHeight: owner.clientHeight,
        scrollHeight: owner.scrollHeight,
        scrollWidth: owner.scrollWidth,
        clientWidth: owner.clientWidth,
        scrollTop: owner.scrollTop,
        maxScrollTop: owner.scrollHeight - owner.clientHeight,
        overflowX: style.overflowX,
        overflowY: style.overflowY,
        touchAction: style.touchAction,
        overscrollBehaviorY: style.overscrollBehaviorY,
      },
      document: {
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
        clientHeight: document.documentElement.clientHeight,
        scrollHeight: document.documentElement.scrollHeight,
        scrollTop: document.scrollingElement.scrollTop,
      },
      bottomControl: {
        missionId: lastMission.dataset.missionId,
        top: missionRect.top,
        bottom: missionRect.bottom,
        height: missionRect.height,
        visible: missionRect.top >= -2 && missionRect.bottom <= innerHeight + 2,
        disabled: lastMission.disabled,
      },
      bottomTechnology: {
        name: lastTechnologyLink.firstChild?.textContent?.trim() || lastTechnologyLink.textContent.trim(),
        href: lastTechnologyLink.href,
        top: technologyRect.top,
        bottom: technologyRect.bottom,
        height: technologyRect.height,
        visible: technologyRect.top >= -2 && technologyRect.bottom <= innerHeight + 2,
      },
      verticalOwners,
      active: document.activeElement?.className || document.activeElement?.id || document.activeElement?.tagName,
    };
  }, surface);
}

async function launcherOrderProof(page, surface) {
  const dom = await page.evaluate((phase) => {
    const shell = document.querySelector("main.demo-launcher");
    const mission = document.getElementById("demo-launcher-actions");
    const technologies = document.querySelector(".demo-launcher-technologies");
    const missionRect = mission.getBoundingClientRect();
    const technologyRect = technologies.getBoundingClientRect();
    const keyFor = (element) => {
      if (element.matches("canvas.demo-launcher-terrain")) return phase === "step3" ? "terrain" : "canvas";
      if (element.matches("header.demo-launcher-header")) return "header";
      if (element.matches("#demo-launcher-actions.demo-launcher-missions")) return "missions";
      if (element.matches(".demo-launcher-technologies")) return "technologies";
      if (element.matches(".demo-launcher-live-region")) return "live-region";
      if (element.matches(".demo-launcher-orbit")) return "decorative-orbit";
      return `unrecognized:${element.tagName.toLowerCase()}`;
    };
    return {
      directOrder: [...shell.children].map(keyFor),
      missionBeforeTechnologies: Boolean(mission.compareDocumentPosition(technologies) & Node.DOCUMENT_POSITION_FOLLOWING),
      boxes: {
        mission: { top: missionRect.top, bottom: missionRect.bottom, height: missionRect.height },
        technologies: { top: technologyRect.top, bottom: technologyRect.bottom, height: technologyRect.height },
      },
      h2Order: [...shell.querySelectorAll("h2")].map((heading) => heading.textContent.trim()),
      counts: {
        missionSections: document.querySelectorAll("#demo-launcher-actions.demo-launcher-missions").length,
        technologySections: document.querySelectorAll(".demo-launcher-technologies").length,
        readyHeadings: [...document.querySelectorAll("h2")].filter((heading) => heading.textContent.trim() === "Ready to explore?").length,
        technologyHeadings: [...document.querySelectorAll("h2")].filter((heading) => heading.textContent.trim() === "Technologies in and around the demo").length,
        independenceNotes: document.querySelectorAll(".demo-launcher-independence-note").length,
        postNoteSourceLinks: document.querySelectorAll(".demo-launcher-independence-note + .demo-launcher-source-link").length,
      },
      missions: [...mission.querySelectorAll("[data-mission-id]")].map((button) => ({
        id: button.dataset.missionId,
        group: button.dataset.launcherGroup,
        label: button.querySelector(".demo-launcher-card-label")?.textContent.trim(),
        description: button.querySelector(".demo-launcher-card-description")?.textContent.trim() ?? null,
        disabled: button.disabled,
      })),
      technologies: [...technologies.querySelectorAll(".demo-launcher-technology-card")].map((card) => {
        const link = card.querySelector("h3 a");
        return {
          name: link.firstChild?.textContent?.trim() || link.textContent.trim(),
          href: link.href,
          target: link.target,
          rel: link.rel,
          status: card.querySelector(".demo-launcher-technology-status")?.textContent.trim(),
          role: card.querySelector(".demo-launcher-technology-role")?.textContent.trim(),
          claim: card.querySelector(".demo-launcher-technology-claim")?.textContent.trim(),
        };
      }),
      footerLinks: [...document.querySelectorAll(".demo-launcher-dock > a")].map((link) => ({
        text: link.textContent.trim(),
        href: link.href,
      })),
      headerSourceLinks: [...document.querySelectorAll(".demo-launcher-header > .demo-launcher-github-link")].map((link) => ({
        text: link.textContent.trim(),
        accessibleName: link.getAttribute("aria-label"),
        href: link.href,
        target: link.target,
        rel: link.rel,
        image: {
          src: link.querySelector("img")?.getAttribute("src"),
          alt: link.querySelector("img")?.getAttribute("alt"),
          ariaHidden: link.querySelector("img")?.getAttribute("aria-hidden"),
        },
      })),
      postNoteSourceLinks: [...document.querySelectorAll(".demo-launcher-independence-note + .demo-launcher-source-link")].map((link) => ({
        text: link.textContent.trim(),
        href: link.href,
        target: link.target,
        rel: link.rel,
      })),
      jumpInCount: [...document.querySelectorAll("a, button")].filter((control) => control.textContent.trim() === "Jump in").length,
    };
  }, homepagePhase);
  const accessibility = await page.accessibility.snapshot({ interestingOnly: false });
  const accessibilityHeadings = [];
  const accessibilityRepositoryLinks = [];
  const visit = (node) => {
    if (node.role === "heading" && ["Ready to explore?", "Technologies in and around the demo"].includes(node.name)) {
      accessibilityHeadings.push(node.name);
    }
    if (node.role === "link" && [
      "Open the Open Spatial Lab GitHub repository",
      "github.com/openspatials/open-spatial-lab",
    ].includes(node.name)) accessibilityRepositoryLinks.push(node.name);
    for (const child of node.children || []) visit(child);
  };
  visit(accessibility);
  const missionCatalog = createDemoLauncherCatalog({ airportAvailable: surface === "integrated" });
  const orderedMissionCatalog = homepagePhase === "step3"
    ? ["player", "destinations", "servers"].flatMap((group) => (
      missionCatalog.filter((mission) => mission.launcherGroup === group)
    ))
    : missionCatalog;
  const expectedMissions = orderedMissionCatalog.map((mission) => ({
    id: mission.id,
    group: mission.launcherGroup,
    label: mission.label,
    description: mission.description ?? null,
    disabled: mission.availability !== "available",
  }));
  const expectedTechnologies = DEMO_TECHNOLOGIES.map((technology) => ({
    name: technology.name,
    href: technology.officialUrl,
    target: "_blank",
    rel: "noopener noreferrer",
    status: technology.statusLabel,
    role: technology.role,
    claim: technology.claim,
  }));
  assertHomepagePhaseOrder(dom.directOrder, homepagePhase);
  assert.equal(dom.missionBeforeTechnologies, true, "mission section does not precede technology section in DOM order");
  assert(dom.boxes.mission.bottom <= dom.boxes.technologies.top + 0.5, "mission layout overlaps or follows technology section");
  assert.deepEqual(dom.h2Order, ["Ready to explore?", "Technologies in and around the demo"]);
  assert.deepEqual(accessibilityHeadings, ["Ready to explore?", "Technologies in and around the demo"]);
  assert.deepEqual(dom.counts, {
    missionSections: 1,
    technologySections: 1,
    readyHeadings: 1,
    technologyHeadings: 1,
    independenceNotes: 1,
    postNoteSourceLinks: 1,
  });
  assert.deepEqual(dom.missions, expectedMissions);
  assert.deepEqual(dom.technologies, expectedTechnologies);
  assert.deepEqual(dom.footerLinks, [
    { text: "labs.peers.social/open-spatial-lab", href: "https://labs.peers.social/open-spatial-lab/" },
  ]);
  assert.deepEqual(dom.headerSourceLinks, [
    {
      text: "",
      accessibleName: "Open the Open Spatial Lab GitHub repository",
      href: "https://github.com/openspatials/open-spatial-lab",
      target: "_blank",
      rel: "noopener noreferrer",
      image: {
        src: "./assets/icons8-github-250.svg",
        alt: "",
        ariaHidden: "true",
      },
    },
  ]);
  assert.deepEqual(dom.postNoteSourceLinks, [
    {
      text: "github.com/openspatials/open-spatial-lab",
      href: "https://github.com/openspatials/open-spatial-lab",
      target: "_blank",
      rel: "noopener noreferrer",
    },
  ]);
  assert.deepEqual(accessibilityRepositoryLinks, [
    "Open the Open Spatial Lab GitHub repository",
    "github.com/openspatials/open-spatial-lab",
  ]);
  assert.equal(dom.jumpInCount, 0);
  return { ...dom, accessibilityHeadings, accessibilityRepositoryLinks };
}

async function setOwnerPosition(page, surface, top, focus = true) {
  await page.evaluate(({ kind, target, shouldFocus }) => {
    const owner = kind === "integrated"
      ? document.getElementById("demo-launcher-mount")
      : document.scrollingElement;
    owner.scrollTop = target === "max" ? owner.scrollHeight - owner.clientHeight : Number(target);
    if (shouldFocus) {
      // Keep standalone keyboard-scroll focus on a non-mission anchor. If focus sat on a mission
      // button, the launcher's keydown handler would treat Space/Arrow keys as confirm/focus
      // actions and call preventDefault, swallowing the native scroll this proof is measuring.
      const focusTarget = kind === "integrated"
        ? document.querySelector(".demo-launcher")
        : document.querySelector(".demo-launcher-technology-card a");
      focusTarget.focus({ preventScroll: true });
    }
  }, { kind: surface, target: top, shouldFocus: focus });
  await settle(page, 40);
}

async function keyboardMatrix(page, surface) {
  const records = {};
  for (const [label, start, key, direction] of [
    ["page-down", 0, "PageDown", "down"],
    ["page-up", "max", "PageUp", "up"],
    ["space", 0, "Space", "down"],
    ["shift-space", "max", "Space", "up"],
    ["arrow-down", 0, "ArrowDown", "down"],
    ["arrow-up", "max", "ArrowUp", "up"],
    ["end", 0, "End", "end"],
    ["home", "max", "Home", "home"],
  ]) {
    await setOwnerPosition(page, surface, start);
    const before = await scrollFacts(page, surface);
    if (label === "shift-space") await page.keyboard.down("Shift");
    await page.keyboard.press(key);
    if (label === "shift-space") await page.keyboard.up("Shift");
    await settle(page);
    const after = await scrollFacts(page, surface);
    if (direction === "down") assert(after.owner.scrollTop > before.owner.scrollTop + 2, `${surface} ${label} did not scroll down`);
    if (direction === "up") assert(after.owner.scrollTop < before.owner.scrollTop - 2, `${surface} ${label} did not scroll up`);
    if (direction === "end") assert(Math.abs(after.owner.scrollTop - after.owner.maxScrollTop) <= 2, `${surface} End missed the bottom`);
    if (direction === "home") assert(after.owner.scrollTop <= 2, `${surface} Home missed the top`);
    records[label] = { before: before.owner.scrollTop, after: after.owner.scrollTop, max: after.owner.maxScrollTop };
  }
  return records;
}

async function wheelProof(page, surface, profile) {
  await setOwnerPosition(page, surface, 0);
  await page.mouse.move(Math.floor(profile.width / 2), Math.floor(profile.height / 2));
  await page.mouse.wheel({ deltaY: 700 });
  await settle(page, 180);
  const after = await scrollFacts(page, surface);
  assert(after.owner.scrollTop > 2, `${surface} wheel/trackpad event did not move the scroll owner`);
  return after.owner.scrollTop;
}

async function touchProof(page, surface, profile) {
  await setOwnerPosition(page, surface, 0);
  await page.evaluate((kind) => {
    const owner = kind === "integrated" ? document.getElementById("demo-launcher-mount") : document;
    window.__wo264Touch = { starts: 0, moves: 0, trusted: true, prevented: false };
    owner.addEventListener("touchstart", (event) => {
      window.__wo264Touch.starts += 1;
      window.__wo264Touch.trusted &&= event.isTrusted;
      window.__wo264Touch.prevented ||= event.defaultPrevented;
    });
    owner.addEventListener("touchmove", (event) => {
      window.__wo264Touch.moves += 1;
      window.__wo264Touch.trusted &&= event.isTrusted;
      window.__wo264Touch.prevented ||= event.defaultPrevented;
    });
  }, surface);
  const session = await page.createCDPSession();
  const drag = async (x) => {
    const point = (y) => ({ x, y, radiusX: 2, radiusY: 2, force: 1 });
    const startY = Math.floor(profile.height * 0.8);
    await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point(startY)] });
    for (const ratio of [0.74, 0.66, 0.58, 0.5, 0.42, 0.34, 0.26, 0.18]) {
      await session.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [point(Math.floor(profile.height * ratio))],
      });
      await delay(24);
    }
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await settle(page, 240);
  };
  await drag(Math.floor(profile.width / 2));
  if (await page.evaluate((kind) => {
    const owner = kind === "integrated" ? document.getElementById("demo-launcher-mount") : document.scrollingElement;
    return owner.scrollTop <= 2;
  }, surface)) await drag(24);
  await session.detach();
  const result = await page.evaluate((kind) => {
    const owner = kind === "integrated" ? document.getElementById("demo-launcher-mount") : document.scrollingElement;
    return { ...window.__wo264Touch, scrollTop: owner.scrollTop };
  }, surface);
  assert(result.starts >= 1 && result.moves >= 1, `${surface} did not receive the touch gesture`);
  assert.equal(result.trusted, true, `${surface} touch validation was not trusted input`);
  assert.equal(result.prevented, false, `${surface} touch gesture was cancelled`);
  assert(result.scrollTop > 2, `${surface} touch drag did not scroll`);
  return result;
}

async function tabAndBottomProof(page, surface) {
  await setOwnerPosition(page, surface, 0, false);
  await page.evaluate(() => {
    const enabled = [...document.querySelectorAll("[data-mission-id]:not(:disabled)")];
    enabled.at(-2).focus({ preventScroll: true });
  });
  await page.keyboard.press("Tab");
  await settle(page);
  const tab = await scrollFacts(page, surface);
  assert.equal(tab.bottomControl.missionId, await page.evaluate(() => document.activeElement.dataset.missionId));
  assert.equal(tab.bottomControl.visible, true, `${surface} Tab did not reveal the final enabled mission`);
  const missionActivation = await page.evaluate(() => {
    const mission = document.activeElement;
    const rect = mission.getBoundingClientRect();
    window.__wo264MissionActivated = null;
    mission.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      window.__wo264MissionActivated = { trusted: event.isTrusted, missionId: mission.dataset.missionId };
    }, { capture: true, once: true });
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  await page.mouse.click(missionActivation.x, missionActivation.y);
  const missionActivated = await page.evaluate(() => window.__wo264MissionActivated);
  assert.deepEqual(missionActivated, { trusted: true, missionId: tab.bottomControl.missionId });

  await setOwnerPosition(page, surface, "max", false);
  const bottom = await scrollFacts(page, surface);
  assert(Math.abs(bottom.owner.scrollTop - bottom.owner.maxScrollTop) <= 2, `${surface} maximum scroll is unreachable`);
  assert.equal(bottom.bottomTechnology.visible, true, `${surface} final technology link is clipped at maximum scroll`);
  const activation = await page.evaluate(() => {
    const last = [...document.querySelectorAll(".demo-launcher-technology-card a")].at(-1);
    const rect = last.getBoundingClientRect();
    window.__wo264BottomActivated = null;
    last.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      window.__wo264BottomActivated = {
        trusted: event.isTrusted,
        name: last.firstChild?.textContent?.trim() || last.textContent.trim(),
        href: last.href,
      };
    }, { capture: true, once: true });
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  await page.mouse.click(activation.x, activation.y);
  const activated = await page.evaluate(() => window.__wo264BottomActivated);
  assert.deepEqual(activated, {
    trusted: true,
    name: bottom.bottomTechnology.name,
    href: bottom.bottomTechnology.href,
  });
  return { tab, bottom, missionActivated, technologyActivated: activated };
}

async function captureScrollTriplet(page, surface, prefix) {
  const captures = {};
  await setOwnerPosition(page, surface, 0, false);
  captures.top = await screenshot(page, `${prefix}-top.png`);
  const max = (await scrollFacts(page, surface)).owner.maxScrollTop;
  await setOwnerPosition(page, surface, Math.floor(max / 2), false);
  captures.middle = await screenshot(page, `${prefix}-middle.png`);
  await setOwnerPosition(page, surface, "max", false);
  captures.bottom = await screenshot(page, `${prefix}-bottom.png`);
  return captures;
}

async function listenerCount(page) {
  const session = await page.createCDPSession();
  const response = await session.send("Runtime.evaluate", {
    expression: "getEventListeners(document.getElementById('demo-launcher-mount')).keydown?.length || 0",
    includeCommandLineAPI: true,
    returnByValue: true,
  });
  await session.detach();
  return response.result.value;
}

async function openIntegrated(page, profile, exerciseWorld) {
  await configureViewport(page, profile);
  await page.goto(`http://127.0.0.1:${ports.frontend}/index.html?role=player&active=source&intro=0`, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await page.waitForFunction(() => document.body.dataset.assemblyReady === "1" && window.__assembly?.ready === true, { timeout: 60000 });
  const start = await page.$('[data-testid="start-exploring"]');
  if (start) {
    await page.$eval('[data-testid="start-exploring"]', (button) => button.click());
    await page.waitForFunction(() => !document.querySelector('[data-testid="start-exploring"]'));
  }
  await page.waitForFunction(() => {
    const visual = window.__assembly?.avatarVisualState?.();
    return window.__assembly?.equipmentReady?.() === true && visual?.avatar_switch_in_flight === false;
  }, { timeout: 60000, polling: 200 });
  await settle(page, 400);
  const world = {};
  if (exerciseWorld) {
    world.beforeWheel = await page.evaluate(() => window.__assembly.orbitCameraState().distance);
    await page.mouse.move(Math.floor(profile.width / 2), Math.floor(profile.height / 2));
    await page.mouse.wheel({ deltaY: 120 });
    await settle(page, 520);
    world.afterWheel = await page.evaluate(() => window.__assembly.orbitCameraState().distance);
    assert.notEqual(world.afterWheel, world.beforeWheel, "player wheel did not control the world before launcher open");
    await page.keyboard.down("w");
    await settle(page, 60);
    assert.equal(await page.evaluate(() => window.__assembly.controlState.forward), true, "held player key was not active before launcher open");
  }

  await page.click("#btn-views-home");
  await page.waitForFunction(() => !document.getElementById("demo-launcher-mount").hidden && document.getElementById("app").hidden);
  if (exerciseWorld) {
    world.heldKeyReleasedOnOpen = await page.evaluate(() => window.__assembly.controlState.forward === false);
    assert.equal(world.heldKeyReleasedOnOpen, true, "opening launcher left a held world key active");
    await page.keyboard.up("w");
    assert.equal(await page.evaluate(() => window.__assembly.controlState.forward), false, "launcher keyup reactivated world input");
  }
  assert.equal(await page.evaluate(() => document.activeElement?.classList.contains("demo-launcher")), true, "integrated launcher did not receive initial focus");
  return world;
}

async function lifecycleProof(page, profile) {
  const result = { firstListenerCount: await listenerCount(page) };
  assert.equal(result.firstListenerCount, 1, "launcher has duplicate or missing key listeners");
  await setOwnerPosition(page, "integrated", "max");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.getElementById("demo-launcher-mount").hidden && !document.getElementById("app").hidden);
  result.closed = await page.evaluate(() => ({
    mountHidden: document.getElementById("demo-launcher-mount").hidden,
    appHidden: document.getElementById("app").hidden,
    scrollTop: document.getElementById("demo-launcher-mount").scrollTop,
    activeId: document.activeElement?.id,
    childCount: document.getElementById("demo-launcher-mount").childElementCount,
  }));
  assert.deepEqual(result.closed, { mountHidden: true, appHidden: false, scrollTop: 0, activeId: "btn-views-home", childCount: 0 });
  const beforeWorldWheel = await page.evaluate(() => window.__assembly.orbitCameraState().distance);
  await page.mouse.move(Math.floor(profile.width / 2), Math.floor(profile.height / 2));
  await page.mouse.wheel({ deltaY: -120 });
  await settle(page, 520);
  const afterWorldWheel = await page.evaluate(() => window.__assembly.orbitCameraState().distance);
  assert.notEqual(afterWorldWheel, beforeWorldWheel, "player wheel did not resume after launcher close");
  result.worldWheelAfterClose = { before: beforeWorldWheel, after: afterWorldWheel };

  await page.click("#btn-views-home");
  await page.waitForFunction(() => !document.getElementById("demo-launcher-mount").hidden);
  result.reopened = await scrollFacts(page, "integrated");
  assert.equal(result.reopened.owner.scrollTop, 0, "integrated reopen did not return to top");
  assert.match(String(result.reopened.active), /demo-launcher/);
  result.secondListenerCount = await listenerCount(page);
  assert.equal(result.secondListenerCount, 1, "reopen duplicated the launcher key listener");
  return result;
}

async function runSurface(page, surface, profile) {
  const initial = await scrollFacts(page, surface);
  const order = await launcherOrderProof(page, surface);
  assert.equal(initial.viewport.width, profile.width);
  assert.equal(initial.viewport.height, profile.height);
  assert(initial.owner.scrollHeight > initial.owner.clientHeight, `${surface} is not vertically scrollable at ${profile.name}`);
  assert.equal(initial.document.scrollWidth <= initial.document.clientWidth, true, `${surface} has horizontal page overflow at ${profile.name}`);
  if (surface === "integrated") {
    assert.equal(initial.owner.id, "demo-launcher-mount");
    assert.equal(initial.owner.overflowY, "auto");
    assert.equal(initial.owner.touchAction, "auto");
    assert.deepEqual(initial.verticalOwners, ["demo-launcher-mount"]);
  } else {
    assert.equal(initial.owner.id, "document");
    assert.equal(initial.owner.touchAction, "auto");
  }
  const wheel = await wheelProof(page, surface, profile);
  const keyboard = await keyboardMatrix(page, surface);
  const touch = profile.mobile ? await touchProof(page, surface, profile) : null;
  const reach = await tabAndBottomProof(page, surface);
  const screenshots = profile.capture
    ? await captureScrollTriplet(page, surface, `${surface}-${profile.name}`)
    : {};
  return { initial, order, wheel, keyboard, touch, reach, screenshots };
}

async function runProfile(browser, profile, health) {
  const record = { profile, integrated: null, standalone: null, world: null, lifecycle: null };
  const integrated = await browser.newPage();
  const stopIntegratedHealth = bindHealth(integrated, `${profile.name}:integrated`, health);
  try {
    record.world = await openIntegrated(integrated, profile, profile.name === "desktop-1440x1000");
    record.integrated = await runSurface(integrated, "integrated", profile);
    if (profile.name === "desktop-1440x1000") record.lifecycle = await lifecycleProof(integrated, profile);
  } finally {
    stopIntegratedHealth();
    await integrated.close();
  }

  const standalone = await browser.newPage();
  const stopStandaloneHealth = bindHealth(standalone, `${profile.name}:standalone`, health);
  try {
    await configureViewport(standalone, profile);
    await standalone.goto(`http://127.0.0.1:${ports.frontend}/demo-launcher-preview.html`, {
      waitUntil: "networkidle0",
      timeout: 60000,
    });
    record.standalone = await runSurface(standalone, "standalone", profile);
  } finally {
    stopStandaloneHealth();
    await standalone.close();
  }
  return record;
}

async function main() {
  await mkdir(screenshotRoot, { recursive: true });
  await mkdir(path.dirname(evidencePath), { recursive: true });
  await rm(profilePath, { recursive: true, force: true });
  for (const port of Object.values(ports)) assert.equal(await isBindable(port), true, `assigned port ${port} is occupied`);

  const diagnostics = {
    schemaVersion: 1,
    workOrder: process.env.feature_WORK_ORDER || "runtime",
    homepagePhase,
    expectedHomepageOrder: feature_HOMEPAGE_PHASE_ORDERS[homepagePhase] || null,
    outcome: "RUNNING",
    startedAt: new Date().toISOString(),
    browser: { mode: "headed", executable: chromePath, cdp: ports.cdp, webdriver: null, userAgent: null, version: null },
    ports,
    profilePath,
    profiles: [],
    health: { console: [], consoleProblems: [], pageErrors: [], requestFailures: [], teardownAborts: [], httpErrors: [], avatarAssetRequests: [] },
    cleanup: { browser: false, frontend: false, backends: false, portsReleased: false, profileRemoved: false },
  };
  let backends = null;
  let frontend = null;
  let chrome = null;
  let browser = null;
  let failure = null;
  const chromeOutput = { stdout: "", stderr: "", pid: null, exitCode: null };
  try {
    const { startBackends, assertNotLiveDemoPorts } = require("./orchestrator.js");
    const { createFrontendServer } = require("./serve.js");
    assertNotLiveDemoPorts({ a: ports.a, b: ports.b, lobby: ports.lobby });
    backends = await startBackends({ backendPorts: { a: ports.a, b: ports.b, lobby: ports.lobby }, log: () => {} });
    frontend = await createFrontendServer(ports.frontend, {
      backendPorts: { a: ports.a, b: ports.b, lobby: ports.lobby },
      host: "127.0.0.1",
    });

    chrome = spawn(chromePath, [
      "--remote-debugging-address=127.0.0.1",
      `--remote-debugging-port=${ports.cdp}`,
      `--user-data-dir=${profilePath}`,
      "--no-sandbox",
      "--no-first-run",
      "--no-default-browser-check",
      "--password-store=basic",
      "--use-mock-keychain",
      "--window-size=1440,1000",
      "about:blank",
    ], { stdio: ["ignore", "pipe", "pipe"] });
    chromeOutput.pid = chrome.pid;
    chrome.stdout.on("data", (chunk) => { chromeOutput.stdout += chunk; });
    chrome.stderr.on("data", (chunk) => { chromeOutput.stderr += chunk; });
    chrome.once("exit", (code) => { chromeOutput.exitCode = code; });
    const version = await waitForCdp();
    diagnostics.browser.version = version.Browser;
    const browserMajor = version.Browser.match(/Chrome\/(\d+)\./)?.[1];
    assert.ok(browserMajor, `CDP browser version is not Chrome: ${version.Browser}`);
    const puppeteer = require("puppeteer-core");
    browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${ports.cdp}`, defaultViewport: null });
    const identityPage = (await browser.pages())[0] || await browser.newPage();
    const identity = await identityPage.evaluate(() => ({ webdriver: navigator.webdriver, userAgent: navigator.userAgent }));
    diagnostics.browser.webdriver = identity.webdriver;
    diagnostics.browser.userAgent = identity.userAgent;
    assert.equal(identity.webdriver, false, "headed validation must not expose navigator.webdriver");
    assert.match(identity.userAgent, new RegExp(`Chrome/${browserMajor}\\.`));
    await identityPage.close();

    for (const profile of profiles) diagnostics.profiles.push(await runProfile(browser, profile, diagnostics.health));
    diagnostics.health.unrelatedWorldAssetAborts = diagnostics.health.requestFailures.filter((failure) => (
      failure.error === "net::ERR_ABORTED" && /\/assets\/(avatars|mocap)\//.test(failure.url)
    ));
    diagnostics.health.relatedRequestFailures = diagnostics.health.requestFailures.filter((failure) => (
      !diagnostics.health.unrelatedWorldAssetAborts.includes(failure)
    ));
    assert.deepEqual(diagnostics.health.consoleProblems, [], "headed pages emitted console warnings/errors");
    assert.deepEqual(diagnostics.health.pageErrors, [], "headed pages emitted page errors");
    assert.deepEqual(diagnostics.health.relatedRequestFailures, [], "headed launcher pages had related request failures");
    assert.deepEqual(diagnostics.health.httpErrors, [], "headed pages had HTTP errors");
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
    } else if (chrome) {
      chrome.kill("SIGTERM");
    } else diagnostics.cleanup.browser = true;
    if (chrome && chrome.exitCode === null) {
      for (let attempt = 0; attempt < 30 && chrome.exitCode === null; attempt += 1) await delay(100);
      if (chrome.exitCode === null) chrome.kill("SIGKILL");
    }
    if (frontend) {
      try { await frontend.closeAll(); diagnostics.cleanup.frontend = true; }
      catch (error) { cleanupErrors.push(`frontend: ${error.message}`); }
    } else diagnostics.cleanup.frontend = true;
    if (backends) {
      try { await backends.stop(); diagnostics.cleanup.backends = true; }
      catch (error) { cleanupErrors.push(`backends: ${error.message}`); }
    } else diagnostics.cleanup.backends = true;
    diagnostics.cleanup.portsReleased = await waitForPortsReleased();
    if (!diagnostics.cleanup.portsReleased) cleanupErrors.push("assigned ports did not release");
    await rm(profilePath, { recursive: true, force: true });
    diagnostics.cleanup.profileRemoved = await stat(profilePath).then(() => false).catch(() => true);
    if (!diagnostics.cleanup.profileRemoved) cleanupErrors.push("owned Chrome profile was not removed");
    if (cleanupErrors.length) {
      diagnostics.cleanupErrors = cleanupErrors;
      diagnostics.outcome = "RED";
      failure ||= new Error(cleanupErrors.join("; "));
    }
    diagnostics.completedAt = new Date().toISOString();
    await writeFile(chromeLogPath, `${JSON.stringify(chromeOutput, null, 2)}\n`, "utf8");
    await writeFile(evidencePath, `${JSON.stringify(diagnostics, null, 2)}\n`, "utf8");
  }
  process.stdout.write(`runtime headed homepage scroll: ${diagnostics.outcome} profiles=${diagnostics.profiles.length}/${profiles.length} diagnostics=${evidencePath}\n`);
  if (failure) throw failure;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
