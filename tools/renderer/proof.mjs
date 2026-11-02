// Proof for the opt-in renderers (?renderer=x3dom, ?renderer=x_ite) and John Carlson's soft-body world. It also checks
// that three.js stays the default and that the default path does not read the switch.
//
//   npm run renderer-proof                               every check, with screenshots
//   npm run renderer-proof -- --faults                   every planted fault must turn its check red
//   add --only <text> to run the checks or faults whose name holds <text>; a | separates several texts
//
// It needs headless Chrome (tools/find-browser.mjs finds it, or PUPPETEER_EXECUTABLE_PATH names it). It starts its own
// servers on OSL_RENDERER_PROOF_PORT (default 34000) and the four ports after it, and stops only those. It writes its
// pictures and steps.md to diagnostics/renderer-proof/. A browser check that fails gets one re-run, because load can
// cause a failure. Faults get no re-run. It is too slow for `npm test`, so it is not in that group.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { findBrowser } from "../find-browser.mjs";

const CODE = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PROOF = join(CODE, "diagnostics", "renderer-proof");
const PUB = join(CODE, "runtime", "scene-core", "public");
const RA = join(PUB, "render-adapter");
const PORT = Number(process.env.OSL_RENDERER_PROOF_PORT) || 34000;
const BASE = `http://127.0.0.1:${PORT}`;
const require = createRequire(join(CODE, "package.json"));
const puppeteer = require("puppeteer-core");
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const argv = process.argv.slice(2);
const FAULT_MODE = argv.includes("--faults");
const ONLY = argv.includes("--only") ? argv[argv.indexOf("--only") + 1] : null;
// RENDERER_PROOF_SLOW=3 gives every browser time limit three times as long, for a machine loaded by other work.
// It changes how long the proof waits, and nothing it asks of the page.
const SLOW = Number(process.env.RENDERER_PROOF_SLOW) || 1;
// The engines as downloaded: x3dom@1.8.3 and x_ite@16.6.0 from npm. The lab's copies must stay these bytes.
const DOWNLOADED_SHA256 = Object.freeze({
  "x3dom/x3dom-full.js": "0d336683d039d19c94a4b748299a13270db3a9e71edfccbf6ad6a58133e1b3fb",
  "x_ite/x_ite.min.mjs": "14e45510d4a28c3485964b2447ea9fedd996b3564f1130d012c0bc3da0a91b5e",
});
// X_ITE's KTX decoder: KTX-Software builds Ericsson's etcdec.cxx, which is not open source, into it. The lab does not serve it.
const LEFT_OUT_OF_XITE = Object.freeze(["libktx.js", "libktx.wasm"]);
// The code from other projects inside X_ITE's own files, each named with its licence in vendor/x_ite/THIRD-PARTY-IN-BUNDLES.md.
const BUNDLED_IN_XITE = Object.freeze(["libgif-js", "apng-js", "Joyent", "libtess", "Andreas Plesch", "CharLS", "OpenJPEG", "dicom-parser", "jpeg-js", "jpeg-lossless-decoder-js", "ammo.js", "Bullet", "opentype.js", "tiny-inflate", "nurbs", "isndarray", "mikktspace", "nalgebra", "Draco", "meshoptimizer"]);
// The git blob id of web/worlds/soft-body.json in John Carlson's commit bf12953173.
const JOHN_WORLD_BLOB = "18e4ea5b5e1c6415f9a9e7597e5379c4f8d57648";
const ADJUSTED_WORLD = join(CODE, "web", "x3d-worlds", "soft-body.x3d.json");

// ---------------------------------------------------------------- what was done and seen, for steps.md
const steps = { three: [], x3dom: [], x_ite: [], "soft-body": [] };
const shotCount = { three: 0, x3dom: 0, x_ite: 0, "soft-body": 0 };

// ---------------------------------------------------------------- image reading, in a blank page
let analysisPage = null;
async function analyse(pngBase64, rects = [], rings = [], tonePoints = null) {
  return analysisPage.evaluate(async (b64, rects, rings, tonePoints) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(bitmap, 0, 0);
    const W = bitmap.width, H = bitmap.height;
    const data = context.getImageData(0, 0, W, H).data;
    const at = (x, y) => { const i = 4 * (y * W + x); return [data[i], data[i + 1], data[i + 2]]; };
    // The scene, without the page header and footer.
    const top = Math.round(H * 0.1), bottom = Math.round(H * 0.86);
    const buckets = new Map();
    let total = 0, nearBlack = 0, bright = 0;
    for (let y = top; y < bottom; y += 3) {
      for (let x = 0; x < W; x += 3) {
        const [r, g, b] = at(x, y);
        const key = (r >> 4) << 8 | (g >> 4) << 4 | (b >> 4);
        buckets.set(key, (buckets.get(key) || 0) + 1);
        total += 1;
        if (r + g + b < 15) nearBlack += 1;
        if (r > 190 && g > 190 && b > 120) bright += 1;
      }
    }
    const dominant = Math.max(...buckets.values()) / total;
    // Floor tone: the lower corners of the scene, clear of the avatar, or small patches around the given points.
    // The middle value of each colour, not the mean, so a hosted object standing in one corner does not tint it.
    const samples = [[], [], []];
    if (tonePoints && tonePoints.length) {
      for (const [px, py] of tonePoints) {
        for (let dy = -4; dy <= 4; dy += 2) for (let dx = -4; dx <= 4; dx += 2) {
          const x = Math.round(px) + dx, y = Math.round(py) + dy;
          if (x < 0 || y < 0 || x >= W || y >= H) continue;
          const c = at(x, y);
          for (const channel of [0, 1, 2]) samples[channel].push(c[channel]);
        }
      }
    } else {
      for (const xf of [0.06, 0.12, 0.18, 0.82, 0.88, 0.94]) {
        for (const yf of [0.68, 0.72, 0.76]) {
          const c = at(Math.round(W * xf), Math.round(H * yf));
          for (const channel of [0, 1, 2]) samples[channel].push(c[channel]);
        }
      }
    }
    const tone = samples.map((values) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)]);
    // The avatar: dark or strongly different pixels in the middle of the view.
    let middleDark = 0;
    for (let y = Math.round(H * 0.3); y < Math.round(H * 0.8); y += 3) {
      for (let x = Math.round(W * 0.42); x < Math.round(W * 0.58); x += 3) {
        const [r, g, b] = at(x, y);
        if (r + g + b < 60) middleDark += 1;
      }
    }
    // What each named rectangle holds: a flat tint has very few colour groups.
    const regions = rects.map(({ name, x0, y0, x1, y1 }) => {
      const groups = new Map();
      let count = 0, black = 0;
      const sum = [0, 0, 0];
      for (let y = Math.max(0, Math.round(y0)); y < Math.min(H, Math.round(y1)); y += 2) {
        for (let x = Math.max(0, Math.round(x0)); x < Math.min(W, Math.round(x1)); x += 2) {
          const [r, g, b] = at(x, y);
          const key = (r >> 3) << 10 | (g >> 3) << 5 | (b >> 3);
          groups.set(key, (groups.get(key) || 0) + 1);
          count += 1; sum[0] += r; sum[1] += g; sum[2] += b;
          if (r + g + b < 30) black += 1;
        }
      }
      return { name, distinct: groups.size, dominant: count ? +(Math.max(...groups.values()) / count).toFixed(3) : 1, black: count ? +(black / count).toFixed(3) : 1, mean: sum.map((v) => Math.round(v / (count || 1))) };
    });
    // Each portal's ring, sampled along the line where the world says that portal is. A ring left over
    // from another world, or a ring not drawn, does not answer here, however bright the screen is.
    const ringColour = (r, g, b) => (g > 120 && b > 140 && g - r > 40 && b - r > 40) || (r > 170 && g > 120 && b < 170 && r - b > 50) || (r > 190 && g > 190 && b > 120);
    const ringsSeen = rings.map(({ name, points }) => {
      let onScreen = 0, hits = 0;
      for (const [px, py] of points) {
        if (px < 6 || px >= W - 6 || py < top + 6 || py >= H * 0.8) continue;
        onScreen += 1;
        let hit = false;
        for (let dy = -5; dy <= 5 && !hit; dy += 1) for (let dx = -5; dx <= 5 && !hit; dx += 1) {
          const [r, g, b] = at(Math.round(px) + dx, Math.round(py) + dy);
          hit = ringColour(r, g, b);
        }
        if (hit) hits += 1;
      }
      return { name, onScreen, hits };
    });
    return {
      regions, rings: ringsSeen,
      distinct: buckets.size, dominant: +dominant.toFixed(3), nearBlack: +(nearBlack / total).toFixed(3), bright: +(bright / total).toFixed(3),
      tone, middleDark,
    };
  }, pngBase64, rects, rings, tonePoints);
}

function assertLooksLikeWorld(seen, label) {
  assert.ok(seen.distinct >= 8 && seen.dominant < 0.8, `${label}: the view looks blank (${seen.distinct} colour groups, the largest covers ${seen.dominant})`);
}
function assertTone(seen, expected, label) {
  const [r, g, b] = seen.tone;
  const ok = expected === "green" ? g > r + 12 && g > b + 8
    : expected === "blue" ? b > r + 12 && b >= g
      : expected === "brown" ? r > g + 8 && r > b + 12
      : expected === "grey" ? Math.max(r, g, b) - Math.min(r, g, b) < 60 && r + g + b > 120
        : false;
  assert.ok(ok, `${label}: the room colour is wrong, floor tone rgb(${r},${g},${b}) is not ${expected}`);
}

// ---------------------------------------------------------------- pages, with optional planted changes
// A rule: { url, find, replace } rewrites a served text file; { url, abort: true } refuses it.
async function openPage(browser, rules = []) {
  const page = await browser.newPage();
  page.__errors = [];
  page.__assetRequests = [];
  page.on("pageerror", (error) => page.__errors.push(String(error)));
  page.on("request", (request) => { if (/\/api\/[^/]+\/wow\/asset\/primitive-obj-/.test(request.url())) page.__assetRequests.push(request.url()); });
  if (rules.length) {
    await page.setRequestInterception(true);
    page.on("request", async (request) => {
      const rule = rules.find((candidate) => request.url().includes(candidate.url));
      try {
        if (!rule) return await request.continue();
        if (rule.abort) return await request.abort("failed");
        if (rule.status) return await request.respond({ status: rule.status, body: "planted" });
        const response = await fetch(request.url());
        const text = await response.text();
        assert.ok(text.includes(rule.find), `planted fault did not apply to ${rule.url}: ${rule.find}`);
        await request.respond({ status: 200, contentType: response.headers.get("content-type") || "text/plain", body: rule.all ? text.replaceAll(rule.find, rule.replace) : text.replace(rule.find, rule.replace) });
      } catch (error) {
        try { await request.abort("failed"); } catch { /* already handled */ }
        page.__errors.push(String(error));
      }
    });
  }
  return page;
}

async function snap(ctx, page, series, name, detail, rects = [], rings = [], tonePoints = null) {
  await sleep(ctx.settle ?? 700);
  const shot = await page.screenshot({ encoding: "base64" });
  const seen = await analyse(shot, rects, rings, tonePoints);
  if (!ctx.planted) {
    shotCount[series] += 1;
    const number = String(shotCount[series]).padStart(2, "0");
    mkdirSync(join(PROOF, series), { recursive: true });
    const file = `${number}-${name}.png`;
    writeFileSync(join(PROOF, series, file), Buffer.from(shot, "base64"));
    steps[series].push({ file, detail, seen });
  }
  return seen;
}

// ---------------------------------------------------------------- the three.js path
async function openThree(ctx, query, watch = null) {
  const page = await openPage(ctx.browser, ctx.rules);
  if (watch) watch(page);
  await page.goto(`${BASE}/index.html?role=player&intro=bypass${query}`, { waitUntil: "domcontentloaded", timeout: 30000 * SLOW });
  try {
    await page.waitForFunction(() => document.body.dataset.assemblyReady === "1" && window.__assembly?.debugState, { timeout: ctx.patience ?? 45000 * SLOW });
  } catch {
    throw new Error(`the default path did not boot three.js for "${query}"`);
  }
  await page.evaluate(() => document.querySelector('[data-testid="start-exploring"]')?.click());
  await page.waitForFunction(() => window.__assembly.equipmentReady?.() !== false, { timeout: ctx.patience ?? 45000 * SLOW });
  await sleep(600);
  return page;
}
async function threeMoveTo(page, x, z) {
  for (let i = 0; i < 260; i += 1) {
    const left = await page.evaluate(({ x, z }) => {
      const position = window.__assembly.debugState().avatar.position;
      const dx = x - position[0], dz = z - position[2];
      const distance = Math.hypot(dx, dz);
      if (distance > 0.08) window.__assembly.moveAvatar({ forward: true, camera_yaw: Math.atan2(dx, dz) }, Math.min(0.05, distance / 2.4));
      return distance;
    }, { x, z });
    if (left <= 0.08) return;
    await sleep(12);
  }
  throw new Error(`could not move the avatar to ${x},${z}`);
}
function portalPlan(entry, position) {
  const center = entry.frame?.ground_center || entry.trigger?.position || entry.trigger_position;
  const forward = entry.frame?.forward || entry.traversal?.frame_forward || [0, 0, 1];
  const side = (position[0] - center[0]) * forward[0] + (position[2] - center[2]) * forward[2] >= 0 ? 1 : -1;
  return {
    approach: [center[0] + forward[0] * side * 1.1, center[2] + forward[2] * side * 1.1],
    exit: [center[0] - forward[0] * side * 1.1, center[2] - forward[2] * side * 1.1],
  };
}
async function threeCross(page, target) {
  const plan = await page.evaluate((target) => {
    const entry = window.__assembly.adapter.world.portals.find((p) => p.target_location_id === target);
    if (!entry) return null;
    return { entry: JSON.parse(JSON.stringify({ frame: entry.frame, trigger: entry.trigger, trigger_position: entry.trigger_position, traversal: entry.traversal })), position: window.__assembly.debugState().avatar.position };
  }, target);
  if (!plan) throw new Error(`no portal to ${target}`);
  const { approach, exit } = portalPlan(plan.entry, plan.position);
  await threeMoveTo(page, approach[0], approach[1]);
  for (let i = 0; i < 360; i += 1) {
    const location = await page.evaluate(() => window.__assembly.debugState().location_id);
    if (location === target) return;
    await page.evaluate(({ x, z }) => {
      const position = window.__assembly.debugState().avatar.position;
      window.__assembly.moveAvatar({ forward: true, camera_yaw: Math.atan2(x - position[0], z - position[2]) }, 0.05);
    }, { x: exit[0], z: exit[1] });
    await sleep(12);
  }
  throw new Error(`the three.js portal did not reach ${target}`);
}
async function threeState(page) {
  return page.evaluate(() => ({
    location: window.__assembly.debugState().location_id,
    choice: window.__renderAdapter?.active ?? null,
    reason: window.__renderAdapter?.reason ?? null,
    notice: document.getElementById("render-adapter-notice")?.textContent ?? null,
    x3dHost: !!document.getElementById("x3dom-host"),
    x3dEngine: !!window.x3dom,
    x3dLiveMode: !!window.__x3domLiveMode,
    canvases: document.querySelectorAll("#scene-mount canvas").length,
    portalTargets: (window.__assembly.adapter.world.portals || []).map((portal) => portal.target_location_id),
  }));
}

