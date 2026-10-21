'use strict';

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');
const { makeConfig } = require('../src/config');
const { createRuntime } = require('../src/runtime-state');

const airportConfig = makeConfig('airport');
assert.strictEqual(airportConfig.location_id, 'location-airport');
assert.strictEqual(airportConfig.world_id, 'world-airport-terminal');
assert.strictEqual(airportConfig.session_id, 'local-session-airport');
assert.strictEqual(airportConfig.http_port, 18154);
assert.deepStrictEqual(airportConfig.entry_spawn, { position : [ 0, 0, -3 ], rotation_y : 0 });
assert.strictEqual(airportConfig.portals.length, 1);
assert.strictEqual(airportConfig.portals[0].portal_id, 'airport-portal-lobby');
assert.strictEqual(airportConfig.portals[0].target_location_id, 'location-lobby');

// cut Portal C over to the real airport backend: the
// fixture contract is GONE and the portal carries the same backend destination
// shape as every other edge. (These three assertions previously pinned the
// pre-224 fixture state and were failing against the committed config; updated
// to the current contract as part of P1, whose shared-edge
// validation requires the mutual backend pairing asserted here.)
const lobbyPortalC = makeConfig('lobby').portals.find(
    portal => portal.portal_id === 'lobby-portal-c');
assert.ok(lobbyPortalC && !lobbyPortalC.target_fixture, 'Portal C is backend-destination, not fixture');
assert.strictEqual(lobbyPortalC.target_base_url, 'http://127.0.0.1:18154', 'Portal C targets the airport backend');
assert.strictEqual(lobbyPortalC.target_portal_id, 'airport-portal-lobby', 'Portal C names its hosted counterpart');

assert.deepStrictEqual(
    [ makeConfig('a').location_id, makeConfig('b').location_id, makeConfig('lobby').location_id ],
    [ 'location-a', 'location-b', 'location-lobby' ],
    'existing node identities remain unchanged');

const configPath = path.resolve(__dirname, '..', 'src', 'config.js');
const envOverride = spawnSync(process.execPath, [ '-e',
    `process.stdout.write(String(require(${JSON.stringify(configPath)}).makeConfig('airport').http_port))`,
], {
    cwd : path.resolve(__dirname, '..', '..', '..', '..'),
    env : Object.assign({}, process.env, { OSL_BACKEND_AIRPORT_PORT : '19954' }),
    encoding : 'utf8',
});
assert.strictEqual(envOverride.status, 0, envOverride.stderr);
assert.strictEqual(envOverride.stdout, '19954', 'airport endpoint port is environment-overridable');

const runtime = createRuntime(airportConfig);
const world = runtime.getWowWorld();
const location = runtime.getWowLocation();
const graph = runtime.getWowGraph();
const portal = runtime.getWowPortalResource(1);
const scene = runtime.getSceneObjects();
const spatialRoot = runtime.getSpatialGraphRoot('world-airport-terminal');

assert.strictEqual(world.id, 'world-airport-terminal');
assert.strictEqual(world.content.label, 'Denver Skyport — Concourse A');
assert.strictEqual(world.portals.portal_count, 1);
assert.strictEqual(world.proof_boundary.application_level_handoff, true);
assert.strictEqual(world.proof_boundary.standards_conformance, false);
assert.strictEqual(location.id, 'location-airport');
assert.deepStrictEqual(location.entry_spawn.position, [ 0, 0, -3 ]);
assert.match(location.coordinate_frame, /demo-local tangent frame/);
assert.strictEqual(location.resources.authored_graph, '/wow/graph');

assert.strictEqual(graph.spatialID, 'world-airport-terminal');
assert.strictEqual(graph.nodes.length, 14);
assert.strictEqual(graph.backend_contract.client_cutover, false);
assert.strictEqual(graph.backend_contract.public_deployment, false);
assert.strictEqual(graph.world.portals.portal_count, 1);
assert.ok(graph.nodes.some(node => node.label === 'Gate A12 — Flight 482 to Seattle'));
assert.strictEqual(graph.nodes.filter(node =>
    node.webofworlds_extension && node.webofworlds_extension.role === 'storefront').length, 4);
