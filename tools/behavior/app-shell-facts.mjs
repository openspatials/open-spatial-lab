// Everything the app-shell checks read from a page or do to its network, in one place. Most of it is what a person sees
// (text, hidden flags, attributes). The few reads of the demo's insides are marked INSIDE, so that a later move of that
// code changes this file and no statement.
import { fail, waitUntil } from "./kit.mjs";

const clean = (text) => String(text || "").replace(/\s+/g, " ").trim();

/** What the page claims about its connection, in the header, the footer, the card in the middle and the body. */
export const connectionFacts = (page) => page.evaluate(() => {
  const text = (id) => (document.getElementById(id) || {}).textContent || null;
  const card = document.querySelector('[data-testid="player-connection-card"]');
  const first = document.querySelector('[data-testid="player-first-frame"]');
  return {
    state: document.body.dataset.connectionState || null,
    header: text("connection-status"),
    provenance: text("connection-provenance"),
    footer: text("connection-footer-status"),
    backend: text("live-backend"),
    title: text("loc-title"),
    card: card ? card.innerText : null,
    cardRole: card ? card.getAttribute("role") : null,
    retry: Boolean(document.querySelector('[data-testid="connection-retry"]')),
    firstFrame: first ? first.innerText : null,
    startButton: Boolean(document.querySelector('[data-testid="start-exploring"]')),
  };
}).then((facts) => ({ ...facts, card: facts.card && clean(facts.card), firstFrame: facts.firstFrame && clean(facts.firstFrame) }));

/** Wait until the connection facts satisfy `test`; the message says what the page showed last. */
export async function untilConnection(page, test, what, limitMs = 90000) {
  let last = null;
  return waitUntil(async () => {
    last = await connectionFacts(page).catch(() => null); // a page that is reloading answers nothing
    return last && test(last) ? last : null;
  }, () => `${what} (state ${last && last.state}, header ${last && last.header})`, { limitMs });
}

export async function loadPlayer(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
}

/** The inspector (right rail): its class, its toggle and whether it takes any room. */
export const inspectorFacts = (page) => page.evaluate(() => ({
  appClass: document.getElementById("app").className,
  expanded: document.querySelector('[data-testid="rail-toggle"]').getAttribute("aria-expanded"),
  display: getComputedStyle(document.querySelector("aside.rail")).display,
}));

export const clickId = (page, id) => page.evaluate((target) => document.getElementById(target).click(), id);

/** Wait for a page whose world has loaded (the player or the source view), without touching its first-frame card. */
export async function untilAssembled(page, limitMs = 120000) {
  await page.waitForFunction(() => document.body.dataset.assemblyReady === "1" && window.__assembly && window.__assembly.ready === true, { timeout: limitMs });
}

/** INSIDE: the app's own teardown, which the browser runs when the page is hidden. */
export const disposePage = (page) => page.evaluate(() => window.__assembly.dispose());

export const offlineEvent = (page) => page.evaluate(() => window.dispatchEvent(new Event("offline")));

/**
 * Take over a page's requests: `set(match, action)` makes every request whose address contains `match` fail ("abort"),
 * answer 500 ("500") or wait ("hold"). One rule at a time; `release()` lets held requests go on.
 */
export async function interceptRequests(page) {
  await page.setRequestInterception(true);
  let rule = null;
  const held = [];
  page.on("request", (request) => {
    if (!rule || !request.url().includes(rule.match)) return void request.continue().catch(() => {});
    if (rule.action === "abort") return void request.abort("connectionrefused").catch(() => {});
    if (rule.action === "hold") return void held.push(request);
    return void request.respond({ status: 500, contentType: "application/json", body: "{}" }).catch(() => {});
  });
  return {
    set(match, action) { rule = { match, action }; },
    clear() { rule = null; },
    heldCount: () => held.length,
    release() { rule = null; for (const request of held.splice(0)) request.continue().catch(() => {}); },
  };
}

/** The notification center, as the people see it and as the page's own list says. INSIDE: window.__assembly.notifications. */
export const notificationFacts = (page) => page.evaluate(() => {
  const api = window.__assembly.notifications;
  const center = document.getElementById("notification-center");
  const list = api.list();
  return {
    records: list.map((record) => ({ id: record.id, kind: record.kind, event: record.event_type || null })),
    count: api.count(),
    selected: api.selected(),
    open: api.isOpen(),
    centerShown: !center.hidden,
    badge: document.getElementById("notification-count-badge").textContent,
    bodyCount: document.body.dataset.notificationCount,
    pressed: document.getElementById("btn-notifications").getAttribute("aria-expanded"),
    detail: document.getElementById("notification-detail").innerText,
  };
});

