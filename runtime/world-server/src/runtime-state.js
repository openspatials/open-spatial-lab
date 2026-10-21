'use strict';

/*
 * Lane 3 standalone backend node runtime state.
 *
 * FAITHFUL RE-MODEL of the TeleportXR POC runtime state ownership, traced to:
 *     teleport-nodejs-server-example/src/runtime-state.js
 *   - clone()                        : POC lines 182-185 (JSON deep clone)
 *   - bumpRevision()                 : POC lines 211-215
 *   - notifySubscribers()            : POC lines 217-231
 *   - getState()                     : POC lines 233-236 (returns clone(state))
 *   - getDebugState()                : POC lines 238-249 (returns clone of a subset)
 *   - recordPortalExitIntent()       : POC lines ~440-470
 *   - recordPortalArrival()          : POC lines 472-524 (arrival_count += 1 at 501)
 *
 * CLAIM BOUNDARY (never upgraded): local server truth only. This module makes
 * NO claim of native TeleportXR teleport, first-party rendering, reliability,
 * security, persistence, or standards conformance. See getWowProofBoundary().
 *
 * The arrival_count increment here is SYNCHRONOUS and committed to the live
 * `state` object BEFORE recordPortalArrival() returns and BEFORE any read via
 * getDebugState(). This faithfully mirrors the POC. It is the control against
 * which the T-R3 "lag" hypothesis is tested (see test/tr3-investigation.js).
 */

// the OSL-native Spatial Composition Graph store
// backing GET/POST/PUT/DELETE /wow/spatial/... (canonical WoW `Node`s). Vanilla
// Node, additive; see spatial-graph.js for the store + env-gated persistence.
const { createSpatialGraphStore, translationMatrix } = require('./spatial-graph');
const { loadAnchors } = require('./spatial-anchor');
const wowGeo = require('../../../web/wow-geopose.js');

// P1: the shared-edge identity derivation is single-sourced
// in config.js (where the topology is validated at load); descriptors reuse it.
const { portalEdgeId } = require('./config');

// ---- UM identity signer (the IDENTITY trust spine) --------
//
// Brings the retained UniversalManifest identity spine LIVE on /wow/user. REUSES
// the proven, standalone signing library (web/signing/) — Ed25519 (WebCrypto) +
// RFC 8785 JCS canonicalization + did:key binding + UM Signature Profile A shape.
// The library is ESM + browser-safe; this CommonJS backend loads it via dynamic
// import() (absolute file URL, cwd-independent). No crypto is reimplemented here.
//
// TWO TRUST SPINES STAY SEPARATE. This is the IDENTITY spine (Ed25519 / JCS-
// RFC8785 / did:key). The .msf engine spine (src/fabric-signer.js, RS256/x5c) is a
// DIFFERENT crypto profile and stays DEFERRED — UM is NEVER routed through the
// fabric signer, and this signer never touches the .msf path. did:key only
// (did:pkh:solana / did:web live-resolution stay out of scope, per the library).
//
// The signing key is a DETERMINISTIC local demo identity key derived from a labeled
// constant, so the did:key identity is STABLE across restarts and obviously NOT a
// real user credential (same honesty posture as the dev root CA). Honesty: the
// signature is REAL, but standards_conformance stays false on the /wow surface and
// the signed field is labeled non-canonical additive (see getWowUserSigned).
const crypto = require('crypto');
const nodePath = require('path');
const { pathToFileURL } = require('url');

const UM_SIGNING_LIB_URL = pathToFileURL(
    nodePath.join(__dirname, '..', '..', '..', 'web', 'signing', 'index.mjs')).href;
let _umSigningLibPromise = null;
function umSigningLib()
{
    if (!_umSigningLibPromise) _umSigningLibPromise = import(UM_SIGNING_LIB_URL);
    return _umSigningLibPromise;
}
// Deterministic local demo seed (32 bytes) from a labeled constant -> stable did:key.
// NOT a real credential; obviously a demo key. did:key only.
const UM_DEV_IDENTITY_SEED = new Uint8Array(crypto.createHash('sha256')
    .update('open-spatial-lab-local-identity-v1')
    .digest());
// Labeled non-PII placeholder for the OpenUserManifest `age` field (WoW's User is
// silent on age; this is a demo value, not real user data).
const WOW_OPEN_USER_MANIFEST_DEMO_AGE = 30;
// Honest label carried on a SIBLING field of the /wow/user response (NEVER inside
// the signed bytes, which stay exactly {name,age,avatarAssetURI,signature} so the
// client can verify byte-exact as-is).
const UM_IDENTITY_NONCANONICAL_LABEL =
    'non-canonical additive (x-osl-extension): REAL UM identity signature '
    + '(Ed25519 over JCS-RFC8785 canonical bytes; did:key). standards_conformance stays false; '
    + 'separate from the deferred .msf RS256/x5c engine spine.';
// Cache signed manifests by canonical content so an unchanged identity never re-signs.
const _umSignedCache = new Map();

/**
 * Sign the OpenUserManifest content {name, age, avatarAssetURI} per UM Signature
 * Profile A and return the signed manifest {name, age, avatarAssetURI,
 * signature:{...}}. Cached by canonical content. The Profile A signing input is
 * the content MINUS `signature`, so a consumer verifies byte-exact over exactly
 * these three fields. REUSE ONLY — all crypto is the proven web/signing library.
 */
async function umSignOpenUserManifest(content)
{
    const lib = await umSigningLib();
    const canon = lib.canonicalizeToString(content);
    if (_umSignedCache.has(canon)) return _umSignedCache.get(canon);
    const signed = await lib.attachSignatureProfileA(content, UM_DEV_IDENTITY_SEED);
    _umSignedCache.set(canon, signed);
    return signed;
}

// ---- OMB fabric-manifest constants ------------------------
// These MIRROR the live client's portal-frame constants in prototype 057
// web/live-adapter.js (PORTAL_FRAME_PRESETS, PORTAL_FRAME_WIDTH_M,
// PORTAL_FRAME_HEIGHT_M, PORTAL_TRIGGER_DEPTH_M and the sourceSpawn clearance)
// so the fabric's primary.camera equals the client's avatar spawn pose exactly.
const FABRIC_PORTAL_FRAME_PRESETS = {
    'location-a' : { forward : [ 0, 0, 1 ] },
    'location-b' : { forward : [ -1, 0, 0 ] },
    // both lobby portals face +z toward the spawn area.
    'location-lobby' : { forward : [ 0, 0, 1 ] },
    // the airport authored frame is y-up, entrant +z.
    'location-airport' : { forward : [ 0, 0, 1 ] },
};
const FABRIC_PORTAL_FRAME_WIDTH_M = 1.8;
const FABRIC_PORTAL_FRAME_HEIGHT_M = 2.8;
const FABRIC_PORTAL_TRIGGER_DEPTH_M = 0.8;
const FABRIC_SPAWN_CLEARANCE_M = 2.4;
// Trigger-volume half-extents around the portal node (architecture doc §4.2):
// [frame width/2, frame height/2, trigger depth + plane tolerance padding].
const FABRIC_TRIGGER_BOUND_MAX = [
    FABRIC_PORTAL_FRAME_WIDTH_M / 2,
    FABRIC_PORTAL_FRAME_HEIGHT_M / 2,
    0.9,
];
// Scene backdrop currently rendered behind both demo worlds (the frontend's
// #scene-mount radial gradient base #0b1020), projected as a flat RRGGBB.
const FABRIC_BACKGROUND_RRGGBB = '0B1020';

// ---- Web of Worlds (OpenSpatialWorld) conformance constants ----
//
// The /wow/* read surface follows the real Web of Worlds OpenAPI:
//     WoWAPI/specification/
//     OpenSpatialWorld/API.yaml
// (schemas World, User, View, Portal; runnable reference: repos/simpleWorlds).
//
// Every GeoPose is { position: { lat, lon, h }, angles: { yaw, pitch, roll } } (OGC GeoPose
// Basic-YPR; the World API at d39a1a0 spells longitude `lan`, which the reader still accepts).
// A graph's anchor GeoPose places its origin on the WGS-84 ellipsoid: at zero angles local +X is
// east, +Y is up and +Z is south, in metres. A position inside the graph is converted to
// geographic coordinates through that anchor (EPSG 9837 inverse, web/wow-geopose.js), and the
// angles are the pose's angles about the graph's axes plus the anchor's own. The anchors are lab
// placements, not surveyed ones, and no standards conformance is claimed (see getWowProofBoundary()).
const WOW_GEOPOSE_MAPPING = {
    frame : 'graph frame anchored by the graph GeoPose: metres, right-handed, +X east, +Y up, +Z south at zero angles (WGS-84)',
    lat : 'geodetic latitude of the local point, through the anchor',
    lon : 'geodetic longitude of the local point, through the anchor (the World API at d39a1a0 spells it lan)',
    h : 'height above the WGS-84 ellipsoid, in metres',
    angles : 'degrees; the pose angles about the graph axes (yaw about +Y with 0 facing local +Z, scene rotation_y) plus the anchor angles; roll fixed 0',
};

// Fixed per-world Web of Worlds resource ids (spec path params are integers).
// One local user (the demo avatar) and one view (the PlayerView camera seat).
const WOW_LOCAL_USER_ID = 1;
const WOW_PLAYER_VIEW_ID = 1;

// WoW `/wow/user` ids minted for the players in
// the server-side TTL presence registry, so live occupancy is addressable as
// WoW User resources without colliding with the hosted-avatar id (1). A base
// far above the fixed ids keeps the presence-user range obviously distinct and
// legible (1001, 1002, ...). This is a LABELED reference-impl convention (the
// realtime `WS /events` leg), NOT canonical OpenSpatialWorld surface.
const WOW_PRESENCE_USER_ID_BASE = 1000;

// ---- DEMO EXTENSION: hosted scene objects + portal-view ----
//
// Each world server HOSTS a small set of simple primitives (cubes/spheres) and
// a "UM attach-point": ONE reloadable hosted resource whose value IS the view
// seen through a portal INTO this world. This models the documented
// fallback: the Universal Manifest ATTACHES to a point hosted by the server;
// clients RE-READ (reload) that point — the server NEVER streams it. Every
// mutation (object move / portal move) bumps the point's version so a reloading
// client can detect change cheaply.
//
// CLAIM BOUNDARY: this is a labeled DEMO EXTENSION (project-local
// interpretation). It is NOT defined by any published Universal Manifest, IWPS,
// or Web of Worlds spec; standards_conformance stays false on every response.
const DEMO_SCENE_OBJECT_LIMIT_M = 5.4; // mirrors the client's WORLD_LIMIT
const DEMO_PORTAL_LIMIT_M = 5.0;
// Base room tint per world (matches the client's accent*0.35 room dressing).
const DEMO_WORLD_BASE_COLOR = {
    'location-a' : '#143856',
    'location-b' : '#592b14',
    // lobby base tint (neutral green gathering space).
    'location-lobby' : '#1c4030',
    'location-airport' : '#15364a',
};

// BEGIN — loading-content-through-the-portal (portaling bar P11).
// Each world server hosts its OWN branded loading content under the agreed
// `metaverse.portal.*` pointer names (TeleportVR/UM integration packet) so the
// SOURCE world can render the DESTINATION's loading experience through the portal
// before the handshake completes. These are the destination's hosted VALUES —
// the client never hardcodes them. DEMONSTRATION-ONLY (interface requirement, not a
// use-case-page conformance bar); pointer names are packet SUGGESTIONS, not a
// published UM/IWPS/WoW spec surface; no conformance flag is flipped.
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
    // the lobby's own loading brand.
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
// END

// BEGIN — server-side per-location player presence registry.
// Registration/heartbeat/departure are EXPLICIT session actions a player client
// POSTs against its OWN currently-active server (never against a prefetch
// destination). Entries expire on TTL so a closed/crashed tab never leaves
// ghost occupancy. This registry is the ONE server-side presence truth shared
// by /fabric/presence occupancy summaries (prefetch HUD) and — per the pairing
// with — by observer views via session.connected_clients.
const PRESENCE_TTL_DEFAULT_MS = 10000;
const PRESENCE_TTL_MIN_MS = 1000;
const PRESENCE_TTL_MAX_MS = 60000;
const PRESENCE_SWEEP_INTERVAL_MS = 1000;
const PRESENCE_HEARTBEAT_HINT_MS = 3000;
const PRESENCE_MAX_PLAYERS = 64;
// the DEPARTURE TOMBSTONE.
//
// The heartbeat's unknown-player UPSERT exists so a live client self-heals across a
// server restart. But it is also the exact mechanism by which a player who has just
// LEFT gets resurrected: a heartbeat POST that was already in flight when the player
// departed lands AFTER the depart and re-registers them for a full TTL. The client
// comments have named this race ("dropped depart, heartbeat/depart race
// at a crossing") and paid for it with a 10-second ghost: the origin still listed the
// player, and the through-ring proxy layer (which draws LIVE presence membership)
// therefore drew a capsule of the player still standing on the far side of the portal.
//
// A tombstone is the smallest honest fix: for TOMBSTONE_MS after an explicit depart,
// "unknown player" means GONE, not "lost" — so a stale heartbeat cannot upsert them
// back. It only ever blocks the heartbeat-upsert path; an EXPLICIT register (the
// player genuinely arriving, including walking straight back through the portal)
// always clears the tombstone and wins. Sized above the client heartbeat interval
// (3000 ms) so an in-flight beat cannot outlive it.
const PRESENCE_DEPART_TOMBSTONE_MS = 5000;
// END

function demoDefaultSceneObjects(locationId)
{
    // Positions deliberately keep the portal approach corridor (x≈2.8,
    // z 0.4→-2.8 in A; the -x exit lane at z≈-2.8 in B) clear so the
    // keyboard walk-through path is untouched.
    if (locationId === 'location-b')
    {
        return [
            { object_id : 'obj-b-cube-1', shape : 'box', size_m : 0.8, color : '#ff8c42', position : [ -2.4, 0.4, -1.2 ] },
            { object_id : 'obj-b-sphere-1', shape : 'sphere', size_m : 0.7, color : '#ffd166', position : [ 1.6, 0.35, 1.8 ] },
            { object_id : 'obj-b-cube-2', shape : 'box', size_m : 0.6, color : '#c65ccd', position : [ -0.8, 0.3, 2.6 ] },
        ];
    }
    // lobby furniture. The two benches flank the spawn
    // area outside the portal prefetch zones, leaving every approach clear.
    if (locationId === 'location-lobby')
    {
        return [
            { object_id : 'obj-lobby-bench-1', shape : 'box', size_m : 0.6, color : '#9fb0d0', position : [ -4.4, 0.3, 1.6 ] },
            { object_id : 'obj-lobby-bench-2', shape : 'box', size_m : 0.6, color : '#9fb0d0', position : [ 4.4, 0.3, 1.6 ] },
        ];
    }
    return [
        { object_id : 'obj-a-cube-1', shape : 'box', size_m : 0.8, color : '#2bd4ff', position : [ -2.2, 0.4, 1.6 ] },
        { object_id : 'obj-a-sphere-1', shape : 'sphere', size_m : 0.7, color : '#6ee7a8', position : [ 1.8, 0.35, -0.6 ] },
        { object_id : 'obj-a-cube-2', shape : 'box', size_m : 0.6, color : '#8a7dff', position : [ -1.2, 0.3, -2.2 ] },
    ];
}

/**
 * Project authored WoW graph nodes into the existing hosted-scene entity seam.
 * The checked-in graph stays the source of labels, roles, assets, transforms,
 * bounds, storefronts, NPCs, and Gate A12; fabric region reads then expose that
 * authored content without a second airport-specific presence/region system.
 */
function authoredGraphSceneObjects(graph)
{
    if (!graph || !Array.isArray(graph.nodes)) return [];
    const rootId = Number(graph.root);
    return graph.nodes
        .filter(node => node && Number(node.id) !== rootId && node.label !== '__wow_internal_root')
        .map(node => {
            const transform = Array.isArray(node.localTransform) ? node.localTransform : [];
            const extension = node.webofworlds_extension && typeof node.webofworlds_extension === 'object'
                ? JSON.parse(JSON.stringify(node.webofworlds_extension))
                : null;
            const accent = Number(extension && extension.accent);
            return {
                object_id : 'wow-node-' + node.id,
                node_id : Number(node.id),
                label : String(node.label || ('WoW node ' + node.id)),
                shape : 'box',
                size_m : 0.5,
                color : Number.isFinite(accent)
                    ? '#' + Math.max(0, Math.min(0xffffff, accent)).toString(16).padStart(6, '0')
                    : '#8fc7d9',
                position : [
                    Number(transform[12]) || 0,
                    Number(transform[13]) || 0,
                    Number(transform[14]) || 0,
                ],
                spatial_asset_uri : node.spatialAssetURI || null,
                authored_wow_content : true,
                webofworlds_extension : extension,
            };
        });
}

/**
 * Bound authored-graph neighborhood reads by the broadest walkable surface's
 * narrow planar span. This gives a large authored space enough local context
 * to render a meaningful portal aperture without turning a region request into
 * a whole-world download. Graphs without authored walkable geometry retain the
 * legacy 12 m room cap exactly.
 */
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

// OPT-IN synthetic fabric density fixture. The three
// hosted primitives per world are too few to exercise chunked/progressive
// region streaming (bands, budgets, truncation, eviction, background
// completion), so a targeted scene can densify a world's fabric via
//   OSL_FABRIC_DENSITY_FIXTURE='{"location-a":{"band_quotas":[15,12,12,14]}}'
// (same env-hook pattern as OSL_PORTAL_TRAVERSAL_OVERRIDES). Placement is
// DETERMINISTIC — golden-angle spiral rings around the world's first portal
// anchor, quota per radial band mirroring the /fabric/region chunk bands —
// so band populations are reproducible in assertions. Every synthetic entity
// is labeled `synthetic_density_fixture:true`. Default (env unset): returns
// [] and every world's scene_objects stay byte-identical to pre-006.
const FABRIC_DENSITY_FIXTURE_PALETTE = [
    '#2bd4ff', '#6ee7a8', '#8a7dff', '#ff8c42', '#ffd166', '#c65ccd', '#9fb0d0', '#42d68a',
];

function densityFixtureFor(locationId)
{
    const raw = process.env.OSL_FABRIC_DENSITY_FIXTURE;
    if (!raw) return null;
    try
    {
        const parsed = JSON.parse(raw);
        const hit = parsed && typeof parsed === 'object' ? parsed[locationId] : null;
        return hit && typeof hit === 'object' ? hit : null;
    }
    catch (e)
    {
        return null;
    }
}

