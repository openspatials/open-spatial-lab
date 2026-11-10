'use strict';
const { fabricNormalizeVec3 } = require('./runtime-projection-values');

/** Read-only direction, zone and address policy. Shared-edge identity remains owned by config.js. */
const { portalEdgeId } = require('./config');
const { FABRIC_PORTAL_FRAME_PRESETS, FABRIC_PORTAL_FRAME_WIDTH_M, FABRIC_PORTAL_FRAME_HEIGHT_M,
    FABRIC_PORTAL_TRIGGER_DEPTH_M } = require('./runtime-projection-policy');
const { readNumber } = require('./runtime-projection-values');
function portalTraversalRule(portal)
{
    const raw = portal.traversal || {};
    const mode = raw.mode === 'one_way' ? 'one_way' : 'bidirectional';
    const allowed = mode === 'one_way'
        ? (raw.allowed_entry_side === 'back' ? 'back' : 'front')
        : 'both';
    const preset = FABRIC_PORTAL_FRAME_PRESETS[portal.source_location_id] || null;
    return {
        mode : mode,
        transition : typeof raw.transition === 'string' && raw.transition
            ? raw.transition
            : undefined,
        allowed_entry_side : allowed,
        blocked_entry_side : mode === 'one_way'
            ? (allowed === 'front' ? 'back' : 'front')
            : null,
        side_reference : 'portal_frame_forward',
        frame_forward : preset ? preset.forward.slice() : [ 0, 0, 1 ],
        validation : {
            traversal_direction_standard_conformance : false,
            application_level : true,
        },
    };
}

function portalReciprocalRule(portal)
{
    const raw = portal.reciprocal || {};
    return {
        mode : raw.mode === 'automatic' ? 'automatic' : 'disabled',
        validation : {
            automatic_reciprocal_standard_conformance : false,
            application_level : true,
        },
    };
}

function portalSharedEdge(portal)
{
    if (!portal || portal.target_fixture
        || !portal.target_location_id || !portal.target_portal_id)
        return null;
    const edgeId = portalEdgeId(portal);
    if (!edgeId) return null;
    return {
        edge_id : edgeId,
        endpoints : [ String(portal.source_location_id), String(portal.target_location_id) ].sort(),
        this_side : {
            location_id : portal.source_location_id,
            world_id : portal.source_world_id || null,
            portal_id : portal.portal_id,
        },
        counterpart : {
            location_id : portal.target_location_id,
            world_id : portal.target_world_id || null,
            portal_id : portal.target_portal_id,
            base_url : portal.target_base_url || null,
            region_pose_endpoint : '/fabric/region?anchor_portal_id='
                + encodeURIComponent(String(portal.target_portal_id)),
        },
        reciprocal_presence : 'hosted_both_sides',
        identity_rule : 'one portal = one stable connection between two places; '
            + 'the same edge_id is hosted by BOTH endpoint worlds and each '
            + 'side\'s target_portal_id names the other side',
        validation : {
            shared_edge_standard_conformance : false,
            application_level : true,
        },
    };
}

function portalArmedEntrySides(portal)
{
    const rule = portalTraversalRule(portal);
    return rule.mode === 'one_way' ? [ rule.allowed_entry_side ] : [ 'front', 'back' ];
}

function portalZones(portal)
{
    const sf = portal.spatial_fabric || {};
    const prefetchRadius = readNumber(sf.prefetch_radius_m, 2.5);
    const roiRadius = readNumber(sf.roi_radius_m, 5.0);
    const minPrefetchRadius =
        FABRIC_PORTAL_FRAME_WIDTH_M / 2 + FABRIC_PORTAL_TRIGGER_DEPTH_M + 0.5;
    const armedEntrySides = portalArmedEntrySides(portal);
    return {
        prefetch : prefetchZone(prefetchRadius, roiRadius, armedEntrySides),
        traversal : traversalZone(armedEntrySides),
        invariant : 'prefetch.radius_m > width_m/2 + trigger_depth_m + 0.5',
        invariant_min_prefetch_radius_m : Number(minPrefetchRadius.toFixed(3)),
        invariant_ok : prefetchRadius > minPrefetchRadius,
    };
}

