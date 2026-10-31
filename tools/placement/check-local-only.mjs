// Check: placement is local-only.
//
// Run:  npm run -s check:local-only
//
// The rule under test: placement mode and its write routes are on only when the server runs on 127.0.0.1,
// judged by the address the server is bound to. A server bound to another address refuses the write routes with
// a reason, the player offers no placement mode there, and placed portals are still served and shown read-only.
//
// Part 1 (in this process, ports 33470-33472): the real world server and the real frontend are started
//   - L: both bound to 127.0.0.1 (the control: placement works, so a pass is not "everything is refused");
//   - P: both bound to 0.0.0.0 (a public lab, reached here through 127.0.0.1);
//   - M: world on 127.0.0.1 behind a frontend on 0.0.0.0 (a public page in front of a local world).
//   Each has a portal placed earlier (seeded through the runtime, as the placement tool would have left it).
// Part 2 (headless Chrome for Testing): the player against P shows no placement mode and shows the placed
//   portal; a floor click and a drag send no write. Against L it shows placement mode.
// Part 3 (the real launch script, ports 33480-33482): OSL_BIND_HOST=0.0.0.0 gives a lab that refuses the
//   write routes; the default launch is local and allows them.
// Part 4, planted faults: four deliberate breaks of the switch, each run through the same statements. The
//   check passes only if every planted fault turns a statement red.
//
// The bind test alone is not enough, because a public deployment can
// put a public proxy in front of a loopback listener. Placement also needs the explicit opt-in OSL_PLACEMENT_WRITES=1,
// off by default.
//   - N: both on 127.0.0.1 WITHOUT the setting: every write route is refused (the same list as for the public lab,
//     including /demo/portal/move and /reset), the player offers no placement mode, reads still work, and only the
//     exact value "1" turns it on. L (the control) is the same lab WITH the setting, and works.
//   - Scan (read-only): no file under deploy/ mentions the setting, and none of the lab's own launch files
//     sets it. A planted fault (deploy-style and launch-style files that set it, written only inside
//     run-local-only/planted-scan/) must turn the scan red.
//
// Exits 0 only when every statement passes with the code as it is and every planted fault is caught.
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import http from "node:http";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CODE = resolve(HERE, "..", "..");
const WORK = resolve(CODE, "..");
// What the check writes. OSL_PROOF_DIR names another place.
const OUT = process.env.OSL_PROOF_DIR ? resolve(process.env.OSL_PROOF_DIR) : join(CODE, ".runtime", "placement-proof");
const SCREENS = join(OUT, "screens-local-only");
const RUN = join(OUT, "run-local-only");
const require = createRequire(join(CODE, "package.json"));

const FRONT = Number(process.env.OSL_LOCAL_ONLY_PORT) || 33470;
const WORLD_A = FRONT + 1;
const WORLD_B = FRONT + 2;
const LAUNCH = { front: FRONT + 10, a: FRONT + 11, b: FRONT + 12 };
const addr = (port) => `http://127.0.0.1:${port}/`;

// The worlds file for Part 1, read by the code under test before it is loaded.
mkdirSync(RUN, { recursive: true });
const worldsFile = (front, a, b) => ({
  frontend: { port: front },
  worlds: [
    { key: "a", name: "Location A", port: a, address: addr(a), anchor: { lat: 47.7, lon: -122.3, h: 11.5 }, room: "#3aa0ff", preview_radius_m: 8 },
    { key: "b", name: "Location B", port: b, address: addr(b), anchor: { lat: 47.7, lon: -122.2986676811, h: 11.5 }, room: "#ff7a3a", preview_radius_m: 8 },
  ],
});
const WORLDS_FILE = join(RUN, "worlds.json");
writeFileSync(WORLDS_FILE, `${JSON.stringify(worldsFile(FRONT, WORLD_A, WORLD_B), null, 2)}\n`);
process.env.OSL_WORLDS = WORLDS_FILE;
delete process.env.OSL_BIND_HOST;
// The opt-in is read from the environment on each request. Parts 1 and 2 set it per stack (setOptIn below).
const OPT_IN = "OSL_PLACEMENT_WRITES";
function setOptIn(value) { if (value === null || value === undefined) delete process.env[OPT_IN]; else process.env[OPT_IN] = value; }
setOptIn(null);

const puppeteer = require("puppeteer-core");
const { findBrowser } = await import(pathToFileURL(join(CODE, "tools", "find-browser.mjs")).href);
const { placePortal, changePortal, moveNode } = await import(pathToFileURL(join(CODE, "web", "wow-portal.mjs")).href);
const localOnly = require(join(CODE, "runtime", "world-server", "src", "local-only.js"));
const { createServer } = require(join(CODE, "runtime", "world-server", "src", "server.js"));
const { NODES } = require(join(CODE, "runtime", "world-server", "src", "config.js"));
const { worldConfig } = require(join(CODE, "src", "orchestrator.js"));
const { createFrontendServer } = require(join(CODE, "src", "serve.js"));
const { loadWorlds } = require(join(CODE, "src", "worlds-config.js"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
let currentSection = "";
function step(name, ok, detail) {
  results.push({ section: currentSection, name, ok: !!ok, detail: detail || "" });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

/** One HTTP request with headers of our choosing (fetch cannot set Host). */
function call(port, method, path, body, headers = {}) {
  return new Promise((resolveCall) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const request = http.request({ host: "127.0.0.1", port, method, path, agent: false, headers: { Accept: "application/json", ...(data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}), ...headers } }, (response) => {
      const chunks = [];
      response.on("data", (c) => chunks.push(c));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolveCall({ status: response.statusCode, json, text });
      });
    });
    request.on("error", (error) => resolveCall({ status: 0, json: null, text: String(error.message) }));
    if (data) request.write(data);
    request.end();
  });
}

const IDENTITY_AT = (x, z) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, z, 1];

