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
 *      localTransform/spatialAssetURI) — not stubs.
 *   C. >=2 worlds addressable (demo-room-a on :18981, demo-room-b on :18982),
 *      each with its own graph; a server 404s a spatialID it does not host.
 *   D. node CRUD round-trips at /wow/spatial/{id}/node/{nodeId}: create / read /
 *      update / delete (+ subtree), structure integrity, error codes.
 *   E. the ADDITIVE env-gated validation (OSL_WOW_VALIDATE=1): pass headers on
 *      good payloads, 422 on bad request bodies; responses validate via wow-spec.
 *   F. env-gated JSON PERSISTENCE (OSL_WOW_SPATIAL_PERSIST=1): a mutation written
 *      by one server instance is re-read from disk by a fresh instance.
 *   G. — NO SILENT CHILD-NODE DATA LOSS. A SPEC-CONFORMANT body
 *      (canonical `Node`, children EMBEDDED) used to be answered 200 OK with its whole
 *      subtree DELETED. G drives a server built with OSL_WOW_VALIDATE **OFF** (the
 *      DEFAULT deployment, and the path where the silent drop lived) and proves the
 *      caller can always tell what happened: 422 by default (naming `OSLFlatNode`,
 *      with machine-readable remedies), or — on the EXPLICIT `X-OSL-WoW-Node-Form:
 *      canonical` opt-in — a faithful flatten that stores the whole subtree and
 *      reports exactly what it stored. Also covers the two OTHER silent drops found:
 *      integer id-refs on POST, and `children` on PUT. Flat-form clients: unaffected.
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
        const rootR = await GET(PORT_A, '/wow/spatial/demo-room-a');
        check('B1 GET /wow/spatial/demo-room-a -> 200', rootR.status === 200, 'status=' + rootR.status);
        const root = rootR.json || {};
        check('B2 root is a canonical Node (id 0, names carries world_id, 16-float localTransform)',
            root.id === 0 && Array.isArray(root.names) && root.names.indexOf('demo-room-a') !== -1
            && Array.isArray(root.localTransform) && root.localTransform.length === 16);
        // node count must equal the world's real scene objects + portals
        const sceneObjs = (await GET(PORT_A, '/demo/scene-objects')).json.objects.length;
        const portalCount = (await GET(PORT_A, '/wow/world')).json.portals.portal_count;
        check('B3 root populated from real scene data (children == primitives + portals)',
            Array.isArray(root.children) && root.children.length === sceneObjs + portalCount,
            'children=' + (root.children || []).length + ' expected=' + (sceneObjs + portalCount));
        // corrected these two: the served node shape is the
        // LABELED, non-canonical `OSLFlatNode` (children = integer id refs). The
        // canonical `Node` embeds child OBJECTS and OSL does NOT serve it. These
        // checks assert BOTH halves honestly — the served shape validates, and the
        // canonical shape provably does NOT (that is the DECLARED divergence D1).
        check('B4 root validates against the served OSLFlatNode schema (the labeled divergence)',
            v.validate('OSLFlatNode', root).valid, v.validate('OSLFlatNode', root).errorsText);
        check('B4b root does NOT validate against canonical Node (D1 divergence is REAL, not a green label)',
            v.validate('Node', root).valid === false,
            'canonical Node errors: ' + v.validate('Node', root).errorsText);
        check('B5 GET root sets X-OSL-WoW-Validation: pass:OSLFlatNode',
            rootR.headers['x-osl-wow-validation'] === 'pass:OSLFlatNode',
            'header=' + rootR.headers['x-osl-wow-validation']);
        // a primitive seed node + a portal seed node, addressed by id.
        // Seed order is primitives then portals, so the FIRST portal node sits at
        // children[sceneObjs] (the A<->B portal — portals[0] by config order).
        // P1 appended location-a's hosted lobby-return portal,
        // so the LAST child is now the lobby edge, asserted separately as B7b.
        const primNode = (await GET(PORT_A, '/wow/spatial/demo-room-a/node/' + root.children[0])).json;
        const portalNode = (await GET(PORT_A, '/wow/spatial/demo-room-a/node/' + root.children[sceneObjs])).json;
        const lastNode = (await GET(PORT_A, '/wow/spatial/demo-room-a/node/' + root.children[root.children.length - 1])).json;
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
        const rb = await GET(PORT_B, '/wow/spatial/demo-room-b');
        check('C1 second world demo-room-b addressable on :' + PORT_B, rb.status === 200 && rb.json.id === 0);
        check('C2 addressable by location_id alias (location-a)',
            (await GET(PORT_A, '/wow/spatial/location-a')).status === 200);
        check('C3 server A 404s a world it does not host (demo-room-b)',
            (await GET(PORT_A, '/wow/spatial/demo-room-b')).status === 404);
        check('C4 unknown spatialID 404s', (await GET(PORT_A, '/wow/spatial/nope')).status === 404);

        // ---- D + E: CRUD round-trip + validation ----
        const createGood = await POST(PORT_A, '/wow/spatial/demo-room-a/node/0',
            [ { label: 'validation-node', names: [ 'runtime' ],
                localTransform: [ 1,0,0,0, 0,1,0,0, 0,0,1,0, 4,5,6,1 ],
                spatialAssetURI: 'osl-primitive:box?size_m=0.5' } ]);
        check('D1 POST create child -> 200 Node[]',
            createGood.status === 200 && Array.isArray(createGood.json) && createGood.json.length === 1,
            'status=' + createGood.status);
        check('E1 POST create sets pass:OSLFlatNode[] header (the shape we actually accept — runtime)',
            createGood.headers['x-osl-wow-validation'] === 'pass:OSLFlatNode[]',
            'header=' + createGood.headers['x-osl-wow-validation']);
        const newId = createGood.json[0].id;
        check('D2 new node has server-assigned integer id, parent 0',
            Number.isInteger(newId) && newId > 0 && createGood.json[0].parent === 0, 'id=' + newId);
        const rootAfter = (await GET(PORT_A, '/wow/spatial/demo-room-a')).json;
        check('D3 mutation persists across requests (root.children has new id)',
            rootAfter.children.indexOf(newId) !== -1);
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
            && (await GET(PORT_A, '/wow/spatial/demo-room-a')).json.children.indexOf(newId) === -1);

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

        // request validation rejects bad bodies (422) when OSL_WOW_VALIDATE=1
        const badCreate = await POST(PORT_A, '/wow/spatial/demo-room-a/node/0',
            [ { id: 'not-an-int', label: 5 } ]);
        check('E2 POST bad Node[] -> 422 (surfaced, not silently fixed)',
            badCreate.status === 422, 'status=' + badCreate.status);
        const badPut = await PUT(PORT_A, '/wow/spatial/demo-room-a/node/' + root.children[0],
            { localTransform: 'not-an-array' });
        check('E3 PUT bad Node -> 422', badPut.status === 422, 'status=' + badPut.status);

        // ---- G: — NO SILENT CHILD-NODE DATA LOSS ----
        //
        // THE DEFECT: the canonical WoW `Node` (the STANDARD) types `children` as
        // EMBEDDED Node objects. This server stores the DECLARED divergence
        // `OSLFlatNode` (integer id refs). It used to answer a spec-conformant POST
        // with **200 OK and the whole subtree deleted** — the client believed it had
        // stored a tree; we had stored a root.
        //
        // THE BAR: a conformant client must never be able to believe we stored
        // something we did not. This section drives the DEFAULT path — a server built
        // with **OSL_WOW_VALIDATE OFF** — because that is the path where the silent
        // drop lived.
        const savedValidate = process.env.OSL_WOW_VALIDATE;
        process.env.OSL_WOW_VALIDATE = '';           // <- the DEFAULT deployment
        const PORT_OFF = PORT_A + 200;
        const off = createServer('a', { http_port: PORT_OFF });
        await new Promise(r => off.server.listen(PORT_OFF, HOST, r));
        process.env.OSL_WOW_VALIDATE = savedValidate; // restore for the rest of the run

        // The body a SPEC-CONFORMANT client sends: canonical `Node`, children EMBEDDED.
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
        check('G0 the runtime body IS the standard (validates against canonical wow-spec Node[])',
            v.validateRequest('Node[]', canonicalBody()).valid,
            v.validateRequest('Node[]', canonicalBody()).errorsText);

        const rootBefore = (await GET(PORT_OFF, '/wow/spatial/demo-room-a')).json;
        const conformantPost = await POST(PORT_OFF, '/wow/spatial/demo-room-a/node/0', canonicalBody());

        // ---- G1-G3: DEFAULT path (validation OFF) REFUSES, loudly ----
        check('G1 VALIDATION-OFF: conformant embedded-children POST is NOT silently accepted (no 200)',
            conformantPost.status !== 200,
            'status=' + conformantPost.status);
        check('G2 VALIDATION-OFF: it is a 422 naming the divergence + the served schema',
            conformantPost.status === 422
            && conformantPost.json && conformantPost.json.error === 'embedded_children_not_supported'
            && conformantPost.json.served_schema === 'OSLFlatNode'
            && conformantPost.json.canonical_schema === 'Node',
            'status=' + conformantPost.status + ' error=' + (conformantPost.json || {}).error);
        check('G3 the refusal is MACHINE-READABLE (offending path + remedies incl. the opt-in)',
            !!conformantPost.json && Array.isArray(conformantPost.json.offending_paths)
            && conformantPost.json.offending_paths.length > 0
            && Array.isArray(conformantPost.json.remedies)
            && conformantPost.json.remedies.some(s => /nodeForm=canonical|X-OSL-WoW-Node-Form/.test(s)),
            JSON.stringify((conformantPost.json || {}).offending_paths));
        const rootAfterRefusal = (await GET(PORT_OFF, '/wow/spatial/demo-room-a')).json;
        check('G4 the refusal stored NOTHING (clean reject — no partial write, no orphans)',
            rootAfterRefusal.children.length === rootBefore.children.length,
            'before=' + rootBefore.children.length + ' after=' + rootAfterRefusal.children.length);

        // ---- G5-G8: the EXPLICIT opt-in flattens FAITHFULLY and says so ----
        // The caller ASKS for the flattening, so the transform can never surprise it.
        const optIn = await httpReq('POST', PORT_OFF, '/wow/spatial/demo-room-a/node/0', canonicalBody(),
            { 'X-OSL-WoW-Node-Form': 'canonical' });
        check('G5 opt-in (X-OSL-WoW-Node-Form: canonical) -> 200 and stores the WHOLE subtree',
            optIn.status === 200 && Array.isArray(optIn.json) && optIn.json.length === 4,
            'status=' + optIn.status + ' stored=' + (Array.isArray(optIn.json) ? optIn.json.length : '?')
            + ' (expected 4: root + 2 children + 1 grandchild)');
        check('G6 the response TELLS the caller what happened (headers: form + stored/requested + flattened)',
            optIn.headers['x-osl-wow-node-form'] === 'flattened-from-canonical'
            && optIn.headers['x-osl-wow-nodes-stored'] === '4/1'
            && optIn.headers['x-osl-wow-children-flattened'] === '3',
            'form=' + optIn.headers['x-osl-wow-node-form']
            + ' stored=' + optIn.headers['x-osl-wow-nodes-stored']
            + ' flattened=' + optIn.headers['x-osl-wow-children-flattened']);
        // every returned node is a real, addressable, correctly-parented OSLFlatNode
        const byLabel = {};
        for (const n of (optIn.json || [])) byLabel[n.label] = n;
        const cr = byLabel['conformant-root'], c1 = byLabel['embedded-child-1'],
              c2 = byLabel['embedded-child-2'], gc = byLabel['embedded-grandchild'];
        check('G7 the flattened tree PRESERVES the caller\'s structure (parent links at every depth)',
            !!cr && !!c1 && !!c2 && !!gc
            && cr.parent === 0 && c1.parent === cr.id && c2.parent === cr.id && gc.parent === c1.id
            && cr.children.indexOf(c1.id) !== -1 && cr.children.indexOf(c2.id) !== -1
            && c1.children.indexOf(gc.id) !== -1,
            cr && c1 && gc ? 'root=' + cr.id + ' child1=' + c1.id + ' grandchild=' + gc.id : 'MISSING NODES');
        const gcLive = await GET(PORT_OFF, '/wow/spatial/demo-room-a/node/' + (gc || {}).id);
        check('G8 the depth-3 grandchild is REALLY stored (GET returns it, with its transform)',
            gcLive.status === 200 && gcLive.json.label === 'embedded-grandchild'
            && gcLive.json.localTransform[13] === 2,
            'status=' + gcLive.status);
        // The contract (schema.yaml) PROMISES parents-first so the caller can replay the
        // array top-down. Pin it: every node's `parent` must already have appeared.
        const seen = new Set([ 0 ]);
        const preOrder = (optIn.json || []).every(n => {
            const ok = seen.has(n.parent);
            seen.add(n.id);
            return ok;
        });
        check('G8b the returned array is PARENTS-FIRST, exactly as the contract promises',
            preOrder, 'order=' + (optIn.json || []).map(n => n.id + '<-' + n.parent).join(' '));

        // ---- G9-G11: the OTHER silent drops this change found (POST id-refs, PUT children) ----
        const idRefPost = await POST(PORT_OFF, '/wow/spatial/demo-room-a/node/0',
            [ { label: 'wants-existing-children', children: [ 1, 2 ] } ]);
        check('G9 POST with INTEGER id-ref children -> 400 (was ALSO silently dropped: `node.children = []`)',
            idRefPost.status === 400 && idRefPost.json.error === 'child_id_refs_not_supported_on_create',
            'status=' + idRefPost.status + ' error=' + (idRefPost.json || {}).error);
        const restructurePut = await PUT(PORT_OFF, '/wow/spatial/demo-room-a/node/' + cr.id,
            { label: 'renamed', children: [ 999 ] });
        check('G10 PUT that RESTRUCTURES children -> 422 (was silently IGNORED)',
            restructurePut.status === 422 && restructurePut.json.error === 'child_restructure_not_supported',
            'status=' + restructurePut.status + ' error=' + (restructurePut.json || {}).error);
        const embeddedPut = await PUT(PORT_OFF, '/wow/spatial/demo-room-a/node/' + cr.id,
            { label: 'renamed', children: [ { label: 'sneaky-embedded' } ] });
        check('G11 PUT with EMBEDDED children -> 422 naming OSLFlatNode (was silently IGNORED)',
            embeddedPut.status === 422 && embeddedPut.json.error === 'embedded_children_not_supported'
            && embeddedPut.json.served_schema === 'OSLFlatNode',
            'status=' + embeddedPut.status + ' error=' + (embeddedPut.json || {}).error);

        // ---- G12-G13: EXISTING FLAT-FORM CLIENTS ARE UNAFFECTED ----
        // (a) the read-modify-write echo: GET a node, change content, PUT it back
        //     WITH its children unchanged. This is the normal flat-client pattern and
        //     it MUST still work — the refusal is for RESTRUCTURING, not for echoing.
        const rmwGet = (await GET(PORT_OFF, '/wow/spatial/demo-room-a/node/' + cr.id)).json;
        rmwGet.label = 'rmw-renamed';
        const rmwPut = await PUT(PORT_OFF, '/wow/spatial/demo-room-a/node/' + cr.id, rmwGet);
        check('G12 flat client read-modify-write (children ECHOED unchanged) still 200s',
            rmwPut.status === 200 && rmwPut.json.label === 'rmw-renamed'
            && rmwPut.json.children.length === 2,
            'status=' + rmwPut.status);
        // (b) a plain leaf create — the overwhelmingly common flat path — byte-identical
        const leafCreate = await POST(PORT_OFF, '/wow/spatial/demo-room-a/node/0',
            [ { label: 'plain-leaf', children: [], spatialAssetURI: 'osl-primitive:box?size_m=1' } ]);
        check('G13 flat client leaf create (children: []) unchanged -> 200, 1 node, no flatten header',
            leafCreate.status === 200 && leafCreate.json.length === 1
            && leafCreate.json[0].children.length === 0
            && leafCreate.headers['x-osl-wow-node-form'] === 'osl-flat'
            && leafCreate.headers['x-osl-wow-children-flattened'] === undefined,
            'status=' + leafCreate.status + ' form=' + leafCreate.headers['x-osl-wow-node-form']);
        await off.closeAll();

        // ---- G14: the VALIDATION-ON path still behaves ----
        const onRefusal = await POST(PORT_A, '/wow/spatial/demo-room-a/node/0', canonicalBody());
        check('G14 VALIDATION-ON: conformant embedded POST still 422 (runtime path intact)',
            onRefusal.status === 422, 'status=' + onRefusal.status);
        const onOptIn = await httpReq('POST', PORT_A, '/wow/spatial/demo-room-a/node/0', canonicalBody(),
            { 'X-OSL-WoW-Node-Form': 'canonical' });
        check('G15 VALIDATION-ON: opt-in validates the body as canonical Node[] and stores all 4',
            onOptIn.status === 200 && Array.isArray(onOptIn.json) && onOptIn.json.length === 4
            && onOptIn.headers['x-osl-wow-validation'] === 'pass:OSLFlatNode[]',
            'status=' + onOptIn.status + ' hdr=' + onOptIn.headers['x-osl-wow-validation']);
        // the query-param form of the opt-in works too (curl-friendly)
        const qOptIn = await POST(PORT_A, '/wow/spatial/demo-room-a/node/0?nodeForm=canonical', canonicalBody());
        check('G16 ?nodeForm=canonical is an equivalent opt-in',
            qOptIn.status === 200 && Array.isArray(qOptIn.json) && qOptIn.json.length === 4,
            'status=' + qOptIn.status);

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
