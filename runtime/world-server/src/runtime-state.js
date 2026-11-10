'use strict';

/** Compose one runtime and its existing public facade; no owner starts a resource until all bindings exist. */
const { createRuntimeState, runtimeIdentity, runtimeAnchors } = require('./runtime-initialization');
const { createRuntimeSnapshot } = require('./runtime-snapshot');
const { createRuntimeEvents } = require('./runtime-events');
const { createRuntimeSpatial } = require('./runtime-spatial');
const { createRuntimePlacements } = require('./runtime-placements');
const { buildSpatialSeedNodes } = require('./runtime-spatial-seed');
const { createRuntimePresence } = require('./runtime-presence');
const { wowUserEvent } = require('./runtime-presence-projection');
const { createPlacedPortals, createWorldPreview } = require('./portal-standard');
const { createRuntimePortalReader } = require('./runtime-portal-reader');
const { createRuntimeFabricReader } = require('./runtime-fabric-reader');
const { createRuntimeWorldReader } = require('./runtime-world-reader');
const { createRuntimeUsers } = require('./runtime-user-projection');
const { createRuntimeHandoff } = require('./runtime-handoff');
const { createRuntimeSceneView } = require('./runtime-scene-view');
const { createRuntimeSceneObjects } = require('./runtime-scene-objects');
const { createRuntimeRepublish } = require('./runtime-republish');
const { createRuntimeSimulator } = require('./runtime-simulator');
const { getWowProofBoundary } = require('./runtime-world-projection');
const { wowGeoPoseFromLocal, roundedGeoPose } = require('./runtime-view-projection');
const { authoredFabricRegionMaxRadius } = require('./runtime-fabric-region');
const { portalFrameYawRad, portalTraversalRule, portalReciprocalRule } = require('./runtime-portal-policy');
const { WOW_LOCAL_USER_ID, WOW_PLAYER_VIEW_ID, WOW_VIEW_CAMERA_RIG } = require('./runtime-projection-policy');
const { clone } = require('./runtime-projection-values');

