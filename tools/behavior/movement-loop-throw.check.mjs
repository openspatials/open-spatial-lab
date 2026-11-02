// A throw in one frame of the movement loop must not stop the loop, as a Player with real keys.
//   node tools/behavior/movement-loop-throw.check.mjs [--faults] [--only id,id]
//
// The product has no way to throw on request, so the page is given a copy of the movement controller with two added
// lines. The copy is made as the file is served, from what the lab serves: a statement's own `code` would replace the
// copy a planted fault runs in.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { CODE, HarnessError, openPlayer } from "../arch-i4/main-demo/lab.mjs";
import { expect, faceYaw, fixed, holdKeys, pageFacts, planar, runBehavior, sleep, untilClock, waitUntil, walkTo } from "./kit.mjs";

const MOVE = "web/movement-camera-controller.mjs";
const STEP_LINE = "      capabilities.stepAvatar(input, deltaSeconds);\n";
const PREVIEW_LINE = "    if (isPlayer) sceneRuntime.renderPortalPreviews();\n";
const INJECTED = [
  [STEP_LINE, `      windowTarget.__throwInFrame?.("step");\n${STEP_LINE}`],
  [PREVIEW_LINE, `    windowTarget.__throwInFrame?.("late");\n${PREVIEW_LINE}`],
];

const HOLD_S = 0.6;
const WALKS_M = 0.48; // 0.84 m at 1.4 m/s
const STILL_M = 0.05;
const LONGER_THAN_ONE_FAULT_MS = 3000; // the product treats 2 s without a throw as the end of a fault
const NOTICE = /movement/i;
const PICTURE_DIR = join(CODE, ".runtime", "behavior", "movement-loop-throw");

/** A new Player on the Lobby's open floor, turned to walk along +X, given the copy with the two added lines. */
async function playerWithInjection(ctx) {
  const url = `${ctx.lab.front}/index.html?role=player&intro=bypass`;
  const page = await ctx.visit(url, { open: false });
  const cdp = await page.createCDPSession();
  let served = false;
  let notApplied = null;
  cdp.on("Fetch.requestPaused", async ({ requestId }) => {
    const { body, base64Encoded } = await cdp.send("Fetch.getResponseBody", { requestId });
    let source = base64Encoded ? Buffer.from(body, "base64").toString("utf8") : body;
    for (const [find, replace] of INJECTED) {
      if (!source.includes(find)) notApplied = find;
      source = source.replace(find, replace);
    }
    served = true;
    await cdp.send("Fetch.fulfillRequest", {
      requestId, responseCode: 200, responseHeaders: [{ name: "Content-Type", value: "text/javascript" }],
      body: Buffer.from(source).toString("base64"),
    });
  });
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*/movement-camera-controller.mjs*", requestStage: "Response" }] });
  await openPlayer(page, url);
  if (!served) throw new HarnessError("the page never asked for the movement controller");
  if (notApplied) throw new HarnessError(`the injected line no longer applies: ${JSON.stringify(notApplied)}`);
  await page.bringToFront();
  await walkTo(page, -1, 2);
  await faceYaw(page, Math.PI / 2);
  await sleep(300);
  return page;
}

const arm = (page, { at = "step", message, once = false }) => page.evaluate((options) => {
  window.__frameThrows = 0;
  window.__throwInFrame = (where) => {
    if (where !== options.at) return;
    window.__frameThrows += 1;
    if (options.once) window.__throwInFrame = null;
    throw new Error(options.message);
  };
}, { at, message, once });
const disarm = (page) => page.evaluate(() => { window.__throwInFrame = null; });
const throwsSoFar = (page) => page.evaluate(() => window.__frameThrows);

/** Wait for `count` throws since the last arm; a loop that stopped gives fewer. */
const untilThrown = (page, count) => waitUntil(async () => (await throwsSoFar(page)) >= count, async () => `the loop stopped after ${await throwsSoFar(page)} throw(s), wanted ${count}`, { limitMs: 30000 });

