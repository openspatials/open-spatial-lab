// The leak check (quiet discovery, Lab packet QD-1): no maker's server may learn of a visitor before the visitor
// selects a glance. The real Lab page (web/index.html?wow=) opens a test world whose extensions' modules and status
// address are on a second test origin, which stands for a maker: two nodes declare box-maker.wasm by its address there,
// and one points to a signed carrier on the page's own origin whose module and statusRef are there. Every request the
// page makes is recorded (puppeteer request events). From load to the moment before selection (load, then five
// seconds) no request may go to any origin but the page's own; then one glance is clicked, and its module must be
// fetched from the maker, which shows the recorder sees such requests. The check prints the origins contacted before
// and after selection.
//
// One Chrome for Testing (headless, puppeteer-core) and the static server of the extension checks
// (src/fixtures/extension-host/check-server.mjs) on OSL_UE_LEAK_BROWSER_PORT (default 18355); its second port is the
// maker. The browser and the servers are always closed.
//
// Usage: node tools/extension-leak-check.mjs
import { createRequire } from "node:module";
import { nodeChecks } from "./behavior/node-checks.mjs";
import { findBrowser } from "./find-browser.mjs";
import { sleep, startServers, stopBrowser, stopServer } from "../src/fixtures/extension-host/check-server.mjs";
import { carrierManifest, newCarrierKey } from "../src/fixtures/extension-host/carrier.mjs";

const { check, finish } = nodeChecks("extension-leak");
const PORT = Number(process.env.OSL_UE_LEAK_BROWSER_PORT) || 18355;
const WAIT_MS = 60000;
const SETTLE_MS = 5000;
const WORLD_PATH = "/__ue-leak/world.json";
const CARRIER_PATH = "/__ue-leak/carrier.json";
const BOX = { file: "/fixtures/extension-host/world/box-maker.wasm", integrity: "sha256-J+MEtqq8G4EwEbY5a6uiiQeUFTAXd9T4aSX6AiMsHqk=", binding: "ue-core/0" };
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

const originOf = (url) => { try { const { protocol, origin } = new URL(url); return protocol === "http:" || protocol === "https:" ? origin : null; } catch { return null; } };
const hostOf = (url) => { try { return new URL(url).host; } catch { return null; } };
const origins = (urls) => [...new Set(urls.map(originOf).filter(Boolean))];

/** Loads the page, records its requests, selects one glance. Resolves { facts, problem }, never rejects. */
async function runPage() {
  const facts = {};
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
    const { default: puppeteer } = await import("puppeteer-core");
    browser = await puppeteer.launch({ executablePath: findBrowser(), headless: true, args: ["--no-first-run", "--no-default-browser-check"] });
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 800 });
    const requests = [];
    page.on("request", (request) => requests.push(request.url()));
    await page.goto(`${page0}/index.html?role=source&intro=bypass&wow=${encodeURIComponent(WORLD_PATH)}`, { waitUntil: "load", timeout: WAIT_MS });
    await page.waitForFunction(() => document.body.hasAttribute("data-wow-extensions"), { timeout: WAIT_MS });
    await page.waitForSelector('[data-testid="ue-glance"]', { timeout: 10000 }).catch(() => {});
    await sleep(SETTLE_MS);
    facts.glances = await page.evaluate(() => [...document.querySelectorAll('[data-testid="ue-glance"]')].map((button) => button.getAttribute("data-ue-glance")));
    facts.before = requests.slice();
    // The moment of selection: a click on the maker-box glance.
    facts.clicked = await page.evaluate(() => {
      const button = document.querySelector('[data-testid="ue-glance"][data-ue-glance^="maker-box#"]');
      if (button) button.click();
      return !!button;
    });
    const end = Date.now() + 10000;
    while (Date.now() < end && !requests.slice(facts.before.length).some((url) => hostOf(url) === hostOf(maker))) await sleep(100);
    await sleep(500);
    facts.after = requests.slice(facts.before.length);
  } catch (error) {
    problem = oneLine(error);
  } finally {
    await stopBrowser(browser);
    for (const server of servers) await stopServer(server);
  }
  return { facts, problem };
}

const { facts, problem } = await runPage();
const must = (value, message) => { if (!value) throw new Error(`${message}${problem ? ` (${problem})` : ""}`); };
if (facts.before) console.log(`origins contacted before selection: ${origins(facts.before).join(", ") || "none"} (${facts.before.length} requests; page ${facts.pageOrigin}, maker ${facts.maker})`);
if (facts.after) console.log(`origins contacted after selecting maker-box: ${origins(facts.after).join(", ") || "none"} (${facts.after.length} requests)`);

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

await finish({ checkFile: "tools/extension-leak-check.mjs", faults: [
  { statement: "leak-check", name: "one extension's module is fetched at load", expect: /before selection the page asked the maker origin: http:\/\/127\.0\.0\.1:\d+\/fixtures\/extension-host\/world\/box-maker\.wasm/,
    edits: [{ file: "web/wow-extension-mount.mjs", find: "    record.status = \"not-started\";\n    record.selectable = true;\n",
      replace: "    if (record.label === \"plain-box\") void fetchModule(resolveAssetUri(effective.module.url, worldUrl)).catch(() => {});\n    record.status = \"not-started\";\n    record.selectable = true;\n" }] },
] });
