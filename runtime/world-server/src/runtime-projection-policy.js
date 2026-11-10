'use strict';
/** Shared existing geometry and resource constants; these do not establish standards conformance. */
const FABRIC_PORTAL_FRAME_PRESETS = {
    'location-a' : { forward : [ 0, 0, 1 ] },
    'location-b' : { forward : [ -1, 0, 0 ] },
    'location-lobby' : { forward : [ 0, 0, 1 ] },
    'location-airport' : { forward : [ 0, 0, 1 ] },
};
const FABRIC_PORTAL_FRAME_WIDTH_M = 1.8;
const FABRIC_PORTAL_FRAME_HEIGHT_M = 2.8;
const FABRIC_PORTAL_TRIGGER_DEPTH_M = 0.8;
const FABRIC_SPAWN_CLEARANCE_M = 2.4;
const FABRIC_TRIGGER_BOUND_MAX = [
    FABRIC_PORTAL_FRAME_WIDTH_M / 2,
    FABRIC_PORTAL_FRAME_HEIGHT_M / 2,
    0.9,
];
const FABRIC_BACKGROUND_RRGGBB = '0B1020';

const WOW_GEOPOSE_MAPPING = {
    frame : 'graph frame anchored by the graph GeoPose: metres, right-handed, +X east, +Y up, +Z south at zero angles (WGS-84)',
    lat : 'geodetic latitude of the local point, through the anchor',
    lon : 'geodetic longitude of the local point, through the anchor (the World API at d39a1a0 spells it lan)',
    h : 'height above the WGS-84 ellipsoid, in metres',
    angles : 'degrees; the pose angles about the graph axes (yaw about +Y with 0 facing local +Z, scene rotation_y) plus the anchor angles; roll fixed 0',
};

const WOW_LOCAL_USER_ID = 1;
const WOW_PLAYER_VIEW_ID = 1;
const WOW_VIEW_CAMERA_RIG = {
    mode : 'over_shoulder_follow',
    follow_distance_m : 3.5,
    follow_height_m : 2.1,
    look_target_height_m : 1.35,
};

module.exports = { FABRIC_PORTAL_FRAME_PRESETS, FABRIC_PORTAL_FRAME_WIDTH_M, FABRIC_PORTAL_FRAME_HEIGHT_M, FABRIC_PORTAL_TRIGGER_DEPTH_M, FABRIC_SPAWN_CLEARANCE_M, FABRIC_TRIGGER_BOUND_MAX, FABRIC_BACKGROUND_RRGGBB, WOW_GEOPOSE_MAPPING, WOW_LOCAL_USER_ID, WOW_PLAYER_VIEW_ID, WOW_VIEW_CAMERA_RIG };
