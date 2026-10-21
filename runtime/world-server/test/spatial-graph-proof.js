'use strict';

/*
 * Spatial Composition Graph server proof.
 *
 * Runs the 041 backend on ISOLATED high ports (default 18981 / 18982 — NEVER the
 * live demo ports 8143 / 18151-18153) and proves the canonical Spatial
 * Composition Graph end to end:
 *   A. EXISTING endpoints preserved (regression guard: /wow/world|user|view|
 *      portal still 200 + proof_boundary; services[] now also advertises
 *      /wow/spatial).
 *   B. graph root is POPULATED FROM REAL SCENE DATA (hosted primitives + portals),
 *      emitted as canonical WoW `Node`s (id/label/names/children/16-float
 *      localTransform/spatialAssetURI) — not stubs. Children are embedded by default; the
 *      labeled OSLFlatNode (children are ids) is served on an explicit `flat` request.
 *   C. >=2 worlds addressable (demo-room-a on :18981, demo-room-b on :18982),
 *      each with its own graph; a server 404s a spatialID it does not host. The
 *      graph is addressed by its integer id; GET /wow/spatial/1 is the Spatial.
 *   D. node CRUD round-trips at /wow/spatial/{id}/node/{nodeId}: create / read /
 *      update / delete (+ subtree), structure integrity, error codes.
 *   E. request validation: pass headers on good payloads, 422 on bad request
 *      bodies; responses validate via wow-spec.
 *   F. env-gated JSON PERSISTENCE (OSL_WOW_SPATIAL_PERSIST=1): a mutation written
 *      by one server instance is re-read from disk by a fresh instance.
 *   G. NO SILENT CHILD-NODE DATA LOSS. A body in the canonical Node form (children
 *      embedded) used to be answered 200 OK with its whole subtree deleted. It is
 *      now the default form: the whole subtree is stored, every id is assigned, and
 *      the response says what was stored. The flat form refuses embedded children by
 *      name; a PUT never changes children (422 when they differ); integer id-refs on
 *      a create body are 400.
 *
 * Writes evidence to evidence/spatial-graph.json. Exits non-zero on any
 * failure. Honesty boundary preserved: standards_conformance stays false.
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const PORT_A = Number(process.env.OSL_SPATIAL_GRAPH_PORT_A || 18981);
const PORT_B = Number(process.env.OSL_SPATIAL_GRAPH_PORT_B || 18982);
const HOST = '127.0.0.1';

// Exercise the ACTUAL wired validation path (additive; body never altered).
process.env.OSL_WOW_VALIDATE = '1';

const { createValidator } = require(path.join(REPO_ROOT, 'wow-spec', 'validate'));
const { createServer } = require(path.join(__dirname, '..', 'src', 'server'));

const results = [];
let failures = 0;
function check(name, ok, detail)
{
    results.push({ name, ok: !!ok, detail: detail || null });
    if (!ok) failures++;
    process.stdout.write((ok ? '  PASS  ' : '  FAIL  ') + name
        + (detail ? '  -- ' + detail : '') + '\n');
}

function httpReq(method, port, p, body, extraHeaders)
{
    return new Promise((resolve, reject) => {
        const data = body != null ? JSON.stringify(body) : null;
        const headers = Object.assign({ Accept: 'application/json' }, extraHeaders || {});
        if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
        const req = http.request({ host: HOST, port, path: p, method, headers, agent: false }, (res) => {
            let out = '';
            res.on('data', c => { out += c; });
            res.on('end', () => {
                let json = null;
                try { json = out ? JSON.parse(out) : null; } catch (e) { /* leave null */ }
                resolve({ status: res.statusCode, headers: res.headers, json, body: out });
            });
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}
const GET = (port, p) => httpReq('GET', port, p);
const POST = (port, p, b) => httpReq('POST', port, p, b);
const PUT = (port, p, b) => httpReq('PUT', port, p, b);
const DEL = (port, p, b) => httpReq('DELETE', port, p, b);

