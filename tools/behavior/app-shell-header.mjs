// The panels around the world that a Player opens from the header: the Destinations panel, the notification center
// with the toast that points at it, the avatar selector's "none" choice, and what the page's teardown lets go of.
import { worldPortals } from "../arch-i4/main-demo/world-data.mjs";
import { expect, pageFacts, walkThrough, waitUntil } from "./kit.mjs";
import {
  clickDestination, clickId, clickNoneChoice, closeNotifications, destinationFacts, disposePage, noneChoiceFacts,
  notificationFacts, openNotification, stageFirstItem, toastsSeen, watchToasts,
} from "./app-shell-facts.mjs";

const APP = "web/app.js";
const CROSS_LIMIT_MS = 90000; // at two frames a second, 1.4 m takes 30 s

const lobbyUrl = (ctx) => `${ctx.lab.front}/index.html?role=player&intro=bypass`;
const labelsOf = (portals) => portals.map((portal) => portal.resource.label).sort();
const sameLabels = (buttons, portals) => labelsOf(portals).every((label) => buttons.some((text) => text.includes(label))) && buttons.length === portals.length;

const shellPage = (ctx) => ctx.once("shell-page", async () => {
  const page = await ctx.visit(lobbyUrl(ctx));
  await watchToasts(page);
  return page;
});

/** The one walk these statements share: from the Lobby through its portal to Location A, with the panel as it was left. */
const tripToA = (ctx) => ctx.once("shell-trip", async () => {
  const page = await shellPage(ctx);
  const portal = (await worldPortals(ctx.lab.address("lobby"))).find((entry) => entry.resource.label === "Portal to Location A");
  expect(portal, "the Lobby has no portal to Location A");
  const [x, , z] = portal.pose.position;
  const [fx, , fz] = portal.pose.forward;
  const seen = await walkThrough(page, { from: [x + fx * 1.4, z + fz * 1.4], yaw: Math.atan2(-fx, -fz), expect: "location-a", timeoutMs: CROSS_LIMIT_MS });
  expect(seen.location_id === "location-a", `the walk did not cross: still in ${seen.location_id} (timed out after ${CROSS_LIMIT_MS / 1000} s)`);
  return page;
});

async function destinationsStatement(ctx) {
  const page = await shellPage(ctx);
  const lobbyPortals = await worldPortals(ctx.lab.address("lobby"));
  await clickId(page, "btn-semantic-destinations");
  const opened = await waitUntil(async () => { const facts = await destinationFacts(page); return facts.shown ? facts : null; }, "the Destinations toggle opened nothing", { limitMs: 20000 });
  expect(opened.expanded === "true" && /^Lobby/.test(opened.world), `the open panel names "${opened.world}" (toggle ${opened.expanded}), not the Lobby`);
  expect(sameLabels(opened.buttons, lobbyPortals), `the panel lists [${opened.buttons.join("; ")}] for the Lobby's portals [${labelsOf(lobbyPortals).join("; ")}]`);
  await clickDestination(page, 1); // the second portal is not the one the Player stands at, so this is wayfinding
  const wayfinding = await waitUntil(async () => { const facts = await destinationFacts(page); return /No crossing occurred/.test(facts.status) ? facts : null; }, async () => `choosing a destination away from its portal did not say that no crossing occurred; the panel says "${(await destinationFacts(page)).status}"`, { limitMs: 20000 });
  expect((await pageFacts(page)).location === "location-lobby", "choosing a destination in the panel moved the Player out of the Lobby");
  await clickId(page, "btn-semantic-destinations");
  expect(!(await destinationFacts(page)).shown, "a second press of the toggle did not close the panel");
  await clickId(page, "btn-semantic-destinations");
  expect((await destinationFacts(page)).shown, "a third press of the toggle did not open the panel again");
  await tripToA(ctx);
  const moved = await waitUntil(async () => { const facts = await destinationFacts(page); return /^Location A/.test(facts.world) ? facts : null; }, async () => `the open panel still names "${(await destinationFacts(page)).world}" after the crossing into Location A`, { limitMs: 30000 });
  const alsoPortals = await worldPortals(ctx.lab.address("a"));
  expect(sameLabels(moved.buttons, alsoPortals) && /changed to Location A/.test(moved.status), `after the crossing the panel lists [${moved.buttons.join("; ")}] and says "${moved.status}"`);
  return `the Lobby's ${lobbyPortals.length} destinations, no crossing from the panel, and Location A's ${alsoPortals.length} after the walk (${wayfinding.status.slice(0, 40)}...)`;
}

async function notificationsStatement(ctx) {
  const page = await tripToA(ctx);
  const arrival = await waitUntil(async () => (await toastsSeen(page)).find((toast) => /^ARRIVED/.test(toast.text)), "no arrival toast was shown for the crossing", { limitMs: 20000 });
  const shown = await waitUntil(async () => { const facts = await notificationFacts(page); return facts.records.length > 0 ? facts : null; }, "no notification record was published for the crossing", { limitMs: 20000 });
  expect(shown.count === shown.records.length && shown.bodyCount === String(shown.count) && Number(shown.badge) === Math.min(shown.count, 99), `the count says ${shown.count}, the list ${shown.records.length}, the badge ${shown.badge}, the page ${shown.bodyCount}`);
  const target = shown.records[shown.records.length - 1].id;
  await openNotification(page, target);
  const opened = await notificationFacts(page);
  expect(opened.open && opened.centerShown && opened.pressed === "true" && opened.selected === target && opened.detail.length > 0, `opening the record left the center open ${opened.open}, shown ${opened.centerShown}, selected ${opened.selected}, detail ${opened.detail.length} characters`);
  await page.keyboard.press("Escape");
  expect(!(await notificationFacts(page)).centerShown, "Escape did not close the notification center");
  await clickId(page, "btn-notifications");
  expect((await notificationFacts(page)).centerShown, "the header button did not open the notification center");
  await closeNotifications(page);
  const closed = await notificationFacts(page);
  expect(!closed.open && !closed.centerShown && closed.pressed === "false", `closing left the center open ${closed.open}, shown ${closed.centerShown}, pressed ${closed.pressed}`);
  return `the "${arrival.text.slice(0, 24)}" toast was shown; ${shown.count} records; open, Escape, button and close agree`;
}

