// The shared part of the behavior checks: statements that are named and can fail, driven as a person drives the main
// demo. A check file lists its statements and its planted faults and hands them to runBehavior:
//
//   const statements = [{ id: "w-walks", says: "W walks ahead", async run(ctx) {
//     const page = await ctx.visit(`${ctx.lab.front}/index.html?role=player&intro=bypass`);
//     const walk = await holdKeys(page, ["w"], 0.6);
//     expect(walk.speed > 2, `walked at ${walk.speed} m/s`);   // the failure message is what a fault's `expect` matches
//     return "what it saw, for the one output line";
//   } }];
//   const faults = [{ statement: "w-walks", name: "half speed", expect: /walked at/, edits: [{ file, find, replace }] }];
//   await runBehavior({ title: "walking", firstPort: 36130, statements, faults });
//
// Run: node tools/behavior/<file> [--faults] [--faults-only] [--only id,id]
// Checks that open a page need a headless Chrome for Testing, which tools/find-browser.mjs finds.
// One line per statement and per fault. Exit 0: all passed, every fault caught for its reason. Exit 1: a statement
// failed or a fault was missed. Exit 2: a harness error (an edit no longer applies, or a catch for another reason).
//
// ctx.once(name, fn) runs fn one time per lab, so that statements can share one walk. A statement with `lab: (first) =>
// options` gets a lab of its own, with createLab's `extra` and `env`, and `separate` for a world in its own process. Every
// read of the demo's insides is in pageFacts below; check files read nothing else from the page.
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CODE, HarnessError, createLab, faceYaw, hold, launchBrowser, openPlayer, plantFaults, sleep, state, walkThrough, walkTo } from "../arch-i4/main-demo/lab.mjs";
import { recordRequests } from "../arch-i4/main-demo/request-log.mjs";
import { getJson } from "../arch-i4/main-demo/world-data.mjs";

export { faceYaw, hold, recordRequests, sleep, state, walkThrough, walkTo };

const STATEMENT_LIMIT_MS = 600000; // a walk through the airport and back took over 300 s at load average 300
// A small page: each open page draws its world on the CPU, and the checks need frames, not pixels.
const VIEWPORT = { width: 640, height: 400 };
const LOAD_FAILURE = /timed out|timeout|exceeded|Target closed|Protocol error|detached|Session closed|fetch failed/i;

/** Close a browser; on a swamped machine close() can wait for ever, so its process goes after 20 s. */
async function closeBrowser(browser) {
  if (!browser) return;
  const chrome = browser.process();
  await Promise.race([browser.close().catch(() => {}), sleep(20000)]);
  if (chrome && chrome.exitCode === null) chrome.kill("SIGKILL");
}

export const fail = (message) => { throw new Error(message); };
export const expect = (value, message) => { if (!value) fail(message); };
export const inRange = (value, [low, high]) => value >= low && value <= high;
export const planar = (a, b) => Math.hypot(a[0] - b[0], a[2] - b[2]);
export const fixed = (value, digits = 3) => Number(value).toFixed(digits);

/** The smallest signed difference between two angles, in radians. */
export function angleBetween(a, b) {
  let v = a - b;
  while (v > Math.PI) v -= Math.PI * 2;
  while (v < -Math.PI) v += Math.PI * 2;
  return Math.abs(v);
}

/**
 * Adds to every page a count of the time the movement loop was given. The loop moves the avatar by at most 0.05 s per
 * frame, so on a loaded machine wall time says nothing about how far it should have gone; this clock does.
 */
