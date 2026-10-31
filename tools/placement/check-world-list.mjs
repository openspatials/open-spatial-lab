// Check: one world list. A world added to a temporary worlds file appears in the launcher and the frontend routes with
// no other edit, and web/ holds no other hand-written world or port list.
//
// Run:  npm run -s check:world-list
//
// It starts its own lab from its own worlds file on ports 33490-33496, opens the launcher in headless Chrome and
// uses a real mouse click. Screenshots and results go under OSL_PROOF_DIR (default .runtime/placement-proof).
// Each statement has a planted fault that must turn it red. Exits 0 only when all pass and all faults are caught.
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CODE = resolve(HERE, "..", "..");
const OUT = join(process.env.OSL_PROOF_DIR ? resolve(process.env.OSL_PROOF_DIR) : join(CODE, ".runtime", "placement-proof"), "world-list");
const RUN_DIR = join(OUT, "runtime");
const WORLDS_FILE = join(OUT, "worlds.json");
const require = createRequire(join(CODE, "package.json"));
const puppeteer = require("puppeteer-core");
const { findBrowser } = await import(pathToFileURL(join(CODE, "tools", "find-browser.mjs")).href);

const FRONT = Number(process.env.OSL_WORLD_LIST_PORT) || 33490;
const SECOND_FRONT = FRONT + 6;
const PORT = { a: FRONT + 1, b: FRONT + 2, lobby: FRONT + 3, airport: FRONT + 4, e: FRONT + 5 };
const addr = (key) => `http://127.0.0.1:${PORT[key]}/`;
const WORLD_E = { key: "e", name: "Location E", port: PORT.e, address: addr("e"), anchor: { lat: 47.7009, lon: -122.3, h: 11.5 }, room: "#c86bff", preview_radius_m: 8 };
const BASE = [
  { key: "a", name: "Location A", port: PORT.a, address: addr("a"), anchor: { lat: 47.7, lon: -122.3, h: 11.5 }, room: "#3aa0ff", preview_radius_m: 8 },
  { key: "b", name: "Location B", port: PORT.b, address: addr("b"), anchor: { lat: 47.7, lon: -122.2986676811, h: 11.5 }, room: "#ff7a3a", preview_radius_m: 8 },
  { key: "lobby", name: "Lobby", port: PORT.lobby, address: addr("lobby"), anchor: { lat: 47.7, lon: -122.3013323189, h: 11.5 }, room: "#42d68a", preview_radius_m: 8 },
  { key: "airport", name: "Denver Skyport", port: PORT.airport, address: addr("airport"), anchor: { lat: 39.8561, lon: -104.6737, h: 1655.0 }, preview_radius_m: 12 },
];
const ENV = { ...process.env, OSL_WORLDS: WORLDS_FILE, OSL_RUN_DIR: RUN_DIR };
delete ENV.OSL_PLACEMENT_WRITES;

