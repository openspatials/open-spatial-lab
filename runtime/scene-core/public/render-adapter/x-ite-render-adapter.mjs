// X_ITE adapter for the lab's render boundary. New in the lab; written against Nicholas
// Polys's RenderAdapter interface (render-adapter.mjs) and modelled on his X3DOMRenderAdapter, from
// npolys/open-spatial-lab at commit 99175b4b6. X_ITE 16.6.0 is by Holger Seelig and contributors,
// MIT licence (vendor/x_ite/LICENSE.md, vendor/x_ite/package.json).
//
// X3DOM nodes are DOM elements, so its adapter hands out elements. X_ITE is driven through its
// Scene Access Interface, so this adapter hands out small wrapper objects (XNode) that hold the X3D
// node, its parent and a userData bucket. As with every adapter, callers treat handles as opaque.
//
// Where this adapter differs from X3DOM's:
// - Scene construction must wait for ready(). X_ITE creates its scene asynchronously, so mount()
//   cannot promise synchronous construction. The boot path awaits ready() on both engines.
// - createInlineAsset() needs no slot pool: an X_ITE Inline made at any time loads. Each new Inline
//   is added to the scene root at once, the same starting place X3DOM's pool slots have.
// - X_ITE's RenderedTexture node keeps its own scene in its `children` field, and its source marks it
//   "still experimental". The lights in that scene must not be global. A preview's stage is therefore
//   not part of the main scene, and clip planes are limited: see clipPlaneLimit.
// - X_ITE has no public pick-at-pixel call, so pickViewCenter() tests the view's centre line itself,
//   in JavaScript, against the opaque flat planes and boxes this adapter built. The third-person camera
//   needs this to hide a wall that comes between it and the avatar, as it does on X3DOM. Curved shapes
//   and models loaded from files are not tested.
import { RenderAdapter } from "./render-adapter.mjs";
import { composeTRS, decomposeTRS, multiplyMat4, transformPoint, IDENTITY_MAT4 } from "./spatial-math.mjs";

function clamp01(n) { return Math.max(0, Math.min(1, n)); }

function parseColor(value) {
    if (value && typeof value === "object" && "r" in value && "g" in value && "b" in value)
        return { r: value.r, g: value.g, b: value.b };
    if (typeof value === "number")
        return { r: ((value >> 16) & 255) / 255, g: ((value >> 8) & 255) / 255, b: (value & 255) / 255 };
    if (typeof value === "string" && value.startsWith("#")) {
        let hex = value.slice(1);
        if (hex.length === 3)
            hex = hex.split("").map((c) => c + c).join("");
        const n = parseInt(hex, 16);
        return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
    }
    throw new Error(`XIteRenderAdapter: unsupported color value ${JSON.stringify(value)} (hex number or "#rrggbb"/"#rgb" string only)`);
}

function quaternionToAxisAngle(q) {
    const [x, y, z, w] = q;
    const clampedW = Math.max(-1, Math.min(1, w));
    const angle = 2 * Math.acos(clampedW);
    const s = Math.sqrt(1 - clampedW * clampedW);
    if (s < 1e-6)
        return [0, 0, 1, 0];
    return [x / s, y / s, z / s, angle];
}

class XNode {
    constructor(node) {
        this.node = node;
        this.parent = null;
        this.children = [];
        this.userData = {};
        this.name = "";
        this.material = null;
    }
}

// Distance along the ray (origin, dir) to the triangle a, b, c, either side, or null.
function rayTriangleDistance(origin, dir, a, b, c) {
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const p = [dir[1] * e2[2] - dir[2] * e2[1], dir[2] * e2[0] - dir[0] * e2[2], dir[0] * e2[1] - dir[1] * e2[0]];
    const det = e1[0] * p[0] + e1[1] * p[1] + e1[2] * p[2];
    if (Math.abs(det) < 1e-9)
        return null;
    const s = [origin[0] - a[0], origin[1] - a[1], origin[2] - a[2]];
    const u = (s[0] * p[0] + s[1] * p[1] + s[2] * p[2]) / det;
    if (u < 0 || u > 1)
        return null;
    const q = [s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0]];
    const v = (dir[0] * q[0] + dir[1] * q[1] + dir[2] * q[2]) / det;
    if (v < 0 || u + v > 1)
        return null;
    const distance = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) / det;
    return distance > 0 ? distance : null;
}
const BOX_FACES = [[0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4], [3, 2, 6, 7], [0, 3, 7, 4], [1, 2, 6, 5]];

