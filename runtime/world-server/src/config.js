'use strict';

/*
 * Lane 3 fixed-fixture node configuration.
 *
 * FIXED IDs / PORTS (per PRD Section 14 Lane 3; do not drift):
 *   location-a     : 18151  world demo-room-a  session local-session-a
 *   location-b     : 18152  world demo-room-b  session local-session-b
 *   location-lobby : 18153  world demo-lobby   session local-session-lobby
 *   location-airport: 18154 world world-airport-terminal
 *     session local-session-airport
 *
 * Portal geometry / arrival transforms traced to:
 *   (portal shape ~lines 340-376; exit/arrival packet ~lines 502-562)
 */

const AIRPORT_WORLD_GRAPH = require('../../../web/worlds/denver-skyport.json');

const NODES = {
    // the pre-location
    // LOBBY. A player who has not been assigned a server starts here — a
    // real first-class location, not an error state. The lobby is the first
    // N>1-portal node: each portal is a full ADDRESSABLE portal (same
    // spatial_fabric_address + zones + traversal contract as the A<->B
    // portals). Geometry: both portals face +z; the lobby spawn (portal
    // ground-center centroid + clearance) sits ~3.77 m from each portal
    // center. widened the outer data-loading circle from
    // the 2.5 m proof value to the UNIFORM 3.0 m every world takes. The lobby
    // could geometrically stretch to ~3.4 m, but the 1.15x exit hysteresis of
    // anything wider than ~3.2 m swallows the proven lobby
    // walk-away waypoints (~3.69 m from a portal) — machines would never
    // cool on the proven routes. 3.0 m keeps: spawn (3.77 m) outside both
    // zones, the spawn->portal-A corridor (closest approach to portal B
    // ≈ 3.82 m) clean, the deliberate centerline overlap band, AND the
    // walk-away cooling beat (exit at 3.45 m). The destination-side loading
    // circle stays the WIDER roi_radius_m (5.0 m) — see the location-a note.
    lobby : {
        location_id : 'location-lobby',
        world_id : 'demo-lobby',
        session_id : 'local-session-lobby',
        http_port : 18153,
        node_role : 'lobby',
        title : 'Lobby - Pre-Location Gathering',
        portals : [ {
            portal_id : 'lobby-portal-a',
            label : 'Portal to Location A',
            source_location_id : 'location-lobby',
            source_world_id : 'demo-lobby',
            target_location_id : 'location-a',
            target_world_id : 'demo-room-a',
            target_base_url : 'http://127.0.0.1:18151',
            // P1 (shared-edge portal identity): this edge's
            // counterpart is location-a's HOSTED lobby-return portal — no longer
            // 'location-a-portal' (the A<->B portal!). Pre-P1, prefetch/region/
            // aperture/exit all anchored on the WRONG portal in A (4.8 m off),
            // which is the root of the "walk lobby->A, turn around, the
            // portal now goes to B" report.
            target_portal_id : 'location-a-portal-lobby',
            trigger : { position : [ -2.0, 0, -2.8 ], radius_m : 1.25 },
            arrival : { position : [ 0, 0, 3.6 ], rotation_y : Math.PI },
            // outer loading circle widened 2.5 -> 3.0 m
            // (uniform widened radius — see the node comment above); the
            // destination-side circle stays the wider roi_radius_m.
            spatial_fabric : { prefetch_radius_m : 3.0, roi_radius_m : 5.0 },
            traversal : { mode : 'bidirectional' },
        }, {
            portal_id : 'lobby-portal-b',
            label : 'Portal to Location B',
            source_location_id : 'location-lobby',
            source_world_id : 'demo-lobby',
            target_location_id : 'location-b',
            target_world_id : 'demo-room-b',
            target_base_url : 'http://127.0.0.1:18152',
            // P1: counterpart = location-b's hosted
            // lobby-return portal (see the lobby-portal-a note above).
            target_portal_id : 'location-b-portal-lobby',
            trigger : { position : [ 2.0, 0, -2.8 ], radius_m : 1.25 },
            arrival : { position : [ 0, 0, 3.6 ], rotation_y : Math.PI },
            // same uniform 3.0 m widening as lobby-portal-a.
            spatial_fabric : { prefetch_radius_m : 3.0, roi_radius_m : 5.0 },
            traversal : { mode : 'bidirectional' },
        }, {
            portal_id : 'lobby-portal-c',
            label : 'Portal to Denver Skyport',
            source_location_id : 'location-lobby',
            source_world_id : 'demo-lobby',
            // Portal C now uses the same real backend
            // destination contract as A/B. The airport's authored graph remains
            // backend-hosted data at /wow/graph; no fixture/client-scene fallback
            // participates in prefetch, crossing, arrival, presence, or return.
            target_location_id : 'location-airport',
            target_world_id : 'world-airport-terminal',
            target_base_url : 'http://127.0.0.1:18154',
            target_portal_id : 'airport-portal-lobby',
            trigger : { position : [ 0, 0, -4.4 ], radius_m : 1.25 },
            arrival : { position : [ 0, 0, -3.0 ], rotation_y : 0 },
            // The backend-authored 24 x 88 m concourse needs a wider local
            // aperture than the 5 m demo rooms. 24 m includes the nearest
            // traveler and storefront while remaining a partial concourse read.
            spatial_fabric : { prefetch_radius_m : 3.0, roi_radius_m : 24.0 },
            traversal : { mode : 'bidirectional' },
            // Cross-world pairing is separate from face-entry directionality:
            // this edge requests automatic pairing; the airport backend's one
            // explicit inverse wins deduplication and remains the sole ring.
            reciprocal : { mode : 'automatic' },
        } ],
    },
    a : {
        location_id : 'location-a',
        world_id : 'demo-room-a',
        session_id : 'local-session-a',
        http_port : 18151,
        node_role : 'source',
        title : 'Location A - Origin Gallery',
        portals : [ {
            portal_id : 'location-a-portal',
            label : 'Portal to Location B',
            source_location_id : 'location-a',
            source_world_id : 'demo-room-a',
            target_location_id : 'location-b',
            target_world_id : 'demo-room-b',
            target_base_url : 'http://127.0.0.1:18152',
            target_portal_id : 'location-b-portal',
            trigger : { position : [ 2.8, 0, -2.8 ], radius_m : 1.25 },
            arrival : { position : [ 0, 0, 3.6 ], rotation_y : Math.PI },
            // addressable spatial fabric portal prefetch.
            // prefetch_radius_m = the LARGER outer data-loading circle around
            // the portal; roi_radius_m = the DESTINATION-side loading circle
            // requested around the destination anchor portal (5.0 m provably
            // excludes >=1 of the 3 demo objects in each world, keeping the
            // partial-loading proof intact).
            // widened the outer circle 2.5 -> 3.0 m — the
            // geometric MAXIMUM under the spawn contract: the player spawns
            // exactly 3.2 m from the portal center (ground_center + forward *
            // (trigger_depth 0.8 + clearance 2.4)), and the spawn must start
            // OUTSIDE the loading circle so the approach has a real
            // idle -> loading -> warm beat. The destination-side circle stays
            // the WIDER 5.0 m and now loads avatars too; the source/destination
            // width mismatch is recorded on the descriptor
            // (matching_destination_circle.clamp_reason). Widening the source
            // circle to the full 5.0 m requires moving the spawn contract —
            // a separate decision, out of scope here.
            spatial_fabric : { prefetch_radius_m : 3.0, roi_radius_m : 5.0 },
            // the traversal-direction value —
            // bidirectional portals commit from either side of the frame
            // plane; { mode : 'one_way', allowed_entry_side : 'front'|'back' }
            // commits only from that side (the other side renders opaque and
            // suppresses prefetch). Sides are named against the portal frame's
            // `forward` vector. Demo default: bidirectional.
            traversal : { mode : 'bidirectional' },
        }, {
            // P1 — the LOBBY<->A shared edge's A-side half.
            // Location A never hosted a return portal to the lobby: a player who
            // crossed lobby->A and turned around saw only 'location-a-portal',
            // whose destination is location-b. This portal
            // is the SAME connection as 'lobby-portal-a', hosted on THIS side, so
            // the edge exists in BOTH endpoint worlds (edge_id
            // 'edge--location-a--location-lobby'; see validateSharedEdgeTopology).
            //
            // Geometry: all location-a portals share the +z frame preset. The
            // trigger sits on the -z wall, mirrored across the room from the A<->B
            // portal ([2.8,0,-2.8] -> [-2.8,0,-2.8]), which keeps (a) the proven
            // A->B approach corridor (x≈2.8, z 0.4→-2.8) untouched, (b) the
            // lobby->A exit lane (x≈-2.8, +z off this portal) disjoint from it,
            // and (c) the portal-centroid spawn ([0,0,0.4]) outside BOTH 3.0 m
            // loading circles (distance 4.25 m to each trigger).
            portal_id : 'location-a-portal-lobby',
            label : 'Portal to Lobby',
            source_location_id : 'location-a',
            source_world_id : 'demo-room-a',
            target_location_id : 'location-lobby',
            target_world_id : 'demo-lobby',
            target_base_url : 'http://127.0.0.1:18153',
            target_portal_id : 'lobby-portal-a',
            trigger : { position : [ -2.8, 0, -2.8 ], radius_m : 1.25 },
            // Arrival = the landing pose in the TARGET world (the packet-fallback
            // semantic every descriptor uses): 1.05 m (trigger_depth 0.8 + 0.25
            // clearance) in FRONT of lobby-portal-a ([-2.0,0,-2.8], frame +z),
            // facing INTO the lobby — the return lands at the portal you entered,
            // never at a per-world spot beside some other portal.
            arrival : { position : [ -2.0, 0, -1.75 ], rotation_y : 0 },
            spatial_fabric : { prefetch_radius_m : 3.0, roi_radius_m : 5.0 },
            traversal : { mode : 'bidirectional' },
        } ],
    },
    b : {
        location_id : 'location-b',
        world_id : 'demo-room-b',
        session_id : 'local-session-b',
        http_port : 18152,
        node_role : 'target',
        title : 'Location B - Arrival Hall',
        portals : [ {
            portal_id : 'location-b-portal',
            label : 'Portal to Location A',
            source_location_id : 'location-b',
            source_world_id : 'demo-room-b',
            target_location_id : 'location-a',
            target_world_id : 'demo-room-a',
            target_base_url : 'http://127.0.0.1:18151',
            target_portal_id : 'location-a-portal',
            trigger : { position : [ 2.8, 0, -2.8 ], radius_m : 1.25 },
            arrival : { position : [ 0, 0, 3.6 ], rotation_y : Math.PI },
            // see location-a note —
            // same two-zone knobs, same 3.0 m spawn-contract-clamped widening,
            // same 5.0 m destination-side circle.
            spatial_fabric : { prefetch_radius_m : 3.0, roi_radius_m : 5.0 },
            // see location-a note — demo default stays
            // bidirectional; targeted scenes override via
            // OSL_PORTAL_TRAVERSAL_OVERRIDES.
            traversal : { mode : 'bidirectional' },
        }, {
            // P1 — the LOBBY<->B shared edge's B-side half
            // (same rationale as location-a-portal-lobby). All location-b portals
            // share the -x frame preset. The trigger mirrors the B<->A portal
            // across the room ([2.8,0,-2.8] -> [2.8,0,2.8]), keeping the proven
            // A->B arrival exit lane (-x at z≈-2.8) untouched, giving this portal
            // its own -x exit lane at z≈2.8, and keeping the portal-centroid
            // spawn ([-0.4,0,0]) outside BOTH 3.0 m loading circles (4.25 m).
            portal_id : 'location-b-portal-lobby',
            label : 'Portal to Lobby',
            source_location_id : 'location-b',
            source_world_id : 'demo-room-b',
            target_location_id : 'location-lobby',
            target_world_id : 'demo-lobby',
            target_base_url : 'http://127.0.0.1:18153',
            target_portal_id : 'lobby-portal-b',
            trigger : { position : [ 2.8, 0, 2.8 ], radius_m : 1.25 },
            // Landing pose in the lobby: 1.05 m in front of lobby-portal-b
            // ([2.0,0,-2.8], frame +z), facing into the lobby (see the A-side
            // arrival note).
            arrival : { position : [ 2.0, 0, -1.75 ], rotation_y : 0 },
            spatial_fabric : { prefetch_radius_m : 3.0, roi_radius_m : 5.0 },
            traversal : { mode : 'bidirectional' },
        } ],
    },
    // the authored Denver Skyport graph becomes a real
    // fourth backend node. The graph remains checked-in data and is passed
    // through the generic runtime; route handlers contain no airport branch.
    // Portal C is cut over separately in the lobby config above; this node stays
    // a generic authored-data backend with no airport-specific route branch.
    airport : {
        location_id : 'location-airport',
        world_id : 'world-airport-terminal',
        session_id : 'local-session-airport',
        http_port : Number(process.env.OSL_BACKEND_AIRPORT_PORT) || 18154,
        node_role : 'airport',
        title : 'Denver Skyport - Concourse A',
        authored_wow_graph : AIRPORT_WORLD_GRAPH,
        entry_spawn : { position : [ 0, 0, -3 ], rotation_y : 0 },
        portals : [ {
            portal_id : 'airport-portal-lobby',
            label : 'Return portal to Lobby',
            source_location_id : 'location-airport',
            source_world_id : 'world-airport-terminal',
            target_location_id : 'location-lobby',
            target_world_id : 'demo-lobby',
            target_base_url : 'http://127.0.0.1:18153',
            target_portal_id : 'lobby-portal-c',
            trigger : { position : [ 0, 0, -4.4 ], radius_m : 1.25 },
            arrival : { position : [ 0, 0, 0.4 ], rotation_y : 0 },
            spatial_fabric : { prefetch_radius_m : 3.0, roi_radius_m : 5.0 },
            traversal : { mode : 'bidirectional' },
        } ],
    },
};