const LIST_PATTERNS = [
  [/\b(?:8143|1815[0-9])\b/, "a world or frontend port"],
  [/\bSERVICE_PORTS\s*=\s*Object\.freeze\(\[/, "a list of service ports"],
  [/\blocation_id\s*:\s*["']location-(?:a|b|lobby|airport)["']/, "a world's location written as an entry"],
  [/["']location-(?:a|b|lobby|airport)["']\s*:/, "a table keyed by world location"],
  [/\bkey\s*:\s*["'](?:a|b|lobby|airport)["']/, "a world entry"],
  [/\bapiBase\s*:\s*["']\/api\/(?:a|b|lobby|airport)["']/, "a world's API path written as an entry"],
  [/[!=]==\s*["']location-(?:a|b|lobby|airport)["']|["']location-(?:a|b|lobby|airport)["']\s*[!=]==/, "a rule about one world by name"],
  [/"(?:base_url|http_port)"\s*:\s*["\d]/, "a world's address written in a world file"],
];
// What is left, each for a named reason. An entry that no longer matches anything is a harness error.
const LEFT = [
  { file: "app.js", line: /destination: result\.to \?.*location_id: "location-lobby"/, why: "what the header's return-to-Lobby notification says when the server's answer names no destination; one fallback, not a list" },
  { file: "app.js", line: /const inLobby = .*location-lobby/, why: "the header's return-to-Lobby button hides in the Lobby; the button is about that one world" },
  { file: "app.js", line: /const childIsLocationA = /, why: "the accent of a re-attached child fabric on the older attach path, not a portal ring" },
  { file: "live-adapter.js", line: /this\.world\?\.location_id === "location-airport"/, why: "the airport's authored walkable floor is adopted only in that world" },
  { file: "portal-render-controller.mjs", line: /portalHost\(\)\?\.world\?\.location_id === "location-airport"/, why: "the airport's own renderer draws these nodes, so their proxies stay hidden there" },
];
function scanFolder(folder, left = LEFT) {
  const hits = [];
  const used = new Set();
  // The browser's code, and the world files it serves from web/worlds/.
  const worldFiles = join(folder, "worlds");
  const files = readdirSync(folder).filter((name) => /\.(?:js|mjs|html)$/.test(name)).map((name) => [name, join(folder, name)]);
  if (existsSync(worldFiles)) files.push(...readdirSync(worldFiles).filter((name) => name.endsWith(".json")).map((name) => [name, join(worldFiles, name)]));
  for (const [name, path] of files) {
    readFileSync(path, "utf8").split("\n").forEach((text, index) => {
      for (const [pattern, what] of LIST_PATTERNS) {
        if (!pattern.test(text)) continue;
        const allowed = left.find((entry) => entry.file === name && entry.line.test(text));
        if (allowed) { used.add(allowed); continue; }
        hits.push(`${name}:${index + 1} ${what}: ${text.trim().slice(0, 90)}`);
      }
    });
  }
  return { hits, stale: left.filter((entry) => !used.has(entry)).map((entry) => entry.file) };
}

const results = [];
let quiet = false;
function step(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  if (!quiet) console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function sh(script) {
  const r = spawnSync("bash", [join(CODE, script)], { cwd: CODE, env: ENV, encoding: "utf8", timeout: 120000 });
  return { status: r.status, out: `${r.stdout || ""}${r.stderr || ""}` };
}
async function status(url) {
  try { const r = await fetch(url, { redirect: "manual" }); return { status: r.status, json: await r.json().catch(() => null) }; }
  catch (error) { return { status: 0, error: error.message }; }
}

/** The statements on the frontend's routes. */
async function routeStatements(front) {
  const list = await status(`http://127.0.0.1:${front}/worlds.json`);
  const keys = (list.json && list.json.worlds || []).map((w) => w.key);
  step("GET /worlds.json lists the world added to the file", keys.includes("e"), `keys: ${keys.join(", ")}`);
  const entry = (list.json && list.json.worlds || []).find((w) => w.key === "e");
  step("its entry has the file's port, address and name", !!entry && entry.port === PORT.e && entry.address === addr("e") && entry.name === "Location E", JSON.stringify(entry || null));
  const page = await status(`http://127.0.0.1:${front}/w/e/`);
  step("the frontend serves the world's page at /w/e/", page.status === 200, `HTTP ${page.status}`);
  const api = await status(`http://127.0.0.1:${front}/api/e/healthz`);
  step("the frontend reaches the world at /api/e/", api.status === 200 && api.json && api.json.location_id === "location-e", `HTTP ${api.status} ${api.json && api.json.location_id}`);
}

/** The statements in the browser. `setup(page)` plants a fault. */
async function browserStatements(browser, { setup, shots = false } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  try {
    if (setup) await setup(page);
    await page.goto(`http://127.0.0.1:${FRONT}/`, { waitUntil: "domcontentloaded", timeout: 60000 });
    const selector = '[data-mission-id="player-world-e"]';
    const card = await page.waitForSelector(selector, { timeout: 15000 }).catch(() => null);
    const text = card ? await page.$eval(selector, (el) => el.textContent) : "";
    step("the launcher shows the added world", !!card && /Start in Location E/.test(text), card ? text.replace(/\s+/g, " ").trim().slice(0, 100) : "no card");
    const others = await page.$$eval("[data-mission-id]", (els) => els.map((el) => el.dataset.missionId));
    step("the launcher still shows the built-in worlds' missions", ["player-lobby", "server-a-observer", "server-b-observer", "denver-skyport", "player-location-a", "player-location-b"].every((id) => others.includes(id)), others.join(", "));
    if (!card) { step("a click on it opens that world as a player", false, "no card to click"); return; }
    await card.evaluate((el) => el.scrollIntoView({ block: "center" }));
    await sleep(300);
    if (shots) await page.screenshot({ path: join(OUT, "01-launcher-shows-added-world.png") });
    const box = await card.boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForFunction(() => /active=e\b/.test(location.search), { timeout: 15000 }).catch(() => {});
    let location_id = null;
    for (let i = 0; i < 80 && location_id === null; i += 1) {
      await sleep(500);
      location_id = await page.evaluate(() => { try { return window.__assembly?.adapter?.debugState?.()?.location_id ?? null; } catch { return null; } }).catch(() => null);
    }
    const url = page.url();
    step("a click on it opens that world as a player", /role=player/.test(url) && /active=e\b/.test(url) && location_id === "location-e", `${url}; the player is in ${location_id}`);
    if (shots) { await sleep(2000); await page.screenshot({ path: join(OUT, "02-player-in-added-world.png") }); }
  } finally {
    await page.close().catch(() => {});
  }
}

/** Run `fn` with results set aside; the names that went red. */
async function redStatements(fn) {
  const saved = results.splice(0);
  quiet = true;
  try { await fn(); } catch (error) { results.push({ name: `threw: ${error.message}`, ok: false }); }
  quiet = false;
  const red = results.filter((r) => !r.ok).map((r) => r.name);
  results.splice(0, results.length, ...saved);
  return red;
}
function intercept(page, pathname, change) {
  return page.setRequestInterception(true).then(() => page.on("request", async (request) => {
    if (new URL(request.url()).pathname !== pathname) { request.continue(); return; }
    const answer = await fetch(request.url());
    const body = change(await answer.text());
    request.respond({ status: 200, contentType: answer.headers.get("content-type") || "text/javascript", body });
  }));
}
/** A source edit that must apply; one that does not is a harness error, never a pass. */
function sourceFault(file, from, to) {
  const source = readFileSync(join(CODE, "web", file), "utf8");
  if (!source.includes(from)) throw new Error(`harness error: the planted fault for ${file} no longer applies`);
  return () => source.replace(from, to);
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
writeFileSync(WORLDS_FILE, `${JSON.stringify({ frontend: { port: FRONT }, worlds: [...BASE, WORLD_E] }, null, 2)}\n`);

let exitOk = false;
const launch = sh("launchOpenSpatialLab.sh");
try {
  step("the lab launches from a temporary worlds file with an added world, with no other edit", launch.status === 0 && new RegExp(`Location E:\\s+http://127\\.0\\.0\\.1:${PORT.e}/`).test(launch.out), `exit ${launch.status}${launch.status ? `: ${launch.out.slice(-300)}` : ""}`);
  await routeStatements(FRONT);

  const scan = scanFolder(join(CODE, "web"));
  step("web/ holds no other hand-written world or port list", scan.hits.length === 0, scan.hits.length ? scan.hits.join(" | ") : `left, each with a reason: ${LEFT.map((e) => `${e.file} (${e.why})`).join("; ")}`);
  if (scan.stale.length) throw new Error(`harness error: stale allowance for ${scan.stale.join(", ")}`);

  const browser = await puppeteer.launch({ headless: true, executablePath: findBrowser(), args: ["--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  try {
    await browserStatements(browser, { shots: true });

    const fileFault = sourceFault("demo-launcher-catalog.mjs", ".concat(genericWorldMissions(worlds))", "");
    const adapterFault = sourceFault("live-adapter.js", "if (ENDPOINTS[requested]) return requested;", "");
    const faults = [
      ["the frontend's list leaves the world out", /launcher shows the added world/, (page) => intercept(page, "/worlds.json", (text) => { const doc = JSON.parse(text); doc.worlds = doc.worlds.filter((w) => w.key !== "e"); return JSON.stringify(doc); })],
      ["the launcher ignores worlds it has no wording for", /launcher shows the added world/, (page) => intercept(page, "/demo-launcher-catalog.mjs", fileFault)],
      ["the player does not accept a listed world", /opens that world as a player/, (page) => intercept(page, "/live-adapter.js", adapterFault)],
    ];
    for (const [name, expect, setup] of faults) {
      const red = await redStatements(() => browserStatements(browser, { setup }));
      step(`planted fault caught: ${name}`, red.some((n) => expect.test(n)), `red: ${red.join("; ") || "none"}`);
    }
  } finally {
    await browser.close();
  }

  // A frontend whose list does not have the world: the routes must go red.
  const { createFrontendServer } = require(join(CODE, "src", "serve.js"));
  const { loadWorlds } = require(join(CODE, "src", "worlds-config.js"));
  const partial = loadWorlds({ file: WORLDS_FILE });
  partial.worlds = partial.worlds.filter((w) => w.key !== "e");
  const second = await createFrontendServer(SECOND_FRONT, { worlds: partial });
  const routeRed = await redStatements(() => routeStatements(SECOND_FRONT));
  await new Promise((r) => second.close(r));
  step("planted fault caught: a frontend that does not route the world", routeRed.some((n) => /\/w\/e\//.test(n)) && routeRed.some((n) => /\/api\/e\//.test(n)) && routeRed.some((n) => /lists the world/.test(n)), `red: ${routeRed.join("; ") || "none"}`);

  // A planted hand-written list, in a folder of its own: the scan must go red.
  const planted = join(OUT, "planted-web");
  mkdirSync(planted, { recursive: true });
  writeFileSync(join(planted, "fake.mjs"), 'const SERVICE_PORTS = Object.freeze([18151, 18152]);\nexport const W = { key: "lobby", apiBase: "/api/lobby" };\n');
  const plantedScan = scanFolder(planted, []);
  step("planted fault caught: the scan finds a hand-written list", plantedScan.hits.length >= 3, plantedScan.hits.join(" | ") || "no hits");
  writeFileSync(join(planted, "ring.mjs"), 'export const ring = (id) => (id === "location-b" ? 0xffc266 : 0x66e0ff);\n');
  const plantedRule = scanFolder(planted, []);
  step("planted fault caught: the scan finds a rule about one world by name", plantedRule.hits.some((hit) => /^ring\.mjs:1 a rule about one world/.test(hit)), plantedRule.hits.join(" | "));
  mkdirSync(join(planted, "worlds"), { recursive: true });
  writeFileSync(join(planted, "worlds", "fake-world.json"), '{\n  "base_url": "http://127.0.0.1:18151",\n  "http_port": 18151\n}\n');
  const plantedWorldFile = scanFolder(planted, []);
  step("planted fault caught: the scan reads the world files in web/worlds/", plantedWorldFile.hits.some((hit) => /^fake-world\.json:2 /.test(hit)), plantedWorldFile.hits.join(" | "));
  exitOk = true;
} finally {
  const stop = sh("stopOpenSpatialLab.sh");
  console.log(`stopped the proof's lab: exit ${stop.status}`);
}

const failed = results.filter((r) => !r.ok);
writeFileSync(join(OUT, "results.json"), `${JSON.stringify({ ran_at: new Date().toISOString(), passed: results.length - failed.length, total: results.length, results }, null, 2)}\n`);
console.log(failed.length || !exitOk ? `FAIL: ${failed.length} of ${results.length} statements failed.` : `PASS: all ${results.length} statements passed (including every planted fault caught).`);
process.exit(failed.length || !exitOk ? 1 : 0);
