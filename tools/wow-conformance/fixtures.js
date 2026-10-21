'use strict';

/*
 * tools/wow-conformance/fixtures.js — (Lane F).
 *
 * Contract-first typed mocks so the WoW conformance harness runs BEFORE the
 * live server (or a given endpoint) exists (PROP §3, contract-first). Each
 * fixture is shaped to VALIDATE against its wow-spec schema — the harness
 * asserts that in its fixture pass, which proves the contract + harness are
 * coherent independent of the running 041 backend.
 *
 * These are NOT vendored from simpleWorlds (UNLICENSED) — they are minimal
 * shapes authored against the OSL wow-spec contract surface.
 *
 * geoPose fixtures spell longitude `lon`, as the OSL contract does (the iteration 1
 * overlay, a proposed upstream edit; the World API at d39a1a0 spells it `lan`, declared
 * as D9). The drift guard (conformance.js) flags a payload that carries the
 * deprecated `lan` instead.
 */

function identity16()
{
    return [ 1, 0, 0, 0,  0, 1, 0, 0,  0, 0, 1, 0,  0, 0, 0, 1 ];
}

function geoPose()
{
    return {
        position: { lat: 40.0, lon: -73.0, h: 1.6 },
        angles: { yaw: 0, pitch: 0, roll: 0 },
    };
}

// The four claim-boundary flags REQUIRED (ProofBoundary, additionalProperties:false).
// standards_conformance is honestly `false` — no cosmetic green.
function proofBoundary()
{
    return {
        application_level_handoff: true,
        native_teleportxr_teleport: false,
        first_party_teleportxr_browser_rendering: false,
        standards_conformance: false,
    };
}

// ---- OSL response composites (canonical + labeled extensions) ----

function worldResponse()
{
    return {
        content: { label: 'Fixture World', age_restriction: 0, license: 'CC0',
            cost: 'free', version: 1, duration: 0 },
        geoPose: geoPose(),
        presence: { avatar: 'humanoid', navigation: 'walk', gravity: 'on' },
        technology: { 'webXR-immersive': 'optional', runtime: 'osl-local' },
        users: { active_user_count: 1, total_user_count: 1 },
        views: { view_count: 1 },
        portals: { portal_count: 1 },
        // labeled OSL extensions:
        proof_boundary: proofBoundary(),
        webofworlds_extension: {
            schema: 'osl.webofworlds.v0',
            spatial_fabric_address: { profile: 'osl.spatial-fabric-address', value: 'fixture://world' },
        },
        id: 'fixture-world',
    };
}

function userResponse()
{
    return {
        id: 1,
        name: 'Fixture User',
        AvatarURI: 'asset://avatar.vrm',
        geoPose: geoPose(),
        proof_boundary: proofBoundary(),
        webofworlds_extension: { schema: 'osl.webofworlds.v0' },
    };
}

function viewResponse()
{
    return {
        id: 1,
        geoPose: geoPose(),
        proof_boundary: proofBoundary(),
        webofworlds_extension: { schema: 'osl.webofworlds.v0' },
    };
}

function portalResponse()
{
    return {
        id: 1,
        geoPose: geoPose(),
        label: 'Fixture Portal',
        proof_boundary: proofBoundary(),
        webofworlds_extension: {
            schema: 'osl.webofworlds.v0',
            target_world_id: 'world-b',
            spatial_fabric_address: { profile: 'osl.spatial-fabric-address', value: 'fixture://world-b' },
        },
        // lands portal destination on this labeled extension point:
        destination: {
            target_world_id: 'world-b',
            target_base_url: 'http://127.0.0.1:18152',
            spatial_fabric_address: 'fixture://world-b',
        },
    };
}

// ---- Spatial composition graph ----
//
// Two node shapes live here, and the difference between them is the point:
//
//   canonicalNode()  = the STANDARD (`Node`): children are EMBEDDED Node objects
//                      (WoWAPI@d39a1a0, API.yaml:484-487). Since iteration 1 this is what OSL
//                      serves and accepts by default.
//   graphRootNode()  = OSL's labeled flat form (`OSLFlatNode`): children are INTEGER id
//                      references. OSL serves it only on explicit request (`?nodeForm=flat`).
//
// The canonical shape used to be filed under badNodes() as `childrenAsObjects`, so the harness
// booked a green self-test for REJECTING THE STANDARD. It is a first-class fixture that the
// harness proves the canonical `Node` ACCEPTS. Do not put it back under badNodes().

// The Spatial resource: a graph's integer id, its root node's id and its GeoPose anchor. It
// carries the same labeled bag the other resources carry.
function spatialDescriptor()
{
    return {
        id: 1,
        rootNodeID: 0,
        geoPose: geoPose(),
        webofworlds_extension: { x_osl_extension: true },
        proof_boundary: proofBoundary(),
    };
}