/** Start a world (and a second one, so portals have somewhere to lead) and a frontend, bound as asked. */
async function startStack(worldHost, frontHost) {
  const config = loadWorlds({ strict: true });
  const addressByLocation = { [NODES.a.location_id]: addr(WORLD_A), [NODES.b.location_id]: addr(WORLD_B) };
  const listen = (built, port, host) => new Promise((ok, fail) => { built.server.once("error", fail); built.server.listen(port, host, ok); });
  const worldA = createServer("a", worldConfig(config.worlds[0], addressByLocation));
  const worldB = createServer("b", worldConfig(config.worlds[1], addressByLocation));
  await listen(worldA, WORLD_A, worldHost);
  await listen(worldB, WORLD_B, worldHost);
  const frontend = await createFrontendServer(FRONT, { worlds: config, host: frontHost });
  // A portal placed earlier, as the placement tool leaves it: a node under the root, and a portal that names it.
  const root = worldA.runtime.getSpatialDescriptor("1").rootNodeID;
  const made = worldA.runtime.createSpatialNodes("1", root, [{ label: "Placed earlier (portal placement)", localTransform: IDENTITY_AT(-3, -1) }], { flattenEmbedded: true });
  const node = made.top_level[0];
  const added = worldA.runtime.addPortal({ node_id: node, label: "Placed earlier", destination: addr(WORLD_B), active_radius_m: 4 });
  const stack = {
    world: worldA, root, node, portal: added.id, worldHost, frontHost,
    async stop() {
      await Promise.allSettled([worldA.closeAll(), worldB.closeAll(), new Promise((ok) => frontend.close(ok))]);
    },
  };
  stack.frontend = frontend;
  return stack;
}

/** What a reader sees of the world: its portal count, the root's subtree, and the placed portal. */
async function snapshot(stack) {
  const world = await call(WORLD_A, "GET", "/wow/world");
  const root = await call(WORLD_A, "GET", `/wow/spatial/1/node/${stack.root}`);
  const portal = await call(WORLD_A, "GET", `/wow/portal/${stack.portal}`);
  const configured = await call(WORLD_A, "GET", "/wow/portal/1");
  return JSON.stringify({ portals: world.json && world.json.portals, root: root.text, portal: portal.text, configured: configured.text });
}

function firstDifference(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return `at ${i}: before "${a.slice(Math.max(0, i - 60), i + 80)}" / after "${b.slice(Math.max(0, i - 60), i + 80)}"`;
}
const refused = (r) => r.status === 403 && r.json && r.json.error === "placement_local_only";

/**
 * The statements about a stack. `local` says what it should be: true when the world and the frontend are both
 * on 127.0.0.1, false when any is not. Returns nothing; each statement is recorded through step().
 */
