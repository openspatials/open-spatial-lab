// The Scene Manager (docs/engine/SCENE-CONTRACT-V0.md, sections 3, 4 and 6): the one writer of layers. It hands a
// source to the importer the application names and puts the layer it returns into the Scene. It knows no format: what
// only one format needs reaches its importer as that importer's options.
import { decomposeTRS, transformPoint, IDENTITY_MAT4 } from "../core/math.mjs";
import { createSensors, pickLink } from "../interaction/sensors.mjs";
import { createSceneSink } from "../physics/bullet/soft-body.mjs";
import { freezeDeep } from "./check.mjs";
import { createScene } from "./scene.mjs";

/** What the layer records about the importer that made it: its format and its capabilities. */
const importerRecord = (importer) => ({ format: importer.format, capabilities: typeof importer.capabilities === "function" ? importer.capabilities() : {} });

/**
 * Imports one source and puts its layer into the Scene, in place of a layer of the same name.
 * @returns {Promise<{revision: number, report: object}>}
 */
export async function loadLayer(scene, importer, source, { name = "world", placement, visible, signal, resolve, mode = "strict", options = {} } = {}) {
    signal?.throwIfAborted();
    const { layer, report } = await importer.import(source, { resolve, signal, mode, options: { ...options, name } });
    signal?.throwIfAborted();
    if (scene.layers().includes(name)) scene.removeLayer(name);
    return { revision: scene.addLayer({ ...layer, importer: importerRecord(importer) }, { name, placement, visible }), report };
}

function quaternionRotation(q) {
    const length = Math.hypot(...q), w = Math.min(1, Math.max(-1, q[3] / length));
    const sine = Math.sqrt(Math.max(0, 1 - w * w));
    return sine < 1e-10 ? [0, 0, 1, 0] : [q[0] / length / sine, q[1] / length / sine, q[2] / length / sine, 2 * Math.acos(w)];
}

/** The world-space box around what a layer draws: mesh points and the extents of the parametric shapes. */
export function layerBounds(scene, layer) {
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    const add = (matrix, point) => { const p = transformPoint(matrix, point); for (let i = 0; i < 3; i++) { min[i] = Math.min(min[i], p[i]); max[i] = Math.max(max[i], p[i]); } };
    for (const ref of scene.find({ component: "mesh", layer })) {
        const matrix = scene.worldMatrix(ref);
        for (const { geometry } of scene.get(ref).components.mesh.primitives) {
            const g = scene.asset(layer, "geometries", geometry);
            if (g.type === "mesh") { const p = g.attributes.POSITION; for (let i = 0; i < p.length; i += 3) add(matrix, [p[i], p[i + 1], p[i + 2]]); continue; }
            const half = g.type === "box" ? g.size.map((v) => v / 2) : [g.radius, g.type === "sphere" ? g.radius : g.height / 2, g.radius];
            for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) add(matrix, [x * half[0], y * half[1], z * half[2]]);
        }
    }
    return min[0] <= max[0] ? { min, max } : null;
}

/**
 * The default camera for a layer with no camera (contract section 11, item 6): looking down -Z at the centre of what
 * it draws, from far enough that the whole bounding sphere fits a 45-degree view. It is not an entity; it goes to
 * `layer.defaults.camera`, in the layer's frame, marked `framed: true`.
 */
function framedCamera(scene, layer) {
    const bounds = layerBounds(scene, layer);
    const center = bounds ? bounds.min.map((v, i) => (v + bounds.max[i]) / 2) : [0, 0, 0];
    const radius = bounds ? Math.max(1e-6, Math.hypot(...bounds.max.map((v, i) => v - bounds.min[i])) / 2) : 1;
    const yfov = Math.PI / 4, distance = radius / Math.sin(yfov / 2);
    return { type: "perspective", yfov, znear: distance / 100, zfar: distance * 100,
        description: "Framed view of the layer (no camera in the source)", framed: true,
        position: [center[0], center[1], center[2] + distance], rotation: [0, 0, 0, 1], centerOfRotation: center };
}

/**
 * What the application supplies for a layer whose source gave none (contract section 11, item 6): its navigation
 * request, and a framed camera when `frame` is set and the layer has no camera entity. Null when neither applies, so a
 * layer that authored both stays exactly as the importer made it.
 */
function layerDefaults(made, { navigation = null, frame = false } = {}) {
    const defaults = { navigation: made.navigation ? null : navigation ?? null, camera: null };
    if (frame && !made.entities.some((entity) => entity.components?.camera)) {
        const probe = createScene();
        probe.addLayer(made, { name: "probe" });
        defaults.camera = framedCamera(probe, "probe");
    }
    return defaults.navigation || defaults.camera ? defaults : null;
}

/**
 * Interaction on one layer of a Scene, with the viewpoint list read from its camera entities (or, when it has none,
 * from `layer.defaults.camera`) and the navigation list given by the caller, read from the layer, or from
 * `layer.defaults.navigation`.
 * @param {{layer?: string, portalBindings?: Array<{sensor: string, anchor: string}>, navigation?: object[]|null,
 *   centerOf?: Function|null}} options centerOf(entity) gives a camera's local centre of rotation.
 */
