// Proof: the portal placement tool, and adding a world by configuration.
//
// Run:  npm run -s check:placement
//
// It starts its own copy of the lab (launchOpenSpatialLab.sh) from its own worlds file, on ports
// 33460-33466 (or the port in OSL_PLACEMENT_PORT and the six after it), drives headless Chrome with real mouse and keyboard input, and stops its servers at the end.
// Each visual step is a numbered PNG in screens/ under OSL_PROOF_DIR (default .runtime/placement-proof).
// Exits 0 only when every step passes.
//
// Part 1, the placement tool, in the ?wow= player of Location A:
//   01 placement mode on; 02 a click on the floor places a portal (radius 3 m, to Location B);
//   03 a drag moves it; 04 its radius set to 4 m and saved; each is read back from the world's API.
//   05 a drag on a portal from the world's configuration does not move it (the tool says why; Save is off; PUT 409).
//   06 a visitor far away: the portal sleeps; 07 a click on it does not cross;
//   08 the visitor walks in (W key): within 4 m it wakes and loads its preview; 09 a click crosses to B.
// Part 2, a world added by configuration only, following ADD-A-WORLD-CHECKLIST.md:
//   Location E is added to the worlds file; the lab is restarted; the check passes and names it;
//   10 its player opens; 11 the placement tool offers it as a destination; 12 a portal to it crosses there.
//   Then Location F is added to the worlds file without restarting: the check exits 1 and names F's
//   missing port; a portal to F is named too; 13 crossing that portal is refused on the page.
//   No code file changes in part 2 (a hash of the code before and after).
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CODE = resolve(HERE, "..", "..");
const WORK = CODE;
// What the proof writes: its run folder, screenshots and results. OSL_PROOF_DIR names another place.
const OUT = process.env.OSL_PROOF_DIR ? resolve(process.env.OSL_PROOF_DIR) : join(CODE, ".runtime", "placement-proof");
const SCREENS = join(OUT, "screens");
const RUN = join(OUT, "run");
const WORLDS_FILE = join(RUN, "worlds.json");
const RUN_DIR = join(RUN, "runtime");
const require = createRequire(join(CODE, "package.json"));
const puppeteer = require("puppeteer-core");
const { findBrowser } = await import(pathToFileURL(join(CODE, "tools", "find-browser.mjs")).href);
const { placePortal } = await import(pathToFileURL(join(CODE, "web", "wow-portal.mjs")).href);

const FRONT_PORT = Number(process.env.OSL_PLACEMENT_PORT) || 33460;
const PORT = { a: FRONT_PORT + 1, b: FRONT_PORT + 2, lobby: FRONT_PORT + 3, airport: FRONT_PORT + 4, e: FRONT_PORT + 5, f: FRONT_PORT + 6 };
const FRONT = `http://127.0.0.1:${FRONT_PORT}`;
const addr = (key) => `http://127.0.0.1:${PORT[key]}/`;
// OSL_PLACEMENT_WRITES=1 is the explicit opt-in for placement writes (off by default); this proof's own lab turns it on.
const ENV = { ...process.env, OSL_WORLDS: WORLDS_FILE, OSL_RUN_DIR: RUN_DIR, OSL_PLACEMENT_WRITES: "1" };
const ACCEPT = { Accept: "application/wow+json, application/json;q=0.9" };

const BASE_WORLDS = {
  frontend: { port: FRONT_PORT },
  worlds: [
    { key: "a", name: "Location A", port: PORT.a, address: addr("a"), anchor: { lat: 47.7, lon: -122.3, h: 11.5 }, room: "#3aa0ff", preview_radius_m: 8 },
    { key: "b", name: "Location B", port: PORT.b, address: addr("b"), anchor: { lat: 47.7, lon: -122.2986676811, h: 11.5 }, room: "#ff7a3a", preview_radius_m: 8 },
    { key: "lobby", name: "Lobby", port: PORT.lobby, address: addr("lobby"), anchor: { lat: 47.7, lon: -122.3013323189, h: 11.5 }, room: "#42d68a", preview_radius_m: 8 },
    { key: "airport", name: "Denver Skyport", port: PORT.airport, address: addr("airport"), anchor: { lat: 39.8561, lon: -104.6737, h: 1655.0 }, preview_radius_m: 12 },
  ],
};
// The entries the checklist adds (ADD-A-WORLD-CHECKLIST.md, step 2).
const WORLD_E = { key: "e", name: "Location E", port: PORT.e, address: addr("e"), anchor: { lat: 47.7009, lon: -122.3, h: 11.5 }, room: "#c86bff", preview_radius_m: 8 };
const WORLD_F = { key: "f", name: "Location F", port: PORT.f, address: addr("f"), anchor: { lat: 47.7018, lon: -122.3, h: 11.5 }, room: "#e0c040" };

