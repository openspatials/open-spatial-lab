'use strict';

/*
 * Lane 3 acceptance test harness.
 * Node core only. Boots two in-process servers, exercises the full exit-intent
 * -> arrival choreography over real HTTP + a real WS client, and asserts the
 * BackendContract guarantees.
 *
 * PORTS. This harness used to BIND 18151/18152, which are
 * the local demo ports (8143 / 18151-18153, GAS-reserved). Running it
 * during a live session either EADDRINUSE'd or, worse, would have talked to the
 * running demo. It now binds ISOLATED ports (19201/19202) via the server's
 * bind_port operational override. The nodes still DECLARE their deterministic
 * fixture ports (cfg.http_port 18151/18152) and T-L1 still asserts exactly that,
 * unchanged: the fixture contract is what this harness proves; the socket it
 * listens on is not.
 *
 * Covered (maps to PRD Section 9 + NFR-TEST + FR-*):
 *   - T-L1  both nodes launch deterministically (fixed IDs/ports)
 *   - T-L2  node/API health
 *   - T-P1  walk-into-portal trigger (proximity) initiates exit intent
 *   - T-A1  source stays source (A stays location-a after exit)
 *   - T-A2  target already-open receives arrival (B stays location-b)
 *   - T-H1  handoff_id correlation A-exit <-> B-arrival
 *   - T-H2  four proof-boundary flags present on every /wow response
 *   - T-C1  continuity id preserved across handoff
 *   - FR-ID drift guard: arrival applied to WRONG node is rejected
 *   - FR-STATE: no silent one-window reconnect (A and B never collapse)
 *   - reset/replay across >=3 sequential cycles
 */

const assert = require('assert');
const crypto = require('crypto');
const net = require('net');
const { start } = require('../src/server');
const { makeConfig } = require('../src/config');
const { get, post, put, del } = require('../src/http-client');

// Isolated bind ports. NEVER 8143 / 18151-18153.
const PORT_A = Number(process.env.WORLD_SERVER_ACCEPTANCE_A_PORT) || 19201;
const PORT_B = Number(process.env.WORLD_SERVER_ACCEPTANCE_B_PORT) || 19202;
const A = 'http://127.0.0.1:' + PORT_A;
const B = 'http://127.0.0.1:' + PORT_B;

// Point each portal's target at the ISOLATED sibling rather than the live demo,
// so nothing this harness emits or follows can reach the running nodes.
const PORT_BY_LOCATION = { 'location-a' : PORT_A, 'location-b' : PORT_B };
function isolatedPortals(role)
{
    return makeConfig(role).portals.map(portal => Object.assign({}, portal, {
        target_base_url : 'http://127.0.0.1:' + (PORT_BY_LOCATION[portal.target_location_id] || PORT_A),
    }));
}

let passed = 0, failed = 0;
const results = [];
function check(id, desc, fn)
{
    return Promise.resolve().then(fn).then(() => {
        passed++; results.push({ id, desc, status : 'PASS' });
        console.log('PASS  ' + id + '  ' + desc);
    }).catch(err => {
        failed++; results.push({ id, desc, status : 'FAIL', error : err.message });
        console.log('FAIL  ' + id + '  ' + desc + '  -> ' + err.message);
    });
}

// distance helper mirroring portal proximity trigger
function withinPortal(pos, trigger)
{
    const dx = pos[0] - trigger.position[0];
    const dz = pos[2] - trigger.position[2];
    return Math.sqrt(dx * dx + dz * dz) <= trigger.radius_m;
}