function densityFixtureSceneObjects(locationId, portals)
{
    const fixture = densityFixtureFor(locationId);
    if (!fixture) return [];
    const firstPortal = Array.isArray(portals) && portals.length ? portals[0] : null;
    const anchor = firstPortal && firstPortal.trigger
        && Array.isArray(firstPortal.trigger.position)
        ? firstPortal.trigger.position
        : [ 0, 0, 0 ];
    const quotas = Array.isArray(fixture.band_quotas) && fixture.band_quotas.length
        ? fixture.band_quotas.map(n => Math.max(0, Math.floor(Number(n) || 0)))
        : [ 15, 12, 12, 14 ];
    const roi = Number(fixture.roi_radius_m) > 0 ? Number(fixture.roi_radius_m) : 5.0;
    const beyondMax = Number(fixture.max_radius_m) > 0 ? Number(fixture.max_radius_m) : 9.0;
    // Radial ranges mirror the chunk bands: three equal rings inside the ROI
    // plus one beyond-ROI ring feeding post-arrival background completion.
    // Margins keep every entity strictly inside its band (no boundary flap).
    const ranges = [
        [ 0.7, (roi / 3) * 0.94 ],
        [ (roi / 3) * 1.04, ((2 * roi) / 3) * 0.96 ],
        [ ((2 * roi) / 3) * 1.03, roi * 0.96 ],
        [ roi * 1.08, beyondMax ],
    ];
    const GOLDEN_ANGLE = 2.399963229728653;
    const objects = [];
    let serial = 0;
    quotas.forEach((count, band) => {
        const range = ranges[band] || ranges[ranges.length - 1];
        for (let j = 0; j < count; j += 1)
        {
            const frac = count <= 1 ? 0.5 : j / (count - 1);
            const r = range[0] + (range[1] - range[0]) * (0.06 + 0.88 * frac);
            const angle = GOLDEN_ANGLE * serial;
            objects.push({
                object_id : 'fixture-' + locationId + '-' + String(serial).padStart(3, '0'),
                shape : serial % 2 === 0 ? 'box' : 'sphere',
                size_m : 0.24,
                color : FABRIC_DENSITY_FIXTURE_PALETTE[serial % FABRIC_DENSITY_FIXTURE_PALETTE.length],
                position : [
                    Number((anchor[0] + r * Math.cos(angle)).toFixed(3)),
                    0.12,
                    Number((anchor[2] + r * Math.sin(angle)).toFixed(3)),
                ],
                fixture : true,
                synthetic_density_fixture : true,
            });
            serial += 1;
        }
    });
    return objects;
}

// PlayerView over-shoulder camera rig. MIRRORS prototype 057 web/app.js
// PLAYER_CAMERA_DEFAULT + updatePlayerCamera() exactly, so GET /wow/view/1
// projects the same camera the PlayerView computes client-side:
//   forward       = [sin(yaw), 0, cos(yaw)]
//   position      = [ax, 0, az] - forward * follow_distance_m ; y = ay + follow_height_m
//   look target   = [ax, ay + look_target_height_m, az]
const WOW_VIEW_CAMERA_RIG = {
    mode : 'over_shoulder_follow',
    follow_distance_m : 3.5,
    follow_height_m : 2.1,
    look_target_height_m : 1.35,
};