const results = [];
let shotNumber = 0;
function step(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}
async function shot(page, name) {
  shotNumber += 1;
  const file = join(SCREENS, `${String(shotNumber).padStart(2, "0")}-${name}.png`);
  await page.screenshot({ path: file });
  console.log(`     screenshot ${relative(WORK, file)}`);
  return file;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sh(script, args = []) {
  const r = spawnSync("bash", [join(CODE, script), ...args], { cwd: CODE, env: ENV, encoding: "utf8", timeout: 120000 });
  return { status: r.status, out: `${r.stdout || ""}${r.stderr || ""}` };
}
function check() {
  const r = spawnSync(process.execPath, [join(CODE, "tools", "check-worlds.mjs")], { cwd: CODE, env: ENV, encoding: "utf8", timeout: 120000 });
  return { status: r.status, out: `${r.stdout || ""}${r.stderr || ""}` };
}
function writeWorlds(extra) {
  writeFileSync(WORLDS_FILE, `${JSON.stringify({ ...BASE_WORLDS, worlds: [...BASE_WORLDS.worlds, ...extra] }, null, 2)}\n`);
}
async function getJson(url) {
  const r = await fetch(url, { headers: ACCEPT, cache: "no-store" });
  return { status: r.status, json: await r.json().catch(() => null) };
}
const player = (key, extra = "") => `${FRONT}/index.html?role=source&intro=bypass${extra}&wow=${encodeURIComponent(`${addr(key)}wow/spatial/1`)}`;

/** A hash of every code file (not node_modules, not run state), to show part 2 changes none. */
function codeHash() {
  const hash = createHash("sha256");
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      if (name === "node_modules" || name === ".runtime" || name === "diagnostics" || name === ".dev" || name === ".git" || name === ".DS_Store") continue;
      const path = join(dir, name);
      const st = statSync(path);
      if (st.isDirectory()) walk(path);
      else { hash.update(relative(CODE, path)); hash.update(readFileSync(path)); }
    }
  };
  walk(CODE);
  return hash.digest("hex");
}

async function openPlayer(page, url, { placement = false } = {}) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(() => document.body.dataset.wowPortalsReady === "1", { timeout: 180000 });
  if (placement !== null) await page.waitForFunction(() => document.body.dataset.wowPlacementReady === "1", { timeout: 60000 });
  await sleep(1200);
}
const portals = (page) => page.evaluate(() => window.__wowPortals.summary());
const portalById = async (page, id) => (await portals(page)).find((p) => p.id === id);

/** A page point whose floor point (y = 0) is nearest (x, z), searched down the column `column` and across. */
async function screenPointForFloor(page, x, z) {
  return page.evaluate((tx, tz) => {
    const vc = window.__wowViewControls;
    const canvas = document.querySelector("#scene-mount canvas");
    const r = canvas.getBoundingClientRect();
    let best = null;
    for (let py = r.top + 80; py < r.bottom - 60; py += 4) {
      for (let px = r.left + 20; px < r.right - 340; px += 8) {
        const p = vc.floorPointAt(px, py);
        if (!p) continue;
        const d = Math.hypot(p.x - tx, p.z - tz);
        if (!best || d < best.d) best = { x: px, y: py, d, floor: [p.x, p.z] };
      }
    }
    return best;
  }, x, z);
}

async function typeInto(page, selector, text) {
  await page.click(selector);
  await page.keyboard.press("End");
  for (let i = 0; i < 24; i += 1) await page.keyboard.press("Backspace");
  await page.keyboard.type(text);
}