// ---------------------------------------------------------------- the X3D path
async function openX3d(ctx, kind, query = "") {
  const page = await openPage(ctx.browser, ctx.rules);
  await page.goto(`${BASE}/index.html?role=player&intro=bypass&renderer=${kind}${query}`, { waitUntil: "domcontentloaded", timeout: 30000 * SLOW });
  try {
    await page.waitForFunction(() => window.__x3domLiveMode?.liveAdapter?.world, { timeout: ctx.patience ?? 45000 * SLOW });
  } catch {
    throw new Error(`${kind} did not boot: no live mode after waiting, page errors: ${page.__errors.slice(0, 2).join(" | ")}`);
  }
  return page;
}
async function x3dWaitAvatar(ctx, page, kind) {
  try {
    await page.waitForFunction(() => window.__x3domLiveMode.avatarPlaced(), { timeout: ctx.patience ?? 90000 * SLOW });
  } catch {
    throw new Error(`${kind}: the avatar did not load`);
  }
}
async function x3dMoveTo(page, x, z) {
  for (let i = 0; i < 300; i += 1) {
    const left = await page.evaluate(({ x, z }) => {
      const live = window.__x3domLiveMode.liveAdapter;
      const position = live.state.avatar.position;
      const dx = x - position[0], dz = z - position[2];
      const distance = Math.hypot(dx, dz);
      if (distance > 0.08) live.stepAvatar({ forward: true, camera_yaw: Math.atan2(dx, dz) }, Math.min(0.05, distance / 2.4));
      return distance;
    }, { x, z });
    if (left <= 0.08) return;
    await sleep(12);
  }
  throw new Error(`could not move the avatar to ${x},${z}`);
}
async function x3dCross(page, kind, target) {
  const plan = await page.evaluate((target) => {
    const live = window.__x3domLiveMode.liveAdapter;
    const entry = live.world.portals.find((p) => p.target_location_id === target);
    if (!entry) return null;
    return { entry: JSON.parse(JSON.stringify({ frame: entry.frame, trigger: entry.trigger, trigger_position: entry.trigger_position, traversal: entry.traversal })), position: live.state.avatar.position };
  }, target);
  if (!plan) throw new Error(`${kind}: no portal to ${target}`);
  const { approach, exit } = portalPlan(plan.entry, plan.position);
  await x3dMoveTo(page, approach[0], approach[1]);
  for (let i = 0; i < 360; i += 1) {
    const location = await page.evaluate(() => window.__x3domLiveMode.liveAdapter.world?.location_id);
    if (location === target) {
      // The world changes first; the crossing event, which rebuilds the room, comes after it.
      try {
        await page.waitForFunction(() => window.__x3domLiveMode.crossings() >= 1, { timeout: 60000 * SLOW });
      } catch {
        throw new Error(`${kind}: the crossing event count is 0, 60 s after reaching ${target}`);
      }
      return;
    }
    await page.evaluate(({ x, z }) => {
      const live = window.__x3domLiveMode.liveAdapter;
      const position = live.state.avatar.position;
      live.stepAvatar({ forward: true, camera_yaw: Math.atan2(x - position[0], z - position[2]) }, 0.05);
    }, { x: exit[0], z: exit[1] });
    await sleep(12);
  }
  throw new Error(`${kind}: the portal did not reach ${target}`);
}
const x3dState = (page) => page.evaluate(() => {
  const m = window.__x3domLiveMode;
  return {
    kind: m.kind, active: window.__renderAdapter?.active, location: m.liveAdapter.world?.location_id, position: m.liveAdapter.state.avatar?.position,
    avatarPlaced: m.avatarPlaced(), crossings: m.crossings(), previews: m.portalGlue.previewDebugState(),
    otherCanvases: [...document.querySelectorAll("#scene-mount canvas")].filter((canvas) => !canvas.closest("x3d, x3d-canvas")).length,
    appLoaded: !!window.__assembly, title: document.getElementById("loc-title")?.textContent,
    path: location.pathname, worldId: m.liveAdapter.world?.world_id, endpointKey: m.liveAdapter.activeEndpointKey,
    portalTargets: (m.liveAdapter.world?.portals || []).map((portal) => portal.target_location_id),
  };
});

// The middle of each portal's opening on screen, clear of its ring.
const x3dApertureRects = (page) => page.evaluate(() => {
  const { adapter, liveAdapter } = window.__x3domLiveMode;
  return liveAdapter.world.portals.map((portal) => {
    const f = portal.frame, right = f.right || [1, 0, 0], up = f.up || [0, 1, 0];
    const corner = (sx, sy) => adapter.worldToScreen(adapter.camera, [0, 1, 2].map((axis) => f.position[axis] + right[axis] * f.width_m * 0.3 * sx + up[axis] * f.height_m * 0.3 * sy));
    const a = corner(-1, -1), b = corner(1, 1);
    return { name: portal.target_location_id, x0: Math.min(a.x, b.x), x1: Math.max(a.x, b.x), y0: Math.min(a.y, b.y), y1: Math.max(a.y, b.y) };
  });
});
const MIN_PREVIEW_COLOUR_GROUPS = 8;
const X3DOM_UNLIT_PREVIEW_MIN_BLUE = 72;
// Points along each portal's ring on screen, from the frame the world server gave.
const x3dRingPoints = (page) => page.evaluate(() => {
  const { adapter, liveAdapter } = window.__x3domLiveMode;
  return liveAdapter.world.portals.map((portal) => {
    const f = portal.frame, right = f.right || [1, 0, 0], up = f.up || [0, 1, 0];
    const points = [];
    for (let i = 0; i < 48; i += 1) {
      const a = (i / 48) * 2 * Math.PI, c = Math.cos(a) * f.width_m / 2, s = Math.sin(a) * f.height_m / 2;
      const p = adapter.worldToScreen(adapter.camera, [0, 1, 2].map((axis) => f.position[axis] + right[axis] * c + up[axis] * s));
      if (p && p.visible) points.push([p.x, p.y]);
    }
    return { name: portal.target_location_id, points };
  });
});
function assertPortalRings(seen, label) {
  const inView = seen.rings.filter((ring) => ring.onScreen >= 6);
  assert.ok(inView.length, `${label}: no portal is in view (${JSON.stringify(seen.rings)})`);
  for (const ring of inView) assert.ok(ring.hits / ring.onScreen >= 0.5, `${label}: no portal ring where the portal to ${ring.name} is (${ring.hits} of ${ring.onScreen} points on the ring)`);
}
// Waits until the eased camera has come to rest, so a picture shows where it really ends up.
const x3dCameraAtRest = (page) => page.waitForFunction(() => {
  const o = window.__x3domLiveMode.camera.orbit.state;
  return Math.abs(o.targetAzimuth - o.azimuth) < 0.01 && Math.abs(o.targetPolar - o.polar) < 0.01 && Math.abs(o.targetDistance - o.distance) < 0.01;
}, { timeout: 30000 * SLOW });
// Each hosted object belongs to one world: obj-a- to a, obj-b- to b, obj-lobby- to lobby.
async function assertAssetsAskedOfOwner(page, kind) {
  const wrong = page.__assetRequests.filter((url) => {
    const [, server, owner] = url.match(/\/api\/([^/]+)\/wow\/asset\/primitive-obj-([a-z]+)-/) || [];
    return server !== owner;
  });
  assert.deepEqual(wrong, [], `${kind}: asked the wrong world for another world's hosted object: ${wrong.slice(0, 3).join(", ")}`);
  // Only an asset the world serves is asked for: its attach-point names each object's access. The Lobby's two objects
  // are restricted and hidden, so a page in the Lobby asks for none.
  const objects = await page.evaluate(() => window.__x3domLiveMode.liveAdapter.demoReadAttachPoint(window.__x3domLiveMode.liveAdapter.activeEndpointKey).then((point) => point.value.objects));
  const refused = objects.filter((object) => (object.asset_access || "public") !== "public").map((object) => object.object_id);
  const askedRefused = page.__assetRequests.filter((url) => refused.some((id) => url.endsWith(`primitive-${id}`)));
  assert.deepEqual(askedRefused, [], `${kind}: asked for an asset its world refuses: ${askedRefused.slice(0, 3).join(", ")}`);
  if (objects.some((object) => (object.asset_access || "public") === "public")) assert.ok(page.__assetRequests.length > 0, `${kind}: no hosted object was asked for at all`);
}
// Does each portal show its own destination?
// 1. What the world server gave: the preview holds the content of the world its portal names, with that world's own hosted objects.
// 2. What is on screen: hide one destination's staged room and only that portal's picture may change.
async function assertPreviewsShowOwnDestination(ctx, page, kind, rects) {
  const previews = (await x3dState(page)).previews;
  for (const preview of previews) {
    assert.equal(preview.contentLocation, preview.target, `${kind} lobby: the portal to ${preview.target} holds the content of ${preview.contentLocation}`);
    const prefix = { "location-a": "obj-a-", "location-b": "obj-b-" }[preview.target];
    if (prefix) {
      assert.ok(preview.hostedObjectIds.length > 0, `${kind} lobby: the portal to ${preview.target} has no hosted objects`);
      for (const id of preview.hostedObjectIds) assert.ok(id.startsWith(prefix), `${kind} lobby: the portal to ${preview.target} holds the content of another world (${id})`);
    }
  }
  // Hide one destination's staged room: that portal's picture loses its detail, the other portals keep theirs.
  // The avatar stands in front of the middle portal, so that one is judged by how far its picture moves.
  const lines = [];
  const region = (seen, name) => seen.regions.find((candidate) => candidate.name === name);
  const moved = (a, b) => Math.max(...a.mean.map((value, axis) => Math.abs(value - b.mean[axis])));
  const names = rects.map((rect) => rect.name);
  const sides = names.filter((name) => name !== "location-airport");
  for (let index = 0; index < names.length; index += 1) {
    const name = names[index];
    const before = await analyse(await page.screenshot({ encoding: "base64" }), rects);
    await page.evaluate((index) => { const m = window.__x3domLiveMode; m.adapter.setVisible(m.portalGlue.debugDestSceneRoot(index), false); }, index);
    await sleep(3000);
    const hidden = await analyse(await page.screenshot({ encoding: "base64" }), rects);
    await page.evaluate((index) => { const m = window.__x3domLiveMode; m.adapter.setVisible(m.portalGlue.debugDestSceneRoot(index), true); }, index);
    await sleep(3000);
    lines.push(`${name} hidden: ${names.map((other) => `${other} groups ${region(before, other).distinct} to ${region(hidden, other).distinct}, moved ${moved(region(before, other), region(hidden, other))}`).join(", ")}`);
    const fail = (why) => new Error(`${kind} lobby: the picture in the portal to ${name} does not come from that destination's own room: ${why} (${lines[lines.length - 1]})`);
    // Not flat to the last pixel: the opening is see-through, so a little of the lobby shows behind it.
    if (sides.includes(name) && region(hidden, name).distinct > region(before, name).distinct * 0.6) throw fail("its picture stayed");
    if (!sides.includes(name) && moved(region(before, name), region(hidden, name)) <= 4) throw fail("its picture stayed");
    for (const other of sides.filter((candidate) => candidate !== name)) {
      if (region(hidden, other).distinct < region(before, other).distinct * 0.6) throw fail(`the portal to ${other} went flat too`);
    }
  }
  console.log(`      ${kind} own-destination test: ${lines.join("; ")}`);
}

// ---------------------------------------------------------------- X3D checks, one body for each engine
function x3dLobbyCheck(kind) {
  return async (ctx) => {
    const page = await openX3d(ctx, kind);
    await x3dWaitAvatar(ctx, page, kind);
    await sleep(ctx.planted ? 1500 : 5000);
    const state = await x3dState(page);
    assert.equal(state.active, kind, `${kind}: the page says another engine draws`);
    assert.equal(state.location, "location-lobby", `${kind}: a player must start in the lobby`);
    assert.equal(state.otherCanvases, 0, `${kind}: another canvas is drawing in the scene, so this is not the X3D path`);
    assert.equal(state.appLoaded, false, `${kind}: app.js ran`);
    try {
      await page.waitForFunction(() => window.__x3domLiveMode.portalGlue.previewDebugState().every((preview) => preview.ready), { timeout: ctx.patience ?? 45000 * SLOW });
    } catch {
      throw new Error(`${kind} lobby: a preview has no content: ${JSON.stringify((await x3dState(page)).previews)}`);
    }
    if (kind === "x3dom") {
      // X3DOM lights a texture like any surface, so each preview's plane is unlit, and nothing else is but the labels,
      // which face the viewer from a Billboard (web/hosted-access-label.mjs). Measured by its brightness below.
      const lit = await page.evaluate(() => ({
        previews: [...document.querySelectorAll("plane")].filter((plane) => plane.parentElement.querySelector("renderedtexture")).map((plane) => plane.getAttribute("lit")),
        unlit: [...document.querySelectorAll('[lit="false"]')].filter((node) => !node.closest("billboard")).length,
      }));
      assert.equal(lit.previews.length, 3, `x3dom lobby: a portal shows no preview: ${lit.previews.length} of the 3 portals' planes hold a rendered texture`);
      assert.ok(lit.previews.every((value) => value === "false"), `x3dom lobby: a preview's plane is lit (${JSON.stringify(lit.previews)})`);
      // The three previews' planes and the plain face of the fourth portal.
      assert.equal(lit.unlit, 4, `x3dom lobby: more than the portals' planes are unlit (${lit.unlit})`);
    }
    await sleep(ctx.planted ? 3000 : 2000);
    const rects = await x3dApertureRects(page);
    const seen = await snap(ctx, page, kind, "lobby", `Opened ?renderer=${kind}. The lobby is drawn by ${kind}, with three portals showing bounded previews, a fourth in a plain colour, and the avatar. No three.js canvas is on the page.`, rects, [], await floorPointsAhead(page));
    assertLooksLikeWorld(seen, `${kind} lobby`);
    assertTone(seen, "green", `${kind} lobby`);
    assert.ok(seen.bright > 0.004, `${kind} lobby: no bright portal rings on screen (${seen.bright})`);
    assert.ok(seen.middleDark > 150, `${kind} lobby: the avatar is not on screen (${seen.middleDark} dark pixels in the middle)`);
    assert.equal(state.previews.length, 3, `${kind} lobby: expected three portal previews`);
    // The avatar stands in front of the middle portal, so only the left and right ones are measured.
    console.log(`      ${kind} portal openings: ${seen.regions.map((region) => `${region.name} groups ${region.distinct}, black ${region.black}, mean rgb(${region.mean})`).join("; ")}`);
    for (const region of seen.regions.filter((candidate) => candidate.name !== "location-airport")) {
      assert.ok(region.black < 0.3, `${kind} lobby: the portal to ${region.name} renders black (${region.black} of it is black)`);
      assert.ok(region.distinct >= MIN_PREVIEW_COLOUR_GROUPS, `${kind} lobby: the portal to ${region.name} shows no preview, only a flat tint (${region.distinct} colour groups, mean rgb(${region.mean}))`);
      // Unlit, Location A's preview reads blue well above this. Lit by the room, it reads far below.
      if (kind === "x3dom" && region.name === "location-a") assert.ok(region.mean[2] >= X3DOM_UNLIT_PREVIEW_MIN_BLUE, `x3dom lobby: the preview to ${region.name} is as dark as a lit one, mean rgb(${region.mean})`);
    }
    await assertPreviewsShowOwnDestination(ctx, page, kind, rects);
    await assertAssetsAskedOfOwner(page, kind);
    const before = state.position;
    await page.keyboard.down("KeyW");
    await sleep(ctx.planted ? 800 : 1600);
    await page.keyboard.up("KeyW");
    await sleep(300);
    const after = await x3dState(page);
    assert.ok(Math.hypot(after.position[0] - before[0], after.position[2] - before[2]) > 0.1, `${kind}: the W key did not move the avatar (${before} to ${after.position})`);
    await snap(ctx, page, kind, "lobby-after-w-key", `Held W. The avatar walked from z=${before[2].toFixed(2)} to z=${after.position[2].toFixed(2)} and the camera followed.`);
    const headBefore = await page.evaluate(() => window.__x3domLiveMode.equipmentGlue.equipped().head?.item?.itemId);
    await page.click("#btn-x3dom-equip-head");
    await sleep(300);
    const headAfter = await page.evaluate(() => window.__x3domLiveMode.equipmentGlue.equipped().head?.item?.itemId);
    assert.notEqual(headAfter, headBefore, `${kind}: the equipment button did not change the head item (${headBefore})`);
    await page.keyboard.press("KeyC");
    await sleep(300);
    const mode = await page.evaluate(() => window.__x3domLiveMode.camera.mode());
    assert.equal(mode, "first_person", `${kind}: the C key did not switch to first person`);
    await snap(ctx, page, kind, "lobby-first-person", `Clicked the Head button (${headBefore} became ${headAfter}) and pressed C. The camera is in first person and the avatar is hidden.`);
    await page.close();
    return `lobby drawn, colour groups ${seen.distinct}, avatar and portals on screen`;
  };
}

