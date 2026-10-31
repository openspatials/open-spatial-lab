// A crossing's guards run after the adapter has moved, so a guard that fails cannot undo the crossing. The screen must
// still end in the world the adapter is in, the visitor must be told, and the failure must be on record.
// A real packet cannot miss these guards: the exit-intent's answer carries no frames (the page adds them to the packet) and
// the avatar always lands on the exit pose. So each statement changes the crossing's record as the adapter dispatches it.
// Run: node tools/behavior/crossing-guard-failure.check.mjs [--faults] [--only id,id]
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { CODE } from "../arch-i4/main-demo/lab.mjs";
import { worldPortals } from "../arch-i4/main-demo/world-data.mjs";
import { expect, fixed, holdKeys, inRange, pageFacts, runBehavior, sleep } from "./kit.mjs";
import { lobbyUrl, portalNamed, walkInto } from "./crossing-walk.mjs";
import { sceneFacts } from "./page-reads.mjs";

const MISS_M = 0.06; // past the guards' 0.05 m
const SETTLE_MS = 4000;
const WALK_AWAY_M = [1.0, 1.7]; // over 0.6 s of the movement loop's time, at 2.35 m/s
const PROBLEM = /Crossing check failed/;
const PICTURES = join(CODE, ".runtime", "behavior", "crossing-guard-failure", "pictures");

const guardFailures = (page) => page.evaluate(() => {
  const assembly = window.__assembly;
  return assembly.crossingGuardFailures ? assembly.crossingGuardFailures() : [];
});

async function picture(page, name) {
  mkdirSync(PICTURES, { recursive: true });
  await page.screenshot({ path: join(PICTURES, `${name}.png`) }).catch(() => {});
}

/** The first composition crossing the adapter dispatches gets this change. Later crossings are clean. */
const atFirstDispatch = (kind) => (page) => page.evaluate((chosen, miss) => {
  const adapter = window.__assembly.adapter;
  const changes = {
    // The guards' 5 cm: the record's exit pose is `miss` from where the avatar stands.
    "exit-pose-moved": (detail) => {
      const pose = detail.exit_pose;
      detail.exit_pose = { ...pose, position: [pose.position[0] + miss, pose.position[1], pose.position[2]] };
    },
    // The walker stands `miss` inside the distance the record says is safe.
    "lands-inside": (detail) => {
      const pose = detail.exit_pose;
      const policy = pose.landing_policy;
      detail.exit_pose = { ...pose, landing_policy: { ...policy, trigger_depth_m: policy.standoff_m - policy.actor_clearance_m + miss } };
    },
    "no-landing-policy": (detail) => { detail.exit_pose = { ...detail.exit_pose, landing_policy: null }; },
    "no-heading": (detail) => { detail.heading_continuity = null; },
    // The first read of the adapter's state throws: a guard breaks in a way nobody wrote down.
    "guard-breaks": () => {
      const read = adapter.debugState;
      adapter.debugState = () => { adapter.debugState = read; throw new Error("a guard broke"); };
    },
  };
  const send = adapter.dispatchEvent.bind(adapter);
  let used = false;
  adapter.dispatchEvent = (event) => {
    if (!used && event.type === "crossing" && event.detail.kind === "world_navigator_composition_crossing") {
      used = true;
      changes[chosen](event.detail);
    }
    return send(event);
  };
}, kind, MISS_M);

const objectIds = async (lab, key) => (await (await fetch(`${lab.address(key)}demo/scene-objects`)).json()).objects.map((o) => o.object_id);

/** Walk from the Lobby into Location A with `prepare` applied, and read the page after it has settled. */
async function crossToA(ctx, name, prepare) {
  ctx.pageErrors.length = 0;
  const page = await ctx.visit(lobbyUrl(ctx.lab));
  const portal = portalNamed(await worldPortals(ctx.lab.address("lobby")), "Portal to Location A");
  const start = await pageFacts(page, { with: ["objects"] });
  expect(start.objects.length > 0, "the Lobby showed no objects before the crossing (the check would be vacuous)");
  await prepare(page);
  await walkInto(page, portal, "location-a");
  await picture(page, `${name}-arrived`);
  await sleep(SETTLE_MS);
  await picture(page, `${name}-settled`);
  return { page, start, settled: await pageFacts(page, { with: ["objects"] }) };
}

/** The screen is in the world the adapter is in. With the fault planted, the header and the rooms stay the Lobby's. */
async function expectScreenInA(ctx, { page, start, settled }) {
  const { lab } = ctx;
  const name = lab.world("a").name;
  expect(settled.location === "location-a", `the adapter is in ${settled.location}`);
  expect(new RegExp(name).test(settled.title), `the adapter is in Location A and the header says "${settled.title}"`);
  const { sceneGraph, crossingGraph } = await sceneFacts(page);
  expect(sceneGraph && crossingGraph && sceneGraph.spatialId === crossingGraph.spatialId, `the page's scene graph is ${JSON.stringify(sceneGraph)}, the crossing's ${JSON.stringify(crossingGraph)}`);
  const left = start.objects.filter((id) => settled.objects.includes(id));
  expect(left.length === 0, `the Lobby's objects are still shown: ${left.join(", ")}`);
  const wanted = await objectIds(lab, "a");
  const missing = wanted.filter((id) => !settled.objects.includes(id));
  expect(missing.length === 0, `Location A's objects are not shown: ${missing.join(", ")}`);
  return name;
}