function spatialFabricAddressForPortal(portal)
{
    if (portal.target_fixture || !portal.target_location_id
        || !portal.target_portal_id || !portal.target_base_url)
        return null;
    const sf = portal.spatial_fabric || {};
    const roiRadius = readNumber(sf.roi_radius_m, 5.0);
    const targetLocation = String(portal.target_location_id || '');
    const anchorPortalId = String(portal.target_portal_id || (targetLocation + '-portal'));
    const authority = String(portal.target_base_url || '');
    return {
        profile_version : 'osl.spatial-fabric-address.v0',
        uri : 'osl-fabric+http://' + authority.replace(/^https?:\/\//, '')
            + '/fabric.json#portal=' + anchorPortalId + '&roi_radius_m=' + roiRadius,
        authority : authority,
        fabric_id : 'local-fabric-' + targetLocation,
        world_id : portal.target_world_id || null,
        location_id : targetLocation || null,
        anchor : { type : 'portal', portal_id : anchorPortalId },
        roi_hint : { type : 'portal_neighborhood_radius', radius_m : roiRadius },
        discovery : {
            well_known : '/.well-known/spatial-fabric',
            fabric_manifest : '/fabric.json',
            region_endpoint : '/fabric/region',
            presence_endpoint : '/fabric/presence',
        },
        validation : {
            address_scheme_standard_conformance : false,
            application_level : true,
        },
    };
}

function prefetchZone(prefetchRadius, roiRadius, armedEntrySides)
{
    return {
        type : 'portal_center_planar_radius',
        radius_m : prefetchRadius,
        hysteresis_ratio : 1.15,
        armed_entry_sides : armedEntrySides.slice(),
        purpose : 'larger OUTER data-loading circle — resolve + preload the '
            + 'destination spatial fabric neighborhood; NEVER commits traversal',
        widened_by : 'runtime',
        previous_proof_radius_m : 2.5,
        matching_destination_circle : {
            radius_m : roiRadius,
            includes_avatars : true,
            matches_source_circle : roiRadius === prefetchRadius,
            clamp_reason : roiRadius === prefetchRadius
                ? null
                : 'source-side circle is clamped by world geometry (the spawn '
                    + 'contract places the player 3.2 m from a location portal; '
                    + 'the lobby walk-away waypoints bound the exit hysteresis); '
                    + 'the destination-side loading circle keeps the full roi width',
            rule : 'destination /fabric/region loads all scene entities and '
                + 'registered avatars within radius_m of the destination '
                + 'anchor portal',
        },
    };

}

function traversalZone(armedEntrySides)
{
    return {
        type : 'oval_frame_plane_crossing',
        width_m : FABRIC_PORTAL_FRAME_WIDTH_M,
        height_m : FABRIC_PORTAL_FRAME_HEIGHT_M,
        trigger_depth_m : FABRIC_PORTAL_TRIGGER_DEPTH_M,
        armed_entry_sides : armedEntrySides.slice(),
        purpose : 'smaller commit trigger — walking through transfers the '
            + 'player; semantics unchanged from the proven crossing gate',
    };

}

function portalFrameYawRad(locationId)
{
    const preset = FABRIC_PORTAL_FRAME_PRESETS[locationId] || {};
    const f = fabricNormalizeVec3(preset.forward || [ 0, 0, 1 ], [ 0, 0, 1 ]);
    return Math.hypot(f[0], f[2]) > 1e-6 ? Math.atan2(f[0], f[2]) : 0;
}

module.exports = { portalFrameYawRad, portalTraversalRule, portalReciprocalRule, portalSharedEdge, portalArmedEntrySides, portalZones, spatialFabricAddressForPortal };
