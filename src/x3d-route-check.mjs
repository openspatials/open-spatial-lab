// The own-X3D document route in the real shared app, driven as a person drives it, on a lab of its own.
//   node src/x3d-route-check.mjs [--faults] [--faults-only] [--only id,id]
//
// Built on tools/behavior/kit.mjs and tools/arch-i4/main-demo/lab.mjs, read only. Ports 38100-38119.
// Page state comes from window.__x3dWorld.debugState() and from screenshots of the scene mount. Three statements need
// more than those give, and say so: the physics bodies' drawn points (read from the published scene graph), the
// order in which leaving the route releases physics and the scene (two in-page wrappers, put in place by this check
// only), and the default route (kit's own pageFacts). Navigations the route dispatches are caught and aborted, so the
// page never follows them into a server world.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { expect, fail, fixed, pageFacts, runBehavior, sleep } from "../tools/behavior/kit.mjs";
import { CODE, openPlayer } from "../tools/arch-i4/main-demo/lab.mjs";
import { decodeRgbe } from "../runtime/scene-core/public/x3d/rgbe-decoder.mjs";
import { SKY_GRADIENT_PATH, selfTest as skyGradientSelfTest } from "../tools/x3d/make-sky-gradient-hdr.mjs";

// Screenshots go under the code root's diagnostics folder; OSL_X3D_SHOTS names another folder for a run.
const SHOTS_ROOT = process.env.OSL_X3D_SHOTS || join(CODE, "diagnostics", "x3d-route");
const SHOTS = join(SHOTS_ROOT, "route");
const ANCHOR = "anchor-portal-world.x3d.json";
const SOFT = "soft-body.x3d.json";
const DOCS = {
  [ANCHOR]: { sha256: "db7491aaa754aa3e33ef409e3812d6803ecb986b07f9f21cbbbe93405b043441", entry: [0, 1.6, 6], sky: [0.09, 0.13, 0.22], target: "/w/b/" },
  [SOFT]: { sha256: "c7b42847b502f9c895bec63e05eb5cbc7423e11a8dce47447b0897c05c50a0e6", entry: [-10, 1.6, 10], sky: [0.749, 0.82, 0.898], target: "/w/lobby/" },
};
const CONTENT_MIN = 0.05; // a frame of background alone covers ~0 of the frame with anything else
const SKY_MIN = 0.02; // the authored viewpoints look level at eye height, so some sky is in view
// Content brighter than luminance 40 of 255: lit surfaces, not black silhouettes. Measured 2026-11-10 on canvas
// pixels: 0.685 (anchor) and 0.575 (soft body) lit; 0.039 with the soft body's lights at zero (the emissive portal
// disc and label). 0.02 let that through; 0.2 sits between with room on both sides.
const LIT_MIN = 0.2;
const SPEED = [2.16, 2.64]; // 2.4 m/s within 10 %, per second of the frame loop's own time
const EYE_M = 0.01;
const PHYSICS_S = 7;
const BALL_FALL_M = 3; // the accepted isolated proof: ball centre fall over 3 m after 7 simulated seconds
const CLOTH_MOVE_M = 0.1; // and largest cloth node move over 0.1 m
const PIXEL_CHANGE_MIN = 0.002;
const NAV_WAIT_MS = 15000;
// Soft-body entry [-10, 1.6, 10], yaw -0.7854: W walks along (0.707, 0, -0.707), the left arrow along (-0.707, 0,
// -0.707). The PortalTrigger box is centred at (-8.59, 2.93), 1.6 m wide: 6.0 m ahead, then 4.0 m left.
const TRIGGER = { centre: [-8.59, 2.93], half: 0.8 };
const LEG_AHEAD_M = 6.0;
const LEG_LEFT_M = 4.0;

let shotCount = 0;
const shotLog = [];

const docUrl = (ctx, file) => `${ctx.lab.front}/index.html?renderer=own-x3d&x3dDocument=${file}`;
const isReal = (ctx) => ctx.lab.code === CODE;

/** A PNG from Puppeteer (8-bit RGB or RGBA, not interlaced) as RGBA pixels. */
function decodePng(buffer) {
  const buf = Buffer.from(buffer);
  let at = 8, width = 0, height = 0, colorType = 0;
  const data = [];
  while (at < buf.length) {
    const length = buf.readUInt32BE(at);
    const type = buf.toString("ascii", at + 4, at + 8);
    const body = buf.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") {
      width = body.readUInt32BE(0); height = body.readUInt32BE(4); colorType = body[9];
      if (body[8] !== 8 || body[12] !== 0 || (colorType !== 6 && colorType !== 2)) fail(`unexpected screenshot PNG format ${body[8]}/${colorType}/${body[12]}`);
    } else if (type === "IDAT") data.push(body);
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(data));
  const bpp = colorType === 6 ? 4 : 3, stride = width * bpp;
  const out = new Uint8Array(width * height * 4);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = new Uint8Array(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let i = 0; i < stride; i += 1) {
      const a = i >= bpp ? line[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let add = 0;
      if (filter === 1) add = a;
      else if (filter === 2) add = b;
      else if (filter === 3) add = (a + b) >> 1;
      else if (filter === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      line[i] = (line[i] + add) & 255;
    }
    for (let x = 0; x < width; x += 1) {
      out.set([line[x * bpp], line[x * bpp + 1], line[x * bpp + 2], 255], (y * width + x) * 4);
    }
    prev = line;
  }
  return { width, height, rgba: out };
}

/** A screenshot of the scene mount, saved under `dir` (SHOTS unless a statement keeps its own), decoded. */
async function shot(ctx, page, name, dir = SHOTS, save = true) {
  const box = await page.$eval("#scene-mount", (mount) => { const r = mount.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; });
  // Canvas pixels only: the shell's header, footer and intro card sit over the scene mount, so for the screenshot
  // every element but the scene canvases is made invisible, and shown again straight after.
  await page.evaluate(() => {
    const style = document.createElement("style");
    style.id = "x3d-route-check-canvas-only";
    style.textContent = "body * { visibility: hidden !important; } #scene-mount canvas { visibility: visible !important; }";
    document.head.appendChild(style);
  });
  let png;
  try { png = Buffer.from(await page.screenshot({ type: "png", clip: box })); }
  finally { await page.evaluate(() => document.getElementById("x3d-route-check-canvas-only")?.remove()); }
  let file = null, sha256 = null;
  if (save) {
    mkdirSync(dir, { recursive: true });
    shotCount += 1;
    file = join(dir, `${isReal(ctx) ? "real" : "fault"}-${String(shotCount).padStart(2, "0")}-${name}.png`);
    writeFileSync(file, png);
    sha256 = createHash("sha256").update(png).digest("hex");
    shotLog.push({ file, sha256 });
  }
  return { file, sha256, box, ...decodePng(png) };
}

const toSrgb = (c) => Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055));
const near = (p, q, tolerance = 12) => Math.abs(p[0] - q[0]) <= tolerance && Math.abs(p[1] - q[1]) <= tolerance && Math.abs(p[2] - q[2]) <= tolerance;

/**
 * How much of the frame is something other than the authored sky. The sky reference is the document's linear
 * skyColor converted to sRGB, as three r160 draws it (a frame with every shape hidden showed 85,101,129 for the
 * anchor document's 0.09, 0.13, 0.22).
 */
function frameStats(image, skyColor) {
  const sky = skyColor.map(toSrgb);
  const { rgba } = image, count = rgba.length / 4;
  let content = 0, lit = 0;
  for (let i = 0; i < count; i += 1) {
    const p = [rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]];
    if (near(p, sky)) continue;
    content += 1;
    if (0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2] > 40) lit += 1;
  }
  return { sky, content: content / count, skyShare: 1 - content / count, lit: lit / count };
}

function changedShare(a, b) {
  if (a.width !== b.width || a.height !== b.height) fail(`the two frames differ in size (${a.width}x${a.height}, ${b.width}x${b.height})`);
  let changed = 0;
  const count = a.rgba.length / 4;
  for (let i = 0; i < count; i += 1) {
    if (Math.max(Math.abs(a.rgba[i * 4] - b.rgba[i * 4]), Math.abs(a.rgba[i * 4 + 1] - b.rgba[i * 4 + 1]), Math.abs(a.rgba[i * 4 + 2] - b.rgba[i * 4 + 2])) > 24) changed += 1;
  }
  return changed / count;
}

/** The route's own debug state, and the frame loop's clock from kit's page recorder. */
const debug = (page) => page.evaluate(() => {
  const d = window.__x3dWorld.debugState();
  const e = d.entry || {};
  return { kind: d.kind, file: d.file, sha256: d.source_sha256, camera: d.camera, actions: d.actions,
    entry: { position: e.position, orientation: e.orientation, fieldOfView: e.fieldOfView },
    worldFile: window.__x3dWorld.worldFile, clock: window.__behaviorClock.seconds, frames: window.__behaviorClock.frames };
});

async function untilClock(page, seconds, limitMs) {
  const start = (await debug(page)).clock;
  const started = Date.now();
  for (;;) {
    const d = await debug(page);
    if (d.clock - start >= seconds) return d;
    if (Date.now() - started > limitMs) fail(`the frame loop got ${fixed(d.clock - start)} of ${seconds} s (timed out after ${limitMs / 1000} s)`);
    await sleep(40);
  }
}

/** Open a page on the route and wait for the document viewer to say it is ready; a page error fails at once. */
async function openDocument(ctx, url) {
  const page = await ctx.visit(url, { open: false });
  const errors = [];
  const responses = [];
  const requests = [];
  page.on("pageerror", (error) => errors.push(String((error && error.message) || error)));
  page.on("request", (request) => requests.push(request.url()));
  page.on("response", (response) => responses.push({ url: response.url(), status: response.status() }));
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  const started = Date.now();
  for (;;) {
    const ready = await page.evaluate(() => document.body.dataset.x3dWorldReady === "1" && !!window.__x3dWorld?.debugState).catch(() => false);
    if (ready) break;
    if (errors.length) fail(`the document route threw: ${errors[0].slice(0, 200)}`);
    if (Date.now() - started > 120000) fail(`the document route was not ready at ${page.url()} (timed out after 120 s)`);
    await sleep(250);
  }
  await page.bringToFront();
  await untilClock(page, 0.2, 60000);
  return { page, errors, responses, requests };
}

/** Catch every main-frame navigation from now on and abort it, so a dispatched destination is seen, not followed. */
async function catchNavigations(page) {
  const seen = [];
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    if (request.isInterceptResolutionHandled()) return;
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
      seen.push(request.url());
      request.abort("aborted").catch(() => {});
    } else request.continue().catch(() => {});
  });
  return seen;
}

async function waitForNavigation(seen, limitMs = NAV_WAIT_MS) {
  const started = Date.now();
  while (!seen.length && Date.now() - started < limitMs) await sleep(100);
  return seen[0] || null;
}

/** The drawn points of a soft body, in world space, read from the scene the route published. */
const softPoints = (page, name) => page.evaluate((wanted) => {
  const scene = window.__assembly.scene._impl.scene;
  let mesh = null;
  scene.traverse((node) => { if (!mesh && node.isMesh && node.name === wanted && node.userData?.source?.type === "SoftBody") mesh = node; });
  if (!mesh) return null;
  mesh.updateMatrixWorld(true);
  const m = mesh.matrixWorld.elements, a = mesh.geometry.attributes.position, out = [];
  for (let i = 0; i < a.count; i += 1) {
    const x = a.getX(i), y = a.getY(i), z = a.getZ(i);
    out.push([m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]]);
  }
  return out;
}, name);

const centre = (points) => points.reduce((s, p) => [s[0] + p[0], s[1] + p[1], s[2] + p[2]], [0, 0, 0]).map((v) => v / points.length);

function expectBoot(d, file) {
  expect(d.kind === "own-x3d-document" && d.file === file && d.worldFile === file, `debugState names ${d.kind} ${d.file}, not own-x3d-document ${file}`);
  expect(d.sha256 === DOCS[file].sha256, `debugState source_sha256 is ${d.sha256}, not ${DOCS[file].sha256}`);
  const off = Math.hypot(...d.camera.map((v, i) => v - DOCS[file].entry[i]));
  expect(off <= 0.01, `the camera is at ${d.camera.map((v) => fixed(v, 2))}, ${fixed(off)} m from the authored viewpoint ${DOCS[file].entry}`);
}

function expectPixels(stats, file) {
  expect(stats.content >= CONTENT_MIN, `authored content covers ${fixed(stats.content)} of the frame, under ${CONTENT_MIN} (background only)`);
  expect(stats.skyShare >= SKY_MIN, `the authored sky covers ${fixed(stats.skyShare)} of the frame, under ${SKY_MIN} (sky reference ${stats.sky})`);
  expect(stats.lit >= LIT_MIN, `lit content covers ${fixed(stats.lit)} of the frame, under ${LIT_MIN}`);
  return `${file}: content ${fixed(stats.content)}, lit ${fixed(stats.lit)}, sky ${fixed(stats.skyShare)} at sky ${stats.sky}`;
}

/** The soft-body page, with the physics bodies and a frame taken as soon as it is ready. */
const softPage = (ctx) => ctx.once("soft", async () => {
  const opened = await openDocument(ctx, docUrl(ctx, SOFT));
  const d = await debug(opened.page);
  const first = { debug: d, ball: await softPoints(opened.page, "SquishyBall"), cloth: await softPoints(opened.page, "Cloth"), image: await shot(ctx, opened.page, "soft-first") };
  return { ...opened, first };
});
const anchorPage = (ctx) => ctx.once("anchor", async () => {
  const opened = await openDocument(ctx, docUrl(ctx, ANCHOR));
  return { ...opened, first: { debug: await debug(opened.page), image: await shot(ctx, opened.page, "anchor-first") } };
});

