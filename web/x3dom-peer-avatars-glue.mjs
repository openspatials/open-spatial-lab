// Ported by hand from Nicholas Polys's public fork npolys/open-spatial-lab, commit 99175b4b6,
// web/x3dom-peer-avatars-glue.mjs. Apache-2.0, like the rest of the lab. Nicholas Polys is co-author of lab commit ef702ec.
// Changes in this copy: none, except where a comment says so. X_ITE uses this file too.

import { X3domGltfHumanoidProvider } from "./x3dom-gltf-humanoid-provider.mjs";
import { itemMatrix } from "./x3dom-equipment-glue.mjs";

// Phase 3.5b of the X3DOM parity plan — peer/multiplayer avatar rendering, the X3DOM-side
// equivalent of app.js's syncPeerAvatars()/peerAvatarLayers. As with portal traversal (Phase 2)
// and equipment (Phase 3), the DATA half of this needed no new code: LiveAdapter already runs a
// full peer-presence reducer internally (createPeerPresenceReducer, live-adapter-peer-presence-
// reducer.mjs) for both render paths — stepAvatar() already broadcasts our own pose on every
// call, and liveAdapter.debugState().peer_players already reports co-present peers (position,
// rotation, equippedItems) — the exact same feed the three.js path's syncPeerAvatars() consumes.
// The one thing that IS the caller's responsibility (confirmed by reading how app.js boots):
// liveAdapter.listenForCrossWindow() must be called once to start receiving peer broadcasts at
// all — see x3dom-live-mode.mjs's main().
//
// IMPORTANT CAVEAT (already documented elsewhere in this codebase, worth restating here): peer
// presence today is carried over a same-origin BroadcastChannel, not a real cross-network
// transport — this renders correctly for multiple tabs/windows of the same browser profile (which
// is what this phase's spike exercises), but does not yet represent real remote multiplayer.
//
// TEST-METHODOLOGY NOTE (discovered building this phase's spike, not a bug in this module):
// sync() runs from adapter.onEnterFrame(), which only fires while X3DOM's own render loop ticks —
// and that loop is subject to the same requestAnimationFrame throttling as everything else in a
// browser tab. Confirmed empirically: two Puppeteer pages in one headless browser instance are
// NOT both "visible" simultaneously (document.visibilityState) — Chrome (headless or not) only
// actively renders the front-most one; the backgrounded page's rAF (and therefore this module's
// sync()) drops to zero callbacks, regardless of --disable-background-timer-throttling/
// --disable-backgrounding-occluded-windows/--disable-renderer-backgrounding. page.bringToFront()
// is the fix for testing (confirmed) — alternate focus between pages to exercise both directions.
// This is a real characteristic of the browser, identical for the three.js path and every other
// onEnterFrame-driven system in this app (movement, camera, portal crossing) — not specific to
// peer avatars, and not a concern for real separate browser windows (each genuinely visible/
// focused independently), only for this single-headless-browser multi-page test setup.
//
// Each peer's equippedItems arrive already validated against the fixed equipment catalog
// (sanitizePeerEquippedItems() in live-adapter-peer-presence-reducer.mjs — added during this
// project's security-hardening pass) — never trust it blindly regardless, this module still
// only ever uses itemId as a catalog lookup key indirectly via the already-sanitized shape, and
// never renders anything if attachmentPoint/assetUri look malformed (attachItem/createInlineAsset
// simply won't find a matching anchor / will fail to load, not silently do something unexpected).
//
// Every avatar/equipment load here goes through Phase 3.5a's shared Inline-load queue (unchanged,
// automatic — createInlineAsset() enforces it centrally), which is exactly why that hardening had
// to land before this phase: peer spawns/equips arrive on network-driven timing this module has
// no control over.
const MAX_PEERS = 6; // degrade gracefully rather than let the 32-slot Inline pool throw

