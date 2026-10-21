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
const { checkLocalTransform } = require('./node-transform');

const ROOT_ID = 0;

// Deepest children[] nesting an incoming body may carry. A deeper body is refused with 422
// before anything walks it further, so a hostile body cannot exhaust the stack.
const MAX_NODE_TREE_DEPTH = 64;

/*
 * NO SILENT CHILD-NODE DATA LOSS.
 *
 * A node is the canonical `Node` by default: its `children` are the child nodes themselves. The
 * labeled `OSLFlatNode` (children are integer ids) is served only when a request asks for the node
 * form `flat`. Whatever form a body is in, every child entry is CLASSIFIED, never filtered, so no
 * path stores less than the caller sent and still answers 200 OK:
 *
 *   - canonical form: embedded children are stored as a subtree, and the response returns the nodes
 *     the caller sent with every id assigned;
 *   - flat form: integer id-ref child on CREATE -> 400 child_id_refs_not_supported_on_create;
 *     embedded Node child -> 422 embedded_children_not_supported;
 *   - anything else      -> 400 invalid_child_entry;
 *   - children restructured on PUT -> 422 child_restructure_not_supported (children are derived
 *     from the tree; a PUT may leave them out or repeat them unchanged).
 */

/** The default node form: the canonical Node, children embedded. */
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

    let depthExceededPath = null;
    (function walk(nodes, prefix, depth)
    {
        if (depthExceededPath) return;
        if (depth > MAX_NODE_TREE_DEPTH) { depthExceededPath = prefix; return; }
        nodes.forEach((raw, i) => {
            if (depthExceededPath) return;
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
                walk(c.embedded, at + '.children', depth + 1);
            }
        });
    })(Array.isArray(forest) ? forest : [], base, 1);

    if (depthExceededPath)
        return {
            ok : false, status : 422, error : 'node_tree_too_deep',
            detail : {
                message : 'children[] nesting exceeds the maximum supported depth of '
                    + MAX_NODE_TREE_DEPTH + '.',
                path : depthExceededPath,
            },
        };

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
                message : 'This body carries the canonical `Node` shape (children = embedded Node objects), but its node '
                    + 'form is `flat`: the labeled `OSLFlatNode`, whose children are integer node ids. Your embedded '
                    + 'children were REFUSED, NOT stored, and NOT silently dropped.',
                served_schema : 'OSLFlatNode',
                canonical_schema : 'Node',
                offending_paths : embeddedPaths,
                remedies : [
                    'Drop `X-OSL-WoW-Node-Form: flat` (and ?nodeForm=flat). The default form is the canonical Node, '
                        + 'whose children are embedded and stored as sent.',
                    'Or send OSLFlatNode: POST each node with children:[] (or omitted), then POST its '
                        + 'children under the id we return.',
                ],
            },
        };

    return null; // storable as sent
}

/**
 * Check every `localTransform` in an incoming node forest, embedded children included. Returns null
 * when every transform is valid, else the first refusal (422 invalid_local_transform) with the JSON
 * path and the reason. See node-transform.js for what a valid transform is.
 *
 * With opts.arraysOnly a transform that is not an array is left alone, for the contract layer to
 * refuse with its own type error.
 */
function inspectIncomingTransforms(forest, opts)
{
    opts = opts || {};
    let refusal = null;
    function visit(raw, at, depth)
    {
        if (refusal || depth > MAX_NODE_TREE_DEPTH) return;
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
        if ('localTransform' in raw && !(opts.arraysOnly && !Array.isArray(raw.localTransform)))
        {
            const bad = checkLocalTransform(raw.localTransform);
            if (bad)
            {
                refusal = {
                    ok : false, status : 422, error : 'invalid_local_transform',
                    detail : { path : at + '.localTransform', reason : bad.reason, message : bad.message },
                };
                return;
            }
        }
        if (Array.isArray(raw.children)) raw.children.forEach((child, i) => visit(child, at + '.children[' + i + ']', depth + 1));
    }
    if (opts.single) visit(forest, '$', 1);
    else if (Array.isArray(forest)) forest.forEach((node, i) => visit(node, '$[' + i + ']', 1));
    return refusal;
}