const statements = [
  { id: "anchor-boots", says: "The anchor document boots the app shell at its authored viewpoint, with the right file and digest and authored pixels", async run(ctx) {
    const { page, first } = await anchorPage(ctx);
    expect(new URL(page.url()).pathname === "/index.html", `the page is ${page.url()}, not the app shell`);
    const shell = await page.evaluate(() => ({ role: document.getElementById("role-chip")?.textContent, title: document.getElementById("loc-title")?.textContent, mount: !!document.getElementById("scene-mount") }));
    expect(shell.mount && shell.role === "DOCUMENT VIEWER", `the app shell is not up: ${JSON.stringify(shell)}`);
    expectBoot(first.debug, ANCHOR);
    return `${expectPixels(frameStats(first.image, DOCS[ANCHOR].sky), ANCHOR)}; sha ${first.debug.sha256.slice(0, 12)}; shot ${first.image.file}`;
  } },
  { id: "walk-speed", says: `Holding W moves the viewer level at 2.4 m/s (${SPEED.join(" to ")} per second of loop time), eye height unchanged`, async run(ctx) {
    const { page } = await anchorPage(ctx);
    await page.bringToFront();
    const start = await debug(page);
    await page.keyboard.down("w");
    await untilClock(page, 0.3, 60000);
    const before = await debug(page);
    const after = await untilClock(page, 1.5, 120000);
    await page.keyboard.up("w");
    const clock = after.clock - before.clock;
    const horizontal = Math.hypot(after.camera[0] - before.camera[0], after.camera[2] - before.camera[2]);
    const speed = horizontal / clock;
    expect(horizontal > 0.5, `W moved the viewer only ${fixed(horizontal)} m (the check would be vacuous)`);
    expect(speed >= SPEED[0] && speed <= SPEED[1], `walked at ${fixed(speed)} m/s of loop time, not ${SPEED.join(" to ")}`);
    const eye = Math.max(Math.abs(after.camera[1] - start.camera[1]), Math.abs(before.camera[1] - start.camera[1]));
    expect(eye <= EYE_M, `the eye height changed ${fixed(eye)} m while walking`);
    return `${fixed(horizontal)} m in ${fixed(clock)} s of loop time: ${fixed(speed)} m/s, heading (${fixed(after.camera[0] - before.camera[0])}, ${fixed(after.camera[2] - before.camera[2])}), eye ${fixed(after.camera[1])} m`;
  } },
  { id: "anchor-click", says: "A click on the PortalAnchor disc dispatches navigation to the authored /w/b/", async run(ctx) {
    const { page } = await anchorPage(ctx);
    await page.bringToFront();
    const seen = await catchNavigations(page);
    const d = await debug(page);
    expect(!seen.length, `a navigation went out before the click: ${seen[0]}`);
    // The disc's centre, (0, 1.2, -2.5), seen from the camera; the camera looks along -Z with the authored vertical fov.
    const box = await page.$eval("#scene-mount", (mount) => { const r = mount.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; });
    const fov = d.entry.fieldOfView || 0.9;
    const depth = d.camera[2] - -2.5;
    expect(depth > 1, `the camera is ${fixed(depth)} m from the disc (the check would be vacuous)`);
    const t = Math.tan(fov / 2);
    const ndc = [(0 - d.camera[0]) / depth / (t * box.width / box.height), (1.2 - d.camera[1]) / depth / t];
    const at = { x: box.x + (ndc[0] + 1) / 2 * box.width, y: box.y + (1 - ndc[1]) / 2 * box.height };
    await page.mouse.click(at.x, at.y);
    const url = await waitForNavigation(seen);
    expect(url, `no navigation after a click at (${fixed(at.x, 0)}, ${fixed(at.y, 0)}) on the disc (timed out after ${NAV_WAIT_MS / 1000} s)`);
    const target = new URL(url);
    expect(target.pathname === "/w/b/", `the click dispatched ${url}, not /w/b/`);
    expect(target.searchParams.get("renderer") === "own-x3d", `the dispatched ${url} drops renderer=own-x3d`);
    await page.close();
    return `click at (${fixed(at.x, 0)}, ${fixed(at.y, 0)}) from camera z ${fixed(d.camera[2], 2)} dispatched ${target.pathname}${target.search} (caught and aborted)`;
  } },
  { id: "soft-boots", says: "The soft-body document boots the app shell at its authored viewpoint, with the right file and digest and authored pixels", async run(ctx) {
    const { page, first } = await softPage(ctx);
    expect(new URL(page.url()).pathname === "/index.html", `the page is ${page.url()}, not the app shell`);
    expectBoot(first.debug, SOFT);
    return `${expectPixels(frameStats(first.image, DOCS[SOFT].sky), SOFT)}; sha ${first.debug.sha256.slice(0, 12)}; shot ${first.image.file}`;
  } },
  { id: "soft-physics", says: `Bundled Ammo in the app: after ${PHYSICS_S} s of loop time the ball fell over ${BALL_FALL_M} m, the cloth moved over ${CLOTH_MOVE_M} m, and the same view changed`, async run(ctx) {
    const { page, first, responses } = await softPage(ctx);
    await page.bringToFront();
    const loaded = (pattern) => responses.find((r) => pattern.test(new URL(r.url).pathname));
    const ammo = loaded(/\/vendor\/scene-core\/vendor\/x_ite\/assets\/components\/RigidBodyPhysicsComponent\.min\.js$/);
    expect(ammo && ammo.status === 200, `the bundled Ammo component was not loaded from the app base: ${JSON.stringify(ammo || null)}`);
    expect(first.ball && first.cloth, `the scene holds no soft bodies SquishyBall and Cloth (ball ${!!first.ball}, cloth ${!!first.cloth})`);
    const later = await untilClock(page, PHYSICS_S - (( await debug(page)).clock - first.debug.clock), 300000);
    const ball = await softPoints(page, "SquishyBall");
    const cloth = await softPoints(page, "Cloth");
    const image = await shot(ctx, page, "soft-after-7s");
    const elapsed = later.clock - first.debug.clock;
    const fall = centre(first.ball)[1] - centre(ball)[1];
    let clothMove = 0;
    for (let i = 0; i < cloth.length; i += 1) clothMove = Math.max(clothMove, Math.hypot(...cloth[i].map((v, k) => v - first.cloth[i][k])));
    const sameView = Math.hypot(...later.camera.map((v, i) => v - first.debug.camera[i]));
    expect(sameView <= 0.001, `the view moved ${fixed(sameView)} m between the frames (the pixel comparison would mean nothing)`);
    expect(fall > BALL_FALL_M, `the ball fell ${fixed(fall)} m in ${fixed(elapsed)} s of loop time, not over ${BALL_FALL_M} m`);
    expect(clothMove > CLOTH_MOVE_M, `the cloth moved at most ${fixed(clothMove)} m, not over ${CLOTH_MOVE_M} m`);
    const changed = changedShare(first.image, image);
    expect(changed > PIXEL_CHANGE_MIN, `the same view changed in ${fixed(changed, 4)} of the frame, under ${PIXEL_CHANGE_MIN}`);
    return `Ammo ${ammo.status}; in ${fixed(elapsed)} s of loop time the ball centre fell ${fixed(fall)} m (from y ${fixed(centre(first.ball)[1], 2)}), cloth max move ${fixed(clothMove)} m (${cloth.length} nodes, ball ${ball.length}); pixels changed ${fixed(changed, 4)}; shots ${first.image.file}, ${image.file}`;
  } },
  { id: "route-dispose", says: "Leaving the route (the app's pagehide disposal) releases physics before the scene and leaves no live canvas", async run(ctx) {
    const { page } = await softPage(ctx);
    await page.bringToFront();
    const result = await page.evaluate(async () => {
      const entry = performance.getEntriesByType("resource").find((e) => /\/x_ite\.min\.mjs$/.test(new URL(e.name).pathname));
      if (!entry) return { error: "the page never loaded x_ite.min.mjs" };
      const X3D = (await import(entry.name)).default;
      const Ammo = X3D.Namespace.AmmoClass;
      if (!Ammo || typeof Ammo.destroy !== "function") return { error: "no bundled Ammo in the page" };
      const impl = window.__assembly.scene._impl;
      const scene = impl.scene, canvas = impl.renderer.domElement;
      const order = [];
      const destroy = Ammo.destroy, clear = scene.clear;
      Ammo.destroy = function wrapped(object) { order.push("physics"); return destroy.call(this, object); };
      scene.clear = function wrapped() { order.push("scene"); return clear.call(this); };
      const childrenBefore = scene.children.length;
      let thrown = null;
      try { window.__assembly.dispose(); } catch (error) { thrown = String(error && error.message || error); }
      await new Promise((r) => setTimeout(r, 600));
      Ammo.destroy = destroy;
      const live = (c) => { const gl = c.getContext("webgl2") || c.getContext("webgl"); return !!gl && !gl.isContextLost(); };
      const mount = document.getElementById("scene-mount");
      return { order: [order.indexOf("physics"), order.indexOf("scene")], destroys: order.filter((o) => o === "physics").length,
        childrenBefore, childrenAfter: scene.children.length, thrown,
        canvasConnected: canvas.isConnected, canvasLive: live(canvas),
        liveInMount: mount ? [...mount.querySelectorAll("canvas")].filter(live).length : 0,
        disposed: window.__assembly.disposed === true, ready: document.body.getAttribute("data-assembly-ready") };
    });
    if (result.error) fail(result.error);
    const [physicsAt, sceneAt] = result.order;
    expect(physicsAt >= 0, `leaving the route never released physics (scene released at ${sceneAt})`);
    expect(sceneAt >= 0 && result.childrenAfter === 0, `leaving the route never released the scene (${result.childrenAfter} of ${result.childrenBefore} children left)`);
    expect(physicsAt < sceneAt, `the scene was released before physics (scene at call ${sceneAt}, first physics release at ${physicsAt})`);
    expect(!result.canvasLive && result.liveInMount === 0, `a live canvas is left: renderer canvas live ${result.canvasLive} (connected ${result.canvasConnected}), ${result.liveInMount} live in the mount`);
    expect(!result.thrown, `disposal threw: ${result.thrown}`);
    await page.close();
    return `physics release at call ${physicsAt} (${result.destroys} Ammo releases) before the scene at ${sceneAt}; scene ${result.childrenBefore} -> ${result.childrenAfter} children; renderer canvas connected ${result.canvasConnected}, live ${result.canvasLive}; live canvases in mount ${result.liveInMount}`;
  } },
  { id: "soft-crossing", says: "On the soft-body document, walking into the PortalTrigger region dispatches /w/lobby/", async run(ctx) {
    const { page } = await openDocument(ctx, docUrl(ctx, SOFT));
    const seen = await catchNavigations(page);
    const start = await debug(page);
    const ahead = [0.7071, -0.7071], left = [-0.7071, -0.7071];
    const along = (d, dir) => (d.camera[0] - start.camera[0]) * dir[0] + (d.camera[2] - start.camera[2]) * dir[1];
    const inside = (d) => Math.abs(d.camera[0] - TRIGGER.centre[0]) < TRIGGER.half && Math.abs(d.camera[2] - TRIGGER.centre[1]) < TRIGGER.half;
    const leg = async (key, dir, metres, stopInside) => {
      const started = Date.now();
      await page.keyboard.down(key);
      try {
        for (;;) {
          const d = await debug(page);
          if (stopInside && (inside(d) && Math.abs(along(d, dir) - metres) < 0.3 || seen.length)) return d;
          if (along(d, dir) >= metres - 0.05) return d;
          if (Date.now() - started > 180000) fail(`the walk ${key} got ${fixed(along(d, dir))} of ${metres} m (timed out after 180 s)`);
          await sleep(15);
        }
      } finally { await page.keyboard.up(key); }
    };
    const afterAhead = await leg("w", ahead, LEG_AHEAD_M, false);
    expect(!seen.length, `a navigation went out before the trigger region: ${seen[0]}`);
    const afterLeft = await leg("ArrowLeft", left, LEG_LEFT_M, true);
    const url = await waitForNavigation(seen);
    const end = await debug(page);
    expect(inside(end) || inside(afterLeft), `the walk ended at (${fixed(end.camera[0], 2)}, ${fixed(end.camera[2], 2)}), outside the trigger region (the check would be vacuous)`);
    expect(url, `no navigation after walking into the trigger region at (${fixed(end.camera[0], 2)}, ${fixed(end.camera[2], 2)}) (timed out after ${NAV_WAIT_MS / 1000} s)`);
    const target = new URL(url);
    expect(target.pathname === "/w/lobby/", `the crossing dispatched ${url}, not /w/lobby/`);
    await page.close();
    return `walked to (${fixed(afterAhead.camera[0], 2)}, ${fixed(afterAhead.camera[2], 2)}) then (${fixed(end.camera[0], 2)}, ${fixed(end.camera[2], 2)}), eye ${fixed(end.camera[1], 2)}; dispatched ${target.pathname}${target.search} (caught and aborted)`;
  } },
  { id: "redirect", says: "/x3d-world.html?renderer=own-x3d redirects into the app shell on the anchor document", async run(ctx) {
    const url = `${ctx.lab.front}/x3d-world.html?renderer=own-x3d`;
    const page = await ctx.visit(url, { open: false });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    const started = Date.now();
    while (new URL(page.url()).pathname !== "/index.html") {
      if (Date.now() - started > 60000) fail(`the page stayed at ${new URL(page.url()).pathname} (timed out after 60 s)`);
      await sleep(200);
    }
    const landed = new URL(page.url());
    await page.waitForFunction(() => document.body.dataset.x3dWorldReady === "1", { timeout: 120000 });
    const d = await debug(page);
    expect(landed.searchParams.get("renderer") === "own-x3d" && landed.searchParams.get("x3dDocument") === ANCHOR, `the redirect landed on ${landed.pathname}${landed.search}`);
    expectBoot(d, ANCHOR);
    await page.close();
    return `landed on ${landed.pathname}${landed.search}; debugState ${d.file}`;
  } },
  { id: "default-route", says: "The default three.js route (no renderer parameter) still boots on the same lab", async run(ctx) {
    const page = await ctx.visit(`${ctx.lab.front}/index.html?role=player&intro=bypass`);
    const facts = await pageFacts(page);
    const notDocument = await page.evaluate(() => !window.__x3dWorld && document.body.dataset.x3dWorldReady !== "1" && window.__assembly.rendererKind);
    expect(facts.location && facts.position, `the default route has no world or avatar: ${JSON.stringify({ location: facts.location, phase: facts.phase })}`);
    expect(notDocument, "the default route came up as the X3D document viewer");
    const image = await shot(ctx, page, "default-route");
    const counts = new Map();
    for (let i = 0; i < image.rgba.length; i += 4) { const key = `${image.rgba[i] >> 4},${image.rgba[i + 1] >> 4},${image.rgba[i + 2] >> 4}`; counts.set(key, (counts.get(key) || 0) + 1); }
    const mode = Math.max(...counts.values()) / (image.rgba.length / 4);
    expect(1 - mode >= CONTENT_MIN, `the default route's frame is ${fixed(mode)} one colour`);
    await page.close();
    return `location ${facts.location}, phase ${facts.phase}, renderer ${notDocument}, frame ${fixed(1 - mode)} off its commonest colour; shot ${image.file}`;
  } },
];

