// A crossing that fails or hangs gives the walker back: the same refusal a visitor hears at an offline portal, W and S
// work again, the source world holds the player again, and walking in again crosses. While it hangs the walk is short.
// At an offline destination each walk-in is refused once: a walker who holds W on walks through the portal, and one who
// leaves the portal and walks in again is refused again.
// The requests are the page's own, taken over with Chrome's request interception.
// Run: node tools/behavior/crossing-failure.check.mjs [--faults] [--only id,id]
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { CODE, plantFaults } from "../arch-i4/main-demo/lab.mjs";
import { placeByApi, worldPortals } from "../arch-i4/main-demo/world-data.mjs";
import { expect, faceYaw, fail, fixed, holdKeys, inRange, pageFacts, recordRequests, runBehavior, sleep, untilClock, waitUntil, walkTo, worldRecord } from "./kit.mjs";
import { lobbyUrl, portalNamed, walkInto } from "./crossing-walk.mjs";

const EXIT_INTENT = "/portal/exit-intent";
const WALKTHROUGH = "portal_walkthrough";
const REFUSAL_AFTER_PLANE_MS = 60000; // the crossing's own limit is 15 s; the rest is for a loaded machine
const REACH_PLANE_MS = 90000;
const WALK_LIMIT_M = 1.25; // the controller's 1 m, from a crossing point up to one 2.35 m/s frame past the plane
const STOOD_NEAR_PLANE_M = 0.5;
const WALK_AWAY_M = [1.0, 1.7]; // over 0.6 s of the movement loop's time, at 2.35 m/s
const STILL_HERE = /You are still here/;
const LET_GO_S = 0.1; // of the movement loop's time: a finger on W lifts a moment after the refusal, never with it
const SETTLE_MS = 1000; // long enough for a crossing begun by the last step to be refused
const HELD_S = 3; // of the movement loop's time: a walk-in at an offline portal used to be refused about 8 times in this
const THROUGH_M = 0.5; // past the portal's plane, clear of its trigger volume; the Lobby's wall is about 1 m behind it
const PICTURES = join(CODE, ".runtime", "behavior", "crossing-failure", "pictures");

/**
 * Take over the page's requests. `set(match, action)` applies `action` to requests whose address `match` accepts:
 * "hold" keeps them waiting until release(), and a function answers them.
 */
async function takeOverRequests(page) {
  await page.setRequestInterception(true);
  let rule = null;
  const held = [];
  page.on("request", (request) => {
    if (!rule || !rule.match(request.url())) return void request.continue().catch(() => {});
    if (rule.action === "hold") return void held.push(request);
    return void rule.action(request);
  });
  return {
    set(match, action) { rule = { match, action }; },
    release() { rule = null; for (const request of held.splice(0)) request.continue().catch(() => {}); },
    held: () => held.length,
  };
}

const isExitIntent = (url) => url.includes(EXIT_INTENT);
const answer = (status, body) => (request) => request.respond({ status, contentType: "application/json", body }).catch(() => {});

/** The world hears the exit-intent, so it lets the player go, and the page hears `body` in place of its answer. */
const heardThenAnswers = (body) => async (request) => {
  await fetch(request.url(), { method: "POST", headers: { "Content-Type": "application/json" }, body: request.postData() }).catch(() => {});
  await answer(201, body)(request);
};

const pastPlane = ({ position: [x, , z], forward: [fx, , fz] }, facts) => -((facts.position[0] - x) * fx + (facts.position[2] - z) * fz);

/** Walk into the portal with W, let go once past its plane, and wait for the page to refuse. */
async function walkToRefusal(page, place) {
  const [x, , z] = place.position;
  const [fx, , fz] = place.forward;
  await walkTo(page, x + fx * 1.4, z + fz * 1.4);
  await faceYaw(page, Math.atan2(-fx, -fz));
  await sleep(400);
  await page.keyboard.down("w");
  const started = Date.now();
  let crossedAt = null;
  let farthest = 0;
  for (;;) {
    const facts = await pageFacts(page);
    const past = pastPlane(place, facts);
    if (crossedAt === null && past > 0) {
      crossedAt = Date.now();
      await page.keyboard.up("w");
    }
    if (facts.phase === WALKTHROUGH) farthest = Math.max(farthest, past);
    if (facts.refusals.length > 0 || facts.location !== "location-lobby") break;
    if (crossedAt === null && Date.now() - started > REACH_PLANE_MS) {
      await page.keyboard.up("w");
      fail(`the walker did not reach the plane in ${REACH_PLANE_MS / 1000} s, ${fixed(past)} m past it`);
    }
    if (crossedAt !== null && Date.now() - crossedAt > REFUSAL_AFTER_PLANE_MS) fail(`no refusal ${REFUSAL_AFTER_PLANE_MS / 1000} s after the plane: phase ${facts.phase}, walked ${fixed(past)} m past the portal`);
    await sleep(60);
  }
  if (crossedAt === null) await page.keyboard.up("w");
  await sleep(600);
  return { after: await pageFacts(page), farthest, tookMs: Date.now() - (crossedAt ?? started) };
}

