// The main demo on isolated ports, driven as a person drives it: a real lab from its own worlds file, and headless
// Chrome for Testing with real keyboard and mouse input. Used by the proof (proof.mjs) and the portal views (walk.mjs).
// They need a headless Chrome for Testing, which tools/find-browser.mjs finds.
import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const CODE = resolve(HERE, "..", "..", "..");
const require = createRequire(join(CODE, "package.json"));
const puppeteer = require("puppeteer-core");
const { findBrowser } = await import(pathToFileURL(join(CODE, "tools", "find-browser.mjs")).href);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The worlds file of a lab whose ports start at `first` (the frontend), with `extra` worlds after the four built-in ones. */
export function worldsDoc(first, extra = []) {
  const addr = (port) => `http://127.0.0.1:${port}/`;
  return {
    frontend: { port: first },
    worlds: [
      { key: "a", name: "Location A", port: first + 1, address: addr(first + 1), anchor: { lat: 47.7, lon: -122.3, h: 11.5 }, room: "#3aa0ff", preview_radius_m: 10 },
      { key: "b", name: "Location B", port: first + 2, address: addr(first + 2), anchor: { lat: 47.7, lon: -122.2986676811, h: 11.5 }, room: "#ff7a3a", preview_radius_m: 10, portal_ring: { color: "#ffc266", fill: "#ffb14d" } },
      { key: "lobby", name: "Lobby", port: first + 3, address: addr(first + 3), anchor: { lat: 47.7, lon: -122.3013323189, h: 11.5 }, room: "#42d68a", preview_radius_m: 10 },
      { key: "airport", name: "Denver Skyport", port: first + 4, address: addr(first + 4), anchor: { lat: 39.8561, lon: -104.6737, h: 1655.0 }, preview_radius_m: 24 },
      ...extra,
    ],
  };
}

/**
 * A copy of the code with planted faults: exact string edits, each of which must apply. An edit that no longer applies
 * is a harness error, not a pass. The large folders are linked, not copied.
 */
export function plantFaults({ dir, edits }) {
  const code = join(dir, "code");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(code, { recursive: true });
  for (const name of ["src", "runtime", "web", "tools", "wow-spec"]) {
    cpSync(join(CODE, name), join(code, name), {
      recursive: true,
      filter: (source) => !(source === join(CODE, "web", "assets")),
    });
  }
  for (const name of ["package.json", "worlds.json", "launchOpenSpatialLab.sh", "stopOpenSpatialLab.sh"]) cpSync(join(CODE, name), join(code, name));
  symlinkSync(join(CODE, "node_modules"), join(code, "node_modules"));
  symlinkSync(join(CODE, "web", "assets"), join(code, "web", "assets"));
  for (const { file, find, replace } of edits) {
    const path = join(code, file);
    const before = readFileSync(path, "utf8");
    if (!before.includes(find)) throw new HarnessError(`a planted fault no longer applies: ${file}: ${JSON.stringify(find).slice(0, 120)}`);
    writeFileSync(path, before.replace(find, replace));
  }
  return code;
}

export class HarnessError extends Error {}

/**
 * A lab: its own worlds file and run folder under `dir`. `env` is added to its environment; `code` is the code to run
 * (a copy with planted faults, or the real code).
 */
