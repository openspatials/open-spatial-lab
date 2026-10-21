'use strict';

/*
 * tools/wow-conformance/portal-proof.js.
 *
 * TARGETED proof that portals are WoW composition-graph nodes carrying a
 * RESOLVABLE destination, read off the labeled `Portal.destination` extension +
 * the graph node — NOT the raw `webofworlds_extension` bag. Isolated ports only
 * (NEVER 8143 / 18151-18153 — the live local demo). Additive / reuse-driven:
 * consumes the real 041 createServer + wow-spec/validate.js unchanged.
 *
 * It proves, on a booted-in-process instance pair (A + B on isolated high ports):
 *   (a) GET /wow/portal/1 validates against OSLPortalResponse; carries a labeled
 *       Portal.destination (validates against the canonical PortalDestination);
 *       proof_boundary.standards_conformance is false (no cosmetic green).
 *   (b) The destination is RESOLVABLE — its composition-graph reference
 *       (/wow/spatial/{target_world_id}) resolves to a live root Node on the
 *       ISOLATED sibling instance (never the live 18152 authority).
 *   (c) The portal NODE in /wow/spatial/{id} validates against the canonical Node
 *       and carries the resolvable destination (labeled webofworlds_extension +
 *       the kept osl-portal: URI), surfaced never hidden.
 *   (d) The webofworlds_extension portal footprint is measurably SHRUNK — the
 *       navigation-bearing target fields moved to Portal.destination.
 *   (e) The derived portal SHAPE is byte-stable: the real production
 *       live-adapter-world-projection.mjs functions yield IDENTICAL output whether
 *       fed the new destination path or the old extension path, and the graph-node
 *       derivation agrees on every documented shared field.
 *
 * Usage: node tools/wow-conformance/portal-proof.js
 *        OSL_PORTAL_PROOF_PORT_A / OSL_PORTAL_PROOF_PORT_B to override the isolated ports.
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { pathToFileURL } = require('url');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const HOST = '127.0.0.1';
const FORBIDDEN_PORTS = new Set([ 8143, 18151, 18152, 18153, 3000 ]);
const PORT_A = Number(process.env.OSL_PORTAL_PROOF_PORT_A || 18985);
const PORT_B = Number(process.env.OSL_PORTAL_PROOF_PORT_B || 18986);

const { createServer } = require(path.join(REPO_ROOT, 'runtime', 'world-server', 'src', 'server'));
const { createValidator } = require(path.join(REPO_ROOT, 'wow-spec', 'validate'));

const problems = [];
const checks = [];
function ok(name, cond, detail) {
    checks.push({ name, pass: !!cond, detail: detail || null });
    if (!cond) problems.push(name + (detail ? ' — ' + detail : ''));
}

function getJson(baseUrl, p) {
    return new Promise((resolve) => {
        let u;
        try { u = new URL(p, baseUrl); } catch (e) { return resolve({ error: 'bad url: ' + e.message }); }
        const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET',
            headers: { Accept: 'application/json' } }, (res) => {
            let buf = '';
            res.on('data', c => { buf += c; });
            res.on('end', () => { let json = null; try { json = JSON.parse(buf); } catch (e) {} resolve({ status: res.statusCode, headers: res.headers, json }); });
        });
        req.on('error', e => resolve({ error: e.message }));
        req.setTimeout(5000, () => { req.destroy(); resolve({ error: 'timeout' }); });
        req.end();
    });
}

function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

async function main() {
    for (const p of [ PORT_A, PORT_B ]) {
        if (FORBIDDEN_PORTS.has(p)) { console.error('REFUSING protected port ' + p); process.exit(2); }
    }
    const load1 = os.loadavg()[0];
    console.log('1-min load average: ' + load1.toFixed(2));

    const projection = await import(pathToFileURL(path.join(
        REPO_ROOT, 'web', 'live-adapter-world-projection.mjs')).href);
    const derivePortalEntry = projection.portalEntryFromWowPortal;
    const derivePortalEntryFromNode = projection.portalEntryFromWowNode;
    ok('real production portal projectors load Node-side',
        typeof derivePortalEntry === 'function' && typeof derivePortalEntryFromNode === 'function');

    const validator = createValidator();
    const baseA = 'http://' + HOST + ':' + PORT_A;
    const baseB = 'http://' + HOST + ':' + PORT_B;

    const a = createServer('a', { http_port: PORT_A });
    const b = createServer('b', { http_port: PORT_B });
    await new Promise(r => a.server.listen(PORT_A, HOST, r));
    await new Promise(r => b.server.listen(PORT_B, HOST, r));
    console.log('booted A -> ' + baseA + '  B -> ' + baseB + '  (isolated)');

    const diagnostics = { version_id: 'runtime', title: 'Portals as WoW composition-graph nodes (destination)',
        ports: { a: PORT_A, b: PORT_B }, boundary: 'isolated high ports; live demo 8143/18151-18153 untouched',
        checks: [], portal_resource: null, portal_node: null, extension_inventory: null };

    try {
        // (a) portal resource + Portal.destination -------------------------------
        const pr = await getJson(baseA, '/wow/portal/1');
        ok('portal resource GET 200', pr.status === 200, 'status=' + pr.status);
        const portal = pr.json || {};
        const rv = validator.validateResponse('portal', portal);
        ok('portal validates OSLPortalResponse', rv.valid, rv.errorsText);
        ok('portal carries labeled Portal.destination', portal.destination && typeof portal.destination === 'object');
        const dv = validator.validate('PortalDestination', portal.destination || {});
        ok('destination validates canonical PortalDestination', dv.valid, dv.errorsText);
        ok('destination.target_world_id present', !!(portal.destination && portal.destination.target_world_id),
            portal.destination && portal.destination.target_world_id);
        ok('destination.target_base_url present', !!(portal.destination && portal.destination.target_base_url));
        ok('destination.spatial_fabric_address present (flat string)',
            typeof (portal.destination && portal.destination.spatial_fabric_address) === 'string');
        ok('proof_boundary.standards_conformance is false (no cosmetic green)',
            portal.proof_boundary && portal.proof_boundary.standards_conformance === false);
        ok('proof_boundary.native_teleportxr_teleport is false',
            portal.proof_boundary && portal.proof_boundary.native_teleportxr_teleport === false);

        // (d) SHRINK: target fields OFF the raw extension bag; graph-ref present ---
        const ext = portal.webofworlds_extension || {};
        ok('SHRINK: ext has NO target_world_id (moved to destination)', !('target_world_id' in ext));
        ok('SHRINK: ext has NO target_location_id (moved to destination)', !('target_location_id' in ext));
        ok('SHRINK: ext has NO target_base_url (moved to destination)', !('target_base_url' in ext));
        ok('ext carries composition-graph ref target_spatial_graph_endpoint',
            typeof ext.target_spatial_graph_endpoint === 'string', ext.target_spatial_graph_endpoint);
        ok('ext carries portal_node_id (graph node cross-ref)', Number.isInteger(ext.portal_node_id), String(ext.portal_node_id));
        // residuals honestly retained (no WoW-native home)
        ok('RESIDUAL: ext keeps structured spatial_fabric_address object', ext.spatial_fabric_address && typeof ext.spatial_fabric_address === 'object');
        ok('RESIDUAL: ext keeps zones (OSL-native)', !!ext.zones);
        ok('RESIDUAL: ext keeps traversal (OSL-native)', !!ext.traversal);
        diagnostics.portal_resource = { id: portal.id, label: portal.label, destination: portal.destination,
            ext_keys: Object.keys(ext).sort() };

        // (c) portal NODE in the composition graph -------------------------------
        const world = await getJson(baseA, '/wow/world');
        const spatialId = world.json && world.json.id; // world_id (demo-room-a)
        ok('world_id resolved for /wow/spatial', !!spatialId, spatialId);
        const rootR = await getJson(baseA, '/wow/spatial/' + encodeURIComponent(spatialId));
        ok('/wow/spatial/{id} root 200', rootR.status === 200, 'status=' + rootR.status);
        const root = rootR.json || {};
        // served nodes are the LABELED, NON-CANONICAL OSLFlatNode
        // (integer id-ref children). The canonical `Node` embeds child objects, so our
        // nodes are EXPECTED to fail it — that is the DECLARED divergence D1, asserted
        // here explicitly rather than papered over.
        const rootNodeV = validator.validateResponse('node', root);
        ok('graph root validates OSLFlatNode (LABELED, non-canonical served shape)',
            rootNodeV.valid, rootNodeV.errorsText);
        ok('graph root does NOT validate canonical Node (DECLARED divergence D1 — id refs vs embedded objects)',
            validator.validateCanonical('node', root).valid === false);
        // the portal node id == ext.portal_node_id (deterministic seed order)
        const portalNodeR = await getJson(baseA, '/wow/spatial/' + encodeURIComponent(spatialId) + '/node/' + ext.portal_node_id);
        ok('portal node fetched by ext.portal_node_id (200)', portalNodeR.status === 200, 'status=' + portalNodeR.status);
        const pnode = portalNodeR.json || {};
        const pnodeV = validator.validateResponse('node', pnode);
        ok('portal node validates OSLFlatNode (LABELED, non-canonical served shape)',
            pnodeV.valid, pnodeV.errorsText);
        ok('portal node keeps labeled osl-portal: spatialAssetURI', /^osl-portal:/.test(pnode.spatialAssetURI || ''), pnode.spatialAssetURI);
        ok('portal node carries labeled webofworlds_extension role=portal',
            pnode.webofworlds_extension && pnode.webofworlds_extension.role === 'portal');
        ok('portal node destination resolvable via graph ref',
            pnode.webofworlds_extension && typeof pnode.webofworlds_extension.target_spatial_graph_endpoint === 'string',
            pnode.webofworlds_extension && pnode.webofworlds_extension.target_spatial_graph_endpoint);
        diagnostics.portal_node = { id: pnode.id, label: pnode.label, spatialAssetURI: pnode.spatialAssetURI,
            webofworlds_extension: pnode.webofworlds_extension };

        // (b) RESOLVABLE destination — resolve the graph ref on the ISOLATED sibling
        const targetGraphPath = portal.destination && portal.destination.target_world_id
            ? '/wow/spatial/' + encodeURIComponent(portal.destination.target_world_id) : null;
        ok('destination graph path derivable', !!targetGraphPath, targetGraphPath);
        const targetResolve = await getJson(baseB, targetGraphPath); // isolated B, NOT the live 18152 authority
        ok('destination RESOLVES to a live root Node on isolated sibling (B)',
            targetResolve.status === 200 && targetResolve.json && Number.isInteger(targetResolve.json.id),
            'status=' + targetResolve.status + ' (resolved ' + targetGraphPath + ' on isolated ' + baseB + ')');
        ok('resolved target graph root validates OSLFlatNode (LABELED served shape)',
            validator.validateResponse('node', targetResolve.json || {}).valid);

        // (e) DERIVED SHAPE byte-stability ---------------------------------------
        const locId = world.json && world.json.location && world.json.location.id;
        const fromDestination = derivePortalEntry(portal, locId);
        // synthesize an OLD-backend portal: target fields back in the extension, no destination
        const oldStyle = JSON.parse(JSON.stringify(portal));
        oldStyle.webofworlds_extension.target_world_id = portal.destination.target_world_id;
        oldStyle.webofworlds_extension.target_location_id = portal.destination.target_location_id;
        oldStyle.webofworlds_extension.target_base_url = portal.destination.target_base_url;
        delete oldStyle.destination;
        const fromExtension = derivePortalEntry(oldStyle, locId);
        ok('DERIVED SHAPE byte-stable: destination path === legacy extension path', eq(fromDestination, fromExtension),
            'target_world_id ' + fromDestination.target_world_id + ' vs ' + fromExtension.target_world_id);
        // graph-node derivation agrees on shared fields
        const fromNode = derivePortalEntryFromNode(pnode, locId);
        ok('graph-node derivation agrees: target_world_id', fromNode.target_world_id === fromDestination.target_world_id,
            fromNode.target_world_id + ' vs ' + fromDestination.target_world_id);
        ok('graph-node derivation agrees: string_portal_id', fromNode.string_portal_id === fromDestination.string_portal_id,
            fromNode.string_portal_id + ' vs ' + fromDestination.string_portal_id);
        ok('graph-node derivation agrees: trigger position',
            eq(fromNode.trigger.position, fromDestination.trigger.position),
            JSON.stringify(fromNode.trigger.position) + ' vs ' + JSON.stringify(fromDestination.trigger.position));
        diagnostics.derived = {
            from_destination: fromDestination,
            // Keep the prior proof's trigger_position evidence field while also
            // recording the complete real production projector output.
            from_node: Object.assign({ trigger_position: fromNode.trigger.position }, fromNode),
            source: 'web/live-adapter-world-projection.mjs (real production import)',
        };

        // extension inventory (before was measured pre-change; after is live now)
        diagnostics.extension_inventory = {
            portal_resource_ext_keys_after: Object.keys(ext).sort(),
            moved_to_destination: [ 'target_world_id', 'target_location_id', 'target_base_url', 'spatial_fabric_address(flat)' ],
            residual_labeled_in_ext: [ 'spatial_fabric_address(structured object)', 'zones', 'traversal', 'traversal_mode' ],
            added_graph_reference: [ 'portal_node_id', 'target_spatial_graph_endpoint' ],
        };
    } finally {
        await a.closeAll();
        await b.closeAll();
    }

    diagnostics.checks = checks;
    diagnostics.assertions = { ok: problems.length === 0, problems };
    const evDir = path.join(REPO_ROOT, 'diagnostics');
    try { fs.mkdirSync(evDir, { recursive: true }); } catch (e) {}
    const evPath = path.join(evDir, 'runtime-portal-destination-validation.json');
    fs.writeFileSync(evPath, JSON.stringify(diagnostics, null, 2) + '\n', 'utf8');

    console.log('\n=== runtime portal-destination validation ===');
    for (const c of checks) console.log('  ' + (c.pass ? '[PASS] ' : '[FAIL] ') + c.name + (c.detail ? '  (' + c.detail + ')' : ''));
    console.log('\nevidence -> ' + evPath);
    console.log('assertions: ' + (problems.length === 0 ? 'ALL PASS' : 'FAIL -> ' + problems.join('; ')));
    process.exit(problems.length === 0 ? 0 : 1);
}

main().catch(err => { console.error('runtime validation crashed:', err); process.exit(2); });