async function statementsFor(label, stack, { worldLocal, frontLocal, optIn = true }) {
  const worldOn = worldLocal && optIn;
  const frontOn = frontLocal && optIn;
  const before = await snapshot(stack);
  const nodeBody = [{ label: "Should not be created", localTransform: IDENTITY_AT(1, 1) }];
  const portalBody = { node: `wow/spatial/1/node/${stack.node}`, label: "Should not be created", destination: null, active_radius_m: 3 };
  const spoof = { Host: `127.0.0.1:${WORLD_A}`, "X-Forwarded-For": "127.0.0.1", "X-Real-IP": "127.0.0.1", Forwarded: "for=127.0.0.1;host=127.0.0.1", Origin: "http://127.0.0.1", [OPT_IN]: "1", "X-OSL-Placement-Writes": "1" };

  // ---- the world server itself ----
  const policy = await call(WORLD_A, "GET", "/placement");
  step(`${label}: the world reports placement ${worldOn ? "on" : "off"}, both conditions (bound to 127.0.0.1: ${worldLocal}; opt-in: ${optIn}) and the reason`,
    policy.status === 200 && policy.json && policy.json.allowed === worldOn && policy.json.bound_address === stack.worldHost
      && policy.json.bound_local === worldLocal && policy.json.opt_in === optIn
      && (worldOn ? policy.json.reason === null
        : /127\.0\.0\.1/.test(policy.json.reason || "") && (worldLocal || policy.json.reason.includes(stack.worldHost)) && (optIn || policy.json.reason.includes(OPT_IN))),
    `GET /placement: ${policy.text.replace(/\s+/g, " ").slice(0, 360)}`);

  if (!worldOn) {
    const refusals = [
      ["POST /wow/portal", await call(WORLD_A, "POST", "/wow/portal", portalBody)],
      [`PUT /wow/portal/${stack.portal}`, await call(WORLD_A, "PUT", `/wow/portal/${stack.portal}`, { active_radius_m: 9 })],
      [`POST /wow/spatial/1/node/${stack.root}`, await call(WORLD_A, "POST", `/wow/spatial/1/node/${stack.root}`, nodeBody)],
      [`PUT /wow/spatial/1/node/${stack.node}`, await call(WORLD_A, "PUT", `/wow/spatial/1/node/${stack.node}`, { localTransform: IDENTITY_AT(2, 2) })],
      [`DELETE /wow/spatial/1/node/${stack.node}`, await call(WORLD_A, "DELETE", `/wow/spatial/1/node/${stack.node}`)],
      ["POST /demo/portal/move (the old drag of a configured portal)", await call(WORLD_A, "POST", "/demo/portal/move", { position: [4.5, 0, 4.5] })],
      ["POST /reset (puts the graph back to its seed, erasing placed portals)", await call(WORLD_A, "POST", "/reset", {})],
    ];
    for (const [route, r] of refusals)
      step(`${label}: the world refuses ${route} with the reason (403 placement_local_only)`,
        refused(r) && /127\.0\.0\.1/.test(r.json.message || "") && r.json.bound_address === stack.worldHost && (optIn || (r.json.message || "").includes(OPT_IN)), `answered ${r.status}${r.json ? ` ${r.json.error}: ${r.json.message}` : ` ${r.text.slice(0, 120)}`}`);
    const spoofed = [
      await call(WORLD_A, "POST", "/wow/portal", portalBody, spoof),
      await call(WORLD_A, "POST", `/wow/spatial/1/node/${stack.root}`, nodeBody, spoof),
      await call(WORLD_A, "POST", "/demo/portal/move", { position: [4.5, 0, 4.5] }, spoof),
      await call(WORLD_A, "POST", "/reset", {}, spoof),
      await call(WORLD_A, "POST", `/wow/portal?${OPT_IN}=1`, portalBody, spoof),
    ];
    step(`${label}: headers claiming 127.0.0.1 or the opt-in (Host, X-Forwarded-For, X-Real-IP, Forwarded, ${OPT_IN}) change nothing: still refused`,
      spoofed.every(refused), spoofed.map((r) => r.status).join(", "));
  }

  // ---- through the frontend ----
  const viaApi = (path) => `/api/a${path}`;
  const frontPolicy = await call(FRONT, "GET", viaApi("/placement"));
  const expectFront = worldOn && frontOn;
  step(`${label}: the frontend reports placement ${expectFront ? "on" : "off"} for the world behind it`,
    frontPolicy.status === 200 && frontPolicy.json && frontPolicy.json.allowed === expectFront, `GET ${viaApi("/placement")}: ${frontPolicy.text.replace(/\s+/g, " ").slice(0, 200)}`);
  if (!expectFront) {
    const viaFront = [
      ["POST /api/a/wow/portal", await call(FRONT, "POST", viaApi("/wow/portal"), portalBody)],
      [`PUT /api/a/wow/portal/${stack.portal}`, await call(FRONT, "PUT", viaApi(`/wow/portal/${stack.portal}`), { active_radius_m: 9 })],
      [`POST /api/a/wow/spatial/1/node/${stack.root}`, await call(FRONT, "POST", viaApi(`/wow/spatial/1/node/${stack.root}`), nodeBody)],
      [`PUT /api/a/wow/spatial/1/node/${stack.node} (trailing slash)`, await call(FRONT, "PUT", viaApi(`/wow/spatial/1/node/${stack.node}/`), { localTransform: IDENTITY_AT(2, 2) })],
      [`DELETE /wow/spatial/1/node/${stack.node} (the frontend's own /wow route)`, await call(FRONT, "DELETE", `/wow/spatial/1/node/${stack.node}`)],
      ["POST /api/a/demo/portal/move", await call(FRONT, "POST", viaApi("/demo/portal/move"), { position: [4.5, 0, 4.5] })],
      ["POST /api/a/reset", await call(FRONT, "POST", viaApi("/reset"), {})],
    ];
    for (const [route, r] of viaFront)
      step(`${label}: the frontend refuses ${route} (403 placement_local_only)`, refused(r), `answered ${r.status}${r.json ? ` ${r.json.error}` : ""}`);
  }

  // ---- nothing changed, and the reads still work ----
  const after = await snapshot(stack);
  if (!worldOn || !frontOn) step(`${label}: after every refused write the world is exactly as it was (portal count, graph, placed portal)`, before === after, before === after ? "" : `the world changed: ${firstDifference(before, after)}`);
  const reads = [
    ["GET /wow/world", await call(WORLD_A, "GET", "/wow/world")],
    [`GET /wow/portal/${stack.portal} (the placed portal)`, await call(WORLD_A, "GET", `/wow/portal/${stack.portal}`)],
    ["GET /wow/portal/1 (a configured portal)", await call(WORLD_A, "GET", "/wow/portal/1")],
    [`GET /wow/spatial/1/node/${stack.node} (the placed portal's node)`, await call(WORLD_A, "GET", `/wow/spatial/1/node/${stack.node}`)],
    [`GET /api/a/wow/portal/${stack.portal} (through the frontend)`, await call(FRONT, "GET", viaApi(`/wow/portal/${stack.portal}`))],
  ];
  const placed = reads[1][1].json;
  step(`${label}: placed portals are still served read-only (${reads.map(([r]) => r.split(" ")[1]).join(", ")} answer 200)`,
    reads.every(([, r]) => r.status === 200) && placed && placed.placed === true && placed.active_radius_m === 4,
    `placed portal ${stack.portal}: placed ${placed && placed.placed}, active_radius_m ${placed && placed.active_radius_m}`);

  // ---- the control: where it is local, placement really works, through the frontend ----
  if (worldOn && frontOn) {
    const base = `http://127.0.0.1:${FRONT}/api/a/`;
    const io = { fetch };
    const made = await placePortal(base, { graph: 1, parent: stack.root, localTransform: IDENTITY_AT(2, -2), label: "Control", destination: addr(WORLD_B), active_radius_m: 3 }, io).catch((e) => e);
    step(`${label}: placing a portal through the frontend works (node and portal created)`, made && made.portal && made.portal.id && made.node && Number.isInteger(made.node.id), made.message || `portal ${made.portal && made.portal.id}, node ${made.node && made.node.id}`);
    if (made && made.portal) {
      const changed = await changePortal(base, made.portal.id, { active_radius_m: 5 }, io).catch((e) => e);
      const moved = await moveNode(base, 1, made.node.id, IDENTITY_AT(2.5, -2), io).catch((e) => e);
      step(`${label}: changing the radius and moving the node work`, changed.active_radius_m === 5 && moved && moved.id === made.node.id, `${changed.message || `radius ${changed.active_radius_m}`}; ${moved.message || `node ${moved.id}`}`);
    }
  }
}

// ---------- Part 2: the player in headless Chrome for Testing ----------
let screenNumber = 0;
async function shot(page, name) {
  screenNumber += 1;
  const file = join(SCREENS, `${String(screenNumber).padStart(2, "0")}-${name}.png`);
  await page.screenshot({ path: file });
  console.log(`     screenshot ${relative(WORK, file)}`);
}
const playerUrl = (extra = "") => `http://127.0.0.1:${FRONT}/index.html?role=source&intro=bypass&place=1${extra}&wow=${encodeURIComponent(`${addr(WORLD_A)}wow/spatial/1`)}`;

async function openPlayer(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(() => document.body.dataset.wowPortalsReady === "1", { timeout: 180000 });
  await page.waitForFunction(() => document.body.dataset.wowPlacementReady !== undefined, { timeout: 60000 });
  await sleep(1200);
}

async function floorClickPoint(page, x, z) {
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
        if (!best || d < best.d) best = { x: px, y: py, d };
      }
    }
    return best;
  }, x, z);
}

