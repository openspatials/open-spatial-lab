import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(process.argv[2] || join(SCRIPT_DIR, ".."));
const manifest = JSON.parse(readFileSync(join(ROOT, "RELEASE-MANIFEST.json"), "utf8"));

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function walk(current = ROOT) {
  const files = [];
  for (const name of readdirSync(current).sort()) {
    if ([".git", ".runtime", "node_modules", "RELEASE-MANIFEST.json"].includes(name)) continue;
    const absolute = join(current, name);
    const stat = lstatSync(absolute);
    const publicName = relative(ROOT, absolute).split(sep).join("/");
    if (stat.isSymbolicLink()) throw new Error(`symbolic links are not allowed: ${publicName}`);
    if (stat.isDirectory()) files.push(...walk(absolute));
    else if (stat.isFile()) files.push({ absolute, path: publicName });
    else throw new Error(`unsupported filesystem entry: ${publicName}`);
  }
  return files;
}

const forbiddenPathParts = [
  "." + "dev/", "." + "agents/", "work" + "orders/", "govern" + "ance/",
  "re" + "ports/", "au" + "dits/", "find" + "ings/", "ses" + "sions/",
];
const forbiddenText = [
  { label: "absolute user path", pattern: new RegExp("/" + "Users" + "/") },
  { label: "project-management path", pattern: new RegExp("\\." + "dev/" + "ai/") },
  { label: "project-management identifier", pattern: new RegExp("\\b" + String.fromCharCode(87, 79, 45) + "[A-Z0-9-]+", "i") },
  { label: "secret key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { label: "cloud access key", pattern: /AKIA[0-9A-Z]{16}/ },
  { label: "GitHub token", pattern: /gh[opusr]_[A-Za-z0-9_]{20,}/ },
  { label: "embedded demo credential", pattern: new RegExp("osl-" + "(?:dev|demo)-[a-z0-9-]*token", "i") },
  { label: "private workflow marker", pattern: new RegExp("MSF-" + "local|project-" + "notes|local demo-" + "DEMO", "i") },
];
const privateProjectToken = Buffer.from("6f70656e2d7370617469616c2d6c61622d646576", "hex").toString("utf8");
const privateWorkspaceTokens = [
  "7370617469616c2d636f6d707574696e672d72657365617263682d70726f6a656374732d6d7366",
  "78722d72756e74696d652d636f6d70617269736f6e",
].map((hex) => Buffer.from(hex, "hex").toString("utf8"));

function searchableText(path, bytes) {
  if (![".glb", ".vrm"].includes(extname(path).toLowerCase())) return bytes.toString("utf8");
  let offset = 12;
  const chunks = [];
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32LE(offset);
    const type = bytes.readUInt32LE(offset + 4);
    if (type === 0x4e4f534a) chunks.push(bytes.subarray(offset + 8, offset + 8 + length).toString("utf8"));
    offset += 8 + length;
  }
  return chunks.join("\n");
}

const actual = walk().sort((a, b) => a.path.localeCompare(b.path));
const expected = [...manifest.files].sort((a, b) => a.path.localeCompare(b.path));
if (actual.length !== expected.length) throw new Error(`file-count mismatch: expected ${expected.length}, found ${actual.length}`);

for (let index = 0; index < actual.length; index += 1) {
  const file = actual[index];
  const recorded = expected[index];
  if (file.path !== recorded.path) throw new Error(`unexpected file: ${file.path}; expected ${recorded.path}`);
  if (forbiddenPathParts.some((part) => file.path.toLowerCase().includes(part))) throw new Error(`unexpected project path: ${file.path}`);
  const bytes = readFileSync(file.absolute);
  if (bytes.length !== recorded.size || sha256(bytes) !== recorded.sha256) throw new Error(`hash or size mismatch: ${file.path}`);
  if ([".glb", ".vrm"].includes(extname(file.path).toLowerCase()) && bytes.subarray(0, 4).toString("ascii") !== "glTF") {
    throw new Error(`invalid binary glTF header: ${file.path}`);
  }
  const text = searchableText(file.path, bytes);
  if (text.toLowerCase().includes(privateProjectToken)) throw new Error(`unexpected repository reference: ${file.path}`);
  if (privateWorkspaceTokens.some((token) => text.toLowerCase().includes(token))) throw new Error(`unexpected private workspace reference: ${file.path}`);
  for (const rule of forbiddenText) if (rule.pattern.test(text)) throw new Error(`${rule.label}: ${file.path}`);
}

