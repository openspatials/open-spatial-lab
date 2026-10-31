// Iteration 4 in the main demo: standard portals and previews, as a Player, with real keyboard and mouse input.
//
//   Run:  npm run -s arch-i4-main-proof
//         (add `-- --only M4` for one check, `-- --no-faults` to skip the planted faults)
//
// Each check starts its own lab on isolated ports (33500 up), opens the real main demo in headless Chrome for Testing,
// and is then run again against a copy of the code with a planted fault, which must turn it red. A planted fault whose
// edit no longer applies, or that is caught for any reason but its named one, is a harness error, and the proof fails. Numbered screenshots of the real run go to screens/
// under OSL_PROOF_DIR (default .runtime/arch-i4-main-proof).
//
//   M1   portals come from world data and sit at their node
//   M2   a crossing arrives within 1 cm of the destination's #join node; plain navigation does too
//   M3   the airport's return lands at the Lobby's center portal
//   M4   a preview draws only what the destination declares; the request log shows no other node fetched
//   M5   a portal inside a preview shows closed
//   M6   previewing creates no user in the destination
//   M7   an offline destination: the crossing is refused, the reason shows, the visitor stays
//   M8   no destination: the portal does nothing and says why
//   M9   the Lobby start is outside every perimeter, with no destination loading at first
//   M10  after a crossing with keys held the avatar stands idle until a new key press
//   M11  no outside network needed: every asset is local; with no connection the demo says so at once
//   M12  a world added to a temporary OSL_WORLDS list appears with no other edit
//   M13  placement in the main demo behind the setting, refused without it; a placed portal appears for every visitor,
//        and one moved or sent elsewhere through the world's data reaches a visitor already there
//   M14  a browser on another machine (OSL_BIND_HOST=0.0.0.0, no public origin): addresses follow the request's host
//   M15  on small phones the open panel stops above the footer, whose real height it follows
import { request as httpRequest } from "node:http";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { createLab, launchBrowser, openPlayer, plantFaults, sleep, state, walkTo, faceYaw, walkThrough, screenPointOf, hold, CODE, HarnessError } from "./lab.mjs";
import { recordRequests } from "./request-log.mjs";
import { arrivalOf, allNodes, distance, getJson, nodePose, placeByApi, worldPortals } from "./world-data.mjs";

const OUT = process.env.OSL_PROOF_DIR ? resolve(process.env.OSL_PROOF_DIR) : join(CODE, ".runtime", "arch-i4-main-proof");
const SCREENS = join(OUT, "screens");
const FIRST_PORT = Number(process.env.OSL_ARCH_I4_MAIN_PORT) || 33500;
const ONE_CM = 0.01;
const args = process.argv.slice(2);
const only = args.includes("--only") ? args[args.indexOf("--only") + 1].split(",") : null;
const withFaults = !args.includes("--no-faults");
const onlyFaults = args.includes("--faults-only");

let shotNumber = 0;
let realRun = false;

async function shot(page, name) {
  if (!realRun) return;
  shotNumber += 1;
  await page.screenshot({ path: join(SCREENS, `${String(shotNumber).padStart(2, "0")}-${name}.png`) });
}

const fail = (message) => { throw new Error(message); };
const expectTrue = (value, message) => { if (!value) fail(message); };
/** Wait in the page; on time-out, fail for the named reason. "(timed out)" lets a load failure get its one re-run. */
const waitOrFail = (page, fn, options, arg, message) => page.waitForFunction(fn, options, arg).catch((error) => {
  if (!/exceeded|timeout/i.test(String(error && error.message))) throw error;
  fail(`${message} (timed out after ${Math.round(options.timeout / 1000)} s)`);
});
const ROUTE = (ctx, query = "") => `${ctx.lab.front}/index.html?role=player&intro=bypass${query}`;

/** A new visitor. `alone` closes the visitors before it first: each open page draws its world on the CPU. */
async function newPage(ctx, { alone = false } = {}) {
  if (alone) for (const context of ctx.contexts.splice(0)) await context.close();
  const context = await ctx.browser.createBrowserContext();
  const page = await context.newPage();
  ctx.contexts.push(context);
  page.on("pageerror", (error) => ctx.pageErrors.push(String(error && error.message ? error.message : error)));
  return page;
}

/** Keep every toast this page shows from now on, in window.__seenToasts: a toast's life is shorter than a walk. */
async function recordToasts(page) {
  await page.evaluate(() => {
    window.__seenToasts = [];
    new MutationObserver((changes) => {
      for (const change of changes) {
        for (const node of change.addedNodes) if (node.classList && node.classList.contains("toast")) window.__seenToasts.push(node.textContent.replace(/\s+/g, " ").trim());
      }
    }).observe(document.body, { childList: true, subtree: true });
  });
}

/** Hold W until the page records a refusal, the world changes, or 12 s pass: how far a fixed time walks depends on the load. */
async function walkUntilRefused(page) {
  await page.keyboard.down("w");
  await page.waitForFunction(() => window.__assembly.portalRefusals().length > 0 || window.__assembly.debugState().location_id !== "location-lobby", { timeout: 12000, polling: 100 }).catch(() => {});
  await page.keyboard.up("w");
  await sleep(500);
}

/** Wait until every portal of the shown world has its preview settled. */
async function previewsSettled(page, timeout = 90000) {
  await page.waitForFunction(() => {
    const previews = window.__assembly.portalPreviews();
    const world = window.__assembly.adapter.world;
    const keys = (world.portals || []).map((p) => p.string_portal_id || String(p.portal_id));
    return keys.length > 0 && keys.every((k) => {
      const p = previews[k];
      return p && p.kind && (!p.assets || p.assets.status !== "pending");
    });
  }, { timeout, polling: 200 });
}

/** The rings as the scene draws them: { key: [x, y, z] }. */
const ringCenters = (page) => page.evaluate(() => {
  const debug = window.__assembly.debugState();
  const alignment = debug.portal_visual_alignment || {};
  const world = window.__assembly.adapter.world;
  const out = {};
  const impl = window.__assembly.viewport.identity().scene._impl;
  (world.portals || []).forEach((portal, index) => {
    const key = portal.string_portal_id || String(portal.portal_id);
    const group = index === 0 ? impl.directionalPortalGroup : impl.additionalPortalGroups && impl.additionalPortalGroups[key] && impl.additionalPortalGroups[key].group;
    out[key] = group ? { position: [group.position.x, group.position.y, group.position.z], yaw: group.rotation.y, label: portal.label, id: portal.portal_id, forward: portal.frame.forward } : null;
  });
  void alignment;
  return out;
});

// ---- the checks ------------------------------------------------------------------------------------------------

