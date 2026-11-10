'use strict';
/** Unsigned fabric discovery and spawn projections; portal geometry uses the existing standard helpers. */
const { startDistanceClearOfPortals } = require('./portal-standard');
const { FABRIC_PORTAL_FRAME_PRESETS, FABRIC_PORTAL_TRIGGER_DEPTH_M, FABRIC_SPAWN_CLEARANCE_M,
    FABRIC_TRIGGER_BOUND_MAX, FABRIC_BACKGROUND_RRGGBB, WOW_LOCAL_USER_ID, WOW_PLAYER_VIEW_ID } = require('./runtime-projection-policy');
const { readNumber, fabricVec3, fabricRoundVec3, fabricNormalizeVec3 } = require('./runtime-projection-values');
const { portalTraversalRule, portalZones, spatialFabricAddressForPortal } = require('./runtime-portal-policy');
function getFabricSpawnPose(portals, entrySpawn, LOCATION_ID)
{
    if (entrySpawn && Array.isArray(entrySpawn.position))
    {
        const position = fabricVec3(entrySpawn.position, [ 0, 0, 0 ]);
        const rotationY = readNumber(entrySpawn.rotation_y, 0);
        return {
            position : position,
            rotation_y : rotationY,
            rotation : [ 0, Math.sin(rotationY / 2), 0, Math.cos(rotationY / 2) ],
        };
    }
    const portal = portals[0] || null;
    const triggers = portals
        .map(p => fabricVec3(p.trigger && p.trigger.position, null))
        .filter(Boolean);
    const trigger = triggers.length
        ? [
            triggers.reduce((s, t) => s + t[0], 0) / triggers.length,
            triggers.reduce((s, t) => s + t[1], 0) / triggers.length,
            triggers.reduce((s, t) => s + t[2], 0) / triggers.length,
        ]
        : fabricVec3(portal && portal.trigger ? portal.trigger.position : null, [ 2.8, 0, -2.8 ]);
    const preset = FABRIC_PORTAL_FRAME_PRESETS[LOCATION_ID] || {};
    const forward = fabricRoundVec3(
        fabricNormalizeVec3(preset.forward || [ 0, 0, 1 ], [ 0, 0, 1 ]), 6);
    const groundCenter = fabricRoundVec3([ trigger[0], 0, trigger[2] ], 4);
    const spawnDistance = startDistanceClearOfPortals(
        portals, groundCenter, forward,
        Math.max(FABRIC_SPAWN_CLEARANCE_M, FABRIC_PORTAL_TRIGGER_DEPTH_M + FABRIC_SPAWN_CLEARANCE_M),
        (entry) => readNumber(entry.spatial_fabric && entry.spatial_fabric.prefetch_radius_m, 2.5));
    const position = [
        groundCenter[0] + forward[0] * spawnDistance,
        groundCenter[1] + forward[1] * spawnDistance,
        groundCenter[2] + forward[2] * spawnDistance,
    ];
    position[1] = 0;
    return { position, rotation_y : 0, rotation : [ 0, 0, 0, 1 ] };
}

function fabricChildren(portals, spawn, LOCATION_ID)
{
    const ownKey = LOCATION_ID.replace('location-', '');

    const children = [
        {
            Head : { Self : 'P-1' },
            Name : 'Avatar Spawn',
            Transform : { Position : spawn.position.slice() },
        },
    ];
    let nextSelf = 2;
    for (let index = 0; index < portals.length; index += 1)
    {
        const entry = portals[index];
        const triggerPosition = fabricVec3(
            entry.trigger && entry.trigger.position, [ 2.8, 0, -2.8 ]);
        const targetKey = String(entry.target_location_id || '').replace('location-', '');
        const targetFabricUrl = targetKey ? '/api/' + targetKey + '/fabric.json' : null;
        children.push({
            Head : { Self : 'P-' + nextSelf },
            Name : entry.label || ('Portal to ' + (entry.target_location_id || 'unknown')),
            Type : { bSubtype : 255 },
            Resource : { sReference : targetFabricUrl },
            Transform : { Position : triggerPosition.slice() },
            SpatialFabricAddress : spatialFabricAddressForPortal(entry),
            Zones : portalZones(entry),
            Traversal : portalTraversalRule(entry),
        });
        nextSelf += 1;
        children.push({
            Head : { Self : 'P-' + nextSelf },
            Name : index === 0 ? 'Portal Trigger' : 'Portal Trigger (' + entry.portal_id + ')',
            Resource : {
                sReference : index === 0
                    ? 'action:portal-' + ownKey + '-trigger'
                    : 'action:portal-' + ownKey + '-' + entry.portal_id + '-trigger',
            },
            Transform : { Position : triggerPosition.slice() },
            Bound : { Max : FABRIC_TRIGGER_BOUND_MAX.slice() },
        });
        nextSelf += 1;
    }

    return children;
}
function getFabricManifest({ portals, spawn, locationId : LOCATION_ID, spatialId : SPATIAL_ID, authoredGraph : AUTHORED_WOW_GRAPH, proof })
{
    const portal = portals[0] || null;
    const children = fabricChildren(portals, spawn, LOCATION_ID);
    return {
        container : LOCATION_ID,
        services : fabricServices(portal, LOCATION_ID, SPATIAL_ID, AUTHORED_WOW_GRAPH),
        modules : [],
        primary : {
            camera : {
                position : spawn.position.slice(),
                rotation : spawn.rotation.slice(),
            },
            background : FABRIC_BACKGROUND_RRGGBB,
        },
        data : {
            Head : { Self : 'R-0' },
            Name : 'Root',
            Children : children,
        },
        trust : {
            signed : false,
            format : 'plain-json',
            note : 'unsigned local demonstration fabric; JWS signing not implemented (claim boundary)',
        },
        proof_boundary : proof,
    };
}

function fabricServices(portal, LOCATION_ID, SPATIAL_ID, AUTHORED_WOW_GRAPH)
{
    return [
            { name : 'wow', type : 'web-of-worlds', endpoint : '/wow/world' },
            { name : 'wow-location', type : 'web-of-worlds', endpoint : '/wow/location', default_id : LOCATION_ID },
            { name : 'wow-user', type : 'web-of-worlds', endpoint : '/wow/user/{userId}', default_id : WOW_LOCAL_USER_ID },
            { name : 'wow-portal', type : 'web-of-worlds', endpoint : '/wow/portal/{portalId}', default_id : portal ? 1 : null },
            { name : 'wow-view', type : 'web-of-worlds', endpoint : '/wow/view/{viewId}', default_id : WOW_PLAYER_VIEW_ID },
            { name : 'wow-spatial', type : 'web-of-worlds', endpoint : '/wow/spatial/{spatialID}', default_id : SPATIAL_ID },
            { name : 'wow-spatial-node', type : 'web-of-worlds', endpoint : '/wow/spatial/{spatialID}/node/{nodeId}', default_id : SPATIAL_ID },
        ].concat(AUTHORED_WOW_GRAPH ? [ {
            name : 'wow-authored-graph',
            type : 'web-of-worlds',
            endpoint : '/wow/graph',
            default_id : SPATIAL_ID,
        } ] : []);
}

module.exports = { getFabricSpawnPose, getFabricManifest };
