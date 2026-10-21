'use strict';

/*
 * OSL-native Spatial Composition Graph store.
 *
 * The canonical OpenSpatialWorld "Spatial Composition Graph" the 041 backend
 * serves at:
 *   GET    /wow/spatial/{spatialID}                 -> the root Node
 *   GET    /wow/spatial/{spatialID}/node/{nodeId}   -> a single Node
 *   POST   /wow/spatial/{spatialID}/node/{nodeId}   -> create child Nodes
 *   PUT    /wow/spatial/{spatialID}/node/{nodeId}   -> update a Node
 *   DELETE /wow/spatial/{spatialID}/node/{nodeId}   -> delete a Node (+ subtree)
 *
 * This is a MUTABLE, per-world scene-graph store. The nodes follow the CANONICAL
 * WoW `Node` schema (wow-spec/schema.yaml components.schemas.Node): integer id,
 * label, names[], parent, children[] (id refs), a flat 16-float column-major
 * localTransform, spatialAssetURI, appearanceURI.
 *
 * DEPENDENCY-FREE + OSL-NATIVE (reuse-over-rebuild mandate,
 * §12): Node core only. This is OSL's OWN code — it is NOT vendored from the
 * UNLICENSED simpleWorlds reference impl; only the "persist the graph to a JSON
 * file" PATTERN is borrowed (their world_state.json). The store seeds itself
 * from the world's REAL live scene data (the hosted primitives + portals the
 * server already carries) — populated from real scene data, not stubs.
 *
 * HONESTY BOUNDARY (unchanged by this store): no standards-conformance claim;
 * hosted primitives are labeled `osl-primitive:` URIs (NOT glTF —
 * bring real glTF `spatialAssetURI` assets); portal destinations are carried as
 * labeled `osl-portal:` URIs pending the portal-destination migration.
 *
 * PERSISTENCE (env-gated, DEFAULT OFF — additive, byte-identical default path):
 *   OSL_WOW_SPATIAL_PERSIST=1  -> load-on-boot + save-on-mutation to a JSON file
 *                                 per world under OSL_WOW_SPATIAL_DIR (or the
 *                                 default spatial-store dir). Default OFF keeps
 *                                 the store in-memory (still survives across
 *                                 requests), so the existing deterministic test
 *                                 battery is unaffected.
 */

const fs = require('fs');
const path = require('path');

const ROOT_ID = 0;

/*
 * NO SILENT CHILD-NODE DATA LOSS.
 *
 * Before this change, three separate paths dropped a caller's `children` on the
 * floor and still answered 200 OK:
 *
 *   1. normalizeNode()  `children.filter(Number.isInteger)` — every non-integer
 *      child entry (a canonical EMBEDDED `Node` object, a stringified id, null)
 *      vanished with no error.
 *   2. createChildren() `node.children = []` — even INTEGER id-refs sent on a
 *      POST were discarded ("new nodes start as leaves"), silently.
 *   3. updateNode()     ignored `children` entirely — a PUT that restructured a
 *      node's children was a silent no-op.
 *
 * The canonical WoW `Node` (the STANDARD; wow-spec/schema.yaml `Node`, open-spec
 * API.yaml:484-487) types `children` as EMBEDDED `Node` objects. OSL serves the
 * DECLARED, LABELED divergence `OSLFlatNode` (children = integer id refs). So a
 * SPEC-CONFORMANT client POSTing a tree had its whole subtree deleted and was
 * told 200 OK — it believed we stored something we did not. That is the worst
 * failure mode in this project.
 *
 * The rule now: EVERY child entry is CLASSIFIED, never filtered. Nothing is
 * dropped without the caller being told, on EVERY path, regardless of whether
 * ajv request validation (`OSL_WOW_VALIDATE`, default OFF) is enabled — the
 * check is STRUCTURAL, in the store, not a validation-layer opt-in.
 *
 *   - integer id-ref child on CREATE  -> 400 child_id_refs_not_supported_on_create
 *   - embedded canonical Node child   -> 422 embedded_children_not_supported
 *                                        (unless the caller EXPLICITLY opts in to
 *                                         flattening: { flattenEmbedded: true })
 *   - anything else                   -> 400 invalid_child_entry
 *   - children restructured on PUT    -> 422 child_restructure_not_supported
 *
 * See the result artifact for why "reject by default + explicit opt-in" and not
 * "always reject" or "always flatten".
 */

/** The canonical child-form a caller can opt in to (POST only). */
const CANONICAL_CHILD_FORM = 'canonical';

