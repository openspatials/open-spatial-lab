// The leak check (quiet discovery): no maker's or issuer's server may learn of a visitor before the visitor selects a
// glance, and in a world whose place serves its extensions' code and withdrawn list, not even then. The real Lab page
// (web/index.html?wow=) opens two test worlds in turn, in one browser; every request the page makes is recorded
// (puppeteer request events). The second test origin of the static server stands for the maker; the issuer of the
// carriers' status addresses is that host over https, which no server answers.
//
// 1. leak-check: a world without a place store. Two nodes declare box-maker.wasm by its address on the maker, and one
//    points to a signed carrier on the page's own origin whose module and statusRef are on the maker. From load to the
//    moment before selection (load, then five seconds) no request may go to any origin but the page's own; then one
//    glance is clicked, and its module must be fetched from the maker, which shows the recorder sees such requests.
// 2. leak-check-through-start: a world with a place store and a withdrawn list (`webofworlds_extension.extension_store`
//    and `extension_status_list`). Its modules' own addresses are on the maker: a busy-timer module (a slow first timer
//    event, so the Extensions panel shows "slow" once the event has reached it) and box-maker.wasm in a carrier with a
//    statusRef the list does not name; a second carrier the list names as revoked. From load through the selection of
//    both glances, their start and one timer event, the page may ask no origin but its own. The Extensions panel must
//    show "code from this place" for both and "status not checked" for the carrier.
//
// The check prints the origins contacted. With OSL_UE_LEAK_SHOT_DIR set, it saves a screenshot of the Extensions panel
// of the second world there. One Chrome for Testing (headless, puppeteer-core) and the static server of the extension
// checks (src/fixtures/extension-host/check-server.mjs) on OSL_UE_LEAK_BROWSER_PORT (default 18355); its second port is
// the maker. The browser and the servers are always closed.
//
// Usage: node tools/extension-leak-check.mjs
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { nodeChecks } from "./behavior/node-checks.mjs";
import { findBrowser } from "./find-browser.mjs";
import { sleep, startServers, stopBrowser, stopServer } from "../src/fixtures/extension-host/check-server.mjs";
import { carrierManifest, newCarrierKey } from "../src/fixtures/extension-host/carrier.mjs";
import { UE_TEST_MODULES } from "../src/fixtures/extension-host/test-modules.mjs";
import { integrityOf } from "../runtime/extension-host/extension-host.mjs";
import { storeCopyName } from "../web/wow-extension-place-store.mjs";

const { check, finish } = nodeChecks("extension-leak");
const PORT = Number(process.env.OSL_UE_LEAK_BROWSER_PORT) || 18355;
// A copy run with a planted fault (OSL_PLANTED) saves no screenshot.
const SHOT_DIR = process.env.OSL_PLANTED ? "" : process.env.OSL_UE_LEAK_SHOT_DIR || "";
const WAIT_MS = 60000;
const SETTLE_MS = 5000;
const EVENT_MS = 15000;
const WORLD_PATH = "/__ue-leak/world.json";
const CARRIER_PATH = "/__ue-leak/carrier.json";
const PLACE_PATH = "/__ue-leak/place/world.json";
const BOX = { file: "/fixtures/extension-host/world/box-maker.wasm", integrity: "sha256-J+MEtqq8G4EwEbY5a6uiiQeUFTAXd9T4aSX6AiMsHqk=", binding: "ue-core/0" };
const BUSY_FILE = "/__ue-leak/busy-timer.wasm";
const { loadWorlds, publicWorlds } = createRequire(import.meta.url)("../src/worlds-config.js");
const oneLine = (error) => String((error && error.message) || error).replace(/\s+/g, " ").trim();
const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const at = (x, z) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, z, 1];

/** The test world: its modules on `maker`, one carrier on the page's origin. */
function leakWorld(maker) {
  const declared = (glance) => ({
    module: { url: `${maker}${BOX.file}`, integrity: BOX.integrity, binding: BOX.binding }, interface: "ue:host@0.1.0",
    attach: { kind: "world-node" }, requests: ["ue.console.log", "ue.scene.nodes"], limits: {}, ...(glance ? { glance } : {}),
  });
  return {
    spatialID: "extension-leak-world", title: "Extension leak world", root: 0,
    nodes: [
      { id: 0, label: "extension-leak-world", children: [1, 2, 3], localTransform: I },
      { id: 1, parent: 0, label: "maker-box", localTransform: at(-1.5, -2), webofworlds_extension: { universal_extensions: [declared({ line1: "Box maker", line2: "Makes one box", icon: "shop", action: "Open" })] } },
      { id: 2, parent: 0, label: "plain-box", localTransform: at(0, -2), webofworlds_extension: { universal_extensions: [declared(null)] } },
      { id: 3, parent: 0, label: "carried-box", localTransform: at(1.5, -2), webofworlds_extension: { universal_extension_manifests: [{ url: "carrier.json" }] } },
    ],
  };
}

