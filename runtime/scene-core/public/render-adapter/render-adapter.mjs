// Ported by hand from Nicholas Polys's public fork npolys/open-spatial-lab, commit 99175b4b6,
// runtime/scene-core/public/render-adapter/render-adapter.mjs. Apache-2.0, like the rest of the lab. Nicholas Polys is co-author of lab commit ef702ec.
// Changes in this copy: his class is unchanged; the code that chooses an engine from ?renderer= is the lab's, added below it.

// Engine-agnostic contract for scene construction + a render loop, so scene-building code
// (scene.js, canonical-world-content.js, wow-scene.mjs, ...) does not import an engine module
// directly. Concrete engines (ThreeRenderAdapter, and later an X3DOMRenderAdapter) implement this.
//
// Node/geometry/material/camera handles returned by this interface are OPAQUE to callers — never
// reach into them expecting a specific engine's object shape. Use `raw` only in code that is
// explicitly transitional (not yet ported off direct engine access); it returns null on adapters
// that don't expose one (e.g. X3DOM has no equivalent escape hatch to a WebGL/THREE namespace).
export class RenderAdapter {
    constructor() {
        if (new.target === RenderAdapter) {
            throw new Error("RenderAdapter is an interface; instantiate a concrete adapter (e.g. ThreeRenderAdapter)");
        }
    }
    /** Engine identifier, e.g. "three" or "x3dom". */
    get kind() { throw new Error("not implemented"); }
    /** Transitional escape hatch to the underlying engine module/namespace, or null if none. */
    get raw() { throw new Error("not implemented"); }
    /** Opaque handle to the root of the scene graph. */
    get sceneRoot() { throw new Error("not implemented"); }
    /** Flat background color (X3D: a single-color Background node's skyColor field). */
    setBackgroundColor(color) { throw new Error("not implemented"); }
    /**
     * Creates the renderer/canvas and appends it into containerEl. Throws if the engine can't
     * run here. Synchronous: only does setup that doesn't require a live runtime — scene
     * construction (createGroup/createMesh/add/...) may proceed immediately after this returns,
     * without awaiting ready(). Some engines (X3DOM) attach their runtime asynchronously; mount()
     * itself never waits for that.
     */
    mount(containerEl, options = {}) { throw new Error("not implemented"); }
    /**
     * Resolves once the engine's runtime can actually render/pick/query (camera pose reads,
     * picking, screenshots, etc.) — NOT a precondition for scene construction. Resolves
     * immediately on engines that are fully synchronous after mount() (e.g. three.js).
     */
    ready() { throw new Error("not implemented"); }
    /** Recomputes renderer size from containerEl's current dimensions. */
    resize() { throw new Error("not implemented"); }
    /** Tears down the renderer/canvas and releases resources. */
    dispose() { throw new Error("not implemented"); }
    /** Registers a callback invoked once per rendered frame, before that frame is drawn. */
    onEnterFrame(callback) { throw new Error("not implemented"); }
    createPerspectiveCamera({ fov, aspect, near, far }) { throw new Error("not implemented"); }
    setCameraPose(camera, { position, lookAt }) { throw new Error("not implemented"); }
    /**
     * Projects a world position to container-relative screen pixels, for DOM-overlay HUD
     * elements that track a 3D position. Requires ready() — unlike construction, this is a
     * live-runtime query. Returns { x, y, visible } (visible = in front of the camera; does NOT
     * check on-screen bounds — compare x/y against the container's width/height for that) or
     * null if it can't be computed yet.
     */
    worldToScreen(camera, worldPosition) { throw new Error("not implemented"); }
    /** Straight-line distance from the camera's current position to a world position. */
    cameraDistanceTo(camera, worldPosition) { throw new Error("not implemented"); }
    createGroup(name) { throw new Error("not implemented"); }
    /**
     * Loads an external asset (glTF today; model/x3d+xml where the WoW asset endpoint offers it —
     * see the README's Render-engine adapter section) and mounts it under a fresh transform node.
     * Returns { node, ready } — node is available immediately (construction stays synchronous,
     * same as everything else in this interface), ready is a Promise resolving once content has
     * actually loaded. options.loadGltf/cloneScene mirror wow-scene.mjs's existing injected-loader
     * pattern and are REQUIRED for ThreeRenderAdapter (it has no built-in glTF import); X3DOMRenderAdapter
     * ignores them — X3D's native <Inline> node imports glTF on its own.
     */
    createInlineAsset(url, options = {}) { throw new Error("not implemented"); }
    /** Parses a color (hex number, "#rrggbb", CSS name, ...) into an opaque color handle. */
    createColor(value) { throw new Error("not implemented"); }
    /** Returns a new color handle scaled by `scalar` (darken/lighten); does not mutate `color`. */
    multiplyColorScalar(color, scalar) { throw new Error("not implemented"); }
    colorToHexString(color) { throw new Error("not implemented"); }
    /**
     * type: "box" | "plane" | "circle" | "torus" | "capsule" | "sphere" | "cone" | "octahedron" | "cylinder"
     *     | "edges" (wraps another geometry handle, given as `from`)
     *     | "points" (polyline through `points`, an array of [x,y,z])
     * Remaining fields are geometry-specific dimensions (see ThreeRenderAdapter for the exact set).
     */
    createGeometry(desc) { throw new Error("not implemented"); }
    /**
     * type: "standard" | "basic" | "line" | "sprite"
     * Fields: color, emissive, emissiveIntensity, roughness, metalness, transparent, opacity,
     * side ("front" | "back" | "double"), map (texture handle), depthWrite.
     */
    createMaterial(desc) { throw new Error("not implemented"); }
    createMesh(geometry, material) { throw new Error("not implemented"); }
    /** Replaces a mesh's geometry in place (e.g. resizing a floor plane). */
    setGeometry(mesh, geometry) { throw new Error("not implemented"); }
    createLineSegments(geometry, material) { throw new Error("not implemented"); }
    /** A continuous polyline (as opposed to createLineSegments' disconnected pairs). */
    createLine(geometry, material) { throw new Error("not implemented"); }
    /** Builds a live texture from a 2D <canvas> element (e.g. drawn text/labels). */
    createCanvasTexture(canvas, options = {}) { throw new Error("not implemented"); }
    createSprite(material) { throw new Error("not implemented"); }
    createGridHelper({ size, divisions, colorCenterLine, colorGrid, transparent, opacity }) { throw new Error("not implemented"); }
    createAmbientLight({ color, intensity }) { throw new Error("not implemented"); }
    createDirectionalLight({ color, intensity, position }) { throw new Error("not implemented"); }
    add(parent, child) { throw new Error("not implemented"); }
    remove(parent, child) { throw new Error("not implemented"); }
    setName(node, name) { throw new Error("not implemented"); }
    setPosition(node, x, y, z) { throw new Error("not implemented"); }
    setRotationAxis(node, axis, radians) { throw new Error("not implemented"); }
    /** Sets a node's local transform from a flat 16-element column-major matrix (spatial-math.mjs layout). */
    setLocalMatrix(node, matrix16) { throw new Error("not implemented"); }
    setScaleScalar(node, scale) { throw new Error("not implemented"); }
    setVisible(node, visible) { throw new Error("not implemented"); }
    setUserData(node, key, value) { throw new Error("not implemented"); }
    setMaterialProperty(material, key, value) { throw new Error("not implemented"); }
    /** Recolors every material found under (and including) node — e.g. marking an asset placeholder unavailable. */
    recolorSubtreeMaterials(node, hexColor) { throw new Error("not implemented"); }
    disposeGeometry(geometry) { throw new Error("not implemented"); }
    disposeMaterial(material) { throw new Error("not implemented"); }
    /** Recursively disposes every geometry/material under (and including) node. */
    disposeNode(node) { throw new Error("not implemented"); }
}