/**
 * Classify a raw `children` value WITHOUT dropping anything.
 *
 * @returns {{refs:number[], embedded:object[], invalid:Array<{index:number,value:*}>,
 *            present:boolean, count:number}}
 */
function classifyChildren(rawChildren)
{
    const out = { refs : [], embedded : [], invalid : [], present : false, count : 0 };
    if (!Array.isArray(rawChildren)) return out;
    out.present = true;
    out.count = rawChildren.length;
    rawChildren.forEach((entry, index) => {
        if (Number.isInteger(entry)) out.refs.push(entry);
        else if (entry && typeof entry === 'object' && !Array.isArray(entry)) out.embedded.push(entry);
        else out.invalid.push({ index : index, value : entry });
    });
    return out;
}

/**
 * Walk an incoming node forest and report EVERY child entry we cannot store as
 * sent. Returns null when the forest is storable as-is (flat, leaf-only), else a
 * discriminated rejection carrying the exact JSON paths so the caller can see
 * precisely what we refused and why.
 *
 * @param {Array} forest         - the POSTed node array (or [node] for a PUT).
 * @param {object} opts
 * @param {boolean} opts.flattenEmbedded - caller EXPLICITLY opted in to flattening.
 * @param {string}  opts.basePath        - JSON-path prefix for messages.
 */
function inspectIncomingForest(forest, opts)
{
    opts = opts || {};
    const flatten = !!opts.flattenEmbedded;
    const base = opts.basePath || '$';
    const idRefPaths = [];
    const embeddedPaths = [];
    const invalidPaths = [];

    (function walk(nodes, prefix)
    {
        nodes.forEach((raw, i) => {
            const at = prefix + '[' + i + ']';
            const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
            const c = classifyChildren(r.children);
            if (!c.present) return;
            for (const bad of c.invalid)
                invalidPaths.push({ path : at + '.children[' + bad.index + ']', type : typeofLabel(bad.value) });
            if (c.refs.length)
                idRefPaths.push({ path : at + '.children', refs : c.refs.slice() });
            if (c.embedded.length)
            {
                embeddedPaths.push({ path : at + '.children', count : c.embedded.length });
                // recurse regardless of policy: we must report the WHOLE forest,
                // not just its first offending level.
                walk(c.embedded, at + '.children');
            }
        });
    })(Array.isArray(forest) ? forest : [], base);

    if (invalidPaths.length)
        return {
            ok : false, status : 400, error : 'invalid_child_entry',
            detail : {
                message : 'children[] entries must be integer node-id references (OSLFlatNode)'
                    + (flatten ? ' or embedded Node objects' : '')
                    + '; these entries are neither and were REFUSED (never silently dropped).',
                offending_paths : invalidPaths,
            },
        };

    if (idRefPaths.length && !opts.allowIdRefs)
        return {
            ok : false, status : 400, error : 'child_id_refs_not_supported_on_create',
            detail : {
                message : 'This server assigns node ids; a node created by POST starts as a LEAF. '
                    + 'Integer child id-refs on a create body cannot be honoured (they were previously '
                    + 'DROPPED SILENTLY — they are now REFUSED). Create the parent first, then POST its '
                    + 'children to /wow/spatial/{spatialID}/node/{newParentId}.',
                offending_paths : idRefPaths,
            },
        };

    if (embeddedPaths.length && !flatten)
        return {
            ok : false, status : 422, error : 'embedded_children_not_supported',
            detail : {
                message : 'This body carries the CANONICAL WoW `Node` shape (children = embedded Node '
                    + 'objects). This server serves + accepts `OSLFlatNode` — a DECLARED, LABELED '
                    + 'divergence in which children are INTEGER node-id references. Your embedded '
                    + 'children were REFUSED, NOT stored, and NOT silently dropped.',
                served_schema : 'OSLFlatNode',
                canonical_schema : 'Node',
                divergence : 'Node.children: integer id-refs (OSL) vs embedded Node objects (canonical)',
                offending_paths : embeddedPaths,
                remedies : [
                    'Send OSLFlatNode: POST each node with children:[] (or omitted), then POST its '
                        + 'children under the id we return.',
                    'Or opt in to server-side flattening: resend with header '
                        + '`X-OSL-WoW-Node-Form: canonical` (or ?nodeForm=canonical). We will then assign '
                        + 'ids to your embedded subtree, store it, and return EVERY node we stored.',
                ],
            },
        };

    return null; // storable as sent
}