/** With W held, walk on until the page records one more refusal, and let go a moment later. */
async function holdWIntoRefusal(page, known) {
  await page.keyboard.down("w");
  await waitUntil(async () => (await pageFacts(page)).refusals.length > known, `W did not bring refusal ${known + 1}`, { limitMs: REACH_PLANE_MS });
  await untilClock(page, LET_GO_S);
  await page.keyboard.up("w");
  await waitUntil(async () => (await pageFacts(page)).phase !== WALKTHROUGH, "a crossing did not end after W was let go");
  await sleep(SETTLE_MS);
  return pageFacts(page);
}

const holds = (record, playerId) => record.avatars.some((avatar) => avatar.player_id === playerId);

/** After a refusal: the visitor stayed, heard the reason, can walk, and walking in again with nothing in the way crosses. */
async function expectFreedThenRetry(ctx, page, place, { after }, control) {
  expect(after.location === "location-lobby", `the visitor left the Lobby: in ${after.location}`);
  const heard = after.toasts.find((text) => STILL_HERE.test(text));
  expect(heard, `no reason shown: toasts ${JSON.stringify(after.toasts)}, refusals ${JSON.stringify(after.refusals)}`);
  const away = await holdKeys(page, ["s"], 0.6);
  expect(inRange(away.distance, WALK_AWAY_M), `could not walk afterward: S moved ${fixed(away.distance)} m, not ${WALK_AWAY_M.join(" to ")} m`);
  control.release();
  await walkInto(page, { pose: place }, "location-a");
  await waitUntil(async () => holds(await worldRecord(ctx.lab, "a"), after.playerId), "the retry reached Location A, whose own route does not hold the player");
  expect(ctx.pageErrors.length === 0, `uncaught error: ${[...new Set(ctx.pageErrors)].slice(0, 3).join(" | ")}`);
  await page.close();
  return `"${heard}"; S walked ${fixed(away.distance)} m; the retry crossed`;
}

const registeredSince = (requests, mark) => requests.since(mark).some((e) => e.world === "lobby" && e.method === "POST" && /presence\/register/.test(e.path) && e.status >= 200 && e.status < 300);

async function atLobbyPortal(ctx) {
  ctx.pageErrors.length = 0;
  const page = await ctx.visit(lobbyUrl(ctx.lab));
  const portal = portalNamed(await worldPortals(ctx.lab.address("lobby")), "Portal to Location A");
  const control = await takeOverRequests(page);
  const requests = await recordRequests(page, { worlds: ctx.lab.doc.worlds, front: ctx.lab.front });
  return { page, control, requests, place: portal.pose };
}

/** A lab with Location E in a process of its own, so that it can be stopped. */
const offlineLab = (first) => ({ separate: "e", env: { OSL_PLACEMENT_WRITES: "1" }, extra: [{ key: "e", name: "Location E", port: first + 5, address: `http://127.0.0.1:${first + 5}/`, anchor: { lat: 47.7009, lon: -122.3, h: 11.5 }, room: "#c86bff", preview_radius_m: 10 }] });

/** A portal in the Lobby to Location E, whose process is then stopped, and a walker 1.4 m in front of it, facing it. */
async function facingOfflinePortal(ctx) {
  ctx.pageErrors.length = 0;
  const placed = await placeByApi(ctx.lab.address("lobby"), { x: 4.4, z: 1.4, label: "Portal to Location E", destination: ctx.lab.address("e") });
  await ctx.lab.stopWorld("e");
  const at = placed.node.localTransform;
  const place = { position: [at[12], 0, at[14]], forward: placed.inward };
  const page = await ctx.visit(lobbyUrl(ctx.lab));
  await walkTo(page, at[12] + place.forward[0] * 1.4, at[14] + place.forward[2] * 1.4);
  await faceYaw(page, Math.atan2(-place.forward[0], -place.forward[2]));
  await sleep(400);
  return { page, place };
}