assert.strictEqual(graph.nodes.filter(node =>
    node.webofworlds_extension && node.webofworlds_extension.role === 'npc-traveler').length, 6);
assert.deepStrictEqual(
    graph.nodes.find(node => node.label === 'Denver Skyport — Concourse A')
        .webofworlds_extension.airport_terminal.entry_spawn.position_m,
    [ 0, 0, -3 ]);

assert.strictEqual(scene.objects.length, 13);
assert.ok(scene.objects.some(entry => entry.label === 'Gate A12 — Flight 482 to Seattle'));
assert.ok(spatialRoot.children.length >= 14, 'canonical spatial graph carries authored nodes plus portal');
assert.ok(spatialRoot.children.some(id => {
    const node = runtime.getSpatialNode('world-airport-terminal', id);
    return node && node.label === 'Gate A12 — Flight 482 to Seattle';
}), 'Gate A12 resolves through the backend canonical spatial graph');

assert.strictEqual(portal.webofworlds_extension.portal_id, 'airport-portal-lobby');
assert.strictEqual(portal.destination.target_location_id, 'location-lobby');
assert.strictEqual(portal.destination.target_world_id, 'demo-lobby');
assert.strictEqual(portal.webofworlds_extension.traversal_mode, 'bidirectional');
assert.strictEqual(portal.proof_boundary.standards_conformance, false);

runtime.registerPresence({
    player_id : 'unit-airport-player',
    client_id : 'unit-client',
    avatar_id : 'avatar-unit',
    position : [ 0, 0, 4 ],
    requested_ttl_ms : 1000,
});
runtime.heartbeatPresence({ player_id : 'unit-airport-player', position : [ 1, 0, 12 ] });
assert.deepStrictEqual(runtime.getFabricPresence().occupancy.avatars[0].position, [ 1, 0, 12 ]);
assert.strictEqual(runtime.departPresence({ player_id : 'unit-airport-player' }).departed, true);
assert.strictEqual(runtime.getFabricPresence().occupancy.registered_player_count, 0);

const arrivalPacket = {
    handoff_id : 'unit-airport-arrival-1',
    source : {
        location_id : 'location-lobby',
        world_id : 'demo-lobby',
        session_id : 'local-session-lobby',
    },
    target : {
        location_id : 'location-airport',
        world_id : 'world-airport-terminal',
        arrival_position : [ 0, 0, -3 ],
        arrival_rotation_y : 0,
    },
    avatar_context : {
        avatar_id : 'avatar-arriving',
        continuity_id : 'continuity-arriving',
        display_name : 'Arrival Test',
        transform : { position : [ 0, 0, 0 ], rotation_y : 0 },
    },
};
const arrival = runtime.recordPortalArrival(arrivalPacket);
assert.strictEqual(arrival.session.arrival_count, 1);
assert.deepStrictEqual(arrival.avatar.transform.position, [ 0, 0, -3 ]);
assert.throws(() => runtime.recordPortalArrival(Object.assign({}, arrivalPacket, {
    handoff_id : 'wrong-airport-arrival',
    target : Object.assign({}, arrivalPacket.target, { location_id : 'location-a' }),
})), /handoff target location location-a does not match location-airport/);

const fullRegion = runtime.getFabricRegionChunk('airport-portal-lobby', 5, {
    scope : 'full', max_entities : 64, max_bytes : 65536,
});
assert.strictEqual(fullRegion.region.scope, 'full');
assert.strictEqual(fullRegion.proof_boundary.standards_conformance, false);

runtime.stopPresenceSweeper();
runtime.stopRepublishTimer();

process.stdout.write(JSON.stringify({
    ok : true,
    location_id : runtime.LOCATION_ID,
    world_id : runtime.WORLD_ID,
    authored_graph_nodes : graph.nodes.length,
    hosted_scene_objects : scene.objects.length,
    portal_id : portal.webofworlds_extension.portal_id,
    stable_ids : true,
    client_cutover : false,
    public_deployment : false,
    standards_conformance : false,
}, null, 2) + '\n');