function typeofLabel(v)
{
    if (v === null) return 'null';
    if (Array.isArray(v)) return 'array';
    return typeof v;
}

/** A flat 16-float column-major 4x4 translation matrix from a [x,y,z] position. */
function translationMatrix(position)
{
    const p = Array.isArray(position) ? position : [ 0, 0, 0 ];
    const x = Number(p[0]) || 0;
    const y = Number(p[1]) || 0;
    const z = Number(p[2]) || 0;
    // column-major: translation occupies elements 12,13,14 (the last column).
    return [
        1, 0, 0, 0,
        0, 1, 0, 0,
        0, 0, 1, 0,
        x, y, z, 1,
    ];
}

function clone(value)
{
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

function isEnvOn(name)
{
    return /^(1|true|on|yes)$/i.test(String(process.env[name] || ''));
}

/**
 * Build a canonical Node store.
 *
 * @param {object} opts
 * @param {string} opts.spatialId       - primary spatial graph id (the world_id).
 * @param {string[]} opts.acceptedIds   - all ids that address THIS graph
 *                                        (world_id, location_id, aliases).
 * @param {function} opts.seedBuilder   - () => { root, nodes[] } canonical seed,
 *                                        recomputed on reset from live scene data.
 * @param {boolean} [opts.persist]      - persist to disk (default: env-gated).
 * @param {string}  [opts.persistDir]   - persistence dir.
 */
function createSpatialGraphStore(opts)
{
    opts = opts || {};
    const spatialId = String(opts.spatialId || 'world');
    const acceptedIds = (opts.acceptedIds || [ spatialId ])
        .map(id => String(id))
        .filter((id, i, all) => id && all.indexOf(id) === i);
    const seedBuilder = typeof opts.seedBuilder === 'function' ? opts.seedBuilder : () => ({ root: rootNode(), nodes: [] });
    const persist = opts.persist != null ? !!opts.persist : isEnvOn('OSL_WOW_SPATIAL_PERSIST');
    const persistDir = String(opts.persistDir
        || process.env.OSL_WOW_SPATIAL_DIR
        || path.join(__dirname, '..', 'spatial-store'));
    const persistFile = path.join(persistDir, spatialId.replace(/[^A-Za-z0-9._-]/g, '_') + '.json');

    // id -> Node (canonical shape). rootId is always ROOT_ID.
    let nodes = new Map();
    let nextId = ROOT_ID + 1;

    function rootNode()
    {
        return {
            id: ROOT_ID,
            label: 'Root',
            names: [ spatialId ],
            children: [],
            localTransform: translationMatrix([ 0, 0, 0 ]),
        };
    }

    /** Seed the store from live scene data (deterministic; ids assigned here). */
    function loadSeed()
    {
        const seed = seedBuilder() || {};
        nodes = new Map();
        const root = normalizeNode(seed.root || rootNode(), ROOT_ID);
        root.id = ROOT_ID;
        root.children = [];
        nodes.set(ROOT_ID, root);
        nextId = ROOT_ID + 1;
        const children = Array.isArray(seed.nodes) ? seed.nodes : [];
        for (const raw of children)
        {
            const id = nextId++;
            const node = normalizeNode(raw, id);
            node.id = id;
            node.parent = ROOT_ID;
            node.children = Array.isArray(node.children) ? node.children : [];
            nodes.set(id, node);
            root.children.push(id);
        }
    }

    /**
     * Coerce an arbitrary object into the OSLFlatNode shape (no stray keys).
     *
     * this is a TRUSTED-INPUT normalizer only. It is reached from the
     * seed builder and the persisted-file loader — both of which are OSL's own
     * flat, integer-child data. It NO LONGER silently `.filter()`s children:
     * a non-integer child here means a CORRUPT store file (or a broken seed),
     * which is LOUD (warned) rather than quietly swallowed. Caller-supplied
     * bodies never reach here unclassified — inspectIncomingForest() has already
     * refused (or flattened, on explicit opt-in) anything that is not flat.
     */
    function normalizeNode(raw, fallbackId)
    {
        const r = raw && typeof raw === 'object' ? raw : {};
        const node = { id: Number.isInteger(r.id) ? r.id : fallbackId };
        if (r.label != null) node.label = String(r.label);
        if (Array.isArray(r.names)) node.names = r.names.map(n => String(n));
        if (Number.isInteger(r.parent)) node.parent = r.parent;
        const c = classifyChildren(r.children);
        if (c.embedded.length || c.invalid.length)
            console.warn('[spatial-graph] CORRUPT trusted node ' + node.id + ' (' + spatialId + '): '
                + (c.embedded.length + c.invalid.length) + ' of ' + c.count + ' children are not integer '
                + 'id-refs and cannot be stored in the flat graph. This is a store/seed defect, not a '
                + 'client body — client bodies are refused upstream.');
        node.children = c.refs;
        node.localTransform = Array.isArray(r.localTransform) && r.localTransform.length
            ? r.localTransform.map(n => Number(n) || 0)
            : translationMatrix([ 0, 0, 0 ]);
        if (r.spatialAssetURI != null) node.spatialAssetURI = String(r.spatialAssetURI);
        if (r.appearanceURI != null) node.appearanceURI = String(r.appearanceURI);
        // preserve a LABELED, NON-CANONICAL webofworlds_extension
        // bag when a node carries one (e.g. a PORTAL node's resolvable destination /
        // composition-graph reference). Additive: a node with no extension (every
        // hosted-primitive node) is byte-identical to before. It rides legally on the
        // OPEN canonical Node (schema sets no additionalProperties:false) and is
        // SURFACED — never hidden — by the conformance lane.
        if (r.webofworlds_extension && typeof r.webofworlds_extension === 'object')
            node.webofworlds_extension = clone(r.webofworlds_extension);
        return node;
    }

    function persistSave()
    {
        if (!persist) return;
        try {
            if (!fs.existsSync(persistDir)) fs.mkdirSync(persistDir, { recursive: true });
            const doc = {
                // OSL-native persistence format (labeled; NOT a WoW spec artifact).
                osl_spatial_store: true,
                spatial_id: spatialId,
                accepted_ids: acceptedIds.slice(),
                saved_at: new Date().toISOString(),
                root_id: ROOT_ID,
                next_id: nextId,
                nodes: snapshotNodes(),
            };
            const tmp = persistFile + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', 'utf8');
            fs.renameSync(tmp, persistFile);
        } catch (e) {
            // Persistence is best-effort + additive; never break the request path.
            console.warn('[spatial-graph] persist save failed (' + spatialId + '): ' + e.message);
        }
    }

    function persistLoad()
    {
        if (!persist) return false;
        try {
            if (!fs.existsSync(persistFile)) return false;
            const doc = JSON.parse(fs.readFileSync(persistFile, 'utf8'));
            if (!doc || !Array.isArray(doc.nodes)) return false;
            nodes = new Map();
            for (const raw of doc.nodes)
            {
                const node = normalizeNode(raw, raw && raw.id);
                nodes.set(node.id, node);
            }
            if (!nodes.has(ROOT_ID)) { loadSeed(); return true; }
            nextId = Number.isInteger(doc.next_id) ? doc.next_id : computeNextId();
            return true;
        } catch (e) {
            console.warn('[spatial-graph] persist load failed (' + spatialId + '): ' + e.message);
            return false;
        }
    }

    function computeNextId()
    {
        let max = ROOT_ID;
        for (const id of nodes.keys()) if (id > max) max = id;
        return max + 1;
    }

    function snapshotNodes()
    {
        return Array.from(nodes.values()).map(clone);
    }

    // ---- public read API ----

    /** True if `id` addresses THIS graph. */
    function matches(id)
    {
        return acceptedIds.indexOf(String(id == null ? '' : id)) !== -1;
    }

    function getRoot()
    {
        const root = nodes.get(ROOT_ID);
        return root ? clone(root) : null;
    }

    function getNode(nodeId)
    {
        const id = Number(nodeId);
        if (!Number.isInteger(id)) return null;
        const node = nodes.get(id);
        return node ? clone(node) : null;
    }

    function listNodes()
    {
        return snapshotNodes();
    }

    // ---- public write API (returns { ok, ... } discriminated results) ----

    /**
     * POST — create + attach new child nodes under an existing parent.
     *
     * children on the incoming body are CLASSIFIED, never dropped.
     *   - flat/leaf bodies (children:[] or omitted) -> unchanged, byte-identical.
     *   - integer id-refs                           -> 400 (were silently dropped).
     *   - embedded canonical Node children          -> 422 by DEFAULT (were silently
     *     deleted); with opts.flattenEmbedded the whole subtree is stored and EVERY
     *     created node is returned so the caller sees exactly what we stored.
     *
     * @param {object} [opts]
     * @param {boolean} [opts.flattenEmbedded] - caller explicitly opted in.
     */
    function createChildren(parentId, incoming, opts)
    {
        opts = opts || {};
        const pid = Number(parentId);
        if (!Number.isInteger(pid)) return { ok: false, status: 400, error: 'invalid_parent_id' };
        const parent = nodes.get(pid);
        if (!parent) return { ok: false, status: 404, error: 'parent_not_found' };
        if (!Array.isArray(incoming) || !incoming.length)
            return { ok: false, status: 400, error: 'expected_non_empty_node_array' };

        // NOTHING is stored until the WHOLE forest is known to be storable.
        const refusal = inspectIncomingForest(incoming, {
            flattenEmbedded : !!opts.flattenEmbedded,
            allowIdRefs : false,
            basePath : '$',
        });
        if (refusal) return refusal;

        const created = [];
        let flattened = 0;
        let maxDepth = 0;

        // BFS-free recursive attach: parents are created before their children, so
        // `created` is in a topological order the caller can replay.
        (function attach(rawNodes, attachTo, depth)
        {
            if (depth > maxDepth) maxDepth = depth;
            for (const raw of rawNodes)
            {
                const id = nextId++;
                const embedded = classifyChildren(raw && raw.children).embedded;
                // `children` is OWNED by this loop (ids are assigned as we descend), so
                // hand normalizeNode a childless view — otherwise its corrupt-store
                // warning would fire on the perfectly legitimate flatten path.
                const rawContent = Object.assign({}, raw && typeof raw === 'object' ? raw : {});
                delete rawContent.children;
                const node = normalizeNode(rawContent, id);
                node.id = id;               // server owns id assignment (integrity)
                node.parent = attachTo;     // attach under the requested parent
                node.children = [];         // filled in below if it has a subtree
                nodes.set(id, node);
                const parentNode = nodes.get(attachTo);
                if (parentNode && Array.isArray(parentNode.children)) parentNode.children.push(id);

                // PRE-ORDER: record the parent BEFORE descending, so `created` is
                // returned parents-first and a caller can replay it top-down (every
                // node's `parent` is already present by the time it is read).
                created.push(id);

                if (embedded.length)
                {
                    // Only reachable with opts.flattenEmbedded — inspectIncomingForest()
                    // has already 422'd this body otherwise.
                    flattened += embedded.length;
                    attach(embedded, id, depth + 1);
                }
            }
        })(incoming, pid, 1);

        persistSave();
        // Return EVERY node we actually stored (parents first), so a caller that
        // opted into flattening can see the ids we assigned at every depth.
        const value = created.map(id => clone(nodes.get(id)));
        return {
            ok : true, status : 200, value : value,
            flattened : flattened,       // embedded children we flattened (0 on the flat path)
            depth : maxDepth,
            requested : incoming.length, // top-level nodes the caller sent
            stored : value.length,       // nodes we actually created (>= requested when flattened)
        };
    }

    /** PUT — update an existing node's CONTENT (structure preserved). */
    function updateNode(nodeId, incoming)
    {
        const id = Number(nodeId);
        if (!Number.isInteger(id)) return { ok: false, status: 400, error: 'invalid_node_id' };
        const existing = nodes.get(id);
        if (!existing) return { ok: false, status: 404, error: 'node_not_found' };
        const r = incoming && typeof incoming === 'object' ? incoming : {};

        // a PUT `children` used to be IGNORED — silently. It is now
        // classified. The ONE structure-bearing body we accept is the harmless
        // read-modify-write echo (children identical to what we already store):
        // GET the node, change a label, PUT it back. Anything that would RESTRUCTURE
        // the node is REFUSED with the route that does support it, and an embedded
        // (canonical `Node`) children array is refused by name.
        const c = classifyChildren(r.children);
        if (c.present)
        {
            const current = Array.isArray(existing.children) ? existing.children : [];
            const echo = c.embedded.length === 0 && c.invalid.length === 0
                && c.refs.length === current.length
                && c.refs.every((v, i) => v === current[i]);
            if (!echo)
            {
                if (c.embedded.length)
                    return {
                        ok : false, status : 422, error : 'embedded_children_not_supported',
                        detail : {
                            message : 'This PUT body carries the CANONICAL WoW `Node` shape (children = '
                                + 'embedded Node objects). This server serves + accepts `OSLFlatNode` '
                                + '(children = integer node-id refs), and a PUT never restructures a node. '
                                + 'Your embedded children were REFUSED, NOT stored, and NOT silently dropped.',
                            served_schema : 'OSLFlatNode',
                            canonical_schema : 'Node',
                            divergence : 'Node.children: integer id-refs (OSL) vs embedded Node objects (canonical)',
                            current_children : current.slice(),
                            remedies : [
                                'POST /wow/spatial/{spatialID}/node/' + id + ' to CREATE children under this node '
                                    + '(add `X-OSL-WoW-Node-Form: canonical` there to have an embedded subtree '
                                    + 'flattened and stored).',
                                'DELETE /wow/spatial/{spatialID}/node/{childId} to remove one.',
                                'Or PUT with `children` omitted (or echoed unchanged) to edit content only.',
                            ],
                        },
                    };
                return {
                    ok : false, status : 422, error : 'child_restructure_not_supported',
                    detail : {
                        message : 'PUT updates a node\'s CONTENT; it never restructures the graph. The '
                            + '`children` you sent differ from the ones we store, so honouring this body '
                            + 'would mean changing structure — it was REFUSED rather than (as before) '
                            + 'SILENTLY IGNORED.',
                        current_children : current.slice(),
                        requested_children : Array.isArray(r.children) ? r.children.slice() : r.children,
                        remedies : [
                            'POST /wow/spatial/{spatialID}/node/' + id + ' to create children.',
                            'DELETE /wow/spatial/{spatialID}/node/{childId} to remove one.',
                            'Omit `children` (or echo it unchanged) to edit content only.',
                        ],
                    },
                };
            }
        }

        // Content fields are updatable; id/parent/children (structure) are
        // preserved — re-parenting/child edits go through POST/DELETE.
        if ('label' in r) existing.label = r.label == null ? undefined : String(r.label);
        if ('names' in r) existing.names = Array.isArray(r.names) ? r.names.map(n => String(n)) : existing.names;
        if ('localTransform' in r && Array.isArray(r.localTransform))
            existing.localTransform = r.localTransform.map(n => Number(n) || 0);
        if ('spatialAssetURI' in r) existing.spatialAssetURI = r.spatialAssetURI == null ? undefined : String(r.spatialAssetURI);
        if ('appearanceURI' in r) existing.appearanceURI = r.appearanceURI == null ? undefined : String(r.appearanceURI);
        // drop undefined keys so the emitted Node stays clean
        for (const k of Object.keys(existing)) if (existing[k] === undefined) delete existing[k];
        persistSave();
        return { ok: true, status: 200, value: clone(existing) };
    }

    /** DELETE — remove a node and its whole subtree (root is protected). */
    function deleteNode(nodeId)
    {
        const id = Number(nodeId);
        if (!Number.isInteger(id)) return { ok: false, status: 400, error: 'invalid_node_id' };
        if (id === ROOT_ID) return { ok: false, status: 400, error: 'cannot_delete_root' };
        const node = nodes.get(id);
        if (!node) return { ok: false, status: 404, error: 'node_not_found' };

        // collect subtree (DFS)
        const deleted = [];
        const stack = [ id ];
        while (stack.length)
        {
            const cur = stack.pop();
            const n = nodes.get(cur);
            if (!n) continue;
            deleted.push(cur);
            for (const c of (n.children || [])) stack.push(c);
            nodes.delete(cur);
        }
        // unlink from parent
        if (Number.isInteger(node.parent))
        {
            const parent = nodes.get(node.parent);
            if (parent && Array.isArray(parent.children))
                parent.children = parent.children.filter(c => c !== id);
        }
        persistSave();
        return { ok: true, status: 200, value: { deleted: deleted, count: deleted.length } };
    }

    /** Rebuild from live scene data (called by runtime reset()). */
    function resetToSeed()
    {
        loadSeed();
        persistSave();
        return getRoot();
    }

    // ---- init: persisted state (if enabled + present) else fresh seed ----
    loadSeed();
    if (persist)
    {
        const loaded = persistLoad();
        if (!loaded) persistSave(); // establish the file from the seed
    }

    return {
        spatialId,
        acceptedIds: acceptedIds.slice(),
        persist,
        persistFile,
        ROOT_ID,
        matches,
        getRoot,
        getNode,
        listNodes,
        createChildren,
        updateNode,
        deleteNode,
        resetToSeed,
    };
}

module.exports = {
    createSpatialGraphStore,
    translationMatrix,
    ROOT_ID,
    // exported so the proof harnesses can assert the
    // classification directly, without an HTTP round-trip.
    classifyChildren,
    inspectIncomingForest,
    CANONICAL_CHILD_FORM,
};
