// What a Player's page says about its connection, and how it first looks: the first frame, loading, a world that does
// not answer, a world that stops answering, the browser going offline, and the inspector that starts closed.
import { expect, sleep, waitUntil } from "./kit.mjs";
import { clickId, connectionFacts, disposePage, expectShown, inspectorFacts, interceptRequests, loadPlayer, offlineEvent, untilAssembled, untilConnection } from "./app-shell-facts.mjs";

const BOOT_REQUEST = "/api/lobby/wow/world"; // the first thing the page asks the Lobby for
const POLLED_REQUEST = "/api/lobby/wow/view/1"; // asked again every few seconds for as long as the page is open
const APP = "web/app.js";
const WORLD_UNANSWERED = /World connection unavailable/;

const playerUrl = (ctx) => `${ctx.lab.front}/index.html?role=player`;
const blankPage = (ctx) => ctx.visit(null, { open: false });

/** A page whose requests the check controls, on its way to the Lobby's Player view. */
async function interceptedPlayer(ctx, rule) {
  const page = await blankPage(ctx);
  const requests = await interceptRequests(page);
  if (rule) requests.set(...rule);
  await loadPlayer(page, playerUrl(ctx));
  return { page, requests };
}

async function firstFrameStatement(ctx) {
  const page = await blankPage(ctx);
  await loadPlayer(page, playerUrl(ctx));
  const shown = await untilConnection(page, (facts) => facts.firstFrame, "the first frame never showed", 120000);
  expect(shown.title && shown.firstFrame.includes(`You’re in ${shown.title}`), `the first frame does not name the world: "${shown.firstFrame}" (header says "${shown.title}")`);
  expect(/W A S D to walk/.test(shown.firstFrame) && /drag to look/.test(shown.firstFrame) && /scroll to zoom/.test(shown.firstFrame), `the first frame does not show the keys: "${shown.firstFrame}"`);
  expect(shown.startButton, "the first frame offers no way to start");
  expectShown(shown, "live", "Live backend", "a healthy world");
  expect(shown.provenance === "live" && /live/.test(shown.footer), `the provenance says "${shown.provenance}" and the footer "${shown.footer}"`);
  expect(/^\/api\//.test(shown.backend), `a live page names its backend as "${shown.backend}"`);
  await page.keyboard.press("w");
  await untilConnection(page, (facts) => !facts.firstFrame, "the first frame stayed after the W key", 30000);
  await page.close();
  return `named "${shown.title}", showed the keys, claimed ${shown.header}, and went away at the W key`;
}

async function loadingStatement(ctx) {
  const { page, requests } = await interceptedPlayer(ctx, [BOOT_REQUEST, "hold"]);
  await waitUntil(() => requests.heldCount() > 0, "the page never asked for its world", { limitMs: 60000 });
  const loading = await connectionFacts(page);
  expect(loading.state === "loading" && loading.header === "Loading" && loading.provenance === "loading", `while the world has not answered the page claims "${loading.state}" / "${loading.header}" / "${loading.provenance}", not loading`);
  expect(/Opening your world/.test(loading.card) && loading.cardRole === "status" && !loading.firstFrame, `the loading card says "${loading.card}" (role ${loading.cardRole}), first frame ${loading.firstFrame}`);
  expect(!/^\/api\//.test(loading.backend) && /loading/.test(loading.footer), `while loading the page names its backend "${loading.backend}" and the footer says "${loading.footer}"`);
  requests.release();
  const live = await untilConnection(page, (facts) => facts.state === "live", "the page never went live after the world answered", 120000);
  await page.close();
  return `loading while waiting, then ${live.header}`;
}

/** Fail the Lobby's boot request one way and check what the page says. The page is left open for the caller. */
async function bootFailure(ctx, action, expectedState, header, wording) {
  const { page, requests } = await interceptedPlayer(ctx, [BOOT_REQUEST, action]);
  const shown = await untilConnection(page, (facts) => facts.state !== "loading" && facts.state !== null, "the page said nothing about the failed boot", 90000);
  expect(shown.state === expectedState && shown.header === header, `the boot failed (${action}) but the page says "${shown.state}" / "${shown.header}", not "${expectedState}"`);
  expect(wording.test(shown.card) && shown.cardRole === "alert" && shown.retry && !shown.firstFrame, `the failure card says "${shown.card}" (role ${shown.cardRole}, retry ${shown.retry})`);
  expect(shown.title === "Player world unavailable", `the header still says "${shown.title}"`);
  expect(!/^\/api\//.test(shown.backend) && shown.footer.includes(expectedState), `after the failed boot the page names its backend "${shown.backend}" and the footer says "${shown.footer}"`);
  return { page, requests };
}

async function bootFailureStatement(ctx) {
  const unanswered = await bootFailure(ctx, "abort", "disconnected", "Disconnected", WORLD_UNANSWERED);
  const broken = await bootFailure(ctx, "500", "unavailable", "Temporarily unavailable", /temporarily unavailable/);
  await broken.page.close();
  const { page, requests } = unanswered;
  requests.clear();
  await page.evaluate(() => { window.__beforeRetry = true; });
  const reloaded = page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30000 }).then(() => true, () => false);
  await clickId(page, "btn-connection-retry");
  expect(await reloaded, "the retry button did not reload the page");
  const live = await untilConnection(page, (facts) => facts.state === "live", "the page never went live after the retry", 120000);
  await page.close();
  return `unanswered: disconnected; HTTP 500: unavailable; retry reloaded into "${live.header}"`;
}

async function afterBootStatement(ctx) {
  const { page, requests } = await interceptedPlayer(ctx, null);
  await untilConnection(page, (facts) => facts.state === "live", "the page never went live", 120000);
  requests.set(POLLED_REQUEST, "abort");
  const stopped = await untilConnection(page, (facts) => facts.state !== "live", "the page stayed live after the world stopped answering", 90000);
  expect(stopped.state === "disconnected" && stopped.cardRole === "alert" && stopped.retry, `a world that stopped answering shows "${stopped.state}" (role ${stopped.cardRole}, retry ${stopped.retry})`);
  requests.set(POLLED_REQUEST, "500");
  const broken = await untilConnection(page, (facts) => facts.state === "unavailable", "the page stayed live after the world answered with an error", 90000);
  expect(broken.header === "Temporarily unavailable" && broken.cardRole === "alert", `an erroring world shows "${broken.header}" (role ${broken.cardRole})`);
  requests.clear();
  const again = await untilConnection(page, (facts) => facts.state === "live", "the page never recovered once the world answered again", 90000);
  await page.close();
  return `disconnected, then unavailable, then ${again.header} again`;
}

async function livePlayer(ctx) {
  const page = await blankPage(ctx);
  await loadPlayer(page, playerUrl(ctx));
  await untilConnection(page, (facts) => facts.state === "live", "the page never went live", 120000);
  await untilAssembled(page);
  return page;
}

async function offlineStatement(ctx) {
  const watching = await livePlayer(ctx);
  await offlineEvent(watching);
  const offline = await untilConnection(watching, (facts) => facts.state === "disconnected", "the page stayed live when the browser went offline", 20000);
  expect(/This browser is offline/.test(offline.card), `the offline card says "${offline.card}"`);
  await watching.close();
  const closed = await livePlayer(ctx);
  await disposePage(closed);
  await offlineEvent(closed);
  const after = await connectionFacts(closed);
  expect(after.state === "live", `after the page was torn down the offline event still changed it to "${after.state}"`);
  await closed.close();
  return "offline shows the disconnected card; after the page's teardown the event changes nothing";
}

const inspectorIsClosed = (facts) => /rail-collapsed/.test(facts.appClass) && facts.expanded === "false" && facts.display === "none";

/** The inspector of a page whose world has not answered yet: it must not be open while the Player waits. */
async function inspectorWhileLoading(ctx) {
  const { page, requests } = await interceptedPlayer(ctx, [BOOT_REQUEST, "hold"]);
  await waitUntil(() => requests.heldCount() > 0, "the page never asked for its world", { limitMs: 60000 });
  const waiting = await inspectorFacts(page);
  expect(inspectorIsClosed(waiting), `the inspector is open while the world has not answered: class "${waiting.appClass}", toggle ${waiting.expanded}, display ${waiting.display}`);
  requests.release();
  await page.close();
}

async function inspectorStatement(ctx) {
  await inspectorWhileLoading(ctx);
  const seen = [];
  for (const [name, query] of [["player", "role=player"], ["source", "role=source&active=source&intro=0"]]) {
    const page = await blankPage(ctx);
    await loadPlayer(page, `${ctx.lab.front}/index.html?${query}`);
    await untilAssembled(page);
    await sleep(1500);
    const closed = await inspectorFacts(page);
    expect(inspectorIsClosed(closed), `the ${name} view starts with the inspector open: class "${closed.appClass}", toggle ${closed.expanded}, display ${closed.display}`);
    await clickId(page, "btn-rail-toggle");
    const opened = await waitUntil(async () => { const facts = await inspectorFacts(page); return facts.display !== "none" ? facts : null; }, `the ${name} view's inspector toggle opens nothing`, { limitMs: 20000 });
    expect(!/rail-collapsed/.test(opened.appClass) && opened.expanded === "true", `the ${name} inspector opened but says class "${opened.appClass}", toggle ${opened.expanded}`);
    seen.push(name);
    await page.close();
  }
  return `closed while the world loads; ${seen.join(" and ")} views start closed and open at the toggle`;
}

export const connectionStatements = [
  { id: "first-frame", says: "A Player's first frame names the world, shows the keys, claims live, and a key press dismisses it", run: firstFrameStatement },
  { id: "loading-is-not-live", says: "While the world has not answered, the page says loading, not live", run: loadingStatement },
  { id: "boot-failure", says: "A world that does not answer, or answers with an error, shows a failure card with a retry that reloads", run: bootFailureStatement },
  { id: "failure-after-boot", says: "A world that stops answering, or starts erroring, shows it, and the page recovers when it answers again", run: afterBootStatement },
  { id: "offline-is-managed", says: "Going offline shows the disconnected card, and a torn-down page no longer listens", run: offlineStatement },
  { id: "inspector-starts-closed", says: "The inspector is closed while the world loads, starts closed for a Player and for a source view, and its toggle opens it", run: inspectorStatement },
];

export const connectionFaults = [
  { statement: "first-frame", name: "a key press that leaves the first frame up", expect: /stayed after the W key/, edits: [{ file: APP, find: "if (!playerOrientationDismissed && orientation) {", replace: "if (false) {" }] },
  { statement: "first-frame", name: "a first frame that does not name the world", expect: /does not name the world/, edits: [{ file: APP, find: "<h1>You’re in ${escapeHtml(title)}</h1>", replace: "<h1>You’re in</h1>" }] },
  { statement: "loading-is-not-live", name: "a page that claims live before the world answers", expect: /while the world has not answered the page claims "live"/, edits: [{ file: APP, find: 'setConnectionPresentation("loading", "Connecting to the live world…");', replace: 'setConnectionPresentation("live", "Connecting to the live world…");' }] },
  { statement: "boot-failure", name: "a failed boot that is shown as live", expect: /the boot failed \(abort\) but the page says "live"/, edits: [{ file: APP, find: 'disconnected ? "disconnected" : "error"', replace: 'disconnected ? "live" : "live"' }] },
  { statement: "boot-failure", name: "a retry button that does nothing", expect: /the retry button did not reload/, edits: [{ file: APP, find: "location.reload();", replace: "void location;" }] },
  { statement: "failure-after-boot", name: "a world that stopped answering and the page stays live", expect: /stayed live after the world stopped answering/, edits: [{ file: APP, find: "} else if (!request.ok && Number(request.status) === 0) {", replace: "} else if (false) {" }] },
  { statement: "failure-after-boot", name: "a world that answers with an error and the page stays live", expect: /stayed live after the world answered with an error/, edits: [{ file: APP, find: "} else if (!request.ok && Number(request.status) >= 500) {", replace: "} else if (false) {" }] },
  { statement: "offline-is-managed", name: "an offline event nobody listens to", expect: /stayed live when the browser went offline/, edits: [{ file: APP, find: 'listenAtRoot(window, "offline", handleOffline);', replace: "void handleOffline;" }] },
  { statement: "offline-is-managed", name: "an offline listener the teardown does not remove", expect: /after the page was torn down the offline event still changed it/, edits: [{ file: APP, find: 'listenAtRoot(window, "offline", handleOffline);', replace: 'window.addEventListener("offline", handleOffline);' }] },
  { statement: "inspector-starts-closed", name: "a boot that leaves the inspector open while the world loads", expect: /the inspector is open while the world has not answered/, edits: [{ file: APP, find: "appEl.className = `role-${role} rail-collapsed`", replace: "appEl.className = `role-${role}`" }] },
  { statement: "inspector-starts-closed", name: "a mount that is not closed again", expect: /starts with the inspector open/, edits: [{ file: APP, find: "panelTruthChromeController.chromeDriver().close();", replace: "void 0;" }] },
];
