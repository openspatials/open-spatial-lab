'use strict';
/** Partial neighborhood reads filter live presence without mutating its registry. */
const { clone, readNumber, fabricVec3 } = require('./runtime-projection-values');
const { primitiveAssetAccess } = require('./wow-asset');
const { presenceEntrySummary } = require('./runtime-presence-projection');
function fabricRegionBoundary()
{
    return {
        demo_extension : true,
        claim : 'runtime local validation — portal-neighborhood (partial) '
            + 'spatial fabric read. NOT defined by RP1/Spatial Fabric (whitepaper '
            + 'documents proximity+LOD as a principle only), IWPS, Universal '
            + 'Manifest, or Web of Worlds.',
        read_only : true,
        application_level : true,
        roi_standard_conformance : false,
        standards_conformance : false,
        standards_shaped : [
            'rp1-whitepaper-proximity-lod-principle',
            'ogc-3d-tiles-bounding-volume-precedent',
            'oma3-iwps-pre-transit-query-shape',
        ],
    };
}

function objectsSeenFromAnotherWorld(objects)
{
    const out = [];
    for (const obj of objects)
    {
        const access = obj.authored_wow_content ? 'public' : primitiveAssetAccess(objects, obj.object_id);
        if (access === 'hidden') continue;
        out.push(access === 'public' ? obj
            : { object_id : obj.object_id, position : obj.position.slice(), size_m : obj.size_m, asset_access : access });
    }
    return out;
}

function authoredFabricRegionMaxRadius(graph)
{
    if (!graph || !Array.isArray(graph.nodes)) return 12.0;
    let authoredMaximum = 12.0;
    for (const node of graph.nodes)
    {
        const extension = node && node.webofworlds_extension;
        if (!extension || typeof extension !== 'object') continue;
        for (const value of Object.values(extension))
        {
            const surfaces = value && typeof value === 'object'
                && Array.isArray(value.walkable_surfaces)
                ? value.walkable_surfaces : [];
            for (const surface of surfaces)
            {
                const size = surface && Array.isArray(surface.size_m) ? surface.size_m : [];
                const x = Math.abs(Number(size[0]) || 0);
                const z = Math.abs(Number(size[2]) || 0);
                if (x > 0 && z > 0)
                    authoredMaximum = Math.max(authoredMaximum, Math.min(x, z));
            }
        }
    }
    return Math.min(48.0, authoredMaximum);
}

function fabricRegionScan({ portals, objects, locationId : LOCATION_ID, maxRadius : FABRIC_REGION_MAX_RADIUS_M }, anchorPortalId, radiusM)
{
    const portal = portals.find(
        entry => entry.portal_id === String(anchorPortalId || ''));
    if (!portal)
        throw new Error('unknown anchor portal ' + anchorPortalId + ' on ' + LOCATION_ID);
    const requestedRadius = readNumber(radiusM, 5.0);
    const radius = Math.max(1.0,
        Math.min(FABRIC_REGION_MAX_RADIUS_M, requestedRadius));
    const anchor = fabricVec3(
        portal.trigger && portal.trigger.position, [ 2.8, 0, -2.8 ]);
    const included = [];
    const beyond = [];
    for (const obj of objectsSeenFromAnotherWorld(objects))
    {
        const dx = (obj.position[0] || 0) - anchor[0];
        const dz = (obj.position[2] || 0) - anchor[2];
        const distance = Math.hypot(dx, dz);
        const entry = Object.assign(clone(obj), {
            distance_from_anchor_m : Number(distance.toFixed(3)),
        });
        if (distance <= radius) included.push(entry);
        else beyond.push(entry);
    }
    return { portal, requestedRadius, radius, anchor, included, beyond };
}

function fabricRegionAvatarsInCircle(scan, entries, nowMs)
{
    const inside = [];
    let unpositioned = 0;
    for (const entry of entries)
    {
        const summary = presenceEntrySummary(entry, nowMs);
        if (!summary.position)
        {
            unpositioned += 1;
            continue;
        }
        const dx = summary.position[0] - scan.anchor[0];
        const dz = summary.position[2] - scan.anchor[2];
        const distance = Math.hypot(dx, dz);
        if (distance > scan.radius) continue;
        inside.push(Object.assign(summary, {
            entity_kind : 'avatar',
            distance_from_anchor_m : Number(distance.toFixed(3)),
            inside_destination_circle : true,
        }));
    }
    return {
        avatars : inside,
        avatars_in_circle : inside.length,
        avatars_without_position : unpositioned,
        circle : {
            type : 'portal_neighborhood_radius',
            center : scan.anchor.slice(),
            radius_m : scan.radius,
        },
        source : 'presence-registry-read-time-projection',
        read_only : true,
        note : 'runtime — registered players inside the '
            + 'destination-side loading circle at the widened matching radius; '
            + 'live read-time projection (positions from register/heartbeat), '
            + 'excluded from chunk entity/byte budgets and from region totals',
    };
}

function getFabricRegion({ locationId : LOCATION_ID, worldId : WORLD_ID, version, scan, avatars, portalPose, spawn, presenceSummary, proof })
{
    const { portal, requestedRadius, radius, anchor } = scan;
    const entities = scan.included;
    const excluded = scan.beyond.length;
    const avatarsInCircle = avatars;
    return clone(Object.assign({
        ok : true,
        location_id : LOCATION_ID,
        world_id : WORLD_ID,
        fabric_id : 'local-fabric-' + LOCATION_ID,
        version : version,
        region : {
            type : 'portal_neighborhood_radius',
            anchor_portal_id : portal.portal_id,
            center : anchor.slice(),
            radius_m : radius,
            requested_radius_m : requestedRadius,
            radius_clamped : radius !== requestedRadius,
            includes_avatars_within_circle : true,
        },
        entities : entities,
        portal : portalPose,
        spawn : spawn,
        avatars : avatarsInCircle,
        totals : {
            fabric_entities : entities.length + excluded,
            region_entities : entities.length,
            excluded_entities : excluded,
            truncated : false,
            avatars_in_circle : avatarsInCircle.avatars_in_circle,
        },
        presence : presenceSummary,
        freshness : { captured_at : new Date().toISOString(), ttl_ms : 15000 },
        proof_boundary : proof,
    }, fabricRegionBoundary()));
}

module.exports = { fabricRegionBoundary, objectsSeenFromAnotherWorld, authoredFabricRegionMaxRadius, fabricRegionScan, fabricRegionAvatarsInCircle, getFabricRegion };
