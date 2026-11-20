import { X3D_FIELDS, X3D_SCENE_TYPES, SOFT_BODY_COMPATIBILITY, SOFT_BODY_SHA256, sealX3dValue, validateX3dField } from "./profile.mjs";

const parsedDocuments = new WeakSet();
const skippedBodyPath = "$.X3D.Scene.-children[8].RigidBodyCollection.-bodies[0]";

/** True only for immutable documents produced by this module. */
export function isX3dDocument(value) { return parsedDocuments.has(value); }

function record(value, path, keys) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${path}: expected object`);
    for (const key of Object.keys(value)) if (!keys.includes(key)) throw new TypeError(`${path}.${key}: unsupported field`);
}

/**
 * Parses JSON text without I/O. Compatibility requires an exact byte digest;
 * returned source/header/nodes/DEF table/diagnostics are deeply immutable.
 * @param {string} text
 * @param {{compatibility?: string, signal?: AbortSignal}} options
 * @returns {Promise<object>}
 */
export async function parseX3dDocument(text, { compatibility, signal } = {}) {
    signal?.throwIfAborted();
    if (typeof text !== "string" || text.length > 2_000_000) throw new TypeError("$: expected JSON text of at most 2000000 characters");
    if (compatibility !== undefined && compatibility !== SOFT_BODY_COMPATIBILITY) throw new TypeError("$: unsupported compatibility mode");
    if (compatibility) {
        const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
        signal?.throwIfAborted();
        const hex = Array.from(new Uint8Array(digest), (v) => v.toString(16).padStart(2, "0")).join("");
        if (hex !== SOFT_BODY_SHA256) throw new TypeError("$: compatibility requires the pinned soft-body bytes");
    }
    let source;
    try { source = JSON.parse(text); } catch (error) { throw new TypeError(`$: invalid JSON: ${error.message}`); }
    record(source, "$", ["X3D"]);
    const x3d = source.X3D;
    record(x3d, "$.X3D", ["encoding", "@profile", "@version", "@xsd:noNamespaceSchemaLocation", "JSON schema", "head", "Scene"]);
    const pair = `${x3d["@version"]}/${x3d["@profile"]}`;
    if (!["4.0/Interactive", "4.1/Full"].includes(pair)) throw new TypeError("$.X3D: unsupported version/profile declaration");
    if (x3d.encoding !== undefined && x3d.encoding !== "UTF-8") throw new TypeError("$.X3D.encoding: unsupported encoding");
    for (const key of ["@xsd:noNamespaceSchemaLocation", "JSON schema"]) {
        if (key in x3d) validateX3dField("string", x3d[key], `$.X3D.${key}`);
    }
    const head = x3d.head ?? {};
    record(head, "$.X3D.head", ["component", "meta"]);
    for (const kind of ["component", "meta"]) {
        if (head[kind] !== undefined && !Array.isArray(head[kind])) throw new TypeError(`$.X3D.head.${kind}: expected array`);
        for (const [i, item] of (head[kind] ?? []).entries()) {
            const path = `$.X3D.head.${kind}[${i}]`;
            record(item, path, kind === "meta" ? ["@name", "@content"] : ["@name", "@level"]);
            validateX3dField("string", item["@name"], `${path}.@name`);
            if (kind === "meta") validateX3dField("string", item["@content"], `${path}.@content`);
            else if (!Object.hasOwn({ Networking: 2, EnvironmentalSensor: 1, Text: 1, RigidBodyPhysics: 2 }, item["@name"]) ||
                !Number.isInteger(item["@level"]) || item["@level"] < 1 || item["@level"] > ({ Networking: 2, EnvironmentalSensor: 1, Text: 1, RigidBodyPhysics: 2 })[item["@name"]]) {
                throw new TypeError(`${path}: unsupported component/level`);
            }
        }
    }
    record(x3d.Scene, "$.X3D.Scene", ["-children"]);
    const definitions = Object.create(null), nodes = [], diagnostics = [], inventory = Object.create(null);
    let occurrences = 0;
    const active = new Set();
    const parseNode = (wrapper, path, allowed, depth) => {
        if (depth > 128 || ++occurrences > 20000) throw new TypeError(`${path}: scene size/depth limit`);
        if (compatibility && path === skippedBodyPath) {
            diagnostics.push({ code: "omitted-empty-soft-body", path, message: "Pinned Features placeholder omitted; the visible Text remains." });
            return null;
        }
        if (!wrapper || typeof wrapper !== "object" || Array.isArray(wrapper) || Object.keys(wrapper).length !== 1) throw new TypeError(`${path}: expected one node wrapper`);
        const type = Object.keys(wrapper)[0], input = wrapper[type], schema = X3D_FIELDS[type];
        if (!Object.hasOwn(X3D_FIELDS, type) || !allowed.includes(type)) throw new TypeError(`${path}.${type}: unsupported node in this field`);
        if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError(`${path}.${type}: expected object`);
        const nodePath = `${path}.${type}`;
        const entry = inventory[type] ??= { count: 0, fields: new Set() };
        entry.count++;
        for (const key of Object.keys(input)) entry.fields.add(key);
        if (Object.hasOwn(input, "@USE")) {
            if (Object.keys(input).length !== 1 || typeof input["@USE"] !== "string" || !input["@USE"]) throw new TypeError(`${nodePath}.@USE: expected a nonempty reference only`);
            const target = definitions[input["@USE"]];
            if (!target || target.type !== type) throw new TypeError(`${nodePath}.@USE: missing or type-mismatched DEF`);
            if (active.has(target)) throw new TypeError(`${nodePath}.@USE: cyclic containment`);
            return target;
        }
        const def = input["@DEF"];
        if (def !== undefined && (typeof def !== "string" || !/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(def))) throw new TypeError(`${nodePath}.@DEF: unsupported name`);
        if (def !== undefined && Object.hasOwn(definitions, def)) throw new TypeError(`${nodePath}.@DEF: duplicate DEF ${def}`);
        const node = { type, id: def ? `DEF:${def}` : nodePath, def: def ?? null, path: nodePath, fields: {}, children: {} };
        if (def) definitions[def] = node;
        nodes.push(node);
        active.add(node);
        for (const key of Object.keys(input)) {
            if (key === "@DEF") continue;
            const name = key.slice(1), spec = schema[name];
            if (!Object.hasOwn(schema, name) || key[0] !== (spec.type.startsWith("node") ? "-" : "@")) throw new TypeError(`${nodePath}.${key}: unsupported field`);
        }
        for (const [name, spec] of Object.entries(schema)) {
            const child = spec.type.startsWith("node"), key = `${child ? "-" : "@"}${name}`;
            const value = Object.hasOwn(input, key) ? input[key] : structuredClone(spec.initial);
            if (child) {
                const types = spec.type.split(":")[1].split(" ");
                if (spec.type.startsWith("nodes:")) {
                    if (!Array.isArray(value)) throw new TypeError(`${nodePath}.${key}: expected node array`);
                    node.children[name] = value.map((v, i) => parseNode(v, `${nodePath}.${key}[${i}]`, types, depth + 1)).filter(Boolean);
                } else node.children[name] = value === null ? null : parseNode(value, `${nodePath}.${key}`, types, depth + 1);
            } else {
                validateX3dField(spec.type, value, `${nodePath}.${key}`);
                node.fields[name] = value;
            }
        }
        if (type === "SingleAxisHingeJoint" || type === "Stitch") {
            if (!node.children.body1 || !node.children.body2) throw new TypeError(`${nodePath}: joint requires both bodies`);
        }
        if (type === "Stitch" && node.fields.body1Index.length !== node.fields.weight.length) throw new TypeError(`${nodePath}: stitch indices/weights must have equal length`);
        active.delete(node);
        return node;
    };
    if (!Array.isArray(x3d.Scene["-children"])) throw new TypeError("$.X3D.Scene.-children: expected array");
    const roots = x3d.Scene["-children"].map((v, i) => parseNode(v, `$.X3D.Scene.-children[${i}]`, X3D_SCENE_TYPES, 0));
    if (compatibility && diagnostics.length !== 1) throw new TypeError("$: pinned compatibility location not found");
    for (const entry of Object.values(inventory)) entry.fields = [...entry.fields].sort();
    signal?.throwIfAborted();
    const document = sealX3dValue({ schema: "x3d-subset/1", source, header: { version: x3d["@version"], profile: x3d["@profile"], head }, roots, nodes, definitions, diagnostics, inventory });
    parsedDocuments.add(document);
    return document;
}
