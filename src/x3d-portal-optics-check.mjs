// Portal optics on the own-X3D document route: the authored PortalAnchor disc is a window into its destination, drawn
// by the app's own portal window (web/portal-spatial-preview.mjs, unchanged), in the real shared app on a lab of its own.
//   node src/x3d-portal-optics-check.mjs [--faults] [--faults-only] [--only id,id]
//
// Built on tools/behavior/kit.mjs and tools/arch-i4/main-demo/lab.mjs, read only. Ports 38100-38119: the shared lab
// takes the first five, the comparison lab of "outside-unchanged" (a copy with the portal entry removed) the five from
// first + 10. Page state comes from window.__x3dWorld.debugState() (its `portal` part), canvas pixels of the scene
// mount, and the browser's own request log. Statements that read more say so: the camera's matrices (to find the
// disc's pixels), and in "dispose" the overlay object and the renderer, wrapped by this check only. Navigations the
// route dispatches are caught and aborted, so the page never follows them into a server world.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { expect, fail, fixed, runBehavior, sleep } from "../tools/behavior/kit.mjs";
import { CODE, createLab, plantFaults } from "../tools/arch-i4/main-demo/lab.mjs";

// One folder per run, so a later run never overwrites an earlier run's evidence.
const SHOTS = join("/Volumes/2tb-ssd-turbo/scratch/x3d-optics-20261110/shots", new Date().toISOString().replace(/[:.]/g, "-"));
const ANCHOR = "anchor-portal-world.x3d.json";
const SOFT = "soft-body.x3d.json";
const KEY = "x3d-document:PortalAnchor";
const DOCS = {
  [ANCHOR]: { center: [0, 1.2, -2.5], forward: [0, 0, 1], radius: 1.1, world: "b", entry: [0, 1.6, 6] },
  [SOFT]: { center: [-8.59, 1.6, 2.93], forward: [-0.70711, 0, 0.70711], radius: 0.9, world: "lobby", entry: [-10, 1.6, 10] },
};
const PREVIEW_COLOR = [0x28, 0x34, 0x4f]; // web/wow-portal.mjs PREVIEW_COLOR, the flat colour of an unreachable destination
const PORTAL_SPATIAL_PREVIEW_SHA256 = "90b375c6e77252b7b6b4e1f5cdf7a539851d41e96f502a99c7ef5465306f6145"; // Lab's asleep-portal fix
const LIVE_LIMIT_MS = 10000;
const NAV_WAIT_MS = 15000;

let shotCount = 0;
const shotLog = [];
const docUrl = (ctx, file) => `${ctx.lab.front}/index.html?renderer=own-x3d&x3dDocument=${file}`;
const isReal = (ctx) => ctx.lab.code === CODE;

/** A PNG from Puppeteer (8-bit RGB or RGBA, not interlaced) as RGBA pixels. Same decoder as src/x3d-route-check.mjs. */
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
    for (let x = 0; x < width; x += 1) out.set([line[x * bpp], line[x * bpp + 1], line[x * bpp + 2], 255], (y * width + x) * 4);
    prev = line;
  }
  return { width, height, rgba: out };
}

/** A screenshot of the scene canvases only (every other element hidden for the shot), saved under SHOTS, decoded. */
async function shot(ctx, page, name) {
  const box = await page.$eval("#scene-mount", (mount) => { const r = mount.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; });
  await page.evaluate(() => {
    const style = document.createElement("style");
    style.id = "x3d-optics-check-canvas-only";
    style.textContent = "body * { visibility: hidden !important; } #scene-mount canvas { visibility: visible !important; }";
    document.head.appendChild(style);
  });
  let png;
  try { png = Buffer.from(await page.screenshot({ type: "png", clip: box })); }
  finally { await page.evaluate(() => document.getElementById("x3d-optics-check-canvas-only")?.remove()); }
  mkdirSync(SHOTS, { recursive: true });
  shotCount += 1;
  const file = join(SHOTS, `${isReal(ctx) ? "real" : "fault"}-${String(shotCount).padStart(2, "0")}-${name}.png`);
  writeFileSync(file, png);
  const sha256 = createHash("sha256").update(png).digest("hex");
  shotLog.push({ file, sha256 });
  return { file, sha256, ...decodePng(png) };
}

// Column-major 4x4 matrices, as three.js keeps them.
function mul4(a, b) {
  const out = new Array(16).fill(0);
  for (let c = 0; c < 4; c += 1) for (let r = 0; r < 4; r += 1) for (let k = 0; k < 4; k += 1) out[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return out;
}
function inv4(m) {
  const a = [...m], inv = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const at = (M, r, c) => M[c * 4 + r];
  const set = (M, r, c, v) => { M[c * 4 + r] = v; };
  for (let col = 0; col < 4; col += 1) {
    let pivot = col;
    for (let r = col + 1; r < 4; r += 1) if (Math.abs(at(a, r, col)) > Math.abs(at(a, pivot, col))) pivot = r;
    for (const M of [a, inv]) for (let c = 0; c < 4; c += 1) { const t = at(M, col, c); set(M, col, c, at(M, pivot, c)); set(M, pivot, c, t); }
    const d = at(a, col, col);
    for (const M of [a, inv]) for (let c = 0; c < 4; c += 1) set(M, col, c, at(M, col, c) / d);
    for (let r = 0; r < 4; r += 1) {
      if (r === col) continue;
      const f = at(a, r, col);
      for (const M of [a, inv]) for (let c = 0; c < 4; c += 1) set(M, r, c, at(M, r, c) - f * at(M, col, c));
    }
  }
  return inv;
}
const apply4 = (m, v) => [0, 1, 2, 3].map((r) => m[r] * v[0] + m[4 + r] * v[1] + m[8 + r] * v[2] + m[12 + r] * v[3]);
const sub = (a, b) => a.map((v, i) => v - b[i]);
const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
const near = (p, q, tolerance) => Math.abs(p[0] - q[0]) <= tolerance && Math.abs(p[1] - q[1]) <= tolerance && Math.abs(p[2] - q[2]) <= tolerance;
const luma = (p) => 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2];

