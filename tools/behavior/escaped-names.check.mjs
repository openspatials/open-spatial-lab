// Other worlds name their portals and items, and the page shows those names in its side panels. A name that holds markup
// must show as the text it is: no element made from it, no script run by it.
// A world cannot be made to name a portal this way without breaking the lab's other routes, so each statement hands the
// page hostile names where it takes them from the adapter: the equipment it holds, and the prefetch state it reports.
// Run: node tools/behavior/escaped-names.check.mjs [--faults] [--only id,id]
import { expect, pageFacts, runBehavior, sleep } from "./kit.mjs";
import { lobbyUrl } from "./crossing-walk.mjs";

const SETTLE_MS = 1500; // an image in a name loads, fails and runs its handler within this
const RUN = (tag) => `window.__pwned=(window.__pwned||[]).concat('${tag}')`;
const HOSTILE = (tag) => `<img src=x onerror="${RUN(tag)}">`;
const AMPERSAND = "Tom &amp; Jerry &lt;b&gt;";

const NAMES = {
  mode: HOSTILE("mode"),
  itemId: HOSTILE("item-id"),
  attachmentPoint: HOSTILE("attachment-point"),
  message: HOSTILE("message"),
  key: HOSTILE("portal-key"),
  status: HOSTILE("status"),
  dest: HOSTILE("destination"),
};

/** What a panel holds after the page was handed the names: its text, the kinds of element in it, and what ran. */
const readPanel = (page, selector) => page.evaluate((chosen) => {
  const panel = document.querySelector(chosen);
  if (!panel) return null;
  const kinds = {};
  panel.querySelectorAll("*").forEach((el) => { kinds[el.tagName] = (kinds[el.tagName] || 0) + 1; });
  return { text: panel.textContent.replace(/\s+/g, " "), kinds, ran: window.__pwned || [] };
}, selector);

/** Every name is in the text as written, no element came from one, and none ran. */
function expectNamesAsText(panel, where, names, allowed) {
  expect(panel, `${where} is not on the page`);
  for (const [field, value] of Object.entries(names)) expect(panel.text.includes(value), `${where} does not show the ${field} as written: "${panel.text.slice(0, 240)}"`);
  const made = Object.keys(panel.kinds).filter((tag) => !allowed.includes(tag));
  expect(made.length === 0, `${where} holds elements made from a name: ${made.map((tag) => `${tag} x${panel.kinds[tag]}`).join(", ")}`);
  expect(panel.ran.length === 0, `a name ran script in ${where}: ${panel.ran.join(", ")}`);
}

async function openLobby(ctx) {
  ctx.pageErrors.length = 0;
  const page = await ctx.visit(lobbyUrl(ctx.lab));
  const facts = await pageFacts(page);
  expect(facts.location === "location-lobby", `the page opened in ${facts.location}, not the Lobby`);
  return page;
}

