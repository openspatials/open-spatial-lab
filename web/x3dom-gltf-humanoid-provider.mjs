// Ported by hand from Nicholas Polys's public fork npolys/open-spatial-lab, commit 99175b4b6,
// web/x3dom-gltf-humanoid-provider.mjs. Apache-2.0, like the rest of the lab. Nicholas Polys is co-author of lab commit ef702ec.
// Changes in this copy: kind follows the adapter, and the equipment scale goes through adapter.multiplyScale(), so X_ITE can use this provider too.
// Lab change: the anchors come from the avatar's <id>.body.json when it has one (see anchorsFromBody).

import { HumanoidProvider } from "./humanoid-provider.mjs";
import { composeTRS, transformPoint } from "./vendor/scene-core/render-adapter/spatial-math.mjs";

// Scoped deliverable — see humanoid-provider.mjs. Name says "gltf" deliberately: this targets
// glTF/VRM avatars directly via X3DOMRenderAdapter's Inline-slot-pool mechanism (real, verified —
// see x3dom-spikes/spike-x3dom-inline-pool.html), per explicit direction to build against that
// now rather than block on an H-Anim conversion pipeline. A future HAnimHumanoidProvider targeting
// ISO/IEC 19774-1:2019 is expected to sit alongside this one, not replace it outright.
//
// Phase 3 of the X3DOM parity plan added named attachment anchors, mirroring
// avatar-equipment-layer.js's ATTACHMENT_PRESETS fallback-rig pattern — the same non-bone
// approximation that file already uses for non-VRM avatars, since X3DOM has no bone/skeleton API
// to attach to directly (see humanoid-provider.mjs's own scope note on this). Values duplicated
// here rather than importing avatar-equipment-layer.js, to avoid pulling ~1700 lines of
// THREE/VRM-specific code into the X3DOM path for three constants.
const ATTACHMENT_ANCHOR_PRESETS = Object.freeze({
    head: [0, 1.55, 0.12],
    leftHand: [-0.42, 0.82, 0.18],
    rightHand: [0.42, 0.82, 0.18],
});
// equip-*.glb assets are authored roughly 5x too large relative to the avatar (confirmed via a
// live bbox comparison: the default head item rendered at ~1.7m x 0.8m x 1.7m, nearly as large as
// the avatar's own ~1.9m x 3.0m x 1.7m bounds). avatar-equipment-layer.js (the three.js path)
// already corrects this with the same flat scalar on the raw asset root, applied before/
// independent of the catalog's own per-item localTransform.scale (see its _loadItem, where
// assetRoot.scale.setScalar(0.2) nests inside visualRoot before applyLocalTransform runs on
// visualRoot itself) — mirrored here so both engines render equipped items at the same size.
const EQUIPMENT_ASSET_SCALE = 0.2;
// Lab change: the presets above were tuned to the Ready Player Me arms-down avatar. A collection character has a
// <id>.body.json beside its glb (same folder and stem), measured in the avatar frame the engines draw it in: metres,
// +X the avatar's left, +Y up, +Z forward (its rest_pose position_m already carries the glTF root's -90 degree X
// rotation: y-bot's pelvis has local_translation z 0.854 and position_m y 0.854). anchorsFromBody places each anchor
// there; a missing or unreadable body.json keeps the presets.
// The head items' authored offsets (equipment-view.js legacy transforms plus their 0.2-scaled undersides) lift them
// 0.2 m (hat), 0.15 m (helmet) and 0.24 m (crown) above the head anchor. The three.js seat rule (seatHeadItem in
// avatar-equipment-layer.js) puts the hat's underside 0.067 m below the head top, the helmet's 0.077 m and the
// crown's 0.039 m. One drop below the measured head top lands all three within 4 cm of that rule.
const HEAD_ITEM_SEAT_DROP_M = 0.26;

/** Anchor offsets in the avatar frame from a body.json: hands at the grip hollow (or the palm), head at its top. */
export function anchorsFromBody(body) {
    const pose = body && body.rest_pose;
    const roles = body && body.roles;
    if (!pose || !roles)
        return {};
    const out = {};
    for (const [name, side] of [["leftHand", "l"], ["rightHand", "r"]]) {
        const bone = pose[roles[name]];
        const hand = body.hands && body.hands[side];
        const grip = hand && ((hand.hollow && hand.hollow.position_m) || hand.palm_m);
        if (bone && Array.isArray(bone.position_m) && Array.isArray(bone.rotation) && Array.isArray(grip))
            out[name] = transformPoint(composeTRS(bone.position_m, bone.rotation, [1, 1, 1]), grip);
    }
    const head = pose[roles.head];
    const top = body.volumes && body.volumes.head && body.volumes.head.max_m && body.volumes.head.max_m[1];
    if (head && Array.isArray(head.position_m) && Number.isFinite(top))
        out.head = [head.position_m[0], head.position_m[1] + top - HEAD_ITEM_SEAT_DROP_M, head.position_m[2]];
    return out;
}

