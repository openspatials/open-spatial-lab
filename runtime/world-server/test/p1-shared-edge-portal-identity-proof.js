'use strict';

/*
 * P1 — SHARED-EDGE PORTAL IDENTITY PROOF (server lane).
 *
 * The original issue: portals were per-world, per-direction descriptors, so
 * walking lobby -> A and turning around showed "the same portal" now leading to
 * location-b — and the lobby return (issue #5) fell back to a single per-world
 * arrival spot. P1 models each portal as ONE stable connection (a shared edge)
 * hosted by BOTH endpoint worlds, retargets the lobby portals at the real
 * hosted counterparts, and validates the topology at config load.
 *
 * This proof asserts, deterministically and against live isolated servers:
 *   E1  the checked-in topology forms exactly 4 shared edges, each 2-sided
 *   E2  both sides of every edge serve the SAME edge_id + mutual counterpart
 *   E3 regression: A and B each host the A<->B edge AND their lobby
 *       edge (the turn-around portal goes to the LOBBY, not to B)
 *   E4  the counterpart pose is resolvable: /fabric/region anchored on the
 *       counterpart returns THAT portal's pose + its shared-edge identity
 *   E5  P1-authored arrivals land IN FRONT of the entered portal's counterpart
 *       (forward standoff within the frame, not a per-world spot)
 *   E6  reuse-over-rebuild: every pre-P1 descriptor field is byte-stable
 *       (triggers, arrivals, zones knobs, traversal, order, ids)
 *   E7  spawn contract: each demo room's centroid spawn stays OUTSIDE every
 *       portal's 3.0 m loading circle
 *   E8 the proven corridors stay clear of the new triggers
 *   E9 new-portal zones keep the invariant and arm both sides
 *   E10 ON THE WIRE: exit-intent through the new A-side portal hands off to
 *       the lobby and the arrival commits IN FRONT of lobby-portal-a; the
 *       legacy lobby->A leg still commits the byte-identical legacy arrival
 *   E11 the Lobby source omits the removed airport-portal marker, preserves
 *       both benches + lobby-portal-c, and derives graph children from the
 *       remaining primitives plus portals
 *   NEG oracle honesty: a topology missing a counterpart (the pre-P1 world)
 *       or mispointed at the old A<->B portal REFUSES to validate; the Lobby
 *       source contract also rejects a reintroduced airport-portal marker
 *
 * ISOLATED PORTS ONLY (19291-19294; 19281-19283 belong to the battery).
 * 8143 / 18151-18154 (the local demo) are NEVER bound. No git, no web/
 * files. Claim boundary unchanged: local application-level proof;
 * standards_conformance stays false.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { start } = require('../src/server');
const { NODES, makeConfig, portalEdgeId, validateSharedEdgeTopology } = require('../src/config');
const { get, post } = require('../src/http-client');

const PORT_A = Number(process.env.OSL_SHARED_EDGE_PORT_A) || 19291;
const PORT_B = Number(process.env.OSL_SHARED_EDGE_PORT_B) || 19292;
const PORT_LOBBY = Number(process.env.OSL_SHARED_EDGE_PORT_LOBBY) || 19293;
const PORT_AIRPORT = Number(process.env.OSL_SHARED_EDGE_PORT_AIRPORT) || 19294;
const FORBIDDEN = new Set([ 8143, 18151, 18152, 18153, 18154 ]);
for (const p of [ PORT_A, PORT_B, PORT_LOBBY, PORT_AIRPORT ])
{
    if (FORBIDDEN.has(p))
    {
        console.error('REFUSING protected live-demo port ' + p);
        process.exit(2);
    }
}

const PORT_BY_LOCATION = {
    'location-a' : PORT_A,
    'location-b' : PORT_B,
    'location-lobby' : PORT_LOBBY,
    'location-airport' : PORT_AIRPORT,
};
const BASE = {
    'location-a' : 'http://127.0.0.1:' + PORT_A,
    'location-b' : 'http://127.0.0.1:' + PORT_B,
    'location-lobby' : 'http://127.0.0.1:' + PORT_LOBBY,
    'location-airport' : 'http://127.0.0.1:' + PORT_AIRPORT,
};

// Frame forward presets per location — MIRRORS runtime-state
// FABRIC_PORTAL_FRAME_PRESETS (the descriptor truth this proof checks against).
const FRAME_FORWARD = {
    'location-a' : [ 0, 0, 1 ],
    'location-b' : [ -1, 0, 0 ],
    'location-lobby' : [ 0, 0, 1 ],
    'location-airport' : [ 0, 0, 1 ],
};
const FRAME_WIDTH_M = 1.8;
const TRIGGER_DEPTH_M = 0.8;

function isolatedPortals(role)
{
    return makeConfig(role).portals.map(portal => Object.assign({}, portal, {
        target_base_url : 'http://127.0.0.1:'
            + (PORT_BY_LOCATION[portal.target_location_id] || PORT_A),
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

function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function sub(a, b) { return [ a[0] - b[0], a[1] - b[1], a[2] - b[2] ]; }
function rightOf(forward) { return [ forward[2], 0, -forward[0] ]; } // y-up right-hand
function planarDistance(a, b) { return Math.hypot(a[0] - b[0], a[2] - b[2]); }
/** Planar distance from point p to segment [s0,s1] (x/z only). */
function distanceToSegment(p, s0, s1)
{
    const vx = s1[0] - s0[0], vz = s1[2] - s0[2];
    const wx = p[0] - s0[0], wz = p[2] - s0[2];
    const len2 = vx * vx + vz * vz;
    const t = len2 > 0 ? Math.max(0, Math.min(1, (wx * vx + wz * vz) / len2)) : 0;
    return Math.hypot(wx - t * vx, wz - t * vz);
}

