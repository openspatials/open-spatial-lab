// What the live-adapter checks read from the page, and the few things they do to it that a key or a mouse cannot. This
// is the only file of that check that reaches into window.__assembly (kit.mjs's pageFacts still reads position, phase
// and camera), so a later move of the code behind it changes this file and nothing else.
import { openPlayer } from "../arch-i4/main-demo/lab.mjs";
import { recordRequests } from "../arch-i4/main-demo/request-log.mjs";
import { fail, sleep, waitUntil } from "./kit.mjs";

/** The adapter's own account of itself: presence, event streams, the API panel's log and what the avatar wears. */
export function liveFacts(page) {
  return page.evaluate(() => {
    const assembly = window.__assembly;
    const debug = assembly.debugState();
    const presence = debug.presence_registration || {};
    const connections = (debug.presence_push && debug.presence_push.connections) || {};
    return {
      presence: { registered: presence.registered, heartbeats: presence.heartbeat_count, registers: presence.register_count },
      streams: Object.fromEntries(Object.entries(connections).map(([key, one]) => [key, { state: one.state, hello: Boolean(one.hello_at) }])),
      panel: assembly.wowApi.log().map((row) => ({ method: row.method, path: row.path, status: row.status, ok: row.ok, schema: row.schema })),
      worn: ((debug.avatar && debug.avatar.equippedItems) || []).map((item) => item.itemId),
      endpoint: debug.active_endpoint_key || (assembly.adapter && assembly.adapter.activeEndpointKey) || null,
      clientScene: debug.client_scene_load || null,
      groundId: debug.controls ? debug.controls.ground_surface_id : null,
    };
  });
}

/** A visitor whose requests are recorded from the first byte, so that the sockets it opens at load are in the log. */
export async function visitRecorded(ctx, url) {
  const page = await ctx.visit(url, { open: false });
  const requests = await recordRequests(page, { worlds: ctx.lab.doc.worlds, front: ctx.lab.front });
  await openPlayer(page, url);
  return { page, requests };
}

const PICKER_WAIT_MS = 120000; // Apply may also switch the avatar's body, which loads a model

/** Open the picker with its header button, as a visitor does. */
async function openPicker(page) {
  await page.click("#btn-switch-avatar");
  await page.waitForSelector("#avatar-selector-modal:not([hidden])", { timeout: PICKER_WAIT_MS });
}

/** Press Apply and wait for the picker to close; if it stays open, say what it answered. */
async function applyAndClose(page) {
  await page.click('[data-testid="avatar-selector-apply"]');
  try {
    await page.waitForSelector("#avatar-selector-modal", { hidden: true, timeout: PICKER_WAIT_MS });
  } catch {
    const answer = await page.evaluate(() => window.__assembly.avatarSelector.state().last_apply_result);
    fail(`the picker stayed open after Apply (timed out after ${PICKER_WAIT_MS / 1000} s); it answered ${JSON.stringify(answer)}`);
  }
}

/**
 * Wear items through the picker: open it, click each chosen item's chip, press Apply. The picker refuses a loadout that
 * has no held item or no worn item, so a visitor always picks one of each.
 */
export async function wearViaPicker(page, picks) {
  await openPicker(page);
  for (const [slot, itemId] of picks) await page.click(`[data-testid="avatar-selector-item-${slot}-${itemId}"]`);
  await applyAndClose(page);
}

/** The loadout the picker accepts: a hat on the head and a mug in the right hand. */
export const HAT_AND_MUG = [["head", "equip-hat"], ["rightHand", "equip-mug"]];

/** Take everything off through the picker's own "no equipment" choice, then press Apply. */
export async function clearViaPicker(page) {
  await openPicker(page);
  await page.evaluate(() => window.__assembly.avatarSelector.removeAllEquipment());
  await applyAndClose(page);
}

/** What the visitor wears now, as the item ids the world would see. */
export async function wornNow(page) {
  return (await liveFacts(page)).worn;
}

/** The name of the ground the avatar stands on; the plain default plane is what a world without its own floor gives. */
export async function groundNow(page) {
  const { groundId } = await liveFacts(page);
  return { name: groundId, own: Boolean(groundId) && groundId !== "legacy-world-ground-plane" };
}

/** A mark the page sets on its own body. */
export const bodyMark = (page, name) => page.evaluate((attribute) => document.body.getAttribute(attribute), name);

/**
 * The client-scene round trip, as the scene controller drives it: load the airport graph, enter it, come back. Each
 * step answers with what the page showed at that moment.
 */
export async function clientSceneTrip(page) {
  return page.evaluate(async () => {
    const assembly = window.__assembly;
    const adapter = assembly.adapter;
    const { airportSceneContract } = await import("/airport-lobby-transition.mjs");
    const show = () => ({
      location: assembly.debugState().location_id,
      endpoint: adapter.activeEndpointKey,
      base: adapter.base,
      endpointBase: adapter.endpoint && adapter.endpoint.proxy_base,
      streamKeys: (assembly.debugState().presence_push || {}).endpoint_keys || [],
      active: Boolean(assembly.debugState().client_scene_load && assembly.debugState().client_scene_load.active),
      worn: (assembly.debugState().avatar.equippedItems || []).map((item) => item.itemId),
      variant: assembly.debugState().avatar.avatar_variant,
    });
    const portal = adapter.world.portals[0];
    const target = { transition: "client_scene_load", portal_id: portal.portal_id || portal.string_portal_id, graph_endpoint: "/worlds/denver-skyport.json" };
    const resolved = await adapter.resolveClientSceneLoad(target);
    target.spatial_id = resolved.graph.spatialID || resolved.graph.spatial_id;
    const contract = airportSceneContract(resolved.graph, target);
    const avatarBefore = adapter.state.avatar;
    const trip = { before: show(), contract: Boolean(contract) };
    trip.entered = await adapter.enterClientSceneLoad({ target, contract, resolved, bounds: null }).then((r) => ({ ok: r.ok, reason: r.reason || null }));
    trip.inside = show();
    trip.returned = await adapter.returnToLobby().then((r) => ({ ok: r.ok, reason: r.reason || null }));
    trip.after = show();
    trip.sameAvatar = adapter.state.avatar === avatarBefore;
    return trip;
  });
}

export { fail, sleep, waitUntil };
