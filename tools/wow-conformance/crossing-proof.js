'use strict';

/*
 * tools/wow-conformance/crossing-proof.js.
 *
 * TARGETED, DETERMINISTIC proof that a world->world crossing on WoW worlds:
 *   (A) renders BOTH worlds via the WoW Spatial Composition Graph
 *       (buildWowScene over /wow/spatial/{id}) — node counts + positions
 *       GRAPH-SOURCED, NOT a prefetched Sneeze .msf child fabric;
 *   (B) resolves the crossing DESTINATION from the labeled Portal.destination
 * never webofworlds_extension.target_*;
 *   (C) drives the seam with the IWPS handshake (Query = /portal/exit-intent,
 *       Teleport = /portal/arrival) and correlates STRICTLY by handoff_id
 *       (never an arrival_count delta);
 *   (D) hands presence over GHOST-FREE across the two worlds' /wow/user
 *       registries — the crosser ends up in EXACTLY ONE world;
 *   (E) keeps the honesty scoping unchanged (standards_conformance:false,
 *       native_teleportxr_teleport:false; IWPS base-scoped, not inflated);
 *   (F) CARRIES CONTINUITY — the crosser is given a MINTED identity that the
 *       destination cannot produce by accident, and that identity is then observed
 *       CROSSING: source state -> the wire -> the destination's avatar record,
 *       arrival receipt, WoW /wow/user registry and presence registry; then done
 *       AGAIN with a different identity, so a destination that echoed a constant is
 *       caught. BEHAVIOURAL.
 *       The browser-side machinery (no-reload in-memory promotion, the
 *       (x,y,z)->(-x,y,-z) camera isometry) keeps a SOURCE TRIPWIRE, labeled as
 *       exactly that and no longer published as continuity evidence; its RUNTIME
 *       proof is the e2e-driver's (browser), DEFERRED to a load window /.
 *
 * Isolated ports ONLY (NEVER 8143 / 18151-18153 — the live local demo). Boots a
 * real 041 createServer instance pair (A + B) in-process; consumes the real
 * web/wow-scene.mjs buildWowScene builder (Node-safe: THREE injected, no WebGL).
 * Additive / reuse-driven: no server/client/spec change is made by this proof.
 *
 * Usage: node tools/wow-conformance/crossing-proof.js
 *        OSL_CROSSING_PROOF_PORT_A / OSL_CROSSING_PROOF_PORT_B override the isolated ports.
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { pathToFileURL } = require('url');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const HOST = '127.0.0.1';
const FORBIDDEN_PORTS = new Set([ 8143, 18151, 18152, 18153, 3000 ]);
const PORT_A = Number(process.env.OSL_CROSSING_PROOF_PORT_A || 18987);
const PORT_B = Number(process.env.OSL_CROSSING_PROOF_PORT_B || 18988);
const LOAD_GATE = 14; // the repo-wide browser-proof gate; this Node proof records it, never fakes it

// The two kebab-case, POST-only crossing paths (§3.5.3 URL paths, §5.2.1 POST-only). These
// are the IWPS ROLE NAMES for the two POSTs the crossing genuinely makes — Query first,
// Teleport second (§5.1.1). They are NOT IWPS API implementations; see (E) below.
const IWPS_QUERY_PATH = '/portal/exit-intent';
const IWPS_TELEPORT_PATH = '/portal/arrival';

// ---------------------------------------------------------------------------
// NEGATIVE MODE. A verifier you have never seen fail is not a
// verifier; it is a decoration. This proof can be run with the capability REMOVED, and it
// is REQUIRED to go red. Two modes, because there are two ways to lie:
//
//   --negative=route  REMOVE THE CAPABILITY. The destination's kebab-case POST crossing
//                     route (/portal/arrival) is stripped off the wire at runtime — a real
//                     404, not a mock. Everything the "IWPS-SHAPED" claim asserts is then
//                     false, and the proof MUST go red.
//   --negative=claim  RE-INFLATE THE CLAIM. The conformance descriptor is overridden to
//                     `base_query_teleport: true` / `iwps_conformance: true` while the wire
//                     is left exactly as it is. THIS IS THE EXACT REGRESSION
// SHIPPED — and the old source-grep verifier PASSED
//                     it. The claim/wire lock MUST now go red.
//   --negative=continuity
//                     BREAK CONTINUITY ON THE WIRE. The crosser's
//                     `avatar_context.continuity_id` is DELETED from the arrival body as it
//                     enters the destination — a real mutation of a real HTTP request, not a
//                     mock. The crossing still SUCCEEDS: the handoff_id still correlates, the
//                     arrival is still 201, presence is still ghost-free. ONLY the identity
//                     fails to carry. Everything block (F) claims is then false, and the proof
//                     MUST go red. Before this change, block (F) "proved" continuity by grepping
//                     web/live-adapter.js for regexes — it would have passed this cleanly.
//
// In negative mode the exit code is INVERTED: red == the negative test PASSED (exit 0);
// green == THE VERIFIER IS BLIND, which is the real bug (exit 3).
// ---------------------------------------------------------------------------
const NEGATIVE = (() => {
    const arg = process.argv.slice(2).find((a) => a.startsWith('--negative'));
    const env = process.env.OSL_CROSSING_PROOF_NEGATIVE;
    const raw = arg ? (arg.includes('=') ? arg.split('=')[1] : 'route') : (env || '');
    if (!raw) return null;
    if (raw !== 'route' && raw !== 'claim' && raw !== 'continuity') {
        console.error('unknown --negative mode "' + raw + '" (expected: route | claim | continuity)');
        process.exit(2);
    }
    return raw;
})();

const { createServer } = require(path.join(REPO_ROOT, 'runtime', 'world-server', 'src', 'server'));

/**
 * --negative=route: physically remove the crossing capability from the destination server.
 * The kebab-case POST route the IWPS-SHAPED claim depends on starts returning a real 404.
 * Nothing is mocked; the HTTP server genuinely stops serving it.
 */
function stripCrossingCapability(inst, routePath) {
    const original = inst.server.listeners('request').slice();
    inst.server.removeAllListeners('request');
    inst.server.on('request', (req, res) => {
        const p = String(req.url || '').split('?')[0];
        if (p === routePath) {
            res.statusCode = 404;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'capability removed by --negative=route (runtime negative test)' }));
            return;
        }
        for (const l of original) l.call(inst.server, req, res);
    });
}

/**
 * --negative=continuity: remove the CONTINUITY CARRIER from the wire.
 *
 * The arrival request really reaches the destination; the destination really serves it; the
 * crossing really completes. The ONE thing that changes is that `avatar_context.continuity_id`
 * is gone from the body by the time the server's handler reads it — so the destination has
 * nothing to preserve the crosser's identity FROM, and falls back to avatar_id.
 *
 * The mutated body is replayed to the ORIGINAL listener through a Readable carrying the real
 * request's method/url/headers, which is all the 041 server's readBody() consumes. Nothing is
 * stubbed: this is the real server, handling a real (tampered) request.
 */
function stripContinuityOnWire(inst, routePath) {
    const { Readable } = require('stream');
    const original = inst.server.listeners('request').slice();
    inst.server.removeAllListeners('request');
    inst.server.on('request', (req, res) => {
        const p = String(req.url || '').split('?')[0];
        if (req.method !== 'POST' || p !== routePath) {
            for (const l of original) l.call(inst.server, req, res);
            return;
        }
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            let body = Buffer.concat(chunks);
            try {
                const parsed = JSON.parse(body.toString('utf8'));
                if (parsed && parsed.avatar_context) delete parsed.avatar_context.continuity_id;
                body = Buffer.from(JSON.stringify(parsed));
            } catch (e) { /* leave a non-JSON body alone; the server will reject it as it always would */ }
            const replay = new Readable({ read() {} });
            replay.method = req.method;
            replay.url = req.url;
            replay.headers = Object.assign({}, req.headers, { 'content-length': String(body.length) });
            replay.socket = req.socket;
            replay.connection = req.socket;
            replay.push(body);
            replay.push(null);
            for (const l of original) l.call(inst.server, replay, res);
        });
    });
}