const DOC = "web/own-x3d-document.mjs";
const RENDER = "runtime/scene-core/public/render/three/scene-view.mjs";
const faults = [
  { statement: "anchor-boots", name: "shapes realized hidden, so only the background draws", expect: /authored content covers/, edits: [
    { file: RENDER, find: `if (shape) { place(shape, entity.transform); into.add(register(shape, entity, layer)); built.set(entity.id, shape); continue; }`, replace: `if (shape) { place(shape, entity.transform); const hidden = register(shape, entity, layer); hidden.visible = false; into.add(hidden); built.set(entity.id, shape); continue; }` }] },
  { statement: "soft-boots", name: "lighting removed: directional and environment light at zero", expect: /lit content covers/, edits: [
    { file: RENDER, find: "new THREE.DirectionalLight(new THREE.Color().fromArray(light.color), light.intensity)", replace: "new THREE.DirectionalLight(new THREE.Color().fromArray(light.color), 0)" },
    { file: RENDER, find: "if (light.ambientIntensity) parent.add(", replace: "if (false) parent.add(" },
    { file: RENDER, find: "new THREE.AmbientLight(new THREE.Color().fromArray(environment.color), environment.intensity));", replace: "new THREE.AmbientLight(new THREE.Color().fromArray(environment.color), 0));" }] },
  { statement: "walk-speed", name: "the document viewer walks at half speed", expect: /walked at [\d.]+ m\/s/, edits: [
    { file: "web/movement-camera-controller.mjs", find: "const distance = 2.4 * deltaSeconds;", replace: "const distance = 1.2 * deltaSeconds;" }] },
  { statement: "anchor-click", name: "the route allowlist names /w/a/ for the anchor document", expect: /no navigation after a click/, edits: [
    { file: DOC, find: `destination: filename === SOFT ? "/w/lobby/" : "/w/b/" });`, replace: `destination: filename === SOFT ? "/w/lobby/" : "/w/a/" });` }] },
  { statement: "soft-crossing", name: "crossing intents are never dispatched", expect: /no navigation after walking/, edits: [
    { file: DOC, find: "for (const intent of result.intents) dispatch(intent);", replace: "for (const intent of []) dispatch(intent);" }] },
  { statement: "soft-physics", name: "physics never advances", expect: /the ball fell/, edits: [
    { file: "runtime/scene-core/public/physics/bullet/soft-body.mjs", find: "world.stepSimulation(delta, 10);", replace: "world.stepSimulation(0, 10);" }] },
  { statement: "route-dispose", name: "the scene is released before physics", expect: /the scene was released before physics/, edits: [
    { file: DOC, find: "for (const release of [() => documents?.cancel(), () => physics?.dispose(), () => rendererPreparation.dispose(), () => documents?.dispose()]) {", replace: "for (const release of [() => documents?.cancel(), () => rendererPreparation.dispose(), () => physics?.dispose(), () => documents?.dispose()]) {" }] },
  { statement: "redirect", name: "x3d-world.html no longer redirects own-x3d", expect: /the page stayed at/, edits: [
    { file: "web/x3d-world.mjs", find: `if (requestedKind === "own-x3d") {`, replace: `if (false) {` }] },
];

// Item 3: an environment URI and intensity on the document route. x3dEnvironment=sky-gradient.hdr (the only admitted
// file) and x3dEnvironmentIntensity=<number >= 0, default 1>. Besides debugState and canvas pixels these statements read
// the published scene's environment texture, the adapter's environment state (owned asset, applied intensity, whether
// a resolver or lighting call exists) and the scene's materials: safe reads that change nothing. The one exception says
// so: env-pixels adds a harness MeshStandardMaterial probe sphere to the scene, because the authored X3D shapes are Phong
// and do not take a scene environment (the declared limit, measured below).
const ENV_FILE = "sky-gradient.hdr";
const ENV_PATH = `/x3d-worlds/environments/${ENV_FILE}`;
const envUrl = (ctx, file, extra = "") => `${docUrl(ctx, file)}&x3dEnvironment=${ENV_FILE}${extra}`;
const FLOAT_TYPE = 1015, EQUIRECT_REFLECTION = 303, CUBE_UV_REFLECTION = 306; // three r160 constants
const ENV_TEXELS = [[0, 0], [5, 7], [17, 15], [40, 31]];
const PROBE_LUMA_MIN = 2; // mean luminance gain of the probe with the environment, 0-255 (the native proof saw +16.9)
const PROBE_CHANGED_MIN = 0.2; // share of probe pixels brighter by more than 4 of 255
const BOOT_FAILURE = "[connection] handled live-world boot failure:";

/** The file the route serves, decoded in Node with the same decoder the page uses. */
const envReference = () => decodeRgbe(readFileSync(SKY_GRADIENT_PATH));

/** The route's lighting status and what is installed, read from the page; nothing is changed. */
const envRead = (page) => page.evaluate((texels) => {
  const d = window.__x3dWorld.debugState();
  const impl = window.__assembly.scene._impl, scene = impl.scene, adapter = impl.renderAdapter;
  const env = scene.environment, state = adapter._environment || null, data = env?.image?.data;
  let materials = 0, standard = 0;
  const intensities = [], seen = new Set();
  scene.traverse((node) => {
    for (const m of [node.material].flat()) {
      if (!m || seen.has(m)) continue;
      seen.add(m); materials += 1;
      if (m.isMeshStandardMaterial) { standard += 1; intensities.push(m.envMapIntensity); }
    }
  });
  return { file: d.file, lighting: d.lighting,
    environment: env ? { isDataTexture: !!env.isDataTexture, width: env.image?.width, height: env.image?.height, type: env.type, mapping: env.mapping, flipY: env.flipY,
      texels: texels.map(([x, y]) => (data ? Array.from(data.slice((y * env.image.width + x) * 4, (y * env.image.width + x) * 4 + 4)) : null)) } : null,
    owned: state ? { asset: state.owned?.asset ?? null, onScene: !!state.owned && state.owned.scene === scene, intensity: state.intensity, pending: !!state.pending } : null,
    resolverSet: typeof adapter._environmentResolver === "function", lightingCalled: adapter._lightingResult !== undefined,
    materials, standard, intensities };
}, ENV_TEXELS);

const hdrRequests = (opened) => opened.requests.filter((url) => new URL(url).pathname.endsWith(".hdr"));

/** Environment applied from the app base: status, owned asset on the current scene, the texture and its texels. */
function expectApplied(ctx, opened, read, intensity) {
  const want = `${ENV_PATH}`;
  expect(read.lighting && read.lighting.status === "applied", `the lighting status is ${JSON.stringify(read.lighting)}, not applied`);
  expect(read.lighting.file === ENV_FILE && read.lighting.asset === want && read.lighting.intensity === intensity, `debugState lighting names ${read.lighting.file} ${read.lighting.asset} at ${read.lighting.intensity}, not ${ENV_FILE} ${want} at ${intensity}`);
  expect(read.owned && read.owned.asset === want && read.owned.onScene && !read.owned.pending, `the adapter's environment is ${JSON.stringify(read.owned)}, not ${want} on the current scene`);
  const env = read.environment;
  expect(env && env.isDataTexture && env.width === 64 && env.height === 32 && env.type === FLOAT_TYPE && env.mapping === EQUIRECT_REFLECTION,
    `scene.environment is ${JSON.stringify(env && { ...env, texels: undefined })}, not a 64x32 float equirect DataTexture`);
  const ref = envReference();
  ENV_TEXELS.forEach(([x, y], i) => {
    const got = env.texels[i], at = (y * ref.width + x) * 3, exp = [ref.data[at], ref.data[at + 1], ref.data[at + 2], 1];
    expect(got && got.every((v, k) => v === exp[k]), `texel (${x}, ${y}) on the scene is ${got}, the file decodes to ${exp}`);
  });
  const hdr = hdrRequests(opened);
  expect(hdr.length === 1 && hdr[0] === `${ctx.lab.front}${ENV_PATH}`, `the page asked for ${hdr.length} .hdr files (${hdr.join(", ")}), not exactly ${ctx.lab.front}${ENV_PATH} once`);
  const response = opened.responses.find((r) => r.url === hdr[0]);
  expect(response && response.status === 200, `the .hdr answered ${response ? response.status : "nothing"}`);
  return `status applied, ${want} at ${intensity}; 64x32 float equirect on the current scene, ${ENV_TEXELS.length} texels equal the file; one .hdr request ${new URL(hdr[0]).pathname} ${response.status}`;
}

const envAnchorPage = (ctx) => ctx.once("env-anchor", async () => {
  const opened = await openDocument(ctx, envUrl(ctx, ANCHOR));
  return { ...opened, first: { debug: await debug(opened.page), image: await shot(ctx, opened.page, "env-anchor-first") } };
});
const controlAnchorPage = (ctx) => ctx.once("control-anchor", async () => {
  const opened = await openDocument(ctx, docUrl(ctx, ANCHOR));
  return { ...opened, first: { debug: await debug(opened.page), image: await shot(ctx, opened.page, "control-anchor-first") } };
});

/** Adds a harness probe sphere (MeshStandardMaterial, linear grey 0.25, roughness 1) 3 m ahead of the camera, frames it with and without, and removes it. */
async function probe(ctx, page, name) {
  await page.bringToFront();
  const setup = await page.evaluate(async () => {
    const entry = performance.getEntriesByType("resource").find((e) => /\/three\.module\.js$/.test(new URL(e.name).pathname));
    if (!entry) return { error: "the page never loaded three.module.js" };
    const THREE = await import(entry.name);
    const impl = window.__assembly.scene._impl;
    const material = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.25, 0.25, 0.25), roughness: 1, metalness: 0 });
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.6, 48, 24), material);
    mesh.name = "x3d-route-check-probe";
    const forward = impl.camera.getWorldDirection(new THREE.Vector3());
    mesh.position.copy(impl.camera.position).addScaledVector(forward, 3);
    impl.scene.add(mesh);
    window.__x3dRouteProbe = mesh;
    return { at: mesh.position.toArray() };
  });
  if (setup.error) fail(setup.error);
  try {
    await untilClock(page, 0.3, 60000);
    const shown = await shot(ctx, page, `${name}-probe`);
    const facts = await page.evaluate(() => {
      const impl = window.__assembly.scene._impl, mesh = window.__x3dRouteProbe;
      const envMap = impl.renderer.properties.get(mesh.material).envMap || null;
      return { envMap: envMap ? { mapping: envMap.mapping, isRenderTargetTexture: !!envMap.isRenderTargetTexture, width: envMap.image?.width, height: envMap.image?.height } : null,
        envMapIntensity: mesh.material.envMapIntensity, sceneEnvironment: !!impl.scene.environment };
    });
    await page.evaluate(() => { window.__x3dRouteProbe.visible = false; });
    await untilClock(page, 0.3, 60000);
    const hidden = await shot(ctx, page, `${name}-probe-hidden`);
    let count = 0, luma = 0;
    const lumas = [];
    for (let i = 0; i < shown.rgba.length; i += 4) {
      const d = Math.max(Math.abs(shown.rgba[i] - hidden.rgba[i]), Math.abs(shown.rgba[i + 1] - hidden.rgba[i + 1]), Math.abs(shown.rgba[i + 2] - hidden.rgba[i + 2]));
      if (d <= 24) { lumas.push(null); continue; }
      const l = 0.2126 * shown.rgba[i] + 0.7152 * shown.rgba[i + 1] + 0.0722 * shown.rgba[i + 2];
      lumas.push(l); count += 1; luma += l;
    }
    return { ...facts, at: setup.at, mask: count, meanLuma: count ? luma / count : 0, lumas, shown, hidden };
  } finally {
    await page.evaluate(() => { const mesh = window.__x3dRouteProbe; mesh?.parent?.remove(mesh); mesh?.geometry.dispose(); mesh?.material.dispose(); delete window.__x3dRouteProbe; });
  }
}

