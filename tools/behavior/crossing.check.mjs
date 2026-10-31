// What a crossing does in the main demo, seen from the worlds' own routes and from the page, as a Player with real keys.
//   node tools/behavior/crossing.check.mjs [--faults] [--only id,id]
import { arrivalOf, distance, placeByApi, worldPortals } from "../arch-i4/main-demo/world-data.mjs";
import { angleBetween, expect, fixed, holdKeys, inRange, pageFacts, planar, recordRequests, runBehavior, sleep, waitUntil, walkTo, faceYaw, worldRecord } from "./kit.mjs";
import { AT_THE_NODE_M, FACING_RAD, lobbyUrl, portalNamed, walkInto, yawOf } from "./crossing-walk.mjs";

const CAMERA_DISTANCE_M = [1.5, 8];
const COUNTERPART_M = 2.2;
const SETTLE_MS = 4000;
const WALK_AWAY_M = [1.0, 1.7]; // over 0.6 s of the movement loop's time, at 2.35 m/s

/** Every location the page shows, in order, until stop() is called. */
function watchLocations(page) {
  const seen = [];
  let on = true;
  const running = (async () => {
    while (on) {
      const { location } = await pageFacts(page).catch(() => ({ location: seen.at(-1) }));
      if (location && location !== seen.at(-1)) seen.push(location);
      await sleep(120);
    }
  })();
  return { seen, stop: async () => { on = false; await running; return seen; } };
}

/**
 * Reads both worlds, from this process, for the length of a crossing: a page read can take seconds on a loaded machine,
 * and a player the source failed to release expires there 10 s after its last heartbeat. The destination is read first,
 * so a source that holds the player afterward held it at the same time.
 */
function watchHolders(lab, playerId, source, destination) {
  const holds = (record) => record.avatars.some((avatar) => avatar.player_id === playerId);
  const seen = { destinationHeld: false, bothHeld: false };
  let on = true;
  const running = (async () => {
    while (on) {
      if (holds(await worldRecord(lab, destination))) {
        seen.destinationHeld = true;
        if (holds(await worldRecord(lab, source))) seen.bothHeld = true;
      }
      await sleep(50);
    }
  })();
  return { seen, holds, stop: async () => { on = false; await running; return seen; } };
}

/** The one walk most statements read: from the Lobby into Location A, with what each world and the page said. */
const tripToA = (ctx) => ctx.once("trip", async () => {
  const { lab } = ctx;
  const page = await ctx.visit(lobbyUrl(lab));
  const requests = await recordRequests(page, { worlds: lab.doc.worlds, front: lab.front });
  const lobbyPortals = await worldPortals(lab.address("lobby"));
  const portal = portalNamed(lobbyPortals, "Portal to Location A");
  const arrival = await arrivalOf(portal.resource.destination);
  const start = await pageFacts(page, { with: ["objects"] });
  const before = { lobby: await worldRecord(lab, "lobby"), a: await worldRecord(lab, "a") };
  await walkTo(page, portal.pose.position[0], portal.pose.position[2] + 1.4);
  const mark = requests.mark();
  const watch = watchLocations(page);
  const holders = watchHolders(lab, start.playerId, "lobby", "a");
  await walkInto(page, portal, "location-a");
  const arrived = await pageFacts(page);
  await sleep(SETTLE_MS);
  const settled = await pageFacts(page, { with: ["objects"] });
  const locations = await watch.stop();
  const { destinationHeld, bothHeld } = await holders.stop();
  const after = { lobby: await worldRecord(lab, "lobby"), a: await worldRecord(lab, "a") };
  return { page, requests, mark, portal, arrival, start, before, arrived, settled, locations, after, destinationHeld, bothHeld, holds: holders.holds };
});

/** After tripToA: back through Location A's portal to the Lobby. */
const tripBack = (ctx) => ctx.once("back", async () => {
  const trip = await tripToA(ctx);
  const back = portalNamed(await worldPortals(ctx.lab.address("a")), "Portal to Lobby");
  const arrival = await arrivalOf(back.resource.destination);
  await walkInto(trip.page, back, "location-lobby");
  const landed = await pageFacts(trip.page);
  await sleep(1000);
  return { trip, back, arrival, landed };
});