// ----------------------------------------------------------------------------------------------
// Lab addition: choosing the engine. The renderer is chosen ONCE at boot from ?renderer=:
//
//   absent            three.js, through app.js (the default)
//   ?renderer=three   three.js, through app.js
//   ?renderer=x3dom   X3DOM, through x3dom-live-mode.mjs (Nicholas's boot path)
//   ?renderer=x_ite   X_ITE, through x-ite-live-mode.mjs (the same boot path)
//   anything else     unknown: three.js draws and the page says so
// ----------------------------------------------------------------------------------------------
export const DEFAULT_RENDER_ADAPTER_KIND = "three";

/** Every method and field of the interface above, read from the class itself. */
export const RENDER_ADAPTER_METHODS = Object.freeze(
    Object.getOwnPropertyNames(RenderAdapter.prototype).filter((name) => name !== "constructor"),
);

// Spellings a person may type for the same engine. The kind on the right is canonical.
const RENDERER_ALIASES = Object.freeze({
    three: "three",
    "three.js": "three",
    threejs: "three",
    x3dom: "x3dom",
    x_ite: "x_ite",
    "x-ite": "x_ite",
    xite: "x_ite",
});

// What the boot needs to know of each engine, with no engine loaded.
const RENDERER_CHOICES = Object.freeze({
    three: Object.freeze({ kind: "three", label: "three.js" }),
    x3dom: Object.freeze({ kind: "x3dom", label: "X3DOM" }),
    x_ite: Object.freeze({ kind: "x_ite", label: "X_ITE" }),
});

/** The boot's choice from ?renderer=, resolved with no engine loaded. */
export function chooseRendererAtBoot(search) {
    return resolveRenderAdapter(search, RENDERER_CHOICES);
}