/** Opens a document route that must refuse to boot, and returns the boot failure message the app logs. */
async function openRefused(ctx, url) {
  const page = await ctx.visit(url, { open: false });
  const consoleLines = [], requests = [];
  page.on("console", (message) => consoleLines.push(message.text()));
  page.on("request", (request) => requests.push(request.url()));
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  const started = Date.now();
  for (;;) {
    const failure = consoleLines.find((line) => line.startsWith(BOOT_FAILURE));
    const state = await page.evaluate(() => ({ ready: document.body.dataset.x3dWorldReady === "1", lighting: window.__x3dWorld?.debugState?.().lighting ?? null })).catch(() => ({ ready: false }));
    if (failure || state.ready) {
      const text = await page.evaluate(() => document.body.textContent);
      await page.close();
      return { failure: failure ? failure.slice(BOOT_FAILURE.length).trim() : null, booted: state.ready, lighting: state.lighting, text, hdr: requests.filter((u) => new URL(u).pathname.endsWith(".hdr")) };
    }
    if (Date.now() - started > 120000) { await page.close(); return { failure: null, booted: false, timedOut: true, hdr: requests.filter((u) => new URL(u).pathname.endsWith(".hdr")) }; }
    await sleep(250);
  }
}

statements.push(
  { id: "env-decoder", says: "The generated sky gradient is the file the generator builds, and the pure RGBE decoder reads it, flat and RLE scanlines alike, and refuses malformed input", async run() {
    const lines = skyGradientSelfTest();
    const bytes = readFileSync(SKY_GRADIENT_PATH);
    return `${bytes.length} bytes, sha256 ${createHash("sha256").update(bytes).digest("hex")}; ${lines.join("; ")}`;
  } },
  { id: "env-applied", says: `The anchor document with x3dEnvironment=${ENV_FILE} applies the environment: status applied, the file's texels on the scene, one .hdr fetch from the app base`, async run(ctx) {
    const opened = await envAnchorPage(ctx);
    const read = await envRead(opened.page);
    expectBoot(opened.first.debug, ANCHOR);
    return `${expectApplied(ctx, opened, read, 1)}; resolver set ${read.resolverSet}`;
  } },
  { id: "env-pixels", says: "The environment changes pixels on content that takes it; authored Phong shapes do not (declared limit), so a harness Standard probe shows it, with PMREM built from the route's texture", async run(ctx) {
    const env = await envAnchorPage(ctx), control = await controlAnchorPage(ctx);
    const read = await envRead(env.page);
    expect(read.environment && read.lighting?.status === "applied", `no environment is installed (status ${read.lighting?.status})`);
    const authored = changedShare(control.first.image, env.first.image);
    const same = Math.hypot(...env.first.debug.camera.map((v, i) => v - control.first.debug.camera[i]));
    expect(same <= 0.001, `the two first frames are ${fixed(same)} m apart (the comparison would mean nothing)`);
    let authoredNote;
    if (read.standard > 0) {
      expect(authored > PIXEL_CHANGE_MIN, `${read.standard} Standard materials on the route, yet the same view changed in only ${fixed(authored, 4)} of the frame`);
      authoredNote = `${read.standard} Standard materials on the route; the same view changed in ${fixed(authored, 4)} of the frame`;
    } else {
      authoredNote = `declared limit: 0 Standard of ${read.materials} materials on the route (authored Phong), the same view with and without the environment differs in ${fixed(authored, 4)} of the frame`;
    }
    const lit = await probe(ctx, env.page, "env-anchor");
    const dark = await probe(ctx, control.page, "control-anchor");
    expect(lit.envMap && lit.envMap.mapping === CUBE_UV_REFLECTION && lit.envMap.isRenderTargetTexture, `the probe's renderer envMap is ${JSON.stringify(lit.envMap)}, not a PMREM (CubeUV render target) built from the scene environment`);
    expect(!dark.envMap, `without the parameter the probe still has an envMap ${JSON.stringify(dark.envMap)}`);
    expect(lit.mask > 500 && dark.mask > 500, `the probe covers ${lit.mask} and ${dark.mask} pixels (the comparison would mean nothing)`);
    let brighter = 0, both = 0;
    for (let i = 0; i < lit.lumas.length; i += 1) if (lit.lumas[i] != null && dark.lumas[i] != null) { both += 1; if (lit.lumas[i] - dark.lumas[i] > 4) brighter += 1; }
    const gain = lit.meanLuma - dark.meanLuma, share = both ? brighter / both : 0;
    expect(gain >= PROBE_LUMA_MIN && share >= PROBE_CHANGED_MIN, `the probe's mean luminance went ${fixed(dark.meanLuma, 2)} -> ${fixed(lit.meanLuma, 2)} (+${fixed(gain, 2)}, ${fixed(share)} of ${both} shared pixels brighter by over 4), under +${PROBE_LUMA_MIN} and ${PROBE_CHANGED_MIN}`);
    return `${authoredNote}; probe at ${lit.at.map((v) => fixed(v, 2))}: PMREM ${lit.envMap.width}x${lit.envMap.height} CubeUV render target (none without the parameter), mean luminance ${fixed(dark.meanLuma, 2)} -> ${fixed(lit.meanLuma, 2)} (+${fixed(gain, 2)}), ${fixed(share)} of ${both} probe pixels brighter by over 4; probe envMapIntensity ${lit.envMapIntensity} (added after the environment: the contract's later-material limit); shots ${env.first.image.file}, ${control.first.image.file}, ${lit.shown.file}, ${dark.shown.file}`;
  } },
  { id: "env-intensity", says: "x3dEnvironmentIntensity 0.5 and 2 are applied in that order (pixels only where Standard materials take them)", async run(ctx) {
    const results = [];
    for (const intensity of [0.5, 2]) {
      const opened = await openDocument(ctx, envUrl(ctx, ANCHOR, `&x3dEnvironmentIntensity=${intensity}`));
      const read = await envRead(opened.page);
      expect(read.lighting?.status === "applied", `at ${intensity} the lighting status is ${JSON.stringify(read.lighting)}, not applied`);
      expect(read.lighting.intensity === intensity, `debugState names intensity ${read.lighting.intensity}, not ${intensity}`);
      expect(read.owned && read.owned.intensity === intensity, `the adapter's applied intensity is ${read.owned?.intensity}, not the requested ${intensity}`);
      results.push({ intensity, read, image: await shot(ctx, opened.page, `env-intensity-${intensity}`) });
      await opened.page.close();
    }
    const [low, high] = results;
    expect(low.read.owned.intensity < high.read.owned.intensity, `applied intensities ${low.read.owned.intensity} and ${high.read.owned.intensity} are not ordered`);
    let pixels;
    if (low.read.standard > 0) {
      const ordered = low.read.intensities.every((v) => v === 0.5) && high.read.intensities.every((v) => v === 2);
      expect(ordered, `Standard materials hold envMapIntensity ${low.read.intensities} and ${high.read.intensities}, not 0.5 and 2`);
      pixels = `${low.read.standard} Standard materials at envMapIntensity 0.5 and 2`;
    } else {
      pixels = `not measurable in pixels on the route: 0 Standard of ${low.read.materials} materials (authored Phong); the two frames differ in ${fixed(changedShare(low.image, high.image), 4)} of the frame`;
    }
    return `applied intensity 0.5 < 2 (adapter state and debugState agree), status applied both; ${pixels}; shots ${low.image.file}, ${high.image.file}`;
  } },
  { id: "env-soft", says: `The soft-body document with x3dEnvironment=${ENV_FILE} applies the environment again after its own loadDocument`, async run(ctx) {
    const opened = await openDocument(ctx, envUrl(ctx, SOFT));
    const read = await envRead(opened.page);
    const d = await debug(opened.page);
    expectBoot(d, SOFT);
    const applied = expectApplied(ctx, opened, read, 1);
    const image = await shot(ctx, opened.page, "env-soft");
    await opened.page.close();
    return `${read.file}: ${applied}; shot ${image.file}`;
  } },
  { id: "env-errors", says: "An unknown environment file and a negative intensity stop the boot with a clear error, and fetch no .hdr", async run(ctx) {
    const cases = [
      { query: "&x3dEnvironment=other.hdr", message: 'Unknown X3D environment "other.hdr"; admitted: sky-gradient.hdr' },
      { query: `&x3dEnvironment=${ENV_FILE}&x3dEnvironmentIntensity=-1`, message: 'x3dEnvironmentIntensity must be a finite number >= 0, not "-1"' },
    ];
    const out = [];
    for (const { query, message } of cases) {
      const result = await openRefused(ctx, `${docUrl(ctx, ANCHOR)}${query}`);
      expect(!result.booted && result.failure, `${query.slice(1)} gave no clear error: ${result.booted ? `the route booted (lighting ${JSON.stringify(result.lighting)})` : "no boot failure within 120 s"}`);
      expect(result.failure === message, `${query.slice(1)} failed with "${result.failure}", not "${message}"`);
      expect(result.text.includes(message), `the page does not show "${message}"`);
      expect(result.hdr.length === 0, `${query.slice(1)} still asked for ${result.hdr.join(", ")}`);
      out.push(`${query.slice(1)} -> "${result.failure}" (shown on the page, no .hdr request)`);
    }
    return out.join("; ");
  } },
  { id: "env-absent", says: "With neither parameter: no .hdr request, no resolver, no lighting call, no scene environment", async run(ctx) {
    const control = await controlAnchorPage(ctx);
    const read = await envRead(control.page);
    const hdr = hdrRequests(control);
    expect(hdr.length === 0, `the page asked for ${hdr.join(", ")}`);
    expect(read.lighting === null, `debugState lighting is ${JSON.stringify(read.lighting)}, not null`);
    expect(!read.resolverSet && !read.lightingCalled && !read.owned, `resolver set ${read.resolverSet}, lighting called ${read.lightingCalled}, adapter environment ${JSON.stringify(read.owned)}`);
    expect(!read.environment, "the scene has an environment without the parameter");
    return `0 .hdr requests of ${control.requests.length}; lighting null; no resolver, no setLighting, scene.environment null`;
  } },
);

faults.push(
  { statement: "env-applied", name: "the app never sets the environment resolver", expect: /the lighting status is/, edits: [
    { file: "web/app.js", find: `if (x3dEnvironment.selection && choice.active.adapter?.kind === "own-x3d") choice.active.adapter.setEnvironmentResolver(resolveX3dEnvironment);`, replace: `if (false) choice.active.adapter.setEnvironmentResolver(resolveX3dEnvironment);` }] },
  { statement: "env-intensity", name: "the requested intensity is ignored (always 1)", expect: /applied intensity is 1, not the requested 0.5/, edits: [
    { file: DOC, find: "environment: Object.freeze({ asset: url, intensity: value })", replace: "environment: Object.freeze({ asset: url, intensity: 1 })" }] },
  { statement: "env-errors", name: "the environment allowlist admits any file", expect: /other\.hdr gave no clear error/, edits: [
    { file: DOC, find: "if (!ENVIRONMENTS.includes(file)) throw", replace: "if (false) throw" }] },
);

// ---- The drawn catalog on the live own-X3D route ---------------------------------------------------------------
// The accepted manifest's remaining.nativeCatalog names this gap: the catalog was proved on the CPU (resources,
// deformation, materials) but nothing showed the four avatars, their seven items or their deformation DRAWN. These
// statements drive the app's published driver on the live lobby route (?renderer=own-x3d&role=player&intro=bypass) and
// measure canvas pixels.
//
// Every pixel count is confined to a window projected from the rig's own bones through the live camera
// (window.__assembly.viewport.identity()); nothing outside a window is part of any metric. The lobby's portal windows
// refresh their live destination previews all the time, so body identity and body materials are read on the body's
// LOWER BODY window, which stands in front of the floor and not in front of a portal: those pixels are the avatar's,
// and a moving preview cannot enter them.
const CATALOG_SHOTS = join(SHOTS_ROOT, "catalog");
const CATALOG_VARIANTS = ["collection-adam", "collection-megan", "collection-elizabeth", "collection-sophie"];
const CATALOG_ITEMS = ["equip-hat", "equip-helmet", "equip-crown", "equip-torch", "equip-shield", "equip-mug", "equip-hammer"];
const PIXEL_DIFF = 24; // a changed pixel: over 24 of 255 in one channel, the kit's own margin
const DRAW_WAIT_MS = 180000;
const SCENE_SETTLE_S = 0.6; // a last frame or two of the boot's own settling, nothing more
const BOX_PAD_PX = 8; // pad around the whole projected body
const LEGS_PAD_PX = 6; // pad around the lower-body window
const LEGS_COLOURS_MIN = 24; // distinct 16-level colours in the lower-body window: a drawn body, not bare floor
const LEGS_SPREAD_MIN = 8; // luminance standard deviation there
const AVATAR_PAIR_MIN = 0.1; // share of the lower-body window in which two variants must differ
const BODY_PAIR_MIN = 0.05; // share of the whole projected body box in which two variants must differ
const HEIGHT_MATCH_M = 0.02; // avatar_model_height_m against the prepared file's drawn_height_m
const HEIGHT_RANK_MIN_M = 0.05; // a pair this far apart in metres must order the same way in pixels ...
const HEIGHT_RANK_PX = 3; // ... by at least this many rows
const BOOT_COLOURS_MIN = 24; // distinct 16-level colours inside the box at boot (a drawn avatar, not a flat fill)
const ITEM_BOX_PAD = { head: 34, leftHand: 26, rightHand: 26 }; // pixels around an attachment bone: the item draws there
const ITEM_BOX_FLOOR = 30; // pixels an equip must change inside its box, whatever the noise
const ITEM_NOISE_FACTOR = 3; // ... and this many times the change the same box makes with no equip
const ITEM_ADD_FLOOR = 150; // drawn pixels an item must add inside its own window, over the drift
const ITEM_DISTANCE_MAX_M = 0.5; // how far the nearest attached object may sit from the item's attachment bone
const MATERIAL_COLOURS_MIN = 24; // distinct 16-level colours on the drawn lower body
const MATERIAL_DETAIL_MIN = 1.5; // mean |change of luminance| between neighbouring drawn pixels, of 255
const MATERIAL_SPREAD_MIN = 8; // luminance standard deviation on the drawn lower body
const MATERIAL_MEAN_DIFF_MIN = 12; // RGB distance between two variants' mean drawn colour
const DEFORM_SECONDS = 1.2; // idle loop time between the two frames
const DEFORM_ANIM_MIN = 0.004; // share of the avatar's box the idle clip changes
const DEFORM_BONE_MIN_M = 0.002; // largest avatar-local bone move over the idle interval