/** The whole outcome of a failed guard: same world on screen, the visitor told, the reason on record, the walker free. */
async function expectToldAndFree(ctx, crossed, reasons) {
  const name = await expectScreenInA(ctx, crossed);
  const { page, settled } = crossed;
  const told = settled.toasts.find((text) => PROBLEM.test(text));
  expect(told, `no message to the visitor: toasts ${JSON.stringify(settled.toasts)}`);
  const afterwards = settled.toasts.slice(settled.toasts.indexOf(told) + 1);
  expect(afterwards.length === 0, `the message was not the last thing shown: then ${JSON.stringify(afterwards)}`);
  expect(told.includes(`You are in ${name}`), `the message does not say where the visitor is: "${told}"`);
  const failures = await guardFailures(page);
  expect(failures.length === 1, `${failures.length} failed crossings on record, not 1: ${JSON.stringify(failures)}`);
  const said = failures[0].failures.join(" | ");
  for (const reason of reasons) expect(reason.test(said), `no failure on record for ${reason}: "${said}"`);
  expect(failures[0].handoff_id, `the record names no handoff: ${JSON.stringify(failures[0])}`);
  const away = await holdKeys(page, ["w"], 0.6);
  expect(inRange(away.distance, WALK_AWAY_M), `could not walk afterward: W moved ${fixed(away.distance)} m, not ${WALK_AWAY_M.join(" to ")} m`);
  expect(ctx.pageErrors.length === 0, `uncaught error: ${[...new Set(ctx.pageErrors)].slice(0, 3).join(" | ")}`);
  return `"${told}"; on record: ${said}; W walked ${fixed(away.distance)} m`;
}

const statements = [
  { id: "valid-crossing-is-quiet", says: "A valid crossing records no failure and says nothing about one", async run(ctx) {
    const crossed = await crossToA(ctx, "valid", async () => null);
    await expectScreenInA(ctx, crossed);
    const failures = await guardFailures(crossed.page);
    expect(failures.length === 0, `a valid crossing reported a failed guard: ${JSON.stringify(failures)}`);
    const told = crossed.settled.toasts.find((text) => PROBLEM.test(text));
    expect(!told, `a valid crossing told the visitor: "${told}"`);
    expect(ctx.pageErrors.length === 0, `uncaught error: ${[...new Set(ctx.pageErrors)].slice(0, 3).join(" | ")}`);
    await crossed.page.close();
    return `in ${crossed.settled.title}, no failure on record`;
  } },
  { id: "record-misses-5-cm", says: "An exit pose 6 cm from the avatar misses the 5 cm tolerances, and the screen still ends in the destination", async run(ctx) {
    const crossed = await crossToA(ctx, "record-misses", atFirstDispatch("exit-pose-moved"));
    const result = await expectToldAndFree(ctx, crossed, [/dispatch drift 0\.0600 m exceeds 0\.05 m/, /crossing heading guard: source_mapping_mismatch/]);
    await crossed.page.evaluate(() => document.getElementById("btn-notifications").click());
    await sleep(300);
    const center = await crossed.page.evaluate(() => document.getElementById("notification-center").textContent.replace(/\s+/g, " "));
    await picture(crossed.page, "record-misses-notifications");
    expect(/Crossing check failed/.test(center) && /dispatch drift/.test(center), `the notification center does not hold it: ${center.slice(0, 300)}`);
    await crossed.page.close();
    return `${result}; the notification center holds it`;
  } },
  { id: "lands-inside-boundary", says: "A landing 6 cm inside the safe distance: the screen ends in the destination, and the way back is clean", async run(ctx) {
    const crossed = await crossToA(ctx, "lands-inside", atFirstDispatch("lands-inside"));
    const result = await expectToldAndFree(ctx, crossed, [/portal landing guard: [\d.]+ m is inside the [\d.]+ m trigger-plus-clearance boundary/]);
    const { page, start } = crossed;
    const back = portalNamed(await worldPortals(ctx.lab.address("a")), "Portal to Lobby");
    await walkInto(page, back, "location-lobby");
    await sleep(SETTLE_MS);
    const home = await pageFacts(page, { with: ["objects"] });
    const missing = start.objects.filter((id) => !home.objects.includes(id));
    expect(missing.length === 0, `back in the Lobby, its objects are not shown: ${missing.join(", ")}`);
    const failures = await guardFailures(page);
    expect(failures.length === 1, `the clean way back added a failure: ${JSON.stringify(failures)}`);
    expect(ctx.pageErrors.length === 0, `uncaught error: ${[...new Set(ctx.pageErrors)].slice(0, 3).join(" | ")}`);
    await page.close();
    return `${result}; the way back shows the Lobby, with no new failure`;
  } },
  { id: "no-landing-policy", says: "A crossing with no landing policy: the screen ends in the destination", async run(ctx) {
    const crossed = await crossToA(ctx, "no-policy", atFirstDispatch("no-landing-policy"));
    const result = await expectToldAndFree(ctx, crossed, [/portal landing guard: canonical traversed-edge policy unavailable/]);
    await crossed.page.close();
    return result;
  } },
  { id: "no-heading-record", says: "A crossing with no heading record fails the heading guard: the screen ends in the destination", async run(ctx) {
    const crossed = await crossToA(ctx, "no-source-frame", atFirstDispatch("no-heading"));
    const result = await expectToldAndFree(ctx, crossed, [/crossing heading guard: source_heading_continuity_unavailable/]);
    await crossed.page.close();
    return result;
  } },
  { id: "guard-breaks", says: "A guard that breaks in a way nobody wrote down: the screen ends in the destination", async run(ctx) {
    const crossed = await crossToA(ctx, "guard-breaks", atFirstDispatch("guard-breaks"));
    const result = await expectToldAndFree(ctx, crossed, [/a guard broke/]);
    await crossed.page.close();
    return result;
  } },
];

