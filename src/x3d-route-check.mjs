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
import { CODE } from "../tools/arch-i4/main-demo/lab.mjs";
import { decodeRgbe } from "../runtime/scene-core/public/x3d/rgbe-decoder.mjs";
import { SKY_GRADIENT_PATH, selfTest as skyGradientSelfTest } from "../tools/x3d/make-sky-gradient-hdr.mjs";

// Item 3 (environment URI and intensity) runs wrote here; items 1 and 2 first wrote to /Volumes/2tb-ssd-turbo/scratch/x3d-route-20261110.
const SHOTS = "/Volumes/2tb-ssd-turbo/scratch/x3d-env-route-20261110";
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

/** A screenshot of the scene mount, saved under SHOTS, decoded. */
async function shot(ctx, page, name) {
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
  mkdirSync(SHOTS, { recursive: true });
  shotCount += 1;
  const file = join(SHOTS, `${isReal(ctx) ? "real" : "fault"}-${String(shotCount).padStart(2, "0")}-${name}.png`);
  writeFileSync(file, png);
  const sha256 = createHash("sha256").update(png).digest("hex");
  shotLog.push({ file, sha256 });
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
  scene.traverse((node) => { if (!mesh && node.isMesh && node.name === wanted && node.userData?.x3d?.type === "SoftBody") mesh = node; });
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
const RENDER = "runtime/scene-core/public/x3d/scene-renderer.mjs";
const faults = [
  { statement: "anchor-boots", name: "shapes realized hidden, so only the background draws", expect: /authored content covers/, edits: [
    { file: RENDER, find: `case "Shape": parent.add(register(shapeMesh(node), node, instance, anchorId)); break;`, replace: `case "Shape": { const hidden = register(shapeMesh(node), node, instance, anchorId); hidden.visible = false; parent.add(hidden); break; }` }] },
  { statement: "soft-boots", name: "lighting removed: directional and environment light at zero", expect: /lit content covers/, edits: [
    { file: RENDER, find: "new THREE.DirectionalLight(new THREE.Color().fromArray(f.color), f.intensity)", replace: "new THREE.DirectionalLight(new THREE.Color().fromArray(f.color), 0)" },
    { file: RENDER, find: "if (f.ambientIntensity) parent.add(", replace: "if (false) parent.add(" },
    { file: RENDER, find: "new THREE.AmbientLight(new THREE.Color().fromArray(f.color), f.ambientIntensity), node, instance)); break;", replace: "new THREE.AmbientLight(new THREE.Color().fromArray(f.color), 0), node, instance)); break;" }] },
  { statement: "walk-speed", name: "the document viewer walks at half speed", expect: /walked at [\d.]+ m\/s/, edits: [
    { file: "web/movement-camera-controller.mjs", find: "const distance = 2.4 * deltaSeconds;", replace: "const distance = 1.2 * deltaSeconds;" }] },
  { statement: "anchor-click", name: "the route allowlist names /w/a/ for the anchor document", expect: /no navigation after a click/, edits: [
    { file: DOC, find: `destination: filename === SOFT ? "/w/lobby/" : "/w/b/" });`, replace: `destination: filename === SOFT ? "/w/lobby/" : "/w/a/" });` }] },
  { statement: "soft-crossing", name: "crossing intents are never dispatched", expect: /no navigation after walking/, edits: [
    { file: DOC, find: "for (const intent of result.intents) dispatch(intent);", replace: "for (const intent of []) dispatch(intent);" }] },
  { statement: "soft-physics", name: "physics never advances", expect: /the ball fell/, edits: [
    { file: "runtime/scene-core/public/x3d/soft-body.mjs", find: "world.stepSimulation(delta, 10);", replace: "world.stepSimulation(0, 10);" }] },
  { statement: "route-dispose", name: "the scene is released before physics", expect: /the scene was released before physics/, edits: [
    { file: DOC, find: "for (const release of [() => adapter.cancelDocument(), () => physics?.dispose(), () => rendererPreparation.dispose()]) {", replace: "for (const release of [() => adapter.cancelDocument(), () => rendererPreparation.dispose(), () => physics?.dispose()]) {" }] },
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

process.on("exit", () => {
  if (!shotLog.length) return;
  console.log("screenshots:");
  for (const { file, sha256 } of shotLog) console.log(`  ${sha256}  ${file}`);
});

// Check that every planted edit still applies to the live files before any lab starts (plantFaults checks again).
for (const fault of faults) for (const edit of fault.edits) if (!readFileSync(join(CODE, edit.file), "utf8").includes(edit.find)) console.log(`note: fault edit no longer applies: ${edit.file}`);

await runBehavior({ title: "x3d-route", firstPort: 38100, statements, faults });