export function createX3domPeerAvatarsGlue({ adapter, liveAdapter, avatarUrl, log = () => { } }) {
    const provider = new X3domGltfHumanoidProvider(adapter);
    const peers = new Map();

    function disposePeer(clientId, reason) {
        const entry = peers.get(clientId);
        if (!entry)
            return;
        for (const itemHandle of Object.values(entry.equippedHandles)) {
            try {
                provider.detachItem(itemHandle);
            }
            catch (err) {
                log(`[x3dom-peer-avatars] detach failed for ${clientId.slice(0, 18)}: ${err && err.message}`);
            }
        }
        try {
            provider.dispose(entry.handle);
        }
        catch (err) {
            log(`[x3dom-peer-avatars] dispose failed for ${clientId.slice(0, 18)}: ${err && err.message}`);
        }
        peers.delete(clientId);
        log(`[x3dom-peer-avatars] peer ${clientId.slice(0, 18)} ${reason} — avatar removed`);
    }

    async function equipPeerItem(entry, item) {
        const previous = entry.equippedHandles[item.attachmentPoint];
        if (previous) {
            try {
                provider.detachItem(previous);
            }
            catch { /* best-effort */ }
            delete entry.equippedHandles[item.attachmentPoint];
        }
        let attached;
        try {
            attached = provider.attachItem(entry.handle, {
                url: item.assetUri,
                localTransform: itemMatrix(item),
                attachmentPoint: item.attachmentPoint,
            });
        }
        catch (err) {
            log(`[x3dom-peer-avatars] attachItem failed (pool likely exhausted): ${err && err.message}`);
            return;
        }
        entry.equippedHandles[item.attachmentPoint] = attached.itemHandle;
        entry.equippedIds[item.attachmentPoint] = item.itemId;
        try {
            await attached.ready;
        }
        catch (err) {
            log(`[x3dom-peer-avatars] peer item "${item.itemId}" failed to load: ${err && err.message}`);
        }
    }

    function syncEquipment(entry, equippedItems) {
        if (!Array.isArray(equippedItems))
            return;
        for (const item of equippedItems) {
            if (!item || !item.attachmentPoint || !item.itemId || !item.assetUri)
                continue;
            if (entry.equippedIds[item.attachmentPoint] === item.itemId)
                continue;
            void equipPeerItem(entry, item);
        }
    }

    function sync() {
        const dbg = liveAdapter.debugState();
        const peerList = Array.isArray(dbg.peer_players) ? dbg.peer_players : [];
        const coPresent = peerList.filter((peer) => peer && peer.co_present && peer.client_id);
        const liveIds = new Set(coPresent.map((peer) => peer.client_id));
        for (const clientId of Array.from(peers.keys())) {
            if (!liveIds.has(clientId))
                disposePeer(clientId, "left co-presence");
        }
        for (const peer of coPresent) {
            let entry = peers.get(peer.client_id);
            if (!entry) {
                if (peers.size >= MAX_PEERS) {
                    log(`[x3dom-peer-avatars] peer cap (${MAX_PEERS}) reached — skipping ${peer.client_id.slice(0, 18)}`);
                    continue;
                }
                const position = Array.isArray(peer.position) ? peer.position : [0, 0, 0];
                let spawned;
                try {
                    spawned = provider.spawnAvatar({ url: avatarUrl, position });
                }
                catch (err) {
                    log(`[x3dom-peer-avatars] spawnAvatar failed (pool likely exhausted): ${err && err.message}`);
                    continue;
                }
                entry = { handle: spawned.handle, placed: false, equippedHandles: {}, equippedIds: {} };
                peers.set(peer.client_id, entry);
                spawned.ready.then(() => { entry.placed = true; })
                    .catch((err) => log(`[x3dom-peer-avatars] peer avatar load failed: ${err && err.message}`));
                log(`[x3dom-peer-avatars] peer ${peer.client_id.slice(0, 18)} co-present — spawning avatar`);
            }
            if (entry.placed && Array.isArray(peer.position)) {
                provider.setPosition(entry.handle, peer.position[0], peer.position[1], peer.position[2]);
                provider.setRotation(entry.handle, Number(peer.rotation_y) || 0);
            }
            syncEquipment(entry, peer.equippedItems);
        }
    }

    function dispose() {
        for (const clientId of Array.from(peers.keys()))
            disposePeer(clientId, "glue disposed");
    }

    return { sync, dispose, peerCount: () => peers.size, peerClientIds: () => Array.from(peers.keys()) };
}
