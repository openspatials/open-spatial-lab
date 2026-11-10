'use strict';
/** Project the existing player camera rig and anchored GeoPose conversion. */
const { WOW_GEOPOSE_MAPPING, WOW_LOCAL_USER_ID, WOW_PLAYER_VIEW_ID, WOW_VIEW_CAMERA_RIG } = require('./runtime-projection-policy');
const wowGeo = require('../../../web/wow-geopose.js');
const { playerViewPose } = require('./runtime-placements');
const { getWowProofBoundary } = require('./runtime-world-projection');
function wowGeoPoseFromLocal(WORLD_ANCHOR, position, yawRad, pitchRad)
{
    const p = Array.isArray(position) ? position : [ 0, 0, 0 ];
    const local = [ Number(p[0]) || 0, Number(p[1]) || 0, Number(p[2]) || 0 ];
    return roundedGeoPose(wowGeo.localPoseToGeoPose(WORLD_ANCHOR, local, Number(yawRad) || 0, Number(pitchRad) || 0));
}
function roundedGeoPose(pose)
{
    const round = (v, places) => Number(v.toFixed(places));
    return {
        position : { lat : round(pose.position.lat, 11), lon : round(pose.position.lon, 11), h : round(pose.position.h, 4) },
        angles : { yaw : round(pose.angles.yaw, 3), pitch : round(pose.angles.pitch, 3), roll : round(pose.angles.roll, 3) },
    };
}
function getWowView({ avatar, viewId, placed, node, placedGeoPose, anchor })
{
    const accepted = [ String(WOW_PLAYER_VIEW_ID), 'player', 'player-camera' ];
    if (viewId && accepted.indexOf(String(viewId)) === -1)
        return null;
    const rig = WOW_VIEW_CAMERA_RIG;
    const pose = playerViewPose(avatar, rig);
    const yaw = pose.yaw;
    const cameraPosition = pose.position;
    const p = avatar.transform.position;
    const lookTarget = [
        Number(p[0]) || 0,
        (Number(p[1]) || 0) + rig.look_target_height_m,
        Number(p[2]) || 0,
    ];
    const pitchRad = pose.pitch;
    return {
        id : WOW_PLAYER_VIEW_ID, // number, per WoW View schema
        ...(placed != null ? { node : node } : {}),
        geoPose : placedGeoPose || wowGeoPoseFromLocal(anchor, cameraPosition, yaw, pitchRad),
        webofworlds_extension : {
            view_kind : 'player-view-camera',
            mode : rig.mode,
            derivation : 'server-side projection of the live presence pose through the '
                + 'PlayerView camera rig constants (matches the browser runtime '
                + 'PLAYER_CAMERA_DEFAULT: follow 3.5 m, height 2.1 m, look target 1.35 m)',
            rig : {
                follow_distance_m : rig.follow_distance_m,
                follow_height_m : rig.follow_height_m,
                look_target_height_m : rig.look_target_height_m,
            },
            follows_user_id : WOW_LOCAL_USER_ID,
            follows_avatar_id : avatar.avatar_id,
            accepted_aliases : accepted,
            local_camera : {
                position : cameraPosition.map(entry => Number(entry.toFixed(4))),
                look_target : lookTarget.map(entry => Number(entry.toFixed(4))),
                yaw_radians : Number(yaw.toFixed(6)),
                pitch_radians : Number(pitchRad.toFixed(6)),
            },
            geopose_mapping : WOW_GEOPOSE_MAPPING,
        },
        proof_boundary : getWowProofBoundary(),
    };
}

module.exports = { wowGeoPoseFromLocal, roundedGeoPose, getWowView };