const catalogUrl = (ctx, variant = null, { equipment = false } = {}) => `${ctx.lab.front}/index.html?renderer=own-x3d&role=player&intro=bypass${equipment ? "&noequip=0" : ""}${variant ? `&avatar_variant=${variant}` : ""}`;
const avatarName = (key) => key.replace(/^collection-/, "");
const itemName = (id) => id.replace(/^equip-/, "");

/** The catalog's own drawn height for a variant, read from the prepared file the page loads. */
function catalogHeight(key) {
  const name = avatarName(key);
  const prepared = JSON.parse(readFileSync(join(CODE, "web", "assets", "actionforge", "characters", name, `${name}.avatar.json`), "utf8"));
  const height = prepared && prepared.avatar ? prepared.avatar.drawn_height_m : null;
  return typeof height === "number" ? height : null;
}

const catalogClock = (page) => page.evaluate(() => (window.__behaviorClock ? window.__behaviorClock.seconds : null));
const catalogCamera = (page) => page.evaluate(() => {
  const camera = window.__assembly.viewport.identity().camera;
  const q = camera.quaternion;
  return [camera.position.x, camera.position.y, camera.position.z, q.x, q.y, q.z, q.w];
});

/**
 * Wait until a switch or an equip has been applied by the layer, until the follow camera STANDS STILL (after boot it
 * eases into place, and two frames across that ease compare two views), then for `seconds` more of the loop clock.
 */
async function catalogWait(page, seconds = 0.4, limitMs = DRAW_WAIT_MS) {
  await page.waitForFunction(() => window.__assembly?.equipmentReady?.() !== false && window.__assembly.avatarVisualState?.()?.avatar_switch_in_flight !== true, { timeout: limitMs, polling: 60 });
  const steady = Date.now();
  let previous = await catalogCamera(page), stable = 0;
  while (stable < 2) {
    await sleep(200);
    const next = await catalogCamera(page);
    stable = Math.max(...next.map((value, i) => Math.abs(value - previous[i]))) <= 1e-5 ? stable + 1 : 0;
    previous = next;
    if (Date.now() - steady > limitMs) fail(`the camera has not stood still after ${fixed((Date.now() - steady) / 1000, 1)} s`);
  }
  const start = await catalogClock(page);
  expect(start !== null, "the page carries no frame-loop clock");
  const started = Date.now();
  for (;;) {
    const clock = await catalogClock(page);
    if (clock !== null && clock - start >= seconds) return clock;
    if (Date.now() - started > limitMs) fail(`the live route's loop got ${fixed((clock || 0) - start)} of ${seconds} s (timed out after ${limitMs / 1000} s)`);
    await sleep(40);
  }
}

/** What draws the live route: the own-X3D adapter, one canvas, and the avatar layer on the scene's own renderer canvas. */
const catalogRoute = (page) => page.evaluate(() => {
  const mount = document.getElementById("scene-mount");
  const canvases = mount ? [...mount.querySelectorAll("canvas")] : [];
  const layers = window.__assembly.__depthProbeLayers ? window.__assembly.__depthProbeLayers() : null;
  const identity = window.__assembly.viewport.identity();
  const mountRect = mount ? mount.getBoundingClientRect() : null;
  const canvasRect = identity.canvas ? identity.canvas.getBoundingClientRect() : null;
  return { active: window.__renderAdapter ? window.__renderAdapter.active : null,
    rendererKind: window.__assembly.rendererKind || null, sceneRendererKind: window.__assembly.scene ? window.__assembly.scene.rendererKind : null,
    canvases: canvases.length, canvasIsScene: !!identity.canvas && canvases.includes(identity.canvas),
    layerCanvasIsScene: !!layers && !!layers.local_canvas && layers.local_canvas === identity.canvas,
    canvasFillsMount: !!mountRect && !!canvasRect && Math.abs(mountRect.left - canvasRect.left) < 1 && Math.abs(mountRect.top - canvasRect.top) < 1
      && Math.abs(mountRect.width - canvasRect.width) < 1 && Math.abs(mountRect.height - canvasRect.height) < 1 };
});

function expectCatalogRoute(route, where) {
  expect(route.active === "own-x3d", `${where} > is drawn by ${route.active}, not the own-X3D adapter`);
  expect(route.rendererKind === "webgl" && route.sceneRendererKind === "webgl", `the live route's renderer is ${route.rendererKind}/${route.sceneRendererKind}, not webgl`);
  expect(route.canvases === 1 && route.canvasIsScene && route.layerCanvasIsScene && route.canvasFillsMount,
    `${where} > has ${route.canvases} canvases in the mount, the scene canvas ${route.canvasIsScene}, the avatar layer on it ${route.layerCanvasIsScene}, the canvas filling the mount ${route.canvasFillsMount}`);
  return `${route.active}/${route.rendererKind}, 1 canvas shared by the scene and the avatar layer`;
}

/** World points that bound the drawn body: the sampled bones, plus the top and bottom of the body at the rig's foot. */
function rigPoints(rig) {
  expect(rig && rig.bones, `rigProbe answered no bones (${JSON.stringify(rig && { ok: rig.ok, reason: rig.reason } || null)})`);
  const points = Object.values(rig.bones).filter((bone) => bone && bone.world).map((bone) => bone.world);
  expect(Number.isFinite(rig.body_top_world_y) && Number.isFinite(rig.body_bottom_world_y), `rigProbe gave no body bounds (top ${rig.body_top_world_y}, bottom ${rig.body_bottom_world_y})`);
  const at = rig.avatar_rig_world || [0, 0, 0];
  points.push([at[0], rig.body_top_world_y, at[2]], [at[0], rig.body_bottom_world_y, at[2]]);
  return points;
}

/** The world points of the lower body: the four lower-leg and foot bones, in front of the floor and not a portal. */
function legsPoints(rig) {
  const points = ["leftLowerLeg", "rightLowerLeg", "leftFoot", "rightFoot"].map((name) => (rig && rig.bones ? (rig.bones[name] || {}).world : null)).filter(Boolean);
  expect(points.length >= 3, `rigProbe gave ${points.length} of the four lower-leg bone world positions`);
  return points;
}

const padBox = (box, pad, width, height) => ({ left: Math.max(0, box.left - pad), right: Math.min(width - 1, box.right + pad), top: Math.max(0, box.top - pad), bottom: Math.min(height - 1, box.bottom + pad) });
const boxWidth = (box) => Math.max(0, box.right - box.left + 1);
const boxHeight = (box) => Math.max(0, box.bottom - box.top + 1);
const inBox = (box, x, y) => x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
const pixelDelta = (a, b, pixel) => Math.max(Math.abs(a.rgba[pixel * 4] - b.rgba[pixel * 4]), Math.abs(a.rgba[pixel * 4 + 1] - b.rgba[pixel * 4 + 1]), Math.abs(a.rgba[pixel * 4 + 2] - b.rgba[pixel * 4 + 2]));

/** World points projected through the live camera into the screenshot's pixels (null behind the camera). */
const projectPoints = (page, points, image) => page.evaluate(({ points, width, height }) => {
  const camera = window.__assembly.viewport.identity().camera;
  camera.updateMatrixWorld(true);
  camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
  const view = camera.matrixWorldInverse.elements, proj = camera.projectionMatrix.elements;
  const mul = (m, v) => [m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12] * v[3], m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13] * v[3],
    m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14] * v[3], m[3] * v[0] + m[7] * v[1] + m[11] * v[2] + m[15] * v[3]];
  return points.map((point) => {
    const clip = mul(proj, mul(view, [point[0], point[1], point[2], 1]));
    if (!(clip[3] > 1e-6)) return null;
    const ndc = [clip[0] / clip[3], clip[1] / clip[3]];
    return [(ndc[0] + 1) / 2 * width, (1 - ndc[1]) / 2 * height];
  });
}, { points, width: image.width, height: image.height });

/** The screen box that holds every projected point, padded and clamped to the frame. */
function screenBox(projected, width, height, pad = BOX_PAD_PX, minWidth = 40, minHeight = 80) {
  const inside = projected.filter(Boolean);
  expect(inside.length >= 3, `only ${inside.length} of ${projected.length} projected avatar points are in front of the camera`);
  const tight = { left: Math.round(Math.min(...inside.map((point) => point[0]))), right: Math.round(Math.max(...inside.map((point) => point[0]))),
    top: Math.round(Math.min(...inside.map((point) => point[1]))), bottom: Math.round(Math.max(...inside.map((point) => point[1]))) };
  const box = padBox(tight, pad, width, height);
  expect(boxWidth(box) >= minWidth && boxHeight(box) >= minHeight, `the projected window is ${boxWidth(box)}x${boxHeight(box)} px (too small to measure: ${JSON.stringify(tight)})`);
  return box;
}

/**
 * The avatar's whole screen box: hips, head, hands and feet projected through the live camera plus the body's top and
 * bottom at the rig's foot, padded by a tenth of its width. The result must be a body-sized window in the frame
 * (0.10-0.30 of the frame width, 0.30-0.85 of its height); a box that fails that check fails the statement, so a stale
 * or degenerate projection can never be measured.
 */
async function avatarBodyBox(page, rig, image) {
  const at = rig.avatar_rig_world || [0, 0, 0];
  const points = ["hips", "head", "leftHand", "rightHand", "leftFoot", "rightFoot"].map((name) => (rig.bones[name] || {}).world).filter(Boolean);
  expect(Number.isFinite(rig.body_top_world_y) && Number.isFinite(rig.body_bottom_world_y), `rigProbe gave no body bounds (top ${rig.body_top_world_y}, bottom ${rig.body_bottom_world_y})`);
  points.push([at[0], rig.body_top_world_y, at[2]], [at[0], rig.body_bottom_world_y, at[2]]);
  const projected = (await projectPoints(page, points, image)).filter(Boolean);
  expect(projected.length >= 5, `only ${projected.length} of the ${points.length} body points project in front of the camera`);
  const tight = { left: Math.round(Math.min(...projected.map((point) => point[0]))), right: Math.round(Math.max(...projected.map((point) => point[0]))),
    top: Math.round(Math.min(...projected.map((point) => point[1]))), bottom: Math.round(Math.max(...projected.map((point) => point[1]))) };
  const box = padBox(tight, Math.max(6, Math.round((tight.right - tight.left) * 0.10)), image.width, image.height);
  const widthShare = boxWidth(box) / image.width, heightShare = boxHeight(box) / image.height;
  expect(widthShare >= 0.1 && widthShare <= 0.3 && heightShare >= 0.3 && heightShare <= 0.85,
    `the projected body box is ${boxWidth(box)}x${boxHeight(box)} px, ${fixed(widthShare, 3)} x ${fixed(heightShare, 3)} of the frame, outside the 0.10-0.30 x 0.30-0.85 a body must occupy (${JSON.stringify(box)} from ${JSON.stringify(tight)})`);
  return box;
}

/** A small window around one point, for reading one item's own pixels. */
function pointBox(point, pad, width, height) {
  expect(point, "a bone or anchor point to project is missing");
  return padBox({ left: Math.round(point[0]), right: Math.round(point[0]), top: Math.round(point[1]), bottom: Math.round(point[1]) }, pad, width, height);
}

/** Hide or show the avatar model in the shared scene: the exact background of the same view, items included. */
const setModelVisible = (page, visible) => page.evaluate((wanted) => {
  // the local avatar layer's own rig: the drawn avatar model and every item attached to its bones. The layer draws into
  // the host renderer's scene, which on this route is not __assembly.scene._impl.scene, so that scene is not searched.
  const rig = window.__assembly.__depthProbeLayers?.()?.local || null;
  let model = null;
  if (rig) rig.traverse((node) => { if (node.name === "real-vrm-avatar" || node.name === "static-glb-avatar") model = node; });
  if (!model) return false;
  model = rig;
  model.visible = wanted;
  // the app draws on its own frame loop: let two frames pass so the screenshot shows the new visibility
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(model.visible === wanted))));
}, visible);

/** Show or hide one item the avatar layer attached itself (its attached-equipment-<itemId> node), then let two frames pass. */
const setItemVisible = (page, itemId, visible) => page.evaluate(([id, wanted]) => {
  const rig = window.__assembly.__depthProbeLayers?.()?.local || null;
  let node = null;
  if (rig) rig.traverse((candidate) => { if (candidate.name === `attached-equipment-${id}`) node = candidate; });
  if (!node) return false;
  node.visible = wanted;
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(node.visible === wanted))));
}, [itemId, visible]);

/** A box grown by `pad` pixels on every side, kept inside the frame. */
const widenBox = (box, pad, width = 640, height = 400) => ({ left: Math.max(0, box.left - pad), top: Math.max(0, box.top - pad),
  right: Math.min(width - 1, box.right + pad), bottom: Math.min(height - 1, box.bottom + pad) });