/** For each pixel, where its ray meets the disc's plane, in the disc frame (a along right, b along up), or null. */
function discCoordinates(image, cam, frame) {
  const invPV = inv4(mul4(cam.p, cam.mwi));
  const { width, height } = image, out = new Array(width * height).fill(null);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const nx = (x + 0.5) / width * 2 - 1, ny = 1 - (y + 0.5) / height * 2;
      const n = apply4(invPV, [nx, ny, -1, 1]), f = apply4(invPV, [nx, ny, 1, 1]);
      const o = n.slice(0, 3).map((v) => v / n[3]), e = f.slice(0, 3).map((v) => v / f[3]);
      const dir = sub(e, o), denom = dot(dir, frame.forward);
      if (Math.abs(denom) < 1e-9) continue;
      const t = dot(sub(frame.position, o), frame.forward) / denom;
      if (t <= 0) continue;
      const hit = o.map((v, i) => v + dir[i] * t), rel = sub(hit, frame.position);
      out[y * width + x] = [dot(rel, frame.right), dot(rel, frame.up)];
    }
  }
  return out;
}

/** The pixels of `image` whose ray meets the disc within `share` of its radius. */
function insideDisc(image, cam, frame, radius, share = 0.8) {
  const coords = discCoordinates(image, cam, frame), pixels = [];
  coords.forEach((ab, i) => { if (ab && Math.hypot(ab[0], ab[1]) <= share * radius) pixels.push([image.rgba[i * 4], image.rgba[i * 4 + 1], image.rgba[i * 4 + 2]]); });
  return pixels;
}

function flatShare(pixels) {
  return pixels.length ? pixels.filter((p) => near(p, PREVIEW_COLOR, 12)).length / pixels.length : 0;
}

/** The route's portal state and the camera's matrices. */
const read = (page) => page.evaluate((key) => {
  const d = window.__x3dWorld.debugState();
  const p = d.portal || {};
  const rec = p.surface?.records?.[key] || null;
  const camera = window.__assembly.scene._impl.camera;
  camera.updateMatrixWorld(true);
  return {
    camera: d.camera, clock: window.__behaviorClock.seconds,
    portal: { key: p.key ?? null, reason: p.reason ?? null, entry: p.entry ?? null, disc: p.disc ?? null, overlay: p.overlay ?? null,
      window_target_frame: p.window_target_frame ?? null, preview: p.preview ? p.preview[key] ?? null : null, runtime: p.runtime ?? null,
      bound: !!p.surface, gate: p.surface?.surface_gates?.[key] ?? null,
      record: rec && { frames_rendered: rec.frames_rendered, projected_aperture: rec.projected_aperture, last_camera: rec.last_camera,
        ring_alignment: rec.ring_alignment, camera_mapped: rec.camera_mapped, content_status: rec.canonical_content_status,
        content_error: rec.canonical_content_error, render_target: rec.render_target, awareness: rec.awareness_volume } },
    cam: { mwi: camera.matrixWorldInverse.elements.slice(), p: camera.projectionMatrix.elements.slice() },
  };
}, KEY);

async function untilClock(page, seconds, limitMs = 60000) {
  const start = await page.evaluate(() => window.__behaviorClock.seconds);
  const started = Date.now();
  for (;;) {
    const now = await page.evaluate(() => window.__behaviorClock.seconds);
    if (now - start >= seconds) return now;
    if (Date.now() - started > limitMs) fail(`the frame loop got ${fixed(now - start)} of ${seconds} s (timed out after ${limitMs / 1000} s)`);
    await sleep(40);
  }
}

/** Open a page on the route with a full request log; wait for the document viewer to say it is ready. */
async function openDocument(ctx, url, { before = null } = {}) {
  const page = await ctx.visit(url, { open: false });
  const errors = [], consoleErrors = [], requests = [], sockets = [];
  page.on("pageerror", (error) => errors.push(String((error && error.message) || error)));
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push({ at: Date.now(), text: message.text() }); });
  page.on("request", (request) => requests.push({ url: request.url(), method: request.method(), type: request.resourceType(), at: Date.now() }));
  const cdp = await page.createCDPSession();
  await cdp.send("Network.enable");
  cdp.on("Network.webSocketCreated", (event) => sockets.push(event.url));
  if (before) await before(page);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  const started = Date.now();
  for (;;) {
    const ready = await page.evaluate(() => document.body.dataset.x3dWorldReady === "1" && !!window.__x3dWorld?.debugState).catch(() => false);
    if (ready) break;
    if (errors.length) fail(`the document route threw: ${errors[0].slice(0, 200)}`);
    if (Date.now() - started > 120000) fail(`the document route was not ready at ${page.url()} (timed out after 120 s)`);
    await sleep(100);
  }
  const readyAt = Date.now();
  await page.bringToFront();
  return { page, errors, consoleErrors, requests, sockets, readyAt };
}

/** Wait until the window is live and its destination content is ready; the time from ready is part of the answer. */
async function untilLive(opened, limitMs = LIVE_LIMIT_MS) {
  for (;;) {
    const r = await read(opened.page);
    const status = r.portal.preview?.status;
    if (r.portal.gate?.live && r.portal.gate.reason === "canonical_destination_visible" && (status === "ready" || status === "ready_with_asset_errors")) return { ...r, afterMs: Date.now() - opened.readyAt };
    if (Date.now() - opened.readyAt > limitMs) fail(`the window was not live and ready ${limitMs / 1000} s after ready: gate ${JSON.stringify(r.portal.gate && { live: r.portal.gate.live, reason: r.portal.gate.reason })}, preview ${JSON.stringify(r.portal.preview)}, entry ${r.portal.entry ? "present" : `absent (${r.portal.reason})`}`);
    await sleep(100);
  }
}

