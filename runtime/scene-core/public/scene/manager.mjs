// The Scene Manager (docs/engine/SCENE-CONTRACT-V0.md, sections 3 and 6): the one writer of layers. It hands a
// source to an importer and puts the layer it returns into the Scene.
import { decomposeTRS, transformPoint, IDENTITY_MAT4 } from "../core/math.mjs";
import { isX3dDocument, parseX3dDocument } from "../import/x3d/json-document.mjs";
import { documentToLayer } from "../import/x3d/to-scene.mjs";
import { createSensors, pickLink } from "../interaction/sensors.mjs";
import { createSceneSink } from "../physics/bullet/soft-body.mjs";
import { freezeDeep } from "./check.mjs";
import { createScene } from "./scene.mjs";

/**
 * Imports one source and puts its layer into the Scene, in place of a layer of the same name.
 * @returns {Promise<{revision: number, report: object}>}
 */
export async function loadLayer(scene, importer, source, { name = "world", placement, visible, signal, options = {} } = {}) {
    signal?.throwIfAborted();
    const { layer, report } = await importer.import(source, { signal, mode: "strict", options: { ...options, name } });
    signal?.throwIfAborted();
    if (scene.layers().includes(name)) scene.removeLayer(name);
    return { revision: scene.addLayer(layer, { name, placement, visible }), report };
}

function quaternionRotation(q) {
    const length = Math.hypot(...q), w = Math.min(1, Math.max(-1, q[3] / length));
    const sine = Math.sqrt(Math.max(0, 1 - w * w));
    return sine < 1e-10 ? [0, 0, 1, 0] : [q[0] / length / sine, q[1] / length / sine, q[2] / length / sine, 2 * Math.acos(w)];
}

/**
 * Revision 2 compatibility for the document route and the checks in src/: the X3D importer writes a Scene, and
 * Interaction runs on it. The viewpoint list is read from the Scene's camera entities, the navigation list from the
 * document. Same calls and results as the former x3d/scene-runtime.mjs.
 * @param {object} document An immutable parseX3dDocument result.
 * @param {{portalBindings?: Array<{sensor: string, anchor: string}>}} options
 */
export function createX3dRuntime(document, { portalBindings = [] } = {}) {
    if (!isX3dDocument(document)) throw new TypeError("runtime: expected a validated X3D document");
    const scene = createScene();
    scene.addLayer(documentToLayer(document).layer, { name: "world" });
    return x3dRuntimeOnScene(scene, document, { portalBindings });
}

/** The same runtime on a layer of an existing Scene. */
function x3dRuntimeOnScene(scene, document, { layer = "world", portalBindings = [] } = {}) {
    const sensors = createSensors(scene, { layer, portalBindings });
    const nodeId = (entity) => entity.source.def ? `DEF:${entity.source.def}` : entity.source.path;
    const viewpoints = scene.find({ component: "camera", layer }).map((ref) => {
        const entity = scene.get(ref), pose = scene.worldMatrix(ref);
        const parent = entity.parent === null ? IDENTITY_MAT4 : scene.worldMatrix({ layer, id: entity.parent });
        return { id: nodeId(entity), instance: entity.source.instance, description: entity.components.camera.description,
            position: transformPoint(pose, [0, 0, 0]), orientation: quaternionRotation(decomposeTRS(pose).quaternion),
            fieldOfView: entity.components.camera.yfov, centerOfRotation: transformPoint(parent, entity.extras.x3d.centerOfRotation) };
    });
    const instances = new Map(scene.find({ layer }).map((ref) => [scene.get(ref).source.instance, ref]));
    return Object.freeze({
        viewpoints: freezeDeep(viewpoints),
        navigation: freezeDeep(document.nodes.filter((n) => n.type === "NavigationInfo").map((n) => n.fields)),
        scene,
        get generation() { return sensors.generation; },
        isCurrent: sensors.isCurrent,
        // Matrix copies never expose mutable runtime storage or backend handles.
        matrixOf(instance) {
            if (sensors.disposed) throw new Error("runtime is disposed");
            const ref = instances.get(instance);
            if (!ref) throw new TypeError("unknown instance");
            // A Viewpoint's own position and orientation were never part of its placement.
            const entity = scene.get(ref);
            if (entity.components.camera) return entity.parent === null ? [...IDENTITY_MAT4] : scene.worldMatrix({ layer, id: entity.parent });
            return scene.worldMatrix(ref);
        },
        step: sensors.step,
        activate: sensors.activate,
        cancel: sensors.cancel,
        dispose: sensors.dispose,
    });
}