export function createLab({ dir, first, extra = [], env = {}, code = CODE }) {
  const runDir = join(dir, "run");
  rmSync(runDir, { recursive: true, force: true });
  mkdirSync(runDir, { recursive: true });
  const worldsFile = join(runDir, "worlds.json");
  const doc = worldsDoc(first, extra);
  writeFileSync(worldsFile, `${JSON.stringify(doc, null, 2)}\n`);
  const ENV = { ...process.env, OSL_WORLDS: worldsFile, OSL_RUN_DIR: join(runDir, "runtime"), ...env };
  const sh = (script, args = []) => {
    const r = spawnSync("bash", [join(code, script), ...args], { cwd: code, env: ENV, encoding: "utf8", timeout: 180000 });
    return { status: r.status, out: `${r.stdout || ""}${r.stderr || ""}` };
  };
  const processes = new Map();
  const logFile = (name) => openSync(join(runDir, `${name}.log`), "a");
  const start = (name, args, overrides = {}) => {
    const log = logFile(name);
    const child = spawn(process.execPath, args, { cwd: code, env: { ...ENV, ...overrides }, stdio: ["ignore", log, log], detached: false });
    processes.set(name, child);
    return child;
  };
  const waitFor = async (url, what) => {
    for (let i = 0; i < 300; i += 1) {
      try {
        const r = await fetch(url);
        if (r.ok) return;
      } catch { /* not up yet */ }
      await sleep(100);
    }
    throw new HarnessError(`${what} did not come up at ${url}; see ${runDir}`);
  };
  return {
    doc,
    worldsFile,
    runDir,
    code,
    front: `http://127.0.0.1:${first}`,
    world: (key) => doc.worlds.find((w) => w.key === key),
    port: (key) => doc.worlds.find((w) => w.key === key).port,
    address: (key) => doc.worlds.find((w) => w.key === key).address,
    /** The launch script, as `npm start` runs it. */
    start() {
      sh("stopOpenSpatialLab.sh", ["--quiet"]);
      const launch = sh("launchOpenSpatialLab.sh");
      if (launch.status !== 0) throw new HarnessError(`the lab did not start: ${launch.out.slice(-800)}`);
      return launch.out;
    },
    /**
     * The frontend lists every world, but `separate` (a world key) runs in a process of its own, so stopWorld(key) can
     * take that world offline while the rest keep running.
     */
    async startWithSeparateWorld(separate) {
      const main = { ...doc, worlds: doc.worlds.filter((w) => w.key !== separate) };
      const alone = { ...doc, worlds: doc.worlds.filter((w) => w.key === separate) };
      const mainFile = join(runDir, "worlds-main.json");
      const aloneFile = join(runDir, "worlds-separate.json");
      writeFileSync(mainFile, JSON.stringify(main, null, 2));
      writeFileSync(aloneFile, JSON.stringify(alone, null, 2));
      start("worlds-main", ["src/orchestrator.js", "serve-backends"], { OSL_WORLDS: mainFile, OSL_WOW_VALIDATE: "1" });
      start(`world-${separate}`, ["src/orchestrator.js", "serve-backends"], { OSL_WORLDS: aloneFile, OSL_WOW_VALIDATE: "1" });
      start("frontend", ["src/serve.js", String(first)]);
      for (const w of doc.worlds) await waitFor(`http://127.0.0.1:${w.port}/healthz`, w.name);
      await waitFor(`${this.front}/worlds.json`, "the frontend");
    },
    async stopWorld(key) {
      const child = processes.get(`world-${key}`);
      if (!child) throw new HarnessError(`world ${key} does not run in a process of its own`);
      await new Promise((done) => { child.once("exit", done); child.kill("SIGTERM"); });
      processes.delete(`world-${key}`);
    },
    async stop() {
      for (const child of processes.values()) {
        await new Promise((done) => {
          if (child.exitCode !== null) { done(); return; }
          child.once("exit", done);
          child.kill("SIGTERM");
          setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } }, 4000).unref();
        });
      }
      processes.clear();
      sh("stopOpenSpatialLab.sh", ["--quiet"]);
    },
  };
}

export async function launchBrowser() {
  return puppeteer.launch({
    executablePath: findBrowser(), headless: "new",
    args: ["--no-sandbox", "--enable-webgl", "--ignore-gpu-blocklist", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
    defaultViewport: { width: 1280, height: 800 },
  });
}

/** Open the main demo as a Player and wait until the world and the avatar are up. */
export async function openPlayer(page, url, { settle = 1200 } = {}) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(() => document.body.dataset.assemblyReady === "1" && window.__assembly?.debugState, { timeout: 120000 });
  await page.evaluate(() => document.querySelector('[data-testid="start-exploring"]')?.click());
  await page.waitForFunction(() => window.__assembly.equipmentReady?.() !== false && window.__assembly.debugState().avatar, { timeout: 120000 });
  await sleep(settle);
}

