'use strict';
const { ARRIVAL_ROLE } = require('./portal-standard');
const { portalFrameYawRad } = require('./runtime-portal-policy');
const { getWowProofBoundary } = require('./runtime-world-projection');
const { portalEntryUrl : projectPortalEntryUrl, resolveWowPortal : projectResolveWowPortal,
    wowPortalExtension : projectPortalExtension, portalResource : projectPortalResource,
    legacyPortal : projectLegacyPortal } = require('./runtime-portal-projection');
class RuntimePortalReader
{
    constructor({ readPortals, readObjects, spatial, placements, placedPortals, geoPose, identity })
    {
        this.readPortals = readPortals;
        this.readObjects = readObjects;
        this.spatial = spatial;
        this.placements = placements;
        this.placedPortals = placedPortals;
        this.geoPose = geoPose;
        this.identity = identity;
    }
    portalArrivalNodeId(portalId)
    {
        const hit = this.spatial.primary.listNodes().find(node => node.webofworlds_extension
            && node.webofworlds_extension.role === ARRIVAL_ROLE && node.webofworlds_extension.portal_id === portalId);
        return hit ? hit.id : null;
    }

    setPortalJoinResolver(resolver)
    {
        this.joinResolver = typeof resolver === 'function' ? resolver : null;
    }

    demoPortalNodeId(wowId)
    {
        return this.placements.seededNodeId('wow-portal-' + wowId);
    }

    getWowPortalResource(idOrAlias)
    {
        const hit = this.resolveWowPortal(idOrAlias);
        if (!hit) return null;
        if (hit.added) return this.placedPortals.resource(hit.added, hit.wowId);
        const { portal, wowId } = hit;
        const nodeId = this.demoPortalNodeId(wowId);
        return projectPortalResource({ portal, wowId, nodeId,
            node : nodeId != null ? this.spatial.nodeRef(this.spatial.primary, nodeId) : undefined,
            entry : this.portalEntryUrl(portal),
            geoPose : this.placements.geoPoseOfNode(nodeId) || this.geoPose(portal.trigger.position, portalFrameYawRad(this.identity.LOCATION_ID), 0),
            extension : this.wowPortalExtension(portal, wowId), proof : getWowProofBoundary() });
    }

    getWowPortal(portalId)
    {
        if (/^\d+$/.test(String(portalId == null ? '' : portalId))) return this.getWowPortalResource(portalId);
        const hit = this.resolveWowPortal(portalId);
        if (!hit || hit.added) return null;
        const { portal, wowId } = hit;
        const nodeId = this.demoPortalNodeId(wowId);
        return projectLegacyPortal({ portal, wowId, nodeId,
            node : nodeId != null ? this.spatial.nodeRef(this.spatial.primary, nodeId) : undefined,
            entry : this.portalEntryUrl(portal), extension : this.wowPortalExtension(portal, wowId), proof : getWowProofBoundary() });
    }

    resolveWowPortal(id) { return projectResolveWowPortal(this.readPortals(), this.placedPortals, id); }

    portalEntryUrl(portal) { return projectPortalEntryUrl(portal, this.joinResolver); }

    wowPortalExtension(portal, id) { return projectPortalExtension(portal, id, this.readObjects().length); }
}
function createRuntimePortalReader(options)
{
    const reader = new RuntimePortalReader(options);
    return {
        portalArrivalNodeId : reader.portalArrivalNodeId.bind(reader),
        setPortalJoinResolver : reader.setPortalJoinResolver.bind(reader),
        demoPortalNodeId : reader.demoPortalNodeId.bind(reader),
        getWowPortalResource : reader.getWowPortalResource.bind(reader),
        getWowPortal : reader.getWowPortal.bind(reader),
        resolveWowPortal : reader.resolveWowPortal.bind(reader),
        portalEntryUrl : reader.portalEntryUrl.bind(reader),
        wowPortalExtension : reader.wowPortalExtension.bind(reader),
    };
}
module.exports = { createRuntimePortalReader };