function installPageRecorders() {
  const clock = { frames: 0, seconds: 0, last: 0 };
  window.__behaviorClock = clock;
  const tick = (now) => {
    if (clock.last) clock.seconds += Math.min(0.05, (now - clock.last) / 1000);
    clock.last = now;
    clock.frames += 1;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  window.__behaviorToasts = [];
  document.addEventListener("DOMContentLoaded", () => {
    new MutationObserver((changes) => {
      for (const change of changes) {
        for (const node of change.addedNodes) if (node.classList && node.classList.contains("toast")) window.__behaviorToasts.push(node.textContent.replace(/\s+/g, " ").trim());
      }
    }).observe(document.body, { childList: true, subtree: true });
  });
}

/** Everything the checks read from the page. `with` adds the costlier parts: "objects" (shown in the scene) and "peers". */
export function pageFacts(page, { with: extras = [] } = {}) {
  return page.evaluate((wanted) => {
    const assembly = window.__assembly;
    const debug = assembly.debugState();
    const { camera, scene } = assembly.viewport.identity();
    camera.updateMatrixWorld(true);
    const look = camera.getWorldDirection(camera.position.clone());
    const facts = {
      location: debug.location_id,
      phase: debug.phase,
      playerId: debug.controlled_identity ? debug.controlled_identity.player_id : null,
      position: debug.avatar ? debug.avatar.position : null,
      facing: debug.avatar ? debug.avatar.rotation_y : null,
      moving: debug.controls ? debug.controls.moving : null,
      mode: debug.controls ? debug.controls.movement_mode : null,
      grounded: debug.controls ? debug.controls.grounded !== false : null,
      basis: assembly.movementBasisYaw(),
      camera: [camera.position.x, camera.position.y, camera.position.z],
      cameraYaw: Math.atan2(look.x, look.z),
      title: (document.getElementById("loc-title") || {}).textContent || null,
      clock: window.__behaviorClock.seconds,
      frames: window.__behaviorClock.frames,
      toasts: window.__behaviorToasts.slice(),
      refusals: assembly.portalRefusals(),
      arrivals: assembly.phaseLog().filter((entry) => entry.phase === "arrived").length,
      airportReady: document.body.dataset.airportTerminalReady === "1",
    };
    if (wanted.includes("peers")) facts.peers = assembly.peerAvatars();
    if (wanted.includes("objects")) {
      const shown = new Set();
      scene._impl.scene.traverse((node) => {
        if (node.visible && node.name && node.name.startsWith("demo-scene-object-")) shown.add(node.name.slice("demo-scene-object-".length));
      });
      facts.objects = [...shown];
    }
    return facts;
  }, extras);
}

/** Wait until the movement loop has been given `seconds` more of its time. A loop that stands still is a time-out. */
export async function untilClock(page, seconds, { limitMs = 60000 } = {}) {
  const start = (await pageFacts(page)).clock;
  const started = Date.now();
  for (;;) {
    const facts = await pageFacts(page);
    if (facts.clock - start >= seconds) return facts;
    if (Date.now() - started > limitMs) fail(`the movement loop got ${fixed(facts.clock - start)} of ${seconds} s (timed out after ${limitMs / 1000} s)`);
    await sleep(40);
  }
}

/**
 * Hold keys for `seconds` of the movement loop's time and measure the walk while they are held, so the press and the
 * release, which fall anywhere between two frames, are not part of it. `distance` is scaled to exactly `seconds`.
 */
export async function holdKeys(page, keys, seconds) {
  for (const key of keys) await page.keyboard.down(key);
  await untilClock(page, 0.1);
  const before = await pageFacts(page);
  const after = await untilClock(page, seconds);
  for (const key of [...keys].reverse()) await page.keyboard.up(key);
  const moved = [after.position[0] - before.position[0], after.position[2] - before.position[2]];
  const clock = after.clock - before.clock;
  const measured = Math.hypot(moved[0], moved[1]);
  return { before, after, moved, clock, distance: measured * (seconds / clock), speed: measured / clock, heading: Math.atan2(moved[0], moved[1]) };
}

/** A world's presence record as its own route gives it. */
export async function worldRecord(lab, key) {
  const { json } = await getJson(`${lab.address(key)}fabric/presence`);
  return { avatars: json.occupancy.avatars, arrivals: json.occupancy.arrival_count };
}

/** Poll until `check()` gives a true value, or fail with `message` and "(timed out)". */
export async function waitUntil(check, message, { limitMs = 15000, everyMs = 100 } = {}) {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > limitMs) fail(`${typeof message === "function" ? await message() : message} (timed out after ${limitMs / 1000} s)`);
    await sleep(everyMs);
  }
}

/** Blur the window. A headless page cannot lose focus to another window, so the event is dispatched. */
export const blurWindow = (page) => page.evaluate(() => window.dispatchEvent(new Event("blur")));

