// Checks of the extension host core, run in Node: integrity, import and capability refusals, memory and CPU budgets,
// the lifecycle of one instance across attachments, three runs of RP1-built modules against RP1's own engine output,
// the ue:host@0.3.0 WIT file and the ue-core/0 binding, with network, storage and the panel call's rate. The case bodies are in
// fixtures/extension-host/cases.mjs, shared with the browser check (src/extension-host-browser-check.mjs).
// browser-safe-imports and package-tree run here alone.
//
// The network cases fetch from an in-process test server (fixtures/extension-host/net-server.mjs) on a free port of
// 127.0.0.1. Node's fetch keeps no cookies, so the host is given a fetch that adds the cookie a browser would hold for
// the test server's host whenever a request asks for credentials; a host that sends none never adds it.
import { loadExtension } from "../runtime/extension-host/extension-host.mjs";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { nodeChecks } from "../tools/behavior/node-checks.mjs";
import { CASES, loadFixtures } from "./fixtures/extension-host/cases.mjs";
import { startNetServer } from "./fixtures/extension-host/net-server.mjs";

const { check, finish } = nodeChecks("extension-host");
const CODE = new URL("../", import.meta.url);
const CODE_DIR = fileURLToPath(CODE).replace(/[\\/]$/, "");
const fixtures = await loadFixtures((path) => readFile(new URL(path, CODE)));

const server = await startNetServer();
const net = {
  origin: server.origin,
  url: (path) => `${server.origin}${path}`,
  seen: async () => server.records.map((record) => ({ ...record })),
  reset: async () => server.reset(),
  fetch(url, init = {}) {
    const headers = new Headers(init.headers);
    if (init.credentials === "include") headers.set("cookie", "ue_session=lab");
    return globalThis.fetch(url, { ...init, headers });
  },
};
for (const item of CASES.filter((entry) => entry.only !== "web")) {
  await check(item.id, item.says, () => item.run({ loadExtension, fixtures, net }));
}
await server.close();

// ---- browser-safe-imports: what a page loads of the host has no node: import ----

