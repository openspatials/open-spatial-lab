'use strict';
const { getWowProofBoundary, getWowWorld : projectWowWorld, getWowLocation : projectWowLocation,
    getWowGraph : projectWowGraph } = require('./runtime-world-projection');
const { getWowView : projectWowView } = require('./runtime-view-projection');
class RuntimeWorldReader
{
    constructor({ avatar, world, location, session, readPortals, anchor, authoredGraph, spatial, events, presence, placedPortals, worldPreview, room, placements, identity, fabric, portals, joinedUserCount })
    {
        this.avatar = avatar;
        this.world = world;
        this.location = location;
        this.session = session;
        this.readPortals = readPortals;
        this.anchor = anchor;
        this.authoredGraph = authoredGraph;
        this.spatial = spatial;
        this.events = events;
        this.presence = presence;
        this.placedPortals = placedPortals;
        this.worldPreview = worldPreview;
        this.room = room;
        this.placements = placements;
        this.identity = identity;
        this.fabric = fabric;
        this.portals = portals;
        this.joinedUserCount = typeof joinedUserCount === 'function' ? joinedUserCount : () => 0;
    }
    getWowWorld()
    {
        return projectWowWorld({ avatar : this.avatar, world : this.world,
            location : this.location, session : this.session, portals : this.readPortals(),
            anchor : this.anchor, graphIds : this.spatial.spatialGraphIds(), revision : this.events.currentRevision().revision,
            activeUsers : this.presence.livePresenceEntries(Date.now()).length, joinedUsers : this.joinedUserCount(), portalCount : this.placedPortals.count(),
            preview : this.worldPreview.ofWorld(), room : this.room, liveUsers : this.presence.users(),
            authoredGraph : this.authoredGraph, worldId : this.identity.WORLD_ID });
    }

    getWowEventsHello()
    {
        return {
            type : 'hello',
            ts : new Date().toISOString(),
            location_id : this.identity.LOCATION_ID,
            world_id : this.identity.WORLD_ID,
            spatialID : this.identity.WORLD_ID,
            users : this.presence.users(),
            convention : 'WS /events (labeled non-canonical; wow-spec/OSL-WOW-CONTRACT.md §6)',
            event_types : [ 'user_joined', 'user_left', 'node_created', 'node_updated', 'node_deleted' ],
            revision : this.events.currentRevision().revision,
            time : this.events.currentRevision().time,
            presence_scope : 'server-side-ttl-registry (local occupancy truth; not networked)',
            proof_boundary : getWowProofBoundary(),
        };
    }

    getWowView(viewId)
    {
        const id = this.placements.hostedNodeId('view');
        const placed = id != null && this.spatial.storeOfNode(id) ? id : null;
        return projectWowView({ avatar : this.avatar, viewId, placed,
            node : placed != null ? this.spatial.nodeRef(this.spatial.primary, placed) : undefined,
            placedGeoPose : this.placements.geoPoseOfNode(placed), anchor : this.anchor });
    }

    getWowLocation()
    {
        const { LOCATION_ID, TITLE, NODE_ROLE, WORLD_ID, SESSION_ID, PUBLIC_BASE_URL } = this.identity;
        return projectWowLocation({ locationId : LOCATION_ID, title : TITLE, nodeRole : NODE_ROLE,
            worldId : WORLD_ID, sessionId : SESSION_ID, baseUrl : PUBLIC_BASE_URL,
            authoredGraph : this.authoredGraph, spawn : this.fabric.getFabricSpawnPose(), portals : this.readPortals() });
    }

    getWowGraph()
    {
        if (!this.authoredGraph) return null;
        const { LOCATION_ID, WORLD_ID, SESSION_ID, NODE_ROLE, PUBLIC_BASE_URL } = this.identity;
        return projectWowGraph({ authoredGraph : this.authoredGraph, locationId : LOCATION_ID,
            worldId : WORLD_ID, sessionId : SESSION_ID, nodeRole : NODE_ROLE, baseUrl : PUBLIC_BASE_URL,
            portals : this.readPortals().map((portal, index) => this.portals.getWowPortalResource(index + 1)) });
    }
}
function createRuntimeWorldReader(options)
{
    const reader = new RuntimeWorldReader(options);
    return {
        getWowWorld : reader.getWowWorld.bind(reader),
        getWowEventsHello : reader.getWowEventsHello.bind(reader),
        getWowView : reader.getWowView.bind(reader),
        getWowLocation : reader.getWowLocation.bind(reader),
        getWowGraph : reader.getWowGraph.bind(reader),
    };
}
module.exports = { createRuntimeWorldReader };
