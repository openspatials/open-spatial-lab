// The Scene, version 0 (docs/engine/SCENE-CONTRACT-V0.md, sections 2 and 3): an ordered stack of layers of plain
// data. Importers write layers, systems read them through the calls below. Every write raises the revision by one
// and records a change; a system that asks for changes older than the kept log gets "all" and rebuilds.
import { composeTRS, multiplyMat4 } from "../core/math.mjs";
import { freezeDeep, validateField } from "./check.mjs";

export const SCENE_SCHEMA = "scene/0";
const KEPT_CHANGES = 4096;
const IDENTITY_PLACEMENT = Object.freeze({ translation: Object.freeze([0, 0, 0]), rotation: Object.freeze([0, 0, 0, 1]), scale: Object.freeze([1, 1, 1]) });
const LAYER_KINDS = ["content", "meaning"];

function checkTransform(value, path) {
    if (!value || typeof value !== "object") throw new TypeError(`${path}: expected transform`);
    validateField("vec3", value.translation, `${path}.translation`);
    validateField("quaternion", value.rotation, `${path}.rotation`);
    validateField("vec3", value.scale, `${path}.scale`);
    return freezeDeep({ translation: [...value.translation], rotation: [...value.rotation], scale: [...value.scale] });
}

const isIdentity = ({ translation, rotation, scale }) => translation.every((v) => v === 0)
    && rotation[0] === 0 && rotation[1] === 0 && rotation[2] === 0 && rotation[3] === 1 && scale.every((v) => v === 1);