/** One frame and its exact background: the same view with the avatar model hidden for one screenshot. */
async function avatarPair(ctx, page, name) {
  expect(await setModelVisible(page, false), `no avatar model named real-vrm-avatar/static-glb-avatar to hide for ${name}`);
  let background;
  let shown = false;
  try { background = await shot(ctx, page, `${name}-bg`, CATALOG_SHOTS); }
  finally { shown = await setModelVisible(page, true); }
  expect(shown, `the avatar model stayed hidden after the background frame (${name})`);
  return { background, frame: await shot(ctx, page, name, CATALOG_SHOTS) };
}

/** The pixels of a pair's frame where the avatar is drawn: its colour differs from the same view without the model. */
function occupancyMask(pair, tolerance = PIXEL_DIFF) {
  const mask = new Uint8Array(pair.frame.width * pair.frame.height);
  for (let pixel = 0; pixel < mask.length; pixel += 1) if (pixelDelta(pair.frame, pair.background, pixel) > tolerance) mask[pixel] = 1;
  return mask;
}

/** Drawn area added and removed between two pairs, in pixels, and where inside `box` the added pixels are. */
function addedArea(before, after, box) {
  const was = occupancyMask(before), now = occupancyMask(after);
  let added = 0, removed = 0, inside = 0;
  for (let pixel = 0; pixel < now.length; pixel += 1) {
    if (now[pixel] && !was[pixel]) {
      added += 1;
      const x = pixel % after.frame.width, y = Math.floor(pixel / after.frame.width);
      if (inBox(box, x, y)) inside += 1;
    } else if (was[pixel] && !now[pixel]) removed += 1;
  }
  return { added, removed, inside, share: added ? inside / added : 0 };
}

/** Drawn pixels of one pair inside `box`. */
function occupancyIn(pair, box) {
  const mask = occupancyMask(pair);
  let count = 0;
  for (let y = box.top; y <= box.bottom; y += 1) for (let x = box.left; x <= box.right; x += 1) if (mask[y * pair.frame.width + x]) count += 1;
  return count;
}

/** The share of the pixels inside `box` in which two frames differ. */
function boxChangedShare(a, b, box, tolerance = PIXEL_DIFF) {
  let changed = 0, count = 0;
  for (let y = box.top; y <= box.bottom; y += 1) for (let x = box.left; x <= box.right; x += 1) {
    const pixel = y * a.width + x;
    count += 1;
    if (pixelDelta(a, b, pixel) > tolerance) changed += 1;
  }
  return { changed, count, share: count ? changed / count : 0 };
}

/** The pixels one frame adds over another inside `box`, and where their centre is. */
function addedStats(before, after, box, tolerance = PIXEL_DIFF) {
  let added = 0, sumX = 0, sumY = 0;
  for (let y = box.top; y <= box.bottom; y += 1) for (let x = box.left; x <= box.right; x += 1) {
    const pixel = y * after.width + x;
    if (pixelDelta(before, after, pixel) <= tolerance) continue;
    added += 1; sumX += x; sumY += y;
  }
  return { added, cx: added ? sumX / added : null, cy: added ? sumY / added : null };
}

/** A mask over one box, for the statistics that read a region rather than a silhouette. */
function boxMask(width, height, box) {
  const mask = new Uint8Array(width * height);
  for (let y = box.top; y <= box.bottom; y += 1) for (let x = box.left; x <= box.right; x += 1) mask[y * width + x] = 1;
  return mask;
}

/** A mask with its edge ring removed, so anti-aliased background does not count as detail. */
function erodeBoxMask(width, height, box) {
  const out = new Uint8Array(width * height);
  for (let y = Math.max(1, box.top + 1); y <= Math.min(height - 2, box.bottom - 1); y += 1) for (let x = Math.max(1, box.left + 1); x <= Math.min(width - 2, box.right - 1); x += 1) out[y * width + x] = 1;
  return out;
}