/** The place world: a store and a withdrawn list on the page's origin; the modules' own addresses on `maker`. */
function placeWorld(maker, busy) {
  return {
    spatialID: "extension-leak-place-world", title: "Extension leak place world", root: 0,
    webofworlds_extension: { extension_store: { url: "store/" }, extension_status_list: { url: "withdrawn.json" } },
    nodes: [
      { id: 0, label: "extension-leak-place-world", children: [1, 2, 3], localTransform: I },
      { id: 1, parent: 0, label: "timer-box", localTransform: at(-1.5, -2), webofworlds_extension: { universal_extensions: [{
        module: { url: `${maker}${BUSY_FILE}`, integrity: busy.integrity, binding: "ue-core/0" }, interface: "ue:host@0.1.0",
        attach: { kind: "world-node" }, requests: ["ue.console.log", "ue.clock.read", "ue.clock.timer"], limits: {},
        glance: { line1: "Timer", line2: "Ticks once a second", icon: "info", action: "Open" },
      }] } },
      { id: 2, parent: 0, label: "carried-box", localTransform: at(0, -2), webofworlds_extension: { universal_extension_manifests: [{ url: "carrier.json" }] } },
      { id: 3, parent: 0, label: "withdrawn-box", localTransform: at(1.5, -2), webofworlds_extension: { universal_extension_manifests: [{ url: "withdrawn-carrier.json" }] } },
    ],
  };
}

const originOf = (url) => { try { const { protocol, origin } = new URL(url); return protocol === "http:" || protocol === "https:" ? origin : null; } catch { return null; } };
const hostOf = (url) => { try { return new URL(url).host; } catch { return null; } };
const origins = (urls) => [...new Set(urls.map(originOf).filter(Boolean))];

/** Opens `path` on the Lab page in a new tab, recording every request; resolves { page, requests }. */
async function openWorld(browser, pageOrigin, path) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 800 });
  const requests = [];
  page.on("request", (request) => requests.push(request.url()));
  await page.goto(`${pageOrigin}/index.html?role=source&intro=bypass&wow=${encodeURIComponent(path)}`, { waitUntil: "load", timeout: WAIT_MS });
  await page.waitForFunction(() => document.body.hasAttribute("data-wow-extensions"), { timeout: WAIT_MS });
  await page.waitForSelector('[data-testid="ue-glance"]', { timeout: 10000 }).catch(() => {});
  await sleep(SETTLE_MS);
  return { page, requests };
}
const glancesOn = (page) => page.evaluate(() => [...document.querySelectorAll('[data-testid="ue-glance"]')].map((button) => button.getAttribute("data-ue-glance")));
const clickGlance = (page, label) => page.evaluate((prefix) => {
  const button = document.querySelector(`[data-testid="ue-glance"][data-ue-glance^="${prefix}"]`);
  if (button) button.click();
  return !!button;
}, `${label}#`);

