// Ported by hand from Nicholas Polys's public fork npolys/open-spatial-lab, commit 99175b4b6,
// web/x3dom-hud-glue.mjs. Apache-2.0, like the rest of the lab. Nicholas Polys is co-author of lab commit ef702ec.
// Changes in this copy: none, except where a comment says so. X_ITE uses this file too.

import { initAirportHudOverlay } from "./hud/airport-hud-overlay.mjs";
import { createNotificationToastController } from "./notification-toast-controller.mjs";

// Phase 4 of the X3DOM parity plan — HUD wiring. Both pieces below were already engine-agnostic
// before this phase (confirmed during Phase 1 research): the toast/notification chrome is pure
// DOM/CSS with no engine coupling at all (its markup already lives in index.html, shared by both
// render paths), and the airport HUD overlay is already routed through
// RenderAdapter.worldToScreen()/cameraDistanceTo() rather than raw THREE projection math. What
// this phase adds is calling them from the X3DOM boot path, the same way app.js does for three.js.
//
// Scoped OUT of this phase, deliberately, after investigation (not silently skipped):
// - The full inspector/debug panel (panel-truth-chrome-controller.mjs). It needs a much larger
//   app.js-specific dependency graph than the other two (manifest sign/verify callbacks, a
//   portal-settings-modal wiring hook, WoW loading-pointer builders) with no lean equivalent in
//   the X3DOM boot path yet — porting it is real integration work, not "mechanical wiring" as
//   originally assumed. Left for a dedicated future pass.
// - Real storefront/traveler tags on the airport HUD overlay: it matches nodes against
//   STOREFRONT_MAP/TRAVELER_MAP by label/display_name, sourced from airport-terminal-scene.mjs's
//   actual terminal content — which the X3DOM path doesn't mount (x3dom-portal-traversal-glue.mjs
//   only mounts the generic canonical-world-content.js room for every world, not the airport
//   terminal's real content). The overlay still constructs and runs correctly with zero entities
//   (`stores`/`travelers` default to empty); the projection/LOD/declutter mechanism itself is
//   exercised and verifiable with synthetic entities (see the Phase 4 spike), just not populated
//   with real airport data yet.
function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, (ch) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[ch]));
}
function isTypingTarget(target) {
    if (!target)
        return false;
    const tag = target.tagName ? target.tagName.toLowerCase() : "";
    return tag === "input" || tag === "textarea" || tag === "select" || target.isContentEditable;
}

export function createX3domHudGlue({ adapter, cameraEl, documentTarget = document, windowTarget = window, stores = [], travelers = [] }) {
    const lookup = (id) => documentTarget.getElementById(id);
    const toastController = createNotificationToastController({
        lookup,
        createElement: (tagName) => documentTarget.createElement(tagName),
        body: documentTarget.body,
        eventTarget: windowTarget,
        nowMs: () => Date.now(),
        nowIso: () => new Date().toISOString(),
        formatTime: (raw) => {
            const date = new Date(raw);
            return Number.isFinite(date.getTime()) ? date.toLocaleTimeString([], { hour12: false }) : String(raw);
        },
        setTimer: (callback, delay) => windowTarget.setTimeout(callback, delay),
        clearTimer: (timer) => windowTarget.clearTimeout(timer),
        escapeHtml,
        isTypingTarget,
    });
    toastController.mount();

    const airportHud = initAirportHudOverlay({
        adapter,
        camera: cameraEl,
        scene: null,
        document: documentTarget,
        stores,
        travelers,
    });

    return {
        toastController,
        airportHud,
        showToast: (big, sub, cls, opts) => toastController.show(big, sub, cls, opts),
        dispose: () => {
            toastController.dispose();
            if (airportHud && typeof airportHud.dispose === "function")
                airportHud.dispose();
        },
    };
}