function createRuntime(opts)
{
    const cfg = opts || {};
    const anchors = runtimeAnchors(cfg);
    const identity = runtimeIdentity(cfg);
    const { LOCATION_ID, WORLD_ID, SESSION_ID, HTTP_PORT, NODE_ROLE, TITLE } = identity;
    const authoredGraph = cfg.authored_wow_graph ? clone(cfg.authored_wow_graph) : null;
    const state = createRuntimeState(cfg, identity, authoredGraph);
    const snapshot = createRuntimeSnapshot(state, () => presence.presenceConnectedClientsProjection());
    const events = createRuntimeEvents({ worldId : WORLD_ID, replayLimit : cfg.event_replay_limit });
    const geoPose = (position, yaw, pitch) => wowGeoPoseFromLocal(anchors.get(1), position, yaw, pitch);
    const spatial = createRuntimeSpatial({ worldId : WORLD_ID, locationId : LOCATION_ID, title : TITLE, anchors,
        seedBuilder : () => buildSpatialSeedNodes({ objects : state.scene_objects, portals : state.portals,
            avatar : state.avatar, room : cfg.room, title : TITLE, worldId : WORLD_ID, locationId : LOCATION_ID,
            yaw : portalFrameYawRad(LOCATION_ID), authoredGraph, localUserId : WOW_LOCAL_USER_ID,
            playerViewId : WOW_PLAYER_VIEW_ID, cameraRig : WOW_VIEW_CAMERA_RIG, portalTraversalRule, portalReciprocalRule }),
        publish : snapshot.publish, emitEvent : events.emitWowEvent, proofBoundary : getWowProofBoundary });
    const placements = createRuntimePlacements({ spatial, anchors, readAvatar : () => state.avatar,
        cameraRig : WOW_VIEW_CAMERA_RIG, localUserId : WOW_LOCAL_USER_ID,
        playerViewId : WOW_PLAYER_VIEW_ID, roundGeoPose : roundedGeoPose });
    const presence = createRuntimePresence({ locationId : LOCATION_ID, placements,
        project : clients => { state.session.connected_clients = clients; },
        publish : snapshot.publish, emitEvent : events.emitWowEvent, proofBoundary : getWowProofBoundary });
    events.loadRevision(spatial.primary.ids.file.replace(/\.ids\.json$/, '.revision.json'));
    const placedPortals = createPlacedPortals({ configuredCount : () => state.portals.length,
        resolvePortal : id => portals.resolveWowPortal(id), storeOfNode : spatial.storeOfNode,
        nodeRef : spatial.nodeRef, geoPoseOfNode : placements.geoPoseOfNode, proofBoundary : getWowProofBoundary });
    const worldPreview = createWorldPreview({ storeOfNode : spatial.storeOfNode,
        nodeRef : spatial.nodeRef, listNodes : () => spatial.primary.listNodes() });
    const portals = createRuntimePortalReader({ readPortals : () => state.portals,
        readObjects : () => state.scene_objects, spatial, placements, placedPortals, geoPose, identity });
    const sceneView = createRuntimeSceneView({ readObjects : () => state.scene_objects,
        readPortals : () => state.portals, avatar : state.avatar, attachPoint : state.attach_point, identity });
    const sceneObjects = createRuntimeSceneObjects({ readObjects : () => state.scene_objects,
        replaceObjects : objects => { state.scene_objects = objects; }, readPortals : () => state.portals,
        defaultPortals : cfg.portals || [], attachPoint : state.attach_point, debug : state.debug,
        spatial, placements, portalYaw : () => portalFrameYawRad(LOCATION_ID), publish : snapshot.publish });
    const republish = createRuntimeRepublish({ readRate : () => state.republish_rate_ms,
        writeRate : rate => { state.republish_rate_ms = rate; }, step : sceneObjects.republishApplyAmbientDrift, identity });
    const fabric = createRuntimeFabricReader({ readPortals : () => state.portals, readObjects : () => state.scene_objects,
        attachPoint : state.attach_point, presence, portalPose : sceneView.demoPortalPose, entrySpawn : cfg.entry_spawn,
        identity, authoredGraph, maxRadius : authoredFabricRegionMaxRadius(authoredGraph), session : state.session,
        avatar : state.avatar, subscriberCount : snapshot.subscriberCount });
    const users = createRuntimeUsers({ readAvatar : () => state.avatar, readPresence : presence.livePresenceEntries,
        depart : presence.departPresence, placements, spatial, geoPose,
        sessionId : SESSION_ID, worldId : WORLD_ID, locationId : LOCATION_ID });
    const world = createRuntimeWorldReader({ avatar : state.avatar, world : state.world, location : state.location,
        session : state.session, readPortals : () => state.portals, anchor : anchors.get(1), authoredGraph,
        spatial, events, presence, placedPortals, worldPreview, room : cfg.room, placements, identity, fabric, portals });
    const handoff = createRuntimeHandoff({ avatar : state.avatar, session : state.session, debug : state.debug, identity,
        readPortals : () => state.portals, resolvePortal : portals.resolveWowPortal, placementOf : placements.placementOf,
        departPresence : presence.departPresence, presenceCount : presence.size, publish : snapshot.publish,
        getState : snapshot.getState, syncHostedPlacements : placements.syncHostedPlacements,
        arrivalCommitMode : String(cfg.arrival_commit_mode || 'sync') });
    const simulator = createRuntimeSimulator({ spatialResolve : spatial.spatialResolve,
        updateSpatialNode : spatial.updateSpatialNode, currentRevision : events.currentRevision });

    function reset()
    {
        const occupants = presence.entries();
        sceneObjects.resetScene();
        spatial.resetToSeed();
        republish.resetRate();
        state.session.arrival_count = 0;
        state.session.handoff_bootstrap = null;
        presence.clear();
        presence.stopPresenceSweeper();
        state.session.connected_clients = [];
        state.avatar.avatar_id = 'avatar-local-001';
        state.avatar.continuity_id = 'avatar-local-001';
        state.avatar.display_name = 'poc-user';
        state.avatar.transform.position = [ 0, 0, 0 ];
        state.avatar.transform.rotation_y = 0;
        state.avatar.transform.orientation = [ 0, 0, 0, 1 ];
        state.avatar.handoff_context = null;
        state.debug.last_input_source = 'reset';
        state.debug.handoff = { last_handoff_id : null, last_exit_intent : null, last_arrival : null };
        snapshot.publish();
        for (const entry of occupants) placements.unplacePresenceUser(entry);
        placements.syncHostedPlacements();
        for (const entry of occupants) events.emitWowEvent(wowUserEvent('user_left', entry, LOCATION_ID, getWowProofBoundary));
        return snapshot.getDebugState();
    }

    // Remove persisted presence placements before exposing a runtime with no occupants.
    for (const node of spatial.primary.listNodes())
        if (node.id !== placements.hostedNodeId('user') && node.webofworlds_extension?.role === 'user-placement')
            spatial.deleteSpatialNode('1', node.id);
    if (cfg.preview && typeof cfg.preview === 'object') worldPreview.set(cfg.preview);
    if (cfg.simulator && typeof cfg.simulator === 'object') simulator.startSimulator(cfg.simulator);
    republish.startRepublishTimer();

    return {
        LOCATION_ID, WORLD_ID, SESSION_ID, HTTP_PORT, NODE_ROLE,
        getState : snapshot.getState, getDebugState : snapshot.getDebugState,
        subscribe : snapshot.subscribe, subscriberCount : snapshot.subscriberCount,
        subscribeEvents : events.subscribeEvents, eventSubscriberCount : events.eventSubscriberCount,
        eventsSince : events.eventsSince, currentRevision : events.currentRevision, lastChangeOf : events.lastChangeOf,
        ...simulator, listSpatialNodes : spatial.listSpatialNodes,
        addPortal : placedPortals.add, updatePortal : placedPortals.update,
        setPreview : worldPreview.set, getPreview : worldPreview.get, placementOf : placements.placementOf,
        portalArrivalNodeId : portals.portalArrivalNodeId, setPortalJoinResolver : portals.setPortalJoinResolver,
        ...world, getWowPortal : portals.getWowPortal, getWowPortalResource : portals.getWowPortalResource,
        ...users, getWowProofBoundary, wowGeoPoseFromLocal : geoPose,
        getSpatialGraphRoot : spatial.getSpatialGraphRoot, getSpatialNode : spatial.getSpatialNode,
        getSpatialDescriptor : spatial.getSpatialDescriptor, createSpatialNodes : spatial.createSpatialNodes,
        updateSpatialNode : spatial.updateSpatialNode, deleteSpatialNode : spatial.deleteSpatialNode,
        SPATIAL_ID : WORLD_ID, ...fabric, ...handoff,
        getSceneObjects : sceneView.getSceneObjects, moveSceneObject : sceneObjects.moveSceneObject,
        movePortal : sceneObjects.movePortal, getPortalView : sceneView.getPortalView,
        getUmAttachPoint : sceneView.getUmAttachPoint, hostedObjectAccessOfNode : sceneView.hostedObjectAccessOfNode,
        registerPresence : presence.registerPresence, heartbeatPresence : presence.heartbeatPresence,
        departPresence : presence.departPresence, stopPresenceSweeper : presence.stopPresenceSweeper,
        setRepublishRate : republish.setRepublishRate, getRepublishRate : republish.getRepublishRate,
        stopRepublishTimer : republish.stopRepublishTimer,
        reset, tick : () => { state.server_tick += 1; }, _raw : state,
    };
}

module.exports = { createRuntime };