function assertLobbyAirportPortalApproach(scene, portalC, spatialRoot, portalCount)
{
    const objects = scene.objects || [];
    assert.ok(!objects.some(obj => obj.object_id === 'obj-lobby-marker-1'),
        'Lobby source must not include removed obj-lobby-marker-1');
    assert.deepStrictEqual(objects.filter(obj => /^obj-lobby-bench-[12]$/.test(obj.object_id)), [
        { object_id : 'obj-lobby-bench-1', shape : 'box', size_m : 0.6, color : '#9fb0d0', position : [ -4.4, 0.3, 1.6 ] },
        { object_id : 'obj-lobby-bench-2', shape : 'box', size_m : 0.6, color : '#9fb0d0', position : [ 4.4, 0.3, 1.6 ] },
    ], 'both Lobby benches remain byte-stable');
    assert.deepStrictEqual(portalC.webofworlds_extension.trigger.position, [ 0, 0, -4.4 ],
        'lobby-portal-c trigger remains at the airport approach');
    assert.strictEqual(portalC.destination.target_location_id, 'location-airport',
        'lobby-portal-c still targets the airport');
    assert.strictEqual(portalC.webofworlds_extension.shared_edge.counterpart.portal_id,
        'airport-portal-lobby', 'lobby-portal-c counterpart remains the airport portal');
    assert.strictEqual(spatialRoot.children.length, objects.length + portalCount,
        'Lobby graph children derive from remaining primitives plus portals');
}

async function portalByStringId(locationId, portalId)
{
    const r = await get(BASE[locationId] + '/wow/portal/' + encodeURIComponent(portalId));
    assert.strictEqual(r.status, 200, locationId + ' /wow/portal/' + portalId + ' -> ' + r.status);
    return r.json;
}