const statements = [
  { id: "exit-intent-hangs", says: "An exit-intent with no answer: the walk stays short, the crossing is refused in time, and a late answer does not lose the player", async run(ctx) {
    const { page, control, requests, place } = await atLobbyPortal(ctx);
    control.set(isExitIntent, "hold");
    const refused = await walkToRefusal(page, place);
    expect(control.held() === 1, `the page sent ${control.held()} exit-intents`);
    expect(refused.farthest <= WALK_LIMIT_M, `walked ${fixed(refused.farthest)} m past the portal while the crossing hung`);
    const stood = pastPlane(place, refused.after);
    expect(stood <= STOOD_NEAR_PLANE_M, `stood ${fixed(stood)} m past the portal after the refusal, not back where it crossed`);
    const mark = requests.mark();
    control.release();
    await waitUntil(() => registeredSince(requests, mark), "the Lobby lost the player: no new registration after the late exit-intent landed");
    await waitUntil(async () => holds(await worldRecord(ctx.lab, "lobby"), refused.after.playerId), "the Lobby does not hold the player after the late exit-intent");
    const retried = await expectFreedThenRetry(ctx, page, place, refused, control);
    return `refused ${fixed(refused.tookMs / 1000, 1)} s after the plane, walked at most ${fixed(refused.farthest)} m; the Lobby holds the player after the late answer; ${retried}`;
  } },
  { id: "exit-intent-errors", says: "An exit-intent answered with an error is refused aloud, and a retry crosses", async run(ctx) {
    const { page, control, place } = await atLobbyPortal(ctx);
    control.set(isExitIntent, answer(500, "{\"ok\":false}"));
    const refused = await walkToRefusal(page, place);
    return expectFreedThenRetry(ctx, page, place, refused, control);
  } },
  { id: "exit-intent-malformed", says: "An exit-intent the world heard, answered with a malformed packet: refused aloud, the player is registered again, and a retry crosses", async run(ctx) {
    const { page, control, requests, place } = await atLobbyPortal(ctx);
    const mark = requests.mark();
    control.set(isExitIntent, heardThenAnswers("null"));
    const refused = await walkToRefusal(page, place);
    await waitUntil(() => registeredSince(requests, mark), "the Lobby does not hold the player: no new registration after its exit-intent departed it", { limitMs: 4000 });
    return expectFreedThenRetry(ctx, page, place, refused, control);
  } },
  { id: "exit-intent-unreadable", says: "An exit-intent answered with something that is not a packet at all does not cross", async run(ctx) {
    const { page, control, place } = await atLobbyPortal(ctx);
    control.set(isExitIntent, (request) => request.respond({ status: 200, contentType: "text/html", body: "<html>proxy error</html>" }).catch(() => {}));
    const refused = await walkToRefusal(page, place);
    return expectFreedThenRetry(ctx, page, place, refused, control);
  } },
  { id: "visual-begin-throws", says: "A throw from the visual transition's start is refused aloud, and a retry crosses",
    lab: () => ({ code: plantFaults({ dir: join(CODE, ".runtime", "behavior", "crossing-failure", "begin-throws"), edits: [{ file: "web/live-adapter.js", find: "  beginVisualTransition(metadata = {}) {\n", replace: "  beginVisualTransition(metadata = {}) {\n    if (!window.__beginThrew) { window.__beginThrew = true; throw new Error(\"a visual transition is already staged\"); }\n" }] }) }),
    async run(ctx) {
      const { page, control, place } = await atLobbyPortal(ctx);
      const refused = await walkToRefusal(page, place);
      return expectFreedThenRetry(ctx, page, place, refused, control);
    } },
  { id: "check-before-leaving-hangs", says: "A destination that hangs the check before leaving is refused in time, and a retry crosses",
    lab: () => ({ env: { OSL_PLACEMENT_WRITES: "1" } }),
    async run(ctx) {
      ctx.pageErrors.length = 0;
      const destination = ctx.lab.address("a");
      const placed = await placeByApi(ctx.lab.address("lobby"), { x: 4.4, z: 1.4, label: "Portal with no join", destination });
      const at = placed.node.localTransform;
      const place = { position: [at[12], 0, at[14]], forward: placed.inward };
      const page = await ctx.visit(lobbyUrl(ctx.lab));
      const control = await takeOverRequests(page);
      // The world's own answer passes, so the check goes on to read where to arrive, and that read has no limit of its own.
      control.set((url) => url.startsWith(destination) && !url.endsWith("wow/world"), "hold");
      const refused = await walkToRefusal(page, place);
      expect(control.held() > 0, "the check before leaving never asked where to arrive");
      return expectFreedThenRetry(ctx, page, place, refused, control);
    } },
  { id: "offline-backing-away", says: "At an offline destination, the refusal leaves the walker on the side it came from, S then walks away with no second refusal and no crossing, and walking in again from there is refused again",
    lab: offlineLab,
    async run(ctx) {
      const { page, place } = await facingOfflinePortal(ctx);
      const refused = await holdWIntoRefusal(page, 0);
      mkdirSync(PICTURES, { recursive: true });
      await page.screenshot({ path: join(PICTURES, "after-refusal.png") });
      const stood = pastPlane(place, refused);
      expect(STILL_HERE.test(refused.toasts.at(-1)), `the reason gave way on screen to: ${refused.toasts.at(-1)}`);
      expect(stood < 0, `the refusal left the walker ${fixed(stood)} m past the portal, not on the side it came from`);

      const away = await holdKeys(page, ["s"], 0.6);
      await sleep(SETTLE_MS);
      const walked = await pageFacts(page);
      expect(walked.location === "location-lobby", `S crossed: in ${walked.location}`);
      expect(walked.refusals.length === refused.refusals.length, `S started another crossing: ${walked.refusals.length - refused.refusals.length} more refusals, phase ${walked.phase}`);
      expect(inRange(away.distance, WALK_AWAY_M), `could not walk afterward: S moved ${fixed(away.distance)} m, not ${WALK_AWAY_M.join(" to ")} m`);

      const again = await holdWIntoRefusal(page, walked.refusals.length);
      expect(pastPlane(place, again) < 0, `the second refusal left the walker ${fixed(pastPlane(place, again))} m past the portal`);
      expect(again.location === "location-lobby", `the walker left the Lobby: in ${again.location}`);
      expect(ctx.pageErrors.length === 0, `uncaught error: ${[...new Set(ctx.pageErrors)].slice(0, 3).join(" | ")}`);
      await page.close();
      return `stood ${fixed(-stood)} m in front of the portal; S walked ${fixed(away.distance)} m with no second refusal; W from there was refused again`;
    } },
  { id: "offline-held-w", says: "At an offline destination, W held on for 3 s after the refusal starts no second crossing: one refusal and one notice, and the walker, who has not left the portal, walks on through it and stays in the Lobby",
    lab: offlineLab,
    async run(ctx) {
      const { page, place } = await facingOfflinePortal(ctx);
      await page.keyboard.down("w");
      await waitUntil(async () => (await pageFacts(page)).refusals.length > 0, "W did not bring a refusal", { limitMs: REACH_PLANE_MS });
      const refusedAt = await pageFacts(page);
      await untilClock(page, HELD_S);
      await page.keyboard.up("w");
      await sleep(SETTLE_MS);
      const after = await pageFacts(page);
      mkdirSync(PICTURES, { recursive: true });
      await page.screenshot({ path: join(PICTURES, "after-holding-w.png") });
      const notices = after.toasts.filter((text) => STILL_HERE.test(text)).length;
      const through = pastPlane(place, after);
      // Every crossing at an offline destination ends in a refusal, after one check before leaving: one refusal is one crossing.
      expect(after.refusals.length === 1, `refused ${after.refusals.length} times while W was held for ${HELD_S} s`);
      expect(notices === 1, `${notices} notices that the walker is still here: ${JSON.stringify(after.toasts)}`);
      expect(after.location === "location-lobby", `the walker left the Lobby: in ${after.location}`);
      expect(through > THROUGH_M, `W did not take the walker on through the portal: it stands ${fixed(through)} m past it, from ${fixed(pastPlane(place, refusedAt))} m when the refusal came`);
      expect(ctx.pageErrors.length === 0, `uncaught error: ${[...new Set(ctx.pageErrors)].slice(0, 3).join(" | ")}`);
      await page.close();
      return `one refusal and one notice in ${HELD_S} s of W; walked on through the portal to ${fixed(through)} m past it, and stayed in the Lobby`;
    } },
];

