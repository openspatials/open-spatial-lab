import { ThreeRenderAdapter } from "../render-adapter/three-render-adapter.mjs";
import { releaseThreeEnvironment } from "../render-adapter/three-render-features.mjs";
import { validateField } from "../scene/check.mjs";
import { createSceneView } from "../render/three/scene-view.mjs";

/**
 * The Three.js module's adapter: renderer contract revision 2, plus revision 3's attachScene, syncScene, pick and
 * detachScene, which draw a Scene (docs/engine/SCENE-CONTRACT-V0.md, section 5). It reads no X3D: the X3D importer
 * makes the Scene, the Scene Manager loads it, Interaction runs links and sensors on it.
 */
export class OwnX3dRenderAdapter extends ThreeRenderAdapter {
    static info = Object.freeze({ kind: "own-x3d", label: "Owned X3D", engine: "own-x3d", version: "subset-1", boot: "unregistered" });
    constructor(THREE, { createCanvas, preparePhysics } = {}) {
        super(THREE);
        // preparePhysics is still accepted from the registry options; the X3D importer now takes it from the application.
        this._sceneOptions = { createCanvas, preparePhysics };
        this._attached = this._view = null;
        this._seen = 0;
    }
    get kind() { return "own-x3d"; }
    mount(container, options = {}) {
        if (this._disposed) throw new Error("adapter disposed");
        super.mount(container, { ...options, scene: this._scene, cameraHandle: this._camera || options.cameraHandle, frameLoop: false });
        this.resize();
    }
    getCapabilities() {
        const base = super.getCapabilities();
        return { ...base, engine: this.kind, version: "subset-1", backend: `three-r${this.raw.REVISION}`,
            features: { ...base.features,
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
    /** Revision 3: remember the Scene; nothing is built until syncScene. The shown view stays until a rebuild succeeds. */
    attachScene(scene) {
        if (this._disposed) throw new Error("adapter disposed");
        if (!scene || scene.schema !== "scene/0" || typeof scene.changes !== "function") throw new TypeError("attachScene: expected a Scene");
        this._attached = scene;
    }
    /** The Scene this adapter is attached to, or null. */
    get attachedScene() { return this._attached; }
    /**
     * Revision 3: apply the attached Scene's changes since the last call. Transforms and dynamic geometry change in
     * place; a new Scene or a changed layer stack is rebuilt. A failed build keeps the previous view and Scene; once a
     * new view is built, the previous view and the previews and skins drawn over it are retired.
     */
    syncScene() {
        if (this._disposed) throw new Error("adapter disposed");
        const scene = this._attached, view = this._view;
        if (!scene) throw new Error("No attached Scene");
        if (view && view.scene === scene) {
            const changes = scene.changes(this._seen);
            if (changes === "all" ? view.refresh() : view.apply(changes)) { this._seen = scene.revision; return this._seen; }
        }
        let next;
        try { next = createSceneView(this, scene, this._sceneOptions); }
        catch (error) { this._attached = view?.scene ?? null; throw error; }
        if (this._mountEl) {
            next.camera.aspect = (this._mountEl.clientWidth || 640) / (this._mountEl.clientHeight || 420);
            next.camera.updateProjectionMatrix();
        }
        const failures = [];
        this._view = null;
        const retiring = [
            ...[...this._previews].map((preview) => () => this.disposeRenderedTexture(preview)),
            ...[...this._skins].map((skin) => () => this.disposeSkin(skin)),
            () => view?.dispose(),
        ];
        for (const retire of retiring) { try { retire(); } catch (error) { failures.push(error); } }
        if (failures.length) {
            this._attached = null;
            try { next.dispose(); } catch (cleanup) { throw new AggregateError([new AggregateError(failures, "Previous X3D resources failed to dispose"), cleanup], "X3D load and rollback failed"); }
            throw new AggregateError(failures, "Previous X3D resources failed to dispose");
        }
        this._view = next; this._seen = scene.revision;
        this._scene = next.root; this._camera = next.camera;
        return this._seen;
    }
    /** Revision 3: free everything built from the Scene. */
    detachScene() {
        const view = this._view;
        this._view = this._attached = null;
        this._seen = 0;
        view?.dispose();
    }
    /** Revision 3: the first allowed, visible entity a ray hits, as a ref. `allowed` lists refs. */
    pick({ origin, direction, allowed = [] }) {
        if (this._disposed || !this._view) throw new Error("No Scene is shown");
        validateField("vec3", origin, "ray.origin"); validateField("direction", direction, "ray.direction");
        if (!Array.isArray(allowed)) throw new TypeError("ray.allowed: expected refs");
        const allow = new Set(allowed.map((ref) => `${ref?.layer}\u0000${ref?.id}`)), THREE = this.raw;
        this._scene.updateMatrixWorld(true);
        const ray = new THREE.Raycaster(new THREE.Vector3(...origin), new THREE.Vector3(...direction).normalize());
        for (const hit of ray.intersectObjects(this._scene.children, true)) {
            const ref = hit.object.userData.ref;
            if (!ref || !allow.has(`${ref.layer}\u0000${ref.id}`)) continue;
            let visible = hit.object.material?.visible !== false;
            for (let p = hit.object; p; p = p.parent) if (!p.visible) visible = false;
            if (!visible) continue;
            return { ref, distance: hit.distance, point: hit.point.toArray(),
                normal: hit.face ? hit.face.normal.clone().applyMatrix3(new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld)).normalize().toArray() : null };
        }
        return null;
    }
    dispose() {
        if (this._disposed) return;
        this._disposed = true;
        this._generation++;
        const view = this._view, renderer = this._renderer, raf = this._raf, failures = [];
        this._view = this._attached = this._renderer = this._raf = null;
        this._frameCallbacks = [];
        // The base disposer short-circuits on listener errors. Retire each owned
        // resource separately, including the canvas if renderer disposal fails.
        const retiring = [
            () => { if (raf != null) cancelAnimationFrame(raf); },
            () => releaseThreeEnvironment(this),
            ...[...this._previews].map((preview) => () => this.disposeRenderedTexture(preview)),
            ...[...this._skins].map((skin) => () => this.disposeSkin(skin)),
            () => view?.dispose(),
            () => renderer?.dispose(),
            () => { const canvas = renderer?.domElement; canvas?.parentNode?.removeChild(canvas); },
        ];
        for (const retire of retiring) { try { retire(); } catch (error) { failures.push(error); } }
        this._mountEl = null;
        if (failures.length) throw new AggregateError(failures, "Owned X3D disposal failed");
    }
}