async function main()
{
    const a = await start('a', { bind_port : PORT_A, portals : isolatedPortals('a') });
    const b = await start('b', { bind_port : PORT_B, portals : isolatedPortals('b') });
    const lobby = await start('lobby', { bind_port : PORT_LOBBY, portals : isolatedPortals('lobby') });
    const airport = await start('airport', { bind_port : PORT_AIRPORT, portals : isolatedPortals('airport') });
    const servers = [ a, b, lobby, airport ];
    console.log('booted isolated nodes: A :' + PORT_A + '  B :' + PORT_B
        + '  lobby :' + PORT_LOBBY + '  airport :' + PORT_AIRPORT
        + '  (live demo 8143/18151-18154 untouched)');

    // The four shared edges the checked-in demo topology declares.
    const EXPECTED_EDGES = {
        'edge--location-a--location-b' : [
            [ 'location-a', 'location-a-portal' ],
            [ 'location-b', 'location-b-portal' ],
        ],
        'edge--location-a--location-lobby' : [
            [ 'location-a', 'location-a-portal-lobby' ],
            [ 'location-lobby', 'lobby-portal-a' ],
        ],
        'edge--location-b--location-lobby' : [
            [ 'location-b', 'location-b-portal-lobby' ],
            [ 'location-lobby', 'lobby-portal-b' ],
        ],
        'edge--location-airport--location-lobby' : [
            [ 'location-airport', 'airport-portal-lobby' ],
            [ 'location-lobby', 'lobby-portal-c' ],
        ],
    };

    await check('E1', 'checked-in topology = exactly 4 shared edges, each hosted on both sides', async () => {
        const topology = validateSharedEdgeTopology(NODES); // throws on violation
        assert.strictEqual(topology.edge_count, 4, 'edge_count');
        for (const [ edgeId, sides ] of Object.entries(EXPECTED_EDGES))
        {
            const got = topology.edges[edgeId];
            assert.ok(Array.isArray(got), edgeId + ' present');
            assert.deepStrictEqual(got.slice().sort(),
                sides.map(([ loc, pid ]) => loc + '/' + pid).sort(), edgeId + ' sides');
        }
    });

    await check('E2', 'both sides of every edge serve the SAME edge_id + mutual counterpart', async () => {
        for (const [ edgeId, sides ] of Object.entries(EXPECTED_EDGES))
        {
            const [ [ locX, pidX ], [ locY, pidY ] ] = sides;
            const x = (await portalByStringId(locX, pidX)).webofworlds_extension.shared_edge;
            const y = (await portalByStringId(locY, pidY)).webofworlds_extension.shared_edge;
            assert.ok(x && y, edgeId + ' shared_edge present on both sides');
            assert.strictEqual(x.edge_id, edgeId, locX + '/' + pidX + ' edge_id');
            assert.strictEqual(y.edge_id, edgeId, locY + '/' + pidY + ' edge_id');
            assert.strictEqual(x.counterpart.portal_id, y.this_side.portal_id, edgeId + ' x->y');
            assert.strictEqual(y.counterpart.portal_id, x.this_side.portal_id, edgeId + ' y->x');
            assert.strictEqual(x.counterpart.location_id, locY, edgeId + ' x counterpart location');
            assert.strictEqual(y.counterpart.location_id, locX, edgeId + ' y counterpart location');
            assert.strictEqual(x.reciprocal_presence, 'hosted_both_sides');
            assert.strictEqual(y.reciprocal_presence, 'hosted_both_sides');
            assert.strictEqual(x.validation.shared_edge_standard_conformance, false, 'claim boundary');
        }
    });

    await check('E3', 'regression: A and B each host the A<->B edge AND their lobby edge; the lobby portal is never the A<->B portal', async () => {
        for (const [ loc, ownEdge ] of [
            [ 'location-a', 'edge--location-a--location-lobby' ],
            [ 'location-b', 'edge--location-b--location-lobby' ] ])
        {
            const world = (await get(BASE[loc] + '/wow/world')).json;
            const listed = world.webofworlds_extension.portals;
            assert.strictEqual(listed.length, 2, loc + ' hosts 2 portals');
            const edges = [];
            for (const entry of listed)
            {
                const portal = (await get(BASE[loc] + '/wow/portal/' + entry.id)).json;
                edges.push(portal.webofworlds_extension.shared_edge.edge_id);
            }
            assert.ok(edges.includes('edge--location-a--location-b'), loc + ' hosts the A<->B edge');
            assert.ok(edges.includes(ownEdge), loc + ' hosts its lobby edge (the turn-around portal goes to the LOBBY)');
        }
        const lobbyWorld = (await get(BASE['location-lobby'] + '/wow/world')).json;
        const lobbyIds = lobbyWorld.webofworlds_extension.portals.map(p => p.portal_id);
        assert.deepStrictEqual(lobbyIds,
            [ 'lobby-portal-a', 'lobby-portal-b', 'lobby-portal-c' ], 'lobby list unchanged');
        const lobbyEdges = [];
        for (const pid of lobbyIds)
            lobbyEdges.push((await portalByStringId('location-lobby', pid)).webofworlds_extension.shared_edge.edge_id);
        assert.strictEqual(new Set(lobbyEdges).size, 3, 'three DISTINCT lobby edges');
        assert.ok(!lobbyEdges.includes('edge--location-a--location-b'),
            'no lobby portal is the A<->B connection');
    });

    await check('E4', 'counterpart pose resolvable: /fabric/region anchored on the counterpart returns THAT portal + its edge identity', async () => {
        const anchors = [
            [ 'location-a', 'location-a-portal-lobby', [ -2.8, 0, -2.8 ], 'edge--location-a--location-lobby' ],
            [ 'location-b', 'location-b-portal-lobby', [ 2.8, 0, 2.8 ], 'edge--location-b--location-lobby' ],
            [ 'location-lobby', 'lobby-portal-a', [ -2.0, 0, -2.8 ], 'edge--location-a--location-lobby' ],
            [ 'location-lobby', 'lobby-portal-b', [ 2.0, 0, -2.8 ], 'edge--location-b--location-lobby' ],
        ];
        for (const [ loc, anchorId, expectedPos, expectedEdge ] of anchors)
        {
            const r = await get(BASE[loc] + '/fabric/region?anchor_portal_id='
                + encodeURIComponent(anchorId) + '&radius_m=5');
            assert.strictEqual(r.status, 200, loc + ' region(' + anchorId + ') status');
            assert.strictEqual(r.json.portal.portal_id, anchorId, 'region pose is the anchor portal');
            assert.deepStrictEqual(r.json.portal.trigger_position, expectedPos, anchorId + ' pose');
            assert.strictEqual(r.json.portal.shared_edge.edge_id, expectedEdge,
                'the adopted pose declares its edge identity');
        }
    });

    await check('E5', 'P1-authored arrivals land IN FRONT of the counterpart portal (forward standoff inside the frame)', async () => {
        // strict bound for the P1-authored return portals; directional bound for
        // the pre-P1 airport pair (legacy values preserved byte-identical).
        const cases = [
            [ 'location-a', 'location-a-portal-lobby', true ],
            [ 'location-b', 'location-b-portal-lobby', true ],
            [ 'location-lobby', 'lobby-portal-c', true ],
            [ 'location-airport', 'airport-portal-lobby', false ],
        ];
        for (const [ loc, pid, strict ] of cases)
        {
            const ext = (await portalByStringId(loc, pid)).webofworlds_extension;
            const edge = ext.shared_edge;
            const counterpart = (await portalByStringId(
                edge.counterpart.location_id, edge.counterpart.portal_id)).webofworlds_extension;
            const forward = FRAME_FORWARD[edge.counterpart.location_id];
            const delta = sub(ext.arrival.position, counterpart.trigger.position);
            const forwardClearance = dot(delta, forward);
            const lateral = Math.abs(dot(delta, rightOf(forward)));
            assert.ok(forwardClearance > 0,
                pid + ' arrival is on the FRONT side of its counterpart (got ' + forwardClearance + ')');
            assert.ok(lateral <= FRAME_WIDTH_M / 2,
                pid + ' arrival is laterally inside the frame (got ' + lateral + ')');
            if (strict)
            {
                assert.ok(forwardClearance >= TRIGGER_DEPTH_M && forwardClearance <= 2.4,
                    pid + ' standoff within [trigger_depth, 2.4] (got ' + forwardClearance + ')');
            }
        }
    });

    await check('E6', 'reuse-over-rebuild: every pre-P1 descriptor field is byte-stable (order, ids, triggers, arrivals, knobs)', async () => {
        // Portal order + primary stability (wow_id 1 must stay the legacy portal).
        assert.deepStrictEqual(makeConfig('a').portals.map(p => p.portal_id),
            [ 'location-a-portal', 'location-a-portal-lobby' ]);
        assert.deepStrictEqual(makeConfig('b').portals.map(p => p.portal_id),
            [ 'location-b-portal', 'location-b-portal-lobby' ]);
        assert.deepStrictEqual(makeConfig('lobby').portals.map(p => p.portal_id),
            [ 'lobby-portal-a', 'lobby-portal-b', 'lobby-portal-c' ]);
        assert.deepStrictEqual(makeConfig('airport').portals.map(p => p.portal_id),
            [ 'airport-portal-lobby' ]);
        // Pre-P1 literal values stay byte-identical (the crossing mechanics'
        // inputs are untouched; only target_portal_id on lobby a/b retargeted).
        const legacy = {
            'location-a/location-a-portal' : { trigger : [ 2.8, 0, -2.8 ], arrival : [ 0, 0, 3.6 ], rotation : Math.PI, target : 'location-b-portal' },
            'location-b/location-b-portal' : { trigger : [ 2.8, 0, -2.8 ], arrival : [ 0, 0, 3.6 ], rotation : Math.PI, target : 'location-a-portal' },
            'location-lobby/lobby-portal-a' : { trigger : [ -2.0, 0, -2.8 ], arrival : [ 0, 0, 3.6 ], rotation : Math.PI, target : 'location-a-portal-lobby' },
            'location-lobby/lobby-portal-b' : { trigger : [ 2.0, 0, -2.8 ], arrival : [ 0, 0, 3.6 ], rotation : Math.PI, target : 'location-b-portal-lobby' },
            'location-lobby/lobby-portal-c' : { trigger : [ 0, 0, -4.4 ], arrival : [ 0, 0, -3.0 ], rotation : 0, target : 'airport-portal-lobby' },
            'location-airport/airport-portal-lobby' : { trigger : [ 0, 0, -4.4 ], arrival : [ 0, 0, 0.4 ], rotation : 0, target : 'lobby-portal-c' },
        };
        for (const [ key, expect ] of Object.entries(legacy))
        {
            const [ loc, pid ] = key.split('/');
            const node = Object.values(NODES).find(n => n.location_id === loc);
            const portal = node.portals.find(p => p.portal_id === pid);
            assert.deepStrictEqual(portal.trigger.position, expect.trigger, key + ' trigger');
            assert.strictEqual(portal.trigger.radius_m, 1.25, key + ' radius');
            assert.deepStrictEqual(portal.arrival.position, expect.arrival, key + ' arrival');
            assert.strictEqual(portal.arrival.rotation_y, expect.rotation, key + ' rotation');
            assert.strictEqual(portal.target_portal_id, expect.target, key + ' counterpart');
            assert.deepStrictEqual(portal.spatial_fabric,
                pid === 'lobby-portal-c'
                    ? { prefetch_radius_m : 3.0, roi_radius_m : 24.0 }
                    : { prefetch_radius_m : 3.0, roi_radius_m : 5.0 }, key + ' zones knobs');
            assert.strictEqual((portal.traversal || {}).mode, 'bidirectional', key + ' traversal');
        }
        // Reciprocal-rule surface unchanged: only portal-c requests automatic.
        for (const [ loc, pid, mode ] of [
            [ 'location-lobby', 'lobby-portal-a', 'disabled' ],
            [ 'location-lobby', 'lobby-portal-b', 'disabled' ],
            [ 'location-lobby', 'lobby-portal-c', 'automatic' ] ])
        {
            const ext = (await portalByStringId(loc, pid)).webofworlds_extension;
            assert.strictEqual(ext.reciprocal.mode, mode, pid + ' reciprocal mode');
        }
    });

    await check('E7', 'spawn contract: each demo room centroid spawn stays OUTSIDE every 3.0 m loading circle', async () => {
        for (const loc of [ 'location-a', 'location-b', 'location-lobby' ])
        {
            const node = Object.values(NODES).find(n => n.location_id === loc);
            const anchor = node.portals[0].portal_id;
            const region = (await get(BASE[loc] + '/fabric/region?anchor_portal_id='
                + encodeURIComponent(anchor))).json;
            const spawn = region.spawn.position;
            for (const portal of node.portals)
            {
                const d = planarDistance(spawn, portal.trigger.position);
                const prefetch = portal.spatial_fabric.prefetch_radius_m;
                assert.ok(d > prefetch,
                    loc + ' spawn ' + JSON.stringify(spawn) + ' must start OUTSIDE '
                    + portal.portal_id + ' loading circle (' + d.toFixed(2) + ' <= ' + prefetch + ')');
            }
        }
    });

    await check('E8', 'proven corridors stay clear: new triggers are far from the runtime A approach + the B arrival exit components', async () => {
        const clearance = 1.25 + 0.5; // trigger radius + margin
        // A: approach corridor x=2.8, z 0.4 -> -2.8 (spawn-side start kept generous).
        const dA = distanceToSegment([ -2.8, 0, -2.8 ], [ 2.8, 0, 0.4 ], [ 2.8, 0, -2.8 ]);
        assert.ok(dA >= clearance, 'A corridor vs location-a-portal-lobby (' + dA.toFixed(2) + ')');
        // B: A->B arrival exit lane -x at z=-2.8 (x from 2.8 to -0.4).
        const dB = distanceToSegment([ 2.8, 0, 2.8 ], [ 2.8, 0, -2.8 ], [ -0.4, 0, -2.8 ]);
        assert.ok(dB >= clearance, 'B exit components vs location-b-portal-lobby (' + dB.toFixed(2) + ')');
    });

    await check('E9', 'new-portal zones keep the runtime invariant and arm both sides', async () => {
        for (const [ loc, pid ] of [
            [ 'location-a', 'location-a-portal-lobby' ],
            [ 'location-b', 'location-b-portal-lobby' ] ])
        {
            const ext = (await portalByStringId(loc, pid)).webofworlds_extension;
            assert.strictEqual(ext.zones.invariant_ok, true, pid + ' invariant_ok');
            assert.strictEqual(ext.zones.prefetch.radius_m, 3.0, pid + ' prefetch radius');
            assert.deepStrictEqual(ext.zones.prefetch.armed_entry_sides.slice().sort(),
                [ 'back', 'front' ], pid + ' arms both sides');
            assert.strictEqual(ext.traversal.mode, 'bidirectional', pid + ' traversal');
        }
    });

    await check('E10', 'ON THE WIRE: A -> lobby return crossing lands in front of lobby-portal-a; legacy lobby -> A leg unchanged', async () => {
        // Return leg through the NEW shared-edge half.
        const exit = await post(BASE['location-a'] + '/portal/exit-intent',
            { portal_id : 'location-a-portal-lobby' });
        assert.strictEqual(exit.status, 201, 'exit-intent status');
        assert.strictEqual(exit.json.target.location_id, 'location-lobby', 'handoff targets the lobby');
        assert.deepStrictEqual(exit.json.target.arrival_position, [ -2.0, 0, -1.75 ],
            'packet arrival = in front of lobby-portal-a');
        assert.strictEqual(exit.json.portal.portal_id, 'location-a-portal-lobby');
        const arrive = await post(BASE['location-lobby'] + '/portal/arrival', exit.json);
        assert.strictEqual(arrive.status, 201, 'arrival status');
        const lobbyState = (await get(BASE['location-lobby'] + '/debug/state')).json;
        assert.deepStrictEqual(lobbyState.avatar.transform.position, [ -2.0, 0, -1.75 ],
            'lobby avatar committed IN FRONT of the entered portal (not the per-world spot)');
        const lobbyPortalA = Object.values(NODES).find(n => n.location_id === 'location-lobby')
            .portals.find(p => p.portal_id === 'lobby-portal-a');
        const d = planarDistance(lobbyState.avatar.transform.position, lobbyPortalA.trigger.position);
        assert.ok(d <= 1.25, 'landing is within the counterpart trigger circle (' + d.toFixed(2) + ' m)');

        // Legacy forward leg lobby -> A stays byte-identical (pre-P3 behavior).
        const exit2 = await post(BASE['location-lobby'] + '/portal/exit-intent',
            { portal_id : 'lobby-portal-a' });
        assert.strictEqual(exit2.status, 201);
        assert.strictEqual(exit2.json.target.location_id, 'location-a');
        assert.deepStrictEqual(exit2.json.target.arrival_position, [ 0, 0, 3.6 ],
            'legacy packet arrival unchanged (client mapped-exit overrides it in live crossings)');
        const arrive2 = await post(BASE['location-a'] + '/portal/arrival', exit2.json);
        assert.strictEqual(arrive2.status, 201);
    });

    await check('E11', 'Lobby airport approach omits the marker while benches, portal-c, and derived graph counts remain', async () => {
        const scene = (await get(BASE['location-lobby'] + '/demo/scene-objects')).json;
        const world = (await get(BASE['location-lobby'] + '/wow/world')).json;
        const portalC = await portalByStringId('location-lobby', 'lobby-portal-c');
        const spatialRoot = (await get(BASE['location-lobby'] + '/wow/spatial/demo-lobby')).json;
        assertLobbyAirportPortalApproach(scene, portalC, spatialRoot, world.portals.portal_count);
    });

    await check('NEG1', 'oracle: the pre-P1 topology (A hosts NO lobby counterpart) REFUSES to validate', async () => {
        const mutated = JSON.parse(JSON.stringify(NODES));
        mutated.a.portals = mutated.a.portals.filter(p => p.portal_id !== 'location-a-portal-lobby');
        assert.throws(() => validateSharedEdgeTopology(mutated),
            /location-a-portal-lobby.*NOT hosted|lobby-portal-a[\s\S]*NOT hosted/i,
            'missing counterpart must be named');
    });

    await check('NEG2', 'oracle: the old hack (lobby portal pointed at the A<->B portal) REFUSES to validate', async () => {
        const mutated = JSON.parse(JSON.stringify(NODES));
        mutated.lobby.portals.find(p => p.portal_id === 'lobby-portal-a')
            .target_portal_id = 'location-a-portal'; // the pre-P1 wiring
        assert.throws(() => validateSharedEdgeTopology(mutated),
            /does not point back|hosted on 1 side/i,
            'context-dependent pairing must be refused');
    });

    await check('NEG3', 'oracle: edge ids are derivation, not decoration (both sides derive the same id independently)', async () => {
        for (const node of Object.values(NODES))
        {
            for (const portal of node.portals)
            {
                if (portal.target_fixture || !portal.target_portal_id) continue;
                const targetNode = Object.values(NODES)
                    .find(n => n.location_id === portal.target_location_id);
                const counterpart = targetNode.portals
                    .find(p => p.portal_id === portal.target_portal_id);
                assert.strictEqual(portalEdgeId(portal), portalEdgeId(counterpart),
                    portal.portal_id + ' and ' + counterpart.portal_id + ' derive one edge_id');
            }
        }
    });

    await check('NEG4', 'oracle: reintroducing the removed Lobby airport-portal marker REFUSES the source contract', async () => {
        const scene = (await get(BASE['location-lobby'] + '/demo/scene-objects')).json;
        const mutated = Object.assign({}, scene, { objects : scene.objects.concat({
            object_id : 'obj-lobby-marker-1', shape : 'box', size_m : 0.7,
            color : '#42d68a', position : [ 0, 0.35, -4.4 ],
        }) });
        const world = (await get(BASE['location-lobby'] + '/wow/world')).json;
        const portalC = await portalByStringId('location-lobby', 'lobby-portal-c');
        const spatialRoot = (await get(BASE['location-lobby'] + '/wow/spatial/demo-lobby')).json;
        assert.throws(() => assertLobbyAirportPortalApproach(
            mutated, portalC, spatialRoot, world.portals.portal_count),
        /must not include removed obj-lobby-marker-1/,
        'the focused source contract must fail if the marker returns');
    });

    for (const s of servers) await s.closeAll();

    const diagnostics = {
        version_id : 'runtime',
        phase : 'P1 shared-edge portal identity (server components)',
        captured_at : new Date().toISOString(),
        isolated_ports : { a : PORT_A, b : PORT_B, lobby : PORT_LOBBY, airport : PORT_AIRPORT },
        edges : validateSharedEdgeTopology(NODES),
        passed, failed, results,
        claim_boundary : {
            application_level_handoff : true,
            native_teleportxr_teleport : false,
            first_party_teleportxr_browser_rendering : false,
            standards_conformance : false,
            shared_edge_standard_conformance : false,
        },
    };
    const evidencePath = path.resolve(__dirname, '..', '..', '..',
        'diagnostics', 'runtime-p1-shared-edge-portal-identity.json');
    fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
    fs.writeFileSync(evidencePath, JSON.stringify(diagnostics, null, 2) + '\n');
    console.log('[runtime-p1] diagnostics -> ' + evidencePath);

    console.log('\n==== RESULT: ' + passed + ' passed, ' + failed + ' failed ====');
    console.log('SUMMARY_JSON ' + JSON.stringify({ passed, failed, results }));
    process.exit(failed === 0 ? 0 : 1);
}

main().catch(err => { console.error('validation crashed:', err); process.exit(2); });