// One fetch per avatar URL, shared by the local avatar and every peer drawn with the same model.
const bodyAnchorsByUrl = new Map();
function bodyAnchorsFor(url) {
    const bodyUrl = typeof url === "string" && /\.glb(?=$|[?#])/.test(url) ? url.replace(/\.glb(?=$|[?#])/, ".body.json") : null;
    if (!bodyUrl)
        return Promise.resolve({});
    if (!bodyAnchorsByUrl.has(url)) {
        bodyAnchorsByUrl.set(url, fetch(bodyUrl)
            .then((res) => (res.ok ? res.json() : null))
            .then((body) => anchorsFromBody(body))
            .catch(() => ({})));
    }
    return bodyAnchorsByUrl.get(url);
}
// Lab change: his fork used 15000. A 6 MB avatar on a machine with no graphics card took longer.
const AVATAR_LOAD_TIMEOUT_MS = 60000;

export class X3domGltfHumanoidProvider extends HumanoidProvider {
    constructor(x3domRenderAdapter) {
        super();
        if (!x3domRenderAdapter)
            throw new Error("X3domGltfHumanoidProvider requires an X3DOMRenderAdapter instance");
        this._adapter = x3domRenderAdapter;
    }
    get kind() { return `${this._adapter.kind}-gltf`; }
    spawnAvatar({ url, position }) {
        // priority: true — avatars (local + peer) must never sit queued behind background
        // hosted-object WoW-fetch claims, which can legitimately take several real seconds each.
        const { node, ready } = this._adapter.createInlineAsset(url, {}, AVATAR_LOAD_TIMEOUT_MS, true);
        if (position)
            this._adapter.setPosition(node, position[0], position[1], position[2]);
        node._x3domAnchors = {};
        node._x3domAnchorOffsets = {};
        for (const [name, offset] of Object.entries(ATTACHMENT_ANCHOR_PRESETS)) {
            const anchor = this._adapter.createGroup(`equipment-anchor-${name}`);
            this._adapter.setPosition(anchor, offset[0], offset[1], offset[2]);
            this._adapter.add(node, anchor);
            node._x3domAnchors[name] = anchor;
            node._x3domAnchorOffsets[name] = { source: "preset", offset: offset.slice() };
        }
        // Lab change: move the anchors to the avatar's own body once its body.json has loaded; items already attached
        // move with them. Resolves with the offsets used (also on node._x3domAnchorOffsets).
        node._x3domAnchorsPlaced = bodyAnchorsFor(url).then((fromBody) => {
            for (const [name, offset] of Object.entries(fromBody)) {
                if (!node._x3domAnchors[name])
                    continue;
                this._adapter.setPosition(node._x3domAnchors[name], offset[0], offset[1], offset[2]);
                node._x3domAnchorOffsets[name] = { source: "body.json", offset };
            }
            return node._x3domAnchorOffsets;
        });
        return { handle: node, ready: ready.then(() => node) };
    }
    setPosition(handle, x, y, z) { this._adapter.setPosition(handle, x, y, z); }
    setRotation(handle, yawRadians) { this._adapter.setRotationAxis(handle, "y", yawRadians); }
    setVisible(handle, visible) { this._adapter.setVisible(handle, visible); }
    dispose(handle) { this._adapter.disposeNode(handle); }
    /**
     * `attachmentPoint` is optional and additive to the existing root-only contract: when it
     * names a known anchor (see ATTACHMENT_ANCHOR_PRESETS) the item parents under that anchor
     * instead of the avatar root, so it moves with an approximate hand/head position rather than
     * always sitting at the avatar's origin. Unknown/omitted attachmentPoint falls back to the
     * original root-level behavior — unaffected callers (existing spikes) keep working as-is.
     */
    attachItem(avatarHandle, { url, localTransform, attachmentPoint } = {}) {
        const anchor = (avatarHandle._x3domAnchors && avatarHandle._x3domAnchors[attachmentPoint]) || avatarHandle;
        // priority: true — same reasoning as spawnAvatar() above; equipped items (own + peers')
        // are player-visible gear, not background dressing.
        const { node, ready } = this._adapter.createInlineAsset(url, {}, AVATAR_LOAD_TIMEOUT_MS, true);
        if (localTransform)
            this._adapter.setLocalMatrix(node, localTransform);
        // Post-multiply rather than a nested wrapper node: disposeNode() treats this Inline-pool
        // wrapper as a permanent, reusable pool member (releases the slot in place rather than
        // removing it from the DOM — see disposeNode's own comment), so introducing a second
        // Transform node here to hold this scale would leak an orphaned, never-disposed node on
        // every re-equip cycle.
        this._adapter.multiplyScale(node, EQUIPMENT_ASSET_SCALE);
        this._adapter.add(anchor, node);
        return { itemHandle: node, ready: ready.then(() => node) };
    }
    detachItem(itemHandle) { this._adapter.disposeNode(itemHandle); }
}