function x3dCrossingCheck(kind) {
  return async (ctx) => {
    for (const [target, tone, name] of [["location-a", "blue", "location-a-crossed"], ["location-b", "brown", "location-b-crossed"]]) {
      const page = await openX3d(ctx, kind);
      await sleep(ctx.planted ? 500 : 2500);
      const lobby = await analyse(await page.screenshot({ encoding: "base64" }), [], [], await floorPointsAhead(page));
      assertTone(lobby, "green", `${kind} lobby before crossing`);
      await x3dCross(page, kind, target);
      // The same wait with and without a planted fault: the camera eases for a while after a crossing,
      // and what it hides or fails to hide shows only once it has come to rest.
      await sleep(3500);
      await x3dCameraAtRest(page);
      await sleep(1500);
      const state = await x3dState(page);
      assert.equal(state.location, target, `${kind}: wrong world after the crossing`);
      const seen = await snap(ctx, page, kind, name, `Walked through the lobby's portal to ${target}. The world server recorded the crossing, the room was rebuilt, and the header reads "${state.title}".`, await x3dApertureRects(page), await x3dRingPoints(page));
      assertLooksLikeWorld(seen, `${kind} ${target}`);
      assertTone(seen, tone, `${kind} room after crossing to ${target}`);
      assertPortalRings(seen, `${kind} ${target}`);
      console.log(`      ${kind} ${target} openings: ${seen.regions.map((region) => `${region.name} mean rgb(${region.mean}), black ${region.black}`).join("; ")}`);
      // The camera lands behind the portal it came out of. From there the opening shows this room, not a
      // picture of the destination, as in three.js: the preview surface must be off.
      const seenFromBehind = state.previews.filter((preview) => preview.cameraBehind);
      assert.ok(seenFromBehind.length > 0, `${kind} ${target}: the camera is not behind any portal, so the arrival has changed`);
      for (const preview of seenFromBehind) assert.ok(preview.apertureHidden, `${kind} ${target}: a preview covers the opening of the portal to ${preview.target} from behind`);
      console.log(`      ${kind} ${target} rings: ${seen.rings.map((ring) => `${ring.name} ${ring.hits}/${ring.onScreen}`).join("; ")}`);
      await assertAssetsAskedOfOwner(page, kind);
      await page.close();
    }
    return "lobby to Location A and lobby to Location B crossed, rooms redrawn";
  };
}

// Points on the floor ahead of the avatar and to its right, as the camera faces, on screen. The lower corners of a
// room's first view can hold its large restricted and hidden demo objects (runtime-state.js demoDefaultSceneObjects);
// this floor is clear of them in the Lobby, in Location B and where the way back from the soft-body world lands.
const floorPointsAhead = (page) => page.evaluate(() => {
  const { adapter, liveAdapter, camera } = window.__x3domLiveMode;
  const [x, , z] = liveAdapter.state.avatar.position;
  const pose = camera.currentPose();
  if (!pose) return [];
  const fx = pose.lookAt[0] - pose.position[0], fz = pose.lookAt[2] - pose.position[2];
  const length = Math.hypot(fx, fz) || 1;
  const [ax, az] = [fx / length, fz / length];
  const points = [];
  for (const [side, ahead] of [[0.7, 1.3], [0.9, 1.8], [0.6, 2.4]]) {
    const p = adapter.worldToScreen(adapter.camera, [x + ax * ahead - az * side, 0, z + az * ahead + ax * side]);
    if (p && p.visible && p.x >= 0 && p.y >= 0 && p.x < innerWidth && p.y < innerHeight) points.push([p.x, p.y]);
  }
  return points;
});

// Points on the airport's concourse floor, 1 m out from each side of the runner and 3 to 7 m ahead of the avatar, on
// screen. The floor and the runner are the world's own walkable surfaces, as the airport scene draws them.
const airportFloorPoints = (page) => page.evaluate(async () => {
  const { adapter, liveAdapter } = window.__x3domLiveMode;
  const { createAirportWalkableSurfaceContract } = await import("/airport-walkable-surface.mjs");
  const { surfaces } = createAirportWalkableSurfaceContract(liveAdapter.wowResolved().graph);
  const floor = surfaces.find((surface) => surface.render_material === "floor");
  const runner = surfaces.find((surface) => surface.render_material === "runner");
  const top = floor.center_m[1] + floor.size_m[1] / 2;
  const z = liveAdapter.state.avatar.position[2];
  const points = [];
  for (const side of [-1, 1]) {
    for (const ahead of [3, 4, 5, 6, 7]) {
      const p = adapter.worldToScreen(adapter.camera, [runner.center_m[0] + side * (runner.size_m[0] / 2 + 1), top, z + ahead]);
      if (p && p.visible && p.x >= 0 && p.y >= 0 && p.x < innerWidth && p.y < innerHeight) points.push([p.x, p.y]);
    }
  }
  return points;
});

function x3dAirportCheck(kind) {
  return async (ctx) => {
    const page = await openX3d(ctx, kind);
    await sleep(ctx.planted ? 500 : 2500);
    await x3dCross(page, kind, "location-airport");
    await sleep(ctx.planted ? 3000 : 6000);
    const state = await x3dState(page);
    assert.equal(state.location, "location-airport", `${kind}: wrong world after Portal C`);
    const parts = await page.evaluate(() => {
      const m = window.__x3domLiveMode;
      if (m.kind !== "x3dom") return { mounted: null, bare: 0 };
      const content = document.querySelector("#x3dom-host transform[render]") && [...document.querySelectorAll("#x3dom-host shape")];
      const bare = content.filter((shape) => !shape.querySelector(":scope > appearance") && !shape.closest("inline")).length;
      return { bare, shapes: content.length };
    });
    if (kind === "x3dom") assert.equal(parts.bare, 0, `x3dom airport: ${parts.bare} shapes without appearance, drawn white`);
    const seen = await snap(ctx, page, kind, "denver-skyport-crossed", `Walked through Portal C. The airport's building is drawn: floor, walls, columns, signs, storefronts and gate. No travelers, staff or manifest cards.`);
    assertLooksLikeWorld(seen, `${kind} airport`);
    await x3dMoveTo(page, 0, 18);
    await sleep(ctx.planted ? 500 : 2500);
    await x3dCameraAtRest(page);
    // Measured after walking on, on the concourse floor beside the blue runner. On arrival the return portal's ring
    // fills the lower corners, and X3DOM's camera sits close enough that they show the runner, whose blue passed for grey.
    const floorPoints = await airportFloorPoints(page);
    assert.ok(floorPoints.length >= 6, `${kind} airport: the floor beside the runner is not in view (${floorPoints.length} of 10 points on screen)`);
    const onward = await snap(ctx, page, kind, "denver-skyport-concourse", "Walked on along the concourse. The floor colour is read on the concourse floor on both sides of the blue runner, 3 to 7 m ahead.", [], [], floorPoints);
    assertTone(onward, "grey", `${kind} airport is dark or the wrong colour`);
    await page.close();
    return "Portal C crossed, the airport's building drawn";
  };
}

