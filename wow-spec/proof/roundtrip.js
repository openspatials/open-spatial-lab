'use strict';

/*
 * WoW contract foundation proof.
 *
 * Demonstrates the typed+validated contract mechanism end to end:
 *   A. the REAL 041 runtime WoW projections validate against the wow-spec
 *      response composites (and against the PURE canonical schemas);
 *   B. a live HTTP GET /wow/{world,user,view,portal} round-trips through the
 *      ADDITIVE, env-gated ajv validation wired into the vanilla-Node server
 *      (OSL_WOW_VALIDATE=1 -> X-OSL-WoW-Validation: pass:<schema>), body valid;
 *   C. NEGATIVE — deliberately-bad response payloads are REJECTED;
 *   D. request-body validation — good Node / Node[] pass, bad are REJECTED;
 *   E. the canonical /wow/spatial composition-graph paths are present in the
 *      contract (contract-only: served route still 404s, honestly not-yet-impl).
 *
 * Runs the server on an ISOLATED high port (default 18971) — never the live
 * demo ports (8143 / 18151-18153). Writes evidence to
 * evidence/wow-contract-foundation.json. Exits non-zero on any failure.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.OSL_WOW_PROOF_PORT || 18971);
const HOST = '127.0.0.1';

// Exercise the ACTUAL wired server validation path.
process.env.OSL_WOW_VALIDATE = '1';

const { createValidator } = require(path.join(REPO_ROOT, 'wow-spec', 'validate'));
const { createServer } = require(
    path.join(REPO_ROOT, 'runtime', 'world-server', 'src', 'server'));

const results = [];
let failures = 0;
function check(name, ok, detail)
{
    results.push({ name, ok: !!ok, detail: detail || null });
    if (!ok) failures++;
    process.stdout.write((ok ? '  PASS  ' : '  FAIL  ') + name
        + (detail ? '  — ' + detail : '') + '\n');
}

function httpGetJson(p)
{
    return new Promise((resolve, reject) => {
        const req = http.get({ host: HOST, port: PORT, path: p,
            headers: { Accept: 'application/json' } }, (res) => {
            let body = '';
            res.on('data', c => { body += c; });
            res.on('end', () => {
                let json = null;
                try { json = JSON.parse(body); } catch (e) { /* leave null */ }
                resolve({ status: res.statusCode, headers: res.headers, json, body });
            });
        });
        req.on('error', reject);
    });
}

function sixteenIdentity()
{
    return [ 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1 ];
}

