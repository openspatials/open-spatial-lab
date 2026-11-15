'use strict';
/** Public world projections preserve authored content and runtime ownership of occupancy and location. */
const { WOW_GEOPOSE_MAPPING, WOW_LOCAL_USER_ID, WOW_PLAYER_VIEW_ID } = require('./runtime-projection-policy');
const { clone } = require('./runtime-projection-values');
function getWowProofBoundary()
{
    return {
        application_level_handoff : true,
        native_teleportxr_teleport : false,
        first_party_teleportxr_browser_rendering : false,
        standards_conformance : false,
    };
}
function getWowWorld({ avatar, world, location, session, portals, anchor, graphIds, revision, activeUsers, joinedUsers, portalCount, preview, room, liveUsers, authoredGraph : AUTHORED_WOW_GRAPH, worldId : WORLD_ID })
{
    const projected = {
        content : {
            label : location.title + ' - world surface',
            age_restriction : 0,
            license : 'local-unsigned-demo (no license claim)',
            cost : 'free',
            version : 0.1,
            duration : 0,
        },
        geoPose : clone(anchor),
        spatials : graphIds,
        revision : revision,
        services : { events : 'events' },
        presence : {
            avatar : 'vrm-glb-avatar (client-rendered)',
            navigation : 'walk-wasd-jump',
            gravity : 'y-down-ground-clamp',
            avatars : [ {
                avatar_id : avatar.avatar_id,
                continuity_id : avatar.continuity_id,
                display_name : avatar.display_name,
            } ],
        },
        technology : {
            'webXR-immersive' : 'not-proven',
            runtime : 'teleportxr-hosted-state-with-threejs-browser-fallback (re-modeled locally)',
        },
        users : {
            // Presence entries plus users present by the identity handshake.
            active_user_count : activeUsers + (Number.isInteger(joinedUsers) ? joinedUsers : 0),
            total_user_count : 1,
        },
        views : {
            view_count : 1, // the PlayerView camera seat, GET /wow/view/1
        },
        portals : {
            portal_count : portalCount,
        },
        ...(preview ? { preview : preview } : {}),
        ...worldMetadata(world, location, session, room),
        webofworlds_extension : worldExtension(avatar, portals, liveUsers),
        proof_boundary : getWowProofBoundary(),
    };
    return mergeAuthoredWorld(projected, AUTHORED_WOW_GRAPH, WORLD_ID);
}

function worldMetadata(world, location, session, room)
{
    return {
        id : world.world_id,
        location : {
            id : location.location_id,
            title : location.title,
            port : location.http_port,
            node_role : location.node_role,
            ...(room && room.color ? { room : { color : room.color } } : {}),
        },
        session : {
            id : session.session_id,
            world_id : session.world_id,
            location_id : session.location_id,
            arrival_count : session.arrival_count,
        },
    };
}
function worldExtension(avatar, portals, liveUsers)
{
    return {
        schema : 'OpenSpatialWorld API.yaml components.schemas.World + labeled extensions',
        geopose_mapping : WOW_GEOPOSE_MAPPING,
        users: [ { id : WOW_LOCAL_USER_ID, avatar_id : avatar.avatar_id, endpoint : '/wow/user/' + WOW_LOCAL_USER_ID } ]
            .concat(liveUsers),
        views : [ { id : WOW_PLAYER_VIEW_ID, kind : 'player-view-camera', endpoint : '/wow/view/' + WOW_PLAYER_VIEW_ID } ],
        portals : portals.map((portal, index) => ({
            id : index + 1,
            portal_id : portal.portal_id,
            endpoint : '/wow/portal/' + (index + 1),
            target_location_id : portal.target_location_id,
            target_world_id : portal.target_world_id,
        })),
        active_user_count_source : 'live presence entries (/fabric/presence) plus users present by the identity handshake (POST /wow/user)',
    };
}
function mergeAuthoredWorld(projected, AUTHORED_WOW_GRAPH, WORLD_ID)
{
    const authored = AUTHORED_WOW_GRAPH && AUTHORED_WOW_GRAPH.world;
    if (!authored) return projected;
    return Object.assign({}, projected, authored, {
        content : Object.assign({}, projected.content, authored.content || {}),
        presence : Object.assign({}, projected.presence, authored.presence || {}, {
            avatars : projected.presence.avatars,
        }),
        technology : Object.assign({}, projected.technology, authored.technology || {}),
        geoPose : projected.geoPose,
        users : projected.users,
        views : projected.views,
        portals : projected.portals,
        id : WORLD_ID,
        location : projected.location,
        session : projected.session,
        webofworlds_extension : Object.assign(
            {}, authored.webofworlds_extension || {}, projected.webofworlds_extension, {
                authored_graph : {
                    endpoint : '/wow/graph',
                    spatial_id : WORLD_ID,
                    source : 'checked-in OSL-authored world data',
                },
            }),
        proof_boundary : getWowProofBoundary(),
    });
}
function getWowLocation({ locationId : LOCATION_ID, title : TITLE, nodeRole : NODE_ROLE, worldId : WORLD_ID, sessionId : SESSION_ID, baseUrl : PUBLIC_BASE_URL, authoredGraph : AUTHORED_WOW_GRAPH, spawn, portals })
{
    return {
        id : LOCATION_ID,
        title : TITLE,
        node_role : NODE_ROLE,
        world_id : WORLD_ID,
        session_id : SESSION_ID,
        base_url : PUBLIC_BASE_URL,
        coordinate_frame : AUTHORED_WOW_GRAPH && AUTHORED_WOW_GRAPH.units
            ? AUTHORED_WOW_GRAPH.units
            : WOW_GEOPOSE_MAPPING.frame,
        entry_spawn : spawn,
        resources : {
            health : '/healthz',
            world : '/wow/world',
            authored_graph : AUTHORED_WOW_GRAPH ? '/wow/graph' : null,
            spatial_graph : '/wow/spatial/' + WORLD_ID,
            region : '/fabric/region',
            presence : '/fabric/presence',
            runtime_state : '/runtime-state',
            portals : portals.map((portal, index) => ({
                portal_id : portal.portal_id,
                endpoint : '/wow/portal/' + (index + 1),
            })),
            arrival : '/portal/arrival',
        },
        proof_boundary : getWowProofBoundary(),
    };
}
function getWowGraph({ authoredGraph : AUTHORED_WOW_GRAPH, locationId : LOCATION_ID, worldId : WORLD_ID, sessionId : SESSION_ID, nodeRole : NODE_ROLE, baseUrl : PUBLIC_BASE_URL, portals })
{
    if (!AUTHORED_WOW_GRAPH) return null;
    const graph = clone(AUTHORED_WOW_GRAPH);
    graph.spatialID = WORLD_ID;
    graph.base_url = PUBLIC_BASE_URL;
    graph.spatial_composition_graph_endpoint = '/wow/graph';
    graph.world = Object.assign({}, graph.world || {}, {
        id : WORLD_ID,
        portals : { portal_count : portals.length },
        proof_boundary : getWowProofBoundary(),
    });
    graph.portals = portals;
    graph.backend_contract = {
        location_id : LOCATION_ID,
        world_id : WORLD_ID,
        session_id : SESSION_ID,
        node_role : NODE_ROLE,
        authored_content : true,
        client_cutover : false,
        public_deployment : false,
        proof_boundary : getWowProofBoundary(),
    };
    return graph;
}

module.exports = { getWowProofBoundary, getWowWorld, getWowLocation, getWowGraph };