function worldCheck(kind) {
  return async (ctx) => {
    const openWorld = async () => {
      const page = await openPage(ctx.browser, ctx.rules);
      await page.goto(`${BASE}/x3d-world.html?renderer=${kind}`, { waitUntil: "domcontentloaded", timeout: 30000 * SLOW });
      try {
        await page.waitForFunction(() => document.body.dataset.x3dWorldReady === "1" || document.body.dataset.x3dWorldError, { timeout: ctx.patience ?? 45000 * SLOW });
      } catch {
        throw new Error(`${kind}: the X3D JSON world page did not finish loading`);
      }
      const error = await page.evaluate(() => document.body.dataset.x3dWorldError);
      if (error) throw new Error(`${kind}: the X3D JSON world did not load: ${error}`);
      await sleep(ctx.planted ? 800 : 2500);
      return page;
    };
    const arrive = async (page, how) => {
      try {
        await page.waitForFunction(() => window.__x3domLiveMode?.liveAdapter?.world?.location_id, { timeout: ctx.patience ?? 45000 * SLOW });
      } catch {
        throw new Error(`${kind}: the Anchor ${how} did not arrive in a lab world (page is ${page.url()})`);
      }
      const state = await x3dState(page);
      assert.equal(state.location, "location-b", `${kind}: the Anchor ${how} arrived in the wrong world`);
      assert.equal(state.active, kind, `${kind}: the crossing lost the renderer`);
      // Location B, by what the page and the world server say, not by colour.
      assert.equal(state.path, "/w/b/", `${kind}: the Anchor ${how} landed on ${state.path}`);
      assert.equal(state.worldId, "demo-room-b", `${kind}: the Anchor ${how} landed in world ${state.worldId}`);
      assert.equal(state.endpointKey, "b", `${kind}: the Anchor ${how} talks to world server ${state.endpointKey}`);
      assert.match(state.title || "", /^Location B/, `${kind}: the header after the Anchor ${how} reads "${state.title}"`);
      assert.deepEqual([...state.portalTargets].sort(), ["location-a", "location-lobby"], `${kind}: the Anchor ${how} landed in a world with other portals`);
      return state;
    };
    let page = await openWorld();
    const seen = await snap(ctx, page, kind, "x3d-json-world", "Opened x3d-world.html. The X3D JSON world is drawn from its file: floor, wall, columns and an orange disc inside an X3D Anchor.");
    assertLooksLikeWorld(seen, `${kind} X3D JSON world`);
    const anchorUrl = await page.evaluate(() => window.__x3dWorld.anchorUrl);
    assert.match(anchorUrl, /^\/w\/b\//, `${kind}: the Anchor url is not the Location B address`);
    // The disc sits in the middle of the view, a little above centre. A real mouse click.
    await page.mouse.move(640, 390);
    await sleep(600);
    await page.mouse.down();
    await sleep(120);
    await page.mouse.up();
    await arrive(page, "click");
    await sleep(4000);
    const crossed = await snap(ctx, page, kind, "x3d-json-anchor-clicked", `Clicked the disc with the mouse. The browser went to ${anchorUrl} and Location B opened under ${kind}, with its own room colour.`, [], [], await floorPointsAhead(page));
    assertTone(crossed, "brown", `${kind} after the Anchor click (a direct load of Location B)`);
    await page.close();

    page = await openWorld();
    await page.keyboard.down("KeyW");
    let via = null;
    for (let i = 0; i < 400 && !via; i += 1) {
      via = await page.evaluate(() => document.body?.dataset.x3dWorldCrossing || window.__x3domLiveMode?.kind || null).catch(() => null);
      await sleep(100);
    }
    await page.keyboard.up("KeyW").catch(() => {});
    if (!via) throw new Error(`${kind}: the walk did not cross; the camera reached ${JSON.stringify(await page.evaluate(() => window.__x3dWorld.cameraPosition))}`);
    await arrive(page, "walk-in");
    await sleep(ctx.planted ? 500 : 3000);
    await snap(ctx, page, kind, "x3d-json-walked-through", `Reloaded the world and held W until the camera entered the ${kind === "x_ite" ? "world's ProximitySensor" : "ProximitySensor's box, tested by the page"}. Location B opened under ${kind}.`);
    await page.close();
    return "the world loaded; the Anchor crossed by click and by walking in";
  };
}

// ---------------------------------------------------------------- three.js checks
const threeDefaultCheck = async (ctx) => {
  const rendererFiles = [];
  let page = await openThree(ctx, "", (opened) => opened.on("request", (request) => { if (/render-adapter|\/x3dom|\/x_ite|x3d-world|x-ite-live/.test(request.url())) rendererFiles.push(request.url()); }));
  let state = await threeState(page);
  assert.equal(state.choice, null, "default: the page read a renderer switch with none in its address");
  assert.ok(!state.x3dHost && !state.x3dEngine && !state.x3dLiveMode, "default: X3D is on the page");
  assert.deepEqual(rendererFiles, [], `default: the page loaded a renderer file: ${rendererFiles.slice(0, 3).join(", ")}`);
  assert.deepEqual([...state.portalTargets].sort(), ["location-a", "location-airport", "location-b"], `default: the Lobby's portals are ${state.portalTargets}`);
  let seen = await snap(ctx, page, "three", "default-lobby", "Opened the lab with no switch. three.js draws the lobby with its three portals. No renderer file was loaded.");
  assertLooksLikeWorld(seen, "three.js default lobby");
  await page.close();
  page = await openThree(ctx, "&renderer=three");
  state = await threeState(page);
  assert.equal(state.choice, "three", "?renderer=three did not report three.js");
  assert.equal(state.notice, null, `?renderer=three: a notice on the page (${state.notice})`);
  seen = await snap(ctx, page, "three", "renderer-three-lobby", "Opened ?renderer=three. The same lobby, on the same path.");
  assertLooksLikeWorld(seen, "?renderer=three lobby");
  await page.close();
  page = await openThree(ctx, "&renderer=babylon");
  state = await threeState(page);
  assert.equal(state.choice, "three", "unknown renderer: three.js must draw");
  assert.ok(state.notice && /Unknown renderer/.test(state.notice), `unknown renderer: no notice on the page (${state.notice})`);
  await snap(ctx, page, "three", "unknown-renderer-notice", `Opened ?renderer=babylon. three.js draws and the page says: ${state.notice}`);
  await page.close();
  return "the default loads no renderer file; ?renderer=three and an unknown renderer behave";
};
const threeCrossingCheck = async (ctx) => {
  for (const [target, name] of [["location-a", "location-a-crossed"], ["location-b", "location-b-crossed"], ["location-airport", "denver-skyport-crossed"]]) {
    const page = await openThree(ctx, "");
    await threeCross(page, target);
    await sleep(2500);
    const state = await threeState(page);
    assert.equal(state.location, target, "three.js: wrong world after crossing");
    assert.equal(state.choice, null, `three.js: ${target} reads a renderer switch`);
    const seen = await snap(ctx, page, "three", name, `Walked through the lobby's portal to ${target}. three.js draws it.`);
    assertLooksLikeWorld(seen, `three.js ${target}`);
    if (target === "location-b") assertTone(seen, "brown", "three.js room after crossing to location-b");
    await page.close();
  }
  return "lobby to Location A, Location B and Denver Skyport crossed";
};

// ---------------------------------------------------------------- files
async function importAdapters(dir) {
  // Imported by file URL so that a planted copy can be checked the same way.
  // No cache-busting stamp: registry.mjs imports render-adapter.mjs by its plain url, and a stamped copy
  // here would be a second RenderAdapter class, on which missingAdapterMethods can never find a gap.
  // A planted copy has its own temporary folder, so it has its own urls anyway.
  const boundary = await import(pathToFileURL(join(dir, "render-adapter.mjs")).href);
  const registry = await import(pathToFileURL(join(dir, "registry.mjs")).href);
  return { boundary, registry };
}
function plantedAdapterDir(fileName, find, replace) {
  const dir = mkdtempSync(join(tmpdir(), "renderer-proof-adapters-"));
  cpSync(RA, dir, { recursive: true });
  const file = join(dir, fileName);
  const text = readFileSync(file, "utf8");
  assert.ok(text.includes(find), `planted fault did not apply to ${fileName}`);
  writeFileSync(file, text.replace(find, replace));
  return dir;
}
const boundaryCheck = async (ctx) => {
  const { boundary, registry } = await importAdapters(ctx.adapterDir || RA);
  const THREE = await import(pathToFileURL(join(CODE, "node_modules", "three", "build", "three.module.js")).href);
  const pick = (search) => registry.chooseRenderAdapter(THREE, search);
  assert.equal(pick("").active.kind, "three", "the default is not three.js");
  assert.equal(pick("").reason, "default", "the default is not reported as default");
  assert.equal(pick("?renderer=three").active.kind, "three", "?renderer=three");
  assert.equal(pick("?renderer=x3dom").active.kind, "x3dom", "?renderer=x3dom");
  assert.equal(pick("?renderer=x_ite").active.kind, "x_ite", "?renderer=x_ite");
  assert.equal(pick("?renderer=X-ITE").active.kind, "x_ite", "alias x-ite");
  const unknown = pick("?renderer=babylon");
  assert.equal(unknown.active.kind, "three", "unknown renderer must draw with three.js");
  assert.match(unknown.message, /Unknown renderer/, "unknown renderer must say so");
  for (const hostile of ["constructor", "__proto__", "toString"]) {
    assert.equal(boundary.rendererKindFromSearch(`?renderer=${hostile}`), null, `${hostile} must count as unknown`);
  }
  const gaps = {};
  for (const [kind, AdapterClass] of Object.entries(registry.RENDER_ADAPTER_CLASSES)) {
    const missing = boundary.missingAdapterMethods(AdapterClass);
    gaps[kind] = missing;
    assert.deepEqual(missing, [], `the ${kind} adapter is missing ${missing.join(", ")}`);
  }
  return `${boundary.RENDER_ADAPTER_METHODS.length} interface members, every adapter covers them all`;
};

function sha256(file) { return createHash("sha256").update(readFileSync(file)).digest("hex"); }
function walk(dir, skip = () => false) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (skip(full)) continue;
    if (statSync(full).isDirectory()) out.push(...walk(full, skip));
    else out.push(full);
  }
  return out;
}
const creditCheck = async (ctx) => {
  const thirdParty = ctx.noticesText || readFileSync(join(CODE, "THIRD_PARTY_NOTICES.md"), "utf8");
  const page = readFileSync(join(CODE, "web", "renderer-lane.html"), "utf8");
  for (const [label, text] of [["THIRD_PARTY_NOTICES.md", thirdParty], ["the renderer page", page]]) {
    assert.match(text, /Nicholas Polys/, `${label} do not credit Nicholas Polys`);
    assert.match(text, /ef702ec/, `${label} do not name commit ef702ec`);
    assert.match(text, /Holger Seelig/, `${label} do not credit X_ITE's author`);
    assert.match(text, /X3DOM\b[\s\S]{0,120}\bMIT\b/, `${label} do not give X3DOM's licence`);
    assert.match(text, /X_ITE\b[\s\S]{0,120}\bMIT\b/, `${label} do not give X_ITE's licence`);
  }
  const ported = [
    "web/x3dom-airport-terminal-scene.mjs", "web/x3dom-equipment-glue.mjs", "web/x3dom-gltf-humanoid-provider.mjs", "web/x3dom-hud-glue.mjs", "web/x3dom-live-mode.mjs",
    "web/x3dom-movement-camera-controller.mjs", "web/x3dom-peer-avatars-glue.mjs", "web/x3dom-portal-hosted-objects.mjs", "web/x3dom-portal-traversal-glue.mjs",
    "runtime/scene-core/public/render-adapter/render-adapter.mjs", "runtime/scene-core/public/render-adapter/three-render-adapter.mjs", "runtime/scene-core/public/render-adapter/spatial-math.mjs",
    "runtime/scene-core/public/render-adapter/x3dom-render-adapter.mjs", "runtime/scene-core/public/render-adapter/x3dom-inline-pool.js",
  ];
  for (const file of ported) {
    assert.match(readFileSync(join(ctx.codeRoot || CODE, file), "utf8").slice(0, 400), /Nicholas Polys/, `${file} does not credit Nicholas Polys in its header`);
  }
  // Licences and versions, from the files themselves.
  const x3domDir = join(PUB, "vendor", "x3dom");
  const xiteDir = join(PUB, "vendor", "x_ite");
  const x3domVersion = readFileSync(x3domDir + "/VERSION", "utf8").replace(/^﻿/, "");
  const x3domPackage = JSON.parse(readFileSync(x3domDir + "/package.json", "utf8"));
  const x3domLicence = readFileSync(x3domDir + "/LICENSE.md", "utf8");
  const xitePackage = JSON.parse(readFileSync(ctx.xitePackage || xiteDir + "/package.json", "utf8"));
  const xiteLicence = readFileSync(xiteDir + "/LICENSE.md", "utf8");
  assert.match(x3domVersion, /^1\.8\.3/, `X3DOM VERSION file says ${x3domVersion}`);
  assert.equal(x3domPackage.version, "1.8.3", "X3DOM package.json version");
  assert.match(x3domLicence, /dual licensed under the MIT and GPL/, "X3DOM LICENSE.md");
  assert.equal(xitePackage.version, "16.6.0", `X_ITE package.json says ${xitePackage.version}`);
  assert.equal(xitePackage.license, "MIT", "X_ITE package.json licence");
  assert.match(xiteLicence, /MIT License/, "X_ITE LICENSE.md");
  const { X3DOMRenderAdapter } = await import(pathToFileURL(join(RA, "x3dom-render-adapter.mjs")).href);
  const { XIteRenderAdapter } = await import(pathToFileURL(join(RA, "x-ite-render-adapter.mjs")).href);
  assert.equal(X3DOMRenderAdapter.info.version, "1.8.3", "the X3DOM adapter names another version");
  assert.equal(XIteRenderAdapter.info.version, "16.6.0", "the X_ITE adapter names another version");
  for (const fact of ["1.8.3", "16.6.0", "Apache-2.0", "MIT", "99175b4b6"]) assert.ok(thirdParty.includes(fact), `the notices do not state ${fact}`);
  // Nothing the lab serves of X_ITE carries or mentions the non-commercial text, and the pictures of unstated origin stay out.
  const xiteServed = [...walk(xiteDir), ...(ctx.xiteExtraFiles || [])];
  for (const file of xiteServed) {
    const name = relative(xiteDir, file);
    assert.ok(!/CC-BY-NC|assets\/hatching\/|assets\/linetype\/|assets\/images\/(?!logo\.svg$)/.test(file), `a file left out of the X_ITE copy is back: ${name}`);
    assert.ok(!/CC-BY-NC|BY-NC-4|NonCommercial|Non-Commercial/.test(readFileSync(file, "latin1")), `a served X_ITE file mentions the non-commercial licence: ${name}`);
    assert.ok(!LEFT_OUT_OF_XITE.includes(file.split(/[\\/]/).pop()), `a file left out of the X_ITE copy for its licence is back: ${name}`);
  }
  const bundled = ctx.bundledNotices ?? readFileSync(join(xiteDir, "THIRD-PARTY-IN-BUNDLES.md"), "utf8");
  for (const library of BUNDLED_IN_XITE) assert.ok(bundled.includes(library), `vendor/x_ite/THIRD-PARTY-IN-BUNDLES.md does not name ${library}`);
  // The engines on disk are the downloaded bytes.
  assert.equal(sha256(ctx.x3domFile || join(x3domDir, "x3dom-full.js")), DOWNLOADED_SHA256["x3dom/x3dom-full.js"], "x3dom-full.js is not the downloaded file");
  assert.equal(sha256(join(xiteDir, "x_ite.min.mjs")), DOWNLOADED_SHA256["x_ite/x_ite.min.mjs"], "x_ite.min.mjs is not the downloaded file");
  return "credit in every ported file, the notices and the page; versions and licences match the files";
};
const worldFileCheck = async (ctx) => {
  const world = JSON.parse(ctx.worldText || readFileSync(join(CODE, "web", "x3d-worlds", "anchor-portal-world.x3d.json"), "utf8"));
  const find = (value, type) => {
    if (!value || typeof value !== "object") return null;
    if (Array.isArray(value)) { for (const item of value) { const hit = find(item, type); if (hit) return hit; } return null; }
    if (value[type]) return value[type];
    for (const child of Object.values(value)) { const hit = find(child, type); if (hit) return hit; }
    return null;
  };
  assert.equal(world.X3D["@version"], "4.0", "not X3D 4.0");
  const anchor = find(world.X3D.Scene, "Anchor");
  assert.ok(anchor, "the world has no X3D Anchor");
  assert.equal(anchor["@url"][0], "/w/b/", "the Anchor url is not the Location B world address");
  assert.ok(!/renderer=/.test(JSON.stringify(world)), "the world file names a renderer");
  assert.ok(find(world.X3D.Scene, "ProximitySensor"), "the world has no ProximitySensor trigger");
  return "X3D 4.0, Anchor to /w/b/, ProximitySensor trigger, no renderer named";
};
const excludedFilesCheck = async (ctx) => {
  const skip = (path) => /node_modules|\.runtime/.test(path);
  const files = [...walk(join(CODE, "web"), skip), ...walk(join(CODE, "tools"), skip), ...walk(join(CODE, "runtime", "scene-core"), skip), ...(ctx.extraFiles || [])];
  const banned = files.filter((file) => /(^|\/)(NNotes\.txt|bash\.cmd|run-bash\.ps1|RELEASE-MANIFEST\.json|generate-release-manifest\.mjs|_scratch[^/]*|_tmp_[^/]*)$/.test(file) || /\/\.claude\//.test(file));
  assert.deepEqual(banned, [], `personal or scratch files came in: ${banned.join(", ")}`);
  // The humanoid and its texture have no stated source. They stay out, and nothing the lab loads refers to them.
  const leftOut = /(^|\/)(HumanoidComplete[^/]*\.json|gramps_2_outfit1_diffuse[^/]*\.png)$/;
  const back = files.filter((file) => leftOut.test(file));
  assert.deepEqual(back, [], `a file left out came back: ${back.join(", ")}`);
  const hisOwn = join(CODE, "web", "worlds", "soft-body.json");
  const refers = files.filter((file) => /\.(?:json|mjs|js|html)$/.test(file) && file !== hisOwn && !file.startsWith(join(PUB, "vendor")) && !file.includes("/assets/") && /HumanoidComplete|gramps_2_outfit1|GrampsSkin/.test(readFileSync(file, "utf8")) && !file.endsWith("tools/renderer/proof.mjs"));
  assert.deepEqual(refers, [], `a file still refers to the humanoid: ${refers.join(", ")}`);
  return `${files.length} files looked at, none of Nicholas's personal or scratch files, no humanoid and nothing that loads it`;
};
const rendererPageCheck = async (ctx) => {
  const page = await openPage(ctx.browser, ctx.rules);
  await page.goto(`${BASE}/renderer-lane.html`, { waitUntil: "networkidle2", timeout: 45000 * SLOW });
  const content = await page.evaluate(() => ({
    links: Object.fromEntries([...document.querySelectorAll("a[id^=link-]")].map((a) => [a.id, a.getAttribute("href")])),
    adapters: [...document.querySelectorAll(".adapter")].map((row) => row.dataset.adapter),
    text: document.body.innerText,
  }));
  assert.match(content.text, /Nicholas Polys/, "the renderer page does not credit Nicholas Polys");
  assert.match(content.text, /ef702ec/, "the renderer page does not name ef702ec");
  assert.deepEqual(content.adapters, ["three", "x3dom", "x_ite"], "the renderer page does not list the three engines");
  for (const id of ["link-default", "link-x3dom", "link-x_ite", "link-world-x_ite", "link-world-x3dom"]) assert.ok(content.links[id], `the renderer page has no ${id}`);
  assert.match(content.text, /falls short|short of three/i, "the renderer page does not say where the engines fall short");
  await snap(ctx, page, "three", "renderer-page", "Opened the renderer page. It lists every link, the three engines, the credit and the shortfalls.");
  await page.close();
  return `${Object.keys(content.links).length} links, three engines, credit and shortfalls present`;
};
const clientChecks = async (ctx) => {
  const env = ctx.nodeOption ? { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS || ""} --require ${ctx.nodeOption}` } : process.env;
  const result = spawnSync("npm", ["run", "-s", "check:client"], { cwd: CODE, encoding: "utf8", timeout: 600000 * SLOW, env });
  const tail = `${result.stdout}\n${result.stderr}`.trim().split("\n").slice(-3).join(" | ");
  assert.equal(result.status, 0, `npm run check:client failed: ${tail}`);
  return tail.slice(0, 200);
};

// ---------------------------------------------------------------- John Carlson's soft-body world
const SOFT_SERIES = "soft-body";
const softWorldPath = "x3d-worlds/soft-body.x3d.json";
const softWorldQuery = (kind, extra = "") => `x3d-world.html?world=soft-body.x3d.json&renderer=${kind}${extra}`;
const isOutside = (url) => !url.startsWith(BASE) && !url.startsWith("data:") && !url.startsWith("blob:") && !url.startsWith("chrome");

function watchPage(page) {
  page.__outside = [];
  page.__consoleErrors = [];
  page.__answers = new Map();
  page.on("request", (request) => { if (isOutside(request.url())) page.__outside.push(request.url()); });
  page.on("console", (message) => { if (message.type() === "error") page.__consoleErrors.push(message.text()); });
  page.on("response", (response) => page.__answers.set(new URL(response.url()).pathname, response.status()));
}
async function waitSoftWorld(ctx, page, kind) {
  try {
    await page.waitForFunction(() => document.body.dataset.x3dWorldReady === "1" || document.body.dataset.x3dWorldError, { timeout: ctx.patience ?? 90000 * SLOW });
  } catch {
    throw new Error(`${kind}: the soft-body world did not finish loading (page is ${page.url()})`);
  }
  const error = await page.evaluate(() => document.body.dataset.x3dWorldError);
  if (error) throw new Error(`${kind}: the soft-body world did not load: ${error}`);
}
async function openSoftWorld(ctx, kind, extra = "") {
  const page = await openPage(ctx.browser, ctx.rules);
  watchPage(page);
  await page.goto(`${BASE}/${softWorldQuery(kind, extra)}`, { waitUntil: "domcontentloaded", timeout: 30000 * SLOW });
  await waitSoftWorld(ctx, page, kind);
  return page;
}
// What Bullet holds and what the engine holds, boiled down in the page: positions are many.
const softSample = (page) => page.evaluate(() => {
  const s = window.__x3dWorld.physics.sample();
  const cloth = s.soft.Cloth, ball = s.soft.SquishyBall;
  const gap = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const centreOf = (points) => [0, 1, 2].map((axis) => points.reduce((sum, p) => sum + p[axis], 0) / points.length);
  return {
    steps: s.steps, simSeconds: s.simSeconds, widestBallSpread: s.widestBallSpread, rigid: s.rigid,
    cloth: cloth.positions, ball: ball.positions, ballCentre: ball.centre,
    clothDrawnGap: Math.max(...cloth.positions.map((p, i) => gap(p, cloth.drawn[i]))),
    ballDrawnGap: gap(ball.centre, centreOf(ball.drawn)),
    clothCount: cloth.count, ballCount: ball.count,
  };
});
// The largest change, between two samples, in the distance between two nodes of the same body. A rigid move changes none.
function largestStretch(a, b) {
  let most = 0;
  const pairs = Math.min(a.length, 400);
  for (let n = 0; n < pairs; n += 1) {
    const i = (n * 7919) % a.length, j = (n * 104729 + 13) % a.length;
    const before = Math.hypot(a[i][0] - a[j][0], a[i][1] - a[j][1], a[i][2] - a[j][2]);
    const after = Math.hypot(b[i][0] - b[j][0], b[i][1] - b[j][1], b[i][2] - b[j][2]);
    most = Math.max(most, Math.abs(after - before));
  }
  return most;
}
const largestMove = (a, b) => Math.max(...a.map((p, i) => Math.hypot(p[0] - b[i][0], p[1] - b[i][1], p[2] - b[i][2])));
async function picturesDiffer(aBase64, bBase64) {
  return analysisPage.evaluate(async (a, b) => {
    const read = async (b64) => {
      const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type: "image/png" }));
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext("2d", { willReadFrequently: true });
      context.drawImage(bitmap, 0, 0);
      return { data: context.getImageData(0, 0, bitmap.width, bitmap.height).data, W: bitmap.width, H: bitmap.height };
    };
    const first = await read(a), second = await read(b);
    let changed = 0, total = 0;
    for (let y = 0; y < first.H; y += 2) {
      for (let x = 0; x < first.W; x += 2) {
        const i = 4 * (y * first.W + x);
        total += 1;
        if (Math.abs(first.data[i] - second.data[i]) + Math.abs(first.data[i + 1] - second.data[i + 1]) + Math.abs(first.data[i + 2] - second.data[i + 2]) > 30) changed += 1;
      }
    }
    return changed / total;
  }, aBase64, bBase64);
}
const softSnap = (ctx, page, name, detail) => snap(ctx, page, SOFT_SERIES, name, detail);

function softWorldLoadCheck(kind) {
  return async (ctx) => {
    const page = await openSoftWorld(ctx, kind);
    await sleep(ctx.planted ? 1500 : 6000);
    const state = await page.evaluate(() => ({
      anchorUrl: window.__x3dWorld.anchorUrl, kind: window.__x3dWorld.kind, physics: !!window.__x3dWorld.physics, status: window.__x3dWorld.physics?.status,
      hud: document.getElementById("hud").innerText, soft: Object.keys(window.__x3dWorld.physics?.sample().soft || {}),
    }));
    assert.equal(state.kind, kind, `${kind}: the page runs another engine`);
    assert.ok(state.physics, `${kind}: the world has no physics running`);
    assert.deepEqual(state.soft.sort(), ["Cloth", "SquishyBall"], `${kind}: the world's soft bodies are ${state.soft}`);
    assert.match(state.hud, /John Carlson/, `${kind}: the world's page does not credit John Carlson`);
    assert.match(state.anchorUrl, new RegExp(`^/w/lobby/\\?renderer=${kind}`), `${kind}: the Anchor url is ${state.anchorUrl}`);
    assert.deepEqual(page.__outside, [], `${kind}: the world asked outside the lab: ${page.__outside.slice(0, 2).join(", ")}`);
    const unknown = page.__consoleErrors.filter((text) => /Unknown node type/.test(text));
    assert.deepEqual(unknown, [], `${kind}: the engine was given a node it does not know: ${unknown[0]}`);
    const asked = [...page.__answers.keys()].filter((path) => /HumanoidComplete|gramps_2/.test(path));
    assert.deepEqual(asked, [], `${kind}: the world asked for the humanoid: ${asked.join(", ")}`);
    const seen = await softSnap(ctx, page, `${kind}-world-loaded`, `Opened x3d-world.html?world=soft-body.json under ${kind}. John Carlson's world, without his humanoid, is drawn by ${kind} from the lab's adjusted copy of his file: the brick wall, the arm on its pylon with the cloth, his text and the orange disc that goes back to the Lobby. ${state.status.rigidCount} rigid bodies and ${state.status.softCount} soft bodies in one Bullet world. Nothing was asked of any address outside the lab.`);
    assertLooksLikeWorld(seen, `${kind} soft-body world`);
    await page.close();
    return `${state.status.rigidCount} rigid and ${state.status.softCount} soft bodies, drawn by ${kind}, no request outside the lab`;
  };
}