/** Texture and material response of the pixels a mask marks: distinct quantized colours, mean colour, luminance spread, neighbour detail. */
function materialStats(image, mask) {
  const { width, height } = image;
  const colors = new Set();
  const lum = new Float32Array(width * height);
  let pixels = 0, sumR = 0, sumG = 0, sumB = 0, sumL = 0, sumL2 = 0;
  for (let pixel = 0; pixel < mask.length; pixel += 1) {
    if (!mask[pixel]) continue;
    const r = image.rgba[pixel * 4], g = image.rgba[pixel * 4 + 1], b = image.rgba[pixel * 4 + 2];
    colors.add(((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4));
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    lum[pixel] = l;
    pixels += 1; sumR += r; sumG += g; sumB += b; sumL += l; sumL2 += l * l;
  }
  let detail = 0, pairs = 0;
  for (let y = 0; y < height; y += 1) for (let x = 0; x + 1 < width; x += 1) {
    const pixel = y * width + x;
    if (!mask[pixel] || !mask[pixel + 1]) continue;
    detail += Math.abs(lum[pixel] - lum[pixel + 1]); pairs += 1;
  }
  const meanL = pixels ? sumL / pixels : 0;
  return { pixels, colours: colors.size, mean: pixels ? [sumR / pixels, sumG / pixels, sumB / pixels] : [0, 0, 0],
    spread: pixels ? Math.sqrt(Math.max(0, sumL2 / pixels - meanL * meanL)) : 0, detail: pairs ? detail / pairs : 0 };
}

/** The largest avatar-local move of the sampled bones between two rigProbe reads. */
function boneMove(first, second) {
  expect(first && second && first.bones && second.bones, `the rig probe answered no bones (${JSON.stringify({ first: !!(first && first.bones), second: !!(second && second.bones) })})`);
  let max = 0, at = null;
  for (const name of ["hips", "head", "leftHand", "rightHand", "leftFoot", "rightFoot", "leftUpperLeg", "rightUpperLeg"]) {
    const a = first.bones[name], b = second.bones[name];
    if (!a || !b || !a.local || !b.local) continue;
    const moved = Math.hypot(...a.local.map((value, i) => value - b.local[i]));
    if (moved > max) { max = moved; at = name; }
  }
  return { max, at };
}

/**
 * How far the nearest attached object sits from `point`'s raw bone, in metres. rigProbe labels its objects from
 * status.attachedItems[i], and that list also carries the avatar runtime's own held/worn entries, so an item id lookup
 * can name another item's object; the objects are matched to the bone by distance instead.
 */
function attachmentDistance(rig, point) {
  const bone = rig && rig.bones ? rig.bones[point] : null;
  expect(bone && bone.world, `rigProbe has no ${point} bone world position (bones ${rig && rig.bones ? Object.keys(rig.bones).join(",") : "none"})`);
  const objects = (rig.items || []).filter((item) => item.item_world);
  expect(objects.length, `rigProbe has no attached objects with a world position (${(rig.items || []).length} objects)`);
  return objects.map((item) => Math.hypot(...item.item_world.map((value, i) => value - bone.world[i]))).reduce((a, b) => Math.min(a, b), Infinity);
}

statements.push(
  { id: "avatar-runtime", says: "The own-X3D route loads the Lab avatar runtime release byte for byte, and its avatar arrives drawn by that runtime", async run(ctx) {
    // Arrival is proven from the browser's own downloads: every module the page fetches under /avatar/runtime/ must
    // hash to the file the runtime's RELEASE.json pins, every module the avatar loader imports must be among them, and the avatar the page
    // reports must be the runtime's, drawn on the own-X3D route.
    const release = JSON.parse(readFileSync(join(CODE, "web", "avatar", "runtime", "RELEASE.json"), "utf8"));
    const pinned = new Map(release.files.map((file) => [file.path, file.sha256]));
    const url = catalogUrl(ctx, CATALOG_VARIANTS[0]);
    const page = await ctx.visit(url, { open: false });
    const loads = [];
    page.on("response", (response) => {
      const match = /\/avatar\/runtime\/(.+?\.mjs)(?:\?.*)?$/.exec(new URL(response.url()).pathname + new URL(response.url()).search);
      if (match) loads.push(response.buffer().then((body) => ({ path: match[1], status: response.status(), sha256: createHash("sha256").update(body).digest("hex") })).catch(() => ({ path: match[1], status: response.status(), sha256: null })));
    });
    try {
      await openPlayer(page, url);
      await page.bringToFront();
      await catalogWait(page, SCENE_SETTLE_S);
      const route = expectCatalogRoute(await catalogRoute(page), "avatar-runtime");
      const visual = await page.evaluate(() => window.__assembly.avatarVisualState());
      const fetched = await Promise.all(loads);
      expect(fetched.length > 0, `the page fetched nothing under /avatar/runtime/`);
      const wrong = fetched.filter((file) => file.status !== 200 || !pinned.has(file.path) || pinned.get(file.path) !== file.sha256);
      expect(!wrong.length, `the page loaded ${wrong.length} runtime file(s) that are not the ${release.version} release: ${wrong.map((file) => `${file.path} (${file.status}, ${file.sha256 ? file.sha256.slice(0, 12) : "no body"}, pinned ${pinned.has(file.path) ? pinned.get(file.path).slice(0, 12) : "not in RELEASE.json"})`).join("; ")}`);
      const paths = [...new Set(fetched.map((file) => file.path))].sort();
      // The app's avatar loader imports the runtime's modules directly (not the release's aggregate entry), so each
      // module it names must arrive.
      const loader = readFileSync(join(CODE, "web", "avatar", "actionforge-avatar.mjs"), "utf8");
      const imported = [...loader.matchAll(/from\s+["']\.\/runtime\/([^"']+\.mjs)["']/g)].map((match) => match[1]);
      expect(imported.length > 0, `web/avatar/actionforge-avatar.mjs imports nothing from ./runtime/`);
      const missing = imported.filter((path) => !paths.includes(path));
      expect(!missing.length, `the page never loaded ${missing.join(", ")}, which the avatar loader imports (loaded ${paths.join(", ")})`);
      const local = visual.local || visual;
      const source = local.avatar_render_source ?? visual.avatar_render_source;
      expect(source === "actionforge-runtime", `the avatar is drawn from "${source}", not by the avatar runtime`);
      return `${route}; runtime ${release.version}: ${paths.length} of ${release.files.length} pinned modules fetched by the page, each byte-identical to RELEASE.json (${paths.join(", ")}), including the loader's ${imported.length} direct imports; avatar ${local.avatar_variant ?? visual.avatar_variant} drawn from ${source}`;
    } finally { await page.close(); }
  } },
  { id: "catalog-avatars", says: "The four real catalog avatars each draw on the live own-X3D route, and the drawn frames are different people", async run(ctx) {
    const page = await ctx.visit(catalogUrl(ctx, CATALOG_VARIANTS[0]));
    try {
      await catalogWait(page, SCENE_SETTLE_S);
      const route = expectCatalogRoute(await catalogRoute(page), "catalog-avatars");
      const frames = [];
      for (const key of CATALOG_VARIANTS) {
        if (key !== CATALOG_VARIANTS[0]) {
          const answer = await page.evaluate((variant) => window.__assembly.switchAvatar(variant), key);
          expect(answer && answer.ok && answer.variant === key, `switchAvatar(${key}) answered ${JSON.stringify(answer)}`);
          await catalogWait(page);
        }
        const state = await page.evaluate(() => {
          const camera = window.__assembly.viewport.identity().camera;
          return { visual: window.__assembly.avatarVisualState(), avatar: window.__assembly.debugState().avatar, rig: window.__assembly.rigProbe(),
            camera: [camera.position.x, camera.position.y, camera.position.z] };
        });
        expect(state.visual && state.avatar && state.rig, `${key}: the page has no avatar state`);
        expect(state.visual.avatar_variant === key && state.avatar.avatar_variant === key, `after the switch the page is on ${state.visual.avatar_variant}/${state.avatar.avatar_variant}, not ${key}`);
        expect(state.avatar.equippedItems.length === 0, `${key} draws with ${state.avatar.equippedItems.length} items equipped`);
        expect(state.visual.avatar_render_source === "actionforge-runtime", `${key} is drawn from ${state.visual.avatar_render_source}, not the ActionForge runtime`);
        frames.push({ key, state, image: await shot(ctx, page, `catalog-${avatarName(key)}`, CATALOG_SHOTS) });
      }
      const cameraMoved = Math.max(...frames.map((frame) => Math.hypot(...frame.state.camera.map((value, i) => value - frames[0].state.camera[i]))));
      expect(cameraMoved <= 0.001, `the camera moved ${fixed(cameraMoved)} m between the four frames (the comparison would mean nothing)`);
      const width = frames[0].image.width, height = frames[0].image.height;
      const projected = [];
      for (const frame of frames) projected.push(...(await projectPoints(page, rigPoints(frame.state.rig), frame.image)));
      const bodyBox = screenBox(projected, width, height);
      // the lower body: those pixels are the avatar's, standing in front of the floor and not a portal
      const legsProjected = [];
      for (const frame of frames) legsProjected.push(...(await projectPoints(page, legsPoints(frame.state.rig), frame.image)));
      const legsBox = screenBox(legsProjected, width, height, LEGS_PAD_PX, 20, 40);
      // the avatar's own window, recomputed for every variant: a stale box would compare the same window four times
      const bodyBoxes = [];
      for (const frame of frames) bodyBoxes.push(await avatarBodyBox(page, frame.state.rig, frame.image));
      const pairBox = bodyBoxes.reduce((union, box) => ({ left: Math.min(union.left, box.left), right: Math.max(union.right, box.right), top: Math.min(union.top, box.top), bottom: Math.max(union.bottom, box.bottom) }), bodyBoxes[0]);
      expect(new Set(bodyBoxes.map((box) => `${box.left},${box.top},${box.right},${box.bottom}`)).size >= 2,
        `the projected body box is identical for all four variants (${JSON.stringify(bodyBoxes[0])}): the box was not recomputed per frame`);
      // (a) every pair of variants is a different person, in the lower-body window and in the whole body box
      const pairs = [];
      for (let i = 0; i < frames.length; i += 1) for (let j = i + 1; j < frames.length; j += 1) {
        const share = boxChangedShare(frames[i].image, frames[j].image, legsBox);
        pairs.push({ a: frames[i].key, b: frames[j].key, share: share.share });
        expect(share.share >= AVATAR_PAIR_MIN, `the drawn frames for ${frames[i].key} and ${frames[j].key} are not different people (they differ in ${fixed(share.share, 3)} of the ${boxWidth(legsBox)}x${boxHeight(legsBox)} lower-body window, under ${AVATAR_PAIR_MIN})`);
        const whole = boxChangedShare(frames[i].image, frames[j].image, pairBox);
        pairs[pairs.length - 1].whole = whole.share;
        expect(whole.share >= BODY_PAIR_MIN, `the drawn frames for ${frames[i].key} and ${frames[j].key} are not different people in the body box either (they differ in ${fixed(whole.share, 3)} of the ${boxWidth(pairBox)}x${boxHeight(pairBox)} window, under ${BODY_PAIR_MIN})`);
      }
      // (b) each frame draws a body in that window, with more in it than the bare floor
      for (const frame of frames) {
        frame.stats = materialStats(frame.image, erodeBoxMask(width, height, legsBox));
        expect(frame.stats.pixels > 200, `${frame.key}'s lower-body window holds ${frame.stats.pixels} pixels (too small to measure)`);
        expect(frame.stats.colours >= LEGS_COLOURS_MIN, `${frame.key}'s lower-body window carries ${frame.stats.colours} distinct colours, under ${LEGS_COLOURS_MIN}: bare floor, not a drawn body`);
        expect(frame.stats.spread >= LEGS_SPREAD_MIN, `${frame.key}'s lower-body window has a luminance spread of ${fixed(frame.stats.spread, 1)}, under ${LEGS_SPREAD_MIN}: bare floor`);
      }
      // (c) the catalog's own heights, and the camera must order the bodies the same way
      const heights = [];
      for (const frame of frames) {
        const at = frame.state.rig.avatar_rig_world || [0, 0, 0];
        const [top] = await projectPoints(page, [[at[0], frame.state.rig.body_top_world_y, at[2]]], frame.image);
        heights.push({ key: frame.key, model: frame.state.visual.avatar_model_height_m, prepared: catalogHeight(frame.key), top: Math.round(top[1]) });
      }
      for (const height of heights) {
        expect(typeof height.model === "number" && height.prepared !== null, `${height.key}: the page reports ${height.model} m, the catalog ${height.prepared} m`);
        expect(Math.abs(height.model - height.prepared) <= HEIGHT_MATCH_M, `${height.key} is drawn ${height.model} m tall, the catalog's own height is ${height.prepared} m`);
      }
      for (let i = 0; i < heights.length; i += 1) for (let j = i + 1; j < heights.length; j += 1) {
        const a = heights[i], b = heights[j];
        if (Math.abs(a.model - b.model) < HEIGHT_RANK_MIN_M) continue;
        const taller = a.model > b.model ? a : b, shorter = taller === a ? b : a;
        expect(shorter.top - taller.top >= HEIGHT_RANK_PX, `${taller.key} is ${fixed(taller.model - shorter.model, 3)} m taller than ${shorter.key} but its camera-projected crown is only ${fixed(shorter.top - taller.top)} rows higher (under ${HEIGHT_RANK_PX})`);
      }
      const leastPair = Math.min(...pairs.map((pair) => pair.share));
      return `${route}; body box ${boxWidth(bodyBox)}x${boxHeight(bodyBox)} (per-variant ${bodyBoxes.map((box) => `${box.left},${box.top}`).join(" / ")}), lower-body window ${boxWidth(legsBox)}x${boxHeight(legsBox)} at (${legsBox.left}, ${legsBox.top}); whole-body pair differences ${pairs.map((pair) => `${avatarName(pair.a)}-${avatarName(pair.b)} ${fixed(pair.whole, 3)}`).join(", ")}; ${heights.map((height) => `${avatarName(height.key)} ${fixed(height.model, 2)} m, crown row ${height.top} (catalog ${fixed(height.prepared, 2)} m)`).join(", ")}; every pair differs in at least ${fixed(leastPair, 3)} of the lower body; lower-body colours ${frames.map((frame) => frame.stats.colours).join("/")}, spread ${frames.map((frame) => fixed(frame.stats.spread, 1)).join("/")}; shots ${frames.map((frame) => frame.image.file).join(", ")}`;
    } finally { await page.close(); }
  } },
  { id: "catalog-equipment", says: "Each of the seven catalog items equips through the app's driver and draws on the avatar at its attachment", async run(ctx) {
    // Through the app's own drivers only. The default loadout (&noequip=0) carries the hammer, the torch and the hat.
    // Two app facts shape the proof: validateEquippedItems refuses any non-empty set without both a held and a worn
    // item, so equipItem cannot start from an empty avatar (it answered {"ok":false,"error":"equip rejected by schema:
    // missing held item"}); and equipItem APPENDS, so adding the helmet under the hat leaves the helmet inside the
    // hat's crown (measured: 326 px of its box changed, less than the 428 px the same box moves with nothing equipped).
    // Each of the four items the catalog still offers is therefore installed ALONE in its own slot through the app's
    // inventory driver (setSlotItem, the selector's slot swap).
    //
    // The pixel proof is OCCUPANCY, not a frame-to-frame diff: the avatar model (real-vrm-avatar) is hidden for one
    // screenshot to get the exact background of the same view, and every pixel of the model and its items is counted
    // where it differs from that background. Shifting the camera or animating the head cannot create occupancy; an item
    // that is drawn adds its own area. The drift control is the same computation between two frames with nothing
    // equipped, so the lobby's moving portal previews are subtracted rather than trusted.
    const page = await ctx.visit(catalogUrl(ctx, "collection-adam", { equipment: true }));
    try {
      await catalogWait(page, SCENE_SETTLE_S);
      const route = expectCatalogRoute(await catalogRoute(page), "catalog-equipment");
      const read = () => page.evaluate(() => ({ visual: window.__assembly.avatarVisualState(), avatar: window.__assembly.debugState().avatar,
        rig: window.__assembly.rigProbe(), scan: window.__assembly.equipmentSceneScan(), catalog: window.__assembly.equippableCatalog(),
        camera: (() => { const c = window.__assembly.viewport.identity().camera; return [c.position.x, c.position.y, c.position.z]; })() }));
      const boot = await read();
      const catalog = boot.catalog;
      expect(catalog.map((item) => item.itemId).join(",") === CATALOG_ITEMS.join(","), `the driver offers "${catalog.map((item) => item.itemId).join(",")}", not the catalog's seven "${CATALOG_ITEMS.join(",")}"`);
      const base = catalog.filter((item) => item.equipped);
      expect(base.length === 3 && base.map((item) => item.attachmentPoint).sort().join(",") === "head,leftHand,rightHand",
        `the app's default loadout is ${base.map((item) => `${item.itemId}@${item.attachmentPoint}`).join(", ")}, not one item on each of head, leftHand and rightHand (offered: ${catalog.map((item) => `${item.itemId}${item.equipped ? "*" : ""}`).join(", ")})`);
      expect(boot.avatar.equippedItems.length === 3, `the booted avatar carries ${boot.avatar.equippedItems.length} equipped items, not the default loadout's 3`);
      const bodyBox = screenBox(await projectPoints(page, rigPoints(boot.rig), { width: 640, height: 400 }), 640, 400);
      // one window per catalog item, around its own attachment bone
      const anchorPoints = catalog.map((item) => {
        const bone = boot.rig.bones[item.attachmentPoint];
        expect(bone && bone.world, `rigProbe has no ${item.attachmentPoint} bone for ${item.itemId} (bones ${Object.keys(boot.rig.bones).join(",")})`);
        return bone.world;
      });
      const anchors = await projectPoints(page, anchorPoints, { width: 640, height: 400 });
      catalog.forEach((item, i) => { item.box = pointBox(anchors[i], ITEM_BOX_PAD[item.attachmentPoint] || 26, 640, 400); });
      const bootPair = await avatarPair(ctx, page, "catalog-items-boot");
      // the drift control: the same computation, one equip's worth of loop time later, with nothing equipped
      await catalogWait(page, 1);
      const driftPair = await avatarPair(ctx, page, "catalog-items-drift");
      // the clean body, same URL with noequip=1, its own occupancy for the three base items
      const cleanPage = await ctx.visit(catalogUrl(ctx, "collection-adam"));
      let cleanPair, cleanCamera;
      try {
        await catalogWait(cleanPage, SCENE_SETTLE_S);
        cleanCamera = await catalogCamera(cleanPage);
        cleanPair = await avatarPair(ctx, cleanPage, "catalog-items-clean");
      } finally { await cleanPage.close(); }
      expect(Math.max(...cleanCamera.slice(0, 3).map((value, i) => Math.abs(value - boot.camera[i]))) <= 0.001,
        `the clean page's camera is ${JSON.stringify(cleanCamera.slice(0, 3))}, the equipped page's ${JSON.stringify(boot.camera)}: the two occupancies would be of different views`);
      const attachLine = (entry, distance) => `${entry.target === "avatar-runtime-equipment" ? `runtime ${entry.runtime_item}` : "plain bone attach"}${distance === null ? "" : `, ${fixed(distance, 3)} m from its bone`}`;
      const baseLines = [];
      for (const item of base) {
        const entry = (boot.visual.attached_items || []).find((candidate) => candidate.itemId === item.itemId);
        expect(entry, `${item.itemId} is equipped but not attached (attached: ${(boot.visual.attached_items || []).map((candidate) => candidate.itemId).join(",")})`);
        const alone = catalog.filter((candidate) => candidate.equipped && candidate.attachmentPoint === item.attachmentPoint);
        expect(alone.length === 1, `${item.itemId} is not alone at its ${item.attachmentPoint} at boot (${alone.map((candidate) => candidate.itemId).join(",")})`);
        let distance = null;
        if (entry.target === "avatar-runtime-equipment") expect(entry.runtime_item, `${item.itemId} is on ${entry.target} with no runtime item id`);
        else {
          distance = attachmentDistance(boot.rig, item.attachmentPoint);
          expect(distance <= ITEM_DISTANCE_MAX_M, `${item.itemId} sits ${fixed(distance, 3)} m from its ${item.attachmentPoint} attachment at boot, over ${ITEM_DISTANCE_MAX_M} m`);
        }
        if (entry.target !== "avatar-runtime-equipment") {
          // An item the avatar layer attached itself draws from the rig, so it can be hidden alone. Its own pixels are
          // measured in one pose: the same frame with and without it. The clean page stands in another pose (arms down),
          // which moves the hand window's body pixels and would cancel a held item's area.
          const itemWindow = widenBox(item.box, ITEM_BOX_PAD[item.attachmentPoint] || 26);
          const shown = await shot(ctx, page, `catalog-${item.itemId}-shown`, CATALOG_SHOTS);
          const shownAgain = await shot(ctx, page, `catalog-${item.itemId}-shown-again`, CATALOG_SHOTS);
          expect(await setItemVisible(page, item.itemId, false), `${item.itemId} has no attached-equipment-${item.itemId} node to hide`);
          let hidden, hiddenAgain;
          try {
            hidden = await shot(ctx, page, `catalog-${item.itemId}-hidden`, CATALOG_SHOTS);
            hiddenAgain = await shot(ctx, page, `catalog-${item.itemId}-hidden-again`, CATALOG_SHOTS);
          } finally { expect(await setItemVisible(page, item.itemId, true), `${item.itemId} stayed hidden after its frames`); }
          // The idle clip moves the holding arm, and the item with it, between any two frames (the page has no hook to
          // stop it). A pixel is the item's own where the two item-hidden frames agree, so nothing else moves there,
          // and the last shown frame differs from them. The arm's moving edges change between the hidden frames too,
          // so they are not counted; a held item that moves still counts, because without it that spot is steady.
          let own = 0, moving = 0;
          for (let y = itemWindow.top; y <= itemWindow.bottom; y += 1) for (let x = itemWindow.left; x <= itemWindow.right; x += 1) {
            const pixel = y * shown.width + x;
            if (pixelDelta(hidden, hiddenAgain, pixel) > PIXEL_DIFF) { moving += 1; continue; }
            if (pixelDelta(shownAgain, hidden, pixel) > PIXEL_DIFF) own += 1;
          }
          const drift = moving;
          expect(own >= ITEM_ADD_FLOOR, `${item.itemId} draws ${own} steady px of its ${boxWidth(itemWindow)}x${boxHeight(itemWindow)} window at its attachment (${moving} px changed between the item-hidden frames and were not counted, floor ${ITEM_ADD_FLOOR}): it is not drawn there (${attachLine(entry, distance)})`);
          baseLines.push(`${itemName(item.itemId)} ${item.mode} at ${item.attachmentPoint} at boot: ${own} px of its own in one frame (drift ${drift}), ${attachLine(entry, distance)}`);
          continue;
        }
        const equippedArea = occupancyIn(bootPair, item.box);
        const cleanArea = occupancyIn(cleanPair, item.box);
        const drift = Math.abs(occupancyIn(driftPair, item.box) - equippedArea);
        const added = equippedArea - cleanArea;
        expect(added >= drift + ITEM_ADD_FLOOR, `${item.itemId} adds ${added} drawn px of its ${boxWidth(item.box)}x${boxHeight(item.box)} window at boot over the clean avatar (drift ${drift}, floor ${ITEM_ADD_FLOOR}): it is not drawn there (${attachLine(entry, distance)})`);
        baseLines.push(`${itemName(item.itemId)} ${item.mode} at ${item.attachmentPoint} at boot: +${added} px of drawn area (drift ${drift}), ${attachLine(entry, distance)}`);
      }
      const installs = [
        { slot: "head", itemId: "equip-helmet" },
        { slot: "head", itemId: "equip-crown" },
        { slot: "leftHand", itemId: "equip-shield" },
        { slot: "leftHand", itemId: "equip-mug" },
      ];
      const measures = [];
      let previous = driftPair;
      for (const install of installs) {
        const answer = await page.evaluate(({ slot, itemId }) => window.__assembly.inventory.setSlotItem(slot, itemId), install);
        expect(answer && answer.ok, `setSlotItem(${install.slot}, ${install.itemId}) answered ${JSON.stringify(answer)}, not ok`);
        expect(answer.itemId === install.itemId && answer.slot === install.slot, `setSlotItem(${install.slot}, ${install.itemId}) answered ${JSON.stringify(answer)}`);
        await catalogWait(page);
        const state = await read();
        const pair = await avatarPair(ctx, page, `catalog-item-${itemName(install.itemId)}`);
        const item = catalog.find((candidate) => candidate.itemId === install.itemId);
        const entry = (state.visual.attached_items || []).find((candidate) => candidate.itemId === install.itemId);
        expect(entry, `${item.itemId} is not among the attached items: ${(state.visual.attached_items || []).map((candidate) => candidate.itemId).join(",")}`);
        const alone = state.catalog.filter((candidate) => candidate.equipped && candidate.attachmentPoint === install.slot);
        expect(alone.length === 1 && alone[0].itemId === item.itemId, `${item.itemId} is not alone at its ${install.slot} (${alone.map((candidate) => candidate.itemId).join(",")})`);
        let distance = null;
        if (entry.target === "avatar-runtime-equipment") expect(entry.runtime_item, `${item.itemId} is on ${entry.target} with no runtime item id`);
        else {
          distance = attachmentDistance(state.rig, install.slot);
          expect(distance <= ITEM_DISTANCE_MAX_M, `${item.itemId} sits ${fixed(distance, 3)} m from its ${install.slot} attachment, over ${ITEM_DISTANCE_MAX_M} m`);
        }
        // The swap is measured as the pixels of the item's window that change across it, against the change the same
        // window shows over one second with nothing swapped (the idle clip and the live portal previews behind the
        // avatar). Occupancy against a model-hidden frame counts the portal previews that change between the frames.
        const added = addedArea(previous, pair, item.box);
        const changed = boxChangedShare(previous.frame, pair.frame, item.box).changed;
        const drift = boxChangedShare(bootPair.frame, driftPair.frame, item.box).changed;
        expect(changed >= drift + ITEM_ADD_FLOOR, `${item.itemId} changes ${changed} px of its ${boxWidth(item.box)}x${boxHeight(item.box)} attachment window when it is swapped in (drift ${drift}, floor ${ITEM_ADD_FLOOR}): it is equipped but not drawn there (${attachLine(entry, distance)})`);
        const plain = (state.visual.attached_items || []).filter((candidate) => candidate.target !== "avatar-runtime-equipment").length;
        expect(state.scan && state.scan.marker_groups === plain, `equipmentSceneScan counts ${state.scan ? state.scan.marker_groups : "nothing"} marker groups, not the ${plain} items on the plain bone attach`);
        measures.push({ ...item, slot: install.slot, changed, added: added.added, share: added.share, removed: added.removed, drift, distance,
          markers: state.scan ? state.scan.marker_groups : null, plain, file: pair.frame.file, attach: attachLine(entry, distance) });
        previous = pair;
      }
      return `${route}; body box ${boxWidth(bodyBox)}x${boxHeight(bodyBox)}, item windows ${ITEM_BOX_PAD.head} px at the head bone and ${ITEM_BOX_PAD.leftHand} px at a hand bone; occupancy against the model-hidden background of the same view; booted with the app's default loadout: ${baseLines.join("; ")}; then each alone in its slot: ${measures.map((measure) => `${itemName(measure.itemId)} ${measure.mode} at ${measure.attachmentPoint} [${measure.attach}]: ${measure.changed} px of its window changed on the swap (drift ${measure.drift}; +${measure.added} drawn px, ${fixed(measure.share, 3)} inside its window), markers ${measure.markers}/${measure.plain}`).join("; ")}; shots in ${CATALOG_SHOTS}`;
    } finally { await page.close(); }
  } },
  { id: "catalog-materials", says: "The drawn avatar carries the catalog's own textures and material response, not a flat fill", async run(ctx) {
    const page = await ctx.visit(catalogUrl(ctx, CATALOG_VARIANTS[0]));
    try {
      await catalogWait(page, SCENE_SETTLE_S);
      const route = expectCatalogRoute(await catalogRoute(page), "catalog-materials");
      const frames = [];
      for (const key of [CATALOG_VARIANTS[0], "collection-megan"]) {
        if (frames.length) {
          const answer = await page.evaluate((variant) => window.__assembly.switchAvatar(variant), key);
          expect(answer && answer.ok && answer.variant === key, `switchAvatar(${key}) answered ${JSON.stringify(answer)}`);
          await catalogWait(page);
        }
        const rig = await page.evaluate(() => window.__assembly.rigProbe());
        frames.push({ key, rig, image: await shot(ctx, page, `catalog-materials-${avatarName(key)}`, CATALOG_SHOTS) });
      }
      const width = frames[0].image.width, height = frames[0].image.height;
      const projected = [];
      for (const frame of frames) projected.push(...(await projectPoints(page, legsPoints(frame.rig), frame.image)));
      const legsBox = screenBox(projected, width, height, LEGS_PAD_PX, 20, 40);
      const stats = frames.map((frame) => {
        const stat = materialStats(frame.image, erodeBoxMask(width, height, legsBox));
        expect(stat.pixels > 200, `${frame.key}'s lower-body window holds ${stat.pixels} pixels (too small to measure)`);
        return { key: frame.key, stat, frame };
      });
      const [adam, megan] = stats;
      expect(adam.stat.colours >= MATERIAL_COLOURS_MIN, `the drawn avatar carries ${adam.stat.colours} distinct colours in its lower body, under ${MATERIAL_COLOURS_MIN}: a flat fill, not the catalog's textures`);
      expect(adam.stat.detail >= MATERIAL_DETAIL_MIN, `its pixels change by ${fixed(adam.stat.detail, 2)} of 255 between neighbours, under ${MATERIAL_DETAIL_MIN}: no texture detail`);
      expect(adam.stat.spread >= MATERIAL_SPREAD_MIN, `its luminance spread is ${fixed(adam.stat.spread, 1)}, under ${MATERIAL_SPREAD_MIN}: too flat for the catalog's materials`);
      const meanDiff = Math.hypot(...adam.stat.mean.map((value, i) => value - megan.stat.mean[i]));
      expect(meanDiff >= MATERIAL_MEAN_DIFF_MIN, `adam and megan draw the same mean colour (${adam.stat.mean.map((value) => fixed(value, 1))} and ${megan.stat.mean.map((value) => fixed(value, 1))}, ${fixed(meanDiff, 1)} apart, under ${MATERIAL_MEAN_DIFF_MIN}): their material identity is lost`);
      return `${route}; lower-body window ${boxWidth(legsBox)}x${boxHeight(legsBox)} at (${legsBox.left}, ${legsBox.top}) from the rigs' own leg bones; adam ${adam.stat.pixels} px: ${adam.stat.colours} distinct colours, mean ${adam.stat.mean.map((value) => fixed(value, 1))}, luminance spread ${fixed(adam.stat.spread, 1)}, neighbour detail ${fixed(adam.stat.detail, 2)} of 255; megan mean ${megan.stat.mean.map((value) => fixed(value, 1))}, ${fixed(meanDiff, 1)} apart; shots ${adam.frame.image.file}, ${megan.frame.image.file}`;
    } finally { await page.close(); }
  } },
  { id: "catalog-deforms", says: "The drawn catalog avatar deforms: the rig animates while the camera stands still", async run(ctx) {
    const page = await ctx.visit(catalogUrl(ctx, CATALOG_VARIANTS[0]));
    try {
      await catalogWait(page, SCENE_SETTLE_S);
      const route = expectCatalogRoute(await catalogRoute(page), "catalog-deforms");
      await page.waitForFunction(() => {
        const visual = window.__assembly.avatarVisualState ? window.__assembly.avatarVisualState() : null;
        return !!visual && visual.current_animation_state === "idle" && visual.avatar_switch_in_flight !== true;
      }, { timeout: DRAW_WAIT_MS, polling: 60 });
      const read = () => page.evaluate(() => {
        const camera = window.__assembly.viewport.identity().camera;
        return { visual: window.__assembly.avatarVisualState(), rig: window.__assembly.rigProbe(),
          camera: [camera.position.x, camera.position.y, camera.position.z] };
      });
      const first = await read();
      expect(first.visual.current_animation_state === "idle", `the avatar is not on its idle clip at the first frame (${first.visual.current_animation_state})`);
      const a = await shot(ctx, page, "catalog-deforms-a", CATALOG_SHOTS);
      const box = screenBox(await projectPoints(page, rigPoints(first.rig), a), a.width, a.height);
      const clockA = await catalogClock(page);
      const clockB = await catalogWait(page, DEFORM_SECONDS);
      const second = await read();
      const b = await shot(ctx, page, "catalog-deforms-b", CATALOG_SHOTS);
      const seconds = clockB - clockA;
      const cameraMove = Math.max(...second.camera.map((value, i) => Math.abs(value - first.camera[i])));
      expect(cameraMove <= 0.001, `the camera moved ${fixed(cameraMove)} m between the two frames (the comparison would mean nothing)`);
      expect(second.visual.current_animation_state === "idle", `the avatar left idle between the frames (${second.visual.current_animation_state})`);
      const inside = boxChangedShare(a, b, box);
      expect(inside.share >= DEFORM_ANIM_MIN, `the drawn avatar did not change in ${fixed(inside.share, 4)} of its ${boxWidth(box)}x${boxHeight(box)} box over ${fixed(seconds)} s of idle play, under ${DEFORM_ANIM_MIN}: no deformation is drawn`);
      const bones = boneMove(first.rig, second.rig);
      expect(bones.max >= DEFORM_BONE_MIN_M, `the rig's bones moved at most ${fixed(bones.max, 4)} m in avatar-local space over ${fixed(seconds)} s (the rig is frozen)`);
      return `${route}; box ${boxWidth(box)}x${boxHeight(box)} from the rig's bones; over ${fixed(seconds)} s of idle play ${inside.changed} px of the box changed (${fixed(inside.share, 4)}, ${fixed(inside.changed / seconds, 1)} px/s); largest avatar-local bone move ${fixed(bones.max, 4)} m (${bones.at}); camera ${fixed(cameraMove, 6)} m; animation ${first.visual.current_animation_state} -> ${second.visual.current_animation_state}; shots ${a.file}, ${b.file}`;
    } finally { await page.close(); }
  } },
);

faults.push(
  { statement: "avatar-runtime", name: "a runtime module is not the release's bytes", expect: /not the .* release/, edits: [
    { file: "web/avatar/runtime/locomotion.mjs", find: "export ", replace: "// changed after release\nexport " }] },
  { statement: "catalog-avatars", name: "every variant loads the first avatar", expect: /different people|avatar variant/, edits: [
    { file: "web/avatar-equipment-layer.js", find: "const loaded = await loadActionForgeAvatar(variant);", replace: `const loaded = await loadActionForgeAvatar(AVATAR_VARIANTS["collection-adam"]);` }] },
  { statement: "catalog-equipment", name: "items are seated 3 m off their attachment", expect: /attachment|inside the avatar/, edits: [
    { file: "web/avatar-equipment-layer.js", find: "object.position.set(p[0], p[1], p[2]);", replace: "object.position.set(p[0] + 3, p[1], p[2]);" }] },
  { statement: "catalog-materials", name: "the avatar's material maps are stripped, so it draws flat", expect: /texture|flat|colour/, edits: [
    { file: "web/avatar/actionforge-avatar.mjs", find: "  return { vrm, model: instance.holder, library, instance, tuning, items };", replace: "  instance.holder.traverse((o) => { if (o.isMesh && o.material) for (const m of [].concat(o.material)) { m.map = null; m.emissiveMap = null; m.needsUpdate = true; } });\n  return { vrm, model: instance.holder, library, instance, tuning, items };" }] },
  { statement: "catalog-deforms", name: "the motion clock is frozen, so the avatar never deforms", expect: /did not change|deform|frozen/i, edits: [
    { file: "runtime/scene-core/public/animation/drivers/humanoid/avatar-motion.mjs", find: "this.mixer.update(dt);", replace: "this.mixer.update(0);" }] },
);

process.on("exit", () => {
  if (!shotLog.length) return;
  console.log("screenshots:");
  for (const { file, sha256 } of shotLog) console.log(`  ${sha256}  ${file}`);
});

// Check that every planted edit still applies to the live files before any lab starts (plantFaults checks again).
for (const fault of faults) for (const edit of fault.edits) if (!readFileSync(join(CODE, edit.file), "utf8").includes(edit.find)) console.log(`note: fault edit no longer applies: ${edit.file}`);

await runBehavior({ title: "x3d-route", firstPort: 38100, statements, faults });
