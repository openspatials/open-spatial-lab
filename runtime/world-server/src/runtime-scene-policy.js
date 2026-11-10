'use strict';
const DEMO_SCENE_OBJECT_LIMIT_M = 5.4; // mirrors the client's WORLD_LIMIT
const DEMO_PORTAL_LIMIT_M = 5.0;
const DEMO_WORLD_BASE_COLOR = {
    'location-a' : '#143856',
    'location-b' : '#592b14',
    'location-lobby' : '#1c4030',
    'location-airport' : '#15364a',
};

const DEMO_PORTAL_LOADING_BRAND = {
    'location-a' : {
        accent_hex : '#3aa0ff',
        tagline : 'Origin Gallery — where the demo begins',
        estimated_load_ms : 2400,
        instructions : [ 'WASD to walk', 'Space to hop', 'drag to orbit the camera' ],
    },
    'location-b' : {
        accent_hex : '#ff7a3a',
        tagline : 'Arrival Hall — the far side of the crossing',
        estimated_load_ms : 2800,
        instructions : [ 'WASD to walk', 'the return portal is behind you', 'drag to orbit the camera' ],
    },
    'location-lobby' : {
        accent_hex : '#42d68a',
        tagline : 'Lobby — gather here, then choose a destination portal',
        estimated_load_ms : 2000,
        instructions : [ 'WASD to walk', 'two portals ahead: Location A left, Location B right', 'drag to orbit the camera' ],
    },
    'location-airport' : {
        accent_hex : '#4db6d6',
        tagline : 'Denver Skyport - Concourse A and Gate A12',
        estimated_load_ms : 2600,
        instructions : [ 'WASD to walk', 'Gate A12 is down the concourse', 'return portal is behind the entry spawn' ],
    },
};

const RESTRICTED_OBJECT_COLOR = '#ffc400';
const HIDDEN_OBJECT_COLOR = '#ff2d55';
const ACCESS_DEMO_SIZE_M = 1.0;
function demoExtensionBoundary()
{
    return {
        demo_extension : true,
        claim : 'runtime demo extension — reloadable hosted portal-view point; '
            + 'NOT a Universal Manifest, IWPS, or Web of Worlds spec resource',
        standards_conformance : false,
        um_conformance : false,
        iwps_conformance : false,
    };
}
function demoClampMeters(value, limit, fallback)
{
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(-limit, Math.min(limit, n));
}

module.exports = { DEMO_SCENE_OBJECT_LIMIT_M, DEMO_PORTAL_LIMIT_M, DEMO_WORLD_BASE_COLOR, DEMO_PORTAL_LOADING_BRAND, RESTRICTED_OBJECT_COLOR, HIDDEN_OBJECT_COLOR, ACCESS_DEMO_SIZE_M, demoExtensionBoundary, demoClampMeters };