/** The player against a stack. `local` says what it should offer. `plant` is a planted player fault. */
async function playerStatements(browser, label, stack, { local, shots, setup, reasonRe = /127\.0\.0\.1/ }) {
  const page = await browser.newPage();
  if (setup) await setup(page);
  const writes = [];
  page.on("request", (request) => { if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) writes.push(`${request.method()} ${request.url()}`); });
  try {
    await openPlayer(page, playerUrl());
    const state = await page.evaluate(() => ({
      ready: document.body.dataset.wowPlacementReady,
      panel: !!document.querySelector(".wow-placement-panel"),
      toggle: !!document.querySelector("#wow-place-toggle"),
      on: window.__wowPlacement && window.__wowPlacement.on,
      offered: window.__wowPlacement && window.__wowPlacement.offered,
      reason: window.__wowPlacement && window.__wowPlacement.reason,
      portals: (window.__wowPortals ? window.__wowPortals.summary() : []).map((p) => ({ id: p.id, placed: p.placed, label: p.label, radius: p.active_radius_m })),
    }));
    if (shots) await shot(page, local ? "local-lab-placement-mode-offered" : "public-lab-no-placement-mode");
    if (local) {
      step(`${label}: the player offers placement mode, and ?place=1 opens it`, state.ready === "1" && state.panel && state.toggle && state.on === true && state.offered === true, `ready ${state.ready}, panel ${state.panel}, on ${state.on}`);
    } else {
      step(`${label}: the player offers no placement mode (no panel, no switch, ?place=1 ignored) and says why`,
        state.ready === "unavailable" && !state.panel && !state.toggle && state.on === false && state.offered === false && reasonRe.test(state.reason || ""),
        `ready ${state.ready}, panel ${state.panel}, switch ${state.toggle}, on ${state.on}, reason "${state.reason}"`);
      const placed = state.portals.find((p) => p.id === stack.portal);
      step(`${label}: the placed portal is still shown (read-only)`, !!placed && placed.placed === true && placed.radius === 4 && state.portals.length >= 2, `portals shown: ${JSON.stringify(state.portals)}`);
      const before = await snapshot(stack);
      const target = await floorClickPoint(page, -2, -1);
      const to = await floorClickPoint(page, 1.5, -2);
      if (target && to) {
        await page.mouse.click(target.x, target.y);
        await page.mouse.move(target.x, target.y);
        await page.mouse.down();
        await page.mouse.move((target.x + to.x) / 2, (target.y + to.y) / 2, { steps: 6 });
        await page.mouse.move(to.x, to.y, { steps: 6 });
        await page.mouse.up();
      }
      await sleep(1500);
      const after = await snapshot(stack);
      if (shots) await shot(page, "public-lab-floor-click-and-drag-write-nothing");
      step(`${label}: a floor click and a drag in the player send no write and change nothing`, !!target && !!to && writes.length === 0 && before === after, `write requests from the page: ${writes.length}${writes.length ? ` (${writes[0]})` : ""}`);
    }
  } finally {
    await page.close();
  }
}

/** The player is told "yes" by a page that ignores the answer: the server still refuses the write. */
async function serverStillRefuses(browser, label, stack) {
  const page = await browser.newPage();
  try {
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      if (/\/placement$/.test(new URL(request.url()).pathname) && request.method() === "GET")
        request.respond({ status: 200, contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: JSON.stringify({ allowed: true, reason: null, bound_address: "127.0.0.1" }) });
      else request.continue();
    });
    await openPlayer(page, playerUrl());
    const shown = await page.evaluate(() => !!document.querySelector("#wow-place-toggle") && window.__wowPlacement.on === true);
    const before = await snapshot(stack);
    const target = await floorClickPoint(page, -2, -1);
    if (target) await page.mouse.click(target.x, target.y);
    await page.waitForFunction(() => window.__wowPlacement && window.__wowPlacement.error, { timeout: 30000 }).catch(() => {});
    await sleep(500);
    const error = await page.evaluate(() => window.__wowPlacement && window.__wowPlacement.error);
    const after = await snapshot(stack);
    await shot(page, "page-told-yes-server-still-refuses");
    step(`${label}: even a page that shows placement mode cannot write: the click is refused by the server, with the reason, and nothing changes`,
      shown && !!target && /placement_local_only/.test(error || "") && before === after, `status line: "${(error || "").slice(0, 200)}"`);
  } finally {
    await page.close();
  }
}

