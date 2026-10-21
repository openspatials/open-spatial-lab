'use strict';

/*
 * tools/wow-conformance/conformance.js — (Lane F).
 *
 * The spec-first WoW conformance GATE. It CONSUMES the shared ajv layer
 * (wow-spec/validate.js) — it does NOT reimplement validation — and:
 *   1. validates OSL's WoW responses (and node request bodies) against the
 *      OpenSpatialWorld schema via the surface;
 *   2. surfaces EVERY labeled non-canonical extension explicitly (honest
 *      conformance-vs-extension, never cosmetic green);
 *   3. runs contract-first against typed fixtures AND against a live 041 server;
 *   4. reports contract-only / not-yet-implemented endpoints as such, without
 *      failing the whole run.
 *
 * This module is IMPORTABLE as a gate: battery can
 *   require('tools/wow-conformance/conformance').runWowConformance({ baseUrl, validator })
 * against an already-running server. run.js is the standalone CLI wrapper
 * (boot + load-gate + evidence).
 *
 * ADDITIVE: it does not modify the server (Lane A), the client (Lane B), or the
 * wow-spec internals (Lane) — it only reads the contract + drives HTTP.
 */

const http = require('http');
const crypto = require('crypto');
const fx = require('./fixtures');

// --------------------------------------------------------------------------
// Endpoint catalog — the WoW surface under conformance test. `live:true` are
// served by 041 today; `contractOnly:true` are in the contract but not
// yet served (honest 404 / no-upgrade) — land them.
// --------------------------------------------------------------------------
const ENDPOINTS = [
    { id: 'world',  method: 'GET', path: '/wow/world',    kind: 'world',
        responseSchema: 'OSLWorldResponse',  canonicalSchema: 'World',  live: true,
        fixture: fx.worldResponse },
    { id: 'user',   method: 'GET', path: '/wow/user/1',   kind: 'user',
        responseSchema: 'OSLUserResponse',   canonicalSchema: 'User',   live: true,
        fixture: fx.userResponse },
    { id: 'view',   method: 'GET', path: '/wow/view/1',   kind: 'view',
        responseSchema: 'OSLViewResponse',   canonicalSchema: 'View',   live: true,
        fixture: fx.viewResponse },
    { id: 'portal', method: 'GET', path: '/wow/portal/1', kind: 'portal',
        responseSchema: 'OSLPortalResponse', canonicalSchema: 'Portal', live: true,
        fixture: fx.portalResponse },

    // Spatial composition graph — CANONICAL PATHS, OSL-DIVERGENT PAYLOADS.
    // `responseSchema: OSLFlatNode` is the shape OSL actually serves (integer
    // id-ref children); `canonicalSchema: Node` is the STANDARD (embedded child
    // objects). Our payloads are EXPECTED to fail the canonical diff — that is
    // the DECLARED divergence (D1), reported as canonical_core_valid:false and
    // never made green by bending the canonical schema.
    //
    // These three probe the literal graph id `demo`, which is NOT a resolvable
    // graph id on 041 (SPATIAL_ACCEPTED_IDS = world_id/location_id/default/world),
    // so they 404 BY DESIGN. That is NOT "the endpoint isn't served":
    // landed and server.js fully owns the /wow/spatial/ prefix. The REAL live
    // coverage is the spatial.live.* records below, which resolve the world's
    // actual graph id from /wow/world and drive it.
    { id: 'spatial.root', method: 'GET', path: '/wow/spatial/demo', kind: 'node',
        responseSchema: 'OSLFlatNode', canonicalSchema: 'Node', contractOnly: true,
        fixture: fx.graphRootNode, trackedBy: 'live coverage: spatial.live.root' },
    { id: 'spatial.node', method: 'GET', path: '/wow/spatial/demo/node/1', kind: 'node',
        responseSchema: 'OSLFlatNode', canonicalSchema: 'Node', contractOnly: true,
        fixture: fx.graphRootNode, trackedBy: 'live coverage: spatial.live.root' },
    { id: 'spatial.node.create', method: 'POST', path: '/wow/spatial/demo/node/1', kind: 'node',
        requestSchema: 'OSLFlatNode[]', canonicalSchema: 'Node', contractOnly: true,
        requestBody: true, fixture: fx.nodeCreateBody, trackedBy: 'live coverage: spatial.live.root' },

    // Labeled NON-CANONICAL realtime convention (OSL-WOW-CONTRACT §6). Out of
    // the OpenAPI HTTP contract on purpose; shape asserted ourselves..
    { id: 'events', method: 'WS', path: '/events', kind: 'events',
        convention: 'labeled-non-canonical', contractOnly: true,
        fixture: fx.eventsEnvelopes, trackedBy: 'runtime' },
];

// field -> the x-osl-extension schema (or labeled composite member) it rides on
const EXT_FIELD_SCHEMA = {
    proof_boundary: 'ProofBoundary',
    webofworlds_extension: 'WebOfWorldsExtension',
    destination: 'PortalDestination',
    label: '(labeled OSL composite member)',
    id: '(labeled OSL composite member)',
    location: '(labeled OSL composite member)',
    session: '(labeled OSL composite member)',
};

// --------------------------------------------------------------------------
// Schema-derived key sets (canonical vs labeled extension), so the harness
// diffs canonical-vs-actual from the CONTRACT, not a hardcoded list.
// --------------------------------------------------------------------------
function propKeys(doc, schemaName)
{
    const s = doc.components && doc.components.schemas && doc.components.schemas[schemaName];
    return new Set(Object.keys((s && s.properties) || {}));
}

function compositeExtensionKeys(doc, compositeName)
{
    const s = doc.components && doc.components.schemas && doc.components.schemas[compositeName];
    const keys = new Set();
    if (!s) return keys;
    if (Array.isArray(s.allOf)) {
        // allOf composite (OSLWorldResponse, …): the labeled members are the
        // properties contributed by the non-$ref parts.
        for (const part of s.allOf)
            if (part && part.properties)
                for (const k of Object.keys(part.properties)) keys.add(k);
    } else if (s.properties) {
        // Flat labeled schema (e.g. OSLFlatNode): every property it declares is
        // declared-by-the-served-schema. The caller splits canonical-vs-extension
        // against the canonical key set, so a member like webofworlds_extension is
        // correctly surfaced as a LABELED extension rather than an undeclared field.
        for (const k of Object.keys(s.properties)) keys.add(k);
    }
    return keys;
}

// The registry of labeled OSL extension schemas (x-osl-extension:true) — proves
// the extension list is contract-derived, surfaced never hidden (policy §3).
function extensionSchemaRegistry(doc)
{
    const out = [];
    const schemas = (doc.components && doc.components.schemas) || {};
    for (const name of Object.keys(schemas))
        if (schemas[name] && schemas[name]['x-osl-extension'] === true)
            out.push(name);
    return out;
}

