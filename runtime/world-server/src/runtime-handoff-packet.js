'use strict';
function buildHandoffPacket(portal, avatar, revision, identity, { handoffId, now })
{
    return {
        ok : true,
        handoff_id : handoffId,
        behavior : 'application-level-handoff-around-teleportxr',
        native_teleportxr_teleport : false,
        created_at : now,
        source : {
            location_id : identity.LOCATION_ID,
            world_id : identity.WORLD_ID,
            session_id : identity.SESSION_ID,
            base_url : identity.PUBLIC_BASE_URL,
        },
        target : {
            location_id : portal.target_location_id,
            world_id : portal.target_world_id,
            base_url : portal.target_base_url,
            arrival_endpoint : '/portal/arrival',
            session_endpoint : '/sessions',
            arrival_position : portal.arrival.position,
            arrival_rotation_y : portal.arrival.rotation_y,
        },
        portal : portalPacket(portal),
        avatar_context : avatarPacket(avatar, revision, identity),
    };
}
function portalPacket(portal)
{
    return {
        portal_id : portal.portal_id,
        source_location_id : portal.source_location_id,
        source_world_id : portal.source_world_id,
        target_location_id : portal.target_location_id,
        target_world_id : portal.target_world_id,
        target_base_url : portal.target_base_url,
        exit_endpoint : '/portal/exit-intent',
        arrival_endpoint : '/portal/arrival',
        handoff_behavior : 'application-level-handoff-around-teleportxr',
        native_teleportxr_teleport : false,
        trigger : {
            position : portal.trigger.position,
            radius_m : portal.trigger.radius_m,
        },
        arrival : {
            position : portal.arrival.position,
            orientation : [ 0, 0, 0, 1 ],
            rotation_y : portal.arrival.rotation_y,
        },
    };
}
function avatarPacket(avatar, revision, identity)
{
    return {
        avatar_id : avatar.avatar_id,
        continuity_id : avatar.continuity_id,
        display_name : avatar.display_name,
        transform : {
            position : avatar.transform.position.slice(),
            rotation_y : avatar.transform.rotation_y,
            orientation : avatar.transform.orientation.slice(),
            scale : avatar.transform.scale.slice(),
        },
        source_session_id : identity.SESSION_ID,
        source_world_id : identity.WORLD_ID,
        source_location_id : identity.LOCATION_ID,
        state_revision : revision,
    };
}

module.exports = { buildHandoffPacket };