const problems = [];
const checks = [];
function ok(name, cond, detail) {
    checks.push({ name, pass: !!cond, detail: detail || null });
    if (!cond) problems.push(name + (detail ? ' — ' + detail : ''));
}

// ---------------------------------------------------------------------------
// THE EVIDENCE MUST BE DERIVED FROM THE RUN, NOT ASSERTED.
//
// evidence.continuity_static used to HARDCODE `no_reload_invariant: true`,
// `in_memory_promotion: true`, `isometry_x_and_z_negated: true`, ... — literal `true`s
// written into the evidence file for results this proof actually COMPUTES into checks[].
// If a source regex stopped matching (the machinery was deleted, renamed, refactored) the
// run exited 1 — but the evidence file ON DISK still read `true`. Anyone reading the
// artifact, which is the entire point of an artifact, was told the invariant held.
//
// These names are now declared ONCE and used BOTH to register the check and to derive the
// evidence field, so the two cannot drift. A field whose check never ran is `null`
// (UNKNOWN) and raises an EVIDENCE INTEGRITY problem — never `true`, never quietly `false`.
// ---------------------------------------------------------------------------
const C = {
    NO_RELOAD_DOC:   'NO-RELOAD invariant intact: crossing documents "never location.reload()"',
    NO_RELOAD_MECH:  'NO-RELOAD invariant intact: in-memory promotion mechanism string present',
    MACH_COMPLETE:   'MACHINERY: _completePlayerCrossing present (promotion/continuity entrypoint)',
    MACH_PROMOTE:    'MACHINERY: _promoteActiveEndpoint present (in-memory root-swap)',
    ISO_X:           'ISOMETRY source tripwire: canonical proper local helper negates x and mapCameraAcrossCrossing consumes it',
    ISO_Z:           'ISOMETRY source tripwire: canonical proper local helper negates z and mapCameraAcrossCrossing consumes it',
    RESRC_WIRED:     'RE-SOURCE wired: _resolveWowSceneGraph added (WoW graph = scene source of record)',
    RESRC_PROMO:     'RE-SOURCE wired into promotion: destination_scene_source recorded on the crossing',
    RESRC_HONEST:    'RE-SOURCE honest: scene source records msf_dependency:false',
};

/** The recorded outcome of a check that actually ran; null (+ a loud problem) if it did not. */
function checkResult(name) {
    const c = checks.find(x => x.name === name);
    if (!c) {
        problems.push('diagnostics INTEGRITY: no check named "' + name + '" ran — its diagnostics field cannot be derived');
        return null;
    }
    return c.pass;
}
/** true only if every named check ran AND passed; null if any never ran. */
function derived(...names) {
    const vals = names.map(checkResult);
    if (vals.some(v => v === null)) return null;
    return vals.every(v => v === true);
}

function req(method, baseUrl, p, body) {
    return new Promise((resolve) => {
        let u;
        try { u = new URL(p, baseUrl); } catch (e) { return resolve({ error: 'bad url: ' + e.message }); }
        const payload = body != null ? Buffer.from(JSON.stringify(body)) : null;
        const headers = { Accept: 'application/json' };
        if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = payload.length; }
        const r = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method, headers }, (res) => {
            let buf = '';
            res.on('data', c => { buf += c; });
            res.on('end', () => { let json = null; try { json = JSON.parse(buf); } catch (e) {} resolve({ status: res.statusCode, headers: res.headers, json }); });
        });
        r.on('error', e => resolve({ error: e.message }));
        r.setTimeout(6000, () => { r.destroy(); resolve({ error: 'timeout' }); });
        if (payload) r.write(payload);
        r.end();
    });
}
const getJson = (b, p) => req('GET', b, p, null);
const postJson = (b, p, body) => req('POST', b, p, body);

// Walk the live canonical composition graph exactly as the client does
// (GET /wow/spatial/{id} root Node + BFS /node/{id}) into a flat {id:Node} map.
async function walkGraph(base, spatialId) {
    const rootR = await getJson(base, '/wow/spatial/' + encodeURIComponent(spatialId));
    if (rootR.status !== 200 || !rootR.json || rootR.json.id == null) return { ok: false, status: rootR.status, nodes: {}, stats: { total: 0 } };
    const nodes = {}; nodes[Number(rootR.json.id)] = rootR.json;
    const seen = new Set([ Number(rootR.json.id) ]);
    const queue = (Array.isArray(rootR.json.children) ? rootR.json.children : []).map(Number);
    let fetched = 0, failed = 0;
    while (queue.length) {
        const id = Number(queue.shift());
        if (seen.has(id)) continue; seen.add(id);
        const nR = await getJson(base, '/wow/spatial/' + encodeURIComponent(spatialId) + '/node/' + id);
        if (nR.status === 200 && nR.json && nR.json.id != null) {
            nodes[Number(nR.json.id)] = nR.json; fetched++;
            for (const c of (Array.isArray(nR.json.children) ? nR.json.children : [])) if (!seen.has(Number(c))) queue.push(Number(c));
        } else { failed++; }
    }
    return { ok: true, root: Number(rootR.json.id), nodes, stats: { fetched, failed, total: Object.keys(nodes).length } };
}

function near(a, b, tol) { return Math.abs((Number(a) || 0) - (Number(b) || 0)) <= (tol || 0.001); }

// ---------------------------------------------------------------------------
// THE CROSSER'S IDENTITY, AND WHY IT MUST BE MINTED.
//
// Every 041 node boots with the SAME factory identity: avatar_id == continuity_id ==
// 'avatar-local-001', and /reset restores it. So the file's one behavioural continuity check —
// "B's post-arrival continuity_id equals A's exit-packet continuity_id" — was comparing
// 'avatar-local-001' to 'avatar-local-001'. A DEFAULT TO ITSELF. Delete the continuity field
// from the wire and it still passed, because B's untouched default already equalled A's.
//
// So the crosser is given a MINTED continuity_id before it ever crosses. It is distinct from the
// factory default (B cannot produce it by accident) and distinct from avatar_id (so a fallback to
// avatar_id is VISIBLE rather than silently correct). Two of them, because a destination that
// merely echoed a constant would still satisfy one.
// ---------------------------------------------------------------------------
const FACTORY_IDENTITY = 'avatar-local-001';
const CROSSER_AVATAR_ID = 'avatar-local-001';
const mintId = (tag) => 'runtime-continuity-' + tag + '-' + process.pid + '-' + Math.floor(Math.random() * 1e9);
const MINTED_1 = mintId('a');
const MINTED_2 = mintId('b');

/**
 * A REAL inbound arrival that installs a KNOWN continuity identity on a node. This is the node's
 * own production crossing-arrival path (POST /portal/arrival, commitArrival) — not a back door and
 * not a test hook. It is how a crosser's identity legitimately gets onto a world in the first place.
 */
function seedArrivalPacket(worldId, locationId, continuityId) {
    return {
        ok: true,
        handoff_id: 'runtime-seed-' + locationId + '-' + Date.now() + '-' + Math.floor(Math.random() * 1e6),
        behavior: 'application-level-handoff-around-teleportxr',
        native_teleportxr_teleport: false,
        created_at: new Date().toISOString(),
        source: { location_id: 'runtime-seed-origin', world_id: 'runtime-seed-world', session_id: 'runtime-seed-session' },
        target: { location_id: locationId, world_id: worldId, arrival_position: [ 0, 0, 3.6 ], arrival_rotation_y: 0 },
        avatar_context: {
            avatar_id: CROSSER_AVATAR_ID,
            continuity_id: continuityId,
            display_name: 'runtime crosser',
            transform: { position: [ 0, 0, 0 ], rotation_y: 0, orientation: [ 0, 0, 0, 1 ], scale: [ 1, 1, 1 ] },
        },
    };
}