const TRAVERSAL = "web/live-adapter-portal-traversal-controller.mjs";
const faults = [
  { statement: "exit-intent-hangs", name: "the exit-intent has no time limit", expect: /no refusal \d+ s after the plane/, edits: [{ file: TRAVERSAL, find: "packet = await withinLimit(posting, \"the exit-intent\");", replace: "packet = await posting;" }] },
  { statement: "exit-intent-hangs", name: "the walk during a crossing has no end", expect: /walked [\d.]+ m past the portal while the crossing hung/, edits: [{ file: TRAVERSAL, find: "Math.max(0, TRANSITION_WALK_LIMIT_M - walked)", replace: "Infinity" }] },
  { statement: "exit-intent-hangs", name: "the refused walker stays where the walk ended", expect: /stood [\d.]+ m past the portal after the refusal/, edits: [{ file: TRAVERSAL, find: "      host.avatar.position = clonePosition(crossingEntry.position, host.avatar.position);\n", replace: "" }] },
  { statement: "offline-backing-away", name: "the refused walker goes back to the crossing point, on the portal's plane", expect: /the refusal left the walker [\d.]+ m past the portal/, edits: [{ file: TRAVERSAL, find: "position: (runtime && runtime.lastClearPosition) || entryTransform.position };", replace: "position: entryTransform.position };" }] },
  { statement: "offline-backing-away", name: "the portal that refused announces itself over the reason", expect: /the reason gave way on screen/, edits: [{ file: TRAVERSAL, find: " && !ev.runtime.refused);", replace: ");" }] },
  { statement: "offline-backing-away", name: "a portal that refused stays quiet for good, even after the walker has left it", expect: /W did not bring refusal 2/, edits: [{ file: TRAVERSAL, find: "        refusedWalkIn = null;\n", replace: "" }] },
  { statement: "offline-held-w", name: "being put back counts as leaving the portal, so a held W is refused again and again", expect: /refused \d+ times while W was held/, edits: [{ file: TRAVERSAL, find: "        if (refusedWalkIn && refusedWalkIn.portal_key === ev.portal_key) continue;\n", replace: "" }] },
  { statement: "exit-intent-hangs", name: "a late exit-intent departs the player and nobody registers it again", expect: /the Lobby lost the player/, edits: [{ file: TRAVERSAL, find: "if (!handoffInFlight && !transition) registerAgain();", replace: "" }] },
  { statement: "exit-intent-errors", name: "a failed crossing says nothing", expect: /no refusal \d+ s after the plane/, edits: [{ file: TRAVERSAL, find: "    if (onCrossingRefused) onCrossingRefused({ kind: \"offline\", portal: crossingEntry && crossingEntry.portal, reason });\n", replace: "" }] },
  { statement: "exit-intent-malformed", name: "the crossing's failures go unhandled, as before", expect: /no refusal \d+ s after the plane/, edits: [{ file: TRAVERSAL, find: "    commitPortalHandoff().catch(crossingFailed);\n", replace: "    void commitPortalHandoff();\n" }] },
  { statement: "exit-intent-malformed", name: "a refused crossing does not register the departed player again", expect: /the Lobby does not hold the player/, edits: [{ file: TRAVERSAL, find: "    registerAgain();\n", replace: "" }] },
  { statement: "exit-intent-unreadable", name: "any answer is taken for a packet", expect: /the visitor left the Lobby/, edits: [{ file: TRAVERSAL, find: "    if (!isExitPacket(packet)) ", replace: "    if (false) " }] },
  { statement: "check-before-leaving-hangs", name: "the check before leaving has no time limit", expect: /no refusal \d+ s after the plane/, edits: [{ file: TRAVERSAL, find: "const gate = await withinLimit(crossingGate(crossingPortal), \"the check before leaving\");", replace: "const gate = await crossingGate(crossingPortal);" }] },
];

await runBehavior({ title: "crossing-failure", firstPort: 40400, statements, faults });