// OSL's FLAT node (schema: OSLFlatNode). `children` are INTEGER id references;
// `localTransform` is a flat 16-float column-major 4x4 matrix (the iteration 1 overlay, D9 —
// the standard constrains neither length nor major order).
function graphRootNode()
{
    return {
        id: 1,
        label: 'root',
        names: [ 'root' ],
        parent: 0,
        children: [ 2, 3 ],
        localTransform: identity16(),
        spatialAssetURI: 'asset://scene.glb',
    };
}

function childNode(id, parent)
{
    return {
        id: id,
        label: 'child-' + id,
        parent: parent,
        children: [],
        localTransform: identity16(),
        spatialAssetURI: 'asset://child.glb',
    };
}

// A node-create request body (POST /wow/spatial/{id}/node/{nodeId}) is a Node[] in the
// canonical form. These nodes have no children, so they are also valid flat nodes.
function nodeCreateBody()
{
    return [ childNode(4, 1), childNode(5, 1) ];
}

// The CANONICAL upstream Node shape: `children` are EMBEDDED Node objects, per
// WoWAPI@d39a1a0 API.yaml:484-487. THIS IS WHAT THE STANDARD SAYS.
//
// OSL serves this form by default since iteration 1. It is here so the harness can prove that
// a genuinely spec-conformant node VALIDATES against the canonical `Node` schema (it used to
// be REJECTED, and that rejection was booked as a passing conformance proof), and that the
// flat form is reported as the labeled extension it is. Recursion is exercised deliberately
// (a grandchild) since the canonical `children` items are a self-$ref.
function canonicalNode()
{
    return {
        id: 1,
        label: 'root',
        names: [ 'root' ],
        parent: 0,
        children: [
            { id: 2, label: 'child-2', parent: 1, children: [],
                localTransform: identity16(), spatialAssetURI: 'asset://child.glb' },
            { id: 3, label: 'child-3', parent: 1,
                children: [ { id: 4, label: 'grandchild-4', parent: 3, children: [],
                    localTransform: identity16() } ],
                localTransform: identity16() },
        ],
        localTransform: identity16(),
        spatialAssetURI: 'asset://scene.glb',
    };
}

// ---- WS /events envelope (LABELED NON-CANONICAL convention) ----
// Intentionally OUT of the OpenAPI HTTP contract (wow-spec/OSL-WOW-CONTRACT.md
// §6). No wow-spec schema governs it; the harness asserts this shape ITSELF and
// flags it labeled non-canonical.
function eventsEnvelopes()
{
    return [
        { type: 'user_joined', ts: '2026-07-09T00:00:00Z', user: { id: 1 } },
        { type: 'user_left', ts: '2026-07-09T00:00:01Z', user: { id: 1 } },
        { type: 'node_created', ts: '2026-07-09T00:00:02Z', node: { id: 2 } },
        { type: 'node_updated', ts: '2026-07-09T00:00:03Z', node: { id: 2 } },
        { type: 'node_deleted', ts: '2026-07-09T00:00:04Z', node: { id: 2 } },
    ];
}

// ---- Negative fixtures (drift guard self-test — proves the guard is real) ----
// These MUST be caught by conformance.js drift/validation, mirroring the
// proof's "deliberately-bad payloads are rejected" discipline.
function badNodes()
{
    return {
        // children MIXING integer id refs and embedded objects: conforms to
        // NEITHER the standard NOR the OSLFlatNode divergence. This is the real
        // bad case.
        //
        // NB: an ALL-embedded-objects node is NOT bad — it is the canonical
        // standard shape (see canonicalNode()). It used to live here, under the
        // name `childrenAsObjects`, which is how the harness came to certify
        // rejecting the standard. Do not put it back.
        mixedChildren: { id: 1, label: 'x', parent: 0,
            children: [ 2, { id: 3 } ], localTransform: identity16() },
        // localTransform not a 16-float matrix (an OSL CONVENTION — the standard
        // constrains neither length nor major order, so the guard reports this as
        // a divergence from OSL's convention, not as drift from the spec)
        shortTransform: { id: 1, label: 'x', parent: 0, children: [ 2 ],
            localTransform: [ 1, 0, 0 ] },
        // wrong types (rejected by BOTH Node and OSLFlatNode)
        wrongTypes: { id: 'not-an-int', label: 5 },
    };
}

// world response using the deprecated `lan` (drift) instead of the contract's `lon`
function worldWithLanDrift()
{
    const w = worldResponse();
    w.geoPose.position = { lat: 40.0, lan: -73.0, h: 1.6 }; // `lan` — drift from the contract's `lon`
    return w;
}

// world response with standards_conformance cosmetically flipped true (dishonest)
function worldWithCosmeticGreen()
{
    const w = worldResponse();
    w.proof_boundary.standards_conformance = true; // MUST be caught (no cosmetic green)
    return w;
}

module.exports = {
    identity16,
    geoPose,
    proofBoundary,
    worldResponse,
    userResponse,
    viewResponse,
    portalResponse,
    graphRootNode,
    spatialDescriptor,
    childNode,
    nodeCreateBody,
    canonicalNode,
    eventsEnvelopes,
    badNodes,
    worldWithLanDrift,
    worldWithCosmeticGreen,
};