function softMotionCheck(kind) {
  return async (ctx) => {
    const page = await openSoftWorld(ctx, kind);
    await page.waitForFunction(() => window.__x3dWorld.physics.status.steps > 0, { timeout: ctx.patience ?? 60000 * SLOW });
    const first = await softSample(page);
    const firstPicture = await page.screenshot({ encoding: "base64" });
    // The same 7 s with a planted fault: at 3 s the ball has not yet changed shape, so a later fault went red for that reason.
    const wanted = 7;
    try {
      await page.waitForFunction((wanted) => window.__x3dWorld.physics.status.simSeconds > wanted, { timeout: 150000 * SLOW }, wanted);
    } catch {
      throw new Error(`${kind}: the simulation did not reach ${wanted} s within 150 s`);
    }
    const second = await softSample(page);
    const secondPicture = await page.screenshot({ encoding: "base64" });
    const fell = first.ballCentre[1] - second.ballCentre[1];
    assert.ok(fell > 3, `${kind}: the ball did not fall: its centre went from y=${first.ballCentre[1].toFixed(2)} to y=${second.ballCentre[1].toFixed(2)}`);
    const clothMove = largestMove(first.cloth, second.cloth);
    const clothStretch = largestStretch(first.cloth, second.cloth);
    const ballStretch = largestStretch(first.ball, second.ball);
    assert.ok(second.widestBallSpread > 0.2 && ballStretch > 0.2, `${kind}: the ball kept its shape: widest spread ${second.widestBallSpread.toFixed(3)} m, largest change between two nodes ${ballStretch.toFixed(3)} m`);
    assert.ok(clothMove > 0.1 && clothStretch > 0.02, `${kind}: the cloth did not bend: largest node move ${clothMove.toFixed(3)} m, largest change between two nodes ${clothStretch.toFixed(3)} m`);
    // The top row is stitched to the arm, so the cloth hangs and does not fall to the floor.
    const clothTopY = Math.max(...second.cloth.slice(0, 36).map((p) => p[1]));
    assert.ok(clothTopY > 4.5, `${kind}: the cloth no longer hangs from the arm: its top row is at y=${clothTopY.toFixed(2)}`);
    assert.ok(second.clothDrawnGap < 0.6 && second.ballDrawnGap < 0.6, `${kind}: the engine's drawn points do not follow Bullet: cloth ${second.clothDrawnGap.toFixed(2)} m off, ball ${second.ballDrawnGap.toFixed(2)} m off`);
    const pictureChange = await picturesDiffer(firstPicture, secondPicture);
    assert.ok(pictureChange > 0.003, `${kind}: two frames ${(second.simSeconds - first.simSeconds).toFixed(1)} simulated seconds apart are the same picture (${pictureChange})`);
    await softSnap(ctx, page, `${kind}-ball-landed-cloth-hanging`, `Waited ${(second.simSeconds - first.simSeconds).toFixed(1)} simulated seconds. Measured under ${kind}: the ball's centre fell ${fell.toFixed(2)} m, from y=${first.ballCentre[1].toFixed(2)} to y=${second.ballCentre[1].toFixed(2)}, and it changed shape: two of its nodes changed their distance by up to ${ballStretch.toFixed(2)} m, and the widest gap between its nearest and farthest node from its centre reached ${second.widestBallSpread.toFixed(2)} m. A cloth node moved ${clothMove.toFixed(2)} m and two cloth nodes changed their distance by up to ${clothStretch.toFixed(2)} m. ${(pictureChange * 100).toFixed(1)} percent of the picture changed between the two times.`);
    // His own key: Q turns the arm's motor while it is held.
    const beforeKey = second;
    await page.keyboard.down("KeyQ");
    const heldFrom = (await softSample(page)).simSeconds;
    try {
      await page.waitForFunction((from, wanted) => window.__x3dWorld.physics.status.simSeconds > from + wanted, { timeout: 120000 * SLOW }, heldFrom, ctx.planted ? 1.5 : 3);
    } finally {
      await page.keyboard.up("KeyQ");
    }
    const third = await softSample(page);
    const [a, b] = [beforeKey.rigid.Arm.rotation, third.rigid.Arm.rotation];
    const dot = Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]));
    const armTurn = 2 * Math.acos(dot);
    const swing = largestMove(beforeKey.cloth, third.cloth);
    assert.ok(armTurn > 0.1, `${kind}: the Q key did not swing the arm: it turned ${armTurn.toFixed(3)} rad`);
    assert.ok(swing > 0.3, `${kind}: the arm turned and the cloth stayed: largest cloth move ${swing.toFixed(2)} m`);
    await softSnap(ctx, page, `${kind}-q-key-swings-arm`, `Held the Q key. The arm turned ${armTurn.toFixed(2)} rad on its hinge and a cloth node moved ${swing.toFixed(2)} m with it, under ${kind}.`);
    const summary = `${kind}: ball fell ${fell.toFixed(2)} m, two ball nodes changed distance by ${ballStretch.toFixed(2)} m, spread ${second.widestBallSpread.toFixed(2)} m; cloth node moved ${clothMove.toFixed(2)} m, two cloth nodes changed distance by ${clothStretch.toFixed(2)} m; Q turned the arm ${armTurn.toFixed(2)} rad, cloth node moved ${swing.toFixed(2)} m; picture changed ${(pictureChange * 100).toFixed(1)} percent; ${first.clothCount} cloth nodes, ${first.ballCount} ball nodes`;
    console.log(`      ${summary}`);
    await page.close();
    return summary;
  };
}

