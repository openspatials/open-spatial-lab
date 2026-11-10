'use strict';
const { demoDefaultSceneObjects, authoredGraphSceneObjects } = require('./runtime-scene-initialization');
const { densityFixtureSceneObjects } = require('./runtime-fabric-density');
const { loadAnchors } = require('./spatial-anchor');
function createRuntimeState(cfg, identity, authoredGraph)
{
    const AUTHORED_SCENE_OBJECTS = authoredGraphSceneObjects(authoredGraph);
    return {
        location : {
            location_id : identity.LOCATION_ID,
            title : identity.TITLE,
            http_port : identity.HTTP_PORT,
            node_role : identity.NODE_ROLE,
        },
        world : {
            world_id : identity.WORLD_ID,
        },
        session : {
            session_id : identity.SESSION_ID,
            world_id : identity.WORLD_ID,
            location_id : identity.LOCATION_ID,
            arrival_count : 0,
            connected_clients : [],
            handoff_bootstrap : null,
        },
        avatar : initialAvatar(),
        portals : (cfg.portals || []).map(p => Object.assign({}, p)),
        // demo extension: hosted primitives + the reloadable
        // attach-point version record (see the block comment above).
        scene_objects : (AUTHORED_SCENE_OBJECTS.length
            ? AUTHORED_SCENE_OBJECTS
            : demoDefaultSceneObjects(identity.LOCATION_ID))
            .concat(densityFixtureSceneObjects(identity.LOCATION_ID, cfg.portals || []))
            .map(o => Object.assign({}, o, { position : o.position.slice() })),
        attach_point : {
            version : 1,
            updated_at : new Date().toISOString(),
            last_change : 'init',
        },
        server_tick : 0,
        debug : {
            state_revision : 0,
            last_input_source : 'init',
            handoff : {
                last_handoff_id : null,
                last_exit_intent : null,
                last_arrival : null,
            },
        },
    };
}
function initialAvatar()
{
    return {
        avatar_id : 'avatar-local-001',
        continuity_id : 'avatar-local-001',
        display_name : 'poc-user',
        transform : {
            position : [ 0, 0, 0 ],
            rotation_y : 0,
            orientation : [ 0, 0, 0, 1 ],
            scale : [ 1, 1, 1 ],
        },
        handoff_context : null,
    };
}
function runtimeIdentity(cfg)
{
    const LOCATION_ID = String(cfg.location_id);
    const HTTP_PORT = Number(cfg.http_port);
    return Object.freeze({ LOCATION_ID, HTTP_PORT,
        WORLD_ID : String(cfg.world_id), SESSION_ID : String(cfg.session_id),
        PUBLIC_BASE_URL : cfg.public_base_url || ('http://127.0.0.1:' + HTTP_PORT),
        NODE_ROLE : String(cfg.node_role || 'node'), TITLE : String(cfg.title || LOCATION_ID) });
}
function runtimeAnchors(cfg)
{
    const anchors = loadAnchors(cfg.spatial_anchor_fixture !== undefined ? cfg.spatial_anchor_fixture : cfg.spatial_anchors);
    if (!anchors.has(1)) throw new Error('the spatial anchor fixture names no graph 1 (this world serves one graph, id 1)');
    return anchors;
}

module.exports = { createRuntimeState, runtimeIdentity, runtimeAnchors };