// ---------- Part 3: the real launch script ----------
/** `env` entries whose value is null are removed from the child's environment (so "not set" really is not set). */
function launchSh(script, env, args = []) {
  const childEnv = { ...process.env, ...env };
  for (const [key, value] of Object.entries(env)) if (value === null) delete childEnv[key];
  const r = spawnSync("bash", [join(CODE, script), ...args], { cwd: CODE, env: childEnv, encoding: "utf8", timeout: 120000 });
  return { status: r.status, out: `${r.stdout || ""}${r.stderr || ""}` };
}
async function launchStatements() {
  const file = join(RUN, "launch-worlds.json");
  writeFileSync(file, `${JSON.stringify(worldsFile(LAUNCH.front, LAUNCH.a, LAUNCH.b), null, 2)}\n`);
  const env = { OSL_WORLDS: file, OSL_RUN_DIR: join(RUN, "launch-runtime"), [OPT_IN]: null };
  const portalBody = { node: "wow/spatial/1/node/0", label: "x", destination: null };
  try {
    // A public launch, even WITH the opt-in: the bind condition still holds it off.
    const pub = launchSh("launchOpenSpatialLab.sh", { ...env, OSL_BIND_HOST: "0.0.0.0", [OPT_IN]: "1" });
    step("launch with OSL_BIND_HOST=0.0.0.0 (and the opt-in on) starts the lab and says placement is off", pub.status === 0 && /Placement:\s+OFF/.test(pub.out), pub.status === 0 ? "" : pub.out.slice(-400));
    const lsof = spawnSync("lsof", ["-nP", `-iTCP:${LAUNCH.a}`, `-iTCP:${LAUNCH.front}`, "-sTCP:LISTEN"], { encoding: "utf8" }).stdout || "";
    step("the launched servers are bound to every address, not to 127.0.0.1 (lsof)", new RegExp(`\\*:${LAUNCH.a}\\b`).test(lsof) && new RegExp(`\\*:${LAUNCH.front}\\b`).test(lsof), lsof.split("\n").filter((l) => /LISTEN/.test(l)).map((l) => l.replace(/\s+/g, " ").split(" ").slice(-3, -1).join(" ")).join("; "));
    const world = await call(LAUNCH.a, "POST", "/wow/portal", portalBody);
    const front = await call(LAUNCH.front, "POST", "/api/a/wow/portal", portalBody);
    const placement = await call(LAUNCH.a, "GET", "/placement");
    const read = await call(LAUNCH.a, "GET", "/wow/world");
    step("launched public: POST /wow/portal is refused by the world and by the frontend; /placement says off (bind false, opt-in true); reads answer 200",
      refused(world) && refused(front) && placement.json && placement.json.allowed === false && placement.json.bound_address === "0.0.0.0" && placement.json.bound_local === false && placement.json.opt_in === true && read.status === 200,
      `world ${world.status}, frontend ${front.status}, /placement ${JSON.stringify(placement.json && { allowed: placement.json.allowed, bound_address: placement.json.bound_address, bound_local: placement.json.bound_local, opt_in: placement.json.opt_in })}, GET /wow/world ${read.status}`);
    launchSh("stopOpenSpatialLab.sh", env, ["--quiet"]);

    // The default launch, with no opt-in: bound to 127.0.0.1 and still off.
    const local = launchSh("launchOpenSpatialLab.sh", env);
    const lsofLocal = spawnSync("lsof", ["-nP", `-iTCP:${LAUNCH.a}`, "-sTCP:LISTEN"], { encoding: "utf8" }).stdout || "";
    const policy = await call(LAUNCH.a, "GET", "/placement");
    const frontPolicy = await call(LAUNCH.front, "GET", "/api/a/placement");
    const wWorld = await call(LAUNCH.a, "POST", "/wow/portal", portalBody);
    const wFront = await call(LAUNCH.front, "POST", "/api/a/wow/portal", portalBody);
    const wMove = await call(LAUNCH.front, "POST", "/api/a/demo/portal/move", { position: [4.5, 0, 4.5] });
    const wReset = await call(LAUNCH.a, "POST", "/reset", {});
    step("the default launch binds to 127.0.0.1 only, and without the opt-in placement is OFF: says so, /placement says bound yes / opt-in no, and POST /wow/portal, /demo/portal/move and /reset are refused",
      local.status === 0 && /Placement:\s+OFF/.test(local.out) && new RegExp(`127\\.0\\.0\\.1:${LAUNCH.a}\\b`).test(lsofLocal)
        && policy.json && policy.json.allowed === false && policy.json.bound_local === true && policy.json.opt_in === false
        && frontPolicy.json && frontPolicy.json.allowed === false && refused(wWorld) && refused(wFront) && refused(wMove) && refused(wReset),
      `launch exit ${local.status}; /placement ${policy.status} ${policy.text.replace(/\s+/g, " ").slice(0, 160)}; writes: world ${wWorld.status}, frontend ${wFront.status}, move ${wMove.status}, reset ${wReset.status}`);
    launchSh("stopOpenSpatialLab.sh", env, ["--quiet"]);

    // Launch with the opt-in, from the caller's environment: placement is on.
    const on = launchSh("launchOpenSpatialLab.sh", { ...env, [OPT_IN]: "1" });
    const onPolicy = await call(LAUNCH.a, "GET", "/placement");
    const onFront = await call(LAUNCH.front, "GET", "/api/a/placement");
    const onWrite = await call(LAUNCH.front, "POST", "/api/a/wow/portal", portalBody);
    step("launch with the opt-in on, bound to 127.0.0.1: says ON, /placement is allowed through the world and the frontend, and a write is no longer refused as placement_local_only",
      on.status === 0 && /Placement:\s+ON/.test(on.out) && onPolicy.json && onPolicy.json.allowed === true && onPolicy.json.opt_in === true && onFront.json && onFront.json.allowed === true && !refused(onWrite),
      `launch exit ${on.status}; /placement ${onPolicy.text.replace(/\s+/g, " ").slice(0, 160)}; write via frontend answered ${onWrite.status}${onWrite.json && onWrite.json.error ? ` ${onWrite.json.error}` : ""}`);
  } finally {
    const stop = launchSh("stopOpenSpatialLab.sh", env, ["--quiet"]);
    console.log(`     launch servers stopped (exit ${stop.status})`);
  }
}

// ---------- The opt-in values ----------
/** Only the exact value "1" turns placement on. Each value is set in this process's environment and asked on the world. */
async function optInValueStatements(label) {
  const cases = [[null, false, "not set"], ["", false, "empty"], ["0", false, "0"], ["true", false, "true"], ["yes", false, "yes"], ["1", true, "1"]];
  const seen = [];
  for (const [value, expected, name] of cases) {
    setOptIn(value);
    const r = await call(WORLD_A, "GET", "/placement");
    seen.push({ name, allowed: r.json && r.json.allowed, expected });
  }
  setOptIn(null);
  const wrong = seen.filter((c) => c.allowed !== c.expected);
  step(`${label}: only the exact value 1 turns placement on (not set, empty, 0, true and yes stay off)`, wrong.length === 0, wrong.length ? `wrong for: ${wrong.map((c) => `${c.name} -> ${c.allowed}`).join(", ")}` : seen.map((c) => `${c.name} -> ${c.allowed}`).join(", "));
}

