// The airport's two panels as a Player meets them, standing where each belongs: the storefront (press E at a counter,
// the movement keys let go while it is open) and the gate (the boarding journey tells the toasts, the notifications
// and the journal what happened). The Player joins at a node, as an address does, instead of walking 40 m.
import { allNodes } from "../arch-i4/main-demo/world-data.mjs";
import { expect, fixed, holdKeys, pageFacts, untilClock, waitUntil } from "./kit.mjs";
import { airportFacts, clickId, journalLines, notificationFacts, toastsSeen, watchToasts } from "./app-shell-facts.mjs";

const APP = "web/app.js";
const MOVEMENT = "web/movement-camera-controller.mjs";
const HOLD_S = 0.6;
const OPEN_PANEL_MOVED_M = 0.15; // a free walk covers about 1.4 m in this time
const FREE_WALK_M = 0.5;

/** The airport page with the Player standing at the first node whose label matches. */
async function standAt(ctx, label) {
  const node = (await allNodes(ctx.lab.address("airport"), 1)).find((entry) => label.test(entry.label || ""));
  expect(node, `the airport has no node named like ${label}`);
  const page = await ctx.visit(`${ctx.lab.front}/w/airport/?intro=bypass#join=node.${node.id}`);
  await watchToasts(page);
  return page;
}

/** Hold W for a moment of loop time and say how far it went. */
async function pushForward(page) {
  return (await holdKeys(page, ["w"], HOLD_S)).distance;
}

/** Walk forward, press E with W still held, and say how far the Player went in the time after the panel was open. */
async function distanceWhileOpening(page, panelShown, opened) {
  await page.keyboard.down("w");
  try {
    await untilClock(page, 0.1);
    await page.keyboard.press("e");
    await waitUntil(async () => panelShown(await airportFacts(page)), opened, { limitMs: 20000 });
    const before = await pageFacts(page);
    const after = await untilClock(page, HOLD_S);
    return Math.hypot(after.position[0] - before.position[0], after.position[2] - before.position[2]) * (HOLD_S / (after.clock - before.clock));
  } finally {
    await page.keyboard.up("w");
  }
}

async function shoppingStatement(ctx) {
  const page = await standAt(ctx, /Store Staff.*Skyline Coffee/);
  const near = await waitUntil(async () => { const facts = await airportFacts(page); return facts.nearestStore && facts.shopAffordance ? facts : null; }, "no storefront was within reach of a Player standing at the coffee counter", { limitMs: 30000 });
  const held = await distanceWhileOpening(page, (facts) => facts.openStore && facts.shopPanel, "pressing E at the counter opened no shop panel");
  const open = await airportFacts(page);
  expect(open.openStore === near.nearestStore, `E opened store ${open.openStore}, not the nearest, ${near.nearestStore}`);
  expect(held <= OPEN_PANEL_MOVED_M, `the Player kept walking ${fixed(held)} m with the shop panel open`);
  await page.keyboard.press("Escape");
  await waitUntil(async () => !(await airportFacts(page)).shopPanel, "Escape did not close the shop panel", { limitMs: 20000 });
  const freed = await pushForward(page);
  expect(freed >= FREE_WALK_M, `after the panel closed W walked only ${fixed(freed)} m (the check would be vacuous)`);
  await page.close();
  return `store ${near.nearestStore} opened with E; W held through the opening moved ${fixed(held)} m while open and ${fixed(freed)} m after the panel closed`;
}

async function boardingStatement(ctx) {
  const page = await standAt(ctx, /^Gate A12/);
  await waitUntil(async () => { const facts = await airportFacts(page); return facts.boardingPhase === "ready" && facts.boardingAffordance ? facts : null; }, "the gate never became ready for a Player standing at it", { limitMs: 30000 });
  const held = await distanceWhileOpening(page, (facts) => facts.boardingPanel, "pressing E at the gate opened no boarding panel");
  expect(held <= OPEN_PANEL_MOVED_M, `the Player kept walking ${fixed(held)} m with the boarding panel open`);
  await clickId(page, "btn-boarding-validate");
  await waitUntil(async () => (await toastsSeen(page)).some((toast) => /^Credential rejected/.test(toast.text)), "an empty credential showed no \"Credential rejected\" toast", { limitMs: 20000 });
  const published = await notificationFacts(page);
  expect(published.records.some((record) => record.event === "credential_rejected_missing"), `no notification recorded the rejected credential; the list has [${published.records.map((record) => record.event || record.kind).join(", ")}]`);
  const lines = await journalLines(page);
  expect(lines.some((line) => /airport boarding: credential_rejected_missing/.test(line)), "the activity journal has no line for the rejected credential");
  await page.keyboard.press("Escape");
  await waitUntil(async () => !(await airportFacts(page)).boardingPanel, "Escape did not close the boarding panel", { limitMs: 20000 });
  await page.close();
  return `gate ready, panel opened with E, the rejected credential reached the toast, the notifications and the journal; W held through the opening moved ${fixed(held)} m while open`;
}

export const airportStatements = [
  { id: "shop-panel", says: "At a storefront counter E opens the shop panel, the movement keys let go while it is open, and Escape closes it", run: shoppingStatement },
  { id: "boarding-journey", says: "At the gate the journey becomes ready, E opens its panel, and a rejected credential reaches the toast, the notifications and the journal", run: boardingStatement },
];

const BOARDING_WIRING = "  showToast,\n  publishNotification: publishNotificationRecord,\n  logger: logLine,\n  isTypingTarget,\n  nowIso:";
export const airportFaults = [
  { statement: "shop-panel", name: "a shop that is never told where the Player is", expect: /no storefront was within reach/, edits: [{ file: APP, find: "storefrontShoppingController.observe({", replace: "void ({" }] },
  { statement: "shop-panel", name: "movement keys that are not let go when a panel opens", expect: /kept walking [\d.]+ m with the shop panel open/, edits: [{ file: MOVEMENT, find: "releaseControls: resetControlState,", replace: "releaseControls: () => {}," }] },
  { statement: "boarding-journey", name: "a journey that is never told where the Player is", expect: /the gate never became ready/, edits: [{ file: APP, find: "boardingJourneyController.observe({", replace: "void ({" }] },
  { statement: "boarding-journey", name: "a journey whose records reach no notification center", expect: /no notification recorded the rejected credential/, edits: [{ file: APP, find: BOARDING_WIRING, replace: BOARDING_WIRING.replace("publishNotification: publishNotificationRecord,", "publishNotification: () => {},") }] },
  { statement: "boarding-journey", name: "a journey whose log lines go nowhere", expect: /the activity journal has no line for the rejected credential/, edits: [{ file: APP, find: BOARDING_WIRING, replace: BOARDING_WIRING.replace("logger: logLine,", "logger: () => {},") }] },
  { statement: "boarding-journey", name: "a journey that does not let the movement keys go", expect: /kept walking [\d.]+ m with the boarding panel open/, edits: [{ file: MOVEMENT, find: "releaseControls: resetControlState,", replace: "releaseControls: () => {}," }] },
];
