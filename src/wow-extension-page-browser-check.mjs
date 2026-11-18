// Extensions on the real Lab page: web/index.html opened with ?wow= set to the Step 5a test world
// (src/fixtures/extension-host/world/extension-world-5a.json), so web/three-wow-presentation.mjs mounts the extensions,
// adds the header "Extensions" button and attaches pointer input to the scene canvas (mountExtensionUi).
//
// One Chrome for Testing (headless, puppeteer-core), the static server of the mount check
// (fixtures/extension-host/check-server.mjs) on OSL_UE_PAGE_BROWSER_PORT (default 18354), and the test network server
// (fixtures/extension-host/net-server.mjs). The check's server serves one more file: /vendor/extension-host/
// extension-host.mjs is a wrapper that re-exports the real host (served at /__ue-real-host/) and keeps each loaded
// extension in globalThis.__uePageCheck, so the check can read extension.log and extension.events. A second page load
// opens the same world with its extensions taken out. /worlds.json is the list src/serve.js answers. The browser and the servers are always closed.
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { nodeChecks } from "../tools/behavior/node-checks.mjs";
import { findBrowser } from "../tools/find-browser.mjs";
import { startNetServer } from "./fixtures/extension-host/net-server.mjs";
import { WORLD_5A_PATH, sleep, startServers, stopBrowser, stopServer } from "./fixtures/extension-host/check-server.mjs";

const { check, finish } = nodeChecks("wow-extension-page-browser");
const PORT = Number(process.env.OSL_UE_PAGE_BROWSER_PORT) || 18354;
const PLAIN_WORLD_PATH = "/__ue-page-check/world-without-extensions.json";
const WAIT_MS = 60000;
// The page reads its list of worlds at /worlds.json, as src/serve.js answers it.
const { loadWorlds, publicWorlds } = createRequire(import.meta.url)("./worlds-config.js");
const oneLine = (error) => String((error && error.message) || error).replace(/\s+/g, " ").trim();

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

const pageUrl = (world) => `http://127.0.0.1:${PORT}/index.html?role=source&intro=bypass&wow=${encodeURIComponent(world)}`;

// In the page: the extension the host wrapper kept for a label.
const IN_PAGE = `
window.__ueExt = (label) => { const item = (globalThis.__uePageCheck || []).find((entry) => entry.label === label); return item && item.extension; };
window.__ueFetchLines = (label) => { const ext = window.__ueExt(label); return ext ? ext.log.filter((line) => line.startsWith("fetch ")) : []; };
`;

