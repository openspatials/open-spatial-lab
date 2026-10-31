// Ported by hand from Nicholas Polys's public fork npolys/open-spatial-lab, commit 99175b4b6,
// web/x3dom-equipment-glue.mjs. Apache-2.0, like the rest of the lab. Nicholas Polys is co-author of lab commit ef702ec.
// Changes in this copy: none, except where a comment says so. X_ITE uses this file too.

import { inventorySlots, defaultEquippedItems } from "./equipment-view.js";
import { composeTRS } from "./vendor/scene-core/render-adapter/spatial-math.mjs";

// Phase 3 of the X3DOM parity plan — equipment via named anchors (see the anchor mechanism in
// x3dom-gltf-humanoid-provider.mjs). Consumes equipment-view.js's catalog exactly as the three.js
// path does — it's already engine-agnostic (URLs + { position, quaternion, scale } transforms,
// not THREE objects) — and drives HumanoidProvider.attachItem/detachItem, one item per WoW
// equipment slot (head/leftHand/rightHand: the only three the real catalog defines). No avatar
// bone/skinning involved on either side, so this doesn't need to wait for the avatar's own glTF
// to finish loading — createInlineAsset() returns each item's node synchronously and its anchor
// parent (built at spawn time, see the provider) already exists by then.
const SELECTOR_BUTTON_TOP_PX = 104; // Lab change: 44 in his fork; this keeps the buttons below the lab's header
const SELECTOR_BUTTON_STEP_PX = 32;

export function itemMatrix(item) {
    const t = item.localTransform || {};
    return composeTRS(t.position || [0, 0, 0], t.quaternion || [0, 0, 0, 1], t.scale || [1, 1, 1]);
}

function buttonStyle(index) {
    return [
        "position:absolute", `top:${SELECTOR_BUTTON_TOP_PX + index * SELECTOR_BUTTON_STEP_PX}px`, "right:12px", "z-index:6",
        "padding:4px 8px", "background:rgba(8,12,26,0.82)", "color:#dbe8ff",
        "border:1px solid rgba(43,212,255,0.4)", "border-radius:8px", "min-width:120px",
        "font:600 10px ui-monospace,Menlo,monospace", "letter-spacing:0.02em", "cursor:pointer", "text-align:left",
    ].join(";");
}

export function createX3domEquipmentGlue({ provider, getAvatarHandle, avatarReady, sceneMount, documentTarget = document, log = () => { } }) {
    const slots = inventorySlots();
    const equipped = {};
    const buttons = {};

    async function equip(slotName, item) {
        const avatarHandle = getAvatarHandle();
        if (!avatarHandle || !item)
            return;
        const previous = equipped[slotName];
        if (previous && previous.itemHandle) {
            try {
                provider.detachItem(previous.itemHandle);
            }
            catch (err) {
                log(`[x3dom-equipment-glue] detach failed: ${err && err.message}`);
            }
        }
        equipped[slotName] = { item, itemHandle: null };
        const { itemHandle, ready } = provider.attachItem(avatarHandle, {
            url: item.assetUri,
            localTransform: itemMatrix(item),
            attachmentPoint: item.attachmentPoint,
        });
        equipped[slotName].itemHandle = itemHandle;
        updateButtons();
        try {
            await ready;
            log(`[x3dom-equipment-glue] equipped "${item.itemId}" at ${slotName}`);
        }
        catch (err) {
            log(`[x3dom-equipment-glue] "${item.itemId}" failed to load: ${err && err.message}`);
        }
    }

    // Serialized deliberately, and only starting once the avatar's own load is done: firing
    // multiple createInlineAsset() URL-swaps concurrently (confirmed empirically, including
    // against the avatar's own in-flight load) throws inside X3DOM's own addNameSpace internals
    // on this build — never exercised before this phase, since only one Inline node ever loaded
    // at a time previously. One load in flight at a time, anywhere in the app, avoids it.
    async function equipDefaults() {
        if (avatarReady)
            await avatarReady.catch(() => { });
        // Fired together, not awaited one at a time: each equip() call enqueues its (priority)
        // Inline claim synchronously, so firing all three back-to-back gets all of them into the
        // shared load queue's priority slot before the queue's own pump can grab the next
        // already-pending background hosted-object claim in between. Awaiting each item
        // sequentially (the original shape here) let exactly that race happen — confirmed live:
        // the FIRST item's priority claim correctly jumped ahead of a hosted-object claim, but by
        // the time the loop reached the SECOND item, the queue had already moved on to the next
        // hosted-object task, largely defeating the point of prioritizing equipment at all. Safe
        // to fire concurrently: the queue itself still runs exactly one Inline load at a time
        // (the constraint Phase 3.5a's queue exists for) — this only affects which PENDING claim
        // goes next, not how many run simultaneously.
        await Promise.all(defaultEquippedItems().map((item) => equip(item.attachmentPoint, item)));
    }

    function cycle(slotName) {
        const slot = slots.find((entry) => entry.slot === slotName);
        if (!slot || !slot.options.length)
            return;
        const current = equipped[slotName] && equipped[slotName].item;
        const currentIndex = current ? slot.options.findIndex((opt) => opt.itemId === current.itemId) : -1;
        const next = slot.options[(currentIndex + 1) % slot.options.length];
        void equip(slotName, next);
    }

    function updateButtons() {
        for (const slot of slots) {
            const button = buttons[slot.slot];
            if (!button)
                continue;
            const current = equipped[slot.slot] && equipped[slot.slot].item;
            button.textContent = current ? `${slot.label}: ${current.label}` : `${slot.label}: —`;
        }
    }

    function ensureButtons() {
        if (!sceneMount)
            return;
        slots.forEach((slot, index) => {
            if (buttons[slot.slot])
                return;
            const button = documentTarget.createElement("button");
            button.id = `btn-x3dom-equip-${slot.slot}`;
            button.type = "button";
            button.title = `Cycle ${slot.label} equipment`;
            button.style.cssText = buttonStyle(index);
            button.addEventListener("mousedown", (event) => event.stopPropagation());
            button.addEventListener("click", (event) => { event.stopPropagation(); cycle(slot.slot); });
            sceneMount.appendChild(button);
            buttons[slot.slot] = button;
        });
        updateButtons();
    }

    ensureButtons();

    return { equipDefaults, equip, cycle, equipped: () => ({ ...equipped }) };
}