const CHECKS = {
  async M1(ctx) {
    await ctx.lab.start();
    const lobby = ctx.lab.address("lobby");
    const before = await worldPortals(lobby);
    expectTrue(before.length === 3, `the Lobby's world data lists ${before.length} portals`);
    expectTrue(before.every((p) => typeof p.resource.destination === "string" && p.resource.node), "a Lobby portal has no destination or no node");
    // Move one configured portal's node in the world's data. A browser that holds a copy would not follow it.
    const movedNode = before[1];
    const moved = [3.4, 0, -3.1];
    const node = (await getJson(`${lobby}wow/spatial/1/node/${movedNode.nodeId}?nodeForm=flat`)).json;
    const transform = node.localTransform.slice();
    transform[12] = moved[0];
    transform[14] = moved[2];
    const put = await fetch(`${lobby}wow/spatial/1/node/${movedNode.nodeId}`, { method: "PUT", headers: { "Content-Type": "application/json", Accept: "application/wow+json" }, body: JSON.stringify({ localTransform: transform }) });
    expectTrue(put.ok, `moving the portal's node answered ${put.status}`);
    const page = await newPage(ctx);
    await openPlayer(page, ROUTE(ctx));
    await previewsSettled(page);
    const portals = await worldPortals(lobby);
    const rings = await ringCenters(page);
    const off = [];
    for (const portal of portals) {
      const key = portal.resource.webofworlds_extension.portal_id;
      const ring = rings[key];
      if (!ring) { off.push(`${key} is not drawn`); continue; }
      const d = Math.hypot(ring.position[0] - portal.pose.position[0], ring.position[2] - portal.pose.position[2]);
      if (d > ONE_CM) off.push(`${key} is drawn ${d.toFixed(3)} m from its node`);
      if (Math.hypot(ring.forward[0] - portal.pose.forward[0], ring.forward[2] - portal.pose.forward[2]) > 0.001) off.push(`${key} faces away from its node's +Z`);
    }
    expectTrue(!off.length, off.join("; "));
    expectTrue(Math.hypot(rings["lobby-portal-b"].position[0] - moved[0], rings["lobby-portal-b"].position[2] - moved[2]) <= ONE_CM, `the moved portal's ring stayed at ${rings["lobby-portal-b"].position}`);
    await faceYaw(page, Math.PI);
    await sleep(1200);
    await shot(page, "m1-lobby-portals-at-their-nodes-one-moved-in-world-data");
    // B's rooms face -x in their world data: the facing comes from the node, not from the browser.
    const pageB = await newPage(ctx, { alone: true });
    await openPlayer(pageB, ROUTE(ctx, "&active=target"));
    const portalsB = await worldPortals(ctx.lab.address("b"));
    const ringsB = await ringCenters(pageB);
    for (const portal of portalsB) {
      const ring = ringsB[portal.resource.webofworlds_extension.portal_id];
      expectTrue(ring && Math.abs(ring.forward[0] + 1) < 0.001, `Location B's portal ${portal.id} does not face its node's -X: ${JSON.stringify(ring && ring.forward)}`);
    }
    // No portal in the browser's own code.
    const hits = [];
    const walk = (dir) => {
      for (const name of readdirSync(dir)) {
        if (name === "assets" || name === "vendor") continue;
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(mjs|js|html|json)$/.test(name)) {
          // Code only: a comment may tell a portal's history.
          const code = readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
          if (/lobby-portal-[abc]|airport-portal-lobby|location-[ab]-portal/.test(code)) hits.push(name);
        }
      }
    };
    walk(join(ctx.lab.code, "web"));
    expectTrue(!hits.length, `the browser's code names built-in portals: ${hits.join(", ")}`);
    return `3 Lobby rings and 2 Location B rings at their nodes within 1 cm, facing their nodes; one node moved in the world's data and its ring followed; no portal id in web/`;
  },

  async M2(ctx) {
    await ctx.lab.start();
    const page = await newPage(ctx);
    await openPlayer(page, ROUTE(ctx));
    await recordToasts(page);
    const lobby = await worldPortals(ctx.lab.address("lobby"));
    const toA = lobby.find((p) => p.resource.label === "Portal to Location A");
    const arrival = await arrivalOf(toA.resource.destination);
    expectTrue(arrival.node !== null, `the portal's destination names no arrival: ${toA.resource.destination}`);
    const ring = toA.pose.position;
    const inward = toA.pose.forward;
    // Through the middle of the ring.
    await walkThrough(page, { from: [ring[0] + inward[0] * 1.4, ring[2] + inward[2] * 1.4], yaw: Math.atan2(-inward[0], -inward[2]), expect: "location-a" });
    let s = await state(page);
    expectTrue(s.location_id === "location-a", `the walk did not cross: still in ${s.location_id}, at ${s.position}`);
    const off = distance(s.position, arrival.pose.position);
    expectTrue(off <= ONE_CM, `arrived ${off.toFixed(4)} m from node ${arrival.node}: ${s.position} vs ${arrival.pose.position}`);
    await sleep(800);
    await shot(page, "m2-arrived-in-location-a-at-the-join-node");
    // The arrival toast says what happened, and claims nothing about other people.
    const arrivedToast = await page.evaluate(() => window.__seenToasts.find((text) => /^arrived/i.test(text)));
    expectTrue(arrivedToast, `no arrival toast was shown: ${JSON.stringify(await page.evaluate(() => window.__seenToasts))}`);
    expectTrue(!/presence/i.test(arrivedToast), `the arrival toast claims presence: ${arrivedToast}`);
    // Back to the Lobby through the same edge, off the ring's middle: still within 1 cm of its arrival node.
    const inA = await worldPortals(ctx.lab.address("a"));
    const back = inA.find((p) => p.resource.label === "Portal to Lobby");
    const backArrival = await arrivalOf(back.resource.destination);
    const side = [back.pose.forward[2], 0, -back.pose.forward[0]];
    const lateral = 0.5;
    await walkThrough(page, {
      from: [back.pose.position[0] + back.pose.forward[0] * 1.4 + side[0] * lateral, back.pose.position[2] + back.pose.forward[2] * 1.4 + side[2] * lateral],
      yaw: Math.atan2(-back.pose.forward[0], -back.pose.forward[2]),
      expect: "location-lobby",
    });
    s = await state(page);
    expectTrue(s.location_id === "location-lobby", `the walk back did not cross: in ${s.location_id}, at ${s.position}`);
    const offBack = distance(s.position, backArrival.pose.position);
    expectTrue(offBack <= ONE_CM, `off the ring's middle, arrived ${offBack.toFixed(4)} m from node ${backArrival.node}`);
    // Plain web navigation: the world's own page at {B}/#join=node.n.
    const plain = await newPage(ctx, { alone: true });
    await openPlayer(plain, `${ctx.lab.front}/w/a/?intro=bypass#join=node.${arrival.node}`);
    const atPlain = await state(plain);
    const offPlain = distance(atPlain.position, arrival.pose.position);
    expectTrue(atPlain.location_id === "location-a" && offPlain <= ONE_CM, `plain navigation: in ${atPlain.location_id}, ${offPlain.toFixed(4)} m from the node`);
    await shot(plain, "m2-plain-navigation-to-the-join-node");
    // And a walk through a portal that crosses by plain navigation.
    const walker = await newPage(ctx, { alone: true });
    await openPlayer(walker, ROUTE(ctx, "&crossing=plain"));
    await walkTo(walker, ring[0] + inward[0] * 1.4, ring[2] + inward[2] * 1.4);
    await faceYaw(walker, Math.atan2(-inward[0], -inward[2]));
    await sleep(300);
    const navigated = walker.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 60000 });
    await walker.keyboard.down("w");
    await navigated;
    await walker.keyboard.up("w");
    const url = walker.url();
    expectTrue(url.includes("/w/a/") && url.endsWith(`#join=node.${arrival.node}`), `the walk navigated to ${url}`);
    await walker.waitForFunction(() => document.body.dataset.assemblyReady === "1" && window.__assembly?.debugState().avatar, { timeout: 120000 });
    await walker.evaluate(() => document.querySelector('[data-testid="start-exploring"]')?.click());
    const walked = await state(walker);
    const offWalked = distance(walked.position, arrival.pose.position);
    expectTrue(offWalked <= ONE_CM, `after the plain navigation, ${offWalked.toFixed(4)} m from the node`);
    return `seamless: ${(off * 1000).toFixed(1)} mm from node ${arrival.node}; ${lateral} m off the ring's middle: ${(offBack * 1000).toFixed(1)} mm; plain navigation: ${(offPlain * 1000).toFixed(1)} mm opened directly, ${(offWalked * 1000).toFixed(1)} mm walked through`;
  },

  async M3(ctx) {
    await ctx.lab.start();
    const page = await newPage(ctx);
    await openPlayer(page, ROUTE(ctx));
    await recordToasts(page);
    const lobby = await worldPortals(ctx.lab.address("lobby"));
    const center = lobby.find((p) => p.resource.label === "Portal to Denver Skyport");
    await walkThrough(page, { from: [center.pose.position[0], center.pose.position[2] + 1.4], yaw: Math.PI, expect: "location-airport" });
    const inAirport = await state(page);
    expectTrue(inAirport.location_id === "location-airport", `did not reach the airport: ${JSON.stringify(inAirport)}`);
    await page.waitForFunction(() => document.body.dataset.airportTerminalReady === "1", { timeout: 60000 });
    await sleep(1200);
    await shot(page, "m3-in-the-airport");
    // The crossing's small toast names the world from the list, not a prefetch and not another world.
    const crossing = await page.evaluate(() => ({ toasts: window.__seenToasts.filter((text) => /^entering/i.test(text)), title: window.__assembly.featurePortalLoading.status().destination_title }));
    expectTrue(/^Entering Denver Skyport$/.test(crossing.title) && crossing.toasts.every((text) => /^entering denver skyport/i.test(text)), `the crossing toast named ${JSON.stringify(crossing)} on the walk to the airport`);
    const portals = await worldPortals(ctx.lab.address("airport"));
    const back = portals[0];
    await walkThrough(page, { from: [back.pose.position[0], back.pose.position[2] + 1.4], yaw: Math.PI, expect: "location-lobby" });
    const s = await state(page);
    expectTrue(s.location_id === "location-lobby", `did not return to the Lobby: ${JSON.stringify(s)}`);
    // Independently: the arrival in front of the center portal, from the center portal's own node.
    const expected = [center.pose.position[0] + center.pose.forward[0] * 1.05, 0, center.pose.position[2] + center.pose.forward[2] * 1.05];
    const off = distance(s.position, expected);
    const toLeft = lobby.find((p) => p.resource.label === "Portal to Location A");
    const fromLeft = distance(s.position, [toLeft.pose.position[0], 0, toLeft.pose.position[2]]);
    expectTrue(off <= ONE_CM, `the return landed ${off.toFixed(3)} m from the center portal's arrival (${fromLeft.toFixed(2)} m from the left portal), at ${s.position}`);
    await sleep(800);
    await shot(page, "m3-back-in-the-lobby-at-the-center-portal");
    return `the return landed ${(off * 1000).toFixed(1)} mm from the center portal's arrival node, ${fromLeft.toFixed(2)} m from the left portal`;
  },

  async M4(ctx) {
    await ctx.lab.start();
    // A world's own thing near the room's middle, and one far outside what its preview reaches.
    const a = ctx.lab.address("a");
    const root = (await getJson(`${a}wow/spatial/1`)).json.rootNodeID;
    const add = async (label, x, z) => {
      const r = await fetch(`${a}wow/spatial/1/node/${root}`, {
        method: "POST", headers: { "Content-Type": "application/json", Accept: "application/wow+json" },
        body: JSON.stringify([{ label, localTransform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0.5, z, 1], spatialAssetURI: "osl-primitive:box?size_m=1", appearanceURI: "osl-color:ff00ff" }]),
      });
      expectTrue(r.ok, `adding ${label} answered ${r.status}`);
      return (await r.json())[0].id;
    };
    const nearId = await add("near marker", 1, 3);
    const farId = await add("far marker", 30, 0);
    // A world that declares an image, and one that declares nothing, each in a process of the proof's own.
    const require = createRequire(join(ctx.lab.code, "package.json"));
    const { createServer } = require(join(ctx.lab.code, "runtime/world-server/src/server.js"));
    const imageAt = FIRST_PORT + 8;
    const colourAt = FIRST_PORT + 9;
    const started = [];
    const startOne = async (port, preview) => {
      const built = createServer("b", { http_port: port, portals: [], preview, room: undefined, location_id: `location-p${port}`, world_id: `world-p${port}`, session_id: `session-p${port}` });
      await new Promise((done, failed) => { built.server.once("error", failed); built.server.listen(port, "127.0.0.1", done); });
      started.push(built);
    };
    ctx.cleanups.push(async () => { for (const built of started) await built.closeAll(); });
    await startOne(imageAt, { image: `${ctx.lab.front}/assets/hud/storefront-frontier-news--profile.jpg` });
    await startOne(colourAt, undefined);
    const lobby = ctx.lab.address("lobby");
    await placeByApi(lobby, { x: -4.6, z: 2.2, label: "To the image world", destination: `http://127.0.0.1:${imageAt}/` });
    await placeByApi(lobby, { x: 4.6, z: 2.2, label: "To the colour world", destination: `http://127.0.0.1:${colourAt}/` });

    const page = await newPage(ctx);
    const log = await recordRequests(page, { worlds: [...ctx.lab.doc.worlds, { key: "image", address: `http://127.0.0.1:${imageAt}/` }, { key: "colour", address: `http://127.0.0.1:${colourAt}/` }], front: ctx.lab.front });
    await openPlayer(page, ROUTE(ctx));
    await previewsSettled(page);
    await sleep(2500);
    const previews = await page.evaluate(() => window.__assembly.portalPreviews());
    const problems = [];
    // A's preview: exactly the nodes within its radius of its arrival node, computed here from the world's graph.
    const declared = (await getJson(`${a}wow/world`)).json.preview;
    const arrivalPose = await nodePose(a, 1, Number(/node\/(\d+)$/.exec(declared.node)[1]));
    const within = (await allNodes(a, 1)).filter((n) => distance(n.position, arrivalPose.position) <= declared.radius_m).map((n) => n.id).sort((x, y) => x - y);
    const shown = [...previews["lobby-portal-a"].node_ids].sort((x, y) => x - y);
    if (JSON.stringify(shown) !== JSON.stringify(within)) problems.push(`A's preview shows ${shown}, its radius holds ${within}`);
    if (!shown.includes(nearId)) problems.push("the near node is missing from A's preview");
    if (shown.includes(farId)) problems.push("the far node is in A's preview");
    // The airport's: the part of the terminal within its radius, not the far gate.
    const airport = ctx.lab.address("airport");
    const airportWithin = (await allNodes(airport, 1)).filter((n) => distance(n.position, [0, 0, 0]) <= 24);
    const airportFar = (await allNodes(airport, 1)).filter((n) => distance(n.position, [0, 0, 0]) > 24);
    const airportShown = previews["lobby-portal-c"].node_ids;
    if (airportWithin.some((n) => !airportShown.includes(n.id))) problems.push(`the airport's preview lacks nodes within its radius: shows ${airportShown}`);
    if (airportFar.some((n) => airportShown.includes(n.id))) problems.push("the airport's preview shows nodes beyond its radius");
    if (airportFar.length < 5) problems.push(`the airport check is vacuous: only ${airportFar.length} nodes lie beyond its radius`);
    // The image and the plain colour.
    const placedKeys = await page.evaluate(() => window.__assembly.adapter.world.portals.filter((p) => p.placed).map((p) => ({ key: String(p.portal_id), label: p.label })));
    const kindOf = (label) => previews[placedKeys.find((p) => p.label === label).key].kind;
    if (kindOf("To the image world") !== "image") problems.push(`the image world shows ${kindOf("To the image world")}`);
    if (kindOf("To the colour world") !== "color") problems.push(`the colour world shows ${kindOf("To the colour world")}`);
    // The request log: from the first view, each destination was asked only for its World, its preview and its portals.
    const allowed = /^\/wow\/(world|preview|portal\/\d+)$/;
    for (const key of ["a", "b", "airport"]) {
      const asked = log.forWorld(key).map((e) => `${e.method} ${e.path.replace(/\?.*$/, "")}`);
      const other = asked.filter((line) => !allowed.test(line.split(" ")[1]) || !line.startsWith("GET "));
      if (other.length) problems.push(`${key} was also asked for ${[...new Set(other)].join(", ")}`);
      if (!asked.some((line) => line.endsWith("/wow/preview"))) problems.push(`${key}'s preview URL was never read`);
    }
    expectTrue(!problems.length, problems.join("; "));
    await faceYaw(page, Math.PI);
    await sleep(1500);
    await shot(page, "m4-lobby-the-previews-from-the-worlds-data");
    // Inside A's perimeter the prefetch runs and holds a person in A. Nothing it holds may reach A's preview.
    const toA = (await worldPortals(lobby)).find((p) => p.resource.label === "Portal to Location A");
    const standing = (await arrivalOf(toA.resource.destination)).pose.position;
    const registered = await fetch(`${a}fabric/presence/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ player_id: "known-only-to-the-prefetch", avatar_id: "x", display_name: "Known only to the prefetch", position: standing }) });
    expectTrue(registered.ok, `registering a person in A answered ${registered.status}`);
    // A person who stops saying they are there leaves, so this one keeps saying it while the visitor walks over.
    const stayer = setInterval(() => { void fetch(`${a}fabric/presence/heartbeat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ player_id: "known-only-to-the-prefetch", position: standing }) }).catch(() => {}); }, 1000);
    ctx.cleanups.push(async () => clearInterval(stayer));
    await walkTo(page, toA.pose.position[0] + toA.pose.forward[0] * 1.8, toA.pose.position[2] + toA.pose.forward[2] * 1.8);
    await faceYaw(page, Math.atan2(-toA.pose.forward[0], -toA.pose.forward[2]));
    await waitOrFail(page, () => {
      const machine = window.__assembly.debugState().fabric_prefetch.keyed.machines["lobby-portal-a"];
      return machine && machine.zone && machine.zone.inside && machine.status === "warm" && Array.isArray(machine.region?.entities) && machine.region.entities.length > 0
        && (machine.presence?.occupancy?.avatars || []).some((avatar) => avatar.player_id === "known-only-to-the-prefetch");
    }, { timeout: 60000, polling: 250 }, undefined, "inside A's perimeter the prefetch never held the region and the person, so this case would be vacuous").catch(async (error) => {
      const held = await page.evaluate(() => { const m = window.__assembly.debugState().fabric_prefetch.keyed.machines["lobby-portal-a"]; return m && { status: m.status, inside: m.zone && m.zone.inside, entities: m.region?.entities?.length, avatars: m.presence?.occupancy?.avatars }; });
      fail(`${error.message}: ${JSON.stringify(held)}`);
    });
    await sleep(2500);
    const inside = await page.evaluate(() => window.__assembly.portalPreviews()["lobby-portal-a"]);
    expectTrue(inside.kind === "nodes" && inside.avatars_shown === 0 && inside.prefetch_fed === false && JSON.stringify([...inside.node_ids].sort((x, y) => x - y)) === JSON.stringify(shown),
      `the prefetch fed A's preview: ${JSON.stringify({ kind: inside.kind, avatars_shown: inside.avatars_shown, prefetch_fed: inside.prefetch_fed, nodes: inside.node_ids.length, before: shown.length })}`);
    await shot(page, "m4-inside-the-perimeter-the-preview-is-still-only-what-a-declares");
    await walkTo(page, 3.2, 1.2);
    await faceYaw(page, Math.atan2(1.4, 1));
    await sleep(1500);
    await shot(page, "m4-a-world-that-declares-no-preview-shows-a-plain-colour");
    await walkTo(page, -3.2, 1.2);
    await faceYaw(page, Math.atan2(-1.4, 1));
    await sleep(2000);
    await shot(page, "m4-a-world-that-declares-an-image-shows-it");
    return `A shows exactly ${shown.length} nodes within ${declared.radius_m} m (a node 30 m away left out), the airport ${airportShown.length} (${airportFar.length} beyond 24 m left out), an image and a plain colour; inside A's perimeter the warm prefetch fed nothing to the preview; from the first view each destination was asked only for wow/world, wow/preview and wow/portal/{n}`;
  },

  async M5(ctx) {
    await ctx.lab.start();
    const page = await newPage(ctx);
    const log = await recordRequests(page, { worlds: ctx.lab.doc.worlds, front: ctx.lab.front });
    await openPlayer(page, ROUTE(ctx, "&active=airport"));
    await previewsSettled(page);
    await sleep(1500);
    const previews = await page.evaluate(() => window.__assembly.portalPreviews());
    const lobbyPreview = previews["airport-portal-lobby"];
    expectTrue(lobbyPreview && lobbyPreview.kind === "nodes", `the airport's portal shows ${JSON.stringify(lobbyPreview)}`);
    const closed = lobbyPreview.closed_portals.filter((p) => !p.way_back);
    expectTrue(closed.length === 2, `closed portals inside the Lobby's preview: ${JSON.stringify(lobbyPreview.closed_portals)}`);
    const faces = await page.evaluate(() => (window.__assembly.debugState().portal_spatial_preview.records["airport-portal-lobby"].canonical_inventory || []).filter((name) => /^wow-portal-closed/.test(name)));
    expectTrue(faces.length === 4, `the scene holds ${faces.length} closed-portal meshes`);
    // Their destinations are never read for this view: nothing went to Location A or B.
    const toInner = [...log.forWorld("a"), ...log.forWorld("b")];
    expectTrue(!toInner.length, `the page read the inner portals' destinations: ${toInner.map((e) => e.path).join(", ")}`);
    await walkTo(page, 1.4, -2.6);
    await faceYaw(page, Math.atan2(-1.4, -1.8));
    await sleep(2000);
    const sample = await page.evaluate(() => {
      const preview = window.__assembly.debugState().portal_spatial_preview.records["airport-portal-lobby"];
      return { mapped: preview.camera_mapped, closed: (preview.object_culling.objects || []).filter((o) => /^wow-portal-closed-face/.test(o.id)).map((o) => o.reason) };
    });
    expectTrue(sample.closed.length === 2, `closed faces in the window: ${JSON.stringify(sample)}`);
    await shot(page, "m5-through-the-airport-portal-the-lobbys-portals-show-closed");
    return `through the airport's portal, the Lobby's 2 other portals show closed (ring and plain face); no request went to Location A or B`;
  },

  async M6(ctx) {
    await ctx.lab.start();
    const counts = async () => {
      const out = {};
      for (const key of ["a", "b", "airport"]) {
        const world = (await getJson(`${ctx.lab.address(key)}wow/world`)).json;
        const presence = (await getJson(`${ctx.lab.address(key)}fabric/presence`)).json;
        out[key] = { active: world.users.active_user_count, listed: world.webofworlds_extension.users.length, arrivals: world.session.arrival_count, registered: (presence.occupancy && presence.occupancy.avatars || []).length };
      }
      return out;
    };
    const before = await counts();
    const page = await newPage(ctx);
    await openPlayer(page, ROUTE(ctx));
    await previewsSettled(page);
    await sleep(5000);
    const after = await counts();
    expectTrue(JSON.stringify(before) === JSON.stringify(after), `previewing changed a destination's users: before ${JSON.stringify(before)}, after ${JSON.stringify(after)}`);
    const here = (await getJson(`${ctx.lab.address("lobby")}wow/world`)).json.users.active_user_count;
    expectTrue(here === 1, `the Lobby, where the visitor is, counts ${here} users (the check would be vacuous)`);
    // Inside A's perimeter, with the prefetch running: still no user in A.
    const toA = (await worldPortals(ctx.lab.address("lobby"))).find((p) => p.resource.label === "Portal to Location A");
    await walkTo(page, toA.pose.position[0] + toA.pose.forward[0] * 1.8, toA.pose.position[2] + toA.pose.forward[2] * 1.8);
    await waitOrFail(page, () => {
      const machine = window.__assembly.debugState().fabric_prefetch.keyed.machines["lobby-portal-a"];
      return machine && machine.zone && machine.zone.inside && machine.status === "warm";
    }, { timeout: 30000, polling: 250 }, undefined, "inside A's perimeter the prefetch never finished, so this case would be vacuous");
    await sleep(5000);
    const insideCounts = await counts();
    expectTrue(JSON.stringify(after) === JSON.stringify(insideCounts), `inside the perimeter, the prefetch changed a destination's users: before ${JSON.stringify(after)}, after ${JSON.stringify(insideCounts)}`);
    return `inside A's perimeter with the prefetch warm for 5 s, and with 3 previews showing for 5 s, Location A, Location B and the airport still count ${JSON.stringify(after.a.active)}, ${after.b.active} and ${after.airport.active} users; the Lobby counts 1, the visitor`;
  },

  async M7(ctx) {
    await ctx.lab.startWithSeparateWorld("e");
    const lobby = ctx.lab.address("lobby");
    const placed = await placeByApi(lobby, { x: 4.4, z: 1.4, label: "Portal to Location E", destination: ctx.lab.address("e") });
    const page = await newPage(ctx);
    await openPlayer(page, ROUTE(ctx));
    await previewsSettled(page);
    const key = String(placed.portal.id);
    const whileUp = await page.evaluate((k) => window.__assembly.portalPreviews()[k], key);
    expectTrue(whileUp.kind === "nodes", `while Location E runs, its portal shows ${JSON.stringify(whileUp)}`);
    await ctx.lab.stopWorld("e");
    const at = placed.node.localTransform;
    const inward = placed.inward;
    const from = [at[12] + inward[0] * 1.4, at[14] + inward[2] * 1.4];
    await walkTo(page, from[0], from[1]);
    await faceYaw(page, Math.atan2(-inward[0], -inward[2]));
    await sleep(800);
    await walkUntilRefused(page);
    const refusals = await page.evaluate(() => window.__assembly.portalRefusals());
    expectTrue(refusals.length > 0, "no refusal was recorded");
    expectTrue(refusals[0].kind === "offline" && /offline/i.test(refusals[0].sentence), `refusal: ${JSON.stringify(refusals[0])}`);
    const s = await state(page);
    expectTrue(s.location_id === "location-lobby", `the visitor left: in ${s.location_id}`);
    const toast = await page.evaluate(() => { const t = document.querySelector("#toast-stack .toast"); return t ? t.textContent : null; });
    expectTrue(toast && /offline/i.test(toast), `the notification shows ${JSON.stringify(toast)}`);
    const records = await page.evaluate(() => window.__assembly.notifications.list().filter((n) => n.kind === "portal_refused").map((n) => n.summary));
    expectTrue(records.length > 0, "the notification center has no record of the refusal");
    await shot(page, "m7-crossing-refused-the-reason-shows-the-visitor-stays");
    // The ring now says so, and a new visitor finds it offline from the start.
    await page.waitForFunction((k) => window.__assembly.portalPreviews()[k]?.kind === "unreachable", { timeout: 20000, polling: 250 }, key);
    const fresh = await newPage(ctx, { alone: true });
    await openPlayer(fresh, ROUTE(ctx));
    await previewsSettled(fresh);
    const seen = await fresh.evaluate((k) => window.__assembly.portalPreviews()[k], key);
    expectTrue(seen.kind === "unreachable", `a new visitor's portal shows ${JSON.stringify(seen)}`);
    await walkTo(fresh, from[0] - inward[0] * -0.6, from[1] - inward[2] * -0.6);
    await faceYaw(fresh, Math.atan2(-inward[0], -inward[2]));
    await sleep(1000);
    await shot(fresh, "m7-the-portal-to-an-offline-world-says-offline");
    return `walked through the portal with Location E's process stopped: refused, "${refusals[0].sentence}", still in the Lobby`;
  },

  async M8(ctx) {
    await ctx.lab.start();
    const placed = await placeByApi(ctx.lab.address("lobby"), { x: -4.4, z: 1.4, label: "Unfinished portal" });
    const page = await newPage(ctx);
    await openPlayer(page, ROUTE(ctx));
    await previewsSettled(page);
    const preview = await page.evaluate((k) => window.__assembly.portalPreviews()[k], String(placed.portal.id));
    expectTrue(preview.kind === "none", `the portal shows ${JSON.stringify(preview)}`);
    const at = placed.node.localTransform;
    const inward = placed.inward;
    await walkTo(page, at[12] + inward[0] * 1.4, at[14] + inward[2] * 1.4);
    await faceYaw(page, Math.atan2(-inward[0], -inward[2]));
    await sleep(800);
    await shot(page, "m8-a-portal-with-no-destination-says-so");
    await walkUntilRefused(page);
    const refusals = await page.evaluate(() => window.__assembly.portalRefusals());
    expectTrue(refusals.length > 0 && refusals[0].kind === "no_destination", `refusals: ${JSON.stringify(refusals)}`);
    const s = await state(page);
    expectTrue(s.location_id === "location-lobby", `the visitor left: in ${s.location_id}`);
    const toast = await page.evaluate(() => { const t = document.querySelector("#toast-stack .toast"); return t ? t.textContent : null; });
    expectTrue(toast && /no destination/i.test(toast), `the notification shows ${JSON.stringify(toast)}`);
    await shot(page, "m8-walked-through-it-does-nothing-and-says-why");
    return `walked through the portal: nothing happened, "${refusals[0].sentence}"`;
  },

  async M9(ctx) {
    await ctx.lab.start();
    const page = await newPage(ctx);
    const log = await recordRequests(page, { worlds: ctx.lab.doc.worlds, front: ctx.lab.front });
    await openPlayer(page, ROUTE(ctx));
    await previewsSettled(page);
    await sleep(3000);
    const s = await state(page);
    expectTrue(s.location_id === "location-lobby", `started in ${s.location_id}`);
    const portals = await worldPortals(ctx.lab.address("lobby"));
    const margins = portals.map((p) => {
      const radius = p.resource.webofworlds_extension.zones.prefetch.radius_m;
      return Math.hypot(s.position[0] - p.pose.position[0], s.position[2] - p.pose.position[2]) - radius;
    });
    expectTrue(margins.every((m) => m >= 0.69), `the start ${s.position} is within ${Math.min(...margins).toFixed(3)} m of a perimeter (must clear it by the avatar's body and a margin, 0.7 m)`);
    const machines = await page.evaluate(() => {
      const keyed = window.__assembly.debugState().fabric_prefetch.keyed.machines;
      return Object.values(keyed).map((m) => ({ key: m.portal_key, status: m.status, inside: m.zone && m.zone.inside }));
    });
    expectTrue(machines.every((m) => m.status === "idle" && !m.inside), `a prefetch started: ${JSON.stringify(machines)}`);
    const loading = [];
    for (const key of ["a", "b", "airport"]) {
      for (const e of log.forWorld(key)) if (!/^\/wow\/(world|preview|portal\/\d+)$/.test(e.path.replace(/\?.*$/, ""))) loading.push(`${key} ${e.method} ${e.path}`);
    }
    expectTrue(!loading.length, `at the first view, a destination was loading: ${[...new Set(loading)].join(", ")}`);
    await faceYaw(page, Math.PI);
    await sleep(1000);
    await shot(page, "m9-the-first-view-is-the-portals");
    // Then only the portal the visitor nears starts loading.
    const nearest = portals.find((p) => p.resource.label === "Portal to Location A");
    const mark = log.mark();
    await walkTo(page, nearest.pose.position[0], nearest.pose.position[2] + 2.2);
    await sleep(2500);
    const nearA = log.forWorld("a", mark).filter((e) => /fabric\/region|well-known/.test(e.path));
    const nearOthers = [...log.forWorld("b", mark), ...log.forWorld("airport", mark)].filter((e) => /fabric\/region|well-known/.test(e.path));
    expectTrue(nearA.length > 0, "nearing the portal started no prefetch for the crossing");
    expectTrue(!nearOthers.length, `nearing portal A also loaded: ${nearOthers.map((e) => `${e.world} ${e.path}`).join(", ")}`);
    return `the start ${s.position.map((v) => v.toFixed(2))} clears every perimeter by at least ${Math.min(...margins).toFixed(2)} m; no destination loads at the first view; nearing portal A loads only A`;
  },

  async M10(ctx) {
    await ctx.lab.start();
    const page = await newPage(ctx);
    await openPlayer(page, ROUTE(ctx));
    const lobby = await worldPortals(ctx.lab.address("lobby"));
    const toA = lobby.find((p) => p.resource.label === "Portal to Location A");
    await walkTo(page, toA.pose.position[0], toA.pose.position[2] + 2.2);
    await faceYaw(page, Math.PI);
    await sleep(400);
    // Hold run and forward through the crossing, as a person does, with the key repeating.
    await page.keyboard.down("Shift");
    await page.keyboard.down("w");
    let moving = false;
    const deadline = Date.now() + 14000;
    let s = await state(page);
    while (Date.now() < deadline && s.location_id !== "location-a") {
      await page.keyboard.down("w");
      await sleep(60);
      s = await state(page);
      if (s.controls.moving) moving = true;
    }
    expectTrue(s.location_id === "location-a", `did not cross: ${JSON.stringify(s)}`);
    expectTrue(moving, "the avatar never moved before the crossing (the check would be vacuous)");
    const held = await state(page);
    const samples = [];
    for (let i = 0; i < 14; i += 1) {
      await page.keyboard.down("w"); // the key is still down, and repeats
      await sleep(120);
      const now = await state(page);
      const look = await page.evaluate(() => window.__assembly.avatarVisualState().current_animation_state);
      samples.push({ position: now.position, moving: now.controls.moving, mode: now.controls.movement_mode, animation: look });
    }
    const wander = Math.max(...samples.map((x) => distance(x.position, held.position)));
    const settled = samples.slice(5);
    expectTrue(wander <= 0.001, `with the keys still held the avatar moved ${wander.toFixed(3)} m after the crossing`);
    expectTrue(settled.every((x) => !x.moving && x.mode === "idle"), `the controls did not stand idle: ${JSON.stringify(settled[0])}`);
    expectTrue(settled.every((x) => /idle/i.test(String(x.animation))), `the animation did not settle to idle: ${settled.map((x) => x.animation).join(",")}`);
    await shot(page, "m10-keys-still-held-after-the-crossing-the-avatar-stands-idle");
    await page.keyboard.up("w");
    await page.keyboard.up("Shift");
    await sleep(300);
    const standing = await state(page);
    await hold(page, "w", 500);
    await sleep(200);
    const moved = await state(page);
    expectTrue(distance(moved.position, standing.position) > 0.1, "a new key press did not move the avatar");
    return `with W and Shift still held (the key repeating), the avatar moved ${wander.toFixed(3)} m in 1.7 s after arriving and its animation settled to ${settled[0].animation}; a new press walked it ${distance(moved.position, standing.position).toFixed(2)} m`;
  },

  async M11(ctx) {
    await ctx.lab.startWithSeparateWorld("e");
    // The eight external asset URIs of the old order are now files of this lab: count every asset URI the worlds name.
    const uris = new Set();
    const nodesOf = (doc) => (Array.isArray(doc.nodes) ? doc.nodes : Object.values(doc.nodes || {}));
    for (const name of readdirSync(join(ctx.lab.code, "web", "worlds"))) {
      for (const node of nodesOf(JSON.parse(readFileSync(join(ctx.lab.code, "web", "worlds", name), "utf8")))) {
        if (typeof node.spatialAssetURI === "string" && /\.(glb|gltf|vrm)(\?|$)/i.test(node.spatialAssetURI)) uris.add(node.spatialAssetURI);
      }
    }
    const external = [...uris].filter((uri) => /^https?:/i.test(uri));
    const worldModels = readdirSync(join(ctx.lab.code, "web", "assets", "worlds")).filter((name) => name.endsWith(".glb"));
    expectTrue(worldModels.length === 8, `web/assets/worlds holds ${worldModels.length} models, not the eight`);
    for (const name of worldModels) {
      const r = await fetch(`${ctx.lab.front}/assets/worlds/${name}`);
      expectTrue(r.ok, `${name} answered ${r.status} from the lab`);
      await r.arrayBuffer();
    }
    // Outbound network blocked: anything that leaves this machine is refused and recorded, and the walk still works.
    const page = await newPage(ctx);
    const outside = [];
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      const host = new URL(request.url()).hostname;
      if (!["127.0.0.1", "localhost"].includes(host) && !request.url().startsWith("data:") && !request.url().startsWith("blob:")) {
        outside.push(request.url());
        void request.abort("internetdisconnected");
      } else {
        void request.continue();
      }
    });
    await openPlayer(page, ROUTE(ctx));
    await previewsSettled(page);
    const lobby = await worldPortals(ctx.lab.address("lobby"));
    const center = lobby.find((p) => p.resource.label === "Portal to Denver Skyport");
    await walkThrough(page, { from: [center.pose.position[0], center.pose.position[2] + 1.4], yaw: Math.PI, expect: "location-airport" });
    await page.waitForFunction(() => document.body.dataset.airportTerminalReady === "1", { timeout: 60000 });
    // Settled either way: a model refused by the blocked network must be named, not waited for until a time-out.
    await waitOrFail(page, () => Number(document.body.dataset.wowAssetsFailed) > 0 || Number(document.body.dataset.wowAssetsLoaded) > 0, { timeout: 90000 }, undefined, "the airport's assets never settled");
    expectTrue(!outside.length, `with outbound network blocked, the demo asked for ${[...new Set(outside)].join(", ")}`);
    expectTrue(!external.length, `the worlds name external asset URIs: ${external.join(", ")}`);
    const assetsFailed = await page.evaluate(() => Number(document.body.dataset.wowAssetsFailed));
    expectTrue(assetsFailed === 0, `${assetsFailed} of the airport's assets failed to load`);
    await shot(page, "m11-outbound-network-blocked-the-airport-from-local-assets");
    // No connection to a world: the demo says so at once and fails early, with no broken world.
    await ctx.lab.stopWorld("e");
    const down = await newPage(ctx, { alone: true });
    const startedAt = Date.now();
    await down.goto(ROUTE(ctx, "&active=e"), { waitUntil: "domcontentloaded", timeout: 60000 });
    await down.waitForFunction(() => ["disconnected", "unavailable"].includes(document.body.dataset.connectionState), { timeout: 20000 });
    const tookMs = Date.now() - startedAt;
    const said = await down.evaluate(() => ({ state: document.body.dataset.connectionState, text: document.body.innerText, canvas: !!document.querySelector("#scene-mount canvas") }));
    expectTrue(/no connection/i.test(said.text), `the page does not say "no connection": ${said.state}`);
    expectTrue(!said.canvas, "the page drew a world anyway");
    expectTrue(tookMs < 15000, `it took ${tookMs} ms to say so`);
    await sleep(500);
    await shot(down, "m11-no-connection-to-the-world-the-demo-says-so-at-once");
    return `the worlds name ${uris.size} model URIs, ${external.length} external; the eight models are local files; with outbound network blocked a walk into the airport asked for nothing outside; with a world's server down the page said "no connection" in ${(tookMs / 1000).toFixed(1)} s and drew no world. Case that holds: it runs from local assets.`;
  },

  async M12(ctx) {
    await ctx.lab.start();
    const page = await newPage(ctx);
    const listed = (await getJson(`${ctx.lab.front}/worlds.json`)).json.worlds.map((w) => w.key);
    expectTrue(listed.includes("e"), `/worlds.json lists ${listed}`);
    await page.goto(`${ctx.lab.front}/`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForSelector(".demo-launcher", { timeout: 30000 });
    await sleep(800);
    const launcher = await page.evaluate(() => document.querySelector(".demo-launcher").innerText);
    expectTrue(/Location E/.test(launcher), "the launcher does not name Location E");
    await shot(page, "m12-the-launcher-names-the-added-world");
    const player = await newPage(ctx, { alone: true });
    await openPlayer(player, `${ctx.lab.front}/w/e/`);
    const inside = await state(player);
    expectTrue(inside.location_id === "location-e", `the world's page opened ${inside.location_id}`);
    await sleep(1000);
    await shot(player, "m12-its-page-opens-as-a-player-in-its-own-room");
    // A portal to it from the Lobby, from the data alone, and a walk there.
    const placed = await placeByApi(ctx.lab.address("lobby"), { x: 4.4, z: 1.4, label: "Portal to Location E", destination: ctx.lab.address("e") });
    const visitor = await newPage(ctx, { alone: true });
    await openPlayer(visitor, ROUTE(ctx));
    await previewsSettled(visitor);
    const preview = await visitor.evaluate((k) => window.__assembly.portalPreviews()[k], String(placed.portal.id));
    expectTrue(preview.kind === "nodes", `its portal shows ${JSON.stringify(preview)}`);
    // Its ring takes the colour the list gives the world.
    const ringColor = await visitor.evaluate((k) => window.__assembly.viewport.identity().scene._impl.additionalPortalGroups[k].group.getObjectByName(`standing-oval-ring--${k}`).material.color.getHex(), String(placed.portal.id));
    expectTrue(ringColor === 0xc86bff, `the ring of the portal to Location E is #${ringColor.toString(16)}, not the #c86bff its list entry gives`);
    const at = placed.node.localTransform;
    const inward = placed.inward;
    await walkTo(visitor, at[12] + inward[0] * 1.8, at[14] + inward[2] * 1.8);
    await faceYaw(visitor, Math.atan2(-inward[0], -inward[2]));
    await sleep(1200);
    await shot(visitor, "m12-a-portal-to-it-from-the-lobby-shows-its-room");
    const s = await walkThrough(visitor, { from: [at[12] + inward[0] * 1.4, at[14] + inward[2] * 1.4], yaw: Math.atan2(-inward[0], -inward[2]), expect: "location-e" });
    expectTrue(s.location_id === "location-e", `the walk did not reach it: ${JSON.stringify(s)}`);
    // Its only portal is a placed one, and it appears while the visitor stands there.
    const back = await placeByApi(ctx.lab.address("e"), { x: 2.4, z: 2.4, label: "Back to the Lobby", destination: ctx.lab.address("lobby") });
    await visitor.waitForFunction((id) => window.__assembly.adapter.world.portals.some((p) => Number(p.portal_id) === id), { timeout: 20000 }, back.portal.id);
    await sleep(800);
    await shot(visitor, "m12-in-the-added-world-its-only-portal-appears");
    const at2 = back.node.localTransform;
    const inward2 = back.inward;
    const home = await walkThrough(visitor, { from: [at2[12] + inward2[0] * 1.4, at2[14] + inward2[2] * 1.4], yaw: Math.atan2(-inward2[0], -inward2[2]), expect: "location-lobby" });
    expectTrue(home.location_id === "location-lobby", `the walk back did not reach the Lobby: ${JSON.stringify(home)}`);
    return `a world added only to a temporary OSL_WORLDS list is named by the launcher, opens at /w/e/ as a Player, a portal placed through the API to it shows its room and crosses to it, and its own placed portal crosses back`;
  },

  async M13(ctx) {
    // Part 1: the setting on. A real mouse places a portal in the main demo, and every visitor gets it from the world.
    await ctx.lab.start();
    const lobby = ctx.lab.address("lobby");
    const other = await newPage(ctx);
    await openPlayer(other, ROUTE(ctx));
    const page = await newPage(ctx);
    await openPlayer(page, ROUTE(ctx, "&place=1"));
    await page.waitForFunction(() => document.body.dataset.wowPlacementReady === "1", { timeout: 30000 });
    await faceYaw(page, Math.PI);
    await sleep(800);
    const onPanel = await page.evaluate(() => window.__wowPlacement);
    expectTrue(onPanel && onPanel.on === true, `the panel is not on: ${JSON.stringify(onPanel)}`);
    await shot(page, "m13-the-placement-panel-in-the-main-demo");
    await page.select("#wow-place-destination", ctx.lab.address("a"));
    const label = await page.$("#wow-place-label");
    await label.click({ clickCount: 3 });
    await page.keyboard.type("Placed door");
    // On the floor in view, clear of the panel at the page's right.
    const spot = [1.2, 0, -0.4];
    const point = await screenPointOf(page, spot);
    await page.mouse.click(point.x, point.y);
    await page.waitForFunction(() => window.__wowPlacement.last && window.__wowPlacement.last.action === "placed", { timeout: 30000 });
    const last = await page.evaluate(() => window.__wowPlacement.last);
    const resource = (await getJson(`${lobby}wow/portal/${last.portal}`)).json;
    expectTrue(resource.placed === true && resource.label === "Placed door" && resource.destination === ctx.lab.address("a"), `the world holds ${JSON.stringify(resource)}`);
    const node = await nodePose(lobby, 1, last.node);
    expectTrue(Math.hypot(node.position[0] - spot[0], node.position[2] - spot[2]) < 0.25, `the click at ${spot} placed the node at ${node.position}`);
    await sleep(1500);
    await shot(page, "m13-a-click-on-the-floor-placed-a-portal");
    // Another visitor, already in the world, gets it from the world's data with no reload.
    await waitOrFail(other, (id) => window.__assembly.adapter.world.portals.some((p) => Number(p.portal_id) === id), { timeout: 20000 }, last.portal, "the visitor already in the world did not get the placed portal");
    const rings = await ringCenters(other);
    const ring = rings[String(last.portal)];
    expectTrue(ring && Math.hypot(ring.position[0] - node.position[0], ring.position[2] - node.position[2]) <= ONE_CM, `the other visitor's ring: ${JSON.stringify(ring)}`);
    // A new visitor too.
    const fresh = await newPage(ctx);
    await openPlayer(fresh, ROUTE(ctx));
    const freshRings = await ringCenters(fresh);
    expectTrue(freshRings[String(last.portal)], "a new visitor does not get the placed portal");
    // Each open page draws on the CPU: the new visitor has done its part, and the placing visitor's page goes back in front.
    const freshContext = fresh.browserContext();
    ctx.contexts.splice(ctx.contexts.indexOf(freshContext), 1);
    await freshContext.close();
    await page.bringToFront();
    // A mouse drag moves it, and the world's node moves.
    const from = await screenPointOf(page, [node.position[0], 1.35, node.position[2]]);
    const dropAt = await screenPointOf(page, [-1.2, 0, -0.9]);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move((from.x + dropAt.x) / 2, (from.y + dropAt.y) / 2, { steps: 8 });
    await page.mouse.move(dropAt.x, dropAt.y, { steps: 8 });
    await page.mouse.up();
    await page.waitForFunction(() => window.__wowPlacement.last && window.__wowPlacement.last.action === "moved", { timeout: 30000 }).catch(async (error) => {
      const said = await page.evaluate(() => ({ placement: window.__wowPlacement, status: document.querySelector("#wow-place-status")?.textContent, selected: document.querySelector("#wow-place-selected")?.textContent }));
      fail(`the drag from ${JSON.stringify(from)} to ${JSON.stringify(dropAt)} moved nothing: ${JSON.stringify(said)} (${error.message})`);
    });
    const movedNode = await nodePose(lobby, 1, last.node);
    expectTrue(Math.hypot(movedNode.position[0] + 1.2, movedNode.position[2] + 0.9) < 0.3, `the drag left the node at ${movedNode.position}`);
    await sleep(1000);
    await shot(page, "m13-a-drag-moved-it");
    // And it is a portal: walk through it.
    const inward = movedNode.forward;
    await page.evaluate(() => document.querySelector("#wow-place-toggle")?.click());
    await sleep(300);
    await walkThrough(page, { from: [movedNode.position[0] + inward[0] * 1.4, movedNode.position[2] + inward[2] * 1.4], yaw: Math.atan2(-inward[0], -inward[2]), expect: "location-a", timeoutMs: 45000 });
    const s = await state(page);
    expectTrue(s.location_id === "location-a", `walking through the placed portal did not cross (timed out after 45 s): ${JSON.stringify(s)}`);
    const declared = (await getJson(`${ctx.lab.address("a")}wow/world`)).json.preview;
    const previewNode = await nodePose(ctx.lab.address("a"), 1, Number(/node\/(\d+)$/.exec(declared.node)[1]));
    expectTrue(distance(s.position, previewNode.position) <= ONE_CM, `with no #join it arrived ${distance(s.position, previewNode.position).toFixed(3)} m from the place the destination's preview names`);
    await sleep(800);
    await shot(page, "m13-through-the-placed-portal");
    // A portal moved through the world's data reaches the visitor already there, with no reload.
    // That visitor's page comes to the front: a browser draws only the page in front, and does not hurry the timers of the others.
    await other.bringToFront();
    const moveTo = [2.6, 2.2];
    const nodeNow = (await getJson(`${lobby}wow/spatial/1/node/${last.node}?nodeForm=flat`)).json;
    const movedTransform = nodeNow.localTransform.slice();
    movedTransform[12] = moveTo[0];
    movedTransform[14] = moveTo[1];
    const moveAnswer = await fetch(`${lobby}wow/spatial/1/node/${last.node}`, { method: "PUT", headers: { "Content-Type": "application/json", Accept: "application/wow+json" }, body: JSON.stringify({ ...nodeNow, localTransform: movedTransform }) });
    expectTrue(moveAnswer.ok, `moving the portal's node answered ${moveAnswer.status}`);
    await waitOrFail(other, ([key, x, z]) => {
      const portal = window.__assembly.adapter.world.portals.find((p) => String(p.portal_id) === key);
      return portal && Math.hypot(portal.frame.position[0] - x, portal.frame.position[2] - z) <= 0.01;
      // A browser slows a page's timers while it is behind another, for up to a minute: this page's next look may wait that long.
    }, { timeout: 90000, polling: 250 }, [String(last.portal), moveTo[0], moveTo[1]], "the visitor already in the world did not see the moved portal");
    // The ring follows the data; it is drawn again just after the portals are read again.
    await waitOrFail(other, ([key, x, z]) => {
      const world = window.__assembly.adapter.world;
      const index = world.portals.findIndex((p) => String(p.portal_id) === key);
      const impl = window.__assembly.viewport.identity().scene._impl;
      const group = index === 0 ? impl.directionalPortalGroup : impl.additionalPortalGroups?.[key]?.group;
      return group && Math.hypot(group.position.x - x, group.position.z - z) <= 0.01;
    }, { timeout: 20000, polling: 250 }, [String(last.portal), moveTo[0], moveTo[1]], "the portal's data moved but its ring did not");
    // That new place has the visitor on its other side and in line with its opening: a portal moving is no walk through it.
    const stayed = await state(other);
    expectTrue(stayed.location_id === "location-lobby", `the portal moved past the visitor and carried them to ${stayed.location_id}`);
    // So does a new destination, with what the portal shows.
    const newDestination = ctx.lab.address("b");
    const destinationAnswer = await fetch(`${lobby}wow/portal/${last.portal}`, { method: "PUT", headers: { "Content-Type": "application/json", Accept: "application/wow+json" }, body: JSON.stringify({ destination: newDestination }) });
    expectTrue(destinationAnswer.ok, `changing the portal's destination answered ${destinationAnswer.status}`);
    await waitOrFail(other, ([key, url]) => {
      const portal = window.__assembly.adapter.world.portals.find((p) => String(p.portal_id) === key);
      const preview = window.__assembly.portalPreviews()[key];
      return portal && portal.destination === url && preview && preview.destination === url && preview.kind === "nodes";
    }, { timeout: 45000, polling: 250 }, [String(last.portal), newDestination], "the visitor already in the world did not see the new destination").catch(async (error) => {
      const seen = await other.evaluate((key) => ({ destination: window.__assembly.adapter.world.portals.find((p) => String(p.portal_id) === key)?.destination, preview: window.__assembly.portalPreviews()[key] }), String(last.portal));
      fail(`${error.message}: ${JSON.stringify(seen).slice(0, 400)}`);
    });
    for (const context of ctx.contexts.splice(0)) await context.close();
    await ctx.lab.stop();

    // Part 2: the setting off (no OSL_PLACEMENT_WRITES): the same URL offers no panel, says why, and the world refuses.
    const off = createLab({ dir: join(ctx.dir, "off"), first: ctx.first, code: ctx.lab.code, env: { OSL_PLACEMENT_WRITES: "" } });
    ctx.cleanups.push(() => off.stop());
    off.start();
    const refused = await newPage(ctx);
    await openPlayer(refused, `${off.front}/index.html?role=player&intro=bypass&place=1`);
    // Either outcome ends the wait: a panel offered with the setting off is the defect, and the next line names it.
    await waitOrFail(refused, () => ["unavailable", "1"].includes(document.body.dataset.wowPlacementReady), { timeout: 30000 }, undefined, "the page never said whether placement is available");
    const panel = await refused.$("#wow-place-toggle");
    expectTrue(!panel, "the placement panel is offered with the setting off");
    const summary = await refused.evaluate(() => window.__wowPlacement);
    expectTrue(summary.offered === false && /OSL_PLACEMENT_WRITES/.test(summary.reason), `the reason: ${JSON.stringify(summary)}`);
    const lobbyOff = off.address("lobby");
    const write = await fetch(`${lobbyOff}wow/portal`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ node: "wow/spatial/1/node/1", label: "No" }) });
    expectTrue(write.status === 403, `a portal write answered ${write.status} with the setting off`);
    await shot(refused, "m13-with-the-setting-off-the-same-link-offers-no-panel-and-says-why");
    return `with the setting on: a mouse click placed a portal in the main demo, a drag moved it, a visitor already there and a new one got it from the world's data, it crossed, and the visitor still there saw it move and lead elsewhere through the world's data alone; with the setting off: no panel, the reason shown, POST answered 403`;
  },

  async M14(ctx) {
    await ctx.lab.start();
    const askedWith = (url, host) => new Promise((done, failed) => {
      const u = new URL(url);
      const r = httpRequest({ hostname: "127.0.0.1", port: u.port, path: u.pathname, headers: { Host: host, Accept: "application/wow+json, application/json;q=0.9", Connection: "close" } }, (answer) => {
        let body = "";
        answer.on("data", (chunk) => { body += chunk; });
        answer.on("end", () => done(JSON.parse(body)));
      });
      r.on("error", failed);
      r.end();
    });
    const far = `far-lab.example:${ctx.first}`;
    const listed = await askedWith(`${ctx.lab.front}/worlds.json`, far);
    const wrong = listed.worlds.filter((world) => new URL(world.address).hostname !== "far-lab.example" || Number(new URL(world.address).port) !== ctx.lab.port(world.key));
    expectTrue(!wrong.length, `asked from far-lab.example, /worlds.json says ${wrong.map((world) => world.address).join(", ")}`);
    const throughFront = await askedWith(`${ctx.lab.front}/api/lobby/wow/portal/1`, far);
    expectTrue(new URL(throughFront.destination).hostname === "far-lab.example", `a portal read through the frontend says ${throughFront.destination}`);
    const direct = await askedWith(`${ctx.lab.address("lobby")}wow/portal/1`, `far-lab.example:${ctx.lab.port("lobby")}`);
    expectTrue(new URL(direct.destination).hostname === "far-lab.example", `a portal read from the world says ${direct.destination}`);
    // A browser that reaches the lab by another name, and cannot reach 127.0.0.1 at all.
    const page = await newPage(ctx);
    const blocked = new Set();
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      const u = new URL(request.url());
      if (u.hostname === "127.0.0.1") { blocked.add(`${u.port}${u.pathname}`); void request.abort("addressunreachable"); } else void request.continue();
    });
    await openPlayer(page, `${ctx.lab.front.replace("127.0.0.1", "localhost")}/index.html?role=player&intro=bypass`);
    await previewsSettled(page);
    const kinds = await page.evaluate(() => Object.fromEntries(Object.entries(window.__assembly.portalPreviews()).map(([k, v]) => [k, v.kind])));
    expectTrue(Object.values(kinds).length === 3 && Object.values(kinds).every((kind) => kind === "nodes"), `from another name, the portals show ${JSON.stringify(kinds)} (asked 127.0.0.1 for ${[...blocked].slice(0, 5).join(", ")})`);
    await faceYaw(page, Math.PI);
    await sleep(1200);
    await shot(page, "m14-a-browser-on-another-machine-sees-the-portals-online");
    const toA = (await worldPortals(ctx.lab.address("lobby"))).find((p) => p.resource.label === "Portal to Location A");
    const s = await walkThrough(page, { from: [toA.pose.position[0] + toA.pose.forward[0] * 1.4, toA.pose.position[2] + toA.pose.forward[2] * 1.4], yaw: Math.atan2(-toA.pose.forward[0], -toA.pose.forward[2]), expect: "location-a" });
    expectTrue(s.location_id === "location-a", `from another name, the walk did not cross: ${JSON.stringify(s)}, refusals ${JSON.stringify(await page.evaluate(() => window.__assembly.portalRefusals()))}`);
    expectTrue(!blocked.size, `from another name, the page still asked 127.0.0.1 for ${[...blocked].slice(0, 5).join(", ")}`);
    for (const context of ctx.contexts.splice(0)) await context.close();
    await ctx.lab.stop();
    await sleep(500);
    // Bound to 127.0.0.1, and on a public origin, the request's host changes nothing.
    for (const [what, env] of [["a lab on 127.0.0.1", { OSL_BIND_HOST: "" }], ["a lab with a public origin", { OSL_PUBLIC_ORIGIN: "https://public.example" }]]) {
      const other = createLab({ dir: join(ctx.dir, what.replace(/\W+/g, "-")), first: ctx.first, code: ctx.lab.code, env });
      ctx.cleanups.push(() => other.stop());
      other.start();
      const said = await askedWith(`${other.front}/worlds.json`, far);
      expectTrue(said.worlds.every((world) => !/far-lab/.test(world.address)), `${what} follows the request's host: ${said.worlds[0].address}`);
      await other.stop();
      await sleep(500);
    }
    return `asked from another host, /worlds.json and a portal (read through the frontend and from the world) name that host; a browser that cannot reach 127.0.0.1 shows ${Object.keys(kinds).length} previews and crosses; on 127.0.0.1 or a public origin nothing changes`;
  },

  async M15(ctx) {
    await ctx.lab.start();
    const measured = [];
    for (const [width, height] of [[320, 568], [360, 640], [390, 844]]) {
      const page = await newPage(ctx, { alone: true });
      await page.setViewport({ width, height, isMobile: true, hasTouch: true });
      await openPlayer(page, ROUTE(ctx));
      await page.evaluate(() => document.querySelector("#btn-rail-toggle").click());
      await sleep(900);
      const m = await page.evaluate(() => {
        const footer = document.querySelector("footer.controls").getBoundingClientRect();
        const rail = document.querySelector("aside.rail").getBoundingClientRect();
        return { footerTop: footer.top, footerHeight: footer.height, railBottom: rail.bottom, railHeight: rail.height, measured: getComputedStyle(document.documentElement).getPropertyValue("--osl-footer-measured").trim(), open: !document.querySelector("#app").classList.contains("rail-collapsed") };
      });
      expectTrue(m.open && m.railHeight > 100, `the panel did not open at ${width}x${height}: ${JSON.stringify(m)}`);
      const overlap = Math.round(m.railBottom - m.footerTop);
      expectTrue(overlap <= 0, `the open panel overlaps the footer by ${overlap} px at ${width}x${height}: ${JSON.stringify(m)}`);
      measured.push(`${width}x${height}: footer ${Math.round(m.footerHeight)} px, panel stops ${-overlap} px above it`);
      await shot(page, `m15-the-open-panel-at-${width}x${height}`);
    }
    return measured.join("; ");
  },
};