/** Catch every main-frame navigation from now on and abort it. */
async function catchNavigations(page) {
  const seen = [];
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    if (request.isInterceptResolutionHandled()) return;
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) { seen.push(request.url()); request.abort("aborted").catch(() => {}); }
    else request.continue().catch(() => {});
  });
  return seen;
}

/** What the destination declares as its preview, read here in Node from its own World resource. */
async function declaredKind(ctx, key) {
  const response = await fetch(`${ctx.lab.address(key)}wow/world`);
  if (!response.ok) fail(`${ctx.lab.address(key)}wow/world answered ${response.status}`);
  const world = await response.json();
  const preview = world && typeof world.preview === "object" ? world.preview : null;
  return preview && preview.url && preview.node ? "nodes" : preview && preview.image ? "image" : "color";
}

const pageOf = (file) => (ctx) => ctx.once(`doc-${file}`, async () => {
  const opened = await openDocument(ctx, docUrl(ctx, file));
  const live = await untilLive(opened).catch((error) => ({ error }));
  return { ...opened, live };
});
const anchorPage = pageOf(ANCHOR);
const softPage = pageOf(SOFT);
const liveOf = (opened) => { if (opened.live.error) throw opened.live.error; return opened.live; };

function expectEntry(r, file, ctx) {
  const want = DOCS[file], entry = r.portal.entry;
  expect(entry, `no portal entry on ${file} (reason ${r.portal.reason})`);
  expect(r.portal.key === KEY, `the portal key is ${r.portal.key}, not ${KEY}`);
  const off = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));
  expect(off(entry.frame.position, want.center) <= 1e-3, `frame.position ${entry.frame.position} is not within 1e-3 of ${want.center}`);
  expect(off(entry.frame.forward, want.forward) <= 1e-3, `frame.forward ${entry.frame.forward} is not within 1e-3 of ${want.forward}`);
  expect(Math.abs(entry.frame.width_m - 2 * want.radius) <= 1e-6 && Math.abs(entry.frame.height_m - 2 * want.radius) <= 1e-6, `aperture ${entry.frame.width_m} x ${entry.frame.height_m}, not ${2 * want.radius} square`);
  const world = ctx.lab.world(want.world);
  expect(entry.destination === world.address && entry.wow_resource.destination === world.address, `destination ${entry.destination}, not the listed ${want.world} address ${world.address}`);
  expect(r.portal.disc.semantic_matrix_residual <= 1e-6, `the realized disc and the semantic runtime disagree by ${r.portal.disc.semantic_matrix_residual}`);
  expect(entry.traversal.mode === "one_way" && entry.traversal.allowed_entry_side === "front", `traversal ${JSON.stringify(entry.traversal)}`);
  expect(r.portal.disc.viewpoint_signed_distance_m > 0, `the authored Entry viewpoint is behind the disc (${r.portal.disc.viewpoint_signed_distance_m} m)`);
  expect(r.portal.overlay && r.portal.overlay.attached, `no aperture overlay on the disc: ${JSON.stringify(r.portal.overlay)}`);
  return `${file}: key ${r.portal.key}, centre ${entry.frame.position.map((v) => fixed(v, 4))}, forward ${entry.frame.forward.map((v) => fixed(v, 5))}, ${entry.frame.width_m} m square, destination ${entry.destination} (listed ${want.world}), target_location_id ${entry.target_location_id}, semantic residual ${r.portal.disc.semantic_matrix_residual}, Entry viewpoint ${fixed(r.portal.disc.viewpoint_signed_distance_m, 3)} m in front`;
}

/** Projected aperture area against the analytic projection of the 2r square, in drawing-buffer pixels. */
function apertureVsAnalytic(r, file) {
  const proj = r.portal.record.projected_aperture, f = r.portal.entry.frame;
  const { width: W, height: H } = proj.drawing_buffer;
  // The analytic square is the authored disc's (2r), not the entry's own size: an entry sized wrong must show here.
  const pv = mul4(r.cam.p, r.cam.mwi), half = DOCS[file].radius;
  const xs = [], ys = [];
  for (const [sa, sb] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    const p = f.position.map((v, i) => v + f.right[i] * sa * half + f.up[i] * sb * half);
    const c = apply4(pv, [...p, 1]);
    xs.push((c[0] / c[3] * 0.5 + 0.5) * W); ys.push((c[1] / c[3] * 0.5 + 0.5) * H);
  }
  const clamp = (v, hi) => Math.max(0, Math.min(hi, v));
  const analytic = (clamp(Math.max(...xs), W) - clamp(Math.min(...xs), W)) * (clamp(Math.max(...ys), H) - clamp(Math.min(...ys), H));
  return { area: proj.area_device_px, analytic, buffer: W * H, W, H };
}