/** A new, empty Scene. */
export function createScene() {
    const layers = new Map(); // name -> { header, entities: Map(id -> entity), order: [id], assets }
    let revision = 0, changes = [];
    const record = (kind, ref = null, component = null) => {
        revision += 1;
        changes.push(Object.freeze({ revision, kind, ref: ref && Object.freeze({ ...ref }), component }));
        if (changes.length > KEPT_CHANGES) changes = changes.slice(-KEPT_CHANGES);
        return revision;
    };
    const layerOf = (name) => {
        const layer = layers.get(name);
        if (!layer) throw new TypeError(`scene: unknown layer ${JSON.stringify(name)}`);
        return layer;
    };
    const entityOf = (ref) => {
        const entity = layerOf(ref?.layer).entities.get(ref?.id);
        if (!entity) throw new TypeError(`scene: unknown entity ${JSON.stringify(ref?.id)} in layer ${JSON.stringify(ref?.layer)}`);
        return entity;
    };
    const header = (layer, changed) => freezeDeep({ ...layer.header, ...changed });

    const scene = {
        schema: SCENE_SCHEMA,
        get revision() { return revision; },
        addLayer(layer, { name = layer?.name, placement = IDENTITY_PLACEMENT, visible = true } = {}) {
            if (!layer || typeof layer !== "object" || !Array.isArray(layer.entities)) throw new TypeError("scene.addLayer: expected a layer with entities");
            if (typeof name !== "string" || !name) throw new TypeError("scene.addLayer: a layer needs a name");
            if (layers.has(name)) throw new TypeError(`scene.addLayer: layer ${JSON.stringify(name)} already exists`);
            if (!LAYER_KINDS.includes(layer.kind)) throw new TypeError(`scene.addLayer: layer kind ${JSON.stringify(layer.kind)} is not in version 0`);
            if (typeof visible !== "boolean") throw new TypeError("scene.addLayer: visible must be a boolean");
            const entities = new Map(), order = [];
            for (const entity of layer.entities) {
                if (typeof entity?.id !== "string" || entities.has(entity.id)) throw new TypeError(`scene.addLayer: entity ids must be unique strings (${JSON.stringify(entity?.id)})`);
                entities.set(entity.id, freezeDeep(entity));
                order.push(entity.id);
            }
            for (const entity of entities.values()) {
                if (entity.parent !== null && !entities.has(entity.parent)) throw new TypeError(`scene.addLayer: ${entity.id} names a missing parent ${entity.parent}`);
            }
            const assets = { geometries: { ...layer.assets?.geometries }, materials: { ...layer.assets?.materials },
                textures: { ...layer.assets?.textures }, images: { ...layer.assets?.images } };
            for (const group of Object.values(assets)) for (const value of Object.values(group)) freezeDeep(value);
            const { entities: _entities, assets: _assets, ...rest } = layer;
            layers.set(name, { header: freezeDeep({ ...rest, name, visible, placement: checkTransform(placement, "placement") }), entities, order, assets, matrices: new Map() });
            return record("layer-added", { layer: name });
        },
        removeLayer(name) {
            layerOf(name);
            layers.delete(name);
            return record("layer-removed", { layer: name });
        },
        setLayerVisible(name, visible) {
            const layer = layerOf(name);
            if (typeof visible !== "boolean") throw new TypeError("scene.setLayerVisible: visible must be a boolean");
            if (layer.header.visible === visible) return revision;
            layer.header = header(layer, { visible });
            return record("layer-visible", { layer: name });
        },
        /** The layer names, bottom of the stack first. */
        layers() { return [...layers.keys()]; },
        /** A layer without its entities and assets: name, kind, visible, placement, source, info, navigation, environment, report. */
        layer(name) { return layerOf(name).header; },
        /** One asset of a layer: kind is "geometries", "materials", "textures" or "images". */
        asset(name, kind, key) {
            const group = layerOf(name).assets[kind];
            if (!group || !Object.hasOwn(group, key)) throw new TypeError(`scene: unknown ${kind} asset ${JSON.stringify(key)}`);
            return group[key];
        },
        get(ref) { return entityOf(ref); },
        /** Refs of the entities of one layer (or of every layer, in stack order) that carry the component, in source order. */
        find({ component = null, layer = null } = {}) {
            const refs = [];
            for (const name of layer === null ? layers.keys() : [layerOf(layer) && layer]) {
                const { entities, order } = layers.get(name);
                for (const id of order) if (component === null || Object.hasOwn(entities.get(id).components ?? {}, component)) refs.push(Object.freeze({ layer: name, id }));
            }
            return refs;
        },
        /** The entity's placement in the world: layer placement, then every parent, then its own transform. */
        worldMatrix(ref) {
            const layer = layerOf(ref?.layer);
            const local = (entity) => composeTRS(entity.transform.translation, entity.transform.rotation, entity.transform.scale);
            const world = (id) => {
                if (layer.matrices.has(id)) return layer.matrices.get(id);
                const entity = layer.entities.get(id);
                if (!entity) throw new TypeError(`scene: unknown entity ${JSON.stringify(id)}`);
                const placement = layer.header.placement;
                const parent = entity.parent !== null ? world(entity.parent)
                    : isIdentity(placement) ? null : composeTRS(placement.translation, placement.rotation, placement.scale);
                const matrix = parent ? multiplyMat4(parent, local(entity)) : local(entity);
                layer.matrices.set(id, matrix);
                return matrix;
            };
            return [...world(ref?.id)];
        },
        write(ref, component, value) {
            if (component !== "transform") throw new TypeError(`scene.write: only "transform" is writable in version 0`);
            const layer = layerOf(ref?.layer), entity = entityOf(ref);
            layer.entities.set(entity.id, freezeDeep({ ...entity, transform: checkTransform(value, "transform") }));
            layer.matrices.clear();
            return record("entity", { layer: ref.layer, id: entity.id }, "transform");
        },
        writeGeometry(name, key, attribute, array) {
            if (attribute !== "POSITION") throw new TypeError(`scene.writeGeometry: only POSITION is writable in version 0`);
            const layer = layerOf(name), geometry = layer.assets.geometries[key];
            if (!geometry || geometry.type !== "mesh" || geometry.dynamic !== true) throw new TypeError(`scene.writeGeometry: ${key} is not a dynamic mesh`);
            validateField("numbers", Array.from(array ?? []), "POSITION");
            if (array.length !== geometry.attributes.POSITION.length) throw new TypeError(`scene.writeGeometry: ${key} vertex count changed`);
            const POSITION = Float32Array.from(array);
            layer.assets.geometries[key] = freezeDeep({ ...geometry, attributes: { ...geometry.attributes, POSITION } });
            return record("geometry", { layer: name, id: key }, "POSITION");
        },
        /** The changes after `since`, oldest first, or "all" when `since` is older than the kept log. */
        changes(since) {
            if (!Number.isSafeInteger(since) || since < 0 || since > revision) throw new TypeError("scene.changes: expected a revision this Scene has had");
            if (since === revision) return [];
            if (since === 0 || !changes.length || changes[0].revision > since + 1) return "all";
            return changes.filter((change) => change.revision > since);
        },
    };
    return Object.freeze(scene);
}