async function holdKeyUntil(page, code, done, why) {
  await page.keyboard.down(code);
  try {
    for (let i = 0; i < 600; i += 1) {
      if (await done()) return;
      await sleep(40);
    }
  } finally {
    await page.keyboard.up(code).catch(() => {});
  }
  throw new Error(why);
}
const SOFT_PAGE = /\/x3d-world\.html\?world=soft-body\.x3d\.json&renderer=/;
function softPortalCheck(kind) {
  return async (ctx) => {
    const page = await openX3d(ctx, kind);
    watchPage(page);
    await x3dWaitAvatar(ctx, page, kind);
    const start = await x3dState(page);
    assert.ok(!start.portalTargets.includes("location-softbody"), `${kind}: a world server lists a portal to the soft-body world (${start.portalTargets})`);
    const portal = await page.evaluate(() => window.__x3domLiveMode.portalGlue.x3dPortals().find((entry) => entry.portal_id === "lobby-portal-d"));
    assert.ok(portal, `${kind}: the Lobby has no fourth portal from the worlds file`);
    assert.equal(portal.x3d_world, "soft-body.x3d.json", `${kind}: the fourth portal opens ${portal.x3d_world}`);
    const frame = portal.position;
    await sleep(ctx.planted ? 500 : 2500);
    await softSnap(ctx, page, `${kind}-lobby-fourth-portal`, `Opened the Lobby under ${kind}. The worlds file gives it a fourth portal, to John Carlson's world, at x=${frame[0]}, z=${frame[2]}. It shows a plain colour and a sign. No world server lists it.`);
    // Real keys only: the page's position is read to know when to let go.
    const avatarX = () => page.evaluate(() => window.__x3domLiveMode.liveAdapter.state.avatar.position[0]);
    await holdKeyUntil(page, "KeyD", async () => (await avatarX()) >= frame[0] - 0.15, `${kind}: the D key did not bring the avatar in line with the portal`);
    await sleep(ctx.planted ? 200 : 800);
    await softSnap(ctx, page, `${kind}-lobby-in-line-with-portal`, `Held D with a real key press until the avatar stood in line with the fourth portal.`);
    await page.keyboard.down("KeyW");
    let arrived = false;
    for (let i = 0; i < 600 && !arrived; i += 1) {
      arrived = SOFT_PAGE.test(page.url());
      if (!arrived) await sleep(100);
    }
    await page.keyboard.up("KeyW").catch(() => {});
    if (!arrived) {
      const where = await page.evaluate(() => ({ at: window.__x3domLiveMode?.liveAdapter?.world?.location_id, position: window.__x3domLiveMode?.liveAdapter?.state.avatar.position })).catch(() => null);
      throw new Error(`${kind}: holding W did not reach the soft-body page: ${JSON.stringify(where)}, page is ${page.url()}`);
    }
    await waitSoftWorld(ctx, page, kind);
    assert.ok(page.url().includes(`renderer=${kind}`), `${kind}: the crossing lost the renderer: ${page.url()}`);
    await sleep(ctx.planted ? 800 : 4000);
    await softSnap(ctx, page, `${kind}-crossed-into-soft-body`, `Held W and walked into the portal. The page opened John Carlson's world under ${kind}.`);

    // Back: the left arrow until the disc is straight ahead, then W into the X3D Anchor's ProximitySensor.
    const entry = await page.evaluate(() => window.__x3dWorld.cameraPosition);
    const sideways = () => page.evaluate((entry) => { const p = window.__x3dWorld.cameraPosition; return Math.hypot(p[0] - entry[0], p[2] - entry[2]); }, entry);
    await holdKeyUntil(page, "ArrowLeft", async () => (await sideways()) >= 3.9, `${kind}: the left arrow did not move the walker`);
    await sleep(ctx.planted ? 200 : 800);
    await softSnap(ctx, page, `${kind}-disc-straight-ahead`, `Held the left arrow until the orange disc stood straight ahead.`);
    await page.keyboard.down("KeyW");
    let via = null;
    for (let i = 0; i < 400 && !via; i += 1) {
      via = await page.evaluate(() => document.body?.dataset.x3dWorldCrossing || window.__x3domLiveMode?.kind || null).catch(() => null);
      if (!via) await sleep(100);
    }
    await page.keyboard.up("KeyW").catch(() => {});
    if (!via) throw new Error(`${kind}: walking into the disc did not cross; the camera reached ${JSON.stringify(await page.evaluate(() => window.__x3dWorld.cameraPosition))}`);
    const backInLobby = async (how) => {
      try {
        await page.waitForFunction(() => window.__x3domLiveMode?.liveAdapter?.world?.location_id, { timeout: ctx.wayBackPatience ?? ctx.patience ?? 60000 * SLOW });
      } catch {
        throw new Error(`${kind}: the way back ${how} did not arrive in a lab world (page is ${page.url()})`);
      }
      const state = await x3dState(page);
      assert.equal(state.location, "location-lobby", `${kind}: the way back ${how} landed in ${state.location}`);
      assert.equal(state.path, "/w/lobby/", `${kind}: the way back ${how} landed on ${state.path}`);
      assert.equal(state.active, kind, `${kind}: the way back ${how} lost the renderer`);
      return state;
    };
    await backInLobby("by walking");
    await sleep(ctx.planted ? 800 : 4000);
    const lobby = await snap(ctx, page, SOFT_SERIES, `${kind}-walked-back-to-lobby`, `Held W into the disc. The X3D Anchor went to /w/lobby/ and the Lobby opened under ${kind}.`, [], [], await floorPointsAhead(page));
    assertTone(lobby, "green", `${kind} Lobby after the way back`);
    await page.close();

    // The Anchor by a real mouse click.
    const again = await openSoftWorld(ctx, kind);
    await sleep(ctx.planted ? 800 : 2500);
    await again.mouse.move(178, 400);
    await sleep(600);
    await again.mouse.down();
    await sleep(120);
    await again.mouse.up();
    try {
      await again.waitForFunction(() => window.__x3domLiveMode?.liveAdapter?.world?.location_id === "location-lobby", { timeout: ctx.patience ?? 60000 * SLOW });
    } catch {
      throw new Error(`${kind}: a mouse click on the disc did not reach the Lobby (page is ${again.url()})`);
    }
    await sleep(ctx.planted ? 300 : 1500);
    await softSnap(ctx, again, `${kind}-clicked-back-to-lobby`, `Reloaded the world and clicked the disc with the mouse. The Anchor went to the Lobby under ${kind}.`);
    await again.close();
    return "Lobby to the soft-body world by real keys, back by walking into the Anchor and by a mouse click";
  };
}

const softThreeCheck = async (ctx) => {
  // The page leaving for an X3D page fails the check at once. A call sent to the page while it leaves can wait for an
  // answer that never comes, and did: a run stood still for half an hour.
  let leftFor = null;
  const left = new Promise((_, fail) => { leftFor = (url) => fail(new Error(`three.js: the walk opened an X3D page: ${url}`)); });
  left.catch(() => {});
  const watch = (opened) => opened.on("framenavigated", (frame) => { if (frame === opened.mainFrame() && /x3d-world/.test(frame.url())) leftFor(frame.url()); });
  const walk = async () => {
    const page = await openThree(ctx, "", watch);
    const targets = await page.evaluate(() => window.__assembly.adapter.world.portals.map((p) => p.target_location_id));
    assert.ok(!targets.includes("location-softbody"), `three.js: the Lobby shows a portal to the soft-body world (${targets})`);
    // The same walk as under X3D: nothing opens, and the page stays on three.js.
    const avatarX = () => page.evaluate(() => window.__assembly.debugState().avatar.position[0]);
    await holdKeyUntil(page, "KeyD", async () => (await avatarX()) >= 4.25, "three.js: the D key did not bring the avatar in line with where the fourth portal stands under X3D");
    await page.keyboard.down("KeyW");
    await sleep(ctx.planted ? 3000 : 6000);
    await page.keyboard.up("KeyW");
    assert.ok(!/x3d-world/.test(page.url()), `three.js: the walk opened an X3D page: ${page.url()}`);
    const state = await threeState(page);
    assert.equal(state.location, "location-lobby", `three.js: the walk left the Lobby for ${state.location}`);
    const seen = await softSnap(ctx, page, "three-no-fourth-portal", "Under three.js, the default: held D, then W, over the spot where the fourth portal stands under X3D. There is no portal there, and the page stayed on three.js.");
    assertLooksLikeWorld(seen, "three.js Lobby");
    await page.close();
    return "the default Lobby has its three portals; the same walk opens nothing";
  };
  return Promise.race([walk(), left]);
};

const johnFilesCheck = async (ctx) => {
  // His file, as his commit has it.
  const his = ctx.hisWorld || readFileSync(join(CODE, "web/worlds/soft-body.json"));
  const blob = createHash("sha1").update(`blob ${his.length}\0`).update(his).digest("hex");
  assert.equal(blob, JOHN_WORLD_BLOB, "web/worlds/soft-body.json is not the file of his commit");
  // The copy the page loads: his, less the humanoid, with the lab's Entry viewpoint and Anchor, and his credit.
  const adjustedText = ctx.worldText || readFileSync(ADJUSTED_WORLD, "utf8");
  const adjusted = JSON.parse(adjustedText);
  const hisJson = JSON.parse(his.toString("utf8"));
  assert.ok(!/HumanoidComplete|GrampsSkin|"Gramps"/.test(adjustedText), "the adjusted world still refers to his humanoid");
  const bodiesOf = (world) => JSON.stringify(world.X3D.Scene["-children"].find((child) => child.RigidBodyCollection).RigidBodyCollection["-bodies"].filter((entry) => (entry.RigidBody || entry.SoftBody)["@DEF"] !== "Gramps"));
  assert.ok(bodiesOf(adjusted) === bodiesOf(hisJson), "the adjusted world's bodies are not his");
  const metas = adjusted.X3D.head.meta;
  assert.ok(metas.some((meta) => meta["@name"] === "creator" && meta["@content"] === "John Carlson"), "the world file no longer names John Carlson as creator");
  assert.ok(metas.some((meta) => meta["@name"] === "credit" && /John Carlson.*bf12953173.*Apache-2\.0/.test(meta["@content"])), "the world file has no credit line");
  assert.match(readFileSync(join(CODE, "web/soft-body-world.mjs"), "utf8").slice(0, 400), /John Carlson.*\n.*bf12953173/, "the world's page code does not credit John Carlson in its header");
  const notices = ctx.noticesText || readFileSync(join(CODE, "THIRD_PARTY_NOTICES.md"), "utf8");
  for (const fact of [/John Carlson/, /bf12953173/, /coderextreme\/open-spatial-lab/]) assert.match(notices, fact, `the notices do not state ${fact}`);
  assert.match(notices, /humanoid/i, "the notices do not say the humanoid is left out");
  const lanePage = readFileSync(join(CODE, "web/renderer-lane.html"), "utf8");
  assert.match(lanePage, /John Carlson/, "the renderer page does not credit John Carlson");
  return "his file is his commit's blob; the loaded copy has his bodies and his credit, without the humanoid";
};

const softPageLinksCheck = async (ctx) => {
  const page = await openPage(ctx.browser, ctx.rules);
  await page.goto(`${BASE}/renderer-lane.html`, { waitUntil: "domcontentloaded", timeout: 45000 * SLOW });
  const content = await page.evaluate(() => ({
    links: Object.fromEntries([...document.querySelectorAll("a[id^=link-soft]")].map((a) => [a.id, a.getAttribute("href")])),
    text: document.body.innerText,
  }));
  assert.match(content.text, /John Carlson/, "the renderer page does not credit John Carlson");
  assert.match(content.text, /bf12953173/, "the renderer page does not name his commit");
  for (const id of ["link-soft-x_ite", "link-soft-x3dom", "link-soft-file", "link-soft-his-file"]) assert.ok(content.links[id], `the renderer page has no ${id}`);
  for (const pattern of [/Soft Body|soft-body/i]) assert.match(content.text, pattern, "the renderer page does not mention the world");
  assert.match(content.text, /humanoid[^.]*left out|left out[^.]*humanoid/i, "the renderer page does not say the humanoid is left out");
  assert.doesNotMatch(content.text, /\blive\b[^.]*preview|preview[^.]*\blive\b/i, "the renderer page calls a preview live");
  await page.close();
  return `${Object.keys(content.links).length} links, credit and shortfalls`;
};

// ---------------------------------------------------------------- the list
const adapterFile = "render-adapter/x-ite-render-adapter.mjs";
const x3domEngine = { url: "vendor/x3dom/x3dom-full.js", abort: true };
const xiteEngine = { url: "vendor/x_ite/x_ite.min.mjs", abort: true };
const noRoomRule = { url: "render-adapter/canonical-room.mjs", find: "if (!world?.omitLights) mountCanonicalWorldLights(adapter, parent);", replace: "if (!world?.omitLights) mountCanonicalWorldLights(adapter, parent); if (!world?.omitLights) return {};" };
const noRedrawRule = { url: "x3dom-portal-traversal-glue.mjs", find: 'liveAdapter.addEventListener("crossing", handleCrossing);', replace: "" };
const avatarGone = { url: "rpm_female_character.glb", status: 404 };
const worldUrl = "x3d-worlds/anchor-portal-world.x3d.json";
const noPreviewRule = { url: "x3dom-portal-traversal-glue.mjs", find: "adapter.attachRenderedTexture(material, rt);", replace: "" };
const noCKey = { url: "x3dom-movement-camera-controller.mjs", find: 'if (event.code === "KeyC")', replace: "if (false)" };
const assetsFromOtherWorld = { url: "x3dom-portal-traversal-glue.mjs", find: "wowAssetBaseUrl: liveAdapter.demoProxyBase(endpointKey),", replace: 'wowAssetBaseUrl: liveAdapter.demoProxyBase("a"),' };
const contentOfFirstPortal = { url: "x3dom-portal-traversal-glue.mjs", find: "content = await liveAdapter.resolvePortalDestinationContent(portal);", replace: "content = await liveAdapter.resolvePortalDestinationContent(worldPortals(liveAdapter.world)[0]);" };
// Each destination is staged at its own offset and each preview's camera looks into its own stage, so the
// first stage alone would show an empty patch of it. The camera moves into the first stage with it.
const stageOfFirstPortal = { url: "x3dom-portal-traversal-glue.mjs", find: "await adapter.bindRenderedTextureScene(rt, stagingGroup);", replace: "await adapter.bindRenderedTextureScene(rt, previewRecords[0].stagingGroup); record.stagingOffset = previewRecords[0].stagingOffset;" };
const noRings = { url: "x3dom-portal-traversal-glue.mjs", find: "adapter.add(portalGroup, ringMesh);", replace: "" };
const noCycle = { url: "x3dom-equipment-glue.mjs", find: "cycle(slot.slot);", replace: "" };
const redFloor = { url: "x3dom-airport-terminal-scene.mjs", find: 'floor: adapter.createMaterial({ type: "standard", color: 0xb8c5d0 }),', replace: 'floor: adapter.createMaterial({ type: "standard", color: 0xcc0000 }),' };