function newContext(browser, labFor, pageErrors) {
  const ctx = {
    browser, lab: null, pageErrors, contexts: [], memo: new Map(),
    async startLab({ separate, ...options } = {}) {
      ctx.lab = labFor(options);
      try {
        if (separate) await ctx.lab.startWithSeparateWorld(separate);
        else ctx.lab.start();
      } catch (error) {
        // A start that ran out of time on a swamped machine is load, not a broken harness: it gets the one re-run.
        fail(`${error.message} (timed out)`);
      }
    },
    once(name, fn) {
      if (!ctx.memo.has(name)) ctx.memo.set(name, fn());
      return ctx.memo.get(name);
    },
    /** A new visitor in its own browser profile, or `sameProfileAs` a page already open (a second tab). */
    async visit(url, { sameProfileAs = null, open = true } = {}) {
      const context = sameProfileAs ? sameProfileAs.browserContext() : await browser.createBrowserContext();
      if (!sameProfileAs) ctx.contexts.push(context);
      const page = await context.newPage();
      await page.setViewport(VIEWPORT);
      await page.evaluateOnNewDocument(installPageRecorders);
      page.on("pageerror", (error) => ctx.pageErrors.push(String((error && error.message) || error)));
      if (open) await openPlayer(page, url);
      return page;
    },
    async close() {
      for (const context of ctx.contexts.splice(0)) await Promise.race([context.close().catch(() => {}), sleep(20000)]);
      if (ctx.lab) await ctx.lab.stop();
      // lab.stop() blocks the event loop, so Node's fetch would not see that the old sockets closed, and would reuse a
      // dead one on the same port.
      await sleep(500);
    },
  };
  return ctx;
}

async function withLimit(promise) {
  let timer;
  const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`the statement did not finish (timed out after ${STATEMENT_LIMIT_MS / 1000} s)`)), STATEMENT_LIMIT_MS); });
  try { return await Promise.race([promise, limit]); } finally { clearTimeout(timer); }
}

async function attempt(statement, ctx) {
  try {
    if (statement.lab) await ctx.startLab(statement.lab(ctx.first));
    else if (!ctx.lab) await ctx.startLab();
    return { ok: true, detail: await withLimit(statement.run(ctx)) };
  } catch (error) {
    if (error instanceof HarnessError) throw error;
    return { ok: false, detail: String((error && error.message) || error) };
  }
}

class Runner {
  constructor({ title, firstPort, statements }) {
    this.out = join(CODE, ".runtime", "behavior", title);
    this.first = Number(process.env.OSL_TEST_PORT_BASE) || firstPort;
    this.statements = statements;
    this.counts = { passed: 0, failed: 0, caught: 0, missed: 0, harness: 0 };
    this.pageErrors = [];
  }

  labMaker(code, name) {
    return (options) => createLab({ dir: join(this.out, name), first: this.first, code, ...options });
  }

  async fresh(labFor) {
    await closeBrowser(this.browser);
    this.browser = await launchBrowser();
    return this.context(labFor);
  }

  context(labFor) {
    const ctx = newContext(this.browser, labFor, this.pageErrors);
    ctx.first = this.first;
    return ctx;
  }

  /**
   * Every statement in order on one lab; a statement with a lab of its own takes the same ports, so the shared lab stops
   * for it and starts again if a later statement needs it. A failure load might cause gets one re-run.
   */
  async runStatements(selected) {
    const labFor = this.labMaker(CODE, "real");
    this.shared = await this.fresh(labFor);
    for (const statement of selected) {
      const started = Date.now();
      if (statement.lab) await this.restartShared(labFor);
      let result = await attempt(statement, this.shared);
      if (!result.ok && LOAD_FAILURE.test(result.detail)) {
        console.log(`      ${statement.id}: ${result.detail.slice(0, 160)}: one re-run`);
        await this.restartShared(labFor, true);
        result = await attempt(statement, this.shared);
      }
      if (statement.lab) await this.restartShared(labFor);
      this.counts[result.ok ? "passed" : "failed"] += 1;
      console.log(`${result.ok ? "PASS" : "FAIL"}  ${statement.id}: ${statement.says} -> ${result.detail} (${Math.round((Date.now() - started) / 1000)} s)`);
    }
    await this.closeShared();
  }

