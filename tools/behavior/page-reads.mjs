// The reads of the demo's insides that the crossing checks make beyond kit.mjs's pageFacts. When a move renames one of
// these internals, this file and pageFacts are the only places to change.

/** What the page says its scene is built from, whether it is still the document that was marked, and the avatar it wears. */
export function sceneFacts(page) {
  return page.evaluate(() => {
    const assembly = window.__assembly;
    const debug = assembly.debugState();
    const graph = (source) => (source ? { spatialId: source.spatialID, nodes: source.node_count } : null);
    const body = document.body.dataset;
    return {
      sceneGraph: graph(debug.wow_scene_source),
      crossingGraph: graph(debug.crossing && debug.crossing.destination_scene_source),
      mark: window.__behaviorMark || null,
      promotions: Number(body.navigatorPromotionCount),
      samePage: body.markerSameAfterCrossing === "true",
      navigations: performance.getEntriesByType("navigation").length,
      ownVariant: (assembly.avatarVisualState() || {}).avatar_variant || null,
    };
  });
}

/** Put a mark on the document: it is still there after a crossing only if nothing reloaded the page. */
export const markDocument = (page, mark) => page.evaluate((text) => { window.__behaviorMark = text; }, mark);

/** From now on, count every frame the page draws, by peer, whether the peer is drawn and which avatar it wears. */
export function recordPeerFrames(page) {
  return page.evaluate(() => {
    const seen = new Map();
    window.__behaviorPeerFrames = seen;
    const sample = () => {
      for (const peer of window.__assembly.peerAvatars()) {
        const key = `${peer.player_id}|${peer.rendered}|${peer.avatar_variant}`;
        seen.set(key, (seen.get(key) || 0) + 1);
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
}

/** What recordPeerFrames counted so far: one entry per peer, drawn or not, and avatar. */
export async function peerFrames(page) {
  const seen = await page.evaluate(() => [...window.__behaviorPeerFrames]);
  return seen.map(([key, frames]) => {
    const [player, rendered, variant] = key.split("|");
    return { player, rendered: rendered === "true", variant, frames };
  });
}

/** Per portal window: whom it draws. `me` is the visitor's own id. */
export function windowFacts(page) {
  return page.evaluate(() => {
    const debug = window.__assembly.debugState();
    const records = (debug.portal_spatial_preview || {}).records || {};
    const windows = {};
    for (const [key, record] of Object.entries(records)) windows[key] = { drawn: (record.controlled_identity_filter || {}).rendered_player_ids || [] };
    return { me: debug.controlled_identity.player_id, windows };
  });
}

/** The ids of the other visitors this page holds, drawn or not. */
export const peerIds = (page) => page.evaluate(() => window.__assembly.peerAvatars().map((peer) => peer.player_id));

/** The last departure the world pushed to this page, or null. */
export const lastPushedDeparture = (page) => page.evaluate(() => {
  const push = window.__assembly.debugState().presence_push;
  return push && push.last_departure ? { playerId: push.last_departure.player_id, location: push.last_departure.target_location_id } : null;
});

/**
 * Another document of the visitor's browser speaks on the peer channel, as another tab would, for each of `people`
 * ({ id, clientId, location, position }) until stopSpeaking.
 */
export function speakOnPeerChannel(page, people) {
  return page.evaluate((who) => {
    const channel = new BroadcastChannel("open-spatial-lab-peer-presence");
    let seq = 0;
    const speak = () => {
      seq += 1;
      for (const p of who) channel.postMessage({ type: "player-pose", seq, at: Date.now(), client_id: p.clientId, player_id: p.id, location_id: p.location, position: p.position, rotation_y: 0 });
    };
    speak();
    window.__behaviorSpeaker = setInterval(speak, 300);
  }, people);
}

export const stopSpeaking = (page) => page.evaluate(() => clearInterval(window.__behaviorSpeaker));