function createRuntime(opts)
{
    const cfg = opts || {};
    // Each graph's anchor, read through the one GeoPose reader. A fixture the reader refuses stops
    // the server here, with the reader's named error.
    const SPATIAL_ANCHORS = loadAnchors(cfg.spatial_anchor_fixture !== undefined ? cfg.spatial_anchor_fixture : cfg.spatial_anchors);
    const SPATIAL_GRAPH_ID = 1;
    if (!SPATIAL_ANCHORS.has(SPATIAL_GRAPH_ID))
        throw new Error('the spatial anchor fixture names no graph ' + SPATIAL_GRAPH_ID + ' (this world serves one graph, id 1)');
    const WORLD_ANCHOR = SPATIAL_ANCHORS.get(SPATIAL_GRAPH_ID);
    const LOCATION_ID = String(cfg.location_id);
    const WORLD_ID = String(cfg.world_id);
    const SESSION_ID = String(cfg.session_id);
    const HTTP_PORT = Number(cfg.http_port);
    const NODE_ROLE = String(cfg.node_role || 'node');
    const TITLE = String(cfg.title || LOCATION_ID);
    const AUTHORED_WOW_GRAPH = cfg.authored_wow_graph
        ? JSON.parse(JSON.stringify(cfg.authored_wow_graph))
        : null;
    const AUTHORED_SCENE_OBJECTS = authoredGraphSceneObjects(AUTHORED_WOW_GRAPH);
    // Optional injected fault flag to reproduce a *hypothetical* async-lag bug
    // for the T-R3 investigation. Default OFF = faithful synchronous POC behavior.
    const ARRIVAL_COMMIT_MODE = String(cfg.arrival_commit_mode || 'sync'); // 'sync' | 'deferred'

    let stateRevision = 0;
    const subscribers = new Set();

    const state = {
        location : {
            location_id : LOCATION_ID,
            title : TITLE,
            http_port : HTTP_PORT,
            node_role : NODE_ROLE,
        },
        world : {
            world_id : WORLD_ID,
        },
        session : {
            session_id : SESSION_ID,
            world_id : WORLD_ID,
            location_id : LOCATION_ID,
            arrival_count : 0,
            connected_clients : [],
            handoff_bootstrap : null,
        },
        avatar : {
            avatar_id : 'avatar-local-001',
            continuity_id : 'avatar-local-001',
            display_name : 'poc-user',
            transform : {
                position : [ 0, 0, 0 ],
                rotation_y : 0,
                orientation : [ 0, 0, 0, 1 ],
                scale : [ 1, 1, 1 ],
            },
            handoff_context : null,
        },
        portals : (cfg.portals || []).map(p => Object.assign({}, p)),
        // demo extension: hosted primitives + the reloadable
        // attach-point version record (see the block comment above).
        scene_objects : (AUTHORED_SCENE_OBJECTS.length
            ? AUTHORED_SCENE_OBJECTS
            : demoDefaultSceneObjects(String(cfg.location_id)))
            .concat(densityFixtureSceneObjects(String(cfg.location_id), cfg.portals || []))
            .map(o => Object.assign({}, o, { position : o.position.slice() })),
        attach_point : {
            version : 1,
            updated_at : new Date().toISOString(),
            last_change : 'init',
        },
        server_tick : 0,
        debug : {
            state_revision : 0,
            last_input_source : 'init',
            handoff : {
                last_handoff_id : null,
                last_exit_intent : null,
                last_arrival : null,
            },
        },
    };

    // ---- POC-faithful helpers -------------------------------------------------

    function clone(value)
    {
        return JSON.parse(JSON.stringify(value));
    }

    function readNumber(value, fallback)
    {
        const n = Number(value);
        return Number.isFinite(n) ? n : fallback;
    }

    function bumpRevision()
    {
        stateRevision += 1;
        state.debug.state_revision = stateRevision;
    }

    function notifySubscribers()
    {
        const snapshot = getState();
        for (const subscriber of subscribers)
        {
            try
            {
                subscriber(snapshot);
            }
            catch (err)
            {
                console.error('runtime-state subscriber failed: ' + err.message);
            }
        }
    }

    function getState()
    {
        const snapshot = clone(state);
        // connected_clients is projected LIVE at read
        // time (expired-by-TTL entries filtered) so no read or subscriber
        // snapshot can ever show a ghost, even in the sub-second window
        // before the sweeper physically removes the entry. The underlying
        // state is NOT mutated here — reads stay pure.
        snapshot.session.connected_clients = presenceConnectedClientsProjection();
        return snapshot;
    }

    function getDebugState()
    {
        const snapshot = clone({
            location : state.location,
            world : state.world,
            portals : state.portals,
            session : state.session,
            avatar : state.avatar,
            server_tick : state.server_tick,
            debug : state.debug,
        });
        // same live projection rule as getState.
        snapshot.session.connected_clients = presenceConnectedClientsProjection();
        return snapshot;
    }

    function subscribe(fn)
    {
        subscribers.add(fn);
        try { fn(getState()); } catch (err) { /* ignore initial */ }
        return function unsubscribe() { subscribers.delete(fn); };
    }

    function subscriberCount()
    {
        return subscribers.size;
    }

    // ---- WS /events realtime event stream --------
    //
    // A SECOND, ADDITIVE subscription channel that carries TYPED, GRANULAR event
    // envelopes (user_joined/left, node_created/updated/deleted) rather than the
    // full-state snapshots the existing `subscribe()` / `/runtime-state` WS emit.
    // Both channels coexist: `/runtime-state` stays byte-for-byte the pre-015
    // full-state broadcast; `/events` is the WoW-surface realtime convention.
    //
    // HONESTY: `WS /events` is a LABELED NON-CANONICAL reference-impl convention
    // (wow-spec/OSL-WOW-CONTRACT.md §6), intentionally OUT of the OpenAPI HTTP
    // contract. Envelope shape matches the conformance fixture
    // (tools/wow-conformance/fixtures.js): { type, ts, user|node:{id}, ... }.
    //
    // ZERO behavior change when no `/events` client is connected: emitWowEvent()
    // iterates an empty Set and returns — the existing test battery, presence
    // semantics, and `/runtime-state` broadcasts are untouched.
    const eventSubscribers = new Set();

    function emitWowEvent(evt)
    {
        if (!eventSubscribers.size) return; // no /events client -> no-op
        for (const subscriber of eventSubscribers)
        {
            try { subscriber(evt); }
            catch (err) { console.error('runtime-state event subscriber failed: ' + err.message); }
        }
    }

    /** Subscribe to the granular WS /events stream. Returns an unsubscribe fn. */
    function subscribeEvents(fn)
    {
        eventSubscribers.add(fn);
        return function unsubscribeEvents() { eventSubscribers.delete(fn); };
    }

    function eventSubscriberCount()
    {
        return eventSubscribers.size;
    }

    /** Build a user_joined/user_left envelope from a presence registry entry. */
    function wowUserEvent(type, entry)
    {
        return {
            type : type,
            ts : new Date().toISOString(),
            // canonical-shaped user ref (integer id) + labeled presence detail
            user : {
                id : entry.wow_user_id,
                player_id : entry.player_id,
                display_name : entry.display_name,
                avatar_id : entry.avatar_id,
            },
            location_id : LOCATION_ID,
            // co-presence is LOCAL (same-origin multi-tab), never networked —
            // do not read this as multi-machine presence.
            presence_scope : 'server-side-ttl-registry (local occupancy truth)',
            proof_boundary : getWowProofBoundary(),
        };
    }

    /** Build a node_created/updated/deleted envelope for a composition-graph node. */
    function wowNodeEvent(type, spatialID, node)
    {
        const n = node && typeof node === 'object' ? node : {};
        return {
            type : type,
            ts : new Date().toISOString(),
            node : (n.label != null)
                ? { id : n.id, label : n.label }
                : { id : n.id },
            spatialID : spatialID,
            location_id : LOCATION_ID,
            proof_boundary : getWowProofBoundary(),
        };
    }

    /**
     * Live presence players projected as WoW user refs (labeled occupancy).
     * Fronts the EXISTING server-side TTL registry as `/wow/user`
     * resources — no new presence system. Ghost-free: reads livePresenceEntries
     * (TTL-filtered), so an expired player never appears.
     */
    function liveWowPresenceUsers()
    {
        const now = Date.now();
        return livePresenceEntries(now).map(entry => ({
            id : entry.wow_user_id,
            player_id : entry.player_id,
            display_name : entry.display_name,
            avatar_id : entry.avatar_id,
            endpoint : '/wow/user/' + entry.wow_user_id,
            source : 'presence-registry',
        }));
    }

    /**
     * The initial `hello` snapshot a newly-connected `WS /events` client
     * receives, so a late-joiner renders current occupancy at once (the
     * reference-impl sends the roster on connect). LABELED non-canonical; the
     * pure delta events (user_/node_*) follow on every change.
     */
    function getWowEventsHello()
    {
        return {
            type : 'hello',
            ts : new Date().toISOString(),
            location_id : LOCATION_ID,
            world_id : WORLD_ID,
            spatialID : SPATIAL_ID,
            // current live occupancy (TTL-filtered -> ghost-free)
            users : liveWowPresenceUsers(),
            convention : 'WS /events (labeled non-canonical; wow-spec/OSL-WOW-CONTRACT.md §6)',
            event_types : [ 'user_joined', 'user_left', 'node_created', 'node_updated', 'node_deleted' ],
            presence_scope : 'server-side-ttl-registry (local occupancy truth; not networked)',
            proof_boundary : getWowProofBoundary(),
        };
    }

    // ---- WoW / OpenSpatialWorld projections (read-only over live state) -------
    //
    // these projections emit the OSL WoW response
    // composites (canonical OpenSpatialWorld schema + labeled OSL extensions).
    // The types are single-sourced from wow-spec/schema.yaml and consumed here
    // via JSDoc — no TS migration. See wow-spec/types.d.ts.
    /** @typedef {import('../../../wow-spec/types').OSLWorldResponse} OSLWorldResponse */
    /** @typedef {import('../../../wow-spec/types').OSLUserResponse} OSLUserResponse */
    /** @typedef {import('../../../wow-spec/types').OSLViewResponse} OSLViewResponse */
    /** @typedef {import('../../../wow-spec/types').OSLPortalResponse} OSLPortalResponse */

    function getWowProofBoundary()
    {
        // The four proof-boundary flags. MUST appear on every /wow response.
        return {
            application_level_handoff : true,
            native_teleportxr_teleport : false,
            first_party_teleportxr_browser_rendering : false,
            standards_conformance : false,
        };
    }

    /**
     * A pose in this world's graph (local metres, yaw and pitch in radians) as a GeoPose
     * { position: { lat, lon, h }, angles: { yaw, pitch, roll } }: the position by real geodesy
     * through the graph's anchor, the angles per WOW_GEOPOSE_MAPPING. Rounded for stable JSON:
     * 11 decimals of a degree (about a micrometre), 4 decimals of a metre, 3 of a degree.
     */
    function wowGeoPoseFromLocal(position, yawRad, pitchRad)
    {
        const p = Array.isArray(position) ? position : [ 0, 0, 0 ];
        const local = [ Number(p[0]) || 0, Number(p[1]) || 0, Number(p[2]) || 0 ];
        const pose = wowGeo.localPoseToGeoPose(WORLD_ANCHOR, local, Number(yawRad) || 0, Number(pitchRad) || 0);
        const round = (v, places) => Number(v.toFixed(places));
        return {
            position : { lat : round(pose.position.lat, 11), lon : round(pose.position.lon, 11), h : round(pose.position.h, 4) },
            angles : { yaw : round(pose.angles.yaw, 3), pitch : round(pose.angles.pitch, 3), roll : round(pose.angles.roll, 3) },
        };
    }

    /**
     * GET /wow/world — WoW OpenAPI `World` schema shape.
     * Every schema-defined member (content, geoPose, presence, technology,
     * users, views, portals) is present with the schema's types. The demo's
     * extra state rides along as additional properties (`id`, `location`,
     * `session`, `presence.avatars`) kept for the live 057 client, plus the
     * labeled `webofworlds_extension` — the schema does not forbid additional
     * properties, and the claim boundary still never claims conformance.
     * @returns {OSLWorldResponse} validated by wow-spec OSLWorldResponse.
     */
    function getWowWorld()
    {
        const projected = {
            // ---- WoW `World` schema members ----
            content : {
                label : state.location.title + ' - world surface',
                age_restriction : 0,
                license : 'local-unsigned-demo (no license claim)',
                cost : 'free',
                version : 0.1,
                duration : 0,
            },
            // The world's location for discovery, not a placement: the anchor of its graph.
            geoPose : clone(WORLD_ANCHOR),
            presence : {
                avatar : 'vrm-glb-avatar (client-rendered)',
                navigation : 'walk-wasd-jump',
                gravity : 'y-down-ground-clamp',
                // additional member kept for the live 057 client (reads
                // presence.avatars[0]); not part of the WoW schema.
                avatars : [ {
                    avatar_id : state.avatar.avatar_id,
                    continuity_id : state.avatar.continuity_id,
                    display_name : state.avatar.display_name,
                } ],
            },
            technology : {
                'webXR-immersive' : 'not-proven',
                runtime : 'teleportxr-hosted-state-with-threejs-browser-fallback (re-modeled locally)',
            },
            users : {
                // live truth: WS /runtime-state subscribers now, one known user resource
                active_user_count : subscriberCount(),
                total_user_count : 1,
            },
            views : {
                view_count : 1, // the PlayerView camera seat, GET /wow/view/1
            },
            portals : {
                portal_count : state.portals.length,
            },
            // ---- demo additional properties (legacy readers in 057 web client) ----
            id : state.world.world_id,
            location : {
                id : state.location.location_id,
                title : state.location.title,
                port : state.location.http_port,
                node_role : state.location.node_role,
            },
            session : {
                id : state.session.session_id,
                world_id : state.session.world_id,
                location_id : state.session.location_id,
                arrival_count : state.session.arrival_count,
            },
            webofworlds_extension : {
                schema : 'OpenSpatialWorld API.yaml components.schemas.World + labeled extensions',
                geopose_mapping : WOW_GEOPOSE_MAPPING,
                // the hosted-avatar user PLUS the live
                // players in the TTL presence registry, each addressable as a
                // /wow/user resource (labeled source; ghost-free — TTL-filtered).
                users: [ { id : WOW_LOCAL_USER_ID, avatar_id : state.avatar.avatar_id, endpoint : '/wow/user/' + WOW_LOCAL_USER_ID } ]
                    .concat(liveWowPresenceUsers()),
                views : [ { id : WOW_PLAYER_VIEW_ID, kind : 'player-view-camera', endpoint : '/wow/view/' + WOW_PLAYER_VIEW_ID } ],
                portals : state.portals.map((portal, index) => ({
                    id : index + 1,
                    portal_id : portal.portal_id,
                    endpoint : '/wow/portal/' + (index + 1),
                    target_location_id : portal.target_location_id,
                    target_world_id : portal.target_world_id,
                })),
                active_user_count_source : 'live /runtime-state WebSocket subscribers',
            },
            proof_boundary : getWowProofBoundary(),
        };
        const authored = AUTHORED_WOW_GRAPH && AUTHORED_WOW_GRAPH.world;
        if (!authored) return projected;
        return Object.assign({}, projected, authored, {
            content : Object.assign({}, projected.content, authored.content || {}),
            presence : Object.assign({}, projected.presence, authored.presence || {}, {
                avatars : projected.presence.avatars,
            }),
            technology : Object.assign({}, projected.technology, authored.technology || {}),
            // The anchor fixture is the one source of the world's location. Authored data does not set it.
            geoPose : projected.geoPose,
            users : projected.users,
            views : projected.views,
            portals : projected.portals,
            id : WORLD_ID,
            location : projected.location,
            session : projected.session,
            webofworlds_extension : Object.assign(
                {}, authored.webofworlds_extension || {}, projected.webofworlds_extension, {
                    authored_graph : {
                        endpoint : '/wow/graph',
                        spatial_id : WORLD_ID,
                        source : 'checked-in OSL-authored world data',
                    },
                }),
            proof_boundary : getWowProofBoundary(),
        });
    }

    /** Stable location resource shared by every configured backend node. */
    function getWowLocation()
    {
        return {
            id : LOCATION_ID,
            title : TITLE,
            node_role : NODE_ROLE,
            world_id : WORLD_ID,
            session_id : SESSION_ID,
            base_url : 'http://127.0.0.1:' + HTTP_PORT,
            coordinate_frame : AUTHORED_WOW_GRAPH && AUTHORED_WOW_GRAPH.units
                ? AUTHORED_WOW_GRAPH.units
                : WOW_GEOPOSE_MAPPING.frame,
            entry_spawn : getFabricSpawnPose(),
            resources : {
                health : '/healthz',
                world : '/wow/world',
                authored_graph : AUTHORED_WOW_GRAPH ? '/wow/graph' : null,
                spatial_graph : '/wow/spatial/' + WORLD_ID,
                region : '/fabric/region',
                presence : '/fabric/presence',
                runtime_state : '/runtime-state',
                portals : state.portals.map((portal, index) => ({
                    portal_id : portal.portal_id,
                    endpoint : '/wow/portal/' + (index + 1),
                })),
                arrival : '/portal/arrival',
            },
            proof_boundary : getWowProofBoundary(),
        };
    }

    /**
     * Return the configured authored WoW graph through this backend. The graph
     * data remains authored content; only service metadata, runtime portal
     * descriptors, and the honest local-backend boundary are projected live.
     */
    function getWowGraph()
    {
        if (!AUTHORED_WOW_GRAPH) return null;
        const graph = clone(AUTHORED_WOW_GRAPH);
        graph.spatialID = WORLD_ID;
        graph.base_url = 'http://127.0.0.1:' + HTTP_PORT;
        graph.spatial_composition_graph_endpoint = '/wow/graph';
        graph.world = Object.assign({}, graph.world || {}, {
            id : WORLD_ID,
            portals : { portal_count : state.portals.length },
            proof_boundary : getWowProofBoundary(),
        });
        graph.portals = state.portals.map((portal, index) => getWowPortalResource(index + 1));
        graph.backend_contract = {
            location_id : LOCATION_ID,
            world_id : WORLD_ID,
            session_id : SESSION_ID,
            node_role : NODE_ROLE,
            authored_content : true,
            client_cutover : false,
            public_deployment : false,
            proof_boundary : getWowProofBoundary(),
        };
        return graph;
    }

    /**
     * Resolve a portal by WoW numeric id (spec domain: /wow/portal/{portalId}
     * with an integer id -> our portals indexed 1..n in config order) OR by
     * the demo's legacy string portal_id (compatibility alias).
     * Returns { portal, wowId } or null.
     */
    function resolveWowPortal(idOrAlias)
    {
        const raw = String(idOrAlias == null ? '' : idOrAlias);
        if (/^\d+$/.test(raw))
        {
            const index = Number(raw) - 1;
            const portal = state.portals[index];
            return portal ? { portal, wowId : index + 1 } : null;
        }
        const index = state.portals.findIndex(entry => entry.portal_id === raw);
        if (index === -1)
            return null;
        return { portal : state.portals[index], wowId : index + 1 };
    }

    /**
     * the portal's DESTINATION as a LABELED, NON-CANONICAL
     * `Portal.destination` extension (wow-spec `PortalDestination`). The canonical
     * WoW `Portal` is a bare `{id, geoPose}` with NO destination field — it cannot
     * express "leads to world X". OSL carries the navigation-bearing target HERE,
     * migrated OFF the raw `webofworlds_extension` bag, plus the flat forward-looking
     * spatial-fabric address. The composition-graph reference (the resolvable
     * destination — the target world's canonical /wow/spatial graph) rides in
     * `webofworlds_extension` (see wowPortalExtension). Proposed upstream
     * (§2.B upstream note); until accepted it is an `x-osl-extension`, surfaced by
     * the conformance runner, and `standards_conformance` stays false.
     */
    function portalDestination(portal)
    {
        const address = spatialFabricAddressForPortal(portal);
        const out = {
            target_world_id : portal.target_world_id,
            target_location_id : portal.target_location_id,
            target_base_url : portal.target_base_url,
            // flat, forward-looking spatial-fabric address (the STRING form the
            // PortalDestination schema documents). The STRUCTURED osl profile object
            // stays a labeled residual in webofworlds_extension (no WoW-native home).
            spatial_fabric_address : address && address.uri ? address.uri : undefined,
        };
        // PortalDestination members are typed strings — omit any that are absent so
        // an under-specified portal never emits a null where a string is expected.
        for (const k of Object.keys(out))
            if (out[k] == null || out[k] === '') delete out[k];
        return out;
    }

    /** the composition-graph node id for a portal, derived
     *  from the deterministic seed order (root=0, then the hosted primitives, then
     *  the portals — see buildSpatialSeedNodes). A best-effort cross-reference so a
     *  client can fetch the portal's node directly; the proof asserts it resolves. */
    function wowPortalNodeId(wowId)
    {
        return 1 + state.scene_objects.length + (wowId - 1);
    }

    /** Shared demo detail for a portal, carried as the labeled extension. The
     *  navigation-bearing TARGET fields (target_world_id / target_location_id /
     *  target_base_url) moved to the labeled `Portal.destination` (portalDestination,
     *); the extension keeps the OSL-native residuals (zones, traversal, the
     *  STRUCTURED spatial-fabric-address object, placement geometry) + a
     *  composition-graph reference pointing at both this world's and the target
     *  world's /wow/spatial graph. */
    function wowPortalExtension(portal, wowId)
    {
        const traversal = portalTraversalRule(portal);
        const targetWorldId = portal.target_world_id || portal.target_fixture?.spatial_id;
        const extension = {
            portal_id : portal.portal_id, // legacy string id (demo alias route)
            wow_id : wowId,               // WoW numeric id (spec route /wow/portal/{n})
            wow_resource : '/wow/portal/' + wowId,
            legacy_alias_endpoint : '/wow/portal/' + portal.portal_id,
            source_location_id : portal.source_location_id,
            source_world_id : portal.source_world_id,
            // the navigation-bearing target (target_world_id /
            // target_location_id / target_base_url) MOVED to the labeled
            // `Portal.destination` (a measurable shrink of this private bag). What
            // remains as a WoW-native pointer is the COMPOSITION-GRAPH REFERENCE:
            // this portal's own graph node id, and the RESOLVABLE destination — the
            // target world's /wow/spatial graph, by its integer id (the first graph of that
            // world's server), relative to the target's base URL.
            portal_node_id : wowPortalNodeId(wowId),
            target_spatial_graph_endpoint : targetWorldId ? '/wow/spatial/' + SPATIAL_GRAPH_ID : undefined,
            // fixture-backed destinations are a distinct
            // client scene-load contract, never disguised as a backend URL.
            target_fixture : portal.target_fixture
                ? clone(portal.target_fixture)
                : undefined,
            exit_endpoint : '/portal/exit-intent',
            arrival_endpoint : '/portal/arrival',
            handoff_behavior : portal.target_fixture
                ? 'client-scene-load (same browser/player; no application-level handoff)'
                : 'application-level-handoff-around-teleportxr',
            native_teleportxr_teleport : false,
            trigger : {
                position : portal.trigger.position,
                radius_m : readNumber(portal.trigger.radius_m, 0),
            },
            arrival : {
                position : portal.arrival.position,
                rotation_y : portal.arrival.rotation_y,
            },
            geopose_mapping : WOW_GEOPOSE_MAPPING,
            // BEGIN — addressable spatial fabric portal prefetch.
            // The portal carries (a) TWO DISTINCT interaction volumes — the larger
            // prefetch/loading zone and the smaller traversal/commit trigger — and
            // (b) the loadable spatial fabric address of its destination. Labeled
            // local-proof structures: no published standard defines either (the RP1
            // whitepaper documents proximity+LOD loading as a principle only; IWPS
            // v0.3 has URI addressing + a pre-transit Query but no content/region
            // semantics). Conformance flags stay false.
            zones : portalZones(portal),
            spatial_fabric_address : spatialFabricAddressForPortal(portal) || undefined,
            // END
            // the traversal-direction field lives HERE in
            // the server descriptor beside zones + spatial_fabric_address.
            // Bidirectional portals commit from either side of the frame plane;
            // one-way portals commit only from allowed_entry_side, render the
            // blocked side opaque, and suppress prefetch from it. Direction
            // changes which approaches ARM the zones, never their sizes.
            traversal_mode : traversal.mode,
            traversal : traversal,
            // Automatic cross-world reciprocal pairing is independent of the
            // face-entry traversal rule above. Unknown values default off.
            reciprocal : portalReciprocalRule(portal),
            // P1 — the shared-edge identity this portal is
            // one side of (null only for fixture-backed destinations).
            shared_edge : portalSharedEdge(portal),
        };
        return extension;
    }

    // ---- addressable spatial fabric portal prefetch ------

    /** the portal's traversal-direction rule (the
     *  value: bidirectional vs one-way with an allowed side). Side names are
     *  defined against the portal frame's `forward` vector — the same frame
     *  the client crossing gate measures signed plane distance in: "front" is
     *  the half-space `forward` points into, "back" the opposite one. Labeled
     *  local-proof semantics — no published portal standard defines traversal
     *  directionality. */
    function portalTraversalRule(portal)
    {
        const raw = portal.traversal || {};
        const mode = raw.mode === 'one_way' ? 'one_way' : 'bidirectional';
        const allowed = mode === 'one_way'
            ? (raw.allowed_entry_side === 'back' ? 'back' : 'front')
            : 'both';
        const preset = FABRIC_PORTAL_FRAME_PRESETS[portal.source_location_id] || null;
        return {
            mode : mode,
            transition : typeof raw.transition === 'string' && raw.transition
                ? raw.transition
                : undefined,
            allowed_entry_side : allowed,
            blocked_entry_side : mode === 'one_way'
                ? (allowed === 'front' ? 'back' : 'front')
                : null,
            side_reference : 'portal_frame_forward',
            frame_forward : preset ? preset.forward.slice() : [ 0, 0, 1 ],
            validation : {
                traversal_direction_standard_conformance : false,
                application_level : true,
            },
        };
    }

    function portalReciprocalRule(portal)
    {
        const raw = portal.reciprocal || {};
        return {
            mode : raw.mode === 'automatic' ? 'automatic' : 'disabled',
            validation : {
                automatic_reciprocal_standard_conformance : false,
                application_level : true,
            },
        };
    }

    /**
     * P1 — the SHARED-EDGE identity block. A portal is ONE
     * stable connection between two places: the SAME edge_id appears on the
     * descriptor hosted by BOTH endpoint worlds (validated at config load by
     * validateSharedEdgeTopology), and each side's counterpart names the portal
     * hosted on the other side. The client resolves the counterpart's live pose
     * via the destination's /fabric/region anchored on counterpart.portal_id —
     * the exit/return therefore lands at the portal that was entered, never at
     * a per-world arrival spot. Fixture-backed destinations (no hosted
     * counterpart by design) return null. Labeled local-proof semantics; no
     * published portal standard defines shared-edge identity.
     */
    function portalSharedEdge(portal)
    {
        if (!portal || portal.target_fixture
            || !portal.target_location_id || !portal.target_portal_id)
            return null;
        const edgeId = portalEdgeId(portal);
        if (!edgeId) return null;
        return {
            edge_id : edgeId,
            endpoints : [ String(portal.source_location_id), String(portal.target_location_id) ].sort(),
            this_side : {
                location_id : portal.source_location_id,
                world_id : portal.source_world_id || null,
                portal_id : portal.portal_id,
            },
            counterpart : {
                location_id : portal.target_location_id,
                world_id : portal.target_world_id || null,
                portal_id : portal.target_portal_id,
                base_url : portal.target_base_url || null,
                // Where the counterpart's LIVE pose is read (the adoption
                // seam the client already consumes).
                region_pose_endpoint : '/fabric/region?anchor_portal_id='
                    + encodeURIComponent(String(portal.target_portal_id)),
            },
            reciprocal_presence : 'hosted_both_sides',
            identity_rule : 'one portal = one stable connection between two places; '
                + 'the same edge_id is hosted by BOTH endpoint worlds and each '
                + 'side\'s target_portal_id names the other side',
            validation : {
                shared_edge_standard_conformance : false,
                application_level : true,
            },
        };
    }

    /** which entry sides ARM the portal volumes. Derived
     *  from the traversal rule only — zone sizes/semantics never change. */
    function portalArmedEntrySides(portal)
    {
        const rule = portalTraversalRule(portal);
        return rule.mode === 'one_way' ? [ rule.allowed_entry_side ] : [ 'front', 'back' ];
    }

    /** The larger prefetch zone + smaller traversal trigger, never collapsed. */
    function portalZones(portal)
    {
        const sf = portal.spatial_fabric || {};
        const prefetchRadius = readNumber(sf.prefetch_radius_m, 2.5);
        const roiRadius = readNumber(sf.roi_radius_m, 5.0);
        // Invariant: the prefetch zone must be meaningfully LARGER than the
        // traversal trigger's planar reach (half frame width + trigger depth
        // + 0.5 m margin). Surfaced (not just enforced) so clients/evidence
        // can assert it.
        const minPrefetchRadius =
            FABRIC_PORTAL_FRAME_WIDTH_M / 2 + FABRIC_PORTAL_TRIGGER_DEPTH_M + 0.5;
        // direction changes which APPROACHES arm the two
        // volumes, never their sizes/semantics — both zones stay distinct and
        // keep the exact geometry for every traversal mode.
        const armedEntrySides = portalArmedEntrySides(portal);
        return {
            prefetch : {
                type : 'portal_center_planar_radius',
                radius_m : prefetchRadius,
                hysteresis_ratio : 1.15,
                armed_entry_sides : armedEntrySides.slice(),
                purpose : 'larger OUTER data-loading circle — resolve + preload the '
                    + 'destination spatial fabric neighborhood; NEVER commits traversal',
                // the outer loading circle is widened from
                // the 2.5 m proof value to the uniform 3.0 m geometric maximum
                // (the spawn contract puts a location-world player exactly
                // 3.2 m from the portal and the approach must start OUTSIDE
                // the circle; the lobby's proven walk-away waypoints bound the
                // 1.15x exit hysteresis; both documented in config.js).
                widened_by : 'runtime',
                previous_proof_radius_m : 2.5,
                // The destination-side loading circle this outer circle maps
                // to: everything inside it at the destination — scene entities
                // AND registered avatars — is loaded by the region read.
                // Width = the portal address roi_hint radius (5.0 m, WIDER
                // than the source circle; the mismatch and its reason are
                // recorded rather than hidden).
                matching_destination_circle : {
                    radius_m : roiRadius,
                    includes_avatars : true,
                    matches_source_circle : roiRadius === prefetchRadius,
                    clamp_reason : roiRadius === prefetchRadius
                        ? null
                        : 'source-side circle is clamped by world geometry (the spawn '
                            + 'contract places the player 3.2 m from a location portal; '
                            + 'the lobby walk-away waypoints bound the exit hysteresis); '
                            + 'the destination-side loading circle keeps the full roi width',
                    rule : 'destination /fabric/region loads all scene entities and '
                        + 'registered avatars within radius_m of the destination '
                        + 'anchor portal',
                },
            },
            traversal : {
                type : 'oval_frame_plane_crossing',
                width_m : FABRIC_PORTAL_FRAME_WIDTH_M,
                height_m : FABRIC_PORTAL_FRAME_HEIGHT_M,
                trigger_depth_m : FABRIC_PORTAL_TRIGGER_DEPTH_M,
                armed_entry_sides : armedEntrySides.slice(),
                purpose : 'smaller commit trigger — walking through transfers the '
                    + 'player; semantics unchanged from the proven crossing gate',
            },
            invariant : 'prefetch.radius_m > width_m/2 + trigger_depth_m + 0.5',
            invariant_min_prefetch_radius_m : Number(minPrefetchRadius.toFixed(3)),
            invariant_ok : prefetchRadius > minPrefetchRadius,
        };
    }

    /** The loadable spatial fabric address attached to this portal. */
    function spatialFabricAddressForPortal(portal)
    {
        // A fixture-backed client scene is not a backend spatial fabric. It has
        // no authority, region endpoint, or fabric id to advertise/prefetch.
        if (portal.target_fixture || !portal.target_location_id
            || !portal.target_portal_id || !portal.target_base_url)
            return null;
        const sf = portal.spatial_fabric || {};
        const roiRadius = readNumber(sf.roi_radius_m, 5.0);
        const targetLocation = String(portal.target_location_id || '');
        const anchorPortalId = String(portal.target_portal_id || (targetLocation + '-portal'));
        const authority = String(portal.target_base_url || '');
        return {
            profile_version : 'osl.spatial-fabric-address.v0',
            // Display/debug URI for the plain-language concept "the spatial fabric
            // address attached to the portal". The STRUCTURED fields below are the
            // contract; the scheme is project-local (RP1 publishes no grammar).
            uri : 'osl-fabric+http://' + authority.replace(/^https?:\/\//, '')
                + '/fabric.json#portal=' + anchorPortalId + '&roi_radius_m=' + roiRadius,
            authority : authority,
            fabric_id : 'local-fabric-' + targetLocation,
            world_id : portal.target_world_id || null,
            location_id : targetLocation || null,
            anchor : { type : 'portal', portal_id : anchorPortalId },
            roi_hint : { type : 'portal_neighborhood_radius', radius_m : roiRadius },
            discovery : {
                well_known : '/.well-known/spatial-fabric',
                fabric_manifest : '/fabric.json',
                region_endpoint : '/fabric/region',
                presence_endpoint : '/fabric/presence',
            },
            validation : {
                address_scheme_standard_conformance : false,
                application_level : true,
            },
        };
    }

    /** Boundary label carried on every /fabric/region + /fabric/presence read. */
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

    // ---- per-location player presence registry ----------
    //
    // player_id -> entry. Mutated ONLY by the explicit POST session actions
    // (/fabric/presence/register|heartbeat|depart) and by TTL expiry; the GET
    // /fabric/presence + /fabric/region reads are PURE (they filter live
    // entries without deleting — the sweeper owns removal), so the
    // read-only prefetch rule survives byte-for-byte.
    const presenceRegistry = new Map();
    let presenceSweepTimer = null;
    // monotonic WoW `/wow/user` id per registered player,
    // assigned once on first register and reused across heartbeats (stable id).
    let presenceUserSeq = 0;
    // player_id -> tombstone expiry ms (see
    // PRESENCE_DEPART_TOMBSTONE_MS). Written by departPresence, cleared by an
    // explicit registerPresence, read ONLY by the heartbeat upsert path.
    const presenceTombstones = new Map();
    let presenceResurrectionsBlocked = 0;

    function pruneTombstones(nowMs)
    {
        for (const [ playerId, expiresAt ] of presenceTombstones)
        {
            if (expiresAt <= nowMs) presenceTombstones.delete(playerId);
        }
    }

    /** True when this player explicitly departed recently (a stale heartbeat must not revive them). */
    function presenceDepartedRecently(playerId)
    {
        const expiresAt = presenceTombstones.get(playerId) || 0;
        return expiresAt > Date.now();
    }

    function presenceString(value, fallback, max)
    {
        const s = value == null ? '' : String(value);
        return (s || fallback || '').slice(0, max || 120);
    }

    function presencePosition(value)
    {
        if (!Array.isArray(value) || value.length < 3) return null;
        const p = value.slice(0, 3).map(entry => Number(entry));
        return p.every(entry => Number.isFinite(entry))
            ? p.map(entry => Number(entry.toFixed(4)))
            : null;
    }

    /** Public projection of one registry entry (what occupancy reports). */
    function presenceEntrySummary(entry, nowMs)
    {
        return {
            player_id : entry.player_id,
            client_id : entry.client_id,
            avatar_id : entry.avatar_id,
            continuity_id : entry.continuity_id,
            display_name : entry.display_name,
            position : entry.position ? entry.position.slice() : null,
            rotation_y : entry.rotation_y,
            registered_at : entry.registered_at,
            last_seen_at : entry.last_seen_at,
            ttl_ms : entry.ttl_ms,
            expires_in_ms : Math.max(0, entry.expires_at_ms - nowMs),
            heartbeat_count : entry.heartbeat_count,
            registered_via : entry.registered_via,
        };
    }

    /** Live (non-expired) entries, oldest registration first. PURE — no removal. */
    function livePresenceEntries(nowMs)
    {
        const now = Number.isFinite(nowMs) ? nowMs : Date.now();
        return Array.from(presenceRegistry.values())
            .filter(entry => entry.expires_at_ms > now)
            .sort((x, y) => x.registered_at_ms - y.registered_at_ms);
    }

    /** The live registry as connected-client summaries (read-time truth). */
    function presenceConnectedClientsProjection()
    {
        const now = Date.now();
        return livePresenceEntries(now).map(entry => presenceEntrySummary(entry, now));
    }

    /** Keep session.connected_clients = the live registry projection. */
    function syncConnectedClients(nowMs)
    {
        const now = Number.isFinite(nowMs) ? nowMs : Date.now();
        state.session.connected_clients =
            livePresenceEntries(now).map(entry => presenceEntrySummary(entry, now));
    }

    /** Drop expired entries (TTL truth). Notifies subscribers on change. */
    function sweepPresenceRegistry(reason)
    {
        const now = Date.now();
        // departure tombstones expire on the same sweep that
        // expires registry entries (the sweeper owns all removal).
        pruneTombstones(now);
        const expired = [];
        const expiredEntries = [];
        for (const [ playerId, entry ] of presenceRegistry)
        {
            if (entry.expires_at_ms <= now)
            {
                presenceRegistry.delete(playerId);
                expired.push(playerId);
                expiredEntries.push(entry);
            }
        }
        if (expired.length)
        {
            syncConnectedClients(now);
            state.debug.last_input_source = 'presence-expired:' + expired.join(',').slice(0, 60);
            bumpRevision();
            notifySubscribers();
            // TTL expiry is the ghost-free leave path ->
            // user_left per expired player on /events (the honesty-critical bit:
            // presence reflects REAL occupancy, no ghosts survive their TTL).
            for (const entry of expiredEntries) emitWowEvent(wowUserEvent('user_left', entry));
            console.log('[Presence][' + LOCATION_ID + '] EXPIRED ' + JSON.stringify({
                players : expired, reason : reason || 'ttl_sweep',
            }));
        }
        if (presenceRegistry.size === 0) stopPresenceSweeper();
        return expired;
    }

    function startPresenceSweeper()
    {
        if (presenceSweepTimer) return;
        presenceSweepTimer = setInterval(
            () => sweepPresenceRegistry('ttl_sweep'), PRESENCE_SWEEP_INTERVAL_MS);
        // Never keep the Node event loop alive purely for expiry bookkeeping
        // (same rule as the republish timer; tests can exit cleanly).
        if (presenceSweepTimer && typeof presenceSweepTimer.unref === 'function')
            presenceSweepTimer.unref();
    }

    function stopPresenceSweeper()
    {
        if (presenceSweepTimer)
        {
            clearInterval(presenceSweepTimer);
            presenceSweepTimer = null;
        }
    }

    /**
     * POST /fabric/presence/register — the player's explicit session action
     * against ITS OWN active server. Upserts the entry, (re)arms its TTL, and
     * populates session.connected_clients. Never touches arrival_count, the
     * hosted avatar, portals, or scene objects.
     */
    function registerPresence(body, via)
    {
        sweepPresenceRegistry('pre_register');
        const input = body && typeof body === 'object' ? body : {};
        const playerId = presenceString(input.player_id, '', 120);
        if (!playerId)
            throw new Error('player_id required');
        if (!presenceRegistry.has(playerId) && presenceRegistry.size >= PRESENCE_MAX_PLAYERS)
            throw new Error('presence registry full (' + PRESENCE_MAX_PLAYERS + ')');
        const now = Date.now();
        const nowIso = new Date(now).toISOString();
        const requestedTtl = Number(input.requested_ttl_ms);
        const ttl = Number.isFinite(requestedTtl) && requestedTtl > 0
            ? Math.max(PRESENCE_TTL_MIN_MS, Math.min(PRESENCE_TTL_MAX_MS, Math.round(requestedTtl)))
            : PRESENCE_TTL_DEFAULT_MS;
        const previous = presenceRegistry.get(playerId) || null;
        const entry = {
            player_id : playerId,
            // stable WoW /wow/user id (minted once, reused).
            wow_user_id : previous ? previous.wow_user_id : (WOW_PRESENCE_USER_ID_BASE + (++presenceUserSeq)),
            client_id : presenceString(input.client_id, playerId, 120),
            avatar_id : presenceString(input.avatar_id, 'avatar-unknown', 80),
            continuity_id : presenceString(input.continuity_id, input.avatar_id || playerId, 80),
            display_name : presenceString(input.display_name, input.avatar_id || 'player', 80),
            position : presencePosition(input.position),
            rotation_y : Number.isFinite(Number(input.rotation_y)) ? Number(input.rotation_y) : null,
            registered_at : previous ? previous.registered_at : nowIso,
            registered_at_ms : previous ? previous.registered_at_ms : now,
            last_seen_at : nowIso,
            last_seen_ms : now,
            ttl_ms : ttl,
            expires_at_ms : now + ttl,
            heartbeat_count : previous ? previous.heartbeat_count : 0,
            registered_via : String(via || 'register'),
        };
        presenceRegistry.set(playerId, entry);
        // an EXPLICIT arrival always wins over a departure
        // tombstone — the player really is here now (this is the path a player
        // walking straight back through the portal takes). Only the heartbeat
        // UPSERT is gated by the tombstone; see heartbeatPresence below.
        presenceTombstones.delete(playerId);
        startPresenceSweeper();
        syncConnectedClients(now);
        state.debug.last_input_source = 'presence-register:' + playerId.slice(0, 60);
        bumpRevision();
        notifySubscribers();
        // a GENUINELY NEW presence -> user_joined on /events.
        // A re-register of an already-present player (or a heartbeat-upsert of a
        // still-live player) emits no duplicate join (ghost-free, no self-dup).
        if (!previous) emitWowEvent(wowUserEvent('user_joined', entry));
        console.log('[Presence][' + LOCATION_ID + '] REGISTER ' + JSON.stringify({
            player_id : playerId, display_name : entry.display_name,
            via : entry.registered_via, ttl_ms : ttl, registry_size : presenceRegistry.size,
        }));
        return clone({
            ok : true,
            registered : true,
            location_id : LOCATION_ID,
            player : presenceEntrySummary(entry, now),
            ttl_ms : ttl,
            heartbeat_interval_hint_ms : PRESENCE_HEARTBEAT_HINT_MS,
            registered_player_count : presenceRegistry.size,
        });
    }

    /**
     * POST /fabric/presence/heartbeat — refresh liveness (and optionally pose)
     * for a registered player. Unknown player_id upserts (documented: keeps a
     * live client self-healing across a server restart); still the player's
     * own explicit action against its own active server.
     */
    function heartbeatPresence(body)
    {
        sweepPresenceRegistry('pre_heartbeat');
        const input = body && typeof body === 'object' ? body : {};
        const playerId = presenceString(input.player_id, '', 120);
        if (!playerId)
            throw new Error('player_id required');
        const entry = presenceRegistry.get(playerId);
        if (!entry)
        {
            // REFUSE to resurrect a player who explicitly
            // departed a moment ago. This is the heartbeat/depart race at a
            // crossing: the beat was already in flight when the player left, and
            // upserting it would put them back in this world's registry for a
            // full TTL — the ghost the user sees standing on the far side of
            // the portal. The upsert path keeps its real job (self-healing a live
            // client across a server restart), because a restart has no
            // tombstones and an explicit register clears any that exist.
            if (presenceDepartedRecently(playerId))
            {
                presenceResurrectionsBlocked += 1;
                console.log('[Presence][' + LOCATION_ID + '] HEARTBEAT_AFTER_DEPART_IGNORED '
                    + JSON.stringify({ player_id : playerId, registry_size : presenceRegistry.size }));
                return clone({
                    ok : true,
                    registered : false,
                    departed : true,
                    upserted : false,
                    location_id : LOCATION_ID,
                    player_id : playerId,
                    reason : 'departed_recently',
                    note : 'runtime: a heartbeat in flight at departure may not '
                        + 'resurrect a departed player; re-register explicitly to return',
                    registered_player_count : presenceRegistry.size,
                });
            }
            const out = registerPresence(body, 'heartbeat_upsert');
            out.upserted = true;
            return out;
        }
        const now = Date.now();
        entry.last_seen_at = new Date(now).toISOString();
        entry.last_seen_ms = now;
        entry.expires_at_ms = now + entry.ttl_ms;
        entry.heartbeat_count += 1;
        const position = presencePosition(input.position);
        if (position) entry.position = position;
        if (Number.isFinite(Number(input.rotation_y))) entry.rotation_y = Number(input.rotation_y);
        syncConnectedClients(now);
        return clone({
            ok : true,
            registered : true,
            location_id : LOCATION_ID,
            player : presenceEntrySummary(entry, now),
            ttl_ms : entry.ttl_ms,
            heartbeat_interval_hint_ms : PRESENCE_HEARTBEAT_HINT_MS,
            registered_player_count : presenceRegistry.size,
        });
    }

    /**
     * POST /fabric/presence/depart — explicit departure (portal crossing away
     * from this location, or tab close via beacon). Idempotent.
     */
    function departPresence(body)
    {
        const input = body && typeof body === 'object' ? body : {};
        const playerId = presenceString(input.player_id, '', 120);
        if (!playerId)
            throw new Error('player_id required');
        // capture the entry BEFORE removal so user_left
        // carries its minted /wow/user id + identity.
        const departingEntry = presenceRegistry.get(playerId) || null;
        const removed = presenceRegistry.delete(playerId);
        const now = Date.now();
        // tombstone the departure so a heartbeat that was
        // already in flight cannot upsert this player back into the world. Set
        // unconditionally (even when `removed` is false): the depart may simply
        // have won the race against its own client's heartbeat, and the beat is
        // still on the wire. Cleared by an explicit register.
        pruneTombstones(now);
        presenceTombstones.set(playerId, now + PRESENCE_DEPART_TOMBSTONE_MS);
        if (removed)
        {
            syncConnectedClients(now);
            state.debug.last_input_source = 'presence-depart:' + playerId.slice(0, 60);
            bumpRevision();
            notifySubscribers();
            if (departingEntry) emitWowEvent(wowUserEvent('user_left', departingEntry));
            console.log('[Presence][' + LOCATION_ID + '] DEPART ' + JSON.stringify({
                player_id : playerId,
                reason : presenceString(input.reason, 'unspecified', 80),
                registry_size : presenceRegistry.size,
            }));
        }
        if (presenceRegistry.size === 0) stopPresenceSweeper();
        return clone({
            ok : true,
            departed : removed,
            known : removed,
            location_id : LOCATION_ID,
            player_id : playerId,
            registered_player_count : presenceRegistry.size,
        });
    }

    /** Read-only destination occupancy summary (what THIS server knows). */
    function fabricPresenceSummary()
    {
        const nowMs = Date.now();
        const players = livePresenceEntries(nowMs);
        return {
            occupancy : {
                // the REAL registered players of this
                // location (explicit register/heartbeat/depart, TTL-expired).
                // Empty means the server truthfully knows of no players here.
                avatars : players.map(entry => presenceEntrySummary(entry, nowMs)),
                registered_player_count : players.length,
                arrival_count : state.session.arrival_count,
                live_subscriber_count : subscriberCount(),
                source : 'server-side-presence-registry',
            },
            // the ghost-free crossing's server-side invariant,
            // readable. `resurrections_blocked` counts heartbeats that arrived after
            // their own player had departed and were REFUSED (each one would have been
            // a 10-second ghost in this world under the pre-076 upsert).
            departure_enforcement : {
                _claim : 'runtime: an explicit departure is final — a heartbeat '
                    + 'already in flight cannot upsert a departed player back into this world',
                tombstone_ms : PRESENCE_DEPART_TOMBSTONE_MS,
                // Counted live (expiry > now), never by Map size: this read stays PURE
                // (it removes nothing — the sweeper owns removal, as it does for the
                // registry itself), so an expired tombstone is never reported as active.
                active_tombstones : Array.from(presenceTombstones.values())
                    .filter(expiresAt => expiresAt > nowMs).length,
                resurrections_blocked : presenceResurrectionsBlocked,
            },
            // The single avatar identity this node HOSTS (world-local record) —
            // kept as labeled context; it is no longer counted as occupancy.
            hosted_avatar_identity : {
                avatar_id : state.avatar.avatar_id,
                continuity_id : state.avatar.continuity_id,
                display_name : state.avatar.display_name,
                note : 'hosted world avatar identity record, not a registered player',
            },
            presence_scope : 'server-side per-location player registry '
                + ': occupancy.avatars lists the players explicitly '
                + 'registered with THIS location\'s server via register/heartbeat/depart, '
                + 'TTL-expired against ghosts; one presence truth shared with observer '
                + 'views through session.connected_clients',
            registry : {
                registered_player_count : players.length,
                ttl_default_ms : PRESENCE_TTL_DEFAULT_MS,
                ttl_bounds_ms : { min : PRESENCE_TTL_MIN_MS, max : PRESENCE_TTL_MAX_MS },
                heartbeat_interval_hint_ms : PRESENCE_HEARTBEAT_HINT_MS,
                register_endpoint : '/fabric/presence/register',
                heartbeat_endpoint : '/fabric/presence/heartbeat',
                depart_endpoint : '/fabric/presence/depart',
                mutation_rule : 'registration/heartbeat/departure are explicit player '
                    + 'session actions POSTed to the player\'s OWN active server; '
                    + 'GET reads never mutate',
            },
            captured_at : new Date().toISOString(),
            ttl_ms : 4000,
        };
    }

    /**
     * GET /fabric/presence — light read-only occupancy summary for prefetch
     * refresh polling. Mutates nothing.
     */
    function getFabricPresence()
    {
        return clone(Object.assign({
            ok : true,
            location_id : LOCATION_ID,
            world_id : WORLD_ID,
            fabric_id : 'local-fabric-' + LOCATION_ID,
        }, fabricPresenceSummary(), {
            proof_boundary : getWowProofBoundary(),
        }, fabricRegionBoundary()));
    }

    const FABRIC_REGION_MIN_RADIUS_M = 1.0;
    // A/B/lobby have no authored graph and remain byte-for-byte at the proven
    // 12 m cap. Large authored worlds derive a bounded local aperture from
    // their walkable geometry (24 m for the 24 x 88 m Denver concourse), so
    // even the largest allowed read remains partial rather than whole-world.
    const FABRIC_REGION_MAX_RADIUS_M = authoredFabricRegionMaxRadius(AUTHORED_WOW_GRAPH);

    /**
     * GET /fabric/region — the portal-neighborhood (partial) fabric read: only
     * the hosted entities within radius_m of the anchor portal, plus the portal
     * pose, spawn, occupancy summary, totals that make partiality auditable,
     * freshness, and proof labels. Read-only; mutates nothing.
     */
    /** Shared anchor/radius resolution + entity scan for the legacy and the
     * chunked region reads. `included`/`beyond` keep the
     *  scene_objects iteration order (the legacy response order); each entry
     *  carries distance_from_anchor_m. Pure read — mutates nothing. */
    function fabricRegionScan(anchorPortalId, radiusM)
    {
        const portal = state.portals.find(
            entry => entry.portal_id === String(anchorPortalId || ''));
        if (!portal)
            throw new Error('unknown anchor portal ' + anchorPortalId + ' on ' + LOCATION_ID);
        const requestedRadius = readNumber(radiusM, 5.0);
        const radius = Math.max(FABRIC_REGION_MIN_RADIUS_M,
            Math.min(FABRIC_REGION_MAX_RADIUS_M, requestedRadius));
        const anchor = fabricVec3(
            portal.trigger && portal.trigger.position, [ 2.8, 0, -2.8 ]);
        const included = [];
        const beyond = [];
        for (const obj of state.scene_objects)
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

    /**
     * the registered avatars standing INSIDE the
     * destination-side loading circle (the widened outer circle mirrored on
     * this — the destination — side). A read-time projection of the
     * presence registry, filtered by the same planar circle as the entity
     * scan: live spatial state, never cached fabric, never counted against
     * the chunk entity/byte budgets, and never mixed into `entities`/`totals`
     * (so every pre-011 partiality proof stays byte-stable). Pure read.
     */
    function fabricRegionAvatarsInCircle(scan)
    {
        const nowMs = Date.now();
        const inside = [];
        let unpositioned = 0;
        for (const entry of livePresenceEntries(nowMs))
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

    function getFabricRegion(anchorPortalId, radiusM)
    {
        const scan = fabricRegionScan(anchorPortalId, radiusM);
        const { portal, requestedRadius, radius, anchor } = scan;
        const entities = scan.included;
        const excluded = scan.beyond.length;
        const avatarsInCircle = fabricRegionAvatarsInCircle(scan);
        return clone(Object.assign({
            ok : true,
            location_id : LOCATION_ID,
            world_id : WORLD_ID,
            fabric_id : 'local-fabric-' + LOCATION_ID,
            version : state.attach_point.version,
            region : {
                type : 'portal_neighborhood_radius',
                anchor_portal_id : portal.portal_id,
                center : anchor.slice(),
                radius_m : radius,
                requested_radius_m : requestedRadius,
                radius_clamped : radius !== requestedRadius,
                // this circle also bounds avatar inclusion.
                includes_avatars_within_circle : true,
            },
            entities : entities,
            portal : demoPortalPose(portal),
            spawn : getFabricSpawnPose(),
            // avatars inside the destination-side circle,
            // beside (never inside) the cached-fabric `entities` list.
            avatars : avatarsInCircle,
            totals : {
                fabric_entities : state.scene_objects.length,
                region_entities : entities.length,
                excluded_entities : excluded,
                truncated : false,
                avatars_in_circle : avatarsInCircle.avatars_in_circle,
            },
            presence : fabricPresenceSummary(),
            freshness : { captured_at : new Date().toISOString(), ttl_ms : 15000 },
            proof_boundary : getWowProofBoundary(),
        }, fabricRegionBoundary()));
    }

    // ---- chunked/progressive region streaming ------------
    //
    // The single-radius neighborhood read grows a TILED contract: the region is
    // served as DISTANCE-BANDED chunks (near ring first) with per-chunk
    // freshness/TTL, explicit byte/entity budgets with truncated:true + a
    // continuation cursor, and a scope=full mode whose beyond-ROI band feeds
    // post-arrival background fabric completion. Requests WITHOUT chunked=1 get
    // the exact pre-006 single response — the legacy shape is byte-identical.
    // Everything stays a labeled local proof contract: no chunking/tiling
    // standard exists for spatial fabrics; the shape follows the OGC 3D Tiles
    // precedent (bounding volumes, coarse error metric, ADD refinement) without
    // claiming conformance.
    const FABRIC_REGION_BAND_COUNT = 3; // equal rings inside the ROI
    const FABRIC_REGION_BAND_LABELS = [ 'near', 'mid', 'far' ];
    const FABRIC_REGION_BEYOND_LABEL = 'beyond_roi';
    const FABRIC_REGION_BAND_TTLS_MS = { near : 20000, mid : 40000, far : 60000, beyond_roi : 90000 };
    const FABRIC_REGION_SERVER_MAX_ENTITIES = 64;
    const FABRIC_REGION_SERVER_MAX_BYTES = 65536;
    const FABRIC_REGION_DEFAULT_MAX_ENTITIES = 24;
    const FABRIC_REGION_DEFAULT_MIN_BYTES = 256;
    const FABRIC_REGION_DEFAULT_MAX_BYTES = 16384;

    /** Per-band TTL with the OSL_FABRIC_REGION_TTL_OVERRIDES env fixture hook
     *  ('{"location-a":{"near":1500}}' — same pattern as the traversal
     *  overrides; unset/malformed -> defaults). Near is deliberately the
     *  freshest band: it is the first thing a crossing player stands in. */
    function fabricBandTtlMs(bandLabel)
    {
        const base = FABRIC_REGION_BAND_TTLS_MS[bandLabel] || 60000;
        const raw = process.env.OSL_FABRIC_REGION_TTL_OVERRIDES;
        if (!raw) return base;
        try
        {
            const parsed = JSON.parse(raw);
            const forLocation = parsed && typeof parsed === 'object' ? parsed[LOCATION_ID] : null;
            const hit = forLocation && typeof forLocation === 'object' ? Number(forLocation[bandLabel]) : NaN;
            return Number.isFinite(hit) && hit >= 250 ? hit : base;
        }
        catch (e)
        {
            return base;
        }
    }

    /** Distance-band layout over a scanned entity set. Bands 0..2 are equal
     *  rings inside the ROI radius; band 3 (scope=full only) is everything
     *  beyond it. Entities within each band sort nearest-first with an
     *  object_id tie-break so chunk order is deterministic. */
    function fabricRegionBands(scan, scope)
    {
        const radius = scan.radius;
        const step = radius / FABRIC_REGION_BAND_COUNT;
        const bands = [];
        for (let i = 0; i < FABRIC_REGION_BAND_COUNT; i += 1)
        {
            bands.push({
                band_index : i,
                band_label : FABRIC_REGION_BAND_LABELS[i],
                range_m : [ Number((i * step).toFixed(3)), Number(((i + 1) * step).toFixed(3)) ],
                entities : [],
            });
        }
        if (scope === 'full')
        {
            bands.push({
                band_index : FABRIC_REGION_BAND_COUNT,
                band_label : FABRIC_REGION_BEYOND_LABEL,
                range_m : [ Number(radius.toFixed(3)), null ],
                entities : [],
            });
        }
        const sorted = scan.included.slice().sort(
            (a, b) => a.distance_from_anchor_m - b.distance_from_anchor_m
                || String(a.object_id).localeCompare(String(b.object_id)));
        for (const entry of sorted)
        {
            const idx = Math.min(FABRIC_REGION_BAND_COUNT - 1,
                Math.floor(entry.distance_from_anchor_m / step));
            bands[idx].entities.push(entry);
        }
        if (scope === 'full')
        {
            const beyondSorted = scan.beyond.slice().sort(
                (a, b) => a.distance_from_anchor_m - b.distance_from_anchor_m
                    || String(a.object_id).localeCompare(String(b.object_id)));
            bands[FABRIC_REGION_BAND_COUNT].entities = beyondSorted;
        }
        return bands;
    }

    function fabricRegionEntityBytes(entity)
    {
        return Buffer.byteLength(JSON.stringify(entity), 'utf8');
    }

    /**
     * GET /fabric/region?chunked=1 — one distance-banded chunk per response,
     * budget-bounded, with explicit truncation + continuation cursor.
     * Read-only; mutates nothing. Cursor grammar: '<band_index>:<offset>'.
     */
    function getFabricRegionChunk(anchorPortalId, radiusM, opts)
    {
        const options = opts || {};
        const scope = options.scope == null || options.scope === '' ? 'roi' : String(options.scope);
        if (scope !== 'roi' && scope !== 'full')
            throw new Error('invalid scope "' + scope + '" (roi|full)');
        // Omitted budget params mean the documented defaults (readNumber would
        // coerce null->0, which the clamps would turn into the minimums).
        const maxEntities = Math.max(1, Math.min(FABRIC_REGION_SERVER_MAX_ENTITIES,
            Math.floor(options.max_entities == null || options.max_entities === ''
                ? FABRIC_REGION_DEFAULT_MAX_ENTITIES
                : readNumber(options.max_entities, FABRIC_REGION_DEFAULT_MAX_ENTITIES))));
        const maxBytes = Math.max(FABRIC_REGION_DEFAULT_MIN_BYTES,
            Math.min(FABRIC_REGION_SERVER_MAX_BYTES,
                Math.floor(options.max_bytes == null || options.max_bytes === ''
                    ? FABRIC_REGION_DEFAULT_MAX_BYTES
                    : readNumber(options.max_bytes, FABRIC_REGION_DEFAULT_MAX_BYTES))));
        // Omitted radius means the documented 5.0 m ROI default (background
        // completion deliberately omits it); readNumber would coerce null->0.
        const scan = fabricRegionScan(anchorPortalId,
            radiusM == null || radiusM === '' ? 5.0 : radiusM);
        const bands = fabricRegionBands(scan, scope);

        // Cursor: null -> first band with entities; '<band>:<offset>' resumes.
        let bandIndex = 0;
        let offset = 0;
        let cursorProvided = false;
        if (options.cursor != null && options.cursor !== '')
        {
            cursorProvided = true;
            const match = /^(\d+):(\d+)$/.exec(String(options.cursor));
            if (!match)
                throw new Error('invalid cursor "' + options.cursor + '" (expected <band>:<offset>)');
            bandIndex = Number(match[1]);
            offset = Number(match[2]);
            if (bandIndex >= bands.length)
                throw new Error('invalid cursor band ' + bandIndex + ' (scope ' + scope + ' has ' + bands.length + ' bands)');
            const bandLen = bands[bandIndex].entities.length;
            if (offset !== 0 && offset >= bandLen)
                throw new Error('invalid cursor offset ' + offset + ' (band ' + bandIndex + ' has ' + bandLen + ' entities)');
        }
        if (!cursorProvided)
        {
            while (bandIndex < bands.length - 1 && bands[bandIndex].entities.length === 0)
                bandIndex += 1;
        }

        // Serve from ONE band per response, stopping at whichever budget trips
        // first. A single entity larger than the byte budget still ships (with
        // an honesty flag) so continuation always makes progress.
        const band = bands[bandIndex];
        const chunkEntities = [];
        let chunkBytes = 0;
        let truncationReason = null;
        let byteBudgetExceededBySingleEntity = false;
        for (let i = offset; i < band.entities.length; i += 1)
        {
            const entity = band.entities[i];
            const entityBytes = fabricRegionEntityBytes(entity);
            if (chunkEntities.length >= maxEntities)
            {
                truncationReason = 'entity_budget';
                break;
            }
            if (chunkEntities.length > 0 && chunkBytes + entityBytes > maxBytes)
            {
                truncationReason = 'byte_budget';
                break;
            }
            if (chunkEntities.length === 0 && entityBytes > maxBytes)
                byteBudgetExceededBySingleEntity = true;
            chunkEntities.push(entity);
            chunkBytes += entityBytes;
        }
        const nextOffset = offset + chunkEntities.length;
        let continuation = null;
        if (truncationReason)
        {
            continuation = {
                cursor : bandIndex + ':' + nextOffset,
                next_band_index : bandIndex,
                next_band_label : band.band_label,
                remaining_entities_in_band : band.entities.length - nextOffset,
            };
        }
        else
        {
            let nextBand = bandIndex + 1;
            while (nextBand < bands.length && bands[nextBand].entities.length === 0)
                nextBand += 1;
            if (nextBand < bands.length)
            {
                truncationReason = 'band_boundary';
                continuation = {
                    cursor : nextBand + ':0',
                    next_band_index : nextBand,
                    next_band_label : bands[nextBand].band_label,
                    remaining_entities_in_band : bands[nextBand].entities.length,
                };
            }
        }
        const truncated = continuation !== null;
        const nowIso = new Date().toISOString();
        const ttlMs = fabricBandTtlMs(band.band_label);
        const scopeEntities = scope === 'full'
            ? scan.included.length + scan.beyond.length
            : scan.included.length;
        const response = {
            ok : true,
            location_id : LOCATION_ID,
            world_id : WORLD_ID,
            fabric_id : 'local-fabric-' + LOCATION_ID,
            version : state.attach_point.version,
            region : {
                type : 'portal_neighborhood_radius_chunked',
                anchor_portal_id : scan.portal.portal_id,
                center : scan.anchor.slice(),
                radius_m : scan.radius,
                requested_radius_m : scan.requestedRadius,
                radius_clamped : scan.radius !== scan.requestedRadius,
                scope : scope,
                bands : bands.map(b => ({
                    band_index : b.band_index,
                    band_label : b.band_label,
                    range_m : b.range_m,
                    entity_count : b.entities.length,
                    ttl_ms : fabricBandTtlMs(b.band_label),
                })),
            },
            chunk : {
                chunk_id : scan.portal.portal_id + '#' + scope + '#' + bandIndex + ':' + offset,
                band_index : bandIndex,
                band_label : band.band_label,
                band_range_m : band.range_m,
                entities : chunkEntities,
                entity_count : chunkEntities.length,
                byte_size : chunkBytes,
                byte_size_rule : 'sum of per-entity UTF-8 JSON bytes (measured server-side at serialization)',
                ...(byteBudgetExceededBySingleEntity
                    ? { byte_budget_exceeded_by_single_entity : true }
                    : {}),
                freshness : {
                    generated_at : nowIso,
                    ttl_ms : ttlMs,
                    expires_at : new Date(Date.now() + ttlMs).toISOString(),
                },
            },
            continuation : continuation,
            truncated : truncated,
            truncation_reason : truncated ? truncationReason : null,
            budget : {
                max_entities : maxEntities,
                max_bytes : maxBytes,
                server_max_entities : FABRIC_REGION_SERVER_MAX_ENTITIES,
                server_max_bytes : FABRIC_REGION_SERVER_MAX_BYTES,
            },
            totals : {
                fabric_entities : state.scene_objects.length,
                region_entities : scan.included.length,
                excluded_entities : scan.beyond.length,
                scope_entities : scopeEntities,
                truncated : truncated,
            },
            freshness : { captured_at : nowIso, ttl_ms : ttlMs },
            proof_boundary : getWowProofBoundary(),
        };
        // First chunk of a walk carries the portal/spawn/presence context the
        // legacy response always had; continuations stay light.
        // the first chunk also carries the avatars inside
        // the destination-side circle (read-time projection — deliberately
        // OUTSIDE the chunk entity/byte budgets, which stay entities-only).
        if (!cursorProvided)
        {
            response.portal = demoPortalPose(scan.portal);
            response.spawn = getFabricSpawnPose();
            response.presence = fabricPresenceSummary();
            response.avatars = fabricRegionAvatarsInCircle(scan);
            response.region.includes_avatars_within_circle = true;
        }
        return clone(Object.assign(response, fabricRegionBoundary(), {
            chunking_standard_conformance : false,
        }));
    }

    /**
     * GET /fabric/region/tileset-hypothesis — the chunk layout expressed in an
     * OGC-3D-Tiles-SHAPED structure (nested bounding spheres per band + a
     * coarse geometric-error metric + ADD refinement) as a LABELED HYPOTHESIS
     * ARTIFACT for future standards conversation. NEVER a conformance claim:
     * three_d_tiles_conformance:false on the artifact itself.
     */
    function getFabricRegionTilesetHypothesis(anchorPortalId, radiusM)
    {
        const scan = fabricRegionScan(anchorPortalId,
            radiusM == null || radiusM === '' ? 5.0 : radiusM);
        const bands = fabricRegionBands(scan, 'full');
        const anchor = scan.anchor;
        const maxObserved = bands.reduce((acc, b) => {
            const last = b.entities.length ? b.entities[b.entities.length - 1] : null;
            return last ? Math.max(acc, last.distance_from_anchor_m) : acc;
        }, scan.radius);
        return clone(Object.assign({
            ok : true,
            location_id : LOCATION_ID,
            world_id : WORLD_ID,
            fabric_id : 'local-fabric-' + LOCATION_ID,
            hypothesis_artifact : true,
            three_d_tiles_shaped : true,
            three_d_tiles_conformance : false,
            purpose : 'runtime labeled hypothesis artifact — expresses the '
                + '/fabric/region distance-band chunk layout in an OGC-3D-Tiles-SHAPED '
                + 'structure (bounding volumes + coarse geometric error + ADD refinement) '
                + 'as a concrete input for future standards conversation. NOT a 3D Tiles '
                + 'tileset; no conformance is claimed or implied.',
            asset_shape : { version_shape : '1.1-shaped', tileset_shape_only : true },
            geometricError : Number((maxObserved * 2).toFixed(3)),
            root : {
                boundingVolume : { sphere : [ anchor[0], anchor[1], anchor[2], Number(maxObserved.toFixed(3)) ] },
                geometricError : Number(scan.radius.toFixed(3)),
                refine : 'ADD',
                children : bands.map(b => {
                    const outer = b.range_m[1] != null ? b.range_m[1] : Number(maxObserved.toFixed(3));
                    return {
                        boundingVolume : { sphere : [ anchor[0], anchor[1], anchor[2], outer ] },
                        // Coarse error metric: nearer rings refine finer. A
                        // deliberate hypothesis, not a screen-space-error claim.
                        geometricError : Number((outer / FABRIC_REGION_BAND_COUNT).toFixed(3)),
                        content : {
                            uri : '/fabric/region?anchor_portal_id='
                                + encodeURIComponent(scan.portal.portal_id)
                                + '&chunked=1&scope=full&cursor=' + b.band_index + ':0',
                        },
                        extensions : {
                            osl_local_band : {
                                band_index : b.band_index,
                                band_label : b.band_label,
                                range_m : b.range_m,
                                entity_count : b.entities.length,
                                ttl_ms : fabricBandTtlMs(b.band_label),
                            },
                        },
                    };
                }),
            },
            proof_boundary : getWowProofBoundary(),
        }, fabricRegionBoundary(), { chunking_standard_conformance : false }));
    }

    // END helpers

    /** Yaw (radians) of this world's portal frame forward preset. */
    function portalFrameYawRad()
    {
        const preset = FABRIC_PORTAL_FRAME_PRESETS[LOCATION_ID] || {};
        const f = fabricNormalizeVec3(preset.forward || [ 0, 0, 1 ], [ 0, 0, 1 ]);
        return Math.hypot(f[0], f[2]) > 1e-6 ? Math.atan2(f[0], f[2]) : 0;
    }

    /**
     * GET /wow/portal/{portalId} for the SPEC domain (integer id) —
     * WoW OpenAPI `Portal` schema shape: numeric `id` + geoPose
     * { position: { lat, lan, h }, angles: { yaw, pitch, roll } }.
     * Demo detail (trigger volume, arrival transform, target world) rides in
     * the labeled `webofworlds_extension` additional property.
     */
    function getWowPortalResource(idOrAlias)
    {
        const hit = resolveWowPortal(idOrAlias);
        if (!hit)
            return null;
        const { portal, wowId } = hit;
        return {
            id : wowId, // number, per WoW Portal schema
            geoPose : wowGeoPoseFromLocal(portal.trigger.position, portalFrameYawRad(), 0),
            label : portal.label || ('Portal ' + portal.portal_id),
            // LABELED, NON-CANONICAL Portal.destination.
            destination : portalDestination(portal),
            webofworlds_extension : wowPortalExtension(portal, wowId),
            proof_boundary : getWowProofBoundary(),
        };
    }

    /**
     * Legacy string-alias projection (/wow/portal/location-a-portal). The live
     * 057 client and its e2e harness require `id` to stay the STRING portal_id
     * (frame descriptors are validated as strings client-side), so this alias
     * keeps the pre-076 shape. The spec's own path param is an integer, so the
     * string route is outside the spec domain — a labeled compatibility alias;
     * the numeric route above is the tightened WoW resource.
     */
    function getWowPortal(portalId)
    {
        if (/^\d+$/.test(String(portalId == null ? '' : portalId)))
            return getWowPortalResource(portalId); // spec domain -> strict shape
        const hit = resolveWowPortal(portalId);
        if (!hit)
            return null;
        const { portal, wowId } = hit;
        return {
            id : portal.portal_id,
            label : portal.label || ('Portal ' + portal.portal_id),
            geoPose : {
                position : {
                    x : portal.trigger.position[0],
                    y : portal.trigger.position[1],
                    z : portal.trigger.position[2],
                },
                angles : { yaw : 0, pitch : 0, roll : 0 },
                orientation : { x : 0, y : 0, z : 0, w : 1 },
                radius_m : readNumber(portal.trigger.radius_m, 0),
            },
            // LABELED, NON-CANONICAL Portal.destination
            // (same labeled destination on the legacy string-alias projection).
            destination : portalDestination(portal),
            webofworlds_extension : wowPortalExtension(portal, wowId),
            proof_boundary : getWowProofBoundary(),
        };
    }

    /**
     * GET /wow/user/{userId} — WoW OpenAPI `User` schema shape:
     * numeric `id`, `name`, string `AvatarURI`, geoPose
     * { position: { lat, lan, h }, angles: { yaw, pitch, roll } }.
     * The spec's userId is an integer (our one local user is id 1); the demo
     * aliases 'me', avatar_id and continuity_id keep resolving to the same
     * resource. Local Cartesian truth rides in `webofworlds_extension`.
     */
    function getWowUser(userId)
    {
        const a = state.avatar;
        const accepted = [ String(WOW_LOCAL_USER_ID), a.avatar_id, a.continuity_id, 'me' ]
            .filter((alias, index, all) => all.indexOf(alias) === index);
        // Hosted-avatar user (id 1 + aliases) — pre-015 projection, unchanged.
        if (!userId || accepted.indexOf(String(userId)) !== -1)
        {
            const t = a.transform;
            return {
                id : WOW_LOCAL_USER_ID, // number, per WoW User schema
                name : a.display_name,
                AvatarURI : '', // avatar is a client-side VRM/GLB; this node hosts no avatar asset
                geoPose : wowGeoPoseFromLocal(t.position, t.rotation_y, 0),
                webofworlds_extension : {
                    avatar_id : a.avatar_id,
                    continuity_id : a.continuity_id,
                    display_name : a.display_name,
                    accepted_aliases : accepted,
                    local_transform : {
                        position : t.position.slice(),
                        rotation_y : t.rotation_y,
                        orientation : t.orientation.slice(),
                        scale : t.scale.slice(),
                    },
                    geopose_mapping : WOW_GEOPOSE_MAPPING,
                    source_session_id : a.handoff_context ? a.handoff_context.source_session_id : SESSION_ID,
                    source_world_id : a.handoff_context ? a.handoff_context.source_world_id : WORLD_ID,
                    source_location_id : a.handoff_context ? a.handoff_context.source_location_id : LOCATION_ID,
                    handoff_context : a.handoff_context,
                },
                proof_boundary : getWowProofBoundary(),
            };
        }
        // otherwise resolve a LIVE presence player (by minted
        // /wow/user id or player_id) as a WoW User — fronting the existing TTL
        // registry so /wow/user reflects real occupancy. Ghost-free: an id for a
        // departed/TTL-expired player no longer matches -> honest 404.
        return getWowPresenceUser(userId);
    }

    /**
     * Resolve a LIVE presence player (by minted `/wow/user` id or player_id) as a
     * WoW `User` resource. Ghost-free (reads livePresenceEntries -> TTL-filtered);
     * returns null (-> 404) when no such live player. Same response shape as the
     * hosted-avatar user so it validates against OSLUserResponse.
     */
    function getWowPresenceUser(idOrPlayerId)
    {
        const key = String(idOrPlayerId == null ? '' : idOrPlayerId);
        if (!key) return null;
        const nowMs = Date.now();
        const entry = livePresenceEntries(nowMs)
            .find(e => String(e.wow_user_id) === key || e.player_id === key);
        if (!entry) return null;
        const pos = Array.isArray(entry.position) ? entry.position : [ 0, 0, 0 ];
        const yaw = Number.isFinite(entry.rotation_y) ? entry.rotation_y : 0;
        return {
            id : entry.wow_user_id, // number, per WoW User schema
            name : entry.display_name,
            AvatarURI : '', // client-side VRM/GLB avatar; no hosted asset
            geoPose : wowGeoPoseFromLocal(pos, yaw, 0),
            webofworlds_extension : {
                source : 'presence-registry',
                player_id : entry.player_id,
                client_id : entry.client_id,
                avatar_id : entry.avatar_id,
                continuity_id : entry.continuity_id,
                display_name : entry.display_name,
                registered_at : entry.registered_at,
                last_seen_at : entry.last_seen_at,
                ttl_ms : entry.ttl_ms,
                expires_in_ms : Math.max(0, entry.expires_at_ms - nowMs),
                local_transform : {
                    position : pos.slice(),
                    rotation_y : yaw,
                },
                geopose_mapping : WOW_GEOPOSE_MAPPING,
                presence_scope : 'server-side-ttl-registry (local occupancy truth; not networked)',
            },
            proof_boundary : getWowProofBoundary(),
        };
    }

    /**
     * the SIGNED OpenUserManifest identity fronted via
     * /wow/user. Wraps the (byte-unchanged) getWowUser projection and attaches the
     * retained UM identity spine: the OpenUserManifest content shape
     * {name, age, avatarAssetURI} SIGNED with UM Signature Profile A (Ed25519 /
     * JCS-RFC8785 / did:key), carried as a LABELED non-canonical additive field
     * `open_user_manifest`. The canonical User ({id,name,AvatarURI,geoPose}) +
     * proof_boundary + webofworlds_extension stay UNCHANGED (canonical stays clean
     * for the conformance diff). On signer failure it DEGRADES HONESTLY to
     * an unsigned/unverified manifest — never a cosmetic green. Async (WebCrypto).
     * Resolves the same hosted-avatar + live-presence users getWowUser resolves.
     */
    async function getWowUserSigned(userId)
    {
        const user = getWowUser(userId);
        if (!user) return null;
        // OpenUserManifest content shape: name <- User.name,
        // avatarAssetURI <- User.AvatarURI (WoW's avatar field; empty when this
        // node hosts no avatar asset — the avatar is a client-side VRM/GLB), and
        // `age` ADDED (WoW's User schema is silent on age).
        const content = {
            name : user.name,
            age : WOW_OPEN_USER_MANIFEST_DEMO_AGE,
            avatarAssetURI : user.AvatarURI || '',
        };
        try {
            const signed = await umSignOpenUserManifest(content);
            return {
                ...user,
                // LABELED non-canonical additive. `open_user_manifest` is EXACTLY
                // the signed manifest {name,age,avatarAssetURI,signature} so a
                // client verifies it byte-exact as-is; the honesty label rides on
                // the SIBLING field below (NEVER inside the signed bytes).
                open_user_manifest : signed,
                open_user_manifest_label : UM_IDENTITY_NONCANONICAL_LABEL,
            };
        } catch (e) {
            // HONEST DEGRADATION: unsigned content + an explicit unsigned/unverified
            // label. standards_conformance stays false; no cosmetic conformance.
            return {
                ...user,
                open_user_manifest : { ...content, signature : null },
                open_user_manifest_label :
                    'UNSIGNED / UNVERIFIED — UM identity signer unavailable ('
                    + ((e && e.message) || 'error') + '); degraded honestly.',
            };
        }
    }

    /**
     * DELETE /wow/user/{userId} — the OpenSpatialWorld spec answers 200 "User deleted" or
     * 400 "Invalid user value"; this server adds 404 for an unknown id, as deleteNode() does.
     * There is no user database here: a userId resolves either to this location's own hosted
     * identity (the getWowUser aliases) or to a live presence-registry entry. Deleting the
     * hosted identity has no safe meaning for a stateless HTTP DELETE, so it is the spec's 400.
     * A live presence user is removed through departPresence(), the same path a player's own
     * departure takes.
     */
    function deleteWowUser(userId)
    {
        const a = state.avatar;
        const localAliases = [ String(WOW_LOCAL_USER_ID), a.avatar_id, a.continuity_id, 'me' ]
            .filter((alias, index, all) => all.indexOf(alias) === index);
        const key = String(userId == null ? '' : userId);
        if (!key || localAliases.indexOf(key) !== -1)
            return { ok : false, status : 400, error : 'invalid_user_value',
                reason : 'cannot_delete_local_hosted_identity', userId };
        const entry = livePresenceEntries(Date.now())
            .find(e => String(e.wow_user_id) === key || e.player_id === key);
        if (!entry)
            return { ok : false, status : 404, error : 'user_not_found', userId };
        const departed = departPresence({ player_id : entry.player_id, reason : 'deleted via DELETE /wow/user/' + key });
        return { ok : true, status : 200, value : { ok : true, deleted : true, userId, ...departed } };
    }

    /**
     * GET /wow/view/{viewId} — WoW OpenAPI `View` schema shape:
     * the PlayerView camera as a WoW "view".
     * View 1 is the PlayerView's over-shoulder camera seat, projected
     * server-side from the live presence pose through the SAME rig constants
     * the PlayerView uses client-side (WOW_VIEW_CAMERA_RIG mirrors prototype
     * 057 web/app.js PLAYER_CAMERA_DEFAULT / updatePlayerCamera()).
     */
    function getWowView(viewId)
    {
        const accepted = [ String(WOW_PLAYER_VIEW_ID), 'player', 'player-camera' ];
        if (viewId && accepted.indexOf(String(viewId)) === -1)
            return null;
        const t = state.avatar.transform;
        const yaw = readNumber(t.rotation_y, 0);
        const p = t.position;
        const rig = WOW_VIEW_CAMERA_RIG;
        const forward = [ Math.sin(yaw), 0, Math.cos(yaw) ];
        // mirror app.js: position = [ax,0,az] - forward*follow_distance; y = ay + follow_height
        const cameraPosition = [
            (Number(p[0]) || 0) - forward[0] * rig.follow_distance_m,
            (Number(p[1]) || 0) + rig.follow_height_m,
            (Number(p[2]) || 0) - forward[2] * rig.follow_distance_m,
        ];
        // mirror app.js: target = avatar + look_target_height on y
        const lookTarget = [
            Number(p[0]) || 0,
            (Number(p[1]) || 0) + rig.look_target_height_m,
            Number(p[2]) || 0,
        ];
        // camera looks at the avatar from behind -> horizontal heading == avatar yaw;
        // pitch from the actual rig geometry (slightly below horizontal).
        const pitchRad = Math.atan2(
            rig.look_target_height_m - rig.follow_height_m, rig.follow_distance_m);
        return {
            id : WOW_PLAYER_VIEW_ID, // number, per WoW View schema
            geoPose : wowGeoPoseFromLocal(cameraPosition, yaw, pitchRad),
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
                follows_avatar_id : state.avatar.avatar_id,
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

    // ---- Spatial Composition Graph (canonical /wow/spatial) --
    //
    // The mutable, per-world scene-graph store the 041 backend serves at
    // /wow/spatial/{spatialID} (+ node CRUD). Seeded from THIS world's REAL live
    // scene data — the hosted primitives (/demo/scene-objects) and portals —
    // emitted as CANONICAL WoW `Node`s (id, label, names[], parent, children[],
    // a flat 16-float column-major localTransform, spatialAssetURI). OSL-native,
    // additive; env-gated JSON persistence lives in spatial-graph.js. Not stubs:
    // node count/positions come from the same live state the world already hosts.
    const SPATIAL_ID = WORLD_ID;
    // ids that address THIS world's graph (world_id + location_id + conveniences).
    const SPATIAL_ACCEPTED_IDS = [ WORLD_ID, LOCATION_ID, 'default', 'world' ];

    /** Canonical Node seed (root + children) built from the live scene data. */
    function buildSpatialSeedNodes()
    {
        const children = [];
        // (a) hosted primitives — the same objects GET /demo/scene-objects serves.
        for (const obj of state.scene_objects)
        {
            children.push({
                label : obj.label || obj.object_id,
                names : [ obj.object_id, obj.label, String(obj.shape || 'box') ]
                    .filter((name, index, all) => name && all.indexOf(name) === index),
                localTransform : translationMatrix(obj.position),
                // Labeled OSL primitive URI — honestly a hosted primitive, NOT a
                // glTF asset.
                spatialAssetURI : obj.spatial_asset_uri || ('osl-primitive:'
                    + encodeURIComponent(String(obj.shape || 'box'))
                    + '?size_m=' + (Number(obj.size_m) || 0)),
                appearanceURI : obj.color ? 'osl-color:' + String(obj.color).replace('#', '') : undefined,
                webofworlds_extension : obj.authored_wow_content
                    ? Object.assign({ authored_wow_content : true, authored_node_id : obj.node_id },
                        obj.webofworlds_extension || {})
                    : undefined,
            });
        }
        // (b) portals as composition-graph nodes — the crossing anchors.:
        // the node now carries its RESOLVABLE DESTINATION as a labeled, non-canonical
        // `webofworlds_extension` (the target world's canonical /wow/spatial graph
        // reference) so a client walking the graph derives the portal from the NODE,
        // not a side-channel. The `osl-portal:` spatialAssetURI is KEPT as a labeled
        // parseable fallback (NOT a glTF asset). Both ride legally on the open
        // canonical Node and are SURFACED (never hidden).
        state.portals.forEach((portal, index) => {
            const wowId = index + 1;
            const trigger = portal.trigger || {};
            const targetWorldId = portal.target_world_id || portal.target_fixture?.spatial_id;
            const targetLocationId = portal.target_location_id || portal.target_fixture?.spatial_id;
            children.push({
                label : portal.label || ('Portal ' + portal.portal_id),
                names : [ portal.portal_id, 'portal', 'wow-portal-' + wowId ],
                localTransform : translationMatrix(trigger.position),
                spatialAssetURI : 'osl-portal:?' + [
                    'target_world_id=' + encodeURIComponent(portal.target_world_id || ''),
                    'target_location_id=' + encodeURIComponent(portal.target_location_id || ''),
                    'target_base_url=' + encodeURIComponent(portal.target_base_url || ''),
                    'target_portal_id=' + encodeURIComponent(portal.target_portal_id || ''),
                ].join('&'),
                webofworlds_extension : {
                    role : 'portal',
                    portal_id : portal.portal_id,
                    portal_resource : '/wow/portal/' + wowId,
                    // the RESOLVABLE DESTINATION: the target world's canonical
                    // /wow/spatial graph id + endpoint (B composition-graph
                    // reference — the minimal path that needs no spec change).
                    target_spatial_id : targetWorldId || undefined,
                    target_spatial_graph_endpoint : targetWorldId ? '/wow/spatial/' + SPATIAL_GRAPH_ID : undefined,
                    target_world_id : targetWorldId || undefined,
                    target_location_id : targetLocationId || undefined,
                    target_base_url : portal.target_base_url || undefined,
                    traversal_mode : portalTraversalRule(portal).mode,
                    reciprocal : portalReciprocalRule(portal),
                    note : 'LABELED x-osl-extension. Destination is a composition-graph '
                        + 'reference to the sibling world\'s /wow/spatial graph — NOT a canonical '
                        + 'Node field, NOT a signed .msf reference. Rides legally on the open '
                        + 'canonical Node; surfaced by runtime.',
                },
            });
        });
        return {
            root : {
                label : TITLE + ' - spatial composition graph',
                names : [ WORLD_ID, LOCATION_ID ],
                localTransform : translationMatrix([ 0, 0, 0 ]),
            },
            nodes : children,
        };
    }

    const spatialStore = createSpatialGraphStore({
        spatialId : SPATIAL_ID,
        graphId : SPATIAL_GRAPH_ID,
        acceptedIds : SPATIAL_ACCEPTED_IDS,
        seedBuilder : buildSpatialSeedNodes,
    });

    /** Resolve a spatialID to THIS node's graph store, or null (-> 404). */
    function spatialResolve(spatialID)
    {
        return spatialStore.matches(spatialID) ? spatialStore : null;
    }

    /** The composition graph's root node, as the canonical Node, or as the OSLFlatNode with opts.form 'flat'. */
    function getSpatialGraphRoot(spatialID, opts)
    {
        const store = spatialResolve(spatialID);
        return store ? store.getRoot(opts) : null;
    }

    /**
     * The `Spatial` that GET /wow/spatial/{spatialID} returns: the graph's integer id, the id of
     * its root node and the GeoPose that anchors its origin. It POINTS AT the root node, which is
     * at /wow/spatial/{id}/node/{rootNodeID}.
     */
    function getSpatialDescriptor(spatialID)
    {
        const store = spatialResolve(spatialID);
        if (!store) return null;
        const root = store.getRoot({ form : 'flat' });
        const rootNodeID = root ? root.id : 0;
        return {
            id : store.graphId,
            rootNodeID : rootNodeID,
            geoPose : clone(WORLD_ANCHOR), // the graph's anchor, as read from the fixture
            // LABELED, NON-CANONICAL additive members.
            webofworlds_extension : {
                x_osl_extension : true,
                spatial_id : store.spatialId,
                accepted_ids : store.acceptedIds,
                root_node_endpoint : '/wow/spatial/' + store.graphId + '/node/' + rootNodeID,
                note : 'The graph id is the integer `id`. The world id and the location id in `accepted_ids` are '
                    + 'deprecated aliases that still resolve. The root node is at root_node_endpoint.',
            },
            proof_boundary : getWowProofBoundary(),
        };
    }

    /** A node with its subtree embedded (the canonical Node), or as the OSLFlatNode with opts.form 'flat'. */
    function getSpatialNode(spatialID, nodeId, opts)
    {
        const store = spatialResolve(spatialID);
        return store ? store.getNode(nodeId, opts) : null;
    }

    /**
     * POST — create child nodes under a parent (broadcasts a state change).
     *
     * The body is canonical (children embedded) unless the caller asked for the flat form. With
     * `opts.flattenEmbedded` an embedded subtree is stored whole, one node per object, and every id
     * is assigned. Without it (the flat form) an embedded child is refused with a named 422: a body
     * is never stored with part of it dropped.
     */
    function createSpatialNodes(spatialID, parentId, incoming, opts)
    {
        const store = spatialResolve(spatialID);
        if (!store) return { ok : false, status : 404, error : 'spatial_graph_not_found', spatialID : spatialID };
        const r = store.createChildren(parentId, incoming, opts);
        if (r.ok)
        {
            state.debug.last_input_source = 'wow-spatial-node-create'; bumpRevision(); notifySubscribers();
            // one node_created per created node on /events.
            for (const node of (r.value || [])) emitWowEvent(wowNodeEvent('node_created', store.spatialId, node));
        }
        return r;
    }

    /** PUT — update a node's content or move it (broadcasts a state change). opts.form is 'flat' or canonical. */
    function updateSpatialNode(spatialID, nodeId, node, opts)
    {
        const store = spatialResolve(spatialID);
        if (!store) return { ok : false, status : 404, error : 'spatial_graph_not_found', spatialID : spatialID };
        const r = store.updateNode(nodeId, node, opts);
        if (r.ok)
        {
            state.debug.last_input_source = 'wow-spatial-node-update'; bumpRevision(); notifySubscribers();
            // node_updated on /events.
            emitWowEvent(wowNodeEvent('node_updated', store.spatialId, r.value));
        }
        return r;
    }

    /** DELETE — remove a node + subtree (broadcasts a state change). */
    function deleteSpatialNode(spatialID, nodeId)
    {
        const store = spatialResolve(spatialID);
        if (!store) return { ok : false, status : 404, error : 'spatial_graph_not_found', spatialID : spatialID };
        const r = store.deleteNode(nodeId);
        if (r.ok)
        {
            state.debug.last_input_source = 'wow-spatial-node-delete'; bumpRevision(); notifySubscribers();
            // one node_deleted per removed id (whole subtree).
            for (const id of ((r.value && r.value.deleted) || [])) emitWowEvent(wowNodeEvent('node_deleted', store.spatialId, { id : id }));
        }
        return r;
    }

    // ---- OMB fabric-manifest projection -------------------
    //
    // GET /fabric.json projects the live world state into the Open Metaverse
    // Browser "fabric manifest" shape (docs/webofworlds-teleportxr-demo/
    // WORLD-NAVIGATOR-ARCHITECTURE.md section 4.2). NAMING RULE (section 7):
    // this file format is always the "fabric manifest" in this project, never
    // "MSF" — "MSF" means Metaverse Standards Forum only.
    //
    // Served as PLAIN JSON (unsigned) and labeled as such via `trust` below —
    // JWS signing / trust enforcement is future work (claim boundary).
    //
    // primary.camera MUST equal the avatar spawn pose the live client computes
    // today, so the spawn math below mirrors web/live-adapter.js in prototype
    // 057 (portalFrameForLocation ground_center/forward rounding + worldFromLive
    // sourceSpawn) EXACTLY — same constants, same rounding, same operation
    // order — keeping the doubles bit-identical with the browser's
    // world.avatar.spawn_position.

    function fabricRound(value, digits)
    {
        const n = Number(value);
        return Number.isFinite(n) ? Number(n.toFixed(digits)) : 0;
    }

    function fabricVec3(value, fallback)
    {
        const src = Array.isArray(value) ? value : fallback;
        return [
            Number(src && src[0]) || 0,
            Number(src && src[1]) || 0,
            Number(src && src[2]) || 0,
        ];
    }

    function fabricRoundVec3(value, digits)
    {
        return fabricVec3(value, [ 0, 0, 0 ]).map(entry => fabricRound(entry, digits));
    }

    function fabricNormalizeVec3(value, fallback)
    {
        const v = fabricVec3(value, fallback || [ 0, 0, 1 ]);
        const length = Math.hypot(v[0], v[1], v[2]);
        if (length <= 1e-6) return fabricVec3(fallback || [ 0, 0, 1 ], [ 0, 0, 1 ]);
        return v.map(entry => entry / length);
    }

    /** Avatar spawn pose for THIS world, identical to the live client's. */
    function getFabricSpawnPose()
    {
        // A configured authored graph may carry its own entry spawn. Reuse it
        // directly so its local coordinate frame is not replaced by the demo
        // room's portal-derived spawn heuristic. Existing nodes omit this and
        // remain byte-identical.
        if (cfg.entry_spawn && Array.isArray(cfg.entry_spawn.position))
        {
            const position = fabricVec3(cfg.entry_spawn.position, [ 0, 0, 0 ]);
            const rotationY = readNumber(cfg.entry_spawn.rotation_y, 0);
            return {
                position : position,
                rotation_y : rotationY,
                rotation : [ 0, Math.sin(rotationY / 2), 0, Math.cos(rotationY / 2) ],
            };
        }
        const portal = state.portals[0] || null;
        // with N portals the spawn anchors on the
        // CENTROID of the portal ground centers (the lobby's gathering spot
        // between its portals) instead of biasing toward portals[0]. For a
        // single-portal world the centroid IS that portal's trigger, so the
        // pre-004 pose is byte-identical. The live client's spawn derivation
        // (web/live-adapter.js sourceSpawnForWorld) MIRRORS this rule.
        const triggers = state.portals
            .map(p => fabricVec3(p.trigger && p.trigger.position, null))
            .filter(Boolean);
        const trigger = triggers.length
            ? [
                triggers.reduce((s, t) => s + t[0], 0) / triggers.length,
                triggers.reduce((s, t) => s + t[1], 0) / triggers.length,
                triggers.reduce((s, t) => s + t[2], 0) / triggers.length,
            ]
            : fabricVec3(portal && portal.trigger ? portal.trigger.position : null, [ 2.8, 0, -2.8 ]);
        const preset = FABRIC_PORTAL_FRAME_PRESETS[LOCATION_ID] || {};
        // mirror: frame.forward = roundVec3(normalizeVec3(preset.forward), 6)
        const forward = fabricRoundVec3(
            fabricNormalizeVec3(preset.forward || [ 0, 0, 1 ], [ 0, 0, 1 ]), 6);
        // mirror: frame.ground_center = roundVec3([ground[0], 0, ground[2]], 4)
        const groundCenter = fabricRoundVec3([ trigger[0], 0, trigger[2] ], 4);
        // mirror: sourceSpawn = addScaled3(ground_center, forward,
        //                                  max(2.4, trigger_depth + 2.4)); y = 0
        const spawnDistance = Math.max(
            FABRIC_SPAWN_CLEARANCE_M, FABRIC_PORTAL_TRIGGER_DEPTH_M + FABRIC_SPAWN_CLEARANCE_M);
        const position = [
            groundCenter[0] + forward[0] * spawnDistance,
            groundCenter[1] + forward[1] * spawnDistance,
            groundCenter[2] + forward[2] * spawnDistance,
        ];
        position[1] = 0;
        // the live client spawns with rotation_y = 0 -> identity yaw quaternion
        return { position, rotation_y : 0, rotation : [ 0, 0, 0, 1 ] };
    }

    function getFabricManifest()
    {
        const portal = state.portals[0] || null;
        const spawn = getFabricSpawnPose();
        const ownKey = LOCATION_ID.replace('location-', '');

        const children = [
            {
                Head : { Self : 'P-1' },
                Name : 'Avatar Spawn',
                Transform : { Position : spawn.position.slice() },
            },
        ];
        // one attachment + trigger node pair PER portal
        // (the lobby is the first N>1 node). The FIRST portal keeps the exact
        // pre-004 node ids ('P-2'/'P-3'), names, and action reference so
        // single-portal worlds serve a byte-identical manifest; additional
        // portals continue the P-<n> sequence with portal-id-suffixed names.
        let nextSelf = 2;
        for (let index = 0; index < state.portals.length; index += 1)
        {
            const entry = state.portals[index];
            const triggerPosition = fabricVec3(
                entry.trigger && entry.trigger.position, [ 2.8, 0, -2.8 ]);
            const targetKey = String(entry.target_location_id || '').replace('location-', '');
            // The target world's fabric URL, addressed the way the browser
            // Navigator reaches it (the 057 same-origin proxy:
            // /api/{a|b|lobby}/* -> 1815{1|2|3}/*). Matches the architecture
            // doc section 4.2 example. Direct form would be
            // entry.target_base_url + '/fabric.json'.
            const targetFabricUrl = targetKey ? '/api/' + targetKey + '/fabric.json' : null;
            // (a) portal ATTACHMENT node: Type.bSubtype 255 marks a child-fabric
            // attachment; the engine spawns the referenced fabric at this node.
            // the node also carries the portal's loadable
            // spatial fabric address + two-zone volumes (labeled local-proof
            // additions; existing readers ignore unknown members).
            children.push({
                Head : { Self : 'P-' + nextSelf },
                Name : entry.label || ('Portal to ' + (entry.target_location_id || 'unknown')),
                Type : { bSubtype : 255 },
                Resource : { sReference : targetFabricUrl },
                Transform : { Position : triggerPosition.slice() },
                SpatialFabricAddress : spatialFabricAddressForPortal(entry),
                Zones : portalZones(entry),
                // the same traversal-direction rule the
                // /wow/portal descriptor carries (labeled local-proof member;
                // existing readers ignore unknown members).
                Traversal : portalTraversalRule(entry),
            });
            nextSelf += 1;
            // (b) invisible TRIGGER-volume node: `action:` resource prefix =
            // logic/collider volume the engine never draws (crossing detection).
            children.push({
                Head : { Self : 'P-' + nextSelf },
                Name : index === 0 ? 'Portal Trigger' : 'Portal Trigger (' + entry.portal_id + ')',
                Resource : {
                    sReference : index === 0
                        ? 'action:portal-' + ownKey + '-trigger'
                        : 'action:portal-' + ownKey + '-' + entry.portal_id + '-trigger',
                },
                Transform : { Position : triggerPosition.slice() },
                Bound : { Max : FABRIC_TRIGGER_BOUND_MAX.slice() },
            });
            nextSelf += 1;
        }

        return {
            container : LOCATION_ID,
            // Web of Worlds API surface this fabric points the browser at
            // (architecture doc section 4.2: /wow/world, /wow/user/{id},
            // /wow/portal/{id}, /wow/view/{id}). Endpoints are fabric-relative:
            // the Navigator resolves them against the URL it loaded this
            // manifest from (e.g. /api/a/fabric.json -> /api/a/wow/world).
            // {userId}/{portalId}/{viewId} are integers per the WoW OpenAPI;
            // default_id is this world's live instance of each resource.
            services : [
                { name : 'wow', type : 'web-of-worlds', endpoint : '/wow/world' },
                { name : 'wow-location', type : 'web-of-worlds', endpoint : '/wow/location', default_id : LOCATION_ID },
                { name : 'wow-user', type : 'web-of-worlds', endpoint : '/wow/user/{userId}', default_id : WOW_LOCAL_USER_ID },
                { name : 'wow-portal', type : 'web-of-worlds', endpoint : '/wow/portal/{portalId}', default_id : portal ? 1 : null },
                { name : 'wow-view', type : 'web-of-worlds', endpoint : '/wow/view/{viewId}', default_id : WOW_PLAYER_VIEW_ID },
                // the canonical Spatial Composition Graph
                // (+ node CRUD). default_id is this world's spatialID (world_id).
                { name : 'wow-spatial', type : 'web-of-worlds', endpoint : '/wow/spatial/{spatialID}', default_id : SPATIAL_ID },
                { name : 'wow-spatial-node', type : 'web-of-worlds', endpoint : '/wow/spatial/{spatialID}/node/{nodeId}', default_id : SPATIAL_ID },
            ].concat(AUTHORED_WOW_GRAPH ? [ {
                name : 'wow-authored-graph',
                type : 'web-of-worlds',
                endpoint : '/wow/graph',
                default_id : SPATIAL_ID,
            } ] : []),
            modules : [],
            primary : {
                camera : {
                    position : spawn.position.slice(),
                    rotation : spawn.rotation.slice(),
                },
                background : FABRIC_BACKGROUND_RRGGBB,
            },
            data : {
                Head : { Self : 'R-0' },
                Name : 'Root',
                Children : children,
            },
            // Label required by the claim boundary: plain-JSON UNSIGNED fabric.
            trust : {
                signed : false,
                format : 'plain-json',
                note : 'unsigned local demonstration fabric; JWS signing not implemented (claim boundary)',
            },
            proof_boundary : getWowProofBoundary(),
        };
    }

    // ---- Movement (state ownership proof) ------------------------------------

    function applyMovement(raw)
    {
        const input = raw && typeof raw === 'object' ? raw : {};
        const fwd = readNumber(input.forward, 0);
        const strafe = readNumber(input.strafe, 0);
        const turn = readNumber(input.turn, 0);
        state.avatar.transform.rotation_y += turn * 0.15;
        const yaw = state.avatar.transform.rotation_y;
        const speed = 0.2;
        state.avatar.transform.position[0] += (Math.sin(yaw) * fwd + Math.cos(yaw) * strafe) * speed;
        state.avatar.transform.position[2] += (Math.cos(yaw) * fwd - Math.sin(yaw) * strafe) * speed;
        state.debug.last_input_source = String(input.source || 'movement_input').slice(0, 80);
        bumpRevision();
        notifySubscribers();
        return getState();
    }

    // ---- Portal exit intent (SOURCE side) ------------------------------------

    function recordPortalExitIntent(portalId, playerId)
    {
        const portal = state.portals.find(entry => entry.portal_id === portalId) || state.portals[0];
        if (!portal)
            throw new Error('no portal configured on ' + LOCATION_ID);
        // THE EXIT-INTENT IS THE DEPART.
        //
        // This request is the one the client MUST make to cross — it is what
        // authorizes the traversal and mints the handoff_id. So this is where the
        // player leaves THIS world's presence registry: in the same transaction,
        // committed by the server, not hoped for in a separate best-effort goodbye
        // packet sent ~a second later from the far side of the crossing.
        //
        // That closes the dropped-depart failure mode for the crossing outright:
        //   - exit-intent lost   -> the client fails OPEN and never leaves (no ghost);
        //   - exit-intent lands  -> the player is departed (no ghost).
        // There is no third case, and no window in which the player is registered in
        // two worlds at once. The client's own explicit depart still follows (ordered
        // and awaited) as an idempotent confirmation, and the pagehide beacon / TTL
        // remain the backstops for a crashed tab, which is the ONE ghost path the
        // server genuinely cannot see coming.
        //
        // playerId is absent for observer and `#preview` windows — they register
        // NOBODY and so depart nobody.
        const presenceDeparture = playerId
            ? departPresence({ player_id : playerId, reason : 'portal_exit_intent' })
            : null;
        const now = new Date().toISOString();
        const handoffId = LOCATION_ID + '-' + Date.now() + '-' + Math.floor(Math.random() * 1000000);
        const packet = {
            ok : true,
            handoff_id : handoffId,
            behavior : 'application-level-handoff-around-teleportxr',
            native_teleportxr_teleport : false,
            created_at : now,
            source : {
                location_id : LOCATION_ID,
                world_id : WORLD_ID,
                session_id : SESSION_ID,
                base_url : 'http://127.0.0.1:' + HTTP_PORT,
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
            portal : {
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
            },
            avatar_context : {
                avatar_id : state.avatar.avatar_id,
                continuity_id : state.avatar.continuity_id,
                display_name : state.avatar.display_name,
                transform : {
                    position : state.avatar.transform.position.slice(),
                    rotation_y : state.avatar.transform.rotation_y,
                    orientation : state.avatar.transform.orientation.slice(),
                    scale : state.avatar.transform.scale.slice(),
                },
                source_session_id : SESSION_ID,
                source_world_id : WORLD_ID,
                source_location_id : LOCATION_ID,
                state_revision : state.debug.state_revision,
            },
        };
        // evidence: the departure the server committed as part
        // of authorizing this exit (the ghost-free crossing's load-bearing fact).
        packet.presence_departure = {
            _claim : 'runtime: the origin departs the crossing player from its OWN '
                + 'presence registry in the same transaction that authorizes the exit — the '
                + 'registry never depends on a separate best-effort goodbye packet',
            player_id : playerId || null,
            requested : !!playerId,
            departed : presenceDeparture ? presenceDeparture.departed : false,
            registered_player_count : presenceDeparture
                ? presenceDeparture.registered_player_count
                : presenceRegistry.size,
        };
        state.debug.handoff.last_exit_intent = {
            handoff_id : handoffId,
            target_location_id : portal.target_location_id,
            target_world_id : portal.target_world_id,
            target_base_url : portal.target_base_url,
            exited_at : now,
            presence_departed : packet.presence_departure.departed,
            presence_player_id : playerId || null,
        };
        state.debug.last_input_source = 'portal-exit-intent';
        bumpRevision();
        notifySubscribers();
        console.log('[PortalHandoff][' + LOCATION_ID + '] EXIT_INTENT '
            + JSON.stringify(state.debug.handoff.last_exit_intent));
        return packet;
    }

    // ---- Portal arrival (TARGET side) ----------------------------------------

    function commitArrival(handoff, now)
    {
        const target = handoff.target || {};
        const context = handoff.avatar_context || {};
        const arrivalPosition = Array.isArray(target.arrival_position)
            ? target.arrival_position.slice(0, 3).map(v => readNumber(v, 0))
            : [ 0, 0, 3.6 ];
        state.avatar.avatar_id = String(context.avatar_id || state.avatar.avatar_id).slice(0, 80);
        state.avatar.continuity_id =
            String(context.continuity_id || context.avatar_id || state.avatar.continuity_id).slice(0, 80);
        state.avatar.display_name = String(context.display_name || state.avatar.display_name).slice(0, 80);
        state.avatar.transform.position = arrivalPosition;
        state.avatar.transform.rotation_y = readNumber(target.arrival_rotation_y, Math.PI);
        state.avatar.transform.orientation = [ 0, 0, 0, 1 ];
        state.avatar.handoff_context = {
            handoff_id : String(handoff.handoff_id || 'unknown').slice(0, 120),
            source_location_id : String((handoff.source && handoff.source.location_id) || '').slice(0, 80),
            source_world_id : String((handoff.source && handoff.source.world_id) || '').slice(0, 80),
            source_session_id : String((handoff.source && handoff.source.session_id) || '').slice(0, 80),
            previous_transform : context.transform || null,
            arrived_at : now,
        };
        // *** T-R3 focal line: the arrival_count increment. ***
        state.session.arrival_count += 1;
        state.session.handoff_bootstrap = JSON.parse(JSON.stringify(state.avatar.handoff_context));
        state.debug.handoff.last_handoff_id = state.avatar.handoff_context.handoff_id;
        state.debug.handoff.last_arrival = {
            handoff_id : state.avatar.handoff_context.handoff_id,
            source_location_id : state.avatar.handoff_context.source_location_id,
            source_world_id : state.avatar.handoff_context.source_world_id,
            preserved_avatar_id : state.avatar.avatar_id,
            continuity_id : state.avatar.continuity_id,
            arrived_at : now,
        };
        state.debug.last_input_source = 'portal-arrival';
        bumpRevision();
        notifySubscribers();
        console.log('[PortalHandoff][' + LOCATION_ID + '] ARRIVAL '
            + JSON.stringify(state.debug.handoff.last_arrival));
    }

    function recordPortalArrival(packet)
    {
        const handoff = packet && typeof packet === 'object' ? packet : {};
        const target = handoff.target || {};
        // Guard: arrival must be applied to the CORRECT node. Detects
        // "arrival applied to wrong node" failure mode.
        if (target.world_id && target.world_id !== WORLD_ID)
            throw new Error('handoff target world ' + target.world_id + ' does not match ' + WORLD_ID);
        if (target.location_id && target.location_id !== LOCATION_ID)
            throw new Error('handoff target location ' + target.location_id + ' does not match ' + LOCATION_ID);

        const now = new Date().toISOString();

        if (ARRIVAL_COMMIT_MODE === 'deferred')
        {
            // ---- INJECTED FAULT (opt-in, for T-R3 characterization only) ----
            // Simulates a *hypothetical* buggy variant where the count is
            // committed on a later macrotask. A GET /debug/state that races in
            // before the timer fires would observe the OLD count == lag.
            // This is NOT the POC's real behavior; it exists so the report can
            // demonstrate what a genuine state-lag bug would look like and prove
            // the real path does not exhibit it.
            setTimeout(() => commitArrival(handoff, now), 0);
            return { ok : true, deferred : true, handoff_id : handoff.handoff_id };
        }

        // ---- FAITHFUL POC BEHAVIOR: synchronous commit before return ----
        commitArrival(handoff, now);
        return getState();
    }

    // ---- DEMO EXTENSION: scene objects + UM attach-point ----
    // Reloadable hosted point (see module block comment). ADDITIVE ONLY: nothing
    // here touches the existing world-serving, handoff, or observer-relay paths.

    // Pristine copies for POST /reset (state.portals entries share nested
    // objects with the module-level config, so mutations always REPLACE the
    // nested object — never edit cfg's objects in place).
    const DEMO_DEFAULT_PORTAL_TRIGGERS = (cfg.portals || []).map(p => clone(p.trigger || {}));
    const DEMO_DEFAULT_SCENE_OBJECTS = clone(state.scene_objects);

    function demoClampMeters(value, limit, fallback)
    {
        const n = Number(value);
        if (!Number.isFinite(n)) return fallback;
        return Math.max(-limit, Math.min(limit, n));
    }

    function demoBumpAttachPoint(reason)
    {
        state.attach_point.version += 1;
        state.attach_point.updated_at = new Date().toISOString();
        state.attach_point.last_change = String(reason || 'update');
    }

    function demoPortalPose(portalArg)
    {
        // optional explicit portal so N-portal reads
        // (e.g. /fabric/region anchored on a specific portal) describe THAT
        // portal; default stays portals[0] for every existing caller.
        const portal = portalArg || state.portals[0] || null;
        if (!portal) return null;
        const preset = FABRIC_PORTAL_FRAME_PRESETS[LOCATION_ID] || { forward : [ 0, 0, 1 ] };
        return {
            portal_id : portal.portal_id,
            trigger_position : (portal.trigger && portal.trigger.position || [ 2.8, 0, -2.8 ]).slice(),
            trigger_radius_m : readNumber(portal.trigger && portal.trigger.radius_m, 1.25),
            forward : preset.forward.slice(),
            width_m : FABRIC_PORTAL_FRAME_WIDTH_M,
            height_m : FABRIC_PORTAL_FRAME_HEIGHT_M,
            trigger_depth_m : FABRIC_PORTAL_TRIGGER_DEPTH_M,
            target_location_id : portal.target_location_id || null,
            target_world_id : portal.target_world_id || null,
            // P1: the adopted destination pose declares WHICH
            // shared edge it is the counterpart pose of, so a region-anchored
            // adoption can assert portal identity (additive; readers that predate
            // the field ignore it).
            shared_edge : portalSharedEdge(portal),
        };
    }

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

    // BEGIN — THIS world's loading-content-through-the-portal
    // block, served on GET /demo/portal-view (every resolution rung) and on the
    // attach-point payload, under the agreed `metaverse.portal.*` pointer
    // names + the `metaverse.portal.preloadContent` consent key. A SOURCE world
    // reads this from the DESTINATION server and renders the destination-branded
    // loading experience while the crossing's background steps run (Scene 3b).
    // DEMONSTRATION-ONLY; labeled; standards_conformance stays false.
    function demoPortalLoadingContent()
    {
        const brand = DEMO_PORTAL_LOADING_BRAND[LOCATION_ID] || {};
        const baseHex = DEMO_WORLD_BASE_COLOR[LOCATION_ID] || '#20242e';
        return {
            demo_extension : true,
            standards_conformance : false,
            label : 'runtime DEMO EXTENSION — destination loading-content pointers '
                + '(metaverse.portal.* names from the TeleportVR/UM integration packet; '
                + 'demonstration-only, NOT a published UM/IWPS/WoW spec surface)',
            pointer_host : LOCATION_ID,
            pointer_names : [
                'metaverse.portal.loadingScreen',
                'metaverse.portal.loadingBranding',
                'metaverse.portal.loadingInstructions',
                'metaverse.portal.estimatedLoadTime',
            ],
            consent_key : 'metaverse.portal.preloadContent',
            pointers : {
                'metaverse.portal.loadingScreen' : {
                    href : '/demo/portal-view?resolution=snapshot3d',
                    value : {
                        headline : 'Entering ' + TITLE,
                        background_hex : baseHex,
                        accent_hex : brand.accent_hex || '#9fb0d0',
                    },
                },
                'metaverse.portal.loadingBranding' : {
                    href : '/demo/portal-view',
                    value : {
                        world_title : TITLE,
                        location_id : LOCATION_ID,
                        world_id : WORLD_ID,
                        brand_color_hex : brand.accent_hex || '#9fb0d0',
                        tagline : brand.tagline || '',
                    },
                },
                'metaverse.portal.loadingInstructions' : {
                    href : '/demo/portal-view',
                    value : {
                        instructions : Array.isArray(brand.instructions) ? brand.instructions.slice() : [],
                    },
                },
                'metaverse.portal.estimatedLoadTime' : {
                    href : '/demo/portal-view',
                    value : {
                        estimated_load_ms : Number(brand.estimated_load_ms) || 2500,
                    },
                },
            },
            consent : {
                key : 'metaverse.portal.preloadContent',
                granted : true,
                scope : 'demo',
                note : 'demo consent — the source world MAY preload/render this destination '
                    + 'loading content before the handshake completes',
            },
        };
    }
    // END

    function getSceneObjects()
    {
        return clone(Object.assign({
            ok : true,
            location_id : LOCATION_ID,
            world_id : WORLD_ID,
            version : state.attach_point.version,
            updated_at : state.attach_point.updated_at,
            objects : state.scene_objects,
            portal_pose : demoPortalPose(),
        }, demoExtensionBoundary()));
    }

    function moveSceneObject(objectId, position)
    {
        const obj = state.scene_objects.find(o => o.object_id === String(objectId || ''));
        if (!obj)
            throw new Error('unknown scene object ' + objectId);
        const p = Array.isArray(position) ? position : [];
        obj.position = [
            demoClampMeters(p[0], DEMO_SCENE_OBJECT_LIMIT_M, obj.position[0]),
            obj.position[1], // floor objects keep their resting height
            demoClampMeters(p[2], DEMO_SCENE_OBJECT_LIMIT_M, obj.position[2]),
        ];
        state.debug.last_input_source = 'demo-scene-object-move';
        demoBumpAttachPoint('scene_object_moved:' + obj.object_id);
        bumpRevision();
        notifySubscribers();
        return clone(obj);
    }

    function movePortal(position)
    {
        const portal = state.portals[0];
        if (!portal)
            throw new Error('no portal hosted by this node');
        const prev = (portal.trigger && portal.trigger.position) || [ 2.8, 0, -2.8 ];
        const p = Array.isArray(position) ? position : [];
        // REPLACE the trigger object (cfg shares the nested original).
        portal.trigger = Object.assign({}, portal.trigger, {
            position : [
                demoClampMeters(p[0], DEMO_PORTAL_LIMIT_M, prev[0]),
                0,
                demoClampMeters(p[2], DEMO_PORTAL_LIMIT_M, prev[2]),
            ],
        });
        state.debug.last_input_source = 'demo-portal-move';
        demoBumpAttachPoint('portal_moved:' + portal.portal_id);
        bumpRevision();
        notifySubscribers();
        return clone(portal);
    }

    /** Lowest ladder rung: ONE color — world base tint blended with the hosted
     *  objects' colors, weighted by proximity to the portal (so dragging an
     *  object toward/away from the portal genuinely changes the value). */
    function demoPortalViewColor()
    {
        const pose = demoPortalPose();
        const anchor = pose ? pose.trigger_position : [ 2.8, 0, -2.8 ];
        const parse = hex => {
            const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
            const n = m ? parseInt(m[1], 16) : 0x808080;
            return [ (n >> 16) & 255, (n >> 8) & 255, n & 255 ];
        };
        const base = parse(DEMO_WORLD_BASE_COLOR[LOCATION_ID] || '#20242e');
        let r = base[0] * 2, g = base[1] * 2, b = base[2] * 2, w = 2;
        for (const obj of state.scene_objects)
        {
            const c = parse(obj.color);
            const dx = (obj.position[0] || 0) - anchor[0];
            const dz = (obj.position[2] || 0) - anchor[2];
            const weight = 1 / (1 + Math.hypot(dx, dz));
            r += c[0] * weight; g += c[1] * weight; b += c[2] * weight; w += weight;
        }
        const toHex = v => Math.max(0, Math.min(255, Math.round(v / w))).toString(16).padStart(2, '0');
        return '#' + toHex(r) + toHex(g) + toHex(b);
    }

    /**
     * GET /demo/portal-view?resolution=... — the portal-view VALUE at one rung
     * of the resolution ladder: color (lowest) -> snapshot3d -> splats (highest,
     * STUBBED — deliberately not implemented; labeled).
     */
    function getPortalView(resolution)
    {
        const res = String(resolution || 'snapshot3d');
        const base = Object.assign({
            ok : true,
            location_id : LOCATION_ID,
            world_id : WORLD_ID,
            version : state.attach_point.version,
            updated_at : state.attach_point.updated_at,
            resolution : res,
            resolution_ladder : [ 'color', 'snapshot3d', 'splats' ],
        }, demoExtensionBoundary());
        // every portal-view rung also carries THIS world's
        // loading-content-through-the-portal block (metaverse.portal.* pointers),
        // so a source world reading the destination's portal-view gets the
        // destination-branded loading content. Additive; demonstration-only.
        base.metaverse_portal = demoPortalLoadingContent();
        if (res === 'color')
        {
            return clone(Object.assign(base, {
                status : 'available',
                value : {
                    color_hex : demoPortalViewColor(),
                    derivation : 'world base tint blended with hosted object colors, '
                        + 'weighted 1/(1+planar distance to the portal)',
                },
            }));
        }
        if (res === 'snapshot3d')
        {
            return clone(Object.assign(base, {
                status : 'available',
                value : {
                    kind : '3d_snapshot',
                    room : { size_m : [ 12, 12 ], base_color : DEMO_WORLD_BASE_COLOR[LOCATION_ID] || '#20242e' },
                    portal : demoPortalPose(),
                    objects : state.scene_objects,
                    avatar_position : state.avatar.transform.position.slice(),
                },
            }));
        }
        if (res === 'splats')
        {
            return clone(Object.assign(base, {
                status : 'stub_not_implemented',
                label : 'SPLATS RUNG — STUBBED. Highest resolution (gaussian splats) is '
                    + 'deliberately NOT implemented in this demo; shown only as the ladder\'s top rung.',
                value : null,
            }));
        }
        return null;
    }

    /**
     * GET /demo/um/attach-point — THE reloadable hosted point. The value seen
     * through a portal INTO this world. Clients re-read (reload) this resource;
     * the server never streams it (reload-not-streaming is the model the user
     * specified; this JSON says so on itself).
     */
    function getUmAttachPoint()
    {
        return clone(Object.assign({
            ok : true,
            attach_point_id : 'um-attach-point-' + LOCATION_ID,
            model : 'reloadable_hosted_point',
            model_note : 'Demo interpretation of the documented UM attach-point fallback: '
                + 'the Universal Manifest ATTACHES to this server-hosted point and clients '
                + 'RE-READ (reload) it on demand; the UM/server does NOT stream it. Each GET '
                + 'is a fresh reload of current server truth. Project-local model — not '
                + 'defined by any published UM/IWPS/WoW spec.',
            location_id : LOCATION_ID,
            world_id : WORLD_ID,
            version : state.attach_point.version,
            updated_at : state.attach_point.updated_at,
            last_change : state.attach_point.last_change,
            portal_pose : demoPortalPose(),
            // the attach-point reload also carries the
            // loading-content pointers, so the client reload cache is
            // already warm with the destination's branding at crossing time.
            metaverse_portal : demoPortalLoadingContent(),
            resolutions : {
                color : { status : 'available', href : '/demo/portal-view?resolution=color' },
                snapshot3d : { status : 'available', href : '/demo/portal-view?resolution=snapshot3d' },
                splats : {
                    status : 'stub_not_implemented',
                    href : '/demo/portal-view?resolution=splats',
                    label : 'highest rung — stubbed, not working yet (labeled)',
                },
            },
            value : getPortalView('snapshot3d').value,
            proof_boundary : getWowProofBoundary(),
        }, demoExtensionBoundary()));
    }

    // ---- Reset / replay ------------------------------------------------------

    function reset()
    {
        // snapshot the authoritative occupants before
        // clearing them. Reset is the same truthful departure boundary as TTL
        // expiry/depart for event-stream observers; otherwise an already-open
        // observer can retain a keyed player projection after server truth is
        // empty until some later expiry happens to clean it up.
        const resetPresenceEntries = Array.from(presenceRegistry.values());
        // restore the hosted demo scene to its defaults too
        // (objects + portal trigger), bumping the attach-point so reloading
        // clients pick the restore up like any other change.
        state.scene_objects = clone(DEMO_DEFAULT_SCENE_OBJECTS);
        state.portals.forEach((portal, i) => {
            if (DEMO_DEFAULT_PORTAL_TRIGGERS[i])
                portal.trigger = clone(DEMO_DEFAULT_PORTAL_TRIGGERS[i]);
        });
        demoBumpAttachPoint('reset');
        // rebuild the Spatial Composition Graph from the
        // just-restored scene data so /wow/spatial returns to its seed too.
        spatialStore.resetToSeed();
        // reset restores the application default and
        // replaces the prior ambient-drift timer with exactly one 100 ms timer.
        // startRepublishTimer is a hoisted declaration below and clears any
        // existing timer before starting the replacement.
        state.republish_rate_ms = DEMO_REPUBLISH_RATE_DEFAULT_MS;
        startRepublishTimer();
        state.session.arrival_count = 0;
        state.session.handoff_bootstrap = null;
        // a reset/replay starts from an empty location —
        // clear the player presence registry and stop its expiry sweeper.
        presenceRegistry.clear();
        // A fresh demo slate also resets departure bookkeeping. Tombstones are
        // correct during a live depart/heartbeat race, but they are residue
        // after an explicit whole-location reset and make the receipt nonzero.
        presenceTombstones.clear();
        presenceResurrectionsBlocked = 0;
        stopPresenceSweeper();
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
        bumpRevision();
        notifySubscribers();
        for (const entry of resetPresenceEntries)
            emitWowEvent(wowUserEvent('user_left', entry));
        return getDebugState();
    }

    function tick()
    {
        state.server_tick += 1;
    }

    // ---- DEMO EXTENSION: optional server republish timer ----
    //
    // An OPTIONAL server-side timer that applies a SMALL, BOUNDED ambient drift
    // to the hosted scene objects at a configurable cadence and bumps the
    // attach-point version, so the through-portal view (which reloading clients
    // RE-READ) visibly updates WITHOUT a user drag — proving the reloadable-
    // hosted-point model end-to-end: server mutates hosted state -> client
    // re-reads -> portal view changes.
    //
    // HONEST MODEL: this is a periodic server-side STATE MUTATION that the client
    // PULLS on its own reload cadence. It is NOT a push/stream to the client —
    // no socket write to demo clients, no server-initiated delivery of the
    // portal-view value. reloadable-not-streaming stays true.
    //
    // APPLICATION DEFAULT ON: boot and reset use 100 ms. An explicit operator
    // value of 0 still disables the timer and preserves the pre- behavior
    // (no ambient change; the attach-point only bumps on drags/reset). Labeled
    // demo extension; standards_conformance stays false.
    const DEMO_REPUBLISH_RATE_DEFAULT_MS = 100;
    const DEMO_REPUBLISH_RATE_MIN_MS = 100;   // fastest allowed cadence when > 0
    const DEMO_REPUBLISH_RATE_MAX_MS = 60000; // slowest allowed cadence
    const DEMO_REPUBLISH_DRIFT_AMPLITUDE_M = 0.35; // small bounded wander radius
    state.republish_rate_ms = DEMO_REPUBLISH_RATE_DEFAULT_MS;
    let republishTimer = null;
    let republishTickCount = 0;
    // Home positions the drift oscillates AROUND (captured from the objects'
    // current resting positions) plus a stable per-object phase/axis, so the
    // drift is a bounded sinusoid that never accumulates or walks an object out
    // of the room and is fully reversible when the timer stops.
    const republishDriftSeeds = state.scene_objects.map((o, i) => ({
        object_id : o.object_id,
        home : (o.position || [ 0, 0, 0 ]).slice(),
        phase : (i * 1.7) % (Math.PI * 2),
        // gentle elliptical wander, per-object so they don't move in lockstep
        ampX : DEMO_REPUBLISH_DRIFT_AMPLITUDE_M * (0.6 + 0.4 * ((i * 0.37) % 1)),
        ampZ : DEMO_REPUBLISH_DRIFT_AMPLITUDE_M * (0.6 + 0.4 * ((i * 0.53) % 1)),
        rate : 0.6 + 0.5 * ((i * 0.29) % 1), // radians of phase advance per tick
    }));

    function republishApplyAmbientDrift()
    {
        // Re-seed homes from the CURRENT default scene objects each tick's basis
        // is the captured home; a manual drag replaces the live object position,
        // and the next drift tick oscillates around the (unchanged) home so drag
        // and ambient drift compose rather than fight destructively.
        republishTickCount += 1;
        for (const seed of republishDriftSeeds)
        {
            const obj = state.scene_objects.find(o => o.object_id === seed.object_id);
            if (!obj) continue;
            const t = seed.phase + republishTickCount * seed.rate;
            const nx = seed.home[0] + Math.cos(t) * seed.ampX;
            const nz = seed.home[2] + Math.sin(t) * seed.ampZ;
            obj.position = [
                demoClampMeters(nx, DEMO_SCENE_OBJECT_LIMIT_M, obj.position[0]),
                obj.position[1], // keep resting height
                demoClampMeters(nz, DEMO_SCENE_OBJECT_LIMIT_M, obj.position[2]),
            ];
        }
        state.debug.last_input_source = 'demo-republish-ambient-drift';
        demoBumpAttachPoint('republish_ambient_drift:tick_' + republishTickCount);
        bumpRevision();
        notifySubscribers();
    }

    function stopRepublishTimer()
    {
        if (republishTimer)
        {
            clearInterval(republishTimer);
            republishTimer = null;
        }
    }

    function startRepublishTimer()
    {
        stopRepublishTimer();
        const rate = state.republish_rate_ms;
        if (!(rate > 0)) return; // 0/off -> no timer
        republishTimer = setInterval(republishApplyAmbientDrift, rate);
        // Do not keep the Node event loop alive purely for the demo timer (so a
        // process/test that only awaited the servers can still exit cleanly).
        if (republishTimer && typeof republishTimer.unref === 'function') republishTimer.unref();
    }

    /**
     * GET/POST /demo/republish-rate value. Sets the server republish cadence in
     * ms; 0 explicitly disables it. Boot/reset default to 100 ms. A positive value is clamped to
     * [DEMO_REPUBLISH_RATE_MIN_MS, DEMO_REPUBLISH_RATE_MAX_MS]. Returns the
     * applied cadence + whether the ambient-drift timer is now running.
     */
    function setRepublishRate(rateMs)
    {
        const raw = Number(rateMs);
        let applied = 0;
        if (Number.isFinite(raw) && raw > 0)
        {
            applied = Math.max(DEMO_REPUBLISH_RATE_MIN_MS, Math.min(DEMO_REPUBLISH_RATE_MAX_MS, Math.round(raw)));
        }
        state.republish_rate_ms = applied;
        startRepublishTimer();
        return getRepublishRate();
    }

    function getRepublishRate()
    {
        return clone(Object.assign({
            ok : true,
            location_id : LOCATION_ID,
            world_id : WORLD_ID,
            republish_rate_ms : state.republish_rate_ms,
            enabled : state.republish_rate_ms > 0,
            running : republishTimer != null,
            republish_tick_count : republishTickCount,
            bounds_ms : { min : DEMO_REPUBLISH_RATE_MIN_MS, max : DEMO_REPUBLISH_RATE_MAX_MS },
            model : 'server_side_periodic_state_mutation',
            model_note : 'When > 0, the server applies a small bounded ambient drift to the '
                + 'hosted scene objects at this cadence and bumps the attach-point version. '
                + 'Clients PULL (re-read) the hosted point on their own reload cadence; the '
                + 'server does NOT push/stream this to clients. Boot/reset default to 100 ms; '
                + 'an explicit 0 disables ambient change and restores pre-runtime behavior.',
            drift_amplitude_m : DEMO_REPUBLISH_DRIFT_AMPLITUDE_M,
            reloadable_not_streaming : true,
        }, demoExtensionBoundary()));
    }

    startRepublishTimer();

    return {
        LOCATION_ID, WORLD_ID, SESSION_ID, HTTP_PORT, NODE_ROLE,
        getState, getDebugState, subscribe, subscriberCount,
        // granular WS /events realtime stream +
        // the initial hello snapshot for a newly-connected /events client.
        subscribeEvents, eventSubscriberCount, getWowEventsHello,
        getWowWorld, getWowLocation, getWowGraph,
        getWowPortal, getWowPortalResource, getWowUser, getWowView,
        // the signed OpenUserManifest identity (async).
        getWowUserSigned,
        // DELETE /wow/user/{userId}.
        deleteWowUser,
        getWowProofBoundary,
        // the documented local-tangent geoPose projection,
        // exposed so the OpenSpatialAsset surface can carry a REAL asset geoPose
        // (built from the hosted primitive's live position) without duplicating
        // WOW_GEOPOSE_MAPPING. Not georeferenced; see getWowProofBoundary().
        wowGeoPoseFromLocal,
        // canonical Spatial Composition Graph (+ node CRUD)
        getSpatialGraphRoot, getSpatialNode,
        // the canonical Spatial descriptor (opt-in).
        getSpatialDescriptor,
        createSpatialNodes, updateSpatialNode, deleteSpatialNode,
        SPATIAL_ID,
        getFabricManifest, getFabricSpawnPose,
        applyMovement, recordPortalExitIntent, recordPortalArrival,
        // demo extension (labeled; additive only)
        getSceneObjects, moveSceneObject, movePortal, getPortalView, getUmAttachPoint,
        // addressable spatial fabric portal prefetch (read-only)
        getFabricRegion, getFabricPresence,
        getFabricRegionChunk, getFabricRegionTilesetHypothesis,
        // per-location player presence registry (explicit
        // register/heartbeat/depart session actions + TTL expiry)
        registerPresence, heartbeatPresence, departPresence, stopPresenceSweeper,
        // demo extension: optional server republish timer
        setRepublishRate, getRepublishRate, stopRepublishTimer,
        reset, tick,
        // exposed for tests
        _raw : state,
    };
}

module.exports = { createRuntime };