const treeInput = expected.map((file) => `${file.path}\0${file.mode}\0${file.size}\0${file.sha256}\n`).join("");
if (sha256(Buffer.from(treeInput, "utf8")) !== manifest.complete_tree_sha256) throw new Error("complete tree hash mismatch");

const packageJson = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
if (packageJson.name !== "open-spatial-lab" || packageJson.private !== true || packageJson.license !== "Apache-2.0") {
  throw new Error("package identity mismatch");
}
for (const command of ["start", "stop", "verify"]) if (!packageJson.scripts?.[command]) throw new Error(`missing npm script: ${command}`);

for (const world of ["location-a.json", "location-b.json"]) {
  const text = readFileSync(join(ROOT, "web", "worlds", world), "utf8");
  if (/https:\/\/raw\.githubusercontent\.com/i.test(text)) throw new Error(`${world} still depends on remote models`);
}

const browserImportMap = new Map();
const closureQueue = [];
const closureVisited = new Set();
const staticExtensions = new Set([
  ".css", ".glb", ".gltf", ".html", ".jpeg", ".jpg", ".js", ".json",
  ".mjs", ".png", ".svg", ".vrm", ".wasm", ".woff", ".woff2",
]);

function cleanSpecifier(value) {
  return String(value).replace(/[?#].*$/, "");
}

function runtimeRoute(specifier) {
  return specifier === "/fabric.json"
    || /^\/(?:api|wow)(?:\/|$)/.test(specifier)
    || specifier === "/healthz";
}

function browserRoute(absolute) {
  const path = relative(ROOT, absolute).split(sep).join("/");
  const routes = [
    ["web/vendor/scene-core/", "runtime/scene-core/public/"],
    ["web/vendor-three-examples/", "node_modules/three/examples/jsm/"],
    ["web/vendor-vrm/", "node_modules/@pixiv/three-vrm/lib/"],
  ];
  for (const [prefix, target] of routes) {
    if (path.startsWith(prefix)) return join(ROOT, target, path.slice(prefix.length));
  }
  return absolute;
}

function existingModule(absolute) {
  for (const candidate of [absolute, `${absolute}.js`, `${absolute}.mjs`, `${absolute}.json`, join(absolute, "index.js")]) {
    if (existsSync(candidate) && lstatSync(candidate).isFile()) return candidate;
  }
  return absolute;
}

function mappedBrowserImport(specifier) {
  if (browserImportMap.has(specifier)) return browserImportMap.get(specifier);
  const prefix = [...browserImportMap.keys()]
    .filter((key) => key.endsWith("/") && specifier.startsWith(key))
    .sort((left, right) => right.length - left.length)[0];
  return prefix ? `${browserImportMap.get(prefix)}${specifier.slice(prefix.length)}` : null;
}

function localResource(specifier) {
  const value = cleanSpecifier(specifier);
  return !/^(?:data|blob|https?|wss?):/i.test(value)
    && !value.startsWith("#")
    && (value.startsWith(".") || !/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+\//.test(value))
    && /^(?:\.{0,2}\/|[A-Za-z0-9_.-]+\/)/.test(value)
    && staticExtensions.has(extname(value).toLowerCase());
}

function resolveReference(specifier, referrer, context, kind) {
  const value = cleanSpecifier(specifier);
  if (!value || /^(?:data|blob|https?|wss?):/i.test(value) || value.startsWith("#")) return null;
  if (context === "node") {
    if (!value.startsWith(".") && !value.startsWith("/")) return null;
    return existingModule(resolve(dirname(referrer), value));
  }
  if (runtimeRoute(value)) return null;
  if (value.startsWith("/")) {
    if (value.startsWith("/vendor/scene-core/")) return existingModule(join(ROOT, "runtime/scene-core/public", value.slice(19)));
    if (value.startsWith("/vendor-three-examples/")) return existingModule(join(ROOT, "node_modules/three/examples/jsm", value.slice(23)));
    if (value.startsWith("/vendor-vrm/")) return existingModule(join(ROOT, "node_modules/@pixiv/three-vrm/lib", value.slice(12)));
    return existingModule(join(ROOT, "web", value.slice(1)));
  }
  if (value.startsWith(".")) return existingModule(browserRoute(resolve(dirname(referrer), value)));
  if (kind !== "module" && /^(?:licenses|runtime|src|tools|web|wow-spec)\//.test(value)) {
    return existingModule(resolve(ROOT, value));
  }
  if (kind !== "module") return existingModule(browserRoute(resolve(ROOT, "web", value)));
  const mapped = mappedBrowserImport(value);
  if (!mapped) throw new Error(`unmapped browser import: ${relative(ROOT, referrer)} -> ${value}`);
  return existingModule(browserRoute(resolve(ROOT, "web", cleanSpecifier(mapped))));
}

function enqueueReference(specifier, referrer, context, kind) {
  const absolute = resolveReference(specifier, referrer, context, kind);
  if (!absolute) return;
  if (!existsSync(absolute) || !lstatSync(absolute).isFile()) {
    throw new Error(`missing local ${kind}: ${relative(ROOT, referrer).split(sep).join("/")} -> ${cleanSpecifier(specifier)}`);
  }
  const key = `${context}:${absolute}`;
  if (!closureVisited.has(key)) closureQueue.push({ absolute, context, key });
}

function scanHtml(absolute, text) {
  for (const match of text.matchAll(/<script\s+type=["']importmap["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    const parsed = JSON.parse(match[1]);
    for (const [key, value] of Object.entries(parsed.imports || {})) browserImportMap.set(key, value);
  }
  for (const match of text.matchAll(/\b(?:src|href)=["']([^"']+)["']/gi)) {
    if (localResource(match[1])) enqueueReference(match[1], absolute, "browser", "resource");
  }
}

function scanCss(absolute, text) {
  for (const match of text.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) {
    if (localResource(match[1])) enqueueReference(match[1], absolute, "browser", "resource");
  }
}

function scanJson(absolute, text, context) {
  const resourceContext = relative(ROOT, absolute).split(sep).join("/").startsWith("web/") ? "browser" : context;
  const visit = (value) => {
    if (typeof value === "string" && localResource(value) && !runtimeRoute(value)) {
      enqueueReference(value, absolute, resourceContext, "resource");
    } else if (Array.isArray(value)) {
      value.forEach(visit);
    } else if (value && typeof value === "object") {
      Object.values(value).forEach(visit);
    }
  };
  visit(JSON.parse(text));
}

function scanJavaScript(absolute, text, context) {
  const modulePatterns = [
    /\b(?:import|export)\s+(?:[^"';]*?\s+from\s*)?["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of modulePatterns) {
    for (const match of text.matchAll(pattern)) enqueueReference(match[1], absolute, context, "module");
  }
  if (context !== "browser") return;
  const resourcePatterns = [
    /\b(?:fetch|new URL)\s*\(\s*["']([^"']+)["']/g,
    /\.(?:href|src)\s*=\s*["']([^"']+)["']/g,
  ];
  for (const pattern of resourcePatterns) {
    for (const match of text.matchAll(pattern)) {
      if (localResource(match[1]) && !runtimeRoute(match[1])) enqueueReference(match[1], absolute, context, "resource");
    }
  }
}

function verifyLocalClosure() {
  const browserEntry = join(ROOT, "web", "index.html");
  enqueueReference("./index.html", browserEntry, "browser", "entrypoint");
  for (const path of ["src/orchestrator.js", "src/serve.js", "tools/start-detached.mjs", "tools/verify-demo.mjs"]) {
    enqueueReference(`./${path.split("/").at(-1)}`, join(ROOT, path), "node", "entrypoint");
  }
  while (closureQueue.length) {
    const item = closureQueue.shift();
    if (closureVisited.has(item.key)) continue;
    closureVisited.add(item.key);
    if (item.absolute.includes(`${sep}node_modules${sep}`)) continue;
    const extension = extname(item.absolute).toLowerCase();
    if (![".css", ".html", ".js", ".json", ".mjs"].includes(extension)) continue;
    const text = readFileSync(item.absolute, "utf8");
    if (extension === ".html") scanHtml(item.absolute, text);
    else if (extension === ".css") scanCss(item.absolute, text);
    else if (extension === ".json") scanJson(item.absolute, text, item.context);
    else scanJavaScript(item.absolute, text, item.context);
  }
  return closureVisited.size;
}

const closureFileCount = verifyLocalClosure();

console.log(JSON.stringify({
  status: "PASS",
  file_count: actual.length + 1,
  closure_file_count: closureFileCount,
  complete_tree_sha256: manifest.complete_tree_sha256,
}, null, 2));
