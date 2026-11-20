// The glTF importer (docs/engine/SCENE-CONTRACT-V0.md, section 4): a .glb or .gltf source becomes one Scene layer and a
// load report. The Scene's shapes are glTF's, so this mostly copies: nodes become entities with id nodes/<index>,
// primitives, materials, textures and images become assets under their own paths. It fetches nothing, draws nothing
// and imports no drawing code. Mode "strict" stops at the first thing the Scene has no place for; mode "report" keeps
// it in extras.gltf and lists it in the report. A file that needs a compressed-mesh or compressed-texture decoder is
// refused with that reason.
import { freezeDeep } from "../../scene/check.mjs";
import { accessorArray, accessorFloats, accessorIndices, bufferViewBytes, linkedBytes, readContainer } from "./read.mjs";

export const GLTF_FORMAT = "gltf";
/** Extensions this importer reads. Every other extension is kept and reported, or refused when it needs a decoder. */
export const READ_EXTENSIONS = Object.freeze(["KHR_lights_punctual"]);
const DECODERS = Object.freeze({
    KHR_draco_mesh_compression: "a compressed-mesh decoder (Draco)",
    EXT_meshopt_compression: "a compressed-mesh decoder (meshopt)",
    KHR_texture_basisu: "a compressed-texture decoder (KTX2 with Basis Universal)",
});
const SCENE_ATTRIBUTES = Object.freeze({ POSITION: 3, NORMAL: 3, TEXCOORD_0: 2, COLOR_0: [3, 4] });
const IDENTITY = () => ({ translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
const TEXTURE_SLOTS = ["baseColorTexture", "metallicRoughnessTexture", "normalTexture", "occlusionTexture", "emissiveTexture"];
const REPEAT = 10497;

/** A column-major 4x4 matrix as translation, rotation [x, y, z, w] and scale (the decomposition glTF 2.0 section 3.5.3 allows). */
export function decomposeMatrix(m) {
    if (!Array.isArray(m) || m.length !== 16 || !m.every(Number.isFinite)) throw new TypeError("node.matrix: expected 16 numbers");
    let sx = Math.hypot(m[0], m[1], m[2]);
    const sy = Math.hypot(m[4], m[5], m[6]), sz = Math.hypot(m[8], m[9], m[10]);
    const det = m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);
    if (det < 0) sx = -sx;
    const ix = sx ? 1 / sx : 0, iy = sy ? 1 / sy : 0, iz = sz ? 1 / sz : 0;
    const m11 = m[0] * ix, m12 = m[4] * iy, m13 = m[8] * iz, m21 = m[1] * ix, m22 = m[5] * iy, m23 = m[9] * iz, m31 = m[2] * ix, m32 = m[6] * iy, m33 = m[10] * iz;
    const trace = m11 + m22 + m33;
    let x, y, z, w;
    if (trace > 0) { const s = 0.5 / Math.sqrt(trace + 1); w = 0.25 / s; x = (m32 - m23) * s; y = (m13 - m31) * s; z = (m21 - m12) * s; }
    else if (m11 > m22 && m11 > m33) { const s = 2 * Math.sqrt(1 + m11 - m22 - m33); w = (m32 - m23) / s; x = 0.25 * s; y = (m12 + m21) / s; z = (m13 + m31) / s; }
    else if (m22 > m33) { const s = 2 * Math.sqrt(1 + m22 - m11 - m33); w = (m13 - m31) / s; x = (m12 + m21) / s; y = 0.25 * s; z = (m23 + m32) / s; }
    else { const s = 2 * Math.sqrt(1 + m33 - m11 - m22); w = (m21 - m12) / s; x = (m13 + m31) / s; y = (m23 + m32) / s; z = 0.25 * s; }
    return { translation: [m[12], m[13], m[14]], rotation: [x, y, z, w], scale: [sx, sy, sz] };
}

const sniff = (bytes) => {
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
    return null;
};

/** The error of a refused file: the reason, and a report whose `refused` list names it. */
function refusal(path, reason) {
    const error = new TypeError(`glTF importer: refused: ${path}: ${reason}`);
    error.report = freezeDeep({ translated: {}, kept: [], skipped: [], refused: [{ path, type: "file", reason }], diagnostics: [] });
    return error;
}

/**
 * One layer from a glTF source.
 * @param {{uri?: string, text?: string, bytes?: Uint8Array|ArrayBuffer, mediaType?: string}} source
 * @param {{resolve?: Function, signal?: AbortSignal, mode?: "strict"|"report", name?: string}} options
 * @returns {Promise<{layer: object, report: object}>}
 */
export async function gltfToLayer(source, { resolve, signal, mode = "strict", name = "world" } = {}) {
    if (mode !== "strict" && mode !== "report") throw new TypeError(`glTF importer: unknown mode ${JSON.stringify(mode)}`);
    signal?.throwIfAborted();
    const { json, buffers, container } = await readContainer(source, { resolve, signal });
    signal?.throwIfAborted();
    const used = [...(json.extensionsUsed ?? [])], required = [...(json.extensionsRequired ?? [])];
    for (const extension of required) {
        if (DECODERS[extension]) throw refusal(`extensionsRequired/${extension}`, `the file needs ${DECODERS[extension]}, which this importer does not have`);
        if (!READ_EXTENSIONS.includes(extension)) throw refusal(`extensionsRequired/${extension}`, `the file requires ${extension}, which this importer does not read`);
    }
    const report = { translated: {}, kept: [], skipped: [], refused: [], diagnostics: [] };
    const counted = (type, n = 1) => { if (n) report.translated[type] = (report.translated[type] ?? 0) + n; };
    const keep = (path, type, reason) => {
        if (mode === "strict") throw new TypeError(`${path}: ${reason} (mode "report" keeps it)`);
        report.kept.push({ path, type, reason });
    };
    const reported = new Set();
    /** Unread extensions of one object: kept whole and reported, one line each. */
    const otherExtensions = (object, path, read = []) => {
        const kept = {};
        for (const [extension, value] of Object.entries(object?.extensions ?? {})) {
            if (read.includes(extension)) continue;
            if (DECODERS[extension]) throw refusal(`${path}/extensions/${extension}`, `the file needs ${DECODERS[extension]}, which this importer does not have`);
            keep(`${path}/extensions/${extension}`, "extension", `${extension} is not read by this importer`);
            reported.add(extension);
            kept[extension] = structuredClone(value);
        }
        return Object.keys(kept).length ? kept : null;
    };
    /** extras.gltf of one thing: only the keys that carry something. */
    const leftovers = (values) => {
        const kept = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined && v !== null));
        return Object.keys(kept).length ? { gltf: kept } : {};
    };
    const clone = (value) => (value === undefined ? undefined : structuredClone(value));
    const usedAccessors = new Set();
    const floats = (index) => { usedAccessors.add(index); return accessorFloats(json, buffers, index); };
    const raw = (index) => { usedAccessors.add(index); return accessorArray(json, buffers, index).array; };

    // Images: bytes kept as they are, with their type. The renderer decodes them.
    const images = {};
    for (const [i, image] of (json.images ?? []).entries()) {
        signal?.throwIfAborted();
        const path = `images/${i}`;
        let bytes, mimeType = image.mimeType ?? null, from;
        if (image.bufferView !== undefined) { bytes = bufferViewBytes(json, buffers, image.bufferView).slice(); from = `bufferViews/${image.bufferView}`; }
        else if (typeof image.uri === "string") {
            const linked = await linkedBytes(image.uri, { resolve, signal, base: source?.uri, what: path });
            bytes = linked.bytes; mimeType ??= linked.mimeType; from = image.uri.startsWith("data:") ? "data:" : image.uri;
        } else throw new TypeError(`${path}: no bufferView and no uri`);
        mimeType ??= sniff(bytes);
        images[path] = { mimeType, bytes, source: { path, from }, extras: leftovers({ name: image.name, extras: clone(image.extras), extensions: otherExtensions(image, path) }) };
        counted("image");
    }
    signal?.throwIfAborted();

    // Textures, with their sampler copied in (glTF's own filter and wrap numbers).
    const textures = {};
    for (const [i, texture] of (json.textures ?? []).entries()) {
        const path = `textures/${i}`, sampler = texture.sampler === undefined ? {} : json.samplers?.[texture.sampler];
        if (!sampler) throw new TypeError(`${path}: missing sampler ${texture.sampler}`);
        if (texture.source === undefined) keep(path, "texture", "its image comes from an extension this importer does not read");
        else if (!images[`images/${texture.source}`]) throw new TypeError(`${path}: missing image ${texture.source}`);
        textures[path] = {
            image: texture.source === undefined ? null : `images/${texture.source}`,
            sampler: { magFilter: sampler.magFilter ?? null, minFilter: sampler.minFilter ?? null, wrapS: sampler.wrapS ?? REPEAT, wrapT: sampler.wrapT ?? REPEAT },
            source: { path, sampler: texture.sampler === undefined ? null : `samplers/${texture.sampler}` },
            extras: leftovers({ name: texture.name, extras: clone(texture.extras), extensions: otherExtensions(texture, path),
                sampler: texture.sampler === undefined ? undefined : leftovers({ name: sampler.name, extras: clone(sampler.extras), extensions: otherExtensions(sampler, `samplers/${texture.sampler}`) }).gltf }),
        };
        counted("texture");
    }
    counted("sampler", (json.samplers ?? []).length);

    // Materials: the metallic-roughness model with its five texture slots.
    const materials = {};
    const slot = (info, path, name) => {
        if (info === undefined) return { ref: null, extensions: null };
        if (!textures[`textures/${info.index}`]) throw new TypeError(`${path}: missing texture ${info.index}`);
        const ref = { texture: `textures/${info.index}`, texCoord: info.texCoord ?? 0 };
        if (name === "normalTexture") ref.scale = info.scale ?? 1;
        if (name === "occlusionTexture") ref.strength = info.strength ?? 1;
        if (ref.texCoord !== 0) keep(path, "texture slot", `uses TEXCOORD_${ref.texCoord}; the Scene has TEXCOORD_0 only`);
        return { ref, extensions: otherExtensions(info, path), extras: clone(info.extras) };
    };
    const pbrMaterial = (material, path) => {
        const pbr = material.pbrMetallicRoughness ?? {}, slots = {}, slotExtras = {};
        for (const name of TEXTURE_SLOTS) {
            const where = name === "baseColorTexture" || name === "metallicRoughnessTexture" ? `${path}/pbrMetallicRoughness/${name}` : `${path}/${name}`;
            const made = slot(name === "baseColorTexture" || name === "metallicRoughnessTexture" ? pbr[name] : material[name], where, name);
            slots[name] = made.ref;
            if (made.extensions || made.extras !== undefined) slotExtras[name] = leftovers({ extensions: made.extensions, extras: made.extras }).gltf;
        }
        return {
            model: "pbr", colorSpace: "linear",
            baseColorFactor: [...(pbr.baseColorFactor ?? [1, 1, 1, 1])], metallicFactor: pbr.metallicFactor ?? 1, roughnessFactor: pbr.roughnessFactor ?? 1,
            emissiveFactor: [...(material.emissiveFactor ?? [0, 0, 0])], ...slots,
            doubleSided: material.doubleSided === true, alphaMode: material.alphaMode ?? "OPAQUE", alphaCutoff: material.alphaCutoff ?? 0.5,
            source: { path },
            extras: leftovers({ name: material.name, extras: clone(material.extras), extensions: otherExtensions(material, path),
                pbrMetallicRoughness: leftovers({ extras: clone(pbr.extras), extensions: otherExtensions(pbr, `${path}/pbrMetallicRoughness`) }).gltf,
                textureSlots: Object.keys(slotExtras).length ? slotExtras : undefined }),
        };
    };
    for (const [i, material] of (json.materials ?? []).entries()) { materials[`materials/${i}`] = pbrMaterial(material, `materials/${i}`); counted("material"); }
    const DEFAULT_MATERIAL = "materials/default";

    // Meshes: each primitive's attributes, indices and mode as number arrays.
    const geometries = {}, meshes = [];
    for (const [i, mesh] of (json.meshes ?? []).entries()) {
        const meshPath = `meshes/${i}`;
        if (mesh.weights) keep(`${meshPath}/weights`, "morph weights", "morph targets are reserved (contract section 8)");
        const meshExtras = leftovers({ name: mesh.name, extras: clone(mesh.extras), weights: clone(mesh.weights), extensions: otherExtensions(mesh, meshPath) }).gltf;
        const primitives = [];
        for (const [j, primitive] of mesh.primitives.entries()) {
            signal?.throwIfAborted();
            const key = `${meshPath}/primitives/${j}`, attributes = {}, accessors = {}, other = {};
            if (primitive.attributes?.POSITION === undefined) throw new TypeError(`${key}: no POSITION attribute`);
            for (const [attribute, index] of Object.entries(primitive.attributes)) {
                accessors[attribute] = `accessors/${index}`;
                const sizes = SCENE_ATTRIBUTES[attribute];
                if (sizes === undefined) {
                    const reason = attribute === "TANGENT" ? "the Scene has no TANGENT attribute; normal maps use tangents from screen-space derivatives"
                        : /^(JOINTS|WEIGHTS)_/.test(attribute) ? "skins are reserved (contract section 8)"
                            : /^TEXCOORD_/.test(attribute) ? "the Scene has TEXCOORD_0 only" : /^COLOR_/.test(attribute) ? "the Scene has COLOR_0 only" : "an application attribute the Scene has no place for";
                    keep(`${key}/attributes/${attribute}`, "attribute", reason);
                    other[attribute] = { accessor: `accessors/${index}`, array: raw(index) };
                    continue;
                }
                const read = floats(index);
                if (!(Array.isArray(sizes) ? sizes : [sizes]).includes(read.itemSize)) throw new TypeError(`${key}/attributes/${attribute}: unexpected item size ${read.itemSize}`);
                attributes[attribute] = read.array;
            }
            const count = attributes.POSITION.length / 3;
            for (const attribute of Object.keys(attributes)) if (attributes[attribute].length % count) throw new TypeError(`${key}/attributes/${attribute}: count differs from POSITION`);
            let indices = null;
            if (primitive.indices !== undefined) { usedAccessors.add(primitive.indices); indices = accessorIndices(json, buffers, primitive.indices); }
            if (indices) for (const index of indices) if (index >= count) throw new TypeError(`${key}/indices: index ${index} outside the ${count} vertices`);
            let targets;
            if (primitive.targets) {
                keep(`${key}/targets`, "morph targets", "morph targets are reserved (contract section 8)");
                targets = primitive.targets.map((target) => Object.fromEntries(Object.entries(target).map(([attribute, index]) => [attribute, { accessor: `accessors/${index}`, array: raw(index) }])));
            }
            const mode = primitive.mode ?? 4;
            if (!Number.isInteger(mode) || mode < 0 || mode > 6) throw new TypeError(`${key}/mode: ${mode} is not a glTF mode`);
            geometries[key] = { type: "mesh", attributes, indices, mode, dynamic: false,
                source: { path: key, accessors, indices: primitive.indices === undefined ? null : `accessors/${primitive.indices}` },
                extras: leftovers({ attributes: Object.keys(other).length ? other : undefined, targets, extras: clone(primitive.extras),
                    extensions: otherExtensions(primitive, key), mesh: meshExtras }) };
            let material = DEFAULT_MATERIAL;
            if (primitive.material !== undefined) {
                material = `materials/${primitive.material}`;
                if (!materials[material]) throw new TypeError(`${key}/material: missing material ${primitive.material}`);
            } else if (!materials[DEFAULT_MATERIAL]) materials[DEFAULT_MATERIAL] = pbrMaterial({}, DEFAULT_MATERIAL);
            primitives.push({ geometry: key, material });
            counted("primitive");
        }
        meshes.push(primitives);
        counted("mesh");
    }

    // Lights from KHR_lights_punctual: shining down the node's -Z, as the extension says.
    const lightDefinitions = json.extensions?.KHR_lights_punctual?.lights ?? [];
    const lightComponent = (index, path) => {
        const light = lightDefinitions[index];
        if (!light) throw new TypeError(`${path}: missing light ${index}`);
        if (!["directional", "point", "spot"].includes(light.type)) throw new TypeError(`${path}: light type ${light.type}`);
        return { type: light.type, color: [...(light.color ?? [1, 1, 1])], intensity: light.intensity ?? 1, direction: [0, 0, -1], range: light.range ?? null,
            spot: light.type === "spot" ? { innerConeAngle: light.spot?.innerConeAngle ?? 0, outerConeAngle: light.spot?.outerConeAngle ?? Math.PI / 4 } : null, scope: "global" };
    };

    // Nodes of the shown scene, depth first: entities with id nodes/<index>.
    const nodes = json.nodes ?? [], parents = new Map();
    nodes.forEach((node, i) => {
        for (const child of node.children ?? []) {
            if (!nodes[child]) throw new TypeError(`nodes/${i}/children: missing node ${child}`);
            if (parents.has(child)) throw new TypeError(`nodes/${child}: more than one parent`);
            parents.set(child, i);
        }
    });
    const scenes = json.scenes ?? [];
    const shown = json.scene ?? (scenes.length ? 0 : null);
    if (shown !== null && !scenes[shown]) throw new TypeError(`scene: missing scene ${shown}`);
    const entities = [], visited = new Set(), placedCameras = new Set(), placedLights = new Set();
    let arrival = false;
    const visit = (index, parent) => {
        const path = `nodes/${index}`, node = nodes[index];
        if (!node) throw new TypeError(`${path}: missing`);
        if (visited.has(index)) throw new TypeError(`${path}: the node graph has a cycle or a node placed twice`);
        visited.add(index);
        const transform = node.matrix ? decomposeMatrix(node.matrix)
            : { translation: [...(node.translation ?? [0, 0, 0])], rotation: [...(node.rotation ?? [0, 0, 0, 1])], scale: [...(node.scale ?? [1, 1, 1])] };
        const components = {}, sourceRecord = { path, type: "node" }, extras = { name: undefined };
        if (node.mesh !== undefined) {
            if (!meshes[node.mesh]) throw new TypeError(`${path}: missing mesh ${node.mesh}`);
            components.mesh = { primitives: meshes[node.mesh].map((p) => ({ ...p })) };
            sourceRecord.mesh = `meshes/${node.mesh}`;
            if (node.weights) keep(`${path}/weights`, "morph weights", "morph targets are reserved (contract section 8)");
        }
        if (node.camera !== undefined) {
            const camera = json.cameras?.[node.camera], where = `cameras/${node.camera}`;
            if (!camera) throw new TypeError(`${path}: missing camera ${node.camera}`);
            sourceRecord.camera = where;
            placedCameras.add(node.camera);
            if (camera.type === "perspective") {
                const p = camera.perspective;
                components.camera = { type: "perspective", yfov: p.yfov, znear: p.znear, zfar: p.zfar ?? null, description: camera.name ?? null, ...(arrival ? {} : { arrival: true }) };
                arrival = true;
                extras.camera = leftovers({ aspectRatio: p.aspectRatio, extras: clone(camera.extras), extensions: otherExtensions(camera, where) }).gltf;
            } else {
                keep(where, "camera", `a ${camera.type} camera; the Scene has perspective cameras only`);
                extras.camera = structuredClone(camera);
            }
        }
        const lightIndex = node.extensions?.KHR_lights_punctual?.light;
        if (lightIndex !== undefined) {
            components.light = lightComponent(lightIndex, path);
            sourceRecord.light = `extensions/KHR_lights_punctual/lights/${lightIndex}`;
            placedLights.add(lightIndex);
            const definition = lightDefinitions[lightIndex];
            extras.light = leftovers({ name: definition.name, extras: clone(definition.extras) }).gltf;
        }
        if (node.skin !== undefined) {
            keep(`${path}/skin`, "skin", "skins are reserved (contract section 8); the mesh is drawn unskinned");
            extras.skin = `skins/${node.skin}`;
        }
        extras.weights = clone(node.weights);
        extras.extras = clone(node.extras);
        extras.extensions = otherExtensions(node, path, ["KHR_lights_punctual"]);
        const id = path;
        entities.push({ id, name: node.name ?? null, parent, transform, components, source: sourceRecord, extras: leftovers(extras) });
        counted("node");
        for (const child of node.children ?? []) visit(child, id);
    };
    if (shown !== null) {
        for (const root of scenes[shown].nodes ?? []) {
            if (parents.has(root)) throw new TypeError(`scenes/${shown}: node ${root} is not a root`);
            visit(root, null);
        }
        counted("scene");
    }
    scenes.forEach((_, k) => { if (k !== shown) keep(`scenes/${k}`, "scene", `only scene ${shown} is shown`); });
    nodes.forEach((_, i) => { if (!visited.has(i)) keep(`nodes/${i}`, "node", "not in the scene that is shown"); });
    (json.cameras ?? []).forEach((_, i) => { if (!placedCameras.has(i)) report.skipped.push({ path: `cameras/${i}`, type: "camera", reason: "no node of the shown scene places it" }); });
    lightDefinitions.forEach((_, i) => { if (!placedLights.has(i)) report.skipped.push({ path: `extensions/KHR_lights_punctual/lights/${i}`, type: "light", reason: "no node of the shown scene places it" }); });
    counted("camera", placedCameras.size);
    counted("light", placedLights.size);

    // File-level things the Scene reserves: kept whole in the layer's extras.gltf and reported.
    const layerExtras = {};
    if (json.skins?.length) {
        layerExtras.skins = json.skins.map((skin, k) => {
            keep(`skins/${k}`, "skin", "skins are reserved (contract section 8)");
            return { name: skin.name ?? null, joints: skin.joints.map((j) => `nodes/${j}`), skeleton: skin.skeleton === undefined ? null : `nodes/${skin.skeleton}`,
                inverseBindMatrices: skin.inverseBindMatrices === undefined ? null : { accessor: `accessors/${skin.inverseBindMatrices}`, array: raw(skin.inverseBindMatrices) }, extras: clone(skin.extras) ?? null,
                extensions: otherExtensions(skin, `skins/${k}`) };
        });
    }
    if (json.animations?.length) {
        layerExtras.animations = json.animations.map((animation, k) => {
            keep(`animations/${k}`, "animation", "animation tracks are reserved (contract section 8)");
            return { name: animation.name ?? null,
                channels: animation.channels.map((c) => ({ sampler: c.sampler, target: { node: c.target.node === undefined ? null : `nodes/${c.target.node}`, path: c.target.path } })),
                samplers: animation.samplers.map((s) => ({ input: { accessor: `accessors/${s.input}`, array: raw(s.input) }, output: { accessor: `accessors/${s.output}`, array: raw(s.output) }, interpolation: s.interpolation ?? "LINEAR" })),
                extras: clone(animation.extras) ?? null, extensions: otherExtensions(animation, `animations/${k}`) };
        });
    }
    const topExtensions = otherExtensions(json, "", READ_EXTENSIONS);
    if (topExtensions) layerExtras.extensions = topExtensions;
    if (json.extras !== undefined) layerExtras.extras = structuredClone(json.extras);
    if (scenes.length) layerExtras.scenes = scenes.map((s) => ({ name: s.name ?? null, nodes: (s.nodes ?? []).map((n) => `nodes/${n}`), extras: clone(s.extras) ?? null }));
    // Declared extensions found on no object are still named, so a reader of the report sees every unread one.
    for (const extension of used) {
        if (READ_EXTENSIONS.includes(extension) || reported.has(extension)) continue;
        keep(`extensionsUsed/${extension}`, "extension", `${extension} is declared but found on no object; not read by this importer`);
    }
    (json.accessors ?? []).forEach((_, i) => { if (!usedAccessors.has(i)) report.skipped.push({ path: `accessors/${i}`, type: "accessor", reason: "used by no mesh, skin or animation" }); });
    counted("accessor", usedAccessors.size);
    counted("bufferView", (json.bufferViews ?? []).length);
    counted("buffer", (json.buffers ?? []).length);
    signal?.throwIfAborted();

    const layer = {
        schema: "scene-layer/0", name, kind: "content", visible: true, placement: IDENTITY(),
        source: { uri: source?.uri ?? null, format: GLTF_FORMAT, scene: shown === null ? null : `scenes/${shown}`,
            header: { container, asset: structuredClone(json.asset), extensionsUsed: used, extensionsRequired: required } },
        info: null, navigation: null, environment: { background: null, color: null, intensity: null, image: null },
        entities, assets: { geometries, materials, textures, images }, report,
        extras: Object.keys(layerExtras).length ? { gltf: layerExtras } : {},
    };
    return freezeDeep({ layer, report });
}

/** The importer object of the contract: the application hands over the bytes; linked files come through resolve. */
export const gltfImporter = Object.freeze({
    format: GLTF_FORMAT,
    capabilities() {
        return { gltf: { status: "limited", level: "glTF 2.0 (.glb and .gltf): scenes, nodes, meshes (POSITION, NORMAL, TEXCOORD_0, COLOR_0, indices, modes), metallic-roughness materials with five texture slots, textures, samplers, images, perspective cameras, KHR_lights_punctual",
            reason: "Skins, animations, morph targets, other attributes and every other extension are kept and reported in report mode, not drawn; a file that needs a compressed-mesh or compressed-texture decoder is refused." } };
    },
    async import(source, { resolve, signal, mode = "strict", options = {} } = {}) {
        return gltfToLayer(source, { resolve, signal, mode, name: options.name ?? "world" });
    },
});
