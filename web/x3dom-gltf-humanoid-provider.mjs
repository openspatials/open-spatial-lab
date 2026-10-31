// Ported by hand from Nicholas Polys's public fork npolys/open-spatial-lab, commit 99175b4b6,
// web/x3dom-gltf-humanoid-provider.mjs. Apache-2.0, like the rest of the lab. Nicholas Polys is co-author of lab commit ef702ec.
// Changes in this copy: kind follows the adapter, and the equipment scale goes through adapter.multiplyScale(), so X_ITE can use this provider too.

import { HumanoidProvider } from "./humanoid-provider.mjs";

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
        for (const [name, offset] of Object.entries(ATTACHMENT_ANCHOR_PRESETS)) {
            const anchor = this._adapter.createGroup(`equipment-anchor-${name}`);
            this._adapter.setPosition(anchor, offset[0], offset[1], offset[2]);
            this._adapter.add(node, anchor);
            node._x3domAnchors[name] = anchor;
        }
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
