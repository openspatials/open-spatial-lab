// What the page's connection to its world does, as a visitor sees it: it registers and stays registered, it keeps its
// streams open, it lists every request in the API panel, it signs a crossing, it equips what the picker says, and the
// run-cadence slider sets the run speed. The statements here replace assertions that read web/live-adapter.js as text.
//   node tools/behavior/live-adapter.check.mjs [--faults] [--only id,id]
import { worldPortals } from "../arch-i4/main-demo/world-data.mjs";
import { expect, faceYaw, fixed, holdKeys, inRange, pageFacts, runBehavior, sleep, walkThrough, walkTo, waitUntil, worldRecord } from "./kit.mjs";
import { bodyMark, clearViaPicker, clientSceneTrip, HAT_AND_MUG, groundNow, liveFacts, moveRunCadence, storedInBrowser, visitRecorded, wearViaPicker, wornNow } from "./live-adapter-page.mjs";

const WALK_M = [1.2, 1.65]; // 0.6 s of the movement loop at 2.35 m/s, as in movement.check.mjs
const RUN_FOLLOWS_RANGE = 0.5; // how far the run speed ratio may be from the slider's ratio, as a share of the slider's rise
const CROSS_LIMIT_MS = 90000;

const lobby = (ctx) => `${ctx.lab.front}/index.html?role=player&intro=bypass`;
const visitor = (ctx) => ctx.once("visitor", () => ctx.visit(lobby(ctx)));
const recorded = (ctx) => ctx.once("recorded", () => visitRecorded(ctx, lobby(ctx)));
const holds = (record, playerId) => record.avatars.some((avatar) => avatar.player_id === playerId);
const pathOf = (path) => path.replace(/\?.*$/, "");

/** The Lobby's walk-through of its portal to Location A, from 1.4 m in front, with real keys. */
async function crossToA(ctx) {
  const page = await ctx.visit(lobby(ctx));
  const portal = (await worldPortals(ctx.lab.address("lobby"))).find((p) => p.resource.label === "Portal to Location A");
  expect(portal, "the Lobby has no portal named Portal to Location A");
  const [x, , z] = portal.pose.position;
  const [fx, , fz] = portal.pose.forward;
  const seen = await walkThrough(page, { from: [x + fx * 1.4, z + fz * 1.4], yaw: Math.atan2(-fx, -fz), expect: "location-a", timeoutMs: CROSS_LIMIT_MS });
  expect(seen.location_id === "location-a", `the walk did not cross: still in ${seen.location_id} (timed out after ${CROSS_LIMIT_MS / 1000} s)`);
  return page;
}

/** The middle of the Lobby's open floor, turned to walk along +X, so that a run in either direction stays clear of the walls. */
async function atOpenFloor(page) {
  await page.bringToFront();
  await walkTo(page, -1, 2);
  await faceYaw(page, Math.PI / 2);
  await sleep(300);
}