const statements = [
  { id: "equipment-names-are-text", says: "An item whose mode, id, attachment point and message hold markup shows as text in the equipment list", async run(ctx) {
    const page = await openLobby(ctx);
    const handed = await page.evaluate((names, ampersand) => {
      const adapter = window.__assembly.adapter;
      const item = { mode: names.mode, itemId: names.itemId, attachmentPoint: names.attachmentPoint, assetUri: "none" };
      const plain = { mode: "worn", itemId: ampersand, attachmentPoint: "head", assetUri: "none" };
      adapter.state.avatar.equippedItems = [item, plain];
      adapter.state.equipment_status = {
        validation: { ok: true, errors: [] },
        items: [
          { itemId: item.itemId, fetch_ok: true, visible_fallback: false, message: names.message },
          { itemId: plain.itemId, fetch_ok: false, visible_fallback: true, message: ampersand },
        ],
      };
      adapter._emit();
      return adapter.state.avatar.equippedItems.length;
    }, NAMES, AMPERSAND);
    expect(handed === 2, `the page was handed ${handed} items, not 2`);
    await sleep(SETTLE_MS);
    const panel = await readPanel(page, "#equipment-list");
    expectNamesAsText(panel, "the equipment list", { mode: NAMES.mode, "item id": NAMES.itemId, "attachment point": NAMES.attachmentPoint, message: NAMES.message, "ampersand name": AMPERSAND }, ["DIV", "B"]);
    await page.close();
    return `${Object.keys(panel.kinds).map((tag) => `${tag} x${panel.kinds[tag]}`).join(", ")} in the list, nothing ran`;
  } },
  { id: "portal-names-are-text", says: "A portal whose id, status and destination hold markup shows as text in the portal choice list", async run(ctx) {
    const page = await openLobby(ctx);
    const handed = await page.evaluate((names, ampersand) => {
      const adapter = window.__assembly.adapter;
      const real = adapter.debugState.bind(adapter);
      adapter.debugState = () => {
        const dbg = real();
        const fp = dbg.fabric_prefetch;
        const keyed = fp && fp.keyed;
        const machines = keyed && keyed.machines ? keyed.machines : {};
        const model = Object.values(machines)[0] || {};
        // Not `supported`, so that the page makes no notice from it.
        const hostile = { ...model, supported: false, status: names.status, target_location_id: names.dest, queued: true, zone: { inside: true, distance_m: 1.5 } };
        const plain = { ...model, supported: false, status: "warm", target_location_id: ampersand };
        const hostileMachines = { ...machines, [names.key]: hostile, [`${ampersand}`]: plain };
        return { ...dbg, fabric_prefetch: { ...fp, keyed: { ...keyed, portal_count: Object.keys(hostileMachines).length, machines: hostileMachines } } };
      };
      adapter._emit();
      const keyed = adapter.debugState().fabric_prefetch.keyed;
      return keyed.portal_count;
    }, NAMES, AMPERSAND);
    expect(handed > 1, `the page was handed ${handed} portals, not several`);
    await sleep(SETTLE_MS);
    const panel = await readPanel(page, "#fx-portal-list");
    expectNamesAsText(panel, "the portal choice list", { "portal id": NAMES.key, status: NAMES.status, destination: NAMES.dest, "ampersand name": AMPERSAND }, ["DIV", "SPAN"]);
    await page.close();
    return `${Object.keys(panel.kinds).map((tag) => `${tag} x${panel.kinds[tag]}`).join(", ")} in the list, nothing ran`;
  } },
];

const APP = "web/app.js";
const faults = [
  { statement: "equipment-names-are-text", name: "the item's mode and id go in as written", expect: /ran script in the equipment list|holds elements made from a name|does not show the (mode|item id)/, edits: [{ file: APP, find: "<div><b>${escapeHtml(item.mode)}</b> ${escapeHtml(item.itemId)}</div>", replace: "<div><b>${item.mode}</b> ${item.itemId}</div>" }] },
  { statement: "equipment-names-are-text", name: "the attachment point goes in as written", expect: /ran script in the equipment list|holds elements made from a name|does not show the attachment point/, edits: [{ file: APP, find: "<div>${escapeHtml(item.attachmentPoint)}</div>", replace: "<div>${item.attachmentPoint}</div>" }] },
  { statement: "equipment-names-are-text", name: "the fetch message goes in as written", expect: /ran script in the equipment list|holds elements made from a name|does not show the message/, edits: [{ file: APP, find: "<div>${escapeHtml(fetchText)}</div>", replace: "<div>${fetchText}</div>" }] },
  { statement: "portal-names-are-text", name: "the portal id goes in as written", expect: /ran script in the portal choice list|holds elements made from a name|does not show the portal id/, edits: [{ file: APP, find: "<span class=\"k\">${escapeHtml(key)}</span>", replace: "<span class=\"k\">${key}</span>" }] },
  { statement: "portal-names-are-text", name: "the status goes in as written", expect: /ran script in the portal choice list|holds elements made from a name|does not show the status/, edits: [{ file: APP, find: "${escapeHtml(machine.status)} · ${escapeHtml(dest)}", replace: "${machine.status} · ${dest}" }] },
  { statement: "portal-names-are-text", name: "the destination goes in as written", expect: /ran script in the portal choice list|holds elements made from a name|does not show the destination/, edits: [{ file: APP, find: "${escapeHtml(machine.status)} · ${escapeHtml(dest)}", replace: "${escapeHtml(machine.status)} · ${dest}" }] },
];

await runBehavior({ title: "escaped-names", firstPort: 40560, statements, faults });
