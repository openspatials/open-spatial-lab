// Ported by hand from Nicholas Polys's public fork npolys/open-spatial-lab, commit 99175b4b6,
// runtime/scene-core/public/render-adapter/three-render-adapter.mjs. Apache-2.0, like the rest of the lab. Nicholas Polys is co-author of lab commit ef702ec.
// Changes in this copy: added static info; nothing else changed. The lab's three.js path, the default, still draws through its own code (runtime/scene-core/public/scene.js and web/app.js), so this class is checked against the interface and draws nothing there.

import { RenderAdapter } from "./render-adapter.mjs";

function applySide(materialDesc, THREE) {
    if (materialDesc.side === "double")
        return THREE.DoubleSide;
    if (materialDesc.side === "back")
        return THREE.BackSide;
    return THREE.FrontSide;
}

export class ThreeRenderAdapter extends RenderAdapter {
    static info = Object.freeze({
        kind: "three",
        label: "three.js",
        engine: "three.js",
        licence: "MIT",
        source: "https://github.com/mrdoob/three.js",
        boot: "app",
    });
    constructor(THREE) {
        super();
        if (!THREE)
            throw new Error("ThreeRenderAdapter requires a loaded three.js module");
        this._THREE = THREE;
        this._scene = new THREE.Scene();
        this._renderer = null;
        this._camera = null;
        this._mount = null;
        this._frameCallbacks = [];
        this._raf = null;
        this._loop = this._loop.bind(this);
    }
    get kind() { return "three"; }
    get raw() { return this._THREE; }
    get sceneRoot() { return this._scene; }
    setBackgroundColor(color) { this._scene.background = color; }
    /** Non-interface accessors for call sites still mid-migration (direct THREE object access). */
    get camera() { return this._camera; }
    get renderer() { return this._renderer; }
    /**
     * Non-interface, three.js-specific lightweight bind: sets the container worldToScreen() reads
     * its width/height from, WITHOUT creating a renderer/canvas (unlike mount()). For call sites
     * that already render through a different, externally-owned adapter/renderer and just need
     * size-aware projection math from a second, throwaway adapter instance (e.g. a HUD overlay
     * measuring screen positions against the live scene's own renderer). Not part of the
     * RenderAdapter interface — X3DOMRenderAdapter's worldToScreen() needs no such binding, it
     * reads size directly off the live X3D runtime.
     */
    attach(containerEl) {
        this._mountEl = containerEl;
    }
    mount(containerEl, options = {}) {
        const THREE = this._THREE;
        const width = containerEl.clientWidth || options.width || 640;
        const height = containerEl.clientHeight || options.height || 420;
        const renderer = new THREE.WebGLRenderer({
            antialias: options.antialias !== false,
            alpha: options.alpha !== false,
            preserveDrawingBuffer: !!options.preserveDrawingBuffer,
            failIfMajorPerformanceCaveat: false,
        });
        if (!renderer.getContext())
            throw new Error("no webgl context");
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        renderer.setSize(width, height);
        containerEl.appendChild(renderer.domElement);
        this._renderer = renderer;
        this._mountEl = containerEl;
        const cameraDesc = options.camera || {};
        this._camera = this.createPerspectiveCamera({
            fov: cameraDesc.fov ?? 50,
            aspect: width / height,
            near: cameraDesc.near ?? 0.1,
            far: cameraDesc.far ?? 100,
        });
        this._raf = requestAnimationFrame(this._loop);
    }
    ready() { return Promise.resolve(); }
    resize() {
        if (!this._renderer || !this._mountEl)
            return;
        const width = this._mountEl.clientWidth || 640;
        const height = this._mountEl.clientHeight || 420;
        this._camera.aspect = width / height;
        this._camera.updateProjectionMatrix();
        this._renderer.setSize(width, height);
    }
    dispose() {
        if (this._raf != null)
            cancelAnimationFrame(this._raf);
        this._raf = null;
        this._frameCallbacks = [];
        if (this._renderer) {
            this._renderer.dispose();
            if (this._renderer.domElement.parentNode)
                this._renderer.domElement.parentNode.removeChild(this._renderer.domElement);
        }
        this._renderer = null;
    }
    onEnterFrame(callback) {
        this._frameCallbacks.push(callback);
        return () => {
            const index = this._frameCallbacks.indexOf(callback);
            if (index !== -1)
                this._frameCallbacks.splice(index, 1);
        };
    }
    _loop() {
        for (const callback of this._frameCallbacks)
            callback();
        if (this._renderer && this._camera)
            this._renderer.render(this._scene, this._camera);
        this._raf = requestAnimationFrame(this._loop);
    }
    createPerspectiveCamera({ fov, aspect, near, far }) {
        return new this._THREE.PerspectiveCamera(fov, aspect, near, far);
    }
    setCameraPose(camera, { position, lookAt }) {
        if (position)
            camera.position.set(position[0], position[1], position[2]);
        if (lookAt)
            camera.lookAt(lookAt[0], lookAt[1], lookAt[2]);
    }
    worldToScreen(camera, worldPosition) {
        const width = this._mountEl ? this._mountEl.clientWidth : 0;
        const height = this._mountEl ? this._mountEl.clientHeight : 0;
        if (!width || !height)
            return null;
        const ndc = new this._THREE.Vector3(worldPosition[0], worldPosition[1], worldPosition[2]).project(camera);
        return {
            x: (ndc.x * 0.5 + 0.5) * width,
            y: (-ndc.y * 0.5 + 0.5) * height,
            visible: ndc.z <= 1,
        };
    }
    cameraDistanceTo(camera, worldPosition) {
        return camera.position.distanceTo(new this._THREE.Vector3(worldPosition[0], worldPosition[1], worldPosition[2]));
    }
    createGroup(name) {
        const group = new this._THREE.Group();
        if (name)
            group.name = name;
        return group;
    }
    createColor(value) {
        return new this._THREE.Color(value);
    }
    createInlineAsset(url, options = {}) {
        const wrapper = this.createGroup();
        if (typeof options.loadGltf !== "function")
            throw new Error("ThreeRenderAdapter.createInlineAsset: options.loadGltf is required (three.js has no built-in glTF import)");
        const cloneScene = typeof options.cloneScene === "function" ? options.cloneScene : (scene) => scene.clone(true);
        const ready = Promise.resolve()
            .then(() => options.loadGltf(url))
            .then((template) => {
            if (!template)
                throw new Error("loader returned no scene");
            const model = cloneScene(template);
            wrapper.add(model);
            return wrapper;
        });
        return { node: wrapper, ready };
    }
    multiplyColorScalar(color, scalar) {
        return color.clone().multiplyScalar(scalar);
    }
    colorToHexString(color) {
        return color.getHexString();
    }
    createGeometry(desc) {
        const THREE = this._THREE;
        switch (desc.type) {
            case "box":
                return new THREE.BoxGeometry(desc.width ?? 1, desc.height ?? 1, desc.depth ?? 1);
            case "plane":
                return new THREE.PlaneGeometry(desc.width ?? 1, desc.height ?? 1);
            case "circle":
                return new THREE.CircleGeometry(desc.radius ?? 1, desc.segments ?? 32);
            case "torus":
                return new THREE.TorusGeometry(desc.radius ?? 1, desc.tube ?? 0.1, desc.radialSegments ?? 16, desc.tubularSegments ?? 48);
            case "capsule":
                return new THREE.CapsuleGeometry(desc.radius ?? 0.3, desc.length ?? 0.7, desc.capSegments ?? 6, desc.radialSegments ?? 14);
            case "sphere":
                return new THREE.SphereGeometry(desc.radius ?? 1, desc.widthSegments ?? 16, desc.heightSegments ?? 16);
            case "cone":
                return new THREE.ConeGeometry(desc.radius ?? 0.5, desc.height ?? 1, desc.radialSegments ?? 12);
            case "octahedron":
                return new THREE.OctahedronGeometry(desc.radius ?? 1, desc.detail ?? 0);
            case "cylinder":
                return new THREE.CylinderGeometry(desc.radiusTop ?? 1, desc.radiusBottom ?? 1, desc.height ?? 1, desc.radialSegments ?? 16);
            case "edges":
                if (!desc.from)
                    throw new Error('ThreeRenderAdapter.createGeometry: "edges" requires a `from` geometry handle');
                return new THREE.EdgesGeometry(desc.from);
            case "points": {
                const points = (desc.points || []).map((p) => new THREE.Vector3(p[0], p[1], p[2]));
                return new THREE.BufferGeometry().setFromPoints(points);
            }
            default:
                throw new Error(`ThreeRenderAdapter.createGeometry: unknown type "${desc.type}"`);
        }
    }
    createMaterial(desc) {
        const THREE = this._THREE;
        // Only pass keys the caller actually specified — three.js's Material.setValues()
        // treats a key present with value `undefined` differently from a key that's absent
        // (it warns and skips), so omitted fields must stay omitted, not forwarded as undefined.
        const params = {};
        if (desc.color !== undefined)
            params.color = desc.color;
        if (desc.transparent !== undefined)
            params.transparent = !!desc.transparent;
        if (desc.opacity !== undefined)
            params.opacity = desc.opacity;
        if (desc.side !== undefined)
            params.side = applySide(desc, THREE);
        if (desc.map !== undefined)
            params.map = desc.map;
        if (desc.depthWrite !== undefined)
            params.depthWrite = desc.depthWrite;
        if (desc.type === "basic") {
            return new THREE.MeshBasicMaterial(params);
        }
        if (desc.type === "standard") {
            if (desc.emissive !== undefined)
                params.emissive = desc.emissive;
            if (desc.emissiveIntensity !== undefined)
                params.emissiveIntensity = desc.emissiveIntensity;
            if (desc.roughness !== undefined)
                params.roughness = desc.roughness;
            if (desc.metalness !== undefined)
                params.metalness = desc.metalness;
            return new THREE.MeshStandardMaterial(params);
        }
        if (desc.type === "line") {
            return new THREE.LineBasicMaterial(params);
        }
        if (desc.type === "sprite") {
            return new THREE.SpriteMaterial(params);
        }
        throw new Error(`ThreeRenderAdapter.createMaterial: unknown type "${desc.type}"`);
    }
    createMesh(geometry, material) {
        return new this._THREE.Mesh(geometry, material);
    }
    setGeometry(mesh, geometry) { mesh.geometry = geometry; }
    createLineSegments(geometry, material) {
        return new this._THREE.LineSegments(geometry, material);
    }
    createLine(geometry, material) {
        return new this._THREE.Line(geometry, material);
    }
    createCanvasTexture(canvas, options = {}) {
        const THREE = this._THREE;
        const texture = new THREE.CanvasTexture(canvas);
        if ("SRGBColorSpace" in THREE)
            texture.colorSpace = THREE.SRGBColorSpace;
        // Filters are left at CanvasTexture's own constructor defaults unless the caller asks
        // for LinearFilter explicitly — some call sites relied on the untouched default.
        if (options.linearFilter) {
            texture.minFilter = THREE.LinearFilter;
            texture.magFilter = THREE.LinearFilter;
        }
        return texture;
    }
    createSprite(material) {
        return new this._THREE.Sprite(material);
    }
    createGridHelper({ size, divisions, colorCenterLine, colorGrid, transparent, opacity }) {
        const grid = new this._THREE.GridHelper(size, divisions, colorCenterLine, colorGrid);
        if (transparent !== undefined)
            grid.material.transparent = transparent;
        if (opacity !== undefined)
            grid.material.opacity = opacity;
        return grid;
    }
    createAmbientLight({ color, intensity }) {
        return new this._THREE.AmbientLight(color, intensity);
    }
    createDirectionalLight({ color, intensity, position }) {
        const light = new this._THREE.DirectionalLight(color, intensity);
        if (position)
            light.position.set(position[0], position[1], position[2]);
        return light;
    }
    add(parent, child) { parent.add(child); }
    remove(parent, child) { parent.remove(child); }
    setName(node, name) { node.name = name; }
    setPosition(node, x, y, z) { node.position.set(x, y, z); }
    setRotationAxis(node, axis, radians) { node.rotation[axis] = radians; }
    setLocalMatrix(node, matrix16) {
        node.matrixAutoUpdate = false;
        node.matrix.fromArray(matrix16);
    }
    setScaleScalar(node, scale) { node.scale.setScalar(scale); }
    setVisible(node, visible) { node.visible = visible; }
    setUserData(node, key, value) {
        node.userData = node.userData || {};
        node.userData[key] = value;
    }
    setMaterialProperty(material, key, value) { material[key] = value; }
    recolorSubtreeMaterials(node, hexColor) {
        node.traverse((o) => {
            const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
            for (const m of mats) {
                if (!m)
                    continue;
                if (m.color && typeof m.color.setHex === "function")
                    m.color.setHex(hexColor);
                if (m.emissive && typeof m.emissive.setHex === "function")
                    m.emissive.setHex(hexColor);
            }
        });
    }
    disposeGeometry(geometry) { geometry.dispose(); }
    disposeMaterial(material) { material.dispose(); }
    disposeNode(node) {
        node.traverse((o) => {
            if (o.geometry && typeof o.geometry.dispose === "function")
                o.geometry.dispose();
            const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
            for (const m of mats)
                if (m && typeof m.dispose === "function")
                    m.dispose();
        });
    }
}
