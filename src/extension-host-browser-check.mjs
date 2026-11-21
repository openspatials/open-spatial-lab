// The extension host in a web page: every case of src/fixtures/extension-host/cases.mjs, run by browser-check.html
// with each extension in its own module Web Worker, plus web-sandbox-is-worker. Reported as one check per case, the
// ids prefixed "web-".
//
// It serves the code folder on OSL_EXTENSION_HOST_BROWSER_PORT (default 18341), opens the page in Chrome for Testing,
// headless, through puppeteer-core, and reads each case result as the page logs it. The network cases fetch from the
// check's own test server (fixtures/extension-host/net-server.mjs) on a second, free port of 127.0.0.1, with CORS
// headers for the page's origin; its address reaches the page as ?net=. The browser and both ports are always closed,
// including on failure.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { nodeChecks } from "../tools/behavior/node-checks.mjs";
import { findBrowser } from "../tools/find-browser.mjs";
import { CASES } from "./fixtures/extension-host/cases.mjs";
import { startNetServer } from "./fixtures/extension-host/net-server.mjs";

const { check, finish } = nodeChecks("extension-host-browser");
const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const PORT = Number(process.env.OSL_EXTENSION_HOST_BROWSER_PORT) || 18341;
const PAGE = "/src/fixtures/extension-host/browser-check.html";
const RESULT_MARK = "extension-host-case ";
const DONE_MARK = "extension-host-done";
const STALL_MS = 30000;
const TOTAL_MS = 300000;
const TYPES = {
  ".html": "text/html; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".wasm": "application/wasm", ".wit": "text/plain; charset=utf-8",
};

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const oneLine = (error) => String((error && error.message) || error).replace(/\s+/g, " ").trim();

/** A static file server for the code folder, on 127.0.0.1 only. */
function startServer() {
  const server = createServer(async (request, response) => {
    try {
      const path = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
      const file = resolve(ROOT, `.${path}`);
      if (request.method !== "GET" || (file !== ROOT && !file.startsWith(ROOT + sep))) throw Object.assign(new Error("refused"), { status: 403 });
      const body = await readFile(file);
      response.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream", "cache-control": "no-store" });
      response.end(body);
    } catch (error) {
      response.writeHead(error.status || 404, { "content-type": "text/plain" });
      response.end(String(error.status || 404));
    }
  });
  return new Promise((done, fail) => {
    server.once("error", fail);
    server.listen(PORT, "127.0.0.1", () => done(server));
  });
}

function stopServer(server) {
  if (!server) return Promise.resolve();
  return new Promise((done) => {
    server.close(() => done());
    server.closeAllConnections();
  });
}

async function stopBrowser(browser) {
  if (!browser) return;
  const child = browser.process();
  await Promise.race([browser.close().catch(() => {}), sleep(10000)]);
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await Promise.race([new Promise((done) => child.once("exit", done)), sleep(5000)]);
  }
}

/** Runs the page once. Resolves { results: Map(id -> { id, ok, detail }), problem }, never rejects. */
async function runPage() {
  const results = new Map();
  const pageErrors = [];
  let server = null, netServer = null, browser = null, problem = null;
  try {
    server = await startServer();
    netServer = await startNetServer({ allowOrigin: `http://127.0.0.1:${PORT}` });
    const { default: puppeteer } = await import("puppeteer-core");
    browser = await puppeteer.launch({ executablePath: findBrowser(), headless: true, args: ["--no-first-run", "--no-default-browser-check"] });
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
    const response = await page.goto(`http://127.0.0.1:${PORT}${PAGE}?net=${encodeURIComponent(netServer.origin)}`, { waitUntil: "load", timeout: 30000 });
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
    await stopBrowser(browser);
    await stopServer(server);
    if (netServer) await netServer.close();
  }
  if (pageErrors.length) problem = `${problem ? `${problem}; ` : ""}page errors: ${pageErrors.slice(0, 3).join(" | ")}`;
  return { results, problem };
}

