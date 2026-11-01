// Ported by hand from Nicholas Polys's public fork npolys/open-spatial-lab, commit 99175b4b6,
// runtime/scene-core/public/render-adapter/x3dom-inline-pool.js. Apache-2.0, like the rest of the lab. Nicholas Polys is co-author of lab commit ef702ec.
// Changes in this copy: the placeholder's path resolves beneath the lab's base path (window.__OSL_BASE_PATH__).

// Deliberately a CLASSIC (non-module) script, loaded via a plain <script src> — NOT importable
// as an ES module. It must run synchronously during the browser's initial HTML parse and use
// document.write() so its output becomes part of the same parse stream as genuinely-static
// markup. This is not a style choice: confirmed empirically (see the x3dom-spikes/ investigation
// this session) that X3DOM's <Inline> node only reliably completes its first load when it exists
// in that initial parse stream — a node built via document.createElement()/appendChild() at any
// point after page load, in any ordering, never loads. A node that DID complete that first load
// can then have its `url` attribute reassigned freely and will reliably reload with new content.
//
// So every pool slot is seeded with a placeholder glTF (giving it that one required real load),
// and x3dom-render-adapter.mjs's createInlineAsset() claims a free slot and swaps its url to the
// real target instead of creating a node from scratch.
//
// Fixed at 32 for now — WoWAPI-side content packing (bundling multiple hosted items into fewer
// served files) is expected to keep concurrent-Inline-node demand well under this, so a
// host-capability-scaled pool isn't needed yet.
(function () {
    var X3DOM_INLINE_POOL_SIZE = window.__X3DOM_INLINE_POOL_SIZE_OVERRIDE || 32;
    // The placeholder is the lab's own file, so a copy of the lab served beneath a base path finds it there. The base
    // path is window.__OSL_BASE_PATH__, read and checked as web/base-path.mjs (normalizeBasePath) does: a value that
    // is not a plain path, or none, leaves "/assets/equip-crown.glb" as it was.
    var basePath = typeof window.__OSL_BASE_PATH__ === "string" ? window.__OSL_BASE_PATH__.trim().replace(/\/+$/, "") : "";
    if (!/^(\/[A-Za-z0-9][A-Za-z0-9._~-]*)+$/.test(basePath)) basePath = "";
    var X3DOM_INLINE_POOL_PLACEHOLDER_URL = basePath + "/assets/equip-crown.glb";
    for (var i = 0; i < X3DOM_INLINE_POOL_SIZE; i += 1) {
        // render="false" on the wrapper: every slot needs one real load to become reliably
        // reloadable later (see the file header), but an unclaimed slot has no reason to be
        // visible in the meantime — without this, every idle slot sat at the origin rendering a
        // full-size, un-scaled copy of the placeholder asset, visible in the main scene ("lots of
        // crowns being drawn" — a live-QA report, since the placeholder happens to be
        // equip-crown.glb). createInlineAsset() only sets render="true" back once the claimed
        // slot's url has actually swapped to the caller's real target content (NOT immediately on
        // claim — an earlier version did that and re-introduced the same visible-crown symptom for
        // the whole swap-and-load window, which became multi-second-visible once WoW-negotiated
        // asset fetches started claiming slots); disposeNode() sets it back to "false" on release,
        // alongside the existing url reset.
        document.write("<transform render=\"false\">" +
            "<inline id=\"x3dom-inline-slot-" + i + "\" " +
            "nameSpaceName=\"x3dom-inline-slot-" + i + "-ns\" " +
            "url=\"" + X3DOM_INLINE_POOL_PLACEHOLDER_URL + "\" " +
            "data-x3dom-inline-pool-slot=\"free\" " +
            "data-x3dom-inline-pool-placeholder-url=\"" + X3DOM_INLINE_POOL_PLACEHOLDER_URL + "\"></inline>" +
            "</transform>");
    }
})();