/** A portal in the Lobby that refuses: walk in with W held until the page records why. */
async function refusedAt(ctx, placed) {
  const page = await ctx.visit(lobbyUrl(ctx.lab));
  const at = placed.node.localTransform;
  const from = [at[12] + placed.inward[0] * 1.4, at[14] + placed.inward[2] * 1.4];
  await walkTo(page, from[0], from[1]);
  await faceYaw(page, Math.atan2(-placed.inward[0], -placed.inward[2]));
  await sleep(500);
  const walked = await pageFacts(page);
  await page.keyboard.down("w");
  await waitUntil(async () => {
    const facts = await pageFacts(page);
    return facts.refusals.length > 0 || facts.location !== "location-lobby" || facts.toasts.length > 3 || planar(facts.position, walked.position) > 2.5;
  }, "the walk into the portal ended in nothing", { limitMs: 45000 });
  await page.keyboard.up("w");
  await sleep(600);
  const after = await pageFacts(page);
  // With the keys free, the walker can walk away: S, 0.6 s of the movement loop's time.
  const away = await holdKeys(page, ["s"], 0.6);
  return { after, away };
}

function expectStayedAndWalks({ after, away }, reason) {
  expect(after.location === "location-lobby", `the visitor left the Lobby: in ${after.location}`);
  const heard = after.toasts.find((text) => reason.test(text));
  expect(heard, `no reason shown: toasts ${JSON.stringify(after.toasts)}, refusals ${JSON.stringify(after.refusals)}`);
  expect(inRange(away.distance, WALK_AWAY_M), `could not walk afterward: S moved ${fixed(away.distance)} m, not ${WALK_AWAY_M.join(" to ")} m`);
  return `stayed, "${heard}", then walked ${fixed(away.distance)} m away`;
}

