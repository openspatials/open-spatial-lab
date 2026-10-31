// Ported by hand from Nicholas Polys's public fork npolys/open-spatial-lab, commit 99175b4b6,
// runtime/scene-core/public/render-adapter/x3dom-render-adapter.mjs. Apache-2.0, like the rest of the lab. Nicholas Polys is co-author of lab commit ef702ec.
// Changes in this copy: added static info, multiplyScale() and a background colour for createRenderedTexture(); a material shared by several meshes now gives each mesh its own copy of the appearance.

import { RenderAdapter } from "./render-adapter.mjs";
import { decomposeTRS, transformPoint } from "./spatial-math.mjs";

// X3DOM's SFMatrix4f (as returned by an internal node's getCurrentTransform()) exposes named
// _rc (row r, column c) fields, row-major, translation in column 3 of each row — mathematically
// the same matrix as spatial-math.mjs's column-major flat-array convention, just addressed
// differently. This re-indexes into that flat layout (elements[12..14] = translation), same as
// three.js's Matrix4.elements.
function x3domMatrixToFlatColumnMajor(m) {
    return [
        m._00, m._10, m._20, m._30,
        m._01, m._11, m._21, m._31,
        m._02, m._12, m._22, m._32,
        m._03, m._13, m._23, m._33,
    ];
}

// X3D nodes ARE DOM elements — this adapter builds/mutates a real DOM subtree rather than
// wrapping a JS scene-graph library. Every "node" handle it returns is a DOM element (a
// <transform> for anything positionable, matching three.js Object3D-with-transform semantics).
// A `.userData = {}` property is set on every created node to match THREE.Object3D's built-in
// bucket, so not-yet-migrated call sites that still poke `node.userData.foo = x` directly keep
// working regardless of which adapter actually built the node.

function clamp01(n) { return Math.max(0, Math.min(1, n)); }

function parseColor(value) {
    if (value && typeof value === "object" && "r" in value && "g" in value && "b" in value)
        return { r: value.r, g: value.g, b: value.b };
    if (typeof value === "number") {
        return { r: ((value >> 16) & 255) / 255, g: ((value >> 8) & 255) / 255, b: (value & 255) / 255 };
    }
    if (typeof value === "string" && value.startsWith("#")) {
        let hex = value.slice(1);
        if (hex.length === 3)
            hex = hex.split("").map((c) => c + c).join("");
        const n = parseInt(hex, 16);
        return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
    }
    throw new Error(`X3DOMRenderAdapter: unsupported color value ${JSON.stringify(value)} (hex number or "#rrggbb"/"#rgb" string only)`);
}

function colorToFieldString(c) {
    return `${c.r.toFixed(4)} ${c.g.toFixed(4)} ${c.b.toFixed(4)}`;
}

function quaternionToAxisAngle(q) {
    const [x, y, z, w] = q;
    const clampedW = Math.max(-1, Math.min(1, w));
    const angle = 2 * Math.acos(clampedW);
    const s = Math.sqrt(1 - clampedW * clampedW);
    if (s < 1e-6)
        return [1, 0, 0, 0];
    return [x / s, y / s, z / s, angle];
}

function directionFromPosition(position) {
    const [x, y, z] = position;
    const len = Math.hypot(x, y, z) || 1;
    return [-x / len, -y / len, -z / len];
}

// Lab addition. Removing a subtree that holds an Inline whose own name space has already gone null
// makes X3DOM 1.8.3's Inline.parentRemoved throw ("reading 'removeSpace' of null"). The throw ends
// X3DOM's mutation handler, so every later DOM change of that batch is lost. A portal crossing removes
// the world's hosted objects and rebuilds the portals in one batch, so the old portals stayed on screen
// and the new portals and hosted objects were never drawn. The downloaded file stays as it is; this
// gives parentRemoved a stand-in name space for that one call, which it needs only for removeSpace.
function guardInlineRemoval(x3dom) {
    const proto = x3dom.nodeTypes?.Inline?.prototype;
    if (!proto || proto.__labRemovalGuard)
        return;
    const parentRemoved = proto.parentRemoved;
    proto.parentRemoved = function () {
        if (this._nameSpace)
            return parentRemoved.apply(this, arguments);
        this._nameSpace = { removeSpace() { } };
        try {
            return parentRemoved.apply(this, arguments);
        }
        finally {
            this._nameSpace = null;
        }
    };
    proto.__labRemovalGuard = true;
}