async function main()
{
    const v = createValidator();
    const built = createServer('a', { http_port: PORT });

    await new Promise((resolve) => built.server.listen(PORT, HOST, resolve));

    try {
        const rt = built.runtime;

        // ---- PART A: real runtime projections validate ----
        const world = rt.getWowWorld();
        const user = rt.getWowUser('1');
        const view = rt.getWowView('1');
        const portal = rt.getWowPortalResource('1');

        check('A1 getWowWorld -> OSLWorldResponse valid',
            v.validateResponse('world', world).valid, v.validateResponse('world', world).errorsText);
        check('A2 getWowUser -> OSLUserResponse valid',
            v.validateResponse('user', user).valid, v.validateResponse('user', user).errorsText);
        check('A3 getWowView -> OSLViewResponse valid',
            v.validateResponse('view', view).valid, v.validateResponse('view', view).errorsText);
        check('A4 getWowPortalResource -> OSLPortalResponse valid',
            v.validateResponse('portal', portal).valid, v.validateResponse('portal', portal).errorsText);
        // the real response also satisfies the PURE canonical World (extras ride legally)
        check('A5 getWowWorld also satisfies canonical World',
            v.validateCanonical('world', world).valid, v.validateCanonical('world', world).errorsText);

        // ---- PART B: live HTTP round-trip through the wired validation ----
        const rw = await httpGetJson('/wow/world');
        check('B1 GET /wow/world -> 200', rw.status === 200, 'status=' + rw.status);
        check('B2 GET /wow/world header X-OSL-WoW-Validation=pass:OSLWorldResponse',
            rw.headers['x-osl-wow-validation'] === 'pass:OSLWorldResponse',
            'header=' + rw.headers['x-osl-wow-validation']);
        check('B3 GET /wow/world body validates via contract',
            !!rw.json && v.validateResponse('world', rw.json).valid,
            rw.json ? v.validateResponse('world', rw.json).errorsText : 'no json');

        const ru = await httpGetJson('/wow/user/1');
        check('B4 GET /wow/user/1 pass',
            ru.status === 200 && ru.headers['x-osl-wow-validation'] === 'pass:OSLUserResponse'
            && v.validateResponse('user', ru.json).valid,
            'header=' + ru.headers['x-osl-wow-validation']);

        const rv = await httpGetJson('/wow/view/1');
        check('B5 GET /wow/view/1 pass',
            rv.status === 200 && rv.headers['x-osl-wow-validation'] === 'pass:OSLViewResponse'
            && v.validateResponse('view', rv.json).valid,
            'header=' + rv.headers['x-osl-wow-validation']);

        const rp = await httpGetJson('/wow/portal/1');
        check('B6 GET /wow/portal/1 pass',
            rp.status === 200 && rp.headers['x-osl-wow-validation'] === 'pass:OSLPortalResponse'
            && v.validateResponse('portal', rp.json).valid,
            'header=' + rp.headers['x-osl-wow-validation']);

        // ---- PART C: bad response payloads are REJECTED ----
        const badMissingPB = JSON.parse(JSON.stringify(world));
        delete badMissingPB.proof_boundary;
        check('C1 world missing proof_boundary is REJECTED',
            v.validateResponse('world', badMissingPB).valid === false,
            v.validateResponse('world', badMissingPB).errorsText);

        const badType = JSON.parse(JSON.stringify(world));
        badType.content.version = 'not-a-number';
        check('C2 world content.version wrong type is REJECTED',
            v.validateResponse('world', badType).valid === false,
            v.validateResponse('world', badType).errorsText);

        const badPB = JSON.parse(JSON.stringify(world));
        badPB.proof_boundary.standards_conformance = 'false'; // string, not boolean
        check('C3 proof_boundary.standards_conformance wrong type is REJECTED',
            v.validateResponse('world', badPB).valid === false,
            v.validateResponse('world', badPB).errorsText);

        // ---- PART D: node request-body validation ----
        // OSL serves and accepts the CANONICAL `Node`, which EMBEDS child Node objects
        // (open spec, API.yaml:484-487), by default. The LABELED, NON-CANONICAL
        // `OSLFlatNode` (children = INTEGER id refs) is served only on explicit request.
        // Both are asserted here, each against its OWN schema — never conflated.
        const goodFlatNode = { id: 1, label: 'root', parent: 0, children: [ 2 ],
            localTransform: sixteenIdentity(), spatialAssetURI: 'asset://duck.glb' };
        const badNode = { id: 'not-an-int', label: 5 };
        check('D1 good OSLFlatNode request body is ACCEPTED (OSL\'s flat form, served on request)',
            v.validateRequest('OSLFlatNode', goodFlatNode).valid,
            v.validateRequest('OSLFlatNode', goodFlatNode).errorsText);
        check('D2 bad node request body is REJECTED',
            v.validateRequest('OSLFlatNode', badNode).valid === false,
            v.validateRequest('OSLFlatNode', badNode).errorsText);
        check('D3 good OSLFlatNode[] (node-create body) is ACCEPTED',
            v.validateRequest('OSLFlatNode[]', [ goodFlatNode ]).valid,
            v.validateRequest('OSLFlatNode[]', [ goodFlatNode ]).errorsText);
        check('D4 bad OSLFlatNode[] is REJECTED',
            v.validateRequest('OSLFlatNode[]', [ badNode ]).valid === false,
            v.validateRequest('OSLFlatNode[]', [ badNode ]).errorsText);

        // ---- PART D2: the canonical Node is the STANDARD, not OSL's shape ----
        // These four pin the un-inversion: a genuinely spec-conformant node
        // MUST validate against canonical `Node`, and OSL's flat form must NOT.
        const canonicalNodeFixture = { id: 1, label: 'root', parent: 0,
            children: [ { id: 2, label: 'child-2', parent: 1, children: [] } ],
            localTransform: sixteenIdentity() };
        check('D5 CANONICAL Node (children = EMBEDDED objects) is ACCEPTED — the standard',
            v.validateCanonical('node', canonicalNodeFixture).valid,
            v.validateCanonical('node', canonicalNodeFixture).errorsText);
        check('D6 canonical Node REJECTS integer id-ref children (that is OSL\'s divergence, not the spec)',
            v.validateCanonical('node', goodFlatNode).valid === false);
        check('D7 OSLFlatNode REJECTS embedded child objects (the divergence is enforced both ways)',
            v.validateRequest('OSLFlatNode', canonicalNodeFixture).valid === false);
        check('D8 mixed id-ref + embedded children conform to NEITHER schema',
            v.validateCanonical('node', { id: 1, children: [ 2, { id: 3 } ] }).valid === false
            && v.validateRequest('OSLFlatNode', { id: 1, children: [ 2, { id: 3 } ] }).valid === false);

        // ---- PART E: /wow/spatial paths + schemas present in the contract ----
        const paths = v.doc.paths || {};
        check('E1 contract has /wow/spatial/{spatialID}',
            !!paths['/wow/spatial/{spatialID}']);
        check('E2 contract has /wow/spatial/{spatialID}/node/{nodeId}',
            !!paths['/wow/spatial/{spatialID}/node/{nodeId}']);
        check('E3 canonical Node schema present',
            v.schemaNames.indexOf('Node') !== -1);
        check('E5 canonical Spatial schema present (was OMITTED entirely before runtime)',
            v.schemaNames.indexOf('Spatial') !== -1);
        check('E6 LABELED OSLFlatNode schema present + annotated x-osl-extension',
            v.schemaNames.indexOf('OSLFlatNode') !== -1
            && v.doc.components.schemas.OSLFlatNode['x-osl-extension'] === true
            && typeof v.doc.components.schemas.OSLFlatNode['x-osl-divergence'] === 'string');
        check('E7 canonical Node.children is the spec\'s recursive $ref (NOT integer id refs)',
            v.doc.components.schemas.Node.properties.children.items.$ref
                === '#/components/schemas/Node',
            JSON.stringify(v.doc.components.schemas.Node.properties.children.items));
        // The /wow/spatial prefix IS served. `demo` is not a graph id of this world
        // (the graph id is the integer 1), so it honestly 404s.
        const rs = await httpGetJson('/wow/spatial/demo');
        check('E4 /wow/spatial/demo 404s — `demo` is not a graph id (prefix IS served)',
            rs.status === 404, 'status=' + rs.status);

        // ================================================================
        // PART F —: the LABELED `SpatialFabricSubtree`
        // extension. A WoW node that TRANSCLUDES a signed .msf fabric as a
        // SUBTREE. Nothing here earns a conformance flip: it is declared
        // divergence D8 and standards_conformance stays false.
        // ================================================================
        const sfs = v.doc.components.schemas.SpatialFabricSubtree;
        check('F1 SpatialFabricSubtree present, LABELED x-osl-extension, declares its divergence',
            !!sfs && sfs['x-osl-extension'] === true
            && typeof sfs['x-osl-divergence'] === 'string' && sfs['x-osl-divergence'].indexOf('D8') === 0);
        check('F2 it is STRICT and REQUIRES fabricURI + unitsPerMeter + upAxis + placement',
            !!sfs && sfs.additionalProperties === false
            && [ 'fabricURI', 'unitsPerMeter', 'upAxis', 'placement' ].every(k => sfs.required.indexOf(k) !== -1),
            'required=' + JSON.stringify(sfs && sfs.required));
        // The description must STATE the three load-bearing truths (task §9.1).
        const sfsDesc = String((sfs && sfs.description) || '')
            + String((sfs && sfs.properties && sfs.properties.unitsPerMeter.description) || '')
            + String((sfs && sfs.properties && sfs.properties.mediaType.description) || '')
            + String((sfs && sfs.properties && sfs.properties.placement.description) || '');
        check('F3 description states: unitsPerMeter has NO DEFAULT / msf+jws is UNREGISTERED / backdrop CANNOT depth-composite',
            /NO DEFAULT/i.test(sfsDesc) && /UNREGISTERED|NO SUCH MEDIA TYPE IS REGISTERED/i.test(sfsDesc)
            && /CANNOT DEPTH-COMPOSITE|no shared depth buffer/i.test(sfsDesc));

        const goodSubtree = { fabricURI: 'https://cdn.rp1.com/fabric/artemis.msf',
            mediaType: 'application/msf+jws', unitsPerMeter: 3.3423e-12, upAxis: 'z',
            placement: 'in-room', requireVerified: true, maxDepth: 4, epochTicks: 0 };
        const omit = (o, k) => { const c = JSON.parse(JSON.stringify(o)); delete c[k]; return c; };

        check('F4 a VALID subtree contract VALIDATES',
            v.validate('SpatialFabricSubtree', goodSubtree).valid,
            v.validate('SpatialFabricSubtree', goodSubtree).errorsText);
        check('F5 missing `unitsPerMeter` is REJECTED (auto would silently mean 1 AU = 1 METRE)',
            v.validate('SpatialFabricSubtree', omit(goodSubtree, 'unitsPerMeter')).valid === false,
            v.validate('SpatialFabricSubtree', omit(goodSubtree, 'unitsPerMeter')).errorsText);
        check('F6 missing `placement` is REJECTED (it selects the backend; the two make different claims)',
            v.validate('SpatialFabricSubtree', omit(goodSubtree, 'placement')).valid === false,
            v.validate('SpatialFabricSubtree', omit(goodSubtree, 'placement')).errorsText);
        check('F7 missing/undeclared `upAxis` is REJECTED (never a silent fallback to "z")',
            v.validate('SpatialFabricSubtree', omit(goodSubtree, 'upAxis')).valid === false
            && v.validate('SpatialFabricSubtree', Object.assign({}, goodSubtree, { upAxis: 'x' })).valid === false);
        check('F8 non-positive `unitsPerMeter` and an unknown `placement` are REJECTED',
            v.validate('SpatialFabricSubtree', Object.assign({}, goodSubtree, { unitsPerMeter: 0 })).valid === false
            && v.validate('SpatialFabricSubtree', Object.assign({}, goodSubtree, { placement: 'hologram' })).valid === false);
        check('F9 an UNKNOWN member is REJECTED (a dial the engine would silently ignore)',
            v.validate('SpatialFabricSubtree', Object.assign({}, goodSubtree, { unitsPermeter: 1 })).valid === false);

        // The fail-closed rule reaches THE WIRE, not just the client: the subtree
        // rides the labeled bag, so a served node carrying a BROKEN contract fails
        // OSLFlatNode validation (the 041 server validates node payloads by name).
        const fabricNodeWire = { id: 7, label: 'artemis', parent: 1, children: [],
            localTransform: sixteenIdentity(), spatialAssetURI: 'https://cdn.rp1.com/fabric/artemis.msf',
            webofworlds_extension: { schema: 'osl.webofworlds.v0', spatial_fabric_subtree: goodSubtree } };
        const brokenNodeWire = JSON.parse(JSON.stringify(fabricNodeWire));
        delete brokenNodeWire.webofworlds_extension.spatial_fabric_subtree.unitsPerMeter;
        check('F10 an OSLFlatNode carrying a VALID subtree VALIDATES on the wire',
            v.validate('OSLFlatNode', fabricNodeWire).valid,
            v.validate('OSLFlatNode', fabricNodeWire).errorsText);
        check('F11 an OSLFlatNode carrying a BROKEN subtree is REJECTED on the wire (fail-closed reaches the server)',
            v.validate('OSLFlatNode', brokenNodeWire).valid === false,
            v.validate('OSLFlatNode', brokenNodeWire).errorsText);

        // NO REGRESSION: a canonical node with no extension is untouched, and the
        // strict ProofBoundary is byte-unchanged.
        check('F12 a canonical node with NO extension is UNCHANGED (still validates canonical Node)',
            v.validateCanonical('node', canonicalNodeFixture).valid
            && v.validate('OSLFlatNode', { id: 1, label: 'plain', children: [ 2 ] }).valid);
        const pb = v.doc.components.schemas.ProofBoundary;
        check('F13 ProofBoundary is UNCHANGED (strict, four required flags) — nothing here earned a flip',
            pb.additionalProperties === false && pb.required.length === 4
            && pb.required.indexOf('standards_conformance') !== -1);

        // The VOCABULARY PIN. web/wow-scene.mjs restates the refusal reasons and the
        // placement set rather than importing them (importing wow-fabric-transform.mjs
        // would drag the render-filament compositor into the PURE discovery path). So
        // pin them here, where importing everything is free: a fork fails this test.
        const { pathToFileURL } = require('url');
        const webUrl = (f) => pathToFileURL(path.join(REPO_ROOT, 'web', f)).href;
        const wowScene = await import(webUrl('wow-scene.mjs'));
        const xform = await import(webUrl('wow-fabric-transform.mjs'));
        const backend = await import(webUrl('wow-fabric-backend.mjs'));
        check('F14 VOCABULARY PIN — wow-scene\'s refusal reasons are IDENTICAL to OSL-FAB-XFORM-1\'s',
            wowScene.FABRIC_SUBTREE_REFUSAL.MISSING_UNITS_PER_METER === xform.REFUSAL.MISSING_UNITS_PER_METER
            && wowScene.FABRIC_SUBTREE_REFUSAL.BAD_UNITS_PER_METER === xform.REFUSAL.BAD_UNITS_PER_METER
            && wowScene.FABRIC_SUBTREE_REFUSAL.UNKNOWN_UP_AXIS === xform.REFUSAL.UNKNOWN_UP_AXIS);
        check('F15 VOCABULARY PIN — the placement set is IDENTICAL to the backend seam\'s placement->backend table',
            JSON.stringify(wowScene.FABRIC_PLACEMENTS) === JSON.stringify(Object.keys(backend.PLACEMENT_BACKEND))
            && wowScene.FABRIC_SUBTREE_REFUSAL.UNKNOWN_PLACEMENT === backend.BACKEND_REFUSAL.UNKNOWN_PLACEMENT,
            'scene=' + JSON.stringify(wowScene.FABRIC_PLACEMENTS)
            + ' backend=' + JSON.stringify(Object.keys(backend.PLACEMENT_BACKEND)));
        check('F16 VOCABULARY PIN — the strict member list matches the schema\'s properties exactly',
            JSON.stringify([].concat(wowScene.FABRIC_SUBTREE_MEMBERS).sort())
                === JSON.stringify(Object.keys(sfs.properties).sort()));

        // ================================================================
        // PART G — DISCOVERY: `built.fabric_nodes[]` from the REAL
        // builder (web/wow-scene.mjs) over the REAL fixture, with the REAL
        // three injected. Node-safe: buildWowScene stays PURE.
        // ================================================================
        let THREE = require('three');
        if (!THREE.Scene && THREE.default && THREE.default.Scene) THREE = THREE.default;
        const fabricWorld = require(path.join(REPO_ROOT, 'web', 'fixtures', 'wow', 'world-fabric.json'));
        const builtF = wowScene.buildWowScene(fabricWorld, THREE, { source: 'wow-validation:world-fabric.json' });
        const fn = builtF.fabric_nodes;
        const byId = (id) => fn.find(f => f.node_id === id);

        check('G1 buildWowScene returns fabric_nodes[] — the 3 CONTRACT-BEARING nodes, found by the EXTENSION',
            Array.isArray(fn) && fn.length === 3
            && [ 2, 3, 4 ].every(id => !!byId(id)),
            'fabric_nodes=' + JSON.stringify(fn.map(f => f.node_id)));
        check('G2 fabric nodes are EXCLUDED from asset_nodes (else loadGltf would read a signed .msf as a broken glTF)',
            builtF.asset_nodes.every(a => [ 2, 3, 4 ].indexOf(a.id) === -1),
            'asset_nodes=' + JSON.stringify(builtF.asset_nodes.map(a => a.id)));
        check('G3 the .msf node with NO declared contract (5) is NOT a fabric node — the SUFFIX IS NEVER SNIFFED',
            !byId(5) && builtF.asset_nodes.some(a => a.id === 5)
            && builtF.render_summary.fabric_subtrees.unspecified_contract_warnings.length === 1
            && builtF.render_summary.fabric_subtrees.unspecified_contract_warnings[0].node_id === 5);
        // The composed world matrix — column-major, metres, straight into OSL-FAB-XFORM-1.
        const orrery = byId(3);
        const wm = orrery.world_matrix;
        check('G4 each fabric node carries its COMPOSED column-major world_matrix (translation in m[12..14])',
            Array.isArray(wm) && wm.length === 16
            && Math.abs(wm[12] - 2.5) < 1e-9 && Math.abs(wm[13] - 0.9) < 1e-9 && Math.abs(wm[14] - 0) < 1e-9,
            'm[12..14]=' + JSON.stringify(wm && wm.slice(12, 15)));
        check('G5 the VALID subtree contracts are ACCEPTED, with fail-closed effective values (requireVerified defaults TRUE)',
            orrery.contract.ok === true && orrery.contract.effective.placement === 'in-room'
            && orrery.contract.effective.upAxis === 'z'
            && byId(2).contract.ok === true && byId(2).contract.effective.placement === 'backdrop'
            && byId(2).contract.effective.requireVerified === true);
        // FAIL-CLOSED at discovery, before any fetch.
        const brokenNode = byId(4);
        check('G6 the subtree missing `unitsPerMeter` is REFUSED — MISSING_UNITS_PER_METER, structured, before any fetch',
            brokenNode.contract.ok === false
            && brokenNode.contract.reason === wowScene.FABRIC_SUBTREE_REFUSAL.MISSING_UNITS_PER_METER,
            'reason=' + brokenNode.contract.reason);
        check('G7 a REFUSED subtree KEEPS a labeled, warn-tinted placeholder — never silently dropped, never drawn',
            /^wow-fabric-refused:/.test(brokenNode.placeholder.name)
            && brokenNode.placeholder.userData.assetUnavailable === true
            && !!brokenNode.placeholder.parent,
            'placeholder=' + brokenNode.placeholder.name);
        check('G8 render_summary COUNTS the fabric nodes and the refusal (surfaced, never hidden)',
            builtF.render_summary.fabric_subtrees.fabric_nodes === 3
            && builtF.render_summary.fabric_subtrees.contract_ok === 2
            && builtF.render_summary.fabric_subtrees.contract_refused === 1
            && builtF.render_summary.rendered.fabric_placeholders === 3,
            JSON.stringify(builtF.render_summary.fabric_subtrees.fabric_nodes) + '/'
            + builtF.render_summary.fabric_subtrees.contract_ok + '/'
            + builtF.render_summary.fabric_subtrees.contract_refused);
        // The HANDOVER actually works: world_matrix + the declared contract feed
        // OSL-FAB-XFORM-1 and produce a real placement. This is the seam rides.
        const prep = xform.prepareFabricPlacement(wm, {
            upAxis: orrery.contract.effective.upAxis,
            unitsPerMeter: orrery.contract.effective.unitsPerMeter,
            node_id: orrery.node_id });
        check('G9 HANDOVER — world_matrix + the declared contract feed OSL-FAB-XFORM-1 and yield a real placement',
            prep.ok === true && Number.isFinite(prep.composeScale) && prep.composeScale > 0
            && prep.basisApplied === true,
            'composeScale=' + (prep.ok ? prep.composeScale : prep.reason));
        // NO REGRESSION: a graph with NO fabric node behaves exactly as it does today.
        const worldA = require(path.join(REPO_ROOT, 'web', 'fixtures', 'wow', 'world-a.json'));
        const builtA = wowScene.buildWowScene(worldA, THREE, { source: 'wow-validation:world-a.json' });
        check('G10 NO REGRESSION — a graph with NO fabric node yields fabric_nodes:[] and its 6 asset_nodes unchanged',
            builtA.fabric_nodes.length === 0 && builtA.asset_nodes.length === 6
            && builtA.render_summary.rendered.asset_placeholders === 6
            && builtA.render_summary.fabric_subtrees.unspecified_contract_warnings.length === 0,
            'asset_nodes=' + builtA.asset_nodes.length + ' fabric_nodes=' + builtA.fabric_nodes.length);

        // ---- evidence ----
        const diagnostics = {
            wo: 'runtime',
            title: 'WoW contract foundation',
            captured_at: new Date().toISOString(),
            node: 'a (role source)',
            proof_port: PORT,
            wow_validate_env: process.env.OSL_WOW_VALIDATE,
            tool_versions: {
                ajv: require(path.join(REPO_ROOT, 'node_modules', 'ajv', 'package.json')).version,
                'ajv-formats': require(path.join(REPO_ROOT, 'node_modules', 'ajv-formats', 'package.json')).version,
                'openapi-typescript': require(path.join(REPO_ROOT, 'node_modules', 'openapi-typescript', 'package.json')).version,
                'js-yaml': require(path.join(REPO_ROOT, 'node_modules', 'js-yaml', 'package.json')).version,
            },
            contract: {
                schema_yaml: 'wow-spec/schema.yaml',
                schema_json: 'wow-spec/generated/schema.json',
                types: 'wow-spec/generated/wow-types.d.ts',
                schemas: v.schemaNames,
                canonical_paths: Object.keys(paths),
            },
            checks: results.length,
            failures,
            ok: failures === 0,
            results,
        };
        const evPath = path.join(REPO_ROOT, 'diagnostics', 'runtime-wow-contract-foundation.json');
        fs.mkdirSync(path.dirname(evPath), { recursive: true });
        fs.writeFileSync(evPath, JSON.stringify(diagnostics, null, 2) + '\n', 'utf8');
        process.stdout.write('\n[wow-013] diagnostics -> ' + evPath + '\n');
        process.stdout.write('[wow-013] ' + (failures === 0 ? 'ALL ' + results.length + ' CHECKS PASS'
            : failures + ' of ' + results.length + ' CHECKS FAILED') + '\n');
    } finally {
        await built.closeAll();
    }

    process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => { console.error('validation crashed:', err); process.exit(2); });