async function main() {
    for (const p of [ PORT_A, PORT_B ]) {
        if (FORBIDDEN_PORTS.has(p)) { console.error('REFUSING protected port ' + p); process.exit(2); }
    }
    const load1 = os.loadavg()[0];
    console.log('1-min load average: ' + load1.toFixed(2) +
        (load1 >= 14 ? '  (>=14: a Chrome e2e validation would false-fail — this is the deterministic Node validation; browser nav-count validation deferred)' : ''));

    // The WoW render builder is Node-safe (THREE injected; no DOM/WebGL). Inject
    // the real three so "rendered via the WoW composition graph" is the ACTUAL
    // builder, not a transcription.
    let THREE = require('three');
    if (!THREE.Scene && THREE.default && THREE.default.Scene) THREE = THREE.default;
    const wowSceneMod = await import(pathToFileURL(path.join(REPO_ROOT, 'web', 'wow-scene.mjs')).href);
    const buildWowScene = wowSceneMod.buildWowScene;
    ok('buildWowScene + three load Node-side (headless render builder)', typeof buildWowScene === 'function' && !!THREE.Scene);

    const baseA = 'http://' + HOST + ':' + PORT_A, baseB = 'http://' + HOST + ':' + PORT_B;
    const a = createServer('a', { http_port: PORT_A });
    const b = createServer('b', { http_port: PORT_B });
    await new Promise(r => a.server.listen(PORT_A, HOST, r));
    await new Promise(r => b.server.listen(PORT_B, HOST, r));
    console.log('booted A -> ' + baseA + '  B -> ' + baseB + '  (isolated; live demo 8143/18151-18153 untouched)');

    if (NEGATIVE === 'route') {
        stripCrossingCapability(b, IWPS_TELEPORT_PATH);
        console.log('\n*** NEGATIVE=route — CAPABILITY REMOVED: destination B no longer serves POST ' + IWPS_TELEPORT_PATH +
            ' (real 404). This validation MUST now go RED. ***\n');
    }
    if (NEGATIVE === 'claim') {
        console.log('\n*** NEGATIVE=claim — CLAIM RE-INFLATED: the conformance descriptor is overridden to ' +
            'base_query_teleport:true / iwps_conformance:true while the WIRE IS UNCHANGED.\n' +
            '    This is the exact runtime regression. The old source-grep verifier PASSED it.\n' +
            '    The claim/wire lock MUST now go RED. ***\n');
    }
    if (NEGATIVE === 'continuity') {
        stripContinuityOnWire(b, IWPS_TELEPORT_PATH);
        console.log('\n*** NEGATIVE=continuity — CONTINUITY CARRIER REMOVED: avatar_context.continuity_id is deleted\n' +
            '    from the arrival body on the wire into destination B. The crossing still SUCCEEDS (201, handoff_id\n' +
            '    correlates, presence stays ghost-free) — only the crosser\'s IDENTITY fails to carry.\n' +
            '    The old source-grep block would have passed this without a murmur. Block (F) MUST now go RED. ***\n');
    }

    const diagnostics = {
        version_id: 'runtime',
        title: 'World->world crossing on WoW worlds (IWPS handshake; continuity)',
        ports: { a: PORT_A, b: PORT_B }, load_1min: Number(load1.toFixed(2)),
        boundary: 'isolated high ports; live demo 8143/18151-18153 untouched; deterministic Node validation (no Chrome)',
        checks: [], scene_source: {}, crossing: {}, presence: {}, honesty: {},
        continuity: {}, client_machinery_source_tripwire: {},
    };

    try {
        // ===== (A) BOTH worlds rendered via the WoW composition graph =====
        const worldA = await getJson(baseA, '/wow/world');
        const worldB = await getJson(baseB, '/wow/world');
        const spA = worldA.json && worldA.json.id;
        const spB = worldB.json && worldB.json.id;
        ok('A /wow/world resolves spatialID', !!spA, spA);
        ok('B /wow/world resolves spatialID', !!spB, spB);
        const gA = await walkGraph(baseA, spA);
        const gB = await walkGraph(baseB, spB);
        ok('A composition graph walked (>=1 node)', gA.ok && gA.stats.total >= 1, gA.ok ? ('nodes=' + gA.stats.total) : 'walk failed');
        ok('B composition graph walked (>=1 node)', gB.ok && gB.stats.total >= 1, gB.ok ? ('nodes=' + gB.stats.total) : 'walk failed');
        // walkGraph COUNTED fetch failures and nobody ever asserted
        // the count. Dropped children silently shrink the node map — and then the check below
        // ("render node count == graph node count") compares two numbers BOTH derived from that
        // same truncated map, so it holds tautologically no matter how much of the graph 500'd.
        // A half-fetched graph could render "correctly" against itself. Assert the walk was WHOLE.
        ok('A graph walked with ZERO node-fetch failures (the node-count check below is only meaningful if the walk was complete)',
            gA.stats.failed === 0, 'fetched=' + gA.stats.fetched + ' failed=' + gA.stats.failed);
        ok('B graph walked with ZERO node-fetch failures (the node-count check below is only meaningful if the walk was complete)',
            gB.stats.failed === 0, 'fetched=' + gB.stats.fetched + ' failed=' + gB.stats.failed);

        const builtA = buildWowScene({ spatialID: spA, root: gA.root, nodes: gA.nodes }, THREE, { source: 'live /wow/spatial (isolated A)' });
        const builtB = buildWowScene({ spatialID: spB, root: gB.root, nodes: gB.nodes }, THREE, { source: 'live /wow/spatial (isolated B)' });
        ok('A renders via buildWowScene (shape=wow-composition-graph)', builtA.render_summary.shape === 'wow-composition-graph');
        ok('B renders via buildWowScene (shape=wow-composition-graph)', builtB.render_summary.shape === 'wow-composition-graph');
        ok('A render node count == graph node count (graph-sourced, not synthesized)',
            builtA.render_summary.graph_node_count === gA.stats.total, builtA.render_summary.graph_node_count + ' vs ' + gA.stats.total);
        ok('B render node count == graph node count (graph-sourced, not synthesized)',
            builtB.render_summary.graph_node_count === gB.stats.total, builtB.render_summary.graph_node_count + ' vs ' + gB.stats.total);
        ok('A rendered >=1 node from the graph', builtA.render_summary.rendered.rendered_nodes >= 1, 'rendered=' + builtA.render_summary.rendered.rendered_nodes);
        ok('B rendered >=1 node from the graph', builtB.render_summary.rendered.rendered_nodes >= 1, 'rendered=' + builtB.render_summary.rendered.rendered_nodes);
        // positions graph-sourced: a placement's world_position derives from the node's
        // column-major localTransform, composed through the parent hierarchy.
        function placementsAreGraphSourced(built, g) {
            const pls = built.render_summary.placements || [];
            let checked = 0, matched = 0, sample = null;
            for (const pl of pls) {
                const node = g.nodes[pl.id];
                const lt = node && Array.isArray(node.localTransform) && node.localTransform.length === 16 ? node.localTransform : null;
                if (!lt) continue;
                const parentId = node.parent;
                // A root/top-level node's world_position == its own localTransform translation.
                if (parentId == null || !g.nodes[parentId]) {
                    checked++;
                    const m = near(pl.world_position[0], lt[12]) && near(pl.world_position[1], lt[13]) && near(pl.world_position[2], lt[14]);
                    if (m) matched++; else sample = { id: pl.id, wp: pl.world_position, lt: [ lt[12], lt[13], lt[14] ] };
                }
            }
            return { checked, matched, sample };
        }
        const psA = placementsAreGraphSourced(builtA, gA);
        const psB = placementsAreGraphSourced(builtB, gB);
        ok('A node positions graph-sourced (world_position == localTransform translation for top-level nodes)',
            psA.checked >= 1 && psA.matched === psA.checked, 'matched ' + psA.matched + '/' + psA.checked + (psA.sample ? ' sample ' + JSON.stringify(psA.sample) : ''));
        ok('B node positions graph-sourced (world_position == localTransform translation for top-level nodes)',
            psB.checked >= 1 && psB.matched === psB.checked, 'matched ' + psB.matched + '/' + psB.checked + (psB.sample ? ' sample ' + JSON.stringify(psB.sample) : ''));
        ok('scene source is the WoW composition graph, NOT a .msf child fabric (both worlds)',
            builtA.render_summary.shape === 'wow-composition-graph' && builtB.render_summary.shape === 'wow-composition-graph');
        diagnostics.scene_source = {
            a: { spatialID: spA, node_count: gA.stats.total, rendered_nodes: builtA.render_summary.rendered.rendered_nodes, shape: builtA.render_summary.shape, positions_graph_sourced: psA,
                 walk: { fetched: gA.stats.fetched, failed: gA.stats.failed, complete: gA.stats.failed === 0 } },
            b: { spatialID: spB, node_count: gB.stats.total, rendered_nodes: builtB.render_summary.rendered.rendered_nodes, shape: builtB.render_summary.shape, positions_graph_sourced: psB,
                 walk: { fetched: gB.stats.fetched, failed: gB.stats.failed, complete: gB.stats.failed === 0 } },
            msf_dependency: false,
            note: 'render_summary.shape=wow-composition-graph; node counts+positions taken VERBATIM from /wow/spatial (buildWowScene), not the .msf child fabric.',
        };

        // ===== (B) destination resolved from Portal.destination =====
        const portalA = await getJson(baseA, '/wow/portal/1');
        const pa = portalA.json || {};
        const dest = pa.destination && typeof pa.destination === 'object' ? pa.destination : {};
        const paExt = pa.webofworlds_extension || {};
        ok('A portal carries labeled Portal.destination', !!dest.target_world_id, dest.target_world_id);
        ok('destination is OFF the raw extension (SHRUNK: ext has no target_world_id)', !('target_world_id' in paExt));
        ok('crossing destination (Portal.destination.target_world_id) == B spatialID', String(dest.target_world_id) === String(spB), dest.target_world_id + ' vs ' + spB);
        const destResolve = await getJson(baseB, '/wow/spatial/' + encodeURIComponent(dest.target_world_id));
        ok('Portal.destination resolves to a live root Node on the destination world (B, graph-sourced)',
            destResolve.status === 200 && destResolve.json && destResolve.json.id != null, 'status=' + destResolve.status);
        const portalStringId = (paExt.portal_id && typeof paExt.portal_id === 'string') ? paExt.portal_id : 'location-a-portal';
        diagnostics.crossing.destination = { via: 'Portal.destination', target_world_id: dest.target_world_id, resolves_on_B: destResolve.status === 200, source_portal_string_id: portalStringId };

        // ===== (C) IWPS handshake: Query = exit-intent, Teleport = arrival; handoff_id correlation =====
        await postJson(baseA, '/reset'); await postJson(baseB, '/reset');

        // --- make the crosser's identity DISTINGUISHABLE before it crosses. ---
        // Learn A's own world/location ids from its own exit packet (its `source` block), record the
        // destination's FACTORY identity, and confirm the destination has never heard of the minted
        // id. Only then is "B ends up holding the minted id" a fact about the CROSSING rather than a
        // fact about B's defaults. (This runs BEFORE the graded Query leg; last_exit_intent is
        // overwritten by the real one below, and no IWPS assertion reads this probe.)
        const probe = (await postJson(baseA, IWPS_QUERY_PATH, { portal_id: portalStringId })).json || {};
        const aWorldId = probe.source && probe.source.world_id;
        const aLocationId = probe.source && probe.source.location_id;
        const dsB0 = (await getJson(baseB, '/debug/state')).json || {};
        const baselineB = dsB0.avatar && dsB0.avatar.continuity_id;
        const wowUserBefore = await getJson(baseB, '/wow/user/' + encodeURIComponent(MINTED_1));
        const seedR = await postJson(baseA, IWPS_TELEPORT_PATH, seedArrivalPacket(aWorldId, aLocationId, MINTED_1));
        const dsASeed = (await getJson(baseA, '/debug/state')).json || {};

        const exitR = await postJson(baseA, IWPS_QUERY_PATH, { portal_id: portalStringId });
        const exitPacket = exitR.json || {};
        ok('Query-leg POST (exit-intent) accepted on source A (201)', exitR.status === 201, 'status=' + exitR.status);
        ok('exit packet carries handoff_id', !!exitPacket.handoff_id, exitPacket.handoff_id);
        ok('exit packet target.location_id == destination (location-b)', exitPacket.target && exitPacket.target.location_id === 'location-b', exitPacket.target && exitPacket.target.location_id);
        ok('exit packet native_teleportxr_teleport:false (honest boundary)', exitPacket.native_teleportxr_teleport === false);
        const drift = await postJson(baseA, IWPS_TELEPORT_PATH, exitPacket);
        ok('drift guard: arrival posted to the WRONG node (A) rejected (400)', drift.status === 400, 'status=' + drift.status);
        const arrR = await postJson(baseB, IWPS_TELEPORT_PATH, exitPacket);
        ok('Teleport-leg POST (arrival) accepted on destination B (201)', arrR.status === 201, 'status=' + arrR.status);
        const dsB = (await getJson(baseB, '/debug/state')).json || {};
        const dsA = (await getJson(baseA, '/debug/state')).json || {};
        const bArrHandoff = dsB.debug && dsB.debug.handoff && dsB.debug.handoff.last_arrival ? dsB.debug.handoff.last_arrival.handoff_id : null;
        const aExitHandoff = dsA.debug && dsA.debug.handoff && dsA.debug.handoff.last_exit_intent ? dsA.debug.handoff.last_exit_intent.handoff_id : null;
        ok('handoff_id correlates A.exit == B.arrival == packet (STRICT handoff_id, NOT arrival_count delta)',
            !!bArrHandoff && bArrHandoff === exitPacket.handoff_id && aExitHandoff === exitPacket.handoff_id,
            'A.exit=' + aExitHandoff + ' B.arrival=' + bArrHandoff + ' packet=' + exitPacket.handoff_id);
        ok('continuity_id preserved across the crossing',
            dsB.avatar && exitPacket.avatar_context && dsB.avatar.continuity_id === exitPacket.avatar_context.continuity_id,
            dsB.avatar && dsB.avatar.continuity_id);
        ok('A stays location-a, B stays location-b (no silent one-window collapse)',
            dsA.location && dsA.location.location_id === 'location-a' && dsB.location && dsB.location.location_id === 'location-b');
        diagnostics.crossing.iwps = { handoff_id: exitPacket.handoff_id, a_exit_handoff: aExitHandoff, b_arrival_handoff: bArrHandoff, target: 'location-b', native_teleportxr_teleport: false };

        // ===== (D) ghost-free presence hand-off across the two /wow/user registries =====
        const playerId = 'runtime-crosser';
        const contId = (exitPacket.avatar_context && exitPacket.avatar_context.continuity_id) || 'continuity-runtime';
        const regA = await postJson(baseA, '/fabric/presence/register', { player_id: playerId, avatar_id: 'avatar-local-001', continuity_id: contId, display_name: 'runtime crosser' });
        ok('presence registers on source A', regA.status === 201 || (regA.json && regA.json.registered), 'status=' + regA.status);
        const presA1 = await getJson(baseA, '/fabric/presence');
        ok('A registry lists the crosser (present in source before hand-over)', JSON.stringify(presA1.json || {}).includes(playerId));
        // the crossing's two explicit presence actions: depart the old world, register the new.
        const depA = await postJson(baseA, '/fabric/presence/depart', { player_id: playerId, reason: 'portal_departure' });
        const regB = await postJson(baseB, '/fabric/presence/register', { player_id: playerId, avatar_id: 'avatar-local-001', continuity_id: contId, display_name: 'runtime crosser' });
        ok('presence departs A + registers B (explicit crossing session actions)',
            (depA.json && depA.json.ok !== false) && (regB.status === 201 || (regB.json && regB.json.registered)));
        const presA2 = await getJson(baseA, '/fabric/presence');
        const presB2 = await getJson(baseB, '/fabric/presence');
        const inA = JSON.stringify(presA2.json || {}).includes(playerId);
        const inB = JSON.stringify(presB2.json || {}).includes(playerId);
        ok('GHOST-FREE: crosser is GONE from source A after hand-over', !inA);
        ok('GHOST-FREE: crosser is PRESENT in destination B after hand-over', inB);
        ok('GHOST-FREE: crosser is in EXACTLY ONE world (no ghost left behind)', (inA !== inB) && inB === true);
        diagnostics.presence = { player_id: playerId, in_A_after: inA, in_B_after: inB, ghost_free: (!inA && inB) };

        // ===== (E) honesty scoping — WIRE-LEVEL, NOT A SOURCE GREP =====
        //
        // WHAT THIS USED TO BE, AND WHY IT WAS A FRAUD:
        //
        //     const iwpsSrc = fs.readFileSync('web/iwps-query-teleport.mjs', 'utf8');
        //     ok('IWPS base-scoped: base_query_teleport:true', /base_query_teleport:\s*true/.test(iwpsSrc));
        //
        // THE VERIFIER FOR OUR IWPS CONFORMANCE CLAIM GREPPED THE FILE CONTAINING THE CLAIM
        // FOR THE CLAIM. It asserted that a string exists in a file. It would have passed
        // IDENTICALLY IF THE PROTOCOL DID NOT EXIST — and in fact the protocol did not
        // exist, and it passed, and it shipped a `✓` to a demo we show to standards people.
        // A verifier that greps for its own claim string is worse than no verifier: it
        // launders an assertion into evidence.
        //
        // WHAT IT IS NOW: it asserts BEHAVIOUR ON THE WIRE, and it locks the CLAIM to that
        // wire IN BOTH DIRECTIONS.
        //   - The capability we genuinely have (IWPS-SHAPED: two POSTs, Query->Teleport
        //     order, kebab-case, POST-only, two separate servers) is asserted against real
        //     HTTP. Remove it and this goes RED. (Proven: `--negative=route`.)
        //   - The capability we DO NOT have (the IWPS protocol itself) is asserted ABSENT
        //     from the wire — and the descriptor must SAY it is absent. Re-inflate the claim
        //     without changing the wire and this goes RED. (Proven: `--negative=claim`.)
        //     That is precisely the regression shipped and nothing caught.
        //
        // The descriptor is READ BY IMPORTING THE REAL MODULE, never by regex over its text.
        ok('portal proof_boundary.standards_conformance:false', pa.proof_boundary && pa.proof_boundary.standards_conformance === false);
        ok('portal proof_boundary.native_teleportxr_teleport:false', pa.proof_boundary && pa.proof_boundary.native_teleportxr_teleport === false);

        const iwpsMod = await import(pathToFileURL(path.join(REPO_ROOT, 'web', 'iwps-query-teleport.mjs')).href);
        // --negative=claim simulates someone re-inflating the claim without touching the wire.
        const IWPS = NEGATIVE === 'claim'
            ? Object.assign({}, iwpsMod.IWPS_CONFORMANCE, { iwps_conformance: true, base_query_teleport: true })
            : iwpsMod.IWPS_CONFORMANCE;

        // --- E1. The claim itself. Read from the real module object, not its source text. ---
        ok('IWPS claim is HONEST: iwps_conformance === false (the flag this proof refuses to flip)',
            IWPS.iwps_conformance === false, 'iwps_conformance=' + IWPS.iwps_conformance);
        ok('IWPS NOT INFLATED: base_query_teleport === false (we do NOT implement Query/Teleport)',
            IWPS.base_query_teleport === false, 'base_query_teleport=' + IWPS.base_query_teleport);
        ok('IWPS NOT INFLATED: full_conformance === false', IWPS.full_conformance === false);
        ok('IWPS claim string says SHAPED, not CONFORMANT',
            /IWPS-SHAPED/i.test(String(IWPS.claim)) && /NOT IWPS-CONFORMANT/i.test(String(IWPS.claim)),
            String(IWPS.claim).slice(0, 60) + '...');
        ok('IWPS security profile named as No-Security (§5.4.1)', /No-Security/.test(String(IWPS.profile)));

        // --- E2. THE WIRE: what we genuinely hold. IWPS-SHAPED. Behavioural. ---
        // Query leg and Teleport leg were REALLY POSTed above (exitR/arrR), to two REALLY
        // separate servers, in Query->Teleport order, on kebab-case paths. Assert that.
        ok('WIRE — IWPS-SHAPED: Query leg is a real POST accepted on source A (§5.1.1 order, call 1 of 2)',
            exitR.status === 201, 'POST ' + IWPS_QUERY_PATH + ' -> ' + exitR.status);
        ok('WIRE — IWPS-SHAPED: Teleport leg is a real POST accepted on destination B (§5.1.1 order, call 2 of 2)',
            arrR.status === 201, 'POST ' + IWPS_TELEPORT_PATH + ' -> ' + arrR.status);
        ok('WIRE — IWPS-SHAPED: the two legs hit two GENUINELY SEPARATE world servers (the topology IWPS assumes)',
            PORT_A !== PORT_B && baseA !== baseB, baseA + ' -> ' + baseB);
        ok('WIRE — IWPS-SHAPED: both paths are kebab-case (§3.5.3)',
            /^\/[a-z0-9]+(-[a-z0-9]+)*(\/[a-z0-9]+(-[a-z0-9]+)*)*$/.test(IWPS_QUERY_PATH) &&
            /^\/[a-z0-9]+(-[a-z0-9]+)*(\/[a-z0-9]+(-[a-z0-9]+)*)*$/.test(IWPS_TELEPORT_PATH),
            IWPS_QUERY_PATH + ' , ' + IWPS_TELEPORT_PATH);
        // §5.2.1: "All URLs SHALL be called with the POST method for security reasons."
        const getQuery = await getJson(baseA, IWPS_QUERY_PATH);
        ok('WIRE — IWPS-SHAPED: the crossing routes are POST-only — a GET is NOT accepted (§5.2.1 SHALL)',
            getQuery.status !== 201 && getQuery.status !== 200, 'GET ' + IWPS_QUERY_PATH + ' -> ' + getQuery.status);

        // --- E3. THE WIRE: what we DO NOT hold. The gap, asserted as fact. ---
        // These are the two MANDATORY fields of the IWPS Query response (§5.3.2 Table 2).
        // They are synthesized in the browser. They are NOT on the wire. PROVE it.
        const wireKeys = Object.keys(exitPacket || {});
        const IWPS_TABLE2_MANDATORY = [ 'approval', 'destinationUrl' ];
        const IWPS_WIRE_FIELDS = [ 'approval', 'destinationUrl', 'teleportId', 'teleportPin',
                                   'sourceAckUrl', 'sourceNackUrl', 'sourceClientType', 'expiration' ];
        const foundIwpsOnWire = IWPS_WIRE_FIELDS.filter((f) => wireKeys.includes(f));
        ok('WIRE — THE GAP: NOT ONE IWPS parameter is on the wire (the response is 100% demo-native snake_case)',
            foundIwpsOnWire.length === 0,
            'iwps fields found=' + (foundIwpsOnWire.join(',') || 'NONE') + ' · wire keys=' + wireKeys.join(','));
        ok('WIRE — THE GAP: the two MANDATORY IWPS Query-response fields (approval, destinationUrl — §5.3.2 Table 2) are ABSENT from the real response',
            IWPS_TABLE2_MANDATORY.every((f) => !wireKeys.includes(f)));
        ok('WIRE — THE GAP: the real request body is the demo-native snake_case {portal_id}, carrying no IWPS Table 1 parameter',
            !!exitPacket.handoff_id && !!exitPacket.portal_id !== undefined && !wireKeys.includes('teleportId'),
            'request body was {portal_id:"' + portalStringId + '"}');
        // §5.3.3 step 9 is a SHALL: the Destination Service SHALL call sourceAckUrl on
        // success / sourceNackUrl on failure. We serve NEITHER. They are dead strings.
        const ackR = await postJson(baseA, '/portal/source-ack', { teleportId: 'x' });
        const nackR = await postJson(baseA, '/portal/source-nack', { teleportId: 'x' });
        const ackServed = ackR.status === 200 || ackR.status === 201;
        const nackServed = nackR.status === 200 || nackR.status === 201;
        ok('WIRE — THE GAP: sourceAckUrl / sourceNackUrl (§5.3.3 step 9, a SHALL) are served by NO ROUTE — dead strings, exactly as the claim says',
            !ackServed && !nackServed,
            'POST /portal/source-ack -> ' + ackR.status + ' · POST /portal/source-nack -> ' + nackR.status);

        // --- E4. THE TWO-WAY LOCK. The claim must MATCH the observed wire. ---
        // Overclaim (claim says implemented, wire says absent) -> RED.
        // Underclaim (wire gains real IWPS, claim still says absent) -> RED, so whoever
        // earns conformance is FORCED to come back here and update the claim.
        const wireHasIwps = foundIwpsOnWire.length > 0;
        const wireHasAckNack = ackServed || nackServed;
        ok('LOCK — the CLAIM matches the WIRE on IWPS parameters (no overclaim, no stale underclaim)',
            (IWPS.base_query_teleport === true) === wireHasIwps,
            'claim.base_query_teleport=' + IWPS.base_query_teleport + ' · iwps-params-on-wire=' + wireHasIwps);
        ok('LOCK — the CLAIM matches the WIRE on ack/nack (§5.3.3 step 9)',
            /NOT IMPLEMENTED/i.test(String(IWPS.ack_nack)) === !wireHasAckNack,
            'claim.ack_nack="' + String(IWPS.ack_nack).slice(0, 40) + '..." · ack/nack-served=' + wireHasAckNack);
        ok('LOCK — iwps_conformance may only be true if the destination actually implements the IWPS APIs',
            !(IWPS.iwps_conformance === true && !wireHasIwps),
            'iwps_conformance=' + IWPS.iwps_conformance + ' · iwps-params-on-wire=' + wireHasIwps);

        diagnostics.honesty = {
            portal_standards_conformance: false,
            portal_native_teleportxr_teleport: false,
            // DERIVED from the module object + the observed wire — never from a source grep.
            iwps_conformance: IWPS.iwps_conformance,
            iwps_base_query_teleport: IWPS.base_query_teleport,
            iwps_full_conformance: IWPS.full_conformance,
            iwps_wire: {
                iwps_parameters_on_the_wire: wireHasIwps,
                iwps_fields_found_on_wire: foundIwpsOnWire,
                observed_wire_keys: wireKeys,
                ack_nack_routes_served: wireHasAckNack,
                ack_status: ackR.status,
                nack_status: nackR.status,
                query_leg_post_status: exitR.status,
                teleport_leg_post_status: arrR.status,
                get_on_query_path_status: getQuery.status,
                separate_servers: baseA !== baseB,
            },
            iwps_verifier_note:
                'runtime: the old checks READ web/iwps-query-teleport.mjs AS TEXT and regex-tested it '
                + 'for `base_query_teleport: true` — a verifier that greps for its own claim string. It would have '
                + 'passed with the protocol entirely absent. These checks assert the WIRE and lock the claim to it '
                + 'in both directions. Negative-tested: `--negative=route` (capability removed) and `--negative=claim` '
                + '(claim re-inflated) both drive this validation RED.',
        };

        // ===== (F) CONTINUITY — ASSERTED AS A CONSEQUENCE OF THE RUN =====
        //
        // WHAT THIS USED TO BE, AND WHY IT WAS A FRAUD:
        //
        //     const laSrc = fs.readFileSync('web/live-adapter.js', 'utf8');
        //     ok(C.ISO_X, /frame\.right\[0\]\s*\*\s*-v\.x/.test(laSrc));
        //     ...
        //     evidence.continuity_static = { isometry_x_and_z_negated: derived(C.ISO_X, C.ISO_Z), ... };
        //
        // The PUBLISHED CONTINUITY EVIDENCE WAS DERIVED FROM REGEX HITS ON A SOURCE FILE. It
        // asserted that certain characters appear in live-adapter.js. Continuity — the one thing a
        // crossing exists to preserve — was never once observed CROSSING anything. Two servers were
        // standing right there, a crossing was being driven through them, and the proof went and
        // read a file instead.
        //
        // And underneath it lay a second, quieter lie: the ONE behavioural continuity check in this
        // file (block C, 'continuity_id preserved across the crossing') compared B's post-arrival
        // continuity_id to A's exit-packet continuity_id — and BOTH nodes boot with the SAME factory
        // identity, 'avatar-local-001'. It compared a default to itself. It passed with the
        // continuity field stripped off the wire entirely. Both halves of the continuity claim were
        // therefore unfalsifiable, which is the only kind of claim worth nothing.
        //
        // WHAT IT IS NOW. The crosser was given a MINTED identity (block C) that the destination
        // cannot produce by accident and that differs from avatar_id, so a fallback is visible.
        // Continuity is then OBSERVED CROSSING, at every point it must survive:
        //     A's live state -> the exit packet ON THE WIRE -> B's avatar record -> B's arrival
        //     receipt -> B's WoW /wow/user registry -> B's presence registry
        // and then it is done AGAIN with a DIFFERENT identity, which catches a destination that
        // merely echoes a constant. Every field of evidence.continuity below is READ BACK OFF THE
        // WIRE from that run. Nothing is derived from source text.
        //
        // Negative-tested: `--negative=continuity` deletes avatar_context.continuity_id from the
        // arrival body on the wire into B. The crossing still completes — 201, handoff_id
        // correlated, presence ghost-free — and ONLY these checks go red. Which is the point.

        // --- F1. The identity was DISTINGUISHABLE before it crossed. Without this, everything
        //         below could be satisfied by two servers sharing a default. ---
        ok('CONTINUITY setup: the destination B\'s FACTORY identity is the shared default (so an un-minted check would be a tautology)',
            baselineB === FACTORY_IDENTITY, 'B factory continuity_id=' + baselineB);
        ok('CONTINUITY setup: the crosser\'s minted continuity_id differs from the factory default AND from avatar_id (a fallback would be VISIBLE)',
            MINTED_1 !== FACTORY_IDENTITY && MINTED_1 !== CROSSER_AVATAR_ID && !!MINTED_1, MINTED_1);
        ok('CONTINUITY setup: destination B has NEVER heard of the minted identity before the crossing (/wow/user/{id} -> 404)',
            wowUserBefore.status === 404, 'GET /wow/user/' + MINTED_1 + ' -> ' + wowUserBefore.status);
        ok('CONTINUITY setup: the minted identity is installed on SOURCE A via A\'s real arrival path (201)',
            seedR.status === 201, 'status=' + seedR.status);
        ok('CONTINUITY on the SOURCE: A\'s live avatar record now carries the minted continuity_id',
            dsASeed.avatar && dsASeed.avatar.continuity_id === MINTED_1, dsASeed.avatar && dsASeed.avatar.continuity_id);

        // --- F2. Continuity travels ON THE WIRE, read out of the SOURCE's live state. ---
        ok('CONTINUITY on the WIRE: the exit packet carries the SOURCE\'s LIVE continuity_id (not a constant, not a default)',
            exitPacket.avatar_context && exitPacket.avatar_context.continuity_id === MINTED_1,
            exitPacket.avatar_context && exitPacket.avatar_context.continuity_id);
        ok('CONTINUITY is its OWN identity: continuity_id is neither the handoff_id nor the avatar_id (not an echo of either)',
            MINTED_1 !== exitPacket.handoff_id && MINTED_1 !== CROSSER_AVATAR_ID,
            'continuity=' + MINTED_1 + ' handoff=' + exitPacket.handoff_id + ' avatar=' + CROSSER_AVATAR_ID);

        // --- F3. Continuity is OBSERVABLE IN THE DESTINATION'S STATE after the crossing. ---
        const bCont = dsB.avatar && dsB.avatar.continuity_id;
        const bArrivalRcpt = (dsB.debug && dsB.debug.handoff && dsB.debug.handoff.last_arrival) || {};
        ok('CONTINUITY in the DESTINATION: B\'s avatar record carries the crosser\'s minted continuity_id after arrival',
            bCont === MINTED_1, 'B.avatar.continuity_id=' + bCont);
        ok('CONTINUITY CHANGED AS A CONSEQUENCE: B no longer reports its factory identity (the check above cannot pass by default)',
            bCont !== baselineB, 'before=' + baselineB + ' after=' + bCont);
        ok('CONTINUITY receipt: B\'s arrival record binds the minted continuity_id to THIS crossing\'s handoff_id',
            bArrivalRcpt.continuity_id === MINTED_1 && bArrivalRcpt.handoff_id === exitPacket.handoff_id,
            'arrival.continuity_id=' + bArrivalRcpt.continuity_id + ' arrival.handoff_id=' + bArrivalRcpt.handoff_id);
        ok('CONTINUITY receipt: B preserved the crosser\'s avatar_id alongside its continuity_id',
            bArrivalRcpt.preserved_avatar_id === CROSSER_AVATAR_ID, 'preserved_avatar_id=' + bArrivalRcpt.preserved_avatar_id);

        // --- F4. Continuity is observable on the WoW-native surface, and in presence. ---
        const wowUserAfter = await getJson(baseB, '/wow/user/' + encodeURIComponent(MINTED_1));
        ok('CONTINUITY on the WoW SURFACE: the identity that 404\'d on B before the crossing RESOLVES on B after it (/wow/user/{continuity_id} -> 200)',
            wowUserAfter.status === 200, 'GET /wow/user/' + MINTED_1 + ' -> ' + wowUserAfter.status +
                ' (was ' + wowUserBefore.status + ' before the crossing)');
        // The WoW `User` schema is id/name/AvatarURI/geoPose; the demo's local identity truth rides
        // in webofworlds_extension. Read it where it actually lives.
        const wowUserExt = (wowUserAfter.json && wowUserAfter.json.webofworlds_extension) || {};
        ok('CONTINUITY on the WoW SURFACE: the resolved /wow/user record reports the minted continuity_id (webofworlds_extension.continuity_id)',
            wowUserExt.continuity_id === MINTED_1, 'webofworlds_extension.continuity_id=' + wowUserExt.continuity_id);
        ok('CONTINUITY on the WoW SURFACE: the destination\'s /wow/user record accepts the minted continuity_id as a resolving alias',
            Array.isArray(wowUserExt.accepted_aliases) && wowUserExt.accepted_aliases.indexOf(MINTED_1) !== -1,
            'accepted_aliases=' + JSON.stringify(wowUserExt.accepted_aliases));
        const presBEntries = (presB2.json && (presB2.json.avatars || presB2.json.players || presB2.json.occupancy)) || [];
        const presBList = Array.isArray(presBEntries) ? presBEntries : (presBEntries.avatars || []);
        const crosserInB = presBList.find(e => e && e.player_id === playerId) || null;
        ok('CONTINUITY in the DESTINATION PRESENCE registry: the crosser\'s registered entry carries the minted continuity_id',
            !!crosserInB && crosserInB.continuity_id === MINTED_1,
            crosserInB ? ('entry.continuity_id=' + crosserInB.continuity_id) : 'crosser not found in B presence registry');

        // --- F5. THE CONSTANT-ECHO TEST. A destination that hardcoded/echoed one id would have
        //         satisfied everything above. Cross a SECOND, DIFFERENT identity and demand B tracks
        //         it. Continuity must be a FUNCTION OF THE WIRE, not a stored value. ---
        await postJson(baseA, '/reset'); await postJson(baseB, '/reset');
        await postJson(baseA, IWPS_TELEPORT_PATH, seedArrivalPacket(aWorldId, aLocationId, MINTED_2));
        const exit2 = (await postJson(baseA, IWPS_QUERY_PATH, { portal_id: portalStringId })).json || {};
        const arr2R = await postJson(baseB, IWPS_TELEPORT_PATH, exit2);
        const dsB2 = (await getJson(baseB, '/debug/state')).json || {};
        const bCont2 = dsB2.avatar && dsB2.avatar.continuity_id;
        ok('CONTINUITY second crossing accepted on B (201)', arr2R.status === 201, 'status=' + arr2R.status);
        ok('CONTINUITY IS WIRE-DERIVED, NOT A STORED CONSTANT: a SECOND crossing with a DIFFERENT minted identity makes B report THAT identity',
            bCont2 === MINTED_2 && MINTED_2 !== MINTED_1, 'crossing1 -> B=' + bCont + ' · crossing2 -> B=' + bCont2);
        ok('CONTINUITY: the two crossings carried DIFFERENT identities and B distinguished them (a constant echo is ruled out)',
            bCont !== bCont2 && bCont === MINTED_1 && bCont2 === MINTED_2, bCont + ' != ' + bCont2);

        // EVERY FIELD BELOW WAS READ BACK OFF THE WIRE FROM THE RUN ABOVE. None is derived from
        // source text; none is a literal `true` typed into an evidence file.
        diagnostics.continuity = {
            proof_class: 'BEHAVIOURAL — a real crossing driven against the two real backends; every value observed on the wire or in the destination\'s state',
            crosser_avatar_id: CROSSER_AVATAR_ID,
            destination_factory_identity: baselineB,
            minted_continuity_id: MINTED_1,
            source_a_holds_minted: dsASeed.avatar && dsASeed.avatar.continuity_id === MINTED_1,
            on_the_wire: exitPacket.avatar_context && exitPacket.avatar_context.continuity_id,
            destination_b_after_crossing: bCont,
            changed_from_factory_default: bCont !== baselineB,
            arrival_receipt: {
                continuity_id: bArrivalRcpt.continuity_id || null,
                handoff_id: bArrivalRcpt.handoff_id || null,
                preserved_avatar_id: bArrivalRcpt.preserved_avatar_id || null,
                bound_to_this_crossing: bArrivalRcpt.handoff_id === exitPacket.handoff_id,
            },
            wow_user_surface: {
                before_crossing_status: wowUserBefore.status,
                after_crossing_status: wowUserAfter.status,
                after_crossing_continuity_id: wowUserExt.continuity_id || null,
                after_crossing_accepted_aliases: wowUserExt.accepted_aliases || null,
                note: 'the destination\'s WoW /wow/user registry did NOT resolve this identity before the crossing (404) and DOES after it (200)',
            },
            presence_registry_continuity_id: crosserInB ? crosserInB.continuity_id : null,
            constant_echo_ruled_out: {
                second_minted_continuity_id: MINTED_2,
                destination_b_after_second_crossing: bCont2,
                destination_tracked_the_wire: bCont === MINTED_1 && bCont2 === MINTED_2 && bCont !== bCont2,
            },
            negative_tested: '--negative=continuity deletes avatar_context.continuity_id from the arrival body on the wire into B; '
                + 'the crossing still completes (201, handoff_id correlated, presence ghost-free) and ONLY these checks go red.',
        };

        // ===== (F2) CLIENT-side crossing MACHINERY — a SOURCE TRIPWIRE, and labeled as one =====
        // These regexes are NOT a continuity proof and are no longer published as one. They are a
        // regression tripwire on the browser-side machinery (no-reload in-memory promotion, the
        // (x,y,z)->(-x,y,-z) portal isometry, the WoW re-source) that this Node proof genuinely
        // CANNOT execute: the adapter/controller are browser ES modules in a CommonJS package and do
        // not load under Node. Deleting that machinery must still break something, so the tripwire stays
        // — but it is filed under what it actually is (source presence), NOT under continuity, and
        // the RUNTIME proof of it is the browser e2e-driver's, not this file's.
        const adapterSrc = fs.readFileSync(path.join(REPO_ROOT, 'web', 'live-adapter.js'), 'utf8');
        const traversalSrc = fs.readFileSync(
            path.join(REPO_ROOT, 'web', 'live-adapter-portal-traversal-controller.mjs'), 'utf8');
        const geometrySrc = fs.readFileSync(
            path.join(REPO_ROOT, 'web', 'live-adapter-portal-geometry.mjs'), 'utf8');
        ok(C.MACH_COMPLETE, /_completePlayerCrossing\s*\(/.test(traversalSrc));
        ok(C.MACH_PROMOTE, /_promoteActiveEndpoint\s*\(/.test(adapterSrc));
        ok(C.NO_RELOAD_DOC, /never\s+.?location\.reload\(\)/.test(traversalSrc));
        ok(C.NO_RELOAD_MECH, /promoted to the root frame of the SAME context/.test(adapterSrc));
        ok(C.ISO_X,
            /x:\s*-\(Number\(local\s*&&\s*local\.x\)\s*\|\|\s*0\)/.test(geometrySrc) &&
            /properPortalLocalRotation\(localOffset\)/.test(geometrySrc));
        ok(C.ISO_Z,
            /z:\s*-\(Number\(local\s*&&\s*local\.z\)\s*\|\|\s*0\)/.test(geometrySrc) &&
            /properPortalLocalRotation\(localForward\)/.test(geometrySrc));
        ok(C.RESRC_WIRED, /_resolveWowSceneGraph\s*\(/.test(adapterSrc));
        ok(C.RESRC_PROMO, /destination_scene_source\s*=\s*promoted\.destinationSceneSource/.test(traversalSrc));
        ok(C.RESRC_HONEST, /msf_dependency:\s*false/.test(adapterSrc));

        const msfHonest = derived(C.RESRC_HONEST);
        diagnostics.client_machinery_source_tripwire = {
            proof_class: 'SOURCE-PRESENCE TRIPWIRE — NOT a behavioural validation and NOT diagnostics of continuity. '
                + 'It asserts the browser-side crossing completion still EXISTS in the canonical traversal '
                + 'controller, broad promotion/re-source still EXISTS in web/live-adapter.js, and the proper '
                + 'local isometry still exists in web/live-adapter-portal-geometry.mjs. '
                + 'The continuity CLAIM is proven behaviourally in diagnostics.continuity; the runtime validation of '
                + 'THIS machinery (nav-count=1 / in-memory promotion / camera isometry) is the browser e2e-driver\'s.',
            no_reload_source_present: derived(C.NO_RELOAD_DOC, C.NO_RELOAD_MECH),
            in_memory_promotion_source_present: derived(C.MACH_COMPLETE, C.MACH_PROMOTE),
            isometry_x_and_z_negated_source_present: derived(C.ISO_X, C.ISO_Z),
            resource_wired_into_promotion_source_present: derived(C.RESRC_WIRED, C.RESRC_PROMO),
            msf_dependency: msfHonest === true ? false : null,
            msf_dependency_source_asserted: msfHonest,
            runtime_navcount_proof: 'e2e-driver (browser) mainThreeWindowEvidence nav-count=1 / promotion_count=1 — '
                + (load1 >= LOAD_GATE
                    ? 'DEFERRED to a load window / runtime (1-min load ' + load1.toFixed(2) + ' >= gate ' + LOAD_GATE + ')'
                    : 'NOT RUN HERE by design: this is the deterministic Node validation (1-min load ' + load1.toFixed(2)
                      + ' < gate ' + LOAD_GATE + '; the browser validation is the e2e-driver\'s, tracked by runtime)'),
            load_at_run: Number(load1.toFixed(2)),
            load_gate: LOAD_GATE,
        };
    } finally {
        try { await a.closeAll(); } catch (e) {}
        try { await b.closeAll(); } catch (e) {}
    }

    diagnostics.checks = checks;
    diagnostics.assertions = { ok: problems.length === 0, count: checks.length, passed: checks.filter(c => c.pass).length, problems };
    if (NEGATIVE) diagnostics.negative_mode = NEGATIVE;
    const evDir = path.join(REPO_ROOT, 'diagnostics');
    try { fs.mkdirSync(evDir, { recursive: true }); } catch (e) {}
    // A negative run must NEVER overwrite the real evidence artifact.
    const evPath = path.join(evDir, NEGATIVE
        ? 'runtime-crossing-validation.negative-' + NEGATIVE + '.json'
        : 'runtime-crossing-validation.json');
    fs.writeFileSync(evPath, JSON.stringify(diagnostics, null, 2) + '\n', 'utf8');

    console.log('\n=== runtime world-crossing-on-WoW validation' + (NEGATIVE ? '  [NEGATIVE=' + NEGATIVE + ']' : '') + ' ===');
    for (const c of checks) console.log('  ' + (c.pass ? '[PASS] ' : '[FAIL] ') + c.name + (c.detail ? '  (' + c.detail + ')' : ''));
    console.log('\nevidence -> ' + evPath);
    console.log('assertions: ' + (problems.length === 0 ? ('ALL PASS (' + checks.length + ')') : ('FAIL -> ' + problems.join('; '))));

    // ---- NEGATIVE MODE: the exit code is INVERTED. Red is the required outcome. ----
    if (NEGATIVE) {
        const wentRed = problems.length > 0;
        console.log('\n=== NEGATIVE TEST (' + NEGATIVE + ') ===');
        if (wentRed) {
            console.log('NEGATIVE TEST PASSED — the capability/claim was broken and the validation went RED (' +
                problems.length + ' failing check' + (problems.length === 1 ? '' : 's') + ').');
            console.log('This verifier can fail. It is a verifier.');
            process.exit(0);
        }
        console.error('NEGATIVE TEST FAILED — the capability/claim was broken and THE validation STILL PASSED.');
        console.error('THE VERIFIER IS BLIND. This is the defect class runtime exists to kill. Exit 3.');
        process.exit(3);
    }
    process.exit(problems.length === 0 ? 0 : 1);
}

main().catch(err => { console.error('runtime validation crashed:', err); process.exit(2); });