/*
 * per-portal traversal-direction fixture override.
 * OSL_PORTAL_TRAVERSAL_OVERRIDES is a JSON object keyed by portal_id, e.g.
 *   { "location-b-portal": { "mode": "one_way", "allowed_entry_side": "front" } }
 * so a targeted e2e scene can boot a one-way portal without editing the
 * checked-in demo defaults. Malformed JSON / unknown ids are ignored.
 */
function traversalOverrideFor(portalId)
{
    const raw = process.env.OSL_PORTAL_TRAVERSAL_OVERRIDES;
    if (!raw)
        return null;
    try {
        const parsed = JSON.parse(raw);
        const hit = parsed && typeof parsed === 'object' ? parsed[portalId] : null;
        return hit && typeof hit === 'object' ? hit : null;
    } catch (e) {
        return null;
    }
}

/*
 * P1 — SHARED-EDGE PORTAL IDENTITY.
 *
 * A portal is ONE stable connection between two places, not a per-world,
 * per-direction descriptor. The identity is the EDGE: a deterministic id over
 * the two endpoint locations, carried by the descriptor hosted in BOTH worlds,
 * with each side's target_portal_id naming the other side. This retires the
 * context-dependent hack the user reported ("walk through the left lobby
 * portal -> A, turn around and that portal is now a portal to B"): A and B now
 * HOST their halves of the lobby edges, and the lobby's portals target those
 * real counterparts instead of the A<->B pair.
 *
 * validateSharedEdgeTopology() runs at module load over NODES, so a config
 * with a one-sided or mispointed edge cannot even boot. Labeled local-proof
 * semantics — no published portal standard defines shared-edge identity;
 * standards_conformance stays false on every descriptor surface.
 */