/** Loads both worlds, records their requests, selects glances. Resolves { facts, place, problem }, never rejects. */
async function runPages() {
  const facts = {}, place = {};
  let servers = [], browser = null, problem = null;
  try {
    const pages = { "/worlds.json": { type: ".json", body: JSON.stringify(publicWorlds(loadWorlds())) } };
    servers = await startServers({ port: PORT, netOrigin: "http://127.0.0.1:9", pages });
    const page0 = `http://127.0.0.1:${PORT}`, maker = `http://127.0.0.1:${servers[1].address().port}`;
    Object.assign(facts, { pageOrigin: page0, maker });
    pages[WORLD_PATH] = { type: ".json", body: JSON.stringify(leakWorld(maker)) };
    pages[CARRIER_PATH] = { type: ".json", body: JSON.stringify(carrierManifest({
      key: newCarrierKey(), subject: "urn:osl:check:world-node:carried-box",
      module: { url: `${maker}${BOX.file}`, integrity: BOX.integrity, binding: BOX.binding },
      attach: { kind: "world-node", anchor: "3" }, requests: [{ capability: "ue.scene.nodes", purpose: "draw the box" }],
      statusRef: `https://${hostOf(maker)}/status/carried-box`, glance: { line1: "Carried box", line2: "Signed by its maker", icon: "info", action: "Open" },
    })) };

    // The place world. Both servers serve the same pages, so the maker would answer for every module too.
    const busyBytes = UE_TEST_MODULES.ueBusyTimer({ delayMs: 1000, busyMs: 60, busyCalls: 1 });
    const busy = { integrity: await integrityOf(busyBytes) };
    const boxBytes = await readFile(new URL(`../src${BOX.file}`, import.meta.url));
    const key = newCarrierKey();
    const placeCarrier = (id, name, anchor) => JSON.stringify(carrierManifest({
      key, id, facetId: `urn:osl:check:facet:${name}`, subject: `urn:osl:check:world-node:${name}`,
      module: { url: `${maker}${BOX.file}`, integrity: BOX.integrity, binding: BOX.binding }, attach: { kind: "world-node", anchor },
      requests: [{ capability: "ue.scene.nodes", purpose: "draw the box" }], statusRef: `https://${hostOf(maker)}/status/${name}`,
      glance: { line1: "Carried box", line2: "Signed by its maker", icon: "info", action: "Open" },
    }));
    Object.assign(place, { issuer: `https://${hostOf(maker)}` });
    pages[BUSY_FILE] = { type: ".wasm", body: busyBytes };
    pages[PLACE_PATH] = { type: ".json", body: JSON.stringify(placeWorld(maker, busy)) };
    pages[`/__ue-leak/place/store/${storeCopyName(busy.integrity)}`] = { type: ".wasm", body: busyBytes };
    pages[`/__ue-leak/place/store/${storeCopyName(BOX.integrity)}`] = { type: ".wasm", body: boxBytes };
    pages["/__ue-leak/place/carrier.json"] = { type: ".json", body: placeCarrier("urn:uuid:leak-carried", "carried-box", "2") };
    pages["/__ue-leak/place/withdrawn-carrier.json"] = { type: ".json", body: placeCarrier("urn:uuid:leak-withdrawn", "withdrawn-box", "3") };
    pages["/__ue-leak/place/withdrawn.json"] = { type: ".json", body: JSON.stringify({ checkedAt: "2026-11-23T00:00:00Z", entries: [{ "@id": "urn:uuid:leak-withdrawn", status: "revoked" }] }) };

    const { default: puppeteer } = await import("puppeteer-core");
    browser = await puppeteer.launch({ executablePath: findBrowser(), headless: true, args: ["--no-first-run", "--no-default-browser-check"] });

    // 1. The world without a place store.
    {
      const { page, requests } = await openWorld(browser, page0, WORLD_PATH);
      facts.glances = await glancesOn(page);
      facts.before = requests.slice();
      // The moment of selection: a click on the maker-box glance.
      facts.clicked = await clickGlance(page, "maker-box");
      const end = Date.now() + 10000;
      while (Date.now() < end && !requests.slice(facts.before.length).some((url) => hostOf(url) === hostOf(maker))) await sleep(100);
      await sleep(500);
      facts.after = requests.slice(facts.before.length);
      await page.close();
    }

    // 2. The place world: load, select both glances, start, one timer event.
    {
      const { page, requests } = await openWorld(browser, page0, PLACE_PATH);
      place.glances = await glancesOn(page);
      place.atLoad = requests.length;
      place.clicked = [await clickGlance(page, "timer-box"), await clickGlance(page, "carried-box")];
      place.toggle = await page.waitForSelector('[data-testid="header-actions"] [data-testid="extensions-toggle"]', { timeout: 5000 }).then(() => true, () => false);
      if (place.toggle) await page.click('[data-testid="extensions-toggle"]');
      place.event = await page.waitForSelector('[data-testid="ue-extensions-panel"] [data-ue-extension^="timer-box#"] [data-ue-slow]', { timeout: EVENT_MS }).then(() => true, () => false);
      await sleep(500);
      place.rows = await page.evaluate(() => [...document.querySelectorAll('[data-testid="ue-extensions-panel"] [data-ue-extension]')].map((row) => ({
        id: row.getAttribute("data-ue-extension"), state: (row.querySelector("[data-ue-state]") || {}).textContent || "",
        code: (row.querySelector("[data-ue-code-source]") || {}).textContent || "", revocation: (row.querySelector("[data-ue-revocation]") || {}).textContent || "",
        slow: (row.querySelector("[data-ue-slow]") || { getAttribute: () => null }).getAttribute("data-ue-slow"),
      })));
      if (SHOT_DIR) {
        const panel = await page.$('[data-testid="ue-extensions-panel"]');
        if (panel) await page.screenshot({ path: join(SHOT_DIR, "ue-qd2-extensions-panel.png") });
      }
      place.requests = requests.slice();
      await page.close();
    }
  } catch (error) {
    problem = oneLine(error);
  } finally {
    await stopBrowser(browser);
    for (const server of servers) await stopServer(server);
  }
  return { facts, place, problem };
}

