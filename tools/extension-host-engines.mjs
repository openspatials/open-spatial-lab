// The extension host's browser cases in other engines: src/fixtures/extension-host/browser-check.html (every case of
// cases.mjs that is not Node-only, each extension in its own module Web Worker) run once in WebKit and once in
// Firefox through Playwright, one browser at a time, and reported pass or fail per case per engine. It plants no
// faults and changes nothing: an engine difference is listed, not fixed. Chrome for Testing runs the same page in
// src/extension-host-browser-check.mjs.
//
// Usage:
//   OSL_PLAYWRIGHT_MODULE=<folder of a playwright package> [PLAYWRIGHT_BROWSERS_PATH=<its browser cache>] \
//     bash ../demo-servers/browser-run.sh node tools/extension-host-engines.mjs [webkit] [firefox] [--json=<file>]
//
// The page, the host and the Lab's panel modules (web/, for the panel cases) are served on 127.0.0.1:OSL_UE_ENGINES_PORT
// (default 18361) by the extension checks' static server (src/fixtures/extension-host/check-server.mjs), the network
// cases' test server on a free port. Each browser,
// headless, is closed (killed if it does not close) before the next starts, and the servers are closed at the end,
// including on failure. Exit 0 when every case passed in every engine, 1 when a case failed or reported nothing.
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { CASES } from "../src/fixtures/extension-host/cases.mjs";
import { sleep, startServers, stopServer } from "../src/fixtures/extension-host/check-server.mjs";
import { startNetServer } from "../src/fixtures/extension-host/net-server.mjs";

const PORT = Number(process.env.OSL_UE_ENGINES_PORT) || 18361;
const PAGE = "/src/fixtures/extension-host/browser-check.html";
const RESULT_MARK = "extension-host-case ";
const DONE_MARK = "extension-host-done";
const STALL_MS = 30000;
const TOTAL_MS = 300000;
const ENGINES = ["webkit", "firefox"];
const oneLine = (error) => String((error && error.message) || error).replace(/\s+/g, " ").trim();

const args = process.argv.slice(2);
const jsonOut = (args.find((arg) => arg.startsWith("--json=")) || "").slice("--json=".length);
const engines = args.filter((arg) => !arg.startsWith("--"));
for (const name of engines) if (!ENGINES.includes(name)) throw new Error(`unknown engine ${name}; one of ${ENGINES.join(", ")}`);
if (!process.env.OSL_PLAYWRIGHT_MODULE) throw new Error("OSL_PLAYWRIGHT_MODULE must name the folder of a playwright package");
const playwright = createRequire(import.meta.url)(resolve(process.env.OSL_PLAYWRIGHT_MODULE));
const cases = CASES.filter((item) => item.only !== "node");

/** Closes a browser server, and kills it when it does not close within 15 s. */
async function stopEngine(server) {
  if (!server) return;
  const closed = await Promise.race([server.close().then(() => true, () => false), sleep(15000).then(() => false)]);
  if (!closed) await server.kill().catch(() => {});
}

/** Runs the page once in `name`. Resolves { version, results: Map(id -> { id, ok, detail }), problem }; never rejects. */
async function runEngine(name, origin, netOrigin) {
  const results = new Map();
  const pageErrors = [];
  let server = null, browser = null, version = null, problem = null;
  try {
    server = await playwright[name].launchServer({ headless: true });
    browser = await playwright[name].connect(server.wsEndpoint());
    version = browser.version();
    const page = await browser.newPage();
    let done = false;
    let lastAt = Date.now();
    page.on("console", (message) => {
      const text = message.text();
      if (text.startsWith(RESULT_MARK)) {
        const result = JSON.parse(text.slice(RESULT_MARK.length));
        results.set(result.id, result);
        lastAt = Date.now();
      } else if (text === DONE_MARK) done = true;
    });
    page.on("pageerror", (error) => pageErrors.push(oneLine(error)));
    const response = await page.goto(`${origin}${PAGE}?net=${encodeURIComponent(netOrigin)}`, { waitUntil: "load", timeout: 30000 });
    if (!response || !response.ok()) throw new Error(`the page answered HTTP ${response && response.status()}`);
    const started = Date.now();
    while (!done && Date.now() - lastAt < STALL_MS && Date.now() - started < TOTAL_MS) await sleep(100);
    if (done) {
      const final = await Promise.race([page.evaluate(() => window.__extensionHostResults || null), sleep(5000).then(() => null)]);
      if (Array.isArray(final)) for (const result of final) results.set(result.id, result);
    } else {
      problem = `the page did not finish: no case result for ${Math.round((Date.now() - lastAt) / 1000)} s`;
    }
  } catch (error) {
    problem = oneLine(error);
  } finally {
    if (browser) await Promise.race([browser.close().catch(() => {}), sleep(10000)]);
    await stopEngine(server);
  }
  if (pageErrors.length) problem = `${problem ? `${problem}; ` : ""}page errors: ${pageErrors.slice(0, 3).join(" | ")}`;
  return { version, results, problem };
}

const report = { page: PAGE, cases: cases.map((item) => item.id), engines: {} };
let servers = [], netServer = null;
try {
  netServer = await startNetServer({ allowOrigin: `http://127.0.0.1:${PORT}` });
  servers = await startServers({ port: PORT, netOrigin: netServer.origin, routes: [["/src/", "src/"], ["/runtime/", "runtime/"], ["/web/", "web/"]] });
  for (const name of engines.length ? engines : ENGINES) {
    const run = await runEngine(name, `http://127.0.0.1:${PORT}`, netServer.origin);
    const rows = cases.map((item) => {
      const result = run.results.get(item.id);
      return result ? { id: item.id, ok: result.ok, detail: result.detail } : { id: item.id, ok: false, detail: `no result${run.problem ? ` (${run.problem})` : ""}` };
    });
    report.engines[name] = { version: run.version, problem: run.problem, rows };
    console.log(`\n${name} ${run.version || "(did not start)"}${run.problem ? `: ${run.problem}` : ""}`);
    for (const row of rows) console.log(`  ${row.ok ? "PASS" : "FAIL"}  ${row.id}${row.ok ? "" : `: ${row.detail}`}`);
    console.log(`  ${name}: ${rows.filter((row) => row.ok).length} of ${rows.length} cases pass`);
  }
} finally {
  for (const server of servers) await stopServer(server);
  if (netServer) await netServer.close();
}
if (jsonOut) writeFileSync(jsonOut, `${JSON.stringify(report, null, 2)}\n`);
const failed = Object.values(report.engines).flatMap((engine) => engine.rows.filter((row) => !row.ok));
console.log(`\nextension-host-engines: ${Object.entries(report.engines).map(([name, engine]) => `${name} ${engine.rows.filter((row) => row.ok).length}/${engine.rows.length}`).join(", ")}`);
process.exitCode = failed.length ? 1 : 0;
