// The three cases of src/wow-extension-page-browser-check.mjs once at phone size: Playwright WebKit with its
// "iPhone 15" device descriptor (393 x 659 viewport, touch on, isMobile, scale 3, the iPhone user agent), every action a
// tap (locator.tap(), touchscreen.tap()), never a mouse click. This is an emulation in the desktop WebKit engine, not
// iOS Safari. It plants no faults and changes nothing: it reports each case, what it saw, and screenshots.
//
// Usage:
//   OSL_PLAYWRIGHT_MODULE=<folder of a playwright package> [PLAYWRIGHT_BROWSERS_PATH=<its browser cache>] \
//     bash ../demo-servers/browser-run.sh node tools/extension-page-phone.mjs [--out=<folder for screenshots and JSON>]
//
// The same servers as the page check: the extension checks' static server on 127.0.0.1:OSL_UE_PHONE_PORT (default
// 18363), with the host wrapper that keeps each loaded extension in globalThis.__uePageCheck, the world without
// extensions and /worlds.json, and the network cases' test server on a free port. The browser and the servers are
// always closed. Exit 0 when the three cases pass, 1 otherwise.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startNetServer } from "../src/fixtures/extension-host/net-server.mjs";
import { WORLD_5A_PATH, sleep, startServers, stopServer } from "../src/fixtures/extension-host/check-server.mjs";

const PORT = Number(process.env.OSL_UE_PHONE_PORT) || 18363;
const DEVICE = "iPhone 15";
const PLAIN_WORLD_PATH = "/__ue-page-check/world-without-extensions.json";
const WAIT_MS = 60000;
const oneLine = (error) => String((error && error.message) || error).replace(/\s+/g, " ").trim();
const require = createRequire(import.meta.url);
const { loadWorlds, publicWorlds } = require("../src/worlds-config.js");
const outArg = (process.argv.find((arg) => arg.startsWith("--out=")) || "").slice("--out=".length);
const out = outArg ? resolve(outArg) : null;
if (out) mkdirSync(out, { recursive: true });
if (!process.env.OSL_PLAYWRIGHT_MODULE) throw new Error("OSL_PLAYWRIGHT_MODULE must name the folder of a playwright package");
const playwright = require(resolve(process.env.OSL_PLAYWRIGHT_MODULE));

const HOST_WRAPPER = `
export * from "/__ue-real-host/extension-host.mjs";
import { loadExtension as load } from "/__ue-real-host/extension-host.mjs";
export async function loadExtension(args) {
  const extension = await load(args);
  const url = String((args && args.declaration && args.declaration.module && args.declaration.module.url) || "");
  (globalThis.__uePageCheck ||= []).push({ label: (url.match(/([a-z-]+)\\.wasm/) || [])[1] || "?", extension });
  return extension;
}
`;
const IN_PAGE = `
window.__ueExt = (label) => { const item = (globalThis.__uePageCheck || []).find((entry) => entry.label === label); return item && item.extension; };
window.__ueFetchLines = (label) => { const ext = window.__ueExt(label); return ext ? ext.log.filter((line) => line.startsWith("fetch ")) : []; };
window.__uePointerTypes = [];
for (const name of ["pointerdown", "pointerup", "click", "touchstart", "touchend", "mousedown"]) {
  window.addEventListener(name, (event) => window.__uePointerTypes.push(name + ":" + (event.pointerType || "")), { capture: true, passive: true });
}
`;
const pageUrl = (world) => `http://127.0.0.1:${PORT}/index.html?role=source&intro=bypass&wow=${encodeURIComponent(world)}`;

async function shot(page, name) {
  if (!out) return null;
  const path = join(out, `phone-${name}.png`);
  await page.screenshot({ path }).catch(() => {});
  return path;
}