// --------------------------------------------------------------------------
// Surface labeled extensions present in a payload (honest conformance-vs-ext).
// --------------------------------------------------------------------------
function surfaceExtensions(doc, kind, payload, canonicalSchema, responseSchema)
{
    const canonSet = propKeys(doc, canonicalSchema);
    const declaredExt = responseSchema ? compositeExtensionKeys(doc, responseSchema) : new Set();
    const present = payload && typeof payload === 'object' ? Object.keys(payload) : [];

    const canonicalFieldsPresent = [];
    const extensionsInUse = [];
    const undeclaredFields = [];

    for (const k of present) {
        if (canonSet.has(k)) { canonicalFieldsPresent.push(k); continue; }
        if (declaredExt.has(k)) {
            extensionsInUse.push({
                field: k,
                schema: EXT_FIELD_SCHEMA[k] || '(labeled OSL extension)',
                note: 'labeled extension in use',
            });
        } else {
            undeclaredFields.push({
                field: k,
                note: 'extra field neither canonical nor a declared labeled extension — '
                    + 'rides legally (schemas set no additionalProperties:false) but SURFACED as a drift signal',
            });
        }
    }

    // Enumerate webofworlds_extension open-bag members (documented vs riding open).
    let wowExt = null;
    if (payload && payload.webofworlds_extension && typeof payload.webofworlds_extension === 'object') {
        const documented = propKeys(doc, 'WebOfWorldsExtension');
        const members = Object.keys(payload.webofworlds_extension);
        wowExt = {
            members_present: members,
            documented_members: members.filter(m => documented.has(m)),
            open_bag_members: members.filter(m => !documented.has(m)),
        };
    }

    return { canonicalFieldsPresent, extensionsInUse, undeclaredFields, wowExt };
}

// --------------------------------------------------------------------------
// Spec-drift guard — the known reference-impl catches (task §2/§5). Returns a
// list of { level: 'drift'|'note', msg }. `drift` entries are honest signals
// (surfaced); on a LIVE-served payload a drift becomes a hard problem.
// --------------------------------------------------------------------------
function driftCheck(kind, payload)
{
    const out = [];
    if (!payload || typeof payload !== 'object') return out;

    // geoPose longitude: the standard misspells it `lan`. `lon` is drift.
    const gp = payload.geoPose && payload.geoPose.position;
    if (gp && typeof gp === 'object') {
        if (Object.prototype.hasOwnProperty.call(gp, 'lon') &&
            !Object.prototype.hasOwnProperty.call(gp, 'lan'))
            out.push({ level: 'drift',
                msg: 'geoPose.position uses `lon` — the OpenSpatialWorld standard misspells longitude `lan`' });
        else if (Object.prototype.hasOwnProperty.call(gp, 'lan'))
            out.push({ level: 'note',
                msg: 'geoPose.position uses the standard\'s (misspelled) `lan` for longitude — conformant-to-standard' });
    }

    if (kind === 'node') {
        // ⚠ — THIS CHECK USED TO ASSERT THE INVERSE OF THE
        // STANDARD. It read "Node.children MUST be INTEGER id references (not
        // embedded objects)" and flagged the genuinely spec-conformant shape as
        // drift, so the harness certified REJECTING the standard as conformance.
        //
        // The STANDARD (WoWAPI@d39a1a0, API.yaml:484-487) types children as
        // EMBEDDED Node objects (items: $ref Node). OSL deliberately serves
        // INTEGER id refs — the LABELED `OSLFlatNode` divergence. Report BOTH
        // directions honestly; NEVER assert the OSL convention as the standard.
        if (Array.isArray(payload.children) && payload.children.length) {
            const nonInt = payload.children.filter(c => !Number.isInteger(c));
            if (nonInt.length === 0)
                out.push({ level: 'divergence',
                    msg: 'Node.children uses INTEGER id references — a DECLARED, LABELED OSL '
                        + 'divergence (schema OSLFlatNode). The OpenSpatialWorld standard EMBEDS '
                        + 'child Node objects (items: $ref Node). Not drift: declared.' });
            else if (nonInt.length === payload.children.length)
                out.push({ level: 'note',
                    msg: 'Node.children EMBEDS child objects — CONFORMANT-TO-STANDARD (canonical Node). '
                        + 'NB: this is not the OSL flat-graph shape; OSL readers expect id refs.' });
            else
                out.push({ level: 'drift',
                    msg: 'Node.children MIXES integer id refs and embedded objects — conforms to '
                        + 'NEITHER the standard NOR the OSLFlatNode divergence' });
        }
        if (Array.isArray(payload.localTransform)) {
            // The standard constrains neither the length nor the major order of
            // localTransform (items: number, that is all). 16-float column-major
            // is an OSL CONVENTION — so a non-16 length is a divergence from US,
            // not drift from the standard. Say which is which.
            if (payload.localTransform.length !== 16)
                out.push({ level: 'divergence',
                    msg: 'Node.localTransform is not 16 floats (found length '
                        + payload.localTransform.length + '). NB: 16-float column-major 4x4 is an OSL '
                        + 'CONVENTION — the standard constrains neither length nor major order.' });
            else if (!payload.localTransform.every(n => typeof n === 'number'))
                out.push({ level: 'drift', msg: 'Node.localTransform contains non-number entries '
                    + '(the standard types the items `number`)' });
        }
    }
    return out;
}