/** INSIDE: window.__assembly.notifications.open/close. */
export const openNotification = (page, id) => page.evaluate((target) => window.__assembly.notifications.open(target), id);
export const closeNotifications = (page) => page.evaluate(() => window.__assembly.notifications.close());

/** Keep a list of every toast the page shows, with the record it is linked to. Call it once the page is open. */
export const watchToasts = (page) => page.evaluate(() => {
  window.__shellToasts = [];
  new MutationObserver((changes) => {
    for (const change of changes) {
      for (const node of change.addedNodes) {
        if (node.classList && node.classList.contains("toast")) {
          window.__shellToasts.push({ text: node.textContent.replace(/\s+/g, " ").trim(), linkedTo: node.dataset.notificationId || null });
        }
      }
    }
  }).observe(document.body, { childList: true, subtree: true });
});

export const toastsSeen = (page) => page.evaluate(() => window.__shellToasts.slice());

/** The Destinations panel: open flag, the world it names, and its destination buttons. */
export const destinationFacts = (page) => page.evaluate(() => ({
  shown: !document.getElementById("semantic-destinations-panel").hidden,
  expanded: document.getElementById("btn-semantic-destinations").getAttribute("aria-expanded"),
  world: document.getElementById("semantic-current-world").textContent,
  status: document.getElementById("semantic-destinations-status").textContent,
  buttons: [...document.querySelectorAll("#semantic-destinations-list button")].map((button) => button.innerText.replace(/\s+/g, " ").trim()),
}));

export const clickDestination = (page, index) => page.evaluate((at) => document.querySelectorAll("#semantic-destinations-list button")[at].click(), index);

/** The avatar selector's "none" choice: its words, whether it is the staged state, and the status line. */
export const noneChoiceFacts = (page) => page.evaluate(() => {
  const none = document.querySelector('[data-testid="avatar-selector-equipment-none"]');
  return none ? {
    label: none.innerText,
    ariaLabel: none.getAttribute("aria-label"),
    staged: none.getAttribute("aria-pressed") === "true",
    status: (document.getElementById("avatar-selector-status") || {}).textContent || "",
  } : null;
});

/** Stage one piece of equipment by pressing its chip; false when the selector offers none. */
export const stageFirstItem = (page) => page.evaluate(() => {
  const chip = document.querySelector("#avatar-selector-equipment-groups .avatar-selector-options button");
  if (chip) chip.click();
  return Boolean(chip);
});

export const clickNoneChoice = (page) => page.evaluate(() => document.querySelector('[data-testid="avatar-selector-equipment-none"]').click());

/** INSIDE: the airport shell's two controllers (window.__assembly.storefrontShopping and airportBoarding). */
export const airportFacts = (page) => page.evaluate(() => {
  const shop = window.__assembly.storefrontShopping.state();
  const board = window.__assembly.airportBoarding.state();
  const shown = (testid) => { const node = document.querySelector(`[data-testid="${testid}"]`); return Boolean(node) && !node.hidden; };
  return {
    nearestStore: shop.nearest_store_id,
    openStore: shop.open_store_id,
    shopAffordance: !document.getElementById("storefront-shopping-affordance").hidden,
    shopPanel: !document.getElementById("storefront-shopping-panel").hidden,
    boardingPhase: board.phase,
    boardingAffordance: shown("boarding-journey-affordance"),
    boardingPanel: shown("boarding-journey-panel"),
    boardingAttempts: board.validation_attempts,
  };
});

/** The lines the page wrote to its activity journal (it lives in the inspector, which starts closed). */
export const journalLines = (page) => page.evaluate(() => [...document.querySelectorAll("#activity-journal li")].map((line) => line.textContent.replace(/\s+/g, " ").trim()));

export function expectShown(facts, state, header, what) {
  if (facts.state !== state || facts.header !== header) fail(`${what}: the page says "${facts.state}" / "${facts.header}", not "${state}" / "${header}"`);
}
