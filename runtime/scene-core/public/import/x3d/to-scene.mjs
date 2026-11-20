// The X3D importer (docs/engine/SCENE-CONTRACT-V0.md, section 4): a document read by json-document.mjs becomes one
// Scene layer and a load report. It reads no file, draws nothing and imports no drawing code.
import { freezeDeep } from "../../scene/check.mjs";
import { isX3dDocument, parseX3dDocument } from "./json-document.mjs";
import { X3D_FIELDS } from "./profile.mjs";

const PLACEMENT_LIMIT = 20000;
const IDENTITY = () => ({ translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] });

/** An X3D axis-angle rotation as a quaternion [x, y, z, w]. The same formula the sensors always used. */
export function axisAngleQuaternion([x, y, z, angle]) {
    const scale = Math.sin(angle / 2) / (Math.hypot(x, y, z) || 1);
    return [x * scale, y * scale, z * scale, Math.cos(angle / 2)];
}

const defaults = (type) => Object.fromEntries(Object.entries(X3D_FIELDS[type]).filter(([, v]) => !v.type.startsWith("node")).map(([k, v]) => [k, structuredClone(v.initial)]));

/**
 * One layer from a validated document. `preparePhysics` is the application's prepareWorld; with it, each soft body's
 * surface becomes a dynamic mesh. Strict: what the layer cannot hold stops the import with the node's path.
 * @param {object} document A parseX3dDocument result.
 * @param {{name?: string, preparePhysics?: Function}} options
 * @returns {{layer: object, report: object}}
 */