const CHECKS = [
  { name: "boundary: ?renderer= choice and every adapter covers the interface", body: boundaryCheck, faults: [
    { name: "an X_ITE method removed", ctx: () => ({ adapterDir: plantedAdapterDir("x-ite-render-adapter.mjs", "createMesh(geometry, material) { return this._wrapShape(geometry, material); }", "") }), expect: /x_ite adapter is missing createMesh/ },
    { name: "the default changed to X3DOM", ctx: () => ({ adapterDir: plantedAdapterDir("render-adapter.mjs", 'DEFAULT_RENDER_ADAPTER_KIND = "three"', 'DEFAULT_RENDER_ADAPTER_KIND = "x3dom"') }), expect: /default is not three\.js/ },
    { name: "a hostile renderer name accepted", ctx: () => ({ adapterDir: plantedAdapterDir("render-adapter.mjs", "Object.prototype.hasOwnProperty.call(RENDERER_ALIASES, key) ? RENDERER_ALIASES[key] : null", "RENDERER_ALIASES[key] || null") }), expect: /constructor must count as unknown/ },
  ] },
  { name: "credit, licences, versions and downloaded bytes", body: creditCheck, faults: [
    { name: "Nicholas removed from the notices", ctx: () => ({ noticesText: readFileSync(join(CODE, "THIRD_PARTY_NOTICES.md"), "utf8").replaceAll("Nicholas Polys", "a contributor") }), expect: /THIRD_PARTY_NOTICES\.md do not credit Nicholas Polys/ },
    { name: "a ported file loses its credit", ctx: () => { const dir = mkdtempSync(join(tmpdir(), "renderer-proof-")); for (const part of ["web", "runtime/scene-core/public/render-adapter"]) mkdirSync(join(dir, part), { recursive: true }); for (const f of readdirSync(join(CODE, "web")).filter((n) => n.startsWith("x3dom-"))) writeFileSync(join(dir, "web", f), readFileSync(join(CODE, "web", f), "utf8")); for (const f of readdirSync(RA)) writeFileSync(join(dir, "runtime/scene-core/public/render-adapter", f), readFileSync(join(RA, f), "utf8")); const p = join(dir, "web/x3dom-hud-glue.mjs"); writeFileSync(p, readFileSync(p, "utf8").replaceAll("Nicholas Polys", "someone")); return { codeRoot: dir }; }, expect: /x3dom-hud-glue\.mjs does not credit/ },
    { name: "the X_ITE version changed", ctx: () => { const dir = mkdtempSync(join(tmpdir(), "renderer-proof-")); const file = join(dir, "package.json"); const pkg = JSON.parse(readFileSync(join(PUB, "vendor/x_ite/package.json"), "utf8")); pkg.version = "16.6.1"; writeFileSync(file, JSON.stringify(pkg)); return { xitePackage: file }; }, expect: /X_ITE package\.json says 16\.6\.1/ },
    { name: "the non-commercial text comes back", ctx: () => { const dir = mkdtempSync(join(tmpdir(), "renderer-proof-")); const file = join(dir, "CC-BY-NC-4.0.txt"); writeFileSync(file, "licence text"); return { xiteExtraFiles: [file] }; }, expect: /left out of the X_ITE copy is back.*CC-BY-NC/ },
    { name: "a served file mentions the non-commercial licence", ctx: () => { const dir = mkdtempSync(join(tmpdir(), "renderer-proof-")); const file = join(dir, "note.txt"); writeFileSync(file, "Attribution-NonCommercial 4.0"); return { xiteExtraFiles: [file] }; }, expect: /mentions the non-commercial licence/ },
    { name: "a decoder left out for its licence comes back", ctx: () => { const dir = mkdtempSync(join(tmpdir(), "renderer-proof-")); const file = join(dir, "libktx.wasm"); writeFileSync(file, ""); return { xiteExtraFiles: [file] }; }, expect: /left out of the X_ITE copy for its licence is back: .*libktx\.wasm/ },
    { name: "the notices of X_ITE's bundled code lose a library", ctx: () => ({ bundledNotices: readFileSync(join(PUB, "vendor/x_ite/THIRD-PARTY-IN-BUNDLES.md"), "utf8").replaceAll("ammo.js", "a physics library") }), expect: /THIRD-PARTY-IN-BUNDLES\.md does not name ammo\.js/ },
    { name: "one byte of X3DOM changed", ctx: () => { const dir = mkdtempSync(join(tmpdir(), "renderer-proof-")); const file = join(dir, "x3dom-full.js"); writeFileSync(file, readFileSync(join(PUB, "vendor/x3dom/x3dom-full.js"), "utf8") + " "); return { x3domFile: file }; }, expect: /x3dom-full\.js is not the downloaded file/ },
  ] },
  { name: "X3D JSON world file: Anchor portal with a ProximitySensor", body: worldFileCheck, faults: [
    { name: "the Anchor replaced by a Group", ctx: () => ({ worldText: readFileSync(join(CODE, "web", worldUrl), "utf8").replace('"Anchor":', '"Group":') }), expect: /no X3D Anchor/ },
    { name: "a renderer written into the file", ctx: () => ({ worldText: readFileSync(join(CODE, "web", worldUrl), "utf8").replace('"/w/b/"', '"/w/b/?renderer=x_ite"') }), expect: /not the Location B world address/ },
    { name: "the ProximitySensor removed", ctx: () => ({ worldText: readFileSync(join(CODE, "web", worldUrl), "utf8").replace('"ProximitySensor":', '"Group":') }), expect: /no ProximitySensor/ },
  ] },
  { name: "none of Nicholas's personal or scratch files came in", body: excludedFilesCheck, faults: [
    { name: "NNotes.txt planted", ctx: () => ({ extraFiles: ["/x/web/NNotes.txt"] }), expect: /personal or scratch files came in.*NNotes/ },
    { name: "a _scratch script planted", ctx: () => ({ extraFiles: ["/x/tools/x3dom-spikes/_scratch-diag.mjs"] }), expect: /personal or scratch files came in.*_scratch/ },
  ] },
  { name: "three.js: default, ?renderer=three, unknown renderer", browser: true, body: threeDefaultCheck, faults: [
    { name: "the default goes down the X3D path", rules: [{ url: "demo-shell-bootstrap.mjs", find: 'if (url.searchParams.has("renderer")) {', replace: 'const x3dBoot = await import("./x3dom-live-mode.mjs"); void x3dBoot.startLiveMode(); return; if (true) {' }], patience: 8000, expect: /default path did not boot three\.js/ },
    { name: "the default page loads a renderer file", rules: [{ url: "demo-shell-bootstrap.mjs", find: 'if (url.searchParams.has("renderer")) {', replace: 'if (true) {' }], expect: /loaded a renderer file|read a renderer switch/ },
    { name: "the unknown-renderer notice removed", rules: [{ url: "render-adapter/render-adapter.mjs", find: 'if (!documentTarget || !choice || !choice.message) return null;', replace: "return null;" }], expect: /no notice on the page/ },
  ] },
  { name: "three.js: portal crossings", browser: true, body: threeCrossingCheck, faults: [
    // The crossing request is dropped: the avatar walks through the plane and stays in the lobby.
    { name: "a portal no longer crosses", rules: [{ url: "live-adapter.js", find: 'this._beginPortalTransition("plane_crossing", ev.portal);', replace: "void ev;" }], expect: /three\.js portal did not reach/ },
  ] },
  { name: "X3DOM: lobby drawn, avatar, portal previews, W key", browser: true, body: x3dLobbyCheck("x3dom"), faults: [
    { name: "the X3DOM engine refused", rules: [x3domEngine], patience: 8000, expect: /x3dom did not boot/ },
    { name: "the room not built", rules: [noRoomRule], expect: /room colour is wrong|looks blank/ },
    { name: "the avatar file missing", rules: [avatarGone], patience: 75000, expect: /the avatar did not load/ },
    { name: "the preview not attached to the aperture", rules: [noPreviewRule], expect: /a portal shows no preview: 0 of the 3/ },
    { name: "the adapter drops unlit, as it once did", rules: [{ url: "render-adapter/x3dom-render-adapter.mjs", find: "side: desc.side, unlit: desc.unlit };", replace: "side: desc.side };" }], expect: /a preview's plane is lit/ },
    { name: "the preview's material asks for light", rules: [{ url: "x3dom-portal-traversal-glue.mjs", find: "unlit: true", replace: "unlit: false" }], expect: /a preview's plane is lit/ },
    { name: "every surface unlit", rules: [{ url: "render-adapter/x3dom-render-adapter.mjs", find: 'if (material.base?.unlit && typeof geometry.setAttribute === "function")', replace: 'if (typeof geometry.setAttribute === "function")' }], expect: /more than the portals' planes are unlit/ },
    { name: "the engine ignores lit", rules: [{ url: "vendor/x3dom/x3dom-full.js", find: 'this.addField_SFBool(e,"lit",!0)', replace: 'this._vf.lit=!0' }], expect: /as dark as a lit one/ },
    { name: "the C key does nothing", rules: [noCKey], expect: /C key did not switch/ },
    { name: "the equipment button does nothing", rules: [noCycle], expect: /equipment button did not change/ },
    { name: "every portal holds the first portal's world", rules: [contentOfFirstPortal], expect: /holds the content of/ },
    { name: "every portal draws the first portal's room", rules: [stageOfFirstPortal], expect: /does not come from that destination's own room/ },
    { name: "previews with no background on a clipped view", rules: [{ url: "x3dom-portal-traversal-glue.mjs", find: "backgroundColor: PREVIEW_BACKGROUND_COLOR,", replace: "" }], expect: /renders black/ },
  ] },
  { name: "X_ITE: lobby drawn, avatar, W key", browser: true, body: x3dLobbyCheck("x_ite"), faults: [
    { name: "the X_ITE engine refused", rules: [xiteEngine], patience: 8000, expect: /x_ite did not boot/ },
    { name: "the room not built", rules: [noRoomRule], expect: /room colour is wrong|looks blank/ },
    { name: "the avatar file missing", rules: [avatarGone], patience: 20000, expect: /the avatar did not load/ },
    { name: "the preview not attached to the aperture", rules: [noPreviewRule], expect: /shows no preview, only a flat tint/ },
    { name: "every portal holds the first portal's world", rules: [contentOfFirstPortal], expect: /holds the content of/ },
    { name: "every portal draws the first portal's room", rules: [stageOfFirstPortal], expect: /does not come from that destination's own room/ },
    { name: "the preview draws once and never again", rules: [{ url: adapterFile, find: "node.singleFrame = false;", replace: "" }], expect: /shows no preview, only a flat tint/ },
    { name: "the C key does nothing", rules: [noCKey], expect: /C key did not switch/ },
    { name: "the equipment button does nothing", rules: [noCycle], expect: /equipment button did not change/ },
  ] },
  { name: "X3DOM: portal crossings redraw the world", browser: true, body: x3dCrossingCheck("x3dom"), faults: [
    { name: "the crossing does not rebuild the scene", rules: [noRedrawRule], expect: /room colour is wrong/ },
    { name: "the rings not drawn", rules: [noRings], expect: /no portal ring where the portal/ },
    // The Lobby's two objects are restricted and hidden, so it asks for no asset: a crossing into A or B does.
    { name: "hosted objects asked of the current world", rules: [assetsFromOtherWorld], expect: /asked the wrong world/ },
    { name: "the preview still drawn from behind", rules: [{ url: "x3dom-portal-traversal-glue.mjs", find: "adapter.setVisible(mesh, !behind);\n                mesh._labHidden = behind;", replace: "" }], expect: /a preview covers the opening/ },
  ] },
  { name: "X_ITE: portal crossings redraw the world", browser: true, body: x3dCrossingCheck("x_ite"), faults: [
    { name: "the crossing does not rebuild the scene", rules: [noRedrawRule], expect: /room colour is wrong/ },
    { name: "the rings not drawn", rules: [noRings], expect: /no portal ring where the portal/ },
    // The Lobby's two objects are restricted and hidden, so it asks for no asset: a crossing into A or B does.
    { name: "hosted objects asked of the current world", rules: [assetsFromOtherWorld], expect: /asked the wrong world/ },
    { name: "the preview still drawn from behind", rules: [{ url: "x3dom-portal-traversal-glue.mjs", find: "adapter.setVisible(mesh, !behind);\n                mesh._labHidden = behind;", replace: "" }], expect: /a preview covers the opening/ },
    { name: "the camera no longer hides the wall behind the avatar", rules: [{ url: adapterFile, find: "const { position: origin, lookAt } = this._cameraPose;", replace: "return null; const { position: origin, lookAt } = this._cameraPose;" }], expect: /location-a: the view looks blank/ },
  ] },
  { name: "X3DOM: Denver Skyport", browser: true, body: x3dAirportCheck("x3dom"), faults: [
    { name: "a shared material leaves shapes bare", rules: [{ url: adapterFile.replace("x-ite", "x3dom"), find: "material.appearanceEl.parentNode ? material.appearanceEl.cloneNode(true) : material.appearanceEl", replace: "material.appearanceEl" }], expect: /shapes without appearance/ },
    { name: "the concourse floor red", rules: [redFloor], expect: /airport is dark or the wrong colour: .*floor tone rgb\(\d+,\d+,\d+\) is not grey/ },
  ] },
  { name: "X_ITE: Denver Skyport", browser: true, body: x3dAirportCheck("x_ite"), faults: [
    { name: "the airport's lights removed", rules: [{ url: "x3dom-portal-traversal-glue.mjs", find: "mountCanonicalWorldLights(adapter, worldContentGroup);", replace: "void 0;" }], expect: /airport is dark/ },
    { name: "the concourse floor red", rules: [redFloor], expect: /airport is dark or the wrong colour: .*floor tone rgb\(\d+,\d+,\d+\) is not grey/ },
  ] },
  { name: "X3D JSON world under X_ITE: loads, Anchor crosses by click and by walking in", browser: true, body: worldCheck("x_ite"), faults: [
    { name: "the Anchor replaced by a Group", rules: [{ url: worldUrl, find: '"Anchor":', replace: '"Group":' }], expect: /no X3D Anchor|did not load/ },
    { name: "the Anchor points somewhere else", rules: [{ url: worldUrl, find: '"/w/b/"', replace: '"/w/nowhere/"' }], patience: 8000, expect: /Anchor url is not the Location B address/ },
    { name: "the sensor moved out of reach", rules: [{ url: worldUrl, find: '"@center": [0, 1.2, -2.5]', replace: '"@center": [50, 1.2, -2.5]' }], expect: /the walk did not cross/, shortWalk: true },
  ] },
  { name: "X3D JSON world under X3DOM: loads, Anchor crosses by click and by walking in", browser: true, body: worldCheck("x3dom"), faults: [
    { name: "the Anchor replaced by a Group", rules: [{ url: worldUrl, find: '"Anchor":', replace: '"Group":' }], expect: /no X3D Anchor|did not load/ },
    { name: "walking in lands in Location A", rules: [{ url: "x3d-world.mjs", find: 'window.open(url, "_self")', replace: 'window.open(url.replace("/w/b/", "/w/a/"), "_self")' }], expect: /walk-in arrived in the wrong world/ },
  ] },
  { name: "John Carlson's files: his blob, the loaded copy, credit", body: johnFilesCheck, faults: [
    { name: "one byte of his file changed", ctx: () => ({ hisWorld: Buffer.concat([readFileSync(join(CODE, "web/worlds/soft-body.json")), Buffer.from(" ")]) }), expect: /is not the file of his commit/ },
    { name: "a change to his bodies in the loaded copy", ctx: () => ({ worldText: readFileSync(ADJUSTED_WORLD, "utf8").replace('"@mass": 2', '"@mass": 9') }), expect: /bodies are not his/ },
    { name: "the humanoid back in the loaded copy", ctx: () => ({ worldText: readFileSync(ADJUSTED_WORLD, "utf8").replace('"@name": "credit"', '"@name": "credit", "@href": "../assets/HumanoidComplete.json"') }), expect: /still refers to his humanoid/ },
    { name: "John removed from the notices", ctx: () => ({ noticesText: readFileSync(join(CODE, "THIRD_PARTY_NOTICES.md"), "utf8").replaceAll("John Carlson", "someone") }), expect: /the notices do not state \/John Carlson\// },
  ] },
  { name: "soft-body world under X_ITE: loads from his file", browser: true, body: softWorldLoadCheck("x_ite"), faults: [
    { name: "his world file missing", rules: [{ url: softWorldPath, status: 404 }], expect: /the soft-body world did not load: the world file answered 404/ },
    { name: "the engine given his SoftBody nodes", rules: [{ url: "soft-body-world.mjs", find: "child !== collectionEntry", replace: "true" }], expect: /a node it does not know/ },
    { name: "a request outside the lab", rules: [{ url: "soft-body-world.mjs", find: "const MARGIN = 0.05;", replace: 'fetch("https://cdn.invalid/ammo.js").catch(() => {}); const MARGIN = 0.05;' }], expect: /asked outside the lab/ },
  ] },
  { name: "soft-body world under X3DOM: loads from his file", browser: true, body: softWorldLoadCheck("x3dom"), faults: [
    { name: "his world file missing", rules: [{ url: softWorldPath, status: 404 }], expect: /the soft-body world did not load: the world file answered 404/ },
    { name: "no Ammo", rules: [{ url: "RigidBodyPhysicsComponent", abort: true }], expect: /physics component did not load/ },
    { name: "the credit gone from the page", rules: [{ url: "x3d-world.mjs", find: "World and physics by John Carlson", replace: "A world" }], expect: /does not credit John Carlson/ },
  ] },
  { name: "soft-body world under X_ITE: measured motion", browser: true, body: softMotionCheck("x_ite"), faults: [
    { name: "Bullet never steps", rules: [{ url: "soft-body-world.mjs", find: "world.stepSimulation(dt, 10);", replace: "" }], expect: /the ball did not fall/ },
    { name: "the drawn points left behind", rules: [{ url: "soft-body-world.mjs", find: "sink.setPoints(soft.def, flat);", replace: "" }], expect: /drawn points do not follow Bullet/ },
    { name: "the cloth's stitches gone", rules: [{ url: "soft-body-world.mjs", find: 'soft.made.appendAnchor(Number(node), rigid.made, false, stitch["@weight"]?.[index] ?? 1);', replace: "" }], expect: /no longer hangs from the arm/ },
    { name: "the Q key does nothing", rules: [{ url: "soft-body-world.mjs", find: 'if (event.code === "KeyQ") armMovement = 1;', replace: "" }], expect: /the Q key did not swing the arm/ },
  ] },
  { name: "soft-body world under X3DOM: measured motion", browser: true, body: softMotionCheck("x3dom"), faults: [
    { name: "Bullet never steps", rules: [{ url: "soft-body-world.mjs", find: "world.stepSimulation(dt, 10);", replace: "" }], expect: /the ball did not fall/ },
    { name: "the drawn points left behind", rules: [{ url: "soft-body-world.mjs", find: "sink.setPoints(soft.def, flat);", replace: "" }], expect: /drawn points do not follow Bullet/ },
    { name: "the cloth's stitches gone", rules: [{ url: "soft-body-world.mjs", find: 'soft.made.appendAnchor(Number(node), rigid.made, false, stitch["@weight"]?.[index] ?? 1);', replace: "" }], expect: /no longer hangs from the arm/ },
  ] },
  { name: "portal under X_ITE: Lobby to the soft-body world and back, real keys", browser: true, body: softPortalCheck("x_ite"), faults: [
    { name: "the portal does not open the world", rules: [{ url: "x3dom-portal-traversal-glue.mjs", find: "globalThis.location.assign(withBase(`/x3d-world.html", replace: "void (withBase(`/x3d-world.html" }], expect: /holding W did not reach the soft-body page/ },
    // Only the wait for the way back is short: the avatar, the walk and the world keep their usual time.
    { name: "the Anchor points somewhere else", rules: [{ url: softWorldPath, find: '"/w/lobby/"', replace: '"/w/nowhere/"' }], ctx: () => ({ wayBackPatience: 9000 }), expect: /the way back by walking did not arrive/ },
    { name: "the sensor moved out of reach", rules: [{ url: softWorldPath, find: '"@center": [-8.59, 1.2, 2.93]', replace: '"@center": [80, 1.2, 80]' }], expect: /walking into the disc did not cross/ },
  ] },
  { name: "portal under X3DOM: Lobby to the soft-body world and back, real keys", browser: true, body: softPortalCheck("x3dom"), faults: [
    { name: "the portal does not open the world", rules: [{ url: "x3dom-portal-traversal-glue.mjs", find: "globalThis.location.assign(withBase(`/x3d-world.html", replace: "void (withBase(`/x3d-world.html" }], expect: /holding W did not reach the soft-body page/ },
    { name: "the worlds file has no fourth portal", rules: [{ url: "worlds.json", find: '"portal_id": "lobby-portal-d"', replace: '"portal_id": "gone"' }], expect: /the Lobby has no fourth portal/ },
    { name: "the Anchor loses the renderer on the way back", rules: [{ url: "x3d-world.mjs", find: 'target.searchParams.set("renderer", kind);', replace: 'target.searchParams.set("renderer", "x_ite");' }], expect: /the way back by walking lost the renderer/ },
  ] },
  { name: "three.js: the Lobby has no fourth portal, and the same walk opens nothing", browser: true, body: softThreeCheck, faults: [
    // The walk itself opens the world: W, pressed where the fourth portal stands under X3D. A timer could run out
    // after a quick walk had ended, and then the check stayed green.
    { name: "a walk under three.js opens the world", rules: [{ url: "live-adapter.js", find: 'const HOSTED_ATTACH_POINT_EVENT = "hostedattachpoint";', replace: 'const HOSTED_ATTACH_POINT_EVENT = "hostedattachpoint"; globalThis.addEventListener("keydown", (event) => { if (event.code === "KeyW") globalThis.location.assign(withBase("/x3d-world.html?world=soft-body.x3d.json&renderer=x_ite")); });' }], expect: /the walk opened an X3D page/ },
  ] },
  { name: "renderer page lists the soft-body world, credit and shortfalls", browser: true, body: softPageLinksCheck, faults: [
    { name: "John removed from the page", rules: [{ url: "renderer-lane.html", find: "John Carlson", replace: "someone", all: true }], expect: /does not credit John Carlson/ },
    { name: "the X3DOM link removed", rules: [{ url: "renderer-lane.html", find: 'id="link-soft-x3dom"', replace: 'id="gone"' }], expect: /has no link-soft-x3dom/ },
  ] },
  { name: "renderer page lists the links, engines, credit and shortfalls", browser: true, body: rendererPageCheck, faults: [
    { name: "the credit removed", rules: [{ url: "renderer-lane.html", find: "Nicholas Polys", replace: "someone" }], expect: /does not credit Nicholas Polys/, allOccurrences: true },
  ] },
  { name: "the lab's own client checks (npm run check:client)", body: clientChecks, faults: [
    { name: "one of the lab's checks fails", ctx: () => { const dir = mkdtempSync(join(tmpdir(), "renderer-proof-")); const file = join(dir, "fail-one.cjs"); writeFileSync(file, 'if (process.argv.some((arg) => arg.endsWith("live-lobby-portals-check.mjs"))) process.exit(7);\n'); return { nodeOption: file }; }, expect: /npm run check:client failed/ },
  ] },
];

// ---------------------------------------------------------------- servers
function startServers() {
  const ports = { BACKEND_A_PORT: String(PORT + 1), BACKEND_B_PORT: String(PORT + 2), BACKEND_LOBBY_PORT: String(PORT + 3), BACKEND_AIRPORT_PORT: String(PORT + 4) };
  const clean = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(OSL_)?BACKEND_|^OSL_FRONTEND_PORT$|^OSL_PUBLIC_ORIGIN$/.test(name)));
  mkdirSync(PROOF, { recursive: true });
  const stamp = { stdio: ["ignore", "ignore", "ignore"], detached: true, cwd: CODE };
  const backends = spawn("node", ["src/orchestrator.js", "serve-backends"], { ...stamp, env: { ...clean, NODE_OPTIONS: "", OSL_WOW_VALIDATE: "1", OSL_RUN_DIR: join(PROOF, "run"), ...ports } });
  const frontend = spawn("node", ["src/serve.js", String(PORT)], { ...stamp, env: { ...clean, NODE_OPTIONS: "", ...ports } });
  return [backends, frontend];
}
async function waitForHealth() {
  for (let i = 0; i < 120; i += 1) {
    try {
      const health = await (await fetch(`${BASE}/healthz`)).json();
      if (health.ok) return;
    } catch { /* not yet */ }
    await sleep(500);
  }
  throw new Error(`the proof's servers did not become healthy on ${PORT}-${PORT + 4}`);
}

// ---------------------------------------------------------------- run
const servers = startServers();
const stop = () => { for (const child of servers) { try { process.kill(-child.pid); } catch { /* gone */ } } };
process.on("exit", stop);
await waitForHealth();
console.log(`servers healthy on ${BASE}`);
const launchBrowser = async () => {
  const started = await puppeteer.launch({
    executablePath: findBrowser(),
    headless: "new",
    defaultViewport: { width: 1280, height: 800 },
    protocolTimeout: 240000 * SLOW,
    args: ["--no-sandbox", "--enable-webgl", "--ignore-gpu-blocklist", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--autoplay-policy=no-user-gesture-required"],
  });
  started.process()?.on("exit", (code, signal) => console.log(`BROWSER PROCESS ENDED  code ${code}, signal ${signal}`));
  analysisPage = await started.newPage();
  return started;
};
let browser = await launchBrowser();
// A check that finds the browser gone gets a new one, so one lost browser costs one attempt and not the rest of the run.
const ensureBrowser = async () => {
  if (browser.connected) return;
  console.log("BROWSER GONE  starting a new one");
  browser = await launchBrowser();
};
const results = [];
if (!FAULT_MODE && !ONLY) for (const series of ["three", "x3dom", "x_ite", "soft-body"]) rmSync(join(PROOF, series), { recursive: true, force: true });
const wanted = (name) => !ONLY || ONLY.split("|").some((part) => name.toLowerCase().includes(part.toLowerCase()));
const closeExtras = async () => {
  if (!browser.connected) return;
  for (const page of await browser.pages()) if (page !== analysisPage) await page.close().catch(() => {});
};

if (FAULT_MODE) {
  for (const check of CHECKS) {
    for (const fault of check.faults) {
      const label = `${check.name} / ${fault.name}`;
      if (!wanted(label)) continue;
      const started = Date.now();
      await ensureBrowser();
      const ctx = { browser, planted: true, rules: fault.rules || [], patience: fault.patience, settle: 500, ...(fault.ctx ? fault.ctx() : {}) };
      let outcome;
      try {
        await check.body(ctx);
        outcome = { ok: false, why: "stayed green" };
      } catch (error) {
        const message = String(error && error.message || error);
        outcome = fault.expect.test(message)
          ? { ok: true, why: message.split("\n")[0].slice(0, 200) }
          : { ok: false, why: `red for another reason: ${message.split("\n")[0].slice(0, 300)}` };
      }
      await closeExtras();
      results.push({ name: label, ok: outcome.ok });
      console.log(`${outcome.ok ? "RED, AS PLANTED" : "FAULT NOT CAUGHT"}  ${label}  (${((Date.now() - started) / 1000).toFixed(0)} s)\n      ${outcome.why}`);
    }
  }
} else {
  for (const check of CHECKS) {
    if (!wanted(check.name)) continue;
    const started = Date.now();
    let attempt = 0;
    for (;;) {
      attempt += 1;
      await ensureBrowser();
      const saved = { three: [...steps.three], x3dom: [...steps.x3dom], x_ite: [...steps.x_ite], "soft-body": [...steps["soft-body"]], count: { ...shotCount } };
      // A failed attempt's pictures do not stay in the series: pictures and steps.md describe one run.
      const dropAttempt = () => {
        for (const series of ["three", "x3dom", "x_ite", "soft-body"]) for (const step of steps[series].slice(saved[series].length)) rmSync(join(PROOF, series, step.file), { force: true });
        steps.three = saved.three; steps.x3dom = saved.x3dom; steps.x_ite = saved.x_ite; steps["soft-body"] = saved["soft-body"]; Object.assign(shotCount, saved.count);
      };
      try {
        const detail = await check.body({ browser });
        results.push({ name: check.name, ok: true, attempt });
        console.log(`PASS  ${check.name}  (${((Date.now() - started) / 1000).toFixed(0)} s${attempt > 1 ? ", second attempt" : ""})  ${detail || ""}`);
        break;
      } catch (error) {
        const message = String(error && error.stack || error).split("\n").slice(0, 5).join("\n      ");
        await closeExtras();
        if (check.browser && attempt === 1) {
          console.log(`RE-RUN  ${check.name}: first attempt failed, once more because load can cause this:\n      ${message}`);
          dropAttempt();
          continue;
        }
        // A failed check's pictures do not count: no line in steps.md may describe them as done.
        dropAttempt();
        results.push({ name: check.name, ok: false, attempt });
        console.log(`FAIL  ${check.name}\n      ${message}`);
        break;
      }
    }
  }
  if (!ONLY) {
    const out = ["# The opt-in renderers: what was done and seen", "", "Written by tools/renderer/proof.mjs from one run. Each line names a screenshot, what the proof did, and what it measured in that picture: colour groups (how many groups of colour are in the scene), floor (the colour of the floor at the corners of the scene; in the airport's concourse, on the floor beside the runner), and dark (dark pixels in the middle, where the avatar stands). A check that failed has no lines here.", ""];
    const notPassed = results.filter((result) => !result.ok).map((result) => result.name);
    out.push(notPassed.length ? `Checks that failed in this run: ${notPassed.join("; ")}.` : `Every check passed in this run (${results.length}).`, "");
    const titles = { three: "three.js (the default)", x3dom: "X3DOM", x_ite: "X_ITE", "soft-body": "John Carlson's soft-body world" };
    for (const series of ["three", "x3dom", "x_ite", "soft-body"]) {
      out.push(`## ${titles[series]}`, "", `Pictures in ${series}/.`, "");
      for (const step of steps[series]) {
        out.push(`- ${step.file}: ${step.detail} Colour groups ${step.seen.distinct}, largest ${step.seen.dominant}, floor rgb(${step.seen.tone.join(",")}), dark ${step.seen.middleDark}.`);
      }
      out.push("");
    }
    writeFileSync(join(PROOF, "steps.md"), out.join("\n"));
  }
}
// One statement for each engine and for John Carlson's world: what passed in this run, no more.
const statements = [
  ["three.js", /^three\.js/],
  ["X3DOM", /X3DOM/],
  ["X_ITE", /X_ITE/],
  ["John Carlson's world", /soft-body|John Carlson/],
];
if (!FAULT_MODE) {
  console.log("");
  for (const [who, pattern] of statements) {
    const mine = results.filter((result) => pattern.test(result.name));
    const failed = mine.filter((result) => !result.ok);
    console.log(`${who}: ${mine.length - failed.length} of ${mine.length} checks pass in this run${failed.length ? `; failed: ${failed.map((result) => result.name).join("; ")}` : ""}.`);
  }
}
await browser.close();
stop();
const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} ${FAULT_MODE ? "planted faults caught for their named reason" : "checks pass"}`);
process.exit(failed.length ? 1 : 0);