const statements = [
  { id: "offline-portal-refuses", says: "At a portal to an offline world the walker stays, sees a reason and can still walk",
    lab: (first) => ({ separate: "e", env: { OSL_PLACEMENT_WRITES: "1" }, extra: [{ key: "e", name: "Location E", port: first + 5, address: `http://127.0.0.1:${first + 5}/`, anchor: { lat: 47.7009, lon: -122.3, h: 11.5 }, room: "#c86bff", preview_radius_m: 10 }] }),
    async run(ctx) {
      const placed = await placeByApi(ctx.lab.address("lobby"), { x: 4.4, z: 1.4, label: "Portal to Location E", destination: ctx.lab.address("e") });
      await ctx.lab.stopWorld("e");
      return expectStayedAndWalks(await refusedAt(ctx, placed), /offline/i);
    } },
  { id: "no-destination-refuses", says: "At a portal with no destination the walker stays, sees a reason and can still walk",
    lab: () => ({ env: { OSL_PLACEMENT_WRITES: "1" } }),
    async run(ctx) {
      const placed = await placeByApi(ctx.lab.address("lobby"), { x: -4.4, z: 1.4, label: "Unfinished portal" });
      return expectStayedAndWalks(await refusedAt(ctx, placed), /no destination/i);
    } },
  { id: "crosses-once", says: "Walking into the Lobby's portal to A takes the walker to A once", async run(ctx) {
    const { locations, before, after, settled } = await tripToA(ctx);
    expect(locations.join(">") === "location-lobby>location-a", `the location went ${locations.join(" > ")}`);
    expect(after.a.arrivals - before.a.arrivals === 1, `Location A counted ${after.a.arrivals - before.a.arrivals} arrivals`);
    expect(after.lobby.arrivals === before.lobby.arrivals, `the Lobby counted ${after.lobby.arrivals - before.lobby.arrivals} arrivals`);
    expect(settled.arrivals === 1, `the page arrived ${settled.arrivals} times`);
    return `location went ${locations.join(" > ")}; one arrival at A, none at the Lobby`;
  } },
  { id: "source-lets-go", says: "The Lobby's own route no longer holds the player when A's does", async run(ctx) {
    const { destinationHeld, bothHeld, after, holds, requests, mark } = await tripToA(ctx);
    expect(destinationHeld, "Location A never held the player during the crossing");
    expect(!bothHeld, "the Lobby still held the player when Location A did");
    expect(!holds(after.lobby), `the Lobby still holds the player ${SETTLE_MS / 1000} s later`);
    // A slow crossing outlasts the source's 10 s expiry, which would hide a source that was never told.
    const told = requests.since(mark).some((e) => e.world === "lobby" && e.method === "POST" && /presence\/depart/.test(e.path) && e.status === 200);
    expect(told, "the Lobby was never told the player left: it only let go by expiry");
    return "the Lobby was told, and no read during the crossing found the player in both worlds";
  } },
  { id: "destination-holds", says: "Location A's own route holds the player at the node", async run(ctx) {
    const { after, arrival, start, holds } = await tripToA(ctx);
    expect(holds(after.a), `Location A does not hold the player: ${JSON.stringify(after.a.avatars.map((a) => a.player_id))}`);
    const record = after.a.avatars.find((avatar) => avatar.player_id === start.playerId);
    const off = distance(record.position, arrival.pose.position);
    expect(off <= 0.5, `Location A records the player ${fixed(off)} m from the node`);
    return `A holds the player, ${fixed(off)} m from the node`;
  } },
  { id: "writes-in-order", says: "The writes reach the worlds in order, leaving then arriving, none refused", async run(ctx) {
    const { requests, mark } = await tripToA(ctx);
    const writes = requests.since(mark).filter((e) => e.kind === "http" && e.method !== "GET" && e.world);
    const named = writes.map((e) => `${e.world} ${e.path.replace(/\?.*$/, "")}`);
    const at = (world, pattern) => writes.findIndex((e) => e.world === world && pattern.test(e.path));
    const [exit, arrive, depart, register] = [at("lobby", /portal\/exit/), at("a", /portal\/arrival/), at("lobby", /presence\/depart/), at("a", /presence\/register/)];
    expect([exit, arrive, depart, register].every((i) => i >= 0), `a write is missing: exit ${exit}, arrival ${arrive}, depart ${depart}, register ${register}: ${named.slice(-12).join(", ")}`);
    expect(exit < arrive, "the arrival was written before the exit");
    expect(depart < register, "the destination registered the player before the source let go");
    const refused = writes.filter((e) => !(e.status >= 200 && e.status < 300));
    expect(refused.length === 0, `refused: ${refused.map((e) => `${e.world} ${e.path} ${e.status}`).join(", ")}`);
    return `exit, arrival, depart, register in order; ${writes.length} writes, none refused`;
  } },
  { id: "arrives-at-node", says: `The walker arrives within ${AT_THE_NODE_M} m of the destination's node`, async run(ctx) {
    const { arrived, arrival } = await tripToA(ctx);
    const off = distance(arrived.position, arrival.pose.position);
    expect(off <= AT_THE_NODE_M, `arrived ${fixed(off)} m from node ${arrival.node}`);
    return `${fixed(off)} m from node ${arrival.node}`;
  } },
  { id: "keeps-direction", says: `The walker still faces the walking direction within ${FACING_RAD} rad, and W walks on along it`, async run(ctx) {
    const { arrived, arrival, page } = await tripToA(ctx);
    const inward = yawOf(arrival.pose.forward);
    const off = angleBetween(arrived.facing, inward);
    expect(off <= FACING_RAD, `arrived facing ${fixed(off)} rad off the walking direction`);
    const on = await ctx.once("walk-on", () => holdKeys(page, ["w"], 0.3));
    const heading = angleBetween(on.heading, inward);
    expect(on.distance > 0.3 && heading <= FACING_RAD, `W after the crossing walked ${fixed(on.distance)} m, ${fixed(heading)} rad off the walking direction`);
    return `arrived ${fixed(off)} rad off; W walked on ${fixed(heading)} rad off`;
  } },
  { id: "camera-follows", says: `The camera follows: within ${CAMERA_DISTANCE_M.join(" to ")} m of the walker, looking the way it faces within ${FACING_RAD} rad`, async run(ctx) {
    const { settled } = await tripToA(ctx);
    const away = planar(settled.camera, settled.position);
    expect(inRange(away, CAMERA_DISTANCE_M), `the camera is ${fixed(away)} m from the walker`);
    const off = angleBetween(settled.cameraYaw, settled.facing);
    expect(off <= FACING_RAD, `the camera looks ${fixed(off)} rad away from where the walker faces`);
    return `${fixed(away)} m away, ${fixed(off)} rad off`;
  } },
  { id: "world-shown-changes", says: "The header and the objects become Location A's, and the Lobby's objects are gone", async run(ctx) {
    const { settled, start } = await tripToA(ctx);
    const { lab } = ctx;
    expect(start.objects.length > 0, "the Lobby showed no objects before the crossing (the check would be vacuous)");
    expect(new RegExp(lab.world("a").name).test(settled.title), `the header says "${settled.title}"`);
    const wanted = (await (await fetch(`${lab.address("a")}demo/scene-objects`)).json()).objects.map((o) => o.object_id);
    const missing = wanted.filter((id) => !settled.objects.includes(id));
    expect(missing.length === 0, `Location A's objects are not shown: ${missing.join(", ")}`);
    const left = start.objects.filter((id) => settled.objects.includes(id));
    expect(left.length === 0, `the Lobby's objects are still shown: ${left.join(", ")}`);
    return `"${settled.title}"; ${wanted.length} objects of A shown, ${start.objects.length} of the Lobby gone`;
  } },
  { id: "walks-back", says: `Walking back lands at the counterpart in the Lobby, within ${COUNTERPART_M} m in front of the portal to A`, async run(ctx) {
    const { trip, arrival, landed } = await tripBack(ctx);
    const off = distance(landed.position, arrival.pose.position);
    expect(off <= AT_THE_NODE_M, `landed ${fixed(off)} m from node ${arrival.node}`);
    const ring = trip.portal.pose;
    const fromRing = planar(landed.position, ring.position);
    const inFront = (landed.position[0] - ring.position[0]) * ring.forward[0] + (landed.position[2] - ring.position[2]) * ring.forward[2];
    expect(fromRing <= COUNTERPART_M && inFront > 0, `landed ${fixed(fromRing)} m from the portal to A, ${fixed(inFront)} m in front of it`);
    await waitUntil(async () => trip.holds(await worldRecord(ctx.lab, "lobby")), "the Lobby does not hold the player after the walk back");
    return `${fixed(fromRing)} m from the portal to A, in front of it`;
  } },
  { id: "airport-and-back", says: "Lobby to the airport and back works the same", async run(ctx) {
    const { lab } = ctx;
    const { trip } = await tripBack(ctx);
    const { page } = trip;
    const center = portalNamed(await worldPortals(lab.address("lobby")), "Portal to Denver Skyport");
    const toAirport = await arrivalOf(center.resource.destination);
    await walkInto(page, center, "location-airport");
    const there = await pageFacts(page);
    const off = distance(there.position, toAirport.pose.position);
    expect(off <= AT_THE_NODE_M, `arrived ${fixed(off)} m from the airport's node`);
    await waitUntil(async () => (await pageFacts(page)).airportReady, "the airport never showed", { limitMs: 60000 });
    const [back] = await worldPortals(lab.address("airport"));
    const home = await arrivalOf(back.resource.destination);
    await walkInto(page, back, "location-lobby");
    const landed = await pageFacts(page);
    const fromRing = planar(landed.position, center.pose.position);
    expect(distance(landed.position, home.pose.position) <= AT_THE_NODE_M && fromRing <= COUNTERPART_M, `the return landed ${fixed(fromRing)} m from the center portal`);
    return `${fixed(off)} m from the airport's node; back ${fixed(fromRing)} m from the center portal`;
  } },
  { id: "join-address", says: `A page opened at a destination's #join address arrives within ${AT_THE_NODE_M} m of that node`, async run(ctx) {
    const { lab } = ctx;
    const portal = portalNamed(await worldPortals(lab.address("lobby")), "Portal to Location A");
    const arrival = await arrivalOf(portal.resource.destination);
    const page = await ctx.visit(`${lab.front}/w/a/?intro=bypass#join=node.${arrival.node}`);
    const joined = await pageFacts(page);
    const off = distance(joined.position, arrival.pose.position);
    expect(joined.location === "location-a" && off <= AT_THE_NODE_M, `joined in ${joined.location}, ${fixed(off)} m from node ${arrival.node}`);
    await page.close();
    return `in ${joined.location}, ${fixed(off)} m from node ${arrival.node}`;
  } },
  { id: "no-uncaught-error", says: "The page shows no uncaught error during any of these", async run(ctx) {
    await tripBack(ctx);
    expect(ctx.pageErrors.length === 0, `uncaught error: ${[...new Set(ctx.pageErrors)].slice(0, 3).join(" | ")}`);
    return "none in any page opened by this run";
  } },
];