const statements = [
  { id: "presence-lifecycle", says: "The page registers its player with its world, keeps it there with heartbeats, and the world lets go when the page leaves", async run(ctx) {
    const page = await ctx.visit(lobby(ctx));
    const { playerId } = await pageFacts(page);
    await waitUntil(async () => (await liveFacts(page)).presence.registers >= 1, "the page never registered with its world", { limitMs: 60000 });
    await waitUntil(async () => holds(await worldRecord(ctx.lab, "lobby"), playerId), "the Lobby never held the player");
    const beats = async () => (await liveFacts(page)).presence.heartbeats;
    await waitUntil(async () => (await beats()) >= 2, async () => `the page sent ${await beats()} heartbeats`, { limitMs: 60000 });
    const listed = (await liveFacts(page)).panel.filter((row) => row.method === "POST" && /presence\/heartbeat/.test(row.path)).length;
    expect(listed >= 2, `the API panel lists ${listed} heartbeats`);
    await page.goto("about:blank");
    await waitUntil(async () => !holds(await worldRecord(ctx.lab, "lobby"), playerId), "the Lobby still holds the player after the page left", { limitMs: 6000, everyMs: 150 });
    return `registered, ${listed} heartbeats listed, gone within 6 s of leaving`;
  } },
  { id: "event-streams", says: "The page keeps a runtime-state stream and an events stream open to its own world, through its own address", async run(ctx) {
    const { page, requests } = await recorded(ctx);
    const sockets = requests.entries.filter((entry) => entry.kind === "ws" && entry.world === "lobby");
    const paths = sockets.map((entry) => entry.path);
    expect(paths.includes("/runtime-state"), `no runtime-state stream to the Lobby: ${paths.join(", ") || "none"}`);
    expect(paths.includes("/events"), `no events stream to the Lobby: ${paths.join(", ") || "none"}`);
    expect(sockets.every((entry) => entry.proxied && !entry.direct), `a stream went round the page's own address: ${sockets.map((entry) => entry.url).join(", ")}`);
    const open = await waitUntil(async () => { const one = (await liveFacts(page)).streams.lobby; return one && one.state === "open" && one.hello ? one : null; }, "the events stream never opened and heard the world's hello", { limitMs: 60000 });
    return `${paths.join(" and ")} through the page's address; events stream ${open.state}`;
  } },
  { id: "api-panel-lists-requests", says: "Every request the page makes to its world's data routes is listed in the API panel", async run(ctx) {
    const { page, requests } = await recorded(ctx);
    await waitUntil(async () => (await liveFacts(page)).presence.heartbeats >= 1, "the page never sent a heartbeat", { limitMs: 60000 });
    const missing = async () => {
      const listed = (await liveFacts(page)).panel.map((row) => pathOf(row.path));
      const sent = requests.entries.filter((entry) => entry.kind === "http" && entry.world === "lobby" && !/^\/demo\//.test(entry.path)).map((entry) => pathOf(entry.path));
      return [...new Set(sent.filter((path) => !listed.some((row) => row.endsWith(path))))];
    };
    await waitUntil(async () => (await missing()).length === 0, async () => `not in the API panel: ${(await missing()).join(", ")}`, { limitMs: 20000 });
    const internal = (await liveFacts(page)).panel.filter((row) => /\/demo\//.test(row.path));
    expect(internal.length === 0, `the API panel lists internal demo routes: ${internal.map((row) => row.path).join(", ")}`);
    return `${requests.entries.filter((entry) => entry.kind === "http" && entry.world === "lobby").length} requests to the Lobby; the data routes are listed, the demo routes are not`;
  } },
  { id: "picker-equips", says: "The picker's Apply puts the chosen item on the avatar, and clearing takes it off", async run(ctx) {
    const page = await visitor(ctx);
    expect((await wornNow(page)).length === 0, `the avatar wears ${(await wornNow(page)).join(", ")} before the picker (the check would be vacuous)`);
    await wearViaPicker(page, HAT_AND_MUG);
    const worn = await waitUntil(async () => { const now = await wornNow(page); return now.includes("equip-hat") ? now : null; }, "the picker applied the hat but the avatar does not wear it", { limitMs: 20000 });
    await clearViaPicker(page);
    await waitUntil(async () => (await wornNow(page)).length === 0, async () => `after clearing the avatar still wears ${(await wornNow(page)).join(", ")}`, { limitMs: 20000 });
    return `wore ${worn.join(", ")}, then nothing`;
  } },
  { id: "run-cadence-sets-run-speed", says: "Moving the run cadence slider from its lowest to its highest raises the run speed in step, and writes nothing", async run(ctx) {
    const { page, requests } = await recorded(ctx);
    await atOpenFloor(page);
    const kept = await storedInBrowser(page);
    const address = page.url();
    const writes = [];
    const move = async (key) => {
      const mark = requests.mark();
      const value = await moveRunCadence(page, key);
      writes.push(...requests.since(mark).filter((entry) => entry.kind === "http" && entry.method !== "GET" && entry.world && !/presence/.test(entry.path)));
      return value;
    };
    const low = await move("Home");
    const slow = await holdKeys(page, ["Shift", "w"], 0.6);
    const high = await move("End");
    const fast = await holdKeys(page, ["Shift", "s"], 0.6);
    expect(high > low * 1.05, `the slider's two ends are ${low} and ${high}`);
    const wanted = high / low;
    const got = fast.speed / slow.speed;
    expect(Math.abs(got - wanted) <= (wanted - 1) * RUN_FOLLOWS_RANGE, `the slider went to ${fixed(wanted)} times its lowest value but the run speed to ${fixed(got)} times`);
    expect((await storedInBrowser(page)) === kept, "moving the slider changed what the page keeps in the browser");
    expect(page.url() === address, `moving the slider changed the address to ${page.url()}`);
    expect(writes.length === 0, `moving the slider sent a write to the world: ${writes.map((entry) => `${entry.method} ${entry.path}`).join(", ")}`);
    return `slider ${fixed(wanted)} times from end to end, run speed ${fixed(got)} times; nothing stored, nothing written`;
  } },
  { id: "mission-link-opens-lobby", says: "A link with mission=denver-skyport opens the Lobby, with the page marked as a server-backed crossing", async run(ctx) {
    const page = await ctx.visit(`${lobby(ctx)}&mission=denver-skyport`);
    const facts = await pageFacts(page);
    expect(facts.location === "location-lobby", `the mission link opened ${facts.location}`);
    const mark = await bodyMark(page, "data-denver-skyport-mission");
    expect(mark === "portal-c-server-backed", `the page is marked "${mark}"`);
    return `in ${facts.location}, marked ${mark}`;
  } },
  { id: "airport-ground-walks", says: `A visitor who opens the airport walks on its own floor, ${WALK_M.join(" to ")} m in 0.6 s of the loop`, async run(ctx) {
    const page = await ctx.visit(`${ctx.lab.front}/w/airport/?intro=bypass`);
    await waitUntil(async () => (await pageFacts(page)).airportReady, "the airport never showed", { limitMs: 60000 });
    const facts = await pageFacts(page);
    expect(facts.location === "location-airport", `opened ${facts.location}, not the airport`);
    // The spawn may face a wall, so any of the four walking keys may be the one that is free.
    let best = 0;
    for (const key of ["w", "s", "a", "d"]) {
      best = Math.max(best, (await holdKeys(page, [key], 0.6)).distance);
      if (best >= WALK_M[0]) break;
    }
    expect(inRange(best, WALK_M), `no walking key moved the avatar ${WALK_M.join(" to ")} m in 0.6 s of loop time on the airport floor; the best moved ${fixed(best)} m`);
    const ground = await groundNow(page);
    expect(ground.own, `the visitor walks on ${ground.name || "no ground at all"}, not on the airport's own floor`);
    return `walked ${fixed(best)} m on the airport floor (${ground.name})`;
  } },
  { id: "crossing-is-signed", says: "A crossing from the Lobby to A lists a signed receipt in the API panel", async run(ctx) {
    const page = await crossToA(ctx);
    const receipt = await waitUntil(async () => (await liveFacts(page)).panel.find((row) => row.method === "RECEIPT" && row.ok), async () => `no signed receipt in the API panel: ${(await liveFacts(page)).panel.slice(-6).map((row) => `${row.method} ${row.path}`).join(", ")}`, { limitMs: 20000 });
    return `${receipt.schema} listed after the crossing`;
  } },
  { id: "client-scene-round-trip", says: "Entering a client scene and coming back leaves the lobby's connection, the avatar and what it wears as they were", async run(ctx) {
    const page = await ctx.visit(lobby(ctx));
    await wearViaPicker(page, HAT_AND_MUG);
    await waitUntil(async () => (await wornNow(page)).includes("equip-hat"), "the hat was not worn before the trip", { limitMs: 20000 });
    const trip = await clientSceneTrip(page);
    expect(trip.contract && trip.entered.ok, `the client scene was not entered: ${JSON.stringify(trip.entered)}`);
    expect(trip.inside.active, "the page's debug does not say the client scene is active");
    expect(trip.inside.location !== trip.before.location, `inside the client scene the page still shows ${trip.inside.location}`);
    expect(trip.inside.endpoint === trip.before.endpoint && trip.inside.base === trip.before.base && trip.inside.endpointBase === trip.before.endpointBase, `entering switched the lobby's connection: ${JSON.stringify([trip.before.endpointBase, trip.inside.endpointBase])}`);
    expect(trip.inside.streamKeys.length === 0, `inside the client scene the page still keeps event streams for ${trip.inside.streamKeys.join(", ")}`);
    expect(trip.returned.ok, `the return was refused: ${JSON.stringify(trip.returned)}`);
    expect(!trip.after.active, "the client scene is still active after the return");
    expect(trip.after.location === trip.before.location, `after the return the page shows ${trip.after.location}, not ${trip.before.location}`);
    expect(trip.sameAvatar, "after the return the page holds a copy of the avatar, not the avatar it had");
    expect(trip.after.worn.join() === trip.before.worn.join() && trip.after.variant === trip.before.variant, `after the return the avatar wears ${trip.after.worn.join()} as ${trip.after.variant}, not ${trip.before.worn.join()} as ${trip.before.variant}`);
    expect(trip.after.streamKeys.join() === trip.before.streamKeys.join(), `after the return the page keeps event streams for ${trip.after.streamKeys.join(", ") || "none"}, not ${trip.before.streamKeys.join(", ")}`);
    return `in ${trip.inside.location} with no event streams, back in ${trip.after.location}, still wearing ${trip.after.worn.join()}`;
  } },
];

const ADAPTER = "web/live-adapter.js";
const STREAMS = "web/live-adapter-runtime-stream-controller.mjs";
const faults = [
  { statement: "presence-lifecycle", name: "the heartbeat never starts", expect: /the page sent \d+ heartbeats/, edits: [{ file: "web/live-adapter-presence-controller.mjs", find: "const PRESENCE_HEARTBEAT_INTERVAL_MS = 3000;", replace: "const PRESENCE_HEARTBEAT_INTERVAL_MS = 36000000;" }] },
  { statement: "presence-lifecycle", name: "leaving the page sends the depart to a route that does not exist", expect: /still holds the player after the page left/, edits: [{ file: "web/live-adapter-presence-controller.mjs", find: "`${base}/fabric/presence/depart`,\n          new BlobCtor", replace: "`${base}/fabric/presence/depart-none`,\n          new BlobCtor" }] },
  { statement: "presence-lifecycle", name: "the debug drops its presence key", expect: /the page never registered with its world/, edits: [{ file: ADAPTER, find: "presence_registration: this._presenceDebug(),", replace: "registration: this._presenceDebug()," }] },
  { statement: "presence-lifecycle", name: "the register request goes to a route that does not exist", expect: /the page never registered with its world/, edits: [{ file: "web/live-adapter-presence-controller.mjs", find: "`${base}/fabric/presence/register`, {", replace: "`${base}/fabric/presence/register-none`, {" }] },
  { statement: "event-streams", name: "the debug drops its stream account", expect: /events stream never opened/, edits: [{ file: ADAPTER, find: "presence_push: this._presencePushDebug(),", replace: "push: this._presencePushDebug()," }] },
  { statement: "event-streams", name: "the runtime-state stream is never opened", expect: /no runtime-state stream/, edits: [{ file: STREAMS, find: "    closeRuntimeStream();\n    if (!isEndpointKey(endpointKey) || !locationLike) return null;\n    const generation = ++runtimeGeneration;", replace: "    closeRuntimeStream();\n    return null;\n    if (!isEndpointKey(endpointKey) || !locationLike) return null;\n    const generation = ++runtimeGeneration;" }] },
  { statement: "event-streams", name: "the events stream is never opened", expect: /no events stream/, edits: [{ file: STREAMS, find: "  function openEventStream(endpointKey) {\n", replace: "  function openEventStream(endpointKey) {\n    return null;\n" }] },
  { statement: "api-panel-lists-requests", name: "the user read goes round the transport", expect: /not in the API panel: .*wow\/user\/1/, edits: [{ file: ADAPTER, find: "wowUser = await this._transport.getJson(ep.user.path);", replace: "wowUser = await (await fetch(ep.user.path)).json();" }] },
  { statement: "api-panel-lists-requests", name: "the adapter exports a second bus the panel does not hear", expect: /not in the API panel/, edits: [{ file: ADAPTER, find: 'export { API_EVENTS } from "./live-adapter-transport.mjs";', replace: "export const API_EVENTS = new EventTarget();" }] },
  { statement: "api-panel-lists-requests", name: "a demo route is listed as if it were a data route", expect: /lists internal demo routes/, edits: [{ file: ADAPTER, find: "this._transport.rawFetch(`${this.demoProxyBase(endpointKey)}/demo/um/attach-point`", replace: "this._transport.getJson(`${this.demoProxyBase(endpointKey)}/demo/um/attach-point`" }] },
  { statement: "picker-equips", name: "Apply stages the item but never puts it on", expect: /does not wear it/, edits: [{ file: "web/app.js", find: "          avatar.equippedItems = items;\n", replace: "" }] },
  { statement: "run-cadence-sets-run-speed", name: "the run speed ignores the slider", expect: /the slider went to [\d.]+ times its lowest value but the run speed/, edits: [{ file: ADAPTER, find: "calibration.run_cycle_speed * calibration.run_cycle_distance\n        : sourceSpeed,", replace: "sourceSpeed\n        : sourceSpeed," }] },
  { statement: "run-cadence-sets-run-speed", name: "the slider saves its value in the browser", expect: /changed what the page keeps in the browser/, edits: [{ file: ADAPTER, find: "    this._runCalibration = Object.freeze({", replace: "    localStorage.setItem(\"run_cycle_speed\", String(runCycleSpeed));\n    this._runCalibration = Object.freeze({" }] },
  { statement: "run-cadence-sets-run-speed", name: "the slider posts its value to the world", expect: /sent a write to the world: POST/, edits: [{ file: ADAPTER, find: "    this._runCalibration = Object.freeze({", replace: "    void this._transport.postJson(`${this.base}/demo/run-calibration`, { run_cycle_speed: runCycleSpeed });\n    this._runCalibration = Object.freeze({" }] },
  { statement: "mission-link-opens-lobby", name: "the mission link leaves no mark", expect: /the page is marked "null"/, edits: [{ file: "web/app.js", find: "if (isPlayer && launcherMissionParam === \"denver-skyport\") {", replace: "if (false) {" }] },
  { statement: "airport-ground-walks", name: "the airport's floor is never adopted", expect: /not on the airport's own floor/, edits: [{ file: ADAPTER, find: "  _adoptLiveAirportScenePhysics(resolved) {\n", replace: "  _adoptLiveAirportScenePhysics(resolved) {\n    return;\n" }] },
  { statement: "crossing-is-signed", name: "the crossing is not signed", expect: /no signed receipt in the API panel/, edits: [{ file: ADAPTER, find: "featureSignManifestOntoPacket(packet, this.world, this._transport),", replace: "Promise.resolve(null)," }] },
  { statement: "client-scene-round-trip", name: "entering does nothing", expect: /the client scene was not entered/, edits: [{ file: ADAPTER, find: "    return this._clientSceneController.enter({ target, contract, resolved, bounds });", replace: "    return resolved;" }] },
  { statement: "client-scene-round-trip", name: "the debug does not say the client scene is active", expect: /the page's debug does not say the client scene is active/, edits: [{ file: ADAPTER, find: "client_scene_load: this._clientSceneController.debug(),", replace: "client_scene_load: null," }] },
  { statement: "client-scene-round-trip", name: "the lobby's event streams stay open inside the client scene", expect: /still keeps event streams for lobby/, edits: [{ file: ADAPTER, find: "    if (this._clientSceneController.active() || this._wowLocalWalk) return [];\n", replace: "" }] },
  { statement: "client-scene-round-trip", name: "entering switches the lobby's connection", expect: /entering switched the lobby's connection/, edits: [{ file: ADAPTER, find: "      this._wowResolved = resolved;\n      this._wowSceneSource = {", replace: "      this.endpoint = { proxy_base: \"/api/airport\" };\n      this._wowResolved = resolved;\n      this._wowSceneSource = {" }] },
  { statement: "client-scene-round-trip", name: "the return does not go through the client scene", expect: /still active after the return/, edits: [{ file: ADAPTER, find: "    if (this._clientSceneController.active()) return this.returnFromClientSceneLoad();\n", replace: "" }] },
  { statement: "client-scene-round-trip", name: "the return leaves the airport world in place", expect: /after the return the page shows/, edits: [{ file: ADAPTER, find: "      this.world = origin.world;\n      this._movementBounds = origin.movementBounds;", replace: "      this._movementBounds = origin.movementBounds;" }] },
  { statement: "client-scene-round-trip", name: "the return puts back a copy of the avatar", expect: /holds a copy of the avatar/, edits: [{ file: ADAPTER, find: "      this.state.avatar = avatar;\n      if (avatar) {", replace: "      this.state.avatar = avatar ? { ...avatar } : avatar;\n      if (avatar) {" }] },
  { statement: "client-scene-round-trip", name: "the return puts the avatar back bare", expect: /after the return the avatar wears/, edits: [{ file: ADAPTER, find: "        avatar.equippedItems = equippedItems;\n        avatar.locomotion = this.state.controls;", replace: "        avatar.equippedItems = [];\n        avatar.locomotion = this.state.controls;" }] },
];

await runBehavior({ title: "live-adapter", firstPort: 36400, statements, faults });