const TORUS_RADIAL_SEGMENTS = 12;
const TORUS_TUBULAR_SEGMENTS = 48;

export class XIteRenderAdapter extends RenderAdapter {
    static info = Object.freeze({
        kind: "x_ite",
        label: "X_ITE",
        engine: "X_ITE",
        version: "16.6.0",
        licence: "MIT",
        source: "https://github.com/create3000/x_ite, package x_ite@16.6.0 on npm",
        boot: "x3d-live",
        module: "./x-ite-live-mode.mjs",
    });

    constructor(X3D) {
        super();
        if (!X3D)
            throw new Error("XIteRenderAdapter requires the loaded X_ITE module");
        this._X3D = X3D;
        this._canvas = null;
        this._browser = null;
        this._scene = null;
        this._root = null;
        this._camera = null;
        this._cameraPose = { position: [0, 1.6, 5], lookAt: [0, 1.2, 0] };
        this._cameraFov = 0.7854;
        this._mountEl = null;
        this._frameCallbacks = [];
        this._raf = null;
        this._readyPromise = null;
        this._loop = this._loop.bind(this);
    }
    get kind() { return "x_ite"; }
    get raw() { return null; }
    get sceneRoot() { return this._root; }
    /** Non-interface accessors, the same ones the shared boot path reads from X3DOMRenderAdapter. */
    get camera() { return this._camera; }
    get browser() { return this._browser; }
    get canvasElement() { return this._canvas; }
    get canvasSize() {
        if (!this._canvas)
            return { width: 0, height: 0 };
        return { width: this._canvas.clientWidth || 0, height: this._canvas.clientHeight || 0 };
    }
    /** X_ITE draws whenever a field changes and needs no wake-up. Present because the shared camera controller calls it. */
    requestRender() { }
    mount(containerEl, options = {}) {
        const canvas = this._X3D.createBrowser();
        canvas.id = options.id || "x-ite-host";
        canvas.setAttribute("splashScreen", "false");
        canvas.setAttribute("notifications", "false");
        canvas.setAttribute("contextMenu", "false");
        canvas.setAttribute("timings", "false");
        canvas.setAttribute("cache", "true");
        canvas.style.cssText = "position:absolute; inset:0; width:100%; height:100%; display:block;";
        containerEl.appendChild(canvas);
        this._canvas = canvas;
        this._mountEl = containerEl;
        this._browser = canvas.browser;
        this._readyPromise = this._buildScene(options);
    }
    async _buildScene(options) {
        const browser = this._browser;
        await browser.loadComponents(browser.getProfile("Interactive"), browser.getComponent("Geometry2D", 2), browser.getComponent("Texturing", 3));
        const scene = await browser.createScene(browser.getProfile("Interactive"), browser.getComponent("Geometry2D", 2), browser.getComponent("Texturing", 3));
        await browser.replaceWorld(scene);
        this._scene = browser.currentScene;
        const navigation = this._scene.createNode("NavigationInfo");
        navigation.type = new this._X3D.MFString("NONE");
        navigation.headlight = false;
        this._scene.addRootNode(navigation);
        const root = this._scene.createNode("Group");
        this._scene.addRootNode(root);
        this._root = new XNode(root);
        const cameraDesc = options.camera || {};
        this._camera = this.createPerspectiveCamera({ fov: cameraDesc.fov ?? 50, near: cameraDesc.near ?? 0.05, far: cameraDesc.far ?? 300 });
        this._scene.addRootNode(this._camera.node);
        this._camera.node.set_bind = true;
        this._cameraFov = this._camera.node.fieldOfView;
        this._raf = requestAnimationFrame(this._loop);
        return browser;
    }
    ready() { return this._readyPromise || Promise.reject(new Error("XIteRenderAdapter: mount() was not called")); }
    resize() { /* the x3d-canvas fills its container through CSS and follows it */ }
    dispose() {
        if (this._raf != null)
            cancelAnimationFrame(this._raf);
        this._raf = null;
        this._frameCallbacks = [];
        if (this._canvas && this._canvas.parentNode)
            this._canvas.parentNode.removeChild(this._canvas);
        this._canvas = null;
        this._browser = null;
        this._scene = null;
    }
    _loop() {
        for (const callback of this._frameCallbacks.slice())
            callback();
        this._raf = requestAnimationFrame(this._loop);
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
        const viewpoint = this._scene.createNode("Viewpoint");
        viewpoint.jump = true;
        if (fov !== undefined)
            viewpoint.fieldOfView = (fov * Math.PI) / 180;
        if (near !== undefined)
            viewpoint.nearDistance = near;
        if (far !== undefined)
            viewpoint.farDistance = far;
        return new XNode(viewpoint);
    }
    setCameraPose(camera, { position, lookAt }) {
        const X3D = this._X3D;
        if (position) {
            camera.node.position = new X3D.SFVec3f(position[0], position[1], position[2]);
            if (camera === this._camera)
                this._cameraPose.position = position.slice(0, 3);
        }
        if (position && lookAt) {
            // The same basis construction as X3DOMRenderAdapter.setCameraPose, which explains why a
            // single shortest-arc rotation would roll the camera.
            const dir = [lookAt[0] - position[0], lookAt[1] - position[1], lookAt[2] - position[2]];
            const len = Math.hypot(...dir) || 1;
            const fwd = [dir[0] / len, dir[1] / len, dir[2] / len];
            let right = [-fwd[2], 0, fwd[0]];
            let rightLen = Math.hypot(...right);
            if (rightLen < 1e-6) {
                right = [fwd[1], -fwd[0], 0];
                rightLen = Math.hypot(...right) || 1;
            }
            right = [right[0] / rightLen, right[1] / rightLen, right[2] / rightLen];
            const up = [
                right[1] * fwd[2] - right[2] * fwd[1],
                right[2] * fwd[0] - right[0] * fwd[2],
                right[0] * fwd[1] - right[1] * fwd[0],
            ];
            const rotationMatrix = [
                right[0], right[1], right[2], 0,
                up[0], up[1], up[2], 0,
                -fwd[0], -fwd[1], -fwd[2], 0,
                0, 0, 0, 1,
            ];
            const { quaternion } = decomposeTRS(rotationMatrix);
            const [ax, ay, az, angle] = quaternionToAxisAngle(quaternion);
            camera.node.orientation = new X3D.SFRotation(ax, ay, az, angle);
            if (camera === this._camera)
                this._cameraPose.lookAt = lookAt.slice(0, 3);
        }
    }
    worldToScreen(camera, worldPosition) {
        const { width, height } = this.canvasSize;
        if (!width || !height)
            return null;
        const { position, lookAt } = this._cameraPose;
        const rel = [worldPosition[0] - position[0], worldPosition[1] - position[1], worldPosition[2] - position[2]];
        const dir = [lookAt[0] - position[0], lookAt[1] - position[1], lookAt[2] - position[2]];
        const len = Math.hypot(...dir) || 1;
        const fwd = [dir[0] / len, dir[1] / len, dir[2] / len];
        const rightLen = Math.hypot(fwd[2], fwd[0]) || 1;
        const right = [-fwd[2] / rightLen, 0, fwd[0] / rightLen];
        const up = [right[1] * fwd[2] - right[2] * fwd[1], right[2] * fwd[0] - right[0] * fwd[2], right[0] * fwd[1] - right[1] * fwd[0]];
        const depth = rel[0] * fwd[0] + rel[1] * fwd[1] + rel[2] * fwd[2];
        if (Math.abs(depth) < 1e-6)
            return { x: width / 2, y: height / 2, visible: false };
        const f = 1 / Math.tan(this._cameraFov / 2);
        const ndcX = ((rel[0] * right[0] + rel[1] * right[1] + rel[2] * right[2]) / depth) * f * (height / width);
        const ndcY = ((rel[0] * up[0] + rel[1] * up[1] + rel[2] * up[2]) / depth) * f;
        return { x: (ndcX * 0.5 + 0.5) * width, y: (-ndcY * 0.5 + 0.5) * height, visible: depth > 0 };
    }
    cameraDistanceTo(camera, worldPosition) {
        const p = camera.node.position;
        return Math.hypot(worldPosition[0] - p.x, worldPosition[1] - p.y, worldPosition[2] - p.z);
    }
    /**
     * The nearest opaque flat plane or box on the camera's centre line, in the shape X3DOM's call returns.
     * A node the last call found stays in the test while it is hidden. Otherwise the camera controller,
     * which hides what this finds, would see the wall gone, show it again, and flicker.
     */
    pickViewCenter() {
        if (!this._root)
            return null;
        const { position: origin, lookAt } = this._cameraPose;
        const toTarget = [lookAt[0] - origin[0], lookAt[1] - origin[1], lookAt[2] - origin[2]];
        const length = Math.hypot(...toTarget);
        if (!length)
            return null;
        const dir = [toTarget[0] / length, toTarget[1] / length, toTarget[2] / length];
        let best = null;
        const testFaces = (handle, matrix, corners, faces) => {
            const points = corners.map((corner) => transformPoint(matrix, corner));
            for (const [a, b, c, d] of faces) {
                for (const distance of [rayTriangleDistance(origin, dir, points[a], points[b], points[c]), rayTriangleDistance(origin, dir, points[a], points[c], points[d])]) {
                    if (distance !== null && (!best || distance < best.distance))
                        best = { node: handle, distance };
                }
            }
        };
        const visit = (handle, parentMatrix) => {
            const node = handle.node;
            if (node.visible === false && handle !== this._lastPicked)
                return;
            let matrix = parentMatrix;
            if (node.translation) {
                const t = node.translation, r = node.rotation, s = node.scale;
                const half = r.angle / 2, sinHalf = Math.sin(half);
                matrix = multiplyMat4(parentMatrix, composeTRS([t.x, t.y, t.z], [r.x * sinHalf, r.y * sinHalf, r.z * sinHalf, Math.cos(half)], [s.x, s.y, s.z]));
            }
            if (handle._shape && handle.geometry && !(handle.material?.material?.transparency > 0)) {
                const size = handle.geometry.node.size;
                if (handle.geometry.type === "plane") {
                    const w = size.x / 2, h = size.y / 2;
                    testFaces(handle, matrix, [[-w, -h, 0], [w, -h, 0], [w, h, 0], [-w, h, 0]], [[0, 1, 2, 3]]);
                }
                else if (handle.geometry.type === "box") {
                    const w = size.x / 2, h = size.y / 2, d = size.z / 2;
                    testFaces(handle, matrix, [[-w, -h, -d], [w, -h, -d], [w, h, -d], [-w, h, -d], [-w, -h, d], [w, -h, d], [w, h, d], [-w, h, d]], BOX_FACES);
                }
            }
            for (const child of handle.children)
                visit(child, matrix);
        };
        visit(this._root, IDENTITY_MAT4);
        this._lastPicked = best ? best.node : null;
        if (!best)
            return null;
        const position = [origin[0] + dir[0] * best.distance, origin[1] + dir[1] * best.distance, origin[2] + dir[2] * best.distance];
        return { node: best.node, position, normal: null, distance: best.distance };
    }
    /** X_ITE's shaders take at most this many clip planes on one shape. X3DOM's adapter has no limit to state. */
    get clipPlaneLimit() { return 6; }
    createClipPlane({ normal, constant, enabled = true }) {
        const node = this._scene.createNode("ClipPlane");
        const n = Array.isArray(normal) ? normal : [0, 0, 1];
        node.plane = new this._X3D.SFVec4f(n[0], n[1], n[2], Number(constant) || 0);
        node.enabled = enabled;
        return new XNode(node);
    }
    createRenderedTexture({ dimensions = [128, 128, 4], fov = 55, near = 0.1, far = 30, backgroundColor = null } = {}) {
        const node = this._scene.createNode("RenderedTexture");
        node.width = dimensions[0];
        node.height = dimensions[1];
        // singleFrame is true by default in X_ITE 16.6.0: the node draws once and never again. Without
        // this line a preview keeps its first picture, taken before the destination room is staged,
        // which is only the background colour. Three previews five times a second, because on a machine
        // with no graphics card each one costs a whole extra pass over its scene.
        node.singleFrame = false;
        node.updateInterval = 0.2;
        const viewpoint = this.createPerspectiveCamera({ fov, near, far });
        const handle = { kind: "x_ite-rendered-texture", node, viewpoint, backgroundColor };
        return handle;
    }
    /** Puts the texture on a material that already exists. */
    attachRenderedTexture(material, rt) {
        material.material.diffuseColor = new this._X3D.SFColor(1, 1, 1);
        material.appearance.texture = rt.node;
    }
    /** A stage belongs to the RenderedTexture, not the main scene, so there is nothing to add. */
    mountRenderedTextureStage() { }
    async bindRenderedTextureScene(rt, stage) {
        const X3D = this._X3D;
        const nodes = [rt.viewpoint.node];
        if (rt.backgroundColor) {
            const background = this._scene.createNode("Background");
            background.skyColor = new X3D.MFColor(this._sfColor(parseColor(rt.backgroundColor)));
            nodes.push(background);
        }
        const navigation = this._scene.createNode("NavigationInfo");
        navigation.headlight = false;
        nodes.push(navigation);
        const lit = this._scene.createNode("Group");
        const ambient = this._light([0, -1, 0], 0xffffff, 0, 0.75).node;
        const key = this._light([-0.42, -0.84, -0.32], 0xffffff, 0.9, 0).node;
        ambient.global = false;
        key.global = false;
        lit.children = new X3D.MFNode(ambient, key, stage.node);
        nodes.push(lit);
        rt.node.children = new X3D.MFNode(...nodes);
    }
    /** X_ITE refreshes a RenderedTexture at its own updateInterval while the texture is on screen. */
    setRenderedTextureUpdate() { }
    createGroup(name) {
        const handle = new XNode(this._scene.createNode("Transform"));
        handle.name = name || "";
        return handle;
    }
    createInlineAsset(url, options = {}, timeoutMs = 15000) {
        const X3D = this._X3D;
        const wrapper = this.createGroup(options.name || "inline-asset");
        const inline = this._scene.createNode("Inline");
        const wrapperChildren = wrapper.node.children;
        wrapperChildren.push(inline);
        wrapper.node.visible = false;
        wrapper._inline = inline;
        this.add(this._root, wrapper);
        const ready = new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`XIteRenderAdapter.createInlineAsset: "${url}" did not load within ${timeoutMs}ms`)), timeoutMs);
            inline.url = new X3D.MFString(url);
            // loadNow() settles when this url has loaded or failed. Reading the load state straight after
            // setting the url was not enough: an Inline with no url yet could report itself complete, so
            // a missing avatar file counted as loaded.
            inline.getValue().loadNow().then(() => {
                clearTimeout(timer);
                wrapper.node.visible = wrapper._wantVisible !== false;
                resolve(wrapper);
            }, () => {
                clearTimeout(timer);
                reject(new Error(`XIteRenderAdapter.createInlineAsset: "${url}" failed to load`));
            });
        });
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
    _sfColor(c) { return new this._X3D.SFColor(c.r, c.g, c.b); }
    setBackgroundColor(color) {
        if (!this._background) {
            this._background = this._scene.createNode("Background");
            this._scene.addRootNode(this._background);
        }
        this._background.skyColor = new this._X3D.MFColor(this._sfColor(color));
    }
    _geometry(node, type) { return { kind: "x_ite-geometry", node, type }; }
    _torus(innerRadius, outerRadius) {
        const X3D = this._X3D;
        const coordinate = this._scene.createNode("Coordinate");
        const points = [];
        const index = [];
        const major = outerRadius;
        const minor = innerRadius;
        for (let i = 0; i < TORUS_TUBULAR_SEGMENTS; i += 1) {
            const u = (i / TORUS_TUBULAR_SEGMENTS) * Math.PI * 2;
            for (let j = 0; j < TORUS_RADIAL_SEGMENTS; j += 1) {
                const v = (j / TORUS_RADIAL_SEGMENTS) * Math.PI * 2;
                points.push(new X3D.SFVec3f((major + minor * Math.cos(v)) * Math.cos(u), (major + minor * Math.cos(v)) * Math.sin(u), minor * Math.sin(v)));
                const nextI = (i + 1) % TORUS_TUBULAR_SEGMENTS;
                const nextJ = (j + 1) % TORUS_RADIAL_SEGMENTS;
                const a = i * TORUS_RADIAL_SEGMENTS + j;
                const b = nextI * TORUS_RADIAL_SEGMENTS + j;
                const c = nextI * TORUS_RADIAL_SEGMENTS + nextJ;
                const d = i * TORUS_RADIAL_SEGMENTS + nextJ;
                index.push(a, b, c, d, -1);
            }
        }
        coordinate.point = new X3D.MFVec3f(...points);
        const faces = this._scene.createNode("IndexedFaceSet");
        faces.coord = coordinate;
        faces.coordIndex = new X3D.MFInt32(...index);
        faces.solid = false;
        faces.creaseAngle = 1.2;
        return faces;
    }
    createGeometry(desc) {
        const X3D = this._X3D;
        const scene = this._scene;
        switch (desc.type) {
            case "box": {
                const node = scene.createNode("Box");
                node.size = new X3D.SFVec3f(desc.width ?? 1, desc.height ?? 1, desc.depth ?? 1);
                return this._geometry(node, "box");
            }
            case "plane": {
                const node = scene.createNode("Rectangle2D");
                node.size = new X3D.SFVec2f(desc.width ?? 1, desc.height ?? 1);
                return this._geometry(node, "plane");
            }
            case "sphere": {
                const node = scene.createNode("Sphere");
                node.radius = desc.radius ?? 1;
                return this._geometry(node, "sphere");
            }
            case "cone": {
                const node = scene.createNode("Cone");
                node.bottomRadius = desc.radius ?? 0.5;
                node.height = desc.height ?? 1;
                return this._geometry(node, "cone");
            }
            case "cylinder": {
                const node = scene.createNode("Cylinder");
                node.radius = desc.radiusTop ?? desc.radiusBottom ?? 1;
                node.height = desc.height ?? 1;
                return this._geometry(node, "cylinder");
            }
            case "torus":
                return this._geometry(this._torus(desc.innerRadius ?? 0.5, desc.outerRadius ?? 1), "torus");
            case "octahedron": {
                const r = desc.radius ?? 1;
                const coordinate = scene.createNode("Coordinate");
                coordinate.point = new X3D.MFVec3f(new X3D.SFVec3f(0, r, 0), new X3D.SFVec3f(0, -r, 0), new X3D.SFVec3f(r, 0, 0), new X3D.SFVec3f(-r, 0, 0), new X3D.SFVec3f(0, 0, r), new X3D.SFVec3f(0, 0, -r));
                const node = scene.createNode("IndexedFaceSet");
                node.coord = coordinate;
                node.coordIndex = new X3D.MFInt32(0, 4, 2, -1, 0, 3, 4, -1, 0, 5, 3, -1, 0, 2, 5, -1, 1, 2, 4, -1, 1, 4, 3, -1, 1, 3, 5, -1, 1, 5, 2, -1);
                node.solid = false;
                return this._geometry(node, "octahedron");
            }
            case "edges": {
                if (!desc.from || desc.from.type !== "box")
                    throw new Error('XIteRenderAdapter.createGeometry("edges"): only a box `from` source is supported so far');
                const size = desc.from.node.size;
                const hw = size.x / 2, hh = size.y / 2, hd = size.z / 2;
                const corners = [[-hw, -hh, -hd], [hw, -hh, -hd], [hw, hh, -hd], [-hw, hh, -hd], [-hw, -hh, hd], [hw, -hh, hd], [hw, hh, hd], [-hw, hh, hd]];
                const coordinate = scene.createNode("Coordinate");
                coordinate.point = new X3D.MFVec3f(...corners.map((c) => new X3D.SFVec3f(c[0], c[1], c[2])));
                const node = scene.createNode("IndexedLineSet");
                node.coord = coordinate;
                node.coordIndex = new X3D.MFInt32(0, 1, -1, 1, 2, -1, 2, 3, -1, 3, 0, -1, 4, 5, -1, 5, 6, -1, 6, 7, -1, 7, 4, -1, 0, 4, -1, 1, 5, -1, 2, 6, -1, 3, 7, -1);
                return this._geometry(node, "edges");
            }
            case "points": {
                const coordinate = scene.createNode("Coordinate");
                coordinate.point = new X3D.MFVec3f(...desc.points.map((p) => new X3D.SFVec3f(p[0], p[1], p[2])));
                const node = scene.createNode("LineSet");
                node.coord = coordinate;
                node.vertexCount = new X3D.MFInt32(desc.points.length);
                return this._geometry(node, "points");
            }
            default:
                throw new Error(`XIteRenderAdapter.createGeometry: type "${desc.type}" is not implemented`);
        }
    }
    createMaterial(desc) {
        const scene = this._scene;
        // A sprite's appearance holds its texture and no Material, which X3D draws unlit, as three.js draws a SpriteMaterial.
        if (desc.type === "sprite") {
            if (!desc.map || desc.map.kind !== "x_ite-canvas-texture")
                throw new Error('XIteRenderAdapter.createMaterial: a "sprite" needs a "map" from createCanvasTexture()');
            const appearance = scene.createNode("Appearance");
            appearance.texture = desc.map.node;
            return { kind: "x_ite-material", appearance, material: null, base: { side: "double" } };
        }
        if (desc.type !== "standard" && desc.type !== "basic" && desc.type !== "line")
            throw new Error(`XIteRenderAdapter.createMaterial: type "${desc.type}" is not implemented`);
        const material = scene.createNode("Material");
        const color = desc.color !== undefined ? parseColor(desc.color) : { r: 0.8, g: 0.8, b: 0.8 };
        const emissive = desc.type === "line" || desc.type === "basic" ? color : desc.emissive !== undefined ? parseColor(desc.emissive) : { r: 0, g: 0, b: 0 };
        const base = { color, emissive, emissiveIntensity: desc.emissiveIntensity ?? 1, side: desc.side };
        material.diffuseColor = this._sfColor(color);
        material.emissiveColor = this._sfColor(this.multiplyColorScalar(emissive, base.emissiveIntensity));
        // The lab's ambient light is meant to reach a surface at full strength, as in three.js.
        // X3D's default of 0.2 would leave every room far darker than the same room in three.js.
        material.ambientIntensity = 1;
        if (desc.opacity !== undefined || desc.transparent)
            material.transparency = 1 - (desc.opacity ?? 1);
        const appearance = scene.createNode("Appearance");
        appearance.material = material;
        if (desc.map) {
            if (desc.map.kind !== "x_ite-canvas-texture")
                throw new Error('XIteRenderAdapter.createMaterial: "map" must be a handle from createCanvasTexture()');
            appearance.texture = desc.map.node;
        }
        return { kind: "x_ite-material", appearance, material, base };
    }
    _wrapShape(geometry, material) {
        if (material.base?.side === "double" && "solid" in geometry.node)
            geometry.node.solid = false;
        const shape = this._scene.createNode("Shape");
        shape.appearance = material.appearance;
        shape.geometry = geometry.node;
        const transform = this._scene.createNode("Transform");
        transform.children.push(shape);
        const handle = new XNode(transform);
        handle._shape = shape;
        handle.material = material;
        handle.geometry = geometry;
        return handle;
    }
    createMesh(geometry, material) { return this._wrapShape(geometry, material); }
    setGeometry(mesh, geometry) {
        mesh._shape.geometry = geometry.node;
        mesh.geometry = geometry;
    }
    createLineSegments(geometry, material) { return this._wrapShape(geometry, material); }
    createLine(geometry, material) { return this._wrapShape(geometry, material); }
    createCanvasTexture(canvas) {
        if (!canvas || typeof canvas.toDataURL !== "function")
            throw new Error("XIteRenderAdapter.createCanvasTexture: requires a 2D <canvas> element");
        const node = this._scene.createNode("ImageTexture");
        node.url = new this._X3D.MFString(canvas.toDataURL());
        return { kind: "x_ite-canvas-texture", node, canvas };
    }
    updateCanvasTexture(textureHandle) {
        textureHandle.node.url = new this._X3D.MFString(textureHandle.canvas.toDataURL());
    }
    /** A quad of the given size in metres that turns to face the viewer, as a three.js Sprite does. */
    createSprite(material, { width = 1, height = 1 } = {}) {
        const quad = this._wrapShape(this.createGeometry({ type: "plane", width, height }), material);
        const billboard = this._scene.createNode("Billboard");
        billboard.axisOfRotation = new this._X3D.SFVec3f(0, 0, 0);
        billboard.children.push(quad.node);
        const transform = this._scene.createNode("Transform");
        transform.children.push(billboard);
        return new XNode(transform);
    }
    createGridHelper({ size, divisions, colorGrid, transparent, opacity }) {
        const X3D = this._X3D;
        const half = size / 2;
        const step = size / divisions;
        const points = [];
        const index = [];
        let n = 0;
        for (let i = 0; i <= divisions; i += 1) {
            const pos = -half + i * step;
            points.push(new X3D.SFVec3f(-half, 0, pos), new X3D.SFVec3f(half, 0, pos));
            index.push(n, n + 1, -1);
            n += 2;
            points.push(new X3D.SFVec3f(pos, 0, -half), new X3D.SFVec3f(pos, 0, half));
            index.push(n, n + 1, -1);
            n += 2;
        }
        const coordinate = this._scene.createNode("Coordinate");
        coordinate.point = new X3D.MFVec3f(...points);
        const lineSet = this._scene.createNode("IndexedLineSet");
        lineSet.coord = coordinate;
        lineSet.coordIndex = new X3D.MFInt32(...index);
        const material = this.createMaterial({ type: "line", color: colorGrid ?? 0xffffff, transparent, opacity });
        return this._wrapShape(this._geometry(lineSet, "grid"), material);
    }
    _light(direction, color, intensity, ambientIntensity) {
        const light = this._scene.createNode("DirectionalLight");
        light.global = true;
        light.direction = new this._X3D.SFVec3f(direction[0], direction[1], direction[2]);
        light.color = this._sfColor(parseColor(color ?? 0xffffff));
        light.intensity = intensity;
        light.ambientIntensity = ambientIntensity;
        return new XNode(light);
    }
    createAmbientLight({ color, intensity }) { return this._light([0, -1, 0], color, 0, intensity ?? 1); }
    createDirectionalLight({ color, intensity, position }) {
        const len = position ? Math.hypot(...position) || 1 : 1;
        const direction = position ? [-position[0] / len, -position[1] / len, -position[2] / len] : [0, -1, 0];
        return this._light(direction, color, intensity ?? 1, 0);
    }
    add(parent, child) {
        if (child.parent)
            this.remove(child.parent, child);
        parent.node.children.push(child.node);
        parent.children.push(child);
        child.parent = parent;
    }
    remove(parent, child) {
        if (child.parent !== parent)
            return;
        const children = parent.node.children;
        for (let index = children.length - 1; index >= 0; index -= 1) {
            if (children[index] === child.node) {
                children.splice(index, 1);
                break;
            }
        }
        const at = parent.children.indexOf(child);
        if (at !== -1)
            parent.children.splice(at, 1);
        child.parent = null;
    }
    setName(node, name) { node.name = name; }
    setPosition(node, x, y, z) { node.node.translation = new this._X3D.SFVec3f(x, y, z); }
    setRotationAxis(node, axis, radians) {
        const v = axis === "x" ? [1, 0, 0] : axis === "y" ? [0, 1, 0] : [0, 0, 1];
        node.node.rotation = new this._X3D.SFRotation(v[0], v[1], v[2], radians);
    }
    setLocalMatrix(node, matrix16) {
        const X3D = this._X3D;
        const { translation, quaternion, scale } = decomposeTRS(matrix16);
        const [ax, ay, az, angle] = quaternionToAxisAngle(quaternion);
        node.node.translation = new X3D.SFVec3f(translation[0], translation[1], translation[2]);
        node.node.rotation = new X3D.SFRotation(ax, ay, az, angle);
        node.node.scale = new X3D.SFVec3f(scale[0], scale[1], scale[2]);
    }
    setScaleScalar(node, scale) { node.node.scale = new this._X3D.SFVec3f(scale, scale, scale); }
    multiplyScale(node, factor) {
        const s = node.node.scale;
        node.node.scale = new this._X3D.SFVec3f(s.x * factor, s.y * factor, s.z * factor);
    }
    setVisible(node, visible) {
        node._wantVisible = visible;
        // An Inline wrapper stays hidden until its content has arrived; createInlineAsset() reads _wantVisible then.
        if (node._inline && node._inline.getValue().checkLoadState() !== this._X3D.X3DConstants.COMPLETE_STATE)
            return;
        node.node.visible = visible;
    }
    setUserData(node, key, value) {
        node.userData = node.userData || {};
        node.userData[key] = value;
    }
    setMaterialProperty(material, key, value) {
        if (key === "opacity") {
            material.material.transparency = 1 - value;
            return;
        }
        if (key === "emissiveIntensity") {
            material.base.emissiveIntensity = value;
            material.material.emissiveColor = this._sfColor(this.multiplyColorScalar(material.base.emissive, value));
            return;
        }
        if (key === "transparent")
            return;
        throw new Error(`XIteRenderAdapter.setMaterialProperty: key "${key}" is not implemented`);
    }
    recolorSubtreeMaterials(node, hexColor) {
        const color = this._sfColor(parseColor(hexColor));
        const walk = (handle) => {
            if (handle.material) {
                handle.material.material.diffuseColor = color;
                handle.material.material.emissiveColor = color;
            }
            handle.children.forEach(walk);
        };
        walk(node);
    }
    disposeGeometry() { }
    disposeMaterial() { }
    disposeNode(node) {
        if (node.parent)
            this.remove(node.parent, node);
        else if (node === this._root)
            return;
        node.children = [];
    }
}
