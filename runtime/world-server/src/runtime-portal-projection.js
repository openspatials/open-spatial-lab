'use strict';
/** Project resolved configured portals; dynamically placed portals remain in portal-standard.js. */
const { WOW_GEOPOSE_MAPPING } = require('./runtime-projection-policy');
const { clone, readNumber } = require('./runtime-projection-values');
const { portalTraversalRule, portalReciprocalRule, portalSharedEdge, portalZones,
    spatialFabricAddressForPortal } = require('./runtime-portal-policy');
function portalDestination(portal)
{
    const address = spatialFabricAddressForPortal(portal);
    const out = {
        target_world_id : portal.target_world_id,
        target_location_id : portal.target_location_id,
        target_base_url : portal.target_base_url,
        spatial_fabric_address : address && address.uri ? address.uri : undefined,
    };
    for (const k of Object.keys(out))
        if (out[k] == null || out[k] === '') delete out[k];
    return out;
}

function portalEntryUrl(portal, portalJoinResolver)
{
    if (!portal.target_base_url) return undefined;
    const base = String(portal.target_base_url).replace(/\/*$/, '/');
    const join = portalJoinResolver ? portalJoinResolver(portal) : null;
    return Number.isInteger(join) ? base + '#join=node.' + join : base;
}

function resolveWowPortal(portals, placedPortals, idOrAlias)
{
    const raw = String(idOrAlias == null ? '' : idOrAlias);
    if (/^\d+$/.test(raw))
    {
        const index = Number(raw) - 1;
        const portal = portals[index];
        if (portal) return { portal, wowId : index + 1 };
        const added = placedPortals.at(index - portals.length);
        return added ? { added, wowId : index + 1 } : null;
    }
    const index = portals.findIndex(entry => entry.portal_id === raw);
    if (index === -1)
        return null;
    return { portal : portals[index], wowId : index + 1 };
}

function wowPortalExtension(portal, wowId, objectCount)
{
    const traversal = portalTraversalRule(portal);
    const targetWorldId = portal.target_world_id || portal.target_fixture?.spatial_id;
    const extension = {
        portal_id : portal.portal_id, // legacy string id (demo alias route)
        wow_id : wowId,               // WoW numeric id (spec route /wow/portal/{n})
        wow_resource : '/wow/portal/' + wowId,
        legacy_alias_endpoint : '/wow/portal/' + portal.portal_id,
        source_location_id : portal.source_location_id,
        source_world_id : portal.source_world_id,
        portal_node_id : 1 + objectCount + (wowId - 1),
        target_spatial_graph_endpoint : targetWorldId ? '/wow/spatial/' + 1 : undefined,
        target_fixture : portal.target_fixture
            ? clone(portal.target_fixture)
            : undefined,
        exit_endpoint : '/portal/exit-intent',
        arrival_endpoint : '/portal/arrival',
        handoff_behavior : portal.target_fixture
            ? 'client-scene-load (same browser/player; no application-level handoff)'
            : 'application-level-handoff-around-teleportxr',
        native_teleportxr_teleport : false,
        ...portalGeometry(portal),
        zones : portalZones(portal),
        spatial_fabric_address : spatialFabricAddressForPortal(portal) || undefined,
        traversal_mode : traversal.mode,
        traversal : traversal,
        reciprocal : portalReciprocalRule(portal),
        shared_edge : portalSharedEdge(portal),
    };
    return extension;
}

function portalGeometry(portal)
{
    return {
        trigger : {
            position : portal.trigger.position,
            radius_m : readNumber(portal.trigger.radius_m, 0),
        },
        arrival : {
            position : portal.arrival.position,
            rotation_y : portal.arrival.rotation_y,
        },
        geopose_mapping : WOW_GEOPOSE_MAPPING,
    };
}

function portalResource({ portal, wowId, nodeId, node, entry, geoPose, extension, proof })
{
    return {
        id : wowId, // number, per WoW Portal schema
        ...(entry ? { destination : entry } : {}),
        ...(nodeId != null ? { node : node } : {}),
        geoPose : geoPose,
        label : portal.label || ('Portal ' + portal.portal_id),
        osl_destination : portalDestination(portal),
        webofworlds_extension : extension,
        proof_boundary : proof,
    };
}

function legacyPortal({ portal, wowId, nodeId, node, entry, extension, proof })
{
    return {
        id : portal.portal_id,
        ...(entry ? { destination : entry } : {}),
        ...(nodeId != null ? { node : node } : {}),
        label : portal.label || ('Portal ' + portal.portal_id),
        geoPose : {
            position : {
                x : portal.trigger.position[0],
                y : portal.trigger.position[1],
                z : portal.trigger.position[2],
            },
            angles : { yaw : 0, pitch : 0, roll : 0 },
            orientation : { x : 0, y : 0, z : 0, w : 1 },
            radius_m : readNumber(portal.trigger.radius_m, 0),
        },
        osl_destination : portalDestination(portal),
        webofworlds_extension : extension,
        proof_boundary : proof,
    };
}

module.exports = { portalDestination, portalEntryUrl, resolveWowPortal, wowPortalExtension, portalResource, legacyPortal };