/** The specifiers of a module's static imports and re-exports (not dynamic import()). */
function staticImports(text) {
  const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const found = [];
  const pattern = /(?:^|[;\s])(?:import|export)\s*(?:[^'"();]*?\sfrom\s*)?["']([^"']+)["']/g;
  for (let match = pattern.exec(code); match; match = pattern.exec(code)) found.push(match[1]);
  return found;
}

await check("browser-safe-imports", "No file reachable from extension-host.mjs (or the web adapter and bindings a page imports) through static imports has a node: import", async () => {
  const HOST_DIR = new URL("runtime/extension-host/", CODE);
  const roots = ["extension-host.mjs", "sandbox-web.mjs", "bindings/rp1-sneeze-call.mjs", "bindings/ue-core.mjs"].map((name) => new URL(name, HOST_DIR));
  const seen = new Set();
  const queue = roots.map((url) => ({ url, from: null }));
  const named = (url) => url.href.slice(CODE.href.length);
  while (queue.length) {
    const { url } = queue.shift();
    if (seen.has(url.href) || !url.pathname.endsWith(".mjs")) continue;
    seen.add(url.href);
    for (const specifier of staticImports(await readFile(url, "utf8"))) {
      if (specifier.startsWith("node:")) throw new Error(`${named(url)} imports ${specifier}`);
      if (specifier.startsWith("./") || specifier.startsWith("../")) queue.push({ url: new URL(specifier, url) });
    }
  }
  if (!seen.has(new URL("sandbox-guest.mjs", HOST_DIR).href)) throw new Error("the scan did not reach sandbox-guest.mjs");
});

// ---- package-tree: the site package carries the host's browser files and none of its Node or test files ----

/** Every file under `root`, as a path relative to it with "/" separators. */
function filesUnder(root, at = root, found = []) {
  for (const entry of readdirSync(at, { withFileTypes: true })) {
    const full = join(at, entry.name);
    if (entry.isDirectory()) filesUnder(root, full, found);
    else found.push(relative(root, full).split(sep).join("/"));
  }
  return found;
}

await check("package-tree", "A site tree built by build-app-tree.mjs has the extension-host browser files under vendor/extension-host/, and has neither sandbox-node.mjs nor anything of src/fixtures/", async () => {
  // In a copy of the code with planted faults node_modules is a link to the real one; the builder lives beside the
  // real code folder, in deploy/.
  const realCode = dirname(realpathSync(join(CODE_DIR, "node_modules")));
  const builder = join(realCode, "..", "deploy", "cloudflare", "candidates", "2026-11-01-lab-app-pages", "build-app-tree.mjs");
  const tmp = mkdtempSync(join(tmpdir(), "ue-site-tree-"));
  try {
    // A code folder for the builder: web/ without its 81 MB of assets, this code's runtime/extension-host/, src/serve.js
    // and src/fixtures/extension-host/, and links to the vendor sources.
    const code = join(tmp, "code");
    cpSync(join(CODE_DIR, "web"), join(code, "web"), { recursive: true, filter: (source) => source !== join(CODE_DIR, "web", "assets") });
    cpSync(join(CODE_DIR, "runtime", "extension-host"), join(code, "runtime", "extension-host"), { recursive: true });
    mkdirSync(join(code, "runtime", "scene-core"), { recursive: true });
    symlinkSync(join(CODE_DIR, "runtime", "scene-core", "public"), join(code, "runtime", "scene-core", "public"));
    symlinkSync(join(CODE_DIR, "node_modules"), join(code, "node_modules"));
    cpSync(join(CODE_DIR, "src", "fixtures", "extension-host"), join(code, "src", "fixtures", "extension-host"), { recursive: true });
    writeFileSync(join(code, "src", "serve.js"), readFileSync(join(CODE_DIR, "src", "serve.js")));
    const out = join(tmp, "out");
    const run = spawnSync(process.execPath, [builder, "--out", out, "--server-origin", "https://worlds.example.org", "--code", code], { encoding: "utf8", timeout: 120000 });
    if (run.status !== 0) throw new Error(`build-app-tree.mjs exited ${run.status}: ${`${run.stderr || ""}${run.stdout || ""}`.trim().slice(-400)}`);
    const tree = filesUnder(out);
    const BROWSER_FILES = ["extension-host.mjs", "capabilities.mjs", "sandbox-web.mjs", "sandbox-guest.mjs", "bindings/ue-core.mjs", "bindings/rp1-sneeze-call.mjs", "wit/method-numbers.json"];
    for (const name of BROWSER_FILES) {
      const path = `vendor/extension-host/${name}`;
      if (!tree.includes(path)) throw new Error(`the built tree has no ${path}`);
      const same = readFileSync(join(out, path)).equals(readFileSync(join(CODE_DIR, "runtime", "extension-host", name)));
      if (!same) throw new Error(`${path} is not a copy of runtime/extension-host/${name}`);
    }
    const nodeOnly = tree.filter((path) => path.endsWith("sandbox-node.mjs"));
    if (nodeOnly.length) throw new Error(`the built tree has ${nodeOnly.join(", ")}`);
    const fixtureNames = new Set(filesUnder(join(CODE_DIR, "src", "fixtures")).map((path) => path.split("/").pop()));
    const fromFixtures = tree.filter((path) => path.includes("fixtures/") || fixtureNames.has(path.split("/").pop()));
    if (fromFixtures.length) throw new Error(`the built tree has files of src/fixtures/: ${fromFixtures.slice(0, 5).join(", ")}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

const HOST = "runtime/extension-host/extension-host.mjs";
const BINDING = "runtime/extension-host/bindings/rp1-sneeze-call.mjs";
const TABLE = "runtime/extension-host/wit/method-numbers.json";
const UE_BINDING = "runtime/extension-host/bindings/ue-core.mjs";
await finish({ checkFile: "src/extension-host-check.mjs", faults: [
  { statement: "integrity", name: "skip the hash check", expect: /a wrong integrity loads/,
    edits: [{ file: HOST, find: "if (digest !== declaration.module.integrity)", replace: "if (false)" }] },
  { statement: "import-refused", name: "allow every import", expect: /refused before instantiation/,
    edits: [{ file: HOST, find: "const unknown = wanted.filter((item) => !defines(binding, item));", replace: "const unknown = [];" }] },
  { statement: "capability-refused", name: "allows returns true", expect: /a node was made without ue\.scene\.nodes/,
    edits: [{ file: "runtime/extension-host/capabilities.mjs", find: "return tokens.has(token);", replace: "return true;" }] },
  { statement: "memory-initial", name: "skip the memory-section read", expect: /refused before instantiation|names the memory budget/,
    edits: [{ file: HOST, find: "const memory = readMemorySection(code);", replace: "const memory = { entries: [] };" }] },
  { statement: "memory-growth", name: "do not write the cap", expect: /never returned -1/,
    edits: [{ file: HOST, find: "const capped = capMemory(code, budgetPages);", replace: "const capped = code;" }] },
  { statement: "cpu-watchdog", name: "disable the watchdog timer", expect: /did not end the run/,
    edits: [{ file: "runtime/extension-host/sandbox-node.mjs", find: "const watchdog = setTimeout(() => expire(), budgetMs);", replace: "const watchdog = null;" }] },
  { statement: "initialize-first", name: "do not call _initialize", expect: /Init trapped/,
    edits: [{ file: "runtime/extension-host/sandbox-guest.mjs", find: "if (typeof exports._initialize === \"function\")", replace: "if (false)" }] },
  { statement: "lifecycle", name: "skip the per-attachment release", expect: /first attachment's nodes are not gone/,
    edits: [{ file: HOST, find: "releaseAttachment(index);", replace: "/* no release */" }] },
  { statement: "rp1-quickstart", name: "drop the NODE_ROOT dispatch", expect: /quickstart nodes/,
    edits: [{ file: BINDING, find: "[key(7, 4)]: nodeRoot,", replace: "" }] },
  { statement: "rp1-map", name: "read data.scene instead of Data.Scene", expect: /map nodes/,
    edits: [{ file: BINDING, find: "readPath(fabric, [\"Data\", ...splitPath(path)])", replace: "readPath(fabric, [\"data\", ...splitPath(path).map((part) => part.toLowerCase())])" }] },
  { statement: "rp1-key-case", name: "case-insensitive key lookup", expect: /keys matched without their case/,
    edits: [{ file: BINDING, find: "(name) => name === segment", replace: "(name) => name.toLowerCase() === segment.toLowerCase()" }] },
  { statement: "wit-table-agree", name: "drop one table entry", expect: /clock\.wall-ms has 0 table entries/,
    edits: [{ file: TABLE, find: "    { \"wit\": \"clock.wall-ms\", \"subsystem\": 4, \"method\": 1, \"token\": \"ue.clock.read\", \"returns\": \"scalar\" },\n", replace: "" }] },
  { statement: "method-numbers-frozen", name: "change one method number", expect: /frozen entry timer\.clear changed/,
    edits: [{ file: TABLE, find: "{ \"wit\": \"timer.clear\", \"subsystem\": 5, \"method\": 2,", replace: "{ \"wit\": \"timer.clear\", \"subsystem\": 5, \"method\": 3," }] },
  { statement: "binding-select", name: "map ue-core/0 to the RP1 binding", expect: /ue-core\/0 did not load/,
    edits: [{ file: HOST, find: "\"ue-core/0\": new URL(\"./bindings/ue-core.mjs\", import.meta.url).href,", replace: "\"ue-core/0\": new URL(\"./bindings/rp1-sneeze-call.mjs\", import.meta.url).href," }] },
  { statement: "ue-core-node", name: "drop the scene.node-create dispatch", expect: /node maker nodes/,
    edits: [{ file: UE_BINDING, find: "\"scene.node-create\": nodeCreate,", replace: "" }] },
  { statement: "ue-core-unknown-method", name: "return 0 for an unknown method", expect: /the unknown method's result/,
    edits: [{ file: UE_BINDING, find: "if (!entry) return UE_ERRORS.UNKNOWN_METHOD;", replace: "if (!entry) return 0n;" }] },
  { statement: "ue-core-refused", name: "allows returns true", expect: /a node was made without ue\.scene\.nodes/,
    edits: [{ file: "runtime/extension-host/capabilities.mjs", find: "return tokens.has(token);", replace: "return true;" }] },
  { statement: "ue-core-bad-payload", name: "treat a bad payload as empty", expect: /the bad payload's result/,
    edits: [{ file: UE_BINDING, find: "catch { return null; }", replace: "catch { return {}; }" }] },
  { statement: "ue-core-data-get", name: "swap pointer and length in the packing", expect: /data reader failed|logged title/,
    edits: [{ file: UE_BINDING, find: "(BigInt(ptr) << 32n) | BigInt(len)", replace: "(BigInt(len) << 32n) | BigInt(ptr)" }] },
  { statement: "ue-core-timer-directed", name: "send the event to every attachment", expect: /set no timer got a timer event/,
    edits: [{ file: HOST, find: "const targets = [timer.attachment];", replace: "const targets = [...attachments];" }] },
  { statement: "ue-core-timer-cap", name: "remove the cap", expect: /the timer cap/,
    edits: [{ file: UE_BINDING, find: "if (owned >= MAX_TIMERS) return UE_ERRORS.BUDGET;", replace: "" }] },
  { statement: "ue-core-timer-release", name: "skip the release", expect: /reached attachment 1 after its Close/,
    edits: [{ file: HOST, find: "clearTimers(index);", replace: "/* no timer release */" }] },
  { statement: "ue-core-sandbox", name: "skip the memory-section read for the ue-core/0 path only", expect: /ue-core memory module was refused at stage/,
    edits: [{ file: HOST, find: "const memory = readMemorySection(code);", replace: "const memory = declaration.module.binding === \"ue-core/0\" ? { entries: [] } : readMemorySection(code);" }] },
  { statement: "wit-additive", name: "renumber one 0.1.0 method", expect: /the 0\.1\.0 entry data\.get changed/,
    edits: [{ file: TABLE, find: "{ \"wit\": \"data.get\", \"subsystem\": 2, \"method\": 2,", replace: "{ \"wit\": \"data.get\", \"subsystem\": 2, \"method\": 3," }] },
  { statement: "net-needs-grant", name: "skip the token check", expect: /without its origin token/,
    edits: [{ file: UE_BINDING, find: "if (!host.allows(token)) return host.refuse(token, entry.wit, UE_ERRORS.REFUSED);", replace: "" }] },
  { statement: "net-origin-exact", name: "compare by host only", expect: /was allowed by a grant for https:\/\/a\.example/,
    edits: [{ file: "runtime/extension-host/capabilities.mjs", find: "return tokens.has(token);", replace: "return tokens.has(token) || (token.startsWith(\"ue.network.fetch:\") && [...tokens].some((item) => item.startsWith(\"ue.network.fetch:\") && new URL(item.slice(17)).hostname === new URL(token.slice(17)).hostname));" }] },
  { statement: "net-fetch-ok", name: "send the result to every attachment", expect: /reached another attachment/,
    edits: [{ file: UE_BINDING, find: "const targets = [request.attachment];", replace: "const targets = attachments();" }] },
  { statement: "net-no-credentials", name: "use credentials: \"include\"", expect: /saw a cookie/,
    edits: [{ file: UE_BINDING, find: "credentials: \"omit\",", replace: "credentials: \"include\"," }] },
  { statement: "net-redirect-refused", name: "follow redirects", expect: /redirect target was requested/,
    edits: [{ file: UE_BINDING, find: "redirect: \"manual\",", replace: "redirect: \"follow\"," }] },
  { statement: "net-caps", name: "remove the size cap", expect: /1 MiB \+ 1 byte response has error/,
    edits: [{ file: UE_BINDING, find: "if (received > MAX_RESPONSE_BYTES) throw new FetchFailed(UE_ERRORS.BUDGET);", replace: "" }] },
  { statement: "net-close-aborts", name: "skip the abort", expect: /not aborted at Close/,
    edits: [{ file: UE_BINDING, find: "if (request.attachment === index) request.controller.abort();", replace: "" }] },
  { statement: "grant-live", name: "apply a grant change only on reload", expect: /without a reload/,
    edits: [{ file: HOST, find: "  function setGrant(index, next) {\n", replace: "  function setGrant(index, next) {\n    return { ok: true, error: null, grant: [] };\n" }] },
  { statement: "storage-partition", name: "key storage by module.integrity only", expect: /second placement saw the first placement's key/,
    edits: [{ file: UE_BINDING, find: "return STORAGE_PREFIX + placementKey({ world: placement.world, node: placement.node, integrity: declaration.module.integrity, attach: declaration.attach });", replace: "return STORAGE_PREFIX + declaration.module.integrity;" }] },
  { statement: "storage-quota", name: "remove the quota", expect: /a write past 256 KiB/,
    edits: [{ file: UE_BINDING, find: "if (size > STORAGE_QUOTA_BYTES) return UE_ERRORS.BUDGET;", replace: "" }] },
  { statement: "event-soft-overrun", name: "end the worker at the soft limit", expect: /ended at the soft limit/,
    edits: [{ file: HOST, find: "const hardMs = kind === \"init\" ? limits.initMs : limits.eventHardMs;", replace: "const hardMs = kind === \"init\" ? limits.initMs : limits.eventMs;" }] },
  { statement: "event-hard-limit", name: "arm the event watchdog at one minute", expect: /not ended within 3 s/,
    edits: [{ file: HOST, find: "const hardMs = kind === \"init\" ? limits.initMs : limits.eventHardMs;", replace: "const hardMs = kind === \"init\" ? limits.initMs : 60000;" }] },
  { statement: "event-overruns-in-a-row", name: "never end on a row of overruns", expect: /did not end the worker/,
    edits: [{ file: HOST, find: "if (extension.overrunsInRow >= OVERRUNS_IN_A_ROW) {", replace: "if (false) {" }] },
  { statement: "second-budget-holds", name: "no hold", expect: /no event of the busy extension was held/,
    edits: [{ file: HOST, find: "if (usedMs() >= limits.secondMs) return hold(item);", replace: "if (false) return hold(item);" }] },
  { statement: "package-tree", name: "leave out runtime/extension-host/ from the build", expect: /has no vendor\/extension-host\/extension-host\.mjs/,
    edits: [{ file: "runtime/extension-host/site-files.mjs", find: "return !NODE_ONLY_FILES.includes(path);", replace: "return false;" }] },
  { statement: "panel-rate", name: "no rate limit on ui.panel-set", expect: /five panel-set calls in one second/,
    edits: [{ file: UE_BINDING, find: "if (times.length >= PANEL_SETS_PER_SECOND) return host.refuse(entry.token, entry.wit, UE_ERRORS.BUDGET);", replace: "" }] },
  { statement: "browser-safe-imports", name: "import node:fs in the host", expect: /extension-host\.mjs imports node:fs/,
    edits: [{ file: HOST, find: "import { grantTokens } from \"./capabilities.mjs\";", replace: "import \"node:fs\";\nimport { grantTokens } from \"./capabilities.mjs\";" }] },
] });