export class X3DOMRenderAdapter extends RenderAdapter {
    // Lab addition: what the registry and the renderer page show. The version and licence are read
    // from vendor/x3dom/VERSION and vendor/x3dom/LICENSE.md; tools/renderer/proof.mjs compares them.
    static info = Object.freeze({
        kind: "x3dom",
        label: "X3DOM",
        engine: "X3DOM",
        version: "1.8.3",
        licence: "MIT (X3DOM is dual MIT and GPL; the lab takes MIT)",
        source: "https://github.com/x3dom/x3dom, through npolys/open-spatial-lab at 99175b4b6",
        boot: "x3d-live",
        module: "./x3dom-live-mode.mjs",
        credit: "Nicholas Polys",
    });
    constructor(x3dom) {
        super();
        if (!x3dom)
            throw new Error("X3DOMRenderAdapter requires a loaded x3dom module (window.x3dom)");
        this._x3dom = x3dom;
        guardInlineRemoval(x3dom);
        this._x3dEl = null;
        this._sceneEl = null;
        this._cameraEl = null;
        this._runtime = null;
        this._frameCallbacks = [];
        this._mountEl = null;
        // Confirmed empirically (X3DOM parity Phase 3.5a): letting two createInlineAsset() calls
        // have their url-swap-and-load-poll in flight at the same time — even from unrelated pool
        // slots — intermittently throws inside X3DOM's own addNameSpace/onreadystatechange
        // internals. Not catchable from here (it's inside a vendor event handler, off the call
        // stack this code runs on). This queue guarantees at most one Inline load is ever in
        // flight app-wide, no matter which caller (avatar spawn, equipment, peer avatars, hosted
        // objects) issues it or in what order — a structural fix, not a "remember to await in
        // order" convention callers have to maintain themselves.
        //
        // Priority-aware (added alongside the WoW-negotiated hosted-object asset feature): an
        // explicit array + single active-task flag, not a plain promise chain, so a `priority: true`
        // claim (avatar/equipment) can jump ahead of already-queued-but-not-yet-started `priority:
        // false` claims (hosted objects). Needed once hosted-object WoW-fetch claims — which can
        // legitimately take several real seconds each on the demo's deliberately-common 403/404
        // denial path — started sharing this same queue: without reordering, avatar equipment could
        // sit invisible behind 2-3 hosted-object claims it has no real dependency on, then pop in
        // all at once once they finally cleared (confirmed live: ~10s of a bare, un-equipped avatar
        // before hat/torch/hammer all appeared together). Does NOT preempt an already-in-flight
        // low-priority task (can't cancel mid-load) — only reorders what's still pending.
        this._inlineQueueItems = [];
        this._inlineQueueActive = false;
    }
    /** Runs `task` only after every previously-enqueued Inline load has settled (see the
     * constructor comment) — except a `priority: true` task, which runs ahead of any pending
     * (not yet started) `priority: false` tasks, though still behind whatever is currently
     * in flight. One failure never blocks subsequent loads; `task`'s real outcome (including
     * rejection) is still returned to its caller via the returned promise. */
    _enqueueInlineLoad(task, { priority = false } = {}) {
        return new Promise((resolve, reject) => {
            const item = { task, resolve, reject };
            if (priority)
                this._inlineQueueItems.unshift(item);
            else
                this._inlineQueueItems.push(item);
            this._pumpInlineQueue();
        });
    }
    _pumpInlineQueue() {
        if (this._inlineQueueActive)
            return;
        const item = this._inlineQueueItems.shift();
        if (!item)
            return;
        this._inlineQueueActive = true;
        Promise.resolve().then(item.task).then(item.resolve, item.reject).then(() => {
            this._inlineQueueActive = false;
            this._pumpInlineQueue();
        });
    }
    get kind() { return "x3dom"; }
    get raw() { return null; }
    get sceneRoot() { return this._sceneEl; }
    get runtime() { return this._runtime; }
    /** Non-interface accessor for call sites still mid-migration (direct X3D element access). */
    get camera() { return this._cameraEl; }
    /** Current canvas pixel dimensions — same fallback chain pickViewCenter() already uses
     * internally (clientWidth/clientHeight, falling back to the width/height attributes). Public
     * because worldToScreen()'s returned canvas-pixel coordinates are only meaningful relative to
     * these bounds — a caller doing on-screen visibility/eligibility checks (not just picking a
     * single point) needs them too. */
    get canvasSize() {
        if (!this._x3dEl)
            return { width: 0, height: 0 };
        const width = this._x3dEl.clientWidth || parseInt(this._x3dEl.getAttribute("width"), 10) || 0;
        const height = this._x3dEl.clientHeight || parseInt(this._x3dEl.getAttribute("height"), 10) || 0;
        return { width, height };
    }
    /**
     * Wakes X3DOM's main render loop for the next frame (X3DOM-only — three.js's default render
     * loop is unconditional, so it has no equivalent need). Confirmed directly in the vendored
     * source (X3DCanvas.prototype.tick): `mainloop` runs every requestAnimationFrame regardless,
     * but everything inside tick() — including onEnterFrame() callback dispatch, not just the
     * actual WebGL draw — is gated behind `doc.needRender`, which X3DOM only sets itself in
     * response to its OWN DOM-attribute/field-change tracking. Any caller that mutates plain JS
     * state (not an X3D DOM attribute) and needs onEnterFrame() to keep firing every frame while
     * that state is actively changing (e.g. a mouse-drag handler updating a camera controller's
     * target angles) must call this explicitly, or onEnterFrame() silently stops running and the
     * change only shows up whenever something unrelated happens to wake the loop again — this was
     * the root cause of a real, reported "orbital camera skips frames while dragging" bug.
     * `x3dElem.render` is X3DOM's own public wake-up hook (assigned during X3DCanvas.load); this
     * is a no-op if the runtime isn't attached yet.
     */
    requestRender() {
        if (this._x3dEl && typeof this._x3dEl.render === "function")
            this._x3dEl.render();
    }
    mount(containerEl, options = {}) {
        const width = options.width || containerEl.clientWidth || 640;
        const height = options.height || containerEl.clientHeight || 420;
        const x3dEl = document.createElement("x3d");
        x3dEl.setAttribute("width", `${width}px`);
        x3dEl.setAttribute("height", `${height}px`);
        const sceneEl = document.createElement("scene");
        x3dEl.appendChild(sceneEl);
        containerEl.appendChild(x3dEl);
        this._x3dEl = x3dEl;
        this._sceneEl = sceneEl;
        this._mountEl = containerEl;
        const cameraDesc = options.camera || {};
        this._cameraEl = this.createPerspectiveCamera({
            fov: cameraDesc.fov,
            near: cameraDesc.near,
            far: cameraDesc.far,
        });
        sceneEl.appendChild(this._cameraEl);
        this._dispatchEnterFrame = () => { for (const cb of this._frameCallbacks) cb(); };
    }
    /**
     * Binds this adapter to an <x3d> element that already exists in the page's static markup,
     * instead of creating a fresh one (mount()'s behavior). Required whenever other static
     * content on the page needs to be part of X3DOM's initial parse-time discovery — the Inline
     * slot pool (x3dom-inline-pool.js) is the reason this exists: its slots only load reliably
     * when declared alongside the <x3d> host in that same static markup (see the README's
     * Render-engine adapter section). `x3dEl` must already be attached to the document; nothing
     * is appended/moved. Scene construction may proceed immediately after this returns, same as
     * mount(). Reuses an existing <scene>/<viewpoint> already inside x3dEl if present, so
     * hand-authored static markup isn't clobbered; pass `options.camera: false` to skip creating
     * one at all.
     */
    attach(x3dEl, options = {}) {
        if (!x3dEl || !x3dEl.isConnected) {
            throw new Error("X3DOMRenderAdapter.attach: x3dEl must already be attached to the document");
        }
        this._x3dEl = x3dEl;
        let sceneEl = x3dEl.querySelector(":scope > scene");
        if (!sceneEl) {
            sceneEl = document.createElement("scene");
            x3dEl.appendChild(sceneEl);
        }
        this._sceneEl = sceneEl;
        this._mountEl = x3dEl.parentElement;
        if (options.camera !== false) {
            let cameraEl = sceneEl.querySelector(":scope > viewpoint");
            if (!cameraEl) {
                const cameraDesc = typeof options.camera === "object" && options.camera ? options.camera : {};
                cameraEl = this.createPerspectiveCamera({ fov: cameraDesc.fov, near: cameraDesc.near, far: cameraDesc.far });
                sceneEl.appendChild(cameraEl);
            }
            this._cameraEl = cameraEl;
        }
        this._dispatchEnterFrame = () => { for (const cb of this._frameCallbacks) cb(); };
    }
    // Polls for runtime attachment rather than trusting a single 'load' event or the documented
    // runtime.ready callback — both are one-shot signals that can be missed if they fire before
    // a listener attaches (confirmed empirically: runtime.ready fired before window 'load' in a
    // fast/headless init, so assigning .ready afterward silently missed it). Polling state has
    // no such race.
    ready(timeoutMs = 10000) {
        if (this._runtime)
            return Promise.resolve(this._runtime);
        return new Promise((resolve, reject) => {
            const t0 = performance.now();
            const poll = () => {
                if (this._x3dEl.runtime) {
                    this._runtime = this._x3dEl.runtime;
                    this._runtime.enterFrame = this._dispatchEnterFrame;
                    return resolve(this._runtime);
                }
                if (performance.now() - t0 > timeoutMs)
                    return reject(new Error("X3DOMRenderAdapter: runtime did not attach within " + timeoutMs + "ms"));
                setTimeout(poll, 30);
            };
            poll();
        });
    }
    resize() {
        if (!this._x3dEl || !this._mountEl)
            return;
        const width = this._mountEl.clientWidth || 640;
        const height = this._mountEl.clientHeight || 420;
        this._x3dEl.setAttribute("width", `${width}px`);
        this._x3dEl.setAttribute("height", `${height}px`);
    }
    dispose() {
        this._frameCallbacks = [];
        if (this._runtime)
            this._runtime.enterFrame = null;
        if (this._x3dEl && this._x3dEl.parentNode)
            this._x3dEl.parentNode.removeChild(this._x3dEl);
        this._x3dEl = null;
        this._sceneEl = null;
        this._runtime = null;
    }
    onEnterFrame(callback) {
        this._frameCallbacks.push(callback);
        return () => {
            const index = this._frameCallbacks.indexOf(callback);
            if (index !== -1)
                this._frameCallbacks.splice(index, 1);
        };
    }
    createPerspectiveCamera({ fov, near, far } = {}) {
        const viewpoint = document.createElement("viewpoint");
        // X3D fieldOfView is the vertical FOV in radians; three.js's fov option here is degrees.
        if (fov !== undefined)
            viewpoint.setAttribute("fieldOfView", String((fov * Math.PI) / 180));
        if (near !== undefined)
            viewpoint.setAttribute("zNear", String(near));
        if (far !== undefined)
            viewpoint.setAttribute("zFar", String(far));
        return viewpoint;
    }
    setCameraPose(camera, { position, lookAt }) {
        if (position)
            camera.setAttribute("position", `${position[0]} ${position[1]} ${position[2]}`);
        if (position && lookAt) {
            // X3D Viewpoint has no lookAt(); derive an orientation quaternion from a proper
            // right/up/forward basis (Gram-Schmidt against world-up) — NOT a single shortest-arc
            // rotation from the default forward to the target forward. That simpler approach
            // (this method's original implementation) is roll-free only when azimuth or polar is
            // zero in isolation; combining both (ordinary orbit navigation does this essentially
            // all the time) tilts the shortest-arc rotation axis off-horizontal, which rolls the
            // up vector out of the vertical plane — confirmed both by direct derivation and by a
            // live roll-DOF bug report. This construction (the same one three.js's Matrix4.lookAt/
            // OpenGL's gluLookAt use) keeps "up" maximally aligned with world-up by constraining
            // it via cross products instead of a single free rotation, so azimuth (yaw) and polar
            // (pitch) combine with zero roll by construction.
            //
            // Not built on X3D Viewpoint's own `centerOfRotation` field (doc.x3dom.org/author/
            // Navigation/Viewpoint.html): that field only feeds X3DOM's own built-in EXAMINE
            // navigation, which this app doesn't use — X3DOM's internal canvas swallows every
            // mousemove via stopPropagation regardless of NavigationInfo type (confirmed directly,
            // see x3dom-movement-camera-controller.mjs's attachPointerControls()), so orbit/
            // first-person camera control is fully hand-rolled here, driven by explicit position/
            // lookAt every frame. orbit-camera-controller.mjs's own `focus` state is this app's
            // equivalent of a rotation center, computed independently of anything X3DOM tracks.
            const dir = [lookAt[0] - position[0], lookAt[1] - position[1], lookAt[2] - position[2]];
            const len = Math.hypot(...dir) || 1;
            const fwd = [dir[0] / len, dir[1] / len, dir[2] / len];
            const worldUp = [0, 1, 0];
            let right = [
                fwd[1] * worldUp[2] - fwd[2] * worldUp[1],
                fwd[2] * worldUp[0] - fwd[0] * worldUp[2],
                fwd[0] * worldUp[1] - fwd[1] * worldUp[0],
            ];
            let rightLen = Math.hypot(...right);
            if (rightLen < 1e-6) {
                // fwd is (near-)parallel to world-up (looking straight up/down) — cross product
                // against world-up is degenerate, fall back to a fixed alternate reference axis.
                const altUp = [0, 0, 1];
                right = [
                    fwd[1] * altUp[2] - fwd[2] * altUp[1],
                    fwd[2] * altUp[0] - fwd[0] * altUp[2],
                    fwd[0] * altUp[1] - fwd[1] * altUp[0],
                ];
                rightLen = Math.hypot(...right) || 1;
            }
            right = [right[0] / rightLen, right[1] / rightLen, right[2] / rightLen];
            const up = [
                right[1] * fwd[2] - right[2] * fwd[1],
                right[2] * fwd[0] - right[0] * fwd[2],
                right[0] * fwd[1] - right[1] * fwd[0],
            ];
            // Column-major rotation matrix (this file's own convention — see spatial-math.mjs's
            // header comment): local +X = right, local +Y = up, local +Z = -forward (X3D/three.js
            // cameras look down their own local -Z by default).
            const rotationMatrix = [
                right[0], right[1], right[2], 0,
                up[0], up[1], up[2], 0,
                -fwd[0], -fwd[1], -fwd[2], 0,
                0, 0, 0, 1,
            ];
            const { quaternion } = decomposeTRS(rotationMatrix);
            const [ax, ay, az, angle] = quaternionToAxisAngle(quaternion);
            camera.setAttribute("orientation", `${ax} ${ay} ${az} ${angle}`);
        }
    }
    // Confirmed empirically (not from docs — calcCanvasPos gave no signal for a point behind the
    // camera, projecting it identically to points on the same ray in front): view-space Z from
    // viewMatrix() is the reliable in-front/behind test (negative = in front, matching a camera
    // looking down -Z), independent of whatever calcCanvasPos itself does for off-screen points.
    worldToScreen(camera, worldPosition) {
        if (!this._runtime)
            return null;
        const [x, y] = this._runtime.calcCanvasPos(worldPosition[0], worldPosition[1], worldPosition[2]);
        const viewSpace = this._runtime.viewMatrix().multMatrixPnt(new this._x3dom.fields.SFVec3f(worldPosition[0], worldPosition[1], worldPosition[2]));
        return { x, y, visible: viewSpace.z < 0 };
    }
    cameraDistanceTo(camera, worldPosition) {
        const [cx, cy, cz] = camera.getAttribute("position").trim().split(/\s+/).map(Number);
        return Math.hypot(worldPosition[0] - cx, worldPosition[1] - cy, worldPosition[2] - cz);
    }
    /**
     * Picks whatever is at the exact center of the current camera view and returns
     * { node, position, normal, distance } (distance from the camera), or null if nothing is
     * hit there. Built on runtime.shootRay(x, y) — a real, synchronous Runtime method (confirmed
     * empirically: not in X3DOM's own documented API list, found in the vendored source, verified
     * against known geometry in spike-x3dom-shootray-probe.html) that picks at canvas-pixel
     * coordinates directly, unlike X3DOM's documented picking system which is DOM-event-driven
     * (onclick/onmouseover with event.hitPnt) and has no arbitrary-3D-segment query.
     *
     * Deliberately narrower than a general "raycast this segment" method: X3DOM has no way to
     * test an arbitrary 3D segment, only "what's at this canvas pixel right now." This is exactly
     * what movement-camera-controller.mjs's camera-wall/portal-aperture occlusion checks need —
     * both always test the camera's own current view center in third-person mode, since
     * setCameraPose()'s lookAt always points the camera exactly at the tested target — but a
     * caller relying on this for anything else would be wrong to assume it tests an arbitrary
     * origin/target pair.
     */
    pickViewCenter() {
        if (!this._runtime || !this._x3dEl)
            return null;
        const width = this._x3dEl.clientWidth || parseInt(this._x3dEl.getAttribute("width"), 10) || 0;
        const height = this._x3dEl.clientHeight || parseInt(this._x3dEl.getAttribute("height"), 10) || 0;
        if (!width || !height)
            return null;
        const hit = this._runtime.shootRay(width / 2, height / 2);
        if (!hit || !hit.pickObject || !hit.pickPosition)
            return null;
        const position = [hit.pickPosition.x, hit.pickPosition.y, hit.pickPosition.z];
        const [cx, cy, cz] = this._cameraEl
            ? this._cameraEl.getAttribute("position").trim().split(/\s+/).map(Number)
            : [0, 0, 0];
        return {
            node: hit.pickObject,
            position,
            normal: hit.pickNormal ? [hit.pickNormal.x, hit.pickNormal.y, hit.pickNormal.z] : null,
            distance: Math.hypot(position[0] - cx, position[1] - cy, position[2] - cz),
        };
    }
    /** World-space translation of `node` itself (not its content bounds) — its own accumulated transform's translation component. */
    getWorldPosition(node) {
        if (!node || !node._x3domNode || typeof node._x3domNode.getCurrentTransform !== "function")
            return null;
        const m = node._x3domNode.getCurrentTransform();
        return [m._03, m._13, m._23];
    }
    // Confirmed empirically (spike-x3dom-bbox-probe.html): runtime.getBBox(node) returns bounds
    // already transformed by node's OWN transform, but expressed in node's PARENT's local frame —
    // not full world space, and not node-local either. Composing that with the parent's own
    // accumulated world matrix (node.parentNode._x3domNode.getCurrentTransform()) gives true
    // world-space bounds. All 8 corners are transformed (not just min/max) so a rotated ancestor
    // still produces a correct axis-aligned world box, matching measureVisibleWorldBounds() in
    // web/wow-scene.mjs (the three.js analog this mirrors).
    measureWorldBounds(node) {
        if (!node || !node._x3domNode || !this._runtime)
            return null;
        const parent = node.parentNode;
        if (!parent)
            return null;
        const local = this._runtime.getBBox(node);
        if (!local)
            return null;
        const parentMatrix = parent._x3domNode && typeof parent._x3domNode.getCurrentTransform === "function"
            ? x3domMatrixToFlatColumnMajor(parent._x3domNode.getCurrentTransform())
            : [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
        const lo = [local.min.x, local.min.y, local.min.z];
        const hi = [local.max.x, local.max.y, local.max.z];
        if (!(hi[0] > lo[0] || hi[1] > lo[1] || hi[2] > lo[2]))
            return null;
        const corners = [
            [lo[0], lo[1], lo[2]], [hi[0], lo[1], lo[2]], [hi[0], hi[1], lo[2]], [lo[0], hi[1], lo[2]],
            [lo[0], lo[1], hi[2]], [hi[0], lo[1], hi[2]], [hi[0], hi[1], hi[2]], [lo[0], hi[1], hi[2]],
        ].map((corner) => transformPoint(parentMatrix, corner));
        const min = [Infinity, Infinity, Infinity];
        const max = [-Infinity, -Infinity, -Infinity];
        for (const corner of corners) {
            for (let axis = 0; axis < 3; axis += 1) {
                if (corner[axis] < min[axis])
                    min[axis] = corner[axis];
                if (corner[axis] > max[axis])
                    max[axis] = corner[axis];
            }
        }
        return {
            min,
            max,
            center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
            size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
        };
    }
    createGroup(name) {
        const el = document.createElement("transform");
        el.userData = {};
        if (name)
            el.name = name;
        return el;
    }
    // X3D's ClipPlane node (confirmed present in the vendored x3dom-full.js build:
    // registerNodeType("ClipPlane","Rendering",...)) uses the same ax+by+cz+d>=0-is-kept half-space
    // convention as three.js's own THREE.Plane(normal, constant) — so callers building bounding
    // volumes (portal-preview awareness clipping) can reuse that exact math unchanged, just writing
    // the 4 numbers into this attribute instead of constructing a THREE.Plane. X3DOM-only: three.js
    // never routes clip-plane logic through ThreeRenderAdapter either (portal-spatial-preview.mjs
    // builds THREE.Plane/material.clippingPlanes directly), so this isn't part of the shared
    // RenderAdapter interface — it's an adapter-owned DOM-construction primitive, same category as
    // createGroup/createGeometry, for glue code to place via the existing generic add().
    createClipPlane({ normal, constant, enabled = true }) {
        const el = document.createElement("clipplane");
        const n = Array.isArray(normal) ? normal : [0, 0, 1];
        el.setAttribute("plane", `${n[0]} ${n[1]} ${n[2]} ${Number(constant) || 0}`);
        el.setAttribute("enabled", enabled ? "true" : "false");
        return el;
    }
    // Confirmed empirically (see x3dom-spikes/ this session, exhausted every ordering of
    // document.createElement()-built Inline nodes): a dynamically-created <Inline> never
    // reliably loads, regardless of insertion order, the `load` field, or re-triggering. Only a
    // node that already completed one real load (from the static parse-time markup — see
    // x3dom-inline-pool.js) can have its `url` swapped and reliably reload with new content. So
    // this claims a slot from that pre-seeded pool rather than creating a node from scratch.
    // `priority`: true for avatar/equipment claims (player-visible, should never sit invisible
    // behind background hosted-object claims — see the queue's own comment in the constructor),
    // false (default) for everything else, including hosted-object WoW-fetch claims.
    createInlineAsset(url, options = {}, timeoutMs = 15000, priority = false) {
        // Slot claiming stays synchronous/immediate (unchanged) — only the actual url-swap and
        // load-poll below is queued, so callers still get a real node handle right away.
        const slot = document.querySelector('inline[data-x3dom-inline-pool-slot="free"]');
        if (!slot)
            throw new Error("X3DOMRenderAdapter.createInlineAsset: Inline slot pool exhausted — all slots are claimed (see x3dom-inline-pool.js)");
        slot.setAttribute("data-x3dom-inline-pool-slot", "claimed");
        const wrapper = slot.parentElement;
        wrapper.userData = wrapper.userData || {};
        wrapper._x3domPoolSlot = slot;
        const namesOf = () => Array.from(slot.children).map((c) => c.getAttribute && c.getAttribute("def")).join(",");
        const ready = this._enqueueInlineLoad(async () => {
            // Timeout is measured from when this task actually starts running, not from when
            // createInlineAsset() was called — a load queued behind several others shouldn't
            // spuriously time out just from waiting its turn.
            const t0 = performance.now();
            const pollUntil = (predicate) => new Promise((resolve, reject) => {
                const poll = () => {
                    if (predicate())
                        return resolve();
                    if (performance.now() - t0 > timeoutMs)
                        return reject(new Error(`X3DOMRenderAdapter.createInlineAsset: "${url}" did not load within ${timeoutMs}ms`));
                    setTimeout(poll, 50);
                };
                poll();
            });
            // With many pool slots primed concurrently at page-parse time, the specific slot
            // just claimed may not have finished ITS placeholder load yet — swapping url while
            // that first load is still in flight risks racing it. Wait for real content first.
            await pollUntil(() => slot.children.length > 0);
            const namesBefore = namesOf();
            slot.setAttribute("url", url);
            await pollUntil(() => slot.children.length > 0 && namesOf() !== namesBefore);
            // Only flip visible once the slot is actually showing the requested content — doing
            // this on claim instead (as this used to) left the pool's own placeholder
            // (equip-crown.glb, see x3dom-inline-pool.js) visibly rendered at the caller's
            // already-applied target transform for the whole swap-and-load window. That window
            // was near-instant for small local assets (avatar/equipment), but became a real,
            // multi-second visible "crown" flash once WoW-negotiated asset fetches (real HTTP
            // round-trips, with an explicit multi-second timeout on the deliberately-common
            // 403/404 fallback path) started using this same method.
            wrapper.setAttribute("render", "true");
            return wrapper;
        }, { priority });
        return { node: wrapper, ready };
    }
    createColor(value) { return parseColor(value); }
    multiplyColorScalar(color, scalar) {
        return { r: clamp01(color.r * scalar), g: clamp01(color.g * scalar), b: clamp01(color.b * scalar) };
    }
    colorToHexString(color) {
        const to2 = (n) => Math.round(clamp01(n) * 255).toString(16).padStart(2, "0");
        return `${to2(color.r)}${to2(color.g)}${to2(color.b)}`;
    }
    setBackgroundColor(color) {
        let bg = this._sceneEl.querySelector(":scope > background");
        if (!bg) {
            bg = document.createElement("background");
            this._sceneEl.appendChild(bg);
        }
        bg.setAttribute("skyColor", colorToFieldString(color));
    }
    createGeometry(desc) {
        switch (desc.type) {
            case "box": {
                const el = document.createElement("box");
                el.setAttribute("size", `${desc.width ?? 1} ${desc.height ?? 1} ${desc.depth ?? 1}`);
                return el;
            }
            case "plane": {
                const el = document.createElement("plane");
                el.setAttribute("size", `${desc.width ?? 1} ${desc.height ?? 1}`);
                return el;
            }
            case "sphere": {
                const el = document.createElement("sphere");
                el.setAttribute("radius", String(desc.radius ?? 1));
                return el;
            }
            case "cone": {
                const el = document.createElement("cone");
                el.setAttribute("bottomRadius", String(desc.radius ?? 0.5));
                el.setAttribute("height", String(desc.height ?? 1));
                return el;
            }
            case "cylinder": {
                const el = document.createElement("cylinder");
                el.setAttribute("radius", String(desc.radiusTop ?? desc.radiusBottom ?? 1));
                el.setAttribute("height", String(desc.height ?? 1));
                return el;
            }
            case "torus": {
                const el = document.createElement("torus");
                el.setAttribute("innerRadius", String(desc.innerRadius ?? 0.5));
                el.setAttribute("outerRadius", String(desc.outerRadius ?? 1));
                return el;
            }
            case "octahedron": {
                // X3D has no native octahedron primitive — a precise 6-vertex/8-face
                // IndexedFaceSet (three.js OctahedronGeometry(radius, 0), undivided).
                const r = desc.radius ?? 1;
                const points = [`0 ${r} 0`, `0 ${-r} 0`, `${r} 0 0`, `${-r} 0 0`, `0 0 ${r}`, `0 0 ${-r}`];
                const faces = [
                    [0, 2, 4], [0, 4, 3], [0, 3, 5], [0, 5, 2],
                    [1, 4, 2], [1, 3, 4], [1, 5, 3], [1, 2, 5],
                ];
                const coordIndex = faces.flatMap((f) => [...f, -1]);
                const coord = document.createElement("coordinate");
                coord.setAttribute("point", points.join(", "));
                const el = document.createElement("indexedfaceset");
                el.setAttribute("coordIndex", coordIndex.join(" "));
                el.setAttribute("solid", "false");
                el.appendChild(coord);
                return el;
            }
            case "edges": {
                // Only box-sourced edges are supported (the only case this codebase uses) — a
                // literal 12-edge wireframe of the box, not a generic "edges of any geometry"
                // operation like THREE's EdgesGeometry.
                if (!desc.from || desc.from.tagName?.toLowerCase() !== "box")
                    throw new Error('X3DOMRenderAdapter.createGeometry("edges"): only a box `from` source is supported so far');
                const [w, h, d] = desc.from.getAttribute("size").split(/\s+/).map(Number);
                const hw = w / 2, hh = h / 2, hd = d / 2;
                const corners = [
                    [-hw, -hh, -hd], [hw, -hh, -hd], [hw, hh, -hd], [-hw, hh, -hd],
                    [-hw, -hh, hd], [hw, -hh, hd], [hw, hh, hd], [-hw, hh, hd],
                ];
                const edgeIndices = [
                    [0, 1], [1, 2], [2, 3], [3, 0],
                    [4, 5], [5, 6], [6, 7], [7, 4],
                    [0, 4], [1, 5], [2, 6], [3, 7],
                ];
                const coord = document.createElement("coordinate");
                coord.setAttribute("point", corners.map((c) => c.join(" ")).join(", "));
                const el = document.createElement("indexedlineset");
                el.setAttribute("coordIndex", edgeIndices.map((e) => `${e[0]} ${e[1]} -1`).join(" "));
                el.appendChild(coord);
                return el;
            }
            default:
                throw new Error(`X3DOMRenderAdapter.createGeometry: type "${desc.type}" not yet implemented ` +
                    `(supported so far: box, plane, sphere, cone, cylinder, octahedron, edges(box-only) — ` +
                    `others land with the call sites that need them)`);
        }
    }
    createMaterial(desc) {
        if (desc.type !== "standard" && desc.type !== "basic" && desc.type !== "line")
            throw new Error(`X3DOMRenderAdapter.createMaterial: type "${desc.type}" not yet implemented (supported so far: standard, basic, line)`);
        const materialEl = document.createElement("material");
        const color = desc.color !== undefined ? parseColor(desc.color) : { r: 0.8, g: 0.8, b: 0.8 };
        // X3D lines aren't lit — diffuseColor alone wouldn't render visibly, so line materials
        // also drive emissiveColor from the same color (there's no separate "unlit" material
        // type in this X3DOM build to reach for instead).
        const emissive = desc.type === "line" ? color : desc.emissive !== undefined ? parseColor(desc.emissive) : { r: 0, g: 0, b: 0 };
        const base = { color, emissive, emissiveIntensity: desc.emissiveIntensity ?? 1, side: desc.side, unlit: desc.unlit };
        materialEl.setAttribute("diffuseColor", colorToFieldString(base.color));
        materialEl.setAttribute("emissiveColor", colorToFieldString(this.multiplyColorScalar(base.emissive, base.emissiveIntensity)));
        if (desc.opacity !== undefined || desc.transparent)
            materialEl.setAttribute("transparency", String(1 - (desc.opacity ?? 1)));
        const appearanceEl = document.createElement("appearance");
        appearanceEl.appendChild(materialEl);
        if (desc.map) {
            const validMapKinds = ["x3d-canvas-texture", "x3d-rendered-texture"];
            if (!validMapKinds.includes(desc.map.kind))
                throw new Error('X3DOMRenderAdapter.createMaterial: "map" must be a handle from createCanvasTexture() or createRenderedTexture()');
            appearanceEl.appendChild(desc.map.el);
            // RenderedTexture's own `flipY` field, combined with a <TextureProperties> child on
            // the SAME element (needed for smooth filtering — see createRenderedTexture()'s own
            // comment), was confirmed live to break unrelated rendering elsewhere in the document
            // (the avatar's own diffuse-mapped body went fully invisible; equipment items using
            // vertex-color-only materials were unaffected — consistent with, though not conclusively
            // isolated to, some shared texture-pipeline state corrupted by that specific
            // combination). Flipping via a <TextureTransform> on the CONSUMING material instead
            // avoids touching the RenderedTexture element itself a second way, sidestepping the
            // interaction entirely — confirmed live this does not reproduce the same regression.
            if (desc.map.kind === "x3d-rendered-texture") {
                const textureTransform = document.createElement("texturetransform");
                textureTransform.setAttribute("center", "0.5 0.5");
                textureTransform.setAttribute("scale", "1 -1");
                appearanceEl.appendChild(textureTransform);
            }
        }
        return { kind: "x3d-material", appearanceEl, materialEl, base, mapTexture: desc.map || null };
    }
    _wrapShape(geometry, material) {
        // Bridges createMaterial()'s `side` field onto the geometry element: X3DOM's geometry
        // nodes (Plane included) inherit a `solid` SFBool field from X3DGeometryNode, default
        // true (backface-culled), with no material-level equivalent — so "double-sided" has to be
        // expressed on the geometry side even though callers request it on the material desc.
        if (material.base?.side === "double" && typeof geometry.setAttribute === "function")
            geometry.setAttribute("solid", "false");
        // Lab addition: X3DOM lights a texture like any surface, so a preview on a portal facing away
        // from the room's key light drew almost black. `unlit` turns lighting off for that geometry.
        if (material.base?.unlit && typeof geometry.setAttribute === "function")
            geometry.setAttribute("lit", "false");
        const shape = document.createElement("shape");
        // Lab change: an element has one parent, so a material used by a second mesh moved its
        // appearance away from the first, and the first mesh lost its colour. Each further mesh
        // gets a copy. setMaterialProperty() still reaches only the first; no caller changes a shared material.
        shape.appendChild(material.appearanceEl.parentNode ? material.appearanceEl.cloneNode(true) : material.appearanceEl);
        shape.appendChild(geometry);
        const transform = document.createElement("transform");
        transform.appendChild(shape);
        transform.userData = {};
        transform._x3dShape = shape;
        return transform;
    }
    createMesh(geometry, material) { return this._wrapShape(geometry, material); }
    // Note: unlike createMesh(), this doesn't re-apply the side->solid bridge above (no material
    // handle is available here to read `side` from) — fine for every current caller (only
    // wow-scene.mjs's floor-resize path uses setGeometry, and the floor's material never requests
    // side:"double"), but a future setGeometry() caller needing double-sided geometry would need
    // to set `solid="false"` on the geometry element itself before calling this.
    setGeometry(mesh, geometry) {
        const shape = mesh._x3dShape;
        const old = shape.querySelector(":scope > *:not(appearance)");
        if (old)
            shape.removeChild(old);
        shape.appendChild(geometry);
    }
    // X3D has no separate "line segments" node type distinct from a mesh — an IndexedLineSet
    // geometry inside a Shape renders as lines, same wrapping as createMesh either way.
    createLineSegments(geometry, material) { return this._wrapShape(geometry, material); }
    createLine(geometry, material) { return this._wrapShape(geometry, material); }
    // X3D's ImageTexture.url accepts a data: URI directly, so a live 2D canvas can be wrapped
    // without a dedicated "canvas texture" node type — updateCanvasTexture() re-reads the same
    // canvas on demand (X3DOM has no canvas-backed live-texture primitive to bind to instead).
    createCanvasTexture(canvas) {
        if (!canvas || typeof canvas.toDataURL !== "function")
            throw new Error("X3DOMRenderAdapter.createCanvasTexture: requires a 2D <canvas> element");
        const textureEl = document.createElement("imagetexture");
        textureEl.setAttribute("url", canvas.toDataURL());
        return { kind: "x3d-canvas-texture", el: textureEl, canvas };
    }
    /** Re-reads the handle's source canvas and pushes the new pixels to the live ImageTexture node. */
    updateCanvasTexture(textureHandle) {
        if (!textureHandle || textureHandle.kind !== "x3d-canvas-texture")
            throw new Error("X3DOMRenderAdapter.updateCanvasTexture: requires a handle from createCanvasTexture()");
        textureHandle.el.setAttribute("url", textureHandle.canvas.toDataURL());
    }
    // X3D's RenderedTexture node (confirmed present in the vendored x3dom-full.js build:
    // registerNodeType("RenderedTexture","Texturing",...)) — a genuine GPU render-to-texture
    // primitive. X3DOM-only, same category as createClipPlane above: three.js has no equivalent
    // routed through ThreeRenderAdapter either (its own portal preview builds a raw
    // THREE.WebGLRenderTarget directly — see three-portal-renderer.mjs).
    //
    // Isolation is via the `scene` field, NOT `excludeNodes` — confirmed empirically (see
    // tools/x3dom-spikes/spike-run-rendered-texture-v2.mjs, the Stage 0 feasibility spike this
    // primitive is built from). Leaving `scene` unset forces two problems: the RT falls back to
    // reusing the MAIN scene's already-collected drawable list for its own render pass (so the
    // consuming aperture itself would be part of what's rendered, needing `excludeNodes` to hide
    // it — fragile, since `excludeNodes` toggles a `visible` field that bare geometry leaves don't
    // even have), AND the nested <viewpoint>'s view-matrix computation takes a code path that
    // composes it with `viewpoint.getCurrentTransform().inverse()` — correct only for a viewpoint
    // that's a true Transform-hierarchy descendant, which a <viewpoint> nested under
    // <renderedtexture>/<appearance>/<shape>/<transform> technically is, wrongly pulling in the
    // consumer's own ancestor transform as an offset. Setting `scene` sidesteps both: the RT
    // recomputes drawables from ONLY the referenced subtree, and the viewpoint's matrix is used
    // directly with no ancestor-transform composition.
    //
    // `scene` is bound via a DIRECT JS node-reference assignment (bindRenderedTextureScene() below),
    // NOT a DOM <... containerField="scene" USE="..."> element — confirmed empirically that the
    // DOM/USE path is unreliable at real-app scale: it worked in every isolated spike (single- and
    // multi-portal, attach()-mounted, transparent materials, async-gap population — all reproduced
    // individually and combined) but silently failed against the live app specifically (`_cf.scene.node`
    // stayed null even though the USE element and its DEF target both existed and were independently
    // registered), which sent RenderedTexture down the "reuse main scene" fallback path — including
    // the consuming aperture itself in what gets rendered, producing a real, repeating
    // `GL_INVALID_OPERATION: Feedback loop formed between Framebuffer and active Texture` and a
    // black aperture. Same category of quirk this project has hit before with dynamically-created
    // nodes (Inline pool pre-seeding, the shared Inline-load queue) — DOM-mutation-driven resolution
    // isn't reliable at this app's real scale/concurrency, so this binds the model-layer node
    // reference directly instead of routing through it.
    //
    // `fov`/`near`/`far` size the nested viewpoint's own projection explicitly (same defaults the
    // old hidden-host portal-preview camera used) rather than leaving it at X3D's -1/-1 "automatic"
    // default — the automatic path reads the same whole-document bounding-volume computation that
    // motivated forcing explicit values on the MAIN camera too (see web/index.html's
    // #x3dom-viewpoint comment), so leaving this one automatic would reintroduce the identical
    // depth-precision risk for the destination content itself. Returns { kind, el, viewpoint } —
    // `viewpoint` is a separate node handle (a real <viewpoint> child element, not an attribute), so
    // callers can drive its position/orientation every frame via the existing setCameraPose(), the
    // same way real cameras already are. Callers MUST also call bindRenderedTextureScene() once the
    // target subtree exists — a bare createRenderedTexture() has no `scene` field set yet.
    //
    // `TextureProperties` with NICEST/LINEAR filtering — X3D's own default for both
    // magnificationFilter and minificationFilter is `"FASTEST"` (nearest-neighbor — confirmed via
    // x3dom-full.js's `magFilterDic`/`minFilterDic`, where `"FASTEST"` maps directly to WebGL's
    // NEAREST), producing blocky, unfiltered sampling of a small (down to 128px) texture magnified
    // onto a much larger aperture plane at close range. `magnificationFilter: "NICEST"` maps to
    // LINEAR (smooth bilinear); `minificationFilter: "LINEAR"` (not "NICEST", which maps to a
    // mipmap-chain filter requiring `generateMipMaps` — not worth regenerating a full mipmap chain
    // every single frame for update="always" content) gives smooth, cheap filtering without that
    // cost.
    //
    // Vertical flip is deliberately NOT handled here via `flipY` (a real field, inherited from the
    // shared X3DTextureNode base class every texture node including RenderedTexture has, confirmed
    // in x3dom-full.js — just not listed on RenderedTexture's own doc page). `flipY="true"` alone
    // works fine, and `TextureProperties` alone works fine, but the TWO COMBINED on this element
    // were confirmed live to break unrelated rendering elsewhere in the document (the avatar's own
    // diffuse-mapped body went fully invisible; flat/vertex-color equipment items were unaffected —
    // consistent with, though not conclusively isolated to, shared texture-pipeline state being
    // corrupted by that specific combination). The flip is applied via a <TextureTransform> on the
    // CONSUMING material instead (see createMaterial()'s own comment) — confirmed live this does
    // not reproduce the regression, since it never sets flipY on this element at all.
    createRenderedTexture({ dimensions = [128, 128, 4], update = "always", fov = 55, near = 0.1, far = 30, backgroundColor = null } = {}) {
        const el = document.createElement("renderedtexture");
        el.setAttribute("dimensions", dimensions.join(" "));
        el.setAttribute("update", update);
        const textureProperties = document.createElement("textureproperties");
        textureProperties.setAttribute("magnificationFilter", "NICEST");
        textureProperties.setAttribute("minificationFilter", "LINEAR");
        el.appendChild(textureProperties);
        const viewpoint = this.createPerspectiveCamera({ fov, near, far });
        viewpoint.setAttribute("containerField", "viewpoint");
        el.appendChild(viewpoint);
        // Lab addition: X3DOM clears a RenderedTexture to black, so whatever lay outside the portal's
        // clip volume showed as black. A flat colour reads as the destination instead.
        if (backgroundColor) {
            const background = document.createElement("background");
            background.setAttribute("containerField", "background");
            background.setAttribute("skyColor", colorToFieldString(parseColor(backgroundColor)));
            el.appendChild(background);
        }
        return { kind: "x3d-rendered-texture", el, viewpoint };
    }
    // Binds `rt`'s `scene` field directly to `targetEl`'s own model-layer node — see
    // createRenderedTexture()'s comment for why this bypasses the DOM USE/DEF path entirely. Both
    // `rt.el` and `targetEl` need their own `_x3domNode` assigned by X3DOM's (asynchronous,
    // MutationObserver-driven) node registration before this can complete, so this polls rather than
    // assuming either is ready synchronously — the same pattern createInlineAsset()'s own load-poll
    // already uses for the identical class of "dynamically-added node isn't immediately live" gap.
    async bindRenderedTextureScene(rt, targetEl, timeoutMs = 5000) {
        const t0 = performance.now();
        const poll = () => new Promise((resolve, reject) => {
            const attempt = () => {
                const rtNode = rt.el._x3domNode;
                const targetNode = targetEl._x3domNode;
                if (rtNode && targetNode) {
                    rtNode._cf.scene.node = targetNode;
                    return resolve();
                }
                if (performance.now() - t0 > timeoutMs)
                    return reject(new Error("X3DOMRenderAdapter.bindRenderedTextureScene: node(s) not registered within " + timeoutMs + "ms"));
                setTimeout(attempt, 30);
            };
            attempt();
        });
        await poll();
    }
    // Lab additions, so the portal glue can drive X_ITE's RenderedTexture through the same four calls.
    attachRenderedTexture(material, rt) { material.appearanceEl.appendChild(rt.el); }
    mountRenderedTextureStage(stage) { this.add(this.sceneRoot, stage); }
    setRenderedTextureUpdate(rt, mode) { rt.el.setAttribute("update", mode); }
    createSprite() { throw new Error("X3DOMRenderAdapter.createSprite: not yet implemented"); }
    createGridHelper({ size, divisions, colorGrid, transparent, opacity }) {
        const half = size / 2;
        const step = size / divisions;
        const points = [];
        const coordIndex = [];
        let idx = 0;
        for (let i = 0; i <= divisions; i += 1) {
            const pos = -half + i * step;
            points.push(`${-half} 0 ${pos}`, `${half} 0 ${pos}`);
            coordIndex.push(idx, idx + 1, -1);
            idx += 2;
            points.push(`${pos} 0 ${-half}`, `${pos} 0 ${half}`);
            coordIndex.push(idx, idx + 1, -1);
            idx += 2;
        }
        const coord = document.createElement("coordinate");
        coord.setAttribute("point", points.join(", "));
        const lineSet = document.createElement("indexedlineset");
        lineSet.setAttribute("coordIndex", coordIndex.join(" "));
        lineSet.appendChild(coord);
        const material = document.createElement("material");
        material.setAttribute("emissiveColor", colorToFieldString(parseColor(colorGrid ?? 0xffffff)));
        material.setAttribute("diffuseColor", "0 0 0");
        if (transparent && opacity !== undefined)
            material.setAttribute("transparency", String(1 - opacity));
        const appearance = document.createElement("appearance");
        appearance.appendChild(material);
        const shape = document.createElement("shape");
        shape.appendChild(appearance);
        shape.appendChild(lineSet);
        const transform = document.createElement("transform");
        transform.appendChild(shape);
        transform.userData = {};
        // colorCenterLine is not distinguished from colorGrid here — a documented simplification
        // for this debug-only helper, not worth a second line-set + material for now.
        return transform;
    }
    createAmbientLight({ color, intensity }) {
        const light = document.createElement("directionallight");
        light.setAttribute("direction", "0 -1 0");
        light.setAttribute("ambientIntensity", String(intensity ?? 1));
        light.setAttribute("intensity", "0");
        light.setAttribute("color", colorToFieldString(parseColor(color ?? 0xffffff)));
        light.userData = {};
        return light;
    }
    createDirectionalLight({ color, intensity, position }) {
        const light = document.createElement("directionallight");
        const dir = position ? directionFromPosition(position) : [0, -1, 0];
        light.setAttribute("direction", dir.join(" "));
        light.setAttribute("intensity", String(intensity ?? 1));
        light.setAttribute("color", colorToFieldString(parseColor(color ?? 0xffffff)));
        light.userData = {};
        return light;
    }
    add(parent, child) { parent.appendChild(child); }
    remove(parent, child) { if (child.parentNode === parent) parent.removeChild(child); }
    setName(node, name) { node.name = name; }
    setPosition(node, x, y, z) { node.setAttribute("translation", `${x} ${y} ${z}`); }
    // Every call site in this codebase sets exactly one axis per node (never composes x+y+z
    // rotations on the same node across multiple calls), so overwriting the whole `rotation`
    // field with a single-axis value matches actual usage exactly. Would need real composition
    // if that assumption ever stops holding.
    setRotationAxis(node, axis, radians) {
        const vec = axis === "x" ? "1 0 0" : axis === "y" ? "0 1 0" : "0 0 1";
        node.setAttribute("rotation", `${vec} ${radians}`);
    }
    setLocalMatrix(node, matrix16) {
        const { translation, quaternion, scale } = decomposeTRS(matrix16);
        const [ax, ay, az, angle] = quaternionToAxisAngle(quaternion);
        node.setAttribute("translation", translation.join(" "));
        node.setAttribute("rotation", `${ax} ${ay} ${az} ${angle}`);
        node.setAttribute("scale", scale.join(" "));
    }
    setScaleScalar(node, scale) { node.setAttribute("scale", `${scale} ${scale} ${scale}`); }
    // Lab addition, so the shared humanoid provider does not read an X3DOM attribute itself.
    multiplyScale(node, factor) {
        const [sx, sy, sz] = (node.getAttribute("scale") || "1 1 1").trim().split(/\s+/).map(Number);
        node.setAttribute("scale", `${sx * factor} ${sy * factor} ${sz * factor}`);
    }
    setVisible(node, visible) { node.setAttribute("render", visible ? "true" : "false"); }
    setUserData(node, key, value) {
        node.userData = node.userData || {};
        node.userData[key] = value;
    }
    setMaterialProperty(material, key, value) {
        if (key === "opacity") {
            material.materialEl.setAttribute("transparency", String(1 - value));
            return;
        }
        if (key === "emissiveIntensity") {
            material.base.emissiveIntensity = value;
            material.materialEl.setAttribute("emissiveColor", colorToFieldString(this.multiplyColorScalar(material.base.emissive, value)));
            return;
        }
        if (key === "transparent")
            return; // X3D has no separate transparent flag — transparency alone governs it.
        throw new Error(`X3DOMRenderAdapter.setMaterialProperty: key "${key}" not yet implemented`);
    }
    recolorSubtreeMaterials(node, hexColor) {
        const colorStr = colorToFieldString(parseColor(hexColor));
        node.querySelectorAll("material").forEach((materialEl) => {
            materialEl.setAttribute("diffuseColor", colorStr);
            materialEl.setAttribute("emissiveColor", colorStr);
        });
    }
    disposeGeometry() { /* DOM removal (disposeNode/remove) is what releases X3D resources — no separate step */ }
    disposeMaterial() { /* same as disposeGeometry */ }
    disposeNode(node) {
        // A pool-backed Inline wrapper is a permanent pool member — release it back to the
        // placeholder/free state rather than removing it from the DOM (removing it would shrink
        // the fixed-size pool for good, since a freshly re-created replacement wouldn't load).
        if (node._x3domPoolSlot) {
            const slot = node._x3domPoolSlot;
            const placeholderUrl = slot.getAttribute("data-x3dom-inline-pool-placeholder-url") || slot.getAttribute("url");
            slot.setAttribute("url", placeholderUrl);
            slot.setAttribute("data-x3dom-inline-pool-slot", "free");
            // Hide it again — a freed slot goes back to being an idle, unclaimed pool member (see
            // the render="true" set on claim, and x3dom-inline-pool.js's own comment).
            node.setAttribute("render", "false");
            delete node._x3domPoolSlot;
            return;
        }
        if (node.parentNode)
            node.parentNode.removeChild(node);
    }
}
