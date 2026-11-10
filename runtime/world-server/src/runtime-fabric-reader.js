'use strict';
const { clone } = require('./runtime-projection-values');
const { getWowProofBoundary } = require('./runtime-world-projection');
const { fabricRegionBoundary, fabricRegionScan : scanFabricRegion,
    fabricRegionAvatarsInCircle : projectRegionAvatars, getFabricRegion : projectFabricRegion } = require('./runtime-fabric-region');
const { normalizeChunkOptions, prepareFabricChunk, projectFabricChunk } = require('./runtime-fabric-chunk');
const { getFabricRegionTilesetHypothesis : projectFabricTileset } = require('./runtime-fabric-bands');
const { getFabricSpawnPose : projectFabricSpawn, getFabricManifest : projectFabricManifest } = require('./runtime-fabric-projection');
class RuntimeFabricReader
{
    constructor({ readPortals, readObjects, attachPoint, presence, portalPose, entrySpawn, identity, authoredGraph, maxRadius, session, avatar, subscriberCount })
    {
        this.readPortals = readPortals;
        this.readObjects = readObjects;
        this.attachPoint = attachPoint;
        this.presence = presence;
        this.portalPose = portalPose;
        this.entrySpawn = entrySpawn;
        this.identity = identity;
        this.authoredGraph = authoredGraph;
        this.maxRadius = maxRadius;
        this.session = session;
        this.avatar = avatar;
        this.subscriberCount = subscriberCount;
    }
    getFabricPresence()
    {
        return clone(Object.assign({
            ok : true,
            location_id : this.identity.LOCATION_ID,
            world_id : this.identity.WORLD_ID,
            fabric_id : 'local-fabric-' + this.identity.LOCATION_ID,
        }, this.fabricPresenceSummary(), {
            proof_boundary : getWowProofBoundary(),
        }, fabricRegionBoundary()));
    }

    fabricRegionAvatarsInCircle(scan)
    {
        const now = Date.now();
        return projectRegionAvatars(scan, this.presence.livePresenceEntries(now), now);
    }

    getFabricRegion(anchorPortalId, radiusM)
    {
        const scan = this.fabricRegionScan(anchorPortalId, radiusM);
        const avatars = this.fabricRegionAvatarsInCircle(scan);
        return projectFabricRegion({ locationId : this.identity.LOCATION_ID, worldId : this.identity.WORLD_ID,
            version : this.attachPoint.version, scan, avatars,
            portalPose : this.portalPose(scan.portal), spawn : this.getFabricSpawnPose(),
            presenceSummary : this.fabricPresenceSummary(), proof : getWowProofBoundary() });
    }

    getFabricRegionChunk(anchorPortalId, radiusM, opts)
    {
        const request = normalizeChunkOptions(opts);
        const scan = this.fabricRegionScan(anchorPortalId, radiusM == null || radiusM === '' ? 5.0 : radiusM);
        const selection = prepareFabricChunk(scan, request);
        const response = projectFabricChunk({ scan, request, selection, locationId : this.identity.LOCATION_ID,
            worldId : this.identity.WORLD_ID, version : this.attachPoint.version, proof : getWowProofBoundary() });
        if (!selection.cursorProvided)
        {
            response.portal = this.portalPose(scan.portal);
            response.spawn = this.getFabricSpawnPose();
            response.presence = this.fabricPresenceSummary();
            response.avatars = this.fabricRegionAvatarsInCircle(scan);
            response.region.includes_avatars_within_circle = true;
        }
        return clone(Object.assign(response, fabricRegionBoundary(), { chunking_standard_conformance : false }));
    }

    getFabricRegionTilesetHypothesis(anchorPortalId, radiusM)
    {
        const scan = this.fabricRegionScan(anchorPortalId, radiusM == null || radiusM === '' ? 5.0 : radiusM);
        return projectFabricTileset(scan, this.identity.LOCATION_ID, this.identity.WORLD_ID, getWowProofBoundary());
    }

    fabricRegionScan(anchor, radius)
    {
        return scanFabricRegion({ portals : this.readPortals(), objects : this.readObjects(),
            locationId : this.identity.LOCATION_ID, maxRadius : this.maxRadius }, anchor, radius);
    }

    fabricPresenceSummary()
    {
        return this.presence.summary({ arrivalCount : this.session.arrival_count,
            subscriberCount : this.subscriberCount(), avatar : this.avatar });
    }

    getFabricSpawnPose() { return projectFabricSpawn(this.readPortals(), this.entrySpawn, this.identity.LOCATION_ID); }

    getFabricManifest()
    {
        return projectFabricManifest({ portals : this.readPortals(), spawn : this.getFabricSpawnPose(),
            locationId : this.identity.LOCATION_ID, spatialId : this.identity.WORLD_ID,
            authoredGraph : this.authoredGraph, proof : getWowProofBoundary() });
    }
}
function createRuntimeFabricReader(options)
{
    const reader = new RuntimeFabricReader(options);
    return {
        getFabricPresence : reader.getFabricPresence.bind(reader),
        getFabricRegion : reader.getFabricRegion.bind(reader),
        getFabricRegionChunk : reader.getFabricRegionChunk.bind(reader),
        getFabricRegionTilesetHypothesis : reader.getFabricRegionTilesetHypothesis.bind(reader),
        getFabricSpawnPose : reader.getFabricSpawnPose.bind(reader),
        getFabricManifest : reader.getFabricManifest.bind(reader),
    };
}
module.exports = { createRuntimeFabricReader };
