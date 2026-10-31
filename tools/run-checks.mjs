// Runs the lab's checks, one after another, and fails if any step fails.
// Usage: node tools/run-checks.mjs <group> [--faults] [--only=<part of a file name>]   (or: --self-check)
//
//   test        everything that can run by itself: the three groups below, the proofs, and every file named
//               tools/behavior/*.check.mjs (a file named *.node.check.mjs needs no browser)
//   test-fast   the steps of "test" that need neither a browser nor a running lab
//   identity    the Universal Manifest, RP1 and trust modules' attack-vector tests, and the signing test vectors
//   client      checks of the browser client's controllers and scene code, run in Node
//   browser     checks that drive Chrome for Testing (found by tools/find-browser.mjs)
//   all         identity, client and browser
//
// Every step runs with a time limit, and the run goes on after a failure. A step's output goes to
// diagnostics/test/. One line per step: PASS, FAIL, KNOWN-RED (red today, with its reason and the phase that takes
// it), or SKIP (with its reason; a skip is not a pass). A KNOWN-RED step that passes is a FAIL: take it off the list.
// Exit code 1 when any step fails.
//
// Ports: every step takes its ports from OSL_TEST_PORT_BASE (default 36400) and the 99 numbers after it.
// --faults also runs the planted faults of the files in tools/behavior/.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { KNOWN_RED, STEPS } from "./run-checks-lists.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "diagnostics", "test");
const DEFAULT_BASE = 36400;
const DEFAULT_TIMEOUT_S = 300;
const LAB_DEFAULT_PORTS = [8143, 18151, 18152, 18153, 18154];
const PORT_ENV = /^(OSL_.*PORT.*|PROOF_PORT|WORLD_SERVER_ACCEPTANCE_.*|feature_.*)$/;

function portBase(env = process.env) {
  const base = Number(env.OSL_TEST_PORT_BASE) || DEFAULT_BASE;
  if (!Number.isInteger(base) || base < 1024 || base + 99 > 65535) throw new Error(`OSL_TEST_PORT_BASE ${base} leaves no room for 100 ports`);
  const clash = LAB_DEFAULT_PORTS.find((port) => port >= base && port <= base + 99);
  if (clash) throw new Error(`OSL_TEST_PORT_BASE ${base} covers the lab's own port ${clash}`);
  return base;
}

async function findChrome() {
  try {
    const { findBrowser } = await import(pathToFileURL(join(ROOT, "tools", "find-browser.mjs")).href);
    return { path: findBrowser() };
  } catch (error) {
    return { path: null, why: String(error.message || error).split("\n")[0] };
  }
}

function behaviorSteps() {
  const dir = join(ROOT, "tools", "behavior");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith(".check.mjs")).sort().map((name) => ({
    file: `tools/behavior/${name}`,
    groups: ["behavior"],
    browser: !name.endsWith(".node.check.mjs"),
    timeoutS: 900,
    faultsTimeoutS: 3600,
    ports: (p) => ({ OSL_TEST_PORT_BASE: p(0) }),
    faultsFlag: true,
  }));
}

function stepsOf(group) {
  const all = [...STEPS, ...behaviorSteps()];
  if (group === "test") return all;
  if (group === "test-fast") return all.filter((step) => !step.browser && !step.lab);
  if (group === "all") return all.filter((step) => (step.groups || []).some((g) => ["identity", "client", "browser"].includes(g)));
  return all.filter((step) => (step.groups || []).includes(group));
}

function envFor(step, ctx) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !PORT_ENV.test(name)));
  const p = (n) => String(ctx.base + n);
  Object.assign(env, { OSL_RUN_DIR: join(ctx.out, "run") }, step.ports ? step.ports(p) : {}, { OSL_TEST_PORT_BASE: p(0) }, step.env || {});
  if (step.browser && ctx.chrome.path) {
    Object.assign(env, {
      PUPPETEER_EXECUTABLE_PATH: ctx.chrome.path,
      feature_BROWSER_EXECUTABLE: ctx.chrome.path,
      feature_PROFILE_PATH: join(ctx.out, "browser-profile"),
      OSL_E2E_HEADED: "0",
    });
  }
  return env;
}

