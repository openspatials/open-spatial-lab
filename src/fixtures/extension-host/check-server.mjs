// The static server and browser shutdown shared by the extension browser checks (src/wow-extension-mount-browser-check.mjs
// and src/wow-extension-page-browser-check.mjs). One handler on 127.0.0.1 answers on the given port and on a second,
// free port. It serves the Lab page's routes (web/ at the root, /vendor/scene-core/, /vendor-three-examples/,
// /vendor-vrm/), the extension host at /vendor/extension-host/ and the fixtures at /fixtures/extension-host/, plus the
// check's own pages. The 5a test world is served with the check's test server origin in place of WORLD_5A_ORIGIN.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
// The 5a test world names its test server with this origin; the static server puts the check's own in its place.
export const WORLD_5A_PATH = "/fixtures/extension-host/world/extension-world-5a.json";
export const WORLD_5A_ORIGIN = "http://127.0.0.1:18353";
const TYPES = {
  ".html": "text/html; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".wasm": "application/wasm", ".glb": "model/gltf-binary",
};
// Served path prefix -> folder under the code folder. The Lab frontend's routes are in src/serve.js.
const ROUTES = [
  ["/vendor/scene-core/", "runtime/scene-core/public/"],
  ["/vendor-three-examples/", "node_modules/three/examples/jsm/"],
  ["/vendor-vrm/", "node_modules/@pixiv/three-vrm/lib/"],
  ["/vendor/extension-host/", "runtime/extension-host/"],
  ["/fixtures/extension-host/", "src/fixtures/extension-host/"],
  ["/", "web/"],
];

export const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * startServers({ port, netOrigin, pages, routes }) -> Promise<[server on port, server on a free port]>
 * pages maps a served path to { type: ".html" | ".mjs" | ".json", body }; routes are extra [prefix, folder] pairs,
 * looked up before the Lab's. /__ue-requests answers { modules } (the .wasm requests served), and resets with ?reset=1.
 */
export function startServers({ port, netOrigin, pages = {}, routes = [] }) {
  let modules = 0;
  const allRoutes = [...routes, ...ROUTES];
  const handler = async (request, response) => {
    try {
      const url = new URL(request.url, "http://localhost");
      const path = decodeURIComponent(url.pathname);
      const headers = { "cache-control": "no-store", "access-control-allow-origin": "*" };
      if (Object.hasOwn(pages, path)) return void response.writeHead(200, { ...headers, "content-type": TYPES[pages[path].type] }).end(pages[path].body);
      if (path === "/__ue-requests") {
        const body = JSON.stringify({ modules });
        if (url.searchParams.get("reset")) modules = 0;
        return void response.writeHead(200, { ...headers, "content-type": TYPES[".json"] }).end(body);
      }
      if (request.method !== "GET") throw Object.assign(new Error("refused"), { status: 405 });
      if (path.endsWith(".wasm")) modules += 1;
      const [prefix, folder] = allRoutes.find(([start]) => path.startsWith(start));
      const base = resolve(ROOT, folder);
      const file = resolve(base, `.${path.slice(prefix.length - 1)}`);
      if (file !== base && !file.startsWith(base + sep)) throw Object.assign(new Error("refused"), { status: 403 });
      let body = await readFile(file);
      if (path === WORLD_5A_PATH) body = body.toString("utf8").split(WORLD_5A_ORIGIN).join(netOrigin);
      response.writeHead(200, { ...headers, "content-type": TYPES[extname(file)] || "application/octet-stream" });
      response.end(body);
    } catch (error) {
      response.writeHead(error.status || 404, { "content-type": "text/plain", "access-control-allow-origin": "*" });
      response.end(String(error.status || 404));
    }
  };
  const listen = (at) => new Promise((done, fail) => {
    const server = createServer(handler);
    server.once("error", fail);
    server.listen(at, "127.0.0.1", () => done(server));
  });
  return Promise.all([listen(port), listen(0)]);
}

export function stopServer(server) {
  if (!server) return Promise.resolve();
  return new Promise((done) => {
    server.close(() => done());
    server.closeAllConnections();
  });
}

export async function stopBrowser(browser) {
  if (!browser) return;
  const child = browser.process();
  await Promise.race([browser.close().catch(() => {}), sleep(10000)]);
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await Promise.race([new Promise((done) => child.once("exit", done)), sleep(5000)]);
  }
}