async function main() {
  rmSync(SCREENS, { recursive: true, force: true });
  mkdirSync(SCREENS, { recursive: true });
  mkdirSync(RUN, { recursive: true });
  writeWorlds([]);
  sh("stopOpenSpatialLab.sh", ["--quiet"]);
  const launch = sh("launchOpenSpatialLab.sh");
  step("the lab launches from the proof's worlds file (4 worlds)", launch.status === 0 && /Open Spatial Lab is ready/.test(launch.out), launch.status === 0 ? "" : launch.out.slice(-600));
  if (launch.status !== 0) return;

  const browser = await puppeteer.launch({
    executablePath: findBrowser(), headless: "new",
    args: ["--no-sandbox", "--enable-webgl", "--ignore-gpu-blocklist", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
    defaultViewport: { width: 1280, height: 800 },
  });
  try {
    const page = await browser.newPage();
    page.on("pageerror", (e) => console.log(`     page error: ${e.message}`));

    // ---- Part 1: place, move, set the radius, save; then a visitor wakes it and crosses ----
    await openPlayer(page, player("a"));
    await page.click("#wow-place-toggle");
    await page.waitForFunction(() => window.__wowPlacement && window.__wowPlacement.on === true, { timeout: 10000 });
    await sleep(300);
    await shot(page, "placement-mode-on");
    step("a mouse click on the panel's switch turns placement mode on", await page.evaluate(() => window.__wowPlacement.on === true));

    await typeInto(page, "#wow-place-label", "To Location B");
    await typeInto(page, "#wow-place-radius", "3");
    await page.select("#wow-place-destination", addr("b"));
    const first = await screenPointForFloor(page, -3.0, -0.5);
    await page.mouse.click(first.x, first.y);
    await page.waitForFunction(() => window.__wowPlacement && window.__wowPlacement.last && window.__wowPlacement.last.action === "placed", { timeout: 30000 });
    await sleep(600);
    const placed = await page.evaluate(() => window.__wowPlacement.last);
    await shot(page, "portal-placed-by-floor-click");
    const id = placed.portal;
    const afterPlace = await getJson(`${addr("a")}wow/portal/${id}`);
    step("a mouse click on the floor places a portal, saved to Location A's Web of Worlds API",
      afterPlace.status === 200 && afterPlace.json.node === `wow/spatial/1/node/${placed.node}` && afterPlace.json.active_radius_m === 3 && afterPlace.json.destination === addr("b") && afterPlace.json.label === "To Location B",
      `portal ${id}: ${JSON.stringify({ node: afterPlace.json && afterPlace.json.node, destination: afterPlace.json && afterPlace.json.destination, active_radius_m: afterPlace.json && afterPlace.json.active_radius_m })}, placed at floor (${placed.at[0].toFixed(2)}, ${placed.at[2].toFixed(2)})`);

    // Drag it to the middle of the room's far half, straight ahead of the starting view.
    const from = await page.evaluate((pid) => window.__wowPortals.screenPoint(pid), id);
    const to = await screenPointForFloor(page, 0, -1.5);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 8 });
    await page.mouse.move(to.x, to.y, { steps: 8 });
    await page.mouse.up();
    await page.waitForFunction(() => window.__wowPlacement.last && window.__wowPlacement.last.action === "moved", { timeout: 30000 });
    await sleep(600);
    const moved = await page.evaluate(() => window.__wowPlacement.last);
    await shot(page, "portal-moved-by-drag");
    const node = await getJson(`${addr("a")}wow/spatial/1/node/${placed.node}?nodeForm=flat`);
    const t = node.json && node.json.localTransform;
    const off = t ? Math.hypot(t[12] - moved.at[0], t[14] - moved.at[2]) : Infinity;
    // The node's +Z (its front) points at the middle of the world, as every lab portal faces.
    const facesMiddle = t ? (t[8] * -t[12] + t[10] * -t[14]) / (Math.hypot(t[8], t[10]) * Math.hypot(t[12], t[14]) || 1) : -1;
    step("a mouse drag moves the portal; its node's position in the graph is where it was dropped, facing the middle",
      node.status === 200 && off < 0.01 && Math.hypot(moved.at[0] - 0, moved.at[2] + 1.5) < 0.25 && facesMiddle > 0.999,
      `node ${placed.node} at (${t ? t[12].toFixed(3) : "?"}, ${t ? t[14].toFixed(3) : "?"}), dropped at (${moved.at[0].toFixed(3)}, ${moved.at[2].toFixed(3)}), ${(off * 1000).toFixed(2)} mm apart; front toward the middle: cosine ${facesMiddle.toFixed(4)}`);

    await typeInto(page, "#wow-place-radius", "4");
    await page.click("#wow-place-save");
    await page.waitForFunction(() => window.__wowPlacement.last && window.__wowPlacement.last.action === "saved", { timeout: 30000 });
    await sleep(600);
    await shot(page, "radius-set-to-4m-and-saved");
    const saved = await getJson(`${addr("a")}wow/portal/${id}`);
    step("the active radius, typed as 4 and saved, is the portal's active_radius_m in the world's API",
      saved.status === 200 && saved.json.active_radius_m === 4 && saved.json.destination === addr("b"),
      `GET ${addr("a")}wow/portal/${id}: active_radius_m ${saved.json && saved.json.active_radius_m}, destination ${saved.json && saved.json.destination}`);

    // A portal from the world's configuration (not placed with the tool) is not moved by a drag, nor changed.
    const configured = (await portals(page)).find((p) => p.placed === false && p.node);
    const cNodeId = configured ? Number(/\/node\/(\d+)$/.exec(configured.node)[1]) : null;
    const cNodeUrl = `${addr("a")}wow/spatial/1/node/${cNodeId}?nodeForm=flat`;
    const cBefore = configured ? (await getJson(cNodeUrl)).json.localTransform : null;
    const cFrom = configured ? await page.evaluate((pid) => window.__wowPortals.screenPoint(pid), configured.id) : null;
    if (cFrom) {
      await page.mouse.move(cFrom.x, cFrom.y);
      await page.mouse.down();
      await page.mouse.move(cFrom.x + 40, cFrom.y + 120, { steps: 10 });
      await page.mouse.move(cFrom.x + 60, cFrom.y + 200, { steps: 10 });
      await page.mouse.up();
    }
    await sleep(2500);
    const cAfter = configured ? (await getJson(cNodeUrl)).json.localTransform : null;
    const cLast = await page.evaluate(() => window.__wowPlacement.last);
    const cText = await page.evaluate(() => document.querySelector("#wow-place-status").textContent);
    const cSelected = await page.evaluate(() => document.querySelector("#wow-place-selected").textContent);
    const cSaveDisabled = await page.evaluate(() => document.querySelector("#wow-place-save").disabled);
    const cPut = configured ? await fetch(`${addr("a")}wow/portal/${configured.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label: "renamed" }) }) : null;
    await shot(page, "configured-portal-not-moved-by-drag");
    step("a drag on a portal from the world's configuration does not move it; the tool says why, and it cannot be changed",
      !!cFrom && JSON.stringify(cBefore) === JSON.stringify(cAfter) && !(cLast && cLast.action === "moved" && cLast.portal === configured.id)
        && /comes from the world's configuration, so it is not moved here/.test(cText) && /from the world's configuration/.test(cSelected) && cSaveDisabled && cPut && cPut.status === 409,
      configured ? `portal ${configured.id} "${configured.label}", node ${cNodeId} at (${cAfter[12]}, ${cAfter[14]}) before and after the drag; status "${cText}"; Save disabled ${cSaveDisabled}; PUT wow/portal/${configured.id}: ${cPut && cPut.status}` : "no configured portal found");

    await page.click("#wow-place-toggle");
    step("a second click turns placement mode off", await page.evaluate(() => window.__wowPlacement.on === false));

    // A visitor opens the world: the portal sleeps until they come within 4 m.
    await openPlayer(page, player("a"));
    const far = await portalById(page, id);
    await shot(page, "visitor-far-portal-asleep");
    step("a visitor 4 m or more away: the portal is asleep and has not loaded its preview",
      far && far.awake === false && far.distance_m > 4 && far.preview && far.preview.kind === "asleep",
      far ? `distance ${far.distance_m} m, awake ${far.awake}, preview ${far.preview && far.preview.kind}` : "portal not drawn");
    const urlBefore = page.url();
    const sleepingPoint = await page.evaluate((pid) => window.__wowPortals.screenPoint(pid), id);
    await page.mouse.click(sleepingPoint.x, sleepingPoint.y);
    await sleep(1500);
    const refused = await portalById(page, id);
    await shot(page, "click-on-sleeping-portal-does-not-cross");
    step("a click on the sleeping portal does not cross; it says to come closer",
      page.url() === urlBefore && refused && /asleep: come within 4 m/.test(refused.refusal || ""), refused && refused.refusal);

    // Walk in with the W key, half a meter a tap, until it wakes.
    let taps = 0;
    let near = await portalById(page, id);
    while (!near.awake && taps < 40) {
      await page.keyboard.press("KeyW");
      taps += 1;
      await sleep(260);
      near = await portalById(page, id);
    }
    // Come down to standing height to look at it (Q), then wait for the preview.
    for (let i = 0; i < 5; i += 1) { await page.keyboard.press("KeyQ"); await sleep(120); }
    await page.waitForFunction((pid) => { const p = window.__wowPortals.summary().find((x) => x.id === pid); return p && p.preview && p.preview.kind === "nodes"; }, { timeout: 60000 }, id).catch(() => {});
    await sleep(800);
    near = await portalById(page, id);
    await shot(page, "visitor-within-radius-portal-awake");
    step("walking in with the W key, the portal wakes within 4 m and loads its preview (Location B's room)",
      near.awake === true && near.distance_m <= 4 && near.preview && near.preview.kind === "nodes" && near.preview.nodes > 0,
      `after ${taps} W taps: distance ${near.distance_m} m, awake ${near.awake}, preview ${near.preview && near.preview.kind} with ${near.preview && near.preview.nodes} nodes`);
    const awakePoint = await page.evaluate((pid) => window.__wowPortals.screenPoint(pid), id);
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 60000 }),
      page.mouse.click(awakePoint.x, awakePoint.y),
    ]);
    await page.waitForFunction(() => document.body.dataset.wowArrival, { timeout: 180000 }).catch(() => {});
    await page.waitForFunction(() => document.body.dataset.wowPortalsReady === "1", { timeout: 180000 }).catch(() => {});
    await sleep(1200);
    const arrived = await page.evaluate(() => ({ url: location.href, arrival: window.__wowArrival || null }));
    await shot(page, "crossed-to-location-b");
    step("a mouse click on the awake portal crosses to Location B",
      arrived.url.includes(encodeURIComponent(`${addr("b")}wow/spatial/1`)) && arrived.arrival && arrived.arrival.arrived === true,
      `${arrived.url.replace(FRONT, "")}; arrived at ${arrived.arrival && arrived.arrival.node}`);

    // ---- Part 2: add a world by configuration only, following the checklist ----
    const before = codeHash();
    writeWorlds([WORLD_E]); // checklist step 2: one entry in the worlds file
    const stop1 = sh("stopOpenSpatialLab.sh"); // step 3: restart
    const relaunch = sh("launchOpenSpatialLab.sh");
    step("checklist step 3: after adding Location E's entry, the lab restarts and its receipt lists Location E",
      stop1.status === 0 && relaunch.status === 0 && new RegExp(`Location E:\\s+http://127\\.0\\.0\\.1:${PORT.e}/`).test(relaunch.out), relaunch.status === 0 ? "" : relaunch.out.slice(-600));
    const goodCheck = check(); // step 4: the check
    writeFileSync(join(OUT, "check-after-adding-e.txt"), goodCheck.out);
    step("checklist step 4: the check exits 0 and names Location E as launched and answering",
      goodCheck.status === 0 && new RegExp(`OK {3}Location E \\(e\\) port ${PORT.e}`).test(goodCheck.out), `exit ${goodCheck.status}; output in check-after-adding-e.txt`);
    const listed = await getJson(`${FRONT}/worlds.json`);
    const health = await getJson(`${FRONT}/api/e/healthz`);
    step("the frontend lists Location E and routes to it (/worlds.json, /api/e/healthz)",
      listed.status === 200 && listed.json.worlds.some((w) => w.key === "e" && w.port === PORT.e) && health.status === 200 && health.json.location_id === "location-e",
      `/api/e/healthz: ${health.status} ${health.json && health.json.location_id}`);

    await openPlayer(page, player("e"));
    const eShown = await page.evaluate(() => ({ title: document.getElementById("loc-title")?.textContent || "", frames: document.body.dataset.wowAssetNodes }));
    await shot(page, "location-e-player");
    step("checklist step 5: Location E's player opens and draws its world", eShown.title.includes(`127.0.0.1:${PORT.e}`), eShown.title);

    await openPlayer(page, player("a", "&place=1"));
    const options = await page.evaluate(() => [...document.querySelectorAll("#wow-place-destination option")].map((o) => o.textContent));
    await page.select("#wow-place-destination", addr("e"));
    await typeInto(page, "#wow-place-label", "To Location E");
    await typeInto(page, "#wow-place-radius", "");
    const ePoint = await screenPointForFloor(page, 2.5, -1.0);
    await page.mouse.click(ePoint.x, ePoint.y);
    await page.waitForFunction(() => window.__wowPlacement.last && window.__wowPlacement.last.action === "placed", { timeout: 30000 });
    await sleep(600);
    const toE = await page.evaluate(() => window.__wowPlacement.last);
    await shot(page, "placement-tool-offers-location-e");
    step("the placement tool offers Location E as a destination, read from the worlds file, and places a portal to it",
      options.some((o) => /^Location E/.test(o)) && toE.destination === addr("e"), `options: ${options.join(" | ")}`);
    await page.click("#wow-place-toggle");
    await sleep(300);
    const ePortal = await page.evaluate((pid) => window.__wowPortals.screenPoint(pid), toE.portal);
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 60000 }),
      page.mouse.click(ePortal.x, ePortal.y),
    ]);
    await page.waitForFunction(() => document.body.dataset.wowPortalsReady === "1", { timeout: 180000 }).catch(() => {});
    await sleep(1200);
    const inE = page.url();
    await shot(page, "crossed-to-location-e");
    step("a portal placed to Location E crosses there: the new world is reachable", inE.includes(encodeURIComponent(`${addr("e")}wow/spatial/1`)), inE.replace(FRONT, ""));
    const after = codeHash();
    step("adding Location E changed no code file (one hash of the code before and after)", before === after, `${before.slice(0, 16)} / ${after.slice(0, 16)}`);

    // The deliberate fault: Location F is listed, but the running launch never started it.
    writeWorlds([WORLD_E, WORLD_F]);
    const placedF = await placePortal(addr("a"), { graph: 1, localTransform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -2.5, 0, -1.5, 1], label: "To Location F", destination: addr("f"), active_radius_m: null }, { fetch });
    const badCheck = check();
    writeFileSync(join(OUT, "check-missing-port.txt"), badCheck.out);
    console.log(badCheck.out.split("\n").filter((l) => /Location F|FAIL/.test(l)).map((l) => `     check: ${l}`).join("\n"));
    step("the check exits 1 and names Location F's missing port: missing from the launch, and not answering",
      badCheck.status === 1 && badCheck.out.includes(`FAIL Location F (f) port ${PORT.f}`) && badCheck.out.includes(`port ${PORT.f} is missing from the launch`) && badCheck.out.includes(`does not answer at http://127.0.0.1:${PORT.f}/`),
      `exit ${badCheck.status}; output in check-missing-port.txt`);
    step("the check names the portal into Location F that would wake but not deliver",
      new RegExp(`portal ${placedF.portal.id} "To Location F" in Location A leads to Location F \\(port ${PORT.f}\\), which does not answer`).test(badCheck.out));
    await openPlayer(page, player("a"));
    const fPoint = await page.evaluate((pid) => window.__wowPortals.screenPoint(pid), placedF.portal.id);
    const urlA = page.url();
    if (fPoint) await page.mouse.click(fPoint.x, fPoint.y);
    await sleep(2500);
    const fState = await portalById(page, placedF.portal.id);
    await shot(page, "portal-to-missing-world-refused");
    step("on the page, crossing into Location F is refused with the reason, and the visitor stays",
      !!fPoint && page.url() === urlA && fState && /offline/.test(fState.refusal || ""), fState && fState.refusal);
  } finally {
    await browser.close();
    const stop = sh("stopOpenSpatialLab.sh");
    console.log(`     proof servers stopped (exit ${stop.status})`);
  }
}

const started = Date.now();
await main().catch((error) => step("the proof ran to the end", false, error.stack || String(error)));
const failed = results.filter((r) => !r.ok);
writeFileSync(join(OUT, "results.json"), `${JSON.stringify({ ran_at: new Date().toISOString(), seconds: Math.round((Date.now() - started) / 1000), passed: results.length - failed.length, failed: failed.length, results }, null, 2)}\n`);
console.log(failed.length ? `FAIL: ${failed.length} of ${results.length} steps failed.` : `PASS: all ${results.length} steps passed.`);
process.exit(failed.length || !results.length ? 1 : 0);