// ---- the planted faults -----------------------------------------------------------------------------------------

// `expect` is the fault's named reason. A catch for any other reason (a start that broke, a request that failed) proves
// nothing about the check: it is a harness error, and the proof exits non-zero, as for a stale fault.
const FAULTS = [
  { check: "M1", name: "a ring placed from the demo's own trigger, not the node", expect: /is drawn [\d.]+ m from its node/, edits: [{ file: "web/live-adapter-world-projection.mjs", find: `const triggerPosition = placement
    ? [placement.position[0], 0, placement.position[2]]
    : clonePosition(trigger.position, [2.8, 0, -2.8]);`, replace: "const triggerPosition = clonePosition(trigger.position, [2.8, 0, -2.8]);" }] },
  { check: "M1", name: "a copy of a portal back in the browser's code", expect: /the browser's code names built-in portals: airport-lobby-transition\.mjs/, edits: [{ file: "web/airport-lobby-transition.mjs", find: `export const CLIENT_SCENE_LOAD_TRANSITION = "client_scene_load";`, replace: `export const CLIENT_SCENE_LOAD_TRANSITION = "client_scene_load";\nexport const SKYPORT_PORTAL_COPY = { portal_id: "lobby-portal-c" };` }] },
  { check: "M2", name: "a crossing that lands by the walker's offset, not at the node", expect: /arrived [\d.]+ m from node \d+/, edits: [{ file: "web/live-adapter-portal-traversal-controller.mjs", find: "          arrival: gate.arrival,\n", replace: "          arrival: null,\n" }] },
  { check: "M1", name: "a portal in a world file in web/worlds", expect: /the browser's code names built-in portals: denver-skyport\.json/, edits: [{ file: "web/worlds/denver-skyport.json", find: `"spatialID"`, replace: `"portal_copy": "lobby-portal-a", "spatialID"` }] },
  { check: "M2", name: "a page opened at #join that ignores it", expect: /plain navigation: in \S+, [\d.]+ m from the node/, edits: [{ file: "web/main-demo-wiring.mjs", find: "const arrival = await getAdapter().applyJoinArrival(Number(joinNode[1]));", replace: `const arrival = { arrived: false, reason: "planted" };` }] },
  { check: "M2", name: "an arrival toast that claims presence", expect: /the arrival toast claims presence/, edits: [{ file: "web/app.js", find: `"live crossing", "same page, no reload"`, replace: `"live crossing", "presence continues", "same page, no reload"` }] },
  { check: "M3", name: "a crossing toast that only knows two worlds", expect: /the crossing toast named .* on the walk to the airport/, edits: [{ file: "web/portal-loading.mjs", find: "    return listed ? listed.key : null;", replace: "    return listed && /^[ab]$/.test(listed.key) ? listed.key : \"a\";" }] },
  { check: "M3", name: "a return that names the wrong counterpart's arrival", expect: /the return landed [\d.]+ m from the center portal's arrival/, edits: [{ file: "runtime/world-server/src/portal-standard.js", find: "return destination ? destination.portalArrivalNodeId(portal.target_portal_id) : null;", replace: "return destination ? destination.portalArrivalNodeId(destination.getState().portals[0].portal_id) : null;" }] },
  { check: "M4", name: "a preview URL that returns every node", expect: /the far node is in A's preview/, edits: [{ file: "runtime/world-server/src/portal-standard.js", find: "                if (distance > d.radius_m) continue;\n", replace: "" }] },
  { check: "M4", name: "a preview that also reads another node of the destination", expect: /was also asked for GET \/wow\/spatial\/1\/node\/0/, edits: [{ file: "web/main-demo-portals.mjs", find: "  const destination = destinationOf(resource.destination, io.worlds);\n  const preview = await previewOf(", replace: "  const destination = destinationOf(resource.destination, io.worlds);\n  if (destination) await fetch(new URL(\"wow/spatial/1/node/0\", destination.base).href).catch(() => {});\n  const preview = await previewOf(" }] },
  { check: "M4", name: "a preview fed by the full authored graph", expect: /was also asked for GET \/wow\/graph/, edits: [{ file: "web/main-demo-portals.mjs", find: "  const destination = destinationOf(resource.destination, io.worlds);\n  const preview = await previewOf(", replace: "  const destination = destinationOf(resource.destination, io.worlds);\n  if (destination) await fetch(new URL(\"wow/graph\", destination.base).href).catch(() => {});\n  const preview = await previewOf(" }] },
  { check: "M4", name: "a window that reads the prefetch machine", expect: /the prefetch fed A's preview/, edits: [{ file: "web/portal-spatial-preview.mjs", find: "const machine = standard ? STANDARD_PORTAL_MACHINE : machineInput;", replace: "const machine = standard && !machineInput?.presence?.occupancy?.avatars?.length ? STANDARD_PORTAL_MACHINE : machineInput;" }] },
  { check: "M5", name: "portals inside a preview left open", expect: /closed portals inside the Lobby's preview/, edits: [{ file: "web/wow-portal.mjs", find: "closed: closedIds.has(Number(n.id)),", replace: "closed: false," }] },
  { check: "M6", name: "a preview that registers a user in the destination", expect: /previewing changed a destination's users/, edits: [{ file: "web/main-demo-portals.mjs", find: "  const destination = destinationOf(resource.destination, io.worlds);\n  const preview = await previewOf(", replace: "  const destination = destinationOf(resource.destination, io.worlds);\n  if (destination && destination.world) await fetch(`/api/${destination.world.key}/fabric/presence/register`, { method: \"POST\", headers: { \"Content-Type\": \"application/json\" }, body: JSON.stringify({ player_id: \"previewer\", avatar_id: \"x\", display_name: \"x\", position: [0, 0, 0] }) }).catch(() => {});\n  const preview = await previewOf(" }] },
  { check: "M6", name: "a prefetch that registers a user in the destination", expect: /inside the perimeter, the prefetch changed a destination's users/, edits: [{ file: "web/live-adapter-fabric-prefetch-controller.mjs", find: "    const proxyBase = this._resolveProxyBase(machine.address);\n", replace: "    const proxyBase = this._resolveProxyBase(machine.address);\n    await fetch(`${proxyBase}/fabric/presence/register`, { method: \"POST\", headers: { \"Content-Type\": \"application/json\" }, body: JSON.stringify({ player_id: \"prefetcher\", avatar_id: \"x\", display_name: \"x\", position: [0, 0, 0], requested_ttl_ms: 60000 }) }).catch(() => {});\n" }] },
  { check: "M7", name: "no check before leaving", expect: /no refusal was recorded|the visitor left/, edits: [{ file: "web/live-adapter-portal-traversal-controller.mjs", find: "      if (!gate.ok) {\n", replace: "      if (!gate.ok && gate.kind !== \"offline\") {\n" }] },
  { check: "M7", name: "a refusal that shows no reason", expect: /the notification shows/, edits: [{ file: "web/main-demo-wiring.mjs", find: `showToast("Crossing refused", sentence, "failed", { notificationId });`, replace: "" }] },
  { check: "M8", name: "a portal with no destination that says nothing", expect: /refusals: \[\]/, edits: [{ file: "web/live-adapter-portal-traversal-controller.mjs", find: "if (ev.crossedPlane && ev.sourceReady && !ev.targetReady && onCrossingRefused) {", replace: "if (false) {" }] },
  { check: "M9", name: "the start pose inside the clearance", expect: /is within [\d.]+ m of a perimeter/, edits: [{ file: "runtime/world-server/src/portal-standard.js", find: "const START_CLEARANCE_M = 0.45 + 0.25;", replace: "const START_CLEARANCE_M = -100;" }] },
  { check: "M9", name: "a destination read at boot", expect: /at the first view, a destination was loading/, edits: [{ file: "web/live-adapter.js", find: "    this.state.portal_previews = {};\n    for (const portal of portals) {", replace: "    this.state.portal_previews = {};\n    for (const portal of portals) {\n      const k = endpointKeyForLocation(portal.target_location_id);\n      if (k) await this._transport.getJson(`${ENDPOINTS[k].proxy_base}/debug/state`).catch(() => null);" }] },
  { check: "M10", name: "held keys not latched at the crossing", expect: /with the keys still held the avatar moved/, edits: [{ file: "web/movement-camera-controller.mjs", find: `if (control !== "jump" && controlState[control]) crossingSuppressedKeyCodes.add(code);`, replace: "void code; void control;" }] },
  { check: "M11", name: "a model at an outside address", expect: /with outbound network blocked, the demo asked for https:\/\/assets\.invalid/, edits: [{ file: "web/worlds/denver-skyport.json", find: `"spatialAssetURI": "/assets/avatars/glb/readyplayerme_cyberpunk.glb"`, replace: `"spatialAssetURI": "https://assets.invalid/readyplayerme_cyberpunk.glb"` }] },
  { check: "M11", name: "a failed start that does not say no connection", expect: /does not say \"no connection\"/, edits: [{ file: "web/app.js", find: `? "No connection. The local world services are not responding. Start them, then reload and retry this view."`, replace: `? "Something went wrong."` }] },
  { check: "M12", name: "a browser that keeps only the built-in worlds", expect: /the launcher does not name Location E/, edits: [{ file: "web/worlds-list.mjs", find: "Object.freeze(list.worlds.map((world) =>", replace: "Object.freeze(list.worlds.filter((world) => world.built_in).map((world) =>" }] },
  { check: "M12", name: "a ring colour that ignores the list", expect: /the ring of the portal to Location E is/, edits: [{ file: "web/worlds-list.mjs", find: "return ring ? { color: hexNumber(ring.color), fill: hexNumber(ring.fill) } : DEFAULT_RING;", replace: "return DEFAULT_RING;" }] },
  { check: "M13", name: "a panel offered whatever the world says", expect: /the placement panel is offered with the setting off/, edits: [{ file: "web/main-demo-placement.mjs", find: "  if (!policy.allowed) {", replace: "  if (false) {" }] },
  { check: "M13", name: "writes not refused without the setting", expect: /a portal write answered 2\d\d with the setting off/, edits: [{ file: "runtime/world-server/src/server.js", find: "if (localOnly.isPlacementWrite(req.method, path))", replace: "if (false)" }] },
  { check: "M13", name: "a placed portal that reaches no other visitor", expect: /the visitor already in the world did not get the placed portal/, edits: [{ file: "web/live-adapter.js", find: "return portalSignature(await this._fetchWowPortals(ep, wowWorld)) !== this._lastPortalSignature;", replace: "return false;" }] },
  { check: "M13", name: "a watch that compares only the portal count", expect: /the visitor already in the world did not see the moved portal/, edits: [{ file: "web/live-adapter.js", find: "return portalSignature(await this._fetchWowPortals(ep, wowWorld)) !== this._lastPortalSignature;", replace: "return wowWorld.portals.portal_count !== this.world.portals.length;" }] },
  { check: "M13", name: "a watch that does not compare destinations", expect: /the visitor already in the world did not see the new destination/, edits: [{ file: "web/main-demo-portals.mjs", find: "return [resource.id, resource.destination || null, resource.label || null,", replace: "return [resource.id, null, resource.label || null," }] },
  { check: "M13", name: "a moved portal that counts as a walk through it", expect: /the portal moved past the visitor and carried them|the visitor already in the world did not see the moved portal/, edits: [{ file: "web/live-adapter.js", find: "    this._portalTraversalController.forgetPortalSides();\n", replace: "" }] },
  { check: "M14", name: "a list of worlds that always says 127.0.0.1", expect: /asked from far-lab\.example, \/worlds\.json says/, edits: [{ file: "src/serve.js", find: "address: asSeenFrom(request, backendPorts[world.key] === world.port ? world.address : withPort(world.address, backendPorts[world.key])),", replace: "address: backendPorts[world.key] === world.port ? world.address : withPort(world.address, backendPorts[world.key])," }] },
  { check: "M14", name: "a world's resources that always say 127.0.0.1", expect: /a portal read through the frontend says/, edits: [{ file: "runtime/world-server/src/server.js", find: "const body = asSeenFrom(req, JSON.stringify(obj, null, 2));", replace: "const body = JSON.stringify(obj, null, 2);" }] },
  { check: "M14", name: "a frontend that does not pass the browser's host on", expect: /a portal read through the frontend says/, edits: [{ file: "src/serve.js", find: ", 'x-forwarded-host': request.headers.host }", replace: " }" }] },
  { check: "M14", name: "a lab on 127.0.0.1 that follows the request's host", expect: /a lab on 127\.0\.0\.1 follows the request's host/, edits: [{ file: "runtime/world-server/src/request-address.js", find: "if (String(env.OSL_PUBLIC_ORIGIN || '').trim() || bindHost(env) === LOOPBACK) return null;", replace: "if (String(env.OSL_PUBLIC_ORIGIN || '').trim()) return null;" }] },
  { check: "M15", name: "a panel that assumes the fixed footer height", expect: /the open panel overlaps the footer by \d+ px at 320x568/, edits: [{ file: "web/index.html", find: "--osl-footer-height: max(var(--osl-shell-footer-height), var(--osl-footer-measured, 0px));", replace: "--osl-footer-height: var(--osl-shell-footer-height);" }] },
];

// What each check's lab needs.
const LAB_SETUP = {
  M7: { extra: (first) => [{ key: "e", name: "Location E", port: first + 5, address: `http://127.0.0.1:${first + 5}/`, anchor: { lat: 47.7009, lon: -122.3, h: 11.5 }, room: "#c86bff", preview_radius_m: 10 }] },
  M11: { extra: (first) => [{ key: "e", name: "Location E", port: first + 5, address: `http://127.0.0.1:${first + 5}/`, anchor: { lat: 47.7009, lon: -122.3, h: 11.5 }, room: "#c86bff", preview_radius_m: 10 }] },
  M12: { extra: (first) => [{ key: "e", name: "Location E", port: first + 5, address: `http://127.0.0.1:${first + 5}/`, anchor: { lat: 47.7009, lon: -122.3, h: 11.5 }, room: "#c86bff", preview_radius_m: 10, portal_ring: { color: "#c86bff", fill: "#a04bd0" } }] },
  M14: { env: { OSL_BIND_HOST: "0.0.0.0" } },
};

async function runOnce(browser, id, { code, dir }) {
  const setup = LAB_SETUP[id] || {};
  const lab = createLab({ dir, first: FIRST_PORT, code, extra: setup.extra ? setup.extra(FIRST_PORT) : [], env: { OSL_PLACEMENT_WRITES: "1", ...(setup.env || {}) } });
  const ctx = { lab, browser, contexts: [], cleanups: [], pageErrors: [], dir, first: FIRST_PORT };
  try {
    const detail = await CHECKS[id](ctx);
    return { ok: true, detail, pageErrors: ctx.pageErrors };
  } catch (error) {
    if (error instanceof HarnessError) throw error;
    const cause = error && error.cause ? ` (${error.cause.code || error.cause.message || error.cause})` : "";
    return { ok: false, detail: `${String(error && error.message ? error.message : error)}${cause}`, pageErrors: ctx.pageErrors };
  } finally {
    for (const context of ctx.contexts) await context.close().catch(() => {});
    for (const cleanup of ctx.cleanups) await cleanup();
    await lab.stop();
    // lab.stop() and the next lab.start() block the event loop, so Node's fetch would never see that this lab's
    // keep-alive sockets closed, and would reuse a dead one on the same port in the next run ("fetch failed").
    await sleep(500);
  }
}

async function main() {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(SCREENS, { recursive: true });
  const ids = Object.keys(CHECKS).filter((id) => !only || only.includes(id));
  const results = [];
  let browser = await launchBrowser();
  let failed = 0;
  let wrongReason = 0;
  try {
    if (!onlyFaults) {
      realRun = true;
      for (const id of ids) {
        const started = Date.now();
        let result = await runOnce(browser, id, { code: CODE, dir: join(OUT, "labs", id) });
        // A failure that load might cause gets one re-run before it counts.
        if (!result.ok && /timeout|Timed out|exceeded/i.test(result.detail)) {
          console.log(`     ${id} timed out (${result.detail.slice(0, 120)}): one re-run`);
          await browser.close();
          browser = await launchBrowser();
          result = await runOnce(browser, id, { code: CODE, dir: join(OUT, "labs", id) });
        }
        results.push({ id, kind: "check", ...result, seconds: Math.round((Date.now() - started) / 1000) });
        if (!result.ok) failed += 1;
        console.log(`${result.ok ? "PASS" : "FAIL"}  ${id}  ${result.detail}  (${Math.round((Date.now() - started) / 1000)} s)`);
        if (result.pageErrors && result.pageErrors.length) console.log(`     page errors in ${id}: ${[...new Set(result.pageErrors)].slice(0, 3).join(" | ")}`);
      }
      realRun = false;
    }
    if (withFaults) {
      let index = 0;
      for (const fault of FAULTS) {
        index += 1;
        if (only && !only.includes(fault.check)) continue;
        const started = Date.now();
        const dir = join(OUT, "faults", `${index}-${fault.check}`);
        const code = plantFaults({ dir, edits: fault.edits });
        let result = await runOnce(browser, fault.check, { code, dir });
        // A catch for another reason that load might cause gets one re-run before it counts.
        if (!result.ok && !fault.expect.test(result.detail) && /timeout|Timed out|exceeded/i.test(result.detail)) {
          console.log(`     ${fault.check} planted fault timed out (${result.detail.slice(0, 120)}): one re-run`);
          await browser.close();
          browser = await launchBrowser();
          result = await runOnce(browser, fault.check, { code, dir });
        }
        const caught = !result.ok;
        const forItsReason = caught && fault.expect.test(result.detail);
        results.push({ id: fault.check, kind: "fault", name: fault.name, caught, forItsReason, detail: result.detail, seconds: Math.round((Date.now() - started) / 1000) });
        if (!caught) failed += 1;
        if (caught && !forItsReason) wrongReason += 1;
        const verdict = forItsReason ? "CAUGHT" : caught ? "HARNESS ERROR, WRONG REASON" : "MISSED";
        console.log(`${verdict}  ${fault.check}  planted: ${fault.name}${caught ? `  -> ${result.detail.slice(0, 200)}` : ""}  (${Math.round((Date.now() - started) / 1000)} s)`);
        rmSync(join(dir, "code"), { recursive: true, force: true });
      }
    }
  } finally {
    await browser.close();
  }
  const checks = results.filter((r) => r.kind === "check");
  const faults = results.filter((r) => r.kind === "fault");
  writeFileSync(join(OUT, "results.json"), `${JSON.stringify({ at: new Date().toISOString(), results }, null, 2)}\n`);
  console.log(`\n${checks.filter((r) => r.ok).length}/${checks.length} checks pass; ${faults.filter((r) => r.forItsReason).length}/${faults.length} planted faults caught for their named reason; ${wrongReason} caught for another reason (harness errors); results in ${join(OUT, "results.json")}`);
  process.exit(wrongReason ? 2 : failed ? 1 : 0);
}

main().catch((error) => {
  console.error(error instanceof HarnessError ? `HARNESS ERROR: ${error.message}` : error);
  process.exit(2);
});