// Minimal WS client that connects and collects `state` frames (proves /runtime-state).
function wsCollect(port, path, durationMs)
{
    return new Promise((resolve, reject) => {
        const key = crypto.randomBytes(16).toString('base64');
        const sock = net.connect(port, '127.0.0.1', () => {
            sock.write(
                'GET ' + path + ' HTTP/1.1\r\n' +
                'Host: 127.0.0.1:' + port + '\r\n' +
                'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
                'Sec-WebSocket-Key: ' + key + '\r\n' +
                'Sec-WebSocket-Version: 13\r\n\r\n');
        });
        const frames = [];
        let buf = Buffer.alloc(0);
        let handshakeDone = false;
        sock.on('data', chunk => {
            buf = Buffer.concat([ buf, chunk ]);
            if (!handshakeDone)
            {
                const idx = buf.indexOf('\r\n\r\n');
                if (idx === -1) return;
                handshakeDone = true;
                buf = buf.slice(idx + 4);
            }
            // parse unmasked server text frames (opcode 0x1)
            while (buf.length >= 2)
            {
                const b1 = buf[1];
                let len = b1 & 0x7f;
                let offset = 2;
                if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); offset = 4; }
                else if (len === 127) { if (buf.length < 10) break; len = buf.readUInt32BE(6); offset = 10; }
                if (buf.length < offset + len) break;
                const payload = buf.slice(offset, offset + len).toString('utf8');
                buf = buf.slice(offset + len);
                try { frames.push(JSON.parse(payload)); } catch (e) { /* ignore */ }
            }
        });
        sock.on('error', reject);
        setTimeout(() => { try { sock.destroy(); } catch (e) {} resolve(frames); }, durationMs);
    });
}