  async closeShared() {
    if (this.shared) await this.shared.close();
    this.shared = null;
  }

  async restartShared(labFor, newBrowser = false) {
    await this.closeShared();
    this.shared = newBrowser ? await this.fresh(labFor) : this.context(labFor);
  }

  async runFaultOnce(statement, labFor) {
    this.pageErrors.length = 0;
    this.shared = await this.fresh(labFor);
    try {
      return await attempt(statement, this.shared);
    } finally {
      await this.closeShared();
    }
  }

  async runFault(fault) {
    const started = Date.now();
    const statement = this.statements.find((s) => s.id === fault.statement);
    if (!statement) throw new HarnessError(`a planted fault names no statement: ${fault.statement}`);
    const dir = join(this.out, "fault");
    const code = plantFaults({ dir, edits: fault.edits });
    const labFor = this.labMaker(code, "fault");
    let result = await this.runFaultOnce(statement, labFor);
    if (!result.ok && !fault.expect.test(result.detail) && LOAD_FAILURE.test(result.detail)) {
      console.log(`      ${fault.statement}, ${fault.name}: ${result.detail.slice(0, 160)}: one re-run`);
      result = await this.runFaultOnce(statement, labFor);
    }
    rmSync(code, { recursive: true, force: true });
    const verdict = result.ok ? "MISSED" : fault.expect.test(result.detail) ? "CAUGHT" : "HARNESS ERROR, CAUGHT FOR ANOTHER REASON";
    this.counts[result.ok ? "missed" : fault.expect.test(result.detail) ? "caught" : "harness"] += 1;
    console.log(`${verdict}  ${fault.statement}: planted: ${fault.name} -> ${result.detail} (${Math.round((Date.now() - started) / 1000)} s)`);
  }

  async runFaults(faults) {
    for (const fault of faults) {
      try {
        await this.runFault(fault);
      } catch (error) {
        if (!(error instanceof HarnessError)) throw error;
        this.counts.harness += 1;
        console.log(`HARNESS ERROR  ${fault.statement}: planted: ${fault.name} -> ${error.message}`);
      }
    }
  }
}

/** Run a check file's statements, and with --faults its planted faults. Sets the exit code; see the top of this file. */
export async function runBehavior({ title, firstPort, statements, faults = [] }) {
  const args = process.argv.slice(2);
  const only = args.includes("--only") ? args[args.indexOf("--only") + 1].split(",") : null;
  const known = new Set(statements.map((s) => s.id));
  for (const id of only || []) if (!known.has(id)) throw new HarnessError(`--only names no statement: ${id}`);
  const runner = new Runner({ title, firstPort, statements });
  // Puppeteer's own SIGTERM handler keeps the process alive while it closes the browser, which can hang on a swamped
  // machine. A runner that sends SIGTERM at its time limit would then wait for ever, and a later run would find the ports taken.
  process.once("SIGTERM", () => {
    if (runner.shared && runner.shared.lab) runner.shared.lab.stop();
    if (runner.browser && runner.browser.process()) runner.browser.process().kill("SIGKILL");
    process.exit(143);
  });
  mkdirSync(runner.out, { recursive: true });
  let code = 0;
  try {
    if (!args.includes("--faults-only")) await runner.runStatements(statements.filter((s) => !only || only.includes(s.id)));
    if (args.includes("--faults") || args.includes("--faults-only")) await runner.runFaults(faults.filter((f) => !only || only.includes(f.statement)));
    const { passed, failed, caught, missed, harness } = runner.counts;
    console.log(`${title}: ${passed} statements pass, ${failed} fail; ${caught} faults caught, ${missed} missed; ${harness} harness errors`);
    code = harness ? 2 : failed || missed ? 1 : 0;
  } catch (error) {
    console.error(`HARNESS ERROR: ${error instanceof HarnessError ? error.message : (error && error.stack) || error}`);
    code = 2;
  } finally {
    await runner.closeShared().catch(() => {});
    await closeBrowser(runner.browser);
  }
  process.exit(code);
}