// The divergences OSL DECLARES against the OpenSpatialWorld standard, with the
// upstream line references. Emitted into the evidence so a reader can never
// mistake OSL's shape for the standard's.
const DECLARED_DIVERGENCES = [
    { id: 'D1', subject: 'Node.children', upstream: 'API.yaml:484-487 (items: $ref Node)',
        standard: 'children are EMBEDDED child Node objects',
        osl: 'children are INTEGER node-id references (flat graph)',
        schema: 'OSLFlatNode', status: 'DECLARED — served on every /wow/spatial/* payload' },
    // D2/D3 were STALE UNDER-CLAIMS. They said the canonical
    // Spatial descriptor was "NOT yet served" / "contract-only" for twelve days after
    // served it. An under-claim is the same defect as an
    // over-claim: the claim surface and the code drifted apart and nothing detected
    // it. Both are now re-derived from a running server on every run of
    // src/wow-claim-drift-proof.mjs, which goes RED in BOTH directions.
    { id: 'D2', subject: 'Spatial schema', upstream: 'API.yaml:438-468',
        standard: 'a graph DESCRIPTOR {id, rootNodeID, geoPose}',
        osl: 'transcribed into the contract AND SERVED on a versioned opt-in '
            + '(?form=descriptor / X-OSL-WoW-Spatial-Form: descriptor); the DEFAULT response stays '
            + 'the root node so no existing client breaks. NOTE: the opt-in itself (the `form` query '
            + 'parameter and the X-OSL-WoW-Spatial-Form header) is declared in NO schema.yaml path — '
            + 'the capability is served and proven, its OpenAPI DECLARATION is outstanding.',
        schema: 'Spatial',
        status: 'DECLARED — served on a versioned opt-in; wire-proven by '
            + 'src/wow-gaps-validation.mjs and drift-guarded by src/wow-claim-drift-validation.mjs' },
    { id: 'D3', subject: 'GET /wow/spatial/{spatialID} response', upstream: 'API.yaml:133-153 (getSpatialById)',
        standard: 'returns a Spatial descriptor (points AT a root node)',
        osl: 'returns the root node itself BY DEFAULT (backward compatibility); returns the canonical '
            + 'Spatial descriptor on the D2 versioned opt-in',
        schema: 'OSLFlatNode', status: 'DECLARED — default node · descriptor on opt-in; versioned, never silent' },
    { id: 'D4', subject: 'spatialID path param', upstream: 'API.yaml:141-146 (type: integer)',
        standard: 'integer', osl: 'string (world_id / location_id / default / world)',
        schema: null, status: 'DECLARED — deliberate; 041 addresses graphs by string id' },
    { id: 'D5', subject: 'node-path parameters', upstream: 'API.yaml:163-253',
        standard: 'omits the spatialID path param on all four node ops; DELETE misspells nodeid',
        osl: 'declares spatialID on all four; spells nodeId correctly',
        schema: null, status: 'LABELED REPAIR of an upstream defect — to be proposed upstream' },
    { id: 'D6', subject: 'GET / (getDefaultApp)', upstream: 'API.yaml:17-29',
        standard: 'returns text/html (provisions the web app)',
        osl: 'not in the OSL contract (OSL serves its client differently)',
        schema: null, status: 'OMITTED — canonical surface absent from our contract' },
    // the write path for a CONFORMANT node body.
    { id: 'D7', subject: 'POST/PUT of a CONFORMANT node body (embedded children)',
        upstream: 'API.yaml:163-253',
        standard: 'a Node body (children = EMBEDDED objects) is simply stored',
        osl: 'REFUSED 422 embedded_children_not_supported by default; stored ONLY on the explicit '
            + 'X-OSL-WoW-Node-Form: canonical opt-in, which flattens the subtree to id-refs and reports '
            + 'what it stored (X-OSL-WoW-Nodes-Stored / X-OSL-WoW-Children-Flattened). Until 2026-07-11 '
            + 'such a body was answered 200 OK with its subtree SILENTLY DELETED — that data loss is fixed.',
        schema: 'OSLFlatNode',
        status: 'DECLARED EXTENSION — the opt-in header, the query form, the two response headers and the '
            + '400/422 refusal codes are OSL extensions; the standard specifies none of them' },
    // a node that TRANSCLUDES a signed.msf fabric as a SUBTREE.
    { id: 'D8', subject: 'SpatialFabricSubtree (a node that transcludes a SIGNED .msf fabric as a SUBTREE)',
        upstream: 'API.yaml Node.spatialAssetURI (bare string) + OpenSpatialAsset media-type list',
        standard: 'a Node\'s spatialAssetURI is an unconstrained string — a .msf URL in it is SPEC-LEGAL '
            + '(no format, no mediaType, no enum, no prose). But the standard says NOTHING about what such a '
            + 'URI resolves to, and it has NO concept of a signed, executable spatial document: the sibling '
            + 'OpenSpatialAsset spec is media-type-plural (model/gltf-binary, model/vnd.usdz+zip, ...) yet has '
            + 'no signed-document type. WoW can address a subtree; it cannot SPECIFY one.',
        osl: 'ADOPTS spatialAssetURI as the ADDRESS and adds the CONTRACT the address cannot carry, as a '
            + 'LABELED, STRICT, non-canonical schema on the node '
            + '(webofworlds_extension.spatial_fabric_subtree): unitsPerMeter, upAxis and placement are '
            + 'REQUIRED WITH NO DEFAULTS (an inherited "auto" scale silently means 1 AU = 1 METRE; a guessed '
            + 'up-axis silently lays the solar system on its side; placement selects a BACKEND whose honesty '
            + 'claim differs). Plus a fail-closed trust policy (requireVerified, default TRUE) and a recursion '
            + 'cap (maxDepth). TRANSCLUSION, NOT TRAVERSAL — it rides on Node, never on Portal; the two link '
            + 'mechanisms are deliberately NOT merged.',
        schema: 'SpatialFabricSubtree',
        status: 'DECLARED EXTENSION — the capability is OURS, labeled (x-osl-extension:true) and proposed '
            + 'upstream (runtime: a Node.spatialAssetType media-type discriminator + an '
            + 'OpenSpatialAsset type for a signed, verifiable spatial document). `application/msf+jws` is a '
            + 'PROVISIONAL, UNREGISTERED label — no such IANA media type exists. NOTHING HERE EARNS A '
            + 'CONFORMANCE FLIP: standards_conformance stays false.' },
];

// Honesty guard: /wow read responses MUST carry proof_boundary with
// standards_conformance:false (no cosmetic green). Returns { ok, problems[] }.
function honestyCheck(kind, payload)
{
    const problems = [];
    if (kind === 'events' || kind === 'node') return { ok: true, problems };
    const pb = payload && payload.proof_boundary;
    if (!pb || typeof pb !== 'object') {
        problems.push('response missing required proof_boundary');
        return { ok: false, problems };
    }
    if (pb.standards_conformance !== false)
        problems.push('proof_boundary.standards_conformance is not false (COSMETIC GREEN — dishonest)');
    if (pb.native_teleportxr_teleport !== false)
        problems.push('proof_boundary.native_teleportxr_teleport is not false');
    return { ok: problems.length === 0, problems };
}