/** Reads ?renderer= from a search string or URLSearchParams. Returns the raw value, or null. */
export function readRendererParam(search) {
    const params = search instanceof URLSearchParams ? search : new URLSearchParams(search || "");
    const raw = params.get("renderer");
    return raw == null ? null : raw.trim();
}

/** The canonical kind ?renderer= names, or null when it is absent or unknown. Needs no engine loaded. */
export function rendererKindFromSearch(search) {
    const requested = readRendererParam(search);
    if (!requested) return null;
    const key = requested.toLowerCase();
    return Object.prototype.hasOwnProperty.call(RENDERER_ALIASES, key) ? RENDERER_ALIASES[key] : null;
}

/** Interface members an adapter class does not implement. Empty means it covers the whole boundary. */
export function missingAdapterMethods(AdapterClass) {
    return RENDER_ADAPTER_METHODS.filter((name) => {
        for (let proto = AdapterClass.prototype; proto && proto !== RenderAdapter.prototype; proto = Object.getPrototypeOf(proto)) {
            if (Object.prototype.hasOwnProperty.call(proto, name)) return false;
        }
        return true;
    });
}

/** Throws unless a registry entry says who it is and how it boots. */
export function assertRenderAdapterEntry(entry) {
    if (!entry || typeof entry !== "object") throw new Error("render adapter entry must be an object");
    for (const field of ["kind", "label", "engine", "version", "licence", "source", "boot"]) {
        if (typeof entry[field] !== "string" || !entry[field]) throw new Error(`render adapter entry is missing ${field}`);
    }
    if (entry.boot === "app" && !entry.adapter) throw new Error(`render adapter ${entry.kind} boots through app.js and needs an adapter instance`);
    return entry;
}

/**
 * Chooses the engine. `registry` maps kinds to entries and must hold the default (three). Returns
 * a plain record the page shows and the proof reads:
 *
 *   requested  what the URL asked for (null when absent)
 *   selected   the kind it named, or null when unknown or absent
 *   active     the entry that draws
 *   fallback   true when the request could not be honoured
 *   reason     "default" | "selected" | "unknown_renderer"
 *   message    one plain sentence for the page, or "" when nothing needs saying
 */
export function resolveRenderAdapter(search, registry) {
    const fallbackEntry = registry && registry[DEFAULT_RENDER_ADAPTER_KIND];
    if (!fallbackEntry) throw new Error("render adapter registry must hold the three.js adapter");
    const requested = readRendererParam(search);
    if (requested == null || requested === "") {
        return Object.freeze({ requested: null, selected: null, active: fallbackEntry, fallback: false, reason: "default", message: "" });
    }
    const selected = rendererKindFromSearch(search);
    const entry = selected ? registry[selected] : null;
    if (!entry) {
        return Object.freeze({
            requested,
            selected: null,
            active: fallbackEntry,
            fallback: true,
            reason: "unknown_renderer",
            message: `Unknown renderer "${requested}". Showing the ${fallbackEntry.label} renderer. ` +
                `Known renderers: ${Object.keys(registry).join(", ")}.`,
        });
    }
    return Object.freeze({ requested, selected, active: entry, fallback: false, reason: "selected", message: "" });
}

/** A JSON-safe summary of a resolution, for window.__renderAdapter and data attributes. */
export function describeRenderAdapterChoice(choice) {
    return {
        requested: choice.requested,
        selected: choice.selected,
        active: choice.active.kind,
        active_label: choice.active.label,
        active_version: choice.active.version || null,
        fallback: choice.fallback,
        reason: choice.reason,
        message: choice.message,
    };
}

/** Shows the resolution's message over the scene. Does nothing when there is nothing to say. */
export function mountRenderAdapterNotice(documentTarget, choice) {
    if (!documentTarget || !choice || !choice.message) return null;
    const existing = documentTarget.getElementById("render-adapter-notice");
    if (existing) existing.remove();
    const notice = documentTarget.createElement("div");
    notice.id = "render-adapter-notice";
    notice.setAttribute("role", "status");
    notice.dataset.reason = choice.reason;
    notice.textContent = choice.message;
    Object.assign(notice.style, {
        position: "fixed",
        left: "50%",
        top: "calc(var(--osl-shell-header-height, 56px) + 10px)",
        transform: "translateX(-50%)",
        zIndex: "40",
        maxWidth: "min(640px, calc(100vw - 32px))",
        padding: "10px 14px",
        borderRadius: "10px",
        border: "1px solid var(--osl-pending, #D6A94A)",
        background: "var(--osl-surface-raised, #1E1F26)",
        color: "var(--ink, #F5F5F7)",
        font: "14px/1.4 'Space Grotesk', system-ui, sans-serif",
        boxShadow: "0 6px 24px rgba(0,0,0,.45)",
        pointerEvents: "none",
    });
    documentTarget.body.appendChild(notice);
    return notice;
}