function labWorlds(ctx) {
  const worlds = JSON.parse(readFileSync(join(ROOT, "worlds.json"), "utf8"));
  worlds.frontend.port = ctx.base;
  worlds.worlds.forEach((world, i) => {
    world.port = ctx.base + 1 + i;
    world.address = `http://127.0.0.1:${world.port}/`;
  });
  const file = join(ctx.out, "lab-worlds.json");
  writeFileSync(file, `${JSON.stringify(worlds, null, 2)}\n`);
  return { OSL_WORLDS: file, OSL_RUN_DIR: join(ctx.out, "lab-run") };
}

function labScript(name, env, arg) {
  return spawnSync("bash", [join(ROOT, name), ...(arg ? [arg] : [])], { cwd: ROOT, env, encoding: "utf8", timeout: 120000 });
}

function slug(step) {
  return [step.file, ...(step.args || [])].join("-").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function limitOf(step, ctx) {
  return (ctx.faults && step.faultsTimeoutS) || step.timeoutS || DEFAULT_TIMEOUT_S;
}

function spawnStep(step, ctx, env) {
  const argv = step.argv || [process.execPath, step.file, ...(step.args || []), ...(step.faultsFlag && ctx.faults ? ["--faults"] : [])];
  const logFile = join(ctx.out, `${slug(step)}.log`);
  const fd = openSync(logFile, "w");
  try {
    const result = spawnSync(argv[0], argv.slice(1), { cwd: ROOT, env, stdio: ["ignore", fd, fd], timeout: limitOf(step, ctx) * 1000 });
    return { code: result.status, timedOut: result.error?.code === "ETIMEDOUT", logFile };
  } finally {
    closeSync(fd);
  }
}

function runWithLab(step, ctx, env) {
  const labEnv = { ...env, ...labWorlds(ctx) };
  const up = labScript("launchOpenSpatialLab.sh", labEnv);
  if (up.status !== 0) return { code: 1, timedOut: false, logFile: null, why: `the lab did not start: ${String(up.stderr || up.stdout).trim().split("\n").pop()}` };
  try {
    return spawnStep(step, ctx, labEnv);
  } finally {
    labScript("stopOpenSpatialLab.sh", labEnv, "--quiet");
  }
}

function attempt(step, ctx) {
  const env = envFor(step, ctx);
  return step.lab ? runWithLab(step, ctx, env) : spawnStep(step, ctx, env);
}

/** One step: skip, run (once more after a timeout), then judge it against the known-red list. */
function runOne(step, ctx) {
  if (step.browser && !ctx.chrome.path) return { status: "SKIP", reason: `no Chrome for Testing found (${ctx.chrome.why})` };
  const started = Date.now();
  let result = attempt(step, ctx);
  if (result.timedOut) result = { ...attempt(step, ctx), rerun: true };
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const red = ctx.knownRed[step.file];
  const passed = result.code === 0 && !result.timedOut;
  const why = result.why || (result.timedOut ? `timed out after ${limitOf(step, ctx)} s, run twice` : `exit ${result.code}`);
  if (passed && red) return { status: "FAIL", seconds, reason: `known-red step passes: remove it from the list in tools/run-checks-lists.mjs` };
  if (passed) return { status: "PASS", seconds };
  if (red) return { status: "KNOWN-RED", seconds, reason: `${red.reason} (${red.phase})` };
  return { status: "FAIL", seconds, reason: why, logFile: result.logFile };
}

function tail(logFile, lines = 8) {
  try { return readFileSync(logFile, "utf8").trimEnd().split("\n").slice(-lines).map((line) => `    ${line}`).join("\n"); } catch { return ""; }
}

/** Runs the steps in order and returns the counts and the exit code the run earns. */
export function runSteps(steps, ctx) {
  mkdirSync(ctx.out, { recursive: true });
  const counts = { PASS: 0, FAIL: 0, "KNOWN-RED": 0, SKIP: 0 };
  const results = [];
  for (const step of steps) {
    const result = runOne(step, ctx);
    counts[result.status] += 1;
    results.push({ step, ...result });
    const label = step.file || step.argv.join(" ");
    const timing = result.seconds ? `  (${result.seconds} s)` : "";
    ctx.log(`${result.status.padEnd(9)}  ${label}${result.reason ? `  ${result.reason}` : ""}${timing}`);
    if (result.status === "FAIL" && result.logFile) ctx.log(tail(result.logFile));
  }
  ctx.log(`\n${counts.PASS} PASS, ${counts.FAIL} FAIL, ${counts["KNOWN-RED"]} KNOWN-RED, ${counts.SKIP} SKIP, of ${steps.length} steps`);
  return { counts, results, exitCode: counts.FAIL ? 1 : 0 };
}

/** The runner's planted fault: a fake list with one of each case, and the exit code each case must earn. */
function selfCheck() {
  const fake = (name, code, more = {}) => ({ file: name, argv: [process.execPath, "-e", code], ...more });
  const red = (name) => ({ [name]: { reason: "fake", phase: "phase 0" } });
  const cases = [
    { name: "a passing step", step: fake("fake-pass", "process.exit(0)"), status: "PASS", exit: 0 },
    { name: "a failing step", step: fake("fake-fail", "process.exit(3)"), status: "FAIL", exit: 1 },
    { name: "a known-red step that fails", step: fake("fake-red-fails", "process.exit(1)"), knownRed: red("fake-red-fails"), status: "KNOWN-RED", exit: 0 },
    { name: "a known-red step that passes", step: fake("fake-red-passes", "process.exit(0)"), knownRed: red("fake-red-passes"), status: "FAIL", exit: 1, says: "remove it from the list" },
    { name: "a skipped step", step: fake("fake-skip", "process.exit(0)", { browser: true }), status: "SKIP", exit: 0, noPass: true },
    { name: "a step that times out", step: fake("fake-timeout", "setTimeout(() => {}, 20000)", { timeoutS: 0.5 }), status: "FAIL", exit: 1, says: "timed out" },
  ];
  let wrong = 0;
  for (const c of cases) {
    const ctx = { base: DEFAULT_BASE, out: join(OUT_DIR, "self-check"), chrome: { path: null, why: "self-check" }, knownRed: c.knownRed || {}, log: () => {} };
    const run = runSteps([c.step], ctx);
    const got = run.results[0];
    const ok = got.status === c.status && run.exitCode === c.exit && (!c.noPass || run.counts.PASS === 0) && (!c.says || String(got.reason).includes(c.says));
    if (!ok) wrong += 1;
    console.log(`${ok ? "ok   " : "WRONG"}  ${c.name}: ${got.status}, exit ${run.exitCode} (wanted ${c.status}, ${c.exit})`);
  }
  console.log(wrong ? `\nself-check FAIL: ${wrong} case(s) wrong` : "\nself-check PASS: every case earned its exit code");
  process.exit(wrong ? 1 : 0);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--self-check")) selfCheck();
  const group = args.find((arg) => !arg.startsWith("--"));
  const only = args.find((arg) => arg.startsWith("--only="))?.slice(7);
  const steps = (group ? stepsOf(group) : []).filter((step) => !only || String(step.file).includes(only));
  if (!steps.length) {
    console.error(`usage: node tools/run-checks.mjs <test|test-fast|identity|client|browser|all> [--faults] | --self-check`);
    process.exit(2);
  }
  const chrome = steps.some((step) => step.browser) ? await findChrome() : { path: null, why: "not needed" };
  const ctx = { base: portBase(), out: OUT_DIR, chrome, knownRed: KNOWN_RED, faults: args.includes("--faults"), log: (line) => console.log(line) };
  process.exit(runSteps(steps, ctx).exitCode);
}

main().catch((error) => { console.error(error.stack || error); process.exit(2); });