const statements = [
  { id: "anchor-entry", says: "P1: the anchor document's disc is one standard portal entry at its authored pose, size and listed destination", async run(ctx) {
    const { page } = await anchorPage(ctx);
    return expectEntry(await read(page), ANCHOR, ctx);
  } },
  { id: "soft-entry", says: "P2: the soft-body document's disc is one standard portal entry at its authored pose, size and listed destination", async run(ctx) {
    const { page } = await softPage(ctx);
    return expectEntry(await read(page), SOFT, ctx);
  } },
  { id: "window-live", says: `P3: at both authored viewpoints the window is live within ${LIVE_LIMIT_MS / 1000} s of ready, shows what the destination declares, and keeps rendering`, async run(ctx) {
    const out = [];
    for (const [file, opener] of [[ANCHOR, anchorPage], [SOFT, softPage]]) {
      const opened = await opener(ctx);
      await opened.page.bringToFront();
      const live = liveOf(opened);
      const kind = await declaredKind(ctx, DOCS[file].world);
      expect(live.portal.preview.kind === kind, `${file}: the window shows kind ${live.portal.preview.kind}, the destination declares ${kind}`);
      expect(live.portal.overlay.visible && live.portal.overlay.window_material, `${file}: the overlay is not showing the window: ${JSON.stringify(live.portal.overlay)}`);
      const first = await read(opened.page);
      await sleep(1000);
      await untilClock(opened.page, 0.2);
      const second = await read(opened.page);
      const a = first.portal.record.frames_rendered, b = second.portal.record.frames_rendered;
      expect(b >= 10 && b > a, `${file}: frames_rendered ${a} -> ${b} over 1 s (need >= 10 and increasing)`);
      out.push(`${file}: live after ${fixed(live.afterMs / 1000, 2)} s, reason ${live.portal.gate.reason}, kind ${live.portal.preview.kind} (declared ${kind}), status ${live.portal.preview.status}, nodes ${live.portal.preview.node_ids?.length ?? 0}, frames ${a} -> ${b}`);
    }
    return out.join("; ");
  } },
  { id: "aperture-size", says: "P4: the projected aperture is at least 1% of the drawing buffer at both authored viewpoints and at most 1.3x the analytic 2r square", async run(ctx) {
    const out = [];
    for (const [file, opener] of [[ANCHOR, anchorPage], [SOFT, softPage]]) {
      const opened = await opener(ctx);
      liveOf(opened);
      const r = await read(opened.page);
      const m = apertureVsAnalytic(r, file);
      expect(m.area >= 0.01 * m.buffer, `${file}: aperture ${m.area} px is under 1% of ${m.W}x${m.H}`);
      expect(m.area <= 1.3 * m.analytic, `${file}: aperture ${m.area} px is over 1.3x the analytic ${fixed(m.analytic, 0)} px`);
      out.push(`${file}: ${m.area} px (${fixed(100 * m.area / m.buffer, 2)}% of ${m.W}x${m.H}), analytic ${fixed(m.analytic, 0)} px, ratio ${fixed(m.area / m.analytic)}; render target ${r.portal.record.render_target.width}x${r.portal.record.render_target.height}`);
    }
    return out.join("; ");
  } },
  { id: "disc-pixels", says: "P5: inside 0.8 r of the disc the frame shows the destination: >= 30% of pixels over 20/255 from the flat colour, luminance spread over 2/255 (a flat fill measures 0)", async run(ctx) {
    // Both viewpoints are measured before any clause is judged, so one viewpoint's failure does not hide the other's.
    const out = [], problems = [];
    for (const [file, opener] of [[ANCHOR, anchorPage], [SOFT, softPage]]) {
      const opened = await opener(ctx);
      liveOf(opened);
      await untilClock(opened.page, 0.3);
      const r = await read(opened.page);
      const image = await shot(ctx, opened.page, `${file.split(".")[0]}-disc`);
      const pixels = insideDisc(image, r.cam, r.portal.entry.frame, DOCS[file].radius);
      expect(pixels.length > 200, `${file}: only ${pixels.length} pixels inside 0.8 r (the check would mean nothing)`);
      const differ = pixels.filter((p) => !near(p, PREVIEW_COLOR, 20)).length / pixels.length;
      const lumas = pixels.map(luma), mean = lumas.reduce((s, v) => s + v, 0) / lumas.length;
      const sd = Math.sqrt(lumas.reduce((s, v) => s + (v - mean) ** 2, 0) / lumas.length);
      const line = `${file}: ${pixels.length} pixels inside 0.8 r, ${fixed(differ)} differ from #28344f by > 20, luminance sd ${fixed(sd, 2)}, flat share ${fixed(flatShare(pixels))}; shot ${image.file}`;
      out.push(line);
      if (differ < 0.3) problems.push(`${file}: inside the disc only ${fixed(differ)} of ${pixels.length} pixels differ from the unreachable colour by over 20`);
      if (!(sd > 2)) problems.push(`${file}: inside the disc the luminance sd is ${fixed(sd, 2)}, not over 2`);
    }
    if (problems.length) fail(`${problems.join("; ")} [measured: ${out.join("; ")}]`);
    return out.join("; ");
  } },
  { id: "glue", says: "P6: a 1.0 m lateral walk moves the mapped camera 1.0 m (+-0.08) with local x reversed; ring alignment <= 1 device px", async run(ctx) {
    const opened = await anchorPage(ctx);
    const { page } = opened;
    liveOf(opened);
    await page.bringToFront();
    const before = await read(page);
    expect(before.portal.record.camera_mapped && before.portal.record.last_camera, "the window's camera is not mapped before the walk");
    // The anchor document walks left with A (ArrowLeft is the soft-body document's left; web/movement-camera-controller.mjs).
    await page.keyboard.down("KeyA");
    let after;
    try {
      const started = Date.now();
      for (;;) {
        const d = await page.evaluate(() => window.__x3dWorld.debugState().camera);
        if (Math.hypot(d[0] - before.camera[0], d[2] - before.camera[2]) >= 0.97) break;
        if (Date.now() - started > 120000) fail("the lateral walk did not reach 1 m (timed out after 120 s)");
        await sleep(10);
      }
    } finally { await page.keyboard.up("KeyA"); }
    await untilClock(page, 0.3);
    after = await read(page);
    const moved = sub(after.camera, before.camera), walked = Math.hypot(moved[0], moved[2]);
    expect(walked >= 0.9 && walked <= 1.15, `the viewer walked ${fixed(walked)} m, not about 1.0 m`);
    const lcA = before.portal.record.last_camera, lcB = after.portal.record.last_camera;
    const mappedMove = sub(lcB.position, lcA.position), mapped = Math.hypot(...mappedMove);
    expect(Math.abs(mapped - walked) <= 0.08, `the mapped camera moved ${fixed(mapped)} m for a ${fixed(walked)} m walk`);
    const sourceX = lcB.source_local.x - lcA.source_local.x;
    const tf = after.portal.window_target_frame;
    expect(tf, "no window target frame recorded");
    const targetX = dot(mappedMove, tf.right);
    expect(Math.abs(Math.abs(sourceX) - walked) <= 0.08 && Math.sign(sourceX) === -Math.sign(targetX) && Math.abs(Math.abs(targetX) - walked) <= 0.08,
      `local x is not reversed: source-local x moved ${fixed(sourceX)}, destination-local x moved ${fixed(targetX)}`);
    const ring = after.portal.record.ring_alignment;
    const { W, H } = apertureVsAnalytic(after, ANCHOR);
    const px = ring ? ring.max_ndc_delta * Math.max(W, H) / 2 : Infinity;
    expect(px <= 1, `ring alignment ${ring ? ring.max_ndc_delta : "none"} ndc = ${fixed(px, 3)} device px, over 1`);
    return `walked ${fixed(walked)} m along (${fixed(moved[0])}, ${fixed(moved[2])}); mapped camera moved ${fixed(mapped)} m; source-local x ${fixed(sourceX)}, destination-local x ${fixed(targetX)}; ring alignment ${ring.max_ndc_delta} ndc = ${fixed(px, 3)} px; target frame ${tf.pose_source}`;
  } },
  { id: "back-side", says: "P8: 2 m behind the anchor disc the gate refuses (camera_on_blocked_side), the overlay hides and the window does not render", async run(ctx) {
    const opened = await openDocument(ctx, docUrl(ctx, ANCHOR));
    const { page } = opened;
    await untilLive(opened);
    const seen = await catchNavigations(page);
    // Around the PortalTrigger box (x within 1.2 m of 0): 2 m left, 10.5 m ahead, 2 m right, to (0, 1.6, -4.5).
    const legs = [["KeyA", 0, -2], ["KeyW", 2, -4.5], ["KeyD", 0, 0]];
    for (const [key, axis, target] of legs) {
      await page.keyboard.down(key);
      try {
        const started = Date.now();
        for (;;) {
          const d = await page.evaluate(() => window.__x3dWorld.debugState().camera);
          if (key === "KeyD" ? d[axis] >= target - 0.02 : d[axis] <= target + 0.02) break;
          if (Date.now() - started > 180000) fail(`the walk ${key} did not reach ${target} (timed out after 180 s)`);
          await sleep(10);
        }
      } finally { await page.keyboard.up(key); }
    }
    await untilClock(page, 0.3);
    const a = await read(page);
    await sleep(1000);
    await untilClock(page, 0.3);
    const b = await read(page);
    const signed = dot(sub(b.camera, b.portal.entry.frame.position), b.portal.entry.frame.forward);
    expect(signed < -1.5, `the viewer is ${fixed(signed)} m from the disc plane, not behind it (the check would be vacuous)`);
    expect(!seen.length, `a navigation went out on the walk round the trigger: ${seen[0]}`);
    expect(b.portal.gate && !b.portal.gate.live && b.portal.gate.reason === "camera_on_blocked_side", `the gate is ${JSON.stringify(b.portal.gate && { live: b.portal.gate.live, reason: b.portal.gate.reason })}`);
    expect(!b.portal.overlay.visible && !b.portal.overlay.window_material, `the overlay still shows: ${JSON.stringify(b.portal.overlay)}`);
    expect(b.portal.record.frames_rendered === a.portal.record.frames_rendered, `the window rendered ${b.portal.record.frames_rendered - a.portal.record.frames_rendered} frames behind the disc`);
    const image = await shot(ctx, page, "anchor-back");
    await page.close();
    return `camera ${b.camera.map((v) => fixed(v, 2))}, ${fixed(signed)} m behind the plane; gate ${b.portal.gate.reason}; overlay visible ${b.portal.overlay.visible}; frames ${a.portal.record.frames_rendered} -> ${b.portal.record.frames_rendered} over 1 s; no navigation; shot ${image.file}`;
  } },
  { id: "anchor-click", says: "P9: with the window showing, a click on the disc still dispatches the authored /w/b/", async run(ctx) {
    const opened = await openDocument(ctx, docUrl(ctx, ANCHOR));
    const { page } = opened;
    const live = await untilLive(opened);
    expect(live.portal.overlay.visible, "the overlay is not showing at the click");
    const seen = await catchNavigations(page);
    const d = await read(page);
    const box = await page.$eval("#scene-mount", (mount) => { const r = mount.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; });
    const c = apply4(mul4(d.cam.p, d.cam.mwi), [...DOCS[ANCHOR].center, 1]);
    const at = { x: box.x + (c[0] / c[3] + 1) / 2 * box.width, y: box.y + (1 - c[1] / c[3]) / 2 * box.height };
    await page.mouse.click(at.x, at.y);
    const started = Date.now();
    while (!seen.length && Date.now() - started < NAV_WAIT_MS) await sleep(100);
    expect(seen.length, `no navigation after a click on the disc centre at (${fixed(at.x, 0)}, ${fixed(at.y, 0)})`);
    const target = new URL(seen[0]);
    expect(target.pathname === "/w/b/", `the click dispatched ${seen[0]}, not /w/b/`);
    await page.close();
    return `click at (${fixed(at.x, 0)}, ${fixed(at.y, 0)}) with the overlay showing dispatched ${target.pathname}${target.search} (caught and aborted); the soft-body crossing is src/x3d-route-check.mjs soft-crossing on the same code`;
  } },
  { id: "traffic", says: "P10: the page reads only GETs under the listed destination's address; no /api/, /fabric/, presence, stream, WebSocket, POST or PUT; one X3D document fetch", async run(ctx) {
    const opened = await openDocument(ctx, docUrl(ctx, ANCHOR));
    await untilLive(opened);
    await untilClock(opened.page, 1);
    const reqs = opened.requests.slice();
    const b = ctx.lab.address("b");
    const worldOrigins = ctx.lab.doc.worlds.map((w) => w.address);
    const toWorlds = reqs.filter((r) => worldOrigins.some((o) => r.url.startsWith(o)));
    const destination = toWorlds.filter((r) => r.url.startsWith(b));
    const others = toWorlds.filter((r) => !r.url.startsWith(b));
    const nonGet = reqs.filter((r) => r.method !== "GET");
    // Session and presence traffic, not the app's own module files (live-adapter-presence-*.mjs load as scripts on every route).
    const banned = reqs.filter((r) => { const path = new URL(r.url).pathname; return /^\/api\/|\/fabric\/|\/presence/.test(path) && r.type !== "script" || r.type === "eventsource" || r.type === "websocket"; });
    const docs = reqs.filter((r) => new URL(r.url).pathname.endsWith(`/x3d-worlds/${ANCHOR}`));
    expect(destination.length > 0, "the page made no request to the destination (the check would be vacuous)");
    expect(destination.every((r) => r.method === "GET"), `non-GET to the destination: ${destination.filter((r) => r.method !== "GET").map((r) => `${r.method} ${r.url}`).join(", ")}`);
    expect(!others.length, `requests to other worlds: ${others.map((r) => r.url).join(", ")}`);
    expect(!nonGet.length, `non-GET requests: ${nonGet.map((r) => `${r.method} ${r.url}`).join(", ")}`);
    expect(!banned.length, `session, presence or stream requests: ${banned.map((r) => `${r.type} ${r.url}`).join(", ")}`);
    expect(!opened.sockets.length, `WebSockets opened: ${opened.sockets.join(", ")}`);
    expect(docs.length === 1, `the X3D document was fetched ${docs.length} times`);
    await opened.page.close();
    return `${reqs.length} requests; destination GETs ${destination.length}: ${[...new Set(destination.map((r) => new URL(r.url).pathname))].join(", ")}; other worlds 0; non-GET 0; /api/ /fabric/ presence streams 0; WebSockets 0; X3D document fetched once`;
  } },
  { id: "outside-unchanged", says: "P7: with the portal entry removed (F2, a copy), pixels outside the disc's 2r square match within 2/255 on >= 99%, the disc keeps its authored colour, and no destination is asked", async run(ctx) {
    const dir = join(CODE, ".runtime", "behavior", "x3d-portal-optics", "f2-comparison");
    const code = plantFaults({ dir, edits: [F2_EDIT] });
    const lab = createLab({ dir, first: ctx.first + 10, code });
    const out = [];
    try {
      lab.start();
      // Fresh real pages at the authored viewpoints: the shared anchor page has walked by now (glue, P6).
      for (const file of [ANCHOR, SOFT]) {
        const real = await openDocument(ctx, docUrl(ctx, file));
        await untilLive(real);
        const f2 = await openDocument({ ...ctx, lab }, `${lab.front}/index.html?renderer=own-x3d&x3dDocument=${file}`);
        // The soft body moves for some seconds after load: both pages are compared after 9 s of their own loop time,
        // and pixels that still change on either page within 0.5 s are left out (reported).
        const settle = file === SOFT ? 9 : 0.5;
        const frames = [];
        for (const opened of [real, f2]) {
          await opened.page.bringToFront();
          const elapsed = await opened.page.evaluate(() => window.__behaviorClock.seconds);
          if (elapsed < settle) await untilClock(opened.page, settle - elapsed, 180000);
          const r = await read(opened.page);
          const one = await shot(ctx, opened.page, `${file.split(".")[0]}-${opened === real ? "real" : "f2"}-a`);
          await untilClock(opened.page, 0.5);
          const two = await shot(ctx, opened.page, `${file.split(".")[0]}-${opened === real ? "real" : "f2"}-b`);
          frames.push({ r, one, two });
        }
        const [R, F] = frames;
        const apart = Math.hypot(...R.r.camera.map((v, i) => v - F.r.camera[i]));
        expect(apart <= 1e-3, `${file}: the two pages' cameras are ${fixed(apart)} m apart (the comparison would mean nothing)`);
        const fr = await read(f2.page);
        expect(fr.portal.entry === null && fr.portal.reason === "planted_f2", `the F2 page has a portal entry (${fr.portal.reason})`);
        const f2World = f2.requests.filter((q) => lab.doc.worlds.some((w) => q.url.startsWith(w.address)));
        expect(!f2World.length, `with no entry the page still asked ${f2World.map((q) => q.url).join(", ")}`);
        const frame = R.r.portal.entry.frame, radius = DOCS[file].radius;
        const coords = discCoordinates(R.two, R.r.cam, frame);
        let compared = 0, matched = 0, moving = 0;
        const insideF2 = [];
        for (let i = 0; i < coords.length; i += 1) {
          const ab = coords[i];
          const px = (img) => [img.rgba[i * 4], img.rgba[i * 4 + 1], img.rgba[i * 4 + 2]];
          if (ab && Math.hypot(ab[0], ab[1]) <= 0.8 * radius) insideF2.push(px(F.two));
          if (ab && Math.abs(ab[0]) <= radius && Math.abs(ab[1]) <= radius) continue;
          if (!near(px(R.one), px(R.two), 2) || !near(px(F.one), px(F.two), 2)) { moving += 1; continue; }
          compared += 1;
          if (near(px(R.two), px(F.two), 2)) matched += 1;
        }
        const share = matched / compared;
        expect(share >= 0.99, `${file}: outside the disc square only ${fixed(share, 4)} of ${compared} pixels match the F2 page within 2/255`);
        const mean = [0, 1, 2].map((k) => insideF2.reduce((s, p) => s + p[k], 0) / insideF2.length);
        expect(insideF2.length > 200 && flatShare(insideF2) < 0.1 && mean[0] > mean[2] + 40, `${file}: inside the disc the F2 page is not the authored orange: mean ${mean.map((v) => fixed(v, 0))}, flat share ${fixed(flatShare(insideF2))}`);
        out.push(`${file}: ${fixed(share, 4)} of ${compared} outside pixels within 2/255 (${moving} still-moving pixels left out); F2 entry null (${fr.portal.reason}), 0 destination requests, disc mean ${mean.map((v) => fixed(v, 0))}; shots ${R.two.file}, ${F.two.file}`);
        await f2.page.close();
        await real.page.close();
      }
    } finally {
      await lab.stop();
      rmSync(code, { recursive: true, force: true });
    }
    return out.join("; ");
  } },
  { id: "offline", lab: () => ({ separate: "b" }), says: "P11: with the destination's server stopped the page does not throw, the window is live with kind unreachable, and the disc shows the flat colour", async run(ctx) {
    await ctx.lab.stopWorld("b");
    const opened = await openDocument(ctx, docUrl(ctx, ANCHOR));
    const started = Date.now();
    let r;
    for (;;) {
      r = await read(opened.page);
      if (r.portal.preview?.kind === "unreachable" && r.portal.gate?.live) break;
      if (Date.now() - started > 15000) fail(`offline: preview ${JSON.stringify(r.portal.preview)}, gate ${JSON.stringify(r.portal.gate && { live: r.portal.gate.live, reason: r.portal.gate.reason })} (timed out after 15 s); kind is not unreachable`);
      await sleep(100);
    }
    await untilClock(opened.page, 0.5);
    r = await read(opened.page);
    const image = await shot(ctx, opened.page, "anchor-offline");
    const pixels = insideDisc(image, r.cam, r.portal.entry.frame, DOCS[ANCHOR].radius);
    const flat = flatShare(pixels);
    expect(!opened.errors.length, `the page threw: ${opened.errors[0]}`);
    expect(pixels.length > 200 && flat >= 0.9, `inside the disc ${fixed(flat)} of ${pixels.length} pixels are within 12/255 of #28344f, under 0.9`);
    await opened.page.close();
    return `kind ${r.portal.preview.kind} (${r.portal.preview.reason}), gate live ${r.portal.gate.live} (${r.portal.gate.reason}), no page error; ${fixed(flat)} of ${pixels.length} disc pixels within 12/255 of #28344f; shot ${image.file}`;
  } },
  { id: "dispose", says: "P12: leaving the route releases the window and the overlay, with no render or error after a late destination answer", async run(ctx) {
    const out = [];
    for (const late of [false, true]) {
      const delayed = [];
      const opened = await openDocument(ctx, docUrl(ctx, ANCHOR), { before: late ? async (page) => {
        const b = ctx.lab.address("b");
        await page.setRequestInterception(true);
        page.on("request", (request) => {
          if (request.isInterceptResolutionHandled()) return;
          if (request.url().startsWith(b)) { delayed.push({ url: request.url(), at: Date.now() }); setTimeout(() => request.continue().catch(() => {}), 2000); }
          else request.continue().catch(() => {});
        });
      } : null });
      const { page } = opened;
      if (late) {
        const started = Date.now();
        while (!delayed.length && Date.now() - started < 5000) await sleep(20);
        expect(delayed.length, "F4: no destination request was held (the check would be vacuous)");
        const wait = 500 - (Date.now() - opened.readyAt);
        if (wait > 0) await sleep(wait);
      } else await untilLive(opened);
      const before = await read(page);
      const result = await page.evaluate(async () => {
        const impl = window.__assembly.scene._impl;
        const overlay = impl.scene.getObjectByName("x3d-portal-aperture");
        if (!overlay) return { error: "no aperture overlay in the scene" };
        let geometryDisposed = false, renders = 0, disposed = false;
        const geometryDispose = overlay.geometry.dispose.bind(overlay.geometry);
        overlay.geometry.dispose = () => { geometryDisposed = true; geometryDispose(); };
        const renderer = impl.renderer, render = renderer.render.bind(renderer);
        renderer.render = (...args) => { if (disposed) renders += 1; return render(...args); };
        let thrown = null;
        try { window.__assembly.dispose(); } catch (error) { thrown = String(error && error.message || error); }
        disposed = true;
        await new Promise((r) => setTimeout(r, 3000));
        let portal = null, debugError = null;
        try { portal = window.__x3dWorld.debugState().portal; } catch (error) { debugError = String(error && error.message || error); }
        return { thrown, renders, geometryDisposed, overlayAttached: !!overlay.parent, debugError,
          surface: portal ? portal.surface : "unread", runtime: portal ? portal.runtime : null, overlayDebug: portal ? portal.overlay : null };
      });
      if (result.error) fail(result.error);
      const disposedAt = Date.now() - 3000;
      const lateErrors = opened.consoleErrors.filter((e) => e.at >= disposedAt - 50);
      const tag = late ? "F4 late answer" : "live window";
      expect(!result.thrown, `${tag}: disposal threw ${result.thrown}`);
      expect(!result.debugError, `${tag}: debugState threw after disposal: ${result.debugError}`);
      expect(result.surface === null, `${tag}: the window manager is still there after disposal`);
      expect(result.runtime && result.runtime.webgl_contexts_awaiting_release === 0 && result.runtime.portal_preview_bound === false, `${tag}: runtime after disposal ${JSON.stringify(result.runtime)}`);
      expect(result.geometryDisposed && !result.overlayAttached, `${tag}: overlay geometry disposed ${result.geometryDisposed}, still attached ${result.overlayAttached}`);
      expect(result.renders === 0, `${tag}: ${result.renders} renders after disposal`);
      expect(!opened.errors.length && !lateErrors.length, `${tag}: errors: ${[...opened.errors, ...lateErrors.map((e) => e.text)].join(" | ").slice(0, 300)}`);
      out.push(`${tag}: before ${late ? `status ${before.portal.preview?.status ?? before.portal.record?.content_status} with ${delayed.length} held destination request(s)` : `frames ${before.portal.record.frames_rendered}`}; after: manager gone, contexts awaiting release ${result.runtime.webgl_contexts_awaiting_release}, overlay geometry disposed and detached, 0 renders and 0 errors in 3 s`);
      await page.close();
    }
    return out.join("; ");
  } },
  { id: "regression-hash", says: "P13: web/portal-spatial-preview.mjs is unchanged from Lab's named hash", async run() {
    const sha = createHash("sha256").update(readFileSync(join(CODE, "web", "portal-spatial-preview.mjs"))).digest("hex");
    expect(sha === PORTAL_SPATIAL_PREVIEW_SHA256, `web/portal-spatial-preview.mjs is ${sha}, not ${PORTAL_SPATIAL_PREVIEW_SHA256}`);
    return `sha256 ${sha}; tools/placement/run.mjs, main-demo M13/M10 and the default route are separate runs`;
  } },
];