const { results, problem } = await runPage();
for (const item of CASES.filter((entry) => entry.only !== "node")) {
  await check(`web-${item.id}`, item.says, () => {
    const result = results.get(item.id);
    if (!result) throw new Error(`the page reported no result${problem ? ` (${problem})` : ""}`);
    if (!result.ok) throw new Error(result.detail);
  });
}

const HOST = "runtime/extension-host/extension-host.mjs";
const WEB = "runtime/extension-host/sandbox-web.mjs";
const UE_BINDING = "runtime/extension-host/bindings/ue-core.mjs";
await finish({ checkFile: "src/extension-host-browser-check.mjs", faults: [
  { statement: "web-net-no-credentials", name: "use credentials: \"include\"", expect: /saw a cookie/,
    edits: [{ file: UE_BINDING, find: "credentials: \"omit\",", replace: "credentials: \"include\"," }] },
  { statement: "web-net-redirect-refused", name: "follow redirects", expect: /redirect target was requested/,
    edits: [{ file: UE_BINDING, find: "redirect: \"manual\",", replace: "redirect: \"follow\"," }] },
  { statement: "web-net-fetch-ok", name: "send the result to every attachment", expect: /reached another attachment/,
    edits: [{ file: UE_BINDING, find: "const targets = [request.attachment];", replace: "const targets = attachments();" }] },
  { statement: "web-grant-live", name: "apply a grant change only on reload", expect: /without a reload/,
    edits: [{ file: HOST, find: "  function setGrant(index, next) {\n", replace: "  function setGrant(index, next) {\n    return { ok: true, error: null, grant: [] };\n" }] },
  { statement: "web-cpu-watchdog", name: "disable the watchdog timer in the web adapter", expect: /did not end the run/,
    edits: [{ file: WEB, find: "const watchdog = setTimeout(() => expire(), budgetMs);", replace: "const watchdog = null;" }] },
  { statement: "web-memory-growth", name: "do not write the cap", expect: /never returned -1/,
    edits: [{ file: HOST, find: "const capped = capMemory(code, budgetPages);", replace: "const capped = code;" }] },
  { statement: "web-ue-core-timer-directed", name: "send the event to every attachment", expect: /set no timer got a timer event/,
    edits: [{ file: HOST, find: "const targets = [timer.attachment];", replace: "const targets = [...attachments];" }] },
  { statement: "web-integrity", name: "skip the hash check", expect: /a wrong integrity loads/,
    edits: [{ file: HOST, find: "if (digest !== declaration.module.integrity)", replace: "if (false)" }] },
  { statement: "web-event-soft-overrun", name: "end the worker at the soft limit", expect: /ended at the soft limit/,
    edits: [{ file: HOST, find: "const hardMs = kind === \"init\" ? limits.initMs : limits.eventHardMs;", replace: "const hardMs = kind === \"init\" ? limits.initMs : limits.eventMs;" }] },
  { statement: "web-second-budget-holds", name: "no hold", expect: /no event of the busy extension was held/,
    edits: [{ file: HOST, find: "if (usedMs() >= limits.secondMs) return hold(item);", replace: "if (false) return hold(item);" }] },
  { statement: "web-sandbox-is-worker", name: "run the guest on the main page instead of in a Worker", expect: /not a DedicatedWorkerGlobalScope/,
    edits: [{ file: WEB, find: "const worker = new Worker(new URL(import.meta.url), { type: \"module\" });", replace: [
      "const worker = (() => {",
      "  const page = new EventTarget(), guest = new EventTarget();",
      "  const send = (target, data) => setTimeout(() => target.dispatchEvent(new MessageEvent(\"message\", { data })), 0);",
      "  page.postMessage = (data) => send(guest, data);",
      "  page.terminate = () => {};",
      "  guest.addEventListener(\"message\", (event) => runGuest({ post: (data) => send(page, data), onMessage: (handler) => guest.addEventListener(\"message\", (next) => handler(next.data)) }, event.data), { once: true });",
      "  return page;",
      "})();",
    ].join("\n") }] },
] });