export function documentToLayer(document, { name = "world", preparePhysics = null } = {}) {
    if (!isX3dDocument(document)) throw new TypeError("X3D importer: expected a validated X3D document");
    const entities = [], geometries = {}, materials = {};
    const report = { translated: {}, kept: [], skipped: [], refused: [], diagnostics: document.diagnostics.map((d) => ({ ...d })) };
    const counted = (type) => { report.translated[type] = (report.translated[type] ?? 0) + 1; };
    const layer = { schema: "scene-layer/0", name, kind: "content", visible: true, placement: IDENTITY(),
        source: { format: "x3d-json", header: document.header }, info: null, navigation: null,
        environment: { background: null, color: null, intensity: null, image: null } };

    // The id rule: DEF:<name>, else the node path; a node placed more than once gets #<instance> on every placement.
    const placed = new Map();
    let placements = 0;
    const countPlacements = (node) => {
        if (++placements > PLACEMENT_LIMIT) throw new TypeError("X3D importer: instance limit");
        placed.set(node, (placed.get(node) ?? 0) + 1);
        for (const child of node.children.children ?? []) countPlacements(child);
    };
    document.roots.forEach(countPlacements);
    const idOf = (node, instance) => placed.get(node) > 1 ? `${node.id}#${instance}` : node.id;
    const source = (node, instance) => ({ path: node.path, type: node.type, def: node.def, instance });
    const entity = (node, instance, parent, { transform = IDENTITY(), components = {}, extras = {}, id = idOf(node, instance) } = {}) => {
        const made = { id, name: node.def, parent, transform, components, source: source(node, instance), extras };
        entities.push(made);
        counted(node.type);
        return made;
    };
    const material = (appearance, doubleSided) => {
        const key = `m${Object.keys(materials).length}`;
        const values = appearance?.children.material?.fields ?? defaults("Material");
        // Classic X3D Material, colours as the author wrote them (treated as linear, as the drawing code does today).
        materials[key] = { model: "classic", colorSpace: "linear", diffuseColor: [...values.diffuseColor], emissiveColor: [...values.emissiveColor],
            ambientIntensity: values.ambientIntensity, specularColor: [0, 0, 0], shininess: 0.2, transparency: 0, doubleSided };
        if (appearance) counted("Appearance");
        if (appearance?.children.material) counted("Material");
        return key;
    };
    const geometry = (description) => { const key = `g${Object.keys(geometries).length}`; geometries[key] = description; return key; };
    const shapeComponents = (node) => {
        const g = node.children.geometry;
        if (!g) { report.skipped.push({ path: node.path, type: "Shape", reason: "empty Shape: nothing to draw" }); return {}; }
        const f = g.fields;
        counted(g.type);
        switch (g.type) {
            case "Box": return { mesh: { primitives: [{ geometry: geometry({ type: "box", size: [...f.size] }), material: material(node.children.appearance, false) }] } };
            case "Cylinder": return { mesh: { primitives: [{ geometry: geometry({ type: "cylinder", radius: f.radius, height: f.height }), material: material(node.children.appearance, false) }] } };
            case "Sphere": return { mesh: { primitives: [{ geometry: geometry({ type: "sphere", radius: f.radius }), material: material(node.children.appearance, false) }] } };
            case "Text": {
                const style = g.children.fontStyle?.fields ?? defaults("FontStyle");
                if (g.children.fontStyle) counted("FontStyle");
                return { text: { string: [...f.string], size: style.size, justify: [...style.justify], family: ["SERIF"], spacing: 1, material: material(node.children.appearance, true) } };
            }
            default: throw new TypeError(`${g.path}: geometry requires supported soft-body topology`);
        }
    };
    let collections = 0;
    const bodies = (collection, instance, parent) => {
        // Physics prepares one root collection, as the drawing code always required.
        if (typeof preparePhysics === "function" && (parent.parent !== null || collections++ > 0)) throw new TypeError(`${collection.path}: one root collection requires the existing prepareWorld helper`);
        const prepared = typeof preparePhysics === "function" ? preparePhysics(document.source) : null;
        if (prepared && prepared.rigid.length + prepared.soft.length !== collection.children.bodies.length) throw new TypeError(`${collection.path}: preparation omitted a body`);
        const ids = new Map();
        collection.children.bodies.forEach((body, i) => {
            const at = `${instance}/${body.def ?? `bodies[${i}]`}`, rigid = body.type === "RigidBody";
            const geometryNodes = body.children.geometry;
            if (geometryNodes.length !== 1 || !geometryNodes[0].children.shape) throw new TypeError(`${collection.path}: unsupported ${rigid ? "rigid" : "soft"} body ${body.def}`);
            const shape = geometryNodes[0].children.shape;
            counted("CollidableShape");
            // A rigid body sits at its position; a soft body's surface points are in world space, so it sits at the origin.
            const made = entity(body, at, parent.id, { transform: rigid ? { ...IDENTITY(), translation: [...body.fields.position] } : IDENTITY(),
                components: { body: { type: rigid ? "rigid" : "soft", mass: body.fields.mass } },
                extras: rigid ? {} : { x3d: { position: [...body.fields.position] } } });
            ids.set(body, made.id);
            const shapeId = idOf(shape, `${at}/shape`);
            if (rigid) {
                const components = shapeComponents(shape);
                if (components.mesh) made.components.collider = { shape: components.mesh.primitives[0].geometry };
                entity(shape, `${at}/shape`, made.id, { components, id: shapeId });
                return;
            }
            // A soft body's surface is the application's prepared mesh, in world space, rewritten by Physics while it runs.
            // It is the body entity's own mesh: its Shape becomes part of the body entity.
            const entry = prepared?.soft.find((e) => e.def === body.def);
            const g = shape.children.geometry;
            if (g) { counted(g.type); made.extras.x3d.geometry = { type: g.type, ...g.fields }; }
            if (!entry) {
                if (prepared) throw new TypeError(`${collection.path}: unsupported soft body ${body.def}`);
                report.kept.push({ path: shape.path, type: "Shape", reason: "a soft-body surface needs the application's prepareWorld" });
                return;
            }
            const triangles = [];
            let face = [];
            for (const index of entry.mesh.faces) {
                if (index === -1) { if (face.length !== 3) throw new TypeError("Expected triangular prepared surface"); triangles.push(...face); face = []; }
                else face.push(index);
            }
            if (face.length) throw new TypeError("Unterminated prepared face");
            const key = geometry({ type: "mesh", attributes: { POSITION: Float32Array.from(entry.mesh.points) }, indices: Uint32Array.from(triangles), mode: 4, dynamic: true });
            made.components.body.dynamicGeometry = key;
            made.components.mesh = { primitives: [{ geometry: key, material: material(shape.children.appearance, true) }] };
            counted("Shape");
        });
        if (prepared) for (const entry of prepared.rigid) {
            if (!collection.children.bodies.some((n) => n.def === entry.def && n.type === "RigidBody")) throw new TypeError(`${collection.path}: unsupported rigid body ${entry.def}`);
        }
        collection.children.joints.forEach((joint, i) => {
            const f = joint.fields, hinge = joint.type === "SingleAxisHingeJoint";
            const component = hinge
                ? { type: "hinge", bodyA: ids.get(joint.children.body1), bodyB: ids.get(joint.children.body2), anchor: [...f.anchorPoint], axis: [...f.axis] }
                : { type: "stitch", bodyA: ids.get(joint.children.body1), bodyB: ids.get(joint.children.body2), indices: [...f.body1Index], weights: [...f.weight] };
            if (!component.bodyA || !component.bodyB) throw new TypeError(`${joint.path}: a joint must name bodies of its own collection`);
            entity(joint, `${instance}/${joint.def ?? `joints[${i}]`}`, parent.id, { components: { joint: component } });
        });
    };
    const visit = (node, parent, instance) => {
        const f = node.fields;
        switch (node.type) {
            case "Transform": {
                const made = entity(node, instance, parent, { transform: { translation: [...f.translation], rotation: axisAngleQuaternion(f.rotation), scale: [1, 1, 1] } });
                node.children.children.forEach((child, i) => visit(child, made.id, `${instance}/${i}`));
                break;
            }
            case "Anchor": {
                const metadata = node.children.metadata;
                const made = entity(node, instance, parent, { components: { link: { url: [...f.url], parameter: [...f.parameter], description: f.description, metadata } } });
                if (metadata) counted("MetadataSet");
                node.children.children.forEach((child, i) => visit(child, made.id, `${instance}/${i}`));
                break;
            }
            case "Shape": entity(node, instance, parent, { components: shapeComponents(node) }); break;
            case "Viewpoint": {
                const arrival = !entities.some((e) => e.components.camera);
                entity(node, instance, parent, { transform: { translation: [...f.position], rotation: axisAngleQuaternion(f.orientation), scale: [1, 1, 1] },
                    components: { camera: { type: "perspective", yfov: f.fieldOfView, znear: 0.1, zfar: 1000, description: f.description, ...(arrival ? { arrival: true } : {}) } },
                    extras: { x3d: { centerOfRotation: [...f.centerOfRotation] } } });
                break;
            }
            case "ProximitySensor": entity(node, instance, parent, { components: { sensor: { type: "proximity", center: [...f.center], size: [...f.size], enabled: f.enabled } } }); break;
            case "DirectionalLight":
                entity(node, instance, parent, { components: { light: { type: "directional", color: [...f.color], intensity: f.intensity, direction: [...f.direction],
                    ambientIntensity: f.ambientIntensity, scope: f.global ? "global" : "subtree" } } });
                break;
            case "Background":
                if (layer.environment.background) throw new TypeError("Multiple Background bindings are unsupported");
                layer.environment.background = { skyColor: [...f.skyColor] };
                counted(node.type);
                break;
            case "EnvironmentLight":
                if (parent !== null || layer.environment.color) report.kept.push({ path: node.path, type: node.type, reason: "only the first root EnvironmentLight is the layer's environment" });
                else { layer.environment.color = [...f.color]; layer.environment.intensity = f.ambientIntensity; counted(node.type); }
                break;
            case "NavigationInfo":
                if (layer.navigation) report.kept.push({ path: node.path, type: node.type, reason: "only the first NavigationInfo is the layer's navigation" });
                else { layer.navigation = { modes: [...f.type], speed: f.speed, avatarSize: [...f.avatarSize], headlight: f.headlight }; counted(node.type); }
                break;
            case "WorldInfo":
                if (layer.info) report.kept.push({ path: node.path, type: node.type, reason: "only the first WorldInfo is the layer's info" });
                else { layer.info = { title: f.title, notes: [...f.info] }; counted(node.type); }
                break;
            case "RigidBodyCollection": {
                const made = entity(node, instance, parent, { extras: { x3d: { gravity: [...f.gravity] } } });
                bodies(node, instance, made);
                break;
            }
            default: throw new TypeError(`${node.path}: unsupported node for the Scene`);
        }
    };
    document.roots.forEach((node, i) => visit(node, null, `${i}`));
    return freezeDeep({ layer: { ...layer, entities, assets: { geometries, materials, textures: {}, images: {} }, report }, report });
}

/** The importer object of the contract: the application hands over the source text; nothing is fetched here. */
export const x3dImporter = Object.freeze({
    format: "x3d-json",
    capabilities() {
        return { x3d: { status: "limited", level: "declared JSON subset and soft-body extension", evidenceScope: "isolated CPU graph checks; native pixels unqualified",
            reason: "Strict only: a node or field outside the declared subset stops the import with its path; report mode is not built for X3D." } };
    },
    async import(source, { signal, mode = "strict", options = {} } = {}) {
        if (mode !== "strict") throw new TypeError("X3D importer: only strict mode is built");
        const text = typeof source?.text === "string" ? source.text : source?.bytes ? new TextDecoder().decode(source.bytes) : null;
        const document = await parseX3dDocument(text, { compatibility: options.compatibility, signal });
        signal?.throwIfAborted();
        // options.onDocument: the application's own use of the read document (its portal bindings); the reading is unchanged.
        options.onDocument?.(document);
        return documentToLayer(document, { name: options.name, preparePhysics: options.preparePhysics });
    },
});