function portalEdgeId(portal)
{
    if (!portal || !portal.source_location_id || !portal.target_location_id)
        return null;
    const endpoints = [ String(portal.source_location_id), String(portal.target_location_id) ].sort();
    return 'edge--' + endpoints.join('--');
}

function validateSharedEdgeTopology(nodes)
{
    const byLocation = new Map();
    for (const node of Object.values(nodes || {}))
        byLocation.set(node.location_id, node);
    const problems = [];
    const edges = new Map(); // edge_id -> [ 'location/portal_id', ... ]
    for (const node of Object.values(nodes || {}))
    {
        for (const portal of node.portals || [])
        {
            // Fixture-backed destinations host no backend counterpart by design
            //they are exempt from edge pairing.
            if (portal.target_fixture) continue;
            const edgeId = portalEdgeId(portal);
            if (!edgeId || !portal.target_portal_id)
            {
                problems.push(node.location_id + '/' + portal.portal_id
                    + ': backend portal lacks target_location_id/target_portal_id');
                continue;
            }
            const targetNode = byLocation.get(portal.target_location_id);
            if (!targetNode)
            {
                problems.push(node.location_id + '/' + portal.portal_id
                    + ': target location ' + portal.target_location_id + ' is not a configured node');
                continue;
            }
            const counterpart = (targetNode.portals || [])
                .find(p => p.portal_id === portal.target_portal_id);
            if (!counterpart)
            {
                problems.push(node.location_id + '/' + portal.portal_id
                    + ': counterpart ' + portal.target_portal_id
                    + ' is NOT hosted by ' + portal.target_location_id
                    + ' — a shared edge must exist in BOTH endpoint worlds');
                continue;
            }
            if (counterpart.target_location_id !== node.location_id
                || counterpart.target_portal_id !== portal.portal_id)
            {
                problems.push(node.location_id + '/' + portal.portal_id
                    + ' <-> ' + targetNode.location_id + '/' + counterpart.portal_id
                    + ': counterpart does not point back (got target_location_id='
                    + counterpart.target_location_id + ' target_portal_id='
                    + counterpart.target_portal_id
                    + ') — one portal must be ONE mutual connection');
                continue;
            }
            const sides = edges.get(edgeId) || [];
            sides.push(node.location_id + '/' + portal.portal_id);
            edges.set(edgeId, sides);
        }
    }
    for (const [ edgeId, sides ] of edges)
    {
        if (sides.length !== 2)
            problems.push(edgeId + ': hosted on ' + sides.length + ' side(s) ['
                + sides.join(', ') + '] — a shared edge is hosted by exactly its two endpoint worlds');
    }
    if (problems.length)
        throw new Error('shared-edge portal topology invalid (runtime P1):\n  - '
            + problems.join('\n  - '));
    return {
        edge_count : edges.size,
        edges : Object.fromEntries(
            Array.from(edges.entries()).map(([ id, sides ]) => [ id, sides.slice().sort() ])),
    };
}

// Config-integrity gate: the checked-in NODES table must always form a valid
// shared-edge topology. Runs once at require time; throws before any server
// can boot on a broken topology.
const SHARED_EDGE_TOPOLOGY = validateSharedEdgeTopology(NODES);

function makeConfig(role, extraOpts)
{
    const key = String(role).toLowerCase().replace('location-', '');
    const base = NODES[key];
    if (!base)
        throw new Error('unknown node role "' + role + '" (expected a|b|lobby|airport|location-a|location-b|location-lobby|location-airport)');
    const cfg = Object.assign({}, base, extraOpts || {});
    cfg.portals = (cfg.portals || []).map(portal => {
        const override = traversalOverrideFor(portal.portal_id);
        return override ? Object.assign({}, portal, { traversal : override }) : portal;
    });
    return cfg;
}

module.exports = {
    NODES, makeConfig,
    portalEdgeId, validateSharedEdgeTopology, SHARED_EDGE_TOPOLOGY,
};