const reported = (ctx, message) => ctx.pageErrors.filter((text) => text.includes(message)).length;
const notices = async (page) => (await pageFacts(page)).toasts.filter((text) => NOTICE.test(text));

async function oneThrowWalksOn(ctx, at, where) {
  const message = `injected once ${where}`;
  const page = await playerWithInjection(ctx);
  await arm(page, { at, message, once: true });
  await untilThrown(page, 1);
  const walk = await holdKeys(page, ["w"], HOLD_S);
  expect(walk.distance > WALKS_M, `after one throw ${where} W walked ${fixed(walk.distance)} m in ${HOLD_S} s of loop time`);
  expect(reported(ctx, message) === 1, `one throw ${where} reached the console ${reported(ctx, message)} times`);
  let told = await notices(page);
  expect(told.length === 0, `a single throw told the player: "${told[0]}"`);
  await sleep(LONGER_THAN_ONE_FAULT_MS);
  await untilClock(page, 0.1);
  await arm(page, { at, message: `${message}, later`, once: true });
  await untilThrown(page, 1);
  await untilClock(page, 0.2);
  told = await notices(page);
  expect(told.length === 0, `two throws far apart told the player: "${told[0]}"`);
  await page.close();
  return `W walked ${fixed(walk.distance)} m after the throw; reached the console once; no message to the player`;
}

const statements = [
  { id: "one-throw-in-the-step", says: "One throw from the avatar step leaves W walking, is reported once and tells the player nothing", run: (ctx) => oneThrowWalksOn(ctx, "step", "in the avatar step") },
  { id: "one-throw-late-in-the-frame", says: "One throw from the portal previews, late in the frame, leaves W walking", run: (ctx) => oneThrowWalksOn(ctx, "late", "late in the frame") },
  { id: "every-frame-then-clears", says: "A throw in every frame reports each message once, tells the player in plain words, and W walks when it clears", async run(ctx) {
    const first = "injected every frame";
    const second = "injected for a while";
    const page = await playerWithInjection(ctx);
    await page.keyboard.down("w");
    await arm(page, { message: first });
    await untilThrown(page, 5);
    const frozenFrom = await untilClock(page, 0.2);
    const frozenTo = await untilClock(page, HOLD_S);
    const frozen = planar(frozenTo.position, frozenFrom.position);
    expect(frozen < STILL_M, `W walked ${fixed(frozen)} m with the avatar step throwing (the check would be vacuous)`);
    await arm(page, { message: second });
    await untilThrown(page, 5);
    await arm(page, { message: first });
    const told = await waitUntil(async () => { const seen = await notices(page); return seen.length > 0 && seen; }, "no plain message reached the player while every frame threw", { limitMs: 30000 });
    mkdirSync(PICTURE_DIR, { recursive: true });
    await page.screenshot({ path: join(PICTURE_DIR, "notice.png") });
    expect(!told[0].includes(first) && !told[0].includes(second), `the player was shown the raw error: "${told[0]}"`);
    await waitUntil(async () => (await notices(page)).length >= 2, "the message came once and the player is still stuck with no second message", { limitMs: 60000 });
    const throws = await throwsSoFar(page);
    expect(reported(ctx, first) === 1 && reported(ctx, second) === 1, `over ${throws} throws the first message was reported ${reported(ctx, first)} times and the second ${reported(ctx, second)} times`);
    await disarm(page);
    await untilClock(page, 0.1);
    const clearFrom = await pageFacts(page);
    const clearTo = await untilClock(page, HOLD_S);
    await page.keyboard.up("w");
    const walked = planar(clearTo.position, clearFrom.position);
    expect(walked > WALKS_M, `after the fault cleared W, still held, walked ${fixed(walked)} m in ${HOLD_S} s of loop time`);
    await page.close();
    return `over ${throws} more throws each message was reported once; told "${told[0]}", then again; held W walked ${fixed(walked)} m after it cleared, ${fixed(frozen)} m during it`;
  } },
];