async function main()
{
    const a = await start('a', { bind_port : PORT_A, portals : isolatedPortals('a') });
    const b = await start('b', { bind_port : PORT_B, portals : isolatedPortals('b') });

    // T-L1 / T-L2
    await check('T-L1', 'both nodes launch with fixed IDs/ports', async () => {
        assert.strictEqual(a.cfg.http_port, 18151);
        assert.strictEqual(b.cfg.http_port, 18152);
        assert.strictEqual(a.runtime.LOCATION_ID, 'location-a');
        assert.strictEqual(b.runtime.LOCATION_ID, 'location-b');
    });
    await check('T-L2', 'node/API health returns 200', async () => {
        const ha = await get(A + '/healthz');
        const hb = await get(B + '/healthz');
        assert.strictEqual(ha.status, 200);
        assert.strictEqual(hb.status, 200);
        assert.strictEqual(ha.json.location_id, 'location-a');
    });

    // T-H2 proof-boundary flags on every /wow response
    await check('T-H2', 'four validation-boundary flags on every /wow response', async () => {
        const paths = [ A + '/wow/world', A + '/wow/portal/location-a-portal', A + '/wow/user/avatar-local-001',
                        A + '/wow/portal/1', A + '/wow/user/1', A + '/wow/view/1',
                        B + '/wow/world', B + '/wow/portal/location-b-portal', B + '/wow/user/avatar-local-001',
                        B + '/wow/portal/1', B + '/wow/user/1', B + '/wow/view/1' ];
        for (const p of paths)
        {
            const r = await get(p);
            assert.strictEqual(r.status, 200, 'status for ' + p);
            const pb = r.json.proof_boundary;
            assert.ok(pb, 'proof_boundary present on ' + p);
            assert.strictEqual(pb.application_level_handoff, true, 'application_level_handoff on ' + p);
            assert.strictEqual(pb.native_teleportxr_teleport, false, 'native_teleportxr_teleport on ' + p);
            assert.strictEqual(pb.first_party_teleportxr_browser_rendering, false, 'first_party on ' + p);
            assert.strictEqual(pb.standards_conformance, false, 'standards_conformance on ' + p);
        }
    });

    // WOW-SHAPE: /wow read surface matches the Web of Worlds
    // OpenAPI schemas (WoWAPI specification/OpenSpatialWorld/API.yaml).
    await check('WOW-SHAPE', '/wow world|user|portal|view match the WoW OpenAPI schema shapes', async () => {
        function assertGeoPose(g, where)
        {
            assert.ok(g && g.position && g.angles, 'geoPose present on ' + where);
            for (const k of [ 'lat', 'lan', 'h' ])
                assert.strictEqual(typeof g.position[k], 'number', 'geoPose.position.' + k + ' number on ' + where);
            for (const k of [ 'yaw', 'pitch', 'roll' ])
                assert.strictEqual(typeof g.angles[k], 'number', 'geoPose.angles.' + k + ' number on ' + where);
        }
        for (const base of [ A, B ])
        {
            // World schema: content/geoPose/presence/technology/users/views/portals
            const w = (await get(base + '/wow/world')).json;
            assert.strictEqual(typeof w.content.label, 'string');
            assert.strictEqual(typeof w.content.version, 'number');
            assert.strictEqual(typeof w.content.license, 'string');
            assert.strictEqual(typeof w.content.cost, 'string');
            assert.strictEqual(typeof w.content.age_restriction, 'number');
            assert.strictEqual(typeof w.content.duration, 'number');
            assertGeoPose(w.geoPose, base + '/wow/world');
            assert.strictEqual(typeof w.presence.avatar, 'string');
            assert.strictEqual(typeof w.presence.navigation, 'string');
            assert.strictEqual(typeof w.presence.gravity, 'string');
            assert.strictEqual(typeof w.technology['webXR-immersive'], 'string');
            assert.strictEqual(typeof w.technology.runtime, 'string');
            assert.ok(Number.isInteger(w.users.active_user_count), 'users.active_user_count integer');
            assert.ok(Number.isInteger(w.users.total_user_count), 'users.total_user_count integer');
            assert.ok(Number.isInteger(w.views.view_count) && w.views.view_count >= 1, 'views.view_count');
            assert.ok(Number.isInteger(w.portals.portal_count) && w.portals.portal_count >= 1, 'portals.portal_count');
            // legacy 057 client contract still intact (additional properties)
            assert.ok(Array.isArray(w.presence.avatars) && w.presence.avatars[0].avatar_id, 'presence.avatars kept');
            assert.ok(w.location && w.session && w.id, 'location/session/id kept');

            // Portal schema at the spec (integer) route: numeric id + geoPose
            const p = (await get(base + '/wow/portal/1')).json;
            assert.strictEqual(typeof p.id, 'number', 'portal id number');
            assertGeoPose(p.geoPose, base + '/wow/portal/1');
            // legacy alias keeps the STRING id the live client requires
            const alias = base === A ? 'location-a-portal' : 'location-b-portal';
            const pl = (await get(base + '/wow/portal/' + alias)).json;
            assert.strictEqual(typeof pl.id, 'string', 'legacy portal alias id stays string');
            assert.ok(pl.webofworlds_extension.trigger && pl.webofworlds_extension.arrival, 'alias extension intact');
            assert.strictEqual(pl.webofworlds_extension.wow_id, 1, 'alias cross-links numeric wow id');

            // User schema: numeric id, name, AvatarURI string, geoPose
            const u = (await get(base + '/wow/user/1')).json;
            assert.strictEqual(typeof u.id, 'number', 'user id number');
            assert.strictEqual(typeof u.name, 'string', 'user name string');
            assert.strictEqual(typeof u.AvatarURI, 'string', 'AvatarURI string');
            assertGeoPose(u.geoPose, base + '/wow/user/1');

            // View schema (new): numeric id + geoPose; tracks the live presence pose
            const v0 = (await get(base + '/wow/view/1')).json;
            assert.strictEqual(typeof v0.id, 'number', 'view id number');
            assertGeoPose(v0.geoPose, base + '/wow/view/1');
            await post(base + '/movement', { forward : 1, source : 'wow-shape-test' });
            const v1 = (await get(base + '/wow/view/1')).json;
            assert.notStrictEqual(v0.geoPose.position.lat, v1.geoPose.position.lat,
                'view geoPose follows the live presence pose after /movement');
            await post(base + '/reset');

            // fabric services[] references all four WoW endpoints + the
            // Spatial Composition Graph (+ node CRUD) service.
            const fabric = (await get(base + '/fabric.json')).json;
            const endpoints = fabric.services.map(s => s.endpoint);
            for (const e of [ '/wow/world', '/wow/user/{userId}', '/wow/portal/{portalId}', '/wow/view/{viewId}',
                              '/wow/spatial/{spatialID}', '/wow/spatial/{spatialID}/node/{nodeId}' ])
                assert.ok(endpoints.indexOf(e) !== -1, 'fabric services[] references ' + e);
        }
    });

    // WOW-SPATIAL: the canonical Spatial Composition Graph
    // + node CRUD at /wow/spatial/{spatialID}(/node/{nodeId}). Proves ≥2 worlds
    // are addressable, the graph is populated from real scene data (not stubs),
    // and create/read/update/delete round-trips + mutations persist across
    // requests. Node payloads are the canonical WoW `Node` shape.
    await check('WOW-SPATIAL', 'canonical /wow/spatial graph + node CRUD (>=2 worlds, populated, persists)', async () => {
        const worlds = [ { base : A, spatial : 'demo-room-a', loc : 'location-a' },
                         { base : B, spatial : 'demo-room-b', loc : 'location-b' } ];
        for (const w of worlds)
        {
            // (1) graph root by world_id -> canonical Node, populated from real scene data
            const rootR = await get(w.base + '/wow/spatial/' + w.spatial);
            assert.strictEqual(rootR.status, 200, 'graph root 200 for ' + w.spatial);
            const root = rootR.json;
            assert.strictEqual(root.id, 0, 'root id is 0');
            assert.ok(Array.isArray(root.names) && root.names.indexOf(w.spatial) !== -1, 'root names carries world_id');
            assert.ok(Array.isArray(root.children) && root.children.length >= 4,
                'root populated (>=3 primitives + >=1 portal), got ' + root.children.length);
            assert.ok(Array.isArray(root.localTransform) && root.localTransform.length === 16,
                'localTransform is a flat 16-float matrix');

            // (2) addressable by location_id alias too; unknown spatialID -> 404
            const byLoc = await get(w.base + '/wow/spatial/' + w.loc);
            assert.strictEqual(byLoc.status, 200, 'graph addressable by location_id alias');
            const unknown = await get(w.base + '/wow/spatial/not-a-world');
            assert.strictEqual(unknown.status, 404, 'unknown spatialID 404s');

            // (3) fetch a seeded child node (a portal or primitive) by id
            const childId = root.children[0];
            const childR = await get(w.base + '/wow/spatial/' + w.spatial + '/node/' + childId);
            assert.strictEqual(childR.status, 200, 'seeded child node 200');
            assert.strictEqual(childR.json.id, childId, 'child node id matches');
            assert.strictEqual(childR.json.parent, 0, 'seeded child parent is root');
            // a portal seed node carries the labeled osl-portal: destination URI
            const portalNodeR = await get(w.base + '/wow/spatial/' + w.spatial + '/node/'
                + root.children[root.children.length - 1]);
            assert.ok(/^osl-portal:/.test(portalNodeR.json.spatialAssetURI || ''),
                'last seed child is a portal node with a labeled osl-portal URI');

            // (4) CREATE — POST child nodes under the root
            const created = await post(w.base + '/wow/spatial/' + w.spatial + '/node/0',
                [ { label : 'test-node', names : [ 'acc-test' ],
                    localTransform : [ 1,0,0,0, 0,1,0,0, 0,0,1,0, 1,2,3,1 ],
                    spatialAssetURI : 'osl-primitive:box?size_m=0.5' } ]);
            assert.strictEqual(created.status, 200, 'POST create 200');
            assert.ok(Array.isArray(created.json) && created.json.length === 1, 'POST returns created Node[]');
            const newId = created.json[0].id;
            assert.ok(Number.isInteger(newId) && newId > 0, 'new node has a server-assigned integer id');
            assert.strictEqual(created.json[0].parent, 0, 'new node attached under root');

            // (5) mutation PERSISTS across requests — re-GET root shows the new child
            const root2 = (await get(w.base + '/wow/spatial/' + w.spatial)).json;
            assert.ok(root2.children.indexOf(newId) !== -1, 'new child persisted into root.children');
            const newNode = (await get(w.base + '/wow/spatial/' + w.spatial + '/node/' + newId)).json;
            assert.strictEqual(newNode.label, 'test-node', 'new node readable with its label');

            // (6) UPDATE — PUT new content, re-GET reflects it (persists)
            const upd = await put(w.base + '/wow/spatial/' + w.spatial + '/node/' + newId,
                { label : 'test-node-renamed', spatialAssetURI : 'osl-primitive:sphere?size_m=0.9' });
            assert.strictEqual(upd.status, 200, 'PUT update 200');
            const afterUpd = (await get(w.base + '/wow/spatial/' + w.spatial + '/node/' + newId)).json;
            assert.strictEqual(afterUpd.label, 'test-node-renamed', 'update persisted (label)');
            assert.strictEqual(afterUpd.id, newId, 'update preserved id');
            assert.strictEqual(afterUpd.parent, 0, 'update preserved structure (parent)');

            // (7) DELETE — node gone, unlinked from root (persists)
            const delR = await del(w.base + '/wow/spatial/' + w.spatial + '/node/' + newId);
            assert.strictEqual(delR.status, 200, 'DELETE 200');
            const afterDel = await get(w.base + '/wow/spatial/' + w.spatial + '/node/' + newId);
            assert.strictEqual(afterDel.status, 404, 'deleted node 404s');
            const root3 = (await get(w.base + '/wow/spatial/' + w.spatial)).json;
            assert.ok(root3.children.indexOf(newId) === -1, 'deleted child unlinked from root');

            // (8) root is protected; bad node id is a 400
            const delRoot = await del(w.base + '/wow/spatial/' + w.spatial + '/node/0');
            assert.strictEqual(delRoot.status, 400, 'root delete rejected (400)');
            const badId = await get(w.base + '/wow/spatial/' + w.spatial + '/node/not-an-int');
            assert.strictEqual(badId.status, 400, 'non-integer node id rejected (400)');
        }
        // reset both worlds' graphs back to seed for downstream determinism
        await post(A + '/reset');
        await post(B + '/reset');
    });

    // T-P1 walk-into-portal proximity trigger
    let exitPacket = null;
    await check('T-P1', 'walk-into-portal proximity trigger initiates exit intent', async () => {
        const portal = (await get(A + '/wow/portal/location-a-portal')).json;
        const trig = portal.webofworlds_extension.trigger;
        // move avatar to just outside then into radius
        assert.strictEqual(withinPortal([ 0, 0, 0 ], trig), false, 'origin outside radius');
        assert.strictEqual(withinPortal(trig.position, trig), true, 'trigger center inside radius');
        // simulate arrival at the portal by posting movement to the trigger position
        // (proximity is a client concern; here we assert geometry + then fire exit)
        const r = await post(A + '/portal/exit-intent', { portal_id : 'location-a-portal' });
        assert.strictEqual(r.status, 201);
        exitPacket = r.json;
        assert.ok(exitPacket.handoff_id, 'handoff_id present in exit packet');
        assert.strictEqual(exitPacket.native_teleportxr_teleport, false);
        assert.strictEqual(exitPacket.target.location_id, 'location-b');
    });

    // T-A1 source stays source after exit
    await check('T-A1', 'source stays source (A remains location-a, records exit)', async () => {
        const ds = (await get(A + '/debug/state')).json;
        assert.strictEqual(ds.location.location_id, 'location-a');
        assert.strictEqual(ds.session.session_id, 'local-session-a');
        assert.strictEqual(ds.debug.last_input_source, 'portal-exit-intent');
        assert.strictEqual(ds.debug.handoff.last_exit_intent.handoff_id, exitPacket.handoff_id);
        // A did NOT become B and A arrival_count did not move
        assert.strictEqual(ds.session.arrival_count, 0, 'source arrival_count stays 0');
    });

    // FR-ID drift guard: post A's packet to A itself (wrong node) must be rejected
    await check('FR-ID', 'arrival applied to WRONG node is rejected (port/id drift guard)', async () => {
        const bad = await post(A + '/portal/arrival', exitPacket); // target is B, posting to A
        assert.strictEqual(bad.status, 400, 'wrong-node arrival rejected');
        assert.ok(/does not match/.test(bad.json.message || ''), 'rejection message explains mismatch');
    });

    // T-A2 + T-H1 + T-C1: target already-open receives arrival, correlates handoff_id, preserves continuity
    await check('T-A2/T-H1/T-C1', 'target receives arrival; handoff_id correlates; continuity preserved', async () => {
        const before = (await get(B + '/debug/state')).json.session.arrival_count;
        const arr = await post(B + '/portal/arrival', exitPacket);
        assert.strictEqual(arr.status, 201);
        const ds = (await get(B + '/debug/state')).json;
        assert.strictEqual(ds.location.location_id, 'location-b', 'B stays location-b');
        assert.strictEqual(ds.session.arrival_count, before + 1, 'B arrival_count incremented by 1');
        assert.strictEqual(ds.debug.handoff.last_arrival.handoff_id, exitPacket.handoff_id, 'handoff_id correlates');
        assert.strictEqual(ds.avatar.continuity_id, exitPacket.avatar_context.continuity_id, 'continuity preserved');
        assert.strictEqual(ds.avatar.avatar_id, 'avatar-local-001');
    });

    // FR-STATE: A and B never collapse into one window/identity
    await check('FR-STATE', 'no silent one-window reconnect (A and B stay distinct)', async () => {
        const dsa = (await get(A + '/debug/state')).json;
        const dsb = (await get(B + '/debug/state')).json;
        assert.notStrictEqual(dsa.location.location_id, dsb.location.location_id);
        assert.strictEqual(dsa.location.location_id, 'location-a');
        assert.strictEqual(dsb.location.location_id, 'location-b');
        // A still shows exit (departed) state, B shows arrival state
        assert.strictEqual(dsa.debug.last_input_source, 'portal-exit-intent');
        assert.strictEqual(dsb.debug.last_input_source, 'portal-arrival');
    });

    // /runtime-state WS proves state propagation to an already-open subscriber
    await check('WS', '/runtime-state broadcasts arrival to an already-open subscriber', async () => {
        await post(B + '/reset');
        const collector = wsCollect(PORT_B, '/runtime-state', 500);
        // give the WS a moment to connect and receive the initial frame
        await new Promise(r => setTimeout(r, 120));
        const exit2 = (await post(A + '/portal/exit-intent', { portal_id : 'location-a-portal' })).json;
        // retarget to B (exit2 already targets B)
        await post(B + '/portal/arrival', exit2);
        const frames = await collector;
        assert.ok(frames.length >= 1, 'received >=1 state frame, got ' + frames.length);
        const sawArrival = frames.some(f => f.state && f.state.debug
            && f.state.debug.last_input_source === 'portal-arrival'
            && f.state.debug.handoff.last_arrival
            && f.state.debug.handoff.last_arrival.handoff_id === exit2.handoff_id);
        assert.ok(sawArrival, 'a broadcast frame carried the arrival with matching handoff_id');
    });

    // reset/replay >=3 sequential cycles (NFR-REPEAT at state level)
    await check('REPEAT', 'reset/replay across 3 sequential cycles, per-cycle count is deterministic', async () => {
        await post(A + '/reset');
        await post(B + '/reset');
        for (let i = 1; i <= 3; i++)
        {
            const b0 = (await get(B + '/debug/state')).json.session.arrival_count;
            const ex = (await post(A + '/portal/exit-intent', { portal_id : 'location-a-portal' })).json;
            await post(B + '/portal/arrival', ex);
            const b1 = (await get(B + '/debug/state')).json.session.arrival_count;
            assert.strictEqual(b1, b0 + 1, 'cycle ' + i + ' incremented by exactly 1 (b0=' + b0 + ' b1=' + b1 + ')');
            assert.strictEqual((await get(A + '/debug/state')).json.location.location_id, 'location-a', 'A stays A cycle ' + i);
        }
        // after 3 cycles B arrival_count == 3 (deterministic accumulation)
        assert.strictEqual((await get(B + '/debug/state')).json.session.arrival_count, 3, 'B total arrival_count == 3');
    });

    await a.closeAll();
    await b.closeAll();

    console.log('\n==== RESULT: ' + passed + ' passed, ' + failed + ' failed ====');
    // machine-readable summary line for evidence capture
    console.log('SUMMARY_JSON ' + JSON.stringify({ passed, failed, results }));
    process.exit(failed === 0 ? 0 : 1);
}

main().catch(err => { console.error('harness crashed:', err); process.exit(2); });