/** Answers the consent dialogs as they come: plan[label] is "allow" or "deny". Returns the labels seen. */
async function answerDialogs(page, plan) {
  return page.evaluate(async (plan, waitMs) => {
    const seen = [];
    const end = performance.now() + waitMs;
    while (performance.now() < end && !Object.keys(plan).every((label) => seen.includes(label))) {
      const dialog = [...document.querySelectorAll('[data-testid="ue-consent-dialog"]')].find((item) => !item.__ueAnswered);
      if (!dialog) { await new Promise((done) => setTimeout(done, 100)); continue; }
      dialog.__ueAnswered = true;
      const label = String(dialog.getAttribute("data-ue-extension") || "").replace(/#\d+$/, "");
      seen.push(label);
      dialog.querySelector(`[data-ue-action="${plan[label] || "deny"}"]`).click();
    }
    return seen;
  }, plan, WAIT_MS);
}

/** Runs both page loads. Resolves { facts, problem }, never rejects. */
async function runPage() {
  const facts = {};
  let servers = [], netServer = null, browser = null, problem = null;
  try {
    netServer = await startNetServer({ allowOrigin: `http://127.0.0.1:${PORT}` });
    const world = JSON.parse(await readFile(fileURLToPath(new URL(`./fixtures/extension-host/world/${WORLD_5A_PATH.split("/").pop()}`, import.meta.url)), "utf8"));
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
    const { default: puppeteer } = await import("puppeteer-core");
    browser = await puppeteer.launch({ executablePath: findBrowser(), headless: true, args: ["--no-first-run", "--no-default-browser-check"] });
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 800 });
    await page.evaluateOnNewDocument(IN_PAGE);

    // The 5a world: allow the fetcher and the pointer listener, deny the storage user.
    await page.goto(pageUrl(WORLD_5A_PATH), { waitUntil: "load", timeout: WAIT_MS });
    await page.waitForFunction(() => document.body.hasAttribute("data-wow-extensions"), { timeout: WAIT_MS });
    facts.dialogs = await answerDialogs(page, { fetcher: "allow", "storage-user": "deny", "pointer-listener": "allow" });

    // Case 1: the header button opens the panel.
    facts.button = await page.waitForSelector('[data-testid="header-actions"] [data-testid="extensions-toggle"]', { timeout: 5000 }).then(() => true, () => false);
    if (facts.button) {
      await page.evaluate(() => document.querySelector('[data-testid="extensions-toggle"]').click());
      await sleep(300);
      facts.panelRows = await page.evaluate(() => [...document.querySelectorAll('[data-testid="ue-extensions-panel"] [data-ue-extension]')]
        .map((row) => row.getAttribute("data-ue-extension").replace(/#\d+$/, "")));
    }

    // Case 2: the fetcher runs with its grant, then Withdraw in the panel.
    facts.fetchOk = await page.waitForFunction(() => {
      const ext = window.__ueExt("fetcher");
      return !!ext && ext.events.some((item) => item.event && item.event.type === "fetch" && item.event.status === 200 && !item.event.error);
    }, { timeout: 10000 }).then(() => true, () => false);
    facts.fetchBefore = await page.evaluate(() => window.__ueFetchLines("fetcher"));
    facts.withdrawClicked = await page.evaluate(() => {
      const button = document.querySelector('[data-testid="ue-extensions-panel"] [data-ue-withdraw^="fetcher#"]');
      if (!button || button.disabled) return false;
      button.click();
      return true;
    });
    await sleep(2000);
    facts.fetchAfter = (await page.evaluate(() => window.__ueFetchLines("fetcher"))).slice(facts.fetchBefore.length);
    if (facts.button) await page.evaluate(() => { if (document.querySelector('[data-testid="ue-extensions-panel"]')) document.querySelector('[data-testid="extensions-toggle"]').click(); });

    // Case 3: click the scene canvas at the screen position of the pointer listener's node (the world node at x = 2).
    facts.click = await page.evaluate(async () => {
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
      const init = { clientX: x, clientY: y, bubbles: true, pointerId: 1, pointerType: "mouse", isPrimary: true, button: 0 };
      canvas.dispatchEvent(new PointerEvent("pointermove", init));
      canvas.dispatchEvent(new PointerEvent("pointerdown", init));
      canvas.dispatchEvent(new PointerEvent("pointerup", init));
      canvas.dispatchEvent(new MouseEvent("click", init));
      await new Promise((done) => setTimeout(done, 1000));
      const ext = window.__ueExt("pointer-listener");
      return { at: [Math.round(x), Math.round(y)], events: ext ? ext.events.filter((item) => item.event && item.event.type === "pointer").map((item) => item.event.event) : null };
    });

    // A world without extensions: no button.
    await page.goto(pageUrl(PLAIN_WORLD_PATH), { waitUntil: "load", timeout: WAIT_MS });
    await page.waitForFunction(() => document.body.hasAttribute("data-wow-assets-loaded"), { timeout: WAIT_MS });
    await sleep(1500);
    facts.plain = await page.evaluate(() => ({
      header: !!document.querySelector('[data-testid="header-actions"]'),
      button: !!document.querySelector('[data-testid="extensions-toggle"]'),
    }));
  } catch (error) {
    problem = oneLine(error);
  } finally {
    await stopBrowser(browser);
    for (const server of servers) await stopServer(server);
    if (netServer) await netServer.close();
  }
  return { facts, problem };
}

const { facts, problem } = await runPage();
const must = (value, message) => { if (!value) throw new Error(`${message}${problem ? ` (${problem})` : ""}`); };

await check("page-extensions-button", "The world header shows the Extensions button; a click opens the panel listing the fetcher, the storage user and the pointer listener; a world without extensions shows no button", () => {
  must(facts.button, "no Extensions button in the world header");
  const rows = facts.panelRows || [];
  must(["fetcher", "storage-user", "pointer-listener"].every((label) => rows.includes(label)), `the panel lists ${JSON.stringify(rows)}`);
  must(facts.plain && facts.plain.header, "the world without extensions has no header actions");
  must(!facts.plain.button, "a world without extensions shows the Extensions button");
});

await check("page-withdraw", "After Allow the fetcher's fetch succeeds; Withdraw for the fetcher in the panel makes its next fetch return -2", () => {
  must(facts.fetchOk, `after Allow the fetcher's fetch did not succeed: ${JSON.stringify(facts.fetchBefore)}`);
  must(facts.withdrawClicked, "the panel has no enabled Withdraw button for the fetcher");
  const after = facts.fetchAfter || [];
  must(after.length > 0 && after.every((line) => line === "fetch -2"), `after Withdraw the fetches returned ${JSON.stringify(after)}`);
});

await check("page-pointer-click", "With ue.input.pointer allowed, a click on the canvas at the pointer listener's node reaches it as a click event", () => {
  must(facts.dialogs && facts.dialogs.includes("pointer-listener"), `no consent dialog for the pointer listener: ${JSON.stringify(facts.dialogs)}`);
  must(facts.click && !facts.click.error, `the click did not run: ${facts.click && facts.click.error}`);
  must(Array.isArray(facts.click.events) && facts.click.events.includes("click"), `no click reached the pointer listener at ${JSON.stringify(facts.click.at)}: ${JSON.stringify(facts.click.events)}`);
});

const PAGE_FILE = "web/three-wow-presentation.mjs";
await finish({ checkFile: "src/wow-extension-page-browser-check.mjs", faults: [
  { statement: "page-extensions-button", name: "mountExtensionUi does not add the button", expect: /no Extensions button in the world header/,
    edits: [{ file: PAGE_FILE, find: "      actions.prepend(button);\n", replace: "" }] },
  { statement: "page-withdraw", name: "the panel gets a mount whose withdraw does nothing", expect: /after Withdraw the fetches returned/,
    edits: [{ file: PAGE_FILE, find: "          mounted,\n          onClose: () => {", replace: "          mounted: Object.create(mounted, { withdraw: { value: () => {} } }),\n          onClose: () => {" }] },
  { statement: "page-pointer-click", name: "mountExtensionUi does not call attachExtensionPointer", expect: /no click reached the pointer listener/,
    edits: [{ file: PAGE_FILE, find: "      const pointer = attachExtensionPointer({ THREE, camera: built.camera, scene: built.scene, canvas, mounted });\n      undo.push(() => pointer.dispose());\n",
      replace: "" }] },
] });