/** Deep equality of two JSON values; the order of an object's keys does not matter. */
function sameJson(a, b)
{
    if (a === b) return true;
    if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a)) return a.length === b.length && a.every((v, i) => sameJson(v, b[i]));
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every(k => Object.prototype.hasOwnProperty.call(b, k) && sameJson(a[k], b[k]));
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
    // The graph's canonical address is an integer, as the API types it. The string `spatialId`
    // (the world id) stays as a deprecated alias in `acceptedIds`.
    const graphId = Number.isInteger(opts.graphId) ? opts.graphId : 1;
    const acceptedIds = [ String(graphId) ].concat(opts.acceptedIds || [ spatialId ])
        .map(id => String(id))
        .filter((id, i, all) => id && all.indexOf(id) === i);
    const seedBuilder = typeof opts.seedBuilder === 'function' ? opts.seedBuilder : () => ({ root: rootNode(), nodes: [] });
    const persist = opts.persist != null ? !!opts.persist : isEnvOn('OSL_WOW_SPATIAL_PERSIST');
    const persistDir = String(opts.persistDir
        || process.env.OSL_WOW_SPATIAL_DIR
        || path.join(__dirname, '..', '..', '..', '.runtime', 'spatial-store'));
    const fileStem = spatialId.replace(/[^A-Za-z0-9._-]/g, '_');
    const persistFile = path.join(persistDir, fileStem + '.json');
    // Node ids are unique within a world and never reused. The highest id ever issued is kept in
    // its own small file, written whether or not the whole store is persisted, so a deleted id, a
    // reset or a restart can never hand the same id to a different node.
    const idFile = path.join(persistDir, fileStem + '.ids.json');

    // id -> Node (canonical shape). rootId is always ROOT_ID.
    let nodes = new Map();
    let nextId = ROOT_ID + 1;
    let highWater = loadHighWater();

    function loadHighWater()
    {
        try {
            const doc = JSON.parse(fs.readFileSync(idFile, 'utf8'));
            return doc && Number.isInteger(doc.high_water) && doc.high_water >= ROOT_ID ? doc.high_water : ROOT_ID;
        } catch (e) {
            return ROOT_ID;
        }
    }

    function saveHighWater()
    {
        try {
            if (!fs.existsSync(persistDir)) fs.mkdirSync(persistDir, { recursive: true });
            const tmp = idFile + '.' + process.pid + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify({ osl_spatial_ids: true, spatial_id: spatialId, high_water: highWater }) + '\n', 'utf8');
            fs.renameSync(tmp, idFile);
        } catch (e) {
            // Best effort: ids stay unique within this process even if the file cannot be written.
            console.warn('[spatial-graph] id high-water save failed (' + spatialId + '): ' + e.message);
        }
    }

    /** The next node id: above every id this world has ever issued. */
    function issueId()
    {
        const id = Math.max(nextId, highWater + 1);
        nextId = id + 1;
        highWater = id;
        saveHighWater();
        return id;
    }

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
        let seedId = ROOT_ID;
        const children = Array.isArray(seed.nodes) ? seed.nodes : [];
        for (const raw of children)
        {
            const id = ++seedId;
            const node = normalizeNode(raw, id);
            node.id = id;
            node.parent = ROOT_ID;
            node.children = Array.isArray(node.children) ? node.children : [];
            nodes.set(id, node);
            root.children.push(id);
        }
        // The authored seed owns ids 1..n whenever it is built, so a reset restores it under the same
        // ids. Nodes that clients created are gone after a reset, and their ids are never issued again.
        if (seedId > highWater) { highWater = seedId; saveHighWater(); }
        nextId = highWater + 1;
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
            nextId = Math.max(Number.isInteger(doc.next_id) ? doc.next_id : computeNextId(), highWater + 1);
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

    /**
     * A node as the canonical `Node`: its children are the child nodes themselves, to the leaves.
     * The tree is bounded by MAX_NODE_TREE_DEPTH on every write, so this recursion is bounded too.
     */
    function canonicalOf(id, depth)
    {
        const node = nodes.get(id);
        if (!node) return null;
        const out = clone(node);
        out.children = depth > MAX_NODE_TREE_DEPTH * 2 ? []
            : (node.children || []).map(child => canonicalOf(child, depth + 1)).filter(Boolean);
        return out;
    }

    /** opts.form is 'flat' for the OSLFlatNode (children are ids); anything else is the canonical Node. */
    function getRoot(opts)
    {
        return getNode(ROOT_ID, opts);
    }

    function getNode(nodeId, opts)
    {
        const id = Number(nodeId);
        if (!Number.isInteger(id)) return null;
        const node = nodes.get(id);
        if (!node) return null;
        return opts && opts.form === 'flat' ? clone(node) : canonicalOf(id, 0);
    }

    /** The number of nodes on the path from the root to `id`, counting both. */
    function depthOf(id)
    {
        let depth = 0;
        for (let cursor = id; cursor != null && depth <= nodes.size; depth += 1)
        {
            const node = nodes.get(cursor);
            cursor = node ? node.parent : null;
        }
        return depth;
    }

    /** The height of the subtree at `id`: 1 for a leaf. */
    function heightOf(id)
    {
        const node = nodes.get(id);
        if (!node) return 0;
        let tallest = 0;
        for (const child of node.children || []) tallest = Math.max(tallest, heightOf(child));
        return tallest + 1;
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
        const badTransform = inspectIncomingTransforms(incoming);
        if (badTransform) return badTransform;
        // The graph must stay shallow enough to render and to return in full.
        const addedHeight = (function height(nodesIn)
        {
            let tallest = 0;
            for (const raw of nodesIn) tallest = Math.max(tallest, 1 + height(classifyChildren(raw && raw.children).embedded));
            return tallest;
        })(incoming);
        if (depthOf(pid) + addedHeight > MAX_NODE_TREE_DEPTH)
            return { ok : false, status : 422, error : 'node_tree_too_deep',
                detail : { message : 'the graph would be deeper than ' + MAX_NODE_TREE_DEPTH + ' levels.' } };

        const created = [];
        const topLevel = [];
        let flattened = 0;
        let maxDepth = 0;

        // BFS-free recursive attach: parents are created before their children, so
        // `created` is in a topological order the caller can replay.
        (function attach(rawNodes, attachTo, depth)
        {
            if (depth > maxDepth) maxDepth = depth;
            for (const raw of rawNodes)
            {
                const id = issueId();
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
                if (attachTo === pid) topLevel.push(id);

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
            top_level : topLevel,        // ids of the nodes the caller sent, in order
            flattened : flattened,       // embedded children we flattened (0 on the flat path)
            depth : maxDepth,
            requested : incoming.length, // top-level nodes the caller sent
            stored : value.length,       // nodes we actually created (>= requested when flattened)
        };
    }

    /**
     * Where a node would move on a PUT of `parent`. Nothing is changed here; the answer is either a
     * refusal or the new parent (null when the parent is unchanged).
     */
    function planMove(id, node, requested)
    {
        if (id === ROOT_ID && (requested === null || requested === undefined)) return { ok : true, to : null };
        if (!Number.isInteger(requested))
            return { ok : false, status : 422, error : 'invalid_parent',
                detail : { message : 'parent must be the integer id of a node in this graph', requested_parent : requested } };
        if (id === ROOT_ID)
            return { ok : false, status : 422, error : 'cannot_move_root',
                detail : { message : 'the root has no parent and cannot be moved' } };
        if (requested === node.parent) return { ok : true, to : null };
        if (!nodes.has(requested))
            return { ok : false, status : 422, error : 'parent_not_found',
                detail : { message : 'no node ' + requested + ' in this graph', requested_parent : requested } };
        // The new parent must not be the node itself or anything below it.
        let cursor = requested;
        for (let steps = 0; cursor != null && steps <= nodes.size; steps += 1)
        {
            if (cursor === id)
                return { ok : false, status : 422, error : 'parent_would_create_cycle',
                    detail : { message : 'node ' + id + ' cannot move under itself or its own descendant', requested_parent : requested } };
            const above = nodes.get(cursor);
            cursor = above ? above.parent : null;
        }
        return { ok : true, to : requested };
    }

    /** PUT — update an existing node: its content, and its place in the tree by `parent`. opts.form: 'flat' or canonical. */
    function updateNode(nodeId, incoming, opts)
    {
        const flat = !!(opts && opts.form === 'flat');
        const id = Number(nodeId);
        if (!Number.isInteger(id)) return { ok: false, status: 400, error: 'invalid_node_id' };
        const existing = nodes.get(id);
        if (!existing) return { ok: false, status: 404, error: 'node_not_found' };
        const r = incoming && typeof incoming === 'object' ? incoming : {};

        // `children` is derived from the tree. A PUT may repeat it, which is what a client that reads a
        // node and writes it back does, and it may leave it out. A PUT whose children differ from the
        // stored ones is refused, never ignored: a client that believes it restructured the tree must
        // be told it did not.
        if (!flat && Array.isArray(r.children))
        {
            const stored = canonicalOf(id, 0).children;
            if (!sameJson(r.children, stored))
                return {
                    ok : false, status : 422, error : 'child_restructure_not_supported',
                    detail : {
                        message : 'children are derived from the tree and a PUT never changes them. The `children` you sent '
                            + 'differ from the ones stored, so they were REFUSED rather than ignored.',
                        current_children : stored.map(child => child.id),
                        remedies : [
                            'POST /wow/spatial/{spatialID}/node/' + id + ' to add a child.',
                            'DELETE /wow/spatial/{spatialID}/node/{childId} to remove one.',
                            'PUT the child with `parent` set to move it.',
                            'Omit `children` (or repeat them unchanged) to edit content only.',
                        ],
                    },
                };
        }
        else if (flat)
        {
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
                                message : 'This PUT body carries the canonical `Node` shape (children = embedded Node objects), '
                                    + 'but its node form is `flat` (the labeled `OSLFlatNode`, children are ids), and a PUT never '
                                    + 'restructures a node. Your embedded children were REFUSED, NOT stored, and NOT silently dropped.',
                                served_schema : 'OSLFlatNode',
                                canonical_schema : 'Node',
                                current_children : current.slice(),
                                remedies : [
                                    'Drop `X-OSL-WoW-Node-Form: flat`: the default form is the canonical Node, and a PUT may repeat '
                                        + 'its children unchanged.',
                                    'POST /wow/spatial/{spatialID}/node/' + id + ' to CREATE children under this node.',
                                    'DELETE /wow/spatial/{spatialID}/node/{childId} to remove one.',
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

        }

        // Everything that can be refused is refused before anything changes.
        const badTransform = inspectIncomingTransforms(r, { single : true });
        if (badTransform) return badTransform;
        const move = 'parent' in r ? planMove(id, existing, r.parent) : { ok : true, to : null };
        if (!move.ok) return move;
        if (move.to !== null && depthOf(move.to) + heightOf(id) > MAX_NODE_TREE_DEPTH)
            return { ok : false, status : 422, error : 'node_tree_too_deep',
                detail : { message : 'the graph would be deeper than ' + MAX_NODE_TREE_DEPTH + ' levels.' } };

        // Content fields are updatable. `children` is derived from the tree and is never written by a
        // PUT; a node changes place only through `parent`.
        if ('label' in r) existing.label = r.label == null ? undefined : String(r.label);
        if ('names' in r) existing.names = Array.isArray(r.names) ? r.names.map(n => String(n)) : existing.names;
        if ('localTransform' in r && Array.isArray(r.localTransform))
            existing.localTransform = r.localTransform.map(n => Number(n) || 0);
        if ('spatialAssetURI' in r) existing.spatialAssetURI = r.spatialAssetURI == null ? undefined : String(r.spatialAssetURI);
        if ('appearanceURI' in r) existing.appearanceURI = r.appearanceURI == null ? undefined : String(r.appearanceURI);
        if (move.to !== null)
        {
            const oldParent = nodes.get(existing.parent);
            if (oldParent && Array.isArray(oldParent.children))
                oldParent.children = oldParent.children.filter(c => c !== id);
            const newParent = nodes.get(move.to);
            newParent.children = (newParent.children || []).concat(id);
            existing.parent = move.to;
        }
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
        graphId,
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
    inspectIncomingTransforms,
    CANONICAL_CHILD_FORM,
};