export function createLayerRuntime(scene, { layer = "world", portalBindings = [], navigation = null, centerOf = null } = {}) {
    const sensors = createSensors(scene, { layer, portalBindings });
    const nodeId = (entity) => entity.source?.def ? `DEF:${entity.source.def}` : entity.source?.path ?? entity.id;
    const viewpoints = scene.find({ component: "camera", layer }).map((ref) => {
        const entity = scene.get(ref), pose = scene.worldMatrix(ref);
        const parent = entity.parent === null ? IDENTITY_MAT4 : scene.worldMatrix({ layer, id: entity.parent });
        return { id: nodeId(entity), instance: entity.source?.instance, description: entity.components.camera.description,
            position: transformPoint(pose, [0, 0, 0]), orientation: quaternionRotation(decomposeTRS(pose).quaternion),
            fieldOfView: entity.components.camera.yfov, centerOfRotation: transformPoint(parent, centerOf ? centerOf(entity) : [0, 0, 0]) };
    });
    const header = scene.layer(layer), defaults = header.defaults ?? {};
    if (!viewpoints.length && defaults.camera) {
        const lens = defaults.camera;
        viewpoints.push({ id: null, instance: null, description: lens.description, framed: lens.framed === true,
            position: lens.position, orientation: quaternionRotation(lens.rotation), fieldOfView: lens.yfov,
            centerOfRotation: lens.centerOfRotation, near: lens.znear, far: lens.zfar });
    }
    const authored = header.navigation ?? defaults.navigation ?? null;
    const instances = new Map(scene.find({ layer }).map((ref) => [scene.get(ref).source?.instance ?? ref.id, ref]));
    return Object.freeze({
        viewpoints: freezeDeep(viewpoints),
        navigation: freezeDeep(navigation ?? (authored ? [authored] : [])),
        scene,
        get generation() { return sensors.generation; },
        isCurrent: sensors.isCurrent,
        // Matrix copies never expose mutable runtime storage or backend handles.
        matrixOf(instance) {
            if (sensors.disposed) throw new Error("runtime is disposed");
            const ref = instances.get(instance);
            if (!ref) throw new TypeError("unknown instance");
            // A camera's own position and orientation were never part of its placement.
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
 * The Scene Manager's host for one shown layer (docs/engine/SCENE-CONTRACT-V0.md, section 6). Each load hands the
 * source to the importer the caller names, puts its layer into a new Scene, starts Interaction and the Physics sink on
 * it, attaches it to a revision 3 renderer and syncs. The previous Scene stays shown until the renderer has built the
 * new one; then its Interaction and sink are retired. A later load or cancel supersedes a pending one.
 * The state keeps the fields the application reads: scene, layer, report, importer, runtime, realization (scene,
 * objects by source node id, preparedPhysics, sink) and camera. The renderer is the caller's; dispose never disposes it.
 * @param {{renderer: object, layer?: string}} options
 */
export function createSceneHost({ renderer, layer = "world" } = {}) {
    for (const call of ["attachScene", "syncScene", "pick", "detachScene"]) {
        if (typeof renderer?.[call] !== "function") throw new TypeError(`Scene host: the renderer has no ${call} (revision 3)`);
    }
    let generation = 0, state = null, disposed = false;
    const shown = (value) => !!value && renderer.attachedScene === value.scene;
    const live = () => {
        if (disposed || !shown(state)) throw new Error("No live Scene layer");
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
        /**
         * @param {object} source The importer's source: { uri, text | bytes, mediaType }.
         * @param {{importer: object, mode?: "strict"|"report", resolve?: Function, signal?: AbortSignal, options?: object,
         *   navigation?: object, centerOf?: Function, frame?: boolean}} how options go to the importer (preparePhysics is
         *   wrapped so the host keeps what it prepared; portalBindings also go to Interaction). navigation is the
         *   application's request for a layer whose source has none, written to layer.defaults.navigation; frame writes a
         *   framed layer.defaults.camera when it has no camera entity. layer.navigation stays as the author wrote it.
         */
        async load(source, { importer, mode = "strict", resolve, signal, options = {}, navigation = null, centerOf = null, frame = false } = {}) {
            if (disposed) throw new Error("Scene host disposed");
            if (typeof importer?.import !== "function") throw new TypeError("Scene host: load needs an importer");
            const mine = ++generation;
            const current = () => {
                signal?.throwIfAborted();
                if (disposed || mine !== generation) throw new DOMException("Scene load superseded", "AbortError");
            };
            let preparedPhysics = null;
            const given = options.preparePhysics;
            const importOptions = { ...options, name: layer, ...(typeof given === "function" ? { preparePhysics: (input) => (preparedPhysics = given(input)) } : {}) };
            const { layer: made, report } = await importer.import(source, { resolve, signal, mode, options: importOptions });
            current();
            const record = importerRecord(importer);
            const scene = createScene();
            const defaults = layerDefaults(made, { navigation, frame });
            scene.addLayer({ ...made, importer: record, ...(defaults ? { defaults } : {}) }, { name: layer });
            const runtime = createLayerRuntime(scene, { layer, portalBindings: options.portalBindings ?? [], centerOf });
            const sink = createSceneSink(scene, layer), fresh = { runtime, realization: { sink } };
            const previous = state;
            try {
                renderer.attachScene(scene);
                renderer.syncScene();
            } catch (error) {
                const failures = [];
                if (previous && !shown(previous)) { state = null; failures.push(...retire(previous)); }
                failures.push(...retire(fresh));
                if (failures.length) throw new AggregateError([error, ...failures], "Scene load and rollback failed");
                throw error;
            }
            state = null;
            const failures = previous ? retire(previous) : [];
            if (failures.length) { retire(fresh); throw new AggregateError(failures, "Previous Scene resources failed to dispose"); }
            const realization = Object.freeze({ scene: renderer.sceneRoot, objects: objectsByNode(scene), preparedPhysics, sink });
            state = Object.freeze({ scene, layer, report, importer: record, runtime, realization, camera: renderer.camera, generation: mine });
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