// --------------------------------------------------------------------------
// HTTP / WS drivers
// --------------------------------------------------------------------------
function httpRequestJson(baseUrl, method, p, body)
{
    return new Promise((resolve) => {
        let u;
        try { u = new URL(p, baseUrl); } catch (e) { return resolve({ error: 'bad url: ' + e.message }); }
        const payload = body != null ? Buffer.from(JSON.stringify(body), 'utf8') : null;
        const req = http.request({
            host: u.hostname, port: u.port, path: u.pathname + u.search, method,
            headers: Object.assign({ Accept: 'application/json' },
                payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
        }, (res) => {
            let buf = '';
            res.on('data', c => { buf += c; });
            res.on('end', () => {
                let json = null;
                try { json = JSON.parse(buf); } catch (e) { /* leave null */ }
                resolve({ status: res.statusCode, headers: res.headers, json, body: buf });
            });
        });
        req.on('error', e => resolve({ error: e.message }));
        req.setTimeout(5000, () => { req.destroy(); resolve({ error: 'timeout' }); });
        if (payload) req.write(payload);
        req.end();
    });
}

// Probe a WS upgrade WITHOUT a full ws client: Node emits 'upgrade' on a 101.
function probeWs(baseUrl, p, timeoutMs)
{
    return new Promise((resolve) => {
        let u;
        try { u = new URL(p, baseUrl); } catch (e) { return resolve({ upgraded: false, detail: 'bad url' }); }
        const key = crypto.randomBytes(16).toString('base64');
        const req = http.request({
            host: u.hostname, port: u.port, path: u.pathname, method: 'GET',
            headers: { Connection: 'Upgrade', Upgrade: 'websocket',
                'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13' },
        });
        let done = false;
        const finish = (r) => { if (done) return; done = true; try { req.destroy(); } catch (e) {} resolve(r); };
        req.on('upgrade', (res, socket) => { try { socket.destroy(); } catch (e) {} finish({ upgraded: true, detail: '101 Switching Protocols' }); });
        req.on('response', res => finish({ upgraded: false, detail: 'no upgrade (HTTP ' + res.statusCode + ')' }));
        req.on('error', e => finish({ upgraded: false, detail: 'connection closed/destroyed (' + e.code + ')' }));
        setTimeout(() => finish({ upgraded: false, detail: 'timeout' }), timeoutMs || 2500);
        req.end();
    });
}

// Local shape-check for the WS /events envelope (no wow-spec schema governs it).
const EVENTS_TYPES = new Set([ 'user_joined', 'user_left', 'node_created', 'node_updated', 'node_deleted' ]);
function checkEventEnvelope(msg)
{
    const problems = [];
    if (!msg || typeof msg !== 'object') { problems.push('event is not an object'); return { ok: false, problems }; }
    if (typeof msg.type !== 'string') problems.push('event.type missing/not-a-string');
    else if (!EVENTS_TYPES.has(msg.type)) problems.push('event.type "' + msg.type + '" not a known convention type');
    return { ok: problems.length === 0, problems };
}

// --------------------------------------------------------------------------
// The gate.
// --------------------------------------------------------------------------
async function runWowConformance(opts)
{
    opts = opts || {};
    const validator = opts.validator || require('../../wow-spec/validate').createValidator();
    const doc = validator.doc;
    const baseUrl = opts.baseUrl || null; // when null -> fixtures-only

    const problems = [];       // hard failures -> non-zero exit
    const endpoints = [];
    const extIndex = new Map(); // field -> { field, schema, note, endpoints:Set }
    const gaps = [];

    function noteExt(field, schema, note, endpointId)
    {
        const key = field + '|' + schema;
        if (!extIndex.has(key)) extIndex.set(key, { field, schema, note, endpoints: new Set() });
        extIndex.get(key).endpoints.add(endpointId);
    }

    for (const ep of ENDPOINTS) {
        const r = {
            id: ep.id, method: ep.method, path: ep.path, kind: ep.kind,
            declared: ep.contractOnly ? 'contract-only' : 'live',
            tracked_by: ep.trackedBy || null,
            convention: ep.convention || null,
            fixture: null, live: null, drift: [], divergences: [], notes: [],
            canonical_fields_present: [], extensions_in_use: [], undeclared_fields: [], wow_extension: null,
            status: null, reason: null,
        };

        // Split a driftCheck() result into the three HONEST levels:
        //   drift      — conforms to NEITHER the standard nor our declared shape (hard)
        //   divergence — our DECLARED, LABELED departure from the standard (surfaced)
        //   note       — conformant-to-standard observation
        function applyChecks(rec, kind, payload)
        {
            const all = driftCheck(kind, payload);
            rec.drift = all.filter(d => d.level === 'drift').map(d => d.msg);
            rec.divergences = all.filter(d => d.level === 'divergence').map(d => d.msg);
            rec.notes = all.filter(d => d.level === 'note').map(d => d.msg);
            return rec.drift;
        }

        // ---- fixture pass (always; contract-first) ----
        const fixtureData = ep.fixture ? ep.fixture() : null;
        if (ep.kind === 'events') {
            const per = (fixtureData || []).map(checkEventEnvelope);
            const ok = per.every(p => p.ok);
            r.fixture = { validated: 'WS /events envelope (labeled non-canonical; self-asserted shape)',
                valid: ok, errors: ok ? null : per.flatMap(p => p.problems) };
            if (!ok) problems.push(ep.id + ' fixture: events envelope shape invalid (contract/harness incoherent)');
        } else if (ep.requestBody) {
            const res = validator.validateRequest(ep.requestSchema, fixtureData);
            r.fixture = { validated: ep.requestSchema + ' (request body)', valid: res.valid, errors: res.errorsText };
            if (!res.valid) problems.push(ep.id + ' fixture: ' + ep.requestSchema + ' request body invalid: ' + res.errorsText);
        } else if (ep.responseSchema) {
            const res = validator.validateResponse(ep.kind, fixtureData);
            r.fixture = { validated: ep.responseSchema, valid: res.valid, errors: res.errorsText };
            if (!res.valid) problems.push(ep.id + ' fixture: ' + ep.responseSchema + ' invalid: ' + res.errorsText);
            // Canonical diff: for the spatial node kind our SERVED
            // shape (OSLFlatNode) is EXPECTED to fail the canonical `Node` — that is
            // declared divergence D1, recorded, never silently passed as conformance.
            if (ep.canonicalSchema && ep.canonicalSchema !== ep.responseSchema) {
                const canon = validator.validateCanonical(ep.kind, fixtureData);
                r.fixture.canonical_schema = ep.canonicalSchema;
                r.fixture.canonical_valid = canon.valid;
                r.fixture.canonical_errors = canon.valid ? null : canon.errorsText;
            }
            applyChecks(r, ep.kind, fixtureData);
            const surf = surfaceExtensions(doc, ep.kind, fixtureData, ep.canonicalSchema, ep.responseSchema);
            r.canonical_fields_present = surf.canonicalFieldsPresent;
            r.extensions_in_use = surf.extensionsInUse;
            r.undeclared_fields = surf.undeclaredFields;
            r.wow_extension = surf.wowExt;
            for (const e of surf.extensionsInUse) noteExt(e.field, e.schema, e.note, ep.id);
        } else if (ep.canonicalSchema) { // canonical-only endpoint (no OSL composite)
            const res = validator.validateCanonical(ep.kind, fixtureData);
            r.fixture = { validated: ep.canonicalSchema + ' (canonical)', valid: res.valid, errors: res.errorsText };
            if (!res.valid) problems.push(ep.id + ' fixture: ' + ep.canonicalSchema + ' invalid: ' + res.errorsText);
            applyChecks(r, ep.kind, fixtureData);
        }

        // ---- live pass (when a server is provided) ----
        if (baseUrl) {
            if (ep.method === 'WS') {
                const probe = await probeWs(baseUrl, ep.path, 2500);
                r.live = { attempted: true, upgraded: probe.upgraded, detail: probe.detail };
                if (probe.upgraded) { r.status = 'conformant'; r.reason = 'WS /events upgraded (labeled non-canonical convention)'; }
                else { r.status = 'not-implemented'; r.reason = 'WS /events not served (' + probe.detail
                    + ') — labeled non-canonical convention, tracked by ' + (ep.trackedBy || 'runtime'); }
            } else {
                const body = ep.requestBody ? fixtureData : null;
                const resp = await httpRequestJson(baseUrl, ep.method, ep.path, body);
                r.live = { attempted: true, http_status: resp.status || null,
                    validation_header: resp.headers ? resp.headers['x-osl-wow-validation'] || null : null,
                    error: resp.error || null };

                if (resp.error) {
                    r.status = 'error'; r.reason = 'transport error: ' + resp.error;
                    problems.push(ep.id + ' live: transport error: ' + resp.error);
                } else if (resp.status === 404) {
                    // honest not-yet-implemented / not-resolvable for contract-only endpoints
                    r.status = ep.contractOnly ? 'contract-only' : 'gap';
                    r.reason = ep.contractOnly
                        ? 'live 404 — the fixed probe id `demo` is not a resolvable graph id on 041 '
                          + '(SPATIAL_ACCEPTED_IDS). NOT "unserved": runtime landed and server.js owns the '
                          + '/wow/spatial/ prefix. The fixture validates the contract shape; '
                          + (ep.trackedBy || 'live coverage: spatial.live.root')
                        : 'live 404 — endpoint expected live but not served';
                    if (!ep.contractOnly) problems.push(ep.id + ' live: expected-live endpoint returned 404');
                } else if (resp.status === 200 && ep.responseSchema) {
                    const res = validator.validateResponse(ep.kind, resp.json);
                    const canon = validator.validateCanonical(ep.kind, resp.json);
                    const honesty = honestyCheck(ep.kind, resp.json);
                    const surf = surfaceExtensions(doc, ep.kind, resp.json, ep.canonicalSchema, ep.responseSchema);

                    r.live.response_valid = res.valid;
                    r.live.canonical_core_valid = canon.valid;
                    r.live.canonical_schema = ep.canonicalSchema || null;
                    r.live.canonical_errors = canon.valid ? null : canon.errorsText;
                    r.live.response_errors = res.valid ? null : res.errorsText;
                    r.canonical_fields_present = surf.canonicalFieldsPresent;
                    r.extensions_in_use = surf.extensionsInUse;
                    r.undeclared_fields = surf.undeclaredFields;
                    r.wow_extension = surf.wowExt;
                    applyChecks(r, ep.kind, resp.json);
                    for (const e of surf.extensionsInUse) noteExt(e.field, e.schema, e.note, ep.id);

                    if (!res.valid) { r.status = 'fail'; r.reason = 'response fails ' + ep.responseSchema + ': ' + res.errorsText;
                        problems.push(ep.id + ' live: response fails ' + ep.responseSchema + ': ' + res.errorsText); }
                    else if (!honesty.ok) { r.status = 'fail'; r.reason = honesty.problems.join('; ');
                        for (const hp of honesty.problems) problems.push(ep.id + ' live: ' + hp); }
                    else if (r.drift.length) { r.status = 'fail'; r.reason = 'drift on live response: ' + r.drift.join('; ');
                        for (const d of r.drift) problems.push(ep.id + ' live: drift — ' + d); }
                    else if (r.divergences.length) {
                        // Valid against the schema OSL SERVES, and the departure from the
                        // STANDARD is declared + labeled. Say BOTH things out loud — never
                        // let "conformant" be read as "conforms to the standard".
                        r.status = 'conformant-with-declared-divergence';
                        r.reason = 'response valid vs ' + ep.responseSchema + ' (LABELED, non-canonical) + honest '
                            + '(standards_conformance:false); canonical ' + (ep.canonicalSchema || 'schema')
                            + ' valid: ' + canon.valid + ' — DECLARED divergence, see declared_divergences';
                    }
                    else { r.status = 'conformant'; r.reason = 'response valid + honest (standards_conformance:false)'; }
                } else {
                    r.status = 'fail'; r.reason = 'unexpected live status ' + resp.status;
                    problems.push(ep.id + ' live: unexpected status ' + resp.status);
                }
            }
        } else {
            // fixtures-only mode
            r.status = ep.contractOnly ? 'contract-only' : 'fixture-only';
            r.reason = 'fixtures-only mode (no live server driven)';
        }

        if (r.status === 'contract-only' || r.status === 'not-implemented' || r.status === 'gap')
            gaps.push({ endpoint: ep.id, method: ep.method, path: ep.path, status: r.status,
                reason: r.reason, tracked_by: ep.trackedBy || null });

        endpoints.push(r);
    }

    // ---- LIVE composition-graph portal-node conformance ----
    // Additive, LIVE-only (fixtures-only mode is byte-identical — this whole block
    // is skipped when no server is driven). Now that serves /wow/spatial and
    // lands the portal node's RESOLVABLE destination, drive the REAL graph:
    // resolve the world's spatialID from /wow/world, validate the root + each PORTAL
    // node, assert the destination is resolvable (a composition-graph reference), and
    // SURFACE the labeled portal extension (never hidden). Portal nodes are found by
    // role==='portal' / the labeled osl-portal: URI.
    //
    // these nodes are validated against the schema OSL ACTUALLY
    // SERVES (`OSLFlatNode` — integer id-ref children), and the canonical `Node` diff
    // (which they are EXPECTED to fail, because the standard embeds child objects) is
    // recorded as `canonical_node_valid:false` — a DECLARED divergence, surfaced, not
    // a bent yardstick. Previously this block validated the flat nodes against a
    // `Node` schema that had been (wrongly) redefined to expect id refs, which is how
    // the harness came to certify rejecting the standard as conformance.
    if (baseUrl) {
        const nodeKeySet = propKeys(doc, 'Node');
        const world = await httpRequestJson(baseUrl, 'GET', '/wow/world');
        const spatialId = world && world.json && world.json.id;
        const spPath = spatialId ? '/wow/spatial/' + encodeURIComponent(spatialId) : null;
        const rootRec = {
            id: 'spatial.live.root', method: 'GET', path: spPath || '/wow/spatial/{world_id}', kind: 'node',
            declared: 'live', tracked_by: 'runtime/runtime', fixture: null,
            live: { attempted: true, http_status: null }, drift: [],
            canonical_fields_present: [], extensions_in_use: [], undeclared_fields: [], wow_extension: null,
            status: null, reason: null,
        };
        endpoints.push(rootRec);
        if (!spatialId) {
            rootRec.status = 'error'; rootRec.reason = 'could not resolve world_id from /wow/world';
            problems.push('spatial.live.root: could not resolve world_id from /wow/world');
        } else {
            const rootResp = await httpRequestJson(baseUrl, 'GET', spPath);
            rootRec.live.http_status = rootResp.status || null;
            if (rootResp.status !== 200 || !rootResp.json) {
                rootRec.status = 'fail';
                rootRec.reason = 'root /wow/spatial/{id} not 200 (' + rootResp.status + ')';
                problems.push('spatial.live.root: /wow/spatial/' + spatialId + ' returned ' + rootResp.status);
            } else {
                // Validate against what we SERVE (OSLFlatNode) — that is the hard gate.
                const sv = validator.validateResponse('node', rootResp.json);
                // …and diff against the STANDARD (canonical Node), which our flat shape
                // is expected to fail. Recorded, never converted into a pass.
                const cv = validator.validateCanonical('node', rootResp.json);
                const all = driftCheck('node', rootResp.json);
                const drift = all.filter(d => d.level === 'drift').map(d => d.msg);
                rootRec.drift = drift;
                rootRec.divergences = all.filter(d => d.level === 'divergence').map(d => d.msg);
                rootRec.notes = all.filter(d => d.level === 'note').map(d => d.msg);
                rootRec.live.served_schema = 'OSLFlatNode';
                rootRec.live.served_valid = sv.valid;
                rootRec.live.canonical_schema = 'Node';
                rootRec.live.canonical_node_valid = cv.valid;
                rootRec.live.canonical_node_errors = cv.valid ? null : cv.errorsText;
                rootRec.canonical_fields_present = Object.keys(rootResp.json).filter(k => nodeKeySet.has(k));
                if (!sv.valid) { rootRec.status = 'fail'; rootRec.reason = 'root fails served schema OSLFlatNode: ' + sv.errorsText;
                    problems.push('spatial.live.root: ' + sv.errorsText); }
                else if (drift.length) { rootRec.status = 'fail'; rootRec.reason = 'drift: ' + drift.join('; ');
                    for (const d of drift) problems.push('spatial.live.root: drift — ' + d); }
                else if (rootRec.divergences.length || !cv.valid) {
                    rootRec.status = 'conformant-with-declared-divergence';
                    rootRec.reason = 'root node valid vs OSLFlatNode (LABELED, non-canonical); canonical Node valid: '
                        + cv.valid + ' — DECLARED divergence D1 (the standard embeds child Node objects; OSL serves '
                        + 'integer id refs). NOT a claim of standards conformance';
                } else {
                    // No children to diverge over (a leaf): the payload satisfies BOTH the
                    // served OSLFlatNode AND the canonical Node. Say that precisely — do not
                    // label a genuinely canonical payload as divergent.
                    rootRec.status = 'conformant';
                    rootRec.reason = 'root node valid vs OSLFlatNode AND vs the canonical Node '
                        + '(no children -> the id-ref/embedded divergence does not arise here)';
                }

                let portalCount = 0;
                // a child-node fetch that 500'd, timed out, or came
                // back unparseable used to be SILENTLY DROPPED (`continue`). If 2 of 3 portal
                // nodes failed, the evidence recorded the ONE that worked and said nothing about
                // the two it never saw — a partial graph presented as the whole graph. Count
                // every failure, record it in the evidence, and make it a hard problem.
                let childrenFetched = 0;
                const childrenFailed = [];
                const children = Array.isArray(rootResp.json.children) ? rootResp.json.children : [];
                for (const cid of children) {
                    const nr = await httpRequestJson(baseUrl, 'GET', spPath + '/node/' + encodeURIComponent(cid));
                    if (nr.status !== 200 || !nr.json) {
                        childrenFailed.push({ id: cid, http_status: nr.status ?? null,
                            reason: nr.status !== 200 ? ('HTTP ' + (nr.status ?? 'no-response')) : 'unparseable JSON body' });
                        problems.push('spatial.live.node.' + cid + ': child-node fetch FAILED ('
                            + (nr.status !== 200 ? ('HTTP ' + (nr.status ?? 'no-response')) : 'unparseable body')
                            + ') — the composition graph was only PARTIALLY walked; this diagnostics does not cover node ' + cid);
                        continue;
                    }
                    childrenFetched++;
                    const node = nr.json;
                    const ext = node.webofworlds_extension || {};
                    const isPortal = ext.role === 'portal' || /^osl-portal:/.test(node.spatialAssetURI || '');
                    if (!isPortal) continue;
                    portalCount += 1;
                    const pv = validator.validateResponse('node', node);      // served: OSLFlatNode (the gate)
                    const pcv = validator.validateCanonical('node', node);    // standard: Node (expected to fail — declared)
                    const pall = driftCheck('node', node);
                    const pdrift = pall.filter(d => d.level === 'drift').map(d => d.msg);
                    const resolvable = typeof ext.target_spatial_graph_endpoint === 'string' && ext.target_spatial_graph_endpoint.length > 0;
                    const rec = {
                        id: 'spatial.live.portal.node.' + cid, method: 'GET', path: spPath + '/node/' + cid, kind: 'node',
                        declared: 'live', tracked_by: 'runtime', fixture: null,
                        live: { attempted: true, http_status: nr.status, portal_id: ext.portal_id || null,
                            served_schema: 'OSLFlatNode', served_valid: pv.valid,
                            canonical_schema: 'Node', canonical_node_valid: pcv.valid,
                            canonical_node_errors: pcv.valid ? null : pcv.errorsText,
                            destination_resolvable: resolvable, target_spatial_graph_endpoint: ext.target_spatial_graph_endpoint || null },
                        drift: pdrift,
                        divergences: pall.filter(d => d.level === 'divergence').map(d => d.msg),
                        notes: pall.filter(d => d.level === 'note').map(d => d.msg),
                        canonical_fields_present: Object.keys(node).filter(k => nodeKeySet.has(k)),
                        extensions_in_use: [], undeclared_fields: [], wow_extension: null, status: null, reason: null,
                    };
                    if (node.webofworlds_extension) {
                        rec.extensions_in_use = [ { field: 'webofworlds_extension', schema: 'WebOfWorldsExtension',
                            note: 'labeled portal-destination extension on the composition-graph node (surfaced, runtime)' } ];
                        noteExt('webofworlds_extension', 'WebOfWorldsExtension',
                            'portal node destination', rec.id);
                    }
                    if (!pv.valid) { rec.status = 'fail'; rec.reason = 'portal node fails served schema OSLFlatNode: ' + pv.errorsText;
                        problems.push(rec.id + ': ' + pv.errorsText); }
                    else if (pdrift.length) { rec.status = 'fail'; rec.reason = 'drift: ' + pdrift.join('; ');
                        for (const d of pdrift) problems.push(rec.id + ': drift — ' + d); }
                    else if (!resolvable) { rec.status = 'fail';
                        rec.reason = 'portal node destination NOT resolvable (no target_spatial_graph_endpoint)';
                        problems.push(rec.id + ': destination not resolvable'); }
                    else if (rec.divergences.length || !pcv.valid) {
                        rec.status = 'conformant-with-declared-divergence';
                        rec.reason = 'portal node valid vs OSLFlatNode (LABELED, non-canonical) + resolvable destination '
                            + '(labeled, surfaced); canonical Node valid: ' + pcv.valid
                            + ' — DECLARED divergence D1, not a standards-conformance claim';
                    } else {
                        // A LEAF portal node (children: []) satisfies BOTH shapes — the
                        // id-ref/embedded divergence simply does not arise with no children.
                        // Report that truthfully instead of stamping a false divergence.
                        rec.status = 'conformant';
                        rec.reason = 'portal node valid vs OSLFlatNode AND vs the canonical Node (leaf: no '
                            + 'children, so the id-ref/embedded divergence does not arise) + resolvable '
                            + 'destination (labeled, surfaced). Canonical validity here does NOT imply '
                            + 'OSL\'s graph is canonical — the ROOT diverges (D1)';
                    }
                    endpoints.push(rec);
                }
                // R2: the walk's COVERAGE is part of the evidence, not an implicit assumption.
                rootRec.graph_walk = {
                    children_declared: children.length,
                    children_fetched: childrenFetched,
                    children_failed: childrenFailed.length,
                    failures: childrenFailed,
                    complete: childrenFailed.length === 0,
                };
                rootRec.reason += portalCount
                    ? '; ' + portalCount + ' portal node(s) validated live'
                    : '; WARNING: no portal nodes found in graph';
                if (childrenFailed.length) {
                    rootRec.status = 'fail';
                    rootRec.reason += '; PARTIAL WALK: ' + childrenFailed.length + ' of ' + children.length
                        + ' declared child node(s) could NOT be fetched — this record does not describe the whole graph';
                }
                if (!portalCount) problems.push('spatial.live.root: no portal nodes found in the live composition graph');
            }
        }
    }

    // ---- negative self-tests: prove the guards are REAL (not cosmetic) ----
    const selfChecks = [];
    function selfCheck(name, caught, detail) {
        selfChecks.push({ name, caught: !!caught, detail: detail || null });
        if (!caught) problems.push('self-test FAILED (guard is cosmetic): ' + name);
    }
    // ---- THE UN-INVERSION ----
    // Until 2026-07-11 this block asserted "ajv rejects Node with
    // children-as-objects" and booked it GREEN — i.e. it certified REJECTING the
    // OpenSpatialWorld standard as conformance. The canonical `Node` EMBEDS child
    // Node objects (API.yaml:484-487). These four checks pin BOTH shapes to the
    // right schema so that inversion cannot silently return.
    selfCheck('canonical Node ACCEPTS embedded child objects (THE STANDARD — was inverted)',
        validator.validateCanonical('node', fx.canonicalNode()).valid === true,
        validator.validateCanonical('node', fx.canonicalNode()).errorsText);
    selfCheck('canonical Node REJECTS integer id-ref children (proves `Node` is the STANDARD, not OSL\'s shape)',
        validator.validateCanonical('node', fx.graphRootNode()).valid === false);
    selfCheck('OSLFlatNode ACCEPTS the flat id-ref node OSL actually serves',
        validator.validateResponse('node', fx.graphRootNode()).valid === true,
        validator.validateResponse('node', fx.graphRootNode()).errorsText);
    selfCheck('OSLFlatNode REJECTS embedded child objects (our divergence is enforced on our own shape)',
        validator.validateResponse('node', fx.canonicalNode()).valid === false);

    // ajv catches structural breaks, under BOTH schemas
    selfCheck('ajv rejects a node with wrong types (canonical Node)',
        validator.validateRequest('Node', fx.badNodes().wrongTypes).valid === false);
    selfCheck('ajv rejects a node with wrong types (OSLFlatNode)',
        validator.validateRequest('OSLFlatNode', fx.badNodes().wrongTypes).valid === false);
    selfCheck('ajv rejects children MIXING id refs and embedded objects (conforms to NEITHER shape)',
        validator.validateCanonical('node', fx.badNodes().mixedChildren).valid === false
        && validator.validateResponse('node', fx.badNodes().mixedChildren).valid === false);

    // drift guard: it must name the STANDARD correctly in BOTH directions
    selfCheck('drift guard reports embedded children as CONFORMANT-TO-STANDARD (a note, never drift)',
        driftCheck('node', fx.canonicalNode()).some(d => d.level === 'note')
        && !driftCheck('node', fx.canonicalNode()).some(d => d.level === 'drift'));
    selfCheck('drift guard reports OSL id-ref children as a DECLARED DIVERGENCE (never as the standard)',
        driftCheck('node', fx.graphRootNode()).some(d => d.level === 'divergence')
        && !driftCheck('node', fx.graphRootNode()).some(d => d.level === 'drift'));
    selfCheck('drift guard catches MIXED children as real drift',
        driftCheck('node', fx.badNodes().mixedChildren).some(d => d.level === 'drift'));
    // drift guard catches what ajv (open schemas) does not
    selfCheck('drift guard flags non-16 localTransform (an OSL CONVENTION, reported as divergence)',
        driftCheck('node', fx.badNodes().shortTransform)
            .some(d => d.level === 'divergence' && /localTransform/.test(d.msg)));
    selfCheck('drift guard catches lon-instead-of-lan',
        driftCheck('world', fx.worldWithLonDrift()).some(d => d.level === 'drift'));
    // honesty guard catches cosmetic green (ajv passes it — a boolean true is a valid boolean)
    selfCheck('honesty guard catches cosmetic standards_conformance:true',
        honestyCheck('world', fx.worldWithCosmeticGreen()).ok === false
        && validator.validateResponse('world', fx.worldWithCosmeticGreen()).valid === true);

    const extensions_in_use = Array.from(extIndex.values())
        .map(e => ({ field: e.field, schema: e.schema, note: e.note, endpoints: Array.from(e.endpoints) }));

    // ---- COVERAGE vs COMPLETENESS ----------------------
    // A reader must be able to tell, at a glance, WHAT THIS RUN DID NOT LOOK AT.
    // `live_driven` is derived from the live records we ACTUALLY produced, never
    // from the caller's INTENT (`baseUrl`): if a "live" pass somehow drove zero
    // endpoints, this block still tells the truth instead of inheriting the lie.
    // ---- THIS BLOCK OVER-CLAIMED ITSELF -----------------
    // `endpoints_live_validated` counted every endpoint that had a `live` RECORD —
    // including the three whose live record is an HTTP 404 and whose response was
    // therefore never validated at all. On top of that it printed `not_covered: []`
    // and "FULL COVERAGE: fixtures AND live server responses were both validated."
    // So the file said 11/11 live-validated while 3 of the 11 were 404s.
    // That is the SAME defect as the D2/D3 under-claim above, pointing the other
    // way: the claim surface and the observations drifted apart and nothing caught
    // it. The count is now what was ACTUALLY VALIDATED, every shortfall is
    // enumerated WITH ITS REASON, and `complete` means what a reader thinks it does.
    // Guarded by src/wow-claim-drift-proof.mjs, which RECOMPUTES these numbers
    // from this file's own `endpoints` array and goes RED on any disagreement.
    // An endpoint is LIVE-VALIDATED iff a live RESPONSE BODY was actually validated
    // against a schema. The world/user/view/portal records record that as
    // `response_valid`; the /wow/spatial node records record it as `served_valid`
    // (validated against the LABELED OSLFlatNode — a declared divergence, but a real
    // validation). Having a `live` record is NOT the same thing, and that conflation
    // is exactly what produced the 11/11 over-claim.
    const wasLiveValidated = (e) => !!e.live && (e.live.response_valid === true || e.live.served_valid === true);
    const liveAttempted = endpoints.filter(e => e.live && e.live.attempted);
    const liveValidated = endpoints.filter(wasLiveValidated).length;
    const liveDriven = liveAttempted.length > 0;
    const liveShortfall = liveAttempted
        .filter(e => !wasLiveValidated(e))
        .map(e => ({
            id: e.id, method: e.method, path: e.path,
            http_status: e.live.http_status == null ? null : e.live.http_status,
            upgraded: e.live.upgraded === true,
            endpoint_status: e.status || null,
            why: e.live.upgraded === true
                ? 'live OBSERVED (protocol upgrade), but NO response body was schema-validated — '
                    + 'WS /events is a labeled non-canonical convention, deliberately outside the '
                    + 'OpenAPI HTTP contract. Counting it as a validated endpoint would be a false green.'
                : 'live response was NOT validated: '
                    + (e.live.error ? 'transport error ' + e.live.error : 'HTTP ' + e.live.http_status)
                    + '. This endpoint contributes NOTHING to endpoints_live_validated.',
        }));
    const notCovered = liveDriven ? liveShortfall.map(s =>
        'LIVE ' + s.method + ' ' + s.path + ' — ' + s.why) : [
        'LIVE HTTP pass: no WoW endpoint was driven against a running server. Every '
            + 'endpoint below is a CONTRACT/FIXTURE result only — it proves the fixture matches '
            + 'the schema, NOT that the server emits it.',
        'LIVE honesty guard: no on-the-wire response was checked for '
            + 'proof_boundary.standards_conformance:false. A cosmetic green on the real server '
            + 'would NOT have been caught by this run.',
        'LIVE composition-graph portal battery: the /wow/spatial graph walk, the portal '
            + 'node role/URI surfacing, and the resolvable-destination assertion did not run.',
        'LIVE canonical_node_valid observation (declared divergence D1): no served node payload was '
            + 'compared against the canonical Node schema in this run.',
        'LIVE X-OSL-WoW-Validation header parity (server-side validator observability).',
        'WS /events upgrade probe.',
    ];

    return {
        captured_at: new Date().toISOString(),
        mode: liveDriven ? 'fixtures+live' : 'fixtures-only',
        coverage: {
            live_driven: liveDriven,
            complete: liveDriven && liveShortfall.length === 0,
            complete_means: 'the LIVE pass ran AND every endpoint it attempted had its live '
                + 'response VALIDATED. It has never meant, and does not mean, "the server conforms".',
            endpoints_total: endpoints.length,
            endpoints_live_attempted: liveAttempted.length,
            endpoints_live_validated: liveValidated,
            endpoints_live_not_validated: liveShortfall.length,
            live_not_validated: liveShortfall,
            endpoints_fixture_validated: endpoints.filter(e => e.fixture).length,
            not_covered: notCovered,
            reading_this_file: liveDriven
                ? (liveShortfall.length === 0
                    ? 'FULL COVERAGE: fixtures AND live server responses were both validated.'
                    : 'PARTIAL LIVE COVERAGE — NOT a conformance pass and NOT "full coverage". '
                        + 'Fixtures were validated for every endpoint, but only ' + liveValidated
                        + ' of ' + liveAttempted.length + ' endpoints attempted live had their live '
                        + 'response VALIDATED. The other ' + liveShortfall.length + ' are enumerated '
                        + 'in `live_not_validated`, each with the reason it was not.')
                : 'PARTIAL COVERAGE — DO NOT READ THIS AS A CONFORMANCE PASS. Only fixtures were '
                    + 'validated. NOTHING here was observed against a running server. An empty '
                    + '`problems` list in this mode means "the contract is self-consistent", NOT '
                    + '"the server conforms". See not_covered.',
        },
        base_url: baseUrl,
        contract: {
            schema_yaml: 'wow-spec/schema.yaml',
            schema_json: 'wow-spec/generated/schema.json',
            schemas: validator.schemaNames,
            canonical_paths: Object.keys(doc.paths || {}),
            extension_schema_registry: extensionSchemaRegistry(doc),
        },
        endpoints,
        extensions_in_use,
        declared_divergences: DECLARED_DIVERGENCES,
        gaps,
        not_claimed: [
            'No full OpenSpatialWorld conformance beyond what actually validates against the runtime surface.',
            '.msf engine-trust / tamper-diagnostics conformance is OUT OF SCOPE (deferred to the later .msf-inclusive build).',
            'standards_conformance stays false on every /wow response — no cosmetic green.',
            'native_teleportxr_teleport:false; first_party_teleportxr_browser_rendering:false.',
            'WS /events is a LABELED non-canonical convention, NOT part of the OpenAPI HTTP contract.',
            'The /wow/spatial/* NODE PAYLOADS ARE NOT CANONICAL. OSL serves `OSLFlatNode` '
                + '(children = integer id refs); the OpenSpatialWorld standard EMBEDS child Node '
                + 'objects (API.yaml:484-487). '
                + (liveDriven
                    ? 'Every live spatial record below reports canonical_node_valid:false. '
                    : 'THIS RUN DROVE NO LIVE SPATIAL RECORDS, so it made no canonical_node_valid '
                        + 'observation at all — the divergence below is DECLARED, not measured here. ')
                + 'That is a DECLARED divergence (D1) — see declared_divergences — NOT a '
                + 'conformance claim.',
            'GET /wow/spatial/{spatialID} returns the root node BY DEFAULT; the standard returns a '
                + '`Spatial` descriptor (D3). The canonical `Spatial` schema IS in the contract and IS '
                + 'SERVED, on the versioned opt-in ?form=descriptor / X-OSL-WoW-Spatial-Form: descriptor '
                + '. What is NOT claimed is the DEFAULT response shape — it stays the root node '
                + 'for backward compatibility — and the OpenAPI DECLARATION of the opt-in, which appears '
                + 'in no schema.yaml path stanza.',
            'PROVENANCE (corrected 2026-07-11): OSL\'s first transcription of `Node` and of five '
                + 'operationIds matched the STALE spec copy vendored in the simpleWorlds reference '
                + 'implementation, not the open spec. `Node` is corrected; the operationId NAMING is '
                + 'retained. No simpleWorlds SOURCE CODE is vendored. simpleWorlds\' own license state '
                + 'is self-contradictory (Apache-2.0 LICENSE file vs "license":"UNLICENSED" in '
                + 'package.json), so OSL treats it as DO-NOT-COPY.',
        ],
        self_tests: { ok: selfChecks.every(c => c.caught), checks: selfChecks },
        problems,
        ok: problems.length === 0,
    };
}

module.exports = { runWowConformance, ENDPOINTS, DECLARED_DIVERGENCES, surfaceExtensions, driftCheck,
    honestyCheck, extensionSchemaRegistry, probeWs, httpRequestJson };