const { facts, place, problem } = await runPages();
const must = (value, message) => { if (!value) throw new Error(`${message}${problem ? ` (${problem})` : ""}`); };
if (facts.before) console.log(`origins contacted before selection: ${origins(facts.before).join(", ") || "none"} (${facts.before.length} requests; page ${facts.pageOrigin}, maker ${facts.maker})`);
if (facts.after) console.log(`origins contacted after selecting maker-box: ${origins(facts.after).join(", ") || "none"} (${facts.after.length} requests)`);
if (place.requests) {
  console.log(`place world: origins contacted from load through start: ${origins(place.requests).join(", ") || "none"} (${place.requests.length} requests; ${place.requests.length - place.atLoad} after selection; maker ${facts.maker}, issuer ${place.issuer})`);
  for (const row of place.rows || []) console.log(`place world: panel ${row.id}: ${row.state}${row.code ? `; ${row.code}` : ""}${row.revocation ? `; ${row.revocation}` : ""}${row.slow ? `; slow ${row.slow}` : ""}`);
}

await check("leak-check", "From load to the moment before selection the page asks no origin but its own; selecting a glance then fetches that module from the maker", () => {
  must(facts.before, "the page did not load");
  const toMaker = facts.before.filter((url) => hostOf(url) === hostOf(facts.maker));
  must(toMaker.length === 0, `before selection the page asked the maker origin: ${toMaker.map((url) => url.slice(0, 160)).join(" ")}`);
  const elsewhere = facts.before.filter((url) => originOf(url) && originOf(url) !== facts.pageOrigin);
  must(elsewhere.length === 0, `before selection the page asked another origin: ${elsewhere.map((url) => url.slice(0, 160)).join(" ")}`);
  must((facts.glances || []).length === 3, `the page shows ${(facts.glances || []).length} glance(s), not 3: ${JSON.stringify(facts.glances)}`);
  must(facts.clicked, "no maker-box glance to click");
  must(facts.after.includes(`${facts.maker}${BOX.file}`), `after selection the recorder saw no request for the module on the maker: ${JSON.stringify(origins(facts.after))}`);
});

await check("leak-check-through-start", "In a world with a place store and a withdrawn list, from load through selection, start and one event, the page asks no origin but its own", () => {
  must(place.requests, "the place world did not load");
  const elsewhere = place.requests.filter((url) => originOf(url) && originOf(url) !== facts.pageOrigin);
  must(elsewhere.length === 0, `from load through start the page asked another origin: ${elsewhere.map((url) => url.slice(0, 160)).join(" ")}`);
  must((place.glances || []).length === 2, `the place world shows ${(place.glances || []).length} glance(s), not 2 (the withdrawn carrier has none): ${JSON.stringify(place.glances)}`);
  must(place.clicked.every(Boolean), `a glance to click is missing: ${JSON.stringify(place.clicked)}`);
  must(place.event, `no timer event reached timer-box within ${EVENT_MS / 1000} s (no "slow" line): ${JSON.stringify(place.rows)}`);
  const row = (label) => (place.rows || []).find((item) => item.id.startsWith(`${label}#`)) || {};
  for (const label of ["timer-box", "carried-box"]) must(row(label).state === "running" && row(label).code === "code from this place", `${label} in the panel: ${JSON.stringify(row(label))}`);
  must(row("carried-box").revocation === "status not checked", `carried-box in the panel: ${JSON.stringify(row("carried-box"))}`);
  must(row("withdrawn-box").state === "refused", `withdrawn-box in the panel: ${JSON.stringify(row("withdrawn-box"))}`);
});

await finish({ checkFile: "tools/extension-leak-check.mjs", faults: [
  { statement: "leak-check", name: "one extension's module is fetched at load", expect: /before selection the page asked the maker origin: http:\/\/127\.0\.0\.1:\d+\/fixtures\/extension-host\/world\/box-maker\.wasm/,
    edits: [{ file: "web/wow-extension-mount.mjs", find: "    record.status = \"not-started\";\n    record.selectable = true;\n",
      replace: "    if (record.label === \"plain-box\") void fetchModule(resolveAssetUri(effective.module.url, worldUrl)).catch(() => {});\n    record.status = \"not-started\";\n    record.selectable = true;\n" }] },
  { statement: "leak-check-through-start", name: "a status request to the issuer at selection", expect: /from load through start the page asked another origin: https:\/\/127\.0\.0\.1:\d+\/status\/carried-box/,
    edits: [{ file: "web/wow-extension-mount.mjs", find: "    if (!loadExtension) return fail(record, \"worker\", \"no extension host injected\");\n",
      replace: "    if (!loadExtension) return fail(record, \"worker\", \"no extension host injected\");\n    if (record.carrier && record.carrier.status_ref) await fetchModule(record.carrier.status_ref).catch(() => {});\n" }] },
] });
