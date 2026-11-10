'use strict';
const { translationMatrix, multiplyMatrices, rotationYMatrix, rotationXMatrix } = require('./spatial-graph');
const { composedTransform } = require('./portal-standard');
const wowGeo = require('../../../web/wow-geopose.js');

function finiteNumber(value) { const n = Number(value); return Number.isFinite(n) ? n : 0; }
function placementMatrix(position, yawRad, pitchRad)
{
    return multiplyMatrices(translationMatrix(position),
        multiplyMatrices(rotationYMatrix(Number(yawRad) || 0), rotationXMatrix(-(Number(pitchRad) || 0))));
}

function hostedUserPose(avatar)
{
    const t = avatar.transform;
    return { position : t.position.slice(), yaw : finiteNumber(t.rotation_y), pitch : 0 };
}

function playerViewPose(avatar, rig)
{
    const t = avatar.transform;
    const yaw = finiteNumber(t.rotation_y);
    const p = t.position;
    const forward = [ Math.sin(yaw), 0, Math.cos(yaw) ];
    return {
        position : [
            (Number(p[0]) || 0) - forward[0] * rig.follow_distance_m,
            (Number(p[1]) || 0) + rig.follow_height_m,
            (Number(p[2]) || 0) - forward[2] * rig.follow_distance_m,
        ],
        yaw,
        pitch : Math.atan2(rig.look_target_height_m - rig.follow_height_m, rig.follow_distance_m),
    };
}

function placementSeed(kind, id, label, pose)
{
    return {
        label : label,
        names : [ 'wow-' + kind + '-' + id, kind ],
        localTransform : placementMatrix(pose.position, pose.yaw, pose.pitch),
        webofworlds_extension : { role : kind + '-placement', resource : '/wow/' + kind + '/' + id },
    };
}

function presencePose(entry)
{
    return {
        position : Array.isArray(entry.position) ? entry.position.slice() : [ 0, 0, 0 ],
        yaw : Number.isFinite(entry.rotation_y) ? entry.rotation_y : 0,
        pitch : 0,
    };
}
class RuntimePlacements
{
    constructor({ spatial, anchors, readAvatar, cameraRig, localUserId, playerViewId, roundGeoPose })
    {
        this.spatial = spatial;
        this.anchors = anchors;
        this.readAvatar = readAvatar;
        this.cameraRig = cameraRig;
        this.roundGeoPose = roundGeoPose;
        this.hosted = { user : this.seededNodeId('wow-user-' + localUserId),
            view : this.seededNodeId('wow-view-' + playerViewId) };
        this.presence = new Map();
    }

    hostedNodeId(kind) { return this.hosted[kind]; }
    presenceNodeId(id) { return this.presence.get(id); }
    placementOf(nodeId)
    {
        const store = this.spatial.storeOfNode(nodeId);
        if (!store) return null;
        const m = composedTransform(store, nodeId);
        const length = Math.hypot(m[8], m[9], m[10]);
        const yaw = Math.hypot(m[8], m[10]) > 1e-12 ? Math.atan2(m[8], m[10]) : 0;
        const pitch = length > 1e-12 ? Math.asin(Math.max(-1, Math.min(1, m[9] / length))) : 0;
        return { store, graphId : store.graphId, matrix : m, position : [ m[12], m[13], m[14] ], yaw, pitch };
    }

    geoPoseOfNode(nodeId)
    {
        const at = nodeId == null ? null : this.placementOf(nodeId);
        const anchor = at && this.anchors.get(at.graphId);
        return anchor ? this.roundGeoPose(wowGeo.localPoseToGeoPose(anchor, at.position, at.yaw, at.pitch)) : undefined;
    }

    seededNodeId(name)
    {
        const hit = this.spatial.primary.listNodes().find(node => Array.isArray(node.names) && node.names.indexOf(name) !== -1);
        return hit ? hit.id : null;
    }

    movePlacement(nodeId, pose)
    {
        if (nodeId == null || !this.spatial.storeOfNode(nodeId)) return;
        this.spatial.updateSpatialNode(String(1), nodeId, { localTransform : placementMatrix(pose.position, pose.yaw, pose.pitch) }, { form : 'flat' });
    }

    syncHostedPlacements()
    {
        this.movePlacement(this.hosted.user, hostedUserPose(this.readAvatar()));
        this.movePlacement(this.hosted.view, playerViewPose(this.readAvatar(), this.cameraRig));
    }

    placePresenceUser(entry)
    {
        if (this.presence.has(entry.wow_user_id)) return;
        const r = this.spatial.createSpatialNodes(String(1), this.spatial.primary.rootId,
            [ placementSeed('user', entry.wow_user_id, 'User ' + entry.wow_user_id + ' (' + entry.display_name + ')', presencePose(entry)) ],
            { form : 'flat' });
        if (r.ok && r.value && r.value[0]) this.presence.set(entry.wow_user_id, r.value[0].id);
    }

    movePresenceUser(entry)
    {
        this.movePlacement(this.presence.get(entry.wow_user_id), presencePose(entry));
    }

    unplacePresenceUser(entry)
    {
        const nodeId = this.presence.get(entry.wow_user_id);
        this.presence.delete(entry.wow_user_id);
        if (nodeId != null && this.spatial.storeOfNode(nodeId)) this.spatial.deleteSpatialNode(String(1), nodeId);
    }
}

function createRuntimePlacements(options)
{
    const owner = new RuntimePlacements(options);
    return {
        seededNodeId : owner.seededNodeId.bind(owner),
        hostedNodeId : owner.hostedNodeId.bind(owner),
        presenceNodeId : owner.presenceNodeId.bind(owner),
        placementOf : owner.placementOf.bind(owner),
        geoPoseOfNode : owner.geoPoseOfNode.bind(owner),
        syncHostedPlacements : owner.syncHostedPlacements.bind(owner),
        placePresenceUser : owner.placePresenceUser.bind(owner),
        movePresenceUser : owner.movePresenceUser.bind(owner),
        unplacePresenceUser : owner.unplacePresenceUser.bind(owner),
    };
}

module.exports = { createRuntimePlacements, hostedUserPose, playerViewPose, placementSeed };