const TRAVERSAL = "web/live-adapter-portal-traversal-controller.mjs";
const LEAVE_THEN_ENTER = `      await presence.departPresence({ base: fromEndpoint.proxy_base, reason: "portal_departure" });
      const destinationRegistration = await presence.registerPresence({ spawnReason: "portal_arrival" });`;
const faults = [
  { statement: "crosses-once", name: "the arrival is written twice", expect: /Location A counted 2 arrivals/, edits: [{ file: TRAVERSAL, find: "      const arrivalPromise = transport\n", replace: "      void transport.postJson(`${targetEndpoint.proxy_base}/portal/arrival`, packet);\n      const arrivalPromise = transport\n" }] },
  { statement: "source-lets-go", name: "a crossing that leaves the player registered in the source", expect: /the Lobby still held the player when Location A did|the Lobby was never told the player left/, edits: [{ file: TRAVERSAL, find: `      await presence.departPresence({ base: fromEndpoint.proxy_base, reason: "portal_departure" });\n`, replace: "" }] },
  { statement: "destination-holds", name: "the destination is never told the player is there", expect: /Location A does not hold the player/, edits: [{ file: "runtime/world-server/src/server.js", find: "return sendJson(res, 200, runtime.heartbeatPresence(body || {}));", replace: "return sendJson(res, 200, { ok : true });" }, { file: "runtime/world-server/src/server.js", find: "return sendJson(res, 201, runtime.registerPresence(body || {}));", replace: "return sendJson(res, 201, { ok : true });" }] },
  { statement: "writes-in-order", name: "the destination registers the player before the source lets go", expect: /registered the player before the source let go/, edits: [{ file: TRAVERSAL, find: LEAVE_THEN_ENTER, replace: `      const destinationRegistration = await presence.registerPresence({ spawnReason: "portal_arrival" });\n      await presence.departPresence({ base: fromEndpoint.proxy_base, reason: "portal_departure" });` }] },
  { statement: "writes-in-order", name: "the source world refuses the departure", expect: /refused: lobby \/fabric\/presence\/depart 409/, edits: [{ file: "runtime/world-server/src/server.js", find: "return sendJson(res, 200, runtime.departPresence(body || {}));", replace: "return sendJson(res, 409, { ok : false });" }] },
  { statement: "arrives-at-node", name: "a crossing that lands by the walker's offset, not at the node", expect: /arrived [\d.]+ m from node \d+/, edits: [{ file: TRAVERSAL, find: "          arrival: gate.arrival,\n", replace: "          arrival: null,\n" }] },
  { statement: "keeps-direction", name: "the walker arrives turned away from its walking direction", expect: /arrived facing [\d.]+ rad off/, edits: [{ file: TRAVERSAL, find: "      const exitPose = deriveFabricExitPose(frameMapping);\n", replace: "      const exitPose = deriveFabricExitPose(frameMapping);\n      exitPose.rotation_y += 1.2;\n" }] },
  { statement: "camera-follows", name: "a crossing that leaves the camera turned away from the walker", expect: /the camera looks [\d.]+ rad away/, edits: [{ file: "web/movement-camera-controller.mjs", find: "      remapped = applyCrossingCameraMapping(detail);\n", replace: "      remapped = applyCrossingCameraMapping(detail);\n      seedOrbitCamera({ azimuth: normalizeYawRad(orbitCamera.azimuth + 1.2) });\n      applyPlayerCamera();\n" }] },
  { statement: "world-shown-changes", name: "the header keeps the source world's name", expect: /the header says "(?!Location A)/, edits: [{ file: "web/scene-runtime-controller.mjs", find: `implementation.renderer.render(implementation.scene, implementation.camera);\n    }\n    const title = documentTarget.getElementById("loc-title");\n`, replace: "implementation.renderer.render(implementation.scene, implementation.camera);\n    }\n    const title = null;\n" }] },
  { statement: "walks-back", name: "the way back names the wrong portal's arrival", expect: /landed [\d.]+ m from the portal to A/, edits: [{ file: "runtime/world-server/src/portal-standard.js", find: "return destination ? destination.portalArrivalNodeId(portal.target_portal_id) : null;", replace: "const other = destination && destination.getState().portals.find((p) => p.portal_id !== portal.target_portal_id);\n            return destination ? destination.portalArrivalNodeId(other ? other.portal_id : portal.target_portal_id) : null;" }] },
  { statement: "airport-and-back", name: "the return from the airport names the wrong portal's arrival", expect: /the return landed [\d.]+ m from the center portal/, edits: [{ file: "runtime/world-server/src/portal-standard.js", find: "return destination ? destination.portalArrivalNodeId(portal.target_portal_id) : null;", replace: "return destination ? destination.portalArrivalNodeId(destination.getState().portals[0].portal_id) : null;" }] },
  { statement: "offline-portal-refuses", name: "a refusal that leaves the page in the departed phase, so the walker cannot move", expect: /could not walk afterward/, edits: [{ file: TRAVERSAL, find: "    host.controls.portal_transition_elapsed_s = 0;\n    patchHost({ phase: HANDOFF_PHASES.IDLE, controls: host.controls });\n    updatePortalStatus();\n    emitState();\n  }\n\n  function denyCrossing", replace: "    host.controls.portal_transition_elapsed_s = 0;\n    patchHost({ phase: HANDOFF_PHASES.DEPARTED, controls: host.controls });\n    updatePortalStatus();\n    emitState();\n  }\n\n  function denyCrossing" }] },
  { statement: "no-destination-refuses", name: "a portal with no destination that says nothing", expect: /no reason shown/, edits: [{ file: TRAVERSAL, find: "if (ev.crossedPlane && ev.sourceReady && !ev.targetReady && onCrossingRefused) {", replace: "if (false) {" }] },
  { statement: "join-address", name: "a page opened at #join that ignores it", expect: /joined in \S+, [\d.]+ m from node/, edits: [{ file: "web/main-demo-wiring.mjs", find: "const arrival = await getAdapter().applyJoinArrival(Number(joinNode[1]));", replace: `const arrival = { arrived: false, reason: "planted" };` }] },
  { statement: "no-uncaught-error", name: "a crossing that throws after it has arrived", expect: /uncaught error: planted/, edits: [{ file: "web/app.js", find: "  recomposeActiveWorldScene(detail.kind || \"crossing\");\n  onState(adapter.debugState());\n", replace: "  setTimeout(() => { throw new Error(\"planted\"); }, 0);\n  recomposeActiveWorldScene(detail.kind || \"crossing\");\n  onState(adapter.debugState());\n" }] },
];

await runBehavior({ title: "crossing", firstPort: 36100, statements, faults });