const TOAST_LINE = 'showToast("Movement is not working", "Try reloading the page.", "failed");';
const faults = [
  { statement: "one-throw-in-the-step", name: "the old loop: no catch, the next frame asked for only at the end", expect: /after one throw in the avatar step W walked 0\.000 m/, edits: [{ file: MOVE, find: "    try {\n      stepFrame(timestamp);\n      frameFaults.clean(timestamp);\n    } catch (error) {\n      frameFaults.failed(error, timestamp);\n    } finally {\n      scheduleNextFrame();\n    }\n", replace: "    stepFrame(timestamp);\n    scheduleNextFrame();\n" }] },
  { statement: "one-throw-late-in-the-frame", name: "only the avatar step is guarded", expect: /after one throw late in the frame W walked 0\.000 m/, edits: [
    { file: MOVE, find: "    try {\n      stepFrame(timestamp);\n      frameFaults.clean(timestamp);\n    } catch (error) {\n      frameFaults.failed(error, timestamp);\n    } finally {\n      scheduleNextFrame();\n    }\n", replace: "    stepFrame(timestamp);\n    scheduleNextFrame();\n" },
    { file: MOVE, find: STEP_LINE, replace: `      try {\n${STEP_LINE}      } catch (error) {\n        frameFaults.failed(error, timestamp);\n      }\n` },
  ] },
  { statement: "one-throw-in-the-step", name: "the first throw already tells the player", expect: /a single throw told the player/, edits: [{ file: MOVE, find: "const FRAME_FAULT_NOTICE_AFTER_MS = 2000;", replace: "const FRAME_FAULT_NOTICE_AFTER_MS = 0;" }] },
  { statement: "one-throw-in-the-step", name: "a fault never ends, so a later throw counts as the same one", expect: /two throws far apart told the player/, edits: [{ file: MOVE, find: "timestamp - lastFaultAt >= FRAME_FAULT_OVER_AFTER_MS", replace: "false" }] },
  { statement: "every-frame-then-clears", name: "every throw goes to the console", expect: /the first message was reported [2-9]|the first message was reported \d\d/, edits: [{ file: MOVE, find: "!reported.has(message) && reported.size < FRAME_FAULT_DISTINCT_LIMIT", replace: "true" }] },
  { statement: "every-frame-then-clears", name: "only the first message of a fault is reported", expect: /the second 0 times/, edits: [{ file: MOVE, find: "!reported.has(message) && reported.size < FRAME_FAULT_DISTINCT_LIMIT", replace: "reported.size < 1" }] },
  { statement: "every-frame-then-clears", name: "the player is never told", expect: /no plain message reached the player/, edits: [{ file: MOVE, find: TOAST_LINE, replace: "void showToast;" }] },
  { statement: "every-frame-then-clears", name: "the player is told once, however long it lasts", expect: /the message came once/, edits: [{ file: MOVE, find: "const FRAME_FAULT_NOTICE_EVERY_MS = 15000;", replace: "const FRAME_FAULT_NOTICE_EVERY_MS = 3600000;" }] },
  { statement: "every-frame-then-clears", name: "the player is shown the raw error", expect: /the player was shown the raw error/, edits: [{ file: MOVE, find: TOAST_LINE, replace: 'showToast("Movement is not working", message, "failed");' }] },
  { statement: "every-frame-then-clears", name: "movement stays off after the message", expect: /after the fault cleared W, still held, walked 0\.000 m/, edits: [
    { file: MOVE, find: TOAST_LINE, replace: `${TOAST_LINE}\n        globalThis.__movementOff = true;` },
    { file: MOVE, find: "? { ...controlState, run: runModifierKeys.size > 0, camera_yaw: movementBasisYaw() }", replace: "? (globalThis.__movementOff ? { camera_yaw: movementBasisYaw() } : { ...controlState, run: runModifierKeys.size > 0, camera_yaw: movementBasisYaw() })" },
  ] },
];

await runBehavior({ title: "movement-loop-throw", firstPort: 40300, statements, faults });
