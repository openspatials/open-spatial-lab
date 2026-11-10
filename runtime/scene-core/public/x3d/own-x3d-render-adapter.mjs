import { ThreeRenderAdapter } from "../render-adapter/three-render-adapter.mjs";
import { releaseThreeEnvironment } from "../render-adapter/three-render-features.mjs";
import { parseX3dDocument, isX3dDocument } from "./json-document.mjs";
import { createX3dRuntime } from "./scene-runtime.mjs";
import { validateX3dField } from "./profile.mjs";
import { realizeX3dScene } from "./scene-renderer.mjs";

/** Owned X3D interpretation/mapping, with existing Three drawing and skin resources. */
export class OwnX3dRenderAdapter extends ThreeRenderAdapter {
    static info = Object.freeze({ kind: "own-x3d", label: "Owned X3D", engine: "own-x3d", version: "subset-1", boot: "unregistered" });
    constructor(THREE, { createCanvas, preparePhysics } = {}) {
        super(THREE);
        this._sceneOptions = { createCanvas, preparePhysics };
        this._documentGeneration = 0;
        this._x3d = null;
    }
    get kind() { return "own-x3d"; }
    get documentState() { return this._x3d; }
    mount(container, options = {}) {
        if (this._disposed) throw new Error("adapter disposed");
        super.mount(container, { ...options, scene: this._scene, cameraHandle: this._camera || options.cameraHandle, frameLoop: false });
        this.resize();
    }
    getCapabilities() {
        const base = super.getCapabilities();
        return { ...base, engine: this.kind, version: "subset-1", backend: `three-r${this.raw.REVISION}`,
            features: { ...base.features,
                x3d: { status: "limited", level: "declared JSON subset and soft-body extension", evidenceScope: "isolated CPU graph checks; native pixels unqualified" },
                gltf: { status: "limited", reason: "Explicit avatar-render/1 resources only; no private graph or loader." },
                picking: { status: "limited", reason: "Host-filtered ray hits on realized visible geometry; no through-portal interaction." },
                portalPreview: { status: "limited", reason: "Document route only: the authored PortalAnchor disc is a one-way (front) standard portal window through the shared portal preview manager, with the destination from the listed world's bounded preview; no join, no takeover, no peers; through-view eye height differs from the destination entry." },
                authoredMaterials: { status: "limited", reason: "Linear RGB classic Phong mapping; canvas serif text metrics and environment-as-ambient require native comparison." },
            } };
    }
    bindSkin(description) {
        if (description?.schema !== "avatar-render/1") throw new TypeError("Owned X3D requires explicit avatar-render/1 resources");
        return super.bindSkin(description);
    }
    createInlineAsset() { throw new Error("Owned X3D accepts prepared resources; Inline/network loading is unsupported"); }
    disposeRenderedTexture(preview) {
        if (!this._previews.has(preview)) return false;
        try { return super.disposeRenderedTexture(preview); }
        finally { preview.scene = preview.camera = null; }
    }
    async loadDocument(input, { compatibility, portalBindings = [], signal } = {}) {
        if (this._disposed) throw new Error("adapter disposed");
        const generation = ++this._documentGeneration;
        let runtime, realization;
        const current = () => {
            signal?.throwIfAborted();
            if (this._disposed || generation !== this._documentGeneration) throw new DOMException("X3D load superseded", "AbortError");
        };
        try {
            const document = isX3dDocument(input) ? input : await parseX3dDocument(input, { compatibility, signal });
            current();
            runtime = createX3dRuntime(document, { portalBindings });
            realization = realizeX3dScene(this, document, this._sceneOptions);
            current();
            const viewpoint = runtime.viewpoints[0];
            const camera = this.createPerspectiveCamera({ fov: (viewpoint?.fieldOfView ?? Math.PI / 4) * 180 / Math.PI, aspect: 1, near: 0.1, far: 1000 });
            if (viewpoint) {
                camera.position.fromArray(viewpoint.position);
                const [x, y, z, angle] = viewpoint.orientation;
                camera.quaternion.setFromAxisAngle(new this.raw.Vector3(x, y, z).normalize(), angle);
            }
            if (runtime.navigation[0]?.headlight) {
                const headlight = new this.raw.DirectionalLight(0xffffff, 1);
                headlight.target.position.set(0, 0, -1); camera.add(headlight, headlight.target); realization.scene.add(camera);
            }
            if (this._mountEl) {
                camera.aspect = (this._mountEl.clientWidth || 640) / (this._mountEl.clientHeight || 420);
                camera.updateProjectionMatrix();
            }
            const previous = this._x3d, failures = [];
            this._x3d = null;
            const retiring = [
                ...[...this._previews].map((preview) => () => this.disposeRenderedTexture(preview)),
                ...[...this._skins].map((skin) => () => this.disposeSkin(skin)),
                () => previous?.runtime.dispose(), () => previous?.realization.dispose(),
            ];
            for (const retire of retiring) { try { retire(); } catch (error) { failures.push(error); } }
            if (failures.length) throw new AggregateError(failures, "Previous X3D resources failed to dispose");
            this._scene = realization.scene; this._camera = camera;
            this._x3d = { document, runtime, realization, camera, generation };
            return this._x3d;
        } catch (error) {
            try { runtime?.dispose(); realization?.dispose(); }
            catch (cleanup) { throw new AggregateError([error, cleanup], "X3D load and rollback failed"); }
            throw error;
        }
    }
    cancelDocument() { this._documentGeneration++; this._x3d?.runtime.cancel(); }
    stepDocument(frame) {
        if (this._disposed || !this._x3d) throw new Error("No live X3D document");
        return this._x3d.runtime.step(frame);
    }
    activateAnchor(id, options) {
        if (this._disposed || !this._x3d) throw new Error("No live X3D document");
        return this._x3d.runtime.activate(id, options);
    }
    pickRay({ origin, direction, allowedIds = [] }) {
        if (this._disposed || !this._x3d) throw new Error("No live X3D document");
        validateX3dField("vec3", origin, "ray.origin"); validateX3dField("direction", direction, "ray.direction"); validateX3dField("strings", allowedIds, "ray.allowedIds");
        const allow = new Set(allowedIds), THREE = this.raw;
        this._scene.updateMatrixWorld(true);
        const ray = new THREE.Raycaster(new THREE.Vector3(...origin), new THREE.Vector3(...direction).normalize());
        for (const hit of ray.intersectObjects(this._scene.children, true)) {
            const identity = hit.object.userData.x3d;
            if (!identity || !allow.has(identity.nodeId) && !allow.has(identity.anchorId)) continue;
            let visible = hit.object.material?.visible !== false;
            for (let p = hit.object; p; p = p.parent) if (!p.visible) visible = false;
            if (!visible) continue;
            return { ...identity, distance: hit.distance, point: hit.point.toArray(), frame: "world",
                normal: hit.face ? hit.face.normal.clone().applyMatrix3(new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld)).normalize().toArray() : null };
        }
        return null;
    }
    dispose() {
        if (this._disposed) return;
        this._disposed = true;
        this._documentGeneration++;
        this._generation++;
        const previous = this._x3d, renderer = this._renderer, raf = this._raf, failures = [];
        this._x3d = this._renderer = this._raf = null;
        this._frameCallbacks = [];
        // The base disposer short-circuits on listener errors. Retire each owned
        // resource separately, including the canvas if renderer disposal fails.
        const retiring = [
            () => { if (raf != null) cancelAnimationFrame(raf); },
            () => releaseThreeEnvironment(this),
            ...[...this._previews].map((preview) => () => this.disposeRenderedTexture(preview)),
            ...[...this._skins].map((skin) => () => this.disposeSkin(skin)),
            () => previous?.runtime.dispose(), () => previous?.realization.dispose(),
            () => renderer?.dispose(),
            () => { const canvas = renderer?.domElement; canvas?.parentNode?.removeChild(canvas); },
        ];
        for (const retire of retiring) { try { retire(); } catch (error) { failures.push(error); } }
        this._mountEl = null;
        if (failures.length) throw new AggregateError(failures, "Owned X3D disposal failed");
    }
}