export const state = (page) => page.evaluate(() => {
  const d = window.__assembly.debugState();
  return {
    location_id: d.location_id, phase: d.phase, position: d.avatar && d.avatar.position, rotation_y: d.avatar && d.avatar.rotation_y,
    controls: d.controls && { moving: d.controls.moving, movement_mode: d.controls.movement_mode, speed_mps: d.controls.speed_mps, focus: d.controls.portal_focus_portal_id, blocker: d.controls.portal_ready_blocker },
    basis: window.__assembly.movementBasisYaw(),
  };
});

const wrap = (a) => { let v = a; while (v > Math.PI) v -= Math.PI * 2; while (v < -Math.PI) v += Math.PI * 2; return v; };

/** Turn the follow camera with a real mouse drag, so that W walks along `yaw` (radians, 0 = +Z). */
export async function faceYaw(page, yaw, { tolerance = 0.02 } = {}) {
  const box = await page.evaluate(() => { const r = document.querySelector("#scene-mount").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height * 0.8 }; });
  for (let i = 0; i < 6; i += 1) {
    const basis = await page.evaluate(() => window.__assembly.movementBasisYaw());
    const delta = wrap(yaw - basis);
    if (Math.abs(delta) <= tolerance) return true;
    // The drag speed is the camera's orbit speed per pixel; a drag to the right lowers the azimuth.
    const px = Math.max(-500, Math.min(500, Math.round(delta / 0.005) * -1));
    if (px === 0) return true;
    await page.mouse.move(box.x, box.y);
    await page.mouse.down();
    await page.mouse.move(box.x + px, box.y, { steps: 6 });
    await page.mouse.up();
    await sleep(700);
  }
  return false;
}

/** Hold a key for about `ms`. */
export async function hold(page, key, ms) {
  await page.keyboard.down(key);
  await sleep(ms);
  await page.keyboard.up(key);
}

/** Walk to (x, z) with the W key, turning the camera with the mouse toward the target first; stops within `tolerance`. */
export async function walkTo(page, x, z, { tolerance = 0.12, maxSteps = 60 } = {}) {
  let closest = Infinity;
  let stalled = 0;
  for (let step = 0; step < maxSteps; step += 1) {
    const s = await state(page);
    const dx = x - s.position[0];
    const dz = z - s.position[2];
    const distance = Math.hypot(dx, dz);
    if (distance <= tolerance) return s;
    // On a busy machine a short press can fall between two frames and move nothing: then press for longer.
    stalled = distance < closest - 0.01 ? 0 : stalled + 1;
    closest = Math.min(closest, distance);
    await faceYaw(page, Math.atan2(dx, dz), { tolerance: distance > 1.5 ? 0.06 : 0.03 });
    await hold(page, "w", Math.max(60, Math.min(900, distance * 260)) * Math.min(6, 1 + stalled));
    await sleep(150);
  }
  throw new Error(`could not walk to ${x},${z} (timed out after ${maxSteps} steps): ${JSON.stringify(await state(page))}`);
}

/**
 * Walk through a portal with real keys: to `from`, turn to `yaw`, then hold W until the world changes or `timeoutMs`
 * passes. Returns the state at the first sight of the new world (the key may still be held: `release` says).
 */
export async function walkThrough(page, { from, yaw, expect, timeoutMs = 14000, release = true, keys = ["w"] }) {
  await walkTo(page, from[0], from[1]);
  await faceYaw(page, yaw);
  await sleep(400);
  const started = Date.now();
  for (const key of keys) await page.keyboard.down(key);
  let s = await state(page);
  while (Date.now() - started < timeoutMs) {
    s = await state(page);
    if (expect ? s.location_id === expect : false) break;
    await sleep(60);
  }
  if (release) {
    for (const key of [...keys].reverse()) await page.keyboard.up(key);
    await sleep(250);
  }
  return s;
}

/** Where a world point is on the page, in client pixels. */
export async function screenPointOf(page, point) {
  return page.evaluate((p) => {
    const camera = window.__assembly.viewport.identity().camera;
    camera.updateMatrixWorld(true);
    const v = camera.position.clone().set(p[0], p[1], p[2]).project(camera);
    const r = document.querySelector("#scene-mount").getBoundingClientRect();
    return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height, ndc: [v.x, v.y, v.z] };
  }, point);
}