/** Answers the consent dialogs as they come, by tapping: plan[label] is "allow" or "deny". Returns what it saw. */
async function tapDialogs(page, plan) {
  const seen = [];
  const end = Date.now() + WAIT_MS;
  while (Date.now() < end && !Object.keys(plan).every((label) => seen.some((item) => item.label === label))) {
    const dialog = page.locator('[data-testid="ue-consent-dialog"]').first();
    if (!(await dialog.count())) { await sleep(100); continue; }
    const label = String((await dialog.getAttribute("data-ue-extension")) || "").replace(/#\d+$/, "");
    const box = await dialog.boundingBox();
    const button = dialog.locator(`[data-ue-action="${plan[label] || "deny"}"]`);
    const buttonBox = await button.boundingBox();
    if (!seen.length) await shot(page, "consent-dialog");
    await button.tap({ timeout: 5000 });
    await dialog.waitFor({ state: "detached", timeout: 5000 }).catch(() => {});
    seen.push({ label, answer: plan[label] || "deny", dialog: box, button: buttonBox });
  }
  return seen;
}

async function run() {
  const facts = { device: DEVICE };
  let servers = [], netServer = null, browser = null, problem = null;
  try {
    netServer = await startNetServer({ allowOrigin: `http://127.0.0.1:${PORT}` });
    const worldFile = fileURLToPath(new URL(`../src/fixtures/extension-host/world/${WORLD_5A_PATH.split("/").pop()}`, import.meta.url));
    const world = JSON.parse(readFileSync(worldFile, "utf8"));
    for (const node of world.nodes) delete node.webofworlds_extension;
    servers = await startServers({
      port: PORT, netOrigin: netServer.origin,
      pages: {
        "/vendor/extension-host/extension-host.mjs": { type: ".mjs", body: HOST_WRAPPER },
        [PLAIN_WORLD_PATH]: { type: ".json", body: JSON.stringify(world) },
        "/worlds.json": { type: ".json", body: JSON.stringify(publicWorlds(loadWorlds())) },
      },
      routes: [["/__ue-real-host/", "runtime/extension-host/"]],
    });
    browser = await playwright.webkit.launch({ headless: true });
    facts.version = browser.version();
    const descriptor = playwright.devices[DEVICE];
    facts.descriptor = { viewport: descriptor.viewport, deviceScaleFactor: descriptor.deviceScaleFactor, isMobile: descriptor.isMobile, hasTouch: descriptor.hasTouch };
    const context = await browser.newContext({ ...descriptor });
    await context.addInitScript(IN_PAGE);
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(oneLine(error)));

    await page.goto(pageUrl(WORLD_5A_PATH), { waitUntil: "load", timeout: WAIT_MS });
    await page.waitForFunction(() => document.body.hasAttribute("data-wow-extensions"), null, { timeout: WAIT_MS });
    facts.page = await page.evaluate(() => ({ inner: [innerWidth, innerHeight], touch: navigator.maxTouchPoints, coarse: matchMedia("(pointer: coarse)").matches, ua: navigator.userAgent }));
    facts.dialogs = await tapDialogs(page, { fetcher: "allow", "storage-user": "deny", "pointer-listener": "allow" });

    // Case 1: tap the header button; the panel opens.
    const toggle = page.locator('[data-testid="header-actions"] [data-testid="extensions-toggle"]');
    facts.button = await toggle.waitFor({ state: "attached", timeout: 5000 }).then(() => true, () => false);
    if (facts.button) {
      facts.buttonBox = await toggle.boundingBox();
      facts.buttonVisible = await toggle.isVisible();
      facts.buttonTap = await toggle.tap({ timeout: 5000 }).then(() => "tapped", (error) => oneLine(error));
      await sleep(400);
      facts.panelRows = await page.evaluate(() => [...document.querySelectorAll('[data-testid="ue-extensions-panel"] [data-ue-extension]')]
        .map((row) => row.getAttribute("data-ue-extension").replace(/#\d+$/, "")));
      facts.panelBox = await page.locator('[data-testid="ue-extensions-panel"]').boundingBox().catch(() => null);
      facts.panelStates = await page.evaluate(() => [...document.querySelectorAll('[data-testid="ue-extensions-panel"] [data-ue-extension]')]
        .map((row) => `${row.getAttribute("data-ue-extension")}: ${(row.querySelector("[data-ue-state]") || {}).textContent} (${(row.querySelector(".ue-extension-tokens") || {}).textContent})`));
      facts.loaded = await page.evaluate(() => (globalThis.__uePageCheck || []).map((entry) => `${entry.label}: ${entry.extension.ok ? "ok" : `${entry.extension.stage} ${entry.extension.error}`}`));
      facts.log = await page.evaluate(() => [...document.querySelectorAll("*")].filter((node) => node.children.length === 0 && /wow extension/.test(node.textContent || "")).map((node) => node.textContent).slice(0, 12));
      await shot(page, "extensions-panel");
    }

    // Case 2: the fetcher runs with its grant, then a tap on Withdraw in the panel.
    facts.fetchOk = await page.waitForFunction(() => {
      const ext = window.__ueExt("fetcher");
      return !!ext && ext.events.some((item) => item.event && item.event.type === "fetch" && item.event.status === 200 && !item.event.error);
    }, null, { timeout: 10000 }).then(() => true, () => false);
    const withdraw = page.locator('[data-testid="ue-extensions-panel"] [data-ue-withdraw^="fetcher#"]');
    facts.withdrawBox = await withdraw.boundingBox().catch(() => null);
    facts.withdrawTap = (await withdraw.count()) && (await withdraw.isEnabled())
      ? await withdraw.tap({ timeout: 5000 }).then(() => "tapped", (error) => oneLine(error))
      : "no enabled Withdraw button";
    // The count is taken once the tap has landed (a tap first waits for the button to be ready, while the fetcher
    // polls), and after one fetch period, so a call already running with the old grant is not counted.
    await sleep(300);
    facts.fetchBefore = await page.evaluate(() => window.__ueFetchLines("fetcher"));
    await sleep(2000);
    facts.fetchAfter = (await page.evaluate(() => window.__ueFetchLines("fetcher"))).slice(facts.fetchBefore.length);
    if (facts.button && (await page.locator('[data-testid="ue-extensions-panel"]').count())) {
      facts.closeTap = await toggle.tap({ timeout: 5000 }).then(() => "tapped", (error) => oneLine(error));
      await sleep(300);
    }

    // Case 3: tap the scene canvas at the screen position of the pointer listener's node (the world node at x = 2).
    const target = await page.evaluate(async () => {
      const THREE = await import("three");
      const controls = window.__wowViewControls;
      if (!controls) return { error: "the page has no view controls" };
      const canvas = [...document.querySelectorAll("canvas")].sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0];
      const rect = canvas.getBoundingClientRect();
      const pose = controls.pose();
      const camera = new THREE.PerspectiveCamera(50, rect.width / rect.height, 0.1, 2000);
      camera.position.fromArray(pose.position);
      camera.lookAt(new THREE.Vector3().fromArray(pose.position).add(new THREE.Vector3().fromArray(pose.direction)));
      camera.updateMatrixWorld();
      const ndc = new THREE.Vector3(2, 0.25, 0).project(camera);
      const x = rect.left + ((ndc.x + 1) / 2) * rect.width, y = rect.top + ((1 - ndc.y) / 2) * rect.height;
      const top = document.elementFromPoint(x, y);
      window.__uePointerTypes.length = 0;
      return { x, y, ndc: [ndc.x, ndc.y], canvas: [rect.left, rect.top, rect.width, rect.height], onCanvas: top === canvas, topElement: top ? top.tagName.toLowerCase() + (top.getAttribute("data-testid") ? `[${top.getAttribute("data-testid")}]` : "") : null };
    });
    facts.target = target;
    if (!target.error) {
      await page.touchscreen.tap(target.x, target.y);
      await sleep(1000);
      facts.click = await page.evaluate(() => {
        const ext = window.__ueExt("pointer-listener");
        return { events: ext ? ext.events.filter((item) => item.event && item.event.type === "pointer").map((item) => item.event.event) : null, dom: [...window.__uePointerTypes] };
      });
      await shot(page, "after-tap");
    }

    // A world without extensions: no button.
    await page.goto(pageUrl(PLAIN_WORLD_PATH), { waitUntil: "load", timeout: WAIT_MS });
    await page.waitForFunction(() => document.body.hasAttribute("data-wow-assets-loaded"), null, { timeout: WAIT_MS });
    await sleep(1500);
    facts.plain = await page.evaluate(() => ({ header: !!document.querySelector('[data-testid="header-actions"]'), button: !!document.querySelector('[data-testid="extensions-toggle"]') }));
    facts.pageErrors = pageErrors;
    await context.close();
  } catch (error) {
    problem = oneLine(error);
  } finally {
    if (browser) await Promise.race([browser.close().catch(() => {}), sleep(10000)]);
    for (const server of servers) await stopServer(server);
    if (netServer) await netServer.close();
  }
  return { facts, problem };
}

const { facts, problem } = await run();
const rows = [];
const verdict = (id, says, test) => {
  let detail = null;
  try { test(); } catch (error) { detail = `${oneLine(error)}${problem ? ` (${problem})` : ""}`; }
  rows.push({ id, ok: !detail, says, detail });
};
const must = (value, message) => { if (!value) throw new Error(message); };
verdict("page-extensions-button", "A tap on the Extensions button opens the panel listing the three extensions; a world without extensions shows no button", () => {
  must(facts.button, "no Extensions button in the world header");
  must(facts.buttonTap === "tapped", `the button could not be tapped: ${facts.buttonTap}`);
  const panelRows = facts.panelRows || [];
  must(["fetcher", "storage-user", "pointer-listener"].every((label) => panelRows.includes(label)), `the panel lists ${JSON.stringify(panelRows)}`);
  must(facts.plain && facts.plain.header, "the world without extensions has no header actions");
  must(!facts.plain.button, "a world without extensions shows the Extensions button");
});
verdict("page-withdraw", "After a tap on Allow the fetcher's fetch succeeds; a tap on Withdraw makes its next fetch return -2", () => {
  must(facts.dialogs && facts.dialogs.some((item) => item.label === "fetcher"), `no consent dialog was tapped for the fetcher: ${JSON.stringify(facts.dialogs)}`);
  must(facts.fetchOk, `after Allow the fetcher's fetch did not succeed: ${JSON.stringify(facts.fetchBefore)}`);
  must(facts.withdrawTap === "tapped", `Withdraw: ${facts.withdrawTap}`);
  const after = facts.fetchAfter || [];
  must(after.length > 0 && after.every((line) => line === "fetch -2"), `after Withdraw the fetches returned ${JSON.stringify(after)}`);
});
verdict("page-pointer-click", "With ue.input.pointer allowed by a tap, a tap on the canvas at the pointer listener's node reaches it as a click event", () => {
  must(facts.dialogs && facts.dialogs.some((item) => item.label === "pointer-listener"), `no consent dialog for the pointer listener: ${JSON.stringify(facts.dialogs)}`);
  must(facts.target && !facts.target.error, `no tap target: ${facts.target && facts.target.error}`);
  must(facts.click && Array.isArray(facts.click.events) && facts.click.events.includes("click"), `no click reached the pointer listener at ${JSON.stringify(facts.target && [Math.round(facts.target.x), Math.round(facts.target.y)])}: ${JSON.stringify(facts.click)}`);
});

console.log(`${DEVICE} in Playwright WebKit ${facts.version || "(did not start)"} (an emulation in the desktop WebKit engine)${problem ? `: ${problem}` : ""}`);
for (const row of rows) console.log(`  ${row.ok ? "PASS" : "FAIL"}  ${row.id}${row.ok ? "" : `: ${row.detail}`}`);
console.log(`facts: ${JSON.stringify(facts)}`);
if (out) writeFileSync(join(out, "phone-run.json"), `${JSON.stringify({ rows, facts, problem }, null, 2)}\n`);
console.log(`extension-page-phone: ${rows.filter((row) => row.ok).length}/${rows.length}`);
process.exitCode = rows.every((row) => row.ok) ? 0 : 1;