const DOC = "web/own-x3d-document.mjs";
const F2_EDIT = { file: DOC, find: "const found = ownX3dPortalEntry({ state, selection, worlds, THREE });", replace: `const found = { entry: null, reason: "planted_f2" };` };
const faults = [
  { statement: "anchor-entry", name: "F2: no portal entry for the disc", expect: /no portal entry/, edits: [F2_EDIT] },
  { statement: "soft-entry", name: "the disc's forward taken from local +Z, not the cylinder axis", expect: /frame\.forward/, edits: [
    { file: DOC, find: "new THREE.Vector3(0, 1, 0).transformDirection(world4)", replace: "new THREE.Vector3(0, 0, 1).transformDirection(world4)" }] },
  { statement: "window-live", name: "the document viewer's frame never draws portal previews", expect: /was not live|frames_rendered/, edits: [
    { file: "web/movement-camera-controller.mjs", find: "if (documentViewer) { sceneRuntime.renderPortalPreviews(deltaSeconds); frameFaults.clean(timestamp); return; }", replace: "if (documentViewer) { frameFaults.clean(timestamp); return; }" }] },
  { statement: "aperture-size", name: "the aperture rectangle is twice the disc", expect: /over 1\.3x the analytic|not live/, edits: [
    { file: DOC, find: "width_m: 2 * radius,\n  height_m: 2 * radius,", replace: "width_m: 4 * radius,\n  height_m: 4 * radius," }] },
  { statement: "disc-pixels", name: "F1: the destination resolver always finds the destination unreachable", expect: /differ from the unreachable colour/, edits: [
    { file: "web/app.js", find: "resolveBoundedPreview(entry, { fetch: (url, init) => fetch(url, init) })", replace: `resolveBoundedPreview(entry, { fetch: () => Promise.reject(new Error("planted F1")) })` }] },
  { statement: "glue", name: "the window glue keeps local x (no 180-degree turn)", expect: /local x is not reversed|ring alignment/, edits: [
    { file: "web/live-adapter-portal-geometry.mjs", find: "    x: -(Number(local && local.x) || 0),\n    y: Number(local && local.y) || 0,\n    z: -(Number(local && local.z) || 0),", replace: "    x: (Number(local && local.x) || 0),\n    y: Number(local && local.y) || 0,\n    z: -(Number(local && local.z) || 0)," }] },
  { statement: "back-side", name: "the window opens from both faces", expect: /the gate is|overlay still shows/, edits: [
    { file: DOC, find: `normalizePortalTraversal({ mode: "one_way", allowed_entry_side: "front" })`, replace: `normalizePortalTraversal({ mode: "bidirectional" })` }] },
  { statement: "traffic", name: "the destination is read with POST", expect: /non-GET/, edits: [
    { file: "web/app.js", find: "resolveBoundedPreview(entry, { fetch: (url, init) => fetch(url, init) })", replace: `resolveBoundedPreview(entry, { fetch: (url, init) => fetch(url, { ...init, method: "POST" }) })` }] },
  { statement: "offline", name: "the document route has no destination resolver", expect: /kind is not unreachable/, edits: [
    { file: "web/scene-runtime-controller.mjs", find: `if (entry?.x3d_document_portal && typeof resolveX3dPortalDestination === "function") return resolveX3dPortalDestination(entry);`, replace: "" }] },
  { statement: "dispose", name: "disposal leaves the overlay on the disc", expect: /overlay geometry disposed/, edits: [
    { file: DOC, find: "for (const release of [() => aperture?.removeFromParent(), () => aperture?.geometry.dispose(), () => idleMaterial?.dispose()]) {", replace: "for (const release of [() => idleMaterial?.dispose()]) {" }] },
];

process.on("exit", () => {
  if (!shotLog.length) return;
  console.log("screenshots:");
  for (const { file, sha256 } of shotLog) console.log(`  ${sha256}  ${file}`);
});

for (const fault of faults) for (const edit of fault.edits) if (!readFileSync(join(CODE, edit.file), "utf8").includes(edit.find)) console.log(`note: fault edit no longer applies: ${edit.file}`);

await runBehavior({ title: "x3d-portal-optics", firstPort: 38100, statements, faults });
