import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findBrowser } from "./find-browser.mjs";

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FRONTEND_PORT = Number(process.env.OSL_FRONTEND_PORT) || 8143;
const BACKEND_PORTS = {
  a: Number(process.env.OSL_BACKEND_A_PORT) || 18151,
  b: Number(process.env.OSL_BACKEND_B_PORT) || 18152,
  lobby: Number(process.env.OSL_BACKEND_LOBBY_PORT) || 18153,
  airport: Number(process.env.OSL_BACKEND_AIRPORT_PORT) || 18154,
};
const BASE = `http://127.0.0.1:${FRONTEND_PORT}`;
const sleep = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));

function run(script, args = []) {
  const result = spawnSync("bash", [join(ROOT, script), ...args], { cwd: ROOT, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${script} failed\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

async function json(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.json();
}

async function press(page, key, milliseconds = 130) {
  await page.keyboard.down(key);
  await sleep(milliseconds);
  await page.keyboard.up(key);
}

async function openWorld(browser, route, expectedLocation, requestLog, errors) {
  const page = await browser.newPage();
  page.on("request", (request) => requestLog.push(request.url()));
  page.on("requestfailed", (request) => errors.push(`request failed: ${request.url()} ${request.failure()?.errorText || ""}`));
  page.on("pageerror", (error) => errors.push(`page error: ${String(error)}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console error: ${message.text()}`);
  });
  await page.goto(`${BASE}/${route}`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForFunction(() => document.body.dataset.assemblyReady === "1" && window.__assembly?.debugState, { timeout: 30000 });
  await page.evaluate(() => document.querySelector('[data-testid="start-exploring"]')?.click());
  await page.waitForFunction(() => window.__assembly.equipmentReady?.() !== false, { timeout: 30000 });
  const state = await page.evaluate(() => window.__assembly.debugState());
  if (state.location_id !== expectedLocation) throw new Error(`expected ${expectedLocation}, found ${state.location_id}`);
  if (!(await page.$("#scene-mount canvas"))) throw new Error(`Three.js canvas missing for ${expectedLocation}`);
  return page;
}

async function moveDirectlyToward(page, x, z, maxSteps = 220) {
  for (let step = 0; step < maxSteps; step += 1) {
    const distance = await page.evaluate(({ targetX, targetZ }) => {
      const position = window.__assembly.debugState().avatar.position;
      const dx = targetX - position[0];
      const dz = targetZ - position[2];
      const remaining = Math.hypot(dx, dz);
      if (remaining <= 0.08) return remaining;
      window.__assembly.moveAvatar(
        { forward: true, camera_yaw: Math.atan2(dx, dz) },
        Math.min(0.05, remaining / 2.4),
      );
      return remaining;
    }, { targetX: x, targetZ: z });
    if (distance <= 0.08) return;
    await sleep(12);
  }
  throw new Error(`could not move avatar to ${x},${z}`);
}

async function portalDrive(page, portalId, destinationLocation, { browserDriven = false } = {}) {
  await page.waitForFunction((id) => {
    const position = window.__assembly?.debugState?.()?.avatar?.position;
    const portals = window.__assembly?.adapter?.world?.portals;
    return Array.isArray(position) && Array.isArray(portals) && portals.some(
      (candidate) => (candidate.string_portal_id || candidate.portal_id) === id,
    );
  }, { timeout: 30000, polling: 25 }, portalId);
  const portal = await page.evaluate((id) => {
    const entry = window.__assembly.adapter.world.portals.find(
      (candidate) => (candidate.string_portal_id || candidate.portal_id) === id,
    );
    if (!entry) throw new Error(`portal missing: ${id}`);
    const center = entry.frame?.ground_center || entry.trigger?.position || entry.trigger_position;
    const forward = entry.frame?.forward || entry.traversal?.frame_forward || [0, 0, 1];
    const position = window.__assembly.debugState().avatar.position;
    const signed = (position[0] - center[0]) * forward[0] + (position[2] - center[2]) * forward[2];
    return { center, forward, side: signed >= 0 ? 1 : -1 };
  }, portalId);
  const approach = [
    portal.center[0] + portal.forward[0] * portal.side * 1.1,
    portal.center[2] + portal.forward[2] * portal.side * 1.1,
  ];
  const exit = [
    portal.center[0] - portal.forward[0] * portal.side * 1.1,
    portal.center[2] - portal.forward[2] * portal.side * 1.1,
  ];
  await moveDirectlyToward(page, approach[0], approach[1]);
  for (let step = 0; step < 360; step += 1) {
    const state = await page.evaluate(() => window.__assembly.debugState());
    if (state.location_id === destinationLocation) return state;
    if (browserDriven) {
      const key = await page.evaluate(({ targetX, targetZ }) => {
        const position = window.__assembly.debugState().avatar.position;
        const dx = targetX - position[0];
        const dz = targetZ - position[2];
        const yaw = Number(window.__assembly.movementBasisYaw());
        const sinBasis = Math.sin(yaw);
        const cosBasis = Math.cos(yaw);
        return [
          { key: "w", direction: [sinBasis, cosBasis] },
          { key: "s", direction: [-sinBasis, -cosBasis] },
          { key: "d", direction: [-cosBasis, sinBasis] },
          { key: "a", direction: [cosBasis, -sinBasis] },
        ].reduce((best, candidate) => {
          const score = candidate.direction[0] * dx + candidate.direction[1] * dz;
          return !best || score > best.score ? { ...candidate, score } : best;
        }, null).key;
      }, { targetX: exit[0], targetZ: exit[1] });
      await press(page, key, 80);
    } else {
      await page.evaluate(({ targetX, targetZ }) => {
        const position = window.__assembly.debugState().avatar.position;
        window.__assembly.moveAvatar(
          { forward: true, camera_yaw: Math.atan2(targetX - position[0], targetZ - position[2]) },
          0.05,
        );
      }, { targetX: exit[0], targetZ: exit[1] });
      await sleep(12);
    }
  }
  const state = await page.evaluate(() => {
    const debug = window.__assembly?.debugState?.();
    return {
      location_id: debug?.location_id,
      phase: debug?.phase,
      position: debug?.avatar?.position,
      controls: debug?.controls,
      portal_ids: window.__assembly?.adapter?.world?.portals?.map(
        (entry) => entry.string_portal_id || entry.portal_id,
      ),
    };
  });
  throw new Error(`portal ${portalId} did not reach ${destinationLocation}: ${JSON.stringify(state)}`);
}

async function assertBinaryAsset(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 20 || bytes.subarray(0, 4).toString("ascii") !== "glTF") {
    throw new Error(`invalid GLB/VRM asset: ${url}`);
  }
}

async function assertValidatedJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  const validation = response.headers.get("X-OSL-WoW-Validation");
  if (!validation?.startsWith("pass:")) throw new Error(`${url} returned invalid contract header: ${validation || "missing"}`);
  return response.json();
}

async function assertEnabledWowContracts() {
  for (const world of ["a", "b", "lobby", "airport"]) {
    const worldResource = await assertValidatedJson(`${BASE}/api/${world}/wow/world`);
    await json(`${BASE}/api/${world}/wow/location`);
    await assertValidatedJson(`${BASE}/api/${world}/wow/user/1`);
    await assertValidatedJson(`${BASE}/api/${world}/wow/view/1`);
    const portalCount = Number(worldResource.portals?.portal_count) || 0;
    for (let id = 1; id <= portalCount; id += 1) await assertValidatedJson(`${BASE}/api/${world}/wow/portal/${id}`);
    const spatialId = worldResource.id;
    const root = await assertValidatedJson(`${BASE}/api/${world}/wow/spatial/${encodeURIComponent(spatialId)}`);
    for (const id of [root.id, ...(root.children || [])]) await assertValidatedJson(`${BASE}/api/${world}/wow/spatial/${encodeURIComponent(spatialId)}/node/${id}`);
  }
}

async function assertToolbarTargets(page) {
  const controlIds = [
    "btn-views-home", "btn-camera-toggle", "btn-switch-avatar",
    "btn-refresh-settings", "btn-notifications", "btn-return-lobby", "btn-rail-toggle",
  ];
  for (const width of [1280, 1024, 768, 620, 390]) {
    await page.setViewport({ width, height: 800 });
    await page.evaluate(() => window.__assembly.viewport.forceSync());
    await page.waitForFunction((expected) => {
      const value = Number.parseFloat(getComputedStyle(document.documentElement)
        .getPropertyValue("--osl-viewport-width"));
      return Math.abs(value - expected) < 2;
    }, { timeout: 5000 }, width);
    const geometry = await page.evaluate((ids) => {
      const visible = (element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return !element.hidden && style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      const box = (element) => {
        const rect = element.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        return {
          id: element.id,
          left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
          width: rect.width, height: rect.height, x, y,
          hit: document.elementFromPoint(x, y)?.closest?.("button")?.id || null,
        };
      };
      return {
        controls: ids.map((id) => document.getElementById(id)).filter(visible).map(box),
        hidden: ["btn-semantic-destinations", "btn-runtime-tweaks"].map((id) => {
          const element = document.getElementById(id);
          return { id, display: getComputedStyle(element).display, ariaHidden: element.getAttribute("aria-hidden"), tabIndex: element.tabIndex };
        }),
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    }, controlIds);
    const ordered = [...geometry.controls].sort((left, right) => left.left - right.left);
    const hitSize = width <= 620 ? 30 : 40;
    if (geometry.overflow !== 0 || ordered.length < 5 ||
        !ordered.some((entry) => entry.id === "btn-views-home") ||
        ordered.some((entry) => entry.hit !== entry.id || entry.width < hitSize || entry.height < hitSize) ||
        ordered.some((entry, index) => index > 0 && ordered[index - 1].right > entry.left) ||
        geometry.hidden.some((entry) => entry.display !== "none" || entry.ariaHidden !== "true" || entry.tabIndex !== -1)) {
      throw new Error(`toolbar geometry/hit failure at ${width}px: ${JSON.stringify(geometry)}`);
    }
    const view = geometry.controls.find((entry) => entry.id === "btn-views-home");
    await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.click(), {
      x: view.x, y: view.y,
    });
    await page.waitForFunction(() => document.getElementById("btn-views-home")?.getAttribute("aria-expanded") === "true");
    await page.keyboard.press("Escape");
    await page.focus("#btn-views-home");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.getElementById("btn-views-home")?.getAttribute("aria-expanded") === "true");
    await page.keyboard.press("Escape");
  }
  await page.setViewport({ width: 1280, height: 800 });
}

async function settledErrors(errors) {
  const significant = [];
  for (const value of errors) {
    const aborted = /^request failed: (\S+) net::ERR_ABORTED$/i.exec(value);
    if (!aborted) {
      if (!/favicon\.ico|WebSocket is closed before the connection is established/i.test(value)) significant.push(value);
      continue;
    }
    try {
      await assertBinaryAsset(aborted[1]);
    } catch (error) {
      significant.push(`${value}; settlement check failed: ${error.message}`);
    }
  }
  return significant;
}

async function main() {
  run("stopOpenSpatialLab.sh", ["--quiet"]);
  const receipt = run("launchOpenSpatialLab.sh");
  if (!receipt.includes("Open Spatial Lab is ready.")) throw new Error("startup receipt missing");

  for (const [port, location] of [[BACKEND_PORTS.a, "location-a"], [BACKEND_PORTS.b, "location-b"], [BACKEND_PORTS.lobby, "location-lobby"], [BACKEND_PORTS.airport, "location-airport"]]) {
    const health = await json(`http://127.0.0.1:${port}/healthz`);
    if (!health.ok || health.location_id !== location) throw new Error(`health check mismatch on ${port}`);
  }
  for (const world of ["a", "b", "lobby", "airport"]) {
    const user = await json(`${BASE}/api/${world}/wow/user/1`);
    const signature = user.open_user_manifest?.signature;
    if (!signature?.keyRef || !signature?.value) throw new Error(`signed user manifest missing for ${world}`);
  }
  await assertEnabledWowContracts();
  for (const port of [19151, 19152, 19153, 19154]) {
    const result = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" });
    if (result.status === 0 && result.stdout.trim()) throw new Error(`unsupported auxiliary listener is active on ${port}`);
  }
  for (const name of ["AntiqueCamera", "ToyCar", "BoomBox", "Fox", "Avocado", "BarramundiFish", "Duck", "Lantern"]) {
    await assertBinaryAsset(`${BASE}/assets/worlds/${name}.glb`);
  }
  const avatarCatalog = await json(`${BASE}/assets/avatar-catalog.json`);
  for (const avatar of avatarCatalog.avatars) {
    if (avatar.type !== "parametric") await assertBinaryAsset(new URL(avatar.url, BASE));
  }
  const equipmentCatalog = await json(`${BASE}/assets/equip-catalog.json`);
  for (const item of equipmentCatalog.items) {
    await assertBinaryAsset(new URL(item.assetUri, BASE));
  }

  const executablePath = findBrowser();
  if (!executablePath) throw new Error("No compatible local browser was found. Set PUPPETEER_EXECUTABLE_PATH.");
  const puppeteer = require("puppeteer-core");
  const browser = await puppeteer.launch({
    executablePath,
    headless: "new",
    args: ["--no-sandbox", "--enable-webgl", "--ignore-gpu-blocklist", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
    defaultViewport: { width: 1280, height: 800 },
  });
  const requests = [];
  const errors = [];
  try {
    const launcher = await browser.newPage();
    launcher.on("request", (request) => requests.push(request.url()));
    launcher.on("pageerror", (error) => errors.push(`launcher page error: ${String(error)}`));
    await launcher.goto(`${BASE}/`, { waitUntil: "networkidle0", timeout: 30000 });
    await launcher.waitForSelector(".demo-launcher", { timeout: 15000 });

    const lobby = await openWorld(browser, "index.html?role=player&intro=bypass", "location-lobby", requests, errors);
    await assertToolbarTargets(lobby);
    await lobby.evaluate(async () => {
      const selector = window.__assembly.avatarSelector;
      selector.open();
      selector.pickAvatar("parametric");
      await selector.apply();
    });
    await lobby.waitForFunction(
      () => window.__assembly.debugState().avatar?.avatar_variant === "parametric",
      { timeout: 30000 },
    );
    await lobby.evaluate(async () => {
      const selector = window.__assembly.avatarSelector;
      selector.open();
      selector.pickAvatar("parametric");
      selector.pickSlotItem("head", "equip-hat");
      selector.pickSlotItem("rightHand", "equip-hammer");
      await selector.apply();
    });
    await lobby.waitForFunction(() => {
      const state = window.__assembly.debugState();
      const itemIds = state.avatar?.equippedItems?.map((item) => item.itemId) || [];
      return state.avatar?.avatar_variant === "parametric" && itemIds.includes("equip-hat") && itemIds.includes("equip-hammer");
    }, { timeout: 30000 });
    await portalDrive(lobby, "lobby-portal-c", "location-airport", { browserDriven: true });
    await lobby.waitForFunction(() => (
      document.body.dataset.airportTerminalReady === "1" &&
      window.__assembly.adapter.world.portals.some(
        (portal) => (portal.string_portal_id || portal.portal_id) === "airport-portal-lobby",
      )
    ), { timeout: 30000 });
    const contractState = await lobby.evaluate(() => window.__assembly.debugState().wow_contract_validation);
    if (contractState?.status === "failed" || contractState?.failed || contractState?.errors)
      throw new Error(`visible WoW contract warning after Portal C: ${JSON.stringify(contractState)}`);
    await lobby.evaluate(() => window.__assembly.orbitCamera(Math.PI, 0, 0));
    await sleep(350);
    await portalDrive(lobby, "airport-portal-lobby", "location-lobby", { browserDriven: true });

    const locationA = await openWorld(browser, "index.html?role=player&active=source&intro=bypass", "location-a", requests, errors);
    await portalDrive(locationA, "location-a-portal", "location-b");
    await portalDrive(locationA, "location-b-portal", "location-a");
    await openWorld(browser, "index.html?role=source&intro=bypass", "location-a", requests, errors);
    await openWorld(browser, "index.html?role=target&intro=bypass", "location-b", requests, errors);

    const external = requests.filter((value) => {
      try {
        const url = new URL(value);
        return ["http:", "https:", "ws:", "wss:"].includes(url.protocol) && !["127.0.0.1", "localhost"].includes(url.hostname);
      } catch { return false; }
    });
    if (external.length) throw new Error(`unexpected external runtime requests: ${[...new Set(external)].join(", ")}`);
    const significant = await settledErrors(errors);
    if (significant.length) throw new Error(significant.join("\n"));
  } finally {
    await browser.close();
    run("stopOpenSpatialLab.sh", ["--quiet"]);
  }

  for (const port of [FRONTEND_PORT, ...Object.values(BACKEND_PORTS), 19151, 19152, 19153, 19154]) {
    const result = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" });
    if (result.status === 0 && result.stdout.trim()) throw new Error(`port ${port} remained occupied after shutdown`);
  }
  console.log("PASS: Open Spatial Lab verification complete");
}

main().catch((error) => {
  try { run("stopOpenSpatialLab.sh", ["--quiet"]); } catch {}
  console.error(error.stack || error.message);
  process.exit(1);
});