// ---------- The scan: nothing under deploy/ or in the launch files sets the opt-in ----------
// Read-only. The scan reads files and never writes them. Two modes:
//   "deploy": any mention of OSL_PLACEMENT (the setting's name, case-insensitive) in any text file fails. The
//             deploy files have no reason to name it. Docs there must not name it either.
//   "launch": the lab's own launch files may READ the setting (to say whether placement is on) but must not SET it:
//             an assignment (NAME=..., NAME: ..., "NAME": ...), an export/ENV/env/-e/--env of it, or
//             process.env.NAME = .... Reads (${NAME}, $NAME) are removed first; comment lines are skipped.
const SKIP_DIRS = new Set(["node_modules", ".git", ".runtime", ".dev"]);
function walk(root, accept) {
  const out = [];
  const visit = (dir) => {
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) visit(full); }
      else if (e.isFile() && accept(full, e.name)) out.push(full);
    }
  };
  visit(root);
  return out;
}
const SET_FORMS = [
  /OSL_PLACEMENT_WRITES["']?\s*[:=]/i,
  /\b(?:export|ENV|env|set|setenv|-e|--env|--env-file)\s+["']?OSL_PLACEMENT_WRITES/i,
  /Environment=\S*OSL_PLACEMENT_WRITES/i,
  /process\.env\.OSL_PLACEMENT_WRITES\s*=(?!=)/i,
  /process\.env\[\s*["']OSL_PLACEMENT_WRITES["']\s*\]\s*=(?!=)/i,
  /OSL_PLACEMENT_WRITES["']?\s+["']?\d/i,
];
/** The lines of `file` that set (mode launch) or mention (mode deploy) the opt-in: [{ file, line, text }]. */
function scanFile(file, mode) {
  let text = "";
  try { if (statSync(file).size > 4 * 1024 * 1024) return { hits: [], scanned: false }; text = readFileSync(file, "latin1"); } catch { return { hits: [], scanned: false }; }
  if (text.includes("\u0000")) return { hits: [], scanned: false };
  const hits = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    if (mode === "deploy") { if (/OSL_PLACEMENT/i.test(raw)) hits.push({ file, line: i + 1, text: raw.trim().slice(0, 160) }); return; }
    const trimmed = raw.trim();
    if (/^(#|\/\/|\*|\/\*)/.test(trimmed)) return;
    const line = raw.replace(/\$\{?OSL_PLACEMENT_WRITES[^}\s"']*\}?/gi, "");
    if (SET_FORMS.some((re) => re.test(line))) hits.push({ file, line: i + 1, text: trimmed.slice(0, 160) });
  });
  return { hits, scanned: true };
}
function scanTree(root, mode, accept = () => true) {
  const files = walk(root, accept);
  let scanned = 0;
  const hits = [];
  for (const f of files) { const r = scanFile(f, mode); if (r.scanned) scanned += 1; hits.push(...r.hits); }
  return { files: files.length, scanned, hits };
}
const DEPLOY = join(WORK, "deploy");
const LAUNCH_NAMES = /^(launchOpenSpatialLab\.sh|stopOpenSpatialLab\.sh|package\.json|worlds\.json|orchestrator\.js|serve\.js|Dockerfile.*|.*\.(ya?ml|service|plist|env|conf)|\.env.*|Caddyfile.*)$/;
/** The lab's launch files: its launch and stop scripts, the servers' starters, its configs and any container files. Not proof/ or logs/. */
function launchFileTargets(root = WORK) {
  const found = [];
  for (const sub of ["code", "config"]) {
    const base = join(root, sub);
    if (!existsSync(base)) continue;
    for (const f of walk(base, (full, name) => LAUNCH_NAMES.test(name) && !/\/code\/(runtime\/world-server\/test|tools|web|wow-spec|diagnostics)\//.test(full))) found.push(f);
  }
  return found;
}
function scanLaunchFiles(root = WORK) {
  const files = launchFileTargets(root);
  let scanned = 0;
  const hits = [];
  for (const f of files) { const r = scanFile(f, "launch"); if (r.scanned) scanned += 1; hits.push(...r.hits); }
  return { files: files.length, scanned, hits };
}
const hitText = (hits) => hits.slice(0, 3).map((h) => `${relative(WORK, h.file)}:${h.line} "${h.text}"`).join("; ");

/** Plant: a deploy-style tree and a launch-style tree that set the opt-in, written only inside this proof folder. */
function plantScanTree() {
  const root = join(RUN, "planted-scan");
  rmSync(root, { recursive: true, force: true });
  const put = (rel, text) => { const f = join(root, rel); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, text); };
  put("clean/deploy/open-spatial-lab.env.example", "OSL_RUNTIME_TOPOLOGY=single-instance\nOSL_PUBLIC_BASE_PATH=/open-spatial-lab/\n");
  put("clean/code/launchOpenSpatialLab.sh", "#!/usr/bin/env bash\nif [ \"${OSL_PLACEMENT_WRITES:-}\" != \"1\" ]; then echo off; fi\n");
  put("env-file/deploy/open-spatial-lab.env", "OSL_RUNTIME_TOPOLOGY=single-instance\nOSL_PLACEMENT_WRITES=1\n");
  put("compose/deploy/docker-compose.yml", "services:\n  lab:\n    environment:\n      OSL_PUBLIC_BASE_PATH: \"/open-spatial-lab/\"\n      OSL_PLACEMENT_WRITES: \"1\"\n");
  put("dockerfile/deploy/Dockerfile", "FROM node:22\nENV OSL_SIGNING_MODE=degraded \\\n    OSL_PLACEMENT_WRITES=1\n");
  put("systemd/deploy/open-spatial-lab.service", "[Service]\nEnvironment=OSL_PLACEMENT_WRITES=1\n");
  put("launch-script/code/launchOpenSpatialLab.sh", "#!/usr/bin/env bash\nexport OSL_PLACEMENT_WRITES=1\nnode src/serve.js\n");
  put("launch-inline/code/launchOpenSpatialLab.sh", "#!/usr/bin/env bash\nOSL_PLACEMENT_WRITES=1 node src/serve.js 1234\n");
  put("launch-js/code/src/orchestrator.js", "'use strict';\nprocess.env.OSL_PLACEMENT_WRITES = '1';\n");
  put("deploy-mention/deploy/README.md", "Set OSL_PLACEMENT_WRITES in the unit file to try it.\n");
  return root;
}

async function scanStatements() {
  const deploy = scanTree(DEPLOY, "deploy");
  step(`scan: no file under deploy/ names the opt-in (${deploy.scanned} files read)`, deploy.scanned >= 20 && deploy.hits.length === 0, deploy.hits.length ? `found: ${hitText(deploy.hits)}` : `${deploy.files} files found, ${deploy.scanned} read, no mention`);
  const launch = scanLaunchFiles();
  const launchNames = launchFileTargets().map((f) => relative(WORK, f));
  step(`scan: none of the lab's own launch files sets the opt-in (${launch.scanned} files read, including the launch script, the stop script and the servers' starters)`,
    launch.scanned >= 6 && launchNames.some((n) => /launchOpenSpatialLab\.sh$/.test(n)) && launchNames.some((n) => /src\/orchestrator\.js$/.test(n)) && launch.hits.length === 0,
    launch.hits.length ? `found: ${hitText(launch.hits)}` : `${launch.scanned} files read: ${launchNames.slice(0, 12).join(", ")}`);

  // Planted faults: the same scan, pointed at planted trees. Each must turn it red. The clean trees must stay green.
  const root = plantScanTree();
  const clean = scanTree(join(root, "clean", "deploy"), "deploy");
  const cleanLaunch = scanTree(join(root, "clean", "code"), "launch");
  step("planted scan control: a clean deploy-style tree and a launch script that only READS the setting stay green", clean.scanned === 1 && clean.hits.length === 0 && cleanLaunch.scanned === 1 && cleanLaunch.hits.length === 0,
    `deploy-style hits ${clean.hits.length}, launch-style hits ${cleanLaunch.hits.length}`);
  const planted = [
    ["an env file in a deploy-style folder sets it", "env-file/deploy", "deploy"],
    ["a compose file in a deploy-style folder sets it", "compose/deploy", "deploy"],
    ["a Dockerfile in a deploy-style folder sets it with ENV", "dockerfile/deploy", "deploy"],
    ["a systemd unit in a deploy-style folder sets it", "systemd/deploy", "deploy"],
    ["a deploy-style README names it (strict mode for deploy/)", "deploy-mention/deploy", "deploy"],
    ["a launch script exports it", "launch-script/code", "launch"],
    ["a launch script sets it inline before the server command", "launch-inline/code", "launch"],
    ["a server starter sets it through process.env", "launch-js/code", "launch"],
  ];
  for (const [name, rel, mode] of planted) {
    const r = scanTree(join(root, rel), mode);
    step(`planted fault caught by the scan (red): ${name}`, r.scanned >= 1 && r.hits.length >= 1, r.hits.length ? `red: ${hitText(r.hits)}` : `the scan stayed green on ${r.scanned} file(s)`);
  }
}

// ---------- Part 4: planted faults ----------
const real = { placementPolicy: localOnly.placementPolicy, isPlacementWrite: localOnly.isPlacementWrite };
function restore() { localOnly.placementPolicy = real.placementPolicy; localOnly.isPlacementWrite = real.isPlacementWrite; }

/** Run `body` and return the names of the statements it turned red. */
async function redStatements(body) {
  const start = results.length;
  await body();
  const mine = results.splice(start);
  for (const r of mine) console.log(`     (planted fault run) ${r.ok ? "pass" : "RED "} ${r.name}`);
  return mine.filter((r) => !r.ok).map((r) => r.name);
}

async function main() {
  rmSync(SCREENS, { recursive: true, force: true });
  mkdirSync(SCREENS, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: findBrowser(), headless: "new",
    args: ["--no-sandbox", "--enable-webgl", "--ignore-gpu-blocklist", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
    defaultViewport: { width: 1280, height: 800 },
  });
  try {
    // ---- Part 1 and 2, the code as it is ----
    currentSection = "L: world and frontend on 127.0.0.1, with the opt-in (control)";
    setOptIn("1");
    let stack = await startStack("127.0.0.1", "127.0.0.1");
    try {
      await statementsFor("L", stack, { worldLocal: true, frontLocal: true });
      await playerStatements(browser, "L", stack, { local: true, shots: true });
    } finally { await stack.stop(); }

    currentSection = "P: world and frontend on 0.0.0.0 (a public lab; the opt-in is on, the bind still holds it off)";
    setOptIn("1");
    stack = await startStack("0.0.0.0", "0.0.0.0");
    try {
      await statementsFor("P", stack, { worldLocal: false, frontLocal: false });
      await playerStatements(browser, "P", stack, { local: false, shots: true });
      await serverStillRefuses(browser, "P", stack);
    } finally { await stack.stop(); }

    currentSection = "M: world on 127.0.0.1 behind a frontend on 0.0.0.0";
    setOptIn("1");
    stack = await startStack("127.0.0.1", "0.0.0.0");
    try { await statementsFor("M", stack, { worldLocal: true, frontLocal: false }); }
    finally { await stack.stop(); }

    currentSection = "N: world and frontend on 127.0.0.1 WITHOUT the opt-in (a loopback listener behind a public proxy)";
    setOptIn(null);
    stack = await startStack("127.0.0.1", "127.0.0.1");
    try {
      await statementsFor("N", stack, { worldLocal: true, frontLocal: true, optIn: false });
      await playerStatements(browser, "N", stack, { local: false, shots: true, reasonRe: /OSL_PLACEMENT_WRITES/ });
      await serverStillRefuses(browser, "N", stack);
      await optInValueStatements("N");
    } finally { await stack.stop(); }

    currentSection = "L2: the old routes still work on a local lab with the opt-in";
    setOptIn("1");
    stack = await startStack("127.0.0.1", "127.0.0.1");
    try {
      const movedWorld = await call(WORLD_A, "POST", "/demo/portal/move", { position: [4.5, 0, 4.5] });
      const movedFront = await call(FRONT, "POST", "/api/a/demo/portal/move", { position: [3.5, 0, 3.5] });
      const portalOne = await call(WORLD_A, "GET", "/wow/portal/1");
      step("L2: POST /demo/portal/move works on a local lab, on the world and through the frontend (the demo drag is unchanged)",
        movedWorld.status === 200 && movedFront.status === 200 && /3\.5/.test(portalOne.text), `world ${movedWorld.status}, frontend ${movedFront.status}, portal 1 trigger now ${(portalOne.text.match(/"position":\s*\[[^\]]*\]/) || [""])[0].replace(/\s+/g, "")}`);
      const resetFront = await call(FRONT, "POST", "/api/a/reset", {});
      const placedAfter = await call(WORLD_A, "GET", `/wow/portal/${stack.portal}`);
      const resetWorld = await call(WORLD_A, "POST", "/reset", {});
      step("L2: POST /reset works on a local lab, on the world and through the frontend (it erases the placed portal's node, as before)",
        resetFront.status === 200 && resetWorld.status === 200 && placedAfter.status !== 500, `frontend ${resetFront.status}, world ${resetWorld.status}`);
    } finally { await stack.stop(); }

    currentSection = "launch script";
    setOptIn(null);
    await launchStatements();

    currentSection = "scan: deploy/ and the launch files";
    await scanStatements();

    // ---- Part 4: planted faults, each must turn a statement red ----
    currentSection = "planted faults";
    const faults = [
      {
        name: "the switch always says allowed (judges nothing)",
        stack: ["0.0.0.0", "0.0.0.0"], optIn: "1", mode: { worldLocal: false, frontLocal: false },
        plant: () => { localOnly.placementPolicy = (server) => ({ allowed: true, bound_local: true, opt_in: true, bound_address: localOnly.boundAddress(server), reason: null }); },
        expect: /P: the world refuses POST \/wow\/portal/,
      },
      {
        name: "the switch guards the portal routes but forgets the node routes",
        stack: ["0.0.0.0", "0.0.0.0"], optIn: "1", mode: { worldLocal: false, frontLocal: false },
        plant: () => { localOnly.isPlacementWrite = (method, path) => real.isPlacementWrite(method, path) && /^\/wow\/portal/.test(String(path)); },
        expect: /P: the world refuses (POST|PUT|DELETE) \/wow\/spatial/,
      },
      {
        name: "the frontend does not apply the switch (a public page in front of a local world)",
        stack: ["127.0.0.1", "0.0.0.0"], optIn: "1", mode: { worldLocal: true, frontLocal: false },
        plant: () => { localOnly.placementPolicy = (server) => (server && server.address() && server.address().port === FRONT ? { allowed: true, bound_local: true, opt_in: true, bound_address: "127.0.0.1", reason: null } : real.placementPolicy(server)); },
        expect: /M: the frontend refuses POST \/api\/a\/wow\/portal/,
      },
      {
        name: "the switch guards the placement routes but forgets /demo/portal/move and /reset",
        stack: ["0.0.0.0", "0.0.0.0"], optIn: "1", mode: { worldLocal: false, frontLocal: false },
        plant: () => { localOnly.isPlacementWrite = (method, path) => (String(path) === "/demo/portal/move" || String(path) === "/reset") ? false : real.isPlacementWrite(method, path); },
        expect: /P: the world refuses POST \/(demo\/portal\/move|reset)/,
      },
      {
        name: "the switch judges the bind only and ignores the opt-in (a loopback listener behind a public proxy)",
        stack: ["127.0.0.1", "127.0.0.1"], optIn: null, label: "N", mode: { worldLocal: true, frontLocal: true, optIn: false },
        plant: () => { localOnly.placementPolicy = (server) => real.placementPolicy(server, { OSL_PLACEMENT_WRITES: "1" }); },
        expect: /N: the world refuses POST \/wow\/portal/,
      },
      {
        name: "the switch treats any non-empty opt-in value as on (0, true and yes switch it on)",
        stack: ["127.0.0.1", "127.0.0.1"], optIn: null, label: "N", values: true, mode: { worldLocal: true, frontLocal: true, optIn: false },
        plant: () => { localOnly.placementPolicy = (server, env = process.env) => real.placementPolicy(server, { OSL_PLACEMENT_WRITES: env.OSL_PLACEMENT_WRITES ? "1" : "" }); },
        expect: /N: only the exact value 1 turns placement on/,
      },
    ];
    for (const fault of faults) {
      const stackF = await startStack(...fault.stack);
      let red;
      try {
        setOptIn(fault.optIn);
        fault.plant();
        const label = fault.label || (fault.stack[0] === "127.0.0.1" ? "M" : "P");
        red = await redStatements(async () => { if (fault.values) await optInValueStatements(label); else await statementsFor(label, stackF, fault.mode); });
      } finally { restore(); setOptIn(null); await stackF.stop(); }
      const caught = red.some((name) => fault.expect.test(name));
      step(`planted fault caught: ${fault.name}`, caught, caught ? `${red.length} statement(s) went red, among them: ${red.find((n) => fault.expect.test(n))}` : `no expected statement went red (red: ${red.join("; ") || "none"})`);
    }

    // A fault in the player: it ignores the world's answer and always offers placement mode. The same player
    // statements run against a public lab with the planted source, and one must go red.
    {
      setOptIn("1");
      const stackF = await startStack("0.0.0.0", "0.0.0.0");
      let applied = false;
      try {
        const original = readFileSync(join(CODE, "web", "wow-portal.mjs"), "utf8");
        const faulty = original.replace("if (json && json.allowed === true) return", "if (true) return");
        applied = faulty !== original;
        const setup = async (page) => {
          await page.setRequestInterception(true);
          page.on("request", (request) => {
            if (new URL(request.url()).pathname === "/wow-portal.mjs") request.respond({ status: 200, contentType: "text/javascript; charset=utf-8", body: faulty });
            else request.continue();
          });
        };
        const red = await redStatements(() => playerStatements(browser, "P", stackF, { local: false, shots: false, setup }));
        const caught = applied && red.some((name) => /P: the player offers no placement mode/.test(name));
        step("planted fault caught: the player ignores the world's answer and offers placement mode on a public lab", caught, `fault applied to the player source: ${applied}; red: ${red.join("; ") || "none"}`);
      } finally { setOptIn(null); await stackF.stop(); }
    }
  } finally {
    restore();
    await browser.close();
  }
}

const started = Date.now();
await main().catch((error) => step("the check ran to the end", false, error.stack || String(error)));
const failed = results.filter((r) => !r.ok);
const outFile = join(OUT, "check-local-only.json");
writeFileSync(outFile, `${JSON.stringify({ ran_at: new Date().toISOString(), seconds: Math.round((Date.now() - started) / 1000), passed: results.length - failed.length, failed: failed.length, results }, null, 2)}\n`);
console.log(failed.length ? `FAIL: ${failed.length} of ${results.length} statements failed.` : `PASS: all ${results.length} statements passed (including every planted fault caught).`);
process.exit(failed.length || !results.length ? 1 : 0);