/**
 * The Scene Manager for the X3D document route (docs/engine/SCENE-CONTRACT-V0.md, section 6): each load reads the
 * document with the X3D importer into a new Scene, starts Interaction and the Physics sink on it, attaches it to a
 * revision 3 renderer and syncs. The previous Scene stays shown until the renderer has built the new one; then its
 * Interaction and sink are retired. A later load or cancel supersedes a pending one.
 * The state keeps the fields the application reads: document, runtime, realization (scene, objects by X3D node id,
 * preparedPhysics, sink) and camera. The renderer is the caller's; dispose never disposes it.
 * @param {{renderer: object, preparePhysics?: Function, layer?: string}} options preparePhysics is the application's prepareWorld.
 */
export function createX3dSceneHost({ renderer, preparePhysics = null, layer = "world" } = {}) {
    for (const call of ["attachScene", "syncScene", "pick", "detachScene"]) {
        if (typeof renderer?.[call] !== "function") throw new TypeError(`Scene host: the renderer has no ${call} (revision 3)`);
    }
    let generation = 0, state = null, disposed = false;
    const shown = (value) => !!value && renderer.attachedScene === value.scene;
    const live = () => {
        if (disposed || !shown(state)) throw new Error("No live X3D document");
        return state;
    };
    const retire = (value) => {
        const failures = [];
        for (const release of [() => value.runtime.dispose(), () => value.realization.sink.dispose()]) {
            try { release(); } catch (error) { failures.push(error); }
        }
        return failures;
    };
    const objectsByNode = (scene) => {
        const objects = new Map();
        renderer.sceneRoot.traverse((object) => {
            const ref = object.userData.ref;
            if (!ref || ref.layer !== layer) return;
            const entity = scene.get(ref), id = entity.source?.def ? `DEF:${entity.source.def}` : entity.source?.path ?? entity.id;
            if (!objects.has(id)) objects.set(id, []);
            objects.get(id).push(object);
        });
        return objects;
    };
    return Object.freeze({
        get state() { return state; },
        async load(input, { compatibility, portalBindings = [], signal } = {}) {
            if (disposed) throw new Error("Scene host disposed");
            const mine = ++generation;
            const current = () => {
                signal?.throwIfAborted();
                if (disposed || mine !== generation) throw new DOMException("X3D load superseded", "AbortError");
            };
            const document = isX3dDocument(input) ? input : await parseX3dDocument(input, { compatibility, signal });
            current();
            let preparedPhysics = null;
            const prepare = typeof preparePhysics === "function" ? (source) => (preparedPhysics = preparePhysics(source)) : null;
            const { layer: made, report } = documentToLayer(document, { name: layer, preparePhysics: prepare });
            const scene = createScene();
            scene.addLayer(made, { name: layer });
            const runtime = x3dRuntimeOnScene(scene, document, { layer, portalBindings });
            const sink = createSceneSink(scene, layer), fresh = { runtime, realization: { sink } };
            const previous = state;
            try {
                renderer.attachScene(scene);
                renderer.syncScene();
            } catch (error) {
                const failures = [];
                if (previous && !shown(previous)) { state = null; failures.push(...retire(previous)); }
                failures.push(...retire(fresh));
                if (failures.length) throw new AggregateError([error, ...failures], "X3D load and rollback failed");
                throw error;
            }
            state = null;
            const failures = previous ? retire(previous) : [];
            if (failures.length) { retire(fresh); throw new AggregateError(failures, "Previous X3D resources failed to dispose"); }
            const realization = Object.freeze({ scene: renderer.sceneRoot, objects: objectsByNode(scene), preparedPhysics, sink });
            state = Object.freeze({ document, scene, layer, report, runtime, realization, camera: renderer.camera, generation: mine });
            return state;
        },
        /** Supersedes a pending load and resets Interaction, so earlier intents are no longer current. */
        cancel() { generation++; state?.runtime.cancel(); },
        step(frame) { return live().runtime.step(frame); },
        activate(id, options) { return live().runtime.activate(id, options); },
        pick(ray) { const { scene } = live(); return pickLink(scene, renderer, ray, { layer }); },
        dispose() {
            if (disposed) return;
            disposed = true;
            generation++;
            const previous = state;
            state = null;
            if (!previous) return;
            const failures = retire(previous);
            if (shown(previous)) { try { renderer.detachScene(); } catch (error) { failures.push(error); } }
            if (failures.length) throw new AggregateError(failures, "Scene host disposal failed");
        },
    });
}