const APP = "web/app.js";
const THROWS_AGAIN = { file: APP, find: "    failures.push(`${guard.name} broke: ${error.message}`);\n    return null;\n", replace: "    throw error;\n" };
const faults = [
  { statement: "record-misses-5-cm", name: "the landing guard throws again, as before", expect: /the adapter is in Location A and the header says "Lobby/, edits: [THROWS_AGAIN, { file: APP, find: "record.guard_failure = `portal landing guard: dispatch drift ${correctionM.toFixed(4)} m exceeds 0.05 m`;", replace: "throw new Error(`portal landing guard: dispatch drift ${correctionM.toFixed(4)} m exceeds 0.05 m`);" }] },
  { statement: "record-misses-5-cm", name: "the drift tolerance is 50 cm", expect: /no failure on record for .*dispatch drift/, edits: [{ file: APP, find: "} else if (correctionM > 0.05) {", replace: "} else if (correctionM > 0.5) {" }] },
  { statement: "record-misses-5-cm", name: "a failure the visitor never hears of", expect: /no message to the visitor/, edits: [{ file: APP, find: "  showToast(\"Crossing check failed\", sentence, \"failed\", { notificationId });\n", replace: "" }] },
  { statement: "record-misses-5-cm", name: "the arrival toast replaces the message at once", expect: /the message was not the last thing shown/, edits: [{ file: APP, find: "  recomposeActiveWorldScene(detail.kind || \"crossing\");\n  onState(adapter.debugState());\n  // After onState, whose arrival toast would replace this one.\n  if (guardFailures.length > 0) reportCrossingGuardFailures(detail, guardFailures);\n", replace: "  if (guardFailures.length > 0) reportCrossingGuardFailures(detail, guardFailures);\n  recomposeActiveWorldScene(detail.kind || \"crossing\");\n  onState(adapter.debugState());\n" }] },
  { statement: "record-misses-5-cm", name: "the notification center is not told", expect: /the notification center does not hold it/, edits: [{ file: APP, find: "  publishNotificationRecord({ id: notificationId, kind: \"crossing_check_failed\"", replace: "  void ({ id: notificationId, kind: \"crossing_check_failed\"" }] },
  { statement: "lands-inside-boundary", name: "the failure is not recorded", expect: /0 failed crossings on record/, edits: [{ file: APP, find: "  crossingGuardFailures.push({ at, handoff_id: detail.handoff_id || null, failures });\n", replace: "" }] },
  { statement: "lands-inside-boundary", name: "the safe distance is not checked", expect: /no message to the visitor/, edits: [{ file: APP, find: "} else if (standoffM + 1e-6 < safeMinimumM) {", replace: "} else if (false) {" }] },
  { statement: "no-landing-policy", name: "the landing policy is not asked for", expect: /no message to the visitor/, edits: [{ file: APP, find: "    if (!record.parity.supported) {\n      record.guard_failure", replace: "    if (false) {\n      record.guard_failure" }] },
  { statement: "no-heading-record", name: "the heading guard says nothing", expect: /no message to the visitor/, edits: [{ file: APP, find: "  if (!record || !record.validated || record.changed) {\n    lastCrossingHeadingContinuity.guard_failure", replace: "  if (false) {\n    lastCrossingHeadingContinuity.guard_failure" }] },
  { statement: "guard-breaks", name: "a guard that breaks is not caught", expect: /the adapter is in Location A and the header says "Lobby/, edits: [THROWS_AGAIN] },
  { statement: "valid-crossing-is-quiet", name: "every crossing reports a failure", expect: /a valid crossing reported a failed guard/, edits: [{ file: APP, find: "  if (guardFailures.length > 0) reportCrossingGuardFailures", replace: "  reportCrossingGuardFailures" }] },
];

await runBehavior({ title: "crossing-guard-failure", firstPort: 40440, statements, faults });