async function main()
{
    const v = createValidator();
    const a = createServer('a', { http_port: PORT_A });
    const b = createServer('b', { http_port: PORT_B });
    await new Promise(r => a.server.listen(PORT_A, HOST, r));
    await new Promise(r => b.server.listen(PORT_B, HOST, r));

    let persistDir = null;
    try {
        // ---- A: existing endpoints preserved (regression guard) ----
        const world = await GET(PORT_A, '/wow/world');
        check('A1 GET /wow/world still 200', world.status === 200, 'status=' + world.status);
        const pb = world.json && world.json.proof_boundary;
        check('A2 proof_boundary intact (handoff true, conformance false)',
            !!pb && pb.application_level_handoff === true && pb.native_teleportxr_teleport === false
            && pb.first_party_teleportxr_browser_rendering === false && pb.standards_conformance === false,
            JSON.stringify(pb));
        for (const p of [ '/wow/portal/1', '/wow/user/1', '/wow/view/1' ])
        {
            const r = await GET(PORT_A, p);
            check('A3 GET ' + p + ' still 200', r.status === 200, 'status=' + r.status);
        }
        const fabric = await GET(PORT_A, '/fabric.json');
        const eps = (fabric.json.services || []).map(s => s.endpoint);
        check('A4 fabric services[] advertises /wow/spatial + node',
            eps.indexOf('/wow/spatial/{spatialID}') !== -1
            && eps.indexOf('/wow/spatial/{spatialID}/node/{nodeId}') !== -1,
            eps.join(','));
        check('A5 fabric services[] still advertises the four original WoW endpoints',
            [ '/wow/world', '/wow/user/{userId}', '/wow/portal/{portalId}', '/wow/view/{viewId}' ]
                .every(e => eps.indexOf(e) !== -1));

        // ---- B: graph populated from REAL scene data ----
        // The graph root is the canonical Node by default: its children are the child nodes themselves.
        const rootR = await GET(PORT_A, '/wow/spatial/demo-room-a?form=node');
        check('B1 GET /wow/spatial/demo-room-a?form=node -> 200', rootR.status === 200, 'status=' + rootR.status);
        const root = rootR.json || {};
        check('B2 root is a canonical Node (id 0, names carries world_id, 16-float localTransform)',
            root.id === 0 && Array.isArray(root.names) && root.names.indexOf('demo-room-a') !== -1
            && Array.isArray(root.localTransform) && root.localTransform.length === 16);
        // node count must equal the world's real scene objects + portals
        const sceneObjs = (await GET(PORT_A, '/demo/scene-objects')).json.objects.length;
        const portalCount = (await GET(PORT_A, '/wow/world')).json.portals.portal_count;
        check('B3 root populated from real scene data (children == primitives + portals)',
            Array.isArray(root.children) && root.children.length === sceneObjs + portalCount
            && root.children.every(c => c && typeof c === 'object' && Number.isInteger(c.id)),
            'children=' + (root.children || []).length + ' expected=' + (sceneObjs + portalCount));
        // The canonical Node embeds its children and is what is served by default. The labeled
        // OSLFlatNode (children = integer ids) is served only when a request says `flat`; it is NOT
        // canonical, and the two checks below assert both halves.
        const flatRoot = (await GET(PORT_A, '/wow/spatial/demo-room-a?form=node&nodeForm=flat')).json;
        check('B4 root validates against the canonical Node schema',
            v.validate('Node', root).valid, v.validate('Node', root).errorsText);
        check('B4b the flat form validates against OSLFlatNode and NOT against canonical Node (the labeled form is real)',
            v.validate('OSLFlatNode', flatRoot).valid && v.validate('Node', flatRoot).valid === false,
            'canonical Node errors on the flat root: ' + v.validate('Node', flatRoot).errorsText);
        check('B5 GET root sets X-OSL-WoW-Validation: pass:Node',
            rootR.headers['x-osl-wow-validation'] === 'pass:Node',
            'header=' + rootR.headers['x-osl-wow-validation']);
        // a primitive seed node + a portal seed node, addressed by id.
        // Seed order is primitives then portals, so the FIRST portal node sits at
        // children[sceneObjs] (the A<->B portal — portals[0] by config order).
        // P1 appended location-a's hosted lobby-return portal,
        // so the LAST child is now the lobby edge, asserted separately as B7b.
        const primNode = (await GET(PORT_A, '/wow/spatial/demo-room-a/node/' + root.children[0].id)).json;
        const portalNode = (await GET(PORT_A, '/wow/spatial/demo-room-a/node/' + root.children[sceneObjs].id)).json;
        const lastNode = (await GET(PORT_A, '/wow/spatial/demo-room-a/node/' + root.children[root.children.length - 1].id)).json;
        check('B6 primitive seed node carries labeled osl-primitive: URI (NOT glTF)',
            /^osl-primitive:/.test(primNode.spatialAssetURI || ''), primNode.spatialAssetURI);
        check('B7 portal seed node carries labeled osl-portal: destination URI',
            /^osl-portal:/.test(portalNode.spatialAssetURI || '')
            && /target_world_id=demo-room-b/.test(portalNode.spatialAssetURI || ''),
            portalNode.spatialAssetURI);
        check('B7b appended lobby-return portal seed node targets demo-lobby (runtime P1 shared edge)',
            /^osl-portal:/.test(lastNode.spatialAssetURI || '')
            && /target_world_id=demo-lobby/.test(lastNode.spatialAssetURI || ''),
            lastNode.spatialAssetURI);

        // ---- C: >=2 worlds addressable, per-world isolation ----
        const rb = await GET(PORT_B, '/wow/spatial/demo-room-b?form=node');
        check('C1 second world demo-room-b addressable on :' + PORT_B, rb.status === 200 && rb.json.id === 0);
        check('C2 addressable by location_id alias (location-a)',
            (await GET(PORT_A, '/wow/spatial/location-a')).status === 200);
        check('C3 server A 404s a world it does not host (demo-room-b)',
            (await GET(PORT_A, '/wow/spatial/demo-room-b')).status === 404);
        check('C4 unknown spatialID 404s', (await GET(PORT_A, '/wow/spatial/nope')).status === 404);
        const spatial = await GET(PORT_A, '/wow/spatial/1');
        check('C5 GET /wow/spatial/1 is the Spatial: an integer id, the root node id and a GeoPose anchor',
            spatial.status === 200 && spatial.json.id === 1 && spatial.json.rootNodeID === 0
            && spatial.headers['x-osl-wow-validation'] === 'pass:Spatial'
            && spatial.headers['x-osl-wow-spatial-form'] === 'descriptor'
            && v.validate('Spatial', spatial.json).valid,
            'status=' + spatial.status + ' hdr=' + spatial.headers['x-osl-wow-validation']);

        // ---- D + E: CRUD round-trip + validation ----
        const createGood = await POST(PORT_A, '/wow/spatial/demo-room-a/node/0',
            [ { label: 'validation-node', names: [ 'runtime' ],
                localTransform: [ 1,0,0,0, 0,1,0,0, 0,0,1,0, 4,5,6,1 ],
                spatialAssetURI: 'osl-primitive:box?size_m=0.5' } ]);
        check('D1 POST create child -> 200 Node[]',
            createGood.status === 200 && Array.isArray(createGood.json) && createGood.json.length === 1,
            'status=' + createGood.status);
        check('E1 POST create sets pass:Node[] header (the canonical Node[] is the default form)',
            createGood.headers['x-osl-wow-validation'] === 'pass:Node[]',
            'header=' + createGood.headers['x-osl-wow-validation']);
        const newId = createGood.json[0].id;
        check('D2 new node has server-assigned integer id, parent 0',
            Number.isInteger(newId) && newId > 0 && createGood.json[0].parent === 0, 'id=' + newId);
        const rootAfter = (await GET(PORT_A, '/wow/spatial/demo-room-a?form=node')).json;
        check('D3 mutation persists across requests (root.children has new id)',
            rootAfter.children.some(c => c.id === newId));
        check('D4 GET new node -> 200 with its content',
            (await GET(PORT_A, '/wow/spatial/demo-room-a/node/' + newId)).json.label === 'validation-node');

        const upd = await PUT(PORT_A, '/wow/spatial/demo-room-a/node/' + newId,
            { label: 'validation-node-2', spatialAssetURI: 'osl-primitive:sphere?size_m=0.9' });
        const afterUpd = (await GET(PORT_A, '/wow/spatial/demo-room-a/node/' + newId)).json;
        check('D5 PUT update persists (label) + preserves structure (id/parent)',
            upd.status === 200 && afterUpd.label === 'validation-node-2'
            && afterUpd.id === newId && afterUpd.parent === 0);

        // nested child, then delete the subtree
        const grandchild = await POST(PORT_A, '/wow/spatial/demo-room-a/node/' + newId,
            [ { label: 'grandchild', localTransform: [ 1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1 ] } ]);
        const gcId = grandchild.json[0].id;
        const delR = await DEL(PORT_A, '/wow/spatial/demo-room-a/node/' + newId);
        check('D6 DELETE removes node + subtree',
            delR.status === 200 && delR.json.deleted.indexOf(newId) !== -1
            && delR.json.deleted.indexOf(gcId) !== -1, JSON.stringify(delR.json));
        check('D7 deleted node 404s + unlinked from root',
            (await GET(PORT_A, '/wow/spatial/demo-room-a/node/' + newId)).status === 404
            && !(await GET(PORT_A, '/wow/spatial/demo-room-a?form=node')).json.children.some(c => c.id === newId));

        // error codes
        check('D8 DELETE root rejected (400)',
            (await DEL(PORT_A, '/wow/spatial/demo-room-a/node/0')).status === 400);
        check('D9 non-integer node id -> 400',
            (await GET(PORT_A, '/wow/spatial/demo-room-a/node/xyz')).status === 400);
        check('D10 PUT unknown node -> 404',
            (await PUT(PORT_A, '/wow/spatial/demo-room-a/node/99999', { label: 'x' })).status === 404);
        check('D11 POST under unknown parent -> 404',
            (await POST(PORT_A, '/wow/spatial/demo-room-a/node/99999', [ { label: 'x' } ])).status === 404);
        check('D12 POST to graph-root resource (no /node) -> 405',
            (await POST(PORT_A, '/wow/spatial/demo-room-a', [ { label: 'x' } ])).status === 405);

        // request validation rejects bad bodies (422)
        const badCreate = await POST(PORT_A, '/wow/spatial/demo-room-a/node/0',
            [ { id: 'not-an-int', label: 5 } ]);
        check('E2 POST bad Node[] -> 422 (surfaced, not silently fixed)',
            badCreate.status === 422, 'status=' + badCreate.status);
        const badPut = await PUT(PORT_A, '/wow/spatial/demo-room-a/node/' + root.children[0].id,
            { localTransform: 'not-an-array' });
        check('E3 PUT bad Node -> 422', badPut.status === 422, 'status=' + badPut.status);

        // ---- G: NO SILENT CHILD-NODE DATA LOSS ----
        //
        // THE DEFECT this section guards: a spec-conformant body (the canonical `Node`, children
        // EMBEDDED) used to be answered 200 OK with its whole subtree deleted: the client believed it
        // had stored a tree; the server had stored a root. The canonical Node is now the default form,
        // so the whole subtree is stored and returned. The labeled flat form refuses embedded
        // children by name, and a PUT never changes a node's children.
        //
        // THE BAR: a client must never be able to believe the server stored something it did not.
        const canonicalBody = () => ([ {
            label: 'conformant-root',
            localTransform: [ 1,0,0,0, 0,1,0,0, 0,0,1,0, 1,2,3,1 ],
            children: [
                { label: 'embedded-child-1',
                  localTransform: [ 1,0,0,0, 0,1,0,0, 0,0,1,0, 0,1,0,1 ],
                  children: [ { label: 'embedded-grandchild',
                               localTransform: [ 1,0,0,0, 0,1,0,0, 0,0,1,0, 0,2,0,1 ] } ] },
                { label: 'embedded-child-2',
                  localTransform: [ 1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,1,1 ] },
            ],
        } ]);
        check('G0 the body IS the standard (validates against canonical wow-spec Node[])',
            v.validateRequest('Node[]', canonicalBody()).valid,
            v.validateRequest('Node[]', canonicalBody()).errorsText);

        const rootBefore = (await GET(PORT_A, '/wow/spatial/demo-room-a?form=node&nodeForm=flat')).json;
        const maxIdBefore = Math.max(...(await GET(PORT_A, '/wow/spatial/demo-room-a?form=node')).json.children.map(c => c.id));
        const conformantPost = await POST(PORT_A, '/wow/spatial/demo-room-a/node/0', canonicalBody());

        // ---- G1-G6: the canonical default stores the whole subtree and says so ----
        check('G1 a conformant embedded-children POST is stored: 200, one node sent, one node returned',
            conformantPost.status === 200 && Array.isArray(conformantPost.json) && conformantPost.json.length === 1,
            'status=' + conformantPost.status);
        const sent = (conformantPost.json || [])[0] || {};
        const idsOf = (n) => [ n.id ].concat((n.children || []).flatMap(idsOf));
        const allIds = idsOf(sent);
        check('G2 the response is the nodes sent with their subtrees, every id assigned at every depth',
            sent.label === 'conformant-root' && (sent.children || []).length === 2
            && (sent.children[0].children || []).length === 1
            && allIds.length === 4 && new Set(allIds).size === 4 && allIds.every(id => Number.isInteger(id) && id > maxIdBefore),
            'ids=' + allIds.join(','));
        check('G3 the response TELLS the caller what happened (headers: form + stored/sent)',
            conformantPost.headers['x-osl-wow-node-form'] === 'canonical'
            && conformantPost.headers['x-osl-wow-nodes-stored'] === '4/1'
            && conformantPost.headers['x-osl-wow-validation'] === 'pass:Node[]',
            'form=' + conformantPost.headers['x-osl-wow-node-form'] + ' stored=' + conformantPost.headers['x-osl-wow-nodes-stored']
            + ' validation=' + conformantPost.headers['x-osl-wow-validation']);
        const c1 = sent.children[0], c2 = sent.children[1], gc = c1.children[0];
        check('G4 the stored tree PRESERVES the caller\'s structure (parent links at every depth)',
            sent.parent === 0 && c1.parent === sent.id && c2.parent === sent.id && gc.parent === c1.id,
            'root=' + sent.id + ' child1=' + c1.id + ' grandchild=' + gc.id);
        const gcLive = await GET(PORT_A, '/wow/spatial/demo-room-a/node/' + gc.id);
        check('G5 the depth-3 grandchild is REALLY stored (GET returns it, with its transform)',
            gcLive.status === 200 && gcLive.json.label === 'embedded-grandchild' && gcLive.json.localTransform[13] === 2,
            'status=' + gcLive.status);
        const subtree = (await GET(PORT_A, '/wow/spatial/demo-room-a/node/' + sent.id)).json;
        check('G6 reading the node returns the same subtree the POST returned',
            JSON.stringify(subtree) === JSON.stringify(sent));

        // ---- G7-G8: the flat form is explicit, and refuses what it cannot store ----
        const flatEmbedded = await httpReq('POST', PORT_A, '/wow/spatial/demo-room-a/node/0', canonicalBody(),
            { 'X-OSL-WoW-Node-Form': 'flat' });
        check('G7 the flat form refuses an embedded body: 422 naming OSLFlatNode, with offending paths and remedies',
            flatEmbedded.status === 422 && flatEmbedded.json.error === 'embedded_children_not_supported'
            && flatEmbedded.json.served_schema === 'OSLFlatNode' && flatEmbedded.json.canonical_schema === 'Node'
            && Array.isArray(flatEmbedded.json.offending_paths) && flatEmbedded.json.offending_paths.length > 0
            && flatEmbedded.json.remedies.some(r => /X-OSL-WoW-Node-Form: flat/.test(r)),
            'status=' + flatEmbedded.status + ' error=' + (flatEmbedded.json || {}).error);
        const rootAfterRefusal = (await GET(PORT_A, '/wow/spatial/demo-room-a?form=node&nodeForm=flat')).json;
        check('G8 the refusal stored NOTHING (clean reject: no partial write, no orphans)',
            rootAfterRefusal.children.length === rootBefore.children.length + 1,
            'before=' + rootBefore.children.length + ' after=' + rootAfterRefusal.children.length + ' (one root stored by G1)');

        // ---- G9-G13: ids on a create body, and PUT never changing children ----
        const idRefPost = await POST(PORT_A, '/wow/spatial/demo-room-a/node/0',
            [ { label: 'wants-existing-children', children: [ 1, 2 ] } ]);
        check('G9 POST with INTEGER id-ref children -> 400 (they were once silently dropped)',
            idRefPost.status === 400 && idRefPost.json.error === 'child_id_refs_not_supported_on_create',
            'status=' + idRefPost.status + ' error=' + (idRefPost.json || {}).error);
        const restructurePut = await PUT(PORT_A, '/wow/spatial/demo-room-a/node/' + sent.id,
            { label: 'renamed', children: [ { id: 999, label: 'not-a-child' } ] });
        check('G10 a PUT whose children differ -> 422 child_restructure_not_supported (never silently ignored)',
            restructurePut.status === 422 && restructurePut.json.error === 'child_restructure_not_supported',
            'status=' + restructurePut.status + ' error=' + (restructurePut.json || {}).error);
        const stillThere = (await GET(PORT_A, '/wow/spatial/demo-room-a/node/' + sent.id)).json;
        check('G11 the refused PUT changed nothing (label and children intact)',
            stillThere.label === 'conformant-root' && JSON.stringify(stillThere.children) === JSON.stringify(sent.children));
        const rmwGet = (await GET(PORT_A, '/wow/spatial/demo-room-a/node/' + sent.id)).json;
        rmwGet.label = 'rmw-renamed';
        const rmwPut = await PUT(PORT_A, '/wow/spatial/demo-room-a/node/' + sent.id, rmwGet);
        check('G12 read-modify-write: GET the node, change a label, PUT it back with its children repeated -> 200',
            rmwPut.status === 200 && rmwPut.json.label === 'rmw-renamed' && rmwPut.json.children.length === 2
            && rmwPut.headers['x-osl-wow-validation'] === 'pass:Node',
            'status=' + rmwPut.status);

        // ---- G13-G15: the explicit flat form, for clients that read ids ----
        const flatLeaf = await httpReq('POST', PORT_A, '/wow/spatial/demo-room-a/node/0',
            [ { label: 'plain-leaf', children: [], spatialAssetURI: 'osl-primitive:box?size_m=1' } ],
            { 'X-OSL-WoW-Node-Form': 'flat' });
        check('G13 flat form leaf create: 200, one OSLFlatNode back, header says flat',
            flatLeaf.status === 200 && flatLeaf.json.length === 1 && flatLeaf.json[0].children.length === 0
            && flatLeaf.headers['x-osl-wow-node-form'] === 'flat'
            && flatLeaf.headers['x-osl-wow-validation'] === 'pass:OSLFlatNode[]',
            'status=' + flatLeaf.status + ' form=' + flatLeaf.headers['x-osl-wow-node-form']);
        const flatGet = await GET(PORT_A, '/wow/spatial/demo-room-a/node/' + sent.id + '?nodeForm=flat');
        check('G14 ?nodeForm=flat is the query form of the header: children are ids, validated as OSLFlatNode',
            flatGet.status === 200 && JSON.stringify(flatGet.json.children) === JSON.stringify([ c1.id, c2.id ])
            && flatGet.headers['x-osl-wow-validation'] === 'pass:OSLFlatNode',
            'status=' + flatGet.status);
        flatGet.json.label = 'flat-rmw';
        const flatRmw = await httpReq('PUT', PORT_A, '/wow/spatial/demo-room-a/node/' + sent.id, flatGet.json,
            { 'X-OSL-WoW-Node-Form': 'flat' });
        const flatRestructure = await httpReq('PUT', PORT_A, '/wow/spatial/demo-room-a/node/' + sent.id,
            { label: 'x', children: [ 999 ] }, { 'X-OSL-WoW-Node-Form': 'flat' });
        const flatEmbeddedPut = await httpReq('PUT', PORT_A, '/wow/spatial/demo-room-a/node/' + sent.id,
            { label: 'x', children: [ { label: 'sneaky-embedded' } ] }, { 'X-OSL-WoW-Node-Form': 'flat' });
        check('G15 flat PUT: a repeated children list is 200; changed ids are 422 child_restructure_not_supported; embedded is 422 naming OSLFlatNode',
            flatRmw.status === 200 && flatRmw.json.label === 'flat-rmw'
            && flatRestructure.status === 422 && flatRestructure.json.error === 'child_restructure_not_supported'
            && flatEmbeddedPut.status === 422 && flatEmbeddedPut.json.error === 'embedded_children_not_supported'
            && flatEmbeddedPut.json.served_schema === 'OSLFlatNode',
            'rmw=' + flatRmw.status + ' restructure=' + flatRestructure.status + ' embedded=' + flatEmbeddedPut.status);

        // ---- F: env-gated JSON persistence across a fresh server instance ----
        persistDir = fs.mkdtempSync(path.join(os.tmpdir(), 'osl-runtime-persist-'));
        process.env.OSL_WOW_SPATIAL_PERSIST = '1';
        process.env.OSL_WOW_SPATIAL_DIR = persistDir;
        const p1 = createServer('a', { http_port: PORT_A + 100 });
        await new Promise(r => p1.server.listen(PORT_A + 100, HOST, r));
        const persistCreate = await POST(PORT_A + 100, '/wow/spatial/demo-room-a/node/0',
            [ { label: 'persisted-node', spatialAssetURI: 'osl-primitive:box?size_m=1' } ]);
        const persistedId = persistCreate.json[0].id;
        await p1.closeAll();
        check('F1 persist file written to disk',
            fs.existsSync(path.join(persistDir, 'demo-room-a.json')));
        // fresh instance (no in-memory carryover) must re-read the mutation from disk
        const p2 = createServer('a', { http_port: PORT_A + 101 });
        await new Promise(r => p2.server.listen(PORT_A + 101, HOST, r));
        const survived = await GET(PORT_A + 101, '/wow/spatial/demo-room-a/node/' + persistedId);
        check('F2 fresh instance re-reads persisted node from disk',
            survived.status === 200 && survived.json.label === 'persisted-node',
            'status=' + survived.status);
        await p2.closeAll();
        delete process.env.OSL_WOW_SPATIAL_PERSIST;
        delete process.env.OSL_WOW_SPATIAL_DIR;

        // ---- evidence ----
        const diagnostics = {
            wo: 'runtime',
            title: 'WoW world + Spatial Composition Graph server',
            captured_at: new Date().toISOString(),
            isolated_ports: { a: PORT_A, b: PORT_B, persist: [ PORT_A + 100, PORT_A + 101 ] },
            live_ports_untouched: [ 8143, 18151, 18152, 18153 ],
            wow_validate_env: '1',
            worlds_addressable: [ 'demo-room-a', 'demo-room-b' ],
            standards_conformance: false,
            checks: results.length,
            failures,
            ok: failures === 0,
            results,
        };
        const evPath = path.join(REPO_ROOT, 'diagnostics', 'runtime-spatial-graph.json');
        fs.mkdirSync(path.dirname(evPath), { recursive: true });
        fs.writeFileSync(evPath, JSON.stringify(diagnostics, null, 2) + '\n', 'utf8');
        process.stdout.write('\n[runtime] diagnostics -> ' + evPath + '\n');
        process.stdout.write('[runtime] ' + (failures === 0 ? 'ALL ' + results.length + ' CHECKS PASS'
            : failures + ' of ' + results.length + ' CHECKS FAILED') + '\n');
    } finally {
        try { await a.closeAll(); } catch (e) {}
        try { await b.closeAll(); } catch (e) {}
        if (persistDir) { try { fs.rmSync(persistDir, { recursive: true, force: true }); } catch (e) {} }
    }
    process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => { console.error('validation crashed:', err); process.exit(2); });