async function disposeStatement(ctx) {
  const page = await ctx.visit(lobbyUrl(ctx));
  const panels = [["btn-semantic-destinations", async () => (await destinationFacts(page)).shown, "Destinations panel"], ["btn-notifications", async () => (await notificationFacts(page)).centerShown, "notification center"]];
  for (const [button, isShown, name] of panels) {
    await clickId(page, button);
    expect(await isShown(), `before the teardown the ${name} did not open`);
    await clickId(page, button);
    expect(!(await isShown()), `before the teardown the ${name} did not close`);
  }
  await disposePage(page);
  for (const [button, isShown, name] of panels) {
    await clickId(page, button);
    expect(!(await isShown()), `after the page was torn down the ${name} still opened`);
  }
  await page.close();
  return "both header buttons work, and neither does anything after the page's teardown";
}

async function noneChoiceStatement(ctx) {
  const page = await ctx.visit(lobbyUrl(ctx));
  await clickId(page, "btn-switch-avatar");
  const none = await waitUntil(() => noneChoiceFacts(page), "the avatar selector shows no choice for no equipment", { limitMs: 30000 });
  expect(/none/i.test(none.label) && /remove all equipment/i.test(none.label) && /remove all equipped items/i.test(none.ariaLabel), `the choice says "${none.label}" with the name "${none.ariaLabel}"`);
  expect(await stageFirstItem(page), "the selector offers no equipment to stage, so the check would be vacuous");
  await waitUntil(async () => !(await noneChoiceFacts(page)).staged, "staging an item left the none choice marked as staged", { limitMs: 10000 });
  await clickNoneChoice(page);
  const cleared = await waitUntil(async () => { const facts = await noneChoiceFacts(page); return facts.staged ? facts : null; }, "pressing None left equipment staged", { limitMs: 10000 });
  await page.close();
  return `"${cleared.status}" after staging an item and pressing None`;
}

export const headerStatements = [
  { id: "destinations-panel", says: "The Destinations panel opens at its toggle, lists the world's portals, says that no crossing occurred, and follows the Player into the next world", run: destinationsStatement },
  { id: "crossing-notifications", says: "A crossing shows an arrival toast and publishes records, and the notification center opens, selects and closes as the list says", run: notificationsStatement },
  { id: "teardown-releases-panels", says: "After the page's teardown the header buttons for the Destinations panel and the notification center do nothing", run: disposeStatement },
  { id: "none-choice", says: "The avatar selector's None choice is worded as removing all equipment and clears staged equipment", run: noneChoiceStatement },
];

export const headerFaults = [
  { statement: "destinations-panel", name: "a panel that is never mounted", expect: /the Destinations toggle opened nothing/, edits: [{ file: APP, find: "semanticDestinationsController.mount();", replace: "void semanticDestinationsController;" }] },
  { statement: "destinations-panel", name: "a panel that is not told the world changed", expect: /the open panel still names "Lobby/, edits: [{ file: APP, find: "semanticDestinationsController.update({", replace: "void ({" }] },
  { statement: "crossing-notifications", name: "records that are never published", expect: /no notification record was published for the crossing/, edits: [{ file: APP, find: "notificationToastController.publish(record);", replace: "void record;" }] },
  { statement: "crossing-notifications", name: "toasts that are never shown", expect: /no arrival toast was shown/, edits: [{ file: APP, find: "notificationToastController.show(big, sub, cls, opts);", replace: "void big;" }] },
  { statement: "crossing-notifications", name: "a center that the page's open call does not open", expect: /opening the record left the center open false/, edits: [{ file: APP, find: "open: (id) => openNotificationCenter(id),", replace: "open: () => {}," }] },
  { statement: "teardown-releases-panels", name: "a Destinations panel the teardown does not release", expect: /after the page was torn down the Destinations panel still opened/, edits: [{ file: APP, find: "    semanticDestinationsController,\n    runtimeTweakController,", replace: "    runtimeTweakController," }] },
  { statement: "teardown-releases-panels", name: "a notification center the teardown does not release", expect: /after the page was torn down the notification center still opened/, edits: [{ file: APP, find: "    notificationToastController,\n  ]) {", replace: "  ]) {" }] },
  { statement: "none-choice", name: "a None choice that clears nothing", expect: /pressing None left equipment staged/, edits: [{ file: APP, find: "applyNoEquipmentChoice: (items) => applyNoEquipmentChoice(items),", replace: "applyNoEquipmentChoice: (items) => items," }] },
  { statement: "none-choice", name: "a None choice with other words", expect: /the choice says "Gear/, edits: [{ file: APP, find: "noEquipmentChoice: NO_EQUIPMENT_CHOICE,", replace: "noEquipmentChoice: { ...NO_EQUIPMENT_CHOICE, label: \"Gear\" }," }] },
];
